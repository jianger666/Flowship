/**
 * 飞书卡片按钮回调闭环（S3b / 方案 4.4① + 决策 #24）
 *
 * 处理 card.action.trigger：
 * - kind=ask → 选项答题（对齐 ask-inject / ask-reply chat 分支）
 * - kind=retry → 重发上一条用户消息（handleChatReplyInject）
 * - kind=end_chat / end_all → 清理卡「结束」（飞书侧出局、app 数据不动）
 * - kind=cmd → 控制面板快捷按钮（等价 /new 无参 / 直发 /stop / /status）
 *
 * 坑 #11：lark-cli 长连接由 SDK 自动 ack（见报告）；本模块只做业务 + 卡片终态 PATCH。
 * 坑 #12：operator 必须是应用 owner（本人），他人点转发卡片一律丢弃。
 */

import type { ModelSelection } from "@cursor/sdk";

import { handleChatReplyInject } from "@/lib/server/chat-inject";
import { clearPendingAsk, getPendingAsk } from "@/lib/server/chat-pending";
import { getChatLifecycle } from "@/lib/server/chat-gate";
import {
  deliverChatAskReply,
  hasChatSession,
} from "@/lib/server/chat-runner";
import { stopTaskAgent } from "@/lib/server/stop-task";
import { getTask } from "@/lib/server/task-fs";
import {
  PERSIST_WARNING_DELIVERED,
  writeUserEventAndPublishStrict,
} from "@/lib/server/task-stream";

import {
  addEndedChatTaskId,
  getCurrentChatTaskId,
  setCurrentChatTaskId,
} from "./bridge-state";
import {
  ASK_CARD_ANSWERED_HINT,
  isAskCardSettled,
  settleAskCards,
} from "./ask-card-settle";
import { findTaskByMessageId } from "./card-map";
import {
  GROUP_MEMBER_FALLBACK_NAME,
  mentionTag,
  rememberGroupReply,
  restoreGroupReply,
} from "./group-shared";
import { nextCardSequence } from "./card-seq";
import { askOptionElementId } from "./card-stream";
import {
  execCleanupCard,
  execNewChatNoArgs,
  execStatusText,
} from "./commands";
import {
  buildCleanupCardEndedAllJson,
  endChatButtonElementId,
  endChatRowElementId,
} from "./control-cards";
import {
  batchUpdateCard,
  getBotAppInfo,
  sendTextMessage,
  sendTextMessageToChat,
  updateCardEntity,
} from "./lark-api";
import {
  listActiveChatTasks,
  loadBridgeBootContext,
  registerCardActionHandler,
} from "./router";
import type { CardButtonValue } from "./types";

const LOG = "[feishu-bridge/card-action]";

/** globalThis 幂等注册键（dev HMR 不双挂） */
const CARD_ACTION_REG_KEY = "__flowshipFeishuCardActionRegisteredV1__";

// ----------------- 事件宽容解析（对齐 inbound.normalizeInboundEvent 风格） -----------------

export type NormalizedCardAction = {
  operatorOpenId: string;
  messageId: string;
  /** 延迟更新 token（坑 #11 视觉应答备用；CardKit 路径可不依赖） */
  token?: string;
  /** 原始 action value（对象或已 parse 的 JSON） */
  valueRaw: unknown;
  chatId?: string;
};

/** 取第一个非空字符串（各家 schema 字段名不一、取值链一律用它拼） */
const firstString = (...cands: unknown[]): string | undefined => {
  for (const c of cands) {
    if (typeof c === "string" && c) return c;
  }
  return undefined;
};

/**
 * 从 lark-cli 扁平输出 / 官方嵌套 event 两种形态抽出关键字段。
 * 扁平（consume 实测 schema）：operator_id / action_value / message_id / chat_id / token
 * 嵌套（开放平台原文）：operator.open_id / event.action.value /
 * event.context.open_message_id / event.context.open_chat_id
 */
export const normalizeCardActionEvent = (
  raw: unknown,
): NormalizedCardAction | null => {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nested =
    o.event && typeof o.event === "object"
      ? (o.event as Record<string, unknown>)
      : null;
  // 官方原文把会话 / 消息标识塞在 event.context 里（扁平 schema 没有这一层）
  const nestedCtx =
    nested?.context && typeof nested.context === "object"
      ? (nested.context as Record<string, unknown>)
      : null;

  // operator
  let operatorOpenId = "";
  if (typeof o.operator_id === "string") operatorOpenId = o.operator_id;
  else if (typeof o.operatorOpenId === "string") operatorOpenId = o.operatorOpenId;
  else {
    const op =
      (o.operator && typeof o.operator === "object"
        ? (o.operator as Record<string, unknown>)
        : null) ||
      (nested?.operator && typeof nested.operator === "object"
        ? (nested.operator as Record<string, unknown>)
        : null);
    if (op) {
      if (typeof op.open_id === "string") operatorOpenId = op.open_id;
      else if (typeof op.operator_id === "string") operatorOpenId = op.operator_id;
      else if (typeof op.user_id === "string") operatorOpenId = op.user_id;
    }
  }

  // message_id
  const messageId =
    firstString(
      o.message_id,
      o.open_message_id,
      nestedCtx?.open_message_id,
      nested?.message_id,
    ) ?? "";

  // action value：扁平 action_value（常为 JSON 字符串）/ 嵌套 action.value（对象或字符串）
  let valueRaw: unknown;
  if ("action_value" in o) valueRaw = o.action_value;
  else if ("actionValue" in o) valueRaw = o.actionValue;
  else {
    const action =
      (o.action && typeof o.action === "object"
        ? (o.action as Record<string, unknown>)
        : null) ||
      (nested?.action && typeof nested.action === "object"
        ? (nested.action as Record<string, unknown>)
        : null);
    if (action && "value" in action) valueRaw = action.value;
  }

  if (!operatorOpenId) return null;
  // value 缺失无法分发；messageId 可缺（仍可用 value.taskId）
  if (valueRaw === undefined || valueRaw === null || valueRaw === "") {
    return null;
  }

  const token = firstString(o.token, nested?.token);
  // 来源 chat 取值链：漏一层就会让群卡片校验拿不到来源、把跨角色答题 / 群推进
  // 降级成 owner-only（`isGroupCardClickFromItsChat` 的 fail-closed 兜底）——
  // 群里除属主外全员哑火。扁平 chat_id / open_chat_id、嵌套 event.*、
  // 官方原文 event.context.open_chat_id 都要认。
  const chatId = firstString(
    o.chat_id,
    o.open_chat_id,
    nested?.chat_id,
    nested?.open_chat_id,
    nestedCtx?.open_chat_id,
  );

  return { operatorOpenId, messageId, token, valueRaw, chatId };
};

/** 解析 CardButtonValue：兼容对象与 JSON 字符串（坑：action_value 类型开发者自定义） */
export const parseCardButtonValue = (raw: unknown): CardButtonValue | null => {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    try {
      obj = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const v = obj as Record<string, unknown>;
  if (v.kind === "ask") {
    if (
      typeof v.taskId !== "string" ||
      typeof v.askId !== "string" ||
      typeof v.questionId !== "string" ||
      typeof v.optionId !== "string"
    ) {
      return null;
    }
    return {
      kind: "ask",
      taskId: v.taskId,
      askId: v.askId,
      questionId: v.questionId,
      optionId: v.optionId,
    };
  }
  if (v.kind === "retry") {
    if (typeof v.taskId !== "string") return null;
    return {
      kind: "retry",
      taskId: v.taskId,
      ...(typeof v.lastUserMessage === "string"
        ? { lastUserMessage: v.lastUserMessage }
        : {}),
    };
  }
  if (v.kind === "group_ask") {
    if (
      typeof v.taskId !== "string" ||
      typeof v.askId !== "string" ||
      typeof v.questionId !== "string" ||
      typeof v.optionId !== "string" ||
      typeof v.chatId !== "string"
    ) {
      return null;
    }
    return {
      kind: "group_ask",
      taskId: v.taskId,
      askId: v.askId,
      questionId: v.questionId,
      optionId: v.optionId,
      chatId: v.chatId,
    };
  }
  if (v.kind === "group_advance") {
    if (
      typeof v.taskId !== "string" ||
      typeof v.chatId !== "string" ||
      typeof v.pickId !== "string" ||
      typeof v.actionKey !== "string"
    ) {
      return null;
    }
    return {
      kind: "group_advance",
      taskId: v.taskId,
      chatId: v.chatId,
      pickId: v.pickId,
      actionKey: v.actionKey,
      ...(typeof v.label === "string" ? { label: v.label } : {}),
    };
  }
  if (v.kind === "end_chat") {
    if (typeof v.taskId !== "string") return null;
    return { kind: "end_chat", taskId: v.taskId };
  }
  if (v.kind === "end_all") {
    return { kind: "end_all" };
  }
  if (v.kind === "cmd") {
    if (v.command !== "new" && v.command !== "clean" && v.command !== "status") {
      return null;
    }
    return { kind: "cmd", command: v.command };
  }
  return null;
};

// ----------------- 卡片 PATCH（CardKit batch_update） -----------------

/**
 * sequence 走按卡共享分配器（card-seq）——与 card-stream 流式更新共用同一
 * 严格递增序列，答完题后同卡继续流式不会撞 300317。
 */
const nextOutOfBandSeq = (cardId: string): number => nextCardSequence(cardId);

const warnLark = (op: string, err: unknown): void => {
  console.warn(
    `${LOG} ${op} 失败（静默）:`,
    err instanceof Error ? err.message : err,
  );
};

/** 解析 messageId → cardId（card-map）；失败返回 null */
const resolveCardId = async (
  messageId: string,
  fallbackTaskId?: string,
): Promise<string | null> => {
  if (!messageId) return null;
  try {
    const entry = await findTaskByMessageId(messageId);
    if (entry?.cardId) {
      // 可选：taskId 不一致时仍用 cardId（按钮点在这张卡上）
      if (fallbackTaskId && entry.taskId !== fallbackTaskId) {
        console.warn(
          `${LOG} card-map taskId 与 value.taskId 不一致 map=${entry.taskId} value=${fallbackTaskId}，仍用本卡`,
        );
      }
      return entry.cardId;
    }
  } catch (err) {
    warnLark("findTaskByMessageId", err);
  }
  return null;
};

/**
 * 无 pending 时只知道被点的那颗按钮——把它换成失效提示。
 *
 * 这组 ask 已经被 {@link settleAskCards} 整体置成终态时**不做**：问题区连同按钮
 * 早被换掉了，再 patch 一个不存在的 element_id 只会白报一次飞书错误。
 */
const patchSingleButtonStale = async (
  cardId: string,
  taskId: string,
  askId: string,
  questionId: string,
  optionId: string,
): Promise<void> => {
  if (isAskCardSettled(taskId, askId)) return;
  const bid = askOptionElementId(askId, questionId, optionId);
  await batchUpdateCard(
    cardId,
    [
      {
        action: "update_element",
        params: {
          element_id: bid,
          element: {
            tag: "markdown",
            element_id: bid,
            content: "⚠️ 该问题已失效或已回答",
          },
        },
      },
    ],
    nextOutOfBandSeq(cardId),
  );
};

/** 重试按钮 → 「🔄 已重试」纯文案（去掉 behaviors，防连点） */
const patchRetryDone = async (cardId: string): Promise<void> => {
  await batchUpdateCard(
    cardId,
    [
      {
        action: "update_element",
        params: {
          element_id: "btn_retry",
          element: {
            tag: "markdown",
            element_id: "btn_retry",
            content: "🔄 已重试",
          },
        },
      },
    ],
    nextOutOfBandSeq(cardId),
  );
};

// ----------------- ask / retry 业务 -----------------

type AskValue = Extract<CardButtonValue, { kind: "ask" }>;
type GroupAskValue = Extract<CardButtonValue, { kind: "group_ask" }>;
type RetryValue = Extract<CardButtonValue, { kind: "retry" }>;
type EndChatValue = Extract<CardButtonValue, { kind: "end_chat" }>;
type CmdValue = Extract<CardButtonValue, { kind: "cmd" }>;

/**
 * 多题语义（对齐 ask-reply）：answers 必须覆盖全部 questionId，一次投递清 pending。
 * 被点选项 → 该题 answer=选项 label；其余题 →「（未回答）」。
 * （飞书每点一题一按钮，无法在一张卡上凑齐多题选项后再交——与 app 弹窗「一次答完」不同，
 * 取「先到先得整组提交」+ 未点题占位，避免卡死 pending。）
 */
const buildAskAnswersAndReplyText = (
  pending: NonNullable<ReturnType<typeof getPendingAsk>>,
  value: AskValue,
): {
  label: string;
  answers: Array<{ questionId: string; answer: string; optionId?: string }>;
  replyText: string;
} | null => {
  const q = pending.questions.find((x) => x.id === value.questionId);
  if (!q) return null;
  const opt = q.options?.find((o) => o.id === value.optionId);
  if (!opt) return null;
  const label = opt.label;

  const answers = pending.questions.map((question) => {
    if (question.id === value.questionId) {
      return {
        questionId: question.id,
        answer: label,
        optionId: value.optionId,
      };
    }
    return { questionId: question.id, answer: "（未回答）" };
  });

  const sections: string[] = ["[ASK_USER_REPLY]"];
  pending.questions.forEach((question, idx) => {
    const a = answers.find((x) => x.questionId === question.id);
    const ansText = a?.answer?.trim() ? a.answer : "（未回答）";
    sections.push("", `Q${idx + 1}: ${question.question}`, `答：${ansText}`);
  });

  return { label, answers, replyText: sections.join("\n") };
};

const handleAskAction = async (
  value: AskValue,
  messageId: string,
): Promise<void> => {
  const cardId = await resolveCardId(messageId, value.taskId);
  const pending = getPendingAsk(value.taskId);

  // 失效：无 pending / askId 不匹配 → 卡片置提示 + bot 私聊（先到先得）
  // askId 不匹配时 pending 属于另一组提问，不能拿它的 options 去删按钮
  if (!pending || pending.askId !== value.askId) {
    if (cardId) {
      try {
        await patchSingleButtonStale(
          cardId,
          value.taskId,
          value.askId,
          value.questionId,
          value.optionId,
        );
      } catch (err) {
        warnLark("patchAskStale", err);
      }
    }
    try {
      const bot = await getBotAppInfo();
      await sendTextMessage(
        bot.ownerOpenId,
        "该问题已失效或已回答（可能已在 app / 飞书另一侧提交），无需再答。",
      );
    } catch (err) {
      warnLark("sendTextMessage(stale ask)", err);
    }
    return;
  }

  const built = buildAskAnswersAndReplyText(pending, value);
  if (!built) {
    console.warn(
      `${LOG} 选项不在 pending 内 task=${value.taskId} q=${value.questionId} opt=${value.optionId}`,
    );
    return;
  }

  const task = await getTask(value.taskId);
  if (!task || task.mode !== "chat") {
    console.warn(`${LOG} ask 目标非 chat 或不存在 task=${value.taskId}`);
    return;
  }

  const life = getChatLifecycle(value.taskId);
  if (life !== null) {
    console.warn(`${LOG} ask 投递被 lifecycle 拦住 life=${life}`);
    try {
      const bot = await getBotAppInfo();
      await sendTextMessage(
        bot.ownerOpenId,
        life === "deleting"
          ? "任务正在删除，答案未送达。"
          : life === "finalizing"
            ? "正在终结，请稍后再试。"
            : "正在停止，请稍后再试。",
      );
    } catch (err) {
      warnLark("sendTextMessage(lifecycle)", err);
    }
    return;
  }

  let bootArgs: { apiKey?: string; model?: ModelSelection } | undefined;
  try {
    const boot = await loadBridgeBootContext();
    if (boot) bootArgs = { apiKey: boot.apiKey, model: boot.model };
  } catch (err) {
    warnLark("loadBridgeBootContext", err);
  }

  const ok = await deliverChatAskReply(
    task,
    built.replyText,
    undefined,
    bootArgs,
  );
  if (!ok) {
    if (!hasChatSession(value.taskId)) {
      clearPendingAsk(value.taskId);
    }
    try {
      const bot = await getBotAppInfo();
      await sendTextMessage(
        bot.ownerOpenId,
        "答案未能送达 AI（会话忙或已失效），请稍后重试或在 app 内回答。",
      );
    } catch (err) {
      warnLark("sendTextMessage(deliver fail)", err);
    }
    return;
  }

  clearPendingAsk(value.taskId);
  // 卡片答题成功 → 当前对话指针切到该卡 task（直发后续消息进同一对话）
  void setCurrentChatTaskId(value.taskId);

  // 落 ask_user_reply（meta 对齐 ask-inject：askId / answers / source:"feishu"）
  const reqEvent = [...task.events]
    .reverse()
    .find(
      (ev) =>
        ev.kind === "ask_user_request" &&
        typeof ev.meta?.askId === "string" &&
        ev.meta.askId === pending.askId,
    );
  // 对齐 ask-reply：已送达后 strict 落盘（写+publish 同链）
  try {
    const replyEvent = await writeUserEventAndPublishStrict(value.taskId, {
      kind: "ask_user_reply",
      actionId: reqEvent?.actionId,
      text: built.replyText,
      meta: {
        askId: pending.askId,
        answers: built.answers,
        source: "feishu",
      },
    });
    if (!replyEvent) {
      warnLark(
        "writeUserEventAndPublishStrict(ask_user_reply)",
        new Error(PERSIST_WARNING_DELIVERED),
      );
    }
  } catch (err) {
    warnLark("writeUserEventAndPublishStrict(ask_user_reply)", err);
  }

  // 卡片置已答：被点题「已选择：」（Hermes interaction_result 同款）、其余题「（未回答）」+ 删按钮。
  // 走统一收口点——同一组 ask 可能同时挂在 p2p 流式卡和需求群答题卡上，两张都要置态
  //（header 恢复不了：出卡句柄不可达、updateCardEntity 要全量 card JSON，本路径只改元素区）
  await settleAskCards({
    taskId: value.taskId,
    askId: value.askId,
    questions: pending.questions,
    noteByQuestion: { [value.questionId]: `已选择：${built.label}` },
    fallbackNote: "（未回答）",
    hintNote: ASK_CARD_ANSWERED_HINT,
  });
};

const handleRetryAction = async (
  value: RetryValue,
  messageId: string,
): Promise<void> => {
  const text = value.lastUserMessage?.trim() ?? "";
  if (!text) {
    console.warn(`${LOG} retry 缺少 lastUserMessage task=${value.taskId}`);
    return;
  }

  const cardId = await resolveCardId(messageId, value.taskId);
  // 先置「已重试」防连点（即使后续 inject 失败也避免狂点）
  if (cardId) {
    try {
      await patchRetryDone(cardId);
    } catch (err) {
      warnLark("patchRetryDone", err);
    }
  }

  let bootArgs: { apiKey?: string; model?: ModelSelection } | undefined;
  try {
    const boot = await loadBridgeBootContext();
    if (boot) bootArgs = { apiKey: boot.apiKey, model: boot.model };
  } catch (err) {
    warnLark("loadBridgeBootContext", err);
  }

  try {
    const resp = await handleChatReplyInject(
      value.taskId,
      { text, bootArgs },
      { userReplyMetaExtra: { source: "feishu", via: "card_retry" } },
    );
    if (!resp.ok) {
      let errText = `HTTP ${resp.status}`;
      try {
        const body = (await resp.json()) as { error?: string };
        if (typeof body.error === "string") errText = body.error;
      } catch {
        /* ignore */
      }
      console.warn(`${LOG} retry inject 失败 task=${value.taskId}: ${errText}`);
      try {
        const bot = await getBotAppInfo();
        await sendTextMessage(
          bot.ownerOpenId,
          `重试失败：${errText}`,
        );
      } catch (err) {
        warnLark("sendTextMessage(retry fail)", err);
      }
    }
  } catch (err) {
    warnLark("handleChatReplyInject(retry)", err);
  }
};

// ----------------- 清理卡「结束」/「全部结束」 -----------------

/**
 * 结束单个对话（飞书侧口径、app 数据不动）：
 * 运行中先停 → 记 endedChatTaskIds（listActiveChatTasks 出局）→ 指针指向它则清。
 * 返回标题（patch 行文案用）；task 已删也照常出局（幂等）。
 */
const endOneChat = async (taskId: string): Promise<string> => {
  let title = taskId;
  try {
    const task = await getTask(taskId);
    if (task) {
      title = task.title || taskId;
      if (task.runStatus === "running") {
        await stopTaskAgent(task);
      }
    }
  } catch (err) {
    // 停失败不阻断出局——用户意图是「别再进这个对话」
    warnLark("endOneChat stop", err);
  }
  try {
    await addEndedChatTaskId(taskId);
  } catch (err) {
    warnLark("addEndedChatTaskId", err);
  }
  try {
    if ((await getCurrentChatTaskId()) === taskId) {
      await setCurrentChatTaskId("");
    }
  } catch (err) {
    warnLark("clearPointer(endOneChat)", err);
  }
  return title;
};

/** 「结束」按钮：出局 + 该行 patch 成「已结束：xxx」（删按钮、行文案替换） */
const handleEndChatAction = async (
  value: EndChatValue,
  messageId: string,
): Promise<void> => {
  const title = await endOneChat(value.taskId);
  // 清理卡出卡时以 taskId 空串记了 card-map——按 messageId 反查 cardId
  const cardId = await resolveCardId(messageId);
  if (!cardId) return;
  const rowId = endChatRowElementId(value.taskId);
  try {
    await batchUpdateCard(
      cardId,
      [
        {
          action: "delete_elements",
          params: { element_ids: [endChatButtonElementId(value.taskId)] },
        },
        {
          action: "update_element",
          params: {
            element_id: rowId,
            element: {
              tag: "markdown",
              element_id: rowId,
              content: `已结束：${title}`,
            },
          },
        },
      ],
      nextOutOfBandSeq(cardId),
    );
  } catch (err) {
    warnLark("patchEndChat", err);
  }
};

/** 「全部结束」：点击时重算活跃集合逐个出局，整卡换成「已全部结束（N 个）」 */
const handleEndAllAction = async (messageId: string): Promise<void> => {
  // 不吃卡片快照：出卡后可能又有新对话活跃，以点击时口径为准
  const active = await listActiveChatTasks();
  for (const t of active) {
    await endOneChat(t.id);
  }
  const cardId = await resolveCardId(messageId);
  if (!cardId) return;
  try {
    await updateCardEntity(
      cardId,
      buildCleanupCardEndedAllJson(active.length),
      nextOutOfBandSeq(cardId),
    );
  } catch (err) {
    warnLark("patchEndAll", err);
  }
};

// ----------------- 需求群答题（跨角色、非 owner 也放行） -----------------

/**
 * 群答题卡按钮回调。
 *
 * 与 p2p handleAskAction 的三点差异：
 * 1. 不过 owner 闸——群里任何人都能替本机任务答题（跨角色协作的核心）；
 * 2. 走 injectPendingAskText（chat / task 两种模式通吃）而不是只认 chat 的 deliverChatAskReply；
 * 3. 答案带答题人姓名（事件流看得出谁答的）；先到先得，后到的在群里回「已被 XX 回答」。
 *
 * 答完同样登记回群（第五轮双审 P2-1）：在群里**打字**作答会把 agent 这轮的答复 @ 回群，
 * **点按钮**却全程不登记——同一件事两种入口两种结果，点完按钮的人就此没了下文。
 */
const handleGroupAskAction = async (
  value: GroupAskValue,
  operatorOpenId: string,
  messageId: string,
): Promise<void> => {
  // 动态 import：ask-inject 静态引 task-runner，本模块挂在 bootstrap 启动链上——
  // 静态连边会把这条重依赖拖进 p2p 卡片回调的模块图（并炸「只 mock 局部导出」的
  // 既有单测）。群答题是低频路径，按需加载即可。
  const { injectPendingAskText } = await import("./ask-inject");
  // 卡片回调事件只给 open_id、没有姓名（换姓名要通讯录权限、公司不给审批）——
  // 群里点按钮答题一律记泛称；打字作答那条链有 sender_name、记的是真名。
  const answeredBy = GROUP_MEMBER_FALLBACK_NAME;
  const cardId = await resolveCardId(messageId);
  const pending = getPendingAsk(value.taskId);

  // 先到先得：app / p2p / 群里另一个人已经答过 → 这次点击作废
  if (!pending || pending.askId !== value.askId) {
    if (cardId) {
      try {
        await patchSingleButtonStale(
          cardId,
          value.taskId,
          value.askId,
          value.questionId,
          value.optionId,
        );
      } catch (err) {
        warnLark("patchGroupAskStale", err);
      }
    }
    try {
      await sendTextMessageToChat(
        value.chatId,
        `${mentionTag(operatorOpenId, answeredBy)} 这个问题已经有人回答了`,
      );
    } catch (err) {
      warnLark("sendTextMessageToChat(stale group ask)", err);
    }
    return;
  }

  const q = pending.questions.find((x) => x.id === value.questionId);
  const opt = q?.options?.find((o) => o.id === value.optionId);
  if (!q || !opt) {
    console.warn(
      `${LOG} 群答题选项不在 pending 内 task=${value.taskId} q=${value.questionId} opt=${value.optionId}`,
    );
    return;
  }

  let bootArgs: { apiKey?: string; model?: ModelSelection } | undefined;
  try {
    const boot = await loadBridgeBootContext();
    if (boot) bootArgs = { apiKey: boot.apiKey, model: boot.model };
  } catch (err) {
    warnLark("loadBridgeBootContext(group ask)", err);
  }

  // 登记必须抢在注入之前：deliverAskReply 一返回 agent 就在跑、先到的 delta / done
  // 会错过窗口。答案送进的是属主活会话 → owner 通道；那格被在飞的推进登记占着时
  // rememberGroupReply 自己让位返 null（这轮结果由推进的产物卡承载）
  const replyHandle = rememberGroupReply(value.taskId, {
    chatId: value.chatId,
    requesterOpenId: operatorOpenId,
    requesterName: answeredBy,
    kind: "question",
    channel: "owner",
  });
  const result = await injectPendingAskText(
    value.taskId,
    opt.label,
    bootArgs,
    undefined,
    { answeredBy },
  );
  if (!result.ok) {
    // 没送进去就别挂着登记——否则下一轮无关的 done 会把结果误发进群
    restoreGroupReply(value.taskId, replyHandle);
    try {
      await sendTextMessageToChat(
        value.chatId,
        `${mentionTag(operatorOpenId, answeredBy)} 答案没送达：${result.error}`,
      );
    } catch (err) {
      warnLark("sendTextMessageToChat(group ask fail)", err);
    }
    return;
  }

  // 卡片置已答不在这里做：`injectPendingAskText` 送达成功后统一置态（群卡 + p2p 卡一起），
  // 群里**打字**作答走的也是它——同一件事只留一个收口点，两个入口结果一致
};

// ----------------- 控制面板快捷按钮 -----------------

/** 面板按钮 → 等价命令流程（commands 导出的共用执行体） */
const handleCmdAction = async (value: CmdValue): Promise<void> => {
  if (value.command === "new") {
    await execNewChatNoArgs();
    return;
  }
  if (value.command === "clean") {
    await execCleanupCard();
    return;
  }
  await execStatusText();
};

// ----------------- 入口 -----------------

/**
 * 这次群卡片点击是不是发生在卡片自己那个群里（群答题卡 / 群推进选择卡共用）。
 *
 * 群答题卡不过 owner 闸（跨角色作答是它的意义），于是「谁能点」全靠这条：
 * 飞书卡片可以被转发到任意会话，转发后的按钮 value 原样带着 taskId / askId ——
 * 不校来源的话，任何拿到转发卡的人都能替属主把这组问题答掉。
 * 群推进卡虽然还有一道 owner 闸，但它的回执 / 拒绝提示都发往 `value.chatId`
 *（出卡时写死的那个需求群），转发出去点一下就是往无关群里丢消息。
 *
 * 事件没带来源 chat（lark-cli 扁平 schema 偶尔缺字段）时退回 owner 闸：
 * 宁可只让本机应用 owner 点，也不放行一次身份不明的作答。
 */
const isGroupCardClickFromItsChat = async (
  norm: NormalizedCardAction,
  cardChatId: string,
): Promise<boolean> => {
  const from = norm.chatId?.trim() ?? "";
  if (from) {
    if (from === cardChatId) return true;
    console.warn(
      `${LOG} 群卡片点击来源与卡片绑定的群不一致、丢弃 from=${from} card=${cardChatId}`,
    );
    return false;
  }
  let ownerOpenId = "";
  try {
    ownerOpenId = (await getBotAppInfo()).ownerOpenId;
  } catch (err) {
    warnLark("getBotAppInfo(群卡片来源校验)", err);
    return false;
  }
  if (ownerOpenId && norm.operatorOpenId === ownerOpenId) return true;
  console.warn(
    `${LOG} 群卡片点击缺来源 chat、非 owner 一律丢弃 op=${norm.operatorOpenId}`,
  );
  return false;
};

/**
 * inbound 经 router.dispatchCardActionEvent 丢进来的原始 NDJSON。
 * 全程 try/catch，不向外抛（坑 #10）。
 */
export const handleCardActionEvent = async (raw: unknown): Promise<void> => {
  try {
    const norm = normalizeCardActionEvent(raw);
    if (!norm) {
      console.warn(`${LOG} 事件字段不完整、丢弃`);
      return;
    }

    const value = parseCardButtonValue(norm.valueRaw);
    if (!value) {
      console.warn(`${LOG} CardButtonValue 不合法、丢弃`);
      return;
    }

    // 需求群答题卡：跨角色协作的核心——群里任何人都能答，**不过** owner 闸。
    // 但「群里任何人」的边界得校出来：卡片能被转发，转发后点按钮的人跟需求群毫无关系
    // （坑 #12 那道 owner 闸对本分支是关的）。所以要求事件来源 chat 与卡片自己记的
    // chatId 一致；来源拿不到时退回 owner 闸。
    if (value.kind === "group_ask") {
      if (!(await isGroupCardClickFromItsChat(norm, value.chatId))) return;
      await handleGroupAskAction(value, norm.operatorOpenId, norm.messageId);
      return;
    }

    // 需求群推进选择卡：属主闸在 group-route 内做（非属主要回群提示、不是静默丢弃）。
    // 但来源校验得先做——卡片能被转发，转发到别的群里点「推进」会往**卡片自己那个
    // 需求群**回「已开始跑」（value.chatId 是出卡时写死的），同 group_ask 一条口径。
    // 动态 import：group-route 静态挂着 task-runner 一串重依赖——按需加载、
    // 别拖进 p2p 卡片回调的模块图（同 group_ask 走 ask-inject 的处理）。
    if (value.kind === "group_advance") {
      if (!(await isGroupCardClickFromItsChat(norm, value.chatId))) return;
      const { handleGroupAdvancePick } = await import("./group-route");
      await handleGroupAdvancePick(value, norm.operatorOpenId, async () => {
        const boot = await loadBridgeBootContext();
        return boot ? { apiKey: boot.apiKey, model: boot.model } : null;
      });
      return;
    }

    // 坑 #12：其余卡片非本人忽略（卡片可被转发）
    let ownerOpenId = "";
    try {
      ownerOpenId = (await getBotAppInfo()).ownerOpenId;
    } catch (err) {
      warnLark("getBotAppInfo", err);
      return;
    }
    if (norm.operatorOpenId !== ownerOpenId) {
      console.warn(
        `${LOG} operator≠owner、丢弃 op=${norm.operatorOpenId} owner=${ownerOpenId}`,
      );
      return;
    }

    if (value.kind === "ask") {
      await handleAskAction(value, norm.messageId);
      return;
    }
    if (value.kind === "retry") {
      await handleRetryAction(value, norm.messageId);
      return;
    }
    if (value.kind === "end_chat") {
      await handleEndChatAction(value, norm.messageId);
      return;
    }
    if (value.kind === "end_all") {
      await handleEndAllAction(norm.messageId);
      return;
    }
    if (value.kind === "cmd") {
      await handleCmdAction(value);
    }
  } catch (err) {
    console.warn(
      `${LOG} handleCardActionEvent 未捕获异常（已吞）:`,
      err instanceof Error ? err.message : err,
    );
  }
};

/**
 * 幂等注册到 router.registerCardActionHandler。
 * 接线到 instrumentation 由主线做——本函数只 export 供主线调用。
 */
export const ensureCardActionHandlerRegistered = (): void => {
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  if (g[CARD_ACTION_REG_KEY]) return;
  g[CARD_ACTION_REG_KEY] = true;
  registerCardActionHandler(handleCardActionEvent);
  console.log(`${LOG} 已注册 card.action.trigger handler`);
};

/** 单测清理注册标记（并注销 handler） */
export const __resetCardActionRegistrationForTest = (): void => {
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  g[CARD_ACTION_REG_KEY] = false;
  registerCardActionHandler(null);
};
