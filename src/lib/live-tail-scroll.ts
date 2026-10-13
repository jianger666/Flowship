/**
 * 实时思考窗口（LiveThinkingTail）的「连续滚动」：算内容该向上平移多少像素。纯函数、无 DOM。
 *
 * 为什么不用浏览器的 smooth scroll（2026-10-12 用户反馈「速度时快时慢，像开车加速又刹车又加速」）：
 * 窗口原先是「换一行就 `scrollTo({ behavior: "smooth" })` 一次」。每次调用都是一段 ease-in-out
 * （慢—快—慢）的动画，行与行之间纹丝不动——字吐得再匀，窗口也是「一行一个脉冲」。
 * 浏览器实测（120 字/秒的思考）：82% 的时间窗口不动，其余时间猛地滚一下，
 * 100ms 窗口里滚动速度 0–190px/s（均值只有 23px/s），约 1.2 次/秒的脉冲——比文字速度的锯齿更扎眼。
 *
 * 现在的做法：窗口不再「等换行再滚」，而是随**文末光标的位置**连续上移——
 * 光标在一行里从左写到右，内容就匀速上移一整行；换行的瞬间光标回到行首、行号 +1，
 * 两项的变化正好抵消，位置是连续的。滚动速度因此恒等于「写字的速度 ÷ 一行的字数 × 行高」，
 * 字吐得匀，窗口就滚得匀；字停了窗口就停（没有残余动画）。
 *
 * 代价：窗口底部会留出 0–1 行的空隙（光标写到行尾时空隙最大，换行后新行填进来）——
 * 这是「连续」的固有代价：要么最新一行永远贴底、换行时跳一行，要么底部随书写进度起伏。
 * 最新的字始终完整可见（空隙在最新行的下方，不会把它顶出窗口）。
 */

export interface LiveTailMetrics {
  /** 文末光标的 offsetTop（px，相对内容区顶部；比行盒顶多出一个固定的小偏移，不影响连续性） */
  caretTop: number;
  /** 文末光标的 offsetLeft（px，相对内容区左缘） */
  caretLeft: number;
  /** 内容区宽度（px）：一行的满宽 */
  width: number;
  /** 行高（px） */
  lineHeight: number;
  /** 窗口高度上限（px；max-h-28 = 112）。注意是「上限」而不是当前高度：内容不够高时窗口随内容长高，不需要平移 */
  viewport: number;
}

const isUsable = (m: LiveTailMetrics): boolean =>
  Number.isFinite(m.caretTop) &&
  Number.isFinite(m.caretLeft) &&
  Number.isFinite(m.width) &&
  Number.isFinite(m.lineHeight) &&
  Number.isFinite(m.viewport) &&
  m.width > 0 &&
  m.lineHeight > 0 &&
  m.viewport > 0;

/** 最新一行的底边是否已超出窗口上限：超出了才需要平移、才需要顶部渐隐 */
export const isLiveTailOverflowing = (m: LiveTailMetrics): boolean =>
  isUsable(m) && m.caretTop + m.lineHeight > m.viewport + 1;

/**
 * 内容该向上平移多少像素（≥ 0）。
 *
 * @param continuous true = 随光标在行内的进度连续平移；false = 只按整行阶跃（偏好「减少动态效果」的用户：
 *   换一行跳一行，行内不动）
 *
 * 推导：让「最新一行的底边」落在窗口底边之上 progress × 行高 处——
 *   offset = (caretTop + lineHeight) − viewport + progress × lineHeight，progress = 光标在行内的水平进度 ∈ [0, 1]。
 * progress = 0（行首）时最新一行的底边正好贴窗口底边（完整可见）；
 * progress → 1（行尾）时多滚了一整行，下一行的位置在窗口底部空着等新字；
 * 换行时 caretTop += lineHeight 而 progress 1 → 0，offset 不变——连续。
 */
export const liveTailOffset = (
  m: LiveTailMetrics,
  continuous = true,
): number => {
  if (!isUsable(m)) return 0;
  const bottom = m.caretTop + m.lineHeight;
  if (bottom <= m.viewport) return 0;
  const progress = continuous
    ? Math.min(Math.max(m.caretLeft / m.width, 0), 1)
    : 0;
  return bottom - m.viewport + progress * m.lineHeight;
};
