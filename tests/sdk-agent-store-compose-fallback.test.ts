/**
 * sdk-agent-store：SDK 升级后 `composeLocalAgentStore` 还在、却抛错 → 回退 SDK 自带实现。
 *
 * 单独成文件：这里要把 `@cursor/sdk` 的 compose 换成会抛错的版本（vi.mock 是文件级的），
 * 其余导出（JsonlLocalAgentStore、paginateCheckpointBlobIds）保持真实实现。
 * 不回退会怎样：openSdkStore 抛错 → 每一次创建 / 恢复 agent 都失败，且不缓存失败、反复重试。
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FastCheckpoints } from "@/lib/server/fast-checkpoint-store";
import {
  __resetSdkStoreHandleForTests,
  getSdkStoreHandle,
  openSdkStore,
} from "@/lib/server/sdk-agent-store";

import {
  allBlobsOk,
  cleanupTmps,
  mkTmp,
  seed,
} from "./helpers/fast-store-helpers";

vi.mock("@cursor/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cursor/sdk")>();
  return {
    ...actual,
    composeLocalAgentStore: () => {
      throw new Error("compose behavior changed");
    },
  };
});

const prevDataDir = process.env.FLOWSHIP_DATA_DIR;

const quiet = () => ({
  log: vi.spyOn(console, "log").mockImplementation(() => undefined),
  warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
});

beforeEach(() => {
  __resetSdkStoreHandleForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetSdkStoreHandleForTests();
  if (prevDataDir === undefined) delete process.env.FLOWSHIP_DATA_DIR;
  else process.env.FLOWSHIP_DATA_DIR = prevDataDir;
  cleanupTmps();
});

describe("openSdkStore：compose 抛错", () => {
  it("回退 SDK 自带实现、不抛、有告警；回退后的 store 仍然可读写", async () => {
    const { warn } = quiet();
    const h = await openSdkStore(mkTmp(), {});
    expect(h).not.toBeNull();
    expect(h?.mode).toBe("sdk");
    expect(h?.fast).toBeNull();
    expect(h?.store.checkpoints).not.toBeInstanceOf(FastCheckpoints);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("composeLocalAgentStore")),
    ).toBe(true);

    await seed(h!.store.checkpoints, 3);
    expect(await allBlobsOk(h!.store.checkpoints, 3)).toBe(true);
  });

  it("旧 run_events.ndjson 原样不动：归档只在 compose 成功之后才动磁盘，回退到 SDK 自带实现时它还要被读写", async () => {
    quiet();
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, "run_events.ndjson"), "legacy\n");
    const h = await openSdkStore(dir, {});
    expect(h?.mode).toBe("sdk");
    expect(h?.runEvents).toBe("file");
    expect(h?.memoryRunEvents).toBeNull();
    expect(fs.readFileSync(path.join(dir, "run_events.ndjson"), "utf8")).toBe("legacy\n");
    expect(fs.existsSync(path.join(dir, ".quarantine"))).toBe(false);
  });

  it("进程级单例同样不抛：拿到的是回退后的句柄，且被缓存（不会每次重试 compose）", async () => {
    quiet();
    process.env.FLOWSHIP_DATA_DIR = mkTmp();
    const a = await getSdkStoreHandle();
    const b = await getSdkStoreHandle();
    expect(a?.mode).toBe("sdk");
    expect(b).toBe(a);
  });
});
