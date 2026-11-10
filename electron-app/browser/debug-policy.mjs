/**
 * 增强包 E2 · B5 调试器的纯策略（契约 §15.2 S6）：变量名凭据识别、作用域浅层化与值脱敏、断点 / 暂停相关参数校验、暂停期间的 op 白名单。
 *
 * 为什么抽成纯函数：`debug` 能读页面运行时内存，作用域变量里最容易出现密码 / 令牌——这一层的判断必须可穷举地单测，
 * 而不是埋在 CDP 往返的 op 里。本模块不依赖 Electron / CDP，注入的只有 `redact` 函数（默认用主进程的 `redactSensitiveText`）。
 *
 * 取舍（宁可多藏）：一个被误伤的变量值对 AI 排查几乎没影响，漏一个密码 / 令牌却是实打实的泄露；
 * 但 `monkey / keyboard / keyword / author / authority / tokenizer` 这类普通词不动（按「词」判，不按子串判）。
 */
import { redactSensitiveText } from "./text-redact.mjs";
import { compileUrlRegex, NetFilterError } from "./net-filter.mjs";

/** 每个 tab 最多同时存在的断点数（含条件断点） */
export const MAX_BREAKPOINTS = 20;
/** 暂停超过这么久自动 resume（页面主线程被冻结，不能让它永久挂着） */
export const PAUSE_AUTO_RESUME_MS = 120_000;
/** 单个变量值展示的字符上限（先脱敏后截断） */
export const SCOPE_VALUE_MAX_CHARS = 200;
export const SCOPE_MAX_VARS_DEFAULT = 50;
export const SCOPE_MAX_VARS_LIMIT = 200;
export const SCOPE_DEPTH_MAX = 2;
/** 断点条件表达式上限 */
export const CONDITION_MAX_CHARS = 1000;
export const URL_MAX_CHARS = 2000;
export const LINE_MAX = 10_000_000;
/** 一次 step / resume 等 `paused` / `resumed` 事件的上限 */
export const STEP_WAIT_MS = 5000;
/** 凭据变量值的替代文本（与 text-redact 的 REDACTED_TEXT 同一个词，便于 AI / 测试统一识别） */
export const HIDDEN_VALUE = "[已隐藏]";

export const PAUSE_ON_EXCEPTION_STATES = Object.freeze(["none", "uncaught", "all"]);
export const DEBUG_ACTIONS = Object.freeze([
  "set_breakpoint",
  "remove_breakpoint",
  "list_breakpoints",
  "pause_on_exception",
  "status",
  "step_over",
  "step_into",
  "step_out",
  "resume",
  "scope",
]);
/** 需要「执行页面代码」才能完成、因此要走 evaluate 审批的 action（condition 在页面里跑；scope 读运行时内存） */
export const STEP_ACTIONS = Object.freeze(["step_over", "step_into", "step_out", "resume"]);
/** 只读类：用户接管时也放行（不改页面状态） */
export const READONLY_ACTIONS = Object.freeze(["status", "list_breakpoints"]);

/** 暂停原因：把 CDP 的 reason 折成固定枚举（状态里不放页面可控文字） */
export const PAUSE_REASONS = Object.freeze(["breakpoint", "exception", "debugger_statement", "step", "other"]);

/**
 * CDP `Debugger.paused.reason` → 固定枚举。
 * 真机实测（Electron 42 / V8）：`debugger;` 语句与单步落点的 reason 都是 `other`（没有 hitBreakpoints），两者靠「我们刚发过 step_*」区分：
 * `stepping` 为真 → step，否则 `other` 视为 debugger 语句。`debugCommand`（控制台 `debug(fn)`）也归入 debugger_statement。
 * `ambiguous / assert / OOM / XHR / CSPViolation …` 等罕见原因 → other。
 * @param {string} reason @param {string[]} [hitBreakpoints] @param {{ stepping?: boolean }} [ctx]
 */
export const normalizePauseReason = (reason, hitBreakpoints = [], { stepping = false } = {}) => {
  if (Array.isArray(hitBreakpoints) && hitBreakpoints.length > 0) return "breakpoint";
  switch (reason) {
    case "exception":
    case "promiseRejection":
      return "exception";
    case "debugCommand":
      return "debugger_statement";
    case "step":
      return "step";
    case "other":
      return stepping ? "step" : "debugger_statement";
    default:
      return "other";
  }
};

export const PAUSE_REASON_LABEL = Object.freeze({
  breakpoint: "断点",
  exception: "异常",
  debugger_statement: "debugger 语句",
  step: "单步",
  other: "其它",
});

// ── 变量名是否像凭据 ──

/** 按「词」精确匹配：这些词本身就是凭据语义（`apiKey` → api + key；`author` 不是 `auth`） */
const CREDENTIAL_WORDS = new Set([
  "password", "passwords", "passwd", "pwd", "passphrase", "passcode", "pin",
  "token", "tokens", "secret", "secrets",
  "key", "apikey", "privatekey", "secretkey", "accesskey", "signingkey", "encryptionkey",
  "auth", "authn", "authz", "authorization", "authorisation", "authentication",
  "cookie", "cookies", "session", "sessions", "sessionid", "sid",
  "credential", "credentials", "bearer", "jwt", "otp", "totp", "csrf", "xsrf", "mnemonic",
  // R6-08：按「词」补全——`userPass` / `dbPass` 拆出 pass；`cvv2` 拆出 cvv；`privateKeyPem` 拆出 pem；`codeVerifier` / `mfaCode` / `seedPhrase` 靠 verifier / mfa / seed。
  // `author` / `passenger` / `compass` / `bypass` 本身是整词，不在表里 → 不误杀（这里绝不用子串匹配）。
  "pass", "pw", "psw", "pswd", "hotp", "cvv", "cvc", "cvn", "ssn", "mfa", "seed", "pem", "verifier", "signature", "signatures", "sig",
  // 相邻词拼接后才成立的复合词（`card_number` → cardnumber；`auth_code` → authcode）。裸 `code` 不进表：`status_code` / `errorCode` / `keyCode` 是普通数据。
  "cardnumber", "cardno", "creditcard", "authcode", "oauthcode", "smscode", "verifycode", "verificationcode", "securitycode", "accesscode",
  "authorizationcode", "seedphrase", "recoveryphrase", "refreshtoken",
  // R6-41 ④：框架默认的会话 cookie 名（单个整词，驼峰 / 下划线拆不开）：`JSESSIONID`（Java）、`PHPSESSID`（PHP）、`sessid` / `sess`（`koa.sess` / `express:sess`）；
  // `connect.sid` / `ASP.NET_SessionId` / `laravel_session` 拆词后已经命中 sid / session，不用补；`ASPSESSIONID<随机后缀>` 见 isCredentialName 里的前缀判断。
  "jsessionid", "phpsessid", "sessid", "sess",
]);
/** 作为词内子串出现就隐藏的强词干（不会出现在普通英文词里）：`mypassword`、`dbPasswd`、`userCredentials`、`bearerToken` */
const STRONG_STEMS = ["password", "passwd", "passphrase", "secret", "credential", "bearer", "cookie", "apikey", "privatekey", "accesskey", "secretkey"];
/** `token` 词干：词首 / 词尾为 token 都算（`accessToken`、`tokenValue`、`authtoken`）；这几个普通词除外 */
const TOKEN_FALSE_FRIENDS = /^token(?:iz|is)/;

/** 把变量名拆成小写词：驼峰 / 下划线 / 连字符 / 数字边界（`apiKey_v2` → api key v 2） */
export const splitIdentifierWords = (name) =>
  String(name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

/**
 * 这个变量名像不像凭据（不区分大小写 / 驼峰 / 下划线）。
 * 另按「相邻两词拼接」再判一次，覆盖 `api_key` / `private-key` / `pass_word` 这类被拆开的复合词。
 */
export const isCredentialName = (name) => {
  if (typeof name !== "string" || name === "") return false;
  const words = splitIdentifierWords(name);
  if (words.length === 0) return false;
  const check = (w) => {
    if (CREDENTIAL_WORDS.has(w)) return true;
    if (w.startsWith("aspsessionid")) return true; // ASP 经典会话 cookie：`ASPSESSIONIDAQSTRDCT`（后缀是随机串）
    if (STRONG_STEMS.some((s) => w.includes(s))) return true;
    if (w.includes("token") && !TOKEN_FALSE_FRIENDS.test(w) && (w.startsWith("token") || w.endsWith("token"))) return true;
    return false;
  };
  if (words.some(check)) return true;
  // 相邻词拼接：api+key → apikey、pass+word → password、access+token → accesstoken
  for (let i = 0; i + 1 < words.length; i++) {
    if (check(words[i] + words[i + 1])) return true;
  }
  return false;
};

// ── 值的展示 ──

const clipText = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 不带源码 / 栈的对象描述：只认 `Array(3)` / `Map(2)` 这种「类名(数字)」形态，其余只给 className */
const SAFE_COUNT_DESC = /^[A-Za-z][A-Za-z0-9_]{0,40}\(\d{1,9}\)$/;

/**
 * 一个 CDP RemoteObject → 展示用短文本（**对象不递归、不取 description 全文**）：
 *  - 原始值：数字 / 布尔 / null / undefined / bigint / symbol / 字符串（带引号）；
 *  - 函数：只写 `function`（description 是函数源码，可能带密码，绝不取）；
 *  - 对象：`类名`（`Array(3)` 这种带长度的保留）；Error 的 description 是栈，不取。
 * @param {any} obj
 */
export const describeRemoteValue = (obj) => {
  if (!obj || typeof obj !== "object") return "undefined";
  switch (obj.type) {
    case "undefined":
      return "undefined";
    case "boolean":
    case "number":
      if (obj.unserializableValue) return String(obj.unserializableValue);
      return String(obj.value);
    case "bigint":
      return typeof obj.unserializableValue === "string" ? obj.unserializableValue : String(obj.description ?? "bigint");
    case "string":
      return JSON.stringify(typeof obj.value === "string" ? obj.value : String(obj.description ?? ""));
    case "symbol":
      return typeof obj.description === "string" ? obj.description : "Symbol()";
    case "function":
      return "function";
    case "object": {
      if (obj.subtype === "null") return "null";
      const desc = typeof obj.description === "string" ? obj.description : "";
      if (SAFE_COUNT_DESC.test(desc)) return desc;
      const cls = typeof obj.className === "string" && obj.className ? obj.className : obj.subtype || "Object";
      return clipText(String(cls).replace(/[\r\n]+/g, " "), 60);
    }
    default:
      return clipText(String(obj.type ?? "unknown"), 20);
  }
};

/**
 * 变量 → 对外展示的 { name, value, type }。
 * 凭据名 → `[已隐藏]`；其余值先 `redact` 再截断（先脱敏后截断，免得凭据被劈成两半残留）。
 * 变量名本身也过一遍脱敏 + 限长（名字来自页面：计算属性名可以是任意字符串）。
 * @param {string} name
 * @param {any} remote
 * @param {{ redact?: (s: string) => string, maxChars?: number }} [opts]
 */
export const scopeVariable = (name, remote, { redact = redactSensitiveText, maxChars = SCOPE_VALUE_MAX_CHARS } = {}) => {
  const safeName = clipText(redact(String(name ?? "")).replace(/[\r\n\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/g, " "), 80);
  const type = remote && typeof remote.type === "string" ? clipText(remote.type, 20) : "undefined";
  if (isCredentialName(name)) return { name: safeName, value: HIDDEN_VALUE, type, hidden: true };
  const text = describeRemoteValue(remote);
  const redacted = redact(text);
  return { name: safeName, value: clipText(redacted, maxChars), type };
};

/** 展开哪些作用域：local / closure / block / catch；global / script / with / eval / module 一律不展开（global 太大且最易泄露） */
const EXPANDABLE_SCOPES = new Set(["local", "closure", "block", "catch"]);
const FUNCTION_SCOPES = new Set(["local", "closure"]);

/**
 * 从 `callFrame.scopeChain` 里挑出要展开的作用域（由内向外）。
 * `depth` = 展开的「函数级」作用域数（local / closure），**块级（block / catch）作用域不占名额、全部带上**——
 * 否则循环体里断下时最内层是 `for (let i…)` 的 block，depth=1 就看不到真正想看的 local 变量了。
 * @param {any[]} scopeChain
 * @param {number} depth 1..{@link SCOPE_DEPTH_MAX}
 * @returns {Array<{ type: string, object: any, name?: string }>}
 */
export const pickScopes = (scopeChain, depth = 1) => {
  const d = Math.min(Math.max(1, Math.trunc(Number(depth)) || 1), SCOPE_DEPTH_MAX);
  const out = [];
  let fn = 0;
  for (const sc of Array.isArray(scopeChain) ? scopeChain : []) {
    const type = typeof sc?.type === "string" ? sc.type : "";
    if (!EXPANDABLE_SCOPES.has(type) || !sc.object?.objectId) continue;
    // 已经凑够 depth 个函数级作用域后，再往外的（含外层函数体里的 block）一律不要：它们属于下一层函数
    if (fn >= d) break;
    if (FUNCTION_SCOPES.has(type)) fn += 1;
    out.push({ type, object: sc.object, ...(typeof sc.name === "string" ? { name: clipText(sc.name, 60) } : {}) });
  }
  return out;
};

// ── 参数校验 ──

/** 含控制字符 / 换行的字符串一律拒绝（url / condition 会进 CDP 与活动日志） */
const hasControl = (s) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);

/**
 * 断点参数校验（主进程 normalize 与单测共用）。返回规整后的对象或抛 `Error`（调用方转 BAD_ARGS）。
 * - `url` 与 `urlRegex` 二选一；regex 沿用 B1 `url_regex` 的 ReDoS 校验（长度 ≤100、拒绝嵌套量词 / 回溯引用 / 环视）；
 * - `line` 按 1 起始对外（1..{@link LINE_MAX}），`column` 同；
 * - `condition` ≤ {@link CONDITION_MAX_CHARS}，不含控制字符。
 * @param {{ url?: unknown, urlRegex?: unknown, line?: unknown, column?: unknown, condition?: unknown }} a
 * @returns {{ url?: string, urlRegex?: string, line: number, column?: number, condition?: string }}
 */
export const validateBreakpointArgs = (a) => {
  const hasUrl = a?.url !== undefined && a.url !== null && a.url !== "";
  const hasRegex = a?.urlRegex !== undefined && a.urlRegex !== null && a.urlRegex !== "";
  if (hasUrl === hasRegex) throw new Error("set_breakpoint 需要 url（脚本地址）或 url_regex 二选一（先用 browser_sources list 查看已加载的脚本）");
  const out = {};
  if (hasUrl) {
    if (typeof a.url !== "string") throw new Error("url 必须是字符串");
    if (a.url.length > URL_MAX_CHARS) throw new Error(`url 过长（上限 ${URL_MAX_CHARS} 字符）`);
    if (hasControl(a.url) || /[\r\n]/.test(a.url)) throw new Error("url 含控制字符 / 换行");
    out.url = a.url;
  } else {
    if (typeof a.urlRegex !== "string") throw new Error("url_regex 必须是字符串");
    if (hasControl(a.urlRegex) || /[\r\n]/.test(a.urlRegex)) throw new Error("url_regex 含控制字符 / 换行");
    try {
      compileUrlRegex(a.urlRegex);
    } catch (err) {
      if (err instanceof NetFilterError) throw new Error(err.message);
      throw err;
    }
    out.urlRegex = a.urlRegex;
  }
  const line = a?.line;
  if (!Number.isInteger(line) || line < 1 || line > LINE_MAX) throw new Error(`line 必须是 1..${LINE_MAX} 的整数（行号从 1 开始）`);
  out.line = line;
  if (a?.column !== undefined && a.column !== null) {
    if (!Number.isInteger(a.column) || a.column < 1 || a.column > LINE_MAX) throw new Error(`column 必须是 1..${LINE_MAX} 的整数（列号从 1 开始）`);
    out.column = a.column;
  }
  if (a?.condition !== undefined && a.condition !== null && a.condition !== "") {
    if (typeof a.condition !== "string") throw new Error("condition 必须是字符串（JS 表达式）");
    if (a.condition.length > CONDITION_MAX_CHARS) throw new Error(`condition 过长（上限 ${CONDITION_MAX_CHARS} 字符）`);
    if (hasControl(a.condition)) throw new Error("condition 含控制字符");
    out.condition = a.condition;
  }
  return out;
};

/** 断点 id（CDP 形如 `1:12:0:https://…`）：长度 + 控制字符校验 */
export const validateBreakpointId = (id) => {
  if (typeof id !== "string" || id === "") throw new Error("remove_breakpoint 需要 id（先 list_breakpoints 查看）");
  if (id.length > 400 || hasControl(id)) throw new Error("id 不合法");
  return id;
};

// ── 暂停期间的 op 放行表 ──

/**
 * 页面被调试器暂停时仍可放行的 op：不依赖页面主线程的读缓冲 / 会话管理类。
 *  - `debug`（自己，resume 必须能插队）、`status`、`network` / `console`（读主进程里的缓冲，不碰页面）、`tabs`、
 *    `user_activity`、`ask_user_to_act`、`close_session`；
 *  - 其余（navigate / snapshot / screenshot / click / type / read / evaluate / wait_for …）都需要渲染进程响应，暂停时必然挂住 → 入口快速失败。
 * `screenshot`：CDP 截图要渲染进程出帧，暂停时会一直挂住（真机验证），所以不放行。
 * `network` 的 `network_detail include_body` 走浏览器进程的 `Network.getResponseBody`，不依赖主线程；放行整个 op 简单且一致。
 */
export const PAUSE_ALLOWED_OPS = Object.freeze([
  "debug", "status", "network", "console", "tabs", "user_activity", "ask_user_to_act", "close_session",
  // 纯主进程 / 浏览器进程侧的操作（不碰渲染进程主线程）：网络规则 / HAR 导出 / 权限 / 下载列表
  "net_rules", "net_export", "permissions", "downloads",
]);

/**
 * tab 当前「真的」处于暂停吗（`tab.debugPause` 是 debug 模块维护的镜像，可能因 hub 被 `Debugger.disable` 而过期）。
 * hub 存在且说没暂停 → 清掉镜像返回 null。假 tab（单测）没有 hub 时直接信镜像。
 * @param {any} tab
 * @param {{ staleMs?: number, now?: () => number, onStale?: (pause: any) => void }} [opts] R6-09：入口闸门的兜底超时（不传 = 旧行为）
 */
export const livePause = (tab, opts) => {
  const p = tab?.debugPause;
  if (!p) return null;
  const hub = tab.ext?.get?.("debugger-hub");
  if (hub && typeof hub.getPaused === "function" && !hub.getPaused()) {
    tab.debugPause = null;
    return null;
  }
  // R6-09 入口闸门的「兜底超时」：暂停已经超过 staleMs（= 120s 自动 resume + 宽限）还没被清，说明自动 resume 与所有清理路径都失灵了
  // （目标已死 / 会话失效）。此时继续拒绝只会把 tab 永久锁死——宁可放行，让后续操作自己撞 CDP 超时并报出真实错误。
  if (opts && Number.isFinite(opts.staleMs) && opts.staleMs > 0 && Number.isFinite(p.since)) {
    const now = typeof opts.now === "function" ? opts.now() : Date.now();
    if (now - p.since > opts.staleMs) {
      tab.debugPause = null;
      try {
        hub?.clearPaused?.();
      } catch {
        /* 假 hub 没有该方法 */
      }
      try {
        opts.onStale?.(p);
      } catch {
        /* 日志回调失败不影响放行 */
      }
      return null;
    }
  }
  return p;
};

/** 入口闸门的兜底超时：自动 resume（120s）之后再留 30 秒宽限；超过仍未清除就视为暂停态已失效、不再拒绝 */
export const PAUSE_GATE_STALE_MS = PAUSE_AUTO_RESUME_MS + 30_000;

/** 被拒绝时给模型的话：「怎么继续」写在最前，位置经脱敏 + 限长 */
export const pausedMessage = (info) => {
  const where = info?.url ? `${clipText(String(info.url), 120)}${Number.isFinite(info.line) ? `:${info.line}` : ""}` : "未知位置";
  return `页面被调试器暂停（${where}），页面脚本被冻结、无法响应。请先用 browser_debug {action:"resume"}（或 step_over / step_into / step_out）继续运行，再做这一步`;
};

/**
 * 暂停闸门：某 op 在 tab 暂停时是否要拒绝。`debug` 之外的白名单见 {@link PAUSE_ALLOWED_OPS}。
 * @param {string} op
 * @param {{ url?: string, line?: number } | null | undefined} pause 目标 tab 的暂停状态
 * @returns {string | null} 要拒绝时返回错误文案，放行返回 null
 */
export const pauseGateMessage = (op, pause) => {
  if (!pause) return null;
  if (PAUSE_ALLOWED_OPS.includes(op)) return null;
  return pausedMessage(pause);
};

/**
 * 用户接管时某 debug action 是否放行：只读类放行，其余 `USER_CONTROL`（含 resume / step：用户可能正在看暂停现场，AI 不能替他继续）。
 * @param {string} action
 * @param {"idle" | "ai" | "user"} controller
 */
export const debugAllowedUnderController = (action, controller) => controller !== "user" || READONLY_ACTIONS.includes(action);
