/**
 * 任务预热（v1.9.28）：用户回到窗口 / 聚焦输入框时，趁他还在敲字，
 * 把「发送时必付的冷启动代价」提前付掉。
 *
 * 为什么有用（main.log 实测）：1543 次 MCP 探活里约 70% 整表 miss，其中距上次 >30min 的占 252 次
 * （stale-while-revalidate 管不到、必须同步探，用户首条消息要多等一轮探活）；
 * 会话落盘后 resume 要读 checkpoint 尾部 blob，空闲久了页缓存是冷的。
 *
 * 只做「幂等、只读、可丢弃」的两件事：刷新 MCP 探活缓存、预读 store 尾部 blob。
 * 绝不：建会话 / resume / 发消息 / 改任何 task 状态 / 碰 prompt——
 * 预热失败或被丢弃，用户发送时只是回到原来的路径，不会更差。
 *
 * 保护：同一 task 服务端 20s 节流（前端另有 30s 去抖）、全局并发 ≤2（用户飞快切任务不堆积）、
 * 有 run 在跑 / 正在停止或删除的任务不预热。MCP 的 OAuth 续期走 mcp-oauth 的 single-flight，
 * 预热与正式发送并发不会重复打 refresh 请求。
 *
 * 观测：每次预热（含出错、除高频的节流 / 忙碌跳过）写一行 warmup.jsonl；
 * 成功后 noteWarmed——之后该 task 的 run 汇总记录带 warmedAgoMs，可对比「预热过 vs 没预热」。
 */
import { getChatLifecycle } from "./chat-gate";
import { hasChatSession, isChatRunActive } from "./chat-runner";
import { resolveTaskMcpServers } from "./cursor-config";
import { enrichMcpServersWithOAuth } from "./mcp-oauth";
import { warmMcpProbe, type McpWarmStats } from "./mcp-probe";
import { appendPerfRecord } from "./perf-journal";
import { noteWarmed } from "./run-prep-notes";
import { getTask } from "./task-fs";
import { hasTaskAgentSession, isTaskRunning } from "./task-op";

/** 预热只需要 task 的这几个字段（结构类型：测试里不必造完整 Task） */
export interface WarmTask {
  id: string;
  mode?: string;
  sessionAgentId?: string;
  disabledMcpServers?: string[];
}

export type WarmupSkipReason =
  | "not_found"
  | "throttled"
  | "busy"
  | "run_active"
  | "lifecycle";

export interface WarmupOutcome {
  taskId: string;
  status: "warmed" | "skipped" | "error";
  reason?: WarmupSkipReason;
  mcp?: McpWarmStats;
  store?: { blobs: number; bytes: number };
  /** 内存里已有会话 = 恢复路径是热的，不预读 store */
  sessionHot?: boolean;
  totalMs: number;
  error?: string;
}

export interface WarmupDeps {
  now: () => number;
  getTask: (id: string) => Promise<WarmTask | null>;
  lifecycle: (id: string) => string | null;
  hasLiveSession: (task: WarmTask) => boolean;
  isRunActive: (task: WarmTask) => boolean;
  /** 刷新该 task 会用到的 MCP 的探活缓存；没有可探的 server 返回 null */
  warmMcp: (task: WarmTask) => Promise<McpWarmStats | null>;
  /** 预读会话存储尾部；store 没开 / 非 fast 实现返回 null */
  prefetchStore: (
    agentId: string,
  ) => Promise<{ blobs: number; bytes: number } | null>;
  record: (file: string, rec: Record<string, unknown>) => void;
  noteWarmed: (taskId: string, at: number) => void;
}

/** 同一 task 两次预热的最小间隔（前端另有去抖，这里是兜底） */
const THROTTLE_MS = 20_000;
const MAX_CONCURRENT = 2;
const MAX_TRACKED_TASKS = 200;

const G = globalThis as unknown as {
  __feWarmupLast?: Map<string, number>;
  __feWarmupInflight?: number;
};
const lastMap = (): Map<string, number> => (G.__feWarmupLast ??= new Map());

const rememberWarmed = (taskId: string, at: number): void => {
  const m = lastMap();
  m.delete(taskId);
  m.set(taskId, at);
  while (m.size > MAX_TRACKED_TASKS) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
};

/** 仅测试：清空节流 / 并发状态 */
export const __resetWarmupStateForTests = (): void => {
  lastMap().clear();
  G.__feWarmupInflight = 0;
};

const defaultDeps: WarmupDeps = {
  now: () => Date.now(),
  getTask: async (id) => (await getTask(id)) as WarmTask | null,
  lifecycle: (id) => getChatLifecycle(id),
  hasLiveSession: (t) =>
    t.mode === "chat" ? hasChatSession(t.id) : hasTaskAgentSession(t.id),
  isRunActive: (t) =>
    t.mode === "chat" ? isChatRunActive(t.id) : isTaskRunning(t.id),
  warmMcp: async (t) => {
    // 必须走和正式发送完全相同的「解析 + OAuth 注入」：探活缓存 key 含 headers（含 token），
    // 不注入 token 预热出来的缓存条目，正式发送时根本命中不了
    const servers = await enrichMcpServersWithOAuth(
      await resolveTaskMcpServers(t.disabledMcpServers),
    );
    return Object.keys(servers).length > 0 ? warmMcpProbe(servers) : null;
  },
  prefetchStore: async (agentId) => {
    // 只看不开：store 还没打开（App 刚启动、尚无任何发送）就不预读，预热不负责打开 store
    const { peekSdkStoreHandle } = await import("./sdk-agent-store");
    const handle = await peekSdkStoreHandle();
    return handle?.fast ? handle.fast.prefetchAgent(agentId) : null;
  },
  record: (file, rec) => appendPerfRecord(file, rec),
  noteWarmed: (taskId, at) => noteWarmed(taskId, at),
};

const errText = (err: unknown): string =>
  (err instanceof Error ? `${err.name}: ${err.message}` : "unknown").slice(0, 160);

/**
 * 预热一个 task。永不 reject：任何故障都折成 status=error 的结果并记一行日志。
 * 路由层火忘调用——前端不等它。
 */
export const warmupTask = async (
  taskId: string,
  deps: WarmupDeps = defaultDeps,
): Promise<WarmupOutcome> => {
  const t0 = deps.now();
  /** 收口 + 记日志；silent = 高频的无信息量跳过（节流 / 忙碌）不落盘，免得刷屏 */
  const finish = (
    o: Omit<WarmupOutcome, "taskId" | "totalMs">,
    silent = false,
  ): WarmupOutcome => {
    const out: WarmupOutcome = { taskId, ...o, totalMs: deps.now() - t0 };
    if (!silent) deps.record("warmup.jsonl", { ...out });
    return out;
  };

  let occupied = false;
  try {
    const last = lastMap().get(taskId);
    if (last !== undefined && t0 - last < THROTTLE_MS) {
      return finish({ status: "skipped", reason: "throttled" }, true);
    }
    if ((G.__feWarmupInflight ?? 0) >= MAX_CONCURRENT) {
      return finish({ status: "skipped", reason: "busy" }, true);
    }

    const task = await deps.getTask(taskId);
    if (!task) return finish({ status: "skipped", reason: "not_found" });
    if (deps.lifecycle(taskId) !== null) {
      return finish({ status: "skipped", reason: "lifecycle" });
    }
    if (deps.isRunActive(task)) {
      return finish({ status: "skipped", reason: "run_active" });
    }

    // 通过全部前置检查后才占并发名额 + 记「刚预热过」（不存在 / 被挡的不占节流窗口）
    // —— getTask 的 await 期间别的预热可能已占满名额，这里再核一次
    if ((G.__feWarmupInflight ?? 0) >= MAX_CONCURRENT) {
      return finish({ status: "skipped", reason: "busy" }, true);
    }
    G.__feWarmupInflight = (G.__feWarmupInflight ?? 0) + 1;
    occupied = true;
    rememberWarmed(taskId, t0);

    const sessionHot = deps.hasLiveSession(task);
    const [mcp, store] = await Promise.all([
      deps.warmMcp(task).catch(() => null),
      !sessionHot && task.sessionAgentId
        ? deps.prefetchStore(task.sessionAgentId).catch(() => null)
        : Promise.resolve(null),
    ]);
    deps.noteWarmed(taskId, deps.now());
    return finish({
      status: "warmed",
      sessionHot,
      ...(mcp ? { mcp } : {}),
      ...(store ? { store } : {}),
    });
  } catch (err) {
    return finish({ status: "error", error: errText(err) });
  } finally {
    if (occupied) {
      G.__feWarmupInflight = Math.max(0, (G.__feWarmupInflight ?? 1) - 1);
    }
  }
};
