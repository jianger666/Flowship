/**
 * 进行中正文（assistant 流式气泡）的快照合并（纯函数，useSmoothStreaming.applySnapshot 用）。
 *
 * 背景（2026-10-22 用户反馈「对话在生成中、我没聚焦这个窗口，切回来看到的是它返回的中间部分，
 * 要等它生成完才能看到全部」）：assistant_delta 是纯内存帧、从不回放，前端流式文本又只活在组件本地
 * （ref + state）里——切到别的对话再切回（组件重挂）、SSE 断流重连，新订阅者只能从「订阅之后的第一帧」
 * 开始拼。服务端现在记住「已发出的进行中那一段」，每次连接 bootstrap 补一帧 assistant_snapshot，
 * 本文件决定怎么把它并回本地流式态。
 */

/** SSE `assistant_snapshot` 帧里的 live（线上字段 eventId，前端内部叫 id） */
export interface AssistantSnapshot {
  /** 这段正文落盘后那条 assistant_message 事件的预定 id */
  id: string;
  /** 服务端已发出的整段原文（已脱敏） */
  text: string;
  /** 服务端已发出的字符数（脱敏前口径，仅供校验） */
  total: number;
}

export type AssistantSnapshotPlan =
  /** 没有进行中的正文（或空）：清掉本地残留 */
  | { kind: "clear" }
  /** 本地已经对得上（相同，或本地比快照更新）：什么都不动 */
  | { kind: "keep" }
  /** 本地已收到的是快照的前缀（同页重连、期间又长了一截）：保留已上屏长度、只补尾巴，吐字动画接着走 */
  | { kind: "extend"; target: string }
  /**
   * 整段直接铺上、不逐字动画：新挂载（切走再切回，本地什么都没有）——用户要的是「立刻看到已经生成的全部」；
   * 或本地与快照不一致（不应出现，兜底以服务端为准）
   */
  | { kind: "replace"; target: string };

/**
 * @param received 本地「已收到」的全部流式文本（含还没上屏、还在合帧队列里的）
 * @param snap 服务端快照；null = 此刻没有进行中的正文
 */
export const planAssistantSnapshot = (
  received: string,
  snap: AssistantSnapshot | null,
): AssistantSnapshotPlan => {
  if (snap === null || snap.text.length === 0) return { kind: "clear" };
  const text = snap.text;
  if (received === text) return { kind: "keep" };
  if (received.length === 0) return { kind: "replace", target: text };
  if (text.startsWith(received)) return { kind: "extend", target: text };
  // 本地反而更长且以快照为前缀：不可能出现在正常时序里（快照 = 订阅前已发出的全部），保守地不动
  if (received.startsWith(text)) return { kind: "keep" };
  return { kind: "replace", target: text };
};
