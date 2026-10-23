/**
 * 回退截断必须排进 events 的追加链（评审 BE5）。
 *
 * 旧行为：`truncateEventsBeforeEventId` 读全量 → slice → tmp + rename，不进追加链；
 * `appendEventLine` 也不拿 `withTaskLock`，回退持的锁挡不住它。读和 rename 之间若有旁路写者
 * （群答疑 run 等）appendFile 到旧文件，那一行被 rename 吃掉：客户端已收到 publish、磁盘没有、seq 出现空洞。
 *
 * 钉死（都是确定性的——用 `event.inQueue` 失效点把写者挂在链内，不靠 sleep 赌时序）：
 *   1. 截断之前已排进链的写者先落完：截断读到的是含它的一致快照（旧实现不排队、读不到它）；
 *   2. 截断之后才排进链的写者落在截断后的文件上，不被吃掉；
 *   3. 一堆写者与截断交错：文件始终是合法 jsonl、id 不重复、seq 严格递增、截断之后排队的写者全在；
 *   4. 链内抛错不毒死后续（截断读不到目标 → null，之后的写者照常落盘）；
 *   5. restoreEventsRawText：只被追加过 → 不写回（写回备份会抹掉追加）；被改写过 → 写回备份；
 *   6. 源码契约：截断与恢复都经 withEventAppendChain、appendEventLine 复用同一个导出。
 */
import { mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-rewind-chain-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { restoreEventsRawText, truncateEventsBeforeEventId } = await import(
  "@/lib/server/chat-checkpoint"
);
const { appendEventLine, newEventId, readEvents, taskDir, withEventAppendChain } =
  await import("@/lib/server/task-fs-core");
const { clearFailpoints, setFailpoint } = await import("@/lib/server/failpoints");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`rewind-truncate-append-chain DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const ids: string[] = [];
afterEach(async () => {
  clearFailpoints();
  for (const id of ids.splice(0)) {
    await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  }
});

const alloc = async (): Promise<string> => {
  const id = `t_rtc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  await fs.mkdir(taskDir(id), { recursive: true });
  return id;
};

const mkEv = (kind: TaskEvent["kind"], text: string): TaskEvent => ({
  id: newEventId(),
  ts: Date.now(),
  kind,
  text,
});

/** 种一段「info → user_reply(目标) → assistant」的历史，返回目标事件 */
const seed = async (id: string): Promise<{ before: TaskEvent; target: TaskEvent }> => {
  const before = mkEv("info", "before");
  const target = mkEv("user_reply", "target");
  await appendEventLine(id, before);
  await appendEventLine(id, target);
  await appendEventLine(id, mkEv("assistant_message", "after-1"));
  await appendEventLine(id, mkEv("assistant_message", "after-2"));
  return { before, target };
};

/** 第一次命中挂起（放行前一直卡在链内、appendFile 之前），之后的命中直接放行 */
const hangFirstInQueue = () => {
  let hit = false;
  let used = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setFailpoint("event.inQueue", async () => {
    if (used) return;
    used = true;
    hit = true;
    await gate;
  });
  return {
    release: () => release(),
    waitHit: async () => {
      for (let i = 0; i < 400 && !hit; i++) await new Promise((r) => setTimeout(r, 5));
      expect(hit).toBe(true);
    },
  };
};

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 20));
};

describe("回退截断排进追加链（BE5）", () => {
  it("截断之前已在链内的写者先落完：截断读到含它的一致快照（旧实现不排队、读不到它）", async () => {
    const id = await alloc();
    const { before, target } = await seed(id);

    const hang = hangFirstInQueue();
    const inflight = mkEv("info", "side-run-inflight");
    const pInflight = appendEventLine(id, inflight); // 命中失效点、挂在链内
    await hang.waitHit();

    let truncated = false;
    const pTrunc = truncateEventsBeforeEventId(id, target.id).then((r) => {
      truncated = true;
      return r;
    });
    await flushMicrotasks();
    // 旧实现：不进链、不等写者，早就读完写完了
    expect(truncated).toBe(false);

    hang.release();
    await pInflight;
    const trunc = await pTrunc;
    expect(trunc).not.toBeNull();
    // 目标之后原有 3 条（target + after-1 + after-2）+ 在飞的那一条 = 4：截断看见了它
    expect(trunc!.truncatedCount).toBe(4);
    expect(trunc!.kept.map((e) => e.id)).toEqual([before.id]);
    expect((await readEvents(id)).map((e) => e.id)).toEqual([before.id]);
  });

  it("截断之后才排进链的写者落在截断后的文件上，不被 rename 吃掉", async () => {
    const id = await alloc();
    const { before, target } = await seed(id);

    const hang = hangFirstInQueue();
    const blocker = mkEv("info", "blocker");
    const pBlocker = appendEventLine(id, blocker);
    await hang.waitHit();

    const pTrunc = truncateEventsBeforeEventId(id, target.id); // 排在 blocker 之后
    const late = mkEv("info", "side-run-late");
    const pLate = appendEventLine(id, late); // 排在截断之后
    await flushMicrotasks();

    hang.release();
    await Promise.all([pBlocker, pTrunc, pLate]);

    const left = await readEvents(id);
    // blocker 在截断之前（目标之后）→ 按设计被截掉；late 在截断之后 → 必须留着
    expect(left.map((e) => e.id)).toEqual([before.id, late.id]);
  });

  it("一堆写者与截断交错：文件合法、id 不重复、seq 严格递增、截断之后排队的写者全在", async () => {
    const id = await alloc();
    const { before, target } = await seed(id);

    const early = Array.from({ length: 15 }, (_, i) => mkEv("info", `early-${i}`));
    const lateEvs = Array.from({ length: 15 }, (_, i) => mkEv("info", `late-${i}`));
    const pEarly = early.map((ev) => appendEventLine(id, ev));
    const pTrunc = truncateEventsBeforeEventId(id, target.id);
    const pLate = lateEvs.map((ev) => appendEventLine(id, ev));
    await Promise.all([...pEarly, pTrunc, ...pLate]);

    const raw = await fs.readFile(path.join(taskDir(id), "events.jsonl"), "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const parsed = lines.map((l) => JSON.parse(l) as TaskEvent); // 任何一行损坏都会抛
    const idList = parsed.map((e) => e.id);
    expect(new Set(idList).size).toBe(idList.length);

    const seqs = parsed.map((e) => e.seq ?? 0);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);

    // 截断之前入链的（early）全在被截范围里；截断之后入链的（late）一条不少、顺序保持
    expect(idList).toEqual([before.id, ...lateEvs.map((e) => e.id)]);
  });

  it("链内读不到目标 → null；之后的写者照常落盘（一次返回 null / 抛错不毒死链）", async () => {
    const id = await alloc();
    await seed(id);
    expect(await truncateEventsBeforeEventId(id, "e_not_exist")).toBeNull();

    await expect(
      withEventAppendChain(id, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const after = mkEv("info", "after-failure");
    expect(await appendEventLine(id, after)).toBe(true);
    expect((await readEvents(id)).at(-1)?.id).toBe(after.id);
  });
});

describe("restoreEventsRawText：只在文件真被改写过时才写回备份", () => {
  const eventsPath = (id: string): string => path.join(taskDir(id), "events.jsonl");

  it("备份之后文件只被追加 → 不写回（写回备份会抹掉旁路 run 这期间追加的行）", async () => {
    const id = await alloc();
    await seed(id);
    const backup = await fs.readFile(eventsPath(id), "utf-8");
    const appended = mkEv("info", "appended-after-backup");
    await appendEventLine(id, appended);
    const current = await fs.readFile(eventsPath(id), "utf-8");

    await restoreEventsRawText(id, backup);
    expect(await fs.readFile(eventsPath(id), "utf-8")).toBe(current);
    expect((await readEvents(id)).at(-1)?.id).toBe(appended.id);
  });

  it("文件被改写过（不再以备份为前缀）→ 写回备份（保持旧补偿行为）", async () => {
    const id = await alloc();
    const { target } = await seed(id);
    const backup = await fs.readFile(eventsPath(id), "utf-8");
    await truncateEventsBeforeEventId(id, target.id); // 把文件改短
    expect((await fs.readFile(eventsPath(id), "utf-8")).length).toBeLessThan(backup.length);

    await restoreEventsRawText(id, backup);
    expect(await fs.readFile(eventsPath(id), "utf-8")).toBe(backup);
  });

  it("没有 events 文件且备份为空 → no-op（不凭空建空文件）", async () => {
    const id = await alloc();
    await restoreEventsRawText(id, "");
    await expect(fs.stat(eventsPath(id))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("源码契约", () => {
  const read = (rel: string): string =>
    readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

  it("chat-checkpoint：整文件重写（截断 / 恢复）都经 withEventAppendChain，且不再有链外的 events 整文件写", () => {
    const src = read("src/lib/server/chat-checkpoint.ts").replace(/\/\/.*$/gm, "");
    expect(src).toMatch(/truncateEventsBeforeEventId[\s\S]{0,400}withEventAppendChain\(taskId,/);
    expect(src).toMatch(/restoreEventsRawText[\s\S]{0,300}withEventAppendChain\(taskId,/);
    // atomicWriteTextFile 的调用点只有截断（链内）+ 恢复（链内）两处（定义是 `= async (`、不带紧邻括号）
    const calls = src.match(/atomicWriteTextFile\(/g) ?? [];
    expect(calls.length).toBe(2);
    // 主流程里不再直接对 events 路径调 atomicWriteTextFile
    expect(src).not.toMatch(/await atomicWriteTextFile\(\s*path\.join\(taskDir\(taskId\), EVENTS_FILE\),\s*eventsRawBackup/);
  });

  it("task-fs-core：appendEventLine 与 withEventAppendChain 共用同一条链实现（不各写一份）", () => {
    const src = read("src/lib/server/task-fs-core.ts");
    expect(src).toContain("export const withEventAppendChain = async <T>(");
    expect(src).toContain("return withEventAppendChain(id, run);");
    // 链 Map 只在 withEventAppendChain 里被取（getEventAppendChains 的定义 + 1 处使用）
    expect((src.match(/getEventAppendChains\(\)/g) ?? []).length).toBe(1);
  });
});
