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
import {
  THINKING_LIVE_LABEL,
  THINKING_TEXT_MAX,
  type LiveThinking,
} from "@/lib/thinking-live";
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
  /** 主文案：当前工具「正在执行 shell」/ thinking 首行截断 /「处理中…」/「正在回复…」 */
  label: string;
  /** 可选细节：工具摘要 / liveOutput 尾行（单行截断 ~80 字） */
  detail?: string;
  /**
   * 「已经说完、只剩收尾」：静态展示（打勾、不闪烁、不带脉冲点）。
   * 动画会让用户以为 AI 还在写；这个态的意思恰恰是「可以读了」。
   */
  settled?: boolean;
};

/**
 * 回合已结束（回复完整落盘）但 SDK 迟迟没收尾（等 checkpoint 持久化等）时的状态行。
 * 替代之前一直闪烁的「正在回复…」——那会让用户对着一个其实已写完的回复干等。
 */
export const TURN_WRAP_UP_STATUS: ActiveStatus = {
  label: "回复已完成",
  detail: "正在保存会话…",
  settled: true,
};

/** 工具都跑完、下一句还没出来：空等挂在这一句，不挂在 write 上 */
export const PROCESSING_PLACEHOLDER_LABEL = "处理中…";

/**
 * 工作过程组末尾要不要挂「处理中…」。
 * 本组已是流尾、没有还在跑的工具、正文还没开始流；末成员是 thinking 时思考行本身就是进度，不再叠一行。
 */
export const shouldShowProcessingPlaceholder = (input: {
  isRunning: boolean;
  isLastItem: boolean;
  hasRunning: boolean;
  hasStreamingText: boolean;
  lastMemberKind?: string;
}): boolean => {
  if (!input.isRunning || !input.isLastItem) return false;
  if (input.hasRunning || input.hasStreamingText) return false;
  if (input.lastMemberKind === "thinking") return false;
  return true;
};

export const isWorkGroup = (it: ChatRenderItem): it is WorkGroupItem =>
  it.kind === "__work_group__";

/**
 * 进行中思考的合成 meta：`live` 标记这条 thinking 是前端合成的（不落盘、不在 task.events 里），
 * ProcessEventRow 据此多画一个转圈、折叠摘要取最新一行、不显示耗时（耗时落盘后才有）；
 * `liveTruncated` = 原文超过前端保留上限、前面的被截掉了（展开区顶部给提示）。
 */
const liveThinkingMeta = (live: LiveThinking): Record<string, unknown> =>
  live.text.length >= THINKING_TEXT_MAX
    ? { live: true, liveTruncated: true }
    : { live: true };

/**
 * 这条事件是不是「进行中的思考」（attachLiveThinking 合成的那条）。
 * 普通布尔判定：传入类型本来就是 TaskEvent 的调用方（ProcessEventRow）用它，
 * 不会因类型守卫把 else 分支窄化成 never。
 */
export const isLiveThinkingMeta = (
  ev: Pick<TaskEvent, "kind" | "meta">,
): boolean => ev.kind === "thinking" && ev.meta?.live === true;

/** 同上，但入参是渲染项、带类型守卫（折叠组头取末成员文本用） */
export const isLiveThinkingEvent = (
  it: ChatRenderItem | undefined,
): it is TaskEvent =>
  !!it && it.kind === "thinking" && isLiveThinkingMeta(it as TaskEvent);

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
  const meta = liveThinkingMeta(live);
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
): ActiveStatus | null => {
  if (events.length === 0) return null;

  const waitingAfterTools = (): ActiveStatus =>
    opts?.streaming
      ? { label: "正在回复…" }
      : { label: PROCESSING_PLACEHOLDER_LABEL };

  // 先收集已完成的 callId（有对应 tool_result）
  const doneCallIds = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== "tool_result") continue;
    const cid = getCallId(ev);
    if (cid) doneCallIds.add(cid);
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;

    // 扫到 user_reply 还没撞上 agent 活动 → 刚发出、等启动
    if (ev.kind === "user_reply") {
      return { label: "正在启动…" };
    }

    // 自定义 pi 压缩：字已经在屏上，但 agent_settled 还没到——别继续说「正在回复」
    if (isCompactionInfo(ev)) {
      if (isCompactionRunning(ev)) {
        return { label: COMPACTION_RUNNING_LABEL };
      }
      continue;
    }

    // 未配对 tool_call = 当前在跑的工具
    if (ev.kind === "tool_call") {
      const cid = getCallId(ev);
      if (cid && doneCallIds.has(cid)) {
        // 已完成的 tool_call：等下一轮模型（交卷 / 结论 / 下一个工具）
        return waitingAfterTools();
      }
      const name = getToolName(ev);
      // task 子代理特殊文案
      if (name.toLowerCase() === "task") {
        const taskArgs = parseTaskToolArgs(getArgs(ev));
        const detail = taskArgs?.description
          ? clipDetail(taskArgs.description)
          : undefined;
        return { label: "子代理工作中", detail };
      }
      const live = cid && liveToolOutputs ? liveToolOutputs[cid] : undefined;
      const detail = live?.trim()
        ? lastLineClipped(live)
        : summarizeToolCallArgs(ev);
      return {
        label: `正在执行 ${name}`,
        detail,
      };
    }

    // 已完成的 tool_result：等下一轮模型，不是已经在写回复
    if (ev.kind === "tool_result") {
      return waitingAfterTools();
    }

    // ephemeral 增量不参与判定
    if (ev.kind === "tool_output_delta") continue;

    if (ev.kind === "thinking") {
      const detail = ev.text.trim() ? lastLineClipped(ev.text) : undefined;
      return { label: "思考中", detail };
    }

    if (ev.kind === "assistant_message") {
      return { label: "正在回复…" };
    }

    // error 也算明确活动收尾 → 正在回复（调用方仍在 running 时少见）
    if (ev.kind === "error") {
      return { label: "正在回复…" };
    }

    // info / ask_* / 其它 → 继续往前扫
  }

  // 全是 info 之类、没有任何 user/agent 信号
  return { label: "正在回复…" };
};

/**
 * 只有这些「空等」文案会被实时思考盖掉：
 * 工具在跑 / 子代理 / 压缩有更具体的信息，不能盖；已落盘的「思考中」本来就对。
 */
const IDLE_WAIT_LABELS: ReadonlySet<string> = new Set([
  "正在启动…",
  PROCESSING_PLACEHOLDER_LABEL,
  "正在回复…",
]);

/**
 * 粘性状态行文案（含思考实时态）。
 *
 * `thinking`：思考实时帧聚合出的「最近一行」——null / undefined = 没在思考；
 * "" = 在思考但还没有可展示的行（只显示「思考中」不带细节）。
 *
 * 为什么需要它：已落盘的 thinking 事件要等整段思考**结束**才有，deriveActiveStatusBase
 * 扫到它时思考已经完了；思考进行中（实测一段可长达 65s）事件流尾部还是 user_reply /
 * tool_result，状态行只能说「正在启动…」「处理中…」，用户以为卡死。
 */
export const deriveActiveStatus = (
  events: readonly TaskEvent[],
  liveToolOutputs?: Record<string, string>,
  opts?: { streaming?: boolean; thinking?: string | null },
): ActiveStatus | null => {
  const base = deriveActiveStatusBase(events, liveToolOutputs, opts);
  const thinking = opts?.thinking;
  if (thinking == null || !base) return base;
  // 正文已经在流 = 在回复、不是在思考（thinking 此时本应已被清掉，这里兜竞态）
  if (opts?.streaming) return base;
  if (!IDLE_WAIT_LABELS.has(base.label)) return base;
  return thinking
    ? { label: THINKING_LIVE_LABEL, detail: thinking }
    : { label: THINKING_LIVE_LABEL };
};
