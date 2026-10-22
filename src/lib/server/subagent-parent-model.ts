/**
 * 父会话模型登记（给事件流里的子代理卡片徽标用）。
 *
 * 为什么单拆一个模块：写的一方（cursor-subagent，经 facade 给父 agent 挂 `subagent` 时登记）和读的一方
 * （task-runner / chat-runner，消费消息流时取）要共用这张表，但 runner 的测试普遍 mock 掉 agent-backend，
 * 读方不能从 agent-backend / cursor-subagent（会拖进 @cursor/sdk）取——放在无依赖的小模块里两边都安全。
 *
 * 表挂 globalThis：Next 的多个路由 chunk / dev HMR 可能各 import 一份本模块，登记和读取必须是同一张表。
 * 键是 facade 返回给调用方的那个（包了取消联动的）父 agent 对象，WeakMap——agent 释放表项自动消失。
 */
import type { SubagentDisplayLookup } from "@/lib/cursor-subagent-display";
import type { SubagentModelSelection } from "@/lib/subagent-spec";

type ParentModelMap = WeakMap<object, SubagentModelSelection | undefined>;
type DisplayLookupMap = WeakMap<object, SubagentDisplayLookup>;
type Holder = typeof globalThis & {
  __flowshipSubagentParentModels?: ParentModelMap;
  __flowshipSubagentDisplayLookups?: DisplayLookupMap;
};

const table = (): ParentModelMap => {
  const g = globalThis as Holder;
  g.__flowshipSubagentParentModels ??= new WeakMap();
  return g.__flowshipSubagentParentModels;
};

/** facade 给父 agent 挂 `subagent` 时登记它的当前模型（没显式选模型 → undefined 也要登记，表示「挂了子代理」） */
export const setSubagentParentModel = (
  agent: object,
  model: SubagentModelSelection | undefined,
): void => {
  table().set(agent, model);
};

/**
 * 读某个父 agent 的当前模型。事件流把 `subagent` 调用改写成卡片时，子代理「沿用」就显示这个实际模型 / 思考档，
 * 而不是模型随手写的 `inherit`。不是 Cursor 路径 / 没挂 subagent 的 agent → undefined（徽标保持原始入参）。
 */
export const getSubagentParentModel = (
  agent: unknown,
): SubagentModelSelection | undefined =>
  agent !== null && typeof agent === "object"
    ? table().get(agent)
    : undefined;

const lookupTable = (): DisplayLookupMap => {
  const g = globalThis as Holder;
  g.__flowshipSubagentDisplayLookups ??= new WeakMap();
  return g.__flowshipSubagentDisplayLookups;
};

/**
 * facade 给父 agent 挂 `subagent` 时登记「查子代理实际模型 / 思考档」的同步查表函数
 *（该模型的默认档、resume 那个子代理当初用的模型）。与父模型同键、同生命周期。
 */
export const setSubagentDisplayLookup = (
  agent: object,
  lookup: SubagentDisplayLookup,
): void => {
  lookupTable().set(agent, lookup);
};

/** 读某个父 agent 的查表函数；不是 Cursor 路径 / 没挂 subagent 的 agent → undefined（徽标不补默认档、resume 不补模型） */
export const getSubagentDisplayLookup = (
  agent: unknown,
): SubagentDisplayLookup | undefined =>
  agent !== null && typeof agent === "object"
    ? lookupTable().get(agent)
    : undefined;
