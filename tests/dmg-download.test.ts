/**
 * 流式落盘（R14 B2-4 / Q15-01）：electron-app/dmg-download.mjs 的 streamResponseToFile
 *
 * 改前 mac 暂存下载是手写的 `for await (chunk of res.body) { if (!ws.write(chunk)) await once(ws, "drain") }`：
 * 目的流没有 error 监听（磁盘满 → 主进程 uncaughtException 弹框），而且流被销毁后 write() 恒返回 false、drain 永不触发，
 * 整个下载永远挂住（stagingPromise 单飞锁永不释放）。这里钉的是替代它的 stream.pipeline 版本的行为：
 *   A. 正常：字节原样落盘、返回累计字节数、进度回调拿到累计值（Web ReadableStream / async iterable 两种响应体形态）
 *   B. 写盘失败（写入 / 收尾 flush）：reject 原错误、**不挂起**、源和目的流都被销毁
 *   C. 源流中途出错（断流）：reject、目的流被销毁
 *   D. 背压：目的流卡住时源不会被一口气拉完
 *   E. 目的流建不出来：reject 原错误并取消响应体
 *   F. 进度回调抛错 = 下载失败（与改前 for-await 里抛出同语义）
 *   G. 真实文件系统 / 真实 HTTP（Node 全局 fetch 的 res.body）：完整落盘；目录不存在 → ENOENT；服务端中途断开 → reject、不挂起
 * 所有「不挂起」的断言都带超时：这类 bug 的表现就是永远不 settle。
 */
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { createWriteStream as fsCreateWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { ReadableStream } from "node:stream/web";

import { afterAll, describe, expect, it, vi } from "vitest";

import { streamResponseToFile } from "../electron-app/dmg-download.mjs";

const TMP = mkdtempSync(path.join(os.tmpdir(), "fe-dmg-download-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const buf = (n: number, fill: number): Buffer => Buffer.alloc(n, fill);
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** 「不挂起」：ms 内没 settle 就判失败（挂起 = 这类 bug 的真实表现） */
const withTimeout = <T,>(p: Promise<T>, ms = 3000): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`挂起：${ms}ms 内没有 settle`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
};

/** async generator 形态的响应体；finally 里记 returned（被销毁 / 取消时会走到）；可在第 N 块之前抛错 */
const makeIterSource = (parts: Buffer[], opts: { throwBefore?: number } = {}) => {
  const state = { pulled: 0, returned: false };
  async function* gen(): AsyncGenerator<Buffer> {
    try {
      for (const [i, p] of parts.entries()) {
        if (opts.throwBefore !== undefined && i >= opts.throwBefore) throw new Error("terminated");
        state.pulled += 1;
        yield p;
      }
    } finally {
      state.returned = true;
    }
  }
  return { body: gen(), state };
};

/** Web ReadableStream 形态的响应体（真实 fetch 的 res.body 就是这个形状）；cancel 时记 canceled */
const makeWebSource = (parts: Buffer[]) => {
  const state = { canceled: false };
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < parts.length) controller.enqueue(new Uint8Array(parts[i++]!));
      else controller.close();
    },
    cancel() {
      state.canceled = true;
    },
  });
  return { body, state };
};

/** 内存里的目的流：可让第 N 次写入失败（回调带 ENOSPC，与 fs.WriteStream 的失败路径同一机制）/ 收尾失败 / 卡住写入 */
const makeWriter = (opts: { failOnWrite?: number; failOnFinal?: Error; hold?: Promise<void> } = {}) => {
  const got: Buffer[] = [];
  let writes = 0;
  const ws = new Writable({
    write(chunk, _enc, cb) {
      writes += 1;
      if (opts.failOnWrite === writes) {
        cb(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
        return;
      }
      got.push(Buffer.from(chunk));
      if (opts.hold) void opts.hold.then(() => cb());
      else cb();
    },
    final(cb) {
      cb(opts.failOnFinal ?? null);
    },
  });
  return { ws, got, writes: () => writes };
};

const run = (
  body: unknown,
  ws: Writable,
  onProgress?: (n: number) => void,
): Promise<number> =>
  streamResponseToFile({
    body: body as never,
    dest: "/ignored/by/in-memory/writer",
    createWriteStream: () => ws,
    onProgress,
  });

describe("A. 正常落盘", () => {
  it("Web ReadableStream 响应体：字节原样落盘、返回累计字节数、进度回调拿到累计值", async () => {
    const src = makeWebSource([buf(100, 1), buf(200, 2), buf(300, 3)]);
    const w = makeWriter();
    const progress: number[] = [];
    const n = await withTimeout(run(src.body, w.ws, (r) => progress.push(r)));
    expect(n).toBe(600);
    expect(Buffer.concat(w.got).equals(Buffer.concat([buf(100, 1), buf(200, 2), buf(300, 3)]))).toBe(true);
    expect(progress).toEqual([100, 300, 600]);
    expect(w.ws.writableFinished).toBe(true);
  });

  it("async iterable 响应体（测试替身 / 其它 fetch 实现）同样可用", async () => {
    const src = makeIterSource([buf(10, 1), buf(20, 2)]);
    const w = makeWriter();
    expect(await withTimeout(run(src.body, w.ws))).toBe(30);
    expect(Buffer.concat(w.got).length).toBe(30);
    expect(w.ws.writableFinished).toBe(true);
  });

  it("空响应体：返回 0、目的流正常结束（不是错误）", async () => {
    const w = makeWriter();
    expect(await withTimeout(run(makeWebSource([]).body, w.ws))).toBe(0);
    expect(w.ws.writableFinished).toBe(true);
  });

  it("没传 onProgress 也行", async () => {
    const w = makeWriter();
    expect(await withTimeout(run(makeWebSource([buf(5, 1)]).body, w.ws))).toBe(5);
  });
});

describe("B. 写盘失败：reject 原错误、不挂起、两端都被销毁", () => {
  it("第 2 块写入 ENOSPC：reject（code 保留）、目的流销毁、源被销毁、第 2 块没写进去", async () => {
    const src = makeIterSource([buf(1000, 1), buf(1000, 2), buf(1000, 3), buf(1000, 4)]);
    const w = makeWriter({ failOnWrite: 2 });
    const err = await withTimeout(run(src.body, w.ws)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "ENOSPC" });
    await tick();
    expect(w.ws.destroyed).toBe(true);
    expect(src.state.returned).toBe(true);
    expect(w.got.length).toBe(1);
  });

  it("Web ReadableStream 响应体：写盘失败时响应体被取消（连接不会挂着）", async () => {
    const src = makeWebSource([buf(1000, 1), buf(1000, 2), buf(1000, 3)]);
    const w = makeWriter({ failOnWrite: 1 });
    await expect(withTimeout(run(src.body, w.ws))).rejects.toMatchObject({ code: "ENOSPC" });
    await tick();
    expect(src.state.canceled).toBe(true);
  });

  it("收尾（flush / close）时失败：同样 reject、不当成成功", async () => {
    const w = makeWriter({ failOnFinal: Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" }) });
    await expect(withTimeout(run(makeWebSource([buf(10, 1)]).body, w.ws))).rejects.toMatchObject({ code: "EIO" });
  });
});

describe("C. 源流中途出错（断流）", () => {
  it("第 2 块之前抛错：reject、目的流销毁、不挂起", async () => {
    const src = makeIterSource([buf(100, 1), buf(100, 2), buf(100, 3)], { throwBefore: 1 });
    const w = makeWriter();
    await expect(withTimeout(run(src.body, w.ws))).rejects.toThrow("terminated");
    await tick();
    expect(w.ws.destroyed).toBe(true);
    expect(w.ws.writableFinished).toBe(false);
  });
});

describe("D. 背压", () => {
  it("目的流卡住时，源不会被一口气拉完（无背压的实现会拉完全部 400 块）", async () => {
    const parts = Array.from({ length: 400 }, (_, i) => buf(64 * 1024, i % 250));
    const src = makeIterSource(parts);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const w = makeWriter({ hold });
    const done = run(src.body, w.ws);
    await new Promise((r) => setTimeout(r, 100)); // 让链路跑到「目的流不 ack」的稳态
    expect(src.state.pulled).toBeLessThan(40);
    release();
    expect(await withTimeout(done, 10000)).toBe(400 * 64 * 1024);
    expect(src.state.pulled).toBe(400);
  });
});

describe("E. 目的流建不出来", () => {
  it("createWriteStream 同步抛错：reject 同一个错误，并取消还没人读的响应体", async () => {
    const boom = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const web = makeWebSource([buf(10, 1)]);
    await expect(
      streamResponseToFile({
        body: web.body as never,
        dest: "/x",
        createWriteStream: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(web.state.canceled).toBe(true);

    // async iterable 形态：用带 return 探针的迭代器对象（async generator 从未开始迭代就被 return()，
    // 不会进 try / finally——直接观察 `return` 被调用才是对的）
    const returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));
    const iterBody = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => ({ done: false as const, value: buf(10, 1) }),
      return: returnSpy,
    };
    await expect(
      streamResponseToFile({
        body: iterBody as never,
        dest: "/x",
        createWriteStream: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("F. 进度回调抛错", () => {
  it("回调抛错 = 下载失败：reject 该错误、目的流销毁（与改前 for-await 里抛出同语义）", async () => {
    const w = makeWriter();
    const err = await withTimeout(
      run(makeWebSource([buf(10, 1), buf(10, 2)]).body, w.ws, () => {
        throw new Error("setProgressBar: Object has been destroyed");
      }),
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain("Object has been destroyed");
    await tick();
    expect(w.ws.destroyed).toBe(true);
  });

  it("回调每块调一次、参数单调递增", async () => {
    const w = makeWriter();
    const onProgress = vi.fn();
    await withTimeout(run(makeWebSource([buf(1, 1), buf(1, 2), buf(1, 3)]).body, w.ws, onProgress));
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });
});

describe("G. 真实文件系统 / 真实 HTTP", () => {
  const serve = async (handler: RequestListener) => {
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/`,
      close: () =>
        new Promise<void>((r) => {
          server.closeAllConnections?.();
          server.close(() => r());
        }),
    };
  };

  it("真实 fs.createWriteStream + 真实 fetch 的 res.body：3MB 完整落盘、进度累计到总数", async () => {
    const SIZE = 3 * 1024 * 1024;
    const payload = Buffer.alloc(SIZE, 7);
    const s = await serve((_req, res) => {
      res.writeHead(200, { "content-length": SIZE });
      res.end(payload);
    });
    try {
      const dest = path.join(TMP, "ok.bin");
      const res = await fetch(s.url);
      let last = 0;
      const n = await withTimeout(
        streamResponseToFile({
          body: res.body as never,
          dest,
          createWriteStream: fsCreateWriteStream,
          onProgress: (r) => (last = r),
        }),
      );
      expect(n).toBe(SIZE);
      expect(last).toBe(SIZE);
      expect(statSync(dest).size).toBe(SIZE);
      expect(readFileSync(dest).equals(payload)).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("真实 fs：目的目录不存在 → reject ENOENT（真实的异步 error 事件）、不挂起、没有未处理的错误", async () => {
    const res = await fetch(
      await (async () => {
        const s = await serve((_req, r) => r.end(Buffer.alloc(1024, 1)));
        closers.push(s.close);
        return s.url;
      })(),
    );
    await expect(
      withTimeout(
        streamResponseToFile({
          body: res.body as never,
          dest: path.join(TMP, "no-such-dir", "x.bin"),
          createWriteStream: fsCreateWriteStream,
        }),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(existsSync(path.join(TMP, "no-such-dir"))).toBe(false);
  });

  it("真实 HTTP：服务端发了一半就断开 → reject、不挂起（半截文件由调用方的 finally 清理，这里只保证流已销毁）", async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { "content-length": 1_000_000 });
      res.write(Buffer.alloc(100_000, 9));
      setTimeout(() => res.socket?.destroy(), 30);
    });
    try {
      const dest = path.join(TMP, "cut.bin");
      const res = await fetch(s.url);
      let ws: Writable | undefined;
      await expect(
        withTimeout(
          streamResponseToFile({
            body: res.body as never,
            dest,
            createWriteStream: (d: string) => (ws = fsCreateWriteStream(d)),
          }),
          8000,
        ),
      ).rejects.toThrow();
      await tick();
      expect(ws?.destroyed).toBe(true);
    } finally {
      await s.close();
    }
  });
});

const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(closers.map((c) => c()));
});
