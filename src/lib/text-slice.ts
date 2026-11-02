/**
 * 不劈开字符的字符串截取（纯函数）。
 *
 * 背景：`str.slice(0, n)` 按 UTF-16 码元计，一个 emoji / 生僻字占两个码元，终点恰落在中间就会截出
 * 半个字符（界面上是 \uFFFD，发往飞书的正文里是孤立代理项）。
 * 这里保持「长度预算仍按码元」的既有口径（调用方的 `length > max` 判断不用改），只在终点 / 起点落在
 * 「字符」中间时往里退：
 * - 有 `Intl.Segmenter`：按字素簇（grapheme）退——ZWJ 序列（👨‍👩‍👧）、国旗（🇨🇳）、组合符（e + 重音）都不被劈开；
 * - 没有：只防代理对（旧行为）。
 *
 * 性能：只对截断点附近 ±{@link GRAPHEME_WINDOW} 个码元分段，绝不对整段文本做全量分段（正文可能几十万字）。
 * 窗口内找不到可用边界（单个字素簇比窗口还长，如叠了几百个组合符的恶意文本）时回退到代理对安全的旧行为，
 * 不会把前缀退成空串。
 */

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** 截断点两侧参与分段的码元数（最长的常见 ZWJ 家庭 / 肤色序列约 25 个码元，留足余量） */
const GRAPHEME_WINDOW = 64;

// 惰性创建并缓存；环境没有 Segmenter（或构造失败）时为 null，走旧行为
let segmenter: Intl.Segmenter | null | undefined;
const getSegmenter = (): Intl.Segmenter | null => {
  if (segmenter !== undefined) return segmenter;
  try {
    segmenter =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  } catch {
    segmenter = null;
  }
  return segmenter;
};

/** 窗口起点别落在代理对中间（否则开头会多出一个假的字素边界） */
const windowStart = (text: string, center: number): number => {
  let from = Math.max(0, center - GRAPHEME_WINDOW);
  if (from > 0 && isLowSurrogate(text.charCodeAt(from)) && isHighSurrogate(text.charCodeAt(from - 1))) {
    from -= 1;
  }
  return from;
};

/** 取前 end 个码元；终点劈在字符中间时往前退到上一个字符边界（少一个字符，也不留半个） */
export const sliceHeadSafe = (text: string, end: number): string => {
  if (end <= 0) return "";
  if (end >= text.length) return text;
  const seg = getSegmenter();
  if (seg) {
    const from = windowStart(text, end);
    const to = Math.min(text.length, end + GRAPHEME_WINDOW);
    let cut = -1;
    for (const s of seg.segment(text.slice(from, to))) {
      const boundary = from + s.index;
      if (boundary > end) break;
      cut = boundary;
    }
    // cut === from（且 from > 0）= 窗口起点到终点一路都是同一个字素簇：窗口起点不一定是真边界，不采用
    if (cut > from || (cut === from && from === 0)) return text.slice(0, cut);
  }
  const cut =
    isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))
      ? end - 1
      : end;
  return text.slice(0, cut);
};

/** 取后 n 个码元；起点劈在字符中间时往后移到下一个字符边界 */
export const sliceTailSafe = (text: string, n: number): string => {
  if (n <= 0) return "";
  if (n >= text.length) return text;
  const start = text.length - n;
  const seg = getSegmenter();
  if (seg) {
    const from = windowStart(text, start);
    const to = Math.min(text.length, start + GRAPHEME_WINDOW);
    let cut = -1;
    for (const s of seg.segment(text.slice(from, to))) {
      const boundary = from + s.index;
      if (boundary >= start) {
        cut = boundary;
        break;
      }
    }
    // 窗口一直延伸到文本末尾仍没有 ≥ start 的边界：start 落在最后一个字素簇里，末尾本身就是边界
    if (cut < 0 && to === text.length) cut = text.length;
    if (cut >= 0) return text.slice(cut);
  }
  const from =
    isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))
      ? start + 1
      : start;
  return text.slice(from);
};
