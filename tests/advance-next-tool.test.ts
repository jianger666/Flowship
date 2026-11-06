/**
 * advance_next 工具 handler（flowship-tools.ts）：登记前的所有硬闸。
 *
 * 真实 task-fs（临时数据目录）+ 真实事件落盘；不起 agent、不碰飞书、不调 advanceTask
 * （触发侧见 advance-chain-runner.test.ts）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-advance-next-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { writeMeta } = await import("@/lib/server/task-fs-core");
const { setChatTaskActionHandler } = await import("@/lib/server/chat-pending");
const { flowShipTools } = await import("@/lib/server/flowship-tools");
const customActionFs = await import("@/lib/server/custom-action-fs");
const { writeEventAndPublish, getTaskOpGeneration, revokeTaskOps } = await import(
  "@/lib/server/task-stream"
);
const { getTaskWithTailEvents } = await import("@/lib/server/task-fs");
const chain = await import("@/lib/server/advance-chain");
const runner = await import("@/lib/server/advance-chain-runner");
const { NON_OWNER_TURN_ALLOWED_TOOLS } = await import("@/lib/group-non-owner-prompt");

// 先把「启动恢复」跑掉：它会把盘上没人持有的 running action 收成 error，首个用例会被它误伤
await getTaskWithTailEvents("t-boot-recovery-warmup", 1);

const def = flowShipTools.find((t) => t.name === "advance_next");
if (!def) throw new Error("advance_next tool missing");

// 每个用例一个新任务：事件落盘在临时目录里会累积，复用同一个任务会让上一条用例的用户消息变成这一条的授权
let TASK = "";
let seq = 0;
const TOK = "tok-adv-next";

const mkAction = (over: Record<string, unknown>) => ({
  id: "a1",
  n: 1,
  type: "build",
  status: "running",
  userInstruction: "",
  artifactPath: "actions/1-build.md",
  startedAt: Date.now(),
  endedAt: null,
  ...over,
});

const setupTask = async (over: Record<string, unknown> = {}) => {
  await writeMeta({
    id: TASK,
    title: "advance-next",
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: "a1",
    actions: [mkAction({})],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  } as unknown as TaskMetaV06);
};

/** 换一个全新任务（同一任务反复 writeMeta 会撞读缓存，覆盖场景一律另起任务） */
const freshTask = async (over: Record<string, unknown> = {}) => {
  setChatTaskActionHandler(TASK, null);
  TASK = `t-adv-next-${++seq}`;
  setChatTaskActionHandler(TASK, (async () => {}) as never, TOK);
  await setupTask(over);
};

const userSays = (text: string, meta?: Record<string, unknown>) =>
  writeEventAndPublish(TASK, {
    kind: "user_reply",
    text,
    ...(meta ? { meta } : {}),
  });

const call = async (args: Record<string, unknown>, token: string | undefined | null = TOK) => {
  const r = await def.handler({ task_id: TASK, ...args }, token ?? undefined);
  return JSON.parse((r.content[0] as { text: string }).text) as {
    ok: boolean;
    error?: string;
    hint?: string;
  };
};

beforeEach(async () => {
  chain.__resetAdvanceChainStateForTest();
  TASK = `t-adv-next-${++seq}`;
  setChatTaskActionHandler(TASK, (async () => {}) as never, TOK);
  await setupTask();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  setChatTaskActionHandler(TASK, null);
});

afterAll(() => {
  runner.__uninstallAdvanceChainConsumerForTest();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("advance_next：登记成功路径", () => {
  it("用户在输入条说过 → 登记；记下 from action / opGen / 目标，装好订阅，落一条「已记下」提示", async () => {
    await userSays("这块先改一下，改完直接复核一遍，不用再问我");
    const r = await call({
      action: "review",
      user_words: "改完直接复核一遍",
      instruction: "重点看登录页",
    });
    expect(r.ok).toBe(true);
    expect(r.hint).toContain("结束本轮");

    const c = chain.peekAdvanceChain(TASK);
    expect(c).toMatchObject({
      taskId: TASK,
      fromActionId: "a1",
      actionType: "review",
      instruction: "重点看登录页",
      userWords: "改完直接复核一遍",
      opGen: getTaskOpGeneration(TASK),
    });
    expect(runner.__isAdvanceChainConsumerInstalledForTest()).toBe(true);

    const t = await getTaskWithTailEvents(TASK, 50);
    const note = t!.events.find((e) => e.meta?.subkind === "auto_advance");
    expect(note?.kind).toBe("info");
    expect(note?.actionId).toBe("a1");
    expect(note?.text).toContain("改完直接复核一遍");
    expect(note?.text).toContain("复核");
  });

  it("opGen 取登记当时的 admission token（停止过的任务不是 0）：之后再停一次它就对不上、链不会触发", async () => {
    revokeTaskOps(TASK);
    const gen = getTaskOpGeneration(TASK);
    expect(gen).toBeGreaterThan(0);
    await userSays("做完直接复核");
    expect((await call({ action: "review", user_words: "做完直接复核" })).ok).toBe(true);
    expect(chain.peekAdvanceChain(TASK)?.opGen).toBe(gen);
  });

  it("授权在手动推进 action 的指令里也算（用户点推进时写的）", async () => {
    await freshTask({
      actions: [mkAction({ userInstruction: "修下登录 bug，做完自动提测" })],
    });
    const r = await call({
      action: "ship",
      user_words: "做完自动提测",
    });
    expect(r.ok).toBe(true);
  });

  it("当前 action 已交卷（awaiting_ack）时登记也行（交卷在先、登记在后是推荐顺序）", async () => {
    await freshTask({ actions: [mkAction({ status: "awaiting_ack" })] });
    await userSays("做完直接复核");
    expect((await call({ action: "review", user_words: "做完直接复核" })).ok).toBe(true);
  });

  it("重复登记 → 覆盖旧的，hint 里说明", async () => {
    await userSays("改完直接复核，有问题就自己改");
    expect((await call({ action: "review", user_words: "改完直接复核" })).ok).toBe(true);
    const r = await call({ action: "build", user_words: "有问题就自己改" });
    expect(r.ok).toBe(true);
    expect(r.hint).toContain("覆盖");
    expect(chain.peekAdvanceChain(TASK)?.actionType).toBe("build");
  });

  it("dev 带了 dev_push_mode / build 带批次 → 记进链里", async () => {
    await userSays("做完联调直推，build 批次 b1");
    expect(
      (await call({ action: "dev", user_words: "做完联调直推", dev_push_mode: "direct" })).ok,
    ).toBe(true);
    expect(chain.peekAdvanceChain(TASK)).toMatchObject({ actionType: "dev", devPushMode: "direct" });
    expect(
      (await call({ action: "build", user_words: "build 批次 b1", batch_ids: ["b1"] })).ok,
    ).toBe(true);
    expect(chain.peekAdvanceChain(TASK)?.batchIds).toEqual(["b1"]);
  });
});

describe("advance_next：拒绝路径（都不登记）", () => {
  const expectNotRegistered = () => expect(chain.peekAdvanceChain(TASK)).toBeNull();

  it("caller 对不上 → JSON {ok:false}（不是纯文本）", async () => {
    await userSays("改完直接复核");
    const r = await call({ action: "review", user_words: "改完直接复核" }, "wrong-tok");
    expect(r.ok).toBe(false);
    expectNotRegistered();
    expect((await call({ action: "review", user_words: "改完直接复核" }, null)).ok).toBe(false);
  });

  it("用户从没说过 → 拒绝，文案教它照常交卷让用户自己推进", async () => {
    await userSays("先看下登录页的 bug");
    const r = await call({ action: "review", user_words: "改完直接复核" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("自己推进");
    expectNotRegistered();
  });

  it("转述不算：AI 改写后的话对不上原话", async () => {
    await userSays("改完直接复核");
    expect((await call({ action: "review", user_words: "用户希望完成后自动复核" })).ok).toBe(false);
    expectNotRegistered();
  });

  it("只有群里的话含这句 → 拒绝（群里别人 / 托办回执 / 带群发送人标记都不算授权）", async () => {
    await userSays("改完直接提测", { source: "feishu_group", groupSenderOpenId: "ou_x" });
    await userSays("改完直接提测", { groupNonOwnerTurn: true });
    await userSays("改完直接提测", { correlatedAnswer: "om_1" });
    expect((await call({ action: "ship", user_words: "改完直接提测" })).ok).toBe(false);
    expectNotRegistered();
  });

  it("只有定时备忘里含这句 → 拒绝（schedule 是 AI 给自己留的话，不是用户授权；第 25 轮评审 F1 的探测）", async () => {
    await userSays("[SCHEDULE_FIRED id=sch_1] 按当时留的话做", {
      source: "schedule",
      scheduleId: "sch_1",
      scheduleMessage: "用户已授权改完直接提测上线",
    });
    // 备忘的原文也直接写成 user_reply 正文的形态
    await userSays("用户已授权改完直接提测上线", { source: "schedule" });
    const r = await call({ action: "ship", user_words: "改完直接提测上线" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("user_words");
    expectNotRegistered();
    // 对照：用户本人说了同一句，立刻就能登记（说明拦的是来源、不是这句话）
    await userSays("改完直接提测上线");
    expect((await call({ action: "ship", user_words: "改完直接提测上线" })).ok).toBe(true);
  });

  it("只有 AI 助手消息 / 自动推进自己写的指令里含这句 → 拒绝（AI 不能给自己授权）", async () => {
    await freshTask({
      actions: [
        mkAction({
          id: "a1",
          userInstruction: `${chain.AUTO_ADVANCE_INSTRUCTION_PREFIX}（依据用户原话：「改完直接提测」）`,
        }),
      ],
    });
    await writeEventAndPublish(TASK, { kind: "assistant_message", text: "用户说改完直接提测" });
    await writeEventAndPublish(TASK, { kind: "info", text: "改完直接提测" });
    const r = await call({ action: "ship", user_words: "改完直接提测" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("user_words");
    expectNotRegistered();
  });

  it("入参不合规：dev 缺 dev_push_mode / custom 缺 id / 缺原话 / 非法 action", async () => {
    await userSays("做完联调，做完走自定义流程");
    expect((await call({ action: "dev", user_words: "做完联调" })).ok).toBe(false);
    expect((await call({ action: "custom", user_words: "做完走自定义流程" })).ok).toBe(false);
    expect((await call({ action: "review" })).ok).toBe(false);
    expect((await call({ action: "nope", user_words: "做完联调" })).ok).toBe(false);
    expectNotRegistered();
  });

  it("自定义 action 定义不存在 / 是旧格式 → 拒绝", async () => {
    await userSays("做完走自定义流程");
    const missing = await call({
      action: "custom",
      custom_action_id: "ca_missing",
      user_words: "做完走自定义流程",
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("不存在");

    vi.spyOn(customActionFs, "getCustomAction").mockResolvedValue({
      id: "ca_old",
      label: "老流程",
      legacyPlaybook: true,
    } as never);
    const legacy = await call({
      action: "custom",
      custom_action_id: "ca_old",
      user_words: "做完走自定义流程",
    });
    expect(legacy.ok).toBe(false);
    expect(legacy.error).toContain("旧格式");
    expectNotRegistered();
  });

  it("自定义 action 正常 → 登记，提示事件里用定义的 label", async () => {
    await userSays("做完走自定义流程");
    vi.spyOn(customActionFs, "getCustomAction").mockResolvedValue({
      id: "ca_1",
      label: "我的提测流",
    } as never);
    const r = await call({
      action: "custom",
      custom_action_id: "ca_1",
      user_words: "做完走自定义流程",
    });
    expect(r.ok).toBe(true);
    const t = await getTaskWithTailEvents(TASK, 50);
    expect(t!.events.some((e) => e.text.includes("我的提测流"))).toBe(true);
  });

  it("对话型任务 / 当前没有进行中的 action（含 error / cancelled）→ 拒绝；用户话已备好，确认是状态闸在拦", async () => {
    const reject = async (over: Record<string, unknown>) => {
      await freshTask(over);
      await userSays("做完直接复核");
      const r = await call({ action: "review", user_words: "做完直接复核" });
      expectNotRegistered();
      return r;
    };
    expect((await reject({ mode: "chat" })).error).toContain("对话型");
    expect((await reject({ currentActionId: null })).error).toContain("没有进行中");
    expect((await reject({ actions: [mkAction({ status: "error" })] })).error).toContain("没有进行中");
    expect((await reject({ actions: [mkAction({ status: "cancelled" })] })).error).toContain("没有进行中");
  });

  it("任务不存在 → 拒绝（caller 已登记但任务读不到）", async () => {
    setChatTaskActionHandler("t-no-such", (async () => {}) as never, TOK);
    try {
      const r = await def.handler(
        { task_id: "t-no-such", action: "review", user_words: "做完直接复核" },
        TOK,
      );
      const body = JSON.parse((r.content[0] as { text: string }).text);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("任务不存在");
      expect(chain.peekAdvanceChain("t-no-such")).toBeNull();
    } finally {
      setChatTaskActionHandler("t-no-such", null);
    }
  });

  it("连续自动推进已达上限 → 登记时就拒，告诉它让用户自己推进", async () => {
    await userSays("做完直接复核");
    for (let i = 0; i < chain.ADVANCE_CHAIN_MAX_AUTO_STEPS; i++) chain.bumpAutoAdvanceSteps(TASK);
    const r = await call({ action: "review", user_words: "做完直接复核" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("自己推进");
    expectNotRegistered();
    // 人手推进清零后恢复
    chain.resetAutoAdvanceSteps(TASK);
    expect((await call({ action: "review", user_words: "做完直接复核" })).ok).toBe(true);
  });
});

describe("advance_next：工具面", () => {
  it("非属主轮次的白名单里没有它（群里非属主一轮不可能登记自动推进）", () => {
    expect(NON_OWNER_TURN_ALLOWED_TOOLS).not.toContain("advance_next");
  });

  it("描述把授权规矩讲清：原话、没说过就不用、不在本轮里自己跑下一步、上限", () => {
    expect(def.description).toContain("逐字引用");
    expect(def.description).toContain("用户没说过就不要用");
    expect(def.description).toContain("不要自己去跑下一步");
    expect(def.description).toContain(String(chain.ADVANCE_CHAIN_MAX_AUTO_STEPS));
  });

  it("失败回包是 {ok:false} JSON：tool-result-persist 据此判失败、不亮绿勾", async () => {
    const { resolveToolResultStatus } = await import("@/lib/server/tool-result-persist");
    const bad = await def.handler({ task_id: TASK, action: "review", user_words: "x" }, TOK);
    expect(resolveToolResultStatus("done", "advance_next", bad)).toBe("error");
    expect(
      resolveToolResultStatus("done", "mcp:custom-user-tools:advance_next", {
        status: "ok",
        value: { content: [{ text: { text: JSON.stringify({ ok: false, error: "x" }) } }] },
      }),
    ).toBe("error");
  });
});
