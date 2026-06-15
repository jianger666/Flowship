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
 * V0.6.13：状态从 4 态（ok/unauthorized/unreachable/local）收敛为 2 态（ok/fail）、
 * 降低噪音（用户拍板）。失败原因不再靠 status 区分、改全部塞进 detail 给日志弹窗看。
 *
 * 注意：探测应在 enrichMcpServersWithOAuth 之后做、这样带上 OAuth token 的 server
 * 才能正确探出 ok / unauthorized（否则飞书项目永远 401）。
 */

import type { McpServerConfig } from "@cursor/sdk";

import type { McpHealth } from "@/lib/types";

// 探测超时（比 oauth probe 的 5s 略宽、避免慢服务误判连不上）
const PROBE_TIMEOUT_MS = 6000;

// 发 initialize 拿 HTTP 状态码（连不上则返 error）
const sendInitialize = async (
  url: string,
  headers?: Record<string, string>,
): Promise<{ httpCode: number } | { error: string }> => {
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
          clientInfo: { name: "ai-flow", version: "0" },
        },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { httpCode: res.status };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
};

/** 探测单个 MCP server 的连通性 */
export const probeMcpHealth = async (
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
  const r = await sendInitialize(cfg.url, headers);
  // 连不上（超时 / DNS / 连接拒绝）：detail 带 url + 错误原文、点开看日志能直接排查
  if ("error" in r) {
    return {
      name,
      status: "fail",
      detail: `连接失败：${r.error}\nURL：${cfg.url}`,
    };
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
      detail: `需要授权（HTTP ${r.httpCode}）——去设置页给「${name}」授权\nURL：${cfg.url}`,
    };
  }
  // 其它非 2xx 异常状态码（404 / 405 / 5xx 等）
  return {
    name,
    status: "fail",
    httpCode: r.httpCode,
    detail: `服务异常 HTTP ${r.httpCode}\nURL：${cfg.url}`,
  };
};

/** 并发探测所有 MCP server（key=server 名） */
export const probeMcpHealthAll = async (
  servers: Record<string, McpServerConfig>,
): Promise<Record<string, McpHealth>> => {
  const entries = await Promise.all(
    Object.entries(servers).map(
      async ([name, cfg]) => [name, await probeMcpHealth(name, cfg)] as const,
    ),
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
 */
export const filterHealthyMcp = async (
  servers: Record<string, McpServerConfig>,
): Promise<FilteredMcp> => {
  const health = await probeMcpHealthAll(servers);
  const kept: Record<string, McpServerConfig> = {};
  const dropped: McpHealth[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const h = health[name];
    if (h.status === "ok") {
      kept[name] = cfg;
    } else {
      dropped.push(h);
    }
  }
  return { servers: kept, dropped };
};
