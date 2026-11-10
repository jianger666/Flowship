/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type -- 假 electron 对象 / 假 session 与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * E2·P2 / A6 无痕标签（主进程侧）：
 *   - partition 命名：净化 / 截断 / 唯一 / 必然匹配 INCOGNITO_PARTITION_RE；isIncognitoPartition 拒绝一切别的名字
 *   - wipeIncognitoSession / createIncognitoManager：引用计数、最后一个 tab 关闭才清、清空成功才复用、失败退役、池上限
 *   - normalizeOpArgs("tabs") 的 incognito 校验
 *   - BrowserSession.openTab({ incognito })：分配 partition、计入上限、关闭即销毁
 *   - createBrowserManager 整合（假 electron）：无痕 partition 被完整配置（权限 / 下载守卫）、tab 关闭后清空且只清自己那个 session、
 *     持久档案不受影响、clearBrowsingData 只清持久档案、will-download 在无痕 session 里仍能找到所属 tab
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  createIncognitoManager,
  INCOGNITO_PARTITION_PREFIX,
  INCOGNITO_PARTITION_RE,
  INCOGNITO_POOL_MAX,
  isIncognitoPartition,
  makeIncognitoPartition,
  nextIncognitoSeq,
  sanitizeTaskId,
  wipeIncognitoSession,
} from "../electron-app/browser/incognito.mjs";
import { createBrowserManager, normalizeOpArgs } from "../electron-app/browser/index.mjs";
import { BrowserSession, MAX_TABS } from "../electron-app/browser/session.mjs";
import { BROWSER_PARTITION } from "../electron-app/browser/tab.mjs";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
};

// ───────────────────────── 命名 ─────────────────────────

describe("无痕 partition 命名", () => {
  it("常量：前缀不含 persist:（= 内存 partition）；正则与前缀一致", () => {
    expect(INCOGNITO_PARTITION_PREFIX).toBe("flowship-incognito-");
    expect(INCOGNITO_PARTITION_PREFIX.startsWith("persist:")).toBe(false);
    expect(INCOGNITO_PARTITION_RE.test(`${INCOGNITO_PARTITION_PREFIX}a`)).toBe(true);
  });

  it("正常 taskId：flowship-incognito-<task>-<tab>-<序号>", () => {
    expect(makeIncognitoPartition({ taskId: "task-1", tabId: "t3", seq: 7 })).toBe("flowship-incognito-task-1-t3-7");
  });

  it("taskId 净化：路径穿越 / 空白 / 点 / 冒号 / 中文 / emoji / 控制字符都被替换成下划线，结果仍匹配正则", () => {
    const nasty = ["../../etc/passwd", "a b", "a.b", "a:b", "任务🙂1", "a\u0000b", "a\nb", "persist:flowship-browser", "<script>alert(1)</script>", "C:\\Users\\x"];
    for (const taskId of nasty) {
      const name = makeIncognitoPartition({ taskId, tabId: "t1", seq: 1 });
      expect(INCOGNITO_PARTITION_RE.test(name), `${JSON.stringify(taskId)} → ${name}`).toBe(true);
      expect(name).not.toMatch(/[./\\:\s]/);
      expect(name.startsWith("persist:")).toBe(false);
    }
    expect(sanitizeTaskId("../../etc")).toBe("______etc");
  });

  it("过长的 taskId / tabId 被截断，整体长度恒不超过正则上限（前缀 + 100）；序号后缀完整保留（唯一性不被截断吞掉）", () => {
    const name = makeIncognitoPartition({ taskId: "x".repeat(500), tabId: "t".repeat(500), seq: 123456 });
    expect(INCOGNITO_PARTITION_RE.test(name)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(INCOGNITO_PARTITION_PREFIX.length + 100);
    expect(name.endsWith("-123456")).toBe(true);
    const huge = makeIncognitoPartition({ taskId: "y".repeat(10_000), tabId: "z", seq: Number.MAX_SAFE_INTEGER });
    expect(INCOGNITO_PARTITION_RE.test(huge)).toBe(true);
  });

  it("空 / 非字符串 taskId、tabId 有兜底；非法序号落到 0", () => {
    for (const taskId of ["", undefined, null, 12345, {}, []] as unknown[]) {
      const name = makeIncognitoPartition({ taskId: taskId as never, tabId: "" as never, seq: -3 });
      expect(INCOGNITO_PARTITION_RE.test(name)).toBe(true);
    }
    expect(makeIncognitoPartition({ taskId: "", tabId: "", seq: Number.NaN })).toBe("flowship-incognito-task-t-0");
  });

  it("唯一：taskId 净化是有损的（a:b 与 a_b 撞车），靠进程内序号区分；序号单调递增", () => {
    const a = makeIncognitoPartition({ taskId: "a:b", tabId: "t1", seq: nextIncognitoSeq() });
    const b = makeIncognitoPartition({ taskId: "a_b", tabId: "t1", seq: nextIncognitoSeq() });
    expect(a).not.toBe(b);
    const s1 = nextIncognitoSeq();
    const s2 = nextIncognitoSeq();
    expect(s2).toBeGreaterThan(s1);
  });

  it("isIncognitoPartition / 正则：只认 flowship-incognito-[A-Za-z0-9_-]{1,100}；别的一律拒绝", () => {
    expect(isIncognitoPartition("flowship-incognito-a")).toBe(true);
    expect(isIncognitoPartition(`flowship-incognito-${"a".repeat(100)}`)).toBe(true);
    for (const bad of [
      BROWSER_PARTITION,
      "persist:flowship-incognito-a",
      "flowship-incognito-",
      `flowship-incognito-${"a".repeat(101)}`,
      "flowship-incognito-a.b",
      "flowship-incognito-a/b",
      "flowship-incognito-a b",
      "flowship-incognito-a\n",
      "flowship-incognito-中文",
      "xflowship-incognito-a",
      "",
      "default",
    ]) {
      expect(isIncognitoPartition(bad), bad).toBe(false);
    }
    for (const notString of [undefined, null, 1, {}, [], true]) expect(isIncognitoPartition(notString as never)).toBe(false);
  });
});

// ───────────────────────── 清空 / 管理器 ─────────────────────────

describe("wipeIncognitoSession", () => {
  it("清存储（不带 options = 全部类型）+ HTTP 缓存 + 认证缓存，顺序执行", async () => {
    const order: string[] = [];
    const ses = {
      clearStorageData: vi.fn(async (...a: unknown[]) => void order.push(`storage:${a.length}`)),
      clearCache: vi.fn(async () => void order.push("cache")),
      clearAuthCache: vi.fn(async () => void order.push("auth")),
    };
    await wipeIncognitoSession(ses);
    expect(order).toEqual(["storage:0", "cache", "auth"]);
  });

  it("任一步失败向上抛（调用方据此退役 partition），后面的步骤不再执行", async () => {
    const ses = {
      clearStorageData: vi.fn(async () => {
        throw new Error("disk");
      }),
      clearCache: vi.fn(async () => {}),
      clearAuthCache: vi.fn(async () => {}),
    };
    await expect(wipeIncognitoSession(ses)).rejects.toThrow("disk");
    expect(ses.clearCache).not.toHaveBeenCalled();
    const ses2 = { clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}), clearAuthCache: vi.fn(async () => Promise.reject(new Error("auth"))) };
    await expect(wipeIncognitoSession(ses2)).rejects.toThrow("auth");
  });

  it("缺可选方法（老版本没有 clearAuthCache）不报错", async () => {
    await expect(wipeIncognitoSession({ clearStorageData: vi.fn(async () => {}) })).resolves.toBeUndefined();
  });
});

describe("createIncognitoManager：分配 / 引用计数 / 回收", () => {
  const mk = (over: { wipe?: (n: string) => Promise<void>; poolMax?: number } = {}) => {
    const wipe = vi.fn(over.wipe ?? (async () => {}));
    const logs: string[] = [];
    let seq = 0;
    const m = createIncognitoManager({ wipe, log: (s: string) => logs.push(s), nextSeq: () => ++seq, ...(over.poolMax !== undefined ? { poolMax: over.poolMax } : {}) });
    return { m, wipe, logs };
  };

  it("allocate：新名字匹配正则、互不相同", () => {
    const { m } = mk();
    const a = m.allocate({ taskId: "task1", tabId: "t1" });
    const b = m.allocate({ taskId: "task1", tabId: "t1" });
    expect(isIncognitoPartition(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("tab 关闭（release 归零）→ 清空被调用一次，参数就是这个 partition 名", async () => {
    const { m, wipe } = mk();
    const name = m.allocate({ taskId: "task1", tabId: "t1" });
    m.retain(name);
    expect(wipe).not.toHaveBeenCalled();
    await m.release(name);
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(wipe).toHaveBeenCalledWith(name);
  });

  it("引用计数：opener + 弹窗共用一个 partition，先关弹窗不清空，最后一个关了才清", async () => {
    const { m, wipe } = mk();
    const name = m.allocate({ taskId: "task1", tabId: "t1" });
    m.retain(name); // opener
    m.retain(name); // 弹窗继承
    expect(m.release(name)).toBeUndefined();
    await flush();
    expect(wipe).not.toHaveBeenCalled();
    await m.release(name);
    expect(wipe).toHaveBeenCalledTimes(1);
  });

  it("清空成功 → 名字回收到复用池（下次 allocate 直接复用，Session 常驻数量有界）", async () => {
    const { m } = mk();
    const name = m.allocate({ taskId: "task1", tabId: "t1" });
    m.retain(name);
    await m.release(name);
    expect(m.stats()).toMatchObject({ live: 0, free: 1, retired: 0 });
    expect(m.allocate({ taskId: "task2", tabId: "t9" })).toBe(name);
    expect(m.stats().free).toBe(0);
  });

  it("清空进行中：名字既不在池里也拿不到（不会在清空完成前被复用）", async () => {
    let finish!: () => void;
    const { m } = mk({ wipe: () => new Promise<void>((r) => (finish = r)) });
    const name = m.allocate({ taskId: "task1", tabId: "t1" });
    m.retain(name);
    const job = m.release(name)!;
    await flush();
    expect(m.stats()).toMatchObject({ wiping: 1, free: 0 });
    const other = m.allocate({ taskId: "task1", tabId: "t2" });
    expect(other).not.toBe(name);
    finish();
    await job;
    expect(m.stats()).toMatchObject({ wiping: 0, free: 1 });
  });

  it("清空失败 → 退役（永不复用）并记日志；不抛", async () => {
    const { m, logs } = mk({
      wipe: async () => {
        throw new Error("clear failed");
      },
    });
    const name = m.allocate({ taskId: "task1", tabId: "t1" });
    m.retain(name);
    await expect(m.release(name)).resolves.toBeUndefined();
    expect(m.stats()).toMatchObject({ free: 0, retired: 1 });
    expect(m.allocate({ taskId: "task1", tabId: "t1" })).not.toBe(name);
    expect(logs.join("\n")).toContain("清空失败");
    m.abandon(name);
    expect(m.stats().free).toBe(0); // 退役的名字 abandon 也回不了池
  });

  it("多释放 / 释放没登记过的名字 = 空操作（不二次清空、池里不出现重复名字）", async () => {
    const { m, wipe } = mk();
    const name = m.allocate({ taskId: "task1", tabId: "t1" });
    m.retain(name);
    await m.release(name);
    expect(m.release(name)).toBeUndefined();
    expect(m.release("flowship-incognito-never-retained-1")).toBeUndefined();
    expect(m.release(BROWSER_PARTITION)).toBeUndefined();
    await flush();
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(m.stats().free).toBe(1);
  });

  it("retain / release 对非无痕名字（持久档案 / 垃圾）无效：永远不会清空持久档案", async () => {
    const { m, wipe } = mk();
    m.retain(BROWSER_PARTITION);
    m.retain("persist:other");
    m.retain(undefined as never);
    expect(m.stats().live).toBe(0);
    await m.release(BROWSER_PARTITION);
    expect(wipe).not.toHaveBeenCalled();
  });

  it("abandon：分配了没建成 tab → 放回池；有人在用的名字（弹窗继承的）abandon 无效", async () => {
    const { m } = mk();
    const name = m.allocate({ taskId: "task1", tabId: "t1" });
    m.abandon(name);
    expect(m.stats().free).toBe(1);
    expect(m.allocate({ taskId: "x", tabId: "y" })).toBe(name);
    m.retain(name);
    m.abandon(name);
    expect(m.stats().free).toBe(0);
    m.abandon(name);
    m.abandon("not-incognito");
    expect(m.stats().free).toBe(0);
  });

  it("池有上限：超出的名字直接丢弃（不无限攒 Session）", async () => {
    const { m } = mk({ poolMax: 2 });
    const names = Array.from({ length: 5 }, (_, i) => m.allocate({ taskId: "t", tabId: `t${i}` }));
    for (const n of names) m.retain(n);
    for (const n of names) await m.release(n);
    expect(m.stats().free).toBe(2);
    expect(INCOGNITO_POOL_MAX).toBeGreaterThan(0);
  });

  it("settled()：等所有清空任务结束", async () => {
    let finish!: () => void;
    const { m } = mk({ wipe: () => new Promise<void>((r) => (finish = r)) });
    const name = m.allocate({ taskId: "task1", tabId: "t1" });
    m.retain(name);
    void m.release(name);
    let done = false;
    const p = m.settled().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    finish();
    await p;
    expect(done).toBe(true);
  });
});

// ───────────────────────── tabs op 参数 ─────────────────────────

describe("normalizeOpArgs('tabs') 的 incognito 校验", () => {
  it("new + incognito:true → 透传；false / 缺省 → 不带该键（false 等于没给）", () => {
    expect(normalizeOpArgs("tabs", { action: "new", incognito: true })).toEqual({ action: "new", incognito: true });
    expect(normalizeOpArgs("tabs", { action: "new", url: "https://a.test/", incognito: true })).toEqual({ action: "new", url: "https://a.test/", incognito: true });
    expect(normalizeOpArgs("tabs", { action: "new", incognito: false })).toEqual({ action: "new" });
    expect(normalizeOpArgs("tabs", { action: "new" })).toEqual({ action: "new" });
    expect(normalizeOpArgs("tabs", { action: "new", incognito: null })).toEqual({ action: "new" });
  });

  it("incognito 只能配 new：list / select / close 带 true → BAD_ARGS（不静默吞掉）", () => {
    for (const args of [{ action: "list" }, { action: "select", tabId: "t1" }, { action: "close", tabId: "t1" }]) {
      expect(() => normalizeOpArgs("tabs", { ...args, incognito: true })).toThrowError(expect.objectContaining({ code: "BAD_ARGS" }));
    }
    // false 不报错（等于没给）
    expect(normalizeOpArgs("tabs", { action: "list", incognito: false })).toEqual({ action: "list" });
  });

  it("incognito 非布尔 → BAD_ARGS（字符串 'true' / 数字 1 不能让无痕悄悄变成普通标签）", () => {
    for (const v of ["true", "yes", 1, 0, {}, []]) {
      expect(() => normalizeOpArgs("tabs", { action: "new", incognito: v }), String(v)).toThrowError(expect.objectContaining({ code: "BAD_ARGS" }));
    }
  });

  it("既有校验不变：缺 action / select 缺 tabId", () => {
    expect(() => normalizeOpArgs("tabs", {})).toThrowError(expect.objectContaining({ code: "BAD_ARGS" }));
    expect(() => normalizeOpArgs("tabs", { action: "select" })).toThrowError(expect.objectContaining({ code: "BAD_ARGS" }));
    expect(normalizeOpArgs("tabs", { action: "select", tabId: "t1" })).toEqual({ action: "select", tabId: "t1" });
  });
});

// ───────────────────────── session ─────────────────────────

class ITab {
  opener: string | null = null;
  url = "about:blank";
  title = "";
  lastUrl = "";
  destroy = vi.fn();
  setInputIgnored = vi.fn(async () => {});
  overlaySetActive = vi.fn(async () => {});
  overlayHide = vi.fn(async () => {});
  moveToMain = vi.fn();
  moveToParking = vi.fn();
  setBounds = vi.fn();
  setVisible = vi.fn();
  navigate = vi.fn(async () => ({ url: this.url, title: this.title, status: 200 }));
  ready = Promise.resolve();
  constructor(
    public id: string,
    public partition?: string,
  ) {}
  info(isActive: boolean) {
    return { id: this.id, url: this.url, title: this.title, favicon: null, loading: false, canGoBack: false, canGoForward: false, isActive, ...(this.partition?.startsWith("flowship-incognito-") ? { incognito: true } : {}) };
  }
}

const makeSessionEnv = (opts: { allocate?: boolean; maxTabs?: number } = {}) => {
  const createCalls: Array<{ id: string; partition?: string }> = [];
  const created: ITab[] = [];
  const allocate = vi.fn(({ taskId, tabId }: { taskId: string; tabId: string }) => `flowship-incognito-${taskId}-${tabId}-99`);
  const host = {
    createTab: (a: { id: string; hooks: unknown; partition?: string }) => {
      createCalls.push(a);
      const t = new ITab(a.id, a.partition);
      created.push(t);
      return t;
    },
    getMainWindow: () => ({}),
    getParkingWindow: () => ({}),
    onChange: vi.fn(),
    emitEvent: vi.fn(),
    emitPicked: vi.fn(),
    startPicker: vi.fn(),
    ...(opts.allocate === false ? {} : { allocateIncognitoPartition: allocate }),
    ...(opts.maxTabs !== undefined ? { getMaxTabs: () => opts.maxTabs } : {}),
  };
  const activityLog = { addSystem: vi.fn(), ingest: vi.fn(() => false) };
  const session = new BrowserSession({ taskId: "task1", host: host as never, activityLog: activityLog as never });
  return { session, host, createCalls, created, allocate, activityLog };
};

describe("BrowserSession.openTab({ incognito })", () => {
  it("向 host 要 partition（taskId + tabId），createTab 带上它；tab info 标 incognito", async () => {
    const env = makeSessionEnv();
    const tab = (await env.session.openTab({ incognito: true })) as ITab;
    expect(env.allocate).toHaveBeenCalledWith({ taskId: "task1", tabId: "t1" });
    expect(env.createCalls[0].partition).toBe("flowship-incognito-task1-t1-99");
    expect(tab.info(true).incognito).toBe(true);
    expect(env.session.listTabs()[0]).toMatchObject({ id: "t1", incognito: true });
  });

  it("host 没有分配器（老调用方 / 单测）→ 会话自己生成合法名字，且两次互不相同", async () => {
    const env = makeSessionEnv({ allocate: false });
    await env.session.openTab({ incognito: true });
    await env.session.openTab({ incognito: true });
    const [a, b] = env.createCalls.map((c) => c.partition!);
    expect(isIncognitoPartition(a)).toBe(true);
    expect(isIncognitoPartition(b)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("默认（不带 incognito / incognito:false）→ createTab 的参数里根本没有 partition（走共享持久档案，调用形状与 E1 一致）", async () => {
    const env = makeSessionEnv();
    await env.session.openTab({});
    await env.session.openTab({ incognito: false });
    for (const c of env.createCalls) expect("partition" in c).toBe(false);
    expect(env.allocate).not.toHaveBeenCalled();
    expect("incognito" in env.session.listTabs()[0]).toBe(false);
  });

  it("host 的分配器返回垃圾（空串 / 非字符串）→ 退回会话自己生成", async () => {
    const env = makeSessionEnv();
    env.host.allocateIncognitoPartition = (() => "") as never;
    await env.session.openTab({ incognito: true });
    expect(isIncognitoPartition(env.createCalls[0].partition!)).toBe(true);
  });

  it("计入标签页上限：无痕与普通同等占名额（MAX_TABS=20）", async () => {
    const env = makeSessionEnv();
    for (let i = 0; i < MAX_TABS - 1; i++) await env.session.openTab({});
    await env.session.openTab({ incognito: true }); // 第 20 个
    await expect(env.session.openTab({ incognito: true })).rejects.toMatchObject({ code: "BAD_ARGS" });
    await expect(env.session.openTab({})).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(env.session.tabs).toHaveLength(MAX_TABS);
  });

  it("设置里调小的上限（getMaxTabs=5）同样适用于无痕", async () => {
    const env = makeSessionEnv({ maxTabs: 5 });
    for (let i = 0; i < 3; i++) await env.session.openTab({});
    await env.session.openTab({ incognito: true });
    await env.session.openTab({ incognito: true });
    await expect(env.session.openTab({ incognito: true })).rejects.toMatchObject({ code: "BAD_ARGS" });
  });

  it("关闭无痕标签 → tab.destroy()（清空由 host 的 destroy 钩子触发，见下面的整合测试）", async () => {
    const env = makeSessionEnv();
    await env.session.openTab({});
    const inc = (await env.session.openTab({ incognito: true })) as ITab;
    await env.session.closeTab(inc.id);
    expect(inc.destroy).toHaveBeenCalledTimes(1);
    expect(env.session.tabs.map((t) => t.id)).toEqual(["t1"]);
  });

  it("活动日志写「无痕标签页」", async () => {
    const env = makeSessionEnv();
    await env.session.openTab({ incognito: true });
    expect(env.activityLog.addSystem.mock.calls.map((c) => c[0].summary).join("\n")).toContain("无痕标签页");
  });
});

// ───────────────────────── manager 整合（假 electron） ─────────────────────────

class MWc extends EventEmitter {
  destroyedFlag = false;
  prefs: Record<string, unknown> = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true };
  setWindowOpenHandler = vi.fn();
  setAudioMuted = vi.fn();
  isDestroyed = () => this.destroyedFlag;
  loadURL = vi.fn(async () => {});
  getURL = () => "about:blank";
  getTitle = () => "";
  isLoading = () => false;
  stop = vi.fn();
  getZoomLevel = () => 0;
  getLastWebPreferences = () => this.prefs;
  capturePage = vi.fn(async () => ({ isEmpty: () => true }));
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  /** true（默认）= close() 后一个微任务就 destroyed；false = 手动 finishClose()（用来断言「destroyed 之前不清空」） */
  autoDestroy = true;
  finishClose = () => {
    this.destroyedFlag = true;
    this.emit("destroyed");
  };
  /** 真 Electron 的 wc.close() 是异步销毁：先返回，之后才 destroyed */
  close = vi.fn(() => {
    if (this.autoDestroy) queueMicrotask(this.finishClose);
  });
  debugger = { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), on: vi.fn(), sendCommand: vi.fn(async () => ({})) };
}

const makeManager = (opts: { wipeFails?: boolean } = {}) => {
  const wcs: MWc[] = [];
  const viewArgs: Array<Record<string, any>> = [];
  class FakeView {
    webContents: MWc;
    setBounds = vi.fn();
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
    constructor(o: Record<string, any>) {
      viewArgs.push(o);
      this.webContents = o.webContents ?? new MWc();
      wcs.push(this.webContents);
    }
  }
  const makeWin = () => ({
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      this.destroyed = true;
    },
    on: vi.fn(),
    once: vi.fn(),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { send: vi.fn(), isDestroyed: () => false, getZoomFactor: () => 1 },
  });
  class FakeWindow {
    constructor() {
      return makeWin() as never;
    }
  }
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipcMain = {
    handle: (n: string, f: never) => void handlers.set(n, f),
    on: vi.fn(),
    removeHandler: (n: string) => void handlers.delete(n),
    removeListener: vi.fn(),
  };
  const sessions = new Map<string, Record<string, any>>();
  const fromPartition = vi.fn((name: string) => {
    let s = sessions.get(name);
    if (!s) {
      const listeners: Record<string, Function[]> = {};
      s = {
        name,
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setDevicePermissionHandler: vi.fn(),
        on: vi.fn((ev: string, fn: Function) => void (listeners[ev] ??= []).push(fn)),
        listeners,
        clearStorageData: vi.fn(async () => {
          if (opts.wipeFails) throw new Error("wipe failed");
        }),
        clearCache: vi.fn(async () => {}),
        clearAuthCache: vi.fn(async () => {}),
        // R6-10：断开已建立的连接（防「已放行坏证书的连接」被复用）
        closeAllConnections: vi.fn(async () => {}),
      };
      sessions.set(name, s);
    }
    return s;
  });
  const logs: string[] = [];
  const manager = createBrowserManager({
    app: { getPath: () => "/tmp" },
    BrowserWindow: FakeWindow,
    WebContentsView: FakeView,
    session: { fromPartition },
    ipcMain,
    getMainWindow: () => makeWin(),
    isAppUrl: () => false,
    isTrustedIpcSender: () => true,
    log: (m: string) => logs.push(m),
    startPicker: () => ({ cancel() {} }),
  } as never);
  const dispatch = (op: string, args: Record<string, unknown>, taskId = "T1") => (manager as any).dispatch(op, args, { taskId, signal: undefined });
  return { manager, dispatch, wcs, viewArgs, fromPartition, sessions, handlers, logs };
};

type TabsResult = { tabs: Array<{ id: string; incognito?: boolean }>; activeTabId: string };

describe("manager 整合：tabs new incognito", () => {
  it("tabs(new, incognito) → 新 tab 在无痕 partition 里（内存、匹配正则）；list 里标 incognito:true；默认 tab 不带标记", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "about:blank" });
    const r = (await env.dispatch("tabs", { action: "new", incognito: true })) as TabsResult;
    const incTab = r.tabs.find((t) => t.incognito)!;
    expect(incTab).toBeDefined();
    expect(r.activeTabId).toBe(incTab.id);
    const names = [...env.sessions.keys()];
    const incName = names.find((n) => isIncognitoPartition(n))!;
    expect(incName).toBeDefined();
    expect(names).toContain(BROWSER_PARTITION);
    const listed = (await env.dispatch("tabs", { action: "list" })) as TabsResult;
    expect(listed.tabs.filter((t) => t.incognito)).toHaveLength(1);
    expect(listed.tabs.find((t) => !t.incognito)).toBeDefined();
    expect("incognito" in listed.tabs.find((t) => !t.incognito)!).toBe(false);
  });

  it("无痕 partition 与持久档案一样被完整配置：权限默认拒绝、设备权限拒绝、will-download 守卫已挂", async () => {
    const env = makeManager();
    await env.dispatch("tabs", { action: "new", incognito: true });
    const incName = [...env.sessions.keys()].find((n) => isIncognitoPartition(n))!;
    const ses = env.sessions.get(incName)!;
    expect(ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(ses.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(ses.setDevicePermissionHandler).toHaveBeenCalledTimes(1);
    expect(ses.listeners["will-download"]).toHaveLength(1);
  });

  it("will-download 在无痕 session 里仍能找到所属 tab：无手势且没有令牌 → 拦截并写进该会话的日志；该 tab 登记过浏览器侧令牌 → 放行（只有找到 owner 才可能命中令牌）", async () => {
    const env = makeManager();
    await env.dispatch("tabs", { action: "new", incognito: true });
    const incName = [...env.sessions.keys()].find((n) => isIncognitoPartition(n))!;
    const ses = env.sessions.get(incName)!;
    const wc = env.wcs[env.wcs.length - 1]; // 无痕 tab 的 wc
    const session = (env.manager as any).getSession("T1");
    const tab = session.tabs.find((t: { wc: unknown }) => t.wc === wc);
    expect(tab.incognito).toBe(true);
    const mkItem = (name: string, url: string) =>
      Object.assign(new EventEmitter(), {
        getFilename: () => name,
        getTotalBytes: () => 100,
        getReceivedBytes: () => 0,
        getURLChain: () => [url],
        getURL: () => url,
        hasUserGesture: () => false, // 页面无手势：只有「浏览器发起」令牌能放行
        setSavePath: vi.fn(),
        cancel: vi.fn(),
      });
    const fire = (item: unknown) => ses.listeners["will-download"][0]({ preventDefault: vi.fn() }, item, wc);
    const dlLog = () => session.activityLog.list().filter((e: { kind: string }) => e.kind === "download").map((e: { summary: string }) => e.summary).join("|");

    const blocked = mkItem(`p2-inc-a-${process.pid}.bin`, "https://files.example.com/a.bin");
    fire(blocked);
    expect(blocked.cancel).toHaveBeenCalledTimes(1);
    expect(blocked.setSavePath).not.toHaveBeenCalled();
    expect(dlLog()).toMatch(/下载被拦截：p2-inc-a-/); // 日志写进了无痕 tab 所属会话 = owner 找到了

    tab.noteBrowserInitiatedLoad("https://files.example.com/b.bin");
    const allowed = mkItem(`p2-inc-b-${process.pid}.bin`, "https://files.example.com/b.bin");
    fire(allowed);
    expect(allowed.cancel).not.toHaveBeenCalled();
    expect(allowed.setSavePath).toHaveBeenCalledTimes(1);
    expect(dlLog()).toMatch(/开始下载：p2-inc-b-/);
  });

  it("关闭无痕标签 → wc 真正 destroyed 之后才清空该 partition（存储 + 缓存 + 认证缓存），只清它自己；持久档案的 session 一次都没被清", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "about:blank" });
    const r = (await env.dispatch("tabs", { action: "new", incognito: true })) as TabsResult;
    const incId = r.tabs.find((t) => t.incognito)!.id;
    const incName = [...env.sessions.keys()].find((n) => isIncognitoPartition(n))!;
    const ses = env.sessions.get(incName)!;
    expect(ses.clearStorageData).not.toHaveBeenCalled();
    const incWc = env.wcs[env.wcs.length - 1];
    incWc.autoDestroy = false;
    await env.dispatch("tabs", { action: "close", tabId: incId });
    // wc.close() 是异步销毁：destroyed 之前绝不能清空（渲染进程的 pagehide 写入会污染复用的名字）
    await flush();
    expect(incWc.close).toHaveBeenCalled();
    expect(ses.clearStorageData).not.toHaveBeenCalled();
    incWc.finishClose();
    await flush();
    expect(ses.clearStorageData).toHaveBeenCalledTimes(1);
    expect(ses.clearStorageData).toHaveBeenCalledWith(); // 不带 options = 全部存储类型
    expect(ses.clearCache).toHaveBeenCalledTimes(1);
    expect(ses.clearAuthCache).toHaveBeenCalledTimes(1);
    const persistent = env.sessions.get(BROWSER_PARTITION)!;
    expect(persistent.clearStorageData).not.toHaveBeenCalled();
    expect(persistent.clearCache).not.toHaveBeenCalled();
    expect(persistent.clearAuthCache).not.toHaveBeenCalled();
  });

  it("关闭会话里的普通 tab 不清任何无痕 partition；无痕标签还开着时它的 session 不被清", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "about:blank" });
    const r = (await env.dispatch("tabs", { action: "new", incognito: true })) as TabsResult;
    const normalId = r.tabs.find((t) => !t.incognito)!.id;
    const incName = [...env.sessions.keys()].find((n) => isIncognitoPartition(n))!;
    await env.dispatch("tabs", { action: "close", tabId: normalId });
    await flush();
    expect(env.sessions.get(incName)!.clearStorageData).not.toHaveBeenCalled();
  });

  it("两个无痕标签各有各的 partition（登录态互相隔离），关一个只清一个", async () => {
    const env = makeManager();
    const r1 = (await env.dispatch("tabs", { action: "new", incognito: true })) as TabsResult;
    const r2 = (await env.dispatch("tabs", { action: "new", incognito: true })) as TabsResult;
    const incNames = [...env.sessions.keys()].filter((n) => isIncognitoPartition(n));
    expect(incNames).toHaveLength(2);
    expect(new Set(incNames).size).toBe(2);
    const second = r2.tabs.filter((t) => t.incognito).find((t) => !r1.tabs.some((x) => x.id === t.id))!;
    await env.dispatch("tabs", { action: "close", tabId: second.id });
    await flush();
    const cleared = incNames.filter((n) => env.sessions.get(n)!.clearStorageData.mock.calls.length > 0);
    expect(cleared).toHaveLength(1);
  });

  it("清空后名字被复用：再开一个无痕标签用回已清空的 partition，不新增 Session（常驻数量有界）", async () => {
    const env = makeManager();
    const r1 = (await env.dispatch("tabs", { action: "new", incognito: true })) as TabsResult;
    await env.dispatch("tabs", { action: "close", tabId: r1.tabs.find((t) => t.incognito)!.id });
    await flush();
    const before = [...env.sessions.keys()].filter((n) => isIncognitoPartition(n)).length;
    await env.dispatch("tabs", { action: "new", incognito: true });
    const after = [...env.sessions.keys()].filter((n) => isIncognitoPartition(n)).length;
    expect(after).toBe(before);
  });

  it("清空失败：名字退役，不被复用（宁可多一个 Session 也不复用没清干净的）", async () => {
    const env = makeManager({ wipeFails: true });
    const r1 = (await env.dispatch("tabs", { action: "new", incognito: true })) as TabsResult;
    await env.dispatch("tabs", { action: "close", tabId: r1.tabs.find((t) => t.incognito)!.id });
    await flush();
    const first = [...env.sessions.keys()].filter((n) => isIncognitoPartition(n));
    await env.dispatch("tabs", { action: "new", incognito: true });
    const second = [...env.sessions.keys()].filter((n) => isIncognitoPartition(n));
    expect(second.length).toBe(first.length + 1);
    expect(env.logs.join("\n")).toContain("清空失败");
  });

  it("browser:clearBrowsingData 只清持久档案，不碰无痕 partition", async () => {
    const env = makeManager();
    (env.manager as any).registerIpc();
    await env.dispatch("tabs", { action: "new", incognito: true });
    const incName = [...env.sessions.keys()].find((n) => isIncognitoPartition(n))!;
    const clear = env.handlers.get("browser:clearBrowsingData")!;
    expect(clear).toBeDefined();
    await clear({});
    const persistent = env.sessions.get(BROWSER_PARTITION)!;
    expect(persistent.clearStorageData).toHaveBeenCalledTimes(1);
    expect(env.sessions.get(incName)!.clearStorageData).not.toHaveBeenCalled();
  });

  it("incognito 带非法值：BAD_ARGS，不新建任何 tab / session", async () => {
    const env = makeManager();
    await expect(env.dispatch("tabs", { action: "new", incognito: "true" })).rejects.toMatchObject({ code: "BAD_ARGS" });
    await expect(env.dispatch("tabs", { action: "list", incognito: true })).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect([...env.sessions.keys()].filter((n) => isIncognitoPartition(n))).toHaveLength(0);
  });

  it("整合：计入上限——无痕 tab 占会话的 tab 名额", async () => {
    const env = makeManager();
    for (let i = 0; i < MAX_TABS; i++) await env.dispatch("tabs", { action: "new", incognito: i % 2 === 0 });
    await expect(env.dispatch("tabs", { action: "new", incognito: true })).rejects.toMatchObject({ code: "BAD_ARGS" });
    await expect(env.dispatch("tabs", { action: "new" })).rejects.toMatchObject({ code: "BAD_ARGS" });
  });

  it("partition 名不能由外部字符串决定：host.createTab 对非法 partition 名直接抛", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "about:blank" });
    const session = (env.manager as any).getSession("T1") as BrowserSession;
    const host = (session as any).host as { createTab: (a: Record<string, unknown>) => unknown };
    for (const partition of ["persist:evil", "flowship-incognito-../x", "default", "flowship-incognito-"]) {
      expect(() => host.createTab({ id: "tx", hooks: {}, partition }), partition).toThrow(/partition/);
    }
  });
});

// ───────────────────────── R6-10 / R6-11 / R6-22（S3）：真 createBrowserManager + 假 session ─────────────────────────

describe("R6-10 / R6-11 / R6-22：清除数据 / 会话结束 / 无痕 wipe 的网络清理（经真 manager）", () => {
  const seedCert = async (env: ReturnType<typeof makeManager>, partition: string) => {
    const { getNetGuardState, certScopeKey } = await import("../electron-app/browser/net-guard.mjs");
    const session = (env.manager as any).getSession("T1");
    getNetGuardState(session).allowedCerts.set(certScopeKey(partition, "bad.example:8443"), new Set(["sha256/AAAAAAAAAAAA"]));
    return { session, state: getNetGuardState(session) };
  };

  it("browser:clearBrowsingData：持久 session 断开连接（在清完认证缓存与例外表之后）；例外表按持久 partition 清；无痕不受影响", async () => {
    const env = makeManager();
    (env.manager as any).registerIpc();
    await env.dispatch("navigate", { url: "about:blank" });
    await env.dispatch("tabs", { action: "new", incognito: true });
    const incName = [...env.sessions.keys()].find((n) => isIncognitoPartition(n))!;
    const { state } = await seedCert(env, BROWSER_PARTITION);
    const { certScopeKey } = await import("../electron-app/browser/net-guard.mjs");
    state.allowedCerts.set(certScopeKey(incName, "inc.example"), new Set(["sha256/BBBBBBBBBBBB"]));

    await env.handlers.get("browser:clearBrowsingData")!({});
    const persistent = env.sessions.get(BROWSER_PARTITION)!;
    expect(persistent.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(persistent.closeAllConnections.mock.invocationCallOrder[0]).toBeGreaterThan(persistent.clearAuthCache.mock.invocationCallOrder[0]);
    expect(env.sessions.get(incName)!.closeAllConnections).not.toHaveBeenCalled();
    // 例外表：持久的清了、无痕的还在
    expect(state.hasCertExceptions(BROWSER_PARTITION)).toBe(false);
    expect(state.hasCertExceptions(incName)).toBe(true);
  });

  it("clearBrowsingData：closeAllConnections 失败 / fake session 没有该方法都不让清除报错", async () => {
    const env = makeManager();
    (env.manager as any).registerIpc();
    await env.dispatch("navigate", { url: "about:blank" });
    const persistent = env.sessions.get(BROWSER_PARTITION)!;
    persistent.closeAllConnections = vi.fn(async () => {
      throw new Error("conn-boom");
    });
    await expect(env.handlers.get("browser:clearBrowsingData")!({})).resolves.toBeUndefined();
    expect(env.logs.join("\n")).toContain("conn-boom");
    delete persistent.closeAllConnections;
    await expect(env.handlers.get("browser:clearBrowsingData")!({})).resolves.toBeUndefined();
  });

  it("无痕 wipe：wc 真正 destroyed 后断开连接；该 partition 的证书例外随之作废（名字复用时不继承）", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "about:blank" });
    const r = (await env.dispatch("tabs", { action: "new", incognito: true })) as TabsResult;
    const incId = r.tabs.find((t) => t.incognito)!.id;
    const incName = [...env.sessions.keys()].find((n) => isIncognitoPartition(n))!;
    const { state } = await seedCert(env, incName);
    const ses = env.sessions.get(incName)!;
    const incWc = env.wcs[env.wcs.length - 1];
    incWc.autoDestroy = false;
    await env.dispatch("tabs", { action: "close", tabId: incId });
    await flush();
    expect(ses.closeAllConnections).not.toHaveBeenCalled(); // destroyed 之前不清
    expect(state.hasCertExceptions(incName)).toBe(true);
    incWc.finishClose();
    await flush();
    expect(ses.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(state.hasCertExceptions(incName)).toBe(false);
    // 持久 session 没被误断
    expect(env.sessions.get(BROWSER_PARTITION)!.closeAllConnections).not.toHaveBeenCalled();
  });

  it("closeAllConnections 失败不让无痕 wipe 失败（partition 不退役、仍回到复用池）", async () => {
    const env = makeManager();
    const r1 = (await env.dispatch("tabs", { action: "new", incognito: true })) as TabsResult;
    const incName = [...env.sessions.keys()].find((n) => isIncognitoPartition(n))!;
    env.sessions.get(incName)!.closeAllConnections = vi.fn(async () => {
      throw new Error("conn-boom");
    });
    await env.dispatch("tabs", { action: "close", tabId: r1.tabs.find((t) => t.incognito)!.id });
    await flush();
    const before = [...env.sessions.keys()].filter((n) => isIncognitoPartition(n)).length;
    await env.dispatch("tabs", { action: "new", incognito: true });
    expect([...env.sessions.keys()].filter((n) => isIncognitoPartition(n)).length).toBe(before); // 复用了，没有新增
    expect(env.logs.join("\n")).not.toContain("清空失败");
  });

  it("R6-11：close_session（任务结束）→ 持久 session 的 clearAuthCache 被调用；没有证书例外时不断连接", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "about:blank" });
    const persistent = env.sessions.get(BROWSER_PARTITION)!;
    expect(persistent.clearAuthCache).not.toHaveBeenCalled();
    await env.dispatch("close_session", {});
    await flush();
    expect(persistent.clearAuthCache).toHaveBeenCalledTimes(1);
    expect(persistent.closeAllConnections).not.toHaveBeenCalled();
  });

  it("R6-10：close_session 时本会话有用户放行的持久 partition 证书例外 → 同时断开连接", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "about:blank" });
    await seedCert(env, BROWSER_PARTITION);
    await env.dispatch("close_session", {});
    await flush();
    const persistent = env.sessions.get(BROWSER_PARTITION)!;
    expect(persistent.clearAuthCache).toHaveBeenCalledTimes(1);
    expect(persistent.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it("R6-10：只有无痕 partition 的例外时，会话结束不去断持久 session（无痕的连接随 wipe 断）", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "about:blank" });
    await env.dispatch("tabs", { action: "new", incognito: true });
    const incName = [...env.sessions.keys()].find((n) => isIncognitoPartition(n))!;
    await seedCert(env, incName);
    await env.dispatch("close_session", {});
    await flush();
    expect(env.sessions.get(BROWSER_PARTITION)!.closeAllConnections).not.toHaveBeenCalled();
  });

  // ── R6-24③：onConfig 的「行为」测试（原先只有 maxTabs 源码正则契约）：开关切换后主进程行为真的变化，坏值（"true" / 1 / null …）被拒 ──
  describe("R6-24③ onConfig 行为（真 manager）", () => {
    const BAD = ["true", "false", "1", "0", 1, 0, null, undefined, {}, []] as unknown[];
    const cfgOf = (env: ReturnType<typeof makeManager>) => (env.manager as any).getConfig() as Record<string, unknown>;

    it("布尔开关：只有真正的 boolean 才写入；字符串 / 数字 / null / 对象一律不改（fail-closed：不会把 \"false\" 当 true，也不会把 0 当 false）", () => {
      const env = makeManager();
      const on = (c: Record<string, unknown>) => (env.manager as any).onConfig(c);
      for (const k of ["storageAccess", "pagePermissions", "trustLoopbackCerts", "networkBodyRead", "evaluateEnabled"]) {
        const dflt = cfgOf(env)[k];
        for (const bad of BAD) {
          on({ [k]: bad });
          expect(cfgOf(env)[k], `${k}=${JSON.stringify(bad)} 不应改动`).toBe(dflt);
        }
        on({ [k]: !dflt });
        expect(cfgOf(env)[k], `${k} 合法 boolean 应生效`).toBe(!dflt);
        on({ [k]: dflt });
        expect(cfgOf(env)[k]).toBe(dflt);
      }
      // 整个 cfg 不是对象也不抛
      expect(() => on(null as never)).not.toThrow();
      expect(() => on("x" as never)).not.toThrow();
    });

    it("maxTabs：只认 5–60 的整数；坏值保持原值（不是回 20）", () => {
      const env = makeManager();
      const on = (v: unknown) => (env.manager as any).onConfig({ maxTabs: v });
      on(33);
      for (const bad of [4, 61, 0, -5, "20", 20.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}]) {
        on(bad);
        expect(cfgOf(env).maxTabs, `maxTabs=${String(bad)}`).toBe(33);
      }
      on(5);
      expect(cfgOf(env).maxTabs).toBe(5);
      on(60);
      expect(cfgOf(env).maxTabs).toBe(60);
    });

    it("trustLoopbackCerts：开 → 本机证书错误直接放行；关 → 不再放行（转询问）；坏值不改变当前状态", async () => {
      const env = makeManager();
      await env.dispatch("navigate", { url: "about:blank" });
      const wc = env.wcs[env.wcs.length - 1];
      const fire = () => {
        const cb = vi.fn();
        wc.emit("certificate-error", { preventDefault: vi.fn() }, "https://localhost:8443/", "net::ERR_CERT_AUTHORITY_INVALID", { fingerprint: "sha256/AAAAAAAAAAAA" }, cb, true);
        return cb;
      };
      const on = (v: unknown) => (env.manager as any).onConfig({ trustLoopbackCerts: v });
      on(true);
      expect(fire()).toHaveBeenCalledWith(true);
      on(false);
      const asked = fire();
      await flush();
      expect(asked).not.toHaveBeenCalled(); // 询问中（提示挂起），没有被放行
      for (const bad of ["true", 1, null]) on(bad); // 坏值：仍是 false
      const still = fire();
      await flush();
      expect(still).not.toHaveBeenCalledWith(true);
      on(true);
      expect(fire()).toHaveBeenCalledWith(true);
    });

    it("R6-23：开关开着时 `*.local` 也不被放行（转询问），回环才放行", async () => {
      const env = makeManager();
      await env.dispatch("navigate", { url: "about:blank" });
      const wc = env.wcs[env.wcs.length - 1];
      (env.manager as any).onConfig({ trustLoopbackCerts: true });
      const fire = (url: string) => {
        const cb = vi.fn();
        wc.emit("certificate-error", { preventDefault: vi.fn() }, url, "net::ERR_CERT_AUTHORITY_INVALID", { fingerprint: "sha256/AAAAAAAAAAAA" }, cb, true);
        return cb;
      };
      const local = fire("https://nas.local:8443/");
      await flush();
      expect(local).not.toHaveBeenCalled();
      expect(fire("https://app.localhost:8443/")).toHaveBeenCalledWith(true);
      expect(fire("https://127.0.0.1:8443/")).toHaveBeenCalledWith(true);
    });

    it("pagePermissions：关 → permissions grant 被 ACCESS_DISABLED 拒；开 → 不再因开关被拒；坏值不改变", async () => {
      const env = makeManager();
      await env.dispatch("navigate", { url: "about:blank" });
      const grant = () => env.dispatch("permissions", { action: "grant", permission: "geolocation" });
      const on = (v: unknown) => (env.manager as any).onConfig({ pagePermissions: v });
      await expect(grant()).rejects.toMatchObject({ code: "ACCESS_DISABLED" });
      for (const bad of ["true", 1, null]) on(bad);
      await expect(grant()).rejects.toMatchObject({ code: "ACCESS_DISABLED" }); // 坏值没有把它打开
      on(true);
      await expect(grant()).rejects.not.toMatchObject({ code: "ACCESS_DISABLED" }); // 过了开关（后面因 about:blank 没有站点而 BAD_ARGS）
      for (const bad of ["false", 0, null]) on(bad);
      await expect(grant()).rejects.not.toMatchObject({ code: "ACCESS_DISABLED" }); // 坏值没有把它关掉
      on(false);
      await expect(grant()).rejects.toMatchObject({ code: "ACCESS_DISABLED" });
    });

    it("storageAccess：关 → storage reveal 被 ACCESS_DISABLED 拒；开 → 不再因开关被拒；坏值不改变", async () => {
      const env = makeManager();
      await env.dispatch("navigate", { url: "about:blank" });
      const reveal = () => env.dispatch("storage", { action: "cookies_list", reveal: true });
      const on = (v: unknown) => (env.manager as any).onConfig({ storageAccess: v });
      await expect(reveal()).rejects.toMatchObject({ code: "ACCESS_DISABLED" });
      for (const bad of ["true", 1, null]) on(bad);
      await expect(reveal()).rejects.toMatchObject({ code: "ACCESS_DISABLED" });
      on(true);
      await expect(reveal()).rejects.not.toMatchObject({ code: "ACCESS_DISABLED" });
      on(false);
      await expect(reveal()).rejects.toMatchObject({ code: "ACCESS_DISABLED" });
    });
  });

  it("R6-11：manager.destroy()（应用退出）同样清持久 session 的认证缓存", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "about:blank" });
    const persistent = env.sessions.get(BROWSER_PARTITION)!;
    (env.manager as any).destroy();
    await flush();
    expect(persistent.clearAuthCache).toHaveBeenCalledTimes(1);
  });
});
