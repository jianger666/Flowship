/**
 * sdk-agent-store 接入层：开关解析与回退、单例并发、四个子 store 与 SDK 原实现的互操作。
 *
 * 全部用真实 `@cursor/sdk` 的 JsonlLocalAgentStore 作对照（不 mock），
 * 每个用例自己的临时目录，互不影响。
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FastCheckpoints } from "@/lib/server/fast-checkpoint-store";
import {
  __resetSdkStoreHandleForTests,
  getSdkStoreHandle,
  openSdkStore,
  resolveSdkStoreMode,
  SDK_AGENT_STORE_DIRNAME,
  SDK_STORE_ENV,
  SDK_STORE_MARKER,
  withCursorJsonlStore,
} from "@/lib/server/sdk-agent-store";

import {
  A,
  allBlobsOk,
  blobData,
  cleanupTmps,
  fileOf,
  loadSdk,
  mkTmp,
  sameBytes,
  sdkReaderOk,
  seed,
} from "./helpers/fast-store-helpers";

const prevDataDir = process.env.FLOWSHIP_DATA_DIR;
const prevMode = process.env[SDK_STORE_ENV];

/** 吞掉启动日志（避免测试输出噪声），需要断言告警时用返回值 */
const quiet = () => ({
  log: vi.spyOn(console, "log").mockImplementation(() => undefined),
  warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
});

beforeEach(() => {
  delete process.env[SDK_STORE_ENV];
  __resetSdkStoreHandleForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetSdkStoreHandleForTests();
  if (prevDataDir === undefined) delete process.env.FLOWSHIP_DATA_DIR;
  else process.env.FLOWSHIP_DATA_DIR = prevDataDir;
  if (prevMode === undefined) delete process.env[SDK_STORE_ENV];
  else process.env[SDK_STORE_ENV] = prevMode;
  cleanupTmps();
});

describe("resolveSdkStoreMode 真值表", () => {
  it.each([
    [{}, false, "fast"],
    [{}, true, "sdk"],
    [{ [SDK_STORE_ENV]: "sdk" }, false, "sdk"],
    [{ [SDK_STORE_ENV]: " SDK " }, false, "sdk"],
    [{ [SDK_STORE_ENV]: "sdk" }, true, "sdk"],
    [{ [SDK_STORE_ENV]: "fast" }, true, "fast"], // 显式 fast 压过标记文件
    [{ [SDK_STORE_ENV]: "fast" }, false, "fast"],
    [{ [SDK_STORE_ENV]: "" }, true, "sdk"],
    [{ [SDK_STORE_ENV]: "typo" }, false, "fast"], // 拼写错误忽略，不当成回退
    [{ [SDK_STORE_ENV]: "typo" }, true, "sdk"],
  ] as const)("env=%j marker=%s → %s", (env, marker, want) => {
    expect(resolveSdkStoreMode(env, marker)).toBe(want);
  });
});

describe("openSdkStore：模式选择与回退", () => {
  it("默认：checkpoints 换成 FastCheckpoints，其余三份仍是 SDK 自带实现", async () => {
    quiet();
    const dir = mkTmp();
    const h = await openSdkStore(dir, {});
    expect(h?.mode).toBe("fast");
    expect(h?.fast).toBeInstanceOf(FastCheckpoints);
    expect(h?.store.checkpoints).toBe(h?.fast);
    expect(h?.store.agents).not.toBeInstanceOf(FastCheckpoints);
    expect(h?.dir).toBe(dir);
  });

  it("环境变量 sdk：用 SDK 自带实现，不碰 FastCheckpoints", async () => {
    quiet();
    const warmUp = vi.spyOn(FastCheckpoints.prototype, "warmUp");
    const h = await openSdkStore(mkTmp(), { [SDK_STORE_ENV]: "sdk" });
    expect(h?.mode).toBe("sdk");
    expect(h?.fast).toBeNull();
    expect(h?.store.checkpoints).not.toBeInstanceOf(FastCheckpoints);
    expect(warmUp).not.toHaveBeenCalled();
  });

  it("标记文件 USE_SDK_STORE 存在：用 SDK 自带实现（桌面包的一键回退）", async () => {
    quiet();
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, SDK_STORE_MARKER), "");
    const h = await openSdkStore(dir, {});
    expect(h?.mode).toBe("sdk");
    expect(h?.fast).toBeNull();
  });

  it("环境变量 fast 压过标记文件", async () => {
    quiet();
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, SDK_STORE_MARKER), "");
    const h = await openSdkStore(dir, { [SDK_STORE_ENV]: "fast" });
    expect(h?.mode).toBe("fast");
  });

  it("预热失败：回退 SDK 自带实现、不抛、有告警（此时尚无写入，回退安全）", async () => {
    const { warn } = quiet();
    vi.spyOn(FastCheckpoints.prototype, "warmUp").mockRejectedValueOnce(
      new Error("boom"),
    );
    const dir = mkTmp();
    const h = await openSdkStore(dir, {});
    expect(h?.mode).toBe("sdk");
    expect(h?.fast).toBeNull();
    expect(h?.store.checkpoints).not.toBeInstanceOf(FastCheckpoints);
    expect(warn).toHaveBeenCalled();
    // 回退后的 store 仍然可用
    await seed(h!.store.checkpoints, 3);
    expect(await allBlobsOk(h!.store.checkpoints, 3)).toBe(true);
  });
});

describe("openSdkStore：与 SDK 原实现互操作", () => {
  it("四个子 store 都可用，落盘内容 SDK 原实现全部读得到", async () => {
    quiet();
    const dir = mkTmp();
    const h = await openSdkStore(dir, {});
    expect(h?.mode).toBe("fast");
    const { store } = h!;
    const now = Date.now();

    await store.agents.create({
      agent: { agentId: "ag-1", cwd: "/w", status: "idle", createdAt: now, updatedAt: now },
    });
    await seed(store.checkpoints, 8, "ag-1");
    await store.runs.create({
      run: {
        runId: "r1",
        agentId: "ag-1",
        turnNumber: 1,
        status: "finished",
        createdAt: now,
        updatedAt: now,
      },
    });
    await store.runEvents.append({ runId: "r1", eventType: "x", payload: { a: 1 } });

    const sdk = await loadSdk();
    const ref = new sdk.JsonlLocalAgentStore(dir);
    expect((await ref.agents.get({ agentId: "ag-1" }))?.cwd).toBe("/w");
    expect((await ref.runs.get({ agentId: "ag-1", runId: "r1" }))?.status).toBe("finished");
    expect((await ref.runEvents.list({ runId: "r1" })).items).toHaveLength(1);
    expect(await sdkReaderOk(dir, sdk, 8, {}, "ag-1")).toBe(true);
  });

  it("SDK 原实现先写的库：fast 启动后全部可读，之后 fast 的写入 SDK 原实现也读得到", async () => {
    quiet();
    const dir = mkTmp();
    const sdk = await loadSdk();
    await seed(new sdk.JsonlLocalAgentStore(dir).checkpoints, 12);

    const h = await openSdkStore(dir, {});
    expect(h?.mode).toBe("fast");
    expect(await allBlobsOk(h!.store.checkpoints, 12)).toBe(true);

    await h!.store.checkpoints.create({ agentId: A, blobId: "b12", data: blobData(12) });
    expect(await sdkReaderOk(dir, sdk, 13)).toBe(true);
  });

  it("回退（sdk 模式）读写同一份文件：fast 写过的库切回 SDK 自带实现完全可读（回滚路径）", async () => {
    quiet();
    const dir = mkTmp();
    const fastH = await openSdkStore(dir, {});
    await seed(fastH!.store.checkpoints, 20);

    const sdkH = await openSdkStore(dir, { [SDK_STORE_ENV]: "sdk" });
    expect(sdkH?.mode).toBe("sdk");
    expect(await allBlobsOk(sdkH!.store.checkpoints, 20)).toBe(true);
    // 回退之后的写入，再切回 fast 也读得到
    await sdkH!.store.checkpoints.create({ agentId: A, blobId: "b20", data: blobData(20) });
    const again = await openSdkStore(dir, {});
    expect(sameBytes(await again!.store.checkpoints.get({ agentId: A, blobId: "b20" }), blobData(20))).toBe(true);
  });

  it("worker IPC 的 JSON 往返：不抛，checkpoints 只留标识、不序列化内部状态", async () => {
    quiet();
    const dir = mkTmp();
    const h = await openSdkStore(dir, {});
    await seed(h!.store.checkpoints, 50);
    const json = JSON.stringify(h!.store);
    const back = JSON.parse(json) as { checkpoints: unknown };
    expect(back.checkpoints).toEqual({ kind: "fast-checkpoints", file: fileOf(dir) });
    expect(json.length).toBeLessThan(2000);
  });
});

describe("getSdkStoreHandle：进程级单例", () => {
  it("并发 20 次拿到同一个句柄，且只预热一次（同目录只会有一个 FastCheckpoints）", async () => {
    quiet();
    process.env.FLOWSHIP_DATA_DIR = mkTmp();
    const warmUp = vi.spyOn(FastCheckpoints.prototype, "warmUp");
    const hs = await Promise.all(
      Array.from({ length: 20 }, () => getSdkStoreHandle()),
    );
    expect(new Set(hs).size).toBe(1);
    expect(hs[0]?.mode).toBe("fast");
    expect(warmUp).toHaveBeenCalledTimes(1);
    // 之后的串行调用也复用
    expect(await getSdkStoreHandle()).toBe(hs[0]);
  });

  it("数据目录变了：换新句柄，不复用旧目录的实例", async () => {
    quiet();
    process.env.FLOWSHIP_DATA_DIR = mkTmp();
    const a = await getSdkStoreHandle();
    process.env.FLOWSHIP_DATA_DIR = mkTmp();
    const b = await getSdkStoreHandle();
    expect(b).not.toBe(a);
    expect(b?.dir).not.toBe(a?.dir);
  });

  it("打开失败不缓存：占用 store 目录位置的文件删掉后，下次调用重试成功", async () => {
    quiet();
    const root = mkTmp();
    process.env.FLOWSHIP_DATA_DIR = root;
    const dir = path.join(root, SDK_AGENT_STORE_DIRNAME);
    fs.writeFileSync(dir, "我是个文件，占着 store 目录的位置");

    await expect(getSdkStoreHandle()).rejects.toBeTruthy();
    fs.rmSync(dir);
    const h = await getSdkStoreHandle();
    expect(h?.mode).toBe("fast");
  });
});

describe("withCursorJsonlStore", () => {
  it("未传 store：补上单例句柄里的 store，并保留 local 的其他字段", async () => {
    quiet();
    process.env.FLOWSHIP_DATA_DIR = mkTmp();
    const input: { local: { cwd: string; store?: unknown } } = {
      local: { cwd: "/x" },
    };
    const out = await withCursorJsonlStore(input);
    const h = await getSdkStoreHandle();
    expect(out.local.store).toBe(h?.store);
    expect(out.local.cwd).toBe("/x");
  });

  it("调用方已传 store：原样返回，且不触发打开 / 预热", async () => {
    quiet();
    process.env.FLOWSHIP_DATA_DIR = mkTmp();
    const warmUp = vi.spyOn(FastCheckpoints.prototype, "warmUp");
    const existing = { kind: "already" };
    const input = { local: { cwd: "/x", store: existing } };
    const out = await withCursorJsonlStore(input);
    expect(out).toBe(input);
    expect(warmUp).not.toHaveBeenCalled();
  });
});
