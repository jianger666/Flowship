/**
 * 本地 HTML 的只读静态服务（「HTML 默认用内置浏览器打开」，docs/BROWSER-AUTOMATION.md §16）。
 *
 * 为什么不放开 `file:`：`url-policy` 拦 `file:` 是红线——页面脚本一旦能读 `file:` 就能读本机任意文件。
 * 这里换成「主进程起一个只监听回环的只读静态服务」，内置浏览器通过 `http://<token>.localhost:<随机端口>/<文件名>` 访问：
 * 这个地址不是 Flowship 自己的地址（不违反「AI 不能访问 Flowship」），AI 也能照常用 `browser_*` 工具调试它；
 * 而页面脚本即使是恶意的，也只读得到「那个 HTML 所在目录」里本来就要展示的文件。
 *
 * **每个 token 一个 origin（R7-07）**：token 放在主机名里（`<48 位小写 hex>.localhost`），不放在路径里——
 *  - 不同 token 的页面是不同 origin：localStorage / IndexedDB / BroadcastChannel / cookie 互不可见，也读写不到 `127.0.0.1:<任意端口>` 的 cookie；
 *  - 路径就是相对根目录的路径，`vite build` 产出的 `/assets/app.js` 这类根绝对路径资源自然可用；
 *  - Chromium 把 `*.localhost` 直接解析成回环（不走系统 DNS、不走代理），所以不需要改 hosts。
 *
 * 守卫（缺一不可，`tests/browser-local-html-server.test.ts` 逐条钉住并做过变异）：
 *  1. **范围**：只服务入口 HTML 的真实（realpath）所在目录；入口所在目录「过宽」（文件系统根 / 家目录 / 桌面 / 下载 / 临时目录 / 凭据目录 /
 *     同步盘 / 挂载点根…）时**退化为单文件模式**——只服务这一个 HTML，相对路径的样式 / 脚本 / 图片不会加载
 *     （宁可页面不完整，也不把整个家目录交给页面脚本）；
 *  2. **token**：每次打开生成 192 位随机 token，滑动空闲 30 分钟过期 + 绝对 4 小时上限，同时最多 32 个（超出挤掉最久没用的）；
 *     没有任何有效 token 时服务自己关掉（下次打开再起），所以「没人在看」时本机没有任何监听端口；
 *  3. **路径**：请求路径逐段解码；`..` / `.` / 空段 / 反斜杠 / NUL / Windows 的盘符与保留字符一律 404；再对拼出的路径做 `realpath`，
 *     结果必须仍在 realpath(root) 之内（符号链接逃逸被拒）；单文件模式下只认入口本身；以 `O_NOFOLLOW | O_NONBLOCK` 打开，
 *     打开后第一件事 `fstat`，不是普通文件（FIFO / socket / 设备）立刻关掉 404——否则 `open(O_RDONLY)` 会在 FIFO 上永久阻塞 libuv 线程池（R7-03）；
 *  4. **敏感文件**：相对根目录的任何一段以点开头（`.env` / `.git` / `.ssh` …）、私钥 / 凭据类的名字与扩展名一律 404——
 *     请求路径和 realpath 之后的路径各查一遍（`a.html -> .env` 这类链接也拦得住）；
 *  5. **只读**：只放行 GET / HEAD；不列目录（目录一律 404）；
 *  6. **Host 校验**：Host 必须恰为 `<有效 token>.localhost:<本服务端口>`（小写、不接受别的写法 / 后缀匹配；防 DNS 重绑定，同时把
 *     「这个请求属于哪个 token」固定下来）；`Sec-Fetch-Site: cross-site` 的请求也拒（页面 A 去取页面 B 的资源就是 cross-site）；
 *  7. **响应头**：不发任何 CORS 放行头；`X-Content-Type-Options: nosniff`、`Cross-Origin-Resource-Policy: same-origin`、`Cache-Control: no-store`、
 *     `Referrer-Policy: no-referrer`；
 *  8. **大小上限**：单个文件 > 50MB 拒（413）；入口 HTML 在打开时就检查；
 *  9. **连接上限**：`maxConnections`、头 / 请求 / 空闲超时都收紧且可注入（R7-06）——本机任意进程不需要 token 就能连上端口，
 *     不能让它靠空闲连接耗尽主进程的 fd；
 * 10. **端口**：绝不使用 Flowship 自己的端口 / 8676 / 8776 / 8876（随机到了就换一个），同端口同时监听 `[::1]`（Chromium 对 `*.localhost`
 *     会同时试 IPv6 与 IPv4，只听 IPv4 时别的进程抢先占 `[::1]:<同端口>` 就能收到带 token 的请求）；`[::1]` 被占就换端口，没有 IPv6 回环就只听 IPv4。
 *
 * 所有拒绝一律返回同一个 404（Host / 方法 / 跨站 / 过大 / Range 不可满足除外）——不给探测路径是否存在的口子。
 * 销毁后服务不能复活：`revokeAll` 自增 generation，在途的 `open` / 启动流程在每个 await 之后都会核对（R7-04）。
 *
 * 纯 node（fs / http / crypto / os 都可注入，单测用真实临时目录 + 真实回环 http），不 import electron。
 */
import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodeHttp from "node:http";
import nodeOs from "node:os";
import nodePath from "node:path";
import { pipeline } from "node:stream";

import { FLOWSHIP_KNOWN_PORTS } from "./app-origin.mjs";

/** 滑动空闲过期：每次成功的请求都会续期 */
export const LOCAL_HTML_IDLE_TTL_MS = 30 * 60_000;
/** 绝对上限：不管有没有在用，4 小时后一定过期 */
export const LOCAL_HTML_MAX_AGE_MS = 4 * 60 * 60_000;
/** 同时有效的 token 数上限（挤掉最久没用的） */
export const LOCAL_HTML_MAX_TOKENS = 32;
/** 单个文件大小上限 */
export const LOCAL_HTML_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** 同时连接数上限（每个监听各自计） */
export const LOCAL_HTML_MAX_CONNECTIONS = 64;
/** 请求头必须在这个时间内收完（半截头 / 只连不发都按它断开；实际精度取决于 connectionsCheckingInterval） */
export const LOCAL_HTML_HEADERS_TIMEOUT_MS = 10_000;
/** 整个请求必须在这个时间内收完 */
export const LOCAL_HTML_REQUEST_TIMEOUT_MS = 30_000;
/** keep-alive 空闲连接保留多久 */
export const LOCAL_HTML_KEEP_ALIVE_TIMEOUT_MS = 5_000;
/** Node 检查「头 / 请求超时」的间隔（默认 30 秒：会让 10 秒的 headersTimeout 实际变成 30 秒） */
export const LOCAL_HTML_CONNECTIONS_CHECK_INTERVAL_MS = 2_000;
/** 过期清扫间隔 */
const SWEEP_INTERVAL_MS = 60_000;
/** 找不到合适端口时最多重试几次（随机到保留端口 / `[::1]` 被占） */
const MAX_BIND_ATTEMPTS = 8;
/** Host 必须长这样：48 位小写 hex 的 token + `.localhost` + 端口（精确匹配，不接受大写 / 末尾点 / 后缀） */
const HOST_SHAPE = /^([0-9a-f]{48})\.localhost:([0-9]{1,5})$/;

const HTML_EXT = /\.html?$/i;

/** 入口文件是不是 `.html` / `.htm` */
export const isHtmlName = (name) => typeof name === "string" && HTML_EXT.test(name);

/** UNC / 网络路径（`\\server\share`、`//server/share`） */
const isUncPath = (p) => /^[\\/]{2}/.test(p);

// ───────────────────────── 敏感文件 ─────────────────────────

/**
 * 最后一段文件名命中就不服务（私钥 / 证书库 / 密钥库 / 密码库 / 凭据 / 状态文件）。
 * 刻意写成「具体的名字 / 扩展名」而不是 `id_*` `*secret*` `*token*` 这种宽匹配：前端目录里 `tokens.json`（设计令牌）、`env.js`、`key.png`、
 * `keyboard.css`、`secret-santa.html`、`id_map.js` 都很常见，被拦的代价虽然只是 404，也不能把正常页面拦掉（有「放行样本」测试钉住）。
 */
const SENSITIVE_PATTERNS = [
  // 扩展名：私钥 / 证书 / 密钥库 / 密码库 / VPN 配置 / keytab / `foo.env`
  /\.(pem|key|p12|pfx|p8|jks|keystore|kdbx|ppk|gpg|pgp|ovpn|keytab|env)$/i,
  // Terraform：状态（含 .backup）与变量文件
  /\.tfstate(\.[^.]+)?$/i,
  /\.tfvars(\.json)?$/i,
  // SSH：密钥类型是有限集合，`id_rsa_work` / `id_ed25519_sk.pub` 都算
  /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?([._-].*)?$/i,
  /^(known_hosts|authorized_keys|_netrc)$/i,
  // kubeconfig
  /^kubeconfig(\.(ya?ml|json|conf))?$/i,
  /\.kubeconfig$/i,
  // 凭据 / 密钥文件
  /^credentials(\.(json|ya?ml|txt|csv|xml|ini|toml))?$/i,
  /[-_.]credentials\.(json|ya?ml|txt|csv|xml|ini|toml)$/i,
  /^secrets?\.(json|ya?ml|txt|env|ini|toml)$/i,
  /^client[-_]secrets?.*\.json$/i,
  /^firebase-adminsdk-.*\.json$/i,
  /^service[-_]?account.*\.json$/i,
];

/**
 * 相对根目录的路径里有没有「不该给页面的文件」：任何一段以点开头，或最后一段命中私钥 / 凭据的名字 / 扩展名。
 * 这是启发式的补充，真正的边界是「只服务那个目录」。
 * @param {string[]} segments 相对根目录的路径段（已解码）
 */
export const isSensitiveSegments = (segments) => {
  for (const seg of segments) {
    if (seg.startsWith(".")) return true;
  }
  const last = segments[segments.length - 1] ?? "";
  return SENSITIVE_PATTERNS.some((re) => re.test(last));
};

// ───────────────────────── 目录是不是「过宽」 ─────────────────────────

/**
 * 家目录下的这些子目录里常堆满不相干的文件：HTML 直接放在它们里面也按「过宽」处理（只判恰好这一层）。
 * R7-13：补上 macOS 的 `Sites`、Windows / Linux 的 `Videos` / `Templates`、`~/node_modules`，以及中文 Linux（XDG）的本地化目录名
 * （`下载` `桌面` `文档` `图片` `音乐` `视频` `公共` `模板`——英文的 `Downloads` / `Desktop` 早就在名单里）。
 */
const HOME_BROAD_CHILDREN = [
  "Desktop",
  "Documents",
  "Downloads",
  "Pictures",
  "Movies",
  "Music",
  "Public",
  "Applications",
  "Videos",
  "Templates",
  "Sites",
  "node_modules",
  "下载",
  "桌面",
  "文档",
  "图片",
  "音乐",
  "视频",
  "公共",
  "模板",
];
/**
 * 家目录下这些前缀的一级目录是同步盘根（`OneDrive - Corp`、`iCloudDrive`、`Google Drive`、`Dropbox (Personal)`）：恰好这一层过宽。
 * R7-13：补上常见的海外 / 国内同步盘与网盘（前缀匹配，因为很多带账号 / 公司后缀）。全部小写。
 */
const HOME_SYNC_PREFIXES = [
  "icloud",
  "dropbox",
  "onedrive",
  "google drive",
  "googledrive",
  "nextcloud",
  "owncloud",
  "pcloud",
  "megasync",
  "seafile",
  "syncthing",
  "synologydrive",
  "synology drive",
  "yandex.disk",
  "creative cloud",
  "tresorit",
  "box sync",
  "nutstore",
  "坚果云",
  "百度网盘",
  "baidunetdisk",
  "wpsdrive",
];
/** 太短、前缀匹配会误伤正常项目目录（`boxes`、`sync-tool`、`megaman`）的同步盘名：只认**整个名字**（小写）相等 */
const HOME_SYNC_EXACT = ["box", "mega", "sync"];
/** 家目录下整棵子树都过宽：macOS 的应用数据 / 同步盘（`Library/CloudStorage`、`Library/Mobile Documents`）、Windows 的 AppData */
const HOME_BROAD_SUBTREES = ["Library", "AppData"];
const SYSTEM_BROAD_DIRS = ["/var/tmp", "/private/tmp", "/private/var", "/private/var/tmp", "/usr/share", "/usr/local", "/mnt"];
/** R7-13（P4）：系统里放凭据 / 数据库的整棵子树（posix）：HTML 放在它们下面任何一层都按过宽处理 */
const SYSTEM_BROAD_SUBTREES = ["/System", "/Library/Keychains", "/private/var/db", "/private/var/root"];

/** `rel`（`path.relative(base, dir)` 的结果）表示 dir 在 base 之内（含 base 本身）？`..foo` 这种以 `..` 开头的普通目录名不算「在外面」 */
const isWithin = (rel, path) => rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));

/**
 * 入口所在目录（已 realpath）是不是「过宽」：
 *  - 文件系统根及其一级子目录（`/tmp` `/Users` `/opt` `C:\Users` …）、系统共享目录、临时目录、系统凭据 / 数据库子树（`/System` `/Library/Keychains` `/private/var/db` `/private/var/root`，posix）；
 *  - 挂载点根（`/Volumes/<x>` `/mnt/<x>` `/media/<u>/<x>` `/run/media/<u>/<x>`，恰好这一层）；
 *  - 其它用户的家目录（`/Users/<name>` `/home/<name>`）——不依赖是否取得到当前用户的 home；
 *  - 家目录本身、家目录下的 Desktop / Documents / Downloads 等（恰好这一层；含中文 XDG 目录名）、同步盘根（前缀匹配 / 短名整名匹配，恰好这一层）、
 *    同步盘根下的已知文件夹（`OneDrive\\Desktop`、`OneDrive - Corp\\Documents`，R7-13）；
 *  - 家目录下**任一祖先段以点开头**的整棵子树（`~/.ssh` `~/.aws` `~/.config/gcloud` `~/.cursor/…`）、`~/Library` 与 `~/AppData` 整棵子树。
 * 过宽 → 单文件模式。更深的普通项目目录（`~/Documents/site/` 之类）不算。
 *
 * @param {string} realDir 已 realpath 的目录
 * @param {{ path?: typeof nodePath, home?: string, tmp?: string, platform?: string }} [deps] home / tmp 也要是 realpath 之后的
 */
export const isBroadRoot = (realDir, { path = nodePath, home = "", tmp = "", platform = process.platform } = {}) => {
  const fold = (p) => (platform === "win32" ? p.toLowerCase() : p);
  const dir = fold(path.resolve(realDir));
  const fsRoot = fold(path.parse(dir).root);
  if (dir === fsRoot) return true;
  const fromRoot = path.relative(fsRoot, dir).split(path.sep).filter(Boolean);
  // 文件系统根的一级子目录：/tmp /Users /home /opt /etc /Volumes、C:\Users …
  if (fromRoot.length <= 1) return true;
  if (SYSTEM_BROAD_DIRS.some((d) => fold(path.resolve(d)) === dir)) return true;
  if (platform !== "win32" && SYSTEM_BROAD_SUBTREES.some((d) => isWithin(path.relative(d, dir), path))) return true;
  if (tmp && dir === fold(path.resolve(tmp))) return true;
  // 其它用户的家目录：/Users/<name>、/home/<name>（C:\Users\<name>）
  if (fromRoot.length === 2 && (fromRoot[0] === fold("Users") || fromRoot[0] === "home")) return true;
  // 挂载点根（posix）
  if (platform !== "win32") {
    const [a, b] = fromRoot;
    if ((a === "Volumes" || a === "mnt") && fromRoot.length === 2) return true;
    if (a === "media" && fromRoot.length === 3) return true;
    if (a === "run" && b === "media" && fromRoot.length === 4) return true;
  }
  if (home) {
    const h = fold(path.resolve(home));
    const rel = path.relative(h, dir);
    if (rel === "") return true;
    if (isWithin(rel, path)) {
      const segs = rel.split(path.sep).filter(Boolean);
      // 任一祖先段点开头：~/.ssh ~/.aws ~/.config/gcloud ~/.cursor/projects/x …
      if (segs.some((s) => s.startsWith("."))) return true;
      if (HOME_BROAD_SUBTREES.some((s) => segs[0] === fold(s))) return true;
      const isHomeBroadChild = (name) => HOME_BROAD_CHILDREN.some((c) => name === fold(c));
      const isSyncRoot = (name) => {
        const lower = name.toLowerCase();
        return HOME_SYNC_EXACT.includes(lower) || HOME_SYNC_PREFIXES.some((p) => lower.startsWith(p));
      };
      if (segs.length === 1 && (isHomeBroadChild(segs[0]) || isSyncRoot(segs[0]))) return true;
      // R7-13：同步盘根下的「已知文件夹」——Windows 11 默认把桌面 / 文档 / 图片重定向进 OneDrive（`OneDrive\Desktop`、
      // `OneDrive - Corp\Documents`），用户和 AI 最常把 HTML 放的恰好是桌面；与 `~/Desktop` 同口径（恰好这一层）
      if (segs.length === 2 && isSyncRoot(segs[0]) && isHomeBroadChild(segs[1])) return true;
    }
  }
  return false;
};

// ───────────────────────── 内容类型 ─────────────────────────

const MIME = {
  html: "text/html",
  htm: "text/html",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  wasm: "application/wasm",
  pdf: "application/pdf",
};

/** 文件名 → Content-Type（未知扩展名一律 octet-stream，配合 nosniff 不让浏览器猜） */
export const contentTypeOf = (name) => {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return (m && MIME[m[1].toLowerCase()]) || "application/octet-stream";
};

/** HTML 自己声明了非 UTF-8 的 charset（`<meta charset=gbk>`）时不要在响应头里强加 utf-8；没声明的按 utf-8（否则中文页会乱码） */
const htmlContentType = (head) => {
  const m = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  if (m && !/^utf-?8$/i.test(m[1])) return "text/html";
  return "text/html; charset=utf-8";
};

// ───────────────────────── 请求路径解析（纯函数） ─────────────────────────

/**
 * `req.url` → 相对根目录的路径段；任何不合法（编码 / `..` / 空段 / 反斜杠 / NUL / Windows 保留字符）或没有路径段（根 `/`）返回 null。
 * 不用 `new URL()`：WHATWG 会把 `/a/../x` 悄悄折叠成 `/x`，我们要的是「看到 `..` 就拒」。
 * token 不在路径里（在 Host 里），这里只管路径。
 * @param {string} rawUrl
 * @param {{ platform?: string }} [opts]
 * @returns {string[] | null}
 */
export const parseRequestPath = (rawUrl, { platform = process.platform } = {}) => {
  if (typeof rawUrl !== "string" || rawUrl.length > 4096 || !rawUrl.startsWith("/")) return null;
  const cut = rawUrl.search(/[?#]/);
  const pathname = cut >= 0 ? rawUrl.slice(0, cut) : rawUrl;
  const raw = pathname.slice(1).split("/");
  const segments = [];
  for (const piece of raw) {
    let seg;
    try {
      seg = decodeURIComponent(piece);
    } catch {
      return null;
    }
    // 空段（`//` 或以 `/` 结尾的目录请求 / 根）、`.`、`..` 一律拒
    if (seg === "" || seg === "." || seg === "..") return null;
    if (seg.includes("/") || seg.includes("\\") || seg.includes("\0")) return null;
    if (platform === "win32" && (/[:*?"<>|]/.test(seg) || /[. ]$/.test(seg))) return null;
    segments.push(seg);
  }
  return segments;
};

/**
 * `Host` 头 → token；不是「`<48 位小写 hex>.localhost:<port>`」或端口不等于本服务端口返回 null。
 * @param {unknown} host
 * @param {number} port
 */
export const parseHostToken = (host, port) => {
  if (typeof host !== "string") return null;
  const m = HOST_SHAPE.exec(host);
  if (!m || Number(m[2]) !== port || String(Number(m[2])) !== m[2]) return null;
  return m[1];
};

/**
 * `Range` 头 → 单段字节范围。只认 `bytes=a-b` / `bytes=a-` / `bytes=-n` 一段；多段 / 别的单位 / 语法不对一律忽略（返回 null = 按 200 整个发，RFC 允许）；
 * 语法对但取不到（起点超出文件）返回 "unsatisfiable"（416）。
 * @param {unknown} header
 * @param {number} size 文件大小
 * @returns {{ start: number, end: number } | "unsatisfiable" | null}
 */
export const parseRange = (header, size) => {
  if (typeof header !== "string") return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    // 后缀：最后 n 字节
    const n = Number(b);
    if (!Number.isSafeInteger(n)) return null;
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (!Number.isSafeInteger(start)) return null;
  const end = b === "" ? size - 1 : Number(b);
  if (!Number.isSafeInteger(end)) return null;
  if (b !== "" && end < start) return null; // 语法无效：忽略
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
};

/** `child` 是否在 `root` 之内（含自身）：按路径段比较，`/a/bc` 不算在 `/a/b` 里 */
export const isInsideRoot = (root, child, path = nodePath) => {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// ───────────────────────── 服务 ─────────────────────────

/**
 * @param {{
 *   fs?: typeof nodeFs, path?: typeof nodePath, http?: typeof nodeHttp, crypto?: typeof nodeCrypto, os?: typeof nodeOs,
 *   now?: () => number, log?: (msg: string) => void, platform?: string,
 *   isReservedPort?: (port: number) => boolean,
 *   limits?: {
 *     idleTtlMs?: number, maxAgeMs?: number, maxTokens?: number, maxFileBytes?: number,
 *     maxConnections?: number, headersTimeoutMs?: number, requestTimeoutMs?: number, keepAliveTimeoutMs?: number, connectionsCheckIntervalMs?: number,
 *   },
 * }} [deps] isReservedPort：除了 Flowship 约定端口（8676 / 8776 / 8876）以外还不能用的端口（壳注入「Flowship 自己的端口」）
 */
export const createLocalHtmlServer = (deps = {}) => {
  const fs = deps.fs ?? nodeFs;
  const path = deps.path ?? nodePath;
  const http = deps.http ?? nodeHttp;
  const crypto = deps.crypto ?? nodeCrypto;
  const os = deps.os ?? nodeOs;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const platform = deps.platform ?? process.platform;
  const idleTtlMs = deps.limits?.idleTtlMs ?? LOCAL_HTML_IDLE_TTL_MS;
  const maxAgeMs = deps.limits?.maxAgeMs ?? LOCAL_HTML_MAX_AGE_MS;
  const maxTokens = deps.limits?.maxTokens ?? LOCAL_HTML_MAX_TOKENS;
  const maxFileBytes = deps.limits?.maxFileBytes ?? LOCAL_HTML_MAX_FILE_BYTES;
  const maxConnections = deps.limits?.maxConnections ?? LOCAL_HTML_MAX_CONNECTIONS;
  const headersTimeoutMs = deps.limits?.headersTimeoutMs ?? LOCAL_HTML_HEADERS_TIMEOUT_MS;
  const requestTimeoutMs = deps.limits?.requestTimeoutMs ?? LOCAL_HTML_REQUEST_TIMEOUT_MS;
  const keepAliveTimeoutMs = deps.limits?.keepAliveTimeoutMs ?? LOCAL_HTML_KEEP_ALIVE_TIMEOUT_MS;
  const connectionsCheckIntervalMs = deps.limits?.connectionsCheckIntervalMs ?? LOCAL_HTML_CONNECTIONS_CHECK_INTERVAL_MS;
  const isReservedPort = (p) => FLOWSHIP_KNOWN_PORTS.includes(p) || (typeof deps.isReservedPort === "function" && deps.isReservedPort(p) === true);

  /** @type {Map<string, { realRoot: string, entryReal: string, scope: "dir" | "file", createdAt: number, lastUsedAt: number }>} */
  const tokens = new Map();
  /** 监听中的 http.Server：IPv4 回环一个，`[::1]` 可选一个（同端口） */
  let servers = [];
  let port = 0;
  let starting = null;
  let sweepTimer = null;
  /** `revokeAll` 自增：在途的启动 / open 在每个 await 之后核对，发现变了就自己收拾干净（销毁后不能复活） */
  let generation = 0;

  const SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };

  const reply = (res, status, body = "", extra = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...extra });
    res.end(body);
  };
  const notFound = (res) => reply(res, 404, "Not Found");
  /**
   * 还没证明自己有 token 的请求（方法不对 / Host 不合格 / 跨站）：回完就断开，不保持连接（R7-14-3）。
   * 本机任意进程不需要 token 就能连上端口；若这些拒绝保持 keep-alive，64 个连接每 3 秒发一次请求就能把 `maxConnections` 占满，
   * 带正确 Host 的真页面请求会被拒（实测 14 秒内 64/64）。持有有效 token 的请求（含它们的 404）仍走 keep-alive，页面不受影响。
   */
  const rejectAndClose = (res, status, body, extra = {}) => reply(res, status, body, { Connection: "close", ...extra });

  const expired = (entry, t) => t - entry.lastUsedAt > idleTtlMs || t - entry.createdAt > maxAgeMs;

  const realpathOrNull = async (p) => {
    try {
      return await fs.promises.realpath(p);
    } catch {
      return null;
    }
  };

  const closeServer = (s, force) => {
    try {
      s.close();
      if (force) s.closeAllConnections?.();
      else s.closeIdleConnections?.();
    } catch {
      /* 已经关了 */
    }
  };

  /** force=true（撤销全部 / 退出）连在途连接一起断；否则只关监听 + 空闲连接，在途的那个请求（比如刚发现自己过期的）还能把 404 回完 */
  const stopServer = (force = false) => {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    const list = servers;
    servers = [];
    port = 0;
    starting = null;
    for (const s of list) closeServer(s, force);
  };

  /** 清掉过期 token；一个有效的都不剩就把服务关掉 */
  const sweep = () => {
    const t = now();
    for (const [k, v] of tokens) if (expired(v, t)) tokens.delete(k);
    if (tokens.size === 0) stopServer();
  };

  /** 解析请求 → 有效的 { entry, real } 或 null（一律当 404） */
  const resolveRequest = async (token, rawUrl) => {
    const segments = parseRequestPath(rawUrl, { platform });
    if (!segments) return null;
    const entry = tokens.get(token);
    if (!entry) return null;
    const t = now();
    if (expired(entry, t)) {
      tokens.delete(token);
      if (tokens.size === 0) stopServer();
      return null;
    }
    // 请求路径本身就带敏感段 / 点开头 → 不用碰磁盘
    if (isSensitiveSegments(segments)) return null;
    const real = await realpathOrNull(path.join(entry.realRoot, ...segments));
    // 范围守卫（符号链接逃逸）：真实路径必须仍在根目录内。
    // 注：posix 下逃出去的相对路径以 `..` 开头，会被下面的"点开头"规则二次兜底（所以单独去掉这一行变异测试不红，
    // 属纵深防御的冗余）；Windows 跨盘符时 relative 返回绝对路径，不带点，只有这一行能拦——别当死代码删（有 win32 注入用例钉住）。
    if (!real || !isInsideRoot(entry.realRoot, real, path)) return null;
    if (entry.scope === "file" && real !== entry.entryReal) return null;
    // realpath 之后再查一遍：`a.html -> .env` / `x.txt -> id_rsa` 这类链接
    const relReal = path.relative(entry.realRoot, real).split(path.sep).filter(Boolean);
    if (relReal.length === 0 || isSensitiveSegments(relReal)) return null;
    entry.lastUsedAt = t;
    return { entry, real };
  };

  const handle = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return rejectAndClose(res, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
    }
    // DNS 重绑定 + 把请求归属到某个 token：Host 必须恰为 `<有效 token>.localhost:<本服务端口>`
    const token = parseHostToken(req.headers.host, port);
    if (token === null || !tokens.has(token)) return rejectAndClose(res, 403, "Forbidden");
    if (req.headers["sec-fetch-site"] === "cross-site") return rejectAndClose(res, 403, "Forbidden");

    const hit = await resolveRequest(token, req.url);
    if (!hit) return notFound(res);

    // O_NOFOLLOW：realpath 之后到 open 之间若末级被换成链接，open 直接失败而不是跟过去。
    // O_NONBLOCK：目录里的 FIFO 会让 open(O_RDONLY) 永久阻塞（占住 libuv 线程池，4 个请求就冻住主进程的 fs / dns / crypto）——
    // 非阻塞地打开，然后立刻 fstat 判断是不是普通文件（R7-03）。
    let fh = null;
    try {
      fh = await fs.promises.open(hit.real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      const st = await fh.stat();
      if (!st.isFile()) {
        await fh.close();
        fh = null;
        return notFound(res);
      }
      if (st.size > maxFileBytes) {
        await fh.close();
        fh = null;
        return reply(res, 413, "Payload Too Large");
      }
      let type = contentTypeOf(hit.real);
      if (type === "text/html") {
        const buf = Buffer.alloc(Math.min(1024, st.size));
        if (buf.length > 0) await fh.read(buf, 0, buf.length, 0);
        type = htmlContentType(buf.toString("latin1"));
      }
      // 单段 Range（<audio> / <video> 拖进度条要它）；If-Range 我们没有校验器可比，按 RFC 忽略 Range 发整个文件；HEAD 不看 Range
      let range = null;
      if (req.method === "GET" && req.headers["if-range"] === undefined) range = parseRange(req.headers.range, st.size);
      if (range === "unsatisfiable") {
        await fh.close();
        fh = null;
        return reply(res, 416, "", { "Content-Range": `bytes */${st.size}`, "Accept-Ranges": "bytes" });
      }
      const partial = range !== null;
      const start = partial ? range.start : 0;
      const end = partial ? range.end : st.size - 1;
      const headers = { ...SECURITY_HEADERS, "Accept-Ranges": "bytes", "Content-Type": type, "Content-Length": partial ? end - start + 1 : st.size };
      if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
      res.writeHead(partial ? 206 : 200, headers);
      if (req.method === "HEAD" || st.size === 0) {
        await fh.close();
        fh = null;
        return res.end();
      }
      // end 钉在 fstat 的大小上：读的过程中文件被追加也不会超出 Content-Length
      const stream = fh.createReadStream({ start, end, autoClose: true });
      fh = null; // 所有权交给 stream（autoClose）
      // pipeline 统一三方清理（R7-04a）：客户端中途断开 → 销毁 stream（关 fd）；stream 出错 → 销毁 res；
      // 客户端在上面那些 await 期间就已经断开（res 已销毁）时，pipeline 同样会立刻销毁 stream——不需要自己再挂 close 监听
      // （「close 监听注册得太晚、早断连就永远不触发」是旧实现泄漏 FileHandle 的原因，tests 里有真实复现）。
      pipeline(stream, res, () => {});
    } catch {
      if (fh) await fh.close().catch(() => {});
      if (!res.headersSent) notFound(res);
      else res.destroy();
    }
  };

  const makeServer = () => {
    const s = http.createServer(
      {
        connectionsCheckingInterval: connectionsCheckIntervalMs,
        headersTimeout: headersTimeoutMs,
        requestTimeout: requestTimeoutMs,
        keepAliveTimeout: keepAliveTimeoutMs,
      },
      (req, res) => {
        handle(req, res).catch(() => {
          if (!res.headersSent) notFound(res);
          else res.destroy();
        });
      },
    );
    s.maxConnections = maxConnections;
    s.on("clientError", (_err, socket) => socket.destroy());
    // 启动阶段（listen 回调与 ensureStarted 挂日志监听之间）的 error 也要有人接，否则会变成未捕获异常
    s.on("error", () => {});
    return s;
  };

  /** 在指定 host:port 上监听；成功 resolve 实际端口，失败 reject（错误带 `code`） */
  const listenOn = (s, host, wantPort) =>
    new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      s.once("error", onError);
      s.listen({ host, port: wantPort }, () => {
        s.off("error", onError);
        resolve(s.address().port);
      });
    });

  const revoked = () => Object.assign(new Error("本地 HTML 服务已撤销"), { code: "REVOKED" });

  /**
   * 起监听：先在 127.0.0.1 随机端口上起，端口是保留端口就换；再在同端口上尝试 `[::1]`：被别的进程占了就整体换端口，没有 IPv6 回环就只听 IPv4。
   * @param {number} gen 启动时的 generation
   */
  const startListeners = async (gen) => {
    for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
      const s4 = makeServer();
      let p;
      try {
        p = await listenOn(s4, "127.0.0.1", 0);
      } catch (err) {
        closeServer(s4, true);
        throw err;
      }
      if (gen !== generation) {
        closeServer(s4, true);
        throw revoked();
      }
      if (isReservedPort(p)) {
        closeServer(s4, true);
        continue;
      }
      const list = [s4];
      const s6 = makeServer();
      try {
        await listenOn(s6, "::1", p);
        list.push(s6);
      } catch (err) {
        closeServer(s6, true);
        if (err?.code === "EADDRINUSE") {
          closeServer(s4, true);
          continue;
        }
        log(`[browser] 本地 HTML 服务：IPv6 回环不可用（${err?.code ?? err?.message ?? err}），只监听 IPv4`);
      }
      if (gen !== generation) {
        for (const s of list) closeServer(s, true);
        throw revoked();
      }
      return { list, port: p };
    }
    throw new Error("找不到可用的本地端口");
  };

  const ensureStarted = () => {
    if (servers.length > 0 && port) return Promise.resolve();
    if (starting) return starting;
    const gen = generation;
    const p = startListeners(gen)
      .then(({ list, port: listening }) => {
        servers = list;
        port = listening;
        for (const s of list) s.on("error", (err) => log(`[browser] 本地 HTML 服务出错：${err?.message || err}`));
        sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
        sweepTimer.unref?.();
      })
      .finally(() => {
        if (starting === p) starting = null;
      });
    starting = p;
    return p;
  };

  /**
   * 登记一个本地 HTML，返回内置浏览器该打开的地址。
   * @param {unknown} absPath 入口 HTML 的绝对路径
   * @returns {Promise<{ ok: true, url: string, scope: "dir" | "file" } | { ok: false, error: string }>}
   */
  const open = async (absPath) => {
    if (typeof absPath !== "string" || absPath === "" || absPath.length > 4096 || absPath.includes("\0")) return { ok: false, error: "无效的文件路径" };
    if (!path.isAbsolute(absPath)) return { ok: false, error: "需要绝对路径" };
    // UNC / 网络路径不服务（网络盘上的 realpath / 权限语义不可靠）。拒绝发生在碰任何文件系统之前。
    if (isUncPath(absPath)) return { ok: false, error: "不支持网络路径" };
    if (!isHtmlName(absPath)) return { ok: false, error: "只能打开 .html / .htm 文件" };
    const gen = generation;
    const entryReal = await realpathOrNull(absPath);
    if (!entryReal) return { ok: false, error: "文件不存在或无法访问" };
    // 映射盘符 / 符号链接可能 realpath 成 UNC：结果也要查一遍
    if (isUncPath(entryReal)) return { ok: false, error: "不支持网络路径" };
    // 链接指向的真实文件也必须是 HTML、且不是敏感文件（`x.html -> ~/.ssh/id_rsa`）
    const entryName = path.basename(entryReal);
    if (!isHtmlName(entryName) || isSensitiveSegments([entryName])) return { ok: false, error: "这个文件不能在内置浏览器里打开" };
    let st;
    try {
      st = await fs.promises.stat(entryReal);
    } catch {
      return { ok: false, error: "文件不存在或无法访问" };
    }
    if (!st.isFile()) return { ok: false, error: "不是普通文件" };
    if (st.size > maxFileBytes) return { ok: false, error: "文件太大（超过 50MB）" };

    const realRoot = path.dirname(entryReal);
    const broad = isBroadRoot(realRoot, {
      path,
      platform,
      home: (await realpathOrNull(os.homedir())) ?? os.homedir(),
      tmp: (await realpathOrNull(os.tmpdir())) ?? os.tmpdir(),
    });
    const scope = broad ? "file" : "dir";

    try {
      await ensureStarted();
    } catch (err) {
      if (gen !== generation) return { ok: false, error: "内置浏览器已关闭" };
      log(`[browser] 本地 HTML 服务启动失败：${err?.message || err}`);
      return { ok: false, error: "本地服务启动失败" };
    }
    // open 在途时被 revokeAll：不能复活服务，也不能留下一个没有 token 的孤儿监听
    if (gen !== generation) {
      if (tokens.size === 0) stopServer();
      return { ok: false, error: "内置浏览器已关闭" };
    }
    const t = now();
    // 挤掉过期的；仍满了就挤掉最久没用的
    for (const [k, v] of tokens) if (expired(v, t)) tokens.delete(k);
    while (tokens.size >= maxTokens) {
      let oldest = null;
      for (const [k, v] of tokens) if (oldest === null || v.lastUsedAt < tokens.get(oldest).lastUsedAt) oldest = k;
      tokens.delete(oldest);
    }
    // 小写 hex：主机名会被浏览器小写化，token 字母表必须本来就是小写；48 个字符 = 192 位，单个 DNS label ≤ 63
    const token = crypto.randomBytes(24).toString("hex");
    tokens.set(token, { realRoot, entryReal, scope, createdAt: t, lastUsedAt: t });
    log(`[browser] 本地 HTML 已登记（范围 ${scope}，当前 ${tokens.size} 个有效）`);
    return { ok: true, url: `http://${token}.localhost:${port}/${encodeURIComponent(entryName)}`, scope };
  };

  /** 撤销全部 token 并关掉服务（会话销毁 / 应用退出）。generation 自增：在途的 open / 启动不会把服务复活 */
  const revokeAll = () => {
    generation += 1;
    tokens.clear();
    stopServer(true);
  };

  return {
    open,
    revokeAll,
    /** 测试 / 诊断用：当前有效 token 数与监听端口（没在监听 = 0） */
    stats: () => ({ tokens: tokens.size, port }),
    /** 测试 / 诊断用：IPv4 / IPv6 回环各自有没有在监听 */
    listening: () => ({ v4: servers.length > 0, v6: servers.length > 1 }),
    /** 测试用：立即清扫一次过期 token */
    sweep,
  };
};
