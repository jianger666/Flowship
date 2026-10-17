/**
 * 流式回复 → 定稿事件的「同一个 React 节点」交接（2026-10-17「吐字完成后整段抖一下」）
 *
 * 根因：流式阶段画的是虚拟项（kind `__streaming__`、一个独立的占位组件），定稿的
 * assistant_message 事件一到，同一次提交里虚拟项被删、真事件项冒出来——Virtuoso 的 key 不同、
 * 组件类型也不同，整段正文被**卸载再重挂载**：Markdown 重新解析、Streamdown 的块全部重建、
 * 代码块 / 公式 / mermaid 在 static 插件下重画、任务栏的头部高度还不一样。表现就是文字刚吐完、
 * 整段闪一下 / 跳几个像素。
 *
 * 修法：让定稿事件**接管流式项的 Virtuoso key**。Virtuoso 按 key 复用 item 外壳、React 在外壳里
 * 看到同一个 `EventRow` 就地更新 props（`streaming` true → false、`ev` 换成真事件），
 * Streamdown 在原地从 streaming 模式切 static，已渲染的块一个都不重建。
 *
 * 这里只放「什么时候该接管」的纯判定（不碰 DOM / React），由 event-stream.tsx 用
 * 「渲染期 setState（由输入推导 state）」驱动：同输入多算几次结果不变，StrictMode 双渲染安全。
 */

/** 流式项 id 的固定前缀（event-stream-search 等按 kind 认流式项、不靠 id 前缀） */
export const STREAM_ITEM_ID_PREFIX = "__streaming__";

/** 第 seq 段流式回复的项 id / Virtuoso key：每段唯一，下一段不会跟上一段已被接管的 key 撞车 */
export const streamItemId = (seq: number): string =>
  `${STREAM_ITEM_ID_PREFIX}:${seq}`;

export interface StreamHandoffState {
  /** 上一次判定时是否正在流式 */
  active: boolean;
  /** 已开始过的流式段数（只增不减） */
  seq: number;
  /** 本段流式开始时，流里最后一条 assistant_message 的 id（用来识别「新冒出来的定稿」） */
  baselineAssistantId: string | null;
  /** 被接管的定稿事件 id → 它接管的流式项 key */
  aliases: Readonly<Record<string, string>>;
}

export const INITIAL_STREAM_HANDOFF: StreamHandoffState = {
  active: false,
  seq: 0,
  baselineAssistantId: null,
  aliases: {},
};

/**
 * 推进交接状态：
 *  - 流式开始（false → true）：段号 +1、记下此刻最后一条 assistant_message 作基线；
 *  - 流式结束（true → false）：流里**新冒出**的 assistant_message（id ≠ 基线）= 这一段的定稿，
 *    登记 `定稿 id → 流式项 key`；没有新定稿（被停止 / 报错 / 定稿还在路上）就不登记——
 *    退回老行为（重挂载），不会错认别的事件；
 *  - 其余情况原样返回同一个引用（调用方靠引用相等判断「没变化」、不触发 setState）。
 *
 * @param lastAssistantId 当前流里最后一条 assistant_message 的 id（没有为 null）
 */
export const nextStreamHandoff = (
  prev: StreamHandoffState,
  input: { streaming: boolean; lastAssistantId: string | null },
): StreamHandoffState => {
  if (input.streaming) {
    if (prev.active) return prev;
    return {
      active: true,
      seq: prev.seq + 1,
      baselineAssistantId: input.lastAssistantId,
      aliases: prev.aliases,
    };
  }
  if (!prev.active) return prev;
  const landed =
    input.lastAssistantId !== null &&
    input.lastAssistantId !== prev.baselineAssistantId;
  return {
    active: false,
    seq: prev.seq,
    baselineAssistantId: null,
    aliases: landed
      ? {
          ...prev.aliases,
          [input.lastAssistantId as string]: streamItemId(prev.seq),
        }
      : prev.aliases,
  };
};

/**
 * 流里最后一条 assistant_message 的 id（没有 → null）。
 * assistant_message 永远独立平铺、不进工作过程组（见 chat-turns 的 MEMBER_KINDS），
 * 所以只扫顶层项就够；从尾往前扫，通常第一两步就命中。
 */
export const findLastAssistantId = (
  items: readonly { kind: string; id: string }[],
): string | null => {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "assistant_message") return it.id;
  }
  return null;
};

/** Virtuoso 的 key：被接管的定稿事件用它接管的流式项 key，其余用自己的 id */
export const resolveItemKey = (
  itemId: string,
  aliases: Readonly<Record<string, string>>,
): string => aliases[itemId] ?? itemId;
