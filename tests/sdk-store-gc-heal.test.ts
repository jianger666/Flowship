/**
 * run_events 自愈：SDK 读 ndjson 只容忍「最后一行」损坏，中间坏一行就整体抛
 * `Corrupt local agent store`（1.0.31 / 1.0.37 同）。
 *
 * 复盘（2026-10-09）：真实库的 run_events.ndjson 里有一条 ~110KB 的记录被插进了换行、拆成两条
 * 坏记录（直接拼回去是合法 JSON）。store 路径的 GC 经 SDK 的 `runEvents.delete` 读它，从此每次
 * 启动都死在那一步、永久「本轮跳过」，checkpoints 再也不瘦身。当时的单测只用干净数据，没有锁住
 * 「库里本来就带着坏记录」这一条。
 *
 * 本文件锁：
 *  1. healRunEventsFile 的判据与 SDK 读取函数一致（尾行坏不算、中间坏才算），干净文件一个字节都不动；
 *  2. 复现线上损坏（一条记录被换行拆成两半）：修复前 SDK 读不了，修复后读得了，坏记录原文进旁路；
 *  3. 并发保护（处理期间文件被追加 → 放弃、不覆盖）、旁路份数上限、IO 失败不抛；
 *  4. 端到端：真实 store（SDK JsonlLocalAgentStore + FastCheckpoints）上 GC 不再「本轮跳过」。
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
import { gcSdkStoreOnce, healRunEventsFile } from "@/lib/server/sdk-store-gc";

import { cleanupTmps, loadSdk, mkTmp, seed } from "./helpers/fast-store-helpers";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const FILE = "run_events.ndjson";

// 端到端用例要先用 SDK 原实现预写一整个库；Windows 上单个用例就要几秒，放宽超时避免纯慢误报
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTmps();
});

const quiet = () => ({
  log: vi.spyOn(console, "log").mockImplementation(() => undefined),
  warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
});

/**
 * 一条合法的 run_events 记录。字段必须和 SDK 真实落盘的一致（探针实测：runId / seq / offset /
 * eventType / payload / payloadRef / idempotencyKey / createdAt）——SDK 的 list 会按形状过滤，
 * 缺字段的记录虽然 JSON.parse 得过，却会被 list 当成「不是事件」丢掉，断言就读到 0 条了。
 */
const rec = (i: number, text = `事件-${i}`): string =>
  JSON.stringify({
    runId: `run-${i}`,
    seq: 1,
    offset: "1",
    eventType: "t",
    payload: { text },
    payloadRef: null,
    idempotencyKey: null,
    createdAt: "2026-10-09T09:30:26.910Z",
  });

/** 把一行从中间劈成两半——线上那次损坏的形态（两半直接拼回去就是原记录） */
const halves = (line: string): [string, string] => {
  const cut = Math.floor(line.length / 2);
  return [line.slice(0, cut), line.slice(cut)];
};

const mkDir = (lines: string[], trailingNewline = true): { dir: string; file: string } => {
  const dir = mkTmp();
  const file = path.join(dir, FILE);
  fs.writeFileSync(file, lines.join("\n") + (trailingNewline ? "\n" : ""));
  return { dir, file };
};

const readLines = (file: string): string[] =>
  fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);

const quarantineFiles = (dir: string): string[] => {
  const q = path.join(dir, ".quarantine");
  return fs.existsSync(q) ? fs.readdirSync(q).sort() : [];
};

/** 用 SDK 原实现读 run_events（它才是「读得了 / 读不了」的标准答案） */
const sdkListRunEvents = async (dir: string, runId: string) => {
  const sdk = await loadSdk();
  return new sdk.JsonlLocalAgentStore(dir).runEvents.list({ runId });
};

const noTmpLeft = (dir: string): boolean =>
  fs.readdirSync(dir).every((n) => !n.endsWith(".heal-tmp")) &&
  quarantineFiles(dir).every((n) => !n.endsWith(".tmp"));

// ───────────────────────── healRunEventsFile（文件级） ─────────────────────────

describe("healRunEventsFile：判据与 SDK 一致，干净文件不动", () => {
  it("文件不存在：clean（SDK 当空）", async () => {
    const dir = mkTmp();
    const r = await healRunEventsFile(dir);
    expect(r).toEqual({ status: "clean", quarantined: 0 });
    expect(fs.existsSync(path.join(dir, ".quarantine"))).toBe(false);
  });

  it("全是好记录：clean，一个字节都不重写（inode / mtime / size / 内容均不变）、不建旁路目录", async () => {
    const { dir, file } = mkDir([rec(1), rec(2), rec(3)]);
    const before = fs.statSync(file);
    const bytes = fs.readFileSync(file);

    const r = await healRunEventsFile(dir);

    expect(r.status).toBe("clean");
    const after = fs.statSync(file);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(Buffer.compare(fs.readFileSync(file), bytes)).toBe(0);
    expect(fs.existsSync(path.join(dir, ".quarantine"))).toBe(false);
    expect(noTmpLeft(dir)).toBe(true);
  });

  it("只有尾行坏（SDK 当它写到一半、容忍）：clean，不动——它可能正被追加", async () => {
    for (const trailingNewline of [true, false]) {
      const [front] = halves(rec(9));
      const { dir, file } = mkDir([rec(1), rec(2), front], trailingNewline);
      const bytes = fs.readFileSync(file);

      const r = await healRunEventsFile(dir);

      expect(r.status).toBe("clean");
      expect(Buffer.compare(fs.readFileSync(file), bytes)).toBe(0);
      // SDK 原实现读得了（它自己就容忍尾行）
      expect((await sdkListRunEvents(dir, "run-1")).items).toHaveLength(1);
    }
  });

  it("空白行不算记录、也不算坏：clean", async () => {
    const { dir } = mkDir([rec(1), "", "   ", rec(2)]);
    expect((await healRunEventsFile(dir)).status).toBe("clean");
  });
});

describe("healRunEventsFile：复现线上损坏", () => {
  it("一条记录被换行拆成两半夹在中间：修复前 SDK 读不了，修复后读得了；坏记录原文进旁路，拼回去就是原记录", async () => {
    const [a, b] = halves(rec(2));
    const { dir, file } = mkDir([rec(1), a, b, rec(3), rec(4)]);

    // 夹具有效性：修复前 SDK 原实现确实整体抛错（这就是线上 GC 永久「本轮跳过」的根因）
    await expect(sdkListRunEvents(dir, "run-1")).rejects.toThrow(/Corrupt local agent store/);

    const r = await healRunEventsFile(dir, { now: NOW });

    expect(r.status).toBe("healed");
    expect(r.quarantined).toBe(2);
    // 主文件：好记录原样保留、顺序不变，没有任何坏行
    expect(readLines(file)).toEqual([rec(1), rec(3), rec(4)]);
    // SDK 原实现现在读得了，且读到的就是留下的好记录
    expect((await sdkListRunEvents(dir, "run-1")).items).toHaveLength(1);
    expect((await sdkListRunEvents(dir, "run-3")).items).toHaveLength(1);
    expect((await sdkListRunEvents(dir, "run-2")).items).toHaveLength(0);
    // 旁路：两半原文都在，拼回去与原记录逐字一致
    expect(quarantineFiles(dir)).toEqual([`run_events-${NOW}.ndjson`]);
    expect(r.quarantineFile).toBe(path.join(dir, ".quarantine", `run_events-${NOW}.ndjson`));
    const q = readLines(r.quarantineFile!);
    expect(q).toEqual([a, b]);
    expect(q[0] + q[1]).toBe(rec(2));
    expect(noTmpLeft(dir)).toBe(true);
  });

  it("多处坏记录（连续 3 条 + 分散 1 条）全部隔离，好记录一条不丢", async () => {
    const { dir, file } = mkDir([rec(1), "坏a", "{坏b", '{"x":', rec(2), "坏d", rec(3)]);
    const r = await healRunEventsFile(dir, { now: NOW });
    expect(r.status).toBe("healed");
    expect(r.quarantined).toBe(4);
    expect(readLines(file)).toEqual([rec(1), rec(2), rec(3)]);
    expect(readLines(r.quarantineFile!)).toEqual(["坏a", "{坏b", '{"x":', "坏d"]);
  });

  it("中间有坏记录、尾行也是坏的：只隔离中间的，尾行原样留在主文件（保持 SDK 的容忍语义）", async () => {
    const [tailFront] = halves(rec(9));
    const { dir, file } = mkDir([rec(1), "坏", rec(2), tailFront]);
    const r = await healRunEventsFile(dir, { now: NOW });
    expect(r.status).toBe("healed");
    expect(r.quarantined).toBe(1);
    expect(readLines(file)).toEqual([rec(1), rec(2), tailFront]);
    expect(readLines(r.quarantineFile!)).toEqual(["坏"]);
    expect((await sdkListRunEvents(dir, "run-1")).items).toHaveLength(1);
  });

  it("CRLF / 空白行 / 末尾没有换行：口径与 SDK 一致（按 \\n 切、空白行丢弃）", async () => {
    const dir = mkTmp();
    const file = path.join(dir, FILE);
    // 第 2 行（带 \r）是坏的，第 3 行是空白，最后一条没有换行
    fs.writeFileSync(file, `${rec(1)}\r\n坏\r\n\r\n${rec(2)}`);
    const r = await healRunEventsFile(dir, { now: NOW });
    expect(r.status).toBe("healed");
    expect(r.quarantined).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(`${rec(1)}\r\n${rec(2)}\n`);
    expect(fs.readFileSync(r.quarantineFile!, "utf8")).toBe("坏\r\n");
    expect((await sdkListRunEvents(dir, "run-1")).items).toHaveLength(1);
    expect((await sdkListRunEvents(dir, "run-2")).items).toHaveLength(1);
  });

  it("超长多字节行（>1MB 的中文，必然跨 64KB 读块、多字节字符被块边界劈开）：好记录逐字节保留", async () => {
    const big = rec(1, "中".repeat(400_000));
    const { dir, file } = mkDir([big, "坏", rec(2)]);
    const r = await healRunEventsFile(dir, { now: NOW });
    expect(r.status).toBe("healed");
    expect(readLines(file)).toEqual([big, rec(2)]);
    expect(Buffer.byteLength(big)).toBeGreaterThan(1_000_000);
  });

  it("主文件权限沿用原文件，旁路目录 / 文件仅属主可读写（里面是对话事件残片）", async () => {
    if (process.platform === "win32") return;
    const { dir, file } = mkDir([rec(1), "坏", rec(2)]);
    fs.chmodSync(file, 0o640);
    const r = await healRunEventsFile(dir, { now: NOW });
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.statSync(path.join(dir, ".quarantine")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(r.quarantineFile!).mode & 0o777).toBe(0o600);
  });
});

describe("healRunEventsFile：保护与兜底", () => {
  it("处理期间文件被追加（SDK 正好写了一条）：放弃本轮、不覆盖别人的写入、不留 tmp / 旁路", async () => {
    const { dir, file } = mkDir([rec(1), "坏", rec(2)]);
    const warn = quiet().warn;
    const appended = rec(7);

    const r = await healRunEventsFile(dir, {
      now: NOW,
      beforeRename: async () => {
        fs.appendFileSync(file, `${appended}\n`);
      },
    });

    expect(r).toEqual({ status: "skipped", quarantined: 0, reason: "changed-during-heal" });
    // 文件就是「原内容 + 别人追加的那一条」——我们一个字都没覆盖
    expect(fs.readFileSync(file, "utf8")).toBe(`${rec(1)}\n坏\n${rec(2)}\n${appended}\n`);
    expect(noTmpLeft(dir)).toBe(true);
    expect(quarantineFiles(dir)).toEqual([]);
    expect(warn).toHaveBeenCalled();

    // 下一轮没人再动它：照常修好
    const again = await healRunEventsFile(dir, { now: NOW + 1 });
    expect(again.status).toBe("healed");
    expect(readLines(file)).toEqual([rec(1), rec(2), appended]);
  });

  it("旁路只留最近 5 份：连续 7 次损坏 → 留下的是最新的 5 份", async () => {
    const dir = mkTmp();
    const file = path.join(dir, FILE);
    for (let i = 0; i < 7; i++) {
      fs.writeFileSync(file, `${rec(1)}\n坏-${i}\n${rec(2)}\n`);
      const r = await healRunEventsFile(dir, { now: NOW + i });
      expect(r.status).toBe("healed");
    }
    expect(quarantineFiles(dir)).toEqual(
      [2, 3, 4, 5, 6].map((i) => `run_events-${NOW + i}.ndjson`),
    );
    expect(fs.readFileSync(path.join(dir, ".quarantine", `run_events-${NOW + 6}.ndjson`), "utf8")).toBe(
      "坏-6\n",
    );
  });

  it("IO 失败（旁路目录被同名文件占住）：不抛、skipped、原文件字节不动、不留 tmp", async () => {
    const { dir, file } = mkDir([rec(1), "坏", rec(2)]);
    fs.writeFileSync(path.join(dir, ".quarantine"), "我是个文件");
    const bytes = fs.readFileSync(file);
    const warn = quiet().warn;

    const r = await healRunEventsFile(dir, { now: NOW });

    expect(r).toEqual({ status: "skipped", quarantined: 0, reason: "error" });
    expect(Buffer.compare(fs.readFileSync(file), bytes)).toBe(0);
    expect(fs.readdirSync(dir).some((n) => n.endsWith(".heal-tmp"))).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("修好之后再跑一遍：幂等（clean，文件不再被动）", async () => {
    const { dir, file } = mkDir([rec(1), "坏", rec(2)]);
    await healRunEventsFile(dir, { now: NOW });
    const st = fs.statSync(file);
    const r = await healRunEventsFile(dir, { now: NOW + 1 });
    expect(r.status).toBe("clean");
    expect(fs.statSync(file).mtimeMs).toBe(st.mtimeMs);
    expect(quarantineFiles(dir)).toHaveLength(1);
  });
});

// ───────────────────────── 端到端（真实 store） ─────────────────────────

const mkAgent = (agentId: string, updatedAt: number): LocalAgentDocument => ({
  agentId,
  cwd: "/w",
  status: "idle",
  createdAt: updatedAt - 1000,
  updatedAt,
});

const mkRun = (agentId: string, updatedAt: number): LocalAgentRunDocument => ({
  runId: `run-${agentId}`,
  agentId,
  turnNumber: 1,
  status: "finished",
  createdAt: updatedAt - 1000,
  updatedAt,
});

/** 往 store 里造一个完整 agent：agents 行 + run + run_event + n 个 blob */
const populate = async (
  s: LocalAgentStore,
  agentId: string,
  updatedAt: number,
  n = 4,
): Promise<void> => {
  await s.agents.create({ agent: mkAgent(agentId, updatedAt) });
  await s.runs.create({ run: mkRun(agentId, updatedAt) });
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
  ref: LocalAgentStore;
  handle: SdkStoreHandle;
}

/** live / recent 要留；dead1 / dead2 / ghost 是孤儿。run_events 每个有 run 的 agent 一行，按创建顺序。 */
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
  await seed(ref.checkpoints, 3, "agent-ghost");
  const tasks = path.join(root, "tasks", "t0");
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, "meta.json"), JSON.stringify({ sessionAgentId: "agent-live" }));
  const handle = await openSdkStore(dir, {});
  if (!handle || handle.mode !== "fast") throw new Error("测试前置：应是 fast 句柄");
  return { root, dir, ref, handle };
};

/** 把含 `containing` 的那条 run_events 记录劈成两半（线上损坏的形态） */
const splitRunEvent = (dir: string, containing: string): [string, string] => {
  const file = path.join(dir, FILE);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(containing));
  if (i < 0) throw new Error(`夹具：没找到要拆的记录 ${containing}`);
  const [a, b] = halves(lines[i]);
  lines.splice(i, 1, a, b);
  fs.writeFileSync(file, lines.join("\n"));
  return [a, b];
};

const agentIdsOnDisk = async (ref: LocalAgentStore): Promise<string[]> =>
  (await ref.agents.list({ filter: { limit: 1000 } })).items.map((a) => a.agentId).sort();

describe("gcSdkStoreOnce：run_events 带着坏记录也能清孤儿（线上故障回归）", () => {
  it("复现线上：中间一条记录被劈成两半。修复前 GC 死在 runEvents.delete「本轮跳过」；现在自愈后照常清孤儿", async () => {
    const { warn } = quiet();
    const { dir, ref, handle } = await buildWorld();
    const [a, b] = splitRunEvent(dir, "run-agent-dead1");

    // 夹具有效性：修复前 SDK 原实现整体读不了（GC 的 runEvents.delete 走的就是这个读取）
    await expect(ref.runEvents.list({ runId: "run-agent-live" })).rejects.toThrow(
      /Corrupt local agent store/,
    );

    const stats = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });

    expect(stats.skipped).toBeUndefined();
    expect(stats.via).toBe("store");
    expect(stats.orphanAgents).toBe(3); // dead1 / dead2 / ghost
    expect(stats.runEventsQuarantined).toBe(2);
    // SDK 原实现重新读盘核对：孤儿清了，活的还在，run_events 又能读了
    expect(await agentIdsOnDisk(ref)).toEqual(["agent-live", "agent-recent"]);
    expect((await ref.runEvents.list({ runId: "run-agent-live" })).items).toHaveLength(1);
    expect((await ref.runEvents.list({ runId: "run-agent-recent" })).items).toHaveLength(1);
    expect((await ref.runEvents.list({ runId: "run-agent-dead1" })).items).toHaveLength(0);
    // 坏记录原文留在旁路，拼回去就是被劈开的那条记录
    const names = quarantineFiles(dir);
    expect(names).toHaveLength(1);
    const q = readLines(path.join(dir, ".quarantine", names[0]));
    expect(q).toEqual([a, b]);
    expect(JSON.parse(q[0] + q[1]).runId).toBe("run-agent-dead1");
    // 有一条醒目的自愈告警，运维能在日志里看到
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("run_events 自愈：隔离 2 条")),
    ).toBe(true);
  });

  it("被劈开的是活 agent 的记录：它的那条 run_event 读不出（本来就读不出）被隔离，其余照常，GC 照样成功", async () => {
    quiet();
    const { dir, ref, handle } = await buildWorld();
    splitRunEvent(dir, "run-agent-live");

    const stats = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });

    expect(stats.skipped).toBeUndefined();
    expect(stats.runEventsQuarantined).toBe(2);
    expect(await agentIdsOnDisk(ref)).toEqual(["agent-live", "agent-recent"]);
    expect((await ref.runEvents.list({ runId: "run-agent-live" })).items).toHaveLength(0);
    expect((await ref.runEvents.list({ runId: "run-agent-recent" })).items).toHaveLength(1);
  });

  it("run_events 没有坏记录：不报 runEventsQuarantined、不建旁路目录（零额外行为）", async () => {
    quiet();
    const { dir, handle } = await buildWorld();
    const stats = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });
    expect(stats.skipped).toBeUndefined();
    expect(stats.runEventsQuarantined).toBeUndefined();
    expect(fs.existsSync(path.join(dir, ".quarantine"))).toBe(false);
  });

  it("自愈失败不挡 GC 的 fail-open：本轮照旧「跳过」、孤儿一个没删、数据字节不动", async () => {
    quiet();
    const { dir, ref, handle } = await buildWorld();
    splitRunEvent(dir, "run-agent-dead1");
    fs.writeFileSync(path.join(dir, ".quarantine"), "占位的文件，让旁路目录建不出来");
    const before = fs.readFileSync(path.join(dir, FILE));

    const stats = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });

    expect(stats.skipped).toBe("error");
    expect(await agentIdsOnDisk(ref)).toEqual([
      "agent-dead1",
      "agent-dead2",
      "agent-live",
      "agent-recent",
    ]);
    expect(Buffer.compare(fs.readFileSync(path.join(dir, FILE)), before)).toBe(0);
  });

  it("自愈之后再跑一轮 GC：没有孤儿、没有坏记录，幂等不动", async () => {
    quiet();
    const { dir, handle } = await buildWorld();
    splitRunEvent(dir, "run-agent-dead1");
    await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });
    const st = fs.statSync(path.join(dir, FILE));

    const second = await gcSdkStoreOnce({ handle, minBytes: 1, now: NOW });

    expect(second.skipped).toBeUndefined();
    expect(second.orphanAgents).toBe(0);
    expect(second.runEventsQuarantined).toBeUndefined();
    expect(fs.statSync(path.join(dir, FILE)).mtimeMs).toBe(st.mtimeMs);
    expect(quarantineFiles(dir)).toHaveLength(1);
  });
});
