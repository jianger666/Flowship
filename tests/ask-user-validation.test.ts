/**
 * R14 Q11b-02：`ask_user` 入参校验。
 *
 * 改前零校验：弱模型 / 自定义 provider 传 `questions: []` 或 `[{id:"",question:""}]`（SDK 路径不强制
 * inputSchema，pi 路径 TypeBox 只校验类型、不校验非空）也会登记 pending ask、推一张没有可答项的空卡，
 * 工具回 `[ASK_SUBMITTED] … 立刻前台执行 curl，timeout 86400000`——模型挂住等一份没人能提交的答案，
 * 只能靠用户点「跳过」/ 停止。`options: []`、重复 id、label 空、`allow_text:false` 且没选项同理。
 *
 * 校验在 `dispatchAskUser` 开头（工具 handler 与测试共用）：不合法 → 不登记、不推卡、不通知，
 * 回给模型一段点名「第几项哪个字段」的话（没有 ASK_SUBMITTED，所以模型不会去挂 curl）。
 * 真 dispatch + 临时数据目录（与 ownership-r29-pipeline 同款搭法）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ask-user-validation-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { clearEventSeqCounter, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { agentSessions, allocTaskRunInstanceId } = await import("@/lib/server/task-stream");
const {
  CALLER_MISMATCH_ERROR,
  cleanupChatTaskState,
  getPendingAsk,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
} = await import("@/lib/server/chat-pending");
const {
  ASK_USER_MAX_QUESTIONS,
  dispatchAskUser,
  flowShipTools,
  validateAskUserQuestions,
} = await import("@/lib/server/flowship-tools");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`ask-user-validation DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

type Q = Parameters<typeof validateAskUserQuestions>[0][number];
const q = (over: Partial<Q> = {}): Q => ({ id: "q1", question: "要不要？", allowText: true, ...over });

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `ask-user-validation ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

describe("validateAskUserQuestions（纯函数）", () => {
  it("合法：单题无选项（文字回答）", () => {
    expect(validateAskUserQuestions([q()])).toBeNull();
  });

  it("合法：有选项；有选项时可以不允许文字回答", () => {
    expect(
      validateAskUserQuestions([
        q({ options: [{ id: "a", label: "是" }, { id: "b", label: "否" }], allowText: false }),
        q({ id: "q2", question: "补充？", options: [{ id: "a", label: "A" }] }),
      ]),
    ).toBeNull();
  });

  it("上限常量是 20（其余用例按这个常量算，这里钉住字面值）", () => {
    expect(ASK_USER_MAX_QUESTIONS).toBe(20);
  });

  it("合法：上限边界（恰好 ASK_USER_MAX_QUESTIONS 项）", () => {
    const many = Array.from({ length: ASK_USER_MAX_QUESTIONS }, (_, i) => q({ id: `q${i}` }));
    expect(validateAskUserQuestions(many)).toBeNull();
  });

  it("空数组 / 非数组 → 至少 1 项", () => {
    expect(validateAskUserQuestions([])).toContain("至少要有 1 项");
    expect(validateAskUserQuestions(undefined as never)).toContain("至少要有 1 项");
    expect(validateAskUserQuestions(null as never)).toContain("至少要有 1 项");
  });

  it("超过上限 → 点名上限与当前项数", () => {
    const many = Array.from({ length: ASK_USER_MAX_QUESTIONS + 1 }, (_, i) => q({ id: `q${i}` }));
    const r = validateAskUserQuestions(many);
    expect(r).toContain(`最多 ${ASK_USER_MAX_QUESTIONS} 项`);
    expect(r).toContain(`当前 ${ASK_USER_MAX_QUESTIONS + 1} 项`);
  });

  it("id 为空 / 全空白 → 点名是第几项的 id", () => {
    expect(validateAskUserQuestions([q(), q({ id: "" })])).toBe("questions[1].id 不能为空");
    expect(validateAskUserQuestions([q({ id: "   " })])).toBe("questions[0].id 不能为空");
  });

  it("question 为空 / 全空白 → 点名第几项（带 id）的 question", () => {
    expect(validateAskUserQuestions([q({ question: "" })])).toBe("questions[0]（id=q1）.question 不能为空");
    expect(validateAskUserQuestions([q(), q({ id: "q2", question: " \n " })])).toBe(
      "questions[1]（id=q2）.question 不能为空",
    );
  });

  it("id 重复 → 点名后出现的那一项与重复的 id", () => {
    expect(validateAskUserQuestions([q(), q({ id: "q2" }), q({ id: "q1" })])).toBe(
      "questions[2].id「q1」与前面的项重复，id 必须唯一",
    );
    // 首尾空白不能绕过去重
    expect(validateAskUserQuestions([q({ id: "q1" }), q({ id: " q1 " })])).toContain("重复");
  });

  it("options 给了空数组 → 提示要么给选项、要么别传", () => {
    const r = validateAskUserQuestions([q({ options: [] })]);
    expect(r).toContain("questions[0]（id=q1）.options 给了空数组");
    expect(r).toContain("不要传 options");
  });

  it("选项 id 为空 / label 为空 / 同题内选项 id 重复 → 各自点名 options[j]", () => {
    expect(validateAskUserQuestions([q({ options: [{ id: "a", label: "A" }, { id: "", label: "B" }] })])).toBe(
      "questions[0]（id=q1）.options[1].id 不能为空",
    );
    expect(validateAskUserQuestions([q({ options: [{ id: "a", label: "  " }] })])).toBe(
      "questions[0]（id=q1）.options[0].label 不能为空",
    );
    expect(
      validateAskUserQuestions([q({ options: [{ id: "a", label: "A" }, { id: "a", label: "B" }] })]),
    ).toBe("questions[0]（id=q1）.options[1].id「a」重复，同一题里选项 id 必须唯一");
  });

  it("不同题之间选项 id 可以相同（只要求同题内唯一）", () => {
    expect(
      validateAskUserQuestions([
        q({ options: [{ id: "yes", label: "是" }] }),
        q({ id: "q2", options: [{ id: "yes", label: "是" }] }),
      ]),
    ).toBeNull();
  });

  it("没有选项又不允许文字回答（allow_text=false）→ 用户无法作答", () => {
    expect(validateAskUserQuestions([q({ allowText: false })])).toBe(
      "questions[0]（id=q1）既没有 options 又不允许文字回答（allow_text=false），用户无法作答",
    );
  });

  it("同时有多个问题时报最靠前的一个（按 questions 顺序、每项内按 id → 去重 → question → options）", () => {
    expect(validateAskUserQuestions([q({ question: "" }), q({ id: "" })])).toContain("questions[0]");
    expect(validateAskUserQuestions([q({ id: "" , question: "" })])).toContain(".id 不能为空");
  });
});

describe("ask_user 工具 / dispatchAskUser（真 dispatch）", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_askval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };
  afterEach(() => {
    for (const id of ids) {
      agentSessions.delete(id);
      cleanupChatTaskState(id);
      clearEventSeqCounter(id);
    }
    ids.length = 0;
    vi.restoreAllMocks();
  });

  /** 登记 handler（保 token）+ 一个会计数的 notifier（"accepted"）：校验之外的东西全部放行，方便证明「被校验拦下」 */
  const setup = async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const token = String(allocTaskRunInstanceId());
    setChatTaskActionHandler(id, async () => ({ ok: true as const }), token);
    const notifier = vi.fn(async () => "accepted" as const);
    setChatAwaitingNotifier(id, notifier, token);
    return { id, token, notifier };
  };
  const askTool = () => flowShipTools.find((t) => t.name === "ask_user")!;
  const textOf = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");

  it("questions 缺失 / 空数组 → 不登记、不通知、文案点名并明确「不要去执行 curl」（改前：登记 + ASK_SUBMITTED）", async () => {
    const { id, token, notifier } = await setup();
    for (const args of [{ task_id: id }, { task_id: id, questions: [] }, { task_id: id, questions: "oops" }]) {
      const r = textOf(await askTool().handler(args, token));
      expect(r).toContain("提问未发出");
      expect(r).toContain("至少要有 1 项");
      expect(r).toContain("不要去执行 curl");
      expect(r).not.toContain("[ASK_SUBMITTED]");
    }
    expect(getPendingAsk(id)).toBeNull();
    expect(notifier).not.toHaveBeenCalled();
  });

  it("[{id:'',question:''}] → 点名 questions[0].id，不登记", async () => {
    const { id, token, notifier } = await setup();
    const r = textOf(await askTool().handler({ task_id: id, questions: [{ id: "", question: "" }] }, token));
    expect(r).toContain("提问未发出：questions[0].id 不能为空");
    expect(getPendingAsk(id)).toBeNull();
    expect(notifier).not.toHaveBeenCalled();
  });

  it("5 种非法入参各自点名具体项、都不登记 / 不通知", async () => {
    const { id, token, notifier } = await setup();
    const cases: Array<[unknown[], string]> = [
      [[{ id: "q1", question: "   " }], "questions[0]（id=q1）.question 不能为空"],
      [[{ id: "q1", question: "a" }, { id: "q1", question: "b" }], "questions[1].id「q1」与前面的项重复"],
      [[{ id: "q1", question: "a", options: [] }], "questions[0]（id=q1）.options 给了空数组"],
      [[{ id: "q1", question: "a", options: [{ id: "x", label: "" }] }], "questions[0]（id=q1）.options[0].label 不能为空"],
      [[{ id: "q1", question: "a", allow_text: false }], "既没有 options 又不允许文字回答"],
    ];
    for (const [questions, expected] of cases) {
      const r = textOf(await askTool().handler({ task_id: id, questions }, token));
      expect(r, JSON.stringify(questions)).toContain(expected);
      expect(r).not.toContain("[ASK_SUBMITTED]");
    }
    expect(getPendingAsk(id)).toBeNull();
    expect(notifier).not.toHaveBeenCalled();
  });

  it("项不是对象（null / 字符串）、选项不是对象 → 不 TypeError，按空项点名", async () => {
    const { id, token } = await setup();
    const r1 = textOf(await askTool().handler({ task_id: id, questions: [null] }, token));
    expect(r1).toContain("questions[0].id 不能为空");
    const r2 = textOf(await askTool().handler({ task_id: id, questions: ["问点什么"] }, token));
    expect(r2).toContain("questions[0].id 不能为空");
    const r3 = textOf(
      await askTool().handler({ task_id: id, questions: [{ id: "q1", question: "a", options: [null] }] }, token),
    );
    expect(r3).toContain("questions[0]（id=q1）.options[0].id 不能为空");
    expect(getPendingAsk(id)).toBeNull();
  });

  it("dispatchAskUser 直接调：返回 { ok:false, error }，同样不登记", async () => {
    const { id, token, notifier } = await setup();
    const r = await dispatchAskUser({ taskId: id, callerToken: token, questions: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("至少要有 1 项");
    expect(getPendingAsk(id)).toBeNull();
    expect(notifier).not.toHaveBeenCalled();
  });

  it("身份校验仍排在前面：错 token + 非法入参 → 回的是接管错误，不透露校验细节", async () => {
    const { id } = await setup();
    const r = await dispatchAskUser({ taskId: id, callerToken: "not-the-owner", questions: [] });
    expect(r).toEqual({ ok: false, error: CALLER_MISMATCH_ERROR });
  });

  it("对照：合法入参照常登记 + 通知一次 + 回 ASK_SUBMITTED", async () => {
    const { id, token, notifier } = await setup();
    const r = textOf(
      await askTool().handler(
        {
          task_id: id,
          questions: [
            { id: "q1", question: "选哪个？", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], allow_text: false },
            { id: "q2", question: "补充说明？" },
          ],
        },
        token,
      ),
    );
    expect(r).toContain("[ASK_SUBMITTED]");
    expect(r).not.toContain("提问未发出");
    expect(notifier).toHaveBeenCalledTimes(1);
    const pending = getPendingAsk(id);
    expect(pending?.questions.map((x) => x.id)).toEqual(["q1", "q2"]);
    expect(pending?.questions[0]?.allowText).toBe(false);
    expect(pending?.questions[1]?.allowText).toBe(true);
  });
});
