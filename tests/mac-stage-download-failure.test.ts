/**
 * mac 暂存下载（真实执行 main.js 的 downloadAndStageMacUpdate + downloadAndStageMacUpdateInner 函数体）
 * ——写盘失败后的复位、下载前的磁盘预检（R14 B2-4 / Q15-01）
 *
 * 台账原句（Q15-01 P2 BUG）：dmg 暂存的写流没有 error 监听、也没有磁盘预检；磁盘满 / 权限被收时，
 * 主进程弹 "A JavaScript error occurred"，而且 `for await` 永远挂在 drain 上，stagingPromise 永不复位、徽标停在「下载中」直到重启。
 * 这里不 grep 源码，而是把两个函数从 main.js 切出来、注入替身、**真跑**（脚手架见 tests/helpers/main-slice.ts）：
 *   A. 写盘失败（第 2 块 ENOSPC）：reject 原错误、不挂起、stagingPromise 复位、页面状态回 available 带原因、
 *      finally 清理照常跑（进度条复位 / hdiutil detach / 删半截 dmg）、之后能重新开始（单飞锁没卡死）
 *   B. 下载前的磁盘预检：不够 → 一个字节都不下、不进「下载中」、专门的错误类型；不计入「会白下 dmg」的闸、但登记时间退避；
 *      空间恢复后下一次就能成功；量不到放行；恰好阈值放行
 *   C. 进度 / 完整性：整数百分点去重推送、进度条最后一定复位、字节数对不上 content-length 就中止
 *   D. 成功路径没被带歪（验签入参、attach / ditto、暂存元信息、ready 状态）
 *   E. 源码契约：预检在 mkdir 之后、「下载中」与 fetch 之前（且在 try 里）；不再有手写的 for-await + drain
 * 改前红 / 改后绿：把本文件放进改前的 main.js 副本里跑（A 组挂起 + 未处理错误、B 组红），见 HANDOFF 的 B2-4 小节。
 */
import { Writable } from "node:stream";
import { ReadableStream } from "node:stream/web";

import { describe, expect, it, vi } from "vitest";

import { assertMacStageSpace } from "../electron-app/disk-space.mjs";
import { streamResponseToFile } from "../electron-app/dmg-download.mjs";
import { buildVerifyRejectionNotice } from "../electron-app/update-manifest-verify.mjs";
import {
  isPermanentVerifyFailure,
  nextCostlyFailureRecord,
  nextVerifyRetry,
  shouldGiveUpAutoStage,
} from "../electron-app/update-verify-retry.mjs";
import { instantiateMany, mainDecls, sliceMainFn } from "./helpers/main-slice";

const V = "9.9.9";
const UPDATES = "/tmp/flowship-updates";
const DMG = `${UPDATES}/v${V}.dmg`;
const MB = 1048576;

const buf = (n: number, fill: number): Buffer => Buffer.alloc(n, fill);

/** 「不挂起」：ms 内没 settle 就判失败 */
const withTimeout = <T,>(p: Promise<T>, ms = 3000): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`挂起：${ms}ms 内没有 settle`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
};

/** 目的流：可让第 N 次写入失败（回调带 ENOSPC——与 fs.WriteStream 的失败路径同一机制，error 事件异步发出） */
const makeWriter = (failOnWrite?: number): Writable => {
  let writes = 0;
  return new Writable({
    write(_chunk, _enc, cb) {
      writes += 1;
      if (failOnWrite === writes) {
        cb(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
        return;
      }
      cb();
    },
  });
};

/** 假 fetch：dmg 响应（Web ReadableStream，与真实 res.body 同形）；清单请求不走它（loadSignedManifest 整个注入） */
const makeFetch = (parts: Buffer[], contentLength?: number) =>
  vi.fn<(url: string) => Promise<unknown>>(async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(new Uint8Array(p));
        controller.close();
      },
    }),
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-length" && contentLength !== undefined ? String(contentLength) : null,
    },
  }));

/** 字节级假 statfs（bsize=1 → bavail 即可用字节数） */
const statfsMB = (mb: number) => () => ({ bavail: mb * MB, bsize: 1 });

interface Opts {
  parts?: Buffer[];
  contentLength?: number;
  failOnWrite?: number;
  freeMB?: number;
  statfs?: () => { bavail: number; bsize: number };
}

const setup = (o: Opts = {}) => {
  const parts = o.parts ?? [buf(1000, 1), buf(1000, 2), buf(1000, 3)];
  const total = o.contentLength ?? parts.reduce((n, p) => n + p.length, 0);
  const manifestCtx = { entry: "manifest-ctx" };
  const deps = {
    readStagedMeta: vi.fn(async () => null),
    existsSync: vi.fn(() => false),
    clearStagedUpdate: vi.fn(async () => undefined),
    process: { arch: "arm64" },
    runningAppPath: () => "/Applications/Flowship.app",
    loadSignedManifest: vi.fn(async () => manifestCtx),
    updatesDirPath: () => UPDATES,
    path: { join: (...p: string[]) => p.join("/") },
    mkdirSync: vi.fn(),
    log: vi.fn(),
    setUpdateState: vi.fn(),
    fetch: makeFetch(parts, total),
    createWriteStream: vi.fn(() => makeWriter(o.failOnWrite)),
    mainWindow: { setProgressBar: vi.fn() },
    verifyDownloadedUpdate: vi.fn(async () => undefined),
    execFileStrict: vi.fn<(cmd: string, args: string[]) => Promise<void>>(async () => undefined),
    execFileP: vi.fn(async () => ""),
    readdirSync: vi.fn(() => ["Flowship.app"]),
    fs: { rm: vi.fn(async () => undefined), stat: vi.fn(async () => ({ size: total })) },
    writeStagedMeta: vi.fn(async () => undefined),
    statfsSync: vi.fn(o.statfs ?? statfsMB(o.freeMB ?? 10_000)),
    // 下面这些是真实实现（不是替身）：被测的就是它们与 main.js 的接线
    assertMacStageSpace,
    streamResponseToFile,
    isPermanentVerifyFailure,
    nextVerifyRetry,
    nextCostlyFailureRecord,
    shouldGiveUpAutoStage,
    buildVerifyRejectionNotice,
  };
  const h = instantiateMany<{
    stage: (v: string) => Promise<unknown>;
    state: () => {
      stagingPromise: unknown;
      macVerifyFailedVersion: unknown;
      macVerifyRetry: unknown;
      macCostlyFailures: unknown;
      macStageGiveUpVersion: unknown;
    };
  }>(
    ["downloadAndStageMacUpdate", "downloadAndStageMacUpdateInner"],
    deps,
    mainDecls(
      "stagingPromise",
      "macVerifyFailedVersion",
      "macVerifyRetry",
      "macCostlyFailures",
      "macStageGiveUpVersion",
      "repeatedFailurePromptedVersion",
      "installInFlight",
    ),
    "return { stage: downloadAndStageMacUpdate, state: () => ({ stagingPromise, macVerifyFailedVersion, macVerifyRetry, macCostlyFailures, macStageGiveUpVersion }) };",
  );
  const phases = (): string[] =>
    deps.setUpdateState.mock.calls.map((c) => (c[0] as { phase?: string }).phase ?? `(percent ${(c[0] as { percent?: number }).percent})`);
  const lastState = (): { phase?: string; version?: string; error?: string | null } =>
    deps.setUpdateState.mock.calls.at(-1)![0] as never;
  return { deps, ...h, phases, lastState };
};

describe("A. 写盘失败：不挂起、stagingPromise 复位、状态回 available", () => {
  it("第 2 块 ENOSPC：reject 原错误；stagingPromise 复位；页面状态回 available 且带原因；finally 清理照常跑", async () => {
    const s = setup({ failOnWrite: 2 });
    const err = await withTimeout(s.stage(V)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "ENOSPC" });
    // 单飞锁复位：这是台账里「stagingPromise 永不复位、徽标停在下载中直到重启」的直接对应
    expect(s.state().stagingPromise).toBeNull();
    expect(s.lastState()).toMatchObject({ phase: "available", version: V });
    expect(String(s.lastState().error)).toContain("ENOSPC");
    // finally：进度条复位、卸载（没挂也无害）、删半截 dmg
    expect(s.deps.mainWindow.setProgressBar).toHaveBeenLastCalledWith(-1);
    expect(s.deps.execFileP).toHaveBeenCalledWith("hdiutil", expect.arrayContaining(["detach"]));
    expect(s.deps.fs.rm).toHaveBeenCalledWith(DMG, { force: true });
    // 没走到验签 / attach / 暂存
    expect(s.deps.verifyDownloadedUpdate).not.toHaveBeenCalled();
    expect(s.deps.execFileStrict).not.toHaveBeenCalled();
    expect(s.deps.writeStagedMeta).not.toHaveBeenCalled();
  });

  it("失败后能重新开始：单飞锁没卡死，第二次调用重新发起下载（改前挂在 drain 上、第二次只会拿到那个永不 settle 的 promise）", async () => {
    const s = setup({ failOnWrite: 2 });
    await withTimeout(s.stage(V)).catch(() => undefined);
    expect(s.deps.fetch).toHaveBeenCalledTimes(1);
    await withTimeout(s.stage(V)).catch(() => undefined);
    expect(s.deps.fetch).toHaveBeenCalledTimes(2);
    expect(s.state().stagingPromise).toBeNull();
  });

  it("并发合流：失败时两个调用方拿到同一个错误、之后锁复位", async () => {
    const s = setup({ failOnWrite: 1 });
    const a = s.stage(V);
    const b = s.stage(V);
    expect(a).toBe(b);
    const [ea, eb] = await withTimeout(Promise.all([a.catch((e: unknown) => e), b.catch((e: unknown) => e)]));
    expect(ea).toBe(eb);
    expect(ea).toMatchObject({ code: "ENOSPC" });
    expect(s.state().stagingPromise).toBeNull();
    expect(s.deps.fetch).toHaveBeenCalledTimes(1);
  });

  it("写盘失败登记为「会白下 dmg 的失败」（下载已经花了流量）：连续 3 次后放弃自动暂存", async () => {
    const s = setup({ failOnWrite: 2 });
    for (let i = 0; i < 3; i += 1) await withTimeout(s.stage(V)).catch(() => undefined);
    expect(s.state().macCostlyFailures).toEqual({ version: V, count: 3 });
    expect(s.state().macStageGiveUpVersion).toBe(V);
  });
});

describe("B. 下载前的磁盘预检", () => {
  it("空间不够：一个字节都不下、不进「下载中」、不建目的流；抛 StageNoSpaceError；页面状态回 available 带说清剩多少的原因", async () => {
    const s = setup({ freeMB: 100 });
    const err = (await withTimeout(s.stage(V)).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("STAGE_NO_SPACE");
    expect(err.name).toBe("StageNoSpaceError");
    expect(s.deps.fetch).not.toHaveBeenCalled();
    expect(s.deps.createWriteStream).not.toHaveBeenCalled();
    expect(s.phases()).not.toContain("downloading");
    expect(s.lastState()).toMatchObject({ phase: "available", version: V });
    expect(String(s.lastState().error)).toContain("磁盘剩余空间不足");
    expect(s.state().stagingPromise).toBeNull();
    // 清单是预检之前取的（F1-01：先清单、再下载），预检只拦「下载」
    expect(s.deps.loadSignedManifest).toHaveBeenCalledTimes(1);
  });

  it("量的是 updates 目录（statfs 收到的就是 updatesDirPath()），不是 tmp / 安装目录", async () => {
    const s = setup({ freeMB: 100 });
    await withTimeout(s.stage(V)).catch(() => undefined);
    expect(s.deps.statfsSync).toHaveBeenCalledWith(UPDATES);
  });

  it("空间不足不算「会白下 dmg」的失败：反复多次也不放弃自动暂存；但登记了时间退避（不是每次轮询都重量）", async () => {
    const s = setup({ freeMB: 100 });
    for (let i = 0; i < 6; i += 1) await withTimeout(s.stage(V)).catch(() => undefined);
    expect(s.state().macCostlyFailures).toBeNull();
    expect(s.state().macStageGiveUpVersion).toBeNull();
    expect(s.state().macVerifyFailedVersion).toBeNull(); // 也不是永久失败
    expect(s.state().macVerifyRetry).toMatchObject({ version: V });
  });

  it("用户腾出空间后，下一次就能成功暂存；成功会清掉之前的失败记录", async () => {
    let free = 100;
    const s = setup({ statfs: () => ({ bavail: free * MB, bsize: 1 }) });
    await withTimeout(s.stage(V)).catch(() => undefined);
    expect(s.state().macVerifyRetry).not.toBeNull();
    free = 10_000;
    const meta = await withTimeout(s.stage(V));
    expect(meta).toMatchObject({ version: V });
    expect(s.state().macVerifyRetry).toBeNull();
    expect(s.state().macCostlyFailures).toBeNull();
    expect(s.lastState()).toMatchObject({ phase: "ready", version: V });
  });

  it("量不到（statfs 抛错）放行；恰好阈值（600MB）放行；差 1 字节拦", async () => {
    const boom = setup({
      statfs: () => {
        throw new Error("ENOENT");
      },
    });
    await expect(withTimeout(boom.stage(V))).resolves.toMatchObject({ version: V });
    expect(boom.deps.fetch).toHaveBeenCalledTimes(1);

    const edge = setup({ statfs: () => ({ bavail: 600 * MB, bsize: 1 }) });
    await expect(withTimeout(edge.stage(V))).resolves.toMatchObject({ version: V });

    const short = setup({ statfs: () => ({ bavail: 600 * MB - 1, bsize: 1 }) });
    await expect(withTimeout(short.stage(V))).rejects.toMatchObject({ code: "STAGE_NO_SPACE" });
    expect(short.deps.fetch).not.toHaveBeenCalled();
  });

  it("已有可用的暂存包（跳过下载）时不做预检：那条路径不写盘", async () => {
    const s = setup({ freeMB: 1 });
    s.deps.readStagedMeta.mockResolvedValueOnce({ version: V, appPath: "/tmp/staged.app" } as never);
    s.deps.existsSync.mockReturnValueOnce(true);
    await expect(withTimeout(s.stage(V))).resolves.toMatchObject({ version: V });
    expect(s.deps.statfsSync).not.toHaveBeenCalled();
    expect(s.deps.fetch).not.toHaveBeenCalled();
  });
});

describe("C. 进度与完整性", () => {
  it("进度：整数百分点去重推送；Dock 进度条跟着走；最后一定复位到 -1", async () => {
    const s = setup({ parts: [buf(50, 1), buf(50, 2)], contentLength: 100 });
    await withTimeout(s.stage(V));
    const percents = s.deps.setUpdateState.mock.calls
      .map((c) => (c[0] as { percent?: number; phase?: string }))
      .filter((p) => p.phase === undefined)
      .map((p) => p.percent);
    expect(percents).toEqual([50, 100]);
    // main.js 里复位出现两处（下载完成后一次 + finally 一次，改前就如此）：只钉「进度值序列」与「最后一定是 -1」，不钉复位次数
    const bars = s.deps.mainWindow.setProgressBar.mock.calls.map((c) => c[0]);
    expect(bars.filter((b) => b !== -1)).toEqual([0.5, 1]);
    expect(bars.at(-1)).toBe(-1);
  });

  it("同一整数百分点内的多块只推一次（250 个 1 字节块 → percent 恰好 0..100 各一次、单调递增；不是每块一推刷爆 IPC）", async () => {
    const s = setup({ parts: Array.from({ length: 250 }, () => buf(1, 7)), contentLength: 250 });
    await withTimeout(s.stage(V));
    const percents = s.deps.setUpdateState.mock.calls
      .map((c) => c[0] as { percent?: number; phase?: string })
      .filter((p) => p.phase === undefined)
      .map((p) => p.percent);
    expect(percents).toEqual(Array.from({ length: 101 }, (_, i) => i));
  });

  it("响应没带 content-length：不推进度（没有分母），但进度条照样复位", async () => {
    const s = setup({ parts: [buf(50, 1), buf(50, 2)] });
    // setup 默认用实际总数当 content-length；这里换成「没有这个头」的 fetch
    s.deps.fetch.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(buf(50, 1)));
          c.enqueue(new Uint8Array(buf(50, 2)));
          c.close();
        },
      }),
      headers: { get: () => null },
    }));
    await withTimeout(s.stage(V));
    const bars = s.deps.mainWindow.setProgressBar.mock.calls.map((c) => c[0]);
    expect(bars.filter((b) => b !== -1)).toEqual([]);
    expect(bars.at(-1)).toBe(-1);
    expect(s.phases().filter((p) => p.startsWith("(percent"))).toEqual([]);
  });

  it("实际字节数与 content-length 对不上：中止暂存（残缺 dmg 不进验签）、照常清理", async () => {
    const s = setup({ parts: [buf(60, 1)], contentLength: 100 });
    const err = (await withTimeout(s.stage(V)).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("dmg 下载不完整（60/100 字节）");
    expect(s.deps.verifyDownloadedUpdate).not.toHaveBeenCalled();
    expect(s.deps.fs.rm).toHaveBeenCalledWith(DMG, { force: true });
    expect(s.state().stagingPromise).toBeNull();
  });

  it("下载 HTTP 非 2xx：抛「下载失败 HTTP …」、不建目的流", async () => {
    const s = setup();
    s.deps.fetch.mockImplementationOnce(async () => ({ ok: false, status: 502, body: null, headers: { get: () => null } }) as never);
    await expect(withTimeout(s.stage(V))).rejects.toThrow("下载失败 HTTP 502");
    expect(s.deps.createWriteStream).not.toHaveBeenCalled();
  });
});

describe("D. 成功路径没被带歪", () => {
  it("验签入参、attach / ditto、暂存元信息、ready 状态", async () => {
    const s = setup();
    const meta = await withTimeout(s.stage(V));
    expect(meta).toEqual({ version: V, appPath: `${UPDATES}/staged-${V}.app` });
    expect(s.deps.createWriteStream).toHaveBeenCalledWith(DMG);
    expect(s.deps.verifyDownloadedUpdate).toHaveBeenCalledWith(
      V,
      DMG,
      `fe-ai-flow-${V}-mac-arm64.dmg`,
      { entry: "manifest-ctx" },
    );
    expect(s.deps.execFileStrict.mock.calls.map((c) => c[0])).toEqual(["hdiutil", "ditto"]);
    expect(s.deps.writeStagedMeta).toHaveBeenCalledWith({ version: V, appPath: `${UPDATES}/staged-${V}.app` });
    expect(s.lastState()).toMatchObject({ phase: "ready", version: V, percent: 100, error: null });
    expect(s.state().stagingPromise).toBeNull();
    // finally 里的清理在成功路径上也跑（dmg 用完即删）
    expect(s.deps.fs.rm).toHaveBeenCalledWith(DMG, { force: true });
  });

  it("预检日志带上量到的数字（排障用）", async () => {
    const s = setup({ freeMB: 4321 });
    await withTimeout(s.stage(V));
    expect(s.deps.log.mock.calls.map((c) => String(c[0]))).toContain("[updater] 暂存预检 free=4321MB min=600MB");
  });
});

describe("E. 源码契约（防回退）", () => {
  const fn = sliceMainFn("downloadAndStageMacUpdateInner");

  it("预检在 mkdirSync(updatesDir) 之后、「下载中」状态与 fetch 之前，并且在 try 里（失败走既有 finally / catch）", () => {
    const tryAt = fn.indexOf("try {");
    const mkdir = fn.indexOf("mkdirSync(updatesDir");
    const check = fn.indexOf("assertMacStageSpace(updatesDir, statfsSync)");
    const downloading = fn.indexOf('phase: "downloading"');
    const fetchAt = fn.indexOf("await fetch(dmgUrl)");
    for (const [name, i] of Object.entries({ tryAt, mkdir, check, downloading, fetchAt })) {
      expect(i, `downloadAndStageMacUpdateInner 缺少 ${name}`).toBeGreaterThanOrEqual(0);
    }
    expect(tryAt).toBeLessThan(mkdir);
    expect(mkdir).toBeLessThan(check);
    expect(check).toBeLessThan(downloading);
    expect(check).toBeLessThan(fetchAt);
  });

  it("落盘走 streamResponseToFile（createWriteStream 作为参数传入）；不再有手写的 for-await + write + drain", () => {
    expect(fn).toContain("await streamResponseToFile({");
    expect(fn).toMatch(/streamResponseToFile\(\{[\s\S]*createWriteStream,/);
    expect(fn).not.toMatch(/for await\s*\(/);
    expect(fn).not.toContain(".write(chunk)");
    expect(fn).not.toContain('once("drain"');
    expect(fn).not.toMatch(/createWriteStream\(dmgPath\)/);
  });
});
