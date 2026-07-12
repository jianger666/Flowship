/**
 * meegle CLI 进程级串行队列（防凭据并发 refresh 撞毁）
 *
 * 独立小模块：meegle-cli.ts 与 feishu-cli.ts 都会起 meegle 子进程，
 * 若队列只放在 meegle-cli 里，feishu-cli 的 auth/version/config 会绕过；
 * 又不能互相 import（meegle-cli → feishu-cli.meegleBin 已存在），故抽到两边都能引。
 *
 * 挂 globalThis：dev 下不同 route chunk 各持一份 module 变量会让串行化失效
 *（同 task-runner 的 advanceChains / submitWorkFollowupCounts）。
 */

const MEEGLE_CHAIN_KEY = "__feAiFlowMeegleChainV1__";

type MeegleChainState = { current: Promise<void> };

const getMeegleChain = (): MeegleChainState => {
  const g = globalThis as unknown as Record<string, MeegleChainState | undefined>;
  if (!g[MEEGLE_CHAIN_KEY]) g[MEEGLE_CHAIN_KEY] = { current: Promise.resolve() };
  return g[MEEGLE_CHAIN_KEY]!;
};

/**
 * 把一次 meegle 子进程调用排进进程级单飞队列。
 * - 调用方拿到的 promise 仍按本次成败 resolve/reject
 * - 链上吞掉前驱异常（`.then(ok, ok)`），前一个失败不打断后续排队
 *
 * 例外：`auth login` 长驻交互进程不占队列槽（用户显式低频操作、会长时间占着
 * 阻塞看板探测）；仅短命调用（auth status / version / config set|init / 业务 JSON）入队。
 */
export const enqueueMeegle = <T>(run: () => Promise<T>): Promise<T> => {
  const state = getMeegleChain();
  // 等前驱结束（成败都放行）再跑本次
  const result = state.current.then(run, run);
  // 推进链尾：本次无论成败都 settle 成 void，别让 reject 卡住后面
  state.current = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};
