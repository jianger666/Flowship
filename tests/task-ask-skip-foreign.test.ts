/**
 * task 模式「不答提问、直接发新消息」＝ 跳过提问；这条消息是外来内容（foreignContentTurn：所有者空 @ 引用了别人的话）时
 * 走的 curl 回写那条路（第六轮评审 P2-2）。
 *
 * 缺口：同一轮 ask-wait curl 还挂着时，正文直接写进 AI 正等着的那一轮 stdout，不经过 deliverTaskQuestion——
 * 而 markerOnly 标记（「群成员触发」，desktop_* / 写所有者备注 / 新建定时 / 自动推进恒拒）是在 deliverTaskQuestion 里登记的。
 * 于是别人写的内容在没有标记的状态下进了属主那一轮。chat 型同一个缺口第五轮已补（ask-skip-chat.test.ts），这里是 task 型的对应。
 *
 * 修法：回写前一刻同步补登中途标记（beginForeignContentMidRun）；没写进去（槽没了 / 抛错）按 token 回滚，然后照旧走 deliverTaskQuestion；
 * 写进去了的留给 run 收尾（endMidRunForeignContent）清。已有活标记（别的轮次登记的）则沿用、不降级、不误删。
 *
 * 真的 ask-wait / chat-pending / non-owner-turn-guard；只 spy 读盘和「真正送达 / 落盘」那几处。
 * 每个用例独占 taskId（标记表 / 登记表都按 taskId 分）。
 *
 * 注意探针用 isGroupNonOwnerTurnActive（任何作用域的活标记）：外来内容登记的是 scope=desktop，
 * isNonOwnerTurnActive 只认 scope=all，拿它当探针会恒为 false（假红）。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-task-askskip-foreign-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@/lib/server/feishu-bridge/ask-card-settle", () => ({
  settleAskCards: vi.fn(async () => 1),
  ASK_CARD_SKIPPED_NOTE: "（已跳过）",
  ASK_CARD_SKIPPED_HINT: "这组提问已跳过、无需再回答",
  ASK_CARD_ANSWERED_HINT: "这组提问已回答、无需再答",
}));

const taskFs = await import("@/lib/server/task-fs");
const taskStream = await import("@/lib/server/task-stream");
const taskRunner = await import("@/lib/server/task-runner");
const askSkipModule = await import("@/lib/server/ask-skip");
const { attachAskWaiter, openAskWait, resetAskWaitForTest } = await import("@/lib/server/ask-wait");
const { __resetPendingAskStateForTest, getPendingAsk, registerPendingAsk } = await import("@/lib/server/chat-pending");
const {
  __resetNonOwnerTurnGuardForTest,
  __setNonOwnerRunProbeForTest,
  beginForeignContentMidRun,
  beginNonOwnerTurn,
  endMidRunForeignContent,
  isGroupNonOwnerTurnActive,
  isNonOwnerTurnActive,
} = await import("@/lib/server/non-owner-turn-guard");
const { handleTaskQuestionInject } = await import("@/lib/server/task-question-inject");

const ASK_ID = "ask-1";
const QUESTIONS = [{ id: "q1", question: "要不要顺手加埋点", allowText: true }];

let seq = 0;
const freshTaskId = (): string => `ta_task_${++seq}_${Date.now()}`;

/** running = AI 正挂着 curl 等答案（回写路径）；awaiting_user = 此刻没有 run 在跑（槽没了之后会走 deliverTaskQuestion） */
type RunStatus = "running" | "awaiting_user";

const taskOf = (id: string, token: string, runStatus: RunStatus): Task =>
  ({
    id,
    title: "重构登录",
    mode: "task",
    runStatus,
    repoStatus: "developing",
    repoPaths: [],
    mrs: [],
    actions: [],
    currentActionId: null,
    events: [
      {
        id: "ev-ask",
        kind: "ask_user_request",
        text: "有问题要问",
        ts: Date.now(),
        meta: { askId: ASK_ID, token, questions: QUESTIONS },
      } as unknown as TaskEvent,
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as Task;

const BODY = {
  text: "不用加埋点、直接改吧",
  bootArgs: { apiKey: "sk-test", model: { id: "m1" } },
};

/** 搭「task 在跑、有一组待答提问」：登记 pending、spy 读盘 / 送达 / 落盘。返回 pending 的 token 与送达 spy */
const arrange = (id: string, runStatus: RunStatus = "running", withAsk = true) => {
  const token = withAsk ? registerPendingAsk(id, { askId: ASK_ID, questions: QUESTIONS }).token : "";
  // 没有待答提问：事件流里没有 ask、登记表里也没有——askSkip 认领不到
  const task = withAsk ? taskOf(id, token, runStatus) : ({ ...taskOf(id, token, runStatus), events: [] } as Task);
  vi.spyOn(taskFs, "getTaskMeta").mockImplementation((async () => task) as never);
  vi.spyOn(taskFs, "getTaskWithTailEvents").mockImplementation((async () => task) as never);
  const deliver = vi
    .spyOn(taskRunner, "deliverTaskQuestion")
    .mockResolvedValue("sent" as Awaited<ReturnType<typeof taskRunner.deliverTaskQuestion>>);
  vi.spyOn(taskStream, "writeUserEventAndPublishStrict").mockResolvedValue({ id: "e1" } as never);
  vi.spyOn(taskStream, "writeEventAndPublish").mockResolvedValue({ id: "ev_skip" } as never);
  return { token, deliver };
};

/** 挂着等答案的那一轮 curl：把 write 那一刻「中途标记在不在」记下来 */
const attachProbe = (id: string, token: string): boolean[] => {
  const atWrite: boolean[] = [];
  attachAskWaiter(id, token, {
    write: () => {
      atWrite.push(isGroupNonOwnerTurnActive(id));
    },
    close: () => undefined,
  });
  return atWrite;
};

beforeEach(() => {
  __resetNonOwnerTurnGuardForTest();
  __resetPendingAskStateForTest();
  resetAskWaitForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("task 型：外来内容走「顶掉提问」的 curl 回写（第六轮评审 P2-2：回写不经过 deliverTaskQuestion，外来内容无标记）", () => {
  it("foreignContentTurn + 同一轮 curl 挂着：写进 stdout 的那一刻标记已就位，回写成功后留给 run 收尾清", async () => {
    const id = freshTaskId();
    const { token, deliver } = arrange(id);
    openAskWait({ taskId: id, askId: ASK_ID, token });
    const atWrite = attachProbe(id, token);
    try {
      const resp = await handleTaskQuestionInject(id, BODY, { foreignContentTurn: true });
      expect(resp.status).toBe(200);
      // 走的确实是 curl 回写这条路，不是 deliverTaskQuestion
      expect(deliver).not.toHaveBeenCalled();
      expect(atWrite.length, "应该写过 stdout").toBeGreaterThan(0);
      expect(atWrite.every(Boolean), `每一次写进 stdout 的那一刻，标记都已经就位（登记紧贴送达）；实际逐次：${JSON.stringify(atWrite)}`).toBe(true);
      expect(isGroupNonOwnerTurnActive(id), "送出去了：标记留给 run 收尾清").toBe(true);
      // 登记的是 scope=desktop 的「中途」标记：不是系统工具整体硬拒的那种
      expect(isNonOwnerTurnActive(id)).toBe(false);
    } finally {
      endMidRunForeignContent(id);
    }
    expect(isGroupNonOwnerTurnActive(id), "run 收尾按名清掉").toBe(false);
  });

  it("对照：不带 foreignContentTurn（所有者自己的话）→ 回写时没有任何标记，回写后也没有", async () => {
    const id = freshTaskId();
    const { token, deliver } = arrange(id);
    openAskWait({ taskId: id, askId: ASK_ID, token });
    const atWrite = attachProbe(id, token);
    const resp = await handleTaskQuestionInject(id, BODY);
    expect(resp.status).toBe(200);
    expect(deliver).not.toHaveBeenCalled();
    expect(atWrite.length).toBeGreaterThan(0);
    expect(atWrite.some(Boolean), "属主自己的话不该被登记成外来内容").toBe(false);
    expect(isGroupNonOwnerTurnActive(id)).toBe(false);
  });

  it("没认领到待答提问（没有要顶掉的提问）：不预登记——回写那一段根本不会写 stdout，标记留给下游 deliverTaskQuestion 自己登记", async () => {
    const id = freshTaskId();
    const { deliver } = arrange(id, "awaiting_user", false);
    // 回写函数被调用的那一刻标记在不在（它是 async，登记 → 回滚之间会让出微任务，这段间隙里别的并发调用能看到活标记）
    const seen: boolean[] = [];
    vi.spyOn(askSkipModule, "fulfillAskSkipViaWait").mockImplementation(async () => {
      seen.push(isGroupNonOwnerTurnActive(id));
      return false;
    });
    try {
      const resp = await handleTaskQuestionInject(id, BODY, { foreignContentTurn: true });
      expect(resp.status).toBe(200);
      expect(seen, "回写函数被问过一次，且那一刻没有预登记的标记").toEqual([false]);
      // 正常往下走 deliverTaskQuestion，仍带 markerOnly（它自己登记，行为与改动前一致）
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0]?.[9]).toMatchObject({ markerOnly: true, guard: false });
    } finally {
      endMidRunForeignContent(id);
    }
  });

  it("登记后没写进去、task 此刻不在跑（没有挂着的 curl 槽 → 往下走 deliverTaskQuestion）：预登记的标记按 token 回滚，不留孤儿", async () => {
    // 登记点前移到了回写之前：回写没成功时，这一次登记的标记必须收回——后面的送达（deliverTaskQuestion）自己会按 markerOnly 登记，
    // 这里不收的话，送达失败（409）后这个 task 之后的每一轮都会被当成「外来内容轮」拒掉电脑操作，直到 TTL。
    const id = freshTaskId();
    const { deliver } = arrange(id, "awaiting_user");
    deliver.mockResolvedValue("stale" as Awaited<ReturnType<typeof taskRunner.deliverTaskQuestion>>);
    try {
      const resp = await handleTaskQuestionInject(id, BODY, { foreignContentTurn: true });
      expect(resp.status).toBe(409);
      // 真的往下走了 deliverTaskQuestion，并且带着 markerOnly（下游自己登记，行为与改动前一致）
      expect(deliver).toHaveBeenCalledTimes(1);
      const groupNonOwnerArg = deliver.mock.calls[0]?.[9];
      expect(groupNonOwnerArg, "deliverTaskQuestion 仍收到 markerOnly").toMatchObject({ markerOnly: true, guard: false });
      expect(isGroupNonOwnerTurnActive(id), "没送达 → 回滚").toBe(false);
    } finally {
      endMidRunForeignContent(id);
    }
  });

  it("登记后没写进去、task 仍在跑（槽没了但 run 还在 → 走忙线，消息没送达）：标记同样已回滚，不留孤儿", async () => {
    // 这条路径上 deliverTaskQuestion 根本不会被调用（忙线 409 / 入队），更没有谁会替这个预登记的标记收口——只能靠回写那一段自己回滚
    const id = freshTaskId();
    const { deliver } = arrange(id, "running");
    try {
      const resp = await handleTaskQuestionInject(id, BODY, { foreignContentTurn: true });
      expect(resp.status).toBe(409);
      expect(deliver).not.toHaveBeenCalled();
      expect(isGroupNonOwnerTurnActive(id), "没送达 → 回滚").toBe(false);
    } finally {
      endMidRunForeignContent(id);
    }
  });

  it("登记后回写抛错：错误照旧往外抛，标记按 token 回滚，提问登记放回", async () => {
    const id = freshTaskId();
    const { token } = arrange(id);
    openAskWait({ taskId: id, askId: ASK_ID, token });
    vi.spyOn(askSkipModule, "fulfillAskSkipViaWait").mockRejectedValue(new Error("回写炸了"));
    try {
      await expect(handleTaskQuestionInject(id, BODY, { foreignContentTurn: true })).rejects.toThrow("回写炸了");
      expect(isGroupNonOwnerTurnActive(id), "抛错 → 回滚").toBe(false);
      // 外层兜底：认领的提问放回，用户还能回去答
      expect(getPendingAsk(id)).not.toBeNull();
    } finally {
      endMidRunForeignContent(id);
    }
  });

  it("此刻已有活标记（非属主轮 scope=all）：沿用它、不降级；回写成功后仍是原来的标记", async () => {
    const id = freshTaskId();
    const { token } = arrange(id);
    beginNonOwnerTurn(id);
    openAskWait({ taskId: id, askId: ASK_ID, token });
    attachProbe(id, token);
    const resp = await handleTaskQuestionInject(id, BODY, { foreignContentTurn: true });
    expect(resp.status).toBe(200);
    expect(isNonOwnerTurnActive(id), "原有的 scope=all 标记没被降级成 desktop").toBe(true);
  });

  it("此刻已有活标记 + 没写进去：回滚用的 token 为空，不误删别人登记的标记", async () => {
    const id = freshTaskId();
    // 两种「没写进去」都要：task 不在跑（往下走 deliver）/ task 仍在跑（走忙线）
    for (const runStatus of ["awaiting_user", "running"] as const) {
      const sub = `${id}_${runStatus}`;
      const { deliver } = arrange(sub, runStatus);
      deliver.mockResolvedValue("stale" as Awaited<ReturnType<typeof taskRunner.deliverTaskQuestion>>);
      beginNonOwnerTurn(sub);
      const resp = await handleTaskQuestionInject(sub, BODY, { foreignContentTurn: true });
      expect(resp.status, runStatus).toBe(409);
      expect(isNonOwnerTurnActive(sub), `${runStatus}：别人登记的标记还在`).toBe(true);
    }
  });
});

// 第十一轮评审 P3-3：登记之后要跨过 fulfillAskSkipViaWait 的长 await（槽上没有 curl 时最长 ASK_WAIT_ATTACH_MS = 15 秒），窗口里别路的外来内容可能沿用这个标记。
// 回滚因此走 rollbackForeignContentMidRun（沿用过且此刻还有 run 在跑就让位），不是紧贴 send 的 endNonOwnerTurn（按 token 一清就把沿用者正靠着的标记清了）。
// 这一段回滚之前没有别的登记（deliverTaskQuestion 在它之后才登记），所以标记不会被自己沿用、没人沿用时回滚照清（上面几条用例钉着）。
describe("task 型：登记之后窗口里别路沿用了标记（第十一轮评审 P3-3）", () => {
  const PROBE = "task-ask-skip-foreign-probe";
  afterEach(() => {
    __setNonOwnerRunProbeForTest(PROBE, null);
  });

  /** 回写函数（await 的长窗口）里别路的外来内容沿用了活标记（beginForeignContentMidRun 返回 undefined、置 shared），然后窗口到点没写进去 */
  const sharerJoinsThenFail = (id: string, how: "false" | "throw"): void => {
    vi.spyOn(askSkipModule, "fulfillAskSkipViaWait").mockImplementation(async () => {
      expect(beginForeignContentMidRun(id), "前置：窗口里标记已就位，别路沿用它（没有自己的 token）").toBeUndefined();
      if (how === "throw") throw new Error("回写炸了");
      return false;
    });
  };

  it("沿用者那一轮在跑 + 回写没成功（task 仍在跑 → 走忙线 409）：标记让位，留给沿用者那一轮的收尾按名清", async () => {
    const id = freshTaskId();
    arrange(id, "running");
    __setNonOwnerRunProbeForTest(PROBE, (tid) => tid === id);
    sharerJoinsThenFail(id, "false");
    try {
      const resp = await handleTaskQuestionInject(id, BODY, { foreignContentTurn: true });
      expect(resp.status).toBe(409);
      expect(isGroupNonOwnerTurnActive(id), "登记者的回滚把沿用者正靠着的标记清了").toBe(true);
    } finally {
      endMidRunForeignContent(id);
    }
    expect(isGroupNonOwnerTurnActive(id), "沿用者那一轮收尾按名清后才没").toBe(false);
  });

  it("沿用者那一轮在跑 + 回写抛错：同样让位，错误照旧往外抛", async () => {
    const id = freshTaskId();
    arrange(id, "running");
    __setNonOwnerRunProbeForTest(PROBE, (tid) => tid === id);
    sharerJoinsThenFail(id, "throw");
    try {
      await expect(handleTaskQuestionInject(id, BODY, { foreignContentTurn: true })).rejects.toThrow("回写炸了");
      expect(isGroupNonOwnerTurnActive(id), "抛错回滚把沿用者正靠着的标记清了").toBe(true);
    } finally {
      endMidRunForeignContent(id);
    }
  });

  it("沿用者没送达（没有 run 在跑）：回滚照清，不留没人收尾的孤儿（P3-1 在这一处的同口径）", async () => {
    const id = freshTaskId();
    arrange(id, "running");
    sharerJoinsThenFail(id, "false"); // 没登记探针：没有 run 在跑
    try {
      const resp = await handleTaskQuestionInject(id, BODY, { foreignContentTurn: true });
      expect(resp.status).toBe(409);
      expect(isGroupNonOwnerTurnActive(id), "沿用者没送达、没有 run 在跑，标记成了孤儿").toBe(false);
    } finally {
      endMidRunForeignContent(id);
    }
  });
});
