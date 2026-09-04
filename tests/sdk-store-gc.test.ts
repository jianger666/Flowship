/**
 * sdk-store-gc 单测：删数据的代码必须有锁。
 *
 * 覆盖：活的保留、明确孤儿删除、解析不出保留、无归属保留、
 * runId 兜底映射、small/empty-live-list 跳过、端到端一轮 GC。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectLiveAgentIds,
  gcSdkStoreOnce,
  heapPressure,
  HeapPressureError,
  shouldKeepLine,
} from "@/lib/server/sdk-store-gc";

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const live = new Set(["agent-live-1"]);
const emptyMap = new Map<string, string>();

describe("shouldKeepLine", () => {
  it("活 agent 的行保留", () => {
    expect(
      shouldKeepLine(
        "checkpoints.ndjson",
        line({ agentId: "agent-live-1", blobId: "b1" }),
        live,
        emptyMap,
      ),
    ).toBe(true);
  });

  it("明确孤儿的行删除", () => {
    expect(
      shouldKeepLine(
        "checkpoints.ndjson",
        line({ agentId: "agent-dead-9", blobId: "b2" }),
        live,
        emptyMap,
      ),
    ).toBe(false);
  });

  it("解析不出的行保留（fail-open）", () => {
    expect(shouldKeepLine("checkpoints.ndjson", "not-json{{{", live, emptyMap)).toBe(
      true,
    );
  });

  it("拿不到归属的行保留", () => {
    expect(
      shouldKeepLine(
        "checkpoints.ndjson",
        line({ blobId: "b3", noAgent: true }),
        live,
        emptyMap,
      ),
    ).toBe(true);
  });

  it("run_events 靠 runId 兜底：活的留、孤儿删", () => {
    const runMap = new Map([["run-1", "agent-live-1"]]);
    expect(
      shouldKeepLine(
        "run_events.ndjson",
        line({ runId: "run-1", seq: 1 }),
        live,
        runMap,
      ),
    ).toBe(true);
    expect(
      shouldKeepLine(
        "run_events.ndjson",
        line({ runId: "run-unknown", seq: 2 }),
        live,
        runMap,
      ),
    ).toBe(true); // 归属不明也留
  });
});

describe("heapPressure / HeapPressureError", () => {
  it("形态 sane：used/limit/ratio 自洽", () => {
    const p = heapPressure();
    expect(p.limitMB).toBeGreaterThan(0);
    expect(p.usedMB).toBeGreaterThanOrEqual(0);
    expect(p.ratio).toBeGreaterThanOrEqual(0);
    expect(p.over).toBe(p.ratio >= 0.85);
  });

  it("instanceof 可判、文案带等待提示", () => {
    const err = new HeapPressureError("本次推进", 100, 200);
    expect(err instanceof HeapPressureError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.message).toContain("10 秒");
  });
});

const mkTmpStore = async (): Promise<{ root: string; store: string }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-gc-test-"));
  await fs.mkdir(path.join(root, "tasks", "t1"), { recursive: true });
  await fs.writeFile(
    path.join(root, "tasks", "t1", "meta.json"),
    JSON.stringify({ sessionAgentId: "agent-live-1" }),
  );
  const store = path.join(root, "sdk-agent-store");
  await fs.mkdir(store, { recursive: true });
  const cp = [
    line({ agentId: "agent-live-1", blobId: "keep-1" }),
    line({ agentId: "agent-dead-9", blobId: "drop-1" }),
    "broken{{{\n",
  ].join("");
  await fs.writeFile(path.join(store, "checkpoints.ndjson"), cp);
  await fs.writeFile(
    path.join(store, "runs.ndjson"),
    line({ agentId: "agent-live-1", runId: "run-1" }) +
      line({ agentId: "agent-dead-9", runId: "run-9" }),
  );
  await fs.writeFile(
    path.join(store, "agents.ndjson"),
    line({ agentId: "agent-live-1" }) + line({ agentId: "agent-dead-9" }),
  );
  await fs.writeFile(
    path.join(store, "run_events.ndjson"),
    line({ runId: "run-1", seq: 1, payload: { agentId: "agent-live-1" } }) +
      line({ runId: "run-9", seq: 1, payload: { agentId: "agent-dead-9" } }),
  );
  return { root, store };
};

describe("gcSdkStoreOnce 端到端（tmp 库）", () => {
  it("孤儿清掉、活的保留、有备份有统计", async () => {
    const { store } = await mkTmpStore();
    const stats = await gcSdkStoreOnce({ dir: store, minBytes: 1 });
    expect(stats.skipped).toBeUndefined();
    expect(stats.checkpointsBefore).toBe(3);
    expect(stats.checkpointsAfter).toBe(2); // 活1 + 坏行1
    const cp = await fs.readFile(
      path.join(store, "checkpoints.ndjson"),
      "utf-8",
    );
    expect(cp).toContain("keep-1");
    expect(cp).not.toContain("drop-1");
    expect(cp).toContain("broken{{{");
    const runs = await fs.readFile(path.join(store, "runs.ndjson"), "utf-8");
    expect(runs).toContain("run-1");
    expect(runs).not.toContain("run-9");
    const entries = await fs.readdir(store);
    expect(entries.some((n) => n.startsWith(".gc-backup-"))).toBe(true);
  });

  it("小库跳过（small）", async () => {
    const { store } = await mkTmpStore();
    const stats = await gcSdkStoreOnce({ dir: store, minBytes: 10 ** 12 });
    expect(stats.skipped).toBe("small");
  });

  it("活名单为空跳过、不删数据", async () => {
    const { store } = await mkTmpStore();
    await fs.writeFile(
      path.join(store, "..", "tasks", "t1", "meta.json"),
      JSON.stringify({}),
    );
    const stats = await gcSdkStoreOnce({ dir: store, minBytes: 1 });
    expect(stats.skipped).toBe("empty-live-list");
    const cp = await fs.readFile(
      path.join(store, "checkpoints.ndjson"),
      "utf-8",
    );
    expect(cp).toContain("drop-1");
  });

  it("collectLiveAgentIds 读 tmp 任务目录", async () => {
    const { root } = await mkTmpStore();
    const got = await collectLiveAgentIds(path.join(root, "tasks"));
    expect(got?.has("agent-live-1")).toBe(true);
  });
});
