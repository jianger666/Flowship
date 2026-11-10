/**
 * 内置浏览器的设置读取（server 侧）。
 *
 * 存储沿用现有设置的做法：config.json 顶层两个布尔键（与 `agentShellGitBash` 同款——只认显式 true，
 * 缺省 / 坏值一律 false）。**默认都关**：evaluate 能在页面里跑任意 JS、录输入值会把用户键入内容交给 AI，
 * 都得用户在设置页显式打开。
 *
 * 为什么要一份同步缓存：工具注册（`getBrowserTools`）发生在 `buildSdkCustomTools` / pi `buildCustomTools`
 * 这类同步函数里，不能 await 读盘。缓存由三处刷新：bridge 启动 / 握手成功时主动读一次、
 * settings-fs 每次写盘后的回调（见 {@link watchBrowserSettings}）、以及 {@link refreshBrowserSettings}。
 * 缓存挂 globalThis：Next 多 bundle / HMR 下共享同一份。
 *
 * 只依赖 settings-fs（轻量，instrumentation 里本来就在动态加载它），不要在这里引会话 / SDK 模块。
 */

import { onSettingsWritten, readSettingsFile } from "../settings-fs";
import type { BrowserConfig } from "./types";

/** config.json 里的键名（FeAiFlowSettings 同名字段） */
export const BROWSER_EVALUATE_SETTING_KEY = "browserEvaluateEnabled";
export const BROWSER_RECORD_INPUT_SETTING_KEY = "browserRecordInputValues";

/**
 * 增强包 E2（契约 §15）新增的 6 项：
 *  - 「放开」型（默认关，只认显式 true）：storageAccess（A1）/ pagePermissions（A8）
 *  - 「收紧」型（默认开，只认显式 false 才关）：trustLoopbackCerts（A4）/ networkBodyRead（A7）/ advancedTools（高级调试工具组）
 *  - maxTabs（C6）：5–60 的整数，缺省 / 坏值 20
 */
export const BROWSER_MAX_TABS_DEFAULT = 20;
export const BROWSER_MAX_TABS_MIN = 5;
export const BROWSER_MAX_TABS_MAX = 60;

export interface BrowserSettings {
  evaluateEnabled: boolean;
  recordInputValues: boolean;
  storageAccess: boolean;
  pagePermissions: boolean;
  trustLoopbackCerts: boolean;
  networkBodyRead: boolean;
  advancedTools: boolean;
  maxTabs: number;
}

export const BROWSER_SETTINGS_DEFAULTS: Readonly<BrowserSettings> = {
  evaluateEnabled: false,
  recordInputValues: false,
  storageAccess: false,
  pagePermissions: false,
  trustLoopbackCerts: true,
  networkBodyRead: true,
  advancedTools: true,
  maxTabs: BROWSER_MAX_TABS_DEFAULT,
};

export const normalizeBrowserMaxTabs = (v: unknown): number =>
  typeof v === "number" && Number.isInteger(v) && v >= BROWSER_MAX_TABS_MIN && v <= BROWSER_MAX_TABS_MAX
    ? v
    : BROWSER_MAX_TABS_DEFAULT;

/** 从一份原始 settings 里抽出浏览器相关项（只认显式 true） */
export const parseBrowserSettings = (
  raw: Record<string, unknown> | null | undefined,
): BrowserSettings => ({
  evaluateEnabled: raw?.[BROWSER_EVALUATE_SETTING_KEY] === true,
  recordInputValues: raw?.[BROWSER_RECORD_INPUT_SETTING_KEY] === true,
  storageAccess: raw?.browserStorageAccess === true,
  pagePermissions: raw?.browserPagePermissions === true,
  trustLoopbackCerts: raw?.browserTrustLoopbackCerts !== false,
  networkBodyRead: raw?.browserNetworkBodyRead !== false,
  advancedTools: raw?.browserAdvancedTools !== false,
  maxTabs: normalizeBrowserMaxTabs(raw?.browserMaxTabs),
});

const CACHE_KEY = "__flowshipBrowserSettingsV1__";
const WATCH_KEY = "__flowshipBrowserSettingsWatchV1__";

interface Holder {
  value: BrowserSettings;
  listeners: Set<(s: BrowserSettings) => void>;
}

const holder = (): Holder => {
  const g = globalThis as unknown as Record<string, Holder | undefined>;
  if (!g[CACHE_KEY]) {
    g[CACHE_KEY] = { value: { ...BROWSER_SETTINGS_DEFAULTS }, listeners: new Set() };
  }
  return g[CACHE_KEY]!;
};

const same = (a: BrowserSettings, b: BrowserSettings): boolean =>
  (Object.keys(BROWSER_SETTINGS_DEFAULTS) as (keyof BrowserSettings)[]).every((k) => a[k] === b[k]);

const apply = (next: BrowserSettings): void => {
  const h = holder();
  if (same(h.value, next)) return;
  h.value = next;
  for (const cb of [...h.listeners]) {
    try {
      cb({ ...next });
    } catch (err) {
      console.warn("[browser] 设置变化回调出错：", err instanceof Error ? err.message : err);
    }
  }
};

/** 同步读缓存（工具注册 / 工具 handler 用）。还没读过盘时是默认值（全关）。 */
export const getBrowserSettingsSync = (): BrowserSettings => ({ ...holder().value });

/**
 * 读盘刷新缓存。读不到（首次启动 / 文件坏）保持**原缓存**不变：
 * 这两项是「放开」型开关，读盘失败时宁可维持上一次已知值（初始为关），也不凭空打开。
 */
export const refreshBrowserSettings = async (): Promise<BrowserSettings> => {
  try {
    const result = await readSettingsFile();
    if (result.status === "ok") apply(parseBrowserSettings(result.settings));
    else if (result.status === "missing") apply({ ...BROWSER_SETTINGS_DEFAULTS });
  } catch (err) {
    console.warn("[browser] 读取浏览器设置失败：", err instanceof Error ? err.message : err);
  }
  return getBrowserSettingsSync();
};

/** 订阅设置变化（只在值真的变了才回调）；返回取消函数 */
export const onBrowserSettingsChange = (cb: (s: BrowserSettings) => void): (() => void) => {
  const h = holder();
  h.listeners.add(cb);
  return () => {
    h.listeners.delete(cb);
  };
};

/**
 * 挂到 settings-fs 的「写盘后」回调上（幂等：重复调用只挂一次）。
 * 设置页保存后立刻更新缓存并通知订阅者，bridge 据此把新的 config 推给主进程。
 */
export const watchBrowserSettings = (): void => {
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  if (g[WATCH_KEY]) return;
  g[WATCH_KEY] = true;
  onSettingsWritten((settings) => apply(parseBrowserSettings(settings)));
};

/** 缓存 → 协议里的 config 载荷 */
export const toBrowserConfig = (s: BrowserSettings = getBrowserSettingsSync()): BrowserConfig => ({
  recordInputValues: s.recordInputValues,
  evaluateEnabled: s.evaluateEnabled,
  storageAccess: s.storageAccess,
  pagePermissions: s.pagePermissions,
  trustLoopbackCerts: s.trustLoopbackCerts,
  networkBodyRead: s.networkBodyRead,
  maxTabs: s.maxTabs,
});

/** 单测复位 */
export const __resetBrowserSettingsForTest = (value?: Partial<BrowserSettings>): void => {
  const h = holder();
  h.value = { ...BROWSER_SETTINGS_DEFAULTS, ...(value ?? {}) };
  h.listeners.clear();
};
