/**
 * chat 排队条的判定逻辑（纯函数、无 React；第三轮 review R6-01 / D7-02 / V14-05）
 *
 * 组件的 effect / 事件在 node 测试环境跑不起来，决策抽到这里写行为级单测，
 * 组件只负责接线（tests/queue-banner.test.ts）。
 */
import { shouldHideLocalPlaceholder } from "./chat-pending-reconcile";
import { isImeComposing, type ImeEventLike } from "./ime";
import { isCursorProvider } from "./types";

/**
 * 排队「从无到有」：上一拍没有、这一拍有。
 * 队内 1→2 不重复弹（不打断用户正在做的编辑），N→0 更不弹。
 */
export const shouldAutoOpenQueue = (prev: number, next: number): boolean =>
  prev <= 0 && next > 0;

/**
 * 一次 ledger 投影要不要触发排队条「自动弹开」。
 *
 * - `live`：订阅到的实时 dispatch（用户刚发了一条排队消息 / SSE 推来的占位）——看「从无到有」；
 * - `restore`：进入 / 切回会话时从模块级 ledger 恢复。这里的 0→N 只是「我刚挂上来、读到了本来就有的排队」，
 *   不是用户此刻的动作，弹开会抢走 composer 的自动聚焦（第二轮 review N1），永不弹。
 *
 * 为什么不能靠挂载时机区分：排队条要常驻挂载（0 条返回 null，R6-01）——条件挂载时「挂上来就是 N」天然规避了
 * restore，却也让「从无到有」永远不可达（prev 初值 = 挂载时条数）。常驻挂载后必须由调用方显式说清来源。
 */
export const queueAutoOpenOnProjection = (args: {
  source: "live" | "restore";
  prev: number;
  next: number;
}): boolean => args.source === "live" && shouldAutoOpenQueue(args.prev, args.next);

/**
 * 订阅到的实时 dispatch 之后的 autoOpenTick（chat-view 的 onLedgerLive 调它）：
 * prev / next = 这次 dispatch 前后「未落盘的本地占位数」；「从无到有」才 +1，组件只认 tick 的变化。
 * 抽成纯函数是为了能在 node 里连真实 ledger 一起测（组件的 effect 跑不起来）。
 */
export const nextQueueAutoOpenTick = (tick: number, prev: number, next: number): number =>
  queueAutoOpenOnProjection({ source: "live", prev, next }) ? tick + 1 : tick;

/**
 * 服务端重建的占位（Q6-01）：刷新 / 新窗口 / 重启后，bootstrap 的 `queue_state` + `operationSnapshot`
 * 在空 ledger 里重建「别处已排上的队」，占位没有 payload 指纹（`payloadFingerprint:""`——服务端快照不带指纹）；
 * 本窗口真实发出的排队消息（`register`）恒有指纹。重建不是用户此刻的动作，不能当「从无到有」弹开面板。
 */
export const isServerRebuiltPlaceholder = (p: { payloadFingerprint?: string }): boolean =>
  !p.payloadFingerprint;

/**
 * 订阅到的实时 dispatch 前后各一份 pending 占位列表 → 新的 autoOpenTick（chat-view 的 onLedgerLive 调它）。
 *
 * - `prev` 数**所有**未落盘占位（含重建的）：队里本来就有排队（哪怕是重建来的）时，用户再发一条不算「从无到有」，不重复弹；
 * - `next` 只数**本窗口实时登记**的占位（排除服务端重建的）：首次从服务端同步 / 回放账本得到的 N>0 不弹——
 *   只有本窗口实时 dispatch 出来的 0→N 才弹（HANDOFF「只在实时 0→N 才弹开」的真实含义）。
 */
export const nextQueueAutoOpenTickForPending = (
  tick: number,
  prevPending: readonly ({ payloadFingerprint?: string } & Parameters<
    typeof shouldHideLocalPlaceholder
  >[0])[],
  nextPending: readonly ({ payloadFingerprint?: string } & Parameters<
    typeof shouldHideLocalPlaceholder
  >[0])[],
): number => {
  const prevCount = prevPending.filter((p) => !shouldHideLocalPlaceholder(p)).length;
  const nextLive = nextPending.filter(
    (p) => !shouldHideLocalPlaceholder(p) && !isServerRebuiltPlaceholder(p),
  ).length;
  return nextQueueAutoOpenTick(tick, prevCount, nextLive);
};

/**
 * 条上显示的排队条数。run 没在跑 = 0（占位只是刚发出的在途，不是排队）；
 * ledger 没有占位（null）= 0。条数为 0 时组件返回 null。
 */
export const effectiveQueueCount = (args: {
  runActive: boolean;
  queuedCount: number | null;
}): number =>
  args.runActive && args.queuedCount != null && args.queuedCount > 0
    ? args.queuedCount
    : 0;

// ───────────── 立即发送：会不会打断 ─────────────

/**
 * 「立即发送」的两种落地方式（服务端 sendQueuedChatMessageNow 同口径）：
 * - steer：插进正在跑的这一轮，AI 当前步骤结束后读到，不中断；
 * - interrupt：先停止正在进行的回复，再用这条消息重新开始（其余排队消息服务端会放回队列）。
 */
export type SendNowMode = "steer" | "interrupt";

/**
 * 按窗口绑定的 provider 预判。服务端 `canSteerChatRun`：有会话、run 在消费、拿得到本轮 run 句柄
 * 且它带 steer——只有 Cursor 本地 run 带；自定义 HTTP provider（pi 自研后端）没有，一律打断重发。
 * 「冷启动占位 / 刚收尾的空窗」这类瞬时情形客户端看不到，预判不了——偏差只会是「说会插话、实际打断」，
 * 窗口极短，且此时排队条本来就在 run 进行中才出现。
 */
export const predictSendNowMode = (providerId: string | undefined): SendNowMode =>
  isCursorProvider(providerId) ? "steer" : "interrupt";

export interface SendNowCopy {
  /** 按钮 hover 提示 */
  tooltip: string;
  /** 需要确认时的对话框文案；null = 直接发 */
  confirm: { title: string; description: string; confirmLabel: string } | null;
}

export const sendNowCopy = (mode: SendNowMode): SendNowCopy =>
  mode === "steer"
    ? {
        tooltip: "立即发送（插话给正在工作的 AI，不中断它）",
        confirm: null,
      }
    : {
        tooltip: "立即发送（会先停止 AI 正在进行的回复，再用这条重新开始）",
        confirm: {
          title: "立即发送这条？",
          description:
            "当前模型不支持中途插话：会先停止 AI 正在进行的这一轮回复，再用这条消息重新开始。其余排队消息会保留、之后依次发送。",
          confirmLabel: "停止并发送",
        },
      };

// ───────────── 行内编辑的快捷键 ─────────────

/** 键盘事件的最小形状（React 合成事件 / 原生事件 / 测试最小对象都能直接传；IME 口径同 lib/ime） */
export interface QueueEditKeyInput extends ImeEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}

export interface QueueEditKeyAction {
  type: "save" | "cancel";
  preventDefault: boolean;
  /** 拦住冒泡：Esc 只退出编辑，不能再冒到弹层的 Esc 关闭（先退出编辑、再按一次才关弹层，V14-05） */
  stopPropagation: boolean;
}

export const queueEditKeyAction = (e: QueueEditKeyInput): QueueEditKeyAction | null => {
  // 输入法组合输入中的 Enter / Esc（选词 / 取消候选）归输入法，不归编辑框
  if (isImeComposing(e)) return null;
  if (e.key === "Escape") {
    return { type: "cancel", preventDefault: true, stopPropagation: true };
  }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    return { type: "save", preventDefault: true, stopPropagation: false };
  }
  return null;
};
