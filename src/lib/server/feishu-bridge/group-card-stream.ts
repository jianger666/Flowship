/**
 * 需求群答疑回复的流式卡片（打字机）。
 *
 * 为什么不复用 card-stream.ts：那个是「app chat → 飞书私聊」的整套镜像（思考与工具折叠区 / 引用块 /
 * ask 按钮 / 重试 / 熔断 / card-map 锚定），发送目标写死是私聊 open_id。群里只要「一段文字」——
 * 与 `lark-api.buildMarkdownCardJson` 同一个版式（无 header / 无 footer / 一个 markdown 元素），
 * 只是开 streaming_mode，正文边出边推。
 *
 * 语义（对齐 lk-harness 的群流式：同一条建卡 → 按 chat_id 发出 → 正文逐步写进卡里 → 收尾定稿）：
 * - `push(全文)`：期望全量文本（含 `<at user_id>` 旧写法，推送前统一转卡片写法）。**首次 push 才建卡并发到群**
 *   （空回复 / 判定为静默的回复根本不会在群里留下卡）；之后节流刷新，永远只推最新全文，同一时刻最多一个请求在飞。
 * - `finalize(切好的块)`：第 1 块整卡 PUT 成终稿（streaming_mode 关），其余块另发文本卡；
 *   没建成卡（从未 push / 建卡或发卡失败）就全部块走文本卡——群里照样拿到完整回复。
 *   终稿 PUT 重试几次仍失败：把**全部块**另发成文本卡兜底（宁可多一张半截卡，不能让群里没有答案）。
 * - **没有熔断**（2026-11-06 用户拍板「什么熔断机制都可以去掉」）：中间刷新失败只记日志、之后照常再试
 *   （失败越多重试间隔越长，封顶几秒，免得持续故障时每 300ms 打一发）；收尾不看任何「故障状态」，强试到底。
 *
 * 纯 IO 模块：依赖全部可注入，单测不碰飞书。
 */

import {
  MARKDOWN_CARD_ELEMENT_ID,
  buildMarkdownCardJson,
  createCardEntity,
  sendCardMessageToChat,
  sendMarkdownCardToChat,
  toCardMarkdown,
  updateCardElementContent,
  updateCardEntity,
} from "./lark-api";
import { nextCardSequence } from "./card-seq";
import { truncateForCard } from "./card-stream";

const LOG = "[feishu-bridge/group-card-stream]";

/** 中间刷新节流：每 300ms 最多推一次最新全文 */
const FLUSH_INTERVAL_MS = 300;
/** 中间刷新失败后的重试间隔上限（失败越多越慢，封顶） */
const FLUSH_BACKOFF_MAX_MS = 5_000;
/** 单次卡片写的超时：别让一发黑洞请求占住单飞队列 */
const CARD_OP_TIMEOUT_MS = 8_000;
/** 终稿 PUT 的重试间隔（首发之外再试 2 次） */
const DEFAULT_FINAL_RETRY_DELAYS_MS: readonly number[] = [800, 2_000];

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
  sendMarkdown: (chatId, markdown) => sendMarkdownCardToChat(chatId, markdown),
  nextSeq: nextCardSequence,
});

export interface GroupCardStreamOptions {
  chatId: string;
  deps?: Partial<GroupCardStreamDeps>;
  /** 终稿 PUT 的重试间隔（单测传 [0, 0] 免等） */
  finalRetryDelaysMs?: readonly number[];
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
  /** 推当前期望全文；首次调用才建卡。收尾后的 push 一律忽略 */
  push: (fullText: string) => void;
  /** 收尾；幂等（第二次起直接返回第一次的结果） */
  finalize: (chunks: string[]) => Promise<GroupCardFinalizeResult>;
  /** 卡是否已建成并发出（日志 / 单测用） */
  isStarted: () => boolean;
  getIds: () => { cardId?: string; messageId?: string };
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

const warnErr = (op: string, err: unknown): void => {
  console.warn(`${LOG} ${op} 失败:`, err instanceof Error ? err.message : err);
};

export const createGroupCardStream = (
  opts: GroupCardStreamOptions,
): GroupCardStream => {
  const deps: GroupCardStreamDeps = { ...defaultDeps(), ...opts.deps };
  const retryDelays = opts.finalRetryDelaysMs ?? DEFAULT_FINAL_RETRY_DELAYS_MS;

  /** 期望全文（旧写法）；卡上最近一次成功推送的卡片 markdown */
  let desired = "";
  let flushedMd = "";
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

  const renderMd = (): string => toCardMarkdown(truncateForCard(desired));

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number): void => {
    if (finalized || timer !== null || !cardId) return;
    timer = setTimeout(() => {
      timer = null;
      chain = chain.then(flushOnce).catch(() => undefined);
    }, delayMs);
  };

  /** 链上的一次刷新：推最新全文；之后若又有新内容就再排一次 */
  const flushOnce = async (): Promise<void> => {
    if (finalized || !cardId) return;
    const md = renderMd();
    if (md === flushedMd) return;
    try {
      await deps.putContent(
        cardId,
        MARKDOWN_CARD_ELEMENT_ID,
        md,
        deps.nextSeq(cardId),
        CARD_OP_TIMEOUT_MS,
      );
      flushedMd = md;
      flushFails = 0;
    } catch (err) {
      flushFails += 1;
      warnErr("流式刷新", err);
    }
    if (!finalized && renderMd() !== flushedMd) {
      schedule(
        flushFails === 0
          ? FLUSH_INTERVAL_MS
          : Math.min(FLUSH_INTERVAL_MS * 2 ** flushFails, FLUSH_BACKOFF_MAX_MS),
      );
    }
  };

  const start = async (): Promise<void> => {
    // 卡里的初始内容 = 建卡那一刻的 desired；建卡期间 desired 若又往前走了，下面要补推（flushedMd 必须记「建卡时的」）
    const initialMd = renderMd();
    try {
      const created = await deps.createCard(
        buildMarkdownCardJson(truncateForCard(desired), { streaming: true }),
        CARD_OP_TIMEOUT_MS,
      );
      const sent = await deps.sendCard(opts.chatId, created.card_id);
      cardId = created.card_id;
      messageId = sent.message_id;
      flushedMd = initialMd;
    } catch (err) {
      startFailed = true;
      cardId = undefined;
      warnErr("建卡 / 发卡", err);
      return;
    }
    // 建卡期间 desired 可能又往前走了
    if (!finalized && renderMd() !== flushedMd) schedule(FLUSH_INTERVAL_MS);
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

  const doFinalize = async (
    chunks: string[],
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
    const finalBlocks = blocks.length > 0 ? blocks : [desired];
    const finalCard = buildMarkdownCardJson(truncateForCard(finalBlocks[0]!), {
      streaming: false,
    });
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      if (attempt > 0) await sleep(retryDelays[attempt - 1]!);
      try {
        await deps.putCard(
          cardId,
          finalCard,
          deps.nextSeq(cardId),
          CARD_OP_TIMEOUT_MS,
        );
        const rest = await sendPlain(finalBlocks.slice(1));
        return { delivered: rest.ok, error: rest.error, streamed: true };
      } catch (err) {
        lastErr = err;
        warnErr(`终稿更新（第 ${attempt + 1} 次）`, err);
      }
    }
    // 终稿一直落不下去：全部块另发文本卡兜底（半截卡留在群里，但至少有完整答案）
    const fallback = await sendPlain(finalBlocks);
    return {
      delivered: fallback.ok,
      error: fallback.ok ? undefined : (fallback.error ?? lastErr),
      streamed: true,
    };
  };

  const finalize = (chunks: string[]): Promise<GroupCardFinalizeResult> => {
    if (finalResult) return finalResult;
    finalized = true;
    finalResult = doFinalize(chunks);
    return finalResult;
  };

  return {
    push,
    finalize,
    isStarted: () => cardId !== undefined,
    getIds: () => ({ cardId, messageId }),
  };
};
