import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveWatchReconnectPolicy } from "../src/lib/task-terminal";
import {
  applyReconnectDecision,
  createDormantWaiter,
  freshWatchBudget,
  reconcileRunActive,
  stepDormantNotice,
  watchDormantToastId,
  withBootstrapNotice,
  type ApplyDecisionCtx,
  type DormantEnv,
} from "../src/lib/watch-reconnect";

/** 可数监听器的假事件源（用 Node 自带 EventTarget，dispatchEvent 走真实回调路径） */
const makeTarget = () => {
  const t = new EventTarget();
  let count = 0;
  return {
    target: t,
    listeners: () => count,
    api: {
      addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
        count++;
        t.addEventListener(type, fn);
      },
      removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
        count--;
        t.removeEventListener(type, fn);
      },
    },
  };
};

const setup = () => {
  const win = makeTarget();
  const doc = makeTarget();
  const envState = { hidden: false, online: true };
  const env: DormantEnv = {
    win: win.api,
    doc: doc.api,
    read: () => ({ ...envState }),
    tickMs: 60_000,
  };
  const waiter = createDormantWaiter(env);
  const budget = freshWatchBudget();
  const notify = vi.fn<(err: Error, resume?: () => void) => void>();
  const onDormant = vi.fn();
  let cancelled = false;
  const ctx = (): ApplyDecisionCtx => ({
    budget,
    error: new Error("boom"),
    isCancelled: () => cancelled,
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    waiter,
    notify,
    onDormant,
  });
  /** 一次建连失败：走真实 policy → 真实 applyReconnectDecision */
  const failOnce = () => {
    const decision = resolveWatchReconnectPolicy({ kind: "retryable", ...budget });
    if (decision.action === "terminate_deleted") throw new Error("unexpected");
    return applyReconnectDecision(decision, ctx());
  };
  return { win, doc, envState, waiter, budget, notify, onDormant, failOnce, cancel: () => (cancelled = true) };
};

/** 把前 5 次失败（各有退避）跑完，返回第 6 次（耗尽）仍悬挂的 promise */
const driveToDormant = async (m: ReturnType<typeof setup>) => {
  for (let i = 0; i < 5; i++) {
    const p = m.failOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await p).toBe("continue");
  }
  const dormant = m.failOnce();
  await vi.advanceTimersByTimeAsync(0);
  // 包一层：async 函数直接 return promise 会把它等完
  return { dormant };
};

describe("休眠重连状态机（fake timers 驱动真实 applyReconnectDecision）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("预算耗尽 → 提示一次（带 resume）→ 休眠悬挂；online 唤醒 → 预算清零 → 下一次失败重新从 1.5s 退避开始", async () => {
    const m = setup();
    const { dormant } = await driveToDormant(m);

    // 已进入休眠：通知恰好一次且带 resume 句柄；预算已满（transientFailures=5 未被清）
    expect(m.onDormant).toHaveBeenCalledTimes(1);
    expect(m.notify).toHaveBeenCalledTimes(1);
    expect(typeof m.notify.mock.calls[0][1]).toBe("function");
    expect(m.budget.transientFailures).toBe(5);
    let settled = false;
    void dormant.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false); // 没有任何唤醒信号：不会自己重连（也不会静默退出）

    // 网络恢复
    m.win.target.dispatchEvent(new Event("online"));
    expect(await dormant).toBe("continue");
    expect(m.budget).toEqual(freshWatchBudget());
    // 监听器 / 定时器全部拆干净
    expect(m.win.listeners()).toBe(0);
    expect(m.doc.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // 预算确实清零：下一次失败是 retry(1500ms)，而不是立刻再次耗尽
    const decision = resolveWatchReconnectPolicy({ kind: "retryable", ...m.budget });
    expect(decision).toMatchObject({ action: "retry", delayMs: 1500 });
  });

  it("页面隐藏时 online / tick 不唤醒，回到可见才唤醒", async () => {
    const m = setup();
    const { dormant } = await driveToDormant(m);
    let settled = false;
    void dormant.then(() => (settled = true));

    m.envState.hidden = true;
    m.win.target.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(120_000); // 两个兜底 tick
    expect(settled).toBe(false);

    m.envState.hidden = false;
    m.doc.target.dispatchEvent(new Event("visibilitychange"));
    expect(await dormant).toBe("continue");
  });

  it("低频兜底 tick：可见且在线才放行", async () => {
    const m = setup();
    const { dormant } = await driveToDormant(m);
    m.envState.online = false;
    await vi.advanceTimersByTimeAsync(60_000);
    m.envState.online = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await dormant).toBe("continue");
  });

  it("点「重连」(notify 给的 resume) 无条件唤醒，即使离线 / 隐藏", async () => {
    const m = setup();
    m.envState.hidden = true;
    m.envState.online = false;
    const { dormant } = await driveToDormant(m);
    m.notify.mock.calls[0][1]?.();
    expect(await dormant).toBe("continue");
    expect(m.budget).toEqual(freshWatchBudget());
  });

  it("休眠中卸载（resume(false)）→ stop，且不留监听器 / 定时器", async () => {
    const m = setup();
    const { dormant } = await driveToDormant(m);
    m.cancel();
    m.waiter.resume(false);
    expect(await dormant).toBe("stop");
    expect(m.win.listeners()).toBe(0);
    expect(m.doc.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("已取消再遇到耗尽：直接 stop，不挂监听（没人会来收）", async () => {
    const m = setup();
    for (let i = 0; i < 5; i++) {
      const p = m.failOnce();
      await vi.advanceTimersByTimeAsync(20_000);
      await p;
    }
    m.cancel();
    expect(await m.failOnce()).toBe("stop");
    expect(m.win.listeners()).toBe(0);
    expect(m.notify).not.toHaveBeenCalled();
  });
});

describe("休眠提示 toast 生命周期（R6-04）", () => {
  it("稳定 id：同任务同范围恒定，不同任务 / 范围互不串", () => {
    expect(watchDormantToastId("chat", "t1")).toBe(watchDormantToastId("chat", "t1"));
    expect(watchDormantToastId("chat", "t1")).not.toBe(watchDormantToastId("chat", "t2"));
    expect(watchDormantToastId("chat", "t1")).not.toBe(watchDormantToastId("task", "t1"));
  });

  it("休眠 → 连接建立 / 卸载 都要撤；没休眠过不撤；重复休眠不累积", () => {
    expect(stepDormantNotice(false, "connected")).toEqual({ dormant: false, dismiss: false });
    expect(stepDormantNotice(false, "teardown")).toEqual({ dormant: false, dismiss: false });

    const entered = stepDormantNotice(false, "enter");
    expect(entered).toEqual({ dormant: true, dismiss: false });
    expect(stepDormantNotice(entered.dormant, "connected")).toEqual({ dormant: false, dismiss: true });
    expect(stepDormantNotice(entered.dormant, "teardown")).toEqual({ dormant: false, dismiss: true });

    // 休眠 → 唤醒成功撤掉 → 再休眠：只在第二轮再次进入、撤一次
    let s = stepDormantNotice(false, "enter");
    s = stepDormantNotice(s.dormant, "enter"); // 同一轮重复 enter 不改变
    expect(s).toEqual({ dormant: true, dismiss: false });
    const done = stepDormantNotice(s.dormant, "connected");
    expect(done.dismiss).toBe(true);
    expect(stepDormantNotice(done.dormant, "connected").dismiss).toBe(false);
  });
});

describe("重连后校准 runActive（R6-01）", () => {
  it("断线期间漏了 done：重连 bootstrap 快照说不是 running → 释放 latch", () => {
    // 之前 latch 锁着；done 在断线窗口里丢了
    let active = true;
    for (const status of ["idle", "error", "awaiting_user"] as const) {
      expect(reconcileRunActive(active, status)).toBe(false);
    }
    // 服务端确实还在跑 → 保持 / 置位
    expect(reconcileRunActive(true, "running")).toBe(true);
    expect(reconcileRunActive(false, "running")).toBe(true);
    // 无信息 → 不动
    expect(reconcileRunActive(true, undefined)).toBe(true);
    active = reconcileRunActive(active, "idle");
    expect(active).toBe(false);
  });

  it("withBootstrapNotice：每个连接只对第一帧（bootstrap）校准，运行中途的 task 帧不触发", () => {
    const calls: string[] = [];
    const frame1 = withBootstrapNotice<{ s: string }>(
      (t) => calls.push(`forward:${t.s}`),
      (t) => calls.push(`bootstrap:${t.s}`),
    );
    frame1({ s: "idle" });
    frame1({ s: "awaiting_user" }); // 同连接的后续 task 帧
    expect(calls).toEqual(["forward:idle", "bootstrap:idle", "forward:awaiting_user"]);

    // 新连接（重连 / 休眠唤醒）= 新包装，再次校准
    const frame2 = withBootstrapNotice<{ s: string }>(
      (t) => calls.push(`forward:${t.s}`),
      (t) => calls.push(`bootstrap:${t.s}`),
    );
    frame2({ s: "idle" });
    expect(calls.slice(-2)).toEqual(["forward:idle", "bootstrap:idle"]);
  });

  it("端到端：release 后再收到 running 帧会重新上锁（latch effect 语义不被破坏）", () => {
    let active = true;
    active = reconcileRunActive(active, "idle");
    expect(active).toBe(false);
    active = reconcileRunActive(active, "running");
    expect(active).toBe(true);
  });
});
