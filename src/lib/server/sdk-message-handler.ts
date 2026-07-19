/**
 * SDKMessage → task 事件流翻译器（V0.9.x 从 task-runner.ts 拆出；
 * Phase 1 起 chat-runner 也复用本模块，消灭私有 handleSdkMessage 重复债）
 *
 * 职责：把 SDK run.stream() 吐的每条消息翻译成 events.jsonl 事件 + SSE publish：
 *   - thinking / tool_call / tool_result / assistant（流式缓冲）/ status
 *   - artifact 写入检测（write/edit 命中 actions/ 路径 → 「在写 artifact」+ 落盘后刷 artifactUpdatedAt）
 *   - submit_work 特判（状态由 awaitingNotifier 管、这里只记 error）
 *
 * 依赖方向（保证无环）：只依赖 task-stream + task-fs + tool-result-persist、不 import task-runner / chat-runner。
 */

import type { SDKMessage } from "@cursor/sdk";

import { getTask, patchActionIfOwner } from "./task-fs";
import { failpoint } from "./failpoints";
import {
  publish,
  publishIfCurrent,
  stringifyMeta,
  truncate,
  writeOwnedEventAndPublish,
} from "./task-stream";
import { buildToolResultMeta } from "./tool-result-persist";

// assistant 文本的流式缓冲：delta 先 publish 给 UI 打字机、攒到下个非 assistant 消息时 flush 落盘
export interface AssistantBufferCtx {
  buffer: string;
  flush: () => Promise<void>;
  sdkErrorMessage?: string;
}

// 「写文件」类工具名白名单——只有这些工具命中 actions/ 路径才算「在写 artifact」。
// SDK 的 read（读）和 edit（写）都用 path 参数、无法靠 args 区分读写、只能靠工具名。
// 宁可漏标（某写工具不在表里 → 降级成「调用 X」、无害）、不可错标（read 标成「在写」= 误导）。
const WRITE_TOOL_NAMES = new Set([
  "write",
  "edit",
  "create",
  "create_file",
  "search_replace",
  "str_replace",
  "multi_edit",
  "MultiEdit",
  "apply_patch",
]);

// 交卷工具：V0.11.9 改名 submit_work、旧名 wait_for_user 仍以 alias 存在
const SUBMIT_TOOL_NAMES = new Set([
  "submit_work",
  "Submit Work",
  "wait_for_user",
  "Wait For User",
]);

/** 落一条 tool_result（completed / error 共用）；失败只打日志、不挡主流程 */
const emitToolResult = async (
  taskId: string,
  msg: Extract<SDKMessage, { type: "tool_call" }>,
  /** await 后写前复查 */
  stillCurrent: () => boolean,
): Promise<void> => {
  try {
    const meta = await buildToolResultMeta({
      taskId,
      callId: msg.call_id,
      rawName: msg.name,
      args: msg.args,
      result: msg.result,
      msgStatus: msg.status,
    });
    // 代表性插桩——tool_result 构建 await 之后、写事件复查之前
    await failpoint("sdkmsg.beforeEventWrite");
    if (!stillCurrent()) return;
    const summary =
      meta.status === "error"
        ? `工具失败 ${meta.name}`
        : `工具完成 ${meta.name}`;
    await writeOwnedEventAndPublish(
      taskId,
      stillCurrent,
      {
        kind: "tool_result",
        text: summary,
        meta,
      },
    );
  } catch (err) {
    console.warn(
      `[sdk-message-handler] emitToolResult 失败 task=${taskId} call=${msg.call_id}`,
      err,
    );
  }
};

/**
 * lease 改必传——task consume 传 opHandle 闭包（`() => isTaskOpCurrent(h)`）、
 * chat consume 传 instanceId 闭包（本 run 仍是 runningChats 当前实例才写）。
 * 旧签名「chat 缺省 opHandle = 永远 current」的 fail-open 语义删除。
 */
export const handleSdkMessage = async (
  taskId: string,
  msg: SDKMessage,
  assistantCtx: AssistantBufferCtx,
  /**
   * 失主则整条消息丢弃（含 thinking /
   * assistant / tool / error / tool_result + publish）。
   */
  lease: () => boolean,
): Promise<void> => {
  // 入口一次不够——每个 await 之后、写事件之前复用同一闭包复查
  const stillCurrent = lease;
  if (!stillCurrent()) return;

  switch (msg.type) {
    case "thinking": {
      await assistantCtx.flush();
      if (!stillCurrent()) return;
      await writeOwnedEventAndPublish(
        taskId,
        stillCurrent,
        {
          kind: "thinking",
          text: msg.text,
          meta: msg.thinking_duration_ms
            ? { durationMs: msg.thinking_duration_ms }
            : undefined,
        },
    );
      break;
    }

    case "tool_call": {
      await assistantCtx.flush();
      if (!stillCurrent()) return;
      const argsAny = (msg.args ?? {}) as Record<string, unknown>;
      const innerToolName =
        typeof argsAny.toolName === "string" ? argsAny.toolName : "";
      // 必须连 MCP wrapper 一起认——漏认会把 submit_work 写成普通 tool_call、
      // 被兜底 A 误当「答后又干活」拦下（2026-06-16 线上事故根因）
      const isWaitForUser =
        SUBMIT_TOOL_NAMES.has(msg.name) || SUBMIT_TOOL_NAMES.has(innerToolName);

      // V0.6：write / edit 写 actions/N-<type>.md 时推一份「在写 artifact」事件给 UI
      // ⚠️ 必须先用 WRITE_TOOL_NAMES 卡是不是「写」工具——read 跟 edit 都用 path 参数
      const possibleTarget = WRITE_TOOL_NAMES.has(msg.name)
        ? ((argsAny.target_file as string | undefined) ??
          (argsAny.file_path as string | undefined) ??
          (argsAny.path as string | undefined))
        : undefined;
      // Windows agent 写路径常用反斜杠；匹配前先归一成 `/`
      const normalizedTarget = possibleTarget
        ? possibleTarget.replace(/\\/g, "/")
        : undefined;
      if (
        normalizedTarget &&
        (normalizedTarget.includes("/actions/") ||
          normalizedTarget.startsWith("actions/"))
      ) {
        if (msg.status === "running") {
          const argsStr = stringifyMeta(msg.args);
          if (!stillCurrent()) return;
          await writeOwnedEventAndPublish(
            taskId,
            stillCurrent,
            {
              kind: "tool_call",
              text: `agent 在写 artifact: ${possibleTarget}`,
              meta: {
                callId: msg.call_id,
                name: msg.name,
                args: argsStr ? truncate(argsStr) : undefined,
              },
            },
    );
          break;
        }
        if (msg.status === "error") {
          const resStr = stringifyMeta(msg.result);
          if (!stillCurrent()) return;
          await writeOwnedEventAndPublish(
            taskId,
            stillCurrent,
            {
              kind: "error",
              text: `artifact 写入失败 ${msg.name} → ${possibleTarget}：${truncate(resStr, 200)}`,
              meta: {
                callId: msg.call_id,
                name: msg.name,
                target: possibleTarget,
                result: truncate(resStr),
              },
            },
    );
          await emitToolResult(taskId, msg, stillCurrent);
          break;
        }
        // 写成功：先落 tool_result（给前端看 diff/摘要），再刷 artifact 面板
        await emitToolResult(taskId, msg, stillCurrent);
        {
          const m = normalizedTarget.match(/actions\/(\d+)-[a-z]+\.md$/);
          if (m) {
            const n = Number(m[1]);
            const fresh = await getTask(taskId);
            if (!stillCurrent()) return;
            const target = fresh?.actions.find((a) => a.n === n);
            if (target) {
              // 旧 stream 的 artifact 元数据写必须绑 operation；失主拒写
              const patched = await patchActionIfOwner(
                taskId,
                target.id,
                { artifactUpdatedAt: Date.now() },
                () => stillCurrent(),
              );
              const a = patched?.actions.find((x) => x.id === target.id);
              if (a) publish(taskId, { kind: "action", action: a });
            }
          }
        }
        break;
      }

      if (isWaitForUser) {
        // status 维护：notifier 自己处理 awaiting；这里只记 error
        if (msg.status === "error") {
          const resStr = stringifyMeta(msg.result);
          if (!stillCurrent()) return;
          await writeOwnedEventAndPublish(
            taskId,
            stillCurrent,
            {
              kind: "error",
              text: `submit_work 工具调用失败：${truncate(resStr, 200)}`,
            },
    );
        }
        break;
      }

      if (msg.status === "running") {
        const argsStr = stringifyMeta(msg.args);
        if (!stillCurrent()) return;
        await writeOwnedEventAndPublish(
          taskId,
          stillCurrent,
          {
            kind: "tool_call",
            text: `调用 ${msg.name}${argsStr ? `:${truncate(argsStr, 120)}` : ""}`,
            // callId 供前端与 tool_result / tool_output_delta 配对；
            // innerToolName 给兜底 A 精确识别 MCP 工具（勿解析 truncate 后的 text）
            meta: {
              callId: msg.call_id,
              name: msg.name,
              innerToolName: innerToolName || undefined,
              args: argsStr ? truncate(argsStr) : undefined,
            },
          },
    );
      } else if (msg.status === "error") {
        const resStr = stringifyMeta(msg.result);
        if (!stillCurrent()) return;
        await writeOwnedEventAndPublish(
          taskId,
          stillCurrent,
          {
            kind: "error",
            text: `工具调用失败 ${msg.name}：${truncate(resStr, 200)}`,
            meta: {
              callId: msg.call_id,
              name: msg.name,
              result: truncate(resStr),
            },
          },
    );
        await emitToolResult(taskId, msg, stillCurrent);
      } else if (msg.status === "completed") {
        // Phase 1：completed 结果落盘（此前完全忽略 → shell/read 输出用户看不见）
        await emitToolResult(taskId, msg, stillCurrent);
      }
      break;
    }

    case "assistant": {
      // 畸形 SDK 消息可能缺 message / content 非数组 → 直接跳过，避免 TypeError 打崩整轮 run
      const blocks = msg.message?.content;
      if (!Array.isArray(blocks)) break;
      let text = "";
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          text += block.text;
        }
      }
      if (text.length > 0) {
        if (!stillCurrent()) return;
        assistantCtx.buffer += text;
        // streaming delta 也走 publishIfCurrent——失主不清 B 的 UI
        publishIfCurrent(taskId, stillCurrent, {
          kind: "assistant_delta",
          text,
        });
      }
      break;
    }

    case "status": {
      console.log(
        `[sdk-message-handler] SDK status message: status=${msg.status} message=${msg.message ?? "(none)"}`,
      );
      if (
        (msg.status === "ERROR" || msg.status === "EXPIRED") &&
        msg.message
      ) {
        if (!stillCurrent()) return;
        assistantCtx.sdkErrorMessage = msg.message;
        await writeOwnedEventAndPublish(
          taskId,
          stillCurrent,
          {
            kind: "error",
            text: `SDK ${msg.status}：${msg.message}`,
            meta: {
              sdkStatus: msg.status,
              sdkMessage: msg.message,
            },
          },
    );
      }
      break;
    }

    case "system":
    case "user":
    case "request":
    case "task":
    default:
      break;
  }
};
