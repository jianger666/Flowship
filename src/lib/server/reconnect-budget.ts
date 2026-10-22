/**
 * 自动重连预算（S1b-04）：「重连真的恢复了」之后把已用次数归零。
 *
 * 背景：tryAutoReconnect 把已用次数 attempt 放进 opts.reconnectAttempt、递归带进新 run 的 consume。
 * 新 run 跑了很久、收了一堆正文，之后全新的一次断线（VPN 抖 / 合盖唤醒）仍接着旧计数写「第 4/5 次」，
 * 第 6 次直接放弃标 error；sdk-error 里「瞬时鉴权只放行 attempt<=1」也被旧计数污染。
 *
 * 归零信号的取舍：
 * - 不能用「send 受理成功」——resume ok、send ok、立刻又断会变成无限重连环；
 * - 不能用「流里来了任意一条消息」——system init / status 可能是本地先吐的，
 *   status=ERROR / EXPIRED 更是「没通」的明证；
 * - 只认「模型那头真有产出」：assistant 正文 / tool_use、thinking 文本、tool_call、usage（回合结束计费）。
 *
 * 即便如此，「每次都先吐一点再断」理论上仍可无限循环（每圈都有真产出、都有 ≥2s 退避），
 * 所以单条 consume 链再加一个**不归零**的总次数硬上限（RECONNECT_TOTAL_MAX）兜底。
 * 未发生过归零时总次数 ≤ RECONNECT_MAX(5)，这条上限不会改变既有的放弃行为。
 */

/** 单条 consume 链里累计重连的硬上限（不随归零重置）：5 次预算 × 4 轮「恢复又断」 */
export const RECONNECT_TOTAL_MAX = 20;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/**
 * 这条 SDK 消息是否证明「重连后的会话真的通了」。
 * 畸形消息（缺字段 / 类型不对）一律 false：宁可不归零、也不能因脏数据放开重连环。
 */
export const isReconnectRecoverySignal = (msg: unknown): boolean => {
  if (!isRecord(msg)) return false;
  switch (msg.type) {
    case "assistant": {
      const message = msg.message;
      const blocks = isRecord(message) ? message.content : undefined;
      if (!Array.isArray(blocks)) return false;
      return blocks.some((b) => {
        if (!isRecord(b)) return false;
        if (b.type === "tool_use") return true;
        return b.type === "text" && typeof b.text === "string" && b.text.length > 0;
      });
    }
    case "thinking":
      return typeof msg.text === "string" && msg.text.length > 0;
    case "tool_call":
    case "usage":
      return true;
    default:
      // system / user / request / task / status（含 ERROR / EXPIRED）：都不算
      return false;
  }
};

export interface ReconnectBudget {
  /** 当前已用重连次数——下一次 tryAutoReconnect 的 opts.reconnectAttempt 取它 */
  readonly used: number;
  /**
   * 喂入流里的每条 SDK 消息。命中恢复信号且 used>0 → 归零并返回 true。
   * used 已是 0 时不动（返回 false）。
   */
  noteSdkMessage: (msg: unknown) => boolean;
}

export const createReconnectBudget = (initialUsed = 0): ReconnectBudget => {
  let used = Math.max(0, Math.floor(initialUsed));
  return {
    get used() {
      return used;
    },
    noteSdkMessage(msg) {
      if (used === 0) return false;
      if (!isReconnectRecoverySignal(msg)) return false;
      used = 0;
      return true;
    },
  };
};
