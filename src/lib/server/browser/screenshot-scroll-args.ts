/**
 * browser_screenshot / browser_scroll 的增强参数解析（E2·P5a：B6 / C3）。
 * 纯函数，不依赖 tools.ts（避免成环）：错误类型由调用方注入（tools.ts 的 BadArgs，会被渲染成「参数有误：…」）。
 * 互斥规则与主进程 `screenshot-kit.mjs` / `scroll-kit.mjs` 一致——server 先拦一道，给模型快速反馈；主进程仍会独立再校验。
 */

type ErrCtor = new (message: string) => Error;

const SCREENSHOT_FORMATS = ["png", "jpeg", "webp"] as const;
type ScreenshotFormat = (typeof SCREENSHOT_FORMATS)[number];

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ScreenshotOpArgs {
  format: ScreenshotFormat;
  quality: number;
  maxWidth: number;
  ref?: string;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  scale?: number;
  omitBackground?: boolean;
  annotate?: boolean;
}

/**
 * @param ref 已校验过的 ref（调用方用 optRef）
 */
export const parseScreenshotArgs = (args: Record<string, unknown>, ref: string | undefined, Bad: ErrCtor): ScreenshotOpArgs => {
  const bad = (m: string): never => {
    throw new Bad(m);
  };
  const fullPage = bool(args.full_page) === true;
  const rawFormat = typeof args.format === "string" && args.format.trim() !== "" ? args.format.trim().toLowerCase() : undefined;
  if (rawFormat !== undefined && !(SCREENSHOT_FORMATS as readonly string[]).includes(rawFormat)) {
    bad(`format 只能是 ${SCREENSHOT_FORMATS.join(" / ")}，收到的是「${rawFormat.slice(0, 20)}」`);
  }
  const format = (rawFormat ?? "jpeg") as ScreenshotFormat;

  const ranged = (key: string, min: number, max: number, integer: boolean): number | undefined => {
    if (args[key] === undefined || args[key] === null || args[key] === "") return undefined;
    const n = num(args[key]);
    if (n === undefined) return bad(`${key} 必须是数字`);
    if (integer && !Number.isInteger(n)) return bad(`${key} 必须是整数`);
    if (n < min || n > max) return bad(`${key} 必须在 ${min}–${max} 之间，收到 ${n}`);
    return n;
  };
  const quality = ranged("quality", 1, 100, true);
  const maxWidth = ranged("max_width", 100, 4096, true);
  const scale = ranged("scale", 0.1, 3, false);
  const omitBackground = bool(args.omit_background) === true;
  const annotate = bool(args.annotate) === true;

  let clip: ScreenshotOpArgs["clip"];
  if (args.clip !== undefined && args.clip !== null) {
    if (!isRec(args.clip)) bad("clip 必须是对象 {x, y, width, height}（视口 CSS 像素）");
    const c = args.clip as Record<string, unknown>;
    const x = num(c.x);
    const y = num(c.y);
    const width = num(c.width);
    const height = num(c.height);
    if (x === undefined || y === undefined || width === undefined || height === undefined) bad("clip 的 x / y / width / height 都必须是数字");
    if (x! < 0 || y! < 0) bad("clip.x / clip.y 不能为负（原点是视口左上角）");
    if (width! <= 0 || height! <= 0) bad("clip.width / clip.height 必须大于 0");
    if (width! > 8192 || height! > 8192) bad("clip 的宽高不能超过 8192（CSS 像素）；只需要局部时请缩小范围，或用 ref 截取某个元素");
    clip = { x: x!, y: y!, width: width!, height: height! };
  }

  if (clip && fullPage) bad("clip 与 full_page 互斥：clip 是视口内的一块区域，full_page 是整页。请二选一");
  if (clip && ref) bad("clip 与 ref 互斥：ref 已经是按元素截取。请二选一");
  if (omitBackground && format !== "png") bad('omit_background（透明背景）只对 png 有效，请同时传 format:"png"');
  if (quality !== undefined && format === "png") bad("quality 只对 jpeg / webp 有效（png 是无损格式）");
  if (annotate) {
    if (fullPage) bad("annotate 只能标注当前视口：请去掉 full_page（先 browser_scroll 到目标区域再截）");
    if (ref) bad("annotate 标注的是整个视口里的元素，不能与 ref 同用：请去掉 ref");
    if (clip) bad("annotate 不能与 clip 同用：请去掉 clip");
    if (format === "webp") bad('annotate 不支持 webp：请用 format:"png" 或 "jpeg"');
  }

  return {
    format,
    quality: quality ?? 70,
    // 显式 scale 却没给 max_width：放宽到 4096，否则 scale>1 立刻被默认 1280 缩回去
    maxWidth: maxWidth ?? (scale !== undefined ? 4096 : 1280),
    ...(ref ? { ref } : {}),
    ...(fullPage ? { fullPage: true } : {}),
    ...(clip ? { clip } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(omitBackground ? { omitBackground: true } : {}),
    ...(annotate ? { annotate: true } : {}),
  };
};

export interface ScrollOpArgs {
  ref?: string;
  direction?: string;
  amount?: number;
  scrollIntoView?: true;
  untilStable?: { maxSteps?: number; stepTimeoutMs?: number; timeoutMs?: number } | true;
}

/** until_stable 总时长上限 / 下限（与主进程 scroll-kit 的 UNTIL_STABLE_MAX_TOTAL_MS / MIN 逐项一致，测试对账） */
export const UNTIL_STABLE_MAX_TOTAL_MS = 45_000;
export const UNTIL_STABLE_MIN_TOTAL_MS = 1000;
/** scroll until_stable 的 bridge 本地超时：总时长上限 + 收尾余量（ensureCdp / 复位 / scrollInfo），必须 > 上限且 < 默认 60s 的体感 */
export const UNTIL_STABLE_BRIDGE_TIMEOUT_MS = 55_000;

/**
 * scroll 增强参数：scroll_into_view（布尔，或 `{ref}` 对象——模型常按文档写成对象，宽松接受）与 until_stable（true 或 `{max_steps, step_timeout_ms}`）。
 * 三种模式互斥：滚动（direction / amount [+ ref 容器]）｜ scroll_into_view（+ ref）｜ until_stable。
 */
export const parseScrollArgs = (
  args: Record<string, unknown>,
  base: { ref?: string; direction?: string; amount?: number },
  Bad: ErrCtor,
  refParser: (raw: unknown) => string,
): ScrollOpArgs => {
  const bad = (m: string): never => {
    throw new Bad(m);
  };
  let ref = base.ref;
  let scrollIntoView = false;
  const rawSiv = args.scroll_into_view;
  if (isRec(rawSiv)) {
    scrollIntoView = true;
    if (rawSiv.ref !== undefined) {
      const inner = refParser(rawSiv.ref);
      if (ref && ref !== inner) bad("scroll_into_view.ref 与顶层 ref 不一致，请只传一个");
      ref = inner;
    }
  } else if (bool(rawSiv) === true) {
    scrollIntoView = true;
  }

  let untilStable: ScrollOpArgs["untilStable"];
  const rawUs = args.until_stable;
  if (isRec(rawUs)) {
    const ranged = (key: string, min: number, max: number): number | undefined => {
      if (rawUs[key] === undefined || rawUs[key] === null) return undefined;
      const n = num(rawUs[key]);
      if (n === undefined || !Number.isInteger(n)) return bad(`until_stable.${key} 必须是整数`);
      if (n < min || n > max) return bad(`until_stable.${key} 必须在 ${min}–${max} 之间，收到 ${n}`);
      return n;
    };
    const maxSteps = ranged("max_steps", 1, 30);
    const stepTimeoutMs = ranged("step_timeout_ms", 100, 5000);
    // 总时限：夹到 [1000, 45000]（不报错；R6-17）
    const rawTotal = num(rawUs.timeout_ms);
    const timeoutMs = rawTotal === undefined ? undefined : Math.min(UNTIL_STABLE_MAX_TOTAL_MS, Math.max(UNTIL_STABLE_MIN_TOTAL_MS, Math.round(rawTotal)));
    untilStable = {
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(stepTimeoutMs !== undefined ? { stepTimeoutMs } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
  } else if (bool(rawUs) === true) {
    untilStable = {};
  }

  if (untilStable && scrollIntoView) bad("until_stable 与 scroll_into_view 互斥，请二选一");
  if (untilStable && (base.direction || base.amount !== undefined)) {
    bad("until_stable 会自己反复滚到底，不能再带 direction / amount；只想滚一次请去掉 until_stable");
  }
  if (untilStable && ref) bad("until_stable 只作用于页面主滚动区，不能与 ref 同用；要滚某个容器请用 ref + direction");
  if (scrollIntoView) {
    if (!ref) bad("scroll_into_view 需要 ref（先 browser_snapshot 取得）");
    if (base.direction || base.amount !== undefined) bad("scroll_into_view 是把元素滚到视口中央，不能再带 direction / amount");
  }

  return {
    ...(ref ? { ref } : {}),
    ...(base.direction ? { direction: base.direction } : {}),
    ...(base.amount !== undefined ? { amount: base.amount } : {}),
    ...(scrollIntoView ? { scrollIntoView: true as const } : {}),
    ...(untilStable
      ? {
          untilStable: {
            ...(untilStable !== true && untilStable.maxSteps !== undefined ? { maxSteps: untilStable.maxSteps } : {}),
            ...(untilStable !== true && untilStable.stepTimeoutMs !== undefined ? { stepTimeoutMs: untilStable.stepTimeoutMs } : {}),
            ...(untilStable !== true && untilStable.timeoutMs !== undefined ? { timeoutMs: untilStable.timeoutMs } : {}),
          },
        }
      : {}),
  };
};

// ───────────────────────── 结果渲染（纯函数） ─────────────────────────

/** legend 行数上限（主进程已限 80，这里再兜一层） */
const LEGEND_MAX_LINES = 80;

/**
 * annotate 的 legend 文字：元素名来自页面 → 调用方用 `b.untrusted(...)` 包装；这里先脱敏 + 去控制字符 + 限行。
 * @param redact redactSensitiveText
 */
export const renderLegend = (legend: unknown, redact: (s: string) => string): string => {
  if (!Array.isArray(legend)) return "";
  const lines = legend
    .filter((l): l is string => typeof l === "string")
    .slice(0, LEGEND_MAX_LINES)
    .map((l) => l.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, " ").slice(0, 200));
  return redact(lines.join("\n"));
};

export interface UntilStableResult {
  steps?: number;
  heightBefore?: number;
  heightAfter?: number;
  atBottom?: boolean;
  reason?: string;
  elapsedMs?: number;
}

/** until_stable 结果的一句话（全是数字 / 枚举，不含页面文字，可信） */
export const renderUntilStable = (r: UntilStableResult | undefined): string => {
  if (!r || typeof r.steps !== "number") return "";
  const why =
    r.reason === "stable"
      ? "连续两轮没有新内容加载，已停止"
      : r.reason === "timeout"
        ? "已达到总时长上限（最多 45 秒），页面可能还有更多内容（可再滚一次）"
        : "已达到最大步数上限，页面可能还有更多内容（可提高 max_steps 再滚一次）";
  const grew =
    typeof r.heightBefore === "number" && typeof r.heightAfter === "number"
      ? `页面高度 ${Math.round(r.heightBefore)}→${Math.round(r.heightAfter)}px，`
      : "";
  return `无限滚动：共滚动 ${r.steps} 步，${grew}${r.atBottom ? "已在底部" : "未到底部"}；${why}。`;
};
