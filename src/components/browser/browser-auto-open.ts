/**
 * 浏览器面板「自动展开」的判定（纯函数，可在 node 里测）
 *
 * 规则（契约 §11 + 任务要求）：
 *  - 某任务的 controller 变成 `ai`、或出现新的 askRequest 时，若面板是收起的，就自动展开；
 *  - 用户手动收起之后，AI 的后续动作不再反复弹开——记「用户已手动收起」（dismissed）；它**不随 controller 回到 idle 复位**
 *    （主进程在最后一个动作后要过 8 秒才回 idle，AI 两步之间想得久一点就会回 idle，复位的话下一个动作又把面板弹开——R1-17），
 *    只在用户**手动再展开**面板（panelOpen 变 true）时复位（见 noteUserOpenedPanel）；
 *  - askRequest 是 AI 在等你做事，优先级高于「别打扰」：同一个 ask（按 since 区分）只弹一次，
 *    但即使用户早些时候关过面板，新出现的 ask 仍会弹开；
 *  - 挂载时 getState 补的初值（source=seed）只当基线：AI 早就在操作了不算「刚开始」，不弹；
 *    但此刻正挂着一个没处理过的 ask 要弹（用户切到这个任务就该看到它在等什么）。
 *
 * 系统通知**不在这里**：ask 的通知只由全局的 BrowserAskWatcher 发（带节流 / 截断 / 去重）。
 * 以前这里的 decideAutoOpen 也会返回一个 notify、由 hook 直接 sendTaskNotification，
 * 窗口在后台停在该任务页时和 Watcher 各发一条，用户收到两条通知（R1-16）。
 */

import type { BrowserController } from "@/lib/browser-bridge-types";
import type { BrowserSignals, BrowserStateSource } from "./browser-state-store";

export interface AutoOpenMemory {
  /** 上一次见到的 controller（判「刚变成 ai」） */
  controller: BrowserController;
  /** 已处理过的 askRequest.since（同一个 ask 不重复弹） */
  handledAskSince: number | null;
  /** 用户手动收起过面板：不随 idle 复位，直到用户手动再展开 */
  dismissed: boolean;
}

export const initialAutoOpenMemory = (): AutoOpenMemory => ({
  controller: "idle",
  handledAskSince: null,
  dismissed: false,
});

/** 「一轮 AI 操作」是否还在进行：controller 不是 idle，或有 ask 挂着 */
export const isRoundActive = (s: Pick<BrowserSignals, "controller" | "askSince">): boolean =>
  s.controller !== "idle" || s.askSince !== null;

export interface AutoOpenDecision {
  memory: AutoOpenMemory;
  /** 需要把面板展开（并切到浏览器标签） */
  open: boolean;
}

export const decideAutoOpen = (
  memory: AutoOpenMemory,
  next: BrowserSignals,
  ctx: { panelOpen: boolean; source: BrowserStateSource },
): AutoOpenDecision => {
  const newAsk = next.askSince !== null && next.askSince !== memory.handledAskSince;
  const becameAi =
    ctx.source === "push" && next.controller === "ai" && memory.controller !== "ai";

  const open = !ctx.panelOpen && ((becameAi && !memory.dismissed) || newAsk);

  return {
    memory: {
      controller: next.controller,
      handledAskSince: newAsk ? next.askSince : memory.handledAskSince,
      // 不复位：dismissed 只由 noteUserOpenedPanel（用户手动再展开）清掉
      dismissed: memory.dismissed,
    },
    open,
  };
};

/**
 * 面板从「展开」变成「收起」（用户手动关）时调用：若这一轮 AI 操作还在进行，记下「用户已收起」。
 * 轮次已结束（idle 且没有 ask）时关面板是正常行为，不用记——下一轮 AI 开始操作时照常自动弹。
 */
export const noteUserClosedPanel = (
  memory: AutoOpenMemory,
  current: Pick<BrowserSignals, "controller" | "askSince">,
): AutoOpenMemory =>
  isRoundActive(current) && !memory.dismissed ? { ...memory, dismissed: true } : memory;

/**
 * 面板处于展开态（用户手动再展开、或被 ask 弹开）时调用：清掉「用户已收起」。
 * 之后用户若再收起（且 AI 还在忙）会重新记；记忆没变时返回原对象（引用不变，调用方可据此省一次写）。
 */
export const noteUserOpenedPanel = (memory: AutoOpenMemory): AutoOpenMemory =>
  memory.dismissed ? { ...memory, dismissed: false } : memory;

// ───────────────────────── 「收起」是谁干的（R2-14 ③） ─────────────────────────

/**
 * 面板 open 从 true 变 false，不一定是用户收起的：
 *  - task 页切到「浏览器」标签时 minSize 换成像素下限，react-resizable-panels 会重新校验当前宽度——
 *    栏宽小于新下限的一半就**直接折叠**（其余夹到下限）；窗口缩小到放不下时库也会自动折叠；
 *  - chat 页同理（窗口缩小 → 浏览器栏低于下限自动折叠）。
 * 以前 hook 把任何 true→false 都当「用户手动收起」，记下 dismissed，于是库自动折叠之后 AI 的后续动作再也弹不开面板（R1-17 的记忆被污染）。
 * 现在只有「用户意图」造成的收起才记：点头部按钮 / 点「产物」标签 / 拖分隔条（或键盘调整）。
 *
 * 意图用「最近一次用户收起操作的时间」表达（时间注入，纯逻辑可测）：入口在点击处理器里先 mark、再改状态，
 * hook 在随后那次提交的 effect 里看到 true→false 时问「刚才有没有用户收起操作」。窗口很短，
 * 过期的 mark 不会把之后的库自动折叠误判成用户意图。
 */
export const USER_CLOSE_INTENT_MS = 1000;

export interface UserCloseIntent {
  mark: (now: number) => void;
  isRecent: (now: number) => boolean;
}

export const createUserCloseIntent = (windowMs: number = USER_CLOSE_INTENT_MS): UserCloseIntent => {
  let markedAt = Number.NEGATIVE_INFINITY;
  return {
    mark: (now) => {
      markedAt = now;
    },
    // now < markedAt（时钟回拨）不算：宁可漏记一次「已收起」，也不把过期意图当有效
    isRecent: (now) => now >= markedAt && now - markedAt <= windowMs,
  };
};

export interface PanelObservation {
  taskId: string | null | undefined;
  open: boolean;
}

/**
 * 面板这次提交相对上一次的变化：
 *  - opened：当前是展开态（用户手动展开 / 被 ask 弹开）→ 清掉「已收起」；
 *  - user-closed：同一任务内 展开→收起、且是用户意图 → 记「已收起」；
 *  - auto-closed：同一任务内 展开→收起、但不是用户意图（库自动折叠 / 夹取）→ 什么都不记；
 *  - none：其余（本来就是收起、切任务导致的重置…）。
 * `isUserClose` 用函数而不是布尔：只有真的出现展开→收起才去问，别的提交不付这个代价。
 */
export type PanelTransition = "opened" | "user-closed" | "auto-closed" | "none";

export const classifyPanelTransition = (
  prev: PanelObservation,
  next: PanelObservation,
  isUserClose: () => boolean,
): PanelTransition => {
  if (next.open) return "opened";
  if (prev.taskId !== next.taskId || !prev.open) return "none";
  return isUserClose() ? "user-closed" : "auto-closed";
};
