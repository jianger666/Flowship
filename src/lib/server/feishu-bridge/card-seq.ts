/**
 * 按卡片共享的 sequence 分配器
 *
 * CardKit 要求同一张卡的所有更新 sequence 严格递增。卡片会被多个模块更新
 * （card-stream 流式 / card-action 按钮终态），各自维护计数器会互相撞序号
 * （飞书拒绝 300317）——统一走这里：
 *
 * seq = max(该卡上次用过的 + 1, 当前秒级时间戳)
 *
 * - 秒级时间戳兜底：进程重启后内存计数丢失，时间戳保证仍大于历史值
 *   （卡片实体存活 14 天、毫秒会溢出 int32、秒不会——2038 年前安全）
 * - 进程内单调：同秒多次更新靠 last+1 保证严格递增
 */

const SEQ_KEY = "__feAiFlowFeishuCardSeqV1__";

/** cardId → 上次分配的 sequence（挂 globalThis，dev HMR 不丢） */
const getSeqMap = (): Map<string, number> => {
  const g = globalThis as unknown as Record<string, Map<string, number> | undefined>;
  if (!g[SEQ_KEY]) g[SEQ_KEY] = new Map();
  return g[SEQ_KEY]!;
};

const INT32_MAX = 2_147_483_647;
/** 防膨胀：卡片实体最多存活 14 天，映射超限时清最旧的一半 */
const SEQ_MAP_MAX = 1000;

/** 分配该卡下一个 sequence（严格递增、int32 内） */
export const nextCardSequence = (cardId: string): number => {
  const map = getSeqMap();
  const last = map.get(cardId) ?? 0;
  const sec = Math.floor(Date.now() / 1000);
  const next = Math.min(Math.max(last + 1, sec), INT32_MAX);
  if (map.size >= SEQ_MAP_MAX && !map.has(cardId)) {
    const keys = [...map.keys()].slice(0, Math.floor(SEQ_MAP_MAX / 2));
    for (const k of keys) map.delete(k);
  }
  map.set(cardId, next);
  return next;
};

/** 单测重置 */
export const __resetCardSeqForTest = (): void => {
  getSeqMap().clear();
};
