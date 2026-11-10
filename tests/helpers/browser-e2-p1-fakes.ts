/**
 * E2·P1（页面权限 / 证书 / 认证）单测的共用替身：真 BrowserSession（真 PromptHub / 真活动日志 / 真 getState）+ 假 tab / 假 webContents。
 * 这样「凭据不进 getState / 日志 / 活动日志」「提示超时按默认动作」「会话销毁时 ext 清理」测的都是真实逻辑，只是没有 Electron。
 */
import { EventEmitter } from "node:events";
import { vi } from "vitest";

import { createActivityLog } from "../../electron-app/browser/activity-log.mjs";
import { BrowserSession } from "../../electron-app/browser/session.mjs";

export class FakeWc extends EventEmitter {}

type Emulation = Record<string, unknown>;

export class FakeTab {
  ready = Promise.resolve();
  opener: string | null = null;
  hadRecentGesture = () => true;
  destroyed = false;
  url = "about:blank";
  title = "t";
  wc = new FakeWc();
  emulation: Emulation = {};
  certOverride: unknown = null;
  promptHold: (() => Promise<unknown> | null) | null = null;
  ext = new Map<string, unknown>();
  destroyHooks = new Set<() => void>();
  emulationHooks = new Set<(e: { next: Emulation; prev: Emulation; patch: Emulation }) => void>();
  sessionHooks = new Set<(sid: string | null) => unknown>();
  cdpListeners = new Set<(method: string, params: Record<string, unknown>, sid: string | null) => void>();
  sent: Array<{ method: string; params: Record<string, unknown>; sessionId: string | null }> = [];
  /** 让某条 CDP 命令失败 / 自定义应答 */
  sendImpl: (method: string, params: Record<string, unknown>, sessionId: string | null) => Promise<unknown> = async () => ({});
  setInputIgnored = vi.fn(async () => {});
  releaseHeldButtons = vi.fn(async () => {});
  overlaySetActive = vi.fn(async () => {});
  overlayHide = vi.fn(async () => {});
  moveToMain = vi.fn();
  moveToParking = vi.fn();
  setBounds = vi.fn();
  setVisible = vi.fn();
  capturePlaceholder = vi.fn(async () => null);
  constructor(public id: string) {}
  info(isActive: boolean) {
    return { id: this.id, url: this.url, title: this.title, favicon: null, loading: false, canGoBack: false, canGoForward: false, isActive };
  }
  getExt<T>(key: string, factory: () => T): T {
    if (!this.ext.has(key)) this.ext.set(key, factory());
    return this.ext.get(key) as T;
  }
  addDestroyHook(fn: () => void) {
    this.destroyHooks.add(fn);
    return () => this.destroyHooks.delete(fn);
  }
  addEmulationHook(fn: (e: { next: Emulation; prev: Emulation; patch: Emulation }) => void) {
    this.emulationHooks.add(fn);
    return () => this.emulationHooks.delete(fn);
  }
  addSessionHook(fn: (sid: string | null) => unknown) {
    this.sessionHooks.add(fn);
    return () => this.sessionHooks.delete(fn);
  }
  onCdpEvent(fn: (method: string, params: Record<string, unknown>, sid: string | null) => void) {
    this.cdpListeners.add(fn);
    return () => this.cdpListeners.delete(fn);
  }
  cdpSessionIds() {
    return [null];
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId: string | null = null) {
    this.sent.push({ method, params, sessionId });
    return this.sendImpl(method, params, sessionId);
  }
  /** 模拟 CDP 事件（如 Runtime.bindingCalled） */
  emitCdp(method: string, params: Record<string, unknown>, sid: string | null = null) {
    for (const fn of [...this.cdpListeners]) fn(method, params, sid);
  }
  /** 与真 tab.applyEmulation 同语义的最小实现：reset 清空，否则浅合并；成功后调 emulationHooks */
  async applyEmulation(patch: Emulation) {
    const prev = this.emulation;
    const next = patch.reset === true ? {} : { ...prev, ...patch };
    this.emulation = next;
    for (const fn of [...this.emulationHooks]) fn({ next, prev, patch });
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const fn of [...this.destroyHooks]) fn();
  }
}

export interface P1Config {
  pagePermissions: boolean;
  trustLoopbackCerts: boolean;
}

/** Flowship 自己的 origin（测试里的 app origin） */
export const APP_ORIGIN = "http://127.0.0.1:8876";

export const makeEnv = (over: Partial<P1Config> = {}) => {
  const config: P1Config = { pagePermissions: false, trustLoopbackCerts: true, ...over };
  const logs: string[] = [];
  const host = {
    createTab: ({ id }: { id: string }) => new FakeTab(id),
    getMainWindow: () => ({}),
    getParkingWindow: () => ({}),
    onChange: vi.fn(),
    emitEvent: vi.fn(),
    emitPicked: vi.fn(),
    startPicker: () => ({ cancel: vi.fn() }),
  };
  const session = new BrowserSession({
    taskId: "task-p1",
    host: host as never,
    activityLog: createActivityLog(),
    log: (m: string) => logs.push(m),
    // 动态取全局：与 vi.useFakeTimers 的先后无关
    setTimeoutFn: ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as never,
    clearTimeoutFn: ((t: never) => clearTimeout(t)) as never,
  });
  const findOwner = (wc: unknown) => {
    const tab = (session.tabs as FakeTab[]).find((t) => t.wc === wc);
    return tab ? { session, tab } : null;
  };
  const isAppUrl = (u: string) => {
    try {
      return new URL(u).origin === APP_ORIGIN;
    } catch {
      return false;
    }
  };
  const openTab = async (url = "about:blank") => {
    const tab = (await session.openTab({ activate: true })) as unknown as FakeTab;
    tab.url = url;
    return tab;
  };
  return { session, config, logs, host, findOwner, isAppUrl, openTab };
};

/** 让已排队的微任务跑完（提示回答 → then 链 → 回调） */
export const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** 第一个挂起的某类提示（没有则抛错） */
export const firstPrompt = (session: BrowserSession, kind: string) => {
  const p = (session.prompts.list() as Array<{ id: string; kind: string; host: string; detail: Record<string, string>; tabId?: string }>).find((x) => x.kind === kind);
  if (!p) throw new Error(`没有挂起的 ${kind} 提示`);
  return p;
};

/** 把任意值（含 Map / Set）序列化成一段文本，用来断言「某个字符串没有出现在整个状态里」 */
export const dumpAll = (v: unknown): string => {
  try {
    return JSON.stringify(v, (_k, val) => (val instanceof Map ? [...val.entries()] : val instanceof Set ? [...val] : val));
  } catch {
    return String(v);
  }
};
