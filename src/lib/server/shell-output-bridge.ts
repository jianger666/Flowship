/**
 * shell 输出流式桥接（Phase 1）
 *
 * SDK InteractionUpdate 的 `shell-output-delta` 在 run-perf 里被忽略；
 * stream 的 tool_call 消息只有 running/completed、无中间 stdout——必须走 onDelta。
 *
 * 注意：SDK 公开类型里 shell-output-delta **不带 callId**（只有 event.case/value），
 * 用最近一次 tool-call-started 的 shell callId 归因（同进程串行 shell 可靠；
 * 并行 shell 可能错配——记入交付说明）。
 *
 * 节流：≥500ms 或累计 ≥2KB 才 publish 一次；**只 SSE、不落 events.jsonl**。
 */

import type { InteractionUpdate } from "@cursor/sdk";

import {
  compactionEventMeta,
  compactionEventText,
} from "@/lib/compaction-display";

import { publish, writeOwnedEventAndPublish } from "./task-stream";

const FLUSH_INTERVAL_MS = 500;
const FLUSH_BYTES = 2 * 1024;

type Buf = {
  chunks: string[];
  bytes: number;
  lastFlushAt: number;
};

const extractShellChunk = (update: InteractionUpdate): string | null => {
  if (update.type !== "shell-output-delta") return null;
  const event = update.event as {
    case?: string;
    value?: { data?: unknown };
  };
  if (event.case !== "stdout" && event.case !== "stderr") return null;
  const data = event.value?.data;
  return typeof data === "string" && data.length > 0 ? data : null;
};

/**
 * 返回可塞进 SendOptions.onDelta 的 handler。
 * 与 createRunPerfTracker().onDelta 用 composeOnDelta 串联。
 *
 * @param lease 可选；每次 flush/publish 前同步 gate，失效则丢弃（旧 run 迟到 delta 不混入新 run）
 */
export const createShellOutputDeltaPublisher = (
  taskId: string,
  lease?: () => boolean,
): ((args: { update: InteractionUpdate }) => void) => {
  // SDK shell-output-delta 无 callId → 记最近启动的 shell
  let activeShellCallId: string | null = null;
  const buffers = new Map<string, Buf>();

  const publishChunk = (callId: string, chunk: string): void => {
    // publish 紧前同步 gate——无 await 夹缝；失主丢弃
    if (lease && !lease()) return;
    // ephemeral：伪造 TaskEvent 形态走既有 event SSE 帧，但不 appendEvent
    publish(taskId, {
      kind: "event",
      event: {
        id: `ephemeral_tod_${callId}_${Date.now()}`,
        ts: Date.now(),
        kind: "tool_output_delta",
        text: "",
        meta: { callId, chunk },
      },
    });
  };

  const flush = (callId: string): void => {
    // flush 入口再 gate 一次——缓冲期间失主则清缓冲不 publish
    if (lease && !lease()) {
      buffers.delete(callId);
      return;
    }
    const buf = buffers.get(callId);
    if (!buf || buf.chunks.length === 0) return;
    const chunk = buf.chunks.join("");
    buf.chunks = [];
    buf.bytes = 0;
    buf.lastFlushAt = Date.now();
    if (chunk.length === 0) return;
    publishChunk(callId, chunk);
  };

  return (args: { update: InteractionUpdate }): void => {
    try {
      const update = args.update;

      if (update.type === "tool-call-started") {
        const tc = update.toolCall as { type?: string };
        if (tc?.type === "shell") {
          activeShellCallId = update.callId;
          buffers.set(update.callId, {
            chunks: [],
            bytes: 0,
            lastFlushAt: Date.now(),
          });
        }
        return;
      }

      if (update.type === "tool-call-completed") {
        if (buffers.has(update.callId)) {
          flush(update.callId);
          buffers.delete(update.callId);
        }
        if (activeShellCallId === update.callId) activeShellCallId = null;
        return;
      }

      const chunk = extractShellChunk(update);
      if (!chunk) return;

      // 公开类型无 callId；若未来 SDK 补上则优先用
      const maybeId =
        typeof (update as { callId?: unknown }).callId === "string"
          ? (update as { callId: string }).callId
          : activeShellCallId;
      if (!maybeId) return;

      let buf = buffers.get(maybeId);
      if (!buf) {
        buf = { chunks: [], bytes: 0, lastFlushAt: Date.now() };
        buffers.set(maybeId, buf);
      }
      buf.chunks.push(chunk);
      buf.bytes += chunk.length;
      const due =
        buf.bytes >= FLUSH_BYTES ||
        Date.now() - buf.lastFlushAt >= FLUSH_INTERVAL_MS;
      if (due) flush(maybeId);
    } catch (err) {
      // 流式桥接绝不能拖垮主流程
      console.warn(`[shell-output-bridge] onDelta 失败 task=${taskId}`, err);
    }
  };
};

/**
 * Cursor SDK in-place summarization = 压缩上下文。
 * `summary-started` 立刻落「正在压缩上下文…」过程行（跟 pi compaction_start 同一套展示）；
 * `summary-completed` 再落完成行。start/end 串行写，避免火忘乱序。
 *
 * @param lease 绑 instanceId / opHandle——失主丢弃迟到 summary 事件
 */
export const createSdkSummaryDeltaPublisher = (
  taskId: string,
  lease: () => boolean,
): ((args: { update: InteractionUpdate }) => void) => {
  // 暂存最近一次 summary 文本字数（summary update 通常先于 summary-completed）
  let lastSummaryChars: number | undefined;
  // 已经挂过「正在压缩」——summary 正文只补字数，不再落第二条 running
  let startedEmitted = false;
  // onDelta 是同步签名：写事件排队，保证 started 先于 completed
  let writeChain = Promise.resolve();

  const enqueueWrite = (event: {
    text: string;
    meta: Record<string, unknown>;
  }): void => {
    writeChain = writeChain
      .then(async () => {
        if (!lease()) return;
        await writeOwnedEventAndPublish(taskId, lease, {
          kind: "info",
          text: event.text,
          meta: event.meta,
        });
      })
      .catch((err) => {
        console.warn(`[sdk-summary] task=${taskId} 写事件失败:`, err);
      });
  };

  return (args: { update: InteractionUpdate }): void => {
    try {
      const { update } = args;
      const type = String(update.type);
      const looksLikeSummary =
        type === "summary-started" ||
        type === "summary" ||
        type === "summary-completed" ||
        (typeof type === "string" && /summar/i.test(type));

      if (looksLikeSummary && !lease()) {
        console.warn(`[sdk-summary] task=${taskId} type=${type} 已失主，丢弃`);
        return;
      }

      if (type === "summary-started" || type === "summarization-started") {
        lastSummaryChars = undefined;
        startedEmitted = true;
        enqueueWrite({
          text: compactionEventText({ start: true }),
          meta: compactionEventMeta({ start: true, reason: "sdk" }),
        });
        return;
      }

      if (type === "summary" || type === "summarization") {
        const text =
          typeof (update as { summary?: unknown }).summary === "string"
            ? (update as { summary: string }).summary
            : "";
        lastSummaryChars = text.length;
        // 有的 SDK 版本跳过 started，收到摘要正文才挂过程行
        if (!startedEmitted) {
          startedEmitted = true;
          enqueueWrite({
            text: compactionEventText({ start: true }),
            meta: compactionEventMeta({ start: true, reason: "sdk" }),
          });
        }
        return;
      }

      if (type !== "summary-completed" && type !== "summarization-completed") {
        return;
      }

      startedEmitted = false;

      const summaryChars = lastSummaryChars;
      lastSummaryChars = undefined;
      enqueueWrite({
        text: compactionEventText({ start: false }),
        meta: {
          ...compactionEventMeta({ start: false, reason: "sdk" }),
          ...(summaryChars != null ? { summaryChars } : {}),
        },
      });
    } catch (err) {
      console.warn(`[sdk-summary] onDelta 失败 task=${taskId}`, err);
    }
  };
};

/** 串联多个 onDelta（perf + shell 流式 + sdk summary 等） */
export const composeOnDelta = (
  ...handlers: Array<(args: { update: InteractionUpdate }) => void>
): ((args: { update: InteractionUpdate }) => void) => {
  return (args) => {
    for (const h of handlers) h(args);
  };
};
