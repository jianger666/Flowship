/**
 * 最近工作目录 MRU（chat 自由对话的工作目录选择器用）
 *
 * 纯本地便利缓存：存 localStorage、按 origin 隔离、丢了重新积累即可——
 * 不进 config.json（不是权威配置、不需要跨端 / 跨实例同步）。
 *
 * 语义：push 最新选的目录到队首、去重、最多留 MAX 个。
 */

const KEY = "flowship:recent-workdirs";
// 最多记几个最近目录（够覆盖「几个项目间来回切」、再多下拉就太长）
const MAX = 5;

const isBrowser = (): boolean =>
  typeof window !== "undefined" && typeof window.localStorage !== "undefined";

// 读最近目录列表（坏数据 / 非数组一律回空）
export const getRecentWorkdirs = (): string[] => {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
  } catch (err) {
    console.warn("[recent-workdirs] localStorage 损坏、忽略", err);
    return [];
  }
};

// push 一个目录到「最近」队首（去重 + 截断）、返回更新后的列表（调用方可直接 setState）
export const pushRecentWorkdir = (path: string): string[] => {
  const prev = getRecentWorkdirs();
  if (!isBrowser() || !path) return prev;
  // 同路径去重后置顶 + 截断到 MAX
  const next = [path, ...prev.filter((p) => p !== path)].slice(0, MAX);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch (err) {
    console.warn("[recent-workdirs] 写 localStorage 失败", err);
  }
  return next;
};
