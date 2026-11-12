/**
 * 增强包 E2 · B1 网络增强的 server 渲染（契约 §15.2 S3）：`browser_network` 的新字段（规则标记 / 缓存命中 / Service Worker / 发起者 / WebSocket·SSE 帧）
 * 与 `export_har` 的结果。独立成文件，tools.ts 里只留几行接线，避免和别的切片在同一块代码里互相踩。
 *
 * # 不可信包装（契约 §15.3）
 * 条目里的 URL / 发起者栈 / 帧负载全是页面数据：
 *  · 进「可信行」的只有形状受限的字段（枚举映射成固定中文、有限整数），任何字符串都先过 {@link safeEnum} / {@link safeInt}；
 *  · 其余字符串一律「先 `redactSensitiveText`、再截断」（先截会把 JWT / `Bearer xxx` 劈成两段漏过匹配），然后由调用方放进 `b.untrusted(...)` 块。
 *  主进程在帧入缓冲前已经脱敏过一遍（`text-redact.mjs` 与 `redact-text.ts` 逐字一致），这里是第二道。
 *
 * 零依赖于 tools.ts（tools.ts import 本文件，反过来会成环）。
 */
import type { ToolResultBuilder } from "./content";
import { redactSensitiveText } from "./redact-text";

const clipEntry = (s: unknown, n: number): string => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
/** 页面来源字符串：先脱敏后截断 */
const clipRedacted = (s: unknown, n: number): string => clipEntry(redactSensitiveText(String(s ?? "")), n);

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** 有限整数 → 字符串；其余返回空串（进可信行用） */
export const safeInt = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(Math.trunc(v)) : "");

/** 值必须在白名单里才原样返回，否则 "?"（进可信行用：不让任意文字借可信行进来） */
const safeEnum = (v: unknown, allowed: readonly string[]): string => (typeof v === "string" && allowed.includes(v) ? v : "?");

export const RULED_VALUES = ["block", "fail", "mock", "delay", "headers", "mock-refused"] as const;
const RULED_ZH: Record<string, string> = {
  block: "被规则屏蔽",
  fail: "被规则置为失败",
  mock: "被规则模拟",
  delay: "被规则延迟",
  headers: "被规则加了请求头",
  // R14：命中了 mock 规则，但请求「带请求体且无法确认同源」——对它 fulfill 会让 Chromium 崩溃，系统改成了让请求失败（没有放行真请求）
  "mock-refused": "mock被安全拒绝(跨源带体请求不可模拟,请求已失败)",
};
export const CACHE_VALUES = ["fromMemoryCache", "fromDiskCache"] as const;
const CACHE_ZH: Record<string, string> = { fromMemoryCache: "内存缓存命中", fromDiskCache: "磁盘缓存命中" };

export interface NetInitiatorInfo {
  type?: string;
  stack?: string[];
}

/** 条目 / 详情里 B1 新增的字段（都可缺省：老壳没有） */
export interface NetworkExtras {
  ruled?: string;
  cache?: string;
  fromServiceWorker?: boolean;
  initiator?: NetInitiatorInfo;
  frameCount?: number;
  closed?: boolean;
  framesEvicted?: boolean;
}

/** 一条请求在列表行里的标记串（固定中文 + 数字，不含页面文字）：` ⚑被规则模拟 内存缓存命中 SW 帧12 已关闭` */
export const entryFlags = (e: NetworkExtras): string => {
  const parts: string[] = [];
  if (e.ruled) parts.push(`⚑${RULED_ZH[safeEnum(e.ruled, RULED_VALUES)] ?? "被规则处理"}`);
  if (e.cache) parts.push(CACHE_ZH[safeEnum(e.cache, CACHE_VALUES)] ?? "缓存命中");
  if (e.fromServiceWorker === true) parts.push("SW 应答");
  if (typeof e.frameCount === "number" && Number.isFinite(e.frameCount)) parts.push(`帧${safeInt(e.frameCount)}`);
  if (e.closed === true) parts.push("已关闭");
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
};

/** 发起者栈的第一帧（列表行末尾用）；只对 XHR / Fetch / WebSocket / EventSource 显示，其它类型（图片 / 样式 …）太吵 */
export const initiatorTail = (e: NetworkExtras & { type?: string }): string => {
  if (!["XHR", "Fetch", "WebSocket", "EventSource"].includes(String(e.type))) return "";
  const top = Array.isArray(e.initiator?.stack) ? e.initiator?.stack[0] : undefined;
  return typeof top === "string" && top !== "" ? ` ← ${clipRedacted(top, 160)}` : "";
};

/** 详情里的发起者栈：每帧一行（调用方放进 untrusted 块） */
export const initiatorLines = (i: NetInitiatorInfo | undefined): string[] => {
  if (!i || !Array.isArray(i.stack) || i.stack.length === 0) return [];
  const type = /^[A-Za-z]{1,20}$/.test(String(i.type)) ? String(i.type) : "?";
  return [`发起者（${type}）：`, ...i.stack.slice(0, 3).map((s) => `  ${clipRedacted(s, 240)}`)];
};

// ───────────────────────── WebSocket / SSE 帧 ─────────────────────────

export interface StreamFrameItem {
  dir?: string;
  tMs?: number;
  length?: number;
  opcode?: number;
  opName?: string;
  binary?: boolean;
  event?: string;
  eventId?: string;
  text?: string;
  truncated?: boolean;
}

export interface StreamFramesInfo {
  kind?: string;
  total?: number;
  dropped?: number;
  closed?: boolean;
  textIncluded?: boolean;
  note?: string;
  unavailableReason?: string;
  items?: StreamFrameItem[];
}

const DIR_ZH: Record<string, string> = { sent: "→ 发送", received: "← 接收", event: "◆ 事件" };
const OP_NAMES = ["continuation", "text", "binary", "close", "ping", "pong"] as const;

/** 帧列表 → 行（放进 untrusted 块；整块之后还会再整体脱敏一遍） */
export const streamFrameLines = (f: StreamFramesInfo | undefined): string[] => {
  if (!f) return [];
  if (f.unavailableReason) return [`帧不可用：${clipRedacted(f.unavailableReason, 300)}`];
  const items = Array.isArray(f.items) ? f.items : [];
  const kind = f.kind === "sse" ? "SSE 事件" : "WebSocket 帧";
  const head = `${kind}：共 ${safeInt(f.total) || items.length} 条，下面是最近 ${items.length} 条${f.dropped ? `（更早的 ${safeInt(f.dropped)} 条已被挤出缓冲）` : ""}${f.closed ? "，连接已关闭" : ""}：`;
  const lines = [head];
  for (const it of items) {
    if (!isRecord(it)) continue;
    const dir = DIR_ZH[String(it.dir)] ?? "?";
    const op = it.opName && (OP_NAMES as readonly string[]).includes(String(it.opName)) ? ` ${it.opName}` : "";
    const ev = it.event ? ` event=${clipRedacted(it.event, 60)}` : "";
    const id = it.eventId ? ` id=${clipRedacted(it.eventId, 60)}` : "";
    const len = typeof it.length === "number" ? ` ${safeInt(it.length)}${it.binary ? " 字节" : " 字符"}` : "";
    const body = typeof it.text === "string" ? `${it.truncated ? "（已截断）" : ""} ${clipRedacted(it.text, 600)}` : "";
    lines.push(`  [+${safeInt(it.tMs) || 0}ms] ${dir}${op}${ev}${id}${len}${body}`);
  }
  if (f.note) lines.push(clipRedacted(f.note, 200));
  return lines;
};

// ───────────────────────── 列表尾部 / HAR 结果 ─────────────────────────

/** 列表结果的游标说明（只含数字）：符合条件的总数、下一次增量查询该传的 since_id */
export const listCursorLine = (r: { matched?: number; hasMore?: boolean; lastId?: number }, shown: number, usedSince: boolean): string => {
  const parts: string[] = [];
  if (typeof r.matched === "number" && r.matched > shown) parts.push(`符合条件的共 ${safeInt(r.matched)} 条，这里只列了${usedSince ? "最早" : "最近"} ${shown} 条`);
  if (r.hasMore) parts.push("后面还有更多");
  if (typeof r.lastId === "number" && r.lastId > 0) parts.push(`增量查询请用 since_id=${safeInt(r.lastId)}`);
  return parts.join("；");
};

export interface HarExportResult {
  tabId?: string;
  path?: string;
  file?: string;
  entries?: number;
  omitted?: number;
  truncated?: boolean;
  bytes?: number;
  redacted?: boolean;
  bodiesIncluded?: boolean;
  bodiesDisabled?: boolean;
  bodiesSkipped?: number;
}

/** export_har 的结果文案：固定话术 + 数字；路径是主进程生成的，仍按内联不可信包装（里面有用户目录名） */
export const renderHarExport = (r: HarExportResult, b: ToolResultBuilder, wrapInline: (s: string) => string): void => {
  const kb = typeof r.bytes === "number" ? Math.max(1, Math.round(r.bytes / 1024)) : 0;
  b.trusted(
    `已导出 HAR 1.2：${safeInt(r.entries) || "0"} 条请求${kb ? `，约 ${kb}KB` : ""}。URL / 头 / body 已按脱敏规则处理（凭据以 [已隐藏] 代替），cookie 不导出。` +
      (r.truncated ? `文件超过大小上限，已丢弃最旧的 ${safeInt(r.omitted) || "若干"} 条。` : "") +
      (r.bodiesIncluded ? "已包含请求 / 响应体（文本类，各 ≤20000 字符）。" : r.bodiesDisabled ? "用户在设置里关了「允许 AI 读取网络响应内容」，所以没有包含请求 / 响应体。" : "没有包含请求 / 响应体。") +
      (r.bodiesSkipped ? `有 ${safeInt(r.bodiesSkipped)} 条因导出时间预算用尽没取响应体。` : ""),
  );
  if (r.path) {
    b.trusted(`文件：${wrapInline(clipEntry(r.path, 300))}（只在本任务目录里；可用文件类工具读取，用完不需要手动清理，系统会自动保留最近 20 个）。`).markUntrusted();
  }
};
