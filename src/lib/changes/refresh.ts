/**
 * 改动清单刷新的并发控制 + 轮询节奏（纯 TS，无 React / DOM，可直接做行为测试）。
 *
 * 触发源很多：4 秒轮询、窗口聚焦、切分支事件、面板打开、换范围……而读一次清单在大仓里要跑十来个
 * git 子进程、可能要一两秒。不控制的话慢请求会叠起来：浏览器连接池被占满、服务端 git 进程成堆，
 * 先发的响应还可能后到、盖掉新数据。所以：
 *
 * - 静默刷新（轮询 / 聚焦 / 分支切换）：已有请求在跑就不再叠加，只记一笔「跑完补一次」
 *   （在途期间无论触发多少次，只补一次——补的那次读到的是最新磁盘）；
 * - 显式刷新（换范围 / 手动）：取代在途请求（旧的中止——它读的已经是过期的口径，不必再等）；
 * - 中止 / 取代后，旧请求的结果一律不落（isCurrent 为 false）；
 * - 轮询间隔按上一次读取的耗时自适应：读得慢就自动慢下来，快了自动恢复。
 */

/** 自适应间隔的封顶：再慢也至少每分钟看一次 */
const MAX_POLL_MS = 60_000;
/** 间隔至少是上次读取耗时的几倍：留出足够的空闲，让 git 与别的操作（agent 的命令）不被轮询挤占 */
const SLOW_FACTOR = 3;

/**
 * 下一次轮询的等待时长：基础间隔，但至少是「上一次读取耗时」的 3 倍（封顶 60 秒；基础间隔本身更长就用基础间隔）。
 * 没有可参考的耗时（还没读过 / 数值异常）用基础间隔。
 */
export const nextPollDelay = (baseMs: number, lastDurationMs: number | null): number => {
  if (lastDurationMs === null || !Number.isFinite(lastDurationMs) || lastDurationMs <= 0) {
    return baseMs;
  }
  return Math.max(baseMs, Math.min(Math.round(lastDurationMs * SLOW_FACTOR), MAX_POLL_MS));
};

export interface RefreshContext {
  /** 被取代 / 被中止时触发：交给 fetch 即可，请求会自己抛 AbortError */
  signal: AbortSignal;
  /** 这次读取是不是「当前有效」的（没被更晚的显式刷新取代、也没被中止）：落结果前先问一下 */
  isCurrent: () => boolean;
}

export interface RefreshGateOptions {
  /** 实际读取。自己处理结果与错误；被中止时静默返回即可（抛出来也会被兜住，不会冒成未处理拒绝） */
  load: (ctx: RefreshContext) => Promise<void>;
  /** 一次读取的耗时（毫秒）；失败的也上报（超时 / 网络慢同样该让轮询放慢），被中止的不上报 */
  onTiming?: (ms: number) => void;
  /** 时钟（测试注入） */
  now?: () => number;
}

export interface RefreshGate {
  /**
   * 发起一次读取。silent：已有在途就合并成「跑完补一次」；否则取代在途（旧的被中止）。
   * 返回的 Promise 在这一次读取结束后 resolve（被合并掉的静默请求立即 resolve），永不 reject。
   */
  request: (opts?: { silent?: boolean }) => Promise<void>;
  /** 中止在途读取并清掉待补的那一次（换任务 / 卸载时用）；之后仍可再 request */
  abort: () => void;
  inFlight: () => boolean;
}

export const createRefreshGate = ({
  load,
  onTiming,
  now = () => performance.now(),
}: RefreshGateOptions): RefreshGate => {
  let inflight: AbortController | null = null;
  let dirty = false;
  let seq = 0;

  const request = async (opts?: { silent?: boolean }): Promise<void> => {
    if (inflight) {
      if (opts?.silent === true) {
        dirty = true;
        return;
      }
      inflight.abort();
    }
    // 走到这里 = 本次要真的发请求；它读到的就是最新的，之前记下的「待补」作废
    dirty = false;
    const mySeq = ++seq;
    const ctl = new AbortController();
    inflight = ctl;
    const startedAt = now();
    try {
      await load({
        signal: ctl.signal,
        isCurrent: () => mySeq === seq && !ctl.signal.aborted,
      });
    } catch {
      // load 自己负责处理错误；被中止的读取在这里静默结束
    } finally {
      if (!ctl.signal.aborted) onTiming?.(now() - startedAt);
      // 只有「仍是当前在途」的才收尾：被取代的旧请求不能把新请求的状态抹掉、也不触发补发
      if (inflight === ctl) {
        inflight = null;
        if (dirty) {
          dirty = false;
          void request({ silent: true });
        }
      }
    }
  };

  const abort = () => {
    inflight?.abort();
    inflight = null;
    dirty = false;
  };

  return { request, abort, inFlight: () => inflight !== null };
};
