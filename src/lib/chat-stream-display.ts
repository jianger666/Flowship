/**
 * chat 消息流展示的纯逻辑（2026-07-20 消息流 Codex 化批次）
 *
 * 抽离动机：折叠判定 / 轮次分割 / 启动进度（boot stage）归并都是纯函数、
 * 放组件里没法单测。event-stream / rows 只做渲染、判定逻辑单一来源在这。
 */

import type { TaskEvent } from "@/lib/types";

// ---------- 超长用户消息折叠（Codex 同款「显示更多」） ----------

/** 折叠阈值：超过这个换行行数默认截断 */
export const USER_MSG_COLLAPSE_LINES = 8;
/** 单行长文（无换行的大段粘贴）也要折叠——按字符数兜底（渲染时会自动换行撑高） */
export const USER_MSG_COLLAPSE_CHARS = 600;

/**
 * 用户消息是否值得折叠。
 * 行数按 `\n` 计（渲染 whitespace-pre-wrap、换行即视觉行）；
 * 无换行长文按字符数兜底（wrap 后同样占多行）。
 */
export const shouldCollapseUserMessage = (
  text: string,
  maxLines = USER_MSG_COLLAPSE_LINES,
  maxChars = USER_MSG_COLLAPSE_CHARS,
): boolean => {
  if (!text) return false;
  if (text.length > maxChars) return true;
  // split 计数：N 行文本有 N-1 个 \n
  return text.split("\n").length > maxLines;
};

// ---------- 每轮会话分割线（Codex 风、低调） ----------

/**
 * 渲染项 idx 上方是否画轮次分割线。
 *
 * 语义：user_reply = 新一轮开始；「第一轮」（此前没有任何对话轮）不画——
 * 判定「此前有轮」= 前面出现过 user_reply / assistant_message / __work_group__
 * （正文被吸进工作组时整轮可能只剩组；boot info、过程行不算轮）。
 *
 * @param kinds 渲染项 kind 序列（与 items 对齐；虚拟项 kind 以 __ 开头、天然不命中，
 *   例外：`__work_group__` 是 chat 分组产物、算「此前有轮」）
 */
export const shouldShowTurnDivider = (
  kinds: readonly string[],
  idx: number,
): boolean => {
  if (kinds[idx] !== "user_reply") return false;
  for (let i = 0; i < idx; i++) {
    if (
      kinds[i] === "user_reply" ||
      kinds[i] === "assistant_message" ||
      kinds[i] === "__work_group__"
    ) {
      return true;
    }
  }
  return false;
};

// ---------- sticky 轮次头（视口顶上方最近一条 user_reply） ----------

/** sticky 判定只关心 kind / id / text，避免绑死 RenderItem 联合类型 */
export type StickyTurnCandidate = {
  id: string;
  kind: string;
  text?: string;
};

/**
 * 根据 Virtuoso range.startIndex（换算成 items 下标）算是否该粘顶。
 *
 * 规则：从视口顶项往上找最近一条 user_reply；
 * - 它严格在顶项上方（已滚出）→ 粘它
 * - 它就是顶项本身（还看得见）→ 不粘
 * - 上方没有 user_reply → 不粘
 *
 * 抽纯函数：event-stream 滚动热路径只调它、再用命令式 DOM 更新粘顶条——
 * 禁止在 rangeChanged 里 setState（会触发 Virtuoso 重渲 → startIndex 在
 * user_reply 边界来回翻 → 快速持续抖动）。
 */
export const resolveStickyTurn = (
  items: readonly StickyTurnCandidate[],
  localIdx: number,
): { id: string; text: string } | null => {
  if (items.length === 0 || localIdx < 0) return null;
  for (let i = Math.min(localIdx, items.length - 1); i >= 0; i--) {
    const it = items[i];
    if (it && it.kind === "user_reply") {
      if (i < localIdx) {
        return { id: it.id, text: typeof it.text === "string" ? it.text : "" };
      }
      return null;
    }
  }
  return null;
};

// ---------- 启动进度渐进单行（boot stage） ----------

/**
 * 是否是启动链进度 info（「正在检查 MCP…」「正在创建会话…」「正在发送首包…」）。
 * 主判定：server 端 publishBootProgress 打的 meta.bootStage；
 * 兜底：旧事件只有 meta.stage + ephemeral_boot_ id 前缀（内存里可能还挂着旧 shape）。
 */
export const isBootStageInfo = (
  ev: Pick<TaskEvent, "id" | "kind" | "meta">,
): boolean => {
  if (ev.kind !== "info") return false;
  if (ev.meta?.bootStage === true) return true;
  return (
    typeof ev.meta?.stage === "string" && ev.id.startsWith("ephemeral_boot_")
  );
};

/**
 * 出现即视为「对话真正开始」的事件——boot 进度行整组消失。
 * user_reply 不在其中：boot 期间排队进来的用户消息不该把进度行顶没。
 */
const BOOT_SETTLING_KINDS: ReadonlySet<string> = new Set([
  "assistant_message",
  "thinking",
  "tool_call",
  "tool_result",
  "ask_user_request",
  "error",
]);

/**
 * 从事件序列取「当前活跃的启动进度行」（同一时刻只显示最新一条）。
 *
 * 从尾部回扫：
 * - 先遇到 boot 行 → 它就是最新进度、返回之
 * - 先遇到任何 agent 活动（assistant/thinking/tool/error…）→ 本轮已开始、无活跃进度
 * - 扫完没有 boot 行 → null（历史回看：boot 行不落盘、reload 后天然为空）
 */
export const extractActiveBootStage = (
  events: readonly TaskEvent[],
): TaskEvent | null => {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (isBootStageInfo(ev)) return ev;
    if (BOOT_SETTLING_KINDS.has(ev.kind)) return null;
  }
  return null;
};
