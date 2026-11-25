/**
 * 电脑操作工具（`desktop_*`）在事件流工具块里的一行摘要。
 *
 * 与 browser-tool-display.ts 同一思路：工具名保持原样，这里只负责把入参翻成人话，
 * 免得折叠行退化成通用的 `调用 desktop_click:{"x":320,"y":240}`。
 * 纯函数、不依赖 DOM / bridge，网页版（没有电脑操作）回看历史事件时也能正常显示。
 *
 * 隐私：打出去的文字、单字符按键都不在摘要里回显——落盘前 redact-args 已把它们换成 `[已隐藏 N 字符]`，
 * 这里只还原成「N 个字符」；应用名是模型自己写的入参，限长后展示。
 */

export const DESKTOP_TOOL_PREFIX = "desktop_";

export const isDesktopToolName = (name: string): boolean =>
  name.toLowerCase().startsWith(DESKTOP_TOOL_PREFIX);

const clip = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const parseArgs = (args: string | undefined): Record<string, unknown> | null => {
  if (!args) return null;
  try {
    const raw: unknown = JSON.parse(args);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");

/** 数字参数：模型常把数字写成字符串，数字与数字字符串都认 */
const num = (o: Record<string, unknown>, k: string): number | undefined => {
  const v = o[k];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** 落盘前脱敏后的占位符 `[已隐藏 N 字符]`：还原成 N；不是占位符返回 null */
const HIDDEN_CHARS_RE = /^\[已隐藏 (\d+) 字符\]$/;
const hiddenCount = (text: string): number | null => {
  const m = HIDDEN_CHARS_RE.exec(text);
  return m ? Number(m[1]) : null;
};

const at = (x: number | undefined, y: number | undefined): string =>
  x !== undefined && y !== undefined ? ` (${Math.round(x)}, ${Math.round(y)})` : "";

/**
 * 返回一行中文摘要；不是电脑操作工具时返回空串（调用方回落到通用摘要逻辑）。
 * 没有可读入参也有意义的工具（截图 / 状态 / 结束）永远有文案。
 */
export const desktopToolSummary = (name: string, args: string | undefined): string => {
  const n = name.toLowerCase();
  if (!isDesktopToolName(n)) return "";
  const o = parseArgs(args) ?? {};

  switch (n) {
    case "desktop_status":
      return "查看电脑操作状态";
    case "desktop_screenshot":
      // foreground:true = 锁屏时要求解锁、用真实屏幕（Windows 后台模式不够用时 AI 的升级请求）
      return o.foreground === true || o.foreground === "true" ? "电脑截图（要求解锁，用真实屏幕）" : "电脑截图";
    case "desktop_click": {
      const count = num(o, "count");
      const verb = count !== undefined && Math.round(count) >= 3 ? "三连击" : count !== undefined && Math.round(count) === 2 ? "双击" : "点击";
      const which = str(o, "button") === "right" ? "右键" : str(o, "button") === "middle" ? "中键" : "";
      return `${which}${verb}${at(num(o, "x"), num(o, "y"))}`;
    }
    case "desktop_move":
      return `移动鼠标${at(num(o, "x"), num(o, "y"))}`;
    case "desktop_drag": {
      const fx = num(o, "from_x") ?? num(o, "x");
      const fy = num(o, "from_y") ?? num(o, "y");
      const tx = num(o, "to_x") ?? num(o, "toX");
      const ty = num(o, "to_y") ?? num(o, "toY");
      if (fx === undefined || fy === undefined || tx === undefined || ty === undefined) return "拖动";
      return `拖动 (${Math.round(fx)}, ${Math.round(fy)}) → (${Math.round(tx)}, ${Math.round(ty)})`;
    }
    case "desktop_scroll": {
      // 和实际执行同一个取整口径：主进程 clampInt / 工具层校验都是 Math.trunc（dy=0.4 实际滚 0 格，dy=2.7 实际滚 2 格）；
      // 以前这里 Math.round 且只判 !== 0，dy=0.4 会显示成「向下 0 格」、dy=0.6 显示「向下 1 格」而实际一格没动（第三轮评审）。取整后是 0 的方向不显示
      const dx = Math.trunc(num(o, "dx") ?? 0);
      const dy = Math.trunc(num(o, "dy") ?? 0);
      const parts: string[] = [];
      if (dy !== 0) parts.push(`${dy > 0 ? "向下" : "向上"} ${Math.abs(dy)} 格`);
      if (dx !== 0) parts.push(`${dx > 0 ? "向右" : "向左"} ${Math.abs(dx)} 格`);
      return parts.length > 0 ? `滚动 ${parts.join("、")}` : "滚动";
    }
    case "desktop_type": {
      const text = str(o, "text");
      // 输入内容可能是密码：折叠行只给长度；占位符还原 N，别把占位符本身的长度当成输入长度
      const count = text ? (hiddenCount(text) ?? [...text].length) : 0;
      const submit = o.submit === true || o.submit === "true" ? " 并回车" : "";
      return count > 0 ? `输入 ${count} 个字符${submit}` : `输入文字${submit}`;
    }
    case "desktop_key": {
      const keys = str(o, "keys") || str(o, "key");
      if (!keys) return "按键";
      if (hiddenCount(keys) !== null) return "按键（单个字符）";
      const repeat = num(o, "repeat");
      return `按键 ${clip(keys, 30)}${repeat !== undefined && Math.round(repeat) > 1 ? ` ×${Math.round(repeat)}` : ""}`;
    }
    case "desktop_apps":
      return "查看运行中的应用";
    case "desktop_open_app": {
      const app = clip(str(o, "name"), 24);
      return app ? `打开应用「${app}」` : "打开应用";
    }
    case "desktop_end_session":
      return "结束电脑操作";
    default:
      return "";
  }
};
