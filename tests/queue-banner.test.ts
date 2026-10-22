/**
 * chat 排队条：常驻挂载下的「自动弹开」、立即发送的打断预判、行内编辑的 Esc（第三轮 review R6-01 / D7-02 / V14-05）
 *
 * - R6-01：第二轮 N1 把 chat 排队条改成「0 条不渲染（条件挂载）」，而「自动弹开」靠的是 effect 里比较
 *   上一拍 / 这一拍的条数——条件挂载下它每次都是「挂上来就是 N」，prev 初值 = N，永远不会 0→N，自动弹开死码。
 *   修法：常驻挂载（0 条返回 null）。但进入一个本来就有排队的会话（ledger 是模块级、切走再回来还在）
 *   必须仍不弹（N1），所以「从无到有」由 chat-view 在**订阅到的实时 dispatch** 里判定，恢复（restore）永不弹。
 * - D7-02：「立即发送」在不支持插话的后端（自定义 HTTP provider）会先停止正在进行的回复再重发，
 *   tooltip 却说「不中断它」。按服务端同口径（只有 Cursor 本地 run 能 steer）预判，会打断时如实说明并加确认。
 * - V14-05：行内编辑里按 Esc 同时退出编辑并关掉整个弹层，没存的修改被一并丢掉；
 *   改为先退出编辑、再按一次才关弹层。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetChatOpLedgerForTests,
  dispatchChatOp,
  getChatOpLedger,
  subscribeChatOp,
} from "@/lib/chat-op-ledger";
import { shouldHideLocalPlaceholder, type ChatOpState } from "@/lib/chat-pending-reconcile";
import {
  effectiveQueueCount,
  isServerRebuiltPlaceholder,
  nextQueueAutoOpenTick,
  nextQueueAutoOpenTickForPending,
  predictSendNowMode,
  queueAutoOpenOnProjection,
  queueEditKeyAction,
  sendNowCopy,
  shouldAutoOpenQueue,
} from "@/lib/queue-banner";

const source = (rel: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

describe("shouldAutoOpenQueue：只在「从无到有」那一下", () => {
  it.each([
    [0, 1, true],
    [0, 3, true],
    [-1, 2, true], // 防御：负数当 0
    [1, 2, false],
    [2, 1, false],
    [1, 0, false],
    [0, 0, false],
  ])("prev=%i next=%i → %s", (prev, next, want) => {
    expect(shouldAutoOpenQueue(prev, next)).toBe(want);
  });
});

describe("queueAutoOpenOnProjection：恢复永不弹、实时 0→N 才弹（N1 + R6-01）", () => {
  it("实时 dispatch 0→N：弹（常驻挂载后这条才可达）", () => {
    expect(queueAutoOpenOnProjection({ source: "live", prev: 0, next: 1 })).toBe(true);
  });

  it("恢复（进入 / 切回一个本来就有排队的会话，ledger 是模块级的）：即使 0→N 也不弹", () => {
    // 修前（条件挂载 + prevCountRef=useRef(挂载时条数)）靠挂载时机规避；常驻挂载后必须由调用方显式区分
    expect(queueAutoOpenOnProjection({ source: "restore", prev: 0, next: 2 })).toBe(false);
  });

  it("实时但不是从无到有：不弹、不打断编辑", () => {
    expect(queueAutoOpenOnProjection({ source: "live", prev: 1, next: 2 })).toBe(false);
    expect(queueAutoOpenOnProjection({ source: "live", prev: 2, next: 0 })).toBe(false);
    expect(queueAutoOpenOnProjection({ source: "live", prev: 0, next: 0 })).toBe(false);
  });
});

describe("effectiveQueueCount：条上显示的条数（run 没在跑 = 不显示）", () => {
  it("run 进行中：取 ledger 的未落盘占位数", () => {
    expect(effectiveQueueCount({ runActive: true, queuedCount: 3 })).toBe(3);
  });
  it("run 没在跑 / 没有排队 / 未知：0（组件据此返回 null）", () => {
    expect(effectiveQueueCount({ runActive: false, queuedCount: 3 })).toBe(0);
    expect(effectiveQueueCount({ runActive: true, queuedCount: null })).toBe(0);
    expect(effectiveQueueCount({ runActive: true, queuedCount: 0 })).toBe(0);
  });
});

describe("queueEditKeyAction：行内编辑的快捷键（V14-05）", () => {
  const key = (k: string, extra: Partial<Parameters<typeof queueEditKeyAction>[0]> = {}) =>
    queueEditKeyAction({ key: k, metaKey: false, ctrlKey: false, ...extra });

  it("Esc：只退出编辑，并拦住冒泡（不然弹层的 Esc 关闭会一起触发、没存的改动全丢）", () => {
    expect(key("Escape")).toEqual({ type: "cancel", stopPropagation: true, preventDefault: true });
  });

  it("输入法组合中的 Esc 是「取消候选」，不归编辑框（isComposing / keyCode 229 / React nativeEvent 三种形状）", () => {
    expect(key("Escape", { isComposing: true })).toBeNull();
    expect(key("Escape", { keyCode: 229 })).toBeNull();
    expect(key("Escape", { nativeEvent: { isComposing: true } })).toBeNull();
  });

  it("Cmd / Ctrl + Enter：保存", () => {
    expect(key("Enter", { metaKey: true })).toEqual({
      type: "save",
      stopPropagation: false,
      preventDefault: true,
    });
    expect(key("Enter", { ctrlKey: true })?.type).toBe("save");
  });

  it("输入法组合中的 Cmd+Enter 不保存；单独 Enter 是换行（不处理）", () => {
    expect(key("Enter", { metaKey: true, isComposing: true })).toBeNull();
    expect(key("Enter")).toBeNull();
  });

  it("其它键不处理", () => {
    expect(key("a")).toBeNull();
    expect(key("Tab")).toBeNull();
  });
});

describe("predictSendNowMode / sendNowCopy：「立即发送」会不会打断（D7-02）", () => {
  it("Cursor 本地 run（含老任务缺省 provider）能插话；自定义 provider 只能打断重发", () => {
    expect(predictSendNowMode("cursor")).toBe("steer");
    expect(predictSendNowMode(undefined)).toBe("steer");
    expect(predictSendNowMode("")).toBe("steer");
    expect(predictSendNowMode("cp_abc123")).toBe("interrupt");
    expect(predictSendNowMode("cp_legacy")).toBe("interrupt");
  });

  it("插话：tooltip 说不中断，不需要确认", () => {
    const c = sendNowCopy("steer");
    expect(c.tooltip).toContain("不中断");
    expect(c.confirm).toBeNull();
  });

  it("打断：tooltip 如实说会停止当前回复，并带确认；确认文案说清「其余排队保留」", () => {
    const c = sendNowCopy("interrupt");
    expect(c.tooltip).toContain("停止");
    expect(c.tooltip).not.toContain("不中断");
    expect(c.confirm).not.toBeNull();
    expect(c.confirm!.description).toContain("停止");
    expect(c.confirm!.description).toContain("其余排队");
    expect(c.confirm!.confirmLabel).toBeTruthy();
  });

  it("文案是业务口径：不泄露协议词 / 内部名词", () => {
    for (const mode of ["steer", "interrupt"] as const) {
      const c = sendNowCopy(mode);
      const all = [c.tooltip, c.confirm?.title, c.confirm?.description, c.confirm?.confirmLabel].join("|");
      expect(all).not.toMatch(/steer|provider|pi\b|SDK|send_now|drain|requeue/i);
    }
  });
});

describe("真实 ledger + chat-view 同款订阅逻辑：自动弹开 tick 只在「从无到有」的实时 dispatch 上递增（R6-01）", () => {
  const TASK = "t_queue_banner_ledger";
  const reg = (id: string) =>
    dispatchChatOp(TASK, {
      type: "register",
      op: {
        id,
        itemId: id,
        payloadFingerprint: `fp_${id}`,
        persistence: "sending",
        terminalKnowledge: "none",
        networkUncertain: false,
        text: `消息 ${id}`,
        displayText: `消息 ${id}`,
      },
    });
  const countActive = (s: ChatOpState) =>
    s.pending.filter((p) => !shouldHideLocalPlaceholder(p)).length;

  /**
   * 同 chat-view.onLedgerLive：挂载时 prev 取 ledger 现状（恢复，不弹）；
   * 之后每次订阅到的 dispatch 用真实的 nextQueueAutoOpenTickForPending 判从无到有（Q6-01：重建占位不算）
   */
  const mountLikeChatView = () => {
    let tick = 0;
    let prevPending = getChatOpLedger(TASK).pending;
    const unsub = subscribeChatOp(TASK, (state) => {
      tick = nextQueueAutoOpenTickForPending(tick, prevPending, state.pending);
      prevPending = state.pending;
    });
    return { tick: () => tick, unsub };
  };
  /** 刷新 / 新窗口 / 重启后 bootstrap 的 queue_state + operationSnapshot：在空 ledger 里重建别处已排上的队 */
  const bootstrapQueue = (ids: string[]) =>
    dispatchChatOp(TASK, {
      type: "queue_state",
      serverItemIds: ids,
      recentSettled: [],
      operationSnapshot: ids.map((itemId) => ({ itemId, phase: "accepting" })),
    });

  beforeEach(() => __resetChatOpLedgerForTests());

  it("运行中第一条排队（0→1）弹；再排一条（1→2）不重复弹；清空后下一轮（0→1）再弹", () => {
    const h = mountLikeChatView();
    reg("cq_a");
    expect(h.tick()).toBe(1);
    reg("cq_b");
    expect(h.tick()).toBe(1);
    dispatchChatOp(TASK, { type: "queue_failed", itemIds: ["cq_a", "cq_b"] });
    expect(countActive(getChatOpLedger(TASK))).toBe(0);
    expect(h.tick()).toBe(1);
    reg("cq_c");
    expect(h.tick()).toBe(2);
    h.unsub();
  });

  it("恢复：进入 / 切回一个 ledger 里本来就有排队的会话，挂载那一刻不弹；队内再加不弹，清空后下一轮才弹（N1）", () => {
    reg("cq_old"); // 切走前就在 ledger 里（模块级，切回仍在）
    const h = mountLikeChatView();
    expect(h.tick()).toBe(0);
    reg("cq_new");
    expect(h.tick()).toBe(0);
    dispatchChatOp(TASK, { type: "queue_failed", itemIds: ["cq_old", "cq_new"] });
    reg("cq_next");
    expect(h.tick()).toBe(1);
    h.unsub();
  });

  // ───────── Q6-01：刷新 / 新窗口 / 重启后 bootstrap 重建的占位不算「实时 0→N」 ─────────
  it("【Q6-01】刷新进入「运行中且已有 2 条排队」的 chat：bootstrap 重建 2 条占位 → 不弹（旧实现 tick=1）", () => {
    const h = mountLikeChatView(); // 刷新后 ledger 为空
    bootstrapQueue(["cq_a", "cq_b"]);
    const rebuilt = getChatOpLedger(TASK).pending;
    // 前提：确实重建出了 2 条、且都没有指纹（这正是判别口径）
    expect(countActive(getChatOpLedger(TASK))).toBe(2);
    expect(rebuilt.every(isServerRebuiltPlaceholder)).toBe(true);
    expect(h.tick()).toBe(0);
    h.unsub();
  });

  it("【Q6-01】bootstrap 重建 N 条后，本窗口再实时发一条：队里本来就有排队，不算「从无到有」，仍不弹", () => {
    const h = mountLikeChatView();
    bootstrapQueue(["cq_a", "cq_b"]);
    reg("cq_new");
    expect(h.tick()).toBe(0);
    h.unsub();
  });

  it("【Q6-01】重建的队清空（queue_failed）后，下一次本窗口实时排队（0→1）照常弹", () => {
    const h = mountLikeChatView();
    bootstrapQueue(["cq_a", "cq_b"]);
    dispatchChatOp(TASK, { type: "queue_failed", itemIds: ["cq_a", "cq_b"] });
    expect(countActive(getChatOpLedger(TASK))).toBe(0);
    expect(h.tick()).toBe(0);
    reg("cq_next");
    expect(h.tick()).toBe(1);
    h.unsub();
  });

  it("【Q6-01 旧行为仍成立】空 ledger 下本窗口实时 register（0→1）照常弹；重复 bootstrap 对账（已知占位）不弹", () => {
    const h = mountLikeChatView();
    reg("cq_live");
    expect(h.tick()).toBe(1);
    bootstrapQueue(["cq_live"]); // SSE 重连后的对账：占位已存在，不是新的
    expect(h.tick()).toBe(1);
    h.unsub();
  });

  it("【Q6-01】纯函数：prev 数全部未落盘占位（含重建的），next 只数有指纹的实时占位", () => {
    const live = { payloadFingerprint: "fp", persistence: "sending" as const };
    const rebuilt = { payloadFingerprint: "", persistence: "sending" as const };
    const persisted = { payloadFingerprint: "fp", persistence: "persisted" as const };
    expect(nextQueueAutoOpenTickForPending(0, [], [live])).toBe(1);
    expect(nextQueueAutoOpenTickForPending(0, [], [rebuilt, rebuilt])).toBe(0);
    expect(nextQueueAutoOpenTickForPending(0, [rebuilt], [rebuilt, live])).toBe(0);
    expect(nextQueueAutoOpenTickForPending(3, [persisted], [persisted, live])).toBe(4); // persisted 有正式气泡，不计 prev
    expect(nextQueueAutoOpenTickForPending(0, [live], [live, live])).toBe(0);
  });

  it("纯函数：只有 prev<=0 且 next>0 才 +1", () => {
    expect(nextQueueAutoOpenTick(5, 0, 1)).toBe(6);
    expect(nextQueueAutoOpenTick(5, 1, 2)).toBe(5);
    expect(nextQueueAutoOpenTick(5, 2, 0)).toBe(5);
    expect(nextQueueAutoOpenTick(5, 0, 0)).toBe(5);
  });
});

describe("接线契约（补充；行为已由上面的纯函数测试锁住）", () => {
  const banner = source("src/components/tasks/chat-queue-banner.tsx");
  const chatView = source("src/components/tasks/chat-view.tsx");

  it("chat-view 常驻挂载排队条，不再用「条数 > 0」条件挂载（那会让自动弹开死码）", () => {
    expect(chatView).toMatch(/<ChatQueueBanner\b/);
    expect(chatView).not.toMatch(/queuedCount != null && queuedCount > 0\s*\?/);
  });

  it("chat-view 只在订阅到的实时 dispatch 里判「从无到有」，恢复路径不弹", () => {
    expect(chatView).toMatch(/nextQueueAutoOpenTickForPending\(t, prevPending, nextPending\)/);
    expect(chatView).toMatch(/subscribeChatOp\(task\.id, onLedgerLive\)/);
  });

  it("排队条 0 条返回 null 在所有 hook 之后（常驻挂载下 hook 顺序不能变）", () => {
    const firstReturnNull = banner.indexOf("return null");
    expect(firstReturnNull).toBeGreaterThan(-1);
    // 最后一个 hook 调用必须在它之前
    const lastHook = Math.max(
      banner.lastIndexOf("useState("),
      banner.lastIndexOf("useRef("),
      banner.lastIndexOf("useEffect("),
    );
    expect(lastHook).toBeLessThan(firstReturnNull);
  });

  it("立即发送按预判分流：会打断时先 confirm", () => {
    expect(banner).toMatch(/predictSendNowMode\(/);
    expect(banner).toMatch(/await confirm\(/);
  });

  it("行内编辑的按键走 queueEditKeyAction，并按它的结果 stopPropagation", () => {
    expect(banner).toMatch(/queueEditKeyAction\(/);
    expect(banner).toMatch(/e\.stopPropagation\(\)/);
  });

  it("过时注释已修：立即发送不是「stop 清剩余队」（服务端会把其余排队放回去）", () => {
    expect(banner).not.toContain("stop 清剩余队");
    expect(banner).not.toMatch(/每次都自动弹开/);
  });
});
