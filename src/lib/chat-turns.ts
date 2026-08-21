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
  /** 组内含 running 状态工具块 */
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
 * 线性扫产组：连续过程项（thinking / 工具）收进同一组；
 * 任何非过程项（user_reply / assistant_message / error / ask_* / info / 未知）
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
    if (MEMBER_KINDS.has(it.kind)) {
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
 */
export const deriveActiveStatus = (
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
