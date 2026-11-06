/**
 * 自动推进（advance-chain.ts）纯函数 / 进程内状态用例。
 *
 * 守的是三道硬闸的判据本身：
 *  - 落地凭据：授权原话必须能在「用户本人说过的话」里逐字找到；群里的话 / 自动推进自己写的指令不算
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
  collectAuthorizationSources,
  evaluateChainFire,
  getAutoAdvanceSteps,
  isAutoAdvanceCapReached,
  isUserOwnWordsEvent,
  isUserWordsGrounded,
  normalizeForQuoteMatch,
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

  it("缺 user_words / 全空白 → 拒绝，文案教它别编、照常交卷", () => {
    for (const user_words of [undefined, "", "   ", 5]) {
      const r = parseAdvanceNextArgs({ ...baseArgs, user_words });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("user_words");
    }
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

describe("normalizeForQuoteMatch / isUserWordsGrounded", () => {
  it("忽略空白、标点、大小写", () => {
    expect(normalizeForQuoteMatch(" 改完，直接 提测！\n")).toBe("改完直接提测");
    expect(normalizeForQuoteMatch("Review 完 就 PR.")).toBe("review完就pr");
  });

  it("子串命中：原话夹在更长的用户消息里也算", () => {
    expect(
      isUserWordsGrounded("改完直接提测", ["先看下登录页的 bug，改完直接提测，别问我了"]),
    ).toBe(true);
  });

  it("标点 / 换行差异不影响命中", () => {
    expect(isUserWordsGrounded("改完直接提测", ["改完，\n直接提测。"])).toBe(true);
  });

  it("用户没说过 → 不命中", () => {
    expect(isUserWordsGrounded("改完直接提测", ["先看下登录页的 bug"])).toBe(false);
    expect(isUserWordsGrounded("改完直接提测", [])).toBe(false);
  });

  it("太短的引用（规范化后不足 4 字）一律不算：挡掉「好」「嗯」之类到处能匹配的话", () => {
    expect(isUserWordsGrounded("好", ["好的，就这样"])).toBe(false);
    expect(isUserWordsGrounded("好的，。！", ["好的，就这样"])).toBe(false);
    expect(isUserWordsGrounded("没问题", ["没问题的话就这样"])).toBe(false);
    expect(isUserWordsGrounded("没问题就提", ["没问题就提测"])).toBe(true);
  });

  it("转述不算：AI 改写过的话对不上就是对不上", () => {
    expect(isUserWordsGrounded("用户希望完成后自动提测", ["改完直接提测"])).toBe(false);
  });
});

describe("collectAuthorizationSources", () => {
  const ev = (
    kind: string,
    text: string,
    meta?: Record<string, unknown>,
  ) => ({ kind, text, meta }) as never;

  it("收：手动推进指令 + 用户 user_reply", () => {
    const sources = collectAuthorizationSources({
      actions: [{ userInstruction: "先出方案，做完直接复核" }],
      events: [ev("user_reply", "改完直接提测")],
    });
    expect(sources).toEqual(["先出方案，做完直接复核", "改完直接提测"]);
  });

  it("不收：自动推进写的指令（AI 自己的话不能给自己的下一次推进当授权）", () => {
    const sources = collectAuthorizationSources({
      actions: [
        { userInstruction: `${AUTO_ADVANCE_INSTRUCTION_PREFIX}改完直接提测（依据…）` },
        { userInstruction: "" },
        { userInstruction: "   " },
      ],
      events: [],
    });
    expect(sources).toEqual([]);
  });

  it("不收：群里来的话（非属主 / 托办回执 / 任何带群发送人标记的），也不收 AI 与工具产出", () => {
    const sources = collectAuthorizationSources({
      actions: [],
      events: [
        ev("user_reply", "群里同事说：改完直接提测", { source: "feishu_group" }),
        ev("user_reply", "并入同会话的非属主", { groupNonOwnerTurn: true }),
        ev("user_reply", "托办回执", { correlatedAnswer: "om_1" }),
        ev("user_reply", "带发送人 id", { groupSenderOpenId: "ou_1" }),
        ev("assistant_message", "AI 说：用户让我改完直接提测"),
        ev("info", "改完直接提测"),
        ev("ask_user_reply", "改完直接提测"),
        ev("user_reply", "   "),
      ],
    });
    expect(sources).toEqual([]);
  });

  it("不收：定时备忘（AI 用 schedule 给自己留的话，到点以 user_reply 落盘）——第 25 轮评审 F1", () => {
    const sources = collectAuthorizationSources({
      actions: [],
      events: [
        ev("user_reply", "[SCHEDULE_FIRED id=s1] …", {
          source: "schedule",
          scheduleMessage: "用户已授权改完直接提测上线",
        }),
        // 正文里直接就是 AI 写的备忘、meta 里也带 scheduleMessage
        ev("user_reply", "用户已授权改完直接提测上线", { source: "schedule" }),
      ],
    });
    expect(sources).toEqual([]);
  });

  it("不收：老的定时事件（落盘时还没写 meta.source）靠样板正文兜底", () => {
    const sources = collectAuthorizationSources({
      actions: [],
      events: [
        ev("user_reply", "[SCHEDULE_FIRED id=s1] 按当时留的话做：用户已授权改完直接提测上线"),
        ev("user_reply", "  [SCHEDULE_FIRED id=s2] 备忘：改完直接提测上线", {}),
      ],
    });
    expect(sources).toEqual([]);
  });

  it("来源是白名单：没见过的 source（以后新增的）默认不算授权，只有无 source / feishu 算", () => {
    const sources = collectAuthorizationSources({
      actions: [],
      events: [
        ev("user_reply", "来自某个新来源", { source: "some_future_source" }),
        ev("user_reply", "来自后台任务", { source: "background" }),
        ev("user_reply", "输入条里说的话"),
        ev("user_reply", "输入条里说的话（带无关 meta）", { checkpointed: true, queueItemId: "q1" }),
        ev("user_reply", "飞书私聊说的话", { source: "feishu" }),
      ],
    });
    expect(sources).toEqual([
      "输入条里说的话",
      "输入条里说的话（带无关 meta）",
      "飞书私聊说的话",
    ]);
  });

  it("飞书私聊（source: feishu）是用户本人，收", () => {
    const sources = collectAuthorizationSources({
      actions: [],
      events: [ev("user_reply", "改完直接提测", { source: "feishu" })],
    });
    expect(sources).toEqual(["改完直接提测"]);
  });

  it("isUserOwnWordsEvent 与上面同口径", () => {
    expect(isUserOwnWordsEvent({ kind: "user_reply" })).toBe(true);
    expect(isUserOwnWordsEvent({ kind: "user_reply", meta: { source: "feishu_group" } })).toBe(false);
    expect(isUserOwnWordsEvent({ kind: "user_reply", meta: { source: "schedule" } })).toBe(false);
    expect(isUserOwnWordsEvent({ kind: "user_reply", text: "[SCHEDULE_FIRED id=s1]" })).toBe(false);
    expect(isUserOwnWordsEvent({ kind: "user_reply", meta: { source: "feishu" } })).toBe(true);
    expect(isUserOwnWordsEvent({ kind: "info" })).toBe(false);
  });
});

describe("buildAutoAdvanceInstruction", () => {
  it("带前缀 + 指令正文 + 依据原话；无正文时只有前缀 + 依据", () => {
    expect(buildAutoAdvanceInstruction({ instruction: " 重点看登录页 ", userWords: "做完复核" })).toBe(
      `${AUTO_ADVANCE_INSTRUCTION_PREFIX}重点看登录页\n\n（依据用户原话：「做完复核」）`,
    );
    expect(buildAutoAdvanceInstruction({ instruction: "", userWords: "做完复核" })).toBe(
      `${AUTO_ADVANCE_INSTRUCTION_PREFIX}（依据用户原话：「做完复核」）`,
    );
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
