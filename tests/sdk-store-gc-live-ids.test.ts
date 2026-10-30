/**
 * R14 B2-1 · collectLiveAgentIds：meta「读不出」≠「这个任务没有活 agent」。
 *
 * 活名单少一项 = 它的 SDK store（checkpoints / runs / agents / run_events）会被 planOrphans 当孤儿清掉，
 * 而那正是用户的会话上下文——与 sdk-store-gc.ts 文件头「宁可少删，不可误删」矛盾。旧实现的内层 catch 把
 * 「单个 meta 读不出」静默吞掉；掉电后 meta 变零长度、手改坏、Windows 文件被占用、BOM 都会走到这里。
 * 现在：目录里没有 meta.json（ENOENT）照旧跳过；meta 读不出先退到 meta.json.bak；备份也读不出 → 整轮返回 null
 * （两处调用方都把 null 当「本轮跳过」），warn 点名 taskId、不带文件内容。
 *
 * 全程临时目录，不碰真实数据。
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { collectLiveAgentIds } from "@/lib/server/sdk-store-gc";

const BOM = "\uFEFF";

let tasksDir: string;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  tasksDir = mkdtempSync(path.join(os.tmpdir(), "flowship-gc-live-"));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  rmSync(tasksDir, { recursive: true, force: true });
});

const writeTaskFile = (id: string, file: string, text: string): void => {
  const dir = path.join(tasksDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), text, "utf-8");
};
const meta = (agentId?: string): string =>
  JSON.stringify({ id: "t", ...(agentId ? { sessionAgentId: agentId } : {}) });
const gcWarnings = (): string[] =>
  warn.mock.calls
    .map((args) => args.map(String).join(" "))
    .filter((l) => l.includes("[sdk-store-gc]"));

/** 「读不出」的几种典型形态 */
const BROKEN_META: Array<[string, string]> = [
  ["零长度（掉电后的典型形态）", ""],
  ["手改坏（缺右括号）", '{"id": "t", "sessionAgentId": "agent-x"'],
  ["根是 null", "null"],
  ["根是数组", "[]"],
  ["根是字符串", '"agent-x"'],
];

describe("collectLiveAgentIds：正常路径", () => {
  it("每个任务的 sessionAgentId 都在名单里；没有 sessionAgentId（新建 / 还没跑过）不算失败", async () => {
    writeTaskFile("t1", "meta.json", meta("agent-1"));
    writeTaskFile("t2", "meta.json", meta("agent-2"));
    writeTaskFile("t3", "meta.json", meta()); // 合法但没有
    writeTaskFile("t4", "meta.json", JSON.stringify({ sessionAgentId: "" }));
    const live = await collectLiveAgentIds(tasksDir);
    expect(live && [...live].sort()).toEqual(["agent-1", "agent-2"]);
    expect(gcWarnings()).toEqual([]);
  });

  it("目录里没有 meta.json（ENOENT：不是任务目录 / 正在被删）：照旧跳过，不影响其它任务", async () => {
    mkdirSync(path.join(tasksDir, "not-a-task"), { recursive: true });
    writeTaskFile("t1", "meta.json", meta("agent-1"));
    const live = await collectLiveAgentIds(tasksDir);
    expect(live && [...live]).toEqual(["agent-1"]);
    expect(gcWarnings()).toEqual([]);
  });

  it("tasks 目录里混着普通文件：忽略", async () => {
    writeFileSync(path.join(tasksDir, "stray.txt"), "x", "utf-8");
    writeTaskFile("t1", "meta.json", meta("agent-1"));
    const live = await collectLiveAgentIds(tasksDir);
    expect(live && [...live]).toEqual(["agent-1"]);
  });

  it("tasks 目录不存在：返回 null（既有行为：读不出活名单 = 跳过）", async () => {
    expect(await collectLiveAgentIds(path.join(tasksDir, "nope"))).toBeNull();
  });
});

describe("collectLiveAgentIds：meta 读不出不能当成「没有活 agent」", () => {
  it.each(BROKEN_META)(
    "meta %s 且没有 .bak：整轮返回 null（跳过本轮 GC），warn 点名 taskId",
    async (_name, text) => {
      writeTaskFile("t-ok", "meta.json", meta("agent-ok"));
      writeTaskFile("t-bad", "meta.json", text);
      expect(await collectLiveAgentIds(tasksDir)).toBeNull();
      const logs = gcWarnings();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("taskId=t-bad");
    },
  );

  it.each(BROKEN_META)(
    "meta %s 但 meta.json.bak 完好：用备份里的 sessionAgentId，名单完整，不 warn",
    async (_name, text) => {
      writeTaskFile("t-ok", "meta.json", meta("agent-ok"));
      writeTaskFile("t-bad", "meta.json", text);
      writeTaskFile("t-bad", "meta.json.bak", meta("agent-from-bak"));
      const live = await collectLiveAgentIds(tasksDir);
      expect(live && [...live].sort()).toEqual(["agent-from-bak", "agent-ok"]);
      expect(gcWarnings()).toEqual([]);
    },
  );

  it("备份带 BOM 也读得出", async () => {
    writeTaskFile("t-bad", "meta.json", "");
    writeTaskFile("t-bad", "meta.json.bak", BOM + meta("agent-bom-bak"));
    const live = await collectLiveAgentIds(tasksDir);
    expect(live && [...live]).toEqual(["agent-bom-bak"]);
  });

  it("meta 和 .bak 都读不出：整轮返回 null", async () => {
    writeTaskFile("t-bad", "meta.json", "");
    writeTaskFile("t-bad", "meta.json.bak", '{"sessionAgentId": ');
    expect(await collectLiveAgentIds(tasksDir)).toBeNull();
    expect(gcWarnings()).toHaveLength(1);
  });

  it("meta.json 被换成目录（EISDIR：读不出、但不是「不存在」）：按读不出处理", async () => {
    mkdirSync(path.join(tasksDir, "t-bad", "meta.json"), { recursive: true });
    expect(await collectLiveAgentIds(tasksDir)).toBeNull();
  });

  it.each([
    ["坏任务排在好任务之前", ["a-bad", "z-good"]],
    ["坏任务排在好任务之后", ["a-good", "z-bad"]],
  ])("%s：结果都是整轮 null，不会给出「缺一个」的部分名单", async (_name, ids) => {
    for (const id of ids) {
      writeTaskFile(id, "meta.json", id.endsWith("bad") ? "" : meta("agent-good"));
    }
    expect(await collectLiveAgentIds(tasksDir)).toBeNull();
  });

  it("warn 只点 taskId 和错误类别，不带 meta 的内容（V8 的 JSON 报错会夹带出错处附近的原文）", async () => {
    writeTaskFile("t-leak", "meta.json", '{"sessionAgentId": LEAKME_abc123}');
    expect(await collectLiveAgentIds(tasksDir)).toBeNull();
    const logs = gcWarnings();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("taskId=t-leak");
    expect(logs[0]).toContain("JSON 格式不对");
    expect(logs[0]).not.toContain("LEAKME");
  });
});

describe("契约：常量与调用方", () => {
  const read = (rel: string): string =>
    readFileSync(path.join(process.cwd(), rel), "utf-8");

  it("sdk-store-gc 的 meta / 备份文件名与 task-fs-core 的 META_FILE / META_BACKUP_FILE 一致（这里不 import task-fs-core，靠本用例钉住）", () => {
    const gc = read("src/lib/server/sdk-store-gc.ts");
    const core = read("src/lib/server/task-fs-core.ts");
    const pick = (src: string, name: string): string | undefined =>
      new RegExp(`const ${name} = "([^"]+)"`).exec(src)?.[1];
    expect(pick(gc, "TASK_META_FILE")).toBeDefined();
    expect(pick(gc, "TASK_META_FILE")).toBe(pick(core, "META_FILE"));
    expect(pick(gc, "TASK_META_BACKUP_FILE")).toBeDefined();
    expect(pick(gc, "TASK_META_BACKUP_FILE")).toBe(
      pick(core, "META_BACKUP_FILE"),
    );
  });

  it("两处调用方拿到 null 都是「本轮跳过」（collectLiveAgentIds 返回 null 的语义靠它们兜底）", () => {
    const gc = read("src/lib/server/sdk-store-gc.ts");
    const hits = gc.match(/if \(!live\) return \{ skipped: "no-live-list" \};/g);
    expect(hits).toHaveLength(2);
  });
});

/**
 * GC19 补测：.bak 只是「主文件读不出」时的后备，不是「主文件里没有 sessionAgentId」时的后备。
 *
 * 对应 sdk-store-gc.ts 的 collectLiveAgentIds 里 `if (id === undefined)` 才去读 TASK_META_BACKUP_FILE 那一段：
 * 主文件是合法 JSON 但没有 sessionAgentId（会话被重置 / 还没跑过）→ sessionAgentIdFromMetaText 返回 ""
 * （不是 undefined），不该再翻 .bak——备份是更早的一份，里面的旧 id 早已不是现行会话。
 * 若误把它算进活名单，那个旧会话的 SDK store 就永远不会被当孤儿回收（GC 对它失效）。
 * 既有的「合法但没有」用例都没带 .bak，把 `id === undefined` 改成 `!id`（或先读 .bak、或取并集）它们抓不到——这条补上。
 */
describe("GC19 补测：meta 主文件合法就以它为准，不翻 .bak", () => {
  it("meta.json 合法但没有 sessionAgentId、meta.json.bak 里留着旧 sessionAgentId：名单不含旧 id（.bak 只在主文件读不出时兜底）", async () => {
    writeTaskFile("t-ok", "meta.json", meta("agent-ok"));
    // 主文件合法、没有 sessionAgentId；备份是更早的一份，里面还留着旧 id
    writeTaskFile("t-reset", "meta.json", meta());
    writeTaskFile("t-reset", "meta.json.bak", meta("agent-stale-from-bak"));

    // 夹具自检：确实构造出了「主文件合法且没有 id、.bak 里有旧 id」——否则下面的断言可能因夹具没造成立而空转
    const primary = JSON.parse(
      readFileSync(path.join(tasksDir, "t-reset", "meta.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(primary).not.toHaveProperty("sessionAgentId");
    expect(
      readFileSync(path.join(tasksDir, "t-reset", "meta.json.bak"), "utf-8"),
    ).toContain("agent-stale-from-bak");

    const live = await collectLiveAgentIds(tasksDir);

    // 精确等于「只有正常任务的 id」：既保证旧 id 不在，也避免因返回 null / 空集而假绿
    expect(live && [...live]).toEqual(["agent-ok"]);
    expect(live?.has("agent-stale-from-bak")).toBe(false);
    // 主文件合法 = 不是「读不出」，不该 warn、也不该因此跳过本轮
    expect(gcWarnings()).toEqual([]);
  });
});
