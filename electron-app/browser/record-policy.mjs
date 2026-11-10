/**
 * 增强包 E2 · B7 录制的纯逻辑（无 electron / fs 依赖，全部可单测）。
 *
 * 红线（§15.3）：
 *  - 写盘路径只由主进程生成：`<userData>/data/tasks/<taskId>/browser-recordings/<recId>/frame-NNNN.jpg`，recId 只认固定形状，
 *    任何来自 AI 的 rec_id 都先过 {@link isValidRecId} 再 {@link resolveRecDir} 做路径前缀校验（防目录穿越 / 符号链接名）；
 *  - 上限（帧数 / 时长 / 总字节）到限自动停；保留策略只动本功能生成的子目录；
 *  - 敏感字段：截图通路本身没有像素遮罩（密码框靠浏览器自己的圆点渲染），录制要**比截图更保守**——页面上有可见（或聚焦）的
 *    敏感输入框时该帧不写盘，时间线里记 `redacted-gap`。判定与 snapshot / type / inspect 同一份 `secret-field.mjs`；
 *  - mp4 导出只调固定参数的 ffmpeg（execFile、不经 shell、cwd = 录制目录、输入输出都是相对的固定文件名模式），
 *    所以录制目录路径里有空格 / `%` / 引号都不会变成注入点。
 */
import nodePath from "node:path";
import { FRAME_TAG_FN_SOURCE, SECRET_FIELD_FNS_SOURCE } from "./secret-field.mjs";

export const RECORD_ACTIONS = Object.freeze(["start", "stop", "status", "export", "export_activity"]);
export const EXPORT_FORMATS = Object.freeze(["frames", "mp4", "gif"]);
export const ACTIVITY_FORMATS = Object.freeze(["json", "markdown"]);

export const RECORD_DIR_NAME = "browser-recordings";
export const EXPORT_DIR_NAME = "browser-exports";

/**
 * 默认上限（测试可经 `deps.recordLimits` 缩小）
 * @type {Readonly<{ maxFrames: number, maxMs: number, maxBytes: number, maxFrameBytes: number, keepRecordings: number, maxTotalBytes: number, ffmpegTimeoutMs: number, ffmpegMaxOutputBytes: number, keepExports: number, maxMarkers: number, probeTimeoutMs: number }>}
 */
export const RECORD_LIMITS = Object.freeze({
  maxFrames: 600,
  maxMs: 60_000,
  maxBytes: 150 * 1024 * 1024,
  /** 单帧上限：jpeg 一帧通常 < 500KB；异常大的帧直接丢弃，不让一帧吃掉大半预算 */
  maxFrameBytes: 8 * 1024 * 1024,
  keepRecordings: 5,
  maxTotalBytes: 500 * 1024 * 1024,
  ffmpegTimeoutMs: 120_000,
  ffmpegMaxOutputBytes: 150 * 1024 * 1024,
  keepExports: 20,
  maxMarkers: 500,
  probeTimeoutMs: 600,
});

export const TASK_ID_RE = /^[a-zA-Z0-9_-]{1,200}$/;
/** recId 形状：rec-YYYYMMDD-HHmmss-<6 位 hex>（主进程生成；AI 传来的必须匹配） */
export const REC_ID_RE = /^rec-\d{8}-\d{6}-[0-9a-f]{6}$/;

const pad2 = (n) => String(n).padStart(2, "0");
export const recStamp = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
export const makeRecId = (date, hex6) => `rec-${recStamp(date)}-${String(hex6).toLowerCase().replace(/[^0-9a-f]/g, "0").padEnd(6, "0").slice(0, 6)}`;
export const isValidRecId = (v) => typeof v === "string" && REC_ID_RE.test(v);
export const frameFileName = (n) => `frame-${String(n).padStart(4, "0")}.jpg`;

/** 任务的 browser-recordings 根目录；taskId 不是安全字符 / userData 缺失 → null（绝不拼路径） */
export const recordingsRootFor = (userData, taskId) => {
  if (typeof userData !== "string" || userData === "" || !TASK_ID_RE.test(String(taskId ?? ""))) return null;
  return nodePath.join(userData, "data", "tasks", String(taskId), RECORD_DIR_NAME);
};

export const exportsRootFor = (userData, taskId) => {
  if (typeof userData !== "string" || userData === "" || !TASK_ID_RE.test(String(taskId ?? ""))) return null;
  return nodePath.join(userData, "data", "tasks", String(taskId), EXPORT_DIR_NAME);
};

/**
 * recId → 录制目录。recId 形状不对、或解析后不在 root 之内（前缀校验）→ null。
 * 形状校验已经排除了 `..` / 分隔符；前缀校验是第二道，防 root 本身含符号链接以外的意外（例如调用方传了怪 root）。
 */
export const resolveRecDir = (root, recId) => {
  if (typeof root !== "string" || root === "" || !isValidRecId(recId)) return null;
  const base = nodePath.resolve(root);
  const dir = nodePath.resolve(base, recId);
  if (dir === base || !dir.startsWith(base + nodePath.sep)) return null;
  if (nodePath.dirname(dir) !== base) return null;
  return dir;
};

// ───────────────────────── 参数 ─────────────────────────

/** start 参数的夹取（server 与主进程各判一次）；返回规整后的 { maxFrames, quality, everyNth } */
export const clampStartArgs = ({ maxFrames, quality, everyNth } = {}, limits = RECORD_LIMITS) => {
  const num = (v, lo, hi, d) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return d;
    return Math.min(hi, Math.max(lo, Math.round(v)));
  };
  return {
    maxFrames: num(maxFrames, 1, limits.maxFrames, limits.maxFrames),
    quality: num(quality, 20, 90, 60),
    // 屏幕刷新约 60Hz：默认每 6 帧取 1 帧 ≈ 10fps，600 帧恰好撑满 60 秒
    everyNth: num(everyNth, 1, 60, 6),
  };
};

// ───────────────────────── 上限 / 保留 ─────────────────────────

const REASON_TEXT = Object.freeze({
  max_frames: (l) => `达到帧数上限（${l.maxFrames} 帧）`,
  max_duration: (l) => `达到时长上限（${Math.round(l.maxMs / 1000)} 秒）`,
  max_bytes: (l) => `达到体积上限（${Math.round(l.maxBytes / 1048576)}MB）`,
});

/**
 * 到限判定：返回 null（没到）或 `{ reason, text }`；maxFrames 可被 start 的 max_frames 进一步收紧
 * @param {{ frames: number, bytes: number, elapsedMs: number, maxFrames?: number }} s
 * @param {typeof RECORD_LIMITS} [limits]
 * @returns {{ reason: "max_frames" | "max_duration" | "max_bytes", text: string } | null}
 */
export const evaluateLimits = ({ frames, bytes, elapsedMs, maxFrames }, limits = RECORD_LIMITS) => {
  const effective = { ...limits, maxFrames: Math.min(limits.maxFrames, maxFrames ?? limits.maxFrames) };
  if (frames >= effective.maxFrames) return { reason: "max_frames", text: REASON_TEXT.max_frames(effective) };
  if (elapsedMs >= effective.maxMs) return { reason: "max_duration", text: REASON_TEXT.max_duration(effective) };
  if (bytes >= effective.maxBytes) return { reason: "max_bytes", text: REASON_TEXT.max_bytes(effective) };
  return null;
};

export const STOP_REASON_TEXT = Object.freeze({
  stopped: "AI 主动结束",
  user: "用户在面板上停止",
  max_frames: "达到帧数上限自动停止",
  max_duration: "达到时长上限自动停止",
  max_bytes: "达到体积上限自动停止",
  tab_closed: "标签页关闭",
  session_closed: "浏览器会话结束",
  error: "录制出错中止",
});

/**
 * 清理策略：从既有录制目录里挑出要删的。
 * 只考虑名字匹配 {@link REC_ID_RE} 的条目（别的文件 / 目录——包括用户自己放进去的——一概不动）；
 * 按 mtime 新→旧排序，先留 `keep` 个，再按累计体积不超过 `maxTotalBytes` 截；`protect` 里的（进行中 / 刚结束的）永不选。
 * @param {Array<{ name: string, mtimeMs: number, bytes: number }>} entries
 * @param {{ keep: number, maxTotalBytes: number, protect?: string[] }} opts
 * @returns {string[]} 要删除的目录名（旧的在前）
 */
export const selectRecordingsToPrune = (entries, { keep, maxTotalBytes, protect = [] }) => {
  const prot = new Set(protect);
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && isValidRecId(e.name)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const remove = [];
  let kept = 0;
  let total = 0;
  for (const e of list) {
    if (prot.has(e.name)) {
      kept += 1;
      total += Math.max(0, e.bytes || 0);
      continue;
    }
    const bytes = Math.max(0, e.bytes || 0);
    if (kept >= keep || total + bytes > maxTotalBytes) {
      remove.push(e.name);
      continue;
    }
    kept += 1;
    total += bytes;
  }
  return remove.reverse();
};

// ───────────────────────── 时间线 ─────────────────────────

const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const oneLine = (s, n) => String(s ?? "").replace(CTRL_RE, " ").replace(/\s+/g, " ").trim().slice(0, n);

const NAV_KINDS = new Set(["navigate", "load", "tab_open", "tab_close"]);

/**
 * 活动日志条目的分类：导航（无论是 AI 的 navigate / 刷新还是用户 / 页面自己的跳转，按 kind 判，actor 另存在 marker.actor 里）/
 * AI 动作 / 用户动作 / 其它系统事件。
 */
export const markerTypeOf = (entry) => {
  if (NAV_KINDS.has(String(entry.kind))) return "navigation";
  if (entry.actor === "ai") return "ai-action";
  if (entry.actor === "user") return "user-action";
  return "system";
};

/**
 * 活动日志条目 → 时间线标记（时间对齐到录制起点）。
 * 文字过 `redactText`（主进程文本脱敏，注入式依赖，保持本模块无依赖）、剥控制 / 格式字符、限长；url 只留活动日志已清过的 origin+path。
 * @param {Array<any>} entries
 * @param {{ startedAt: number, endedAt: number, frames: Array<{ n: number, t: number }>, redactText?: (s: string, n: number) => string, redactUrl?: (s: string) => string, max?: number }} ctx
 */
export const entriesToMarkers = (entries, { startedAt, endedAt, frames, redactText = (s, n) => oneLine(s, n), redactUrl = (s) => s, max = RECORD_LIMITS.maxMarkers }) => {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== "object" || typeof e.ts !== "number" || !Number.isFinite(e.ts)) continue;
    if (e.ts < startedAt - 50 || e.ts > endedAt + 2000) continue;
    const t = Math.max(0, Math.min(endedAt - startedAt, e.ts - startedAt));
    out.push({
      t,
      type: markerTypeOf(e),
      actor: e.actor === "ai" || e.actor === "user" ? e.actor : "system",
      kind: oneLine(e.kind, 24),
      text: oneLine(redactText(oneLine(e.summary, 400), 160), 160),
      tabId: oneLine(e.tabId, 24),
      url: oneLine(redactUrl(String(e.url ?? "")), 300),
      frame: frameAt(frames, t),
    });
    if (out.length >= max) break;
  }
  return out;
};

/** 时间 t（毫秒，相对起点）之前最近的一帧序号；之前没有帧 → 0 */
export const frameAt = (frames, t) => {
  let n = 0;
  for (const f of frames) {
    if (f.t <= t) n = f.n;
    else break;
  }
  return n;
};

/**
 * 组装 timeline.json 内容。gaps（redacted-gap）/ userControl（user-control）也并入 markers，按时间排序，方便只读一个数组。
 */
export const buildTimeline = ({ recId, tabId, startedAt, endedAt, stopReason, frames, markers, gaps, userControl, limits, params }) => {
  const merged = [
    ...markers,
    ...gaps.map((g) => ({ t: g.t, endT: g.endT, type: "redacted-gap", kind: "redacted-gap", text: `页面有可见的敏感输入框，期间 ${g.skipped} 个画面未写入（原因：${g.reason}）`, tabId: "", url: "", frame: frameAt(frames, g.t) })),
    ...userControl.map((u) => ({ t: u.t, endT: u.endT, type: "user-control", kind: "user-control", text: "用户接管了浏览器（录制继续，画面里是用户的操作）", tabId: "", url: "", frame: frameAt(frames, u.t) })),
  ].sort((a, b) => a.t - b.t);
  const totalBytes = frames.reduce((s, f) => s + f.bytes, 0);
  return {
    version: 1,
    recId,
    tabId,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    stopReason,
    params,
    limits: { maxFrames: limits.maxFrames, maxMs: limits.maxMs, maxBytes: limits.maxBytes },
    totalBytes,
    frames: frames.map((f) => ({ n: f.n, file: f.file, t: f.t, bytes: f.bytes })),
    markers: merged,
  };
};

/** 时间线摘要（stop / export 的返回值用；不含逐帧列表） */
export const summarizeTimeline = (tl) => {
  const counts = {};
  for (const m of tl.markers) counts[m.type] = (counts[m.type] ?? 0) + 1;
  return {
    recId: tl.recId,
    frames: tl.frames.length,
    durationMs: tl.durationMs,
    totalBytes: tl.totalBytes,
    markerCount: tl.markers.length,
    markerCounts: counts,
    stopReason: tl.stopReason,
  };
};

// ───────────────────────── mp4 / ffmpeg ─────────────────────────

/** 帧率：帧数 / 实际时长，夹在 [1, 30]；没有时长（单帧）→ 2 */
export const framesFps = (frameCount, durationMs) => {
  if (!(frameCount > 1) || !(durationMs > 0)) return 2;
  return Math.min(30, Math.max(1, Math.round(frameCount / (durationMs / 1000))));
};

/**
 * ffmpeg 的固定参数数组：只有两个数值（fps / 体积上限）与一个形如 `.rec-<hex>.tmp.mp4` 的输出名可变，其余全是常量；
 * 输入用 `frame-%04d.jpg` 的相对模式（cwd = 录制目录），所以任何路径字符都进不了参数。
 */
export const buildFfmpegArgs = ({ fps, maxBytes, outName }) => {
  const f = Math.min(30, Math.max(1, Math.floor(Number(fps)) || 2));
  const cap = Math.max(1024, Math.floor(Number(maxBytes)) || RECORD_LIMITS.ffmpegMaxOutputBytes);
  if (!/^\.rec-[0-9a-f]{6,16}\.tmp\.mp4$/.test(String(outName))) throw new Error("非法的输出文件名");
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-framerate",
    String(f),
    "-start_number",
    "1",
    "-i",
    "frame-%04d.jpg",
    // libx264 / yuv420p 要求偶数宽高
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-fs",
    String(cap),
    "-f",
    "mp4",
    String(outName),
  ];
};

/**
 * 在 PATH 里找 ffmpeg 的候选绝对路径（只做字符串工作，是否存在由调用方 `isExecutable` 判）。
 * 相对 / 空的 PATH 项一律跳过：`.` 或空项会让「当前目录里被人放了个 ffmpeg」变成执行目标。
 */
export const ffmpegCandidates = (pathEnv, platform = process.platform) => {
  const sep = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? ["ffmpeg.exe"] : ["ffmpeg"];
  const out = [];
  const seen = new Set();
  for (const raw of String(pathEnv ?? "").split(sep)) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const isAbs = platform === "win32" ? nodePath.win32.isAbsolute(dir) : nodePath.posix.isAbsolute(dir);
    if (!isAbs) continue;
    for (const n of names) {
      const p = platform === "win32" ? nodePath.win32.join(dir, n) : nodePath.posix.join(dir, n);
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
};

// ───────────────────────── 敏感字段探针（页内） ─────────────────────────

/**
 * 页内表达式：当前视口里是否有「可见的敏感输入框」（或聚焦的敏感元素）。返回 'secret' | 'safe' | 'unknown'，附带无法检查的跨域 iframe 数。
 * 规则与 snapshot / type / inspect 完全同源（`SECRET_FIELD_FNS_SOURCE`）；穿过开放 shadow root 与同源 iframe；
 * 跨域 iframe 看不进去（OOPIF 由调用方对子 CDP 会话再跑一遍）；任何异常 / 扫描过大 → 'unknown'（调用方按「暂停写帧」处理）。
 * 只读几何与样式，不写 DOM、不留全局。
 */
export const SECRET_VISIBLE_PROBE_SOURCE = `(function () {
  ${SECRET_FIELD_FNS_SOURCE}
  ${FRAME_TAG_FN_SOURCE}
  try {
    var budget = 100000;
    var opaque = 0;
    /* R6-06：opaque 里「与视口相交（或判断不了）」的那部分——读不进去的框架里可能是可见的验证码 / 显示态密码，调用方必须据此丢帧 */
    var opaqueVisible = 0;
    var found = false;
    var inViewport = function (el, ox, oy, vw, vh) {
      var r = el.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) return false;
      var x = r.left + ox, y = r.top + oy;
      if (x + r.width <= 0 || y + r.height <= 0 || x >= vw || y >= vh) return false;
      var view = el.ownerDocument && el.ownerDocument.defaultView;
      var cs = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
      if (cs && (cs.visibility === 'hidden' || cs.display === 'none')) return false;
      return true;
    };
    var markOpaque = function (el, ox, oy, vw, vh) {
      opaque++;
      var vis = true;
      try { vis = inViewport(el, ox, oy, vw, vh); } catch (e) { vis = true; }
      if (vis) opaqueVisible++;
    };
    var scan = function (root, ox, oy, depth, vw, vh, active) {
      /* 嵌套超过 8 层：没探到最深处，无法判断相交 → 一律按「可见」计 */
      if (depth > 8) { opaque++; opaqueVisible++; return; }
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length && !found; i++) {
        if (--budget < 0) throw new Error('too-big');
        var el = all[i];
        var tag = String(el.localName || el.tagName || '').toLowerCase();
        if (el.shadowRoot) scan(el.shadowRoot, ox, oy, depth + 1, vw, vh, el.shadowRoot.activeElement);
        /* R6-36：iframe / frame / object / embed / fencedframe——contentDocument 读得进才下钻，读不进（含 embed / fencedframe）计 opaque */
        if (isFrameLikeTag(tag)) {
          var d = null;
          try { d = el.contentDocument; } catch (e) { d = null; }
          if (d && d.documentElement) {
            var fr = el.getBoundingClientRect();
            scan(d, ox + fr.left, oy + fr.top, depth + 1, vw, vh, d.activeElement);
          } else { markOpaque(el, ox, oy, vw, vh); }
          continue;
        }
        if (tag !== 'input' && tag !== 'textarea') continue;
        if (!isSecretInfo(readSecretInfo(el))) continue;
        if (el === active || inViewport(el, ox, oy, vw, vh)) { found = true; }
      }
    };
    var de = document.documentElement;
    if (!de) return { state: 'safe', opaque: 0, opaqueVisible: 0 };
    scan(document, 0, 0, 0, window.innerWidth, window.innerHeight, document.activeElement);
    return { state: found ? 'secret' : 'safe', opaque: opaque, opaqueVisible: opaqueVisible };
  } catch (e) { return { state: 'unknown', opaque: 0, opaqueVisible: 0 }; }
})()`;

/**
 * 探针结果里有没有「读不进去、且与视口相交（或判断不了相交 / 嵌套过深）的内嵌框架」（R6-06）。
 * `opaqueVisible` 缺失（形状不对）按 0 处理——形状不对本来就会在 readProbeVerdict 里落成 unknown。
 */
export const probeHasVisibleOpaque = (res) => {
  const v = res?.result?.value;
  return !!v && typeof v === "object" && Number(v.opaqueVisible) > 0;
};

/**
 * 把 Runtime.evaluate 的结果规整成 'secret' | 'safe' | 'unknown'（形状不对一律 unknown = fail-closed）。
 * R6-06：state 是 safe 但有「可见且读不进去」的框架（沙箱 / 同站异源 iframe、嵌套 > 8 层）→ unknown：里面的验证码 / 显示态密码框我们看不见，
 * 该帧不能写盘（以前 opaque 被算出来却没人用，等于按 safe 放行）。已确认 secret 的仍是 secret。
 */
export const readProbeVerdict = (res) => {
  const v = res?.result?.value;
  if (res?.exceptionDetails || !v || typeof v !== "object") return "unknown";
  if (v.state === "secret") return "secret";
  if (v.state === "safe") return probeHasVisibleOpaque(res) ? "unknown" : "safe";
  return "unknown";
};

/** 多个会话（主 + OOPIF 子会话）的探针结论合并：任一 secret → secret；主会话 unknown → unknown；子会话 unknown 忽略（子会话随时会销毁） */
export const mergeVerdicts = (main, children) => {
  if (main === "secret" || (children ?? []).includes("secret")) return "secret";
  if (main !== "safe") return "unknown";
  return "safe";
};

// ───────────────────────── 活动日志导出 ─────────────────────────

const mdEscape = (s) => String(s).replace(/([\\`*_{}[\]()#+!|<>~])/g, "\\$1");
const isoOf = (ts) => {
  try {
    return new Date(ts).toISOString();
  } catch {
    return "";
  }
};

/** 活动日志条目 → 导出行（脱敏 + 剥控制字符 + 限长）。redactText / redactUrl 由调用方注入（主进程 text-redact / net-detail） */
export const toExportEntry = (e, { redactText, redactUrl }) => ({
  time: isoOf(e.ts),
  actor: e.actor === "ai" || e.actor === "user" || e.actor === "system" ? e.actor : "system",
  kind: oneLine(e.kind, 24),
  text: oneLine(redactText(oneLine(e.summary, 400), 200), 200),
  tab: oneLine(e.tabId, 24),
  url: oneLine(redactUrl(String(e.url ?? "")), 300),
});

export const renderActivityExport = (rows, format, { taskLabel = "" } = {}) => {
  if (format === "markdown") {
    const ACTOR = { ai: "AI", user: "用户", system: "系统" };
    const lines = ["# 浏览器活动日志", "", `导出时间：${isoOf(Date.now())}${taskLabel ? `　任务：${oneLine(taskLabel, 60)}` : ""}`, `共 ${rows.length} 条（已脱敏：凭据 / URL 查询串 / 密码框输入内容不会出现在这里）。`, ""];
    for (const r of rows) {
      lines.push(`- \`${r.time}\` **${ACTOR[r.actor]}**〔${mdEscape(r.kind)}〕${mdEscape(r.text)}${r.tab ? `（标签 ${mdEscape(r.tab)}）` : ""}${r.url ? ` — ${mdEscape(r.url)}` : ""}`);
    }
    return `${lines.join("\n")}\n`;
  }
  return `${JSON.stringify({ version: 1, exportedAt: isoOf(Date.now()), count: rows.length, entries: rows }, null, 2)}\n`;
};
