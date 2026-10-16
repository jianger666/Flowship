/**
 * 更新 manifest 响应体大小上限（fetchUpdateManifest）
 *
 * 缺陷（实测）：原实现 `await res.json()` 会把整个响应体读进内存再解析，没有任何大小上限；
 * 对本地真实 HTTP 服务 + Node 全局 fetch（与 Electron 主进程同一实现）喂 200MiB 的正文，
 * 客户端照单全收并解析成功（RSS 涨 ~600MB）。超时 30s 只限时长不限字节——千兆链路 30s 可以灌几个 GB，
 * 足以把主进程内存打爆（mac 每次启动 / 2h 轮询都会走到、Windows 点徽标时走到）。
 * 谁能控制 update-manifest.json 这个 release asset（= 本验签链路要防的「能改 GitHub release 的人」）
 * 谁就能用一个超大响应让所有客户端崩溃 / 卡死；fail-closed 虽然没破，但把「拒绝安装」升级成了「应用被打挂」。
 *
 * 修法：读正文时流式累计字节，超过上限立刻 cancel 并抛 UpdateVerifyUnavailableError(manifest-too-large)；
 * 响应头声明的 content-length 已超限则连正文都不读。归 Unavailable 而不是 Mismatch：
 * 清单过大只说明「这次没拿到可用清单」，不能证明安装包有问题，不该删 112MB 的缓存包。
 *
 * 回退自检：把 update-manifest-verify.mjs 里的 `total > maxBytes` 判定去掉（或让 fetchUpdateManifest 改回 res.json()），
 * 下面「超限」相关用例必须全红。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAX_MANIFEST_BYTES,
  UpdateVerifyUnavailableError,
  buildVerifyRejectionNotice,
  fetchUpdateManifest,
  isDefinitiveVerifyFailure,
} from "../electron-app/update-manifest-verify.mjs";

const URL_ = "https://example.invalid/update-manifest.json";
const MiB = 1024 * 1024;
const CHUNK = 64 * 1024;

/** 合法 manifest 文本，尾部补空格到恰好 `bytes` 字节（JSON 允许尾随空白，解析结果不变） */
const paddedManifest = (bytes: number): Uint8Array<ArrayBuffer> => {
  const core = JSON.stringify({ version: "9.9.9", files: [], signature: "x" });
  const buf = new Uint8Array(bytes).fill(0x20);
  buf.set(new TextEncoder().encode(core), 0);
  return buf;
};

/**
 * 有限长的「一块块吐」流：记录被拉走了多少字节、有没有被 cancel。
 * 刻意是有限的（而不是无限流）——修复前的实现会把它读完，红灯是「没抛错」而不是把内存吃爆 / 测试挂死。
 */
const chunkedBody = (totalBytes: number, chunk = CHUNK) => {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (state.pulled >= totalBytes) {
          c.close();
          return;
        }
        const n = Math.min(chunk, totalBytes - state.pulled);
        const piece = new Uint8Array(n).fill(0x20);
        if (state.pulled === 0) piece.set(new TextEncoder().encode('{"version":"9.9.9",'), 0);
        state.pulled += n;
        c.enqueue(piece);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    // highWaterMark: 0 = 没人读就不预取：这样 pulled 精确反映「消费方到底读了多少」，
    // 才能区分「看响应头就拒绝（pulled 为 0）」和「读了第一块才发现超限」
    { highWaterMark: 0 },
  );
  return { stream, state };
};

const catchAsync = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("预期抛错但没有抛");
};

describe("fetchUpdateManifest：响应体大小上限", () => {
  it("默认上限：远大于真实清单（3 个条目 ≈ 600B）、又远小于能伤到主进程的量级", () => {
    expect(typeof MAX_MANIFEST_BYTES).toBe("number");
    expect(MAX_MANIFEST_BYTES).toBeGreaterThanOrEqual(64 * 1024);
    expect(MAX_MANIFEST_BYTES).toBeLessThanOrEqual(8 * MiB);
  });

  it("正文恰好等于上限 → 照常解析；多 1 字节 → Unavailable(manifest-too-large)", async () => {
    const cap = 4096;
    const ok = await fetchUpdateManifest({
      url: URL_,
      maxBytes: cap,
      fetchImpl: async () => new Response(paddedManifest(cap)),
    });
    expect((ok as { version: string }).version).toBe("9.9.9");

    const err = await catchAsync(() =>
      fetchUpdateManifest({
        url: URL_,
        maxBytes: cap,
        fetchImpl: async () => new Response(paddedManifest(cap + 1)),
      }),
    );
    expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((err as UpdateVerifyUnavailableError).code).toBe("manifest-too-large");
  });

  it("默认上限下：MAX_MANIFEST_BYTES + 1 字节的正文被拒（不传 maxBytes 也受限）", async () => {
    const err = await catchAsync(() =>
      fetchUpdateManifest({
        url: URL_,
        fetchImpl: async () => new Response(paddedManifest(MAX_MANIFEST_BYTES + 1)),
      }),
    );
    expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((err as UpdateVerifyUnavailableError).code).toBe("manifest-too-large");
  });

  it("没有 content-length（chunked）的超限正文：读到上限附近就停并 cancel，不会读完整个流", async () => {
    const cap = 256 * 1024;
    const { stream, state } = chunkedBody(100 * MiB);
    const err = await catchAsync(() =>
      fetchUpdateManifest({
        url: URL_,
        maxBytes: cap,
        fetchImpl: async () => new Response(stream),
      }),
    );
    expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((err as UpdateVerifyUnavailableError).code).toBe("manifest-too-large");
    // 允许比上限多拉 / 预取几块（流的 highWaterMark），但绝不能接近读完 100MiB
    expect(state.pulled).toBeLessThanOrEqual(cap + 8 * CHUNK);
    expect(state.cancelled).toBe(true);
  });

  it("响应头声明的 content-length 已超限：连正文都不读", async () => {
    const cap = 4096;
    const { stream, state } = chunkedBody(1 * MiB);
    const err = await catchAsync(() =>
      fetchUpdateManifest({
        url: URL_,
        maxBytes: cap,
        fetchImpl: async () =>
          new Response(stream, { headers: { "content-length": String(1 * MiB) } }),
      }),
    );
    expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((err as UpdateVerifyUnavailableError).code).toBe("manifest-too-large");
    // 看响应头就拒绝：一个字节都没从流里拉过，并且把流 cancel 掉（让连接立刻断开）
    expect(state.pulled).toBe(0);
    expect(state.cancelled).toBe(true);
  });

  it("超限是「暂时无法校验」而不是「确定不符」：不允许删缓存包、不开发布页", async () => {
    const err = await catchAsync(() =>
      fetchUpdateManifest({
        url: URL_,
        maxBytes: 1024,
        fetchImpl: async () => new Response(paddedManifest(4096)),
      }),
    );
    expect(isDefinitiveVerifyFailure(err)).toBe(false);
    const notice = buildVerifyRejectionNotice(err);
    expect(notice.definitive).toBe(false);
    expect(notice.openReleasePage).toBe(false);
    expect(notice.manifestMissing).toBe(false);
  });

  it("上限之内的正常响应不受影响：多字节字符被 chunk 边界切开、UTF-8 BOM 照常解析", async () => {
    const core = JSON.stringify({ version: "9.9.9", files: [{ name: "流程 ✨ émoji😀.exe", size: 1, sha256: "a".repeat(64) }], signature: "x" });
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(core)]);
    for (const chunk of [1, 2, 3, 5, 7]) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
          c.close();
        },
      });
      const m = (await fetchUpdateManifest({
        url: URL_,
        fetchImpl: async () => new Response(stream),
      })) as { files: Array<{ name: string }> };
      expect(m.files[0]!.name, `chunk=${chunk}`).toBe("流程 ✨ émoji😀.exe");
    }
  });
});

describe("fetchUpdateManifest：真实 HTTP 服务（Node 全局 fetch，与 Electron 主进程同实现）", () => {
  let server: http.Server;
  let base = "";
  const seen = { hugeClosedEarly: false };
  const HUGE_TOTAL = 48 * MiB;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/redirect-huge") {
        // GitHub release 资产就是先 302 再落到 objects.githubusercontent.com：上限必须对「跟随重定向后的响应」生效
        res.writeHead(302, { location: "/huge" });
        res.end();
        return;
      }
      if (req.url === "/huge") {
        // 不带 content-length 的 chunked 超大正文，遵守背压，客户端断开后立刻停写
        res.writeHead(200);
        const piece = Buffer.alloc(CHUNK, 0x20);
        let sent = 0;
        let closed = false;
        res.on("close", () => {
          closed = true;
          if (sent < HUGE_TOTAL) seen.hugeClosedEarly = true;
        });
        const pump = () => {
          while (!closed && sent < HUGE_TOTAL) {
            sent += CHUNK;
            if (!res.write(piece)) {
              res.once("drain", pump);
              return;
            }
          }
          if (!closed) res.end();
        };
        pump();
        return;
      }
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(JSON.stringify({ version: "9.9.9", files: [], signature: "x" }));
        return;
      }
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("302 → 正常小清单：照常解析（上限不误伤重定向）", async () => {
    const m = (await fetchUpdateManifest({ url: `${base}/ok`, timeoutMs: 5000 })) as { version: string };
    expect(m.version).toBe("9.9.9");
  });

  it("302 → 超大 chunked 正文：在远低于超时的时间内以 manifest-too-large 拒绝，且客户端主动断开了连接", async () => {
    seen.hugeClosedEarly = false;
    const t0 = Date.now();
    const err = await catchAsync(() =>
      fetchUpdateManifest({ url: `${base}/redirect-huge`, timeoutMs: 10_000 }),
    );
    expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((err as UpdateVerifyUnavailableError).code).toBe("manifest-too-large");
    expect(Date.now() - t0).toBeLessThan(4000);
    // 服务端还有几十 MiB 没发完就收到了断开 = 客户端 cancel 生效（而不是缓冲到读完）
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.hugeClosedEarly).toBe(true);
  });
});
