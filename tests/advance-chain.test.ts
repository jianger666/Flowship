/**
 * 自动推进（advance-chain.ts）纯函数 / 进程内状态用例。
 *
 * 守的是代码层硬闸的判据本身（授权由 AI 自己判断、不再核对原话，见 advance-chain.ts 头注释）：
 *  - 入参：user_words 只是 AI 自述的依据，可选、超长拒绝
 *  - 「用户本人说的话」口径：登记后用户又插话 → 作废
 *  - 轮数上限：连续自动推进的计数与清零
 *  - 触发前核对：停止过 / action 变了 / 没交卷 / 过期 / 超上限 都不推进
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  ADVANCE_CHAIN_INSTRUCTION_MAX,
  ADVANCE_CHAIN_MAX_AUTO_STEPS,
  ADVANCE_CHAIN_TTL_MS,
  ADVANCE_CHAIN_WORDS_MAX,
  AUTO_ADVANCE_INSTRUCTION_PREFIX,
  __resetAdvanceChainStateForTest,
  buildAutoAdvanceInstruction,
  bumpAutoAdvanceSteps,
  describeAdvanceBasis,
  evaluateChainFire,
  getAutoAdvanceSteps,
  isAutoAdvanceCapReached,
  isUserOwnWordsEvent,
  parseAdvanceNextArgs,
  peekAdvanceChain,
  registerAdvanceChain,
  resetAutoAdvanceSteps,
  takeAdvanceChain,
  type AdvanceChain,
} from "@/lib/server/advance-chain";

beforeEach(() => __resetAdvanceChainStateForTest());

const baseArgs = {
  action: "review",
  user_words: "做完直接复核一遍",
};

describe("parseAdvanceNextArgs", () => {
  it("最小合法入参：review + user_words", () => {
    const r = parseAdvanceNextArgs(baseArgs);
    expect(r).toEqual({
      ok: true,
      target: { actionType: "review" },
      instruction: "",
      userWords: "做完直接复核一遍",
    });
  });

  it("action 非法 / 缺失 → 拒绝", () => {
    for (const action of [undefined, "", "deploy", 3, null]) {
      const r = parseAdvanceNextArgs({ ...baseArgs, action });
      expect(r.ok).toBe(false);
    }
  });

  it("user_words 可选：缺 / 空白 / 非字符串都放行，userWords 记为空串（依据由 AI 自述、不核对）", () => {
    for (const user_words of [undefined, "", "   ", 5]) {
      expect(parseAdvanceNextArgs({ ...baseArgs, user_words })).toEqual({
        ok: true,
        target: { actionType: "review" },
        instruction: "",
        userWords: "",
      });
    }
  });

  it("user_words 不要求是用户说过的话：随便一句（含转述）都照单全收", () => {
    const r = parseAdvanceNextArgs({ ...baseArgs, user_words: "用户希望完成后自动提测" });
    expect(r.ok && r.userWords).toBe("用户希望完成后自动提测");
  });

  it("user_words 超长 / instruction 超长 → 拒绝；刚好等于上限放行", () => {
    expect(
      parseAdvanceNextArgs({ ...baseArgs, user_words: "字".repeat(ADVANCE_CHAIN_WORDS_MAX + 1) }).ok,
    ).toBe(false);
    expect(
      parseAdvanceNextArgs({ ...baseArgs, user_words: "字".repeat(ADVANCE_CHAIN_WORDS_MAX) }).ok,
    ).toBe(true);
    expect(
      parseAdvanceNextArgs({ ...baseArgs, instruction: "x".repeat(ADVANCE_CHAIN_INSTRUCTION_MAX + 1) }).ok,
    ).toBe(false);
    expect(
      parseAdvanceNextArgs({ ...baseArgs, instruction: "x".repeat(ADVANCE_CHAIN_INSTRUCTION_MAX) }).ok,
    ).toBe(true);
  });

  it("custom 必须带 custom_action_id", () => {
    expect(parseAdvanceNextArgs({ ...baseArgs, action: "custom" }).ok).toBe(false);
    const r = parseAdvanceNextArgs({
      ...baseArgs,
      action: "custom",
      custom_action_id: "  ca_1 ",
    });
    expect(r.ok && r.target).toEqual({ actionType: "custom", customActionId: "ca_1" });
  });

  it("dev 必须显式 dev_push_mode：不替用户默认选直推", () => {
    const missing = parseAdvanceNextArgs({ ...baseArgs, action: "dev" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("dev_push_mode");
    expect(
      parseAdvanceNextArgs({ ...baseArgs, action: "dev", dev_push_mode: "force" }).ok,
    ).toBe(false);
    for (const mode of ["direct", "mr"] as const) {
      const r = parseAdvanceNextArgs({ ...baseArgs, action: "dev", dev_push_mode: mode });
      expect(r.ok && r.target.devPushMode).toBe(mode);
    }
  });

  it("batch_ids 只对 build 生效；空 / 全空白元素被丢掉", () => {
    const build = parseAdvanceNextArgs({
      ...baseArgs,
      action: "build",
      batch_ids: [" b1 ", "", "  ", "b2"],
    });
    expect(build.ok && build.target.batchIds).toEqual(["b1", "b2"]);
    const empty = parseAdvanceNextArgs({ ...baseArgs, action: "build", batch_ids: ["", " "] });
    expect(empty.ok && empty.target.batchIds).toBeUndefined();
    const review = parseAdvanceNextArgs({ ...baseArgs, action: "review", batch_ids: ["b1"] });
    expect(review.ok && review.target.batchIds).toBeUndefined();
  });

  it("非 dev / 非 custom 不带 devPushMode / customActionId，哪怕误传", () => {
    const r = parseAdvanceNextArgs({
      ...baseArgs,
      action: "ship",
      dev_push_mode: "direct",
      custom_action_id: "x",
    });
    expect(r.ok && r.target).toEqual({ actionType: "ship" });
  });
});

describe("isUserOwnWordsEvent（登记后「用户又插话 → 作废」的判定口径）", () => {
  const ev = (kind: string, meta?: Record<string, unknown>, text?: string) =>
    ({ kind, meta, text }) as never;

  it("输入条 / 飞书私聊里用户本人说的话算；非 user_reply 不算", () => {
    expect(isUserOwnWordsEvent(ev("user_reply"))).toBe(true);
    expect(isUserOwnWordsEvent(ev("user_reply", { source: "feishu" }))).toBe(true);
    expect(isUserOwnWordsEvent(ev("user_reply", { checkpointed: true, queueItemId: "q1" }))).toBe(true);
    expect(isUserOwnWordsEvent(ev("info"))).toBe(false);
    expect(isUserOwnWordsEvent(ev("assistant_message"))).toBe(false);
    expect(isUserOwnWordsEvent(ev("ask_user_reply"))).toBe(false);
  });

  it("不算：群里来的话（含带群标记的脏数据）、定时备忘（老事件靠样板正文兜底）", () => {
    expect(isUserOwnWordsEvent(ev("user_reply", { source: "feishu_group" }))).toBe(false);
    expect(isUserOwnWordsEvent(ev("user_reply", { groupNonOwnerTurn: true }))).toBe(false);
    expect(isUserOwnWordsEvent(ev("user_reply", { correlatedAnswer: "om_1" }))).toBe(false);
    expect(isUserOwnWordsEvent(ev("user_reply", { groupSenderOpenId: "ou_1" }))).toBe(false);
    expect(isUserOwnWordsEvent(ev("user_reply", { source: "schedule" }))).toBe(false);
    expect(isUserOwnWordsEvent(ev("user_reply", undefined, "[SCHEDULE_FIRED id=s1] 备忘"))).toBe(false);
    expect(isUserOwnWordsEvent(ev("user_reply", {}, "  [SCHEDULE_FIRED id=s2] 备忘"))).toBe(false);
  });

  it("来源是白名单：没见过的 source（浏览器交还 / 以后新增的）默认不算「用户说话」", () => {
    expect(isUserOwnWordsEvent(ev("user_reply", { source: "browser" }))).toBe(false);
    expect(isUserOwnWordsEvent(ev("user_reply", { source: "background" }))).toBe(false);
    expect(isUserOwnWordsEvent(ev("user_reply", { source: "some_future_source" }))).toBe(false);
  });
});

describe("describeAdvanceBasis / buildAutoAdvanceInstruction", () => {
  it("写了依据就带上，没写就如实说是 AI 判断的", () => {
    expect(describeAdvanceBasis("做完复核")).toBe("AI 称依据：「做完复核」");
    expect(describeAdvanceBasis("")).toBe("AI 判断你需要这一步");
  });

  it("带前缀 + 指令正文 + 依据；无正文时只有前缀 + 依据", () => {
    expect(buildAutoAdvanceInstruction({ instruction: " 重点看登录页 ", userWords: "做完复核" })).toBe(
      `${AUTO_ADVANCE_INSTRUCTION_PREFIX}重点看登录页\n\n（AI 称依据：「做完复核」）`,
    );
    expect(buildAutoAdvanceInstruction({ instruction: "", userWords: "做完复核" })).toBe(
      `${AUTO_ADVANCE_INSTRUCTION_PREFIX}（AI 称依据：「做完复核」）`,
    );
  });

  it("没写依据：指令里标「AI 判断你需要这一步」，不出现空引号", () => {
    const text = buildAutoAdvanceInstruction({ instruction: "重点看登录页", userWords: "" });
    expect(text).toBe(`${AUTO_ADVANCE_INSTRUCTION_PREFIX}重点看登录页\n\n（AI 判断你需要这一步）`);
    expect(text).not.toContain("「」");
  });
});

describe("evaluateChainFire", () => {
  const NOW = 1_000_000_000;
  const chain: AdvanceChain = {
    taskId: "t1",
    fromActionId: "a1",
    opGen: 7,
    actionType: "review",
    instruction: "",
    userWords: "做完直接复核",
    registeredAt: NOW - 1000,
  };
  const okTask = {
    mode: "task",
    currentActionId: "a1",
    actions: [{ id: "a1", status: "awaiting_ack" as const }],
  };
  const run = (over: Partial<Parameters<typeof evaluateChainFire>[0]> = {}) =>
    evaluateChainFire({
      chain,
      task: okTask,
      opGenNow: 7,
      autoStepsSoFar: 0,
      now: NOW,
      ...over,
    });

  it("一切正常 → ok", () => {
    expect(run()).toEqual({ ok: true });
  });

  it("from action 已 completed 也算交过卷", () => {
    expect(
      run({ task: { ...okTask, actions: [{ id: "a1", status: "completed" }] } }),
    ).toEqual({ ok: true });
  });

  it("任务没了 → stale", () => {
    expect(run({ task: null })).toMatchObject({ ok: false, kind: "stale" });
  });

  it("opGen 变了（停止 / 删除 / 终结过）→ stale", () => {
    expect(run({ opGenNow: 8 })).toMatchObject({ ok: false, kind: "stale" });
  });

  it("当前 action 不是登记时那条（已被推进过）→ stale", () => {
    expect(run({ task: { ...okTask, currentActionId: "a2" } })).toMatchObject({
      ok: false,
      kind: "stale",
    });
    expect(run({ task: { ...okTask, currentActionId: null } })).toMatchObject({
      ok: false,
      kind: "stale",
    });
  });

  it("没交卷（仍 running / error / cancelled / 找不到）→ not_submitted", () => {
    for (const status of ["running", "error", "cancelled"] as const) {
      expect(
        run({ task: { ...okTask, actions: [{ id: "a1", status }] } }),
      ).toMatchObject({ ok: false, kind: "not_submitted" });
    }
    expect(run({ task: { ...okTask, actions: [] } })).toMatchObject({
      ok: false,
      kind: "not_submitted",
    });
  });

  it("过期：恰好 TTL 放行，超过 TTL 作废", () => {
    expect(run({ now: chain.registeredAt + ADVANCE_CHAIN_TTL_MS })).toEqual({ ok: true });
    expect(run({ now: chain.registeredAt + ADVANCE_CHAIN_TTL_MS + 1 })).toMatchObject({
      ok: false,
      kind: "expired",
    });
  });

  it("对话型任务 → invalid", () => {
    expect(run({ task: { ...okTask, mode: "chat" } })).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("连续自动推进达上限 → capped；差一步还放行", () => {
    expect(run({ autoStepsSoFar: ADVANCE_CHAIN_MAX_AUTO_STEPS - 1 })).toEqual({ ok: true });
    const v = run({ autoStepsSoFar: ADVANCE_CHAIN_MAX_AUTO_STEPS });
    expect(v).toMatchObject({ ok: false, kind: "capped" });
    if (!v.ok) expect(v.reason).toContain(String(ADVANCE_CHAIN_MAX_AUTO_STEPS));
  });

  describe("无起点的链（聊天里登记：当时任务还没有 action，fromActionId = null）", () => {
    const nullChain: AdvanceChain = { ...chain, fromActionId: null };
    const noActionTask = { mode: "task", currentActionId: null, actions: [] };
    const runNull = (over: Partial<Parameters<typeof evaluateChainFire>[0]> = {}) =>
      run({ chain: nullChain, task: noActionTask, ...over });

    it("任务仍然没有 action → ok：没有「交卷」可核，这一轮说完就是触发点", () => {
      expect(runNull()).toEqual({ ok: true });
    });

    it("这期间冒出了 action（用户手动推进过 / 别的链已推进）→ stale 让位，不在人家的 action 上再叠一个", () => {
      expect(runNull({ task: okTask })).toMatchObject({ ok: false, kind: "stale" });
    });

    it("其余闸照常管：opGen / TTL / 上限 / 对话型", () => {
      expect(runNull({ opGenNow: 8 })).toMatchObject({ ok: false, kind: "stale" });
      expect(runNull({ now: nullChain.registeredAt + ADVANCE_CHAIN_TTL_MS + 1 })).toMatchObject({
        ok: false,
        kind: "expired",
      });
      expect(runNull({ autoStepsSoFar: ADVANCE_CHAIN_MAX_AUTO_STEPS })).toMatchObject({
        ok: false,
        kind: "capped",
      });
      expect(runNull({ task: { ...noActionTask, mode: "chat" } })).toMatchObject({
        ok: false,
        kind: "invalid",
      });
    });
  });
});

describe("链登记表与自动推进计数", () => {
  const mk = (over: Partial<AdvanceChain> = {}): AdvanceChain => ({
    taskId: "t1",
    fromActionId: "a1",
    opGen: 1,
    actionType: "review",
    instruction: "",
    userWords: "做完直接复核",
    registeredAt: 1,
    ...over,
  });

  it("登记 / peek / take：一次性，take 之后没有了", () => {
    expect(registerAdvanceChain(mk())).toBeNull();
    expect(peekAdvanceChain("t1")?.fromActionId).toBe("a1");
    expect(takeAdvanceChain("t1")?.fromActionId).toBe("a1");
    expect(takeAdvanceChain("t1")).toBeNull();
    expect(peekAdvanceChain("t1")).toBeNull();
  });

  it("同一任务只留最新一条，返回被顶掉的旧链；不同任务互不影响", () => {
    registerAdvanceChain(mk({ fromActionId: "a1" }));
    registerAdvanceChain(mk({ taskId: "t2", fromActionId: "b1" }));
    const prev = registerAdvanceChain(mk({ fromActionId: "a2" }));
    expect(prev?.fromActionId).toBe("a1");
    expect(peekAdvanceChain("t1")?.fromActionId).toBe("a2");
    expect(peekAdvanceChain("t2")?.fromActionId).toBe("b1");
  });

  it("计数：累加到上限即 capped；人手推进清零；清零只影响本任务", () => {
    expect(getAutoAdvanceSteps("t1")).toBe(0);
    for (let i = 1; i <= ADVANCE_CHAIN_MAX_AUTO_STEPS; i++) {
      expect(isAutoAdvanceCapReached("t1")).toBe(false);
      expect(bumpAutoAdvanceSteps("t1")).toBe(i);
    }
    expect(isAutoAdvanceCapReached("t1")).toBe(true);
    bumpAutoAdvanceSteps("t2");
    resetAutoAdvanceSteps("t1");
    expect(getAutoAdvanceSteps("t1")).toBe(0);
    expect(isAutoAdvanceCapReached("t1")).toBe(false);
    expect(getAutoAdvanceSteps("t2")).toBe(1);
  });

  it("没计数时清零是空操作（热路径）", () => {
    expect(() => resetAutoAdvanceSteps("never-seen")).not.toThrow();
    expect(getAutoAdvanceSteps("never-seen")).toBe(0);
  });
});
