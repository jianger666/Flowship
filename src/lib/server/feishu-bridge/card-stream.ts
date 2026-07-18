/**
 * 单轮飞书流式卡片状态机（方案 4.1 / 4.2）
 *
 * start → pushProcess / pushAnswer / setHeaderStatus → appendAskUser / appendRetryButton → finalize
 * - 节流：250ms 或攒 600 字符先到先 flush
 * - 同卡单调递增 sequence；PUT 全量文本且绝不回改已推前缀（坑 #2）
 * - 接近 10 万字符截断（坑 #13）；lark 失败 console.warn 不抛（坑 #10）
 */

import { getDeepLink } from "./bridge-config";
import { rememberCardMessage } from "./card-map";
import { nextCardSequence } from "./card-seq";
import {
  batchUpdateCard,
  createCardEntity,
  getBotAppInfo,
  patchCardSettings,
  sendCardMessage,
  updateCardElementContent,
  updateCardEntity,
} from "./lark-api";
import type {
  CardHeaderTemplate,
  CardButtonValue,
  CardStreamAppendAskOpts,
  CardStreamFinalizeOpts,
  CardStreamHandle,
  CardStreamOptions,
  CardStreamStartOpts,
} from "./types";

/** 节流：时间阈值（Hermes 默认） */
const FLUSH_INTERVAL_MS = 250;
/** 节流：字符阈值 */
const FLUSH_CHAR_THRESHOLD = 600;
/** 单卡 content 上限；留余量给截断提示 */
const CONTENT_SOFT_LIMIT = 95_000;
const TRUNCATE_HINT = "\n\n内容过长，完整回复在 app 内查看";

const ELEMENT_PROCESS = "md_process";
const ELEMENT_ANSWER = "md_answer";
const ELEMENT_FOOTER = "md_footer";
const ELEMENT_QUOTE = "md_quote";

/** 可注入计时器（单测加速） */
type TimerFn = (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
let scheduleTimer: TimerFn = (cb, ms) => setTimeout(cb, ms);
let clearTimer: (id: ReturnType<typeof setTimeout>) => void = (id) =>
  clearTimeout(id);

/** 单测替换 setTimeout / clearTimeout */
export const __setCardStreamTimersForTest = (
  schedule: TimerFn | null,
  clear: ((id: ReturnType<typeof setTimeout>) => void) | null = null,
): void => {
  scheduleTimer = schedule ?? ((cb, ms) => setTimeout(cb, ms));
  clearTimer = clear ?? ((id) => clearTimeout(id));
};

/** 打字机前缀保护：只接受「已推是新文本前缀」的前进；缩短则丢弃本次 */
export const applyPrefixGuard = (lastFlushed: string, next: string): string => {
  if (!lastFlushed) return next;
  if (next.startsWith(lastFlushed)) return next;
  // 新文本是旧文本前缀（模型抖动缩短）→ 保持已推，避免回改
  if (lastFlushed.startsWith(next)) return lastFlushed;
  // 前缀分叉：仍推新文本（全量上屏），但本模块自身不主动制造分叉
  return next;
};

/** 超长截断（坑 #13） */
export const truncateForCard = (text: string): string => {
  if (text.length <= CONTENT_SOFT_LIMIT) return text;
  const budget = CONTENT_SOFT_LIMIT - TRUNCATE_HINT.length;
  return text.slice(0, Math.max(0, budget)) + TRUNCATE_HINT;
};

const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m${s}s` : `${m}m`;
};

const buildQuoteMarkdown = (
  echoText?: string,
  echoImageKeys?: string[],
): string => {
  const lines: string[] = [];
  if (echoText?.trim()) {
    // 引用块：多行前缀 >
    for (const line of echoText.trim().split("\n")) {
      lines.push(`> 💬 你在 app：${line}`);
    }
  }
  if (echoImageKeys?.length) {
    for (const key of echoImageKeys) {
      lines.push(`> ![](${key})`);
    }
  }
  return lines.join("\n");
};

/** 组装方案 4.1 的卡片 JSON 2.0 */
export const buildStreamingCardJson = (opts: {
  title: string;
  subtitle: string;
  template: CardHeaderTemplate;
  quoteMd?: string;
  processText?: string;
  answerText?: string;
  footerText?: string;
}): Record<string, unknown> => {
  const elements: unknown[] = [];
  if (opts.quoteMd) {
    elements.push({
      tag: "markdown",
      element_id: ELEMENT_QUOTE,
      content: opts.quoteMd,
    });
  }
  elements.push(
    {
      tag: "collapsible_panel",
      element_id: "panel_process",
      expanded: false,
      header: {
        title: { tag: "markdown", content: "🧠 思考与工具" },
      },
      elements: [
        {
          tag: "markdown",
          element_id: ELEMENT_PROCESS,
          content: opts.processText ?? "",
        },
      ],
    },
    {
      tag: "markdown",
      element_id: ELEMENT_ANSWER,
      content: opts.answerText ?? "",
    },
    {
      tag: "markdown",
      element_id: ELEMENT_FOOTER,
      content: opts.footerText ?? "",
    },
  );
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      update_multi: true,
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: "fast",
      },
    },
    header: {
      title: { tag: "plain_text", content: opts.title },
      subtitle: { tag: "plain_text", content: opts.subtitle },
      template: opts.template,
    },
    body: { elements },
  };
};

export const createCardStream = (
  taskId: string,
  opts: CardStreamOptions,
): CardStreamHandle => {
  // —— 句柄内部状态 ——
  /** 飞书卡片实体 id */
  let cardId: string | undefined;
  /** 发出的 interactive 消息 id */
  let messageId: string | undefined;
  /** lark 调用失败累计 */
  let failCount = 0;
  /** 是否已 start / finalize */
  let started = false;
  let finalized = false;

  /** 当前标题 / header */
  const title = opts.title;
  let subtitle = "🤔 思考中…";
  let template: CardHeaderTemplate = "blue";
  /** header 脏标记——下次 flush 走全量 PUT */
  let headerDirty = false;

  /** 过程区 / 正文的「期望全量」与「已成功推送」 */
  let processDesired = "";
  let answerDesired = "";
  let processFlushed = "";
  let answerFlushed = "";
  /** 引用块（start 时定稿，不再改） */
  let quoteMd = "";
  /** footer（finalize 填充） */
  let footerText = "";

  /** 自 start 后未 flush 的新增字符数（过程+正文合计增量） */
  let pendingChars = 0;
  /** 节流定时器 */
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** flush 互斥——避免重叠 PUT */
  let flushing: Promise<void> = Promise.resolve();

  // sequence 走按卡共享分配器（card-seq）——card-action 按钮终态与流式共用一张卡，
  // 各自计数会撞序号（飞书 300317 拒绝），统一分配才能交错更新
  const nextSeq = (): number => nextCardSequence(cardId ?? `pending_${taskId}`);

  const warnFail = (label: string, err: unknown): void => {
    failCount += 1;
    console.warn(
      `[feishu-bridge/card-stream] ${label}:`,
      err instanceof Error ? err.message : err,
    );
  };

  const clearFlushTimer = (): void => {
    if (flushTimer !== null) {
      clearTimer(flushTimer);
      flushTimer = null;
    }
  };

  const scheduleFlush = (): void => {
    if (finalized || !started || !cardId) return;
    if (pendingChars >= FLUSH_CHAR_THRESHOLD) {
      clearFlushTimer();
      void enqueueFlush();
      return;
    }
    if (flushTimer !== null) return;
    flushTimer = scheduleTimer(() => {
      flushTimer = null;
      void enqueueFlush();
    }, FLUSH_INTERVAL_MS);
  };

  const enqueueFlush = (): Promise<void> => {
    flushing = flushing.then(() => doFlush()).catch(() => undefined);
    return flushing;
  };

  const rebuildCardJson = (): Record<string, unknown> =>
    buildStreamingCardJson({
      title,
      subtitle,
      template,
      quoteMd: quoteMd || undefined,
      processText: processFlushed,
      answerText: answerFlushed,
      footerText,
    });

  const doFlush = async (): Promise<void> => {
    if (!cardId || finalized) return;

    const nextProcess = truncateForCard(
      applyPrefixGuard(processFlushed, processDesired),
    );
    const nextAnswer = truncateForCard(
      applyPrefixGuard(answerFlushed, answerDesired),
    );
    const processChanged = nextProcess !== processFlushed;
    const answerChanged = nextAnswer !== answerFlushed;
    const needHeader = headerDirty;

    if (!processChanged && !answerChanged && !needHeader) {
      pendingChars = 0;
      return;
    }

    // 先更新本地「已推」快照（打字机前缀以本地为准）；API 失败只记 fail、不回滚前缀
    // ——失败后下一轮仍会用同一全量重试，符合「全量 PUT」语义
    if (processChanged) processFlushed = nextProcess;
    if (answerChanged) answerFlushed = nextAnswer;
    pendingChars = 0;

    try {
      if (needHeader) {
        // header 不在 batch_update 能力面 → 全量 PUT 卡片实体
        headerDirty = false;
        await updateCardEntity(cardId, rebuildCardJson(), nextSeq());
        // 全量 PUT 已带上 process/answer，无需再 element content
        return;
      }
      if (processChanged) {
        await updateCardElementContent(
          cardId,
          ELEMENT_PROCESS,
          processFlushed,
          nextSeq(),
        );
      }
      if (answerChanged) {
        await updateCardElementContent(
          cardId,
          ELEMENT_ANSWER,
          answerFlushed,
          nextSeq(),
        );
      }
    } catch (err) {
      warnFail("flush", err);
      // header 失败时恢复脏标记，便于下次再试
      if (needHeader) headerDirty = true;
    }
  };

  const resolveOpenId = async (): Promise<string> => {
    if (opts.openId) return opts.openId;
    const info = await getBotAppInfo();
    return info.ownerOpenId;
  };

  const start = async (startOpts: CardStreamStartOpts = {}): Promise<void> => {
    if (started || finalized) return;
    quoteMd = buildQuoteMarkdown(startOpts.echoText, startOpts.echoImageKeys);
    const cardJson = buildStreamingCardJson({
      title,
      subtitle,
      template,
      quoteMd: quoteMd || undefined,
    });
    try {
      const created = await createCardEntity(cardJson);
      cardId = created.card_id;
      const openId = await resolveOpenId();
      const sent = await sendCardMessage(openId, cardId);
      messageId = sent.message_id;
      started = true;
      await rememberCardMessage({
        messageId,
        cardId,
        taskId,
        createdAt: Date.now(),
      });
    } catch (err) {
      warnFail("start", err);
      // start 失败：标记 started=false，后续 push 空操作
      started = false;
      cardId = undefined;
      messageId = undefined;
    }
  };

  const pushProcess = (fullText: string): void => {
    if (!started || finalized || !cardId) return;
    const guarded = applyPrefixGuard(processFlushed, fullText);
    if (guarded === processDesired) return;
    const grew = Math.max(0, guarded.length - processDesired.length);
    processDesired = guarded;
    pendingChars += grew;
    scheduleFlush();
  };

  const pushAnswer = (fullText: string): void => {
    if (!started || finalized || !cardId) return;
    const guarded = applyPrefixGuard(answerFlushed, fullText);
    if (guarded === answerDesired) return;
    const grew = Math.max(0, guarded.length - answerDesired.length);
    answerDesired = guarded;
    pendingChars += grew;
    scheduleFlush();
  };

  const setHeaderStatus = (
    nextSubtitle: string,
    nextTemplate?: CardHeaderTemplate,
  ): void => {
    if (!started || finalized) return;
    let dirty = false;
    if (nextSubtitle !== subtitle) {
      subtitle = nextSubtitle;
      dirty = true;
    }
    if (nextTemplate && nextTemplate !== template) {
      template = nextTemplate;
      dirty = true;
    }
    if (dirty) {
      headerDirty = true;
      scheduleFlush();
    }
  };

  const appendAskUser = async (
    askOpts: CardStreamAppendAskOpts,
  ): Promise<void> => {
    if (!started || finalized || !cardId) return;
    await enqueueFlush();
    const elements: unknown[] = [];
    for (const q of askOpts.questions) {
      elements.push({
        tag: "markdown",
        element_id: `md_ask_${q.id}`,
        content: `**${q.question}**`,
      });
      if (q.options?.length) {
        for (const opt of q.options) {
          const value: CardButtonValue = {
            kind: "ask",
            taskId,
            askId: askOpts.askId,
            questionId: q.id,
            optionId: opt.id,
          };
          elements.push({
            tag: "button",
            element_id: `btn_ask_${q.id}_${opt.id}`,
            text: { tag: "plain_text", content: opt.label },
            type: "primary",
            width: "default",
            // 飞书 JSON 2.0：behaviors 触发回调，value 原样回传
            behaviors: [
              {
                type: "callback",
                value,
              },
            ],
          });
        }
      }
    }
    setHeaderStatus("⏸ 等你回答", "orange");
    headerDirty = false; // 本批 batch 不改 header；单独再刷 header
    try {
      await batchUpdateCard(
        cardId,
        [
          {
            action: "add_elements",
            params: {
              type: "insert_before",
              target_element_id: ELEMENT_FOOTER,
              elements,
            },
          },
        ],
        nextSeq(),
      );
      // header 状态单独全量 PUT
      headerDirty = true;
      await enqueueFlush();
    } catch (err) {
      warnFail("appendAskUser", err);
    }
  };

  const appendRetryButton = async (lastUserMessage: string): Promise<void> => {
    if (!started || !cardId) return;
    await enqueueFlush();
    const value: CardButtonValue = {
      kind: "retry",
      taskId,
      lastUserMessage,
    };
    try {
      await batchUpdateCard(
        cardId,
        [
          {
            action: "add_elements",
            params: {
              type: "insert_before",
              target_element_id: ELEMENT_FOOTER,
              elements: [
                {
                  tag: "button",
                  element_id: "btn_retry",
                  text: { tag: "plain_text", content: "重试" },
                  type: "danger",
                  behaviors: [{ type: "callback", value }],
                },
              ],
            },
          },
        ],
        nextSeq(),
      );
    } catch (err) {
      warnFail("appendRetryButton", err);
    }
  };

  const finalize = async (
    fin: CardStreamFinalizeOpts,
  ): Promise<void> => {
    if (!started || finalized || !cardId) {
      finalized = true;
      clearFlushTimer();
      return;
    }
    clearFlushTimer();
    // 先刷完过程/正文
    await enqueueFlush();

    subtitle = fin.ok ? "✅ 完成" : `❌ ${fin.error?.trim() || "出错"}`;
    template = fin.ok ? "green" : "red";
    const parts: string[] = [];
    if (fin.durationMs != null) {
      const d = formatDuration(fin.durationMs);
      if (d) parts.push(`耗时 ${d}`);
    }
    if (fin.model) parts.push(fin.model);
    parts.push(`[在 app 中打开](${getDeepLink(taskId)})`);
    footerText = parts.join(" · ");

    try {
      // footer + header 一次全量 PUT
      answerFlushed = truncateForCard(
        applyPrefixGuard(answerFlushed, answerDesired),
      );
      processFlushed = truncateForCard(
        applyPrefixGuard(processFlushed, processDesired),
      );
      await updateCardEntity(cardId, rebuildCardJson(), nextSeq());
      // 关 streaming_mode
      await patchCardSettings(
        cardId,
        { config: { streaming_mode: false, update_multi: true } },
        nextSeq(),
      );
    } catch (err) {
      warnFail("finalize", err);
    } finally {
      finalized = true;
      headerDirty = false;
    }

  };

  return {
    start,
    pushProcess,
    pushAnswer,
    setHeaderStatus,
    appendAskUser,
    appendRetryButton,
    finalize,
    getFailCount: () => failCount,
    getIds: () => ({ messageId, cardId }),
  };
};
