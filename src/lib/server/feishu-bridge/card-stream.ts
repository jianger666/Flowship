/**
 * 单轮飞书流式卡片状态机（方案 4.1 / 4.2）
 *
 * start → pushProcess / pushAnswer / setHeaderStatus → appendAskUser / appendRetryButton → finalize
 * - 节流：250ms 或攒 600 字符先到先 flush
 * - 同卡单调递增 sequence；PUT 全量文本且绝不回改已推前缀（坑 #2）
 * - 接近 10 万字符截断（坑 #13）；lark 失败 console.warn 不抛（坑 #10）
 * - streaming:false（设置「流式回复」关）：start 只定稿引用、中间态零 API，
 *   finalize 复用 buildStreamingCardJson 一次性发普通卡（streaming_mode 关）
 */

import { getPendingAsk } from "@/lib/server/chat-pending";

import { rememberCardMessage } from "./card-map";
import { flushCardSeqToDisk, nextCardSequence } from "./card-seq";
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

/** djb2 → base36，约 7 字符（element_id ≤20 字符基建、清理卡等静态卡共用） */
export const shortHash = (s: string): string => {
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

/** Hermes `_format_duration`：h/m/s 三段、分档始终带秒（2m0s 而非 2m） */
const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.round(ms / 1000);
  const s = total % 60;
  const minutes = Math.floor(total / 60);
  const m = minutes % 60;
  const h = Math.floor(minutes / 60);
  if (h) return `${h}h${m}m${s}s`;
  if (minutes) return `${m}m${s}s`;
  return `${s}s`;
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

/** 流式 footer：⠋ 生成中（Hermes `_spinner_text`：每 1/8 秒转一帧） */
export const streamingFooterSpinner = (label = "生成中"): string => {
  const frame =
    SPINNER_FRAMES[Math.floor(Date.now() / 125) % SPINNER_FRAMES.length] ?? "⠋";
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
 * 组装飞书卡片 JSON 2.0——分区对齐 app 事件流（先过程后正文）：
 * quote（我们独有）→ 思考与工具折叠面板 → 正文 md_answer → hr → footer(x-small)
 *
 * ⚠️ 打字机约束：仅 md_answer 走流式 content PUT（打字机）；
 * md_process 在 collapsible_panel 内嵌，流式 PUT 对嵌套 element 可能静默不生效
 * （见 doFlush 注释），思考区改走 batch update_element 全量替换。
 * 不做 Hermes 那套「按结构边界拆多块 main_content_N」（会破坏正文前缀守卫）。
 */
export const buildStreamingCardJson = (opts: {
  title: string;
  subtitle: string;
  template: CardHeaderTemplate;
  quoteMd?: string;
  processText?: string;
  answerText?: string;
  footerText?: string;
  /**
   * ask / retry 等已 batch 追加的元素——全量 PUT 时插回 hr 之前，
   * 避免 headerDirty / finalize 的 updateCardEntity 抹掉按钮（R1-1）。
   */
  extraElements?: unknown[];
  /**
   * 是否开 CardKit streaming_mode。默认 true（流式打字机）；
   * 非流式整卡 finalize 传 false，且不带 streaming_config。
   */
  streamingMode?: boolean;
}): Record<string, unknown> => {
  const processText = opts.processText ?? "";
  const toolCount = countToolsInProcess(processText);
  // Hermes 面板标题恒带次数（0 次也显示）
  const panelTitle = `思考与工具 · ${toolCount} 次工具调用`;

  const elements: unknown[] = [];
  if (opts.quoteMd) {
    elements.push({
      tag: "markdown",
      element_id: ELEMENT_QUOTE,
      content: opts.quoteMd,
    });
  }
  // 思考在正文前（与 app 事件流一致；用户 2026-07-19 拍板）
  // Hermes timeline_expanded 默认 false：运行中 / 完成后均折叠，由用户手动展开
  elements.push(
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
    {
      tag: "markdown",
      element_id: ELEMENT_ANSWER,
      content: opts.answerText ?? "",
    },
  );
  // ask/retry 插在分割线前（与 batch_update insert_before hr 位置一致）
  if (opts.extraElements?.length) {
    elements.push(...opts.extraElements);
  }
  elements.push(
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

  const streamingMode = opts.streamingMode !== false;
  const config: Record<string, unknown> = {
    streaming_mode: streamingMode,
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
              : opts.template === "grey"
                ? "已停止"
                : opts.template === "indigo"
                  ? "思考中"
                  : "生成中"),
    },
  };
  if (streamingMode) {
    config.streaming_config = {
      print_frequency_ms: { default: 70 },
      print_step: { default: 1 },
      print_strategy: "fast",
    };
  }

  return {
    schema: "2.0",
    config,
    header,
    body: { elements },
  };
};

export const createCardStream = (
  taskId: string,
  opts: CardStreamOptions,
): CardStreamHandle => {
  // —— 句柄内部状态 ——
  /** 本轮是否流式（create 时定稿，中途改设置不影响） */
  const streamingEnabled = opts.streaming !== false;
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
  // Hermes 全态：正文未开始 = thinking（indigo）、正文开始 = in_progress（blue）
  let template: CardHeaderTemplate = "indigo";
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
  /**
   * 已通过 batch_update 插入的 ask/retry 元素快照。
   * 全量 PUT（headerDirty / finalize）必须带上，否则飞书会抹掉按钮（R1-1）。
   * 非流式模式下 append 只记入此处，finalize 并入整卡。
   */
  let appendedElements: unknown[] = [];

  /** 自 start 后未 flush 的新增字符数（过程+正文合计增量） */
  let pendingChars = 0;
  /** 节流定时器 */
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 卡片写操作互斥链——flush / appendAskUser / appendRetryButton / finalize
   * 全部排进同一链，避免 ask 按钮与 done finalize 交错（R1-1c）。
   */
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

  /** 任意卡片写操作进互斥链（吞错，不打断后续） */
  const enqueueCardOp = (op: () => Promise<void>): Promise<void> => {
    flushing = flushing.then(op).catch(() => undefined);
    return flushing;
  };

  const scheduleFlush = (): void => {
    // 非流式：不发中间态；流式且卡未建：等 start 成功后再刷
    if (finalized || !started || !streamingEnabled || !cardId) return;
    if (pendingChars >= FLUSH_CHAR_THRESHOLD) {
      clearFlushTimer();
      void enqueueCardOp(() => doFlush());
      return;
    }
    if (flushTimer !== null) return;
    flushTimer = scheduleTimer(() => {
      flushTimer = null;
      void enqueueCardOp(() => doFlush());
    }, FLUSH_INTERVAL_MS);
  };

  /**
   * 从单一状态源（desired）算出「应上屏」的 process/answer。
   * ⚠️ 禁止 rebuild / 全量 PUT 直接读 processFlushed——若 doFlush 的 batch 写出去后
   * flushed 未同步、或节流窗内 finalize 抢跑，全量 PUT 会用旧空串把思考区抹掉（P0 真机）。
   */
  const canonicalProcess = (): string =>
    truncateForCard(applyPrefixGuard(processFlushed, processDesired));
  const canonicalAnswer = (): string =>
    truncateForCard(applyPrefixGuard(answerFlushed, answerDesired));

  /** 把 desired 同步进 flushed（全量 PUT / finalize 前必调，保证写出去 = 内部态） */
  const syncFlushedFromDesired = (): void => {
    processFlushed = canonicalProcess();
    answerFlushed = canonicalAnswer();
  };

  const rebuildCardJson = (streamingMode = true): Record<string, unknown> =>
    buildStreamingCardJson({
      title,
      subtitle,
      template,
      quoteMd: quoteMd || undefined,
      // 永远从 desired 渲染（Hermes：单一 render ← 单一状态）
      processText: canonicalProcess(),
      answerText: canonicalAnswer(),
      // 流式中 footer 空 → spinner；等待/完成 / 非流式终态由 footerText 定稿
      footerText:
        footerText || (streamingMode ? streamingFooterSpinner() : ""),
      extraElements: appendedElements.length > 0 ? appendedElements : undefined,
      streamingMode,
    });

  /** 嵌套 panel 内 md_process：batch update_element 全量替换（流式 PUT 对嵌套静默无效） */
  const batchPutProcess = async (content: string): Promise<void> => {
    if (!cardId) return;
    await batchUpdateCard(
      cardId,
      [
        {
          action: "update_element",
          params: {
            element_id: ELEMENT_PROCESS,
            element: {
              tag: "markdown",
              element_id: ELEMENT_PROCESS,
              content,
              text_size: "small",
            },
          },
        },
      ],
      nextSeq(),
    );
  };

  /**
   * 全量 PUT 实体后，再用 batch 回写思考区。
   * 真机：CardKit 全量 PUT 在 streaming_mode 下可能丢 collapsible_panel 嵌套 content，
   * 只靠 JSON 里带 processText 不够；batch 是嵌套区唯一可靠写入通道。
   */
  const putEntityThenReassertProcess = async (): Promise<void> => {
    if (!cardId) return;
    syncFlushedFromDesired();
    await updateCardEntity(cardId, rebuildCardJson(true), nextSeq());
    if (processFlushed) {
      await batchPutProcess(processFlushed);
    }
  };

  const doFlush = async (): Promise<void> => {
    if (!cardId || finalized || !streamingEnabled) return;

    const nextProcess = canonicalProcess();
    const nextAnswer = canonicalAnswer();
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
        // header 不在 batch_update 能力面 → 全量 PUT；随后 batch 回写思考区防抹掉
        headerDirty = false;
        await putEntityThenReassertProcess();
        // 正文若也变了：全量 PUT 已带 canonical answer；再走打字机 PUT 推进前缀
        if (answerChanged) {
          await updateCardElementContent(
            cardId,
            ELEMENT_ANSWER,
            answerFlushed,
            nextSeq(),
          );
        }
        return;
      }
      // 为什么思考区不走流式 PUT：
      // CardKit `PUT .../elements/:id/content` 文档面向「普通文本 / 富文本」打字机；
      // md_process 挂在 collapsible_panel.elements 内，真机实证该 PUT 返回 ok 但面板内容
      // 可仍空白（静默无效）。思考区无需打字机 → 改用 batch_update update_element 全量替换。
      // md_answer 仍走流式 content PUT，打字机绝不能动。
      if (processChanged) {
        await batchPutProcess(processFlushed);
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

  /** 组装 ask_user 元素（流式 batch / 非流式 finalize 共用） */
  const buildAskElements = (
    askOpts: CardStreamAppendAskOpts,
  ): unknown[] => {
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
            // Hermes `_button_type` 无 style 时落 default（非 primary）
            type: "default",
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
    // T7 用户反馈：按钮之外也提示可直接打字答（单题按钮下同样给一行小字）
    elements.push({
      tag: "markdown",
      element_id: "md_ask_hint",
      content: singleQuestion
        ? "<font color='grey'>没有合适选项？直接回复消息作答</font>"
        : "<font color='grey'>请直接回复文字作答</font>",
    });
    return elements;
  };

  /** 按 finalize 入参写终态 header / footer（流式 PUT 与非流式整卡共用） */
  const applyFinalizeVisual = (fin: CardStreamFinalizeOpts): void => {
    const statsParts: string[] = [];
    if (fin.durationMs != null) {
      const d = formatDuration(fin.durationMs);
      if (d) statsParts.push(d);
    }
    if (fin.model) statsParts.push(coloredModelLabel(fin.model));
    const statsFooter = statsParts.join(" · ");

    // R1-4：用户 stop → 灰卡「已停止」（与自然完成 / ask 等待互斥）
    if (fin.outcome === "stopped") {
      subtitle = "已停止";
      template = "grey";
      footerText = statsFooter;
    } else if (fin.ok && getPendingAsk(taskId)) {
      // Hermes waiting：subtitle 空、summary「等待选择」靠 template=orange
      subtitle = "";
      template = "orange";
      footerText = statsFooter;
    } else if (fin.ok) {
      // Hermes completed：subtitle「已完成」、green；footer = 耗时 · 着色模型
      subtitle = "已完成";
      template = "green";
      footerText = statsFooter;
    } else {
      // Hermes failed：subtitle 空、summary「处理失败」、red
      subtitle = "";
      template = "red";
      footerText = "已停止";
    }
  };

  const start = async (startOpts: CardStreamStartOpts = {}): Promise<void> => {
    if (started || finalized) return;
    quoteMd = buildQuoteMarkdown(startOpts.echoText, startOpts.echoImageKeys);
    // 非流式：只定稿引用块，延到 finalize 一次性建普通卡（省中间 API、无打字机抖动）
    if (!streamingEnabled) {
      started = true;
      return;
    }
    // 走 rebuild：footer 带 spinner、分区样式与后续 flush 一致
    const cardJson = rebuildCardJson(true);
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
    // 流式需卡已建；非流式只累积 desired，finalize 再发
    if (!started || finalized) return;
    if (streamingEnabled && !cardId) return;
    const guarded = applyPrefixGuard(processFlushed, fullText);
    if (guarded === processDesired) return;
    const grew = Math.max(0, guarded.length - processDesired.length);
    processDesired = guarded;
    pendingChars += grew;
    scheduleFlush();
  };

  const pushAnswer = (fullText: string): void => {
    if (!started || finalized) return;
    if (streamingEnabled && !cardId) return;
    const guarded = applyPrefixGuard(answerFlushed, fullText);
    if (guarded === answerDesired) return;
    const grew = Math.max(0, guarded.length - answerDesired.length);
    answerDesired = guarded;
    pendingChars += grew;
    // Hermes resolve_display_status：正文一出现 thinking → in_progress（indigo → blue）
    if (template === "indigo" && guarded.trim()) {
      template = "blue";
      headerDirty = true;
    }
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
    // 整段进 flushing 链：先刷余量 → batch 插按钮 → 记快照 → 全量 PUT header
    // （旧实现 batch 在链外，与 finalize 交错不确定——R1-1c）
    return enqueueCardOp(async () => {
      if (!started || finalized) return;
      const elements = buildAskElements(askOpts);
      // Hermes waiting：orange + footer「等待选择」；subtitle 空（交互说明在正文按钮区）
      subtitle = "";
      template = "orange";
      footerText = "等待选择";
      // 记住元素：后续全量 PUT / 非流式 finalize 整卡都带上（R1-1a）
      appendedElements = [...appendedElements, ...elements];

      // 非流式：只记状态，finalize 并入整卡
      if (!streamingEnabled) return;
      if (!cardId) return;

      // 链上先刷过程/正文，避免随后全量 PUT 丢未推文本
      await doFlush();
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
        // header / footer 状态全量 PUT + batch 回写思考区（防嵌套 content 被抹）
        headerDirty = false;
        await putEntityThenReassertProcess();
      } catch (err) {
        warnFail("appendAskUser", err);
        // batch 成功但 header PUT 失败时仍保留快照，下次 finalize/flush 可补
        headerDirty = true;
      }
    });
  };

  const appendRetryButton = async (lastUserMessage: string): Promise<void> => {
    return enqueueCardOp(async () => {
      if (!started || finalized) return;
      const value: CardButtonValue = {
        kind: "retry",
        taskId,
        lastUserMessage,
      };
      const elements: unknown[] = [
        {
          tag: "button",
          element_id: "btn_retry",
          text: { tag: "plain_text", content: "重试" },
          type: "danger",
          size: "medium",
          behaviors: [{ type: "callback", value }],
        },
      ];
      appendedElements = [...appendedElements, ...elements];

      // 非流式：只记状态，finalize 并入整卡
      if (!streamingEnabled) return;
      if (!cardId) return;

      await doFlush();
      try {
        await batchUpdateCard(
          cardId,
          [
            {
              action: "add_elements",
              params: {
                type: "insert_before",
                target_element_id: ELEMENT_DIVIDER,
                elements,
              },
            },
          ],
          nextSeq(),
        );
      } catch (err) {
        warnFail("appendRetryButton", err);
      }
    });
  };

  const finalize = async (
    fin: CardStreamFinalizeOpts,
  ): Promise<void> => {
    clearFlushTimer();
    return enqueueCardOp(async () => {
      if (!started || finalized) {
        finalized = true;
        return;
      }

      applyFinalizeVisual(fin);

      // —— 非流式：一次性建普通卡（引用+思考+正文+ask/retry+footer）——
      if (!streamingEnabled) {
        try {
          answerDesired = closeUnclosedCodeFence(canonicalAnswer());
          processDesired = closeUnclosedCodeFence(canonicalProcess());
          syncFlushedFromDesired();
          const cardJson = rebuildCardJson(false);
          const created = await createCardEntity(cardJson);
          cardId = created.card_id;
          const openId = await resolveOpenId();
          const sent = await sendCardMessage(openId, cardId);
          messageId = sent.message_id;
          await rememberCardMessage({
            messageId,
            cardId,
            taskId,
            createdAt: Date.now(),
          });
          // 非流式从未开 streaming_mode，无需 patch 关流；仍刷 seq 盘水位（card-action 可能后续 patch）
          await flushCardSeqToDisk();
        } catch (err) {
          warnFail("finalize(non-streaming)", err);
        } finally {
          finalized = true;
          headerDirty = false;
        }
        return;
      }

      // —— 流式路径：需卡已建 ——
      if (!cardId) {
        finalized = true;
        return;
      }
      // 链上刷完过程/正文（与在途 flush 互斥，R1-13d）
      await doFlush();

      try {
        // review P2#6：终态才补未闭合围栏（流式期间不补，避免破坏前缀守卫打字机）
        // 先写回 desired，再 sync——保证 finalize 全量 PUT / batch 回写同源
        answerDesired = closeUnclosedCodeFence(canonicalAnswer());
        processDesired = closeUnclosedCodeFence(canonicalProcess());
        syncFlushedFromDesired();
        // footer + header 全量 PUT + batch 回写思考区（纯思考轮 P0：防嵌套 content 被抹）
        await putEntityThenReassertProcess();
        // 关 streaming_mode
        await patchCardSettings(
          cardId,
          { config: { streaming_mode: false, update_multi: true } },
          nextSeq(),
        );
        // R1-3：finalize 后立即刷 seq，避免进程随后退出丢高水位
        await flushCardSeqToDisk();
      } catch (err) {
        warnFail("finalize", err);
      } finally {
        finalized = true;
        headerDirty = false;
      }
    });
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
