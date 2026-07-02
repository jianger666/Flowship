/**
 * SDKMessage → task 事件流翻译器（V0.9.x 从 task-runner.ts 拆出、纯搬家零逻辑变更）
 *
 * 职责：把 SDK run.stream() 吐的每条消息翻译成 events.jsonl 事件 + SSE publish：
 *   - thinking / tool_call / assistant（流式缓冲）/ status
 *   - artifact 写入检测（write/edit 命中 actions/ 路径 → 「在写 artifact」+ 落盘后刷 artifactUpdatedAt）
 *   - wait_for_user 特判（状态由 awaitingNotifier 管、这里只记 error）
 *
 * 依赖方向（保证无环）：只依赖 task-stream + task-fs、不 import task-runner。
 */

import type { SDKMessage } from "@cursor/sdk";

import { getTask, patchAction } from "./task-fs";
import {
  publish,
  stringifyMeta,
  truncate,
  writeEventAndPublish,
} from "./task-stream";

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

export const handleSdkMessage = async (
  taskId: string,
  msg: SDKMessage,
  assistantCtx: AssistantBufferCtx,
): Promise<void> => {
  switch (msg.type) {
    case "thinking": {
      await assistantCtx.flush();
      await writeEventAndPublish(taskId, {
        kind: "thinking",
        text: msg.text,
        meta: msg.thinking_duration_ms
          ? { durationMs: msg.thinking_duration_ms }
          : undefined,
      });
      break;
    }

    case "tool_call": {
      await assistantCtx.flush();
      const argsAny = (msg.args ?? {}) as Record<string, unknown>;
      const innerToolName =
        typeof argsAny.toolName === "string" ? argsAny.toolName : "";
      const isWaitForUser =
        msg.name === "wait_for_user" ||
        msg.name === "Wait For User" ||
        innerToolName === "wait_for_user" ||
        innerToolName === "Wait For User";

      // V0.6：write / edit 写 actions/N-<type>.md 时推一份「在写 artifact」事件给 UI（同 V0.5 artifacts/ 同款套路）
      // ⚠️ 必须先用 WRITE_TOOL_NAMES 卡是不是「写」工具——read 跟 edit 都用 path 参数、
      //    早期漏判直接看 path、导致 read artifact 被误标成「在写 artifact」
      //    （V0.6.12 实测单 task：89 条 read 被误标、比 55 条真 edit 还多、看着像 agent 狂写文件）
      const possibleTarget = WRITE_TOOL_NAMES.has(msg.name)
        ? ((argsAny.target_file as string | undefined) ??
          (argsAny.file_path as string | undefined) ??
          (argsAny.path as string | undefined))
        : undefined;
      if (
        possibleTarget &&
        (possibleTarget.includes("/actions/") ||
          possibleTarget.startsWith("actions/"))
      ) {
        if (msg.status === "running") {
          const argsStr = stringifyMeta(msg.args);
          await writeEventAndPublish(taskId, {
            kind: "tool_call",
            text: `agent 在写 artifact: ${possibleTarget}`,
            meta: {
              name: msg.name,
              args: argsStr ? truncate(argsStr) : undefined,
            },
          });
          break;
        }
        if (msg.status === "error") {
          const resStr = stringifyMeta(msg.result);
          await writeEventAndPublish(taskId, {
            kind: "error",
            text: `artifact 写入失败 ${msg.name} → ${possibleTarget}：${truncate(resStr, 200)}`,
            meta: { name: msg.name, target: possibleTarget, result: truncate(resStr) },
          });
          break;
        }
        // 写成功（status 非 running 非 error = SDK tool 执行完、文件已落盘）
        // 事件驱动根治「artifact 落盘后页面不刷新」：从路径解析 n、刷新对应 action 的
        // artifactUpdatedAt + 推 action 帧 → 前端面板 effect 依赖它立即重拉、不靠退避猜落盘时刻。
        // （artifactPath 在 appendAction 建 action 时已预设成 actions/<n>-<type>.md、文件在即可读、
        //   这里只需触发一次「文件变了、来重读」的信号）
        {
          const m = possibleTarget.match(/actions\/(\d+)-[a-z]+\.md$/);
          if (m) {
            const n = Number(m[1]);
            const fresh = await getTask(taskId);
            const target = fresh?.actions.find((a) => a.n === n);
            if (target) {
              const patched = await patchAction(taskId, target.id, {
                artifactUpdatedAt: Date.now(),
              });
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
          await writeEventAndPublish(taskId, {
            kind: "error",
            text: `wait_for_user 工具调用失败：${truncate(resStr, 200)}`,
          });
        }
        break;
      }

      if (msg.status === "running") {
        const argsStr = stringifyMeta(msg.args);
        await writeEventAndPublish(taskId, {
          kind: "tool_call",
          text: `调用 ${msg.name}${argsStr ? `:${truncate(argsStr, 120)}` : ""}`,
          meta: { name: msg.name, args: argsStr ? truncate(argsStr) : undefined },
        });
      } else if (msg.status === "error") {
        const resStr = stringifyMeta(msg.result);
        await writeEventAndPublish(taskId, {
          kind: "error",
          text: `工具调用失败 ${msg.name}：${truncate(resStr, 200)}`,
          meta: { name: msg.name, result: truncate(resStr) },
        });
      }
      break;
    }

    case "assistant": {
      let text = "";
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          text += block.text;
        }
      }
      if (text.length > 0) {
        assistantCtx.buffer += text;
        publish(taskId, { kind: "assistant_delta", text });
      }
      break;
    }

    case "status": {
      console.log(
        `[task-runner] SDK status message: status=${msg.status} message=${
          (msg as { message?: string }).message ?? "(none)"
        }`,
      );
      if (
        (msg.status === "ERROR" || msg.status === "EXPIRED") &&
        msg.message
      ) {
        assistantCtx.sdkErrorMessage = msg.message;
        await writeEventAndPublish(taskId, {
          kind: "error",
          text: `SDK ${msg.status}：${msg.message}`,
          meta: { sdkStatus: msg.status, sdkMessage: msg.message },
        });
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
