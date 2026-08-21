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

import { appendEvent, getTask, patchActionIfOwner } from "./task-fs";
import { failpoint } from "./failpoints";
import {
  publish,
  publishIfCurrent,
  stringifyMeta,
  truncate,
  writeOwnedEventAndPublish,
} from "./task-stream";
import { buildToolResultMeta } from "./tool-result-persist";

/**
 * 交卷成功后的固定收尾文案（AI 播报形态、内容平台统一固定）。
 * 不出现「交卷 / submit_work」等内部术语——用户只需要知道「产出已更新、等审阅」。
 * 模型交卷后说出的答案照常上屏、回合自然结束时由平台在答案之后补发这一句。
 */
export const SUBMIT_COMPLETED_TEXT = "已完成，产出已更新，请审阅。";

/** 把攒着的 thinking token 落成一条事件。tool / 正文 / run 结束前都要先冲掉。 */
export const flushThinkingBuffer = async (
  taskId: string,
  ctx: AssistantBufferCtx,
  lease: () => boolean,
  origin?: string,
): Promise<void> => {
  const text = ctx.thinkingBuffer ?? "";
  const durationMs = ctx.thinkingDurationMs;
  ctx.thinkingBuffer = "";
  ctx.thinkingDurationMs = undefined;
  if (!text) return;
  if (!lease()) return;
  const meta = {
    ...(durationMs ? { durationMs } : {}),
    ...(ctx.askSeen ? { muted: true } : {}),
  };
  const ev = {
    kind: "thinking" as const,
    text,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
  if (ctx.askSeen) {
    await appendEvent(taskId, ev, lease);
    return;
  }
  await writeOwnedEventAndPublish(taskId, lease, ev, origin);
};

// assistant 文本的流式缓冲：delta 先 publish 给 UI 打字机、攒到下个非 assistant 消息时 flush 落盘
export interface AssistantBufferCtx {
  buffer: string;
  flush: () => Promise<void>;
  /** 思考 delta 攒在这儿，一段思考只落一条 thinking 事件（pi 的 thinking_delta 是 token 级） */
  thinkingBuffer?: string;
  /** 本段思考累加的 durationMs（最后一条 SDK thinking 常带） */
  thinkingDurationMs?: number;
  sdkErrorMessage?: string;
  /** 本回合已交卷成功（submit_work 返回 [SUBMITTED] / [NO_WAIT_NEEDED]）：之后模型输出（答案）照常广播、固定收尾延到 run 结束 */
  submitSeen?: boolean;
  /** 固定收尾是否已补发（防重复） */
  fixedSent?: boolean;
  /** 本回合已提问成功（ask_user 返回 [ASK_SUBMITTED]）：之后模型输出（含工具）全部消音（答题卡即收尾） */
  askSeen?: boolean;
  /** 本轮是否写/改过 artifact（actions/*.md）——交卷时判定「产出是否真的更新」（事实信号、无语义判断） */
  artifactWritten?: boolean;
}

/**
 * 补发固定收尾（交卷成功才补、一次）。
 * 只在 run 自然结束时调用（task-runner / chat-runner 的兜底）——交卷后的答案
 * 已照常广播完、横幅跟在答案之后、once 守卫保证只发一次。
 * 两条都走 info（轻量提示、不占 AI 气泡）：「已完成，产出已更新，请审阅。」（写了产出）
 * 或「已回复」（纯答疑、没动产出）。
 */
export const maybeEmitSubmitFixedText = async (
  ctx: AssistantBufferCtx,
  write: (ev: { kind: "assistant_message" | "info"; text: string }) => Promise<unknown>,
): Promise<boolean> => {
  if (!ctx.submitSeen || ctx.fixedSent) return false;
  ctx.fixedSent = true;
  if (ctx.artifactWritten) {
    await write({ kind: "info", text: SUBMIT_COMPLETED_TEXT });
  } else {
    await write({ kind: "info", text: "已回复" });
  }
  return true;
};

// ----------------- tool_call running 去重（同 callId 只落一条） -----------------
// SDK 对长 args 工具（task / edit）会流式补全 args、对同一 call_id 发多次 status=running；
// 若不挡、events.jsonl 双写 → UI 渲染成对工具块（线上「子代理成对出现」根因）。
const TOOL_CALL_RUNNING_SEEN_KEY = "__flowshipToolCallRunningSeenV1__";
/** 长跑进程防无界；超限 FIFO 淘汰最旧 callId */
const TOOL_CALL_RUNNING_SEEN_MAX = 2000;

type ToolCallRunningSeen = {
  set: Set<string>;
  /** FIFO 插入序，与 set 同步 */
  order: string[];
};

const getToolCallRunningSeen = (): ToolCallRunningSeen => {
  const g = globalThis as unknown as Record<
    string,
    ToolCallRunningSeen | undefined
  >;
  if (!g[TOOL_CALL_RUNNING_SEEN_KEY]) {
    g[TOOL_CALL_RUNNING_SEEN_KEY] = { set: new Set(), order: [] };
  }
  return g[TOOL_CALL_RUNNING_SEEN_KEY]!;
};

/**
 * 标记 callId 已写过 running；返回 false = 本条应跳过写盘。
 * completed / error 不走此门。
 */
const tryMarkToolCallRunningSeen = (callId: string): boolean => {
  if (!callId) return true;
  const state = getToolCallRunningSeen();
  if (state.set.has(callId)) return false;
  state.set.add(callId);
  state.order.push(callId);
  while (state.order.length > TOOL_CALL_RUNNING_SEEN_MAX) {
    const oldest = state.order.shift();
    if (oldest) state.set.delete(oldest);
  }
  return true;
};

/** 单测清空去重表（避免用例互相污染） */
export const __resetToolCallRunningSeenForTest = (): void => {
  const g = globalThis as unknown as Record<
    string,
    ToolCallRunningSeen | undefined
  >;
  g[TOOL_CALL_RUNNING_SEEN_KEY] = { set: new Set(), order: [] };
};

/** task 工具 args 默认上限放宽——短字段前置后仍要给 prompt 留展示空间 */
const TASK_TOOL_ARGS_TRUNCATE_MAX = 2000;

/**
 * updateTodos 主体是 todos 数组，没法短字段前置；默认 500 会截断条目 →
 * 前端 parseTodoToolArgs 解析不全。放宽到 4000 够常见清单。
 */
const TODO_TOOL_ARGS_TRUNCATE_MAX = 4000;

/** updateTodos / update_todos（大小写不敏感） */
const isUpdateTodosToolName = (name: string): boolean => {
  const n = name.toLowerCase();
  return n === "updatetodos" || n === "update_todos";
};

/**
 * task 工具：短字段（description / model / subagentType）前置再 stringify。
 * 原始键序常是 description→prompt→subagentType→model，prompt 动辄 500+，
 * 默认 truncate(500) 会把尾部 model 永久截掉 → 前端徽标永远拿不到。
 *
 * updateTodos：放大截断上限（见 TODO_TOOL_ARGS_TRUNCATE_MAX）。
 */
const stringifyToolCallArgs = (
  name: string,
  args: unknown,
): { argsStr: string; truncateMax: number } => {
  if (
    name === "task" &&
    args != null &&
    typeof args === "object" &&
    !Array.isArray(args)
  ) {
    const raw = args as Record<string, unknown>;
    const { description, model, subagentType, prompt, ...rest } = raw;
    // JSON.stringify 按插入序；undefined 值的键自动跳过
    const reordered = { description, model, subagentType, prompt, ...rest };
    return {
      argsStr: stringifyMeta(reordered),
      truncateMax: TASK_TOOL_ARGS_TRUNCATE_MAX,
    };
  }
  // 待办清单：数组是主体，只能放大截断上限
  if (isUpdateTodosToolName(name)) {
    return {
      argsStr: stringifyMeta(args),
      truncateMax: TODO_TOOL_ARGS_TRUNCATE_MAX,
    };
  }
  return { argsStr: stringifyMeta(args), truncateMax: 500 };
};

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
  /** 旁路 run 身份（属主主链 undefined）——见 handleSdkMessage 的 origin 参数 */
  origin?: string,
  /** 消音审计：事件照常落盘但带 muted 标记、UI 不渲染 */
  muted?: boolean,
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
    const event = {
      kind: "tool_result" as const,
      text: summary,
      meta: muted ? { ...meta, muted: true } : meta,
    };
    if (muted) {
      // 消音审计：只落盘、不 SSE 广播——广播会让前端每来一条 muted chunk 重渲染整条
      // 事件流、贴底跟随反复触发（和用户上滚打架 = 高频抖动，实测回归）
      await appendEvent(taskId, event, stillCurrent);
    } else {
      await writeOwnedEventAndPublish(taskId, stillCurrent, event, origin);
    }
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
  /**
   * 这一路 run 的身份 token（属主主链不传）。本翻译器被属主 run 与旁路只读答疑 run
   * 共用——publish 出去的 envelope 带上它，群回流才分得清「这段回答是谁的」
   * （见 task-stream 的 TaskStreamEvent.origin）。只影响 envelope、不落盘。
   */
  origin?: string,
): Promise<void> => {
  // 入口一次不够——每个 await 之后、写事件之前复用同一闭包复查
  const stillCurrent = lease;
  if (!stillCurrent()) return;

  /** 本轮统一 sink：lease + origin 一次绑好，下面各分支只管事件内容 */
  const writeEv = (
    ev: Parameters<typeof writeOwnedEventAndPublish>[2],
  ): Promise<unknown> =>
    writeOwnedEventAndPublish(taskId, stillCurrent, ev, origin);

  switch (msg.type) {
    case "thinking": {
      await assistantCtx.flush();
      if (!stillCurrent()) return;
      const chunk = typeof msg.text === "string" ? msg.text : "";
      if (!chunk) break;
      assistantCtx.thinkingBuffer = (assistantCtx.thinkingBuffer ?? "") + chunk;
      if (msg.thinking_duration_ms) {
        assistantCtx.thinkingDurationMs =
          (assistantCtx.thinkingDurationMs ?? 0) + msg.thinking_duration_ms;
      }
      break;
    }

    case "tool_call": {
      await flushThinkingBuffer(taskId, assistantCtx, stillCurrent, origin);
      await assistantCtx.flush();
      if (!stillCurrent()) return;
      const argsAny = (msg.args ?? {}) as Record<string, unknown>;
      const innerToolName =
        typeof argsAny.toolName === "string" ? argsAny.toolName : "";
      // 已提问成功后：本回合剩余工具全部消音（照常落盘带 muted 标记、审计保留）——
      // 模型若把宿主 Please continue 当用户消息去调查 / 重问，痕迹留在 events.jsonl、UI 不渲染；
      // 不走 artifact 面板 / ask 检测等副作用分支。
      if (assistantCtx.askSeen) {
        if (msg.status === "running") {
          if (!tryMarkToolCallRunningSeen(msg.call_id)) break;
          const { argsStr, truncateMax } = stringifyToolCallArgs(
            msg.name,
            msg.args,
          );
          if (!stillCurrent()) return;
          await appendEvent(taskId, {
            kind: "tool_call",
            text: `调用 ${msg.name}${
              argsStr ? `:${truncate(argsStr, 120)}` : ""
            }`,
            meta: {
              callId: msg.call_id,
              name: msg.name,
              innerToolName: innerToolName || undefined,
              args: argsStr ? truncate(argsStr, truncateMax) : undefined,
              muted: true,
            },
          }, stillCurrent);
        } else if (msg.status === "error") {
          await emitToolResult(taskId, msg, stillCurrent, origin, true);
        } else if (msg.status === "completed") {
          await emitToolResult(taskId, msg, stillCurrent, origin, true);
        }
        break;
      }
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
        // 事实信号：本轮写/改过 artifact——交卷时据此判「产出是否真的更新」（横幅/收尾语义）
        assistantCtx.artifactWritten = true;
        if (msg.status === "running") {
          // 同 callId 的二次 running（SDK 流式补 args）跳过，避免双工具块
          if (!tryMarkToolCallRunningSeen(msg.call_id)) break;
          const argsStr = stringifyMeta(msg.args);
          if (!stillCurrent()) return;
          await writeEv({
            kind: "tool_call",
            text: `agent 在写 artifact: ${possibleTarget}`,
            meta: {
              callId: msg.call_id,
              name: msg.name,
              args: argsStr ? truncate(argsStr) : undefined,
            },
          });
          break;
        }
        if (msg.status === "error") {
          await emitToolResult(taskId, msg, stillCurrent, origin);
          break;
        }
        // 写成功：先落 tool_result（给前端看 diff/摘要），再刷 artifact 面板
        await emitToolResult(taskId, msg, stillCurrent, origin);
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
          await writeEv({
            kind: "error",
            text: `submit_work 工具调用失败：${truncate(resStr, 200)}`,
          });
        } else if (msg.status === "completed") {
          // 交卷成功才进「已交卷」状态：之后模型输出（答案）照常广播、不消音——
          // 固定收尾「已完成」横幅延到 run 自然结束再补发（见 task-runner / chat-runner 兜底）、
          // 保证答案在横幅之前。
          // 失败文案（未受理 / stale / busy / 无桥 / mismatch）不消音——模型还要解释怎么处理。
          const resStr =
            typeof msg.result === "string"
              ? msg.result
              : stringifyMeta(msg.result ?? {});
          const rejected =
            resStr.length > 0 &&
            /交卷未受理|已被后续操作取代|没有活跃会话桥|CALLER_MISMATCH/.test(resStr);
          if (!rejected) {
            assistantCtx.submitSeen = true;
          }
        }
        break;
      }

      if (msg.status === "running") {
        // 同 callId 的二次 running（SDK 流式补 args）跳过，避免双工具块
        if (!tryMarkToolCallRunningSeen(msg.call_id)) break;
        const { argsStr, truncateMax } = stringifyToolCallArgs(
          msg.name,
          msg.args,
        );
        if (!stillCurrent()) return;
        await writeEv({
          kind: "tool_call",
          text: `调用 ${msg.name}${argsStr ? `:${truncate(argsStr, 120)}` : ""}`,
          // callId 供前端与 tool_result / tool_output_delta 配对；
          // innerToolName 给兜底 A 精确识别 MCP 工具（勿解析 truncate 后的 text）
          meta: {
            callId: msg.call_id,
            name: msg.name,
            innerToolName: innerToolName || undefined,
            args: argsStr ? truncate(argsStr, truncateMax) : undefined,
          },
        });
      } else if (msg.status === "error") {
        await emitToolResult(taskId, msg, stillCurrent, origin);
      } else if (msg.status === "completed") {
        // Phase 1：completed 结果落盘（此前完全忽略 → shell/read 输出用户看不见）
        await emitToolResult(taskId, msg, stillCurrent, origin);
      }

      // ask_user 成功（[ASK_SUBMITTED]）：进入「已提问」状态——之后全部消音（答题卡即收尾）。
      // 放在 tool_result 落盘之后（同一条消息先走正常落盘、再置消音状态）；
      // 失败文案（未受理 / stale / busy / 无桥 / mismatch）不消音——模型还要解释怎么处理。
      const isAskUser =
        innerToolName === "ask_user" ||
        msg.name === "ask_user" ||
        msg.name === "Ask User";
      if (isAskUser && msg.status === "completed" && !assistantCtx.askSeen) {
        const resStr =
          typeof msg.result === "string"
            ? msg.result
            : stringifyMeta(msg.result ?? {});
        const rejected =
          resStr.length > 0 &&
          /未受理|已被后续操作取代|没有活跃会话桥|CALLER_MISMATCH/.test(resStr);
        if (!rejected && resStr.includes("[ASK_SUBMITTED]")) {
          assistantCtx.askSeen = true;
        }
      }
      break;
    }

    case "assistant": {
      await flushThinkingBuffer(taskId, assistantCtx, stillCurrent, origin);
      if (!stillCurrent()) return;
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
        // 提问成功后的模型输出（askSeen）：答案以新消息 [ASK_USER_REPLY] 来 → 之后正文静音；
        // 交卷（submitSeen）后的正文照常广播——答案给用户看、不再静音。
        if (assistantCtx.askSeen) {
          // 消音审计：只落盘、不广播（见 emitToolResult muted 注释）
          await appendEvent(taskId, {
            kind: "assistant_message",
            text,
            meta: { muted: true },
          }, stillCurrent);
          break;
        }
        assistantCtx.buffer += text;
        // streaming delta 也走 publishIfCurrent——失主不清 B 的 UI
        publishIfCurrent(taskId, stillCurrent, {
          kind: "assistant_delta",
          text,
          ...(origin ? { origin } : {}),
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
        await writeEv({
          kind: "error",
          text: `SDK ${msg.status}：${msg.message}`,
          meta: {
            sdkStatus: msg.status,
            sdkMessage: msg.message,
          },
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
