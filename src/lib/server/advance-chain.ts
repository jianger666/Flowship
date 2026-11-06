/**
 * 自动推进（advance chain）：纯状态 + 纯校验，不碰 IO（IO 在 advance-chain-runner.ts）。
 *
 * # 它是什么
 *
 * 给 AI 一个 `advance_next` 工具：**用户在话里说了「做完直接 xx / 改完再复核 / 没问题就提测」**，
 * AI 在本 action 交卷后登记一条「链」，本轮 run 结束时由 runner 代替用户点一次「推进」。
 * 不是「自动推进开关」——触发依据只有用户的话；AI 没有用户授权时不该、也调不成这个工具（见下面「落地凭据」）。
 *
 * # 三道硬闸（提示词只是软约束，下面这几条是代码兜底）
 *
 * 1. **落地凭据**：入参 `user_words` 必须能在用户**真说过**的话里逐字找到（action 的手动推进指令 + 最近的
 *    user_reply 事件；群里的话 / 定时备忘（AI 给自己留的） / 本机自动推进写的指令一律不算）。AI 编不出授权。
 * 2. **轮数上限**：没有人手动推进的情况下，最多连续自动推进 {@link ADVANCE_CHAIN_MAX_AUTO_STEPS} 步
 *   （防 review → build → review 无限回环）。任何一次人手推进（UI / 飞书群 / 选择卡）都会清零。
 * 3. **一次性 + 快照比对**：一条链只在「登记它的那一轮 run 正常结束」时触发一次；触发前核对
 *    ① 没被停止 / 删除过（opGen 没变）② 当前 action 还是登记时那条且已交卷 ③ 没过期，
 *    推进本身再走 advanceTask 的 `expectedCurrentActionId` CAS——任何一项不成立都只落一条提示、不推进。
 *
 * 不碰 ownership / 并发那套：触发时只是 advanceTask 的一个普通调用方（与 UI 路由、飞书群推进同级）。
 */

import { isScheduleBoilerplateText } from "@/lib/chat-stream-display";
import type { ActionRecord, ActionType, DevPushMode, TaskEvent } from "@/lib/types";

/** 连续自动推进（中间没有人手推进）的步数上限 */
export const ADVANCE_CHAIN_MAX_AUTO_STEPS = 3;

/** 链的有效期：build 这类长 action 可能跑很久，但超过这个时间还没收口就别再替用户做主了 */
export const ADVANCE_CHAIN_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * 自动推进出来的 action，`userInstruction` 以它开头：
 * - 界面上一眼能看出这一步不是人点的；
 * - 落地凭据**跳过**带这个前缀的指令（AI 自己写的话不能给自己的下一次推进当授权）。
 */
export const AUTO_ADVANCE_INSTRUCTION_PREFIX = "[自动推进] ";

/** 给下一个 action 的指令长度上限（字符） */
export const ADVANCE_CHAIN_INSTRUCTION_MAX = 4000;

/** 授权原话长度上限（字符；原话是引用，不是转述长文） */
export const ADVANCE_CHAIN_WORDS_MAX = 300;

/** 授权原话去掉空白 / 标点后的最短长度（挡掉「好」「嗯」这种碰巧到处都能匹配的引用） */
export const ADVANCE_CHAIN_WORDS_MIN_NORMALIZED = 4;

/** 落地凭据最多回看多少条事件（调用方读尾部事件时用同一个数） */
export const ADVANCE_CHAIN_GROUNDING_EVENT_TAIL = 150;

/** 自动推进允许的目标（含 custom；dev / custom 还有额外必填，见 {@link parseAdvanceNextArgs}） */
export const ADVANCE_CHAIN_ACTIONS = [
  "plan",
  "build",
  "review",
  "ship",
  "dev",
  "custom",
] as const satisfies readonly ActionType[];

export interface AdvanceChainTarget {
  actionType: ActionType;
  customActionId?: string;
  devPushMode?: DevPushMode;
  batchIds?: string[];
}

export interface AdvanceChain extends AdvanceChainTarget {
  taskId: string;
  /** 登记时的当前 action（= 要交卷的那条）：触发时它必须还是当前 action 且已交卷 */
  fromActionId: string;
  /** 登记时的 admission token：停止 / 删除 / 终结会让它变化，变了就不再触发 */
  opGen: number;
  /** 已经带 {@link AUTO_ADVANCE_INSTRUCTION_PREFIX} 以外的纯指令正文 */
  instruction: string;
  /** 用户授权原话（已 trim） */
  userWords: string;
  registeredAt: number;
}

// ---------------------------------------------------------------------------
// 入参解析（纯函数）
// ---------------------------------------------------------------------------

export type ParsedAdvanceNextArgs =
  | {
      ok: true;
      target: AdvanceChainTarget;
      instruction: string;
      userWords: string;
    }
  | { ok: false; error: string };

const asTrimmedString = (v: unknown): string =>
  typeof v === "string" ? v.trim() : "";

/**
 * 解析 `advance_next` 的入参。
 *
 * - `action`：plan / build / review / ship / dev / custom；custom 必须带 `custom_action_id`
 * - `dev`（联调）会往远端推代码：必须显式 `dev_push_mode`（direct / mr），**不替用户默认选直推**
 * - `batch_ids` 只对 build 有意义，别的类型传了忽略
 * - `user_words` 必填（是否真是用户说过的话由调用方拿凭据源核对，见 {@link isUserWordsGrounded}）
 */
export const parseAdvanceNextArgs = (
  args: Record<string, unknown>,
): ParsedAdvanceNextArgs => {
  const action = asTrimmedString(args.action);
  if (!(ADVANCE_CHAIN_ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      error: `action 必须是 ${ADVANCE_CHAIN_ACTIONS.join(" / ")} 之一`,
    };
  }
  const actionType = action as ActionType;

  const userWords = asTrimmedString(args.user_words);
  if (!userWords) {
    return {
      ok: false,
      error:
        "缺 user_words：必须逐字引用用户说过的、授权你做完后自动推进的那句话。用户没这么说过就不要调用本工具，正常交卷让用户自己推进",
    };
  }
  if (userWords.length > ADVANCE_CHAIN_WORDS_MAX) {
    return {
      ok: false,
      error: `user_words 太长（${userWords.length} 字、上限 ${ADVANCE_CHAIN_WORDS_MAX}）：只引用授权的那一句，不要整段粘贴`,
    };
  }

  const instruction = asTrimmedString(args.instruction);
  if (instruction.length > ADVANCE_CHAIN_INSTRUCTION_MAX) {
    return {
      ok: false,
      error: `instruction 太长（${instruction.length} 字、上限 ${ADVANCE_CHAIN_INSTRUCTION_MAX}）：写要点，细节让下一个 action 读 artifact`,
    };
  }

  const target: AdvanceChainTarget = { actionType };

  if (actionType === "custom") {
    const id = asTrimmedString(args.custom_action_id);
    if (!id) return { ok: false, error: "action=custom 必须带 custom_action_id" };
    target.customActionId = id;
  }

  if (actionType === "dev") {
    const mode = asTrimmedString(args.dev_push_mode);
    if (mode !== "direct" && mode !== "mr") {
      return {
        ok: false,
        error:
          "action=dev（联调）会往远端推代码：必须显式给 dev_push_mode（direct 直推 / mr 提 PR），用户没说用哪种就先 ask_user 问，不要替他选",
      };
    }
    target.devPushMode = mode;
  }

  if (actionType === "build" && Array.isArray(args.batch_ids)) {
    const ids = (args.batch_ids as unknown[])
      .map(asTrimmedString)
      .filter((x) => x.length > 0);
    if (ids.length > 0) target.batchIds = ids;
  }

  return { ok: true, target, instruction, userWords };
};

// ---------------------------------------------------------------------------
// 落地凭据（纯函数）
// ---------------------------------------------------------------------------

/** 去掉空白和常见中英文标点、转小写：引用时多一个标点 / 换行不该判不匹配 */
export const normalizeForQuoteMatch = (s: string): string =>
  s
    .toLowerCase()
    .replace(
      /[\s\u3000，。、！？；：“”‘’「」『』（）《》【】…—·,.!?;:"'`()[\]{}<>~\-_/\\|*#>]+/g,
      "",
    );

/**
 * 授权原话是否真出自用户说过的话。
 * `sources` 由 {@link collectAuthorizationSources} 给：只含用户本人的话。
 * 判据：规范化后长度够（见 {@link ADVANCE_CHAIN_WORDS_MIN_NORMALIZED}）且是某条来源的**子串**。
 */
export const isUserWordsGrounded = (
  userWords: string,
  sources: readonly string[],
): boolean => {
  const needle = normalizeForQuoteMatch(userWords);
  if (needle.length < ADVANCE_CHAIN_WORDS_MIN_NORMALIZED) return false;
  return sources.some((s) => normalizeForQuoteMatch(s).includes(needle));
};

/**
 * 能算「用户本人说的」的 user_reply 来源——**白名单**：
 * - 无 `meta.source`：Flowship 输入条 / 推进弹窗；
 * - `"feishu"`：飞书私聊（已绑定的属主本人）。
 * 其余一律不算：`feishu_group`（群里的话，连属主在群里说的也不认）、`schedule`（AI 之前用 schedule 给自己留的备忘，
 * 到点以 user_reply 落盘，不是用户说的话——`_super.md` 明写「定时消息不构成用户授权」）、以及以后任何新增的来源。
 * 用白名单而不是「排除已知坏来源」：新增来源默认不能授权，不会因为漏列一个就让 AI 给自己授权（第 25 轮评审 F1）。
 */
const USER_OWN_SOURCES: ReadonlySet<unknown> = new Set([undefined, "feishu"]);

const isUserOwnWordsMeta = (
  ev: Pick<TaskEvent, "meta"> & { text?: string },
): boolean => {
  // 老事件（schedule 落盘时还没写 meta.source）靠样板正文兜底，与 chat-stream-display 同口径
  if (typeof ev.text === "string" && isScheduleBoilerplateText(ev.text)) return false;
  const m = ev.meta;
  if (!m) return true;
  if (!USER_OWN_SOURCES.has(m.source)) return false;
  // 群来源的附加标记：正常都带 source: feishu_group，这里是防御（标记在、source 却缺失 / 被改的脏数据）
  return !(
    m.groupNonOwnerTurn === true ||
    typeof m.correlatedAnswer === "string" ||
    typeof m.groupSenderOpenId === "string"
  );
};

/** 事件是不是「用户本人说的话」（user_reply 且来源在白名单内）：授权凭据来源 + 登记后「用户又插话」判定共用 */
export const isUserOwnWordsEvent = (
  ev: Pick<TaskEvent, "kind" | "meta"> & { text?: string },
): boolean => ev.kind === "user_reply" && isUserOwnWordsMeta(ev);

/**
 * 能当授权凭据的文本：
 * - 每条 action 的手动推进指令（`action.userInstruction`），**除了**自动推进写的（带前缀）
 * - 最近的 `user_reply` 事件（用户在输入条 / 飞书私聊说的话），**除了**群里来的与定时备忘（见 {@link isUserOwnWordsEvent}）
 */
export const collectAuthorizationSources = (input: {
  actions: readonly Pick<ActionRecord, "userInstruction">[];
  events: readonly Pick<TaskEvent, "kind" | "text" | "meta">[];
}): string[] => {
  const out: string[] = [];
  for (const a of input.actions) {
    const t = a.userInstruction ?? "";
    if (!t.trim() || t.startsWith(AUTO_ADVANCE_INSTRUCTION_PREFIX)) continue;
    out.push(t);
  }
  for (const ev of input.events) {
    if (!isUserOwnWordsEvent(ev)) continue;
    if (!ev.text?.trim()) continue;
    out.push(ev.text);
  }
  return out;
};

/** 自动推进写进新 action 的指令：前缀 + 指令正文 + 授权原话（用户回头看一眼就知道依据） */
export const buildAutoAdvanceInstruction = (
  chain: Pick<AdvanceChain, "instruction" | "userWords">,
): string => {
  const body = chain.instruction.trim();
  const basis = `（依据用户原话：「${chain.userWords}」）`;
  return body
    ? `${AUTO_ADVANCE_INSTRUCTION_PREFIX}${body}\n\n${basis}`
    : `${AUTO_ADVANCE_INSTRUCTION_PREFIX}${basis}`;
};

// ---------------------------------------------------------------------------
// 触发前核对（纯函数）
// ---------------------------------------------------------------------------

export type ChainFireVerdict =
  | { ok: true }
  | {
      ok: false;
      /** 给用户看的一句话（落 info 事件） */
      reason: string;
      /** stale = 状态变了、静默让位；其余是「这次没推」的明确原因 */
      kind: "stale" | "not_submitted" | "capped" | "expired" | "invalid";
    };

export const evaluateChainFire = (input: {
  chain: AdvanceChain;
  task: {
    mode?: string;
    currentActionId?: string | null;
    actions: readonly Pick<ActionRecord, "id" | "status">[];
  } | null;
  opGenNow: number;
  autoStepsSoFar: number;
  now: number;
}): ChainFireVerdict => {
  const { chain, task } = input;
  if (!task) {
    return { ok: false, kind: "stale", reason: "任务已不存在，自动推进取消" };
  }
  if (input.now - chain.registeredAt > ADVANCE_CHAIN_TTL_MS) {
    return {
      ok: false,
      kind: "expired",
      reason: "距离登记已经很久了，自动推进作废（需要的话再说一声）",
    };
  }
  if (input.opGenNow !== chain.opGen) {
    return {
      ok: false,
      kind: "stale",
      reason: "这期间任务被停止 / 变更过，自动推进取消",
    };
  }
  if (task.mode === "chat") {
    return { ok: false, kind: "invalid", reason: "对话型任务没有可推进的 action" };
  }
  if ((task.currentActionId ?? null) !== chain.fromActionId) {
    return {
      ok: false,
      kind: "stale",
      reason: "当前 action 已经变了（可能刚被推进过），自动推进让位",
    };
  }
  const from = task.actions.find((a) => a.id === chain.fromActionId);
  if (!from || (from.status !== "awaiting_ack" && from.status !== "completed")) {
    return {
      ok: false,
      kind: "not_submitted",
      reason: "这一步没有正常交卷，不自动推进下一步",
    };
  }
  if (input.autoStepsSoFar >= ADVANCE_CHAIN_MAX_AUTO_STEPS) {
    return {
      ok: false,
      kind: "capped",
      reason: `已经连续自动推进 ${ADVANCE_CHAIN_MAX_AUTO_STEPS} 步了，先停在这里等你看一眼（你手动推进一次后可继续自动）`,
    };
  }
  return { ok: true };
};

// ---------------------------------------------------------------------------
// 进程内状态（globalThis：Next dev HMR / 多入口 bundle 下也只有一份）
// ---------------------------------------------------------------------------

interface ChainState {
  chains: Map<string, AdvanceChain>;
  autoSteps: Map<string, number>;
}

const STATE_KEY = "__flowshipAdvanceChainV1__";

const getState = (): ChainState => {
  const g = globalThis as unknown as Record<string, ChainState | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = { chains: new Map(), autoSteps: new Map() };
  }
  return g[STATE_KEY]!;
};

/** 登记（同一任务只留最新一条：AI 改主意重调就覆盖）。返回被顶掉的旧链（没有则 null） */
export const registerAdvanceChain = (chain: AdvanceChain): AdvanceChain | null => {
  const s = getState();
  const prev = s.chains.get(chain.taskId) ?? null;
  s.chains.set(chain.taskId, chain);
  return prev;
};

export const peekAdvanceChain = (taskId: string): AdvanceChain | null =>
  getState().chains.get(taskId) ?? null;

/** 取走（一次性：触发 / 作废都走它，之后不会再有第二次） */
export const takeAdvanceChain = (taskId: string): AdvanceChain | null => {
  const s = getState();
  const c = s.chains.get(taskId) ?? null;
  if (c) s.chains.delete(taskId);
  return c;
};

export const getAutoAdvanceSteps = (taskId: string): number =>
  getState().autoSteps.get(taskId) ?? 0;

export const isAutoAdvanceCapReached = (taskId: string): boolean =>
  getAutoAdvanceSteps(taskId) >= ADVANCE_CHAIN_MAX_AUTO_STEPS;

export const bumpAutoAdvanceSteps = (taskId: string): number => {
  const s = getState();
  const n = (s.autoSteps.get(taskId) ?? 0) + 1;
  s.autoSteps.set(taskId, n);
  return n;
};

/** 人手推进（UI / 飞书群 / 选择卡）时清零；没计数就是空操作（热路径、O(1)） */
export const resetAutoAdvanceSteps = (taskId: string): void => {
  const s = getState();
  if (s.autoSteps.size > 0) s.autoSteps.delete(taskId);
};

/** 仅测试：清空全部状态 */
export const __resetAdvanceChainStateForTest = (): void => {
  const s = getState();
  s.chains.clear();
  s.autoSteps.clear();
};
