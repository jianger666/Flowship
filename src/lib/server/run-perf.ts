/**
 * SDK agent.send 性能埋点（P0 可观测性）
 *
 * 背景：Windows 用户反馈「执行慢」，但现有日志分不清卡在 thinking / 工具 / step 哪一段。
 * SDK 1.0.23 的 SendOptions 已暴露 onDelta / onStep，本模块消费细粒度 InteractionUpdate，
 * 只打元数据日志（绝不记录命令内容 / 工具参数 / 输出 / prompt 正文）。
 *
 * 用法：send 前 createRunPerfTracker → 把 onDelta/onStep 塞进 SendOptions → send 返回后 attachRun。
 *
 * 除日志外唯一的副作用：`turn-ended` 的 token 用量会落进 meta.json（见 persistTurnUsage）。
 * 落在这里而不是各调用点，是因为 9 个 agent.send 全都已经接了本 tracker——
 * chat / task / 交卷追问 / ask 回复 / 问一问 / 重连各链路零改动自动覆盖。
 */

import type { ConversationStep, InteractionUpdate, Run } from "@cursor/sdk";

import { normalizeToolName } from "./normalize-tool-name";
import { recordTurnUsage } from "./task-fs";
import { publish } from "./task-stream";
import { normalizeTurnUsage } from "@/lib/token-usage";

export type RunPerfCtx = {
  taskId: string;
  agentId: string;
  /** 调用点语义：task-first / task-followup / question / chat-first 等 */
  runKind: string;
  promptBytes?: number;
  /** B2：预算裁掉的段名（可回放：段名+省字节见 warn/单测，日志只记名） */
  promptBudgetDropped?: string[];
  /** B2：用了压缩版的段名 */
  promptBudgetCompressed?: string[];
};

export type RunPerfTracker = {
  onDelta: (args: { update: InteractionUpdate }) => void;
  onStep: (args: { step: ConversationStep }) => void;
  /** send 返回后补记 run id / requestId，打 [perf-run] 行 */
  attachRun: (run: Pick<Run, "id" | "requestId">) => void;
};

/** 高频流式 delta——只占带宽、对「卡在哪」无信息量，一律忽略 */
const IGNORED_DELTA_TYPES = new Set([
  "text-delta",
  "thinking-delta",
  "shell-output-delta",
  "token-delta",
  "partial-tool-call",
]);

type ToolCallLike = {
  type: string;
  args?: {
    providerIdentifier?: string;
    toolName?: string;
  };
  result?: {
    status?: string;
    value?: {
      executionTime?: number;
      isError?: boolean;
    };
  };
};

const toolStatus = (toolCall: ToolCallLike): "success" | "error" | "unknown" => {
  const status = toolCall.result?.status;
  if (status === "error") return "error";
  if (status === "success") {
    // MCP 协议层 success 但业务 isError=true，按 error 记（仍不碰 content）
    if (toolCall.type === "mcp" && toolCall.result?.value?.isError === true) {
      return "error";
    }
    return "success";
  }
  return "unknown";
};

const shellSdkExecMs = (toolCall: ToolCallLike): number | undefined => {
  if (toolCall.type !== "shell") return undefined;
  const t = toolCall.result?.value?.executionTime;
  return typeof t === "number" && Number.isFinite(t) ? t : undefined;
};

/**
 * turn 用量落盘 + 推一帧 task 给前端（火忘：onDelta 是同步签名、绝不能 await）。
 *
 * 频次：实测一次 agent.send 只发一条 turn-ended（哪怕中间跑了 40 多步、几十个工具），
 * 所以「一轮写一次 meta」的量级跟现有 patchAction 比可以忽略——绝不按 delta 写盘。
 */
const persistTurnUsage = (taskId: string, rawUsage: unknown): void => {
  const usage = normalizeTurnUsage(rawUsage);
  if (!usage) return;
  void (async () => {
    try {
      const task = await recordTurnUsage(taskId, usage);
      if (task) publish(taskId, { kind: "task", task });
    } catch (err) {
      console.warn(`[perf] turn 用量落盘失败 task=${taskId}`, err);
    }
  })();
};

export const createRunPerfTracker = (ctx: RunPerfCtx): RunPerfTracker => {
  // 上一被记录事件的时间——算 gap（事件间隔），定位「空窗」卡顿
  let lastEventAt = Date.now();
  const toolStartedAt = new Map<string, { name: string; at: number }>();
  const base = `task=${ctx.taskId} kind=${ctx.runKind}`;

  const markEvent = (): { now: number; gap: number } => {
    const now = Date.now();
    const gap = now - lastEventAt;
    lastEventAt = now;
    return { now, gap };
  };

  const onDelta = (args: { update: InteractionUpdate }): void => {
    try {
      const update = args.update;
      if (IGNORED_DELTA_TYPES.has(update.type)) return;

      if (update.type === "tool-call-started") {
        const { gap } = markEvent();
        const name = normalizeToolName(update.toolCall as ToolCallLike);
        toolStartedAt.set(update.callId, { name, at: Date.now() });
        console.log(
          `[perf-tool] ${base} call=${update.callId} tool=${name} phase=start gap=${gap}`,
        );
        return;
      }

      if (update.type === "tool-call-completed") {
        const { now, gap } = markEvent();
        const toolCall = update.toolCall as ToolCallLike;
        const started = toolStartedAt.get(update.callId);
        toolStartedAt.delete(update.callId);
        const name = started?.name ?? normalizeToolName(toolCall);
        const wall = started ? now - started.at : gap;
        const status = toolStatus(toolCall);
        const sdkExec = shellSdkExecMs(toolCall);
        const sdkExecPart =
          sdkExec !== undefined ? ` sdkExec=${sdkExec}` : "";
        console.log(
          `[perf-tool] ${base} call=${update.callId} tool=${name} phase=done wall=${wall} status=${status}${sdkExecPart}`,
        );
        return;
      }

      if (update.type === "thinking-completed") {
        const { gap } = markEvent();
        const duration =
          typeof update.thinkingDurationMs === "number"
            ? ` duration=${update.thinkingDurationMs}`
            : "";
        console.log(`[perf-step] ${base} type=thinking gap=${gap}${duration}`);
        return;
      }

      if (update.type === "step-completed") {
        markEvent();
        console.log(
          `[perf-step] ${base} type=step duration=${update.stepDurationMs} stepId=${update.stepId}`,
        );
        return;
      }

      if (update.type === "turn-ended") {
        markEvent();
        const u = update.usage;
        if (!u) {
          console.log(`[perf-turn] ${base} usage=none`);
          return;
        }
        const reasoning =
          typeof u.reasoningTokens === "number"
            ? ` reasoningTokens=${u.reasoningTokens}`
            : "";
        console.log(
          `[perf-turn] ${base} inputTokens=${u.inputTokens} outputTokens=${u.outputTokens}` +
            ` cacheReadTokens=${u.cacheReadTokens} cacheWriteTokens=${u.cacheWriteTokens}${reasoning}`,
        );
        // 日志之外唯一副作用：落进 meta.json 供 UI 展示（内部已 try/catch + 火忘）
        persistTurnUsage(ctx.taskId, u);
      }
    } catch (err) {
      // 埋点绝不能拖垮主流程
      console.warn(`[perf] onDelta 埋点失败 task=${ctx.taskId}`, err);
    }
  };

  // onStep 目前无额外可观测字段需求；占位接 SendOptions，防未来扩展时调用点再改一遍
  const onStep = (args: { step: ConversationStep }): void => {
    try {
      // ConversationStep 不含 wall-clock；细粒度耗时走 onDelta 的 step-completed
      void args.step;
    } catch (err) {
      console.warn(`[perf] onStep 埋点失败 task=${ctx.taskId}`, err);
    }
  };

  const attachRun = (run: Pick<Run, "id" | "requestId">): void => {
    try {
      const req =
        typeof run.requestId === "string" && run.requestId.length > 0
          ? ` requestId=${run.requestId}`
          : "";
      const bytes =
        typeof ctx.promptBytes === "number"
          ? ` promptBytes=${ctx.promptBytes}`
          : "";
      const dropped =
        ctx.promptBudgetDropped && ctx.promptBudgetDropped.length > 0
          ? ` promptBudgetDropped=${ctx.promptBudgetDropped.join(",")}`
          : "";
      const compressed =
        ctx.promptBudgetCompressed && ctx.promptBudgetCompressed.length > 0
          ? ` promptBudgetCompressed=${ctx.promptBudgetCompressed.join(",")}`
          : "";
      console.log(
        `[perf-run] ${base} agent=${ctx.agentId} run=${run.id}${req}${bytes}${dropped}${compressed}`,
      );
    } catch (err) {
      console.warn(`[perf] attachRun 埋点失败 task=${ctx.taskId}`, err);
    }
  };

  return { onDelta, onStep, attachRun };
};
