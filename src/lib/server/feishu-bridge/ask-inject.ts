/**
 * 飞书自由文本 → pending ask 答题（4.4 通道②）
 *
 * 对齐 ask-reply 的分支：文本填进每道题的 answer → deliver → 落 ask_user_reply。
 * - chat 模式 → deliverChatAskReply（runningChats）
 * - task 模式 → deliverAskReply（agentSessions）——需求群回流答题会命中这条
 * 进程重启后 pending 丢失时返回 no_pending，调用方应改走 chat-reply / question。
 *
 * **入口同步摘走 pending**（takePendingAsk）：群答题卡按钮走 card.action 串行链、
 * 群里打字答题走入向消息串行链——两条链互不排队，`check → deliver → clear` 之间的
 * 长 await 会让同一组问题被投两遍（review P2-2）。摘走后失败路径按条件放回
 *（restorePendingAskIf：槽位被新提问占了就不放，绝不盖掉 agent 的新一组问题）。
 *
 * R1-5：可选 images（base64 payload）落盘后穿透给 deliver，与 chat-inject 同款。
 */

import type { ModelSelection } from "@cursor/sdk";

import {
  restorePendingAskIf,
  takePendingAsk,
} from "@/lib/server/chat-pending";
import { deliverChatAskReply, hasChatSession } from "@/lib/server/chat-runner";
import { deliverAskReply } from "@/lib/server/task-runner";
import { saveImageAttachments } from "@/lib/server/task-artifacts";
import { getTask } from "@/lib/server/task-fs";
import {
  agentSessions,
  PERSIST_WARNING_DELIVERED,
  writeUserEventAndPublishStrict,
} from "@/lib/server/task-stream";
import { getChatLifecycle } from "@/lib/server/chat-gate";

import {
  ASK_CARD_ANSWERED_HINT,
  settleAskCards,
} from "./ask-card-settle";
import { sanitizeGroupMemberName, truncateForGroup } from "./group-shared";

/** 卡片上回显答案的长度上限——卡片是索引不是正文，长答案去 app 看 */
const ASK_CARD_ANSWER_MAX = 120;

export type AskInjectImage = {
  data: string;
  mimeType: string;
  filename?: string;
};

export type AskInjectResult =
  | { ok: true }
  | { ok: false; reason: "no_pending" | "lifecycle" | "deliver_failed" | "not_found"; error: string };

export interface AskInjectOptions {
  /**
   * 答题人姓名（需求群跨角色答题时传）——写进 [ASK_USER_REPLY] 抬头 + 事件
   * meta.answeredBy，事件流里看得出这题是谁答的。app / p2p 本人答题不传。
   * 群昵称是自由文本、进 prompt 前统一过 `sanitizeGroupMemberName`（本模块内做、
   * 调用方漏洗也不会把伪造抬头带进 agent）。
   */
  answeredBy?: string;
}

/**
 * 把一段自由文本当作当前 pending ask 的答案投递（chat / task 两种模式）。
 * @param images 可选附图（base64）——落盘后绝对路径交给 deliver
 */
export const injectPendingAskText = async (
  taskId: string,
  text: string,
  bootArgs?: { apiKey?: string; model?: ModelSelection },
  images?: AskInjectImage[],
  opts: AskInjectOptions = {},
): Promise<AskInjectResult> => {
  // 先摘再投：摘走这一步同步完成，后到的并发调用直接 no_pending（见文件头）
  const pending = takePendingAsk(taskId);
  if (!pending) {
    return { ok: false, reason: "no_pending", error: "无 pending ask" };
  }

  const task = await getTask(taskId);
  if (!task) {
    restorePendingAskIf(taskId, pending);
    return { ok: false, reason: "not_found", error: "任务不存在" };
  }
  const isChat = task.mode === "chat";

  const life = getChatLifecycle(taskId);
  if (life !== null) {
    // 只是「此刻不能答」——问题还在，放回去等停 / 删完再答
    restorePendingAskIf(taskId, pending);
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
  // 姓名会进 agent prompt 抬头 + 事件 meta：清洗掉换行 / 方括号等伪造素材
  const answeredBy = sanitizeGroupMemberName(opts.answeredBy);
  const answers = pending.questions.map((q) => ({
    questionId: q.id,
    answer: answerText,
    ...(answeredBy ? { answeredBy } : {}),
  }));

  // 拼 [ASK_USER_REPLY]——与 ask-reply buildReplyText 非 deferred 路径同构（简化版）
  const sections: string[] = ["[ASK_USER_REPLY]"];
  if (answeredBy) {
    // 跨角色答题：告诉 agent 这轮答案来自谁（不是任务所有者本人）
    sections.push("", `（由需求群成员「${answeredBy}」代答）`);
  }
  pending.questions.forEach((q, idx) => {
    sections.push("", `Q${idx + 1}: ${q.question}`, `答：${answerText}`);
  });
  const replyText = sections.join("\n");

  // 找 ask_user_request 事件拿 actionId（task 模式 deliver 要用它绑失败归属）
  const reqEvent = [...task.events]
    .reverse()
    .find(
      (ev) =>
        ev.kind === "ask_user_request" &&
        typeof ev.meta?.askId === "string" &&
        ev.meta.askId === pending.askId,
    );

  // R1-5：附图落盘（与 chat-inject / ask-reply 同款 saveImageAttachments）
  let imageAbsPaths: string[] | undefined;
  let savedImages: Awaited<ReturnType<typeof saveImageAttachments>> = [];
  if (images && images.length > 0) {
    try {
      savedImages = await saveImageAttachments(taskId, images);
      imageAbsPaths = savedImages.map((s) => s.absPath);
    } catch (err) {
      restorePendingAskIf(taskId, pending);
      return {
        ok: false,
        reason: "deliver_failed",
        error: `图片处理失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const paths =
    imageAbsPaths && imageAbsPaths.length > 0 ? imageAbsPaths : undefined;
  const ok = isChat
    ? await deliverChatAskReply(task, replyText, paths, bootArgs)
    : (await deliverAskReply(
        task,
        replyText,
        paths,
        reqEvent?.actionId,
        bootArgs,
      )) === "sent";
  if (!ok) {
    // 会话还活着 = 只是这次忙 → 放回去让人重试；
    // 会话已死且无法唤醒 → 不放回（与 ask-reply 一致：这组问题就此作废、改走 question 通道）
    const sessionAlive = isChat
      ? hasChatSession(taskId)
      : agentSessions.has(taskId);
    if (sessionAlive) {
      restorePendingAskIf(taskId, pending);
    }
    return {
      ok: false,
      reason: "deliver_failed",
      error: "答案未能送达 AI（会话忙或已失效），请稍后重试",
    };
  }

  // 送达成功——pending 在入口就摘走了，这里不需要再清

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
        ...(answeredBy ? { answeredBy } : {}),
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

  // 飞书侧卡片置终态（群答题卡 + p2p 流式卡一起、按 (taskId, askId) 反查）。
  // 群里**打字**作答和**点按钮**作答都经过本函数，所以置态只留这一个收口点
  //（card-action 的群分支自己不再 patch，两个入口结果一致）。
  // 排在落盘之后：置态是锦上添花，不该让两次 lark 往返拖住答案入库。
  // best-effort：settleAskCards 内部吞掉一切异常、不影响答案已送达的事实
  await settleAskCards({
    taskId,
    askId: pending.askId,
    questions: pending.questions,
    fallbackNote: `${answeredBy ? `${answeredBy} ` : ""}已回答：${truncateForGroup(answerText, ASK_CARD_ANSWER_MAX)}`,
    hintNote: ASK_CARD_ANSWERED_HINT,
  });

  return { ok: true };
};
