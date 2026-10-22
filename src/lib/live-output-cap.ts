/**
 * shell 直播输出的封顶口径（R7-02）——客户端缓冲（live-tool-outputs / tool-display.trimLiveOutputLines）
 * 与服务端发帧（server/shell-output-bridge）共用同一套常量与切法，**无依赖、client / server 都能 import**。
 *
 * 为什么要有字符数上限：原先只按「行数」封顶（留最后 20 行）。shell 吐无换行的大量输出
 * （`cat dist/app.min.js` / `curl -#` / docker pull 的 `\r` 进度条）时，一行可以无限长，
 * 缓冲无界、每个增量还要把整串再 split 一遍（累计 O(n²)：10MB 无换行流 reducer 累计 4.5s）。
 * 20 行 × 约 400 字符 ≈ 8KB 足够「折叠行看最新一行 + 展开区看最近几行」，再多没人看得过来。
 */

/** 直播窗口最多保留的行数 */
export const LIVE_OUTPUT_MAX_LINES = 20;
/** 直播窗口最多保留的字符数（UTF-16 码元） */
export const LIVE_OUTPUT_MAX_CHARS = 8192;

/** 尾部 maxChars 个字符；不切开代理对（切在低位代理上就把那半个 emoji 丢掉，免得显示 �） */
export const sliceLiveOutputTail = (
  text: string,
  maxChars: number = LIVE_OUTPUT_MAX_CHARS,
): string => {
  if (text.length <= maxChars) return text;
  const out = text.slice(-maxChars);
  const c = out.charCodeAt(0);
  return c >= 0xdc00 && c <= 0xdfff ? out.slice(1) : out;
};

/**
 * 从尾部数起第 maxLines 个行分隔符之后的位置（= 要保留部分的起点）；分隔符不足 → 0（全留）。
 * 行分隔符：`\n`、`\r\n`（算一个）、孤立 `\r`（进度条刷新）。只扫尾部，不 split 全文。
 */
const tailLinesStart = (text: string, maxLines: number): number => {
  let seps = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      if (++seps === maxLines) return i + 1;
      if (i > 0 && text.charCodeAt(i - 1) === 13) i--;
    } else if (c === 13) {
      if (++seps === maxLines) return i + 1;
    }
  }
  return 0;
};

/**
 * 直播缓冲封顶：先按字符数留尾部，再按行数留最后 N 行（`\r` 也算换行）。
 * 语义与旧 `text.split("\n").slice(-maxLines)` 一致（末尾换行算一个空元素），只是多了字符上限与 `\r`。
 * 未超限返回原字符串（同引用）。
 */
export const trimLiveOutput = (
  text: string,
  maxLines: number = LIVE_OUTPUT_MAX_LINES,
  maxChars: number = LIVE_OUTPUT_MAX_CHARS,
): string => {
  const capped = sliceLiveOutputTail(text, maxChars);
  const start = tailLinesStart(capped, maxLines);
  return start === 0 ? capped : capped.slice(start);
};

/**
 * 折叠行 / 状态行要的「最新一行」：最后一个非空白段（`\r` 刷新取最后一次刷新的内容）。
 * 全空白返回 undefined。
 */
export const liveOutputTailLine = (text: string): string | undefined => {
  const segs = text.split(/\r\n|\r|\n/);
  for (let i = segs.length - 1; i >= 0; i--) {
    const t = segs[i]!.trim();
    if (t) return t;
  }
  return undefined;
};
