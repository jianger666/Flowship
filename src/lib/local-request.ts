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

/**
 * 请求是否来自本机页面：
 * - Host 头缺失 / 非 loopback → 拒绝（HTTP/1.1 必带 Host、缺失即异常客户端）
 * - Origin 头存在时（fetch / XHR 必带）其主机名也必须是 loopback；
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
      const originHost = new URL(origin).hostname.toLowerCase();
      // URL().hostname 对 IPv6 返回带方括号形态（Node/浏览器实现差异都有）、两种都认
      if (!LOOPBACK_HOSTS.has(originHost) && !LOOPBACK_HOSTS.has(`[${originHost}]`)) {
        return false;
      }
    } catch {
      return false; // Origin 头格式非法、拒绝
    }
  }
  return true;
};
