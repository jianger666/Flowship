/**
 * 聊天通道（一次性 agent）的对话记忆：纯状态机（oneshot-session-memory.ts）。
 * 接线（真跑 startOneShotQuestion：接回 / 回退 / 记下 / 丢弃 / 失效）在 tests/oneshot-question-bailout.test.ts。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  ONESHOT_MEMORY_MAX_TASKS,
  ONESHOT_MEMORY_MAX_TURNS,
  ONESHOT_MEMORY_TTL_MS,
  __resetOneShotMemoryForTest,
  discardOneShotMemory,
  getOneShotMemoryEpoch,
  invalidateOneShotMemory,
  oneShotMemoryMatches,
  oneShotModelKey,
  peekOneShotMemory,
  rememberOneShotMemory,
  type OneShotMemory,
} from "@/lib/server/oneshot-session-memory";

beforeEach(() => __resetOneShotMemoryForTest());

const NOW = 1_800_000_000_000;
const mem = (over: Partial<OneShotMemory> = {}): OneShotMemory => ({
  agentId: "agent_1",
  providerId: "cursor",
  modelKey: "m|",
  cwd: "/w",
  boundChatId: null,
  turns: 1,
  savedAt: NOW,
  ...over,
});

describe("oneShotModelKey / oneShotMemoryMatches", () => {
  it("同一个模型同一组参数 = 同一个 key，参数顺序无关；换模型 / 换参数 = 不同", () => {
    const a = oneShotModelKey({ id: "m", params: [{ id: "x", value: "1" }, { id: "y", value: "2" }] });
    const b = oneShotModelKey({ id: "m", params: [{ id: "y", value: "2" }, { id: "x", value: "1" }] });
    expect(a).toBe(b);
    expect(oneShotModelKey({ id: "m2", params: [] })).not.toBe(oneShotModelKey({ id: "m", params: [] }));
    expect(oneShotModelKey({ id: "m", params: [{ id: "x", value: "9" }] })).not.toBe(
      oneShotModelKey({ id: "m", params: [{ id: "x", value: "1" }] }),
    );
    expect(oneShotModelKey(undefined)).toBe("|");
  });

  it("提供方 / 模型 / 工作目录任何一项不同都不接", () => {
    const want = { providerId: "cursor", modelKey: "m|", cwd: "/w" };
    expect(oneShotMemoryMatches(mem(), want)).toBe(true);
    expect(oneShotMemoryMatches(mem(), { ...want, providerId: "custom-1" })).toBe(false);
    expect(oneShotMemoryMatches(mem(), { ...want, modelKey: "m2|" })).toBe(false);
    expect(oneShotMemoryMatches(mem(), { ...want, cwd: "/other" })).toBe(false);
  });
});

describe("记下 / 取用", () => {
  it("记下后能取到；没记过的任务取不到", () => {
    expect(peekOneShotMemory("t1", NOW)).toBeNull();
    expect(rememberOneShotMemory("t1", mem(), getOneShotMemoryEpoch("t1"))).toBe(true);
    expect(peekOneShotMemory("t1", NOW)).toMatchObject({ agentId: "agent_1", turns: 1 });
    expect(peekOneShotMemory("t2", NOW)).toBeNull();
  });

  it("过期：恰好 TTL 还能用，超过就作废并当场清掉", () => {
    rememberOneShotMemory("t1", mem(), 0);
    expect(peekOneShotMemory("t1", NOW + ONESHOT_MEMORY_TTL_MS)).not.toBeNull();
    expect(peekOneShotMemory("t1", NOW + ONESHOT_MEMORY_TTL_MS + 1)).toBeNull();
    // 清掉了：回到有效期内也取不回
    expect(peekOneShotMemory("t1", NOW)).toBeNull();
  });

  it("轮数到顶就不再接力（换个新的起头）；差一轮还接", () => {
    rememberOneShotMemory("t1", mem({ turns: ONESHOT_MEMORY_MAX_TURNS - 1 }), 0);
    expect(peekOneShotMemory("t1", NOW)).not.toBeNull();
    rememberOneShotMemory("t1", mem({ turns: ONESHOT_MEMORY_MAX_TURNS }), 0);
    expect(peekOneShotMemory("t1", NOW)).toBeNull();
  });

  it("记下新的会覆盖旧的", () => {
    rememberOneShotMemory("t1", mem({ agentId: "a" }), 0);
    rememberOneShotMemory("t1", mem({ agentId: "b", turns: 2 }), 0);
    expect(peekOneShotMemory("t1", NOW)).toMatchObject({ agentId: "b", turns: 2 });
  });

  it("超过任务数上限：挤掉最久没动的，最近的都在", () => {
    for (let i = 0; i <= ONESHOT_MEMORY_MAX_TASKS; i++) {
      rememberOneShotMemory(`t${i}`, mem({ agentId: `a${i}` }), 0);
    }
    expect(peekOneShotMemory("t0", NOW)).toBeNull();
    expect(peekOneShotMemory("t1", NOW)).not.toBeNull();
    expect(peekOneShotMemory(`t${ONESHOT_MEMORY_MAX_TASKS}`, NOW)).not.toBeNull();
  });
});

describe("丢弃 vs 失效（epoch）", () => {
  it("discard：只清记忆，不推进 epoch——之后这一轮照样能写新的", () => {
    rememberOneShotMemory("t1", mem(), 0);
    const epoch = getOneShotMemoryEpoch("t1");
    discardOneShotMemory("t1");
    expect(peekOneShotMemory("t1", NOW)).toBeNull();
    expect(getOneShotMemoryEpoch("t1")).toBe(epoch);
    expect(rememberOneShotMemory("t1", mem({ agentId: "fresh" }), epoch)).toBe(true);
    expect(peekOneShotMemory("t1", NOW)?.agentId).toBe("fresh");
  });

  it("invalidate：清记忆并推进 epoch；入场时抓的旧 epoch 写不回去（堵「旧 one-shot 晚收尾把过期记忆写回」）", () => {
    const entryEpoch = getOneShotMemoryEpoch("t1");
    rememberOneShotMemory("t1", mem(), entryEpoch);
    invalidateOneShotMemory("t1");
    expect(peekOneShotMemory("t1", NOW)).toBeNull();
    expect(getOneShotMemoryEpoch("t1")).toBe(entryEpoch + 1);
    // 在飞的旧 one-shot 用入场时的 epoch 来写：拒绝
    expect(rememberOneShotMemory("t1", mem({ agentId: "stale" }), entryEpoch)).toBe(false);
    expect(peekOneShotMemory("t1", NOW)).toBeNull();
    // 失效之后新入场的 one-shot（抓到新 epoch）能正常写
    expect(rememberOneShotMemory("t1", mem({ agentId: "new" }), getOneShotMemoryEpoch("t1"))).toBe(true);
  });

  it("别的任务互不影响", () => {
    rememberOneShotMemory("t1", mem({ agentId: "a" }), 0);
    rememberOneShotMemory("t2", mem({ agentId: "b" }), 0);
    invalidateOneShotMemory("t1");
    expect(peekOneShotMemory("t1", NOW)).toBeNull();
    expect(peekOneShotMemory("t2", NOW)?.agentId).toBe("b");
    expect(getOneShotMemoryEpoch("t2")).toBe(0);
  });
});
