/**
 * 代码改动面板的偏好（全局共享、跨任务）：纯逻辑 + 可注入存储。
 *
 * 为什么是「字段级」校验而不是整体校验：
 *   偏好会随版本新增字段，也可能被手改或写坏。整体校验失败就全部重置，用户会觉得
 *   「我只是少了个字段，为什么把我的分栏设置也丢了」；逐字段回落默认值能保住其余设置。
 *   未知字段一律丢弃（读时不带出、写时不落盘），避免旧 / 新版本互相污染。
 *
 * 存储通过参数注入（StorageLike 来自 viewed-store），读写都不抛异常——偏好只是体验层便利。
 */

import type { StorageLike } from "@/lib/changes/viewed-store";

/** 面板偏好 */
export interface DiffPrefs {
  /** 统一 / 分栏 */
  view: "unified" | "split";
  /** 忽略空白差异 */
  ignoreWs: boolean;
  /** 文件列表：目录树 / 平铺 */
  treeMode: "tree" | "flat";
  /** 面板加宽（几乎占满窗口，左侧留出系统窗口控件的位置） */
  wide: boolean;
  /** 左侧文件栏收起 */
  treeHidden: boolean;
}

/** 默认偏好 */
export const DEFAULT_DIFF_PREFS: DiffPrefs = {
  view: "unified",
  ignoreWs: false,
  treeMode: "tree",
  wide: false,
  treeHidden: false,
};

/** 偏好的存储 key（带版本号，格式不兼容时升版本即可整体弃用旧数据） */
export const DIFF_PREFS_STORAGE_KEY = "flowship:changes-prefs:v1";

const pickBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

/**
 * 读偏好：字段级校验，坏字段回落默认值、其余字段保留；JSON 坏 / 非对象 / 存储为空 → 全默认。
 * 总是返回新对象，调用方改它不会污染 DEFAULT_DIFF_PREFS。
 */
export const loadDiffPrefs = (storage: StorageLike | null): DiffPrefs => {
  const defaults: DiffPrefs = { ...DEFAULT_DIFF_PREFS };
  if (!storage) return defaults;
  let parsed: unknown;
  try {
    const raw = storage.getItem(DIFF_PREFS_STORAGE_KEY);
    if (raw === null || raw === undefined || raw === "") return defaults;
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return defaults;
  const o = parsed as Record<string, unknown>;
  return {
    view: o.view === "unified" || o.view === "split" ? o.view : defaults.view,
    ignoreWs: pickBool(o.ignoreWs, defaults.ignoreWs),
    treeMode: o.treeMode === "tree" || o.treeMode === "flat" ? o.treeMode : defaults.treeMode,
    wide: pickBool(o.wide, defaults.wide),
    treeHidden: pickBool(o.treeHidden, defaults.treeHidden),
  };
};

/** 写偏好：只落盘已知字段；setItem 抛错（配额满 / 被禁用）一律静默吞 */
export const saveDiffPrefs = (storage: StorageLike | null, prefs: DiffPrefs): void => {
  if (!storage) return;
  try {
    const clean: DiffPrefs = {
      view: prefs.view,
      ignoreWs: prefs.ignoreWs,
      treeMode: prefs.treeMode,
      wide: prefs.wide,
      treeHidden: prefs.treeHidden,
    };
    storage.setItem(DIFF_PREFS_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // 偏好丢了下次回落默认值即可，不能影响面板
  }
};
