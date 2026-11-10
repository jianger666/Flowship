/**
 * V2 读取与检查类新增 op：read / inspect / network_detail / save（契约 §14.1）。
 * `network` 的 id 字段增强在 tab.mjs 的网络环形缓冲 / index.mjs 的 opNetwork 里；纯逻辑见 ../page-read.mjs、../net-detail.mjs。
 *
 * 四个都是**感知类**：不走 runAction（不受 USER_CONTROL 限制、不上输入锁、不抢控制权）——用户接管期间 AI 仍能「看」。
 * save 虽然写盘，但只读页面、不改页面，所以同样属于感知类（契约 §14.1），它自己往活动日志记一条 AI 条目（§14.5-3）。
 *
 * 页面内容读取走**隔离世界**（见 page-read.mjs 顶部说明）；network_detail 的 body 由独立开关 config.networkBodyRead 管（A7 拆分，原先借用 evaluate 总闸）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { assembleNetworkDetail } from "../net-detail.mjs";
import { assembleStreamDetail } from "../net-streams.mjs";
import { assertBase64WithinCap, assertBytesWithinCap, PDF_HINT, PDF_MAX_BYTES } from "../output-caps.mjs";
import { buildElectronPdfOptions, buildPrintToPdfParams, parsePdfOptions } from "../pdf-options.mjs";
import {
  asExpression,
  buildInspectScript,
  buildReadScript,
  clipValue,
  DEFAULT_INSPECT_INCLUDE,
  INSPECT_HTML_MAX,
  INSPECT_INCLUDES,
  INSPECT_VALUE_MAX,
  MAX_STYLE_PROPS,
  normalizeReadOptions,
} from "../page-read.mjs";
import { collectInspectExtras, INSPECT_EXTRA_INCLUDES } from "../inspect-extra.mjs";
import { redactHtmlInputValues } from "../picker.mjs";
import { isSecretInfo } from "../secret-field.mjs";
import { BrowserError } from "../server-channel.mjs";

export const OPS = Object.freeze(["read", "inspect", "network_detail", "save"]);

export const SAVE_KINDS = Object.freeze(["pdf", "screenshot", "html"]);
const SAVE_EXT = Object.freeze({ pdf: "pdf", screenshot: "png", html: "html" });
/** html 落盘上限（契约：≤ 20MB，超了 BAD_ARGS） */
export const SAVE_HTML_MAX_BYTES = 20 * 1024 * 1024;
/** 落盘子目录：和浏览器的普通下载（直接放下载目录）分开，用户一眼能认出哪些是 AI 存的 */
export const SAVE_SUBDIR = "Flowship-browser";
/**
 * 文件名「主体」的 UTF-8 **字节**上限（R1-22）。旧版按码点（80 个）截：80 个汉字 = 240 字节，再加 16 字节时间前缀与扩展名就超过
 * APFS / ext4 单个文件名 255 字节的上限，写盘抛 ENAMETOOLONG。
 * 预算：时间前缀 `YYYYMMDD-HHmmss-` 16 + 主体 ≤120 + 去重后缀 `-99` 3 + `.html` 5 = 144 字节，距 255 留足余量。
 */
export const SAVE_NAME_MAX_BYTES = 120;
/** 单个文件名（含时间前缀、扩展名、去重后缀）的字节上限：macOS APFS / Linux ext4 / Windows NTFS（255 UTF-16 单元，字节更严）都过得去 */
export const FILE_NAME_MAX_BYTES = 255;
/** 读页面用的隔离世界名：与录制器的世界（flowship）分开，互不污染 */
const READ_WORLD_NAME = "flowship-read";

// ───────────────────────── 纯函数（有单测） ─────────────────────────

/** 字素簇切分器（Node ≥16 / Electron 都有 Intl.Segmenter）；缺失时退回按码点切 */
const graphemeSegmenter = typeof Intl?.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * 按 UTF-8 字节数截断（R1-22）：只在**字素簇**边界上切，不会劈开代理对（4 字节字符）、组合字符序列（`e` + U+0301）
 * 或 emoji ZWJ 序列；结果的字节数一定 ≤ maxBytes（第一个字素簇就超限时返回空串）。
 * @param {unknown} s
 * @param {number} maxBytes
 */
export const truncateUtf8 = (s, maxBytes) => {
  const str = String(s ?? "");
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  const units = graphemeSegmenter ? Array.from(graphemeSegmenter.segment(str), (x) => x.segment) : Array.from(str);
  let out = "";
  let bytes = 0;
  for (const u of units) {
    const n = Buffer.byteLength(u, "utf8");
    if (bytes + n > maxBytes) break;
    out += u;
    bytes += n;
  }
  return out;
};

/**
 * 文件名清洗（契约 §14.1）：只留字母 / 数字（含中文）与 `._- ` 空格，其余换成 `_`；
 * 不许以 `.` 开头（隐藏文件 / `..`）；主体 ≤120 **字节**（UTF-8，按字素簇截，不劈代理对 / 组合字符，见 {@link truncateUtf8}）；
 * 清洗后为空回落 `page`。
 * 路径分隔符、控制字符、NUL、引号冒号这类在任何平台上都危险的字符统统落在「其余」里。
 */
export const sanitizeFileName = (raw, maxBytes = SAVE_NAME_MAX_BYTES) => {
  let s = String(raw ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._\- ]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/_{2,}/g, "_");
  s = truncateUtf8(s, maxBytes);
  s = s.replace(/^[.\s_-]+/, "").replace(/[.\s_-]+$/, "");
  return s || "page";
};

const pad2 = (n) => String(n).padStart(2, "0");

/** `YYYYMMDD-HHmmss`（本地时间；now 可注入便于单测） */
export const formatStamp = (d = new Date()) =>
  `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;

/**
 * 文件名的「主体」来源：nameHint 优先，其次页面标题，再次主机名，最后 page
 * @param {{ nameHint?: string, title?: string, url?: string }} p
 */
export const pickBaseName = ({ nameHint, title, url }) => {
  const hint = typeof nameHint === "string" ? nameHint.trim() : "";
  if (hint) return sanitizeFileName(hint);
  const t = typeof title === "string" ? title.trim() : "";
  if (t) return sanitizeFileName(t);
  try {
    return sanitizeFileName(new URL(String(url)).hostname);
  } catch {
    return "page";
  }
};

/**
 * 落盘路径：`<downloads>/Flowship-browser/<stamp>-<base>.<ext>`。**路径完全由主进程拼，AI 只能影响经过清洗的 base**。
 * 返回 { dir, file }；拼完再断言文件确实在 dir 里（防御清洗逻辑被改坏）。
 */
export const buildSavePath = ({ downloadsDir, stamp, base, ext, index = 0 }) => {
  const dir = nodePath.join(downloadsDir, SAVE_SUBDIR);
  const suffix = index > 0 ? `-${index}` : "";
  const name = `${stamp}-${base}${suffix}.${ext}`;
  const file = nodePath.join(dir, name);
  if (nodePath.dirname(file) !== dir) throw new BrowserError("INTERNAL", "保存路径计算异常，已中止");
  // 兜底（R1-22）：base 经 sanitizeFileName 后恒 ≤120 字节，到不了这里；防清洗逻辑被改坏后又退化成 ENAMETOOLONG
  if (Buffer.byteLength(name, "utf8") > FILE_NAME_MAX_BYTES) throw new BrowserError("INTERNAL", "保存的文件名过长，已中止");
  return { dir, file };
};

/** 落盘失败的人话（按 errno 码）：只给原因，不带 Node 原始 message——那里有完整路径（用户名 / 目录结构），不该回传给 AI */
const SAVE_ERRNO_TEXT = Object.freeze({
  ENAMETOOLONG: "文件名过长",
  EACCES: "没有写入权限",
  EPERM: "没有写入权限",
  ENOSPC: "磁盘空间不足",
  EDQUOT: "磁盘配额已用完",
  EROFS: "目标位置是只读的",
  ENOENT: "保存目录不存在或已被删除",
  ENOTDIR: "保存位置的上级不是目录",
  EMFILE: "系统打开的文件过多",
  EIO: "磁盘读写出错",
});

const saveFailure = (err) => {
  const code = typeof err?.code === "string" && /^[A-Z0-9_]{2,20}$/.test(err.code) ? err.code : "";
  return new BrowserError("INTERNAL", `保存文件失败：${SAVE_ERRNO_TEXT[code] ?? "写入出错"}${code ? `（${code}）` : ""}。请检查系统下载目录是否可写`);
};

/**
 * 用 wx 写，已存在（同一秒同名）就加序号重试，绝不覆盖已有文件。返回最终路径。
 * 写盘失败抛 `BrowserError("INTERNAL", …)`，文案只含原因与 errno 码，**不含完整路径**（R1-22）。
 */
export const writeFileUnique = ({ fs = nodeFs, downloadsDir, stamp, base, ext, data }) => {
  const { dir } = buildSavePath({ downloadsDir, stamp, base, ext });
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw saveFailure(err);
  }
  for (let i = 0; i < 100; i++) {
    const { file } = buildSavePath({ downloadsDir, stamp, base, ext, index: i });
    try {
      // 0600（仅属主可读写；Windows 忽略）：页面快照 / PDF / 截图可能含登录后的内容，E2 写盘红线统一要求（冒烟套件发现原先是默认 0644）
      fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 });
      return file;
    } catch (err) {
      if (err?.code === "EEXIST") continue;
      throw saveFailure(err);
    }
  }
  throw new BrowserError("INTERNAL", "同名文件过多，保存失败");
};

/**
 * 主进程再保险：inspect 的结果即便页内脚本被改坏 / 退回主世界执行，也不会漏出 password / hidden 的 value 与 on* 属性，单值 ≤300。
 * html 再按标签属性过一遍字符串级脱敏（hidden / 密码 / 验证码 / 银行卡类 / style 遮罩的 input value；页内已按原节点精确判过，
 * 所以保留普通 textarea 的默认文本）。htmlNote（html 被页内脚本置空的原因）原样透传。
 * 不修改入参，返回新对象。
 */
export const sanitizeInspectResult = (r) => {
  const out = { ...r };
  if (out.attrs && typeof out.attrs === "object") {
    const type = String(out.attrs.type ?? "").toLowerCase();
    // 统一规则（secret-field.mjs）+ hidden；这里只有标签属性，看不到 computed 的 text-security（页内脚本才判得了）
    const secret =
      (r.tag === "input" || r.tag === "textarea") &&
      (type === "hidden" || isSecretInfo({ type, autocomplete: String(out.attrs.autocomplete ?? "") }));
    const attrs = {};
    for (const [k, v] of Object.entries(out.attrs)) {
      if (/^on/i.test(k)) continue;
      if (secret && k.toLowerCase() === "value") continue;
      attrs[k] = clipValue(v, INSPECT_VALUE_MAX);
    }
    out.attrs = attrs;
  }
  if (out.styles && typeof out.styles === "object") {
    const styles = {};
    for (const [k, v] of Object.entries(out.styles)) styles[k] = clipValue(v, INSPECT_VALUE_MAX);
    out.styles = styles;
  }
  if (typeof out.html === "string") out.html = clipValue(redactHtmlInputValues(out.html, { textareaBody: "keep" }), INSPECT_HTML_MAX);
  if (typeof out.htmlNote === "string") out.htmlNote = clipValue(out.htmlNote, 300);
  else delete out.htmlNote;
  return out;
};

// ───────────────────────── 参数校验 ─────────────────────────

const STYLE_PROP_RE = /^(?:--[a-zA-Z0-9_-]{1,60}|[a-zA-Z][a-zA-Z0-9-]{0,60})$/;

export const normalize = (op, args, h) => {
  switch (op) {
    case "read": {
      const ref = h.optStr(args, "ref", 20);
      const o = {
        format: h.optEnum(args, "format", ["markdown", "text"], "markdown"),
        maxChars: h.optNum(args, "maxChars", { min: 1000, max: 200_000, dflt: 30_000 }),
        mainContent: h.optBool(args, "mainContent", true),
      };
      return h.withTab(args, { ...(ref ? { ref } : {}), ...o });
    }
    case "inspect": {
      let include = DEFAULT_INSPECT_INCLUDE.slice();
      if (args.include !== undefined && args.include !== null) {
        // E2·P7b（B4）：基础 4 项 + matched_rules / event_listeners / a11y_audit
        const allIncludes = [...INSPECT_INCLUDES, ...INSPECT_EXTRA_INCLUDES];
        if (!Array.isArray(args.include) || args.include.length === 0 || args.include.length > allIncludes.length) {
          throw h.bad(`include 必须是 ${allIncludes.join(" / ")} 组成的非空数组`);
        }
        for (const v of args.include) {
          if (typeof v !== "string" || !allIncludes.includes(v)) throw h.bad(`include 只能是 ${allIncludes.join(" / ")}，收到「${String(v).slice(0, 20)}」`);
        }
        include = [...new Set(args.include)];
      }
      let styleProps;
      if (args.styleProps !== undefined && args.styleProps !== null) {
        if (!Array.isArray(args.styleProps) || args.styleProps.length > MAX_STYLE_PROPS) {
          throw h.bad(`styleProps 必须是不超过 ${MAX_STYLE_PROPS} 个 CSS 属性名组成的数组`);
        }
        for (const p of args.styleProps) {
          if (typeof p !== "string" || !STYLE_PROP_RE.test(p.trim())) throw h.bad(`styleProps 里有非法的 CSS 属性名「${String(p).slice(0, 30)}」`);
        }
        styleProps = args.styleProps.map((p) => p.trim().toLowerCase());
      }
      return h.withTab(args, { ref: h.reqStr(args, "ref", { max: 20 }), include, ...(styleProps ? { styleProps } : {}) });
    }
    case "network_detail": {
      const id = h.optNum(args, "id", { min: 1, max: 2 ** 31, dflt: undefined });
      if (id === undefined) throw h.bad("缺少必填参数 id（browser_network 列表里每条前面的 #数字）");
      // E2·S3 B1：frameLimit 只对 WebSocket / SSE 条目有意义（取最近 N 帧，默认 50，上限 200 = 每连接的帧缓冲容量）
      return h.withTab(args, { id, includeBody: h.optBool(args, "includeBody", false), frameLimit: h.optNum(args, "frameLimit", { min: 1, max: 200, dflt: 50 }) });
    }
    case "save": {
      const nameHint = h.optStr(args, "nameHint", 200);
      const kind = h.reqEnum(args, "kind", SAVE_KINDS);
      // E2·C5：pdf 打印选项只对 kind=pdf 有意义；给了却不是 pdf 直接报错（别悄悄忽略，模型会以为生效了）
      const parsed = parsePdfOptions(args);
      if ("error" in parsed) throw h.bad(parsed.error);
      if (kind !== "pdf" && parsed.options !== undefined) throw h.bad("landscape / scale / pageRanges / paperFormat / margins / printBackground / header / footer 只在 kind=pdf 时可用");
      return h.withTab(args, {
        kind,
        fullPage: h.optBool(args, "fullPage", true),
        ...(nameHint ? { nameHint } : {}),
        ...(parsed.options !== undefined ? { pdf: parsed.options } : {}),
      });
    }
    default:
      throw h.bad(`未实现的浏览器操作：${String(op).slice(0, 40)}`);
  }
};

// ───────────────────────── 在页面里跑脚本 ─────────────────────────

const callResultValue = (res, what) => {
  if (res?.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new BrowserError("INTERNAL", `${what}时页内脚本出错：${String(d.exception?.description ?? d.text ?? "").slice(0, 200)}`);
  }
  return res?.result?.value;
};

/** 主 frame 的隔离世界 contextId（同名世界 Chromium 会复用，不会越建越多） */
const isolatedContextId = async (tab) => {
  let frameId = tab.mainFrameId;
  if (!frameId) frameId = (await tab.send("Page.getFrameTree", {}))?.frameTree?.frame?.id;
  if (!frameId) throw new BrowserError("INTERNAL", "找不到页面的主 frame");
  const r = await tab.send("Page.createIsolatedWorld", { frameId, worldName: READ_WORLD_NAME });
  if (typeof r?.executionContextId !== "number") throw new BrowserError("INTERNAL", "创建隔离世界失败");
  return r.executionContextId;
};

/**
 * 在页面里执行「函数表达式」脚本，返回按值序列化的结果。
 * - 有 ref：主会话里的元素优先在隔离世界里解析并 callFunctionOn；OOPIF 子会话 / 解析失败退回主世界（actions.callOnNode，
 *   ref 失效 / 不可见的错误映射也在那里）；
 * - 无 ref：隔离世界 evaluate；创建世界失败退回主世界 evaluate。
 */
export const runPageScript = async (tab, { ref, source, callOnNode }) => {
  await tab.ensureCdp();
  if (ref) {
    const entry = tab.resolveRef(ref); // 抛 REF_STALE / REF_NOT_FOUND
    if (!entry.sessionId) {
      let objectId;
      try {
        const contextId = await isolatedContextId(tab);
        const resolved = await tab.send("DOM.resolveNode", { backendNodeId: entry.backendNodeId, executionContextId: contextId });
        objectId = resolved?.object?.objectId;
        if (objectId) {
          const res = await tab.send("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: source,
            returnByValue: true,
            awaitPromise: false,
            silent: true,
          });
          return callResultValue(res, "读取元素");
        }
      } catch (err) {
        if (err instanceof BrowserError && err.code === "INTERNAL" && /页内脚本出错/.test(err.message)) throw err;
        // 其余（节点不属于该 frame 的世界 / 世界创建失败）：退回主世界
      } finally {
        if (objectId) tab.send("Runtime.releaseObject", { objectId }, null, 3000).catch(() => {});
      }
    }
    return callOnNode(tab, entry, ref, source);
  }
  const expression = asExpression(source);
  let contextId;
  try {
    contextId = await isolatedContextId(tab);
  } catch {
    contextId = undefined;
  }
  const res = await tab.send("Runtime.evaluate", {
    expression,
    ...(contextId !== undefined ? { contextId } : {}),
    returnByValue: true,
    awaitPromise: false,
    silent: true,
  });
  return callResultValue(res, "读取页面");
};

// ───────────────────────── handlers ─────────────────────────

const printPdf = async (tab, pdfOptions) => {
  let b64 = null;
  try {
    // E2·C5：pdfOptions 缺省 = E1 的老参数（pdf-options.mjs 保证）
    const r = await tab.send("Page.printToPDF", buildPrintToPdfParams(pdfOptions), null, 60_000);
    if (r?.data) b64 = r.data;
  } catch {
    /* 个别 Electron 版本经 debugger 调 printToPDF 不可用：退回 webContents.printToPDF */
  }
  if (b64) {
    // R1-29：上限检查必须在 try 之外——放里面的话 BAD_ARGS 会被上面的 catch 吞掉、退回 wc.printToPDF 再生成同样巨大的 PDF；
    // 且要在 Buffer.from 解码之前（超长页面的 base64 可达几百 MB）
    assertBase64WithinCap(b64, PDF_MAX_BYTES, "PDF", PDF_HINT);
    return Buffer.from(b64, "base64");
  }
  if (typeof tab.wc?.printToPDF !== "function") throw new BrowserError("INTERNAL", "当前环境不支持保存 PDF");
  const buf = Buffer.from(await tab.wc.printToPDF(buildElectronPdfOptions(pdfOptions)));
  assertBytesWithinCap(buf.length, PDF_MAX_BYTES, "PDF", PDF_HINT);
  return buf;
};

const SAVE_HTML_SOURCE = `function () {
  try {
    var d = document;
    var dt = d.doctype ? "<!DOCTYPE " + d.doctype.name + ">\\n" : "";
    return dt + d.documentElement.outerHTML;
  } catch (e) { return null; }
}`;

export const createHandlers = (deps) => {
  const { requireSession, getConfig, abortable, scheduleState } = deps;
  const fs = deps.fs ?? nodeFs;
  const callOnNode = deps.actions?.callOnNode;
  const now = deps.now ?? (() => new Date());

  const read = async (taskId, a, signal) => {
    const tab = requireSession(taskId).getTab(a.tabId);
    const o = normalizeReadOptions(a);
    const r = await abortable(runPageScript(tab, { ref: a.ref, source: buildReadScript(o), callOnNode }), signal);
    if (!r || typeof r !== "object") throw new BrowserError("INTERNAL", "读取页面没有返回内容");
    if (r.error) throw new BrowserError("INTERNAL", `读取页面失败：${String(r.error).slice(0, 200)}`);
    let text = String(r.text ?? "");
    let truncated = r.truncated === true;
    let totalLength = typeof r.totalLength === "number" ? r.totalLength : text.length;
    // C7：closed shadow root 里的文字页内脚本读不到（host.shadowRoot === null）。整页读取（root=body）时经 CDP 补一段附在末尾——
    // 位置信息丢了，所以单列并注明；元素级读取（有 ref）与 article / main 摘取不补，避免把无关区域混进主内容。失败 / 没有 closed 内容就什么都不加。
    if (!a.ref && r.root === "body" && typeof tab.closedShadowText === "function") {
      let closed = "";
      try {
        closed = await abortable(tab.closedShadowText(), signal);
      } catch (err) {
        if (signal?.aborted) throw err;
      }
      if (closed) {
        const block = `\n\n[以下文字来自 closed shadow DOM，位置信息已丢失，按出现顺序列出]\n${closed}`;
        totalLength += block.length;
        const room = o.maxChars - text.length;
        if (room > 0) text += block.slice(0, room);
        if (room <= 0 || block.length > room) truncated = true;
      }
    }
    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      format: o.format,
      text,
      length: text.length,
      truncated,
      // 增量字段（契约之外）：读的是哪块（article / main / body / element）与整文长度，server 用来给模型补一句提示
      root: typeof r.root === "string" ? r.root : "body",
      totalLength,
    };
  };

  const inspect = async (taskId, a, signal) => {
    const tab = requireSession(taskId).getTab(a.tabId);
    const entry = tab.resolveRef(a.ref); // 先解析：ref 失效时不必白跑脚本，错误信息也更准
    // E2·P7b：新 include（matched_rules / event_listeners / a11y_audit）不进页内脚本，由 inspect-extra.mjs 经 CDP 采集
    const includes = Array.isArray(a.include) ? a.include : [];
    const extras = includes.filter((v) => INSPECT_EXTRA_INCLUDES.includes(v));
    const baseInclude = includes.filter((v) => !INSPECT_EXTRA_INCLUDES.includes(v));
    // 只要了新项：页内脚本仍要跑一次拿 tag，借最便宜的 box，结果里再丢掉（没要 box 就不该出现）
    const onlyExtras = extras.length > 0 && baseInclude.length === 0;
    const source = buildInspectScript({ include: onlyExtras ? ["box"] : baseInclude, styleProps: a.styleProps });
    const r = await abortable(runPageScript(tab, { ref: a.ref, source, callOnNode }), signal);
    if (!r || typeof r !== "object") throw new BrowserError("INTERNAL", "检查元素没有返回内容");
    if (r.error) throw new BrowserError("INTERNAL", `检查元素失败：${String(r.error).slice(0, 200)}`);
    const clean = sanitizeInspectResult(r);
    if (onlyExtras) delete clean.box;
    const extra = extras.length > 0 ? await abortable(collectInspectExtras(tab, entry, extras, { log: deps.log }), signal) : {};
    const role = entry?.role ? String(entry.role) : undefined;
    const name = entry?.name ? clipValue(String(entry.name).replace(/\s+/g, " ").trim(), 200) : undefined;
    return {
      tabId: tab.id,
      ref: a.ref,
      tag: String(clean.tag ?? ""),
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(clean.box ? { box: clean.box } : {}),
      ...(clean.attrs ? { attrs: clean.attrs } : {}),
      ...(clean.styles ? { styles: clean.styles } : {}),
      ...(clean.html !== undefined ? { html: clean.html } : {}),
      // html 被页内脚本主动置空时的原因（克隆与原节点配对失败）：让 AI 知道不是「元素没有 HTML」
      ...(clean.htmlNote ? { htmlNote: clean.htmlNote } : {}),
      ...extra,
    };
  };

  const networkDetail = async (taskId, a, signal) => {
    // 开关先于一切：没开就不碰 body（头与状态本身不受开关影响，所以只在 includeBody 时拦）。
    // A7 拆分：原来借用 evaluate 总闸，现在看独立的 networkBodyRead（默认开，只认显式 false 才关）
    if (a.includeBody && getConfig().networkBodyRead === false) {
      throw new BrowserError(
        "ACCESS_DISABLED",
        "读取请求 / 响应体需要用户在 设置 → 内置浏览器 里打开「允许 AI 读取网络响应内容」（响应体可能含任意页面数据）；不带 include_body 仍可查看头与状态",
      );
    }
    const tab = requireSession(taskId).getTab(a.tabId);
    const found = tab.getNetworkEntry(a.id);
    if (!found) {
      throw new BrowserError(
        "BAD_ARGS",
        `没有 id 为 ${a.id} 的网络请求：可能已被新请求挤出（只保留最近 200 条的详情）、还没完成、或被 clear 清掉。请先用 browser_network 看最新列表`,
      );
    }
    // E2·S3 B1：WebSocket / SSE 条目返回帧 / 事件列表（正文与 include_body 同闸，上面的开关已判过）；它们没有「响应体」可取（流永不结束）
    if (found.entry.type === "WebSocket" || found.detail?.stream === "sse") {
      return assembleStreamDetail({
        base: assembleNetworkDetail({ entry: found.entry, detail: found.detail, includeBody: false }),
        entry: found.entry,
        streamFrames: tab.streams?.framesOf(a.id, a.frameLimit) ?? null,
        includeText: a.includeBody === true,
      });
    }
    let response;
    let requestPostData;
    if (a.includeBody) {
      response = await abortable(tab.fetchNetworkResponseBody(a.id), signal);
      requestPostData = await abortable(tab.fetchNetworkPostData(a.id), signal);
    }
    return assembleNetworkDetail({ entry: found.entry, detail: found.detail, includeBody: a.includeBody === true, response, requestPostData });
  };

  const save = async (taskId, a, signal) => {
    const session = requireSession(taskId);
    const tab = session.getTab(a.tabId);
    await abortable(tab.ensureCdp(), signal);
    let data;
    if (a.kind === "pdf") {
      data = await abortable(printPdf(tab, a.pdf), signal);
    } else if (a.kind === "screenshot") {
      // maxWidth 给超大值：存盘要原图，不能被 snapshot 用的 1280 缩小
      const shot = await abortable(tab.screenshot({ fullPage: a.fullPage !== false, format: "png", maxWidth: 100_000 }), signal);
      data = Buffer.from(String(shot?.dataBase64 ?? ""), "base64");
    } else {
      const html = await abortable(runPageScript(tab, { source: SAVE_HTML_SOURCE, callOnNode }), signal);
      if (typeof html !== "string" || html === "") throw new BrowserError("INTERNAL", "读取页面 HTML 失败");
      if (Buffer.byteLength(html, "utf8") > SAVE_HTML_MAX_BYTES) throw new BrowserError("BAD_ARGS", "页面 HTML 超过 20MB，不保存");
      data = Buffer.from(html, "utf8");
    }
    if (!data || data.length === 0) throw new BrowserError("INTERNAL", "生成的文件是空的，未保存");

    const base = pickBaseName({ nameHint: a.nameHint, title: tab.title, url: tab.url });
    const file = writeFileUnique({
      fs,
      downloadsDir: deps.app.getPath("downloads"),
      stamp: formatStamp(now()),
      base,
      ext: SAVE_EXT[a.kind],
      data,
    });

    // 感知类不走 runAction，所以自己记一条 AI 条目（§14.5-3：用户在面板时间线里能看到 AI 存了什么）
    try {
      session.activityLog.addAI({ kind: "download", tabId: tab.id, url: tab.url, summary: `保存了页面（${a.kind}）` });
      scheduleState?.(taskId);
    } catch (err) {
      deps.log?.(`[browser] 保存页面的活动日志写入失败：${err?.message || err}`);
    }
    return { tabId: tab.id, kind: a.kind, path: file, bytes: data.length };
  };

  return { read, inspect, network_detail: networkDetail, save };
};
