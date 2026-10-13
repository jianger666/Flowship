/**
 * chat 工作过程分组纯函数（CHAT-REDESIGN Batch A、2026-07-21 用户验收修正语义）
 *
 * 把 mergeToolDisplayEvents 产出的 StreamRenderItem[] 里连续的过程项
 * （thinking / 工具块 / verb-group）收成「工作过程组」；
 * assistant_message 一律独立平铺——AI 中间插话天然分隔前后两个组，
 * 不把「插话前后的两批工具」整合进同一组（用户拍板）。
 * error 同样独立平铺（2026-07-28）——见下方 MEMBER_KINDS 注释。
 * 粘性状态行文案也在此派生。不碰 events.jsonl、不碰组件。
 */

import {
  COMPACTION_RUNNING_LABEL,
  isCompactionInfo,
  isCompactionRunning,
} from "@/lib/compaction-display";
import { formatDurationCoarse } from "@/lib/duration-display";
import { THINKING_LIVE_LABEL, type LiveThinking } from "@/lib/thinking-live";
import type { TaskEvent } from "@/lib/types";
import {
  parseTaskToolArgs,
  toolBlockSummary,
  type StreamRenderItem,
  type ToolBlock,
  type ToolVerbGroup,
  isInTurnToolErrorEvent,
} from "@/lib/tool-display";

// ---------- 类型 ----------

export type WorkGroupItem = {
  kind: "__work_group__";
  /** 组内第一个成员的 id（分页 prepend 下稳定、用作 React key 与折叠 state key） */
  id: string;
  members: StreamRenderItem[];
  /** 组内含 error 事件或 error 状态工具块 */
  hasError: boolean;
  /** 组内含 running 状态工具块（或末尾有进行中的思考——见 attachLiveThinking） */
  hasRunning: boolean;
  /** 首成员 ts */
  startTs: number;
  /** 末成员 ts */
  endTs: number;
  /** 步数 = members.length（verb-group 算 1 步） */
  stepCount: number;
};

export type ChatRenderItem = StreamRenderItem | WorkGroupItem;

export type ActiveStatus = {
  /**
   * 主文案：当前工具「正在执行 shell」/「思考中」/
   * 工具刚跑完等模型下一步「正在分析 read 的结果」（说不清是哪个工具时退回「处理中…」）/「正在回复…」
   */
  label: string;
  /**
   * 可选细节：工具摘要 / liveOutput 尾行（单行截断 ~80 字）。
   * 思考没有 detail——思考原文在工作过程组的思考行里展示，这里再带一遍就是上下各一行同样的字。
   */
  detail?: string;
  /**
   * 这一步从何时开始（毫秒时间戳）。有值 = 状态行等了一会儿后显示「· 12s」并逐秒走字，
   * 让人随时能回答「已经等了多久、是不是卡住了」。
   *
   * 给四类有这个需要的空窗：工具执行中 / 子代理 / 工具跑完等模型下一步 / 思考中
   * （思考的起点是收到首帧的时刻；一段思考可长达一分多钟，原文又不在这里展示，计时是唯一的进度感）。
   * 刚发消息的启动阶段由列表里的 PendingRow 计时（「已等待 Ns」）、
   * 正文有流式文字——这些都不在这里重复计时。
   */
  sinceTs?: number;
  /**
   * 「让位」标记：这一状态的信息，在列表末尾已经有一行进度行（PendingRow / BootStageRow）
   * 在说的时候，状态行就不再画，免得上下各说一遍「在启动」。
   *
   * 只是**可以**让位，不是一定让位：调用方（event-stream）看到流尾确有进度行才让；
   * 没有（比如启动链 info 已收进折叠的「启动过程」组、流里没有任何动态指示）时状态行是唯一的
   * 「还在跑」信号，必须照常画。判定放在调用方、不放在这里，是因为这里看不到渲染出来的流尾。
   */
  yieldToTail?: boolean;
};

/** 工具都跑完、下一句还没出来：空等挂在这一句，不挂在 write 上（也是说不清上一个工具时的兜底文案） */
export const PROCESSING_PLACEHOLDER_LABEL = "处理中…";

/**
 * 工具跑完、模型还没给出下一步时的状态行文案：「正在分析 read 的结果」。
 * 只描述「在消化上一个工具的结果」，不断言更细的阶段（推理 / 排队 / SDK 重试从这里分不出来）。
 */
export const analyzingToolLabel = (toolName: string): string =>
  `正在分析 ${toolName} 的结果`;

/** 状态行等够这么久才显示秒数：瞬时工具（读个文件）一闪而过时，别跟着闪一下数字 */
export const STATUS_ELAPSED_SHOW_AFTER_MS = 3000;

/**
 * 已等待毫秒 → 状态行里的「12s」/「2m14s」；不到显示门槛返回 null（不渲染）。
 * 口径与工作过程组头一致（formatDurationCoarse，秒级）。
 */
export const formatStatusElapsed = (elapsedMs: number): string | null =>
  elapsedMs < STATUS_ELAPSED_SHOW_AFTER_MS
    ? null
    : formatDurationCoarse(elapsedMs);

/**
 * 工作过程组末尾要不要挂「处理中…」。
 * 本组已是流尾、没有还在跑的工具、正文还没开始流；末成员是 thinking 时思考行本身就是进度，不再叠一行。
 *
 * `statusLineVisible`：输入框上方的粘性状态行这一帧确实会画出来（chat 形态且有状态文案）。
 * 此时它已经在说「正在分析 X 的结果 · 12s」，组尾再转一圈「处理中…」就是同一句废话说两遍
 * （Bug 记录 #5 的现象描述：工作过程组末尾和输入框上方各有一遍「处理中…」）——让位给状态行。
 * task 形态没有状态行，仍由组尾这一行兜底。
 */
export const shouldShowProcessingPlaceholder = (input: {
  isRunning: boolean;
  isLastItem: boolean;
  hasRunning: boolean;
  hasStreamingText: boolean;
  lastMemberKind?: string;
  statusLineVisible?: boolean;
}): boolean => {
  if (!input.isRunning || !input.isLastItem) return false;
  if (input.hasRunning || input.hasStreamingText) return false;
  if (input.lastMemberKind === "thinking") return false;
  if (input.statusLineVisible) return false;
  return true;
};

export const isWorkGroup = (it: ChatRenderItem): it is WorkGroupItem =>
  it.kind === "__work_group__";

/**
 * 进行中思考的合成 meta：`live` 标记这条 thinking 是前端合成的（不落盘、不在 task.events 里），
 * ProcessEventRow 据此多画一个转圈、默认展开成实时文本区（落盘后回到默认折叠）、不显示耗时
 * （耗时落盘后才有）。
 */
const LIVE_THINKING_META: Readonly<Record<string, unknown>> = { live: true };

/**
 * 这条事件是不是「进行中的思考」（attachLiveThinking 合成的那条）。
 * 普通布尔判定：传入类型本来就是 TaskEvent 的调用方（ProcessEventRow）用它，
 * 不会因类型守卫把 else 分支窄化成 never。
 */
export const isLiveThinkingMeta = (
  ev: Pick<TaskEvent, "kind" | "meta">,
): boolean => ev.kind === "thinking" && ev.meta?.live === true;

/** 同上，但入参是渲染项、带类型守卫（折叠组头判断末成员是不是进行中的思考用） */
export const isLiveThinkingEvent = (
  it: ChatRenderItem | undefined,
): it is TaskEvent =>
  !!it && it.kind === "thinking" && isLiveThinkingMeta(it as TaskEvent);

/**
 * 事件行没被用户动过时的折叠态：进行中的思考自动展开成实时文本区，其余用首次渲染时锁定的默认值。
 *
 * 为什么进行中的思考要自动展开：它存在的意义就是让人看到「正在想什么」。折叠成一行摘要的话，
 * 摘要只能取最新一行，每来一个字整行左滑一格，没法跟读（2026-10-12 用户反馈「思考吐字很机械」）。
 * 为什么其余的用「首次渲染时锁定」的默认值：落盘后同 id 的思考行是同一个节点——
 * live 标记一没，这里自然回到默认折叠；而 isDefaultVisible 之后怎么变都不该把用户的阅读状态刷掉。
 */
export const autoEventCollapsed = (
  isLive: boolean,
  initialCollapsed: boolean,
): boolean => (isLive ? false : initialCollapsed);

/**
 * 用户点一下折叠箭头后的手动态：基于「他当前看到的」翻转——有手动态按手动态，否则按自动态。
 * 手动态一旦有了就一直优先于自动态（live 落盘、默认值变化都不会把用户的选择刷掉）。
 */
export const toggleEventCollapsed = (
  manual: boolean | null,
  auto: boolean,
): boolean => !(manual ?? auto);

/**
 * 把「正在进行的思考」画进流程——作为一条真正的 thinking 成员，由已有的思考行渲染。
 *
 * 为什么是合成事件、而不是另做一个组件：思考本来就是流程里的一步（落盘后就是一条 thinking 行），
 * 只是它要整段结束才落盘——期间流程里缺这一步，用户看到的是「等待模型响应… 已等待 62s」。
 * 现在它一开始想就是流程里的一行，外观、折叠 / 展开和落盘后的思考行是同一个组件。
 *
 * 三种落点，都与「落盘后 buildStreamItems 会产出的结果」同构（行数、组 id、行 id 一致）：
 *  - 流尾是工作过程组、末成员不是思考 → 追加为新成员（stepCount + 1）；
 *  - 末成员已是思考 → 并进去（文本拼接，沿用它的 id 与 ts，stepCount 不变）：落盘后
 *    coalesceAdjacentThinking 也会把相邻 thinking 收成一条（保留第一条的 id），这里提前对齐，
 *    省得落盘那一刻「两行变一行」；
 *  - 流尾不是组（回车后第一段思考 / AI 插话之后又开始想）→ 新建只含这一步的组，
 *    组 id = 思考 id（落盘后它就是新组的第一个成员，而 buildWorkGroup 的组 id = 首成员 id）。
 *
 * 另：
 *  - 事件 id = live.id（服务端预定的落盘 id）——落盘前后是同一个 React 节点，用户点开着读的
 *    内容不会被收起。尾组里已经有这个 id（落盘事件先于「清实时态」那次更新到达；
 *    同批渲染下不会出现，这里兜底）→ 原样返回，不叠一份。
 *  - `hasRunning: true`：组头转圈、自动展开，也让「处理中…」占位让位。
 *  - 不改入参；前面的项原样保留（引用不变）：只有流尾一项会变。
 */
export const attachLiveThinking = (
  items: readonly ChatRenderItem[],
  live: LiveThinking,
): readonly ChatRenderItem[] => {
  const last = items[items.length - 1];
  const meta = { ...LIVE_THINKING_META };
  const step: TaskEvent = {
    id: live.id,
    ts: live.since,
    kind: "thinking",
    text: live.text,
    meta,
  };

  // 流尾不是组：新建一个只含这一步的组
  if (!last || !isWorkGroup(last)) {
    return [
      ...items,
      {
        kind: "__work_group__",
        id: live.id,
        members: [step],
        hasError: false,
        hasRunning: true,
        startTs: live.since,
        endTs: live.since,
        stepCount: 1,
      },
    ];
  }

  // 已落盘（见上）：不叠第二份
  if (last.members.some((m) => m.id === live.id)) return items;

  const tail = last.members[last.members.length - 1];
  if (
    tail &&
    tail.kind === "thinking" &&
    (tail as TaskEvent).actionId === undefined
  ) {
    // 与 coalesceAdjacentThinking 同规则（chat 的 thinking 都没有 actionId）：并进末成员
    const prev = tail as TaskEvent;
    const merged: TaskEvent = {
      ...prev,
      text: `${prev.text}${live.text}`,
      meta: { ...(prev.meta ?? {}), ...meta },
    };
    return [
      ...items.slice(0, -1),
      {
        ...last,
        members: [...last.members.slice(0, -1), merged],
        hasRunning: true,
        endTs: Math.max(last.endTs, live.since),
      },
    ];
  }

  return [
    ...items.slice(0, -1),
    {
      ...last,
      members: [...last.members, step],
      hasRunning: true,
      stepCount: last.stepCount + 1,
      endTs: Math.max(last.endTs, live.since),
    },
  ];
};

// ---------- 组成员判定 ----------

/**
 * 进组的 kind——纯过程项。两类东西**不**进组、独立平铺并隔断前后组：
 *   - assistant_message：AI 说的每段话（含中间插话）都是正文
 *   - error（2026-07-28）：run 挂了是这一轮最重要的信息、不能被组的
 *     「run 结束自动收起」吃掉（用户正在读的错误会啪一下消失、还得点两次找回来）
 */
const MEMBER_KINDS = new Set<string>([
  "thinking",
  "__tool_block__",
  "__tool_verb_group__",
]);

/**
 * 启动链 info 进组（2026-09-23、用户嫌每次发消息刷 6 行）：
 * 唤醒 / 已唤醒 / 准备工作区 / 启动 agent / MCP 跳过——纯过程噪音、与 thinking 同档，
 * 收进工作过程组（跑着展开、完事收起）。后端事件不动，只收前端展示。
 * 「用户停止了…」「本次新增…批次」「已回复」等操作反馈不在此列、继续独立平铺。
 *
 * 约定（2026-09-24，review 立约）：新增过程类 info 必须带 `meta.subkind` 机器字段、
 * 前端只认字段；中文前缀匹配仅兼容无字段的历史事件，别再加新前缀。
 */
const BOOT_INFO_PREFIXES: readonly string[] = [
  "正在唤醒当前阶段",
  "已唤醒当前",
  "正在准备工作区",
  "正在启动 agent",
];

export const isBootInfoText = (text: unknown): boolean => {
  if (typeof text !== "string" || text.length === 0) return false;
  if (BOOT_INFO_PREFIXES.some((p) => text.startsWith(p))) return true;
  return text.includes("不可用的 MCP");
};

export const isBootInfoItem = (it: StreamRenderItem): boolean => {
  if (it.kind !== "info") return false;
  const ev = it as TaskEvent;
  // 首选机器字段；历史事件无字段，回退中文匹配
  if (ev.meta?.subkind === "boot") return true;
  return isBootInfoText(ev.text);
};

/** 组内含 ⚠️ 警告行（MCP 跳过等）——组头挂标，折叠也不吞提示 */
export const groupHasBootWarn = (
  members: readonly StreamRenderItem[],
): boolean =>
  members.some(
    (m) =>
      m.kind === "info" &&
      typeof (m as TaskEvent).text === "string" &&
      (m as TaskEvent).text.includes("⚠️"),
  );

// error 事件已不进组（见 MEMBER_KINDS）、组内只可能剩「工具执行失败」这一种错
const memberHasError = (it: StreamRenderItem): boolean => {
  if (it.kind === "__tool_block__") {
    return (it as ToolBlock).status === "error";
  }
  if (it.kind === "__tool_verb_group__") {
    return (it as ToolVerbGroup).members.some((m) => m.status === "error");
  }
  return false;
};

const memberHasRunning = (it: StreamRenderItem): boolean => {
  if (it.kind === "__tool_block__") {
    return (it as ToolBlock).status === "running";
  }
  if (it.kind === "__tool_verb_group__") {
    return (it as ToolVerbGroup).members.some((m) => m.status === "running");
  }
  return false;
};

const buildWorkGroup = (members: StreamRenderItem[]): WorkGroupItem => {
  const first = members[0]!;
  const last = members[members.length - 1]!;
  return {
    kind: "__work_group__",
    id: first.id,
    members,
    hasError: members.some(memberHasError),
    hasRunning: members.some(memberHasRunning),
    startTs: first.ts,
    endTs: last.ts,
    stepCount: members.length,
  };
};

/**
 * 线性扫产组：连续过程项（thinking / 工具 / 启动链 info）收进同一组；
 * 任何非过程项（user_reply / assistant_message / error / ask_* / 非启动类 info / 未知）
 * 独立输出并隔断组。单成员也成组（统一渲染路径）。O(n)。
 */
export const groupChatRenderItems = (
  items: StreamRenderItem[],
): ChatRenderItem[] => {
  if (items.length === 0) return [];

  const out: ChatRenderItem[] = [];
  let buf: StreamRenderItem[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    out.push(buildWorkGroup(buf));
    buf = [];
  };

  for (const it of items) {
    if (MEMBER_KINDS.has(it.kind) || isBootInfoItem(it)) {
      buf.push(it);
      continue;
    }
    flush();
    out.push(it);
  }
  flush();
  return out;
};

// ---------- 错误可重试判定 ----------

/**
 * 这条 error 是不是「当轮失败」——只有它该给「重试」入口。
 *
 * 重试的语义是「把最后一条用户消息原样再发」。翻历史时点旧错误上的重试、
 * 发出去的是今天最后那条消息、完全不是用户预期。所以要求两件事同时成立：
 *   1. 它是最后一条 error（之后没有更新的失败）
 *   2. 其后没有新的 user_reply（用户已经继续说话 = 这一轮翻篇了）
 */
export const isLatestErrorEvent = (
  events: readonly TaskEvent[],
  eventId: string,
): boolean => {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    // 回合内工具失败不算「当轮崩溃」——不能挡真正的 run 错误，也不能自己带重试
    if (isInTurnToolErrorEvent(ev)) continue;
    if (ev.id === eventId) return ev.kind === "error";
    if (ev.kind === "error" || ev.kind === "user_reply") return false;
  }
  return false;
};

// ---------- deriveActiveStatus ----------

const DETAIL_MAX = 80;

/** 单行截断（状态行 detail 用） */
const clipDetail = (s: string, max = DETAIL_MAX): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
};

/** liveOutput 取末行再截断 */
const lastLineClipped = (text: string): string => {
  const lines = text.split("\n");
  let last = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (t) {
      last = t;
      break;
    }
  }
  return clipDetail(last || text.trim());
};

const getCallId = (ev: TaskEvent): string =>
  typeof ev.meta?.callId === "string" ? ev.meta.callId : "";

const getToolName = (ev: TaskEvent): string =>
  typeof ev.meta?.name === "string" ? ev.meta.name : "tool";

const getArgs = (ev: TaskEvent): string | undefined =>
  typeof ev.meta?.args === "string" ? ev.meta.args : undefined;

/** 用 toolBlockSummary 思路从 tool_call 事件抽一行摘要（不经组件层） */
const summarizeToolCallArgs = (ev: TaskEvent): string | undefined => {
  const name = getToolName(ev);
  const block: ToolBlock = {
    kind: "__tool_block__",
    id: ev.id,
    callId: getCallId(ev) || ev.id,
    name,
    status: "running",
    text: ev.text,
    args: getArgs(ev),
    ts: ev.ts,
  };
  const summary = toolBlockSummary(block);
  if (!summary || summary === ev.text) {
    // text 常是「调用 shell」、不如 args 摘要；无摘要则不给 detail
    if (!getArgs(ev)) return undefined;
  }
  return clipDetail(summary);
};

/**
 * 基础状态 + 它是不是「空等」类。
 * 空等类（刚发消息等启动 / 工具跑完等模型 / 已落盘的思考刚结束 / 正文还没开始）会被思考实时态盖掉；
 * 其余（工具在跑 / 子代理 / 压缩）有更具体的信息，不能盖。
 * 用显式标记而不是按 label 文案判等——文案现在带工具名、不再是一个固定集合。
 */
type StatusBase = { status: ActiveStatus; idle: boolean };

const idleBase = (status: ActiveStatus): StatusBase => ({ status, idle: true });
const busyBase = (status: ActiveStatus): StatusBase => ({ status, idle: false });

/** 事件 ts → 状态的起点时间戳（缺省 / 脏值 → 不带 sinceTs，状态行就不走字） */
const sinceOf = (ev: TaskEvent): Pick<ActiveStatus, "sinceTs"> =>
  Number.isFinite(ev.ts) ? { sinceTs: ev.ts } : {};

/** 状态行里工具名的最大长度（MCP 工具名可以很长，别把整行顶满） */
const ANALYZING_NAME_MAX = 28;

/**
 * 粘性状态行文案：从尾部回扫最近的 agent 活动。
 * 调用方只在 isRunning 时调用；本函数不判断 running。
 * `streaming`：正文已经在流，工具刚跑完也改口「正在回复…」，别停在「处理中…」。
 *
 * 只看已落盘事件——思考实时态由外层 deriveActiveStatus 叠加（见下方）。
 */
const deriveActiveStatusBase = (
  events: readonly TaskEvent[],
  liveToolOutputs?: Record<string, string>,
  opts?: { streaming?: boolean },
): StatusBase | null => {
  if (events.length === 0) return null;

  // 先收集：已完成的 callId（有对应 tool_result）、各 callId 的工具名、出现过的 tool_call callId
  const doneCallIds = new Set<string>();
  const toolNameByCallId = new Map<string, string>();
  const calledIds: string[] = [];
  for (const ev of events) {
    const cid = getCallId(ev);
    if (!cid) continue;
    if (ev.kind === "tool_result") {
      doneCallIds.add(cid);
    } else if (ev.kind === "tool_call") {
      calledIds.push(cid);
      if (typeof ev.meta?.name === "string" && ev.meta.name) {
        toolNameByCallId.set(cid, ev.meta.name);
      }
    }
  }
  // 并行工具：还有 tool_call 没配上 result 时，「上一个工具」说不清——退回泛称、不乱点名
  const hasUnpairedToolCall = calledIds.some((cid) => !doneCallIds.has(cid));

  /** 工具跑完、下一句还没出来（ev = 触发这次判定的 tool_result / 已完成的 tool_call） */
  const waitingAfterTools = (ev: TaskEvent): StatusBase => {
    // 正文已经在流：改口「正在回复…」，别停在「处理中…」
    if (opts?.streaming) return idleBase({ label: "正在回复…" });
    const since = sinceOf(ev);
    const rawName =
      typeof ev.meta?.name === "string" && ev.meta.name
        ? ev.meta.name
        : toolNameByCallId.get(getCallId(ev));
    if (!rawName || hasUnpairedToolCall) {
      return idleBase({ label: PROCESSING_PLACEHOLDER_LABEL, ...since });
    }
    return idleBase({
      label: analyzingToolLabel(clipDetail(rawName, ANALYZING_NAME_MAX)),
      ...since,
    });
  };

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;

    // 扫到 user_reply 还没撞上 agent 活动 → 刚发出、等启动。
    // 不带 sinceTs：这一段由列表里的 PendingRow 计时（「已等待 Ns」），状态行不再重复走一遍字。
    // 正文已经在流（assistant_message 要整段说完才落盘，期间事件尾还是 user_reply）：
    // 是在回复、不是在启动——不然正文在屏上一个字一个字出，输入框上方却写着「正在启动…」。
    // 流尾有进度行时可让位（yieldToTail，见 ActiveStatus）：PendingRow / BootStageRow 已经在说同一件事
    if (ev.kind === "user_reply") {
      return opts?.streaming
        ? idleBase({ label: "正在回复…" })
        : idleBase({ label: "正在启动…", yieldToTail: true });
    }

    // 自定义 pi 压缩：字已经在屏上，但 agent_settled 还没到——别继续说「正在回复」
    if (isCompactionInfo(ev)) {
      if (isCompactionRunning(ev)) {
        return busyBase({ label: COMPACTION_RUNNING_LABEL });
      }
      continue;
    }

    // 未配对 tool_call = 当前在跑的工具
    if (ev.kind === "tool_call") {
      const cid = getCallId(ev);
      if (cid && doneCallIds.has(cid)) {
        // 已完成的 tool_call：等下一轮模型（交卷 / 结论 / 下一个工具）
        return waitingAfterTools(ev);
      }
      const name = getToolName(ev);
      const since = sinceOf(ev);
      // task 子代理特殊文案
      if (name.toLowerCase() === "task") {
        const taskArgs = parseTaskToolArgs(getArgs(ev));
        const detail = taskArgs?.description
          ? clipDetail(taskArgs.description)
          : undefined;
        return busyBase({ label: "子代理工作中", detail, ...since });
      }
      const live = cid && liveToolOutputs ? liveToolOutputs[cid] : undefined;
      const detail = live?.trim()
        ? lastLineClipped(live)
        : summarizeToolCallArgs(ev);
      return busyBase({
        label: `正在执行 ${name}`,
        detail,
        ...since,
      });
    }

    // 已完成的 tool_result：等下一轮模型，不是已经在写回复
    if (ev.kind === "tool_result") {
      return waitingAfterTools(ev);
    }

    // ephemeral 增量不参与判定
    if (ev.kind === "tool_output_delta") continue;

    // 已落盘的 thinking = 这一段思考刚结束、下一个事件还没来（紧接着是工具调用 / 正文）。
    // 不带 detail：它的原文就在上面工作过程组的思考行里（折叠摘要），再摘一行放这里是同一句话说两遍。
    // 算「空等」类（idle）：紧跟着又开始新一段思考时，让实时态（带计时）盖掉它；
    // 正文已经在流则改口「正在回复…」——此时正文在屏上、思考早就结束了
    if (ev.kind === "thinking") {
      return idleBase({
        label: opts?.streaming ? "正在回复…" : THINKING_LIVE_LABEL,
      });
    }

    if (ev.kind === "assistant_message") {
      return idleBase({ label: "正在回复…" });
    }

    // error 也算明确活动收尾 → 正在回复（调用方仍在 running 时少见）
    if (ev.kind === "error") {
      return idleBase({ label: "正在回复…" });
    }

    // info / ask_* / 其它 → 继续往前扫
  }

  // 全是 info 之类、没有任何 user/agent 信号
  return idleBase({ label: "正在回复…" });
};

/**
 * 粘性状态行文案（含思考实时态）。
 *
 * `thinkingSince`：这一段实时思考的起点（毫秒时间戳，收到首帧的时刻）——null / undefined = 没在思考。
 * 只要「在思考 + 从何时起」，不要原文：原文在工作过程组的思考行里展示，状态行再带就是上下重复。
 *
 * 为什么需要它：已落盘的 thinking 事件要等整段思考**结束**才有，deriveActiveStatusBase
 * 扫到它时思考已经完了；思考进行中（实测一段可长达 65s）事件流尾部还是 user_reply /
 * tool_result，状态行只能说「正在启动…」「处理中…」，用户以为卡死。
 * 带上起点是为了走字：原文不在这里展示后，「思考中 · 12s」就是状态行里唯一的进度感。
 */
export const deriveActiveStatus = (
  events: readonly TaskEvent[],
  liveToolOutputs?: Record<string, string>,
  opts?: { streaming?: boolean; thinkingSince?: number | null },
): ActiveStatus | null => {
  const base = deriveActiveStatusBase(events, liveToolOutputs, opts);
  if (!base) return null;
  const since = opts?.thinkingSince;
  if (since == null) return base.status;
  // 正文已经在流 = 在回复、不是在思考（实时态此时本应已被清掉，这里兜竞态）
  if (opts?.streaming) return base.status;
  // 只盖「空等」类；工具在跑 / 子代理 / 压缩有更具体的信息，不能盖
  if (!base.idle) return base.status;
  // 脏值（NaN 等）退化成不带计时的「思考中」，别让走字显示 NaNs
  return Number.isFinite(since)
    ? { label: THINKING_LIVE_LABEL, sinceTs: since }
    : { label: THINKING_LIVE_LABEL };
};
