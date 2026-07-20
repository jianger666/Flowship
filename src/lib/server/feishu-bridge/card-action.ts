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
import { findTaskByMessageId } from "./card-map";
import { nextCardSequence } from "./card-seq";
import { askOptionElementId, askQuestionElementId } from "./card-stream";
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

/**
 * 从 lark-cli 扁平输出 / 官方嵌套 event 两种形态抽出关键字段。
 * 扁平（consume 实测 schema）：operator_id / action_value / message_id / token
 * 嵌套（开放平台原文）：operator.open_id / event.action.value / event.context.open_message_id
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
  let messageId = "";
  if (typeof o.message_id === "string") messageId = o.message_id;
  else if (typeof o.open_message_id === "string") messageId = o.open_message_id;
  else if (nested) {
    const ctx =
      nested.context && typeof nested.context === "object"
        ? (nested.context as Record<string, unknown>)
        : null;
    if (ctx && typeof ctx.open_message_id === "string") {
      messageId = ctx.open_message_id;
    } else if (typeof nested.message_id === "string") {
      messageId = nested.message_id;
    }
  }

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

  const token =
    (typeof o.token === "string" && o.token) ||
    (nested && typeof nested.token === "string" && nested.token) ||
    undefined;
  const chatId =
    (typeof o.chat_id === "string" && o.chat_id) ||
    (nested && typeof nested.chat_id === "string" && nested.chat_id) ||
    undefined;

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
 * 把某题的选项按钮组换成一句 markdown（delete_elements + update_element 问题区）。
 * element_id 与 card-stream.appendAskUser 严格对偶：短哈希 helper 单一来源
 * （CardKit element_id ≤20 字符硬约束、不能直拼 askId/qid/optId）。
 */
const patchAskQuestionAnswered = async (
  cardId: string,
  askId: string,
  questionId: string,
  optionIds: string[],
  statusMarkdown: string,
): Promise<void> => {
  const btnIds = optionIds.map((oid) =>
    askOptionElementId(askId, questionId, oid),
  );
  const actions: unknown[] = [];
  if (btnIds.length > 0) {
    actions.push({
      action: "delete_elements",
      params: { element_ids: btnIds },
    });
  }
  const qid = askQuestionElementId(askId, questionId);
  // 问题标题 markdown → 附上已选/失效文案（全量替换该 element）
  actions.push({
    action: "update_element",
    params: {
      element_id: qid,
      element: {
        tag: "markdown",
        element_id: qid,
        content: statusMarkdown,
      },
    },
  });
  await batchUpdateCard(cardId, actions, nextOutOfBandSeq(cardId));
};

/** 无 pending 时只知道被点的那颗按钮——把它换成失效提示 */
const patchSingleButtonStale = async (
  cardId: string,
  askId: string,
  questionId: string,
  optionId: string,
): Promise<void> => {
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

  // 卡片置已答：被点题「已选择：」（Hermes interaction_result 同款）、其余题「（未回答）」+ 删按钮
  // header 恢复：出卡句柄不可达，且 updateCardEntity 需全量 card JSON——本路径只改按钮区
  if (cardId) {
    try {
      for (const question of pending.questions) {
        const optIds = question.options?.map((o) => o.id) ?? [];
        const status =
          question.id === value.questionId
            ? `**${question.question}**\n\n已选择：${built.label}`
            : `**${question.question}**\n\n（未回答）`;
        await patchAskQuestionAnswered(
          cardId,
          value.askId,
          question.id,
          optIds.length > 0 ? optIds : [value.optionId],
          status,
        );
      }
    } catch (err) {
      warnLark("patchAskAnswered", err);
    }
  }
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

    // 坑 #12：非本人忽略（卡片可被转发）
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

    const value = parseCardButtonValue(norm.valueRaw);
    if (!value) {
      console.warn(`${LOG} CardButtonValue 不合法、丢弃`);
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
