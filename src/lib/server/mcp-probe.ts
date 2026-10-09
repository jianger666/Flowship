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
 *
 * v1.9.28 stale-while-revalidate：实测 main.log 1543 次 filterHealthyMcp，约 70% 全 miss，
 * 其中「同进程内、距上次 5~30min」占热 miss 的一半（用户回复的间隔天然比 5min 长）、
 * 进程冷启动首次仅占 9%。故 ok 过了 TTL 后、在 30min 窗口内仍「先用旧结果」并后台重探；
 * 同步等后台最多 300ms——连接被拒 / DNS 失败这类硬失败几乎秒回、当场采用并剔除，
 * 不把已挂的 server 注入给 SDK（SDK 遇到连不上的 MCP 会让整个 run 报错）；
 * 慢响应的不阻塞发送、结果落缓存下次生效。fail 过期必须同步重探（用户多半刚授权 / 修好）。
 * run 失败收口仍调 invalidateMcpProbeCache（整表清 + 在飞探测的结果不再回写）。
 * 回到窗口 / 聚焦输入框时再用 warmMcpProbe 预热（见 task-warmup.ts），覆盖 >30min 的闲置。
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
/**
 * stale-while-revalidate 窗口（v1.9.28）：ok 过了 TTL 后、距写入不到这么久仍可「先用旧结果」。
 * 只对 ok 生效——fail 过期必须同步重探（用户多半刚授权 / 刚修好，沿用旧 fail 会把好服务继续剔掉）。
 * 取 30min 而不是更长：窗口内 server 挂了的代价是「这一轮 run 因连不上 MCP 失败一次」
 * （失败收口会 invalidate、重试必真探），窗口越长撞上的概率越高。
 */
const PROBE_STALE_OK_MS = 30 * 60_000;
/**
 * stale 命中时同步等后台重探的上限：连接被拒 / DNS 失败这类「死透了」的硬失败几乎秒回，
 * 在窗口内拿到就当场采用并剔除（不把已挂的 server 注入给 SDK）；
 * 慢响应的（真要等 6s 超时的）不阻塞发送——用旧 ok、结果落缓存下次生效。
 */
const PROBE_STALE_GRACE_MS = 300;
/** 缓存条目上限：超出删最旧（Map 插入序） */
const PROBE_CACHE_MAX_ENTRIES = 200;

// 挂 globalThis：各 route 是不同 chunk、module-level Map 会各持一份（同 runningTasks 老坑）
const G = globalThis as unknown as {
  __feMcpProbeCache?: Map<string, { health: McpHealth; at: number }>;
  /** 在飞的探测（single-flight）：同一 server 的并发 filter / warm 共用一次探测 */
  __feMcpProbeInflight?: Map<string, Promise<McpHealth>>;
  /** invalidate 的代数：在它之前发出的探测，结果不得回写缓存 */
  __feMcpProbeGen?: number;
};
const probeCache = (G.__feMcpProbeCache ??= new Map());
const probeInflight = (G.__feMcpProbeInflight ??= new Map());
const currentGen = (): number => (G.__feMcpProbeGen ??= 0);

// 缓存 key：sha256(name|url|type|headers)——避免明文 Bearer 进 Map key；token / transport 换了摘要自然变
const probeCacheKey = (name: string, cfg: McpServerConfig): string | null => {
  if (!("url" in cfg)) return null;
  const payload = `${name}|${cfg.url}|${cfg.type ?? ""}|${JSON.stringify(cfg.headers ?? {})}`;
  return createHash("sha256").update(payload).digest("hex");
};

type CacheState = "fresh" | "stale";

/**
 * 看缓存：fresh = TTL 内直接用；stale = ok 已过 TTL 但还在 stale 窗口内（可先用、需后台重探）；
 * null = 无缓存 / fail 过期 / ok 超出窗口，必须同步探。
 */
const peekProbeCache = (
  key: string | null,
): { health: McpHealth; state: CacheState } | null => {
  if (!key) return null;
  const hit = probeCache.get(key);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  const ok = hit.health.status === "ok";
  if (age < (ok ? PROBE_CACHE_OK_MS : PROBE_CACHE_FAIL_MS)) {
    return { health: hit.health, state: "fresh" };
  }
  if (ok && age < PROBE_STALE_OK_MS) {
    return { health: hit.health, state: "stale" };
  }
  return null;
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
 *
 * v1.9.28：同时换代并丢弃在飞登记——失败之前发出的探测结果已过时，
 * 回来时不得回写缓存（否则会把刚清掉的 ok 又塞回去），后续 filter 也不会去等它们、必真探。
 */
export const invalidateMcpProbeCache = (): void => {
  probeCache.clear();
  G.__feMcpProbeGen = currentGen() + 1;
  probeInflight.clear();
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
 * 探一个 server 并写缓存；同一 key 的并发调用共用同一次探测（single-flight）。
 * stdio（key=null）本来就秒回、不缓存不合并。
 *
 * probeMcpHealth 内部把所有失败都翻成 fail 结果、不会 reject——
 * 后台刷新（没人 await）因此不会产生 unhandledRejection。
 */
const probeWithCache = (
  name: string,
  cfg: McpServerConfig,
  key: string | null,
): Promise<McpHealth> => {
  if (!key) return probeMcpHealth(name, cfg);
  const running = probeInflight.get(key);
  if (running) return running;
  const gen = currentGen();
  const p: Promise<McpHealth> = probeMcpHealth(name, cfg)
    .then((health) => {
      // invalidate 之后才回来的旧探测：结果只给等它的人、不进缓存
      if (gen === currentGen()) writeProbeCache(key, health);
      return health;
    })
    .finally(() => {
      if (probeInflight.get(key) === p) probeInflight.delete(key);
    });
  probeInflight.set(key, p);
  return p;
};

/** p 在 ms 内完成就给结果、否则给 null（不取消 p；定时器必清，别拖住事件循环） */
const settleWithin = async <T>(p: Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

/** 一次 filterHealthyMcp 的缓存命中 / 等待统计（进每个 run 的汇总记录，用来量化探活的真实代价） */
export interface McpProbeStats {
  total: number;
  /** 没有同步等待探测就拿到结果的个数（= fresh + stale；与历史日志里的 cacheHits 同口径） */
  cacheHits: number;
  fresh: number;
  /** 用了「过期但仍在 stale 窗口内」的 ok 结果（同时后台重探） */
  stale: number;
  /** 同步探测的个数（无缓存 / fail 过期 / ok 超出 stale 窗口 / stdio） */
  probedSync: number;
  /** stale 里在 grace 窗口内拿到新结果并当场采用的个数（含当场判 fail 剔除） */
  staleRefreshedInGrace: number;
  /** 整个 filter 的耗时 ms：热路径≈0、stale 命中≤grace、miss = 最慢那个 server 的探测耗时 */
  waitMs: number;
}

export interface FilteredMcp {
  // 健康（ok、含本地 stdio）可注入给 agent 的 server
  servers: Record<string, McpServerConfig>;
  // 被剔除的（探测失败：连不上 / 未授权 / 非 2xx）、调用方据此写一条 info event 提示用户
  dropped: McpHealth[];
  /** 可选：大量测试 mock 只返回 servers / dropped，调用方必须用 ?. 读取 */
  stats?: McpProbeStats;
}

/** 预热结果（task-warmup 进日志用） */
export interface McpWarmStats {
  total: number;
  /** 实际发起后台探测的 http server 数 */
  refreshed: number;
  skippedFresh: number;
  waitMs: number;
}

/**
 * 预热：把缓存里「不是 fresh」的 http server 重探一遍（fresh 的跳过、stdio 不探）。
 * 用户回到窗口 / 聚焦输入框时调——等他敲完字发送，filterHealthyMcp 基本全是 fresh。
 * 共用 single-flight；绝不 reject。
 */
export const warmMcpProbe = async (
  servers: Record<string, McpServerConfig>,
): Promise<McpWarmStats> => {
  const t0 = Date.now();
  let refreshed = 0;
  let skippedFresh = 0;
  await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const key = probeCacheKey(name, cfg);
      if (!key) return; // stdio：本来就秒回、不缓存，预热没意义
      if (peekProbeCache(key)?.state === "fresh") {
        skippedFresh++;
        return;
      }
      refreshed++;
      await probeWithCache(name, cfg, key).catch(() => undefined);
    }),
  );
  return {
    total: Object.keys(servers).length,
    refreshed,
    skippedFresh,
    waitMs: Date.now() - t0,
  };
};

/**
 * 起 agent 前过滤：剔除探测失败（连不上 / 未授权 / 非 2xx）的远程 MCP。
 * 本地 stdio 探测时已乐观标 ok、随 ok 一起保留——交给 SDK 起进程自己处理。
 *
 * 入参应是 enrich（注入 OAuth token）之后的 servers。
 * 走 TTL 缓存 + stale-while-revalidate（见文件头）：fresh 直接秒过；
 * stale 先用旧 ok、后台重探并最多等 300ms；其余情形同步探。
 */
export const filterHealthyMcp = async (
  servers: Record<string, McpServerConfig>,
): Promise<FilteredMcp> => {
  const t0 = Date.now();
  let fresh = 0;
  let stale = 0;
  let probedSync = 0;
  let staleRefreshedInGrace = 0;
  const entries = await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const key = probeCacheKey(name, cfg);
      const hit = peekProbeCache(key);
      if (hit?.state === "fresh") {
        fresh++;
        return [name, cfg, hit.health] as const;
      }
      if (hit?.state === "stale") {
        stale++;
        // 后台重探（single-flight）；没人等的那一支不能产生 unhandledRejection
        const refresh = probeWithCache(name, cfg, key);
        void refresh.catch(() => undefined);
        const fast = await settleWithin(refresh, PROBE_STALE_GRACE_MS);
        if (fast) {
          staleRefreshedInGrace++;
          return [name, cfg, fast] as const;
        }
        return [name, cfg, hit.health] as const;
      }
      probedSync++;
      return [name, cfg, await probeWithCache(name, cfg, key)] as const;
    }),
  );
  const total = entries.length;
  const stats: McpProbeStats = {
    total,
    cacheHits: fresh + stale,
    fresh,
    stale,
    probedSync,
    staleRefreshedInGrace,
    waitMs: Date.now() - t0,
  };
  // 热路径可观测：分析脚本（mcp-miss-breakdown 等）按「前缀 + cacheHits=a/b probed=c」解析，
  // 新字段只能往后追加。cacheHits 含 stale（都没同步等待）、probed 只含同步探测。
  if (total > 0) {
    console.log(
      `[mcp-probe] filterHealthyMcp cacheHits=${stats.cacheHits}/${total} probed=${probedSync}` +
        ` stale=${stale} graceHit=${staleRefreshedInGrace} waitMs=${stats.waitMs}`,
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
  return { servers: kept, dropped, stats };
};
