/**
 * 主窗口外链 / 导航的协议白名单（纯函数、不 import electron，可直接单测）
 *
 * 为什么存在：renderer 里任何一次同 frame 导航、window.open、IPC open-external 最终都会走到
 * `shell.openExternal`——它会把字符串交给操作系统按协议分发，`file:` / `smb:` / 自定义协议处理器
 * 都能被拉起（NTLM 外泄、本地程序执行都是这条路）。所以必须在这里按「协议白名单」把关。
 *
 * 两个判定刻意分开：
 * - `isSafeExternalUrl`：通用外链（setWindowOpenHandler / IPC open-external / will-navigate 共用）；
 * - `isIdeDeepLink`：只给 will-navigate——IDE deep link 是页面里裸 `<a href="cursor://file/...">`
 *   同 frame 导航（见 src/lib/ide-open.ts、path-utils.ts 的 buildIdeLink），
 *   不会走 window.open / IPC，所以不把它放进通用白名单、不扩大另外两条路径的攻击面；
 * - `isSafeMailtoUrl`：同样只给 will-navigate——页面里裸 `<a href="mailto:…">` 的同 frame 导航
 *   （第五轮审查：白名单化之后它被静默拦下、点了没反应）。邮件客户端会解释 mailto 的 query
 *   （attach 能带本地文件 / UNC），所以不能整个协议放行，只放行「收件人 + subject/body/cc/bcc」的严格形态。
 *
 * 判定统一遵循：先拒绝控制字符 / 空白（WHATWG URL 解析会静默剥掉首尾空白和 tab / 换行，
 * `java\nscript:`、` https://…` 这类伪装在解析后「看起来合法」，但交给系统的原始串不是那回事），
 * 再用 `new URL` 解析、按协议精确比对，不做前缀正则。
 */

// 通用外链放行的协议：浏览器链接 + 系统设置深链（设置页「去系统设置里开启通知」用）
const SAFE_EXTERNAL_PROTOCOLS = new Set([
  "http:",
  "https:",
  "x-apple.systempreferences:",
  "ms-settings:",
]);

// 前端真实会生成的 IDE deep link 协议——只有 cursor / vscode：
// types.ts 的 JUMP_IDE_USES_PROTOCOL 只有这两个为 true，其余（idea / webstorm / windsurf / trae…）
// 一律走 POST /api/system/open-in-ide 后端拉起，不经浏览器协议。所以 idea:// 等刻意不放行。
const IDE_DEEP_LINK_SCHEMES = new Set(["cursor:", "vscode:"]);

// 控制字符（C0 / DEL / C1）、空格、各类 Unicode 空白、零宽与 bidi 控制符：
// 前端生成的 URL 经 encodeURIComponent，原串里不可能出现这些；出现即伪装 / 注入
const UNSAFE_CHARS = /[\u0000-\u0020\u007f-\u009f\s\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

// deep link 原串形态：小写 scheme + 固定 host `file`（前端永远这样生成）+ 以 `/` 起头的路径
// + 可选的 `?windowId=_blank`（开工作区目录时的「新窗口」参数，见 buildIdeLink）
const IDE_DEEP_LINK_SHAPE = /^(cursor|vscode):\/\/file(\/[^?#]*)(\?windowId=_blank)?$/;

// deep link 路径单段的合法字符 = encodeURIComponent 的输出集（A-Z a-z 0-9 - _ . ! ~ * ' ( ) 与 %XX）
const IDE_PATH_SEGMENT = /^(?:[A-Za-z0-9\-._~!*'()]|%[0-9A-Fa-f]{2})+$/;

// 绝对路径极限：Linux PATH_MAX 4096、全 %XX 编码后 ×3，8192 足够且能挡住超长构造
const MAX_IDE_LINK_LENGTH = 8192;

const parseStrictUrl = (url) => {
  if (typeof url !== "string" || url.length === 0) return null;
  if (UNSAFE_CHARS.test(url)) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/**
 * 通用外链白名单：http(s) + 系统设置深链。保持原有语义，但改成「解析后按协议比对」。
 *
 * 注意 `http://127.0.0.1:8876@evil/` 这类带 userinfo 的 URL 在这里是「普通外部 http 链接」——
 * 它只会交给系统浏览器、不会在应用窗口里加载，所以放行；「它是不是站内」由 isSameAppOrigin 按 origin 判定。
 */
export const isSafeExternalUrl = (url) => {
  const u = parseStrictUrl(url);
  if (!u || !SAFE_EXTERNAL_PROTOCOLS.has(u.protocol)) return false;
  if (u.protocol === "http:" || u.protocol === "https:") {
    // special scheme 的解析太宽容：`https:evil.com`、`https:\\evil.com`、`https:///evil.com` 都会被规整成
    // https://evil.com/，但交给系统的是原始串、各平台解释不一。要求原串就是规范的 `scheme://host…` 形态
    // （`//` 后紧跟 host 字符、不是又一个分隔符），且不含反斜杠
    if (!/^https?:\/\/[^/\\?#]/i.test(url) || url.includes("\\") || !u.hostname) return false;
  }
  return true;
};

// 路径（以 `/` 起头、已确认不含 ? #）是否是「前端 buildIdeLink 会生成的」绝对路径形态
const isPlainIdeAbsolutePath = (rawPath) => {
  const segments = rawPath.slice(1).split("/");
  // Windows 盘符段 `D:`（冒号不 encode、见 path-utils.ts）——POSIX 路径没有这一段
  if (/^[A-Za-z]:$/.test(segments[0])) segments.shift();
  // 目录路径允许一个尾部斜杠
  if (segments.length > 1 && segments[segments.length - 1] === "") segments.pop();
  if (segments.length === 0) return false;
  // 行号后缀 `:N` 只会出现在最后一段（冒号在文件名里会被 encode 成 %3A）
  const last = segments.length - 1;
  segments[last] = segments[last].replace(/:\d{1,7}$/, "");
  return segments.every((seg) => {
    // 空段 = `//`：`cursor://file//server/share` 在 Windows 上会被当成 UNC 路径（SMB / NTLM 外泄）
    if (!IDE_PATH_SEGMENT.test(seg)) return false;
    let decoded;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return false;
    }
    // 目录穿越 / 编码后夹带分隔符、NUL 与控制字符（%2e%2e、%2F、%5C、%00）
    if (decoded === "." || decoded === ".." || /[/\\\u0000-\u001f\u007f]/.test(decoded)) {
      return false;
    }
    return true;
  });
};

/**
 * 前端真实会生成的 IDE deep link：`cursor://file/<绝对路径>[:行号][?windowId=_blank]`（vscode 同形）。
 *
 * 为什么这么严：VS Code 系的 URL handler 除了 `file` 之外还有 `vscode://vscode.git/clone?url=…`、
 * `cursor://anysphere.cursor-deeplink/…` 这类能拉仓库 / 注入提示词的 host，
 * 所以 host 必须恒为 `file`，且路径不能含 `..` / UNC / 编码分隔符，query 只认 `windowId=_blank`。
 */
export const isIdeDeepLink = (url) => {
  if (typeof url !== "string" || url.length > MAX_IDE_LINK_LENGTH) return false;
  const shape = IDE_DEEP_LINK_SHAPE.exec(url);
  if (!shape) return false;
  const u = parseStrictUrl(url);
  if (!u || !IDE_DEEP_LINK_SCHEMES.has(u.protocol)) return false;
  // 解析器眼里也必须是同一回事：host 恒为 file、无 userinfo / 端口 / fragment
  if (u.hostname !== "file" || u.username || u.password || u.port || u.hash) return false;
  return isPlainIdeAbsolutePath(shape[2]);
};

// mailto 总长上限：邮件客户端 / ShellExecute 对命令行长度本就有限（Windows 约 2K），再长也传不过去；
// 同时挡住超长构造
const MAX_MAILTO_LENGTH = 2048;

// mailto 的 query 只认这四个键：RFC 6068 里除它们之外的 hname（attach / attachment 等）在部分邮件客户端里
// 会被当成「附加本地文件 / UNC 路径」（读本地文件、NTLM 外泄）——这正是不能把 mailto 直接放进通用白名单的原因。
// in-reply-to / from 等也没有放行价值，宁可点了没反应、不扩大面
const MAILTO_ALLOWED_PARAMS = new Set(["subject", "body", "cc", "bcc"]);

// 收件人地址：只收常见邮箱字符集（不含引号 / 空格 / `<>` / `;` / `:` / `\` / `%` 等），
// 域名至少一个点。这不是 RFC 5322 全集——目的是让交给系统的串里不可能夹带 shell / 协议元字符
const MAILTO_ADDRESS = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

// 解码后的 subject 不允许任何控制字符（`%0D%0ABcc:` 一类的邮件头注入）、零宽与 bidi 控制符；
// body 里换行是正常内容（`%0D%0A`），所以单独放开 \t \n \r 这三个，其余控制字符照样拒绝
const MAILTO_VALUE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;
const MAILTO_BODY_FORBIDDEN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

// 逗号分隔的收件人列表：先按原串的逗号切、再逐段解码校验——
// 先解码再切会让 `%2C` 变成分隔符，把「一个地址」悄悄变成两个
const isMailtoAddressList = (raw) => {
  if (!raw) return false;
  return raw.split(",").every((part) => {
    let decoded;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return false;
    }
    return MAILTO_ADDRESS.test(decoded);
  });
};

/**
 * `mailto:` 链接（页面里 `<a href="mailto:…">` 同 frame 导航、将交给系统邮件客户端）。
 *
 * 为什么单独一个判定、不进 isSafeExternalUrl：与 IDE deep link 同理——它只由页面里点链接的同 frame 导航产生，
 * 不会走 IPC open-external，所以只在 will-navigate 里放行，不扩大 IPC 的攻击面。
 *
 * 为什么要校验得这么细：邮件客户端会解释 mailto 的 query（见 MAILTO_ALLOWED_PARAMS 的注释），
 * 所以收件人字符集、query 键白名单、总长、控制字符都要卡死；任何一项不合格整条拒绝（点了没反应好过被带偏）。
 * 必须有至少一个收件人：`mailto:?subject=…` 这种前端不会生成的形态一并拒绝。
 */
export const isSafeMailtoUrl = (url) => {
  if (typeof url !== "string" || url.length > MAX_MAILTO_LENGTH) return false;
  // 先过严格解析：原串里的控制字符 / 空白 / 零宽 / bidi 一律拒绝（与其它判定同口径）
  const u = parseStrictUrl(url);
  if (!u || u.protocol !== "mailto:") return false;
  // 原串形态：`mailto:` + 收件人 + 可选 `?query`，不许有 fragment（`#` 没有任何合法用途）
  const shape = /^mailto:([^?#]*)(?:\?([^#]*))?$/i.exec(url);
  if (!shape || !isMailtoAddressList(shape[1])) return false;
  const query = shape[2];
  if (query === undefined) return true;
  const seen = new Set();
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    // 空键 / 无等号 / 空 pair（`?a=1&` 的尾随 &）都不是前端会生成的形态
    if (eq <= 0) return false;
    // 键不解码：`%73ubject` 这类编码伪装的键当成未知键拒绝
    const key = pair.slice(0, eq).toLowerCase();
    if (!MAILTO_ALLOWED_PARAMS.has(key) || seen.has(key)) return false;
    seen.add(key);
    const rawValue = pair.slice(eq + 1);
    if (key === "cc" || key === "bcc") {
      if (!isMailtoAddressList(rawValue)) return false;
      continue;
    }
    let value;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      return false;
    }
    if ((key === "body" ? MAILTO_BODY_FORBIDDEN : MAILTO_VALUE_FORBIDDEN).test(value)) return false;
  }
  return true;
};

/**
 * 主机名是否指向本机回环（入参是 `URL.hostname`：WHATWG 已把 `127.1` / `2130706433` / `0x7f.1` 规范化成
 * `127.0.0.1`、`[0:0:0:0:0:0:0:1]` 规范化成 `[::1]`，所以这里不必再处理那些写法）。
 * 覆盖：127.0.0.0/8、0.0.0.0（Linux / macOS 上连它等于连本机）、`localhost` 与 `*.localhost`（RFC 6761、
 * Chromium 直接解析成回环；末尾多一个 `.` 的写法也算）、`[::1]`、`[::]`、IPv4 映射的回环 `[::ffff:7fxx:xxxx]`。
 */
const isLoopbackHostname = (hostname) => {
  const h = String(hostname).toLowerCase().replace(/\.$/, "");
  return (
    /^127\.\d+\.\d+\.\d+$/.test(h) ||
    h === "0.0.0.0" ||
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "[::1]" ||
    h === "[::]" ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h)
  );
};

/**
 * 是否「本应用 origin」（精确）：host 必须与壳绑定的一致（127.0.0.1）、端口一致。
 * 主窗同 frame 导航到这个 origin 才是真站内（will-navigate 放行用）。
 */
export const isCanonicalAppOrigin = (url, { host, port }) => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && u.hostname === host && Number(u.port) === port;
  } catch {
    return false;
  }
};

/**
 * 是否站内 URL：必须按 origin 精确比对——`url.startsWith(BASE_URL)` 会被
 * `http://127.0.0.1:8876@evil/` / `:88760/` / `.attacker.tld/` 前缀绕过（审查发现）。
 *
 * 主机名认「本机回环的所有写法」（127.0.0.1 / localhost / [::1] …）而不只是壳绑定的那一个：
 * 服务只绑 127.0.0.1，但 `http://localhost:8876/api/…`、`http://[::1]:8876/api/…` 指向的仍是同一个服务。
 * 如果它们被当「站外 http 链接」交给系统浏览器，顶层导航带 `Sec-Fetch-Site: none`，Fetch Metadata 闸拦不住，
 * AI 输出里一条恶意链接就能让用户一点触发 `mr-inbox?refresh=1` / `repo-branches`（git fetch）这类有副作用的 GET——
 * 与第四轮 Q4-02 收的 `127.0.0.1` 形态是同一个洞，只是换了个主机名写法（2026-10-23 全仓审查复现）。
 * 所以别名也算「站内」：setWindowOpenHandler / IPC 一律 deny、不交系统浏览器；
 * 同 frame 导航到别名则由 main.js 的 will-navigate 用 isCanonicalAppOrigin 区分后拦下（别名 origin 与主窗不同源，放行会把主窗带走）。
 */
export const isSameAppOrigin = (url, { host, port }) => {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" || Number(u.port) !== port) return false;
    return u.hostname === host || (isLoopbackHostname(host) && isLoopbackHostname(u.hostname));
  } catch {
    return false;
  }
};
