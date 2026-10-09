/**
 * sdk-store-gc 的 store 路径：删数据的代码必须有锁。
 *
 * 搭真实 store（SDK 的 JsonlLocalAgentStore + FastCheckpoints），GC 经公共 API 清孤儿，
 * 最后用 **SDK 原实现重新读盘** 核对落盘结果（不信内存状态）。
 *
 * 覆盖：保留规则真值表（planOrphans）、空过滤器守卫、僵尸 running 回收、
 * 本进程写过的 agent 受保护、幽灵残留清理、备份、幂等、GC 期间并发写不丢、
 * 中途失败可重入、各 skipped 分支、回退模式走文件路径。
 */
import fs from "node:fs";
import path from "node:path";

import type {
  LocalAgentDocument,
  LocalAgentRunDocument,
  LocalAgentStore,
} from "@cursor/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openSdkStore, type SdkStoreHandle } from "@/lib/server/sdk-agent-store";
import {
  GC_GRACE_MS,
  gcSdkStoreOnce,
  nonEmpty,
  planOrphans,
} from "@/lib/server/sdk-store-gc";

import {
  blobData,
  cleanupTmps,
  loadSdk,
  mkTmp,
  sameBytes,
  seed,
} from "./helpers/fast-store-helpers";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

// 端到端用例要先用 SDK 原实现预写一整个库（几十次文件追加 / 重写）。Windows（NTFS + Defender 实时扫描）上
// 每次文件操作几十毫秒，单个用例本来就要 3~6 秒（CI 压测里最慢 9.3 秒），卡在默认 5 秒超时的边缘会随机误报
// ——纯慢，不是数据问题（放宽超时后同一批压测 0 失败，断言失败从未出现）。30 秒仍足以暴露死锁 / 无限重试。
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTmps();
});

const quiet = () => ({
  log: vi.spyOn(console, "log").mockImplementation(() => undefined),
  warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
});

// ───────────────────────── planOrphans（纯函数） ─────────────────────────

const agentRow = (agentId: string, updatedAt: number) => ({
  agentId,
  createdAt: updatedAt,
  updatedAt,
});
const runRow = (agentId: string, updatedAt: number, runId = `run-${agentId}`) => ({
  runId,
  agentId,
  createdAt: updatedAt,
  updatedAt,
});

const plan = (over: Partial<Parameters<typeof planOrphans>[0]> = {}) =>
  planOrphans({
    live: new Set(),
    checkpointAgentIds: [],
    agents: [],
    runs: [],
    touched: new Set(),
    now: NOW,
    graceMs: GC_GRACE_MS,
    ...over,
  });

describe("planOrphans 保留规则", () => {
  const old = NOW - DAY;

  it("哪都不认的才是孤儿；live / 本进程写过 / 宽限期内 一律保留", () => {
    const r = plan({
      live: new Set(["live"]),
      touched: new Set(["touched"]),
      agents: [
        agentRow("live", old),
        agentRow("touched", old),
        agentRow("recent", NOW - 60_000),
        agentRow("dead", old),
      ],
      checkpointAgentIds: ["live", "touched", "recent", "dead"],
    });
    expect(r.orphans).toEqual(["dead"]);
    expect(r.kept).toBe(3);
  });

  it("宽限期边界：恰好等于 graceMs 不再受保护，少 1ms 仍受保护", () => {
    const at = plan({ agents: [agentRow("a", NOW - GC_GRACE_MS)] });
    expect(at.orphans).toEqual(["a"]);
    const inside = plan({ agents: [agentRow("a", NOW - GC_GRACE_MS + 1)] });
    expect(inside.orphans).toEqual([]);
  });

  it("created / updated 取较新的一个；run 的近期活动也保护它的 agent", () => {
    const r1 = plan({
      agents: [{ agentId: "a", createdAt: NOW - DAY, updatedAt: NOW - 1000 }],
    });
    expect(r1.orphans).toEqual([]);
    const r2 = plan({
      agents: [agentRow("b", NOW - DAY)],
      runs: [runRow("b", NOW - 1000)],
    });
    expect(r2.orphans).toEqual([]);
  });

  it("只出现在 checkpoints 里的幽灵 agent：不在 live / touched 就是孤儿", () => {
    const r = plan({ checkpointAgentIds: ["ghost"] });
    expect(r.orphans).toEqual(["ghost"]);
  });

  it("只出现在 runs 里的 agent 同理；orphanRunIds 只含孤儿名下的 run", () => {
    const r = plan({
      live: new Set(["live"]),
      runs: [
        runRow("live", NOW - DAY),
        runRow("dead", NOW - DAY, "run-dead-1"),
        runRow("dead", NOW - DAY, "run-dead-2"),
      ],
    });
    expect(r.orphans).toEqual(["dead"]);
    expect(r.orphanRunIds.sort()).toEqual(["run-dead-1", "run-dead-2"]);
  });

  it("时间字段异常（NaN）按近期处理——宁可少删", () => {
    const r = plan({
      agents: [{ agentId: "a", createdAt: Number.NaN, updatedAt: Number.NaN }],
    });
    expect(r.orphans).toEqual([]);
  });

  it("空 agentId 不确定 → 保留", () => {
    const r = plan({ checkpointAgentIds: [""] });
    expect(r.orphans).toEqual([]);
    expect(r.kept).toBe(1);
  });

  it("同一 agent 多处出现只算一次", () => {
    const r = plan({
      checkpointAgentIds: ["d", "d"],
      agents: [agentRow("d", NOW - DAY)],
      runs: [runRow("d", NOW - DAY)],
    });
    expect(r.orphans).toEqual(["d"]);
  });
});

describe("nonEmpty：SDK 过滤器『空 = 匹配全部』的纵深防御", () => {
  it("空数组抛错（绝不能把空过滤器递给 delete）", () => {
    expect(() => nonEmpty([], "agentIds")).toThrow(/空 agentIds/);
  });
  it("非空原样返回", () => {
    const l = ["a"];
    expect(nonEmpty(l, "agentIds")).toBe(l);
  });
});

// ───────────────────────── 端到端（真实 store） ─────────────────────────

type SdkRef = LocalAgentStore;

const mkAgent = (
  agentId: string,
  updatedAt: number,
  status: LocalAgentDocument["status"] = "idle",
): LocalAgentDocument => ({
  agentId,
  cwd: "/w",
  status,
  ...(status === "running" ? { activeRunId: `run-${agentId}` } : {}),
  createdAt: updatedAt - 1000,
  updatedAt,
});

const mkRun = (
  agentId: string,
  updatedAt: number,
  status: LocalAgentRunDocument["status"] = "finished",
): LocalAgentRunDocument => ({
  runId: `run-${agentId}`,
  agentId,
  turnNumber: 1,
  status,
  createdAt: updatedAt - 1000,
  updatedAt,
});

/** 往 store 里造一个完整 agent：agents 行 + run + run_event + n 个 blob */
const populate = async (
  s: LocalAgentStore,
  agentId: string,
  updatedAt: number,
  n = 4,
  status: LocalAgentDocument["status"] = "idle",
): Promise<void> => {
  await s.agents.create({ agent: mkAgent(agentId, updatedAt, status) });
  await s.runs.create({
    run: mkRun(agentId, updatedAt, status === "running" ? "running" : "finished"),
  });
  await s.runEvents.append({
    runId: `run-${agentId}`,
    eventType: "t",
    payload: { agentId },
  });
  await seed(s.checkpoints, n, agentId);
};

interface World {
  root: string;
  dir: string;
  ref: SdkRef;
  handle: SdkStoreHandle;
}

const writeLive = (root: string, ids: string[]): void => {
  ids.forEach((id, i) => {
    const d = path.join(root, "tasks", `t${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify({ sessionAgentId: id }));
  });
};

/**
 * 搭库：先用 SDK 原实现预写（这些 agent 对「本进程」来说都不是 touched），
 * 再打开 fast handle。
 *  live      活名单里                              → 留
 *  recent    不在活名单、1 分钟前刚活动              → 留（宽限）
 *  dead1/2   不在活名单、1 天前                      → 清
 *  zombie    不在活名单、1 天前、status=running      → 清（崩溃遗留的僵尸）
 *  ghost     只有 checkpoints、没有 agents / runs 行 → 清
 */
const buildWorld = async (): Promise<World> => {
  const root = mkTmp();
  const dir = path.join(root, "sdk-agent-store");
  fs.mkdirSync(dir, { recursive: true });
  const sdk = await loadSdk();
  const ref = new sdk.JsonlLocalAgentStore(dir);
  await populate(ref, "agent-live", NOW - DAY);
  await populate(ref, "agent-recent", NOW - 60_000);
  await populate(ref, "agent-dead1", NOW - DAY);
  await populate(ref, "agent-dead2", NOW - 2 * DAY);
  await populate(ref, "agent-zombie", NOW - DAY, 4, "running");
  await seed(ref.checkpoints, 3, "agent-ghost");
  writeLive(root, ["agent-live"]);
  const handle = await openSdkStore(dir, {});
  if (!handle || handle.mode !== "fast") throw new Error("测试前置：应是 fast 句柄");
  return { root, dir, ref, handle };
};

const agentIdsOnDisk = async (ref: SdkRef): Promise<string[]> =>
  (await ref.agents.list({ filter: { limit: 1000 } })).items.map((a) => a.agentId).sort();

const runAgentsOnDisk = async (ref: SdkRef): Promise<string[]> =>
  (await ref.runs.list({ filter: { limit: 1000 } })).items.map((r) => r.agentId).sort();

const blobsOnDisk = async (ref: SdkRef, agentId: string): Promise<string[]> => [
  ...(await ref.checkpoints.list({ filter: { agentIds: [agentId], limit: 1000 } }))
    .items,
];

describe("gcSdkStoreOnce：store 路径端到端", () => {
  it("清孤儿（含僵尸 running / 幽灵残留）、保留 live / 宽限 / 本进程写过，落盘结果 SDK 原实现读得到", async () => {
    quiet();
    const { dir, ref, handle } = await buildWorld();
    // 本进程新写的 agent：agents 行很老、不在活名单，但 checkpoint 是本进程写的 → touched 保护
    await handle.store.agents.create({ agent: mkAgent("agent-touched", NOW - 5 * DAY) });
    await seed(handle.store.checkpoints, 3, "agent-touched");

    const stats = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });

    expect(stats.skipped).toBeUndefined();
    expect(stats.via).toBe("store");
    expect(stats.orphanAgents).toBe(4); // dead1 / dead2 / zombie / ghost
    expect((stats.checkpointsAfter ?? 0) < (stats.checkpointsBefore ?? 0)).toBe(true);
    expect((stats.bytesAfter ?? 0) < (stats.bytesBefore ?? 0)).toBe(true);

    // 用 SDK 原实现重新读盘核对
    const keep = ["agent-live", "agent-recent", "agent-touched"];
    expect(await agentIdsOnDisk(ref)).toEqual(["agent-live", "agent-recent", "agent-touched"]);
    expect(await runAgentsOnDisk(ref)).toEqual(["agent-live", "agent-recent"]);
    for (const id of keep) {
      expect((await blobsOnDisk(ref, id)).length).toBeGreaterThan(0);
    }
    for (const id of ["agent-dead1", "agent-dead2", "agent-zombie", "agent-ghost"]) {
      expect(await blobsOnDisk(ref, id)).toEqual([]);
      expect((await ref.agents.get({ agentId: id })) ?? null).toBeNull();
    }
    expect((await ref.runEvents.list({ runId: "run-agent-live" })).items).toHaveLength(1);
    expect((await ref.runEvents.list({ runId: "run-agent-dead1" })).items).toHaveLength(0);
    expect((await ref.runEvents.list({ runId: "run-agent-zombie" })).items).toHaveLength(0);

    // 活数据字节完全一致
    for (let i = 0; i < 4; i++) {
      expect(
        sameBytes(await ref.checkpoints.get({ agentId: "agent-live", blobId: `b${i}` }), blobData(i)),
      ).toBe(true);
    }

    // 有备份，且备份里还留着被清掉的孤儿（出错可恢复）
    const bak = fs.readdirSync(dir).find((n) => n.startsWith(".gc-backup-"));
    expect(bak).toBeTruthy();
    const sdk = await loadSdk();
    const bakStore = new sdk.JsonlLocalAgentStore(path.join(dir, bak!));
    expect((await blobsOnDisk(bakStore, "agent-dead1")).length).toBe(4);
  });

  it("列表分页很小（每页 2 条）也要翻完整：结果与默认分页一致", async () => {
    quiet();
    const { ref, handle } = await buildWorld();
    const stats = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW, pageSize: 2 });
    expect(stats.skipped).toBeUndefined();
    expect(stats.orphanAgents).toBe(4);
    expect(await agentIdsOnDisk(ref)).toEqual(["agent-live", "agent-recent"]);
    expect(await runAgentsOnDisk(ref)).toEqual(["agent-live", "agent-recent"]);
  });

  it("GC 之后同一个 handle 继续读写正常，写入 SDK 原实现读得到（重写后索引健康）", async () => {
    quiet();
    const { ref, handle } = await buildWorld();
    await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });

    for (let i = 0; i < 4; i++) {
      expect(
        sameBytes(
          await handle.store.checkpoints.get({ agentId: "agent-live", blobId: `b${i}` }),
          blobData(i),
        ),
      ).toBe(true);
    }
    await handle.store.checkpoints.create({
      agentId: "agent-live",
      blobId: "after-gc",
      data: Buffer.from("post-gc"),
    });
    expect(
      sameBytes(await ref.checkpoints.get({ agentId: "agent-live", blobId: "after-gc" }), Buffer.from("post-gc")),
    ).toBe(true);
    // 被清掉的 agent 经 handle 也读不到
    expect(await handle.store.checkpoints.get({ agentId: "agent-dead1", blobId: "b0" })).toBeNull();
  });

  it("幂等：第二轮没有孤儿，不改任何东西、不重写文件", async () => {
    quiet();
    const { dir, handle } = await buildWorld();
    await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });
    const rewrites = handle.fast!.getStats().rewrites;
    const size = fs.statSync(path.join(dir, "checkpoints.ndjson")).size;

    const again = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });
    expect(again.via).toBe("store");
    expect(again.orphanAgents).toBe(0);
    expect(handle.fast!.getStats().rewrites).toBe(rewrites);
    expect(fs.statSync(path.join(dir, "checkpoints.ndjson")).size).toBe(size);
  });

  it("GC 进行中并发创建 blob：一个都不丢（写队列互斥）", async () => {
    quiet();
    const { ref, handle } = await buildWorld();
    const gc = gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });
    const writes = Array.from({ length: 30 }, (_, i) =>
      handle.store.checkpoints.create({
        agentId: `agent-new-${i % 5}`,
        blobId: `n${i}`,
        data: blobData(i),
      }),
    );
    const [stats] = await Promise.all([gc, ...writes]);
    expect(stats.skipped).toBeUndefined();
    for (let i = 0; i < 30; i++) {
      expect(
        sameBytes(
          await ref.checkpoints.get({ agentId: `agent-new-${i % 5}`, blobId: `n${i}` }),
          blobData(i),
        ),
      ).toBe(true);
    }
    expect(await blobsOnDisk(ref, "agent-dead1")).toEqual([]);
  });

  // 回归：CI 压测里 Ubuntu / macOS 各 3/18 次、上一轮 Windows 1 次失败的真实竞态。
  // create 在 `fd.appendFile` 之后还要 close + fsync + 更新索引，最后才标记 touched；这段 I/O 窗口里文件中
  // 已经有这个新 agent 的行，读侧（GC 的 agentIds → catchUp）能追赶到它，它没有 agents 行、不在活名单、
  // 也还没被 touched → 被当成幽灵孤儿，连刚写的 blob 一起清掉（数据丢失）。
  // 这里把窗口撑开成确定性的：卡在第一次 fsync，让 GC 的 plan 在窗口里跑完，再放行 create。
  it("create 已追加进文件、还没返回时被 GC 撞上：新 agent 的 blob 不能被当幽灵孤儿清掉", async () => {
    quiet();
    const { ref, handle } = await buildWorld();

    const proto = Object.getPrototypeOf(handle.fast!) as {
      syncFile: () => Promise<void>;
    };
    const realSync = proto.syncFile;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let landed!: () => void;
    const onDisk = new Promise<void>((r) => {
      landed = r;
    });
    let first = true;
    const syncSpy = vi
      .spyOn(proto, "syncFile")
      .mockImplementation(async function (this: unknown) {
        if (first) {
          first = false;
          landed(); // 此刻 fd.appendFile 已完成：文件里已有这一行，create 还卡在 fsync 上
          await gate;
        }
        return realSync.call(this);
      });
    // GC 在 plan 之后第一个会调的 API 是 runEvents.delete：这时 plan 一定已经在窗口里完成，再放行 create
    const realDel = handle.store.runEvents.delete.bind(handle.store.runEvents);
    const delSpy = vi
      .spyOn(handle.store.runEvents, "delete")
      .mockImplementation((...a: Parameters<typeof realDel>) => {
        release();
        return realDel(...a);
      });
    const safety = setTimeout(() => release(), 5_000); // 兜底：任何意外都别把测试挂死

    try {
      const w = handle.store.checkpoints.create({
        agentId: "agent-new-x",
        blobId: "nx",
        data: blobData(7),
      });
      await onDisk;
      const stats = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });
      await w;

      expect(stats.skipped).toBeUndefined();
      // 新 agent 的 blob 必须还在
      expect(
        sameBytes(
          await ref.checkpoints.get({ agentId: "agent-new-x", blobId: "nx" }),
          blobData(7),
        ),
      ).toBe(true);
      // 真孤儿照清：保护不能变成「什么都不删」
      expect(await blobsOnDisk(ref, "agent-dead1")).toEqual([]);
      expect(await blobsOnDisk(ref, "agent-ghost")).toEqual([]);
    } finally {
      clearTimeout(safety);
      release();
      syncSpy.mockRestore();
      delSpy.mockRestore();
    }
  });

  it("中途失败可重入：agents 行最后删，下一轮接着把孤儿清干净", async () => {
    quiet();
    const { ref, handle } = await buildWorld();
    const spy = vi
      .spyOn(handle.fast!, "delete")
      .mockRejectedValueOnce(new Error("boom"));

    const first = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });
    expect(first.skipped).toBe("error");
    // checkpoints 没删成：孤儿的 agents 行必须还在（它是下一轮识别孤儿的凭据）
    const ids = await agentIdsOnDisk(ref);
    expect(ids).toContain("agent-dead1");
    expect(ids).toContain("agent-zombie");
    expect(await blobsOnDisk(ref, "agent-dead1")).not.toEqual([]);
    // 活的纹丝不动
    expect(ids).toContain("agent-live");

    spy.mockRestore();
    const second = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });
    expect(second.skipped).toBeUndefined();
    expect(await blobsOnDisk(ref, "agent-dead1")).toEqual([]);
    expect(await agentIdsOnDisk(ref)).toEqual(["agent-live", "agent-recent"]);
  });
});

describe("gcSdkStoreOnce：跳过分支与路径选择", () => {
  it("小库跳过（small），不动任何数据", async () => {
    quiet();
    const { ref, handle } = await buildWorld();
    const stats = await gcSdkStoreOnce({ handle, minBytes: 10 ** 12, now: NOW });
    expect(stats.skipped).toBe("small");
    expect(await agentIdsOnDisk(ref)).toContain("agent-dead1");
  });

  it("活名单为空：跳过、不删（全清任务后的残留不敢动）", async () => {
    quiet();
    const { root, ref, handle } = await buildWorld();
    fs.writeFileSync(path.join(root, "tasks", "t0", "meta.json"), JSON.stringify({}));
    const stats = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });
    expect(stats.skipped).toBe("empty-live-list");
    expect(await agentIdsOnDisk(ref)).toContain("agent-dead1");
    expect((await blobsOnDisk(ref, "agent-dead1")).length).toBe(4);
  });

  it("读不到任务目录：跳过（no-live-list）、不删", async () => {
    quiet();
    const { root, ref, handle } = await buildWorld();
    fs.rmSync(path.join(root, "tasks"), { recursive: true, force: true });
    const stats = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });
    expect(stats.skipped).toBe("no-live-list");
    expect(await agentIdsOnDisk(ref)).toContain("agent-dead1");
  });

  it("宽限期调大：有时间戳的 agent 都算近期、一个不删（只剩没有时间戳的幽灵）", async () => {
    const { warn } = quiet();
    const { ref, handle } = await buildWorld();
    const stats = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW, graceMs: 10 * DAY });
    const why = JSON.stringify({ stats, warn: warn.mock.calls.map((c) => c.map(String)) });
    expect(stats.skipped, why).toBeUndefined();
    expect(stats.orphanAgents, why).toBe(1); // 只有 ghost：它没有任何时间戳，无从宽限
    expect(await blobsOnDisk(ref, "agent-dead1")).not.toEqual([]);
    expect(await agentIdsOnDisk(ref)).toContain("agent-zombie");
    expect(await blobsOnDisk(ref, "agent-ghost")).toEqual([]);
  });

  it("回退模式（sdk 句柄）与显式 handle:null 都走文件路径", async () => {
    quiet();
    const root = mkTmp();
    const dir = path.join(root, "sdk-agent-store");
    fs.mkdirSync(dir, { recursive: true });
    writeLive(root, ["agent-live"]);
    const sdk = await loadSdk();
    const seedStore = new sdk.JsonlLocalAgentStore(dir);
    await seed(seedStore.checkpoints, 3, "agent-live");
    await seed(seedStore.checkpoints, 3, "agent-dead");

    const sdkHandle = await openSdkStore(dir, { FLOWSHIP_SDK_STORE: "sdk" });
    expect(sdkHandle?.mode).toBe("sdk");
    const viaSdkHandle = await gcSdkStoreOnce({ handle: sdkHandle, dir, minBytes: 1 });
    expect(viaSdkHandle.via).toBe("files");
    expect(viaSdkHandle.checkpointsAfter).toBe(3);

    const viaNull = await gcSdkStoreOnce({ handle: null, dir, minBytes: 1 });
    expect(viaNull.via).toBe("files");
  });
});

// 与 sdk-store-gc.test.ts 里 files 路径的同名用例成对：GC 有两处 backup-failed 分支（files / store），各自要被锁住。
describe("备份失败 → 不动手", () => {
  it("store 路径：备份目录建不出来 → 跳过（backup-failed），四份 ndjson 字节不动，孤儿还在", async () => {
    quiet();
    const { dir, ref, handle } = await buildWorld();
    const names = ["checkpoints.ndjson", "runs.ndjson", "agents.ndjson", "run_events.ndjson"];
    const before = names.map((n) => fs.readFileSync(path.join(dir, n)));
    const realMkdir = fs.promises.mkdir.bind(fs.promises) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(fs.promises, "mkdir").mockImplementation(((...a: unknown[]) =>
      String(a[0]).includes(".gc-backup-")
        ? Promise.reject(Object.assign(new Error("EACCES: simulated"), { code: "EACCES" }))
        : realMkdir(...a)) as never); // afterEach 里的 vi.restoreAllMocks 会还原

    const stats = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });

    expect(stats.skipped).toBe("backup-failed");
    names.forEach((n, i) => {
      expect(Buffer.compare(fs.readFileSync(path.join(dir, n)), before[i])).toBe(0);
    });
    expect((await blobsOnDisk(ref, "agent-dead1")).length).toBe(4); // 孤儿还在：什么都没删
  });
});
