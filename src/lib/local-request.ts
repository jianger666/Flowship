/**
 * 本机请求判定（CR-01、纯函数、middleware / 测试共用）
 *
 * 背景：本 app 是单机桌面工具、API 无鉴权但带密钥读取 + shell 执行能力——
 * 除了服务端绑定 127.0.0.1（第一道闸）、再校验 Host / Origin 头（第二道闸、
 * 防 DNS rebinding：攻击者页面用自己的域名指向 127.0.0.1、Host 头会带攻击者域名）。
 *
 * 不依赖 node:*——middleware 跑在 edge-lite runtime、也方便 vitest 直测。
 */

// 允许的 loopback 主机名（IPv4 / IPv6 / localhost）
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Host 头形如 "127.0.0.1:8876" / "localhost:8876" / "[::1]:8876"——剥端口取主机名
const hostnameOf = (host: string): string => {
  const trimmed = host.trim().toLowerCase();
  // IPv6 字面量带方括号（[::1]:8876）——保留方括号形态整体比对
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end >= 0 ? trimmed.slice(0, end + 1) : trimmed;
  }
  const colon = trimmed.indexOf(":");
  return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
};

// Host 头拆 主机名（去方括号）+ 端口（无端口按 http 默认 80）
const hostPortOf = (host: string): { name: string; port: string } => {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    const name = end >= 0 ? trimmed.slice(1, end) : trimmed.slice(1);
    const rest = end >= 0 ? trimmed.slice(end + 1) : "";
    return { name, port: rest.startsWith(":") ? rest.slice(1) : "80" };
  }
  const colon = trimmed.indexOf(":");
  return colon >= 0
    ? { name: trimmed.slice(0, colon), port: trimmed.slice(colon + 1) }
    : { name: trimmed, port: "80" };
};

/**
 * 请求是否来自本机页面：
 * - Host 头缺失 / 非 loopback → 拒绝（HTTP/1.1 必带 Host、缺失即异常客户端）
 * - Origin 头存在时（fetch / XHR 必带）必须与 Host 同源（主机名 + 端口精确一致）——
 *   复审（11 轮）：只认 loopback 主机名不够，本机其它端口的 Web 服务（恶意本地页 /
 *   被投毒的文档站）能以 http://127.0.0.1:任意端口 为 Origin 打进来（本机跨端口
 *   CSRF：读密钥 / 改 previewCommand → RCE 链）。同源 fetch 的 Origin 恒等于页面
 *   自身 host，收紧不影响正常前端。
 *   "null" origin（沙箱 iframe 等）拒绝；顶层导航（如 OAuth callback GET）无 Origin、放行
 */
export const isAllowedLocalRequest = (
  host: string | null,
  origin: string | null,
): boolean => {
  if (!host || !LOOPBACK_HOSTS.has(hostnameOf(host))) return false;
  if (origin !== null && origin !== "") {
    if (origin === "null") return false;
    try {
      const url = new URL(origin);
      const originName = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      const originPort =
        url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
      const hostPart = hostPortOf(host);
      if (originName !== hostPart.name || originPort !== hostPart.port) {
        return false;
      }
    } catch {
      return false; // Origin 头格式非法、拒绝
    }
  }
  return true;
};
