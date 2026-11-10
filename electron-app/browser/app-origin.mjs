// 「本应用自己的 origin」判定（内置浏览器 URL 策略用，契约 §7 `checkUrl(url, { isAppUrl })`）。
//
// 只拦 Flowship 自己的 server：回环别名（127.0.0.1 / localhost / [::1] / 0.0.0.0 …）**且端口等于 Flowship server 端口**，
// 外加「同机其他 Flowship 实例」的约定端口（8676 网页热更 / 8776 FlowshipTest / 8876 正式包，见 FLOWSHIP_KNOWN_PORTS）。
// 用户预览自己项目的 `localhost:3000` 之类**必须放行**——所以绝不能「所有 localhost 端口都拦」。
//
// 为什么其他实例的端口也要拦（R1-30）：它们和本实例一样是完整的 Flowship server（任务 / 设置 / agent 执行入口都在里面），
// AI 把内置浏览器导航过去再点按钮，等于绕过「不许碰应用自己」的红线去操作另一个实例；而这三个端口是 Flowship 专用的约定端口
// （AGENTS.md 三端口约定），不是用户自己项目会占的端口，拦掉没有误伤。
//
// **安全边界不止这里**：本文件只管「URL 字面上指向哪」。DNS 别名 / 重绑定（evil.com → 127.0.0.1）这类字面判不出来的，
// 靠 server 侧 middleware.ts 对 Host / Origin / Sec-Fetch-Site 的校验（+ local-request.ts、X-Frame-Options）兜底，见契约 §7。
//
// 与 main.js 里已有的 isAppUrl（external-url.mjs 的 isSameAppOrigin）的区别：
// - 那份只认 `http:`（站内页面都是 http）；这里 http / https 都按端口判（https://127.0.0.1:<自己端口> 也不让开，
//   虽然握手会失败，但没必要给 AI 留任何一条指向自己 server 的路）；
// - 端口用 getter 延迟取值：端口在 app 启动期才确定（占用时会换端口），不能在模块加载时固化。
//
// 纯函数、无 Electron 依赖，可单测。

/** 默认端口（URL.port 为空串时按协议补全；`http://127.0.0.1/` 与 `:80` 等价） */
const DEFAULT_PORTS = { "http:": 80, "https:": 443 };

/**
 * 同机其他 Flowship 实例的约定端口（AGENTS.md 三端口约定）：8676 `pnpm dev:web` 网页热更、8776 FlowshipTest 桌面包、8876 正式桌面包。
 * 不论本实例自己是哪个端口，回环别名 + 这三个端口一律当作「应用自己」拦掉。
 * 只拦能确认的：用 `FLOWSHIP_PORT` 自定义出来的别的端口、别的机器上的实例，字面上无从得知，不在这里处理。
 */
export const FLOWSHIP_KNOWN_PORTS = Object.freeze([8676, 8776, 8876]);

/**
 * IPv6 文本 → 16 字节；不是合法 IPv6 返回 null。
 * 接受带方括号的 `URL.hostname` 形态（`[::ffff:7f00:1]`）与裸写法；支持 `::` 压缩与末尾点分 IPv4（`::ffff:127.0.0.1`）；
 * 带 zone id（`%eth0`）的不认（URL 本身也不接受）。
 * @param {string} input
 * @returns {Uint8Array | null}
 */
const parseIPv6 = (input) => {
  let s = String(input ?? "");
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s.includes(":") || s.includes("%")) return null;
  // 末尾的点分 IPv4 先折成两个 16 位组，后面统一按十六进制组解析
  if (s.includes(".")) {
    const colon = s.lastIndexOf(":");
    const parts = s.slice(colon + 1).split(".");
    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
    const [a, b, c, d] = parts.map(Number);
    s = `${s.slice(0, colon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part) => (part === "" ? [] : part.split(":"));
  const head = groupsOf(halves[0]);
  let groups;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const tail = groupsOf(halves[1]);
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // `::` 至少代表一个全零组
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    const n = Number.parseInt(g, 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 0xff;
  });
  return bytes;
};

/** 16 字节 IPv6 是否指向本机：`::1`，或「内嵌 IPv4」是 127.0.0.0/8 / 0.0.0.0 */
const isLoopbackIPv6 = (b) => {
  const zero = (from, to) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 15) && b[15] === 1) return true; // ::1
  // 内嵌 IPv4 的三种前缀（内嵌地址永远在最后 4 字节）：
  //   ::a.b.c.d       IPv4-compatible（已废弃，但 `::7f00:1`、`::` 这类仍会被解析出来）
  //   ::ffff:a.b.c.d  IPv4-mapped（Chromium / 系统会直接按 IPv4 连：`::ffff:0:0` 就是 0.0.0.0）
  //   ::ffff:0:a.b.c.d IPv4-translated（SIIT，RFC 2765）
  const compat = zero(0, 12);
  const mapped = zero(0, 10) && b[10] === 0xff && b[11] === 0xff;
  const translated = zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0;
  if (!compat && !mapped && !translated) return false;
  const [a, ...rest] = [b[12], b[13], b[14], b[15]];
  return a === 127 || (a === 0 && rest.every((x) => x === 0));
};

/**
 * 主机名（`URL.hostname`，WHATWG 已小写并把 `127.1` / `2130706433` / `0x7f.1` 规范化为 `127.0.0.1`、
 * IPv6 保留方括号）是否指向本机回环。
 * 覆盖：127.0.0.0/8、0.0.0.0、`localhost` 与 `*.localhost`（RFC 6761，Chromium 直接解析成回环；末尾带点的写法也算）、
 * IPv6：`[::1]`、`[::]`，以及**内嵌 IPv4 是 127/8 或 0.0.0.0 的各种形态**（R1-30：先解析成 16 字节再判，
 * 不再只认 `::ffff:7fxx:xxxx` 一个字面形状——`[::ffff:0:0]`、`[::7f00:1]`、`[::ffff:0:7f00:1]` 都算）。
 * 没验证：NAT64（`64:ff9b::/96`）/ 6to4（`2002::/16`）/ Teredo 内嵌回环地址——这些要有对应网络环境才会被路由，不在此判。
 * @param {string} hostname
 */
export const isLoopbackHostname = (hostname) => {
  const h = String(hostname ?? "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (/^127\.\d+\.\d+\.\d+$/.test(h) || h === "0.0.0.0" || h === "localhost" || h.endsWith(".localhost")) return true;
  const bytes = parseIPv6(h);
  return bytes !== null && isLoopbackIPv6(bytes);
};

/**
 * 造一个 isAppUrl：回环别名 + 端口 === getPort()。
 * 判定一律走 `new URL()` 解析后的**真实** hostname / port，不做字符串前缀比较——
 * `http://127.0.0.1:8876@evil.com/`（userinfo 伪装）真实 host 是 evil.com → 不是本应用；
 * `http://evil@127.0.0.1:8876/` 真实 host 是回环 + 自己的端口 → 是本应用。
 * 解析失败（相对路径 / 垃圾输入）返回 false（交给 url-policy 的协议白名单去拒）。
 * 「同机其他 Flowship 实例」的约定端口（{@link FLOWSHIP_KNOWN_PORTS}）与 getPort 无关，回环别名 + 这些端口永远算本应用。
 * getPort 取不到有效端口（undefined / NaN / 0 / 抛错）→ 无从判断「哪个端口是自己」，只剩上面那组固定端口会命中，
 * 其余端口返回 false（不误伤用户预览）；main.js 里 PORT 是模块级常量，实际不会走到这条。
 * 端口比较用解析后的数字（`:08876` 与 `:8876` 等价）。
 * @param {() => number | undefined | null} getPort
 * @returns {(url: string) => boolean}
 */
export const createIsAppUrl = (getPort) => (url) => {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  const defaultPort = DEFAULT_PORTS[u.protocol];
  if (defaultPort === undefined) return false; // 只有 http(s) 才可能是本应用的 origin
  if (!isLoopbackHostname(u.hostname)) return false;
  const port = u.port === "" ? defaultPort : Number(u.port);
  if (FLOWSHIP_KNOWN_PORTS.includes(port)) return true;
  let appPort;
  try {
    appPort = Number(getPort());
  } catch {
    return false;
  }
  if (!Number.isInteger(appPort) || appPort <= 0) return false;
  return port === appPort;
};
