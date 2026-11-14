/**
 * 自动推进执行侧（advance-chain-runner.ts）：流帧 → 取链 → 核对 → advanceTask。
 * 全部依赖用 __setAdvanceChainDepsForTest 注入：不碰真 task-runner / 磁盘 / 飞书。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADVANCE_CHAIN_MAX_AUTO_STEPS,
  AUTO_ADVANCE_INSTRUCTION_PREFIX,
  __resetAdvanceChainStateForTest,
  bumpAutoAdvanceSteps,
  getAutoAdvanceSteps,
  peekAdvanceChain,
  registerAdvanceChain,
  type AdvanceChain,
} from "@/lib/server/advance-chain";
import { ADVANCE_STALE_MESSAGE } from "@/lib/server/advance-expectation";
import type { Task, TaskEvent } from "@/lib/types";

// 真实 publish 会走脱敏（可能读凭据文件）：数据目录指到临时目录，绝不碰真实配置
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-advance-chain-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const {
  __isAdvanceChainConsumerInstalledForTest,
  __setAdvanceChainDepsForTest,
  __uninstallAdvanceChainConsumerForTest,
  ensureAdvanceChainConsumer,
  fireAdvanceChain,
  handleAdvanceChainFrame,
} = await import("@/lib/server/advance-chain-runner");
const { publish } = await import("@/lib/server/task-stream");

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const T = "t_chain";
const NOW = 2_000_000_000_000;

const mkTask = (over: Record<string, unknown> = {}): Task =>
  ({
    id: T,
    mode: "task",
    runStatus: "awaiting_user",
    currentActionId: "a1",
    actions: [{ id: "a1", n: 1, type: "build", status: "awaiting_ack", userInstruction: "" }],
    ...over,
  }) as unknown as Task;

const mkChain = (over: Partial<AdvanceChain> = {}): AdvanceChain => ({
  taskId: T,
  fromActionId: "a1",
  opGen: 5,
  actionType: "review",
  instruction: "重点看登录页",
  userWords: "改完直接复核",
  registeredAt: NOW - 60_000,
  ...over,
});

interface Harness {
  advance: ReturnType<typeof vi.fn>;
  writeEvent: ReturnType<typeof vi.fn>;
  events: Array<{ kind: string; text: string; actionId?: string; meta?: Record<string, unknown> }>;
  setTask: (t: Task | null) => void;
  setRunning: (v: boolean) => void;
  setOpGen: (n: number) => void;
}

const install = (): Harness => {
  let task: Task | null = mkTask();
  let running = false;
  let opGen = 5;
  let clock = NOW;
  const events: Harness["events"] = [];
  const advance = vi.fn(async () => ({ action: { id: "a2" } }) as never);
  const writeEvent = vi.fn(async (_t: string, ev: Harness["events"][number]) => {
    events.push(ev);
    return null;
  });
  __setAdvanceChainDepsForTest({
    getTaskMeta: async () => task,
    getOpGeneration: () => opGen,
    isTaskRunning: () => running,
    loadBoot: async () => ({ apiKey: "k", model: { id: "m" } as never }),
    advance: advance as never,
    writeEvent: writeEvent as never,
    customActionLabel: async (id) => (id === "ca_1" ? "我的提测流" : null),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  return {
    advance,
    writeEvent,
    events,
    setTask: (t) => {
      task = t;
    },
    setRunning: (v) => {
      running = v;
    },
    setOpGen: (n) => {
      opGen = n;
    },
  };
};

const done = (ok: boolean, origin?: string) =>
  ({ kind: "done", task: mkTask(), ok, ...(origin ? { origin } : {}) }) as never;

const flush = async () => {
  // fire 里是若干个 await 串起来的微任务链；让出几轮足够跑完
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

let h: Harness;
beforeEach(() => {
  __resetAdvanceChainStateForTest();
  h = install();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  __setAdvanceChainDepsForTest(null);
  __uninstallAdvanceChainConsumerForTest();
  vi.restoreAllMocks();
});

describe("done 帧 → 触发", () => {
  it("正常结束：用登记的参数调 advanceTask（CAS = 登记时的 action、带前缀与依据原话、viaAutoChain）", async () => {
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance).toHaveBeenCalledTimes(1);
    const input = h.advance.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({
      actionType: "review",
      expectedCurrentActionId: "a1",
      opGen: 5,
      viaAutoChain: true,
      apiKey: "k",
    });
    const ins = input.userInstruction as string;
    expect(ins.startsWith(AUTO_ADVANCE_INSTRUCTION_PREFIX)).toBe(true);
    expect(ins).toContain("重点看登录页");
    expect(ins).toContain("改完直接复核");
    // 一次性：链被取走
    expect(peekAdvanceChain(T)).toBeNull();
    // 成功 → 计数 +1
    expect(getAutoAdvanceSteps(T)).toBe(1);
  });

  it("落一条「正在自动推进」提示：写明依据原话 / 目标 / 第几步，挂在上一条 action 上", async () => {
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(true));
    await flush();
    const note = h.events.find((e) => e.meta?.subkind === "auto_advance");
    expect(note?.kind).toBe("info");
    expect(note?.actionId).toBe("a1");
    expect(note?.text).toContain("改完直接复核");
    expect(note?.text).toContain("复核");
    expect(note?.text).toContain(`1/${ADVANCE_CHAIN_MAX_AUTO_STEPS}`);
  });

  it("无起点的链（聊天里登记、当时任务没有 action）：任务仍没有 action → 这一轮结束就推进；CAS 期望「没有 action」，提示不挂 action", async () => {
    h.setTask(mkTask({ currentActionId: null, actions: [] }));
    registerAdvanceChain(mkChain({ fromActionId: null, actionType: "plan" }));
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance).toHaveBeenCalledTimes(1);
    expect(h.advance.mock.calls[0]![0]).toMatchObject({
      actionType: "plan",
      expectedCurrentActionId: null,
      viaAutoChain: true,
    });
    const note = h.events.find((e) => e.meta?.subkind === "auto_advance");
    expect(note?.kind).toBe("info");
    expect(note?.actionId).toBeUndefined();
    expect(getAutoAdvanceSteps(T)).toBe(1);
  });

  it("无起点的链：这期间任务已有 action（用户手动推进过）→ 静默让位", async () => {
    h.setTask(mkTask({ currentActionId: "a9" }));
    registerAdvanceChain(mkChain({ fromActionId: null, actionType: "plan" }));
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("dev / custom / build 的附加参数原样透传", async () => {
    registerAdvanceChain(mkChain({ actionType: "dev", devPushMode: "mr" }));
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance.mock.calls[0]![0]).toMatchObject({ actionType: "dev", devPushMode: "mr" });

    h.advance.mockClear();
    registerAdvanceChain(mkChain({ actionType: "build", batchIds: ["b1"] }));
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance.mock.calls[0]![0]).toMatchObject({ requestedBatchIds: ["b1"] });

    h.advance.mockClear();
    registerAdvanceChain(mkChain({ actionType: "custom", customActionId: "ca_1" }));
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance.mock.calls[0]![0]).toMatchObject({ actionType: "custom", customActionId: "ca_1" });
    expect(h.events.some((e) => e.text.includes("我的提测流"))).toBe(true);
  });

  it("run 非正常结束（停止 / 报错）：链作废、不推进、不提示", async () => {
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(false));
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(peekAdvanceChain(T)).toBeNull();
  });

  it("带 origin 的 done（非属主 / 旁路）不是主链：不动链、不推进", async () => {
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(true, "restricted:run1"));
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
    expect(peekAdvanceChain(T)).not.toBeNull();
  });

  it("别的任务的 done / 没有链时：什么都不发生", async () => {
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame("other_task", done(true));
    handleAdvanceChainFrame(T, { kind: "task", task: mkTask() } as never);
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
    __resetAdvanceChainStateForTest();
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
  });
});

describe("触发前核对", () => {
  it("没交卷（action 仍 running）→ 不推进，落明确原因", async () => {
    h.setTask(mkTask({ actions: [{ id: "a1", n: 1, type: "build", status: "running", userInstruction: "" }] }));
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.events.some((e) => e.text.includes("没有正常交卷"))).toBe(true);
  });

  it("停止过（opGen 变了）→ 静默让位：不推进、不落提示", async () => {
    h.setOpGen(6);
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("当前 action 已被人手推进过 → 静默让位", async () => {
    h.setTask(mkTask({ currentActionId: "a9" }));
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("任务已删 → 静默让位", async () => {
    h.setTask(null);
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
  });

  it("连续自动推进已达上限 → 不推进，提示里写上限", async () => {
    for (let i = 0; i < ADVANCE_CHAIN_MAX_AUTO_STEPS; i++) bumpAutoAdvanceSteps(T);
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.events.some((e) => e.text.includes(`${ADVANCE_CHAIN_MAX_AUTO_STEPS} 步`))).toBe(true);
    // 没推进 → 计数不再增加
    expect(getAutoAdvanceSteps(T)).toBe(ADVANCE_CHAIN_MAX_AUTO_STEPS);
  });

  it("done 刚到、run 还没落定：等一小会儿；落定了照常推进", async () => {
    h.setRunning(true);
    let polls = 0;
    __setAdvanceChainDepsForTest({
      isTaskRunning: () => ++polls <= 3,
    });
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(polls).toBeGreaterThan(3);
    expect(h.advance).toHaveBeenCalledTimes(1);
  });

  it("一直在跑（新一轮已经起来）→ 放弃，落提示、不推进", async () => {
    __setAdvanceChainDepsForTest({ isTaskRunning: () => true });
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.events.some((e) => e.text.includes("又开始跑"))).toBe(true);
  });

  it("本机缺 API Key / 模型 → 不推进，落提示", async () => {
    __setAdvanceChainDepsForTest({ loadBoot: async () => null });
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.events.some((e) => e.text.includes("API Key"))).toBe(true);
  });
});

describe("advanceTask 失败的处理", () => {
  it("CAS 陈旧 → 落「让位」提示，不是 error 事件，不加计数", async () => {
    h.advance.mockRejectedValueOnce(new Error(ADVANCE_STALE_MESSAGE));
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.events.some((e) => e.kind === "error")).toBe(false);
    expect(h.events.some((e) => e.text.includes("让位"))).toBe(true);
    expect(getAutoAdvanceSteps(T)).toBe(0);
  });

  it("op 让位（停止中）同样静默当让位", async () => {
    h.advance.mockRejectedValueOnce(new Error("正在停止/任务已变更、请重发"));
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.events.some((e) => e.kind === "error")).toBe(false);
  });

  it("其它失败（准入不过 / 建工作区失败…）→ 落 error 事件，带原因与 advance_failed 标记，不加计数", async () => {
    h.advance.mockRejectedValueOnce(new Error("缺少 GitLab Token"));
    registerAdvanceChain(mkChain({ actionType: "ship" }));
    handleAdvanceChainFrame(T, done(true));
    await flush();
    const err = h.events.find((e) => e.kind === "error");
    expect(err?.text).toContain("缺少 GitLab Token");
    expect(err?.text).toContain("提测");
    expect(err?.meta).toMatchObject({ subkind: "advance_failed", actionType: "ship", auto: true });
    expect(getAutoAdvanceSteps(T)).toBe(0);
  });

  it("写事件本身抛错也不让 fire 抛出（不产生未处理 rejection）", async () => {
    __setAdvanceChainDepsForTest({
      writeEvent: async () => {
        throw new Error("disk full");
      },
    });
    h.advance.mockRejectedValueOnce(new Error("boom"));
    registerAdvanceChain(mkChain());
    await expect(fireAdvanceChain(T, mkChain())).resolves.toBeUndefined();
  });
});

describe("登记后用户又插话 → 链作废", () => {
  const userReply = (ts: number, meta?: Record<string, unknown>): TaskEvent =>
    ({ id: "e1", ts, kind: "user_reply", text: "等等，先别提测", ...(meta ? { meta } : {}) }) as TaskEvent;

  it("登记之后的 user_reply → 取消并落提示；之后 done 不再推进", async () => {
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, { kind: "event", event: userReply(NOW) } as never);
    await flush();
    expect(peekAdvanceChain(T)).toBeNull();
    expect(h.events.some((e) => e.text.includes("已取消"))).toBe(true);
    handleAdvanceChainFrame(T, done(true));
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
  });

  it("登记之前的 user_reply（含触发本轮 run 的那条）不算插话", async () => {
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, { kind: "event", event: userReply(NOW - 120_000) } as never);
    handleAdvanceChainFrame(T, {
      kind: "event",
      event: userReply(NOW - 60_000), // = registeredAt，不严格晚于登记
    } as never);
    expect(peekAdvanceChain(T)).not.toBeNull();
  });

  it("群里别人的话不会取消属主登记的链", async () => {
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, {
      kind: "event",
      event: userReply(NOW, { source: "feishu_group", groupSenderOpenId: "ou_x" }),
    } as never);
    handleAdvanceChainFrame(T, {
      kind: "event",
      event: userReply(NOW, { groupNonOwnerTurn: true }),
    } as never);
    expect(peekAdvanceChain(T)).not.toBeNull();
  });

  it("定时到点（schedule 来源）不是用户插话：不取消链", async () => {
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, {
      kind: "event",
      event: userReply(NOW, { source: "schedule", scheduleId: "s1" }),
    } as never);
    expect(peekAdvanceChain(T)).not.toBeNull();
  });

  it("非 user_reply 事件（AI 输出 / info）不取消", async () => {
    registerAdvanceChain(mkChain());
    handleAdvanceChainFrame(T, {
      kind: "event",
      event: { id: "e2", ts: NOW, kind: "assistant_message", text: "好的" },
    } as never);
    expect(peekAdvanceChain(T)).not.toBeNull();
  });
});

describe("订阅装配", () => {
  it("ensure 幂等：装两次只订阅一份，真实 publish 的 done 只触发一次推进", async () => {
    ensureAdvanceChainConsumer();
    ensureAdvanceChainConsumer();
    expect(__isAdvanceChainConsumerInstalledForTest()).toBe(true);
    registerAdvanceChain(mkChain());
    publish(T, done(true));
    await flush();
    expect(h.advance).toHaveBeenCalledTimes(1);
  });

  it("重复 ensure 不会多挂监听，卸载后监听数回到原样（不泄漏）", () => {
    const set = (globalThis as unknown as Record<string, Set<unknown>>)[
      "__flowshipAllTaskStreamListenersV1__"
    ];
    const before = set.size;
    ensureAdvanceChainConsumer();
    ensureAdvanceChainConsumer();
    ensureAdvanceChainConsumer();
    expect(set.size).toBe(before + 1);
    __uninstallAdvanceChainConsumerForTest();
    expect(set.size).toBe(before);
  });

  it("卸载后不再响应", async () => {
    ensureAdvanceChainConsumer();
    __uninstallAdvanceChainConsumerForTest();
    expect(__isAdvanceChainConsumerInstalledForTest()).toBe(false);
    registerAdvanceChain(mkChain());
    publish(T, done(true));
    await flush();
    expect(h.advance).not.toHaveBeenCalled();
  });
});
