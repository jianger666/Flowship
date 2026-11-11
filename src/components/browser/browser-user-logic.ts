/**
 * 用户侧新增 UI 的纯逻辑（契约 §14.3，V4）：缩放标签 / 查找条 / 下载列表 / 对话框条 / 模拟标签。
 * 无 DOM、无 window：组件只管渲染，这里的判定都能在 vitest 里直接断言。
 */
import type { DialogInfo, DownloadInfo, TabInfo, ViewFit } from "@/lib/browser-bridge-types";
import { isImeComposing, type ImeEventLike } from "@/lib/ime";
import { clipOneLine } from "@/lib/one-line";

// ───────────────────────── 缩放 ─────────────────────────

/** Chromium 缩放范围 −3…+5 对应的百分比端点（1.2 ** level，与主进程 user-features.mjs 同口径） */
export const ZOOM_PERCENT_MIN = 58;
export const ZOOM_PERCENT_MAX = 249;

/** 工具栏缩放标签：100 / 缺省 / 非法值 = 不显示（null）；其余显示「125%」 */
export const formatZoomLabel = (zoom: number | undefined | null): string | null => {
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) return null;
  const pct = Math.round(zoom);
  if (pct === 100 || pct <= 0) return null;
  return `${pct}%`;
};

export const canZoomIn = (zoom: number | undefined | null): boolean =>
  !(typeof zoom === "number" && Number.isFinite(zoom) && zoom >= ZOOM_PERCENT_MAX);
export const canZoomOut = (zoom: number | undefined | null): boolean =>
  !(typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 && zoom <= ZOOM_PERCENT_MIN);

// ───────────────────────── 页内查找 ─────────────────────────

export interface FindProgress {
  activeMatchOrdinal: number;
  matches: number;
}

export type FindCountView =
  | { kind: "idle"; text: "" }
  | { kind: "searching"; text: "" }
  | { kind: "none"; text: "无结果" }
  | { kind: "found"; text: string };

/**
 * 查找条右侧的计数文案：
 * - 没输入词 → 空；输入了但还没收到主进程进度 → 空（searching，不闪「无结果」）
 * - matches=0 → 「无结果」；否则「3/12」
 */
export const formatFindCount = (query: string, found: FindProgress | null | undefined): FindCountView => {
  if (query.trim() === "") return { kind: "idle", text: "" };
  if (!found) return { kind: "searching", text: "" };
  if (!(found.matches > 0)) return { kind: "none", text: "无结果" };
  const active = Math.min(Math.max(1, Math.round(found.activeMatchOrdinal) || 1), Math.round(found.matches));
  return { kind: "found", text: `${active}/${Math.round(found.matches)}` };
};

export type FindKeyIntent = "next" | "prev" | "close" | null;

/**
 * 查找输入框的按键：Enter 下一个 / Shift+Enter 上一个 / Esc 关闭。
 * 输入法组字中的按键一律不算（走仓库统一口径 isImeComposing：同时看 isComposing 与 keyCode 229，
 * Safari / 旧内核上确认选词的那次 Enter 的 isComposing 已是 false，只有 keyCode 229 能识别；契约见 tests/ime-enter-contract.test.ts）。
 */
export const findKeyIntent = (e: { key: string; shiftKey?: boolean } & ImeEventLike): FindKeyIntent => {
  if (isImeComposing(e)) return null;
  if (e.key === "Escape") return "close";
  if (e.key === "Enter") return e.shiftKey ? "prev" : "next";
  return null;
};

/** Cmd（mac）/ Ctrl（其它）+ F：面板内焦点时由面板自己打开查找条（页面焦点走主进程 before-input-event） */
export const isFindShortcut = (
  e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean },
  isMac: boolean,
): boolean => {
  if (e.altKey || e.shiftKey) return false;
  if (e.key !== "f" && e.key !== "F") return false;
  return isMac ? e.metaKey === true && e.ctrlKey !== true : e.ctrlKey === true && e.metaKey !== true;
};

// ───────────────────────── 下载 ─────────────────────────

/**
 * 「打开」的扩展名**白名单**（R1-23；原先是开放式黑名单，总会漏项）：只有名单里的常见文档 / 图片 / 文本 / 音视频给「打开」按钮，
 * 其余类型一律只给「在文件夹中显示」。
 * **必须与 electron-app/browser/user-features.mjs 的 OPENABLE_EXTENSIONS 逐项一致**
 * （渲染端据此显示 / 隐藏「打开」按钮，主进程再校验一次；tests/browser-v4-ui.test.ts 钉两边相等）。
 * 刻意不含 svg / html / xml（可含脚本）、docm / xlsm（带宏）、压缩包与一切可执行 / 脚本 / 配置类扩展名；
 * R2-11：也不含 csv（Excel 打开会把页面决定的内容当公式执行，公式注入），原因与 docx / xlsx / pptx 的 MOTW 待核实项见主进程那份的注释。
 */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf",
  "png", "jpg", "jpeg", "gif", "webp",
  "txt", "json", "md", "log",
  "mp3", "wav", "m4a", "mp4", "webm", "mov",
  "docx", "xlsx", "pptx",
]);

/** 文件名 → 小写扩展名；Windows 会忽略末尾的点与空格，先剥掉。没有扩展名返回 "" */
export const fileExtension = (fileName: string): string => {
  const base = (String(fileName ?? "").split(/[\\/]/).pop() ?? "").replace(/[. ]+$/, "");
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
};

/** 能不能给「打开」：已完成 + 扩展名在白名单里（无扩展名、双扩展名伪装、不认识的类型都只给「在文件夹中显示」） */
export const canOpenDownload = (d: Pick<DownloadInfo, "fileName" | "state">): boolean => {
  if (d.state !== "completed") return false;
  const ext = fileExtension(d.fileName);
  return ext !== "" && OPENABLE_EXTENSIONS.has(ext);
};

/** 「在文件夹中显示」：完成的才有稳定的落盘文件；进行中 / 失败的不给 */
export const canRevealDownload = (d: Pick<DownloadInfo, "state">): boolean => d.state === "completed";

export const formatBytes = (n: number | undefined | null): string => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

/** 进度百分比（0–100 整数）；总大小未知（≤0）时 null → UI 画不确定进度 */
export const downloadPercent = (d: Pick<DownloadInfo, "receivedBytes" | "totalBytes">): number | null => {
  if (!(d.totalBytes > 0)) return null;
  return Math.min(100, Math.max(0, Math.round((d.receivedBytes / d.totalBytes) * 100)));
};

/** 一行下载的状态文案（右侧小字） */
export const describeDownloadMeta = (d: DownloadInfo): string => {
  switch (d.state) {
    case "progressing": {
      const pct = downloadPercent(d);
      const got = formatBytes(d.receivedBytes);
      return pct === null ? `下载中 · ${got}` : `下载中 · ${pct}% · ${got}`;
    }
    case "completed":
      return `已完成 · ${formatBytes(d.totalBytes > 0 ? d.totalBytes : d.receivedBytes)}`;
    case "cancelled":
      return "已取消";
    case "interrupted":
      return "下载中断";
    default:
      return "";
  }
};

/** 缺省按空处理：老壳没有 downloads 字段；也丢掉形状不对的条目，渲染不因脏数据崩 */
export const readDownloads = (downloads: unknown): DownloadInfo[] => {
  if (!Array.isArray(downloads)) return [];
  return downloads.filter(
    (d): d is DownloadInfo =>
      !!d && typeof d === "object" && typeof (d as DownloadInfo).id === "number" && typeof (d as DownloadInfo).fileName === "string",
  );
};

export interface DownloadsSummary {
  total: number;
  /** 进行中的条数 */
  active: number;
  /** 进行中下载的合并进度（0–100）；全部总大小未知时 null */
  percent: number | null;
}

/** 工具栏下载按钮用：有下载才出现；进行中显示合并进度 */
export const summarizeDownloads = (downloads: readonly DownloadInfo[]): DownloadsSummary => {
  const active = downloads.filter((d) => d.state === "progressing");
  let got = 0;
  let total = 0;
  for (const d of active) {
    if (d.totalBytes > 0) {
      got += Math.min(d.receivedBytes, d.totalBytes);
      total += d.totalBytes;
    }
  }
  return { total: downloads.length, active: active.length, percent: total > 0 ? Math.round((got / total) * 100) : null };
};

// ───────────────────────── 对话框条 ─────────────────────────

export interface DialogBarModel {
  /** 类型标签：提示框 / 确认框 / 输入框 / 离开确认 */
  typeLabel: string;
  /**
   * 条上的标题（R3-09 ①）：来源 + 类型，如「example.com 的页面提示框」。
   * 对话框条画在应用自己的警告色条里，页面 `prompt("Flowship：会话已过期，请输入 API Key")` 不标来源时用户分不清是谁在说话。
   */
  heading: string;
  /**
   * 同 {@link heading}，但来源主机是完整的（供 Tooltip：窄面板里条上的标题会被 CSS 截断，主域名在末尾，R4 复审 R3-09 / R4-04 ④）。
   * 没有来源时与 heading 相同。
   */
  headingFull: string;
  /** 来源主机（`new URL(url).host`：punycode 后只含 ASCII；只认 http(s)，其余协议 / 解析失败为空串） */
  sourceHost: string;
  message: string;
  showInput: boolean;
  defaultPrompt: string;
  acceptLabel: string;
  cancelLabel: string;
  /** alert 只有「确定」，没有可取消的语义 */
  showCancel: boolean;
}

const DIALOG_TYPE_LABEL: Record<DialogInfo["type"], string> = {
  alert: "提示框",
  confirm: "确认框",
  prompt: "输入框",
  beforeunload: "离开确认",
};

/**
 * 对话框来源主机：只取 `URL.host`（IDN 已转 punycode、userinfo / 路径 / query 都不带），再过 clipOneLine 限长；拿不到返回空串。
 * **只认 http(s)**（R4 复审 R3-09）：主进程下发的 `dialog.url` 是 `safeOriginPath` 的输出，about / data / javascript 这类没有主机的协议
 * 会被 `new URL` 解析出一个「看起来像主机」的片段（`about://blank` → `blank`、`data://text/html,x` → `text`），不能拿来当来源。
 */
export const dialogSourceHost = (url: unknown): string => {
  if (typeof url !== "string" || url === "") return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return clipOneLine(u.host, 60);
  } catch {
    return "";
  }
};

/** 条上标题里显示的主机最多这么多字符：超出时保尾不保头（真正的主域名在末尾，`accounts.google.com.verify.example` 不能显示成 `accounts.google.com.v…`） */
export const DIALOG_HOST_SHOW_MAX = 32;
export const shortHost = (host: string, max = DIALOG_HOST_SHOW_MAX): string =>
  host.length <= max ? host : `…${host.slice(host.length - (max - 1))}`;

/** state.dialog → 对话框条模型；没有对话框（缺省 / null / 形状不对）返回 null */
export const describeDialogBar = (dialog: DialogInfo | null | undefined): DialogBarModel | null => {
  if (!dialog || typeof dialog !== "object") return null;
  const type = dialog.type in DIALOG_TYPE_LABEL ? dialog.type : "alert";
  const message = typeof dialog.message === "string" ? dialog.message : "";
  const sourceHost = dialogSourceHost(dialog.url);
  return {
    typeLabel: DIALOG_TYPE_LABEL[type],
    sourceHost,
    heading: `${sourceHost ? `${shortHost(sourceHost)} 的页面` : "页面"}${DIALOG_TYPE_LABEL[type]}`,
    headingFull: `${sourceHost ? `${sourceHost} 的页面` : "页面"}${DIALOG_TYPE_LABEL[type]}`,
    message: message || (type === "beforeunload" ? "离开此页面可能会丢失未保存的更改" : ""),
    showInput: type === "prompt",
    defaultPrompt: typeof dialog.defaultPrompt === "string" ? dialog.defaultPrompt : "",
    acceptLabel: type === "beforeunload" ? "离开" : "确定",
    cancelLabel: type === "beforeunload" ? "留在此页" : "取消",
    showCancel: type !== "alert",
  };
};

// ───────────────────────── 模拟标签 ─────────────────────────

/** 激活 tab 的模拟摘要（V5 生产，如「iPhone 15 · 暗色」）；缺省 / 空串 / 非字符串 = 没有模拟 */
export const emulationLabelOf = (tab: Pick<TabInfo, "emulation"> | null | undefined): string | null => {
  const e = tab?.emulation;
  return typeof e === "string" && e.trim() !== "" ? e.trim() : null;
};

// ───────────────────────── 设备模拟下的视图适配 ─────────────────────────

/**
 * 缩放适配生效时的整数百分比（如 72）；没缩放 / 非法（非有限数、≤0、≥1）= null。
 * 口径与主进程一致（tab.mjs `#refit`：`Math.round(scale * 100)`，**100 = 不缩放**）：取整后到 100 的
 * （0.995 ≤ s < 1，实际只缩了不到半个百分点）也算没缩放，不显示「适应 100%」（R9-07 ①）。
 * 取整显示：拖面板时比例每帧都在变，百分比整数变了才有必要重绘（主进程也只在整数百分比变化时推状态）。
 */
export const fitScalePercentOf = (tab: Pick<TabInfo, "fitScale"> | null | undefined): number | null => {
  const s = tab?.fitScale;
  if (typeof s !== "number" || !Number.isFinite(s) || s <= 0 || s >= 1) return null;
  const pct = Math.max(1, Math.round(s * 100));
  return pct >= 100 ? null : pct;
};

/** 缩放适配生效时模拟条上的徽标（如「适应 72%」）；没缩放 = null。数字只由 {@link fitScalePercentOf} 一处算出 */
export const fitScaleLabelOf = (tab: Pick<TabInfo, "fitScale"> | null | undefined): string | null => {
  const pct = fitScalePercentOf(tab);
  return pct === null ? null : `适应 ${pct}%`;
};

const isFrac = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * 原生视图被设备模拟收窄后，遮盖占位图要摆的位置（相对占位 div 的百分比，所以不受宿主缩放 / 面板尺寸影响）。
 * 缺省 / 非法（非有限数、负数、宽高 ≤ 0、超出占位 div）= null，调用方退回「铺满占位 div」——宁可拉伸也别把图摆到看不见的地方。
 */
export const viewFitCssOf = (
  fit: ViewFit | null | undefined,
): { left: string; top: string; width: string; height: string } | null => {
  if (!fit) return null;
  const { left, top, width, height } = fit;
  if (!isFrac(left) || !isFrac(top) || !isFrac(width) || !isFrac(height)) return null;
  if (left < 0 || top < 0 || width <= 0 || height <= 0) return null;
  // 浮点误差留一点余量（居中时 left + width 可能是 1.0000000000000002）
  if (left + width > 1.0001 || top + height > 1.0001) return null;
  const pct = (n: number) => `${Number((n * 100).toFixed(3))}%`;
  return { left: pct(left), top: pct(top), width: pct(width), height: pct(height) };
};
