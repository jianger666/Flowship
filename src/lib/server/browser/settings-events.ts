/**
 * A7：主进程 → server 的「设置事件」（契约 §15.2 S2）。
 *
 * 场景：`browser_evaluate` 没开总闸时，主进程弹审批卡；用户选「永久开启」→ 主进程 `emitEvent("settings_set", taskId, { key, value })`，
 * 这里收到后把对应设置置 true（走 settings-fs 的原子写入，与设置页的 PATCH /api/settings 同一条路径：写锁内读改写 →
 * `onSettingsWritten` → 浏览器设置缓存刷新 → `bridge.syncConfig` 推回主进程）。
 *
 * # 为什么只认一对白名单键值
 * 主进程不直接碰 config.json（桌面壳不该持有「改任意设置」的能力）；而 server 也不能变成「主进程说改什么就改什么」的通道——
 * 否则主进程侧任何一处缺陷（或被页面影响的字段）都能顺着这条事件改掉 API Key / 仓库列表等敏感设置。
 * 所以这里是硬编码白名单：**只有 `{ key: "browserEvaluateEnabled", value: true }`** 会被执行，
 * 别的键、`value: false`、非布尔值、非法 taskId、当前没有会话的 taskId 一律忽略（只记一行 warn，不报错、不回传）。
 * 「关闭」永远只能用户在设置页自己关：事件通道只能放开到「用户在审批卡上亲手点了永久开启」这一种。
 *
 * # 为什么轻量
 * 只依赖 bridge.ts / settings.ts / settings-fs（instrumentation 与 getBrowserTools 里都会加载，不能拖 SDK 等重模块）。
 * 注册由 `getBrowserTools` 触发（会话创建时必然经过；evaluate 审批只会发生在已有会话里），按 bridge 实例去重，
 * 注册前到达的事件由 bridge 的事件缓冲（20 条 / 60 秒）补发。
 */

import { getBrowserBridge, type BrowserBridge } from "./bridge";
import { BROWSER_EVALUATE_SETTING_KEY } from "./settings";
import { patchSettingsFile } from "../settings-fs";

/** 主进程发来的事件名 */
export const SETTINGS_SET_EVENT = "settings_set";

/** 白名单：键 → 唯一允许的值。要新增放开项必须改这里并补测试 */
export const SETTINGS_SET_ALLOWED: Readonly<Record<string, true>> = Object.freeze({
  [BROWSER_EVALUATE_SETTING_KEY]: true,
});

/** 与主进程 / server 其它处同口径的 taskId 形态（字母数字 _ -，≤200） */
const TASK_ID_RE = /^[a-zA-Z0-9_-]{1,200}$/;

export type SettingsEventOutcome =
  | { kind: "applied"; key: string }
  | { kind: "ignored"; reason: string }
  | { kind: "failed"; reason: string };

export interface SettingsEventDeps {
  /** 该任务当前在主进程里是否有浏览器会话 */
  hasSession: (taskId: string) => Promise<boolean>;
  /** 把某个（已通过白名单的）设置置 true；返回是否写成功 */
  setTrue: (key: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  warn?: (msg: string) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 纯校验：事件数据是否是白名单里的一对键值（不看 taskId / 会话） */
export const parseSettingsSetData = (data: unknown): { ok: true; key: string } | { ok: false; reason: string } => {
  if (!isRecord(data)) return { ok: false, reason: "数据不是对象" };
  const key = data.key;
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(SETTINGS_SET_ALLOWED, key)) {
    return { ok: false, reason: `键不在白名单内：${String(key).slice(0, 40)}` };
  }
  // 严格等于 true：false / "true" / 1 都不行（关闭只能用户在设置页自己做）
  if (data.value !== SETTINGS_SET_ALLOWED[key]) return { ok: false, reason: `值不被允许（${key} 只接受 true）` };
  return { ok: true, key };
};

/** 处理一次 settings_set：校验 → 写设置。永不抛 */
export const handleSettingsSetEvent = async (
  taskId: unknown,
  data: unknown,
  deps: SettingsEventDeps,
): Promise<SettingsEventOutcome> => {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const ignore = (reason: string): SettingsEventOutcome => {
    warn(`[browser-settings-event] 已忽略 settings_set：${reason}`);
    return { kind: "ignored", reason };
  };
  if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) return ignore("taskId 不合法");
  const parsed = parseSettingsSetData(data);
  if (!parsed.ok) return ignore(parsed.reason);
  let exists = false;
  try {
    exists = await deps.hasSession(taskId);
  } catch {
    exists = false;
  }
  if (!exists) return ignore("该任务当前没有浏览器会话");
  try {
    const r = await deps.setTrue(parsed.key);
    if (!r.ok) {
      warn(`[browser-settings-event] 写设置失败：${r.reason}`);
      return { kind: "failed", reason: r.reason };
    }
    return { kind: "applied", key: parsed.key };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`[browser-settings-event] 写设置失败：${reason}`);
    return { kind: "failed", reason };
  }
};

/** 默认依赖：会话存在性问主进程（status op），写设置走 settings-fs 的字段级补丁（与 PATCH /api/settings 同路径） */
export const defaultSettingsEventDeps = (bridge: BrowserBridge): SettingsEventDeps => ({
  hasSession: async (taskId) => {
    const r = (await bridge.request(taskId, "status", {}, { timeoutMs: 3000 })) as { exists?: unknown } | null;
    return r?.exists === true;
  },
  setTrue: async (key) => {
    const result = await patchSettingsFile({ patch: { [key]: true } });
    if (result.status === "ok") return { ok: true };
    if (result.status === "missing") return { ok: false, reason: "配置文件还不存在" };
    return { ok: false, reason: `配置文件不可读：${result.reason}` };
  },
});

const registeredBridges = new WeakSet<BrowserBridge>();

/**
 * 挂上 `evt settings_set` 处理器（按 bridge 实例幂等）。没有桥（无 IPC 通道）什么都不做，之后有了还能再挂。
 * @param deps 仅测试注入；生产走 {@link defaultSettingsEventDeps}
 */
export const ensureBrowserSettingsEventsRegistered = (deps?: SettingsEventDeps): void => {
  const bridge = getBrowserBridge();
  if (!bridge || registeredBridges.has(bridge)) return;
  registeredBridges.add(bridge);
  const d = deps ?? defaultSettingsEventDeps(bridge);
  bridge.onEvent(SETTINGS_SET_EVENT, ({ taskId, data }) => handleSettingsSetEvent(taskId, data, d).then(() => undefined));
};
