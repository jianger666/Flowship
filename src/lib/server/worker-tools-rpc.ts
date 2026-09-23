/**
 * Worker tool-call RPC 主进程派发器（选项 A compute-plane 翻转的核心 choke 点）。
 *
 * - worker 侧 customTools.execute 一律 RPC 回主进程；这里是**唯一执行点**：
 *   收 args → 查 kind 映射 → 外部 kind 先记参数 + 落 intent → 调真实 record 执行 →
 *   成功落 done / 查无落 abandoned；
 * - submit_mr 不在此落 intent（createMRWithIntent 自带，避免双记；恢复走它的键）；
 * - 本地/可逆工具（ask_user、submit_work 等）直接执行不落 WAL；
 * - actionId 取 task 当前 action（读 meta，失败回落 "unknown"——键仍稳定）；
 * - at-most-once（feishu/notify）崩溃窗口按 abandoned 处理，永不自动重发。
 */

import { buildSdkCustomTools } from "./flowship-tools";
import {
  appendIntent,
  markIntentAbandoned,
  markIntentDone,
} from "./intent-log";
import { buildSideEffectIdempotencyKey } from "./mem-governance";
import { getTaskMeta } from "./task-fs";
import { recordToolCallArgs } from "./tool-call-args";

/** custom tool 名 → 意图 kind（未列出 = 本地/可逆，不进 WAL）。 */
export const WORKER_TOOL_KIND_MAP: Record<string, "merge-request" | "feishu-message" | "notify"> = {
  share_to_group: "feishu-message",
  notify_group_testers: "notify",
};

export interface WorkerToolDispatchInput {
  callerToken?: string;
  taskId?: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface WorkerToolDispatchResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  intentKey?: string;
}

export const contentReportsFailure = (out: unknown): boolean => {
  try {
    const content = (out as { content?: unknown })?.content;
    const parts = Array.isArray(content) ? content : [content];
    for (const p of parts) {
      const t = (p as { text?: unknown })?.text;
      if (typeof t !== "string") continue;
      try {
        const o = JSON.parse(t) as { ok?: unknown };
        if (o && typeof o === "object" && o.ok === false) return true;
      } catch {
        /* 非 JSON 文本不管 */
      }
    }
    return false;
  } catch {
    return false;
  }
};

const payloadHashOf = (args: Record<string, unknown>): string => {
  const s = JSON.stringify(args);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
};

const currentActionOf = async (taskId: string): Promise<string> => {
  try {
    const meta = await getTaskMeta(taskId);
    return meta?.currentActionId ?? "unknown";
  } catch {
    return "unknown";
  }
};

export const dispatchWorkerToolCall = async (
  input: WorkerToolDispatchInput,
): Promise<WorkerToolDispatchResult> => {
  const { callerToken, taskId, toolCallId, toolName, args } = input;
  if (!callerToken) {
    return { ok: false, error: "缺 callerToken（身份不明，fail-closed）" };
  }
  const record = buildSdkCustomTools(callerToken);
  const tool = record[toolName];
  if (!tool) {
    return { ok: false, error: `未知工具 ${toolName}` };
  }
  const kind = WORKER_TOOL_KIND_MAP[toolName];
  // submit_mr 自带 intent（createMRWithIntent），此处不双记；其余外部 kind 先记后做。
  const actionId = taskId ? await currentActionOf(taskId) : "unknown";
  let intentKey: string | undefined;
  if (kind && taskId) {
    intentKey = buildSideEffectIdempotencyKey({ taskId, actionId, toolCallId });
    try {
      recordToolCallArgs({ taskId, actionId, toolCallId, toolName, args });
      await appendIntent({ taskId, actionId, toolCallId, kind, payloadHash: payloadHashOf(args) });
    } catch {
      /* 埋点失败不挡执行 */
    }
  }
  let out: { content?: unknown; ok?: unknown };
  try {
    out = (await tool.execute(args as Record<string, never>, { callerToken } as never)) as {
      content?: unknown;
      ok?: unknown;
    };
  } catch (err) {
    // 执行抛错：意图留 pending（恢复走反查；at-most-once 的永 abandoned）。
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      intentKey,
    };
  }
  // 业务失败（没抛，但 content 文本里报 ok:false）：Transport 通了但事没办成 →
  // abandoned，不记 done。content 形如 [{type:"text",text:"{\"ok\":false,...}"}]。
  if (contentReportsFailure(out)) {
    if (intentKey && taskId) {
      try {
        await markIntentAbandoned(taskId, intentKey);
      } catch {
        /* 收尾失败不翻转结论 */
      }
    }
    return { ok: false, error: "工具返回失败（ok:false），已标 abandoned", intentKey, result: out };
  }
  if (intentKey && taskId) {
    try {
      await markIntentDone(taskId, intentKey);
    } catch {
      /* 收尾失败不翻转成功结论 */
    }
  }
  return { ok: true, result: out, intentKey };
};
