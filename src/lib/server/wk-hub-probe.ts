/**
 * Delivery Hub 可达性探测（服务端发请求；纯逻辑在 `@/lib/wk-hub`）
 *
 * 放服务端而不是浏览器直连的原因：hub 是团队内网机器、没配 CORS，浏览器直连会被
 * 跨域挡住、拿到的报错也分不清「网络不通」还是「被浏览器拦了」。
 */

import {
  hubProbeUrl,
  isArtifactStateShape,
  normalizeHubUrl,
  type WkHubProbeResult,
} from "@/lib/wk-hub";

/** 探测超时：内网机器正常几十毫秒就回，5s 还没动静基本就是不通 */
const PROBE_TIMEOUT_MS = 5000;

/** node fetch 把底层网络错误塞在 cause.code 里（ECONNREFUSED / ENOTFOUND / …） */
const failureMessage = (err: unknown): string => {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return "连接超时，检查地址和内网访问权限";
    }
    const code = (err.cause as { code?: string } | undefined)?.code;
    if (code === "ECONNREFUSED") return "连接被拒绝，服务没起或端口不对";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "域名解析不了";
    if (code) return `连不上（${code}）`;
  }
  return "连不上";
};

/**
 * 探一下这个地址后面是不是活着的 Delivery Hub。
 *
 * @param fetchImpl 便于单测注入；默认走全局 fetch
 */
export const probeWkHub = async (
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WkHubProbeResult> => {
  const base = normalizeHubUrl(rawUrl);
  if (!base) {
    return {
      status: "invalid-url",
      message: "地址格式不对，要形如 http://主机:端口",
    };
  }

  let res: Response;
  try {
    res = await fetchImpl(hubProbeUrl(base), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return { status: "unreachable", message: failureMessage(err) };
  }

  if (!res.ok) {
    // 端口上有服务、但 harness 接口不认——多半是地址填错（指到别的服务）或 hub 版本不对
    return {
      status: "unexpected",
      message: `连上了，但 harness 接口返回 HTTP ${res.status}`,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: "unexpected", message: "连上了，但返回的不是 harness 接口响应" };
  }
  if (!isArtifactStateShape(body)) {
    return { status: "unexpected", message: "连上了，但返回的不是 harness 接口响应" };
  }
  return { status: "ok", message: "已连上 Delivery Hub" };
};
