/**
 * 通知 Electron 壳「首页真实内容已渲出来」（v1.1.x 开屏一屏到底）
 *
 * 壳的启动流程：splash 独立窗亮着 → 主窗 hidden 加载页面 → 页面调本函数 →
 * 壳亮主窗 + 收 splash。这样启动全程只有 splash 一屏 loading、没有
 * 「splash → 页内 loading → 看板」的衔接切换。
 *
 * 幂等（壳侧 revealMainWindow 有 latch）；web 版 / 老壳没有该通道时静默无操作；
 * 壳侧另有 8s 兜底 timer、这里没调到也不会永远黑窗。
 */
export const markShellContentReady = (): void => {
  try {
    const shell = (
      window as unknown as {
        __shell?: { markContentReady?: () => void };
      }
    ).__shell;
    shell?.markContentReady?.();
  } catch {
    /* 非壳环境忽略 */
  }
};
