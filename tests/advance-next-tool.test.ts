/**
 * advance_next 工具 handler（flowship-tools.ts）：登记前的状态闸（授权由 AI 按提示词自己判断，不核对原话）。
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

// 每个用例一个新任务：事件落盘在临时目录里会累积，复用同一个任务会让上一条用例的残留串进这一条
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
    expect(note?.text).toContain("AI 称依据：「改完直接复核一遍」");
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

  it("当前 action 已交卷（awaiting_ack）时登记也行（交卷在先、登记在后是推荐顺序）", async () => {
    await freshTask({ actions: [mkAction({ status: "awaiting_ack" })] });
    await userSays("做完直接复核");
    expect((await call({ action: "review", user_words: "做完直接复核" })).ok).toBe(true);
  });

  it("聊天里登记：任务当前没有 action（还没推进过）→ 照样登记，起点记为 null；提示事件不挂 action、说「这一轮说完后」", async () => {
    await freshTask({ currentActionId: null, actions: [], runStatus: "running" });
    const r = await call({ action: "plan", instruction: "先出个方案" });
    expect(r.ok).toBe(true);
    expect(r.hint).toContain("没有就直接说完收尾");

    expect(chain.peekAdvanceChain(TASK)).toMatchObject({
      taskId: TASK,
      fromActionId: null,
      actionType: "plan",
      instruction: "先出个方案",
      opGen: getTaskOpGeneration(TASK),
    });
    expect(runner.__isAdvanceChainConsumerInstalledForTest()).toBe(true);

    const t = await getTaskWithTailEvents(TASK, 50);
    const note = t!.events.find((e) => e.meta?.subkind === "auto_advance");
    expect(note?.kind).toBe("info");
    expect(note?.actionId).toBeUndefined();
    expect(note?.text).toContain("这一轮说完后");
    expect(note?.text).toContain("AI 判断你需要这一步");
  });

  it("聊天里登记：上一个 action 已完结（completed，用户 ack 过）→ 也行，起点就是它", async () => {
    await freshTask({ actions: [mkAction({ status: "completed" })] });
    expect((await call({ action: "build", instruction: "按方案实现" })).ok).toBe(true);
    expect(chain.peekAdvanceChain(TASK)).toMatchObject({ fromActionId: "a1", actionType: "build" });
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

  it("user_words 可选：不带也能登记；提示事件如实说是 AI 判断的，不编造用户原话", async () => {
    const r = await call({ action: "review" });
    expect(r.ok).toBe(true);
    expect(chain.peekAdvanceChain(TASK)).toMatchObject({ actionType: "review", userWords: "" });

    const t = await getTaskWithTailEvents(TASK, 50);
    const note = t!.events.find((e) => e.meta?.subkind === "auto_advance");
    expect(note?.text).toContain("AI 判断你需要这一步");
    expect(note?.text).not.toContain("按你的话");
  });

  it("不再核对原话（第一期取舍：授权由 AI 按提示词自己判断）：转述 / 只有群里说过，ship 也照样登记", async () => {
    await userSays("改完直接提测", { source: "feishu_group", groupSenderOpenId: "ou_x" });
    const r = await call({ action: "ship", user_words: "用户希望完成后自动提测" });
    expect(r.ok).toBe(true);
    expect(chain.peekAdvanceChain(TASK)).toMatchObject({
      actionType: "ship",
      userWords: "用户希望完成后自动提测",
    });
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

  it("user_words 超长 → 拒绝（只写依据的那一句，不要整段粘贴）", async () => {
    const r = await call({
      action: "review",
      user_words: "字".repeat(chain.ADVANCE_CHAIN_WORDS_MAX + 1),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("user_words");
    expectNotRegistered();
  });

  it("入参不合规：dev 缺 dev_push_mode / custom 缺 id / 非法 action", async () => {
    await userSays("做完联调，做完走自定义流程");
    expect((await call({ action: "dev", user_words: "做完联调" })).ok).toBe(false);
    expect((await call({ action: "custom", user_words: "做完走自定义流程" })).ok).toBe(false);
    expect((await call({ action: "nope", user_words: "做完联调" })).ok).toBe(false);
    expect((await call({})).ok).toBe(false);
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

  it("对话型任务 / 当前 action 出错或被取消 → 拒绝；用户话已备好，确认是状态闸在拦", async () => {
    const reject = async (over: Record<string, unknown>) => {
      await freshTask(over);
      await userSays("做完直接复核");
      const r = await call({ action: "review", user_words: "做完直接复核" });
      expectNotRegistered();
      return r;
    };
    expect((await reject({ mode: "chat" })).error).toContain("对话型");
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

  it("描述把规矩讲清：外部动作明说才直接登记、依据可选不核对、不在本轮里自己跑下一步、上限", () => {
    expect(def.description).toContain("外部动作");
    expect(def.description).toContain("用户明说才直接登记");
    expect(def.description).toContain("user_words（可选）");
    expect(def.description).toContain("不要自己去跑下一步");
    expect(def.description).toContain(String(chain.ADVANCE_CHAIN_MAX_AUTO_STEPS));
    // 旧版「逐字引用 / 没说过就不要用」的硬要求已撤
    expect(def.description).not.toContain("逐字引用");
    expect(def.description).not.toContain("用户没说过就不要用");
  });

  it("schema：user_words 不是必填，task_id / action 是", () => {
    const required = (def.parameters as { required?: string[] }).required ?? [];
    expect(required).toContain("task_id");
    expect(required).toContain("action");
    expect(required).not.toContain("user_words");
  });

  it("失败回包是 {ok:false} JSON：tool-result-persist 据此判失败、不亮绿勾", async () => {
    const { resolveToolResultStatus } = await import("@/lib/server/tool-result-persist");
    const bad = await def.handler({ task_id: TASK, action: "nope" }, TOK);
    expect(resolveToolResultStatus("done", "advance_next", bad)).toBe("error");
    expect(
      resolveToolResultStatus("done", "mcp:custom-user-tools:advance_next", {
        status: "ok",
        value: { content: [{ text: { text: JSON.stringify({ ok: false, error: "x" }) } }] },
      }),
    ).toBe("error");
  });
});
