/**
 * 代码改动面板的「已查看」标记：纯逻辑 + 可注入存储（无 React、不碰全局 localStorage）。
 *
 * 设计要点：
 *   - **标记绑定文件签名**：只在「签名相等」时才算已查看。文件后来又被改过（签名变了）就自动失效，
 *     面板可以据此提示「看过但又变了」（isViewedStale），避免用户以为看过的内容还是当时那份。
 *   - **按任务分开存**：key 带 taskId，不同任务互不干扰，也方便任务删除时整块清理。
 *   - **存储一律走参数注入的 StorageLike**：单测用假存储，SSR / 隐私模式下传 null 即可，
 *     浏览器默认实现只在 getBrowserStorage() 里，并对「访问 localStorage 就抛」做 try/catch。
 *   - **读写都容错**：这只是体验层的便利标记，坏数据 / 配额满都不能影响面板主流程，
 *     所以 load 回落空 map、save 静默吞异常。
 *   - **用数组存、保序**：格式 v1 `{"v":1,"e":[[key,signature],...]}`，数组顺序即「最早 → 最新」，
 *     用来实现超上限时丢最早的。
 *   - **原型安全**：map 一律用 `Object.create(null)` 构造、读取用 `Object.hasOwn`，
 *     且直接拒绝 `__proto__` 这个 key，避免调用方后续用普通对象展开 / 赋值时被污染原型。
 *
 * 已知限制：map 是 Record，JS 对「整数形态的 key」（如 "123"）会按数值序而非插入序枚举，
 * 此时「丢最早 / 挪到末尾」的顺序不保证。实际 entryKey 含路径，不会是纯整数，故不为此引入 Map。
 */

import type { TaskChangeScope } from "../types";
import { formatChangeScope } from "./scope";

/**
 * 「已查看」的存储命名空间 = 任务 + 比较口径。
 *
 * 同一个文件在不同口径下是不同的 diff（「整条分支」与「仅未提交」旧侧不同、行数不同、指纹不同）：
 * 在一个口径里看过的，不能在另一个口径里显示成「看过之后又变了」；反过来也不能互相覆盖——各存各的。
 * 口径 = 范围（单个提交连 sha 一起）；手动基线只影响「整条分支」，其余两种范围与基线无关，不并入。
 * 「忽略空白」只是显示选项，不并入（并入的话每切一次空白开关，标记就全丢了）。
 */
export const viewedNamespace = (
  taskId: string,
  scope: TaskChangeScope,
  baseRef: string | null,
): string => {
  const baseKey = scope.kind === "branch" && baseRef ? `@${baseRef}` : "";
  return `${taskId}::${formatChangeScope(scope)}${baseKey}`;
};

/** 最小存储接口；浏览器 localStorage 与测试假存储都满足它 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** entryKey → 标记时的文件签名 */
export type ViewedMap = Readonly<Record<string, string>>;

/** 单个任务最多保留的「已查看」条目数；超出时丢弃最早插入的 */
export const MAX_VIEWED_ENTRIES = 3000;

const STORAGE_VERSION = 1;
const STORAGE_PREFIX = "flowship:changes-viewed:";
/** 拒绝的 key：作为普通对象的属性名会改写原型 */
const FORBIDDEN_KEY = "__proto__";

/**
 * 浏览器 localStorage；SSR / 隐私模式 / 被禁用（访问就抛）时返回 null。
 * 这是本模块里唯一接触全局存储的地方。
 */
export const getBrowserStorage = (): StorageLike | null => {
  try {
    if (typeof window === "undefined") return null;
    const storage = window.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
};

/** 某个任务的存储 key */
export const viewedStorageKey = (taskId: string): string => `${STORAGE_PREFIX}${taskId}`;

const emptyMap = (): Record<string, string> => Object.create(null) as Record<string, string>;

const hasKey = (map: ViewedMap, key: string): boolean => Object.hasOwn(map, key);

/** 取最后 MAX 条（保序） */
const capEntries = (entries: Array<[string, string]>): Array<[string, string]> =>
  entries.length > MAX_VIEWED_ENTRIES ? entries.slice(entries.length - MAX_VIEWED_ENTRIES) : entries;

/** 读：存储为空 / JSON 坏 / 版本不对 / 字段类型不对 → {}；个别条目坏就丢掉那条、保留其余 */
export const loadViewed = (storage: StorageLike | null, taskId: string): ViewedMap => {
  if (!storage) return emptyMap();
  let parsed: unknown;
  try {
    const raw = storage.getItem(viewedStorageKey(taskId));
    if (raw === null || raw === undefined || raw === "") return emptyMap();
    parsed = JSON.parse(raw);
  } catch {
    return emptyMap();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyMap();
  const doc = parsed as { v?: unknown; e?: unknown };
  if (doc.v !== STORAGE_VERSION || !Array.isArray(doc.e)) return emptyMap();

  // 重复 key 以后出现者为准且视为最新：先收集成保序数组再落到 map
  const ordered = new Map<string, string>();
  for (const entry of doc.e as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, signature] = entry as [unknown, unknown];
    if (typeof key !== "string" || typeof signature !== "string") continue;
    if (key === "" || key === FORBIDDEN_KEY) continue;
    ordered.delete(key);
    ordered.set(key, signature);
  }
  const out = emptyMap();
  for (const [k, s] of capEntries([...ordered])) out[k] = s;
  return out;
};

/**
 * 写：序列化失败 / setItem 抛错（配额满）一律静默吞；
 * 超过 MAX_VIEWED_ENTRIES 时丢弃最早插入的；空 map 时 removeItem（不留垃圾 key）。
 */
export const saveViewed = (storage: StorageLike | null, taskId: string, map: ViewedMap): void => {
  if (!storage) return;
  try {
    const entries: Array<[string, string]> = [];
    for (const key of Object.keys(map)) {
      const signature = map[key];
      if (typeof signature === "string") entries.push([key, signature]);
    }
    const key = viewedStorageKey(taskId);
    if (entries.length === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify({ v: STORAGE_VERSION, e: capEntries(entries) }));
  } catch {
    // 配额满 / 存储被禁用：标记丢了不影响主流程
  }
};

/** 「已查看」只在签名相等时成立：文件后来又被改过（签名变了）就自动失效，要重新看 */
export const isViewed = (map: ViewedMap, key: string, signature: string): boolean =>
  hasKey(map, key) && map[key] === signature;

/** 「看过但后来又变了」：map 里有这个 key 但签名不一致 */
export const isViewedStale = (map: ViewedMap, key: string, signature: string): boolean =>
  hasKey(map, key) && map[key] !== signature;

/** 标记已查看：返回新对象、不改入参；已存在的 key 挪到末尾（视为最新） */
export const markViewed = (map: ViewedMap, key: string, signature: string): ViewedMap => {
  if (key === "" || key === FORBIDDEN_KEY) return map;
  const out = emptyMap();
  for (const k of Object.keys(map)) {
    if (k !== key) out[k] = map[k];
  }
  out[key] = signature;
  return out;
};

/** 取消标记：返回新对象、不改入参；key 不存在时原样返回 */
export const unmarkViewed = (map: ViewedMap, key: string): ViewedMap => {
  if (!hasKey(map, key)) return map;
  const out = emptyMap();
  for (const k of Object.keys(map)) {
    if (k !== key) out[k] = map[k];
  }
  return out;
};

/** 只保留 liveKeys 里还存在的条目（文件已不在改动列表里就清掉）；无变化时原样返回 */
export const pruneViewed = (map: ViewedMap, liveKeys: ReadonlySet<string>): ViewedMap => {
  const keys = Object.keys(map);
  if (keys.every((k) => liveKeys.has(k))) return map;
  const out = emptyMap();
  for (const k of keys) {
    if (liveKeys.has(k)) out[k] = map[k];
  }
  return out;
};
