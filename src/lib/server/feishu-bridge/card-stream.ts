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
/** Hermes 同款正文 / timeline / footer 之间的分割线 */
const ELEMENT_DIVIDER = "main_divider";

/** Hermes footer 旋转 spinner 帧（流式期间） */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** 模型名 → 飞书 markdown `<font color>`（对齐 Hermes MODEL_COLOR_PREFIXES） */
const MODEL_COLOR_PREFIXES: Array<{ prefixes: string[]; color: string }> = [
  { prefixes: ["gpt-", "o1", "o3"], color: "blue" },
  { prefixes: ["claude-"], color: "orange" },
  { prefixes: ["deepseek-", "deepseek/"], color: "indigo" },
  { prefixes: ["kimi-", "kimi/", "moonshot-"], color: "purple" },
  { prefixes: ["glm-"], color: "green" },
  { prefixes: ["hy3", "tencent/", "hunyuan"], color: "teal" },
];

/**
 * review P2#6 / 方案坑 #3：检测未闭合 ``` 围栏（以行首 ``` 计数，奇数为未闭合）。
 *
 * 取舍：流式期间瞬时半截可接受（再 flush 常会闭合；中途补闭合会破坏打字机前缀条件）。
 * 仅在 finalize 终态全量 PUT 时补闭合，避免卡片残留半截 raw 围栏。
 */
export const closeUnclosedCodeFence = (text: string): string => {
  if (!text) return text;
  const fenceLines = text.match(/^```/gm);
  const count = fenceLines?.length ?? 0;
  if (count % 2 === 1) return `${text}\n\`\`\``;
  return text;
};

// ---------- ask_user 元素 id（与 card-action 共用、必须对偶） ----------
// CardKit element_id 约束（2026-07-19 冒烟实测报错）：字母开头、仅字母数字下划线、
// **不超过 20 字符**——askId/questionId/optionId 直拼必超长，改用短哈希；
// 真实 id 走按钮 value 回传，element_id 只用于卡片布局定位。

/** djb2 → base36，约 7 字符 */
const shortHash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
};

/** 问题 markdown 的 element_id（q + hash ≤ 20 字符） */
export const askQuestionElementId = (
  askId: string,
  questionId: string,
): string => `q${shortHash(`${askId}|${questionId}`)}`;

/** 选项按钮的 element_id（b + hash ≤ 20 字符） */
export const askOptionElementId = (
  askId: string,
  questionId: string,
  optionId: string,
): string => `b${shortHash(`${askId}|${questionId}|${optionId}`)}`;

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

/** Hermes 同款：模型名着色（未知型号转义后原样输出） */
export const coloredModelLabel = (model: string): string => {
  const text = model.trim();
  if (!text) return "";
  const safe = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const lower = text.toLowerCase();
  for (const { prefixes, color } of MODEL_COLOR_PREFIXES) {
    if (prefixes.some((p) => lower.startsWith(p))) {
      return `<font color="${color}">${safe}</font>`;
    }
  }
  return safe;
};

/** 流式 footer：⠋ 生成中（帧随时间转，与 Hermes `_spinner_text` 同款） */
export const streamingFooterSpinner = (label = "生成中"): string => {
  const frame =
    SPINNER_FRAMES[Math.floor(Date.now() * 8) % SPINNER_FRAMES.length] ?? "⠋";
  return `${frame} ${label}`;
};

/**
 * 从过程区 markdown 数工具行（Hermes timeline 工具块以 `> \`name\` ·` 起行）。
 * 用于折叠面板标题「思考与工具 · N 次工具调用」。
 */
const countToolsInProcess = (processText: string): number => {
  const matches = processText.match(/^> `[^`]+` · /gm);
  return matches?.length ?? 0;
};

const buildQuoteMarkdown = (
  echoText?: string,
  echoImageKeys?: string[],
): string => {
  const lines: string[] = [];
  if (echoText?.trim()) {
    // 引用块：多行前缀 >（我们相对 Hermes 多保留的 app 回显）
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

/**
 * 组装飞书卡片 JSON 2.0——分区 / 样式对齐 Hermes `render_card`：
 * quote（我们独有）→ 正文 md_answer → 思考与工具折叠面板 → hr → footer(x-small)
 *
 * ⚠️ 打字机约束：md_process / md_answer 仍是流式全量 PUT 的唯一目标 element，
 * 不做 Hermes 那套「按结构边界拆多块 main_content_N」（会破坏前缀守卫）。
 */
export const buildStreamingCardJson = (opts: {
  title: string;
  subtitle: string;
  template: CardHeaderTemplate;
  quoteMd?: string;
  processText?: string;
  answerText?: string;
  footerText?: string;
}): Record<string, unknown> => {
  const processText = opts.processText ?? "";
  const toolCount = countToolsInProcess(processText);
  const panelTitle =
    toolCount > 0
      ? `思考与工具 · ${toolCount} 次工具调用`
      : "思考与工具";

  const elements: unknown[] = [];
  if (opts.quoteMd) {
    elements.push({
      tag: "markdown",
      element_id: ELEMENT_QUOTE,
      content: opts.quoteMd,
    });
  }
  // 正文在前（Hermes main_content 优先），过程区折叠在后
  elements.push(
    {
      tag: "markdown",
      element_id: ELEMENT_ANSWER,
      content: opts.answerText ?? "",
    },
    {
      tag: "collapsible_panel",
      element_id: "panel_process",
      expanded: false,
      header: {
        // Hermes 用 plain_text + vertical_align，不用 markdown 标题
        title: { tag: "plain_text", content: panelTitle },
        vertical_align: "center",
      },
      border: { color: "grey", corner_radius: "5px" },
      padding: "8px 8px 8px 8px",
      elements: [
        {
          tag: "markdown",
          element_id: ELEMENT_PROCESS,
          content: processText,
          // Hermes reasoning 默认 small；单 element 混排时取 reasoning 档
          text_size: "small",
        },
      ],
    },
    { tag: "hr", element_id: ELEMENT_DIVIDER },
    {
      tag: "markdown",
      element_id: ELEMENT_FOOTER,
      content: opts.footerText ?? "",
      text_size: "x-small",
    },
  );

  // 空 subtitle 省略（Hermes 思考中无 subtitle，只靠 footer spinner）
  const header: Record<string, unknown> = {
    title: { tag: "plain_text", content: opts.title },
    template: opts.template,
  };
  if (opts.subtitle.trim()) {
    header.subtitle = { tag: "plain_text", content: opts.subtitle };
  }

  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      update_multi: true,
      // 通知摘要：有 subtitle 用它，否则按模板给中性文案（对齐 Hermes config.summary）
      summary: {
        content:
          opts.subtitle.trim() ||
          (opts.template === "green"
            ? "已完成"
            : opts.template === "red"
              ? "处理失败"
              : opts.template === "orange"
                ? "等待选择"
                : "生成中"),
      },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: "fast",
      },
    },
    header,
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
  /** 运行中默认空——Hermes 把状态放 footer spinner / 工具 subtitle，不写「思考中」 */
  let subtitle = "";
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
  /**
   * footer 终态文案；空串表示流式中——每次 rebuild 用 spinner「生成中」。
   * ask 等待 / finalize 后写入固定文案，不再转 spinner。
   */
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
      // 流式中 footer 空 → spinner；等待/完成由 footerText 定稿
      footerText: footerText || streamingFooterSpinner(),
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
    // 走 rebuild：footer 带 spinner、分区样式与后续 flush 一致
    const cardJson = rebuildCardJson();
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
    // review P1#5：一点即整组提交、未点题填「（未回答）」会误推进——
    // 仅单题渲染选项按钮；多题只列 markdown + 提示走入向文字 ask-reply
    const singleQuestion = askOpts.questions.length === 1;
    for (const q of askOpts.questions) {
      elements.push({
        tag: "markdown",
        // element_id ≤20 字符硬约束 → 短哈希（真实 id 走按钮 value 回传）
        element_id: askQuestionElementId(askOpts.askId, q.id),
        content: `**${q.question}**`,
      });
      if (singleQuestion && q.options?.length) {
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
            element_id: askOptionElementId(askOpts.askId, q.id, opt.id),
            text: { tag: "plain_text", content: opt.label },
            type: "primary",
            // Hermes interaction 按钮同款 size
            size: "medium",
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
    if (!singleQuestion) {
      elements.push({
        tag: "markdown",
        element_id: "md_ask_hint",
        content: "请直接回复文字作答",
      });
    }
    // Hermes waiting：orange + footer「等待选择」；subtitle 空（交互说明在正文按钮区）
    subtitle = "";
    template = "orange";
    footerText = "等待选择";
    headerDirty = false; // 本批 batch 不改 header；单独再刷 header
    try {
      await batchUpdateCard(
        cardId,
        [
          {
            action: "add_elements",
            params: {
              type: "insert_before",
              // 插在分割线前，按钮落在正文区与 footer 之间（对齐 Hermes interaction 位置）
              target_element_id: ELEMENT_DIVIDER,
              elements,
            },
          },
        ],
        nextSeq(),
      );
      // header / footer 状态单独全量 PUT
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
              target_element_id: ELEMENT_DIVIDER,
              elements: [
                {
                  tag: "button",
                  element_id: "btn_retry",
                  text: { tag: "plain_text", content: "重试" },
                  type: "danger",
                  size: "medium",
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

    const deepLink = `[在 app 中打开](${getDeepLink(taskId)})`;
    if (fin.ok) {
      // Hermes completed：subtitle「已完成」、green；footer = 耗时 · 着色模型 · 深链
      subtitle = "已完成";
      template = "green";
      const parts: string[] = [];
      if (fin.durationMs != null) {
        const d = formatDuration(fin.durationMs);
        if (d) parts.push(d);
      }
      if (fin.model) parts.push(coloredModelLabel(fin.model));
      parts.push(deepLink);
      footerText = parts.join(" · ");
    } else {
      // Hermes failed：保留运行中工具 subtitle（不覆盖）、red；footer「已停止」
      template = "red";
      // 无工具预览时用简短失败摘要，避免 header 完全空白
      if (!subtitle.trim()) {
        subtitle = fin.error?.trim()
          ? truncateForCard(fin.error.trim()).slice(0, 120)
          : "处理失败";
      }
      footerText = `已停止 · ${deepLink}`;
    }

    try {
      // footer + header 一次全量 PUT
      // review P2#6：终态才补未闭合围栏（流式期间不补，避免破坏前缀守卫打字机）
      answerFlushed = closeUnclosedCodeFence(
        truncateForCard(applyPrefixGuard(answerFlushed, answerDesired)),
      );
      processFlushed = closeUnclosedCodeFence(
        truncateForCard(applyPrefixGuard(processFlushed, processDesired)),
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
