/**
 * run-perf 默认环境快照里的 store 部分：run_events 实现 / 体积 + runs.ndjson 体积。
 *
 * 真实 openSdkStore（临时目录）+ 真实 tracker 收口，不 mock 环境提供者——
 * 钉死两件事：
 * 1. 记录里的数字确实来自 store 句柄（内存实现读保留量；回退到 SDK 落盘时读文件大小）
 * 2. 观测绝不触发 store 打开（没人打开过 store 时，记录里就没有 store 这一组）
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunPerfRecord } from "@/lib/server/run-perf-record";
import {
  __resetSdkStoreHandleForTests,
  getSdkStoreHandle,
  peekSdkStoreHandle,
  SDK_RUN_EVENTS_ENV,
  SDK_STORE_ENV,
} from "@/lib/server/sdk-agent-store";

import { cleanupTmps, mkTmp } from "./helpers/fast-store-helpers";

const prevDataDir = process.env.FLOWSHIP_DATA_DIR;
const prevMode = process.env[SDK_STORE_ENV];
const prevRunEvents = process.env[SDK_RUN_EVENTS_ENV];

const restoreEnv = (key: string, prev: string | undefined): void => {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
};

beforeEach(() => {
  delete process.env[SDK_STORE_ENV];
  delete process.env[SDK_RUN_EVENTS_ENV];
  __resetSdkStoreHandleForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetSdkStoreHandleForTests();
  restoreEnv("FLOWSHIP_DATA_DIR", prevDataDir);
  restoreEnv(SDK_STORE_ENV, prevMode);
  restoreEnv(SDK_RUN_EVENTS_ENV, prevRunEvents);
  cleanupTmps();
});

/** 把数据根指到一个临时目录（store 目录 = <data>/sdk-agent-store） */
const useTmpDataRoot = (): string => {
  const root = mkTmp();
  process.env.FLOWSHIP_DATA_DIR = root;
  return root;
};

/** 真实 tracker 走一个最小的 run：受理 → finished，返回收口的那条记录（走默认环境快照） */
const runOnce = async (): Promise<RunPerfRecord> => {
  const { createRunPerfTracker } = await import("@/lib/server/run-perf");
  const records: RunPerfRecord[] = [];
  const tracker = createRunPerfTracker({
    taskId: "t1",
    agentId: "agent-x",
    runKind: "chat-followup",
    sink: (r) => records.push(r),
  });
  const listeners = new Set<(s: "finished") => void>();
  tracker.attachRun({
    id: "run-1",
    requestId: "req-1",
    status: "running",
    onDidChangeStatus: (l: (s: never) => void) => {
      listeners.add(l as (s: "finished") => void);
      return () => listeners.delete(l as (s: "finished") => void);
    },
  } as Parameters<typeof tracker.attachRun>[0]);
  for (const l of [...listeners]) l("finished");
  await vi.waitFor(() => expect(records).toHaveLength(1), { timeout: 5_000 });
  return records[0];
};

const bigPayload = (chars: number) => ({ type: "assistant", text: "x".repeat(chars) });

const appendEvent = async (
  handle: NonNullable<Awaited<ReturnType<typeof getSdkStoreHandle>>>,
  chars: number,
): Promise<void> => {
  await handle.store.runEvents.append({
    runId: "run-1",
    eventType: "run_stream_event",
    payload: bigPayload(chars),
    payloadRef: null,
    idempotencyKey: null,
  });
};

describe("默认环境快照：store 部分", () => {
  it("默认（内存实现）：记录 runEvents=memory、保留条数 / 体积 / 回收数，以及 runs.ndjson 体积", async () => {
    useTmpDataRoot();
    const handle = await getSdkStoreHandle();
    expect(handle?.runEvents).toBe("memory");
    if (!handle) throw new Error("store 没打开");
    for (let i = 0; i < 3; i += 1) await appendEvent(handle, 350_000);
    // 内存实现不落盘：目录里没有 run_events.ndjson
    expect(fs.existsSync(path.join(handle.dir, "run_events.ndjson"))).toBe(false);
    fs.writeFileSync(path.join(handle.dir, "runs.ndjson"), "r".repeat(300_000));

    const rec = await runOnce();
    expect(rec.store).toMatchObject({
      mode: "fast",
      runEvents: "memory",
      evCount: 3,
      evTrimmed: 0,
    });
    // 3 × 35 万字符 ≈ 1.0MB（payload 以 JSON 字符串保留，略大于 3 × 35 万）
    expect(rec.store?.evMB).toBeGreaterThanOrEqual(1);
    expect(rec.store?.evMB).toBeLessThan(1.2);
    expect(rec.store?.runsMB).toBeCloseTo(300_000 / 1048576, 2);
  });

  it("回退到 SDK 落盘（FLOWSHIP_SDK_RUN_EVENTS=file）：evMB 取文件大小；没有内存实现的计数字段", async () => {
    useTmpDataRoot();
    process.env[SDK_RUN_EVENTS_ENV] = "file";
    const handle = await getSdkStoreHandle();
    expect(handle?.runEvents).toBe("file");
    if (!handle) throw new Error("store 没打开");
    for (let i = 0; i < 2; i += 1) await appendEvent(handle, 350_000);
    const bytes = fs.statSync(path.join(handle.dir, "run_events.ndjson")).size;
    expect(bytes).toBeGreaterThan(700_000);
    // 显式保证没有 runs.ndjson（不依赖 SDK 是否惰性创建它）
    fs.rmSync(path.join(handle.dir, "runs.ndjson"), { force: true });

    const rec = await runOnce();
    expect(rec.store?.runEvents).toBe("file");
    expect(rec.store?.evMB).toBeCloseTo(bytes / 1048576, 2);
    expect(rec.store).not.toHaveProperty("evCount");
    expect(rec.store).not.toHaveProperty("evTrimmed");
    // runs.ndjson 不存在 → 字段缺省，不是 0 冒充
    expect(rec.store).not.toHaveProperty("runsMB");
  });

  it("整个 store 回退 SDK（FLOWSHIP_SDK_STORE=sdk）：mode=sdk、runEvents=file，没有 fast 才有的统计字段", async () => {
    useTmpDataRoot();
    process.env[SDK_STORE_ENV] = "sdk";
    const handle = await getSdkStoreHandle();
    expect(handle?.mode).toBe("sdk");

    const rec = await runOnce();
    expect(rec.store).toMatchObject({ mode: "sdk", runEvents: "file" });
    expect(rec.store).not.toHaveProperty("evCount");
    expect(rec.store).not.toHaveProperty("blobs");
  });

  it("没有人打开过 store：记录里没有 store 这一组，而且观测不会把 store 打开", async () => {
    useTmpDataRoot();
    expect(peekSdkStoreHandle()).toBeNull();
    const rec = await runOnce();
    expect(rec).not.toHaveProperty("store");
    expect(peekSdkStoreHandle()).toBeNull();
  });
});
