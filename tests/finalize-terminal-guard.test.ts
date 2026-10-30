/**
 * R14 Q7a-01：finalizeTask 终态守卫 + finalize route 409
 *
 * 背景：任务已合入（merged）/ 已放弃（abandoned）之后，陈旧标签页（MR 其实早已合入、页面还停在「待合入」）再点「放弃」，
 * 旧实现不抛错——把 repoStatus 从 merged 翻成 abandoned、再写一条「任务已放弃」事件、再停预览 / 删 worktree / 取消定时。
 * 修复：finalizeTask 在占住 finalizing lifecycle 之后、任何副作用之前，读**盘上 fresh** 的 repoStatus——
 * 已是终态且与本次请求「相反」→ 抛 TaskTerminalConflictError（route 映射 409）；抛错后 finally 释放 lifecycle。
 * 「同目标」重复 finalize（merged → merged / abandoned → abandoned）**不拦**：它走完整流程（join 在飞 cleanup / 幂等补清理，
 * 由 ownership-r34-cleanup-coord 钉着）。
 *
 * 用例分两类：
 *  - [回归]：钉住这次修复；在「改前」源码（BF 影子）里必须红。
 *  - [对照]：钉住「不该被守卫误伤」的既有行为；改前改后都绿。
 *    对照用例刻意不引用新增导出（TaskTerminalConflictError），否则会在 BF 里因符号不存在而红、失去「对照」的意义。
 *
 * 实现要点：
 *  - 任务一律用 task-fs 的 createTask 真造（repoPaths: []，不起 worktree）；只有「被拒的反向 finalize 没有重复副作用」一条
 *    需要 worktree 清理路径可达，才用带隔离 worktree 标记的任务（仓库是个空目录，removeTaskWorktrees 因没有 worktree 目录直接返回）。
 *  - 新增的 TaskTerminalConflictError 用「动态取属性 + toBeDefined」拿，BF 里表现为断言失败而不是整个文件加载崩溃。
 *  - 不用固定 sleep：需要「先到者停在 lifecycle 窗口内」的用例，用挂起 spy（门闩）精确卡位；所有等待都带 30s 上限。
 *  - 数据目录隔离：先钉 FLOWSHIP_DATA_DIR 再动态 import（DATA_DIR 在 task-fs-core 加载时冻结）；
 *    不跑 boot recovery（它会清孤儿 worktree / 杀预览进程 / GC SDK store，本测试用不到，直接预置「已恢复」标志位）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { RepoStatus } from "@/lib/types";

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-finalize-terminal-guard-"),
);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
}));
// finalize → cancelTaskRun → closeTaskSession 在「有活会话」时会 fire-and-forget 收割孤儿进程。
// 本文件的任务都没有会话，走不到；桩掉只是保险——万一以后用例带了会话，也绝不碰真进程。
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const taskFs = await import("@/lib/server/task-fs");
const previewManager = await import("@/lib/server/preview-manager");
const taskWorktrees = await import("@/lib/server/task-worktrees");
const scheduleStore = await import("@/lib/server/schedule-store");
const { beginChatLifecycle, clearChatGate, endChatLifecycle, getChatLifecycle } =
  await import("@/lib/server/chat-gate");
const { clearResourceJobs } = await import("@/lib/server/task-stream");
const taskRunner = await import("@/lib/server/task-runner");
const finalizeRoute = await import("@/app/api/tasks/[id]/finalize/route");

const { finalizeTask, reopenTask } = taskRunner;

if (!taskFsCore.taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `finalize-terminal-guard DATA_DIR 未隔离到 TMP：${taskFsCore.taskDir("probe")}`,
  );
}

// 不跑 boot recovery：直接把「已恢复」标志位预置好（与 ownership-r32/r34 的 skipBootRecovery 同一个标志位）
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
(globalThis as unknown as Record<string, Promise<void> | undefined>)[
  RECOVERY_FLAG
] = Promise.resolve();

/**
 * 新增导出：BF（改前）里不存在。用动态取属性而不是具名 import——
 * 具名 import 一个不存在的符号会让整个文件在 BF 里加载崩溃，回归用例就不是「断言失败」而是「全文件红」。
 */
type ConflictErrorCtor = new (
  current: Extract<RepoStatus, "merged" | "abandoned">,
  requested: Extract<RepoStatus, "merged" | "abandoned">,
) => Error;
const ConflictError = (taskRunner as Record<string, unknown>)
  .TaskTerminalConflictError as ConflictErrorCtor | undefined;

/** 单用例超时（高负载机器上留足余量）与内部所有等待的上限 */
const TEST_TIMEOUT_MS = 60_000;
const DEADLINE_MS = 30_000;

type FinalStatus = Extract<RepoStatus, "merged" | "abandoned">;

// ───────────────────────── 通用 helper ─────────────────────────

/** 给 promise 加上限：超时抛带 label 的错，免得某个门闩没放开时用例只能干等 vitest 超时 */
const withDeadline = async <T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} 未在 ${ms}ms 内完成`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

type Settled = { ok: true } | { ok: false; error: unknown };

/** 把 promise 收成「成功 / 失败+错误」：期望被拒的调用用它，断言失败时的信息比 rejects 更直白 */
const settle = (p: Promise<unknown>): Promise<Settled> =>
  p.then(
    (): Settled => ({ ok: true }),
    (error: unknown): Settled => ({ ok: false, error }),
  );

const errorOf = (s: Settled): unknown => (s.ok ? undefined : s.error);

/** 用例里「发起了但可能还没等到」的 finalize：afterEach 先等它们走完再清盘，避免往已删目录里写 */
const inFlight: Promise<unknown>[] = [];
const startFinalize = (
  id: string,
  status: FinalStatus,
  reason?: string,
): Promise<Settled> => {
  const p = settle(finalizeTask(id, status, reason));
  inFlight.push(p);
  return p;
};

interface HangGate {
  /** 放进被 spy 替换的实现里：登记「已走到挂点」并挂起，直到 release */
  park: () => Promise<void>;
  /** 等被卡住的调用真的走到挂点（带上限） */
  waitHit: () => Promise<void>;
  release: () => void;
}
const gates: HangGate[] = [];
const createHangGate = (): HangGate => {
  let markHit!: () => void;
  const hit = new Promise<void>((r) => {
    markHit = r;
  });
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  const gate: HangGate = {
    park: async () => {
      markHit();
      await opened;
    },
    waitHit: () => withDeadline(hit, DEADLINE_MS, "等先到者走到挂点"),
    release: () => open(),
  };
  gates.push(gate);
  return gate;
};

const ids: string[] = [];
let seq = 0;

/** 造一个最普通的 task 模式任务（无仓库、不起 worktree、developing / idle） */
const makeTask = async (): Promise<string> => {
  seq += 1;
  const task = await taskFs.createTask({
    title: `finalize-terminal-guard #${seq}`,
    repoPaths: [],
    mode: "task",
    workRole: "other",
  });
  ids.push(task.id);
  return task.id;
};

/**
 * 造一个带隔离 worktree 标记的任务：finalize 才会走到 removeTaskWorktrees。
 * 仓库只是个空目录——任务从没建过 worktree，removeTaskWorktrees 发现 worktree 容器目录不存在就直接返回，不碰 git。
 */
const makeWorktreeTask = async (): Promise<string> => {
  seq += 1;
  const repo = mkdtempSync(path.join(TMP_ROOT, "repo-"));
  const task = await taskFs.createTask({
    title: `finalize-terminal-guard worktree #${seq}`,
    repoPaths: [repo],
    mode: "task",
    workRole: "fe",
    feishuStoryUrl: "https://project.feishu.cn/x/story/detail/1",
    isolateWorktree: true,
  });
  ids.push(task.id);
  const meta = await taskFs.getTaskMeta(task.id);
  expect(
    meta !== null && taskWorktrees.isWorktreeTask(meta),
    "前置：造出来的必须是隔离 worktree 任务，否则 removeTaskWorktrees 路径不可达、用例会空洞通过",
  ).toBe(true);
  return task.id;
};

/** 盘上 repoStatus（直接读 meta.json，不经 hydrate / 可见性闸，也不受 getTaskMeta 的 spy 影响） */
const repoStatusOf = async (id: string): Promise<RepoStatus | undefined> =>
  (await taskFsCore.readMetaV06(id))?.repoStatus;

/**
 * 盘上 meta 去掉 updatedAt 后的整份内容：
 * appendEvent 会 fire-and-forget 地补一次 meta touch（只改 updatedAt），可能恰好落在两次快照之间，所以对比时排除它。
 */
const metaSansUpdatedAt = async (
  id: string,
): Promise<Record<string, unknown>> => {
  const meta = await taskFsCore.readMetaV06(id);
  const copy = { ...(meta as unknown as Record<string, unknown>) };
  delete copy.updatedAt;
  return copy;
};

const eventTexts = async (id: string): Promise<string[]> =>
  (await taskFsCore.readEvents(id)).map((e) => e.text);

const NOTICE_MERGED = "任务已标记为已合入";
const NOTICE_ABANDONED = "任务已放弃";

beforeEach(() => {
  // finalize / route 每次都打几行 console.log，静音只为让输出干净；warn / error 保留
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  // 先放开所有门闩、等在飞的 finalize 走完（用例中途断言失败时它们可能还挂着），再清盘
  for (const g of gates.splice(0)) g.release();
  await Promise.allSettled(
    inFlight
      .splice(0)
      .map((p) => withDeadline(p, DEADLINE_MS, "收尾：等在飞的 finalize 走完")),
  );
  vi.restoreAllMocks();
  for (const id of ids.splice(0)) {
    // appendEvent 的 meta touch 走 withTaskLock：排一个空任务进同一把锁，等它落完再删目录（确定性 flush，不用 sleep）
    await taskFsCore
      .withTaskLock(id, async () => undefined)
      .catch(() => undefined);
    clearResourceJobs(id);
    clearChatGate(id);
    try {
      rmSync(taskFsCore.taskDir(id), {
        recursive: true,
        force: true,
        maxRetries: 2,
      });
    } catch {
      /* 尽力清理：清不掉留给 afterAll 删整个 TMP_ROOT */
    }
  }
}, DEADLINE_MS + 30_000);

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

// ═════════════════════════ 函数级：直接调 finalizeTask ═════════════════════════

/**
 * 保护：已合入 / 已放弃的任务再收到「相反」终态时，finalizeTask 必须在任何副作用之前抛 TaskTerminalConflictError，
 * 且不留半截状态（lifecycle 释放、状态 / 事件 / 定时 / 预览 / worktree 全不动）。
 * 全部是 [回归] 用例——改前（无守卫）这 6 条全红：第二次 finalize 静默翻状态、再写一条终结事件、再跑一遍清理副作用。
 */
describe("finalizeTask 终态守卫（R14 Q7a-01）：已终态再收到「相反」终态", () => {
  /**
   * [回归] 保护：已合入的任务再 finalize(abandoned) 必须被拒，且错误是新增的 TaskTerminalConflictError，
   * 带 current / requested 两个属性，文案告诉用户「已合入、要改先恢复」（route 层据此回 409）。
   * 改前：第二次 finalize 不抛错——整条 promise resolve，ConflictError 这个导出也根本不存在。
   */
  it(
    "[回归] merged 之后再 finalize(abandoned) → 抛 TaskTerminalConflictError（current=merged / requested=abandoned）",
    async () => {
      const id = await makeTask();
      await finalizeTask(id, "merged", "MR 已合入");

      const outcome = await settle(
        finalizeTask(id, "abandoned", "陈旧标签页误点放弃"),
      );
      expect(
        outcome.ok,
        "已合入的任务再收到 abandoned 必须被拒绝（改前：不抛错、静默翻成 abandoned）",
      ).toBe(false);
      const err = errorOf(outcome);

      expect(
        ConflictError,
        "task-runner 应导出 TaskTerminalConflictError（改前没有这个类）",
      ).toBeDefined();
      expect(err).toBeInstanceOf(ConflictError);
      expect(err).toMatchObject({ current: "merged", requested: "abandoned" });
      const message = (err as Error).message;
      expect(message).toContain("任务已合入");
      expect(message).toContain("恢复");
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * [回归] 保护：被拒的反向 finalize **什么都没改**——repoStatus 仍是 merged、事件流一条不多、
   * 不出现「任务已放弃」、meta 整份（除 updatedAt 外）逐字段不变。
   * 本条不依赖错误类型（吞掉第二次的结果），只钉「状态不被翻」这个用户可见的契约。
   * 改前：repoStatus 被翻成 abandoned，事件流多一条「任务已放弃（…）」，meta 变了。
   */
  it(
    "[回归] merged 之后被拒的 abandoned 不翻状态、不多写事件（repoStatus 仍 merged、事件流与 meta 完全不变）",
    async () => {
      const id = await makeTask();
      await finalizeTask(id, "merged", "MR 已合入");

      const metaBefore = await metaSansUpdatedAt(id);
      const eventsBefore = await taskFsCore.readEvents(id);
      // 前置：第一次 finalize 确实写了「已合入」终结事件、且此刻没有任何「已放弃」文案
      expect(eventsBefore.some((e) => e.text.includes(NOTICE_MERGED))).toBe(
        true,
      );
      expect(eventsBefore.some((e) => e.text.includes(NOTICE_ABANDONED))).toBe(
        false,
      );

      await settle(finalizeTask(id, "abandoned", "陈旧标签页误点放弃"));

      expect(
        await repoStatusOf(id),
        "被拒之后 repoStatus 必须仍是 merged（改前被翻成 abandoned）",
      ).toBe("merged");
      const eventsAfter = await taskFsCore.readEvents(id);
      expect(
        eventsAfter.length,
        "被拒的 finalize 不得再往事件流里写东西（改前多一条「任务已放弃」）",
      ).toBe(eventsBefore.length);
      expect(eventsAfter.some((e) => e.text.includes(NOTICE_ABANDONED))).toBe(
        false,
      );
      expect(eventsAfter).toEqual(eventsBefore);
      expect(await metaSansUpdatedAt(id)).toEqual(metaBefore);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * [回归] 保护：方向对称——已放弃的任务再 finalize(merged) 同样被拒（current=abandoned / requested=merged），
   * repoStatus 仍 abandoned，不多写「已合入」事件；文案是「任务已放弃、不能再标记为合入」。
   * 改前：不抛错，abandoned 被翻成 merged，并多写一条「任务已标记为已合入」。
   */
  it(
    "[回归] 反向对称：abandoned 之后再 finalize(merged) → 抛 TaskTerminalConflictError、repoStatus 仍 abandoned",
    async () => {
      const id = await makeTask();
      await finalizeTask(id, "abandoned", "不做了");
      const eventsBefore = await taskFsCore.readEvents(id);
      expect(eventsBefore.some((e) => e.text.includes(NOTICE_ABANDONED))).toBe(
        true,
      );

      const outcome = await settle(finalizeTask(id, "merged", "陈旧标签页误点合入"));
      expect(
        outcome.ok,
        "已放弃的任务再收到 merged 必须被拒绝（改前：不抛错、静默翻成 merged）",
      ).toBe(false);
      const err = errorOf(outcome);

      expect(ConflictError, "task-runner 应导出 TaskTerminalConflictError").toBeDefined();
      expect(err).toBeInstanceOf(ConflictError);
      expect(err).toMatchObject({ current: "abandoned", requested: "merged" });
      expect((err as Error).message).toContain("任务已放弃");

      expect(await repoStatusOf(id)).toBe("abandoned");
      const eventsAfter = await taskFsCore.readEvents(id);
      expect(eventsAfter).toEqual(eventsBefore);
      expect(eventsAfter.some((e) => e.text.includes(NOTICE_MERGED))).toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * [回归] 保护：守卫放在「任何副作用之前」——被拒的反向 finalize 不再停预览、不再删 worktree、
   * 也不会把任务名下的活跃定时取消掉并写「定时一并取消」事件。
   *  - 停预览 / 删 worktree：对 stopPreviewsForTask / removeTaskWorktrees 做直通 spy（调用真实现，只计数）；
   *    先断言第一次（成功的）finalize 确实调过它们，证明 spy 真的挂在 finalize 实际调用的函数上，
   *    否则「调用数不增」会在 spy 失效时空洞通过。
   *  - 定时：在第一次 finalize **之后**才造一条活跃定时（否则改前第二次也取消 0 条、不写事件，没有区分度）；
   *    被拒后它必须仍是 active，事件流里不得出现「定时一并取消」。
   *  - 兜底：事件流与 meta（除 updatedAt）逐字段不变。
   * 改前：第二次 finalize 再停预览（调用数 +2）、再删 worktree（+1）、把新定时取消并写「任务已放弃，1 个定时一并取消」。
   */
  it(
    "[回归] 被拒的反向 finalize 没有重复副作用（不再停预览 / 删 worktree，不取消新定时、不写取消事件）",
    async () => {
      const id = await makeWorktreeTask();
      const stopSpy = vi.spyOn(previewManager, "stopPreviewsForTask");
      const removeSpy = vi.spyOn(taskWorktrees, "removeTaskWorktrees");

      await finalizeTask(id, "merged", "MR 已合入");
      const stopCallsAfterFirst = stopSpy.mock.calls.length;
      const removeCallsAfterFirst = removeSpy.mock.calls.length;
      expect(
        stopCallsAfterFirst,
        "自检：第一次 finalize 应走过停预览（spy 必须真的拦得到 finalize 的调用）",
      ).toBeGreaterThan(0);
      expect(
        removeCallsAfterFirst,
        "自检：第一次 finalize 应走过删 worktree（spy 必须真的拦得到 finalize 的调用）",
      ).toBeGreaterThan(0);

      // 终态之后才冒出来的活跃定时：被拒的反向 finalize 若还跑副作用，会把它取消并写事件
      const created = await scheduleStore.createSchedule(id, {
        kind: "once",
        title: "终态后才出现的定时",
        message: "看一眼",
        firstFireAt: Date.now() + 60 * 60_000,
      });
      expect(created.ok, "前置：定时创建成功").toBe(true);
      const metaBefore = await metaSansUpdatedAt(id);
      const eventsBefore = await taskFsCore.readEvents(id);

      await settle(finalizeTask(id, "abandoned", "陈旧标签页误点放弃"));

      expect(
        stopSpy.mock.calls.length,
        "被拒的反向 finalize 不得再停预览（改前再调 2 次）",
      ).toBe(stopCallsAfterFirst);
      expect(
        removeSpy.mock.calls.length,
        "被拒的反向 finalize 不得再删 worktree（改前再调 1 次）",
      ).toBe(removeCallsAfterFirst);
      expect(
        (await scheduleStore.readSchedules(id)).map((s) => s.status),
        "任务名下的活跃定时不得被被拒的 finalize 取消（改前被取消成 cancelled）",
      ).toEqual(["active"]);
      const eventsAfter = await taskFsCore.readEvents(id);
      expect(
        eventsAfter.some((e) => e.text.includes("定时一并取消")),
        "不得再写「定时一并取消」事件",
      ).toBe(false);
      expect(eventsAfter).toEqual(eventsBefore);
      expect(await metaSansUpdatedAt(id)).toEqual(metaBefore);
      expect(await repoStatusOf(id)).toBe("merged");
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * [回归] 保护：守卫抛错走的是 try/finally——finalizing lifecycle 被释放，任务没被卡死：
   * 抛错后 getChatLifecycle 为 null；随后 reopenTask 能成功（repoStatus 回 developing），再 finalize(abandoned) 也能成功。
   * 守卫若被挪到 try 之外（占了 lifecycle 却不释放），后两步会因「任务清理中 / 正在终结」而失败。
   * 改前：第一步就红——第二次 finalize 根本不抛错。
   */
  it(
    "[回归] 守卫抛错后 lifecycle 已释放；reopen 能成功、再 finalize(abandoned) 也能成功（没把任务卡死）",
    async () => {
      const id = await makeTask();
      await finalizeTask(id, "merged", "MR 已合入");

      const outcome = await settle(finalizeTask(id, "abandoned", "陈旧标签页误点放弃"));
      expect(outcome.ok, "反向 finalize 必须被拒（改前：不抛错）").toBe(false);
      expect(
        getChatLifecycle(id),
        "守卫抛错后 finalizing lifecycle 必须已释放",
      ).toBeNull();

      // 恢复任务：不抛 = 没被 lifecycle / terminal cleanup 卡住
      await reopenTask(id);
      expect(await repoStatusOf(id)).toBe("developing");
      expect(getChatLifecycle(id)).toBeNull();

      // 恢复之后任务是 developing，这时再放弃是合法的
      await finalizeTask(id, "abandoned", "恢复后确认放弃");
      expect(await repoStatusOf(id)).toBe("abandoned");
      expect(getChatLifecycle(id)).toBeNull();
      expect(
        (await eventTexts(id)).some((t) => t.includes(NOTICE_ABANDONED)),
        "恢复后的 finalize(abandoned) 应走完整流程并写终结事件",
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * [回归] 保护：守卫读的是**盘上 fresh** 的 repoStatus，而不是 finalizeTask 入场时读的 meta 快照。
   * 构造：后到者（abandoned）先读到 developing 的入场快照，然后停在「已读快照、还没占 lifecycle」处；
   * 此时先到者（merged）完整跑完并释放 lifecycle；放开后到者——它占 lifecycle 成功，
   * 但入场快照已经过期（developing），只有按盘上 fresh 状态判才能拒掉。
   * （用 spy 卡住 getTaskMeta 是为了在测试里人为拉大「读快照 → 占 lifecycle」之间本来极窄的窗口。）
   * 改前：没有守卫，后到者照翻——repoStatus 被改成 abandoned。
   */
  it(
    "[回归] 入场快照已过期（先到者在此期间合入）时，守卫仍按盘上 fresh 状态拒绝",
    async () => {
      const id = await makeTask();
      const realGetTaskMeta = taskFs.getTaskMeta;
      const gate = createHangGate();
      vi.spyOn(taskFs, "getTaskMeta").mockImplementationOnce(
        async (taskId: string) => {
          const snapshot = await realGetTaskMeta(taskId); // 读到 developing 的入场快照
          await gate.park();
          return snapshot;
        },
      );

      // 后到者先发起：它的第一个 getTaskMeta 调用被上面的 once 实现接走、读完快照后挂住
      const stale = startFinalize(id, "abandoned", "拿着过期快照的一方");
      await gate.waitHit();

      // 先到者完整跑完：repoStatus 落盘为 merged，lifecycle 已释放
      await finalizeTask(id, "merged", "先到者");
      expect(await repoStatusOf(id)).toBe("merged");
      expect(getChatLifecycle(id)).toBeNull();

      gate.release();
      const outcome = await withDeadline(stale, DEADLINE_MS, "等持旧快照的 finalize 结束");
      expect(
        outcome.ok,
        "持过期入场快照的反向 finalize 也必须被拒（守卫要读盘上 fresh 状态；改前：照翻）",
      ).toBe(false);
      expect(ConflictError, "task-runner 应导出 TaskTerminalConflictError").toBeDefined();
      expect(errorOf(outcome)).toBeInstanceOf(ConflictError);
      expect(await repoStatusOf(id)).toBe("merged");
      expect(getChatLifecycle(id)).toBeNull();
      expect(
        (await eventTexts(id)).some((t) => t.includes(NOTICE_ABANDONED)),
      ).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * 保护：守卫只拦「已终态 + 相反目标」这一种情况，不能误伤既有行为——同目标重复 finalize、非终态正常 finalize、
 * 并发 finalize 的 lifecycle 占位拒绝（「请稍后再试」≠「终态冲突」）。
 * 全部是 [对照] 用例：改前改后都绿（所以不引用新增的 TaskTerminalConflictError）。
 */
describe("finalizeTask 终态守卫：不该被误伤的既有行为（对照，改前改后都绿）", () => {
  /**
   * [对照] 保护：守卫只拦「反向」。同目标重复 finalize（merged → merged / abandoned → abandoned）不抛、状态不变，
   * 而且仍然走到清理段（再停一次预览）——它是「join 在飞 cleanup / 幂等补清理」的设计内行为，
   * 不能被守卫变成静默 no-op，也不能被变成报错（ownership-r34-cleanup-coord 的 worktree 路径同样钉着）。
   * 改前改后一致：本来就不拦。
   */
  it.each(["merged", "abandoned"] as const)(
    "[对照] 同目标重复 finalize(%s) 不拦：不抛、repoStatus 不变、仍走到清理段",
    async (status) => {
      const id = await makeTask();
      const stopSpy = vi.spyOn(previewManager, "stopPreviewsForTask");

      await finalizeTask(id, status, "第一次");
      const stopCallsAfterFirst = stopSpy.mock.calls.length;
      expect(stopCallsAfterFirst, "自检：spy 拦得到 finalize 的停预览").toBeGreaterThan(0);

      await finalizeTask(id, status, "第二次（幂等重复）");

      expect(await repoStatusOf(id)).toBe(status);
      expect(getChatLifecycle(id)).toBeNull();
      expect(
        stopSpy.mock.calls.length,
        "同目标的重复 finalize 仍应走完整流程（再停一次预览）",
      ).toBeGreaterThan(stopCallsAfterFirst);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * [对照] 保护：非终态（developing）任务正常 finalize 不受守卫影响——
   * 合入 → merged + 「任务已标记为已合入」事件，放弃 → abandoned + 「任务已放弃」事件，lifecycle 事后已释放。
   * 改前改后一致。
   */
  it.each([
    { status: "merged", notice: NOTICE_MERGED },
    { status: "abandoned", notice: NOTICE_ABANDONED },
  ] as const)(
    "[对照] 非终态任务正常 finalize → $status：状态落盘、写终结事件、lifecycle 已释放",
    async ({ status, notice }) => {
      const id = await makeTask();
      expect(await repoStatusOf(id)).toBe("developing");

      await finalizeTask(id, status, "正常终结");

      expect(await repoStatusOf(id)).toBe(status);
      expect((await eventTexts(id)).some((t) => t.includes(notice))).toBe(true);
      expect(getChatLifecycle(id)).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * [对照] 保护：并发两个反向 finalize 时，后到者是被 **lifecycle 占位** 挡掉的（既有行为，文案「任务正在停止/删除/终结、请稍后再试」），
   * 抛的**不是** TaskTerminalConflictError——「正在进行中、稍后重试」与「已经是终态、状态冲突」是两种不同的错；
   * 后到者没占到 lifecycle，所以也不能替先到者把它释放；最终状态是先到者的（merged）。
   * 两个卡位点：
   *  - late：先到者已提交 merged、停在停预览处。此时盘上已是终态，后到者仍应先撞 lifecycle（守卫在占 lifecycle 之后才判，
   *    顺序不能反）；
   *  - early：先到者还没提交任何状态（盘上仍 developing）、停在取消定时处。此时守卫自己拦不住，全靠 lifecycle 串行。
   * 改前改后一致：lifecycle 门本来就在。
   */
  it.each([
    { hold: "late", note: "先到者已提交 merged、停在停预览处", diskBefore: "merged" },
    { hold: "early", note: "先到者尚未提交状态、停在取消定时处", diskBefore: "developing" },
  ] as const)(
    "[对照] 并发反向 finalize（$note）：后到者撞 lifecycle 占位、不是 TaskTerminalConflictError，最终状态是先到者的",
    async ({ hold, diskBefore }) => {
      const id = await makeTask();
      const gate = createHangGate();
      if (hold === "late") {
        vi.spyOn(previewManager, "stopPreviewsForTask").mockImplementationOnce(
          async () => {
            await gate.park();
          },
        );
      } else {
        vi.spyOn(scheduleStore, "cancelAllSchedulesForTask").mockImplementationOnce(
          async () => {
            await gate.park();
            return 0;
          },
        );
      }

      const first = startFinalize(id, "merged", "先到者");
      await gate.waitHit();
      expect(getChatLifecycle(id), "先到者此刻应持有 finalizing lifecycle").toBe(
        "finalizing",
      );
      expect(await repoStatusOf(id)).toBe(diskBefore);

      // 后到者（反向）：占不到 lifecycle → 抛「请稍后再试」
      const loser = await settle(finalizeTask(id, "abandoned", "后到者"));
      expect(loser.ok, "后到者不得成功").toBe(false);
      const err = errorOf(loser);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("任务正在停止/删除/终结");
      expect((err as Error).message).toContain("请稍后再试");
      expect(
        (err as Error).name,
        "并发占位被拒是「稍后再试」，不是终态冲突",
      ).not.toBe("TaskTerminalConflictError");
      expect(err).not.toHaveProperty("current");
      // 后到者没占到 lifecycle：不得替先到者释放；也没碰盘
      expect(getChatLifecycle(id)).toBe("finalizing");
      expect(await repoStatusOf(id)).toBe(diskBefore);

      gate.release();
      const firstOutcome = await withDeadline(first, DEADLINE_MS, "等先到者结束");
      expect(firstOutcome.ok, "先到者应正常完成").toBe(true);
      expect(getChatLifecycle(id)).toBeNull();
      expect(await repoStatusOf(id)).toBe("merged");
      const texts = await eventTexts(id);
      expect(texts.some((t) => t.includes(NOTICE_MERGED))).toBe(true);
      expect(texts.some((t) => t.includes(NOTICE_ABANDONED))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

// ═════════════════════════ route 级：POST /api/tasks/[id]/finalize ═════════════════════════

/** 构造 finalize POST（body 可传对象，或传 raw 字符串模拟非 JSON） */
const callFinalize = (
  id: string,
  body: unknown,
  raw?: string,
): Promise<Response> =>
  finalizeRoute.POST(
    new Request(`http://localhost/api/tasks/${id}/finalize`, {
      method: "POST",
      body: raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

interface FinalizeRouteBody {
  ok?: boolean;
  error?: string;
  task?: { repoStatus?: string };
}

/**
 * 保护：route 把 TaskTerminalConflictError 映射成 409（陈旧标签页误点的 HTTP 语义），而不是 200 / 400。
 * [回归] 用例：改前第二次 POST 返回 200 + ok:true 并翻掉状态。
 */
describe("POST /api/tasks/[id]/finalize：终态冲突映射 409", () => {
  /**
   * [回归] 保护：陈旧标签页场景的 HTTP 语义——任务已终态再 POST 相反的 finalStatus → **409**（不是 200、也不是 400），
   * 响应 JSON 的 error 带「已合入 / 已放弃」让前端能给出准确提示；任务状态不被翻，且响应里没有 ok:true。
   * 两个方向都测（已合入再放弃 / 已放弃再合入）。
   * 改前：第二次 POST 返回 200 + ok:true，repoStatus 被翻掉。
   */
  it.each([
    { first: "merged", second: "abandoned", hint: "任务已合入" },
    { first: "abandoned", second: "merged", hint: "任务已放弃" },
  ] as const)(
    "[回归] 已 $first 再 POST $second → 409、error 含「$hint」、repoStatus 不变",
    async ({ first, second, hint }) => {
      const id = await makeTask();
      const res1 = await callFinalize(id, { finalStatus: first, reason: "第一次" });
      expect(res1.status, "第一次 finalize 应 200").toBe(200);
      expect(await repoStatusOf(id)).toBe(first);

      const res2 = await callFinalize(id, {
        finalStatus: second,
        reason: "陈旧标签页误点",
      });
      expect(
        res2.status,
        "已终态再 POST 相反的 finalStatus 必须 409（改前：200 并翻状态）",
      ).toBe(409);
      const json = (await res2.json()) as FinalizeRouteBody;
      expect(json.error).toContain(hint);
      expect(json.ok).toBeUndefined();

      expect(await repoStatusOf(id), "409 之后状态不得被翻").toBe(first);
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * 保护：route 的其余错误语义不因新增 409 分支而变——不存在 404、格式错 400、正常 / 同目标重复 200、其它 finalizeTask 错误仍 400。
 * 全部是 [对照] 用例：改前改后都绿。
 */
describe("POST /api/tasks/[id]/finalize：其余错误语义不变（对照，改前改后都绿）", () => {
  /** [对照] 保护：task 不存在 → 404 not_found（先于 finalizeTask，守卫不会误把它说成 409 / 400）。 */
  it(
    "[对照] task 不存在 → 404",
    async () => {
      const res = await callFinalize(`t_not_exist_${Date.now()}`, {
        finalStatus: "merged",
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as FinalizeRouteBody).error).toBe("not_found");
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * [对照] 保护：请求格式错仍是 400，且不碰任务——finalStatus 缺失 / 不是 merged|abandoned、body 不是 JSON。
   * 状态码 409 只留给「终态冲突」，格式错不能被误映射。
   */
  it.each([
    { name: "finalStatus 不是 merged/abandoned", body: { finalStatus: "developing" }, raw: undefined },
    { name: "缺 finalStatus", body: {}, raw: undefined },
    { name: "body 不是 JSON", body: undefined, raw: "这不是 JSON {" },
  ])(
    "[对照] 请求格式错（$name）→ 400，任务不受影响",
    async ({ body, raw }) => {
      const id = await makeTask();
      const res = await callFinalize(id, body, raw);
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as FinalizeRouteBody).error).toBe(
        "string",
      );
      expect(await repoStatusOf(id)).toBe("developing");
      expect(await taskFsCore.readEvents(id)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * [对照] 保护：正常 finalize 仍 200 且 ok:true、响应带最新 task；同目标重复 POST 仍 200（守卫不拦同目标）。
   */
  it(
    "[对照] 正常 finalize → 200 且 ok:true；同目标重复 POST → 仍 200",
    async () => {
      const id = await makeTask();

      const res1 = await callFinalize(id, { finalStatus: "merged" });
      expect(res1.status).toBe(200);
      const json1 = (await res1.json()) as FinalizeRouteBody;
      expect(json1.ok).toBe(true);
      expect(json1.task?.repoStatus).toBe("merged");

      const res2 = await callFinalize(id, { finalStatus: "merged" });
      expect(res2.status, "同目标重复 POST 不拦").toBe(200);
      const json2 = (await res2.json()) as FinalizeRouteBody;
      expect(json2.ok).toBe(true);
      expect(json2.task?.repoStatus).toBe("merged");
      expect(await repoStatusOf(id)).toBe("merged");
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * [对照] 保护：409 只给「终态冲突」——其它 finalizeTask 抛错（这里用 stop 在飞、lifecycle 被占）仍是 400，
   * 文案是「请稍后再试」。防止有人把 route 的 catch 改成一律 409。
   */
  it(
    "[对照] 其它错误仍是 400、不被误映射成 409（stopping 在飞 → 400「请稍后再试」）",
    async () => {
      const id = await makeTask();
      expect(beginChatLifecycle(id, "stopping")).toBe(true);
      try {
        const res = await callFinalize(id, { finalStatus: "merged" });
        expect(res.status).toBe(400);
        expect(((await res.json()) as FinalizeRouteBody).error).toContain(
          "请稍后再试",
        );
      } finally {
        endChatLifecycle(id, "stopping");
      }
      expect(await repoStatusOf(id)).toBe("developing");
    },
    TEST_TIMEOUT_MS,
  );
});
