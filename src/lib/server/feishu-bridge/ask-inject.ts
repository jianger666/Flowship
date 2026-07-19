/**
 * 飞书自由文本 → pending ask 答题（4.4 通道②）
 *
 * 对齐 ask-reply 的 chat 分支：文本填进每道题的 answer → deliverChatAskReply → 落 ask_user_reply。
 * 进程重启后 pending 丢失时返回 no_pending，调用方应改走 chat-reply。
 *
 * R1-5：可选 images（base64 payload）落盘后穿透给 deliverChatAskReply，与 chat-inject 同款。
 */

import type { ModelSelection } from "@cursor/sdk";

import { clearPendingAsk, getPendingAsk } from "@/lib/server/chat-pending";
import { deliverChatAskReply, hasChatSession } from "@/lib/server/chat-runner";
import { saveImageAttachments } from "@/lib/server/task-artifacts";
import { getTask } from "@/lib/server/task-fs";
import {
  PERSIST_WARNING_DELIVERED,
  writeUserEventAndPublishStrict,
} from "@/lib/server/task-stream";
import { getChatLifecycle } from "@/lib/server/chat-gate";

export type AskInjectImage = {
  data: string;
  mimeType: string;
  filename?: string;
};

export type AskInjectResult =
  | { ok: true }
  | { ok: false; reason: "no_pending" | "not_chat" | "lifecycle" | "deliver_failed" | "not_found"; error: string };

/**
 * 把一段自由文本当作当前 pending ask 的答案投递（chat 模式）。
 * @param images 可选附图（base64）——落盘后绝对路径交给 deliverChatAskReply
 */
export const injectPendingAskText = async (
  taskId: string,
  text: string,
  bootArgs?: { apiKey?: string; model?: ModelSelection },
  images?: AskInjectImage[],
): Promise<AskInjectResult> => {
  const pending = getPendingAsk(taskId);
  if (!pending) {
    return { ok: false, reason: "no_pending", error: "无 pending ask" };
  }

  const task = await getTask(taskId);
  if (!task) {
    return { ok: false, reason: "not_found", error: "任务不存在" };
  }
  if (task.mode !== "chat") {
    return { ok: false, reason: "not_chat", error: "非 chat 任务" };
  }

  const life = getChatLifecycle(taskId);
  if (life !== null) {
    return {
      ok: false,
      reason: "lifecycle",
      error:
        life === "deleting"
          ? "任务正在删除"
          : life === "finalizing"
            ? "正在终结、请稍后再试"
            : "正在停止、请稍后再试",
    };
  }

  const answerText = text.trim() || "（未回答）";
  const answers = pending.questions.map((q) => ({
    questionId: q.id,
    answer: answerText,
  }));

  // 拼 [ASK_USER_REPLY]——与 ask-reply buildReplyText 非 deferred 路径同构（简化版）
  const sections: string[] = ["[ASK_USER_REPLY]"];
  pending.questions.forEach((q, idx) => {
    sections.push("", `Q${idx + 1}: ${q.question}`, `答：${answerText}`);
  });
  const replyText = sections.join("\n");

  // R1-5：附图落盘（与 chat-inject / ask-reply 同款 saveImageAttachments）
  let imageAbsPaths: string[] | undefined;
  let savedImages: Awaited<ReturnType<typeof saveImageAttachments>> = [];
  if (images && images.length > 0) {
    try {
      savedImages = await saveImageAttachments(taskId, images);
      imageAbsPaths = savedImages.map((s) => s.absPath);
    } catch (err) {
      return {
        ok: false,
        reason: "deliver_failed",
        error: `图片处理失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const ok = await deliverChatAskReply(
    task,
    replyText,
    imageAbsPaths && imageAbsPaths.length > 0 ? imageAbsPaths : undefined,
    bootArgs,
  );
  if (!ok) {
    // 会话已死且无法唤醒时，与 ask-reply 一致：清 pending 并报错
    if (!hasChatSession(taskId)) {
      clearPendingAsk(taskId);
    }
    return {
      ok: false,
      reason: "deliver_failed",
      error: "答案未能送达 AI（会话忙或已失效），请稍后重试",
    };
  }

  clearPendingAsk(taskId);

  // 找 ask_user_request 事件拿 actionId（可缺）
  const reqEvent = [...task.events]
    .reverse()
    .find(
      (ev) =>
        ev.kind === "ask_user_request" &&
        typeof ev.meta?.askId === "string" &&
        ev.meta.askId === pending.askId,
    );

  // 对齐 ask-reply：已送达后 strict 落盘；失败只记 warning，不伪装未发送
  try {
    const replyEvent = await writeUserEventAndPublishStrict(taskId, {
      kind: "ask_user_reply",
      actionId: reqEvent?.actionId,
      text: replyText,
      meta: {
        askId: pending.askId,
        answers,
        source: "feishu",
        ...(savedImages.length > 0 ? { images: savedImages } : {}),
      },
    });
    if (!replyEvent) {
      console.error(
        `[feishu-bridge/ask-inject] 已送达但持久化失败（ENOENT）task=${taskId} warning=${PERSIST_WARNING_DELIVERED}`,
      );
    }
  } catch (persistErr) {
    console.error(
      `[feishu-bridge/ask-inject] 已送达但持久化失败 task=${taskId}:`,
      persistErr,
    );
  }

  return { ok: true };
};
