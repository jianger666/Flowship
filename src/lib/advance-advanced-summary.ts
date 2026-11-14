/**
 * 推进弹窗「高级选项」折叠区：适用项判定 + 折叠头取值摘要（纯函数、可单测；client / server 都能 import）
 *
 * 背景：近期推进里 dev 97% / ship 80% / review 72% / build 43% 没写任何指令——用户基本是「弹窗 → 点推进」，
 * 续用 agent / 模型 / 合并后删源分支这类低频运行参数每次都摆在面前是噪音。折进默认收起的「高级」区后，
 * 折叠头必须仍让用户**一眼看到这次实际会怎么跑**——这里负责生成那串摘要，组件只管渲染。
 *
 * 只折「纯运行参数」，会决定对外副作用走向的选项（dev 直推 / 提 PR、批次选择、plan 重规划）
 * 与所有阻断性 / 警示性内容一律留主区，不经过本文件。
 *
 * 强调口径（emphasized=true → UI 用 warning 徽标标出，避免用户忘了自己改过 / 开过）：
 *  - 续用：与「打开瞬间的默认」（设置页「交互偏好」）不同就强调（双向：默认续用时改成新 agent 同样标）
 *  - 模型：id 或思考档等 params 与打开瞬间默认不同就强调；没选模型也强调（提交会被拦，需要用户处理）
 *  - 提供方：弹窗内换了家一律强调（上下文代价大）
 *  - 合并后删源分支：开着就强调——不可逆倾向，哪怕 task 上次选的就是开，也每次提醒
 */

import { modelSelectionKey } from "@/lib/task-model";
import type { ActionType, ModelSelection } from "@/lib/types";

/** 当前 action 下高级区里有哪些项适用 */
export interface AdvancedItems {
  /**
   * 运行参数块：续用当前 agent + 提供方 / 模型（同一视觉块、同进同退）。
   * 推进 payload 对每个已选 action 都带 reuseAgent / model，所以适用面 = 所有已选 action；
   * 将来若某类 action 真不需要 agent（提交时也不带这两个字段），只在这里改一处。
   */
  agentRuntime: boolean;
  /** 合并后删源分支：仅提测（ship）有意义，其它 action 提交时 payload 里本就是 undefined */
  removeSourceBranch: boolean;
}

/** 没选中 action（全部被隐藏 / 日常任务列表还没拉到）时没有任何适用项，整个高级区不渲染 */
export const resolveAdvancedItems = (
  actionType: ActionType | null,
): AdvancedItems => {
  if (!actionType) return { agentRuntime: false, removeSourceBranch: false };
  return { agentRuntime: true, removeSourceBranch: actionType === "ship" };
};

/** 高级区是否有内容可渲染；全 false 时调用方不要渲染空折叠 */
export const hasAdvancedItems = (items: AdvancedItems): boolean =>
  items.agentRuntime || items.removeSourceBranch;

export type AdvancedSummaryKey = "reuse" | "provider" | "model" | "removeSource";

/** 摘要的一段；emphasized 由 UI 映射成 warning 徽标 */
export interface AdvancedSummarySegment {
  key: AdvancedSummaryKey;
  text: string;
  emphasized: boolean;
}

export interface AdvancedSummaryInput {
  actionType: ActionType | null;
  /** 本次提交实际生效的续用值（调用方已叠加「换了提供方 = 必然新会话」） */
  reuseAgent: boolean;
  /** 打开瞬间的续用默认（设置页「交互偏好」的 reuseAgentDefault） */
  reuseAgentDefault: boolean;
  /** 弹窗内是否换了提供方（跟打开瞬间快照比） */
  providerChanged: boolean;
  /** 当前选中提供方的展示名（只在 providerChanged 时用） */
  providerLabel: string;
  /** 当前选中的模型（含思考档等 params） */
  model: ModelSelection;
  /** 打开瞬间的默认模型（task 最近 action → task.model → 设置页默认），判断「是否偏离默认」 */
  defaultModel: ModelSelection;
  /** 模型短标签（与模型下拉 trigger 同源 compactModelLabel）；空串回退用 model.id */
  modelLabel: string;
  /** 思考档标签（与模型下拉 trigger 同源 resolveThinkingTriggerLabel）；没有思考档为 null */
  thinkingLabel?: string | null;
  /** 合并后是否删源分支（仅 ship 才会进摘要） */
  removeSourceBranch: boolean;
}

// 提供方展示名上限：自建提供方名字不受控，摘要又挤在一行里，超长截断防撑破弹窗
const PROVIDER_LABEL_MAX = 12;

const truncateLabel = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}…` : s;

const modelSegment = (input: AdvancedSummaryInput): AdvancedSummarySegment => {
  const id = input.model.id.trim();
  // 没选模型：点推进会被父组件 prepareRunArgs 拦下，摘要必须醒目提示
  if (!id) return { key: "model", text: "未选模型", emphasized: true };
  const label = input.modelLabel.trim() || id;
  const thinking = input.thinkingLabel?.trim();
  return {
    key: "model",
    text: thinking ? `${label}（${thinking}）` : label,
    // 复用 modelSelectionKey：params 按 id 排序后比对，顺序差不算换了模型
    emphasized:
      modelSelectionKey(input.model) !== modelSelectionKey(input.defaultModel),
  };
};

/**
 * 折叠头摘要段（按固定顺序：续用 → 提供方 → 模型 → 删源分支）；没有适用项返回空数组。
 * 续用时不列提供方 / 模型：续接旧会话不能换模型（服务端走 task.model），列出来反而误导。
 */
export const buildAdvancedSummary = (
  input: AdvancedSummaryInput,
): AdvancedSummarySegment[] => {
  const items = resolveAdvancedItems(input.actionType);
  const segments: AdvancedSummarySegment[] = [];
  if (items.agentRuntime) {
    segments.push({
      key: "reuse",
      text: input.reuseAgent ? "续用当前 agent" : "新 agent",
      emphasized: input.reuseAgent !== input.reuseAgentDefault,
    });
    if (!input.reuseAgent) {
      if (input.providerChanged) {
        segments.push({
          key: "provider",
          text: `提供方 ${truncateLabel(input.providerLabel, PROVIDER_LABEL_MAX)}`,
          emphasized: true,
        });
      }
      segments.push(modelSegment(input));
    }
  }
  if (items.removeSourceBranch) {
    segments.push({
      key: "removeSource",
      text: input.removeSourceBranch ? "合并后删除源分支" : "合并后保留源分支",
      // 删分支不可逆：开着就强调，不看它是不是「默认」
      emphasized: input.removeSourceBranch,
    });
  }
  return segments;
};

/** 摘要的纯文本形态（「高级 · 新 agent · sonnet-5 · 合并后保留源分支」）：测试 / 日志 / 读屏兜底用 */
export const formatAdvancedSummary = (
  segments: readonly AdvancedSummarySegment[],
): string => ["高级", ...segments.map((s) => s.text)].join(" · ");
