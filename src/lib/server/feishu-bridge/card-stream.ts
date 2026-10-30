/**
 * 单轮飞书流式卡片状态机（方案 4.1 / 4.2）
 *
 * start → pushProcess / pushAnswer / setHeaderStatus → appendAskUser / appendRetryButton → finalize
 * - 节流：250ms 或攒 600 字符先到先 flush
 * - 同卡单调递增 sequence；PUT 全量文本且绝不回改已推前缀（坑 #2）
 * - 接近 10 万字符截断（坑 #13）；lark 失败 console.warn 不抛（坑 #10）
 * - streaming:false（单测 / 内部关打字机）：start 只定稿引用、中间态零 API，
 *   finalize 复用 buildStreamingCardJson 一次性发普通卡（streaming_mode 关）
 */

import { getPendingAsk } from "@/lib/server/chat-pending";

import {
  dropAskCardSettledView,
  getAskCardSettledView,
} from "./ask-settle-state";
import { rememberAskCard, rememberCardMessage } from "./card-map";
import { bumpCardSequence, flushCardSeqToDisk, nextCardSequence } from "./card-seq";
import {
  batchUpdateCard,
  createCardEntity,
  getBotAppInfo,
  patchCardSettings,
  sendCardMessage,
  updateCardElementContent,
  updateCardEntity,
} from "./lark-api";
import { classifyLarkFailure, LarkApiError } from "./types";
import type {
  CardHeaderTemplate,
  CardButtonValue,
  CardStreamAppendAskOpts,
  CardStreamFinalizeOpts,
  CardStreamHandle,
  CardStreamHealth,
  CardStreamOptions,
  CardStreamStartOpts,
  LarkFailureKind,
} from "./types";

/** 节流：时间阈值（Hermes 默认） */
const FLUSH_INTERVAL_MS = 250;
/** 节流：字符阈值 */
const FLUSH_CHAR_THRESHOLD = 600;

/**
 * 熔断：连续失败 N 次后暂停流式更新（R14 P1-1）。
 * 为什么要有：flush 失败既不回滚也不退避，节流器照 250ms 一次地发整卡 PUT（argv 可达数十 KB）——
 * 飞书限流 / 断网 / 黑洞时变成 lark-cli 子进程风暴，还会占死「全进程单飞」的 lark 队列，拖垮别的任务。
 */
const BREAKER_FAIL_THRESHOLD = 3;
/** 熔断退避：首次 2s，每次探测仍失败就翻倍，封顶 30s */
const BREAKER_BACKOFF_BASE_MS = 2_000;
const BREAKER_BACKOFF_MAX_MS = 30_000;
/**
 * 卡片更新类调用的单次超时。lark 调用进程级单飞，默认 30s 对流式更新太长：
 * 一个黑洞请求会让所有任务的飞书写操作陪等 30s。
 */
const CARD_OP_TIMEOUT_MS = 8_000;
/** 终稿（finalize）单次超时：它决定用户能不能看到完整回复，弱网下多给点时间，别轻易判失败 */
const CARD_FINALIZE_TIMEOUT_MS = 15_000;
/**
 * 自驱探测封顶：卡一直没收尾、lark 又一直挂时，别在后台永远每 ≤30s 打一发。
 * 超过这个次数（约 3.5 分钟）就不再自己续约；之后只有新的 push（说明这一轮还活着）或 finalize 才会再试。
 */
const BREAKER_MAX_AUTO_PROBES = 10;
/**
 * 累计跳闸几次才对外通知（onBreakerOpen）：2 = 首次探测仍失败。
 * 1–2 秒的小抖动会 3 连败即跳闸、2s 后的首次探测就恢复了——这种不该给用户一条「已暂停实时推送」
 */
const BREAKER_NOTIFY_MIN_TRIPS = 2;
/** 失败原因存入 / 打日志前的限长：lark-cli 的 execFile 错误 message 动辄几十 KB（含整卡 --data） */
const ERROR_TEXT_MAX = 240;
/**
 * 内容超限（飞书卡片体积上限 / Windows 命令行上限，见 classifyLarkFailure 的 `too_long`）之后，终稿的收紧档位：
 * 正文字符预算，过程区取一半。三档逐档收紧：Windows 命令行里的引号 / 反斜杠转义会把长度放大到 2~3 倍、
 * 飞书卡片上限又按字节算（中文 3 字节 / 字），一次砍到 ≈10k 字不一定够；失败是「被拒绝」而不是写了一半，
 * 逐档收紧重发没有副作用。
 */
const SHRINK_ANSWER_BUDGETS = [10_000, 5_000, 2_500] as const;
/** 序号冲突（300317）一轮失败里最多自愈几次（任一次成功后复位）；仍冲突就按普通失败计入熔断 */
const SEQ_HEALS_PER_EPISODE = 1;
/** 流式模式被飞书关掉（200850 超时自动关 / 300309）后：一张卡最多重新打开几次、两次重开最少间隔 */
const STREAM_REOPEN_MAX = 8;
const STREAM_REOPEN_MIN_GAP_MS = 30_000;
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

/**
 * 这组提问的卡片上**是否渲染选项按钮**——私聊流式卡（buildAskElements）、群答题卡
 * （group-ask-card.buildGroupAskCardJson）与结算（ask-card-settle）共用的**唯一判据**。
 *
 * 为什么抽出来：review P1#5 约定「多题卡不出按钮」（一点即整组提交、未点题会被填「（未回答）」
 * 误推进）。这条规则原先在两个构造器里各写了一遍 `questions.length === 1`，而结算那头不认它、
 * 对多题卡也照样往「按钮 id」上发 delete_elements——飞书对不存在的 element_id 行为不可靠
 *（可能整批 batch_update 报错 → 问题区 / 提示行也没换成终态，卡片停在「等待回答」）。
 * 三处共用同一个函数 + 契约测试对真实构造器产物对账，规则以后只能改一处。
 */
export const askRendersOptionButtons = (
  questions: ReadonlyArray<unknown>,
): boolean => questions.length === 1;

/**
 * 这组提问的卡片上**实际渲染过的**选项按钮 element_id（结算只许删这些）。
 * 多题卡不渲染按钮 → 空数组；单题卡 → 每个选项一颗。
 * 与两个构造器的产物逐个 id 对齐由 tests/ask-card-settle-element-contract.test.ts 钉死。
 */
export const askRenderedOptionElementIds = (
  askId: string,
  questions: ReadonlyArray<{
    id: string;
    options?: ReadonlyArray<{ id: string }>;
  }>,
): string[] => {
  if (!askRendersOptionButtons(questions)) return [];
  return questions.flatMap((q) =>
    (q.options ?? []).map((opt) => askOptionElementId(askId, q.id, opt.id)),
  );
};

/**
 * 私聊流式卡的答题提示行（「直接回复消息作答」）element_id——终态渲染时换成已答说明。
 * 导出给 ask-card-settle：置态 patch 必须按「这张卡真有的那个 id」发（群答题卡的提示行
 * 是 `md_gask_hint`、不是它），见 ask-card-settle.hintElementIdOf。
 */
export const ASK_HINT_ELEMENT_ID = "md_ask_hint";

/** appendedElements 的一条：一次 append 的元素；ask 条目额外带原始题目（终态渲染用） */
type AppendedEntry = {
  ask?: CardStreamAppendAskOpts;
  elements: unknown[];
};

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

/** Hermes `_format_duration`：h/m/s 三段、分档始终带秒（2m0s 而非 2m）；outbound 完成追发也复用 */
export const formatDuration = (ms: number): string => {
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

/** 折叠空白并限长（失败原因进状态 / 日志 / 提示前都要过一遍） */
const clipText = (s: string, max = ERROR_TEXT_MAX): string => {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
};

/**
 * 失败原因的一行摘要。lark-cli 的 execFile 错误 message 是
 * 「Command failed: <整条命令行（含 --data 整卡 JSON）>\n<stderr>」：直接截前 N 字，留下的全是 argv，
 * 真正的原因（stderr）被截没了——所以先剥掉命令行，只留 stderr 里最后一条有内容的行；
 * stderr 也是空的就退回「lark-cli 调用失败（命令标签）」。其它形态的 message 照常折叠空白 + 限长。
 */
const failureSummary = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.startsWith("Command failed:")) return clipText(message);
  const rawStderr =
    err instanceof LarkApiError
      ? (err.raw as { stderr?: unknown } | undefined)?.stderr
      : undefined;
  const stderr =
    typeof rawStderr === "string" && rawStderr.trim()
      ? rawStderr
      : message.split("\n").slice(1).join("\n");
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (lastLine) return clipText(lastLine);
  const api = err instanceof LarkApiError ? err.api : undefined;
  return api ? `lark-cli 调用失败（${api}）` : "lark-cli 调用失败";
};

/**
 * 失败原因瘦身后再存：lark-cli 的 execFile 错误 message 动辄几十 KB（见 failureSummary）；
 * LarkApiError 还挂着 raw（stdout / stderr 全文）。句柄活多久它就占多久，
 * 还会被 outbound 拿去拼提示——只留一行摘要 + 定位用的结构化字段（错误码 / 命令 / log_id / 违规字段）。
 */
const slimError = (err: unknown): unknown => {
  if (err instanceof LarkApiError) {
    return new LarkApiError(failureSummary(err), {
      code: err.code,
      api: err.api,
      logId: err.logId,
      fieldViolations: err.fieldViolations,
      // 权限类失败的引导链接（开通 scope 的页面）：app 内提示要带上它，短字符串、不含正文
      consoleUrl: err.consoleUrl ? clipText(err.consoleUrl, 400) : undefined,
    });
  }
  if (err instanceof Error) return new Error(failureSummary(err));
  return failureSummary(err);
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
  // —— 熔断器（R14 P1-1）——
  /** 连续失败次数；任一次成功清零 */
  let consecutiveFails = 0;
  /**
   * 熔断打开到何时（ms 时间戳），0 = 关。到期即「半开」：放行一次探测——
   * 失败立刻再跳闸（退避翻倍），成功则全部清零。
   */
  let breakerOpenUntil = 0;
  /** 连续跳闸次数（决定退避翻倍；成功清零） */
  let breakerTrips = 0;
  /** 本卡生命周期内是否开过熔断（后来恢复了也算） */
  let breakerEverOpened = false;
  /** onBreakerOpen 是否已调过（每张卡最多一次） */
  let breakerNotified = false;
  /** finalize 的终稿内容是否落到了卡片：undefined = 还没 finalize */
  let finalizeOk: boolean | undefined;
  /** start() 失败（建卡 / 发卡没成）：这一轮飞书里从头到尾没有卡，finalize 必须记成「没同步」 */
  let startFailed = false;
  /** 最近一次 lark 失败（已瘦身：一行摘要 + 错误码 / 命令 / log_id / 违规字段等结构化字段，不带 raw，见 slimError） */
  let lastError: unknown;
  // —— 失败分类驱动的状态（R14 B4-3 · Q12a-06 / 07）——
  /** 致命故障类别：设了就不再半开探测（再试也不会好），只剩 finalize 收尾；任一次写成功（= 恢复的证据）清掉 */
  let fatalKind: LarkFailureKind | undefined;
  /** 致命故障的对外通知是否已发（与普通熔断的 breakerNotified 各一次：「不会好了」是新信息） */
  let fatalNotified = false;
  /** 内容超限后的收紧档位：-1 = 不收紧；见 SHRINK_ANSWER_BUDGETS */
  let shrinkLevel = -1;
  /** 收紧是否真的截掉了内容（预算比实际内容大就没截） */
  let shrinkApplied = false;
  /** 序号冲突自愈次数余量（任一次写成功后复位） */
  let seqHealsLeft = SEQ_HEALS_PER_EPISODE;
  /** 流式重开：已重开次数 / 上次重开时间 / 是否已有一个重开 op 在排 */
  let streamReopens = 0;
  let lastReopenAt = 0;
  let reopenQueued = false;
  /** finalize 已经在执行（致命故障在这时才发现，不再单独通知——outbound 的终态 info 会说） */
  let finalizing = false;
  /** 是否已 start / finalize */
  let started = false;
  let finalized = false;
  /**
   * 本卡承载的 ask 组（appendAskUser 记下）——给 card-map 的 ask 索引用。
   * 非流式路径 append 时还没建卡（finalize 才建），先攒着、建完卡再补记。
   */
  let askIdForCardMap: string | undefined;

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
   * 已通过 batch_update 插入的 ask/retry 元素快照（按追加顺序，ask 条目带原始题目）。
   * 全量 PUT（headerDirty / finalize）必须带上，否则飞书会抹掉按钮（R1-1）；
   * 但 ask 已了结（答完 / 跳过）的条目要渲染成终态、不能把按钮带回来（见 renderAppendedElements）。
   * 非流式模式下 append 只记入此处，finalize 并入整卡。
   */
  let appendedElements: AppendedEntry[] = [];

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
    // 日志也限长：一次失败 30KB 的 message × 风暴期几百次，会把日志刷爆
    console.warn(
      `[feishu-bridge/card-stream] ${label}:`,
      failureSummary(err),
    );
  };

  /** 熔断是否打开（到期即「半开」：此时返回 false，放行一次探测）；致命故障 = 一直打开、永不半开 */
  const isBreakerOpen = (): boolean =>
    fatalKind !== undefined || breakerOpenUntil > Date.now();

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

  /** 链上是否已有一个「等着执行」的 flush（合并用：最多 1 个在跑 + 1 个在排） */
  let flushQueued = false;
  /**
   * 请求一次 flush——合并排队：已有 flush 在排就不再排。
   * 为什么：doFlush 每次读的都是最新 desired 全量，排队中的那个执行时自然带上之后所有 push；
   * 不合并的话，链慢（限流 / 黑洞）时 250ms 一个 op 越排越长，恢复后还得把积压的整卡 PUT 逐个发完。
   * 清零放在 op「开始执行」时：此后新到的 push 还能再排一个，不会漏。
   */
  const requestFlush = (): void => {
    if (flushQueued) return;
    flushQueued = true;
    void enqueueCardOp(async () => {
      flushQueued = false;
      await doFlush();
    });
  };

  /**
   * 熔断期间的探测定时器：到期放行一次 flush（半开）。
   * 不能只靠 push 触发——模型在长工具调用里没有新输出时没人再调 scheduleFlush，
   * 卡片就永远等不到恢复探测。同一时刻只留这一个定时器（先清掉可能已排的 250ms 节流定时器）。
   */
  const armBreakerProbe = (): void => {
    clearFlushTimer();
    const wait = Math.max(FLUSH_INTERVAL_MS, breakerOpenUntil - Date.now());
    flushTimer = scheduleTimer(() => {
      flushTimer = null;
      if (finalized) return;
      requestFlush();
    }, wait);
  };

  const scheduleFlush = (): void => {
    // 非流式：不发中间态；流式且卡未建：等 start 成功后再刷
    if (finalized || !started || !streamingEnabled || !cardId) return;
    // 熔断中：不再按 250ms / 字数起 flush（每一发都会撞墙），只留到期探测定时器
    if (isBreakerOpen()) {
      // 致命故障没有「到期探测」：不排任何定时器，只等 finalize
      if (flushTimer === null && fatalKind === undefined) armBreakerProbe();
      return;
    }
    if (pendingChars >= FLUSH_CHAR_THRESHOLD) {
      clearFlushTimer();
      requestFlush();
      return;
    }
    if (flushTimer !== null) return;
    flushTimer = scheduleTimer(() => {
      flushTimer = null;
      requestFlush();
    }, FLUSH_INTERVAL_MS);
  };

  /**
   * 对外通知「飞书卡片在掉线」（outbound 当场落一条 info）。普通熔断与致命故障各最多一次；
   * 回调自己抛的异常吞掉——观测回调不能拖垮卡片流。普通熔断的入参形状与 B1 完全一致（不带 fatalKind）。
   */
  const notifyBreakerOpen = (retryInMs: number, fatal?: LarkFailureKind): void => {
    if (fatal ? fatalNotified : breakerNotified) return;
    if (fatal) fatalNotified = true;
    else breakerNotified = true;
    try {
      opts.onBreakerOpen?.(
        fatal
          ? { consecutiveFails, retryInMs, error: lastError, fatalKind: fatal }
          : { consecutiveFails, retryInMs, error: lastError },
      );
    } catch {
      // 观测回调不能拖垮卡片流
    }
  };

  /**
   * 致命故障（再试也不会好）：熔断一直开着、不再半开探测，清掉待决的节流 / 探测定时器，只剩 finalize 收尾。
   * `too_long` 同时把终稿收紧到第一档（finalize 的第一发就用缩短的内容，不白撞一次）。
   * finalize 已经在跑时不再单独通知——outbound 的终态 info 会说。
   */
  const goFatal = (kind: LarkFailureKind): void => {
    fatalKind = kind;
    breakerEverOpened = true;
    if (kind === "too_long") shrinkLevel = Math.max(shrinkLevel, 0);
    clearFlushTimer();
    if (!finalizing) notifyBreakerOpen(0, kind);
  };

  /**
   * 飞书把本卡的流式模式关了（200850 超时自动关 / 300309）：此后每一发流式 content PUT 都会败。
   * 官方文档给的恢复办法是把卡片 settings 里的 `streaming_mode` 设回 true——排进互斥链去做，
   * 成功后马上补推落下的内容。有次数（STREAM_REOPEN_MAX）与间隔（STREAM_REOPEN_MIN_GAP_MS）上限，
   * 返回 false = 这次不重开（调用方按普通失败计数；次数用完则转致命）。
   * ⚠️ 这条恢复路径按飞书文档写成，**没有在真机上验证过**。
   */
  const reopenStream = (): boolean => {
    if (!cardId || finalized || finalizing) return false;
    if (reopenQueued) return true;
    if (streamReopens >= STREAM_REOPEN_MAX) return false;
    if (lastReopenAt > 0 && Date.now() - lastReopenAt < STREAM_REOPEN_MIN_GAP_MS) return false;
    reopenQueued = true;
    void enqueueCardOp(async () => {
      reopenQueued = false;
      if (finalized || finalizing || !cardId) return;
      streamReopens += 1;
      lastReopenAt = Date.now();
      try {
        await patchCardSettings(
          cardId,
          { config: { streaming_mode: true, update_multi: true } },
          nextSeq(),
          { timeoutMs: CARD_OP_TIMEOUT_MS },
        );
      } catch (err) {
        // 重开本身失败：计入失败（间隔没到，不会再递归重开），之后走普通熔断
        recordFailure("reopenStream", err);
        return;
      }
      // 流式重新打开了：马上把落下的内容补上（成功会 recordSuccess）
      await doFlush();
    });
    return true;
  };

  /**
   * 记一次 lark 写失败：累计 + 连续计数；连续失败达阈值即跳闸（退避 2s → 4s → … 封顶 30s）。
   * 互斥链保证同一时刻只有一个写在跑，计数不会并发错乱。
   *
   * B4-3：先按 `classifyLarkFailure` 分类，几类「再试也没用 / 可自愈」的失败走各自的策略，其余（限流 / 瞬时 / 未知）
   * 照旧走连续 3 次熔断：
   * - `gone`（卡片没了）/ `auth`（没权限）/ `too_long`（内容超限）→ 致命：停掉中间态（goFatal）；
   * - `seq_conflict`（300317）→ 抬高该卡序号、马上重排一次 flush，不计入连续失败（一轮最多一次，仍冲突就按普通失败）；
   * - `stream_closed`（流式被关）→ 重新打开流式（reopenStream）；次数用完 → 致命。
   * start 失败 / finalize 期间的失败不分类：没有卡可修 / 终稿的就地自愈在 putFinal 里。
   */
  const recordFailure = (label: string, err: unknown): void => {
    warnFail(label, err);
    lastError = slimError(err);
    if (label !== "start" && cardId && !finalized && !finalizing) {
      const kind = classifyLarkFailure(err);
      if (kind === "gone" || kind === "auth" || kind === "too_long") {
        goFatal(kind);
        return;
      }
      if (kind === "seq_conflict" && seqHealsLeft > 0) {
        seqHealsLeft -= 1;
        bumpCardSequence(cardId);
        requestFlush();
        return;
      }
      if (kind === "stream_closed") {
        if (reopenStream()) return;
        if (streamReopens >= STREAM_REOPEN_MAX) {
          goFatal(kind);
          return;
        }
      }
    }
    consecutiveFails += 1;
    if (consecutiveFails < BREAKER_FAIL_THRESHOLD) return;
    breakerTrips += 1;
    const retryInMs = Math.min(
      BREAKER_BACKOFF_BASE_MS * 2 ** (breakerTrips - 1),
      BREAKER_BACKOFF_MAX_MS,
    );
    breakerOpenUntil = Date.now() + retryInMs;
    breakerEverOpened = true;
    // 持续性故障才对外通知：首次探测仍失败 = 第 2 次跳闸（小抖动探测就恢复，不打扰用户）。
    // 通知前就进 finalize 的卡不会有这条——outbound 在终态另写一条 info，信号不丢
    if (breakerTrips >= BREAKER_NOTIFY_MIN_TRIPS) notifyBreakerOpen(retryInMs);
    // 流式进行中：排好到期探测（终稿 / 非流式 / 卡未建不需要）。自驱探测有次数上限（BREAKER_MAX_AUTO_PROBES）：
    // 超过后不再续约，只等新的 push（scheduleFlush 的熔断分支会重新 arm）或 finalize
    if (
      started &&
      !finalized &&
      streamingEnabled &&
      cardId &&
      breakerTrips <= BREAKER_MAX_AUTO_PROBES
    ) {
      armBreakerProbe();
    }
  };

  /** 一次 lark 写成功：连续失败清零、熔断关闭（探测成功 = 恢复）；致命故障 / 序号自愈余量一并复位 */
  const recordSuccess = (): void => {
    consecutiveFails = 0;
    breakerTrips = 0;
    breakerOpenUntil = 0;
    fatalKind = undefined;
    seqHealsLeft = SEQ_HEALS_PER_EPISODE;
  };

  /**
   * finalize 失败的统一记账。终稿内容已经落到卡片（finalizeOk 已为 true）、只是收尾的小事
   * （关 streaming_mode / 本地登记）失败 → 只 warn，不算「没同步」；否则终稿没落成，
   * finalizeOk = false 并计入熔断（outbound 据此给用户明确提示，不再静默）。
   */
  const noteFinalizeFailure = (label: string, err: unknown): void => {
    if (finalizeOk === true) {
      warnFail(label, err);
      return;
    }
    finalizeOk = false;
    recordFailure(label, err);
  };

  /**
   * 从单一状态源（desired）算出「应上屏」的 process/answer。
   * ⚠️ 禁止 rebuild / 全量 PUT 直接读 processFlushed——若 doFlush 的 batch 写出去后
   * flushed 未同步、或节流窗内 finalize 抢跑，全量 PUT 会用旧空串把思考区抹掉（P0 真机）。
   */
  /** 内容超限后的收紧：超过当前档位预算就截头 + 提示（不是超限就原样；shrinkLevel < 0 不收紧） */
  const shrinkTo = (text: string, budget: number): string => {
    if (text.length <= budget) return text;
    shrinkApplied = true;
    return text.slice(0, Math.max(0, budget - TRUNCATE_HINT.length)) + TRUNCATE_HINT;
  };
  const canonicalProcess = (): string => {
    const text = truncateForCard(applyPrefixGuard(processFlushed, processDesired));
    return shrinkLevel < 0 ? text : shrinkTo(text, SHRINK_ANSWER_BUDGETS[shrinkLevel] / 2);
  };
  const canonicalAnswer = (): string => {
    const text = truncateForCard(applyPrefixGuard(answerFlushed, answerDesired));
    return shrinkLevel < 0 ? text : shrinkTo(text, SHRINK_ANSWER_BUDGETS[shrinkLevel]);
  };

  /** 把 desired 同步进 flushed（全量 PUT / finalize 前必调，保证写出去 = 内部态） */
  const syncFlushedFromDesired = (): void => {
    processFlushed = canonicalProcess();
    answerFlushed = canonicalAnswer();
  };

  /**
   * 把 appendedElements 渲染成整包 PUT 要带的元素。
   * ask 条目若已被 ask-card-settle 置过终态（app 答 / 飞书点按钮 / 群里打字 / 跳过），
   * 按终态视图渲染（问题 markdown 带说明、无按钮、提示行换成已答说明）——
   * 否则整包 PUT 会用 append 时的快照把已 settle 的按钮「复活」，用户能再点一次。
   */
  const renderAppendedElements = (): unknown[] | undefined => {
    if (appendedElements.length === 0) return undefined;
    const out: unknown[] = [];
    for (const entry of appendedElements) {
      const view = entry.ask
        ? getAskCardSettledView(taskId, entry.ask.askId)
        : null;
      if (!entry.ask || !view) {
        out.push(...entry.elements);
        continue;
      }
      for (const q of entry.ask.questions) {
        const elementId = askQuestionElementId(entry.ask.askId, q.id);
        const note = view.noteByQuestion?.[q.id] ?? view.fallbackNote;
        out.push({
          tag: "markdown",
          element_id: elementId,
          content: `**${q.question}**\n\n${note}`,
        });
      }
      out.push({
        tag: "markdown",
        element_id: ASK_HINT_ELEMENT_ID,
        content: view.hintNote,
      });
    }
    return out;
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
      extraElements: renderAppendedElements(),
      streamingMode,
    });

  /** 嵌套 panel 内 md_process：batch update_element 全量替换（流式 PUT 对嵌套静默无效） */
  const batchPutProcess = async (
    content: string,
    timeoutMs: number = CARD_OP_TIMEOUT_MS,
  ): Promise<void> => {
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
      { timeoutMs },
    );
  };

  /**
   * 全量 PUT 实体后，再用 batch 回写思考区。
   * 真机：CardKit 全量 PUT 在 streaming_mode 下可能丢 collapsible_panel 嵌套 content，
   * 只靠 JSON 里带 processText 不够；batch 是嵌套区唯一可靠写入通道。
   */
  const putEntityThenReassertProcess = async (
    timeoutMs: number = CARD_OP_TIMEOUT_MS,
  ): Promise<void> => {
    if (!cardId) return;
    syncFlushedFromDesired();
    await updateCardEntity(cardId, rebuildCardJson(true), nextSeq(), {
      timeoutMs,
    });
    if (processFlushed) {
      await batchPutProcess(processFlushed, timeoutMs);
    }
  };

  const doFlush = async (): Promise<void> => {
    if (!cardId || finalized || !streamingEnabled) return;
    // 熔断中：这一发必然撞墙，直接放过（内容留在 desired 里，到期探测 / finalize 整包补发）。
    // finalize / append 在链上先调本函数、再做各自的写——它们自己的写不看熔断（强试一次），所以这里 return 不影响它们
    if (isBreakerOpen()) return;

    const nextProcess = canonicalProcess();
    const nextAnswer = canonicalAnswer();
    const processChanged = nextProcess !== processFlushed;
    const answerChanged = nextAnswer !== answerFlushed;
    const needHeader = headerDirty;

    if (!processChanged && !answerChanged && !needHeader) {
      pendingChars = 0;
      return;
    }

    // 先更新本地「已推」快照（打字机前缀以本地为准）；API 失败时在 catch 里回滚到这里存的旧值
    // ——请求没送达，卡片上并没有这些内容；不回滚的话，恢复后只要没有新增文字就永远不会补发
    const prevProcessFlushed = processFlushed;
    const prevAnswerFlushed = answerFlushed;
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
            { timeoutMs: CARD_OP_TIMEOUT_MS },
          );
        }
        recordSuccess();
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
          { timeoutMs: CARD_OP_TIMEOUT_MS },
        );
      }
      recordSuccess();
    } catch (err) {
      // 回滚「已推」快照（见上）。回滚必须和熔断一起做：没有熔断时，回滚会让每个排队的 flush 都重发整卡
      processFlushed = prevProcessFlushed;
      answerFlushed = prevAnswerFlushed;
      // header 失败时恢复脏标记，便于下次再试
      if (needHeader) headerDirty = true;
      recordFailure("flush", err);
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
    // 仅单题渲染选项按钮；多题只列 markdown + 提示走入向文字 ask-reply。
    // 「渲不渲按钮」与结算「删哪些按钮」共用 askRendersOptionButtons，不许各写一份
    const renderButtons = askRendersOptionButtons(askOpts.questions);
    for (const q of askOpts.questions) {
      elements.push({
        tag: "markdown",
        // element_id ≤20 字符硬约束 → 短哈希（真实 id 走按钮 value 回传）
        element_id: askQuestionElementId(askOpts.askId, q.id),
        content: `**${q.question}**`,
      });
      if (renderButtons && q.options?.length) {
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
      element_id: ASK_HINT_ELEMENT_ID,
      content: renderButtons
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
      // Hermes failed：subtitle 空、summary「处理失败」靠 template=red
      subtitle = "";
      template = "red";
      // R3-2：消费 fin.error——失败原因进 footer（收单行 + 截断），并保留耗时/模型统计。
      // 旧文案固定「已停止」：错误信息全丢、还和用户主动 stop 的灰卡撞文案
      const errLine = (fin.error ?? "").replace(/\s+/g, " ").trim();
      const failLabel = errLine
        ? `处理失败：${errLine.length > 120 ? `${errLine.slice(0, 119)}…` : errLine}`
        : "处理失败";
      footerText = statsFooter ? `${failLabel} · ${statsFooter}` : failLabel;
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
      startFailed = false;
      await rememberCardMessage({
        messageId,
        cardId,
        taskId,
        createdAt: Date.now(),
      });
    } catch (err) {
      // start 失败：标记 started=false，后续 push 空操作；finalize 据 startFailed 记「没同步」
      started = false;
      startFailed = true;
      cardId = undefined;
      messageId = undefined;
      recordFailure("start", err);
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

  /**
   * 把「本卡承载了 task 的哪组 ask」写进 card-map 的 ask 索引。
   * 卡还没建出来时只记在内存、等 finalize 建完卡再补（非流式路径）。
   * 记不上只影响终态置态、不影响答题本身——失败只 warn。
   */
  const rememberAskCardRef = async (askId?: string): Promise<void> => {
    if (askId) askIdForCardMap = askId;
    const pendingAskId = askIdForCardMap;
    if (!pendingAskId || !messageId || !cardId) return;
    try {
      await rememberAskCard({
        messageId,
        cardId,
        routeTaskId: taskId,
        askTaskId: taskId,
        askId: pendingAskId,
      });
    } catch (err) {
      warnFail("rememberAskCard", err);
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
      appendedElements = [...appendedElements, { ask: askOpts, elements }];

      // 给 card-map 补上 ask 索引：这组提问从别处了结（app 答题卡 / 群里作答 /
      // 用户直接发新消息跳过）时，ask-card-settle 靠它反查到本卡做终态 patch。
      // 非流式此刻还没 cardId（finalize 才建卡）——那条路径在 finalize 里补记。
      await rememberAskCardRef(askOpts.askId);

      // 非流式：只记状态，finalize 并入整卡
      if (!streamingEnabled) return;
      if (!cardId) return;
      // 卡没了 / 没权限更新：按钮发不出去（本地快照已记，供 finalize 之外的读取）；别白等超时
      if (fatalKind === "gone" || fatalKind === "auth") return;

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
          { timeoutMs: CARD_OP_TIMEOUT_MS },
        );
        // header / footer 状态全量 PUT + batch 回写思考区（防嵌套 content 被抹）
        headerDirty = false;
        await putEntityThenReassertProcess();
        recordSuccess();
      } catch (err) {
        // batch 成功但 header PUT 失败时仍保留快照，下次 finalize/flush 可补
        headerDirty = true;
        recordFailure("appendAskUser", err);
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
      appendedElements = [...appendedElements, { elements }];

      // 非流式：只记状态，finalize 并入整卡
      if (!streamingEnabled) return;
      if (!cardId) return;
      if (fatalKind === "gone" || fatalKind === "auth") return;

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
          { timeoutMs: CARD_OP_TIMEOUT_MS },
        );
        recordSuccess();
      } catch (err) {
        recordFailure("appendRetryButton", err);
      }
    });
  };

  /**
   * finalize 之后本流不会再整包 PUT（所有写入口都挡 finalized）——它承载的 ask 终态视图用完了，
   * 丢掉防登记表只增不减。占坑标记不动（继续挡重复置态、靠 TTL 过期）。
   */
  const dropSettledViews = (): void => {
    for (const entry of appendedElements) {
      if (entry.ask) dropAskCardSettledView(taskId, entry.ask.askId);
    }
  };

  /**
   * 终稿这一发的就地自愈（失败是「被拒绝」而不是写了一半，重发没有副作用）：
   * ① 序号冲突（300317）→ 抬高该卡序号重发一次；
   * ② 内容超限（`too_long`：卡片体积 / Windows 命令行）→ 终稿收紧一档（正文预算 10k → 5k → 2.5k 字）整包重发。
   * 其它错误 / 档位用完 → 原样抛给调用方记账。`fn` 必须每次都从头重算要发的内容（收紧靠 canonical* 读 shrinkLevel）。
   */
  const putFinal = async <T>(fn: () => Promise<T>): Promise<T> => {
    let healed = false;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const kind = classifyLarkFailure(err);
        if (kind === "seq_conflict" && cardId && !healed) {
          healed = true;
          bumpCardSequence(cardId);
          continue;
        }
        if (kind === "too_long" && shrinkLevel < SHRINK_ANSWER_BUDGETS.length - 1) {
          shrinkLevel += 1;
          console.warn(
            `[feishu-bridge/card-stream] 终稿超出飞书卡片上限，正文收紧到 ${SHRINK_ANSWER_BUDGETS[shrinkLevel]} 字重发：`,
            failureSummary(err),
          );
          continue;
        }
        throw err;
      }
    }
  };

  const finalize = async (
    fin: CardStreamFinalizeOpts,
  ): Promise<void> => {
    clearFlushTimer();
    return enqueueCardOp(async () => {
      finalizing = true;
      if (!started || finalized) {
        // start 就失败了（建卡 / 发卡没成）：这一轮飞书里从头到尾没有卡，不能留 undefined——
        // outbound 据 finalizeOk 判「没同步」，undefined 会被当成「还没结果」而照报「已完成」
        if (!finalized && startFailed) finalizeOk = false;
        finalized = true;
        return;
      }

      applyFinalizeVisual(fin);

      // 卡片已经没了 / 没权限更新：再发只会白等一个超时——不发。终态靠 outbound 的 info + 追发文案
      // （finalizeOk=false、lastError 带着原因）；本地状态收口，与普通失败的收尾一致
      if (fatalKind === "gone" || fatalKind === "auth") {
        finalizeOk = false;
        finalized = true;
        headerDirty = false;
        clearFlushTimer();
        return;
      }

      // —— 非流式：一次性建普通卡（引用+思考+正文+ask/retry+footer）——
      if (!streamingEnabled) {
        try {
          const created = await putFinal(async () => {
            answerDesired = closeUnclosedCodeFence(canonicalAnswer());
            processDesired = closeUnclosedCodeFence(canonicalProcess());
            syncFlushedFromDesired();
            return createCardEntity(rebuildCardJson(false));
          });
          cardId = created.card_id;
          const openId = await resolveOpenId();
          const sent = await sendCardMessage(openId, cardId);
          messageId = sent.message_id;
          // 卡片消息已发出——用户已经能看到完整内容；下面的本地登记失败不算「没同步」
          finalizeOk = true;
          recordSuccess();
          await rememberCardMessage({
            messageId,
            cardId,
            taskId,
            createdAt: Date.now(),
          });
          // 非流式：ask 元素在 append 时还没卡可记、建完卡在这里补上索引
          await rememberAskCardRef();
          // 非流式从未开 streaming_mode，无需 patch 关流；仍刷 seq 盘水位（card-action 可能后续 patch）
          await flushCardSeqToDisk();
        } catch (err) {
          noteFinalizeFailure("finalize(non-streaming)", err);
        } finally {
          finalized = true;
          headerDirty = false;
          clearFlushTimer();
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
        // footer + header 全量 PUT + batch 回写思考区（纯思考轮 P0：防嵌套 content 被抹）。
        // 序号冲突 / 内容超限在 putFinal 里就地自愈（每次重试都从头重算要发的内容）
        await putFinal(async () => {
          // review P2#6：终态才补未闭合围栏（流式期间不补，避免破坏前缀守卫打字机）
          // 先写回 desired，再 sync——保证 finalize 全量 PUT / batch 回写同源
          answerDesired = closeUnclosedCodeFence(canonicalAnswer());
          processDesired = closeUnclosedCodeFence(canonicalProcess());
          syncFlushedFromDesired();
          await putEntityThenReassertProcess(CARD_FINALIZE_TIMEOUT_MS);
        });
        // 终稿内容已落到卡片。熔断中走到这里也是照发的（强试一次）——成功就是恢复的最好证据
        finalizeOk = true;
        recordSuccess();
        // 关 streaming_mode：失败只意味着卡片在飞书侧继续显示「生成中」直到自动结束，内容已完整，不改 finalizeOk
        await patchCardSettings(
          cardId,
          { config: { streaming_mode: false, update_multi: true } },
          nextSeq(),
          { timeoutMs: CARD_FINALIZE_TIMEOUT_MS },
        );
        // R1-3：finalize 后立即刷 seq，避免进程随后退出丢高水位
        await flushCardSeqToDisk();
      } catch (err) {
        noteFinalizeFailure("finalize", err);
      } finally {
        finalized = true;
        headerDirty = false;
        clearFlushTimer();
      }
    }).finally(dropSettledViews);
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
    getHealth: (): CardStreamHealth => ({
      failCount,
      consecutiveFails,
      breakerOpen: isBreakerOpen(),
      breakerEverOpened,
      finalizeOk,
      lastError,
      fatalKind,
      truncated: shrinkApplied ? true : undefined,
    }),
    getIds: () => ({ messageId, cardId }),
  };
};
