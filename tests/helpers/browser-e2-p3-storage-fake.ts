/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 假 session 是刻意的，被测 .mjs 无类型声明 */
/**
 * E2·P3（A1 登录态）单测夹具：真实 BrowserSession + 假 tab（内存 cookie jar + 内存 DOMStorage / IndexedDB 的 CDP 应答）
 * + 真实 `ops/storage.mjs` handlers + 真实 url-policy 的 checkAiUrl（isAppUrl 用真实的 createIsAppUrl）。
 *
 * 为什么用真 session：`runAction` 的串行队列 / USER_CONTROL / 活动日志写入口径就是被测契约的一部分，
 * 用假 session 等于自己证明自己。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

import { createActivityLog } from "../../electron-app/browser/activity-log.mjs";
import { createIsAppUrl } from "../../electron-app/browser/app-origin.mjs";
import { createHandlers, normalize } from "../../electron-app/browser/ops/storage.mjs";
import { OP_HELPERS } from "../../electron-app/browser/index.mjs";
import { BrowserError } from "../../electron-app/browser/server-channel.mjs";
import { BrowserSession } from "../../electron-app/browser/session.mjs";
import { checkUrl, normalizeAiUrl } from "../../electron-app/browser/url-policy.mjs";

export { BrowserError };

export interface FakeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  session: boolean;
  hostOnly: boolean;
  expirationDate?: number;
}

const bare = (d: string) => d.replace(/^\./, "").toLowerCase();

const hostOf = (url: string) => new URL(url).hostname.replace(/^\[|\]$/g, "");

const cookieMatchesHost = (c: FakeCookie, host: string) => {
  const d = bare(c.domain);
  return c.hostOnly ? host === d : host === d || host.endsWith(`.${d}`);
};

/** 内存 cookie jar：行为贴近 Electron `session.cookies`（域 cookie 会被规范化成带前导点；secure 不能经 http URL 写入） */
export const makeFakeJar = (seed: Array<Partial<FakeCookie> & { name: string; domain: string }> = []) => {
  const store: FakeCookie[] = [];
  const norm = (c: Partial<FakeCookie> & { name: string; domain: string }): FakeCookie => ({
    name: c.name,
    value: c.value ?? "",
    domain: c.domain,
    path: c.path ?? "/",
    secure: c.secure === true,
    httpOnly: c.httpOnly === true,
    sameSite: c.sameSite ?? "unspecified",
    session: c.expirationDate === undefined,
    hostOnly: !c.domain.startsWith("."),
    ...(c.expirationDate !== undefined ? { expirationDate: c.expirationDate } : {}),
  });
  for (const c of seed) store.push(norm(c));
  const state = { silentReject: false, setCalls: [] as any[], removeCalls: [] as Array<[string, string]> };
  const jar = {
    get: vi.fn(async (filter: { url?: string; domain?: string; name?: string } = {}) => {
      return store
        .filter((c) => {
          if (filter.name !== undefined && c.name !== filter.name) return false;
          if (filter.url !== undefined) {
            const u = new URL(filter.url);
            if (!cookieMatchesHost(c, hostOf(filter.url))) return false;
            if (c.secure && u.protocol !== "https:") return false;
          }
          if (filter.domain !== undefined) {
            const d = bare(filter.domain);
            const cd = bare(c.domain);
            if (!(cd === d || cd.endsWith(`.${d}`))) return false;
          }
          return true;
        })
        .map((c) => ({ ...c }));
    }),
    set: vi.fn(async (d: any) => {
      state.setCalls.push(d);
      if (state.silentReject) return;
      const host = hostOf(d.url);
      if (d.secure && !String(d.url).startsWith("https:")) throw new Error("secure cookie 不能经 http 写入");
      if (d.domain !== undefined) {
        const dom = bare(d.domain);
        if (!(host === dom || host.endsWith(`.${dom}`))) throw new Error("domain 与 url 不匹配");
      }
      const domain = d.domain !== undefined ? `.${bare(d.domain)}` : host;
      const next = norm({
        name: d.name,
        value: d.value,
        domain,
        path: d.path,
        secure: d.secure,
        httpOnly: d.httpOnly,
        sameSite: d.sameSite,
        expirationDate: d.expirationDate,
      });
      const i = store.findIndex((c) => c.name === next.name && c.domain === next.domain && c.path === next.path);
      if (i >= 0) store[i] = next;
      else store.push(next);
    }),
    remove: vi.fn(async (url: string, name: string) => {
      state.removeCalls.push([url, name]);
      const host = hostOf(url);
      for (let i = store.length - 1; i >= 0; i -= 1) {
        if (store[i].name === name && cookieMatchesHost(store[i], host)) store.splice(i, 1);
      }
    }),
  };
  return { jar, store, state };
};

/** 内存 DOMStorage / IndexedDB 的 CDP 应答 */
export const makeFakeCdp = (origin: string, seed: { local?: Record<string, string>; session?: Record<string, string>; idb?: Array<{ name: string; version?: number; stores?: string[] }> } = {}) => {
  const local = new Map(Object.entries(seed.local ?? {}));
  const sess = new Map(Object.entries(seed.session ?? {}));
  const idb = seed.idb ?? [];
  const calls: Array<{ method: string; params: any }> = [];
  const mapOf = (storageId: any) => (storageId?.isLocalStorage === true ? local : sess);
  const state = { noStorageKey: false, failDomStorage: false, failClear: false };
  const send = vi.fn(async (method: string, params: any = {}) => {
    calls.push({ method, params });
    switch (method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "F1" } } };
      case "Storage.getStorageKeyForFrame":
        if (state.noStorageKey) throw new Error("not supported");
        return { storageKey: `${origin}/` };
      case "DOMStorage.enable":
      case "DOMStorage.disable":
      case "IndexedDB.enable":
      case "IndexedDB.disable":
        return {};
      case "DOMStorage.getDOMStorageItems":
        if (state.failDomStorage) throw new Error("cdp failed");
        return { entries: [...mapOf(params.storageId).entries()] };
      case "DOMStorage.setDOMStorageItem":
        mapOf(params.storageId).set(params.key, params.value);
        return {};
      case "DOMStorage.removeDOMStorageItem":
        mapOf(params.storageId).delete(params.key);
        return {};
      case "DOMStorage.clear":
        if (state.failClear) throw new Error("clear failed");
        mapOf(params.storageId).clear();
        return {};
      case "IndexedDB.requestDatabaseNames":
        return { databaseNames: idb.map((d) => d.name) };
      case "IndexedDB.requestDatabase": {
        const d = idb.find((x) => x.name === params.databaseName);
        return {
          databaseWithObjectStores: {
            name: params.databaseName,
            version: d?.version ?? 1,
            objectStores: (d?.stores ?? []).map((n) => ({ name: n, autoIncrement: false, indexes: [] })),
          },
        };
      }
      default:
        return {};
    }
  });
  return { send, calls, local, session: sess, state };
};

class FakeStorageTab {
  ready = Promise.resolve();
  opener: string | null = null;
  destroyedFlag = false;
  title = "示例页";
  pendingDialog: any = null;
  hadRecentGesture = vi.fn(() => true);
  navigate = vi.fn(async () => ({ url: this.url, title: this.title, status: 200 }));
  destroy = vi.fn(() => {
    this.destroyedFlag = true;
  });
  setInputIgnored = vi.fn(async () => {});
  releaseHeldButtons = vi.fn(async () => {});
  overlaySetActive = vi.fn(async () => {});
  overlayHide = vi.fn(async () => {});
  moveToMain = vi.fn();
  moveToParking = vi.fn();
  setBounds = vi.fn();
  setVisible = vi.fn();
  capturePlaceholder = vi.fn(async () => "data:image/jpeg;base64,FAKE");
  ensureCdp = vi.fn(async () => {});
  send: any;
  wc: any;
  constructor(
    public id: string,
    public url: string,
    send: any,
    jar: any,
    clearStorageData: any,
  ) {
    this.send = send;
    this.wc = { session: { cookies: jar, clearStorageData } };
  }
  info(isActive: boolean) {
    return { id: this.id, url: this.url, title: this.title, favicon: null, loading: false, canGoBack: false, canGoForward: false, isActive };
  }
}

export interface StorageEnvOptions {
  /** 页面 URL（默认 https://a.test/home） */
  url?: string;
  cookies?: Array<Partial<FakeCookie> & { name: string; domain: string }>;
  local?: Record<string, string>;
  session?: Record<string, string>;
  idb?: Array<{ name: string; version?: number; stores?: string[] }>;
  /** 设置：默认 storageAccess 开 */
  config?: Record<string, unknown>;
  /** 应用端口（isAppUrl 用；默认 8876） */
  appPort?: number;
  /** 额外判定为「应用自身」的主机名（用来证明 cookie 域名检查走 isAppUrl） */
  extraAppHosts?: string[];
  taskId?: string;
  now?: () => number;
  fs?: any;
}

/** 手工造一个 storage 测试环境 */
export const makeStorageEnv = async (opts: StorageEnvOptions = {}) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "p3-storage-"));
  const url = opts.url ?? "https://a.test/home";
  const origin = new URL(url).origin;
  const { jar, store, state: jarState } = makeFakeJar(opts.cookies ?? []);
  const cdp = makeFakeCdp(origin, { local: opts.local, session: opts.session, idb: opts.idb });
  const clearStorageData = vi.fn(async () => {});
  const activityLog = createActivityLog();
  const host: any = {
    createTab: ({ id }: { id: string }) => new FakeStorageTab(id, url, cdp.send, jar, clearStorageData),
    getMainWindow: () => ({}),
    getParkingWindow: () => ({}),
    onChange: vi.fn(),
    emitEvent: vi.fn(),
    emitPicked: vi.fn(),
    startPicker: vi.fn(),
  };
  const taskId = opts.taskId ?? "task1";
  const session = new BrowserSession({ taskId, host, activityLog, graceMs: 8_000, now: opts.now ?? (() => 1_000) });
  const tab = (await session.openTab({})) as FakeStorageTab;
  const cfg: Record<string, unknown> = { evaluateEnabled: false, storageAccess: true, ...(opts.config ?? {}) };
  const baseIsApp = createIsAppUrl(() => opts.appPort ?? 8876);
  const extra = new Set((opts.extraAppHosts ?? []).map((h) => h.toLowerCase()));
  const isAppUrl = (u: string) => {
    if (baseIsApp(u)) return true;
    try {
      return extra.has(new URL(u).hostname.toLowerCase());
    } catch {
      return false;
    }
  };
  const checkAiUrl = (u: string) => {
    const verdict = checkUrl(normalizeAiUrl(u), { isAppUrl });
    if (!verdict.ok) throw new BrowserError("URL_BLOCKED", `该地址不允许访问：${verdict.reason}`);
    return verdict.url;
  };
  const scheduleState = vi.fn();
  const handlers = createHandlers({
    requireSession: () => session,
    getConfig: () => cfg,
    abortable: (p: Promise<unknown>) => p,
    scheduleState,
    app: { getPath: () => userData },
    checkAiUrl,
    electron: { isAppUrl },
    hostLabel: (u: string) => {
      try {
        return new URL(u).host;
      } catch {
        return String(u);
      }
    },
    log: () => {},
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.fs ? { fs: opts.fs } : {}),
  } as any);

  const norm = (args: Record<string, unknown>) => normalize("storage", args, OP_HELPERS as any) as Record<string, unknown>;
  /** normalize + handler：与真实 dispatch 的顺序一致 */
  const call = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<any> => (handlers as any).storage(taskId, norm(args), signal);
  const activitySummaries = (): string[] => (session.getState().recent as Array<{ actor: string; summary?: string }>).filter((e) => e.actor === "ai").map((e) => e.summary ?? "");

  return {
    userData,
    stateDir: path.join(userData, "data", "tasks", taskId, "browser-state"),
    url,
    origin,
    session,
    tab,
    jar,
    store,
    jarState,
    cdp,
    clearStorageData,
    cfg,
    handlers: handlers as any,
    norm,
    call,
    checkAiUrl,
    isAppUrl,
    activitySummaries,
    cleanup: () => fs.rmSync(userData, { recursive: true, force: true }),
  };
};

export type StorageEnv = Awaited<ReturnType<typeof makeStorageEnv>>;
