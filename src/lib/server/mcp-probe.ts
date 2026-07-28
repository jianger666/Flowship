/**
 * MCP server 连通性探测（V0.6.11）
 *
 * 一套探测、两个用途：
 * 1. 起 agent 前容错（filterHealthyMcp）：剔除连不上 / 未授权的远程 MCP、
 *    单个 MCP 挂不再拖垮整个 SDK run（之前 feishu-project 未授权 401 → 整个 run error）。
 * 2. 设置页 / 任务面板可视（probeMcpHealthAll）：给每个 MCP 标连通状态、不再只有开关。
 *
 * 探测方式跟 mcp-oauth.probeOAuthRequired 一致——发一个 MCP initialize、看 HTTP 响应：
 * - 2xx                 → ok（正常）
 * - 401/403/其它/连不上 → fail（失败、原因落 detail、前端失败可点开看日志）
 * stdio（无 url）本地进程没法 HTTP 探测、乐观标 ok（保留注入、交给 SDK 起进程）。
 *
 * 两种 transport 的探法不同（2026-07-28）：老式 HTTP+SSE（MCP 2024-11-05）的 url 是
 * **GET 建流**端点、POST initialize 过去只会吃 404/405——一律 POST 会把这类 server 全判死。
 * 内网 wk-knowledge（`:8765/sse`：GET 401、POST 404）就是这么被静默剔除的。故：
 * - 认得出是 SSE（显式 type 或 /sse 端点）→ 直接 GET 探
 * - 认不出、POST 又吃 404/405 → 再 GET 兜一次（显式 type: "http" 不兜、那是真坏了）
 * 探测放行还不够：SDK 那边按 Streamable HTTP 连一样连不上，故注入前补 type（见
 * withInferredTransport）。
 *
 * V0.6.13：状态从 4 态（ok/unauthorized/unreachable/local）收敛为 2 态（ok/fail）、
 * 降低噪音（用户拍板）。失败原因不再靠 status 区分、改全部塞进 detail 给日志弹窗看。
 *
 * 注意：探测应在 enrichMcpServersWithOAuth 之后做、这样带上 OAuth token 的 server
 * 才能正确探出 ok / unauthorized（否则飞书项目永远 401）。
 *
 * v1.1.x 提速：起 agent 前的探测（filterHealthyMcp）走 TTL 缓存——每次推进 / 发消息
 * 都真探一轮（单服超时 6s）是「点推进后半天没动静」的固定成本之一。ok / fail 结果均
 * 5 分钟内复用（远大于「60s 内复用」要求）。设置页的 probeMcpHealthAll 保持真探（用户就是
 * 来看真值的）、结果写穿缓存——授权完刷新设置页即可清 fail 缓存、下次起 agent 即新。
 * key 含 headers（OAuth token 变了自然失效）。chat-runner / task-runner 启动链均走
 * filterHealthyMcp，热路径全命中时 mcp 段≈0。
 */

import { createHash } from "node:crypto";

import type { McpServerConfig } from "@cursor/sdk";

import type { McpHealth } from "@/lib/types";

// 探测超时（比 oauth probe 的 5s 略宽、避免慢服务误判连不上）
const PROBE_TIMEOUT_MS = 6000;

// ----------------- 探测结果 TTL 缓存（仅 http server；stdio 本来就秒回不缓存） -----------------

const PROBE_CACHE_OK_MS = 5 * 60_000;
// fail 也缓 5 分钟：长期 401 等每次推进重探白付 6s；设置页 probeMcpHealthAll 真探且写穿缓存，授权后刷新设置页即可清
const PROBE_CACHE_FAIL_MS = 5 * 60_000;
/** 缓存条目上限：超出删最旧（Map 插入序） */
const PROBE_CACHE_MAX_ENTRIES = 200;

// 挂 globalThis：各 route 是不同 chunk、module-level Map 会各持一份（同 runningTasks 老坑）
const G = globalThis as unknown as {
  __feMcpProbeCache?: Map<string, { health: McpHealth; at: number }>;
};
const probeCache = (G.__feMcpProbeCache ??= new Map());

// 缓存 key：sha256(name|url|type|headers)——避免明文 Bearer 进 Map key；token / transport 换了摘要自然变
const probeCacheKey = (name: string, cfg: McpServerConfig): string | null => {
  if (!("url" in cfg)) return null;
  const payload = `${name}|${cfg.url}|${cfg.type ?? ""}|${JSON.stringify(cfg.headers ?? {})}`;
  return createHash("sha256").update(payload).digest("hex");
};

const readProbeCache = (key: string | null): McpHealth | null => {
  if (!key) return null;
  const hit = probeCache.get(key);
  if (!hit) return null;
  const ttl = hit.health.status === "ok" ? PROBE_CACHE_OK_MS : PROBE_CACHE_FAIL_MS;
  return Date.now() - hit.at < ttl ? hit.health : null;
};

const writeProbeCache = (key: string | null, health: McpHealth): void => {
  if (!key) return;
  // 刷新插入序：先删再设，命中续期后仍算「较新」
  if (probeCache.has(key)) probeCache.delete(key);
  probeCache.set(key, { health, at: Date.now() });
  while (probeCache.size > PROBE_CACHE_MAX_ENTRIES) {
    const oldest = probeCache.keys().next().value;
    if (oldest === undefined) break;
    probeCache.delete(oldest);
  }
};

/**
 * 整表失效（run 失败时调、task/chat runner 的失败收口各挂一处）：
 * 缓存 ok 期间 server 挂掉 → 起 agent 带上死 MCP → run 失败——若不清缓存、
 * 用户立刻重试还会命中同一条过期 ok（最长 5 分钟）连续撞。失败就清、重试必真探；
 * 代价只是下次启动多付一轮探测（≤6s）、健康 server 探完立刻回填。
 */
export const invalidateMcpProbeCache = (): void => {
  probeCache.clear();
};

/** 带 url 的远程 server（stdio 分支已在类型上排除） */
type RemoteMcpConfig = Extract<McpServerConfig, { url: string }>;

/** 单次探测的原始结果：拿到响应算 httpCode、连不上算 error */
type ProbeAttempt = { httpCode: number } | { error: string };

/**
 * undici 的 fetch 失败一律 message="fetch failed"、真因（ECONNREFUSED / EHOSTUNREACH /
 * ENOTFOUND…）藏在 cause 里——不摊开的话失败提示等于没说，用户点开日志也无从下手。
 */
const describeFetchError = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (!cause) return err.message;
  if (!(cause instanceof Error)) return `${err.message}（${String(cause)}）`;
  const code = (cause as { code?: string }).code;
  // ECONNREFUSED 这类 code 通常已在 message 里、别拼成「ECONNREFUSED connect ECONNREFUSED …」
  const detail = code && !cause.message.includes(code) ? `${code} ${cause.message}` : cause.message;
  return detail ? `${err.message}（${detail}）` : err.message;
};

/**
 * 判定「老式 HTTP+SSE transport」。两条依据、有先后：
 * 1. 配置显式写了 type——完全以它为准（写了 "http" 却指向 /sse 也照 http 探，
 *    否则会 GET 探出 ok、SDK 却按 Streamable HTTP 连不上，探测反倒放行了一个死的）
 * 2. 没写 type 才看 url：路径以 /sse 结尾——社区约定俗成的建流端点名（尾部斜杠不算数）
 */
const isSseTransport = (cfg: RemoteMcpConfig): boolean => {
  if (cfg.type) return cfg.type === "sse";
  try {
    return new URL(cfg.url).pathname.replace(/\/+$/, "").endsWith("/sse");
  } catch {
    return false;
  }
};

/**
 * 注入给 SDK 前补 transport 标注——探测放行了、SDK 按 Streamable HTTP 去连照样连不上。
 * 只补「推导得出且用户没显式写过」的：写了就尊重、不替用户改主意。
 */
export const withInferredTransport = (cfg: McpServerConfig): McpServerConfig => {
  if (!("url" in cfg) || cfg.type) return cfg;
  return isSseTransport(cfg) ? { ...cfg, type: "sse" } : cfg;
};

/**
 * GET 建流探 SSE 端点：拿到响应头就够判定、立刻 abort。
 * SSE 是长连接、探完不掐会一直占着（服务端还会给它留 session）。
 */
const sendSseHandshake = async (
  url: string,
  headers?: Record<string, string>,
): Promise<ProbeAttempt> => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "text/event-stream", ...(headers ?? {}) },
      redirect: "manual",
      signal: ctl.signal,
    });
    return { httpCode: res.status };
  } catch (err) {
    return { error: describeFetchError(err) };
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
};

// 发 initialize 拿 HTTP 状态码（连不上则返 error）
const sendInitialize = async (
  url: string,
  headers?: Record<string, string>,
): Promise<ProbeAttempt> => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(headers ?? {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "fe-health-probe",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "flowship", version: "0" },
        },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { httpCode: res.status };
  } catch (err) {
    return { error: describeFetchError(err) };
  }
};

/** 把单次探测结果翻成 McpHealth（POST / GET 两条路共用一套判定） */
const classifyAttempt = (
  name: string,
  url: string,
  r: ProbeAttempt,
): McpHealth => {
  // 连不上（超时 / DNS / 连接拒绝）：detail 带 url + 错误原文、点开看日志能直接排查
  if ("error" in r) {
    return { name, status: "fail", detail: `连接失败：${r.error}\nURL：${url}` };
  }
  // 2xx：正常
  if (r.httpCode >= 200 && r.httpCode < 300) {
    return { name, status: "ok", httpCode: r.httpCode };
  }
  // 401/403：需要授权（远程 OAuth MCP 没授权 / token 失效）
  if (r.httpCode === 401 || r.httpCode === 403) {
    return {
      name,
      status: "fail",
      httpCode: r.httpCode,
      detail: `需要授权（HTTP ${r.httpCode}）——去设置页给「${name}」授权\nURL：${url}`,
    };
  }
  // 其它非 2xx 异常状态码（404 / 405 / 5xx 等）
  return {
    name,
    status: "fail",
    httpCode: r.httpCode,
    detail: `服务异常 HTTP ${r.httpCode}\nURL：${url}`,
  };
};

/** 探测单个 MCP server 的连通性 */
const probeMcpHealth = async (
  name: string,
  cfg: McpServerConfig,
): Promise<McpHealth> => {
  // stdio 本地进程：没 url、没法 HTTP 探测、乐观标 ok（交给 SDK 启动时拉起）
  if (!("url" in cfg)) {
    return {
      name,
      status: "ok",
      detail: "本地 stdio 进程、由 SDK 启动时拉起（未做 HTTP 探测）",
    };
  }
  const headers = cfg.headers as Record<string, string> | undefined;

  // 认得出是 SSE：直接 GET 建流（POST 过去必吃 404、白付一轮超时）
  if (isSseTransport(cfg)) {
    return classifyAttempt(name, cfg.url, await sendSseHandshake(cfg.url, headers));
  }

  const r = await sendInitialize(cfg.url, headers);

  // POST 吃 404/405 未必是服务坏了——也可能是没标 type、端点名也不带 /sse 的老式 SSE server，
  // 对它来说 GET 才是入口。显式 type: "http" 的不兜底：那是 Streamable HTTP 的承诺、404 就是真坏。
  // GET 通了按 GET 判；GET 也连不上则退回 POST 的结论（别拿兜底的错遮住原始症状）。
  const worthSseRetry =
    cfg.type !== "http" &&
    !("error" in r) &&
    (r.httpCode === 404 || r.httpCode === 405);
  if (worthSseRetry) {
    const sse = await sendSseHandshake(cfg.url, headers);
    if (!("error" in sse)) return classifyAttempt(name, cfg.url, sse);
  }

  return classifyAttempt(name, cfg.url, r);
};

/**
 * 并发探测所有 MCP server（key=server 名）——**真探不读缓存**（设置页要真值）、
 * 结果写穿缓存（授权完刷新设置页、下次起 agent 立刻拿到新状态）。
 */
export const probeMcpHealthAll = async (
  servers: Record<string, McpServerConfig>,
): Promise<Record<string, McpHealth>> => {
  const entries = await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const health = await probeMcpHealth(name, cfg);
      writeProbeCache(probeCacheKey(name, cfg), health);
      return [name, health] as const;
    }),
  );
  return Object.fromEntries(entries);
};

export interface FilteredMcp {
  // 健康（ok、含本地 stdio）可注入给 agent 的 server
  servers: Record<string, McpServerConfig>;
  // 被剔除的（探测失败：连不上 / 未授权 / 非 2xx）、调用方据此写一条 info event 提示用户
  dropped: McpHealth[];
}

/**
 * 起 agent 前过滤：剔除探测失败（连不上 / 未授权 / 非 2xx）的远程 MCP。
 * 本地 stdio 探测时已乐观标 ok、随 ok 一起保留——交给 SDK 起进程自己处理。
 *
 * 入参应是 enrich（注入 OAuth token）之后的 servers。
 * 走 TTL 缓存（见文件头）：热路径不再每次真探 6s、命中直接秒过。
 */
export const filterHealthyMcp = async (
  servers: Record<string, McpServerConfig>,
): Promise<FilteredMcp> => {
  const entries = await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const key = probeCacheKey(name, cfg);
      const cached = readProbeCache(key);
      if (cached) return [name, cfg, cached, true] as const;
      const health = await probeMcpHealth(name, cfg);
      writeProbeCache(key, health);
      return [name, cfg, health, false] as const;
    }),
  );
  const total = entries.length;
  const cacheHits = entries.filter((e) => e[3]).length;
  // 热路径可观测：全命中时 chat 启动链 mcp≈0（TTL ok/fail 各 5min，远大于 60s 复用要求）
  if (total > 0) {
    console.log(
      `[mcp-probe] filterHealthyMcp cacheHits=${cacheHits}/${total} probed=${total - cacheHits}`,
    );
  }
  const kept: Record<string, McpServerConfig> = {};
  const dropped: McpHealth[] = [];
  for (const [name, cfg, h] of entries) {
    if (h.status === "ok") {
      kept[name] = withInferredTransport(cfg);
    } else {
      dropped.push(h);
    }
  }
  return { servers: kept, dropped };
};
