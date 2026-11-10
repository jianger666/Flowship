/**
 * 增强包 E2 · B1 HAR 1.2 导出（契约 §15.2 S3）——纯逻辑 + 可注入 fs 的落盘函数，无 electron / CDP 依赖，可直接单测。
 *
 * # 红线（契约 §15.3）
 *  - **默认脱敏、不提供明文选项**：URL / queryString（`redactUrlSecrets`）、请求头 / 响应头（`redactHeaders` + 每个值再过一遍 `text-redact`）、
 *    postData / response body（`text-redact`，与 server 渲染 body 用的 `redact-text.ts` 逐字一致）。cookie 数组恒为空（Cookie / Set-Cookie 头值本来就整条隐藏）；
 *  - body 受 `networkBodyRead` 开关约束：开关由主进程判（ops/net-rules.mjs），关着就不取、不含 body（本模块只管「给不给」由调用方传 `includeBodies`）；
 *  - 落盘：文件名由主进程生成（时间戳 + 净化后的主机名，不接受调用方传名）、文件 0600 / 目录 0700（`wx` 临时文件 + rename，不跟随符号链接）、
 *    目录只在 `<userData>/data/tasks/<taskId>/browser-har/`（与 ops/env.mjs `taskDataAllowDirs`、storage-policy.mjs `stateDirFor` 同口径）、
 *    总大小有上限（超出从最旧的条目开始丢并注明）、旧文件自动收尾（保留最近 {@link HAR_KEEP_FILES} 个、最长 {@link HAR_MAX_AGE_MS}）。
 *
 * # 与 HAR 1.2 的差异
 *  浏览器侧只记录了总耗时：`timings` 里只有 `wait` = 总耗时，其余为 -1 / 0；`httpVersion` 固定 "unknown"；`headersSize` / `bodySize` 为 -1（未知）。
 *  `_` 开头是自定义扩展字段（HAR 规范允许）：`_resourceType` / `_id` / `_ruled` / `_cache` / `_fromServiceWorker` / `_initiator` / `_error` / `_webSocketMessages` / `_serverSentEvents`。
 */
import nodeFs from "node:fs";
import { STATUS_CODES } from "node:http";
import nodePath from "node:path";
import { isTextMime, NET_BODY_MAX, redactHeaders, redactUrlSecrets } from "./net-detail.mjs";
import { opcodeName } from "./net-streams.mjs";
import { redactAndClip } from "./text-redact.mjs";

export const HAR_DIR_NAME = "browser-har";
/** HAR 文件体积上限（字节）：500 条 × 带 body 的条目通常 < 5MB，10MB 给足余量又不至于撑爆磁盘 / 一次读不完 */
export const HAR_MAX_BYTES = 10 * 1024 * 1024;
export const HAR_KEEP_FILES = 20;
export const HAR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HEADER_VALUE_MAX = 2000;
const QUERY_PAIRS_MAX = 100;

const TASK_ID_RE = /^[a-zA-Z0-9_-]{1,200}$/;
const unixMode = () => process.platform !== "win32";
const byteLen = (s) => Buffer.byteLength(s, "utf8");

/** 任务的 browser-har 目录；taskId 不是安全字符 / userData 缺失 → null（绝不拼路径） */
export const harDirFor = (userData, taskId) => {
  if (typeof userData !== "string" || userData === "" || !TASK_ID_RE.test(String(taskId ?? ""))) return null;
  return nodePath.join(userData, "data", "tasks", String(taskId), HAR_DIR_NAME);
};

const pad2 = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;

/** 文件名主体：`net-YYYYMMDD-HHmmss[-主机名]`；主机名只留 `[a-z0-9.-]`（≤40）。扩展名与去重后缀由 {@link writeHarFile} 加 */
export const harBaseName = (now, url) => {
  let host = "";
  try {
    host = new URL(String(url)).hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "").replace(/^[.-]+|[.-]+$/g, "").slice(0, 40);
  } catch {
    host = "";
  }
  return `net-${stamp(now)}${host ? `-${host}` : ""}`;
};

// ───────────────────────── 条目转换 ─────────────────────────

const iso = (ms) => {
  const d = new Date(Number.isFinite(ms) ? ms : 0);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
};

const redactValue = (v) => redactAndClip(String(v ?? ""), HEADER_VALUE_MAX).text;

/** 头 → HAR `[{name, value}]`：敏感头整条隐藏（redactHeaders），其余值再过一遍文本脱敏（`X-Custom: Bearer xxx` 这类头名看不出来的） */
const harHeaders = (headers) =>
  Object.entries(redactHeaders(headers)).map(([name, value]) => ({ name: String(name).slice(0, 200), value: redactValue(value) }));

const harQueryString = (redactedUrl) => {
  try {
    const out = [];
    for (const [name, value] of new URL(redactedUrl).searchParams) {
      if (out.length >= QUERY_PAIRS_MAX) break;
      out.push({ name: name.slice(0, 200), value: redactValue(value) });
    }
    return out;
  } catch {
    return [];
  }
};

const headerOf = (headers, name) => {
  const k = Object.keys(headers ?? {}).find((x) => x.toLowerCase() === name);
  return k === undefined ? "" : String(headers[k]);
};

/**
 * 一条网络条目 → HAR entry。`body` 只在调用方已确认 `networkBodyRead` 开启时才传：
 * `{ requestText?: string, response?: { ok, body?, base64Encoded?, reason? } }`。
 * @param {{ entry: any, detail: any, body?: object, streamFrames?: any }} p
 */
export const buildHarEntry = ({ entry, detail, body, streamFrames }) => {
  const rawUrl = String(entry.url ?? "");
  const urlTruncated = rawUrl.endsWith("…");
  const url = redactUrlSecrets(urlTruncated ? rawUrl.slice(0, -1) : rawUrl);
  const reqHeaders = detail?.requestHeaders ?? {};
  const resHeaders = detail?.responseHeaders ?? {};
  const status = typeof entry.status === "number" ? entry.status : 0;
  const duration = typeof entry.durationMs === "number" ? Math.max(0, entry.durationMs) : 0;
  const mimeType = String(detail?.mimeType ?? "").slice(0, 200);

  const request = {
    method: String(entry.method ?? "GET").slice(0, 20),
    url,
    httpVersion: "unknown",
    cookies: [],
    headers: harHeaders(reqHeaders),
    queryString: harQueryString(url),
    headersSize: -1,
    bodySize: -1,
  };
  if (body && typeof body.requestText === "string" && body.requestText !== "") {
    request.postData = { mimeType: redactValue(headerOf(reqHeaders, "content-type")), text: redactAndClip(body.requestText, NET_BODY_MAX).text };
  }

  const content = { size: 0, mimeType };
  if (body?.response) {
    const r = body.response;
    if (r.ok !== true) {
      content.comment = redactValue(r.reason || "响应体不可用");
    } else if (!isTextMime(mimeType)) {
      content.comment = "非文本类型的响应体不导出";
    } else {
      let text = null;
      try {
        text = r.base64Encoded === true ? Buffer.from(String(r.body ?? ""), "base64").toString("utf8") : String(r.body ?? "");
      } catch {
        text = null;
      }
      if (text === null) {
        content.comment = "响应体解码失败";
      } else {
        const c = redactAndClip(text, NET_BODY_MAX);
        content.size = text.length;
        content.text = c.text;
        if (c.truncated) content.comment = `响应体过长，已截断到 ${NET_BODY_MAX} 字符（脱敏后）`;
      }
    }
  }

  const location = headerOf(resHeaders, "location");
  const response = {
    status,
    statusText: STATUS_CODES[status] ?? "",
    httpVersion: "unknown",
    cookies: [],
    headers: harHeaders(resHeaders),
    content,
    redirectURL: location ? redactValue(redactUrlSecrets(location)) : "",
    headersSize: -1,
    bodySize: -1,
  };
  if (typeof entry.errorText === "string" && entry.errorText !== "") response._error = redactValue(entry.errorText);

  const harEntry = {
    startedDateTime: iso(entry.ts),
    time: duration,
    request,
    response,
    cache: {},
    timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: duration, receive: 0 },
    _id: entry.id,
    _resourceType: String(entry.type ?? "Other"),
  };
  if (urlTruncated) harEntry._urlTruncated = true;
  if (entry.ruled) harEntry._ruled = String(entry.ruled);
  if (entry.cache) harEntry._cache = String(entry.cache);
  if (entry.fromServiceWorker) harEntry._fromServiceWorker = true;
  if (entry.initiator) harEntry._initiator = { type: entry.initiator.type, stack: entry.initiator.stack.map((s) => redactAndClip(redactUrlSecrets(s), 300).text) };
  if (streamFrames && Array.isArray(streamFrames.frames)) {
    const includeText = body !== undefined;
    if (streamFrames.kind === "websocket") {
      harEntry._webSocketMessages = streamFrames.frames.map((f) => ({
        type: f.dir === "sent" ? "send" : "receive",
        time: (Number.isFinite(f.ts) ? f.ts : 0) / 1000,
        opcode: f.opcode ?? 1,
        opName: opcodeName(f.opcode ?? 1),
        length: f.length,
        data: includeText && typeof f.text === "string" ? f.text : "",
      }));
    } else {
      harEntry._serverSentEvents = streamFrames.frames.map((f) => ({
        time: (Number.isFinite(f.ts) ? f.ts : 0) / 1000,
        ...(f.event ? { event: f.event } : {}),
        ...(f.eventId ? { id: f.eventId } : {}),
        length: f.length,
        data: includeText && typeof f.text === "string" ? f.text : "",
      }));
    }
  }
  return harEntry;
};

/**
 * 组装整份 HAR，并保证序列化后 ≤ maxBytes：超出时从**最旧**的条目开始丢（最近的请求最有价值），在 `log.comment` 注明。
 * @param {{ entries: any[], maxBytes?: number, comment?: string, creatorVersion?: string }} p
 * @returns {{ har: object, text: string, bytes: number, kept: number, omitted: number }}
 */
export const buildHar = ({ entries, maxBytes = HAR_MAX_BYTES, comment, creatorVersion = "1" }) => {
  const make = (list, omitted) => {
    const notes = [comment ?? "Flowship 内置浏览器导出：URL / 头 / body 已按脱敏规则处理（凭据以 [已隐藏] 代替），cookie 不导出"];
    if (omitted > 0) notes.push(`文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限，已丢弃最旧的 ${omitted} 条请求`);
    return {
      log: {
        version: "1.2",
        creator: { name: "Flowship Browser", version: creatorVersion },
        browser: { name: "Chromium (Electron)", version: String(process.versions?.chrome ?? "unknown") },
        entries: list,
        comment: notes.join("；"),
      },
    };
  };
  // 先按各条目大小从最新往旧累加，估出能装下多少；再用整体序列化结果兜底校验（元数据开销）
  const sizes = entries.map((e) => byteLen(JSON.stringify(e)) + 1);
  let keepFrom = entries.length;
  let total = 2048;
  while (keepFrom > 0 && total + sizes[keepFrom - 1] <= maxBytes) {
    keepFrom -= 1;
    total += sizes[keepFrom];
  }
  if (keepFrom === entries.length && entries.length > 0) keepFrom = entries.length - 1; // 单条就超限：至少留最新一条（它的 body 已被 NET_BODY_MAX 约束，实际不会发生）
  let har = make(entries.slice(keepFrom), keepFrom);
  let text = JSON.stringify(har);
  while (byteLen(text) > maxBytes && keepFrom < entries.length - 1) {
    keepFrom += Math.max(1, Math.ceil((entries.length - keepFrom) / 10));
    keepFrom = Math.min(keepFrom, entries.length - 1);
    har = make(entries.slice(keepFrom), keepFrom);
    text = JSON.stringify(har);
  }
  return { har, text, bytes: byteLen(text), kept: har.log.entries.length, omitted: keepFrom };
};

// ───────────────────────── 落盘（fs 可注入） ─────────────────────────

const ensureHarDir = (fs, dir) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("browser-har 不是普通目录（符号链接或文件），拒绝使用");
  if (unixMode()) fs.chmodSync(dir, 0o700);
};

/** 清理旧 HAR：只动目录里的普通 `.har` 文件；超过 keep 个（保留最新的）或比 maxAgeMs 旧的删掉。返回删除个数 */
export const pruneHarDir = ({ fs = nodeFs, dir, keep = HAR_KEEP_FILES, maxAgeMs = HAR_MAX_AGE_MS, now = Date.now() }) => {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const files = [];
  for (const n of names) {
    if (!n.endsWith(".har")) continue;
    try {
      const st = fs.lstatSync(nodePath.join(dir, n));
      if (st.isFile()) files.push({ n, t: st.mtimeMs });
    } catch {
      /* 刚被删 */
    }
  }
  files.sort((a, b) => b.t - a.t);
  let removed = 0;
  files.forEach((f, i) => {
    if (i < keep && now - f.t <= maxAgeMs) return;
    try {
      fs.unlinkSync(nodePath.join(dir, f.n));
      removed += 1;
    } catch {
      /* 删不掉下次再说 */
    }
  });
  return removed;
};

/**
 * 写 HAR：临时文件（0600、`wx`）→ rename 到 `<dir>/<base>[-N].har`。目标已存在就加 `-2` `-3` …（不覆盖别的导出）。
 * rename 替换的是目录项本身，不会跟随目标处的符号链接。返回 { file, path, bytes }。
 */
export const writeHarFile = ({ fs = nodeFs, dir, base, text, now = Date.now(), maxBytes = HAR_MAX_BYTES }) => {
  const bytes = byteLen(text);
  if (bytes > maxBytes) throw new Error(`HAR 内容 ${Math.round(bytes / 1024)}KB 超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
  ensureHarDir(fs, dir);
  pruneHarDir({ fs, dir, now });
  let file = `${base}.har`;
  for (let i = 2; i < 100; i += 1) {
    try {
      fs.lstatSync(nodePath.join(dir, file));
    } catch {
      break; // 不存在：就用它
    }
    file = `${base}-${i}.har`;
  }
  const finalPath = nodePath.join(dir, file);
  const tmp = nodePath.join(dir, `.${base}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    if (unixMode()) fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, finalPath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清不掉留给 prune */
    }
    throw err;
  }
  return { file, path: finalPath, bytes };
};
