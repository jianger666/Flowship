/**
 * 「损坏任务」提示的「忽略」记忆（第三轮 R9a-04）
 *
 * 背景：数据目录里的 V0.5 遗留 / 旧 schema / 新版回滚后旧版读不了的任务目录，应用既不能修也不提供删除，
 * 侧栏却每次打开都挂「N 个任务数据损坏」——用户只能手改 JSON 或永远带着这条警告。
 * 这里给一个「忽略」：把 `id|kind` 记进 localStorage（纯本地便利状态、按 origin 隔离、丢了重新提示即可），
 * 被忽略的条目不再计入提示条；同一个任务后来换了损坏类别（比如 empty → invalid_json）会作为新问题重新亮出来。
 *
 * 纯函数 + 可注入的 storage（可在 node 测，无 React 依赖）。
 */

import type { CorruptTaskInfo } from "./corrupt-task";

export const CORRUPT_DISMISSED_KEY = "flowship:corrupt-tasks-dismissed";

/** 最多记多少条，防止异常数据把 localStorage 撑大 */
export const CORRUPT_DISMISSED_MAX = 200;

export type DismissStorage = Pick<Storage, "getItem" | "setItem">;

export const corruptDismissKey = (info: Pick<CorruptTaskInfo, "id" | "kind">): string =>
  `${info.id}|${info.kind}`;

/** 读已忽略的 key 集合（坏数据 / 非数组 / 没有 storage 一律回空） */
export const readDismissedCorrupt = (storage: DismissStorage | null): string[] => {
  if (!storage) return [];
  try {
    const raw = storage.getItem(CORRUPT_DISMISSED_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
  } catch {
    return [];
  }
};

export const writeDismissedCorrupt = (
  storage: DismissStorage | null,
  keys: readonly string[],
): void => {
  if (!storage) return;
  try {
    storage.setItem(
      CORRUPT_DISMISSED_KEY,
      JSON.stringify(keys.slice(-CORRUPT_DISMISSED_MAX)),
    );
  } catch {
    // 写失败（隐私模式 / 配额）：忽略只在本次会话生效，不影响功能
  }
};

/** 把一批损坏任务加入已忽略集合（去重），返回新集合 */
export const dismissCorrupt = (
  prev: readonly string[],
  infos: readonly Pick<CorruptTaskInfo, "id" | "kind">[],
): string[] => {
  const set = new Set(prev);
  for (const info of infos) set.add(corruptDismissKey(info));
  return [...set];
};

/** 过滤掉已忽略的条目 */
export const visibleCorruptTasks = <T extends Pick<CorruptTaskInfo, "id" | "kind">>(
  corrupt: readonly T[],
  dismissed: readonly string[],
): T[] => {
  if (dismissed.length === 0) return [...corrupt];
  const set = new Set(dismissed);
  return corrupt.filter((c) => !set.has(corruptDismissKey(c)));
};

/**
 * 清掉已不在当前损坏列表里的忽略记录（任务修好 / 删掉之后再坏要重新提示）。
 *
 * 空列表有两种含义：「真的没有损坏了」（该清——Q8-04：唯一一条被忽略的任务修好后，
 * 同类别再坏必须重新提示）与「还没加载 / 加载失败」（不能清，会把用户的忽略全丢了）。
 * 调用方用 `listTrusted`（= 列表已加载且最近一次拉取没失败）区分：
 * - listTrusted:true → 空列表也清；
 * - 缺省 / false → 空列表保持不动（保守，旧行为）。
 */
export const pruneDismissedCorrupt = (
  dismissed: readonly string[],
  corrupt: readonly Pick<CorruptTaskInfo, "id" | "kind">[],
  opts: { listTrusted?: boolean } = {},
): string[] => {
  if (corrupt.length === 0 && opts.listTrusted !== true) return [...dismissed];
  const live = new Set(corrupt.map(corruptDismissKey));
  return dismissed.filter((k) => live.has(k));
};
