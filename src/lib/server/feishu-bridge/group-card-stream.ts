/**
 * 需求群答疑回复的流式卡片（打字机）。
 *
 * 版式 = 私聊流式卡（card-stream.ts 的 `buildStreamingCardJson`）：header（标题 + 状态色）→
 * 「思考与工具 · N 次工具调用」折叠面板 → 正文（打字机）→ 分割线 → footer（耗时 · 模型）。
 * 2026-11-09 之前群里是「只有一个 markdown 元素」的极简卡，推的又是「当前段」，
 * 结果卡上永远只有一句话、每调一次工具整句被换掉，看着像卡死（用户截图反馈）；
 * 现在照私聊卡抄：正文只增不换、过程（思考 / 工具）进折叠面板、收尾带耗时。
 * 不复用 card-stream 的 `createCardStream`：它是「app chat → 飞书私聊」的整套镜像
 *（引用块 / ask 按钮 / 重试 / 熔断 / card-map 锚定），发送目标写死私聊 open_id。
 *
 * 语义（对齐 lk-harness 的群流式：同一条建卡 → 按 chat_id 发出 → 正文逐步写进卡里 → 收尾定稿）：
 * - `push(全文)`：期望**累积全文**（含 `<at user_id>` 旧写法，推送前统一转卡片写法）。**首次 push 才建卡并发到群**
 *   （空回复 / 判定为静默的回复根本不会在群里留下卡）；之后节流刷新，永远只推最新全文，同一时刻最多一个请求在飞。
 * - `pushProcess(过程区 markdown)`：思考 / 工具时间线（调用方用 `outbound.renderProcess` 渲染）。
 *   还没建卡时只记下、等首次 `push` 建卡时一并带上（**不会因为过程更新而建卡**——保 NO_REPLY 零消息）；
 *   嵌套在折叠面板里的 `md_process` 必须走 `batch_update` 的 `update_element`（流式 content PUT 对嵌套元素静默无效，
 *   与私聊卡同一条真机结论）。
 * - `finalize(切好的块, 收尾选项)`：整卡 PUT 成终稿（header 变 已完成 / 处理失败、footer 写耗时 · 模型）
 *   → 过程区 batch 回写（整卡 PUT 可能丢嵌套内容）→ PATCH 关 streaming_mode。
 *   给了 `body` = 整份终稿进卡（累积全文），其余块不另发；没给 = 第 1 块进卡、其余块另发文本卡（旧行为）。
 *   没建成卡（从未 push / 建卡或发卡失败）就全部块走文本卡——群里照样拿到完整回复。
 *   终稿 PUT 重试几次仍失败：把**全部块**另发成文本卡兜底（宁可多一张半截卡，不能让群里没有答案）。
 *   内容超限（`too_long`，飞书卡片 30KB）按私聊卡同一套三档收紧后重发。
 * - **没有熔断**（2026-11-06 用户拍板「什么熔断机制都可以去掉」）：中间刷新失败只记日志、之后照常再试
 *   （失败越多重试间隔越长，封顶几秒，免得持续故障时每 300ms 打一发）；收尾不看任何「故障状态」，强试到底。
 *
 * 纯 IO 模块：依赖全部可注入，单测不碰飞书。
 */

import {
  batchUpdateCard,
  createCardEntity,
  patchCardSettings,
  sendCardMessageToChat,
  sendMarkdownCardToChat,
  summarizeForCard,
  toCardMarkdown,
  updateCardElementContent,
  updateCardEntity,
} from "./lark-api";
import { CARD_BASE_CONFIG } from "./card-config";
import { nextCardSequence } from "./card-seq";
import {
  ELEMENT_ANSWER,
  ELEMENT_PROCESS,
  buildStreamingCardJson,
  closeUnclosedCodeFence,
  coloredModelLabel,
  formatDuration,
  streamingFooterSpinner,
  truncateForCard,
} from "./card-stream";
import { classifyLarkFailure } from "./types";

const LOG = "[feishu-bridge/group-card-stream]";

/** 中间刷新节流：每 300ms 最多推一次最新全文 */
const FLUSH_INTERVAL_MS = 300;
/** 中间刷新失败后的重试间隔上限（失败越多越慢，封顶） */
const FLUSH_BACKOFF_MAX_MS = 5_000;
/** 单次卡片写的超时：别让一发黑洞请求占住单飞队列 */
const CARD_OP_TIMEOUT_MS = 8_000;
/** 终稿 PUT 的重试间隔（首发之外再试 2 次） */
const DEFAULT_FINAL_RETRY_DELAYS_MS: readonly number[] = [800, 2_000];
/**
 * 内容超限（`too_long`）之后的收紧档位：正文字符预算，过程区取一半
 *（同私聊卡 SHRINK_ANSWER_BUDGETS：飞书卡片上限按字节算、中文 3 字节 / 字，一次砍到 ≈10k 字不一定够）。
 * 失败是「被拒绝」而不是写了一半，逐档收紧重发没有副作用。
 */
const SHRINK_BUDGETS = [10_000, 5_000, 2_500] as const;
/** 收紧后追加的提示（群里的同事没有 app，别写「在 app 内查看」） */
const SHRINK_HINT = "\n\n（内容较长，后半已省略）";

export interface GroupCardStreamDeps {
  createCard: (cardJson: unknown, timeoutMs?: number) => Promise<{ card_id: string }>;
  sendCard: (chatId: string, cardId: string) => Promise<{ message_id?: string }>;
  putContent: (
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
    timeoutMs?: number,
  ) => Promise<void>;
  putCard: (
    cardId: string,
    cardJson: unknown,
    sequence: number,
    timeoutMs?: number,
  ) => Promise<void>;
  /** 局部批量更新（过程区 `md_process` 的 `update_element`） */
  batchUpdate: (
    cardId: string,
    actions: unknown[],
    sequence: number,
    timeoutMs?: number,
  ) => Promise<void>;
  /** 更新卡片 settings（收尾关 streaming_mode） */
  patchSettings: (
    cardId: string,
    settings: unknown,
    sequence: number,
    timeoutMs?: number,
  ) => Promise<void>;
  /** 兜底 / 多余块：普通文本卡（入参仍是纯文本 + `<at user_id>`） */
  sendMarkdown: (chatId: string, markdown: string) => Promise<unknown>;
  nextSeq: (cardId: string) => number;
}

const defaultDeps = (): GroupCardStreamDeps => ({
  createCard: (json, timeoutMs) => createCardEntity(json, { timeoutMs }),
  sendCard: (chatId, cardId) => sendCardMessageToChat(chatId, cardId),
  putContent: (cardId, elementId, content, sequence, timeoutMs) =>
    updateCardElementContent(cardId, elementId, content, sequence, { timeoutMs }),
  putCard: (cardId, json, sequence, timeoutMs) =>
    updateCardEntity(cardId, json, sequence, { timeoutMs }),
  batchUpdate: (cardId, actions, sequence, timeoutMs) =>
    batchUpdateCard(cardId, actions, sequence, { timeoutMs }),
  patchSettings: (cardId, settings, sequence, timeoutMs) =>
    patchCardSettings(cardId, settings, sequence, { timeoutMs }),
  sendMarkdown: (chatId, markdown) => sendMarkdownCardToChat(chatId, markdown),
  nextSeq: nextCardSequence,
});

export interface GroupCardStreamOptions {
  chatId: string;
  /** 卡片 header 标题（任务标题）；缺省 "Flowship" */
  title?: string;
  deps?: Partial<GroupCardStreamDeps>;
  /** 终稿 PUT 的重试间隔（单测传 [0, 0] 免等） */
  finalRetryDelaysMs?: readonly number[];
}

/** 收尾选项：决定 header 状态色与 footer 内容（缺省 = 正常完成、无统计） */
export interface GroupCardFinalizeOpts {
  /**
   * 整份终稿正文（旧写法，含 `<at user_id>`）。给了 = 整份进卡、`chunks` 只用于没建卡 / 终稿落不下去时的文本卡兜底；
   * 不给 = 第 1 块进卡、其余块另发文本卡（旧行为）。
   */
  body?: string;
  /** ok = 已完成（绿）；failed = 处理失败（红）。缺省 ok */
  outcome?: "ok" | "failed";
  /** 本轮耗时（footer） */
  durationMs?: number;
  /** 模型名（footer，着色） */
  model?: string;
}

export interface GroupCardFinalizeResult {
  /** 群里最终有没有拿到完整回复（含走兜底文本卡的情形） */
  delivered: boolean;
  /** 最后一次失败的错误（delivered=false 时给调用方记「发送失败」） */
  error?: unknown;
  /** 这一轮是否真的走过流式卡（false = 一直没建卡、全部走文本卡） */
  streamed: boolean;
}

export interface GroupCardStream {
  /** 推当前期望累积全文；首次调用才建卡。收尾后的 push 一律忽略 */
  push: (fullText: string) => void;
  /** 推过程区（思考 / 工具时间线）markdown；不会触发建卡。收尾后忽略 */
  pushProcess: (processMd: string) => void;
  /** 收尾；幂等（第二次起直接返回第一次的结果） */
  finalize: (
    chunks: string[],
    opts?: GroupCardFinalizeOpts,
  ) => Promise<GroupCardFinalizeResult>;
  /** 卡是否已建成并发出（日志 / 单测用） */
  isStarted: () => boolean;
  getIds: () => { cardId?: string; messageId?: string };
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

const warnErr = (op: string, err: unknown): void => {
  console.warn(`${LOG} ${op} 失败:`, err instanceof Error ? err.message : err);
};

/** 超过预算就截头 + 提示（预算内原样） */
const shrinkTo = (text: string, budget: number): string =>
  text.length <= budget
    ? text
    : text.slice(0, Math.max(0, budget - SHRINK_HINT.length)) + SHRINK_HINT;

export const createGroupCardStream = (
  opts: GroupCardStreamOptions,
): GroupCardStream => {
  const deps: GroupCardStreamDeps = { ...defaultDeps(), ...opts.deps };
  const retryDelays = opts.finalRetryDelaysMs ?? DEFAULT_FINAL_RETRY_DELAYS_MS;
  const title = opts.title?.trim() || "Flowship";

  /** 期望正文（累积全文、旧写法）/ 期望过程区；flushed* = 卡上最近一次成功推送的内容（已是卡片 markdown） */
  let desired = "";
  let desiredProcess = "";
  let flushedAnswer = "";
  let flushedProcess = "";
  /** header / footer 状态（收尾才变）；流式中 footer 恒为 spinner（见 buildCard），这里只存终态值 */
  let subtitle = "";
  let template: "blue" | "green" | "red" = "blue";
  let footerText = "";
  /** 终态正文要补闭合围栏（流式期间不补，免得破坏打字机前缀条件） */
  let closeFences = false;
  /** 内容超限后的收紧档位；-1 = 不收紧 */
  let shrinkLevel = -1;
  let cardId: string | undefined;
  let messageId: string | undefined;
  let startPromise: Promise<void> | null = null;
  let startFailed = false;
  let finalized = false;
  let finalResult: Promise<GroupCardFinalizeResult> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 连续刷新失败次数（成功清零）——只决定重试间隔，不是熔断 */
  let flushFails = 0;
  /** 卡片写互斥链：刷新 / 终稿全部排在同一条链上，序号严格按发出顺序 */
  let chain: Promise<void> = Promise.resolve();

  const canonicalAnswer = (): string => {
    let text = truncateForCard(desired);
    if (shrinkLevel >= 0) text = shrinkTo(text, SHRINK_BUDGETS[shrinkLevel]);
    if (closeFences) text = closeUnclosedCodeFence(text);
    return toCardMarkdown(text);
  };
  const canonicalProcess = (): string => {
    const text = truncateForCard(desiredProcess);
    return shrinkLevel < 0 ? text : shrinkTo(text, SHRINK_BUDGETS[shrinkLevel] / 2);
  };

  /** 整卡 JSON（建卡 / 终稿 PUT 共用）；永远带 streaming_mode:true（关流式走随后的 PATCH settings，同私聊卡） */
  const buildCard = (): Record<string, unknown> => {
    const card = buildStreamingCardJson({
      title,
      subtitle,
      template,
      processText: canonicalProcess(),
      answerText: canonicalAnswer(),
      // 流式中 footer 放 spinner；终态（finalize 已调）footer 以收尾结果为准——没有统计就是空，
      // 不能因为「空」又补回 spinner（那样完成的卡会永远显示「生成中」）
      footerText: finalized ? footerText : streamingFooterSpinner(),
      streamingMode: true,
    });
    // 终态：会话列表 / 推送预览的摘要用正文开头（比「已完成」有信息量；与旧群文本卡一致）
    if (finalized) {
      const summary = summarizeForCard(desired);
      const config = card.config as Record<string, unknown>;
      if (summary) config.summary = { content: summary };
    }
    return card;
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const dirty = (): boolean =>
    canonicalAnswer() !== flushedAnswer || canonicalProcess() !== flushedProcess;

  const schedule = (delayMs: number): void => {
    if (finalized || timer !== null || !cardId) return;
    timer = setTimeout(() => {
      timer = null;
      chain = chain.then(flushOnce).catch(() => undefined);
    }, delayMs);
  };

  const noteFlushFailure = (op: string, err: unknown): void => {
    flushFails += 1;
    warnErr(op, err);
    // 体积超限：中间帧也往下收一档，不然每次重试都撞同一堵墙
    if (
      classifyLarkFailure(err) === "too_long" &&
      shrinkLevel < SHRINK_BUDGETS.length - 1
    ) {
      shrinkLevel += 1;
    }
  };

  /** 过程区：嵌套在折叠面板里，只能 batch update_element（流式 content PUT 静默无效） */
  const processAction = (content: string): unknown => ({
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
  });

  /** 链上的一次刷新：过程区（有变化才推）→ 正文（打字机）；之后若又有新内容就再排一次 */
  const flushOnce = async (): Promise<void> => {
    if (finalized || !cardId) return;
    let failedThisRound = false;
    const proc = canonicalProcess();
    if (proc !== flushedProcess) {
      try {
        await deps.batchUpdate(
          cardId,
          [processAction(proc)],
          deps.nextSeq(cardId),
          CARD_OP_TIMEOUT_MS,
        );
        flushedProcess = proc;
      } catch (err) {
        failedThisRound = true;
        noteFlushFailure("过程区刷新", err);
      }
    }
    if (finalized) return;
    const md = canonicalAnswer();
    if (md !== flushedAnswer) {
      try {
        await deps.putContent(
          cardId,
          ELEMENT_ANSWER,
          md,
          deps.nextSeq(cardId),
          CARD_OP_TIMEOUT_MS,
        );
        flushedAnswer = md;
      } catch (err) {
        failedThisRound = true;
        noteFlushFailure("流式刷新", err);
      }
    }
    if (!failedThisRound) flushFails = 0;
    if (!finalized && dirty()) {
      schedule(
        flushFails === 0
          ? FLUSH_INTERVAL_MS
          : Math.min(FLUSH_INTERVAL_MS * 2 ** flushFails, FLUSH_BACKOFF_MAX_MS),
      );
    }
  };

  const start = async (): Promise<void> => {
    // 卡里的初始内容 = 建卡那一刻的 desired；建卡期间 desired 若又往前走了，下面要补推（flushed* 必须记「建卡时的」）
    const initialAnswer = canonicalAnswer();
    const initialProcess = canonicalProcess();
    try {
      const created = await deps.createCard(buildCard(), CARD_OP_TIMEOUT_MS);
      const sent = await deps.sendCard(opts.chatId, created.card_id);
      cardId = created.card_id;
      messageId = sent.message_id;
      flushedAnswer = initialAnswer;
      flushedProcess = initialProcess;
    } catch (err) {
      startFailed = true;
      cardId = undefined;
      warnErr("建卡 / 发卡", err);
      return;
    }
    // 建卡期间 desired 可能又往前走了
    if (!finalized && dirty()) schedule(FLUSH_INTERVAL_MS);
  };

  const push = (fullText: string): void => {
    if (finalized || startFailed || !fullText.trim()) return;
    desired = fullText;
    if (!cardId) {
      startPromise ??= start();
      return;
    }
    schedule(FLUSH_INTERVAL_MS);
  };

  const pushProcess = (processMd: string): void => {
    if (finalized || startFailed) return;
    desiredProcess = processMd;
    // 没卡：只记下，首次 push 建卡时带上；不因过程更新建卡（NO_REPLY 的轮次不能在群里留卡）
    if (cardId) schedule(FLUSH_INTERVAL_MS);
  };

  const sendPlain = async (
    chunks: string[],
  ): Promise<{ ok: boolean; error?: unknown }> => {
    for (const chunk of chunks) {
      try {
        await deps.sendMarkdown(opts.chatId, chunk);
      } catch (err) {
        // 多块发送遇到第一个失败就停（后面的没有意义）
        return { ok: false, error: err };
      }
    }
    return { ok: true };
  };

  /** 按收尾选项写终态 header / footer（私聊卡 applyFinalizeVisual 的群版：只有完成 / 失败两种） */
  const applyFinalizeVisual = (fin: GroupCardFinalizeOpts): void => {
    const stats: string[] = [];
    if (fin.durationMs != null) {
      const d = formatDuration(fin.durationMs);
      if (d) stats.push(d);
    }
    if (fin.model) stats.push(coloredModelLabel(fin.model));
    const statsFooter = stats.join(" · ");
    if (fin.outcome === "failed") {
      subtitle = "";
      template = "red";
      footerText = statsFooter ? `处理失败 · ${statsFooter}` : "处理失败";
    } else {
      subtitle = "已完成";
      template = "green";
      footerText = statsFooter;
    }
  };

  const doFinalize = async (
    chunks: string[],
    fin: GroupCardFinalizeOpts,
  ): Promise<GroupCardFinalizeResult> => {
    clearTimer();
    // 建卡还在飞：等它落定，才知道有没有卡
    if (startPromise) await startPromise.catch(() => undefined);
    // 在飞的刷新必须先落定，终稿 PUT 的序号才在它之后
    await chain.catch(() => undefined);

    const blocks = chunks.filter((c) => c.trim());
    if (!cardId) {
      // 从未起卡（短回复一次性发 / 空回复）或建卡失败：全部走文本卡
      const sent = await sendPlain(blocks);
      return { delivered: sent.ok, error: sent.error, streamed: false };
    }
    const wholeBody = fin.body?.trim() ? fin.body : undefined;
    const finalBlocks = blocks.length > 0 ? blocks : [wholeBody ?? desired];
    // 卡里的终稿：整份正文，或第 1 块（旧行为）
    desired = wholeBody ?? finalBlocks[0]!;
    const restBlocks = wholeBody ? [] : finalBlocks.slice(1);
    closeFences = true;
    applyFinalizeVisual(fin);

    let lastErr: unknown;
    let putOk = false;
    let attempt = 0;
    for (;;) {
      try {
        await deps.putCard(
          cardId,
          buildCard(),
          deps.nextSeq(cardId),
          CARD_OP_TIMEOUT_MS,
        );
        putOk = true;
        break;
      } catch (err) {
        lastErr = err;
        warnErr(`终稿更新（第 ${attempt + 1} 次）`, err);
        // 体积超限：收紧一档就地重发（不占重试次数；档位有限，必然收敛）
        if (
          classifyLarkFailure(err) === "too_long" &&
          shrinkLevel < SHRINK_BUDGETS.length - 1
        ) {
          shrinkLevel += 1;
          continue;
        }
        if (attempt >= retryDelays.length) break;
        await sleep(retryDelays[attempt]!);
        attempt += 1;
      }
    }
    if (!putOk) {
      // 终稿一直落不下去：全部块另发文本卡兜底（半截卡留在群里，但至少有完整答案）
      const fallback = await sendPlain(finalBlocks);
      return {
        delivered: fallback.ok,
        error: fallback.ok ? undefined : (fallback.error ?? lastErr),
        streamed: true,
      };
    }
    // 终稿内容已落到卡片。过程区 batch 回写（整卡 PUT 可能丢嵌套 content，batch 是嵌套区唯一可靠通道）：
    // 失败只 warn——正文已完整送达，最坏是过程区不全
    const proc = canonicalProcess();
    if (proc) {
      try {
        await deps.batchUpdate(
          cardId,
          [processAction(proc)],
          deps.nextSeq(cardId),
          CARD_OP_TIMEOUT_MS,
        );
      } catch (err) {
        warnErr("终稿过程区回写", err);
      }
    }
    // 关 streaming_mode：失败只意味着飞书侧继续显示「生成中」直到自动结束，内容已完整
    try {
      await deps.patchSettings(
        cardId,
        { config: { streaming_mode: false, ...CARD_BASE_CONFIG } },
        deps.nextSeq(cardId),
        CARD_OP_TIMEOUT_MS,
      );
    } catch (err) {
      warnErr("关闭流式模式", err);
    }
    const rest = await sendPlain(restBlocks);
    return { delivered: rest.ok, error: rest.error, streamed: true };
  };

  const finalize = (
    chunks: string[],
    finOpts: GroupCardFinalizeOpts = {},
  ): Promise<GroupCardFinalizeResult> => {
    if (finalResult) return finalResult;
    finalized = true;
    finalResult = doFinalize(chunks, finOpts);
    return finalResult;
  };

  return {
    push,
    pushProcess,
    finalize,
    isStarted: () => cardId !== undefined,
    getIds: () => ({ cardId, messageId }),
  };
};
