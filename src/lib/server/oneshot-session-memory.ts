/**
 * 聊天通道（属主「一次性 agent」，`startOneShotQuestion`）的对话记忆。
 *
 * 为什么要有：任务还没推进过 / 阶段早已完结、会话又接不回时，输入条的每条消息都起一个全新的 agent
 * （上下文只能靠它自己去读事件日志）——一句一句冷启动，不像在聊天。这里只记住「上一轮那个 agent 的
 * agentId」：它答完照旧 close（不占内存、没有空闲计时器），下一条消息 `Agent.resume` 把同一段对话接回来，
 * 和正式会话的「休眠 / 唤醒」是同一套思路。
 *
 * 刻意**不是**正式会话：不进 `agentSessions`、不写 meta 锚点——一次性 agent 没有 action 这条链，混进去会被
 * 「续用推进」当成正式会话。接不回（存储被清 / 会话文件没了 / 换了模型 / 换了提供方）一律退回现状：
 * 新起一个、带完整背景。
 *
 * 失效（`invalidate`，会推进 epoch）：正式会话装进来（action 开始）——那是上下文边界，之前的聊天记忆作废；
 * 推进 epoch 是为了堵「旧 one-shot 刚好在这之后才收尾、把过期的记忆又写回去」的竞态（见 `rememberOneShotMemory`）。
 * 丢弃（`discard`，不推进 epoch）：这一轮没有干净结束 / 接不回——只是不再用这条记忆。
 *
 * 状态挂 globalThis：dev HMR / 多 chunk 下模块级 Map 会分裂（同 task-talk-queue / chat-gate 做法）。
 * 纯内存：服务重启后记忆没了，下一条消息冷启动（和这个功能之前一样），不算回归。
 */

import type { ModelSelection } from "@/lib/types";

/** 记忆多久不用就作废：聊天可以隔很久再回来，但太久任务多半已经变了，让它重新读日志更稳 */
export const ONESHOT_MEMORY_TTL_MS = 6 * 60 * 60 * 1000;
/** 同一段对话最多接力的轮数：防对话无限增长拖慢 resume / 撑爆上下文，到顶就换个新的起头 */
export const ONESHOT_MEMORY_MAX_TURNS = 40;
/** 记着的任务数上限（超出挤掉最久没动的）：每条只有几个字符串，纯防无界增长 */
export const ONESHOT_MEMORY_MAX_TASKS = 200;

export interface OneShotMemory {
  /** 上一轮 agent 的 agentId（Cursor：SDK 存储里的 id；pi：会话文件路径）——`Agent.resume` 的入参 */
  agentId: string;
  /** 解析好的提供方 id：换了提供方就不能接（两套后端的会话互不认） */
  providerId: string;
  /** 模型指纹（id + 参数）：会话的模型锁死换不了，换了模型就不接 */
  modelKey: string;
  /** 工作目录：本地 agent 按 cwd 定位持久化存储，必须和上一轮一致 */
  cwd: string;
  /** 上一轮告诉过它的需求群 chat_id（没绑 = null）：变了要在这一轮补一句 */
  boundChatId: string | null;
  /** 已经接力了几轮（首轮 = 1） */
  turns: number;
  savedAt: number;
}

/** 接记忆前要对的几项：任何一项不同都不接 */
export interface OneShotMemoryWant {
  providerId: string;
  modelKey: string;
  cwd: string;
}

interface Slot {
  /** 每次 invalidate +1；一轮 one-shot 入场时抓一份，收尾写记忆时对不上就不写 */
  epoch: number;
  mem: OneShotMemory | null;
}

const GLOBAL_KEY = "__flowshipOneShotMemoryV1__";

const getSlots = (): Map<string, Slot> => {
  const g = globalThis as unknown as Record<string, Map<string, Slot> | undefined>;
  if (!(g[GLOBAL_KEY] instanceof Map)) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
};

/**
 * 写一个槽：先删再放保持「迭代序 = 最近写入序」，超限时从头部挤最久没动的。
 * epoch 墓碑（mem 为 null）也算一条：被挤掉后 epoch 读回 0，在飞的旧 one-shot 入场时抓的值对不上就拒写（安全方向）。
 */
const putSlot = (taskId: string, slot: Slot): void => {
  const slots = getSlots();
  slots.delete(taskId);
  slots.set(taskId, slot);
  while (slots.size > ONESHOT_MEMORY_MAX_TASKS) {
    const oldest = slots.keys().next().value;
    if (oldest === undefined) break;
    slots.delete(oldest);
  }
};

/** 模型指纹：同一个模型、同一组参数 = 同一个 key（参数顺序无关） */
export const oneShotModelKey = (model: ModelSelection | undefined | null): string => {
  const id = model?.id?.trim() ?? "";
  const params = [...(model?.params ?? [])]
    .map((p) => `${p.id}=${p.value}`)
    .sort()
    .join("&");
  return `${id}|${params}`;
};

/** 入场时抓：这一轮收尾写记忆前，epoch 没变才算「这期间没有正式 action 开始」 */
export const getOneShotMemoryEpoch = (taskId: string): number =>
  getSlots().get(taskId)?.epoch ?? 0;

/** 取可用的记忆：过期 / 轮数到顶的当场清掉并返回 null */
export const peekOneShotMemory = (
  taskId: string,
  now: number = Date.now(),
): OneShotMemory | null => {
  const slot = getSlots().get(taskId);
  const mem = slot?.mem;
  if (!slot || !mem) return null;
  if (now - mem.savedAt > ONESHOT_MEMORY_TTL_MS || mem.turns >= ONESHOT_MEMORY_MAX_TURNS) {
    slot.mem = null;
    return null;
  }
  return mem;
};

/** 记忆和这一轮的提供方 / 模型 / 工作目录是否对得上（纯函数） */
export const oneShotMemoryMatches = (
  mem: OneShotMemory,
  want: OneShotMemoryWant,
): boolean =>
  mem.providerId === want.providerId &&
  mem.modelKey === want.modelKey &&
  mem.cwd === want.cwd;

/**
 * 干净结束后记下这一轮的 agent。`expectedEpoch` 是入场时抓的：对不上 = 这期间有正式会话装进来过
 * （action 已经开始），这条记忆属于旧上下文，不写。返回是否写入。
 */
export const rememberOneShotMemory = (
  taskId: string,
  mem: OneShotMemory,
  expectedEpoch: number,
): boolean => {
  const slot = getSlots().get(taskId);
  if ((slot?.epoch ?? 0) !== expectedEpoch) return false;
  putSlot(taskId, { epoch: expectedEpoch, mem });
  return true;
};

/** 不再用这条记忆（接不回 / 这一轮没干净结束）；不推进 epoch，不影响本轮之后正常写入新的 */
export const discardOneShotMemory = (taskId: string): void => {
  const slot = getSlots().get(taskId);
  if (slot) slot.mem = null;
};

/** 上下文边界（正式会话装进来 / action 开始）：记忆作废，并推进 epoch 让在飞的旧 one-shot 写不回去 */
export const invalidateOneShotMemory = (taskId: string): void => {
  const slot = getSlots().get(taskId);
  putSlot(taskId, { epoch: (slot?.epoch ?? 0) + 1, mem: null });
};

/** 测试钩子：清空 */
export const __resetOneShotMemoryForTest = (): void => {
  getSlots().clear();
};
