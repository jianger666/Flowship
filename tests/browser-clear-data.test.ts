/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 假 webContents / 假 electron 与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * 「清除登录数据」修复（electron-app/browser/clear-data.mjs + index.mjs 的 `browser:clearBrowsingData`）。
 *
 * 现象（真机探针实测）：清除返回的瞬间 cookie / localStorage / sessionStorage 都是空的，但还开着的页面里 JS 没停——
 * 内存 token + 续期心跳 / 状态回写会在 1～2 秒内把 HttpOnly 登录 cookie 与 localStorage 写回、30 秒后落盘，刷新页面仍是登录状态。
 * 修法：清除前先让持久档案里的 http(s) 标签「停下」（about:blank），清完再回原地址，并把多出来的两条历史修剪掉。
 *
 * 夹具按探针里实测的 Chromium 行为拟真：
 *  - 页面带 beforeunload（有用户激活）时，`loadURL("about:blank")` 没人 `preventDefault` 就 ERR_ABORTED、页面原地不动（探针 C1）；
 *  - 导航会截掉当前下标之后的历史（前进栈丢失，探针 C4）；`removeEntryAtIndex` 不能删当前条目。
 * 「登出态真的不被写回」这件事只有真 Electron 能证明，见 scripts/browser-e2e/clear-login-data.cjs。
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  collectClearTargets,
  haltTabsForClear,
  isClearTarget,
  pruneClearHistory,
  resumeTabsAfterClear,
} from "../electron-app/browser/clear-data.mjs";
import { createBrowserManager } from "../electron-app/browser/index.mjs";
import { BROWSER_PARTITION } from "../electron-app/browser/tab.mjs";

const BLANK = "about:blank";
const ORIGIN = "http://x.test";
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

// ───────────────────────── 夹具：假 webContents（带历史栈）/ 假 tab ─────────────────────────

class FakeWc extends EventEmitter {
  entries: { url: string }[];
  active: number;
  destroyedFlag = false;
  /** 页面带 beforeunload：没人 preventDefault 就 ERR_ABORTED */
  hasBeforeUnload = false;
  /** 终止（loadURL about:blank）永不返回：模拟卡死的页面 */
  hangHalt = false;
  /** 终止的前 N 次直接 ERR_FAILED：模拟「上一次被拦下的 beforeunload 还没结算」（探针 D，Tab 没跟踪到的残留） */
  failHaltTimes = 0;
  /** 返回 true 期间终止直接 ERR_FAILED：模拟「Tab 上挂着的对话框没回答之前，新导航进不去」（探针 D1） */
  blockWhile: () => boolean = () => false;
  /** 恢复（loadURL 原地址）：已提交但 Promise 永不 resolve（慢站点） */
  hangRestore = false;
  loads: string[] = [];
  /** 终止那一刻 will-prevent-unload 监听数（证明「终止期间确实挂了」） */
  listenersDuringHalt: number[] = [];

  constructor(urls: string[], active = urls.length - 1) {
    super();
    this.entries = urls.map((url) => ({ url }));
    this.active = active;
  }

  isDestroyed = () => this.destroyedFlag;
  getURL = () => this.entries[this.active]?.url ?? "";

  commit(url: string) {
    this.entries.splice(this.active + 1); // 导航截掉前进栈
    this.entries.push({ url });
    this.active = this.entries.length - 1;
  }

  loadURL = vi.fn((url: string): Promise<void> => {
    this.loads.push(url);
    if (url === BLANK) {
      this.listenersDuringHalt.push(this.listenerCount("will-prevent-unload"));
      if (this.hangHalt) return new Promise<void>(() => {});
      if (this.blockWhile() || this.failHaltTimes > 0) {
        if (this.failHaltTimes > 0) this.failHaltTimes -= 1;
        return Promise.reject(Object.assign(new Error("ERR_FAILED (-2)"), { code: "ERR_FAILED" }));
      }
      if (this.hasBeforeUnload) {
        const ev = { prevented: false, preventDefault() { this.prevented = true; } };
        this.emit("will-prevent-unload", ev);
        if (!ev.prevented) return Promise.reject(Object.assign(new Error("ERR_ABORTED (-3)"), { code: "ERR_ABORTED" }));
      }
      this.commit(url);
      return Promise.resolve();
    }
    this.commit(url);
    return this.hangRestore ? new Promise<void>(() => {}) : Promise.resolve();
  });

  navigationHistory = {
    getActiveIndex: () => this.active,
    length: () => this.entries.length,
    getEntryAtIndex: (i: number) => this.entries[i] ?? null,
    removeEntryAtIndex: (i: number) => {
      if (i === this.active || i < 0 || i >= this.entries.length) return false;
      this.entries.splice(i, 1);
      if (i < this.active) this.active -= 1;
      return true;
    },
  };
}

class FakeTab {
  id = "t1";
  partition: string = BROWSER_PARTITION;
  incognito = false;
  destroyed = false;
  /** 真 Tab 的挂起对话框（CDP 接管后 beforeunload / alert / confirm / prompt 都落在这里） */
  pendingDialog: { type: string } | null = null;
  /** 真 Tab 的 answerDialog：同步摘掉挂起状态再发 CDP */
  // 与真 Tab.answerDialog 同签名（调用方会传 3 个参数）；假实现只需要摘掉挂起状态
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  answerDialog = vi.fn(async (_accept: boolean, _text?: string, _opts?: { by?: string }) => {
    this.pendingDialog = null;
    return { handled: true, dialog: null };
  });
  loadUrlByUser = vi.fn((u: string) => this.wc.loadURL(u));
  constructor(public wc: FakeWc) {}
  get url() {
    return this.wc.getURL();
  }
}

const urls = (wc: FakeWc) => wc.entries.map((e) => e.url.replace(ORIGIN, ""));
/** 探针里的典型栈：Tab 的初始空白条目 + 三个页面，当前在最后一个（登录页） */
const typical = () => new FakeWc([BLANK, `${ORIGIN}/p1`, `${ORIGIN}/p2`, `${ORIGIN}/`], 3);

// ───────────────────────── 夹具自检 ─────────────────────────

describe("夹具自检：与探针实测的 Chromium 行为一致", () => {
  it("带 beforeunload 的页面：没人放行时 loadURL(about:blank) 被 ERR_ABORTED，页面原地不动（探针 C1）", async () => {
    const wc = typical();
    wc.hasBeforeUnload = true;
    await expect(wc.loadURL(BLANK)).rejects.toMatchObject({ code: "ERR_ABORTED" });
    expect(wc.getURL()).toBe(`${ORIGIN}/`);
  });

  it("导航截掉前进栈（探针 C4）；removeEntryAtIndex 不能删当前条目", () => {
    const wc = new FakeWc([BLANK, `${ORIGIN}/p1`, `${ORIGIN}/p2`], 1);
    void wc.loadURL(`${ORIGIN}/new`);
    expect(urls(wc)).toEqual([BLANK, "/p1", "/new"]);
    expect(wc.navigationHistory.removeEntryAtIndex(wc.active)).toBe(false);
  });
});

// ───────────────────────── 谁要处理 ─────────────────────────

describe("isClearTarget / collectClearTargets：只处理持久档案里可能持有登录态的页面", () => {
  const tabAt = (url: string, over: Partial<FakeTab> = {}) => {
    const tab = new FakeTab(new FakeWc([BLANK, url], 1));
    Object.assign(tab, over);
    return tab;
  };

  it("持久档案的 http / https 页面 → 处理", () => {
    expect(isClearTarget(tabAt("https://a.example/x"))).toBe(true);
    expect(isClearTarget(tabAt("http://localhost:3000/"))).toBe(true);
  });

  it("不处理：无痕 / 非持久 partition / 已销毁 / wc 已销毁", () => {
    expect(isClearTarget(tabAt("https://a.example/", { incognito: true }))).toBe(false);
    expect(isClearTarget(tabAt("https://a.example/", { partition: "flowship-incognito-t-1" }))).toBe(false);
    expect(isClearTarget(tabAt("https://a.example/", { destroyed: true }))).toBe(false);
    const dead = tabAt("https://a.example/");
    dead.wc.destroyedFlag = true;
    expect(isClearTarget(dead)).toBe(false);
  });

  it("不处理：空白页 / 错误页 / 非 http(s) 协议 / Flowship 自身地址 / 取不到 url", () => {
    expect(isClearTarget(tabAt(BLANK))).toBe(false);
    expect(isClearTarget(tabAt("chrome-error://chromewebdata/"))).toBe(false);
    expect(isClearTarget(tabAt("file:///etc/passwd"))).toBe(false);
    expect(isClearTarget(tabAt("https://flowship.local/"), undefined)).toBe(true); // 没传 isAppUrl 就不知道它是应用自身
    expect(isClearTarget(tabAt("https://flowship.local/"), { isAppUrl: (u: string) => u.includes("flowship.local") })).toBe(false);
    expect(isClearTarget(null)).toBe(false);
    // 取 url 时抛（wc 在这期间被销毁）：走到 url 检查才抛，所以 partition 要给对
    expect(isClearTarget({ partition: BROWSER_PARTITION, get url() { throw new Error("boom"); }, wc: {} })).toBe(false);
  });

  it("collectClearTargets：跨会话收集，过滤掉非目标；入参缺 tabs / 不可迭代都不抛", () => {
    const a = tabAt("https://a.example/");
    const b = tabAt("https://b.example/");
    const inc = tabAt("https://inc.example/", { incognito: true });
    const blank = tabAt(BLANK);
    const out = collectClearTargets([{ tabs: [a, inc] }, { tabs: [blank, b] }, {}, null as any]);
    expect(out).toEqual([a, b]);
    expect(collectClearTargets(undefined as never)).toEqual([]); // 故意传非法入参：主进程里 sessions 可能为空
  });
});

// ───────────────────────── 终止 ─────────────────────────

describe("haltTabsForClear：让页面停下", () => {
  it("正常页面：导航到 about:blank；记下清除前的地址与历史下标", async () => {
    const wc = typical();
    const [rec] = await haltTabsForClear([new FakeTab(wc)]);
    expect(wc.getURL()).toBe(BLANK);
    expect(rec).toMatchObject({ url: `${ORIGIN}/`, idx: 3, outcome: "ok" });
  });

  it("页面带 beforeunload：终止期间挂了 will-prevent-unload 强制放行；终止后监听摘掉，不留尾巴", async () => {
    const wc = typical();
    wc.hasBeforeUnload = true;
    const [rec] = await haltTabsForClear([new FakeTab(wc)]);
    expect(rec.outcome).toBe("ok");
    expect(wc.getURL()).toBe(BLANK);
    expect(wc.listenersDuringHalt).toEqual([1]); // 终止那一刻确实挂着
    expect(wc.listenerCount("will-prevent-unload")).toBe(0); // 之后摘干净
  });

  it("卡死的页面：到点就放弃（不拖住清除），监听同样摘掉；记录仍交回（恢复阶段会补救）", async () => {
    const wc = typical();
    wc.hangHalt = true;
    const t0 = Date.now();
    const [rec] = await haltTabsForClear([new FakeTab(wc)], { timeoutMs: 20 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(rec.outcome).toBe("timeout");
    expect(wc.listenerCount("will-prevent-unload")).toBe(0);
  });

  it("loadURL 被拒（页面仍在原地）：记 error，不抛，其它标签不受影响", async () => {
    const bad = typical();
    bad.loadURL.mockImplementationOnce(() => Promise.reject(Object.assign(new Error("x"), { code: "ERR_BLOCKED_BY_CLIENT" })));
    const good = typical();
    const recs = await haltTabsForClear([new FakeTab(bad), new FakeTab(good)]);
    expect(recs[0].outcome).toBe("error:ERR_BLOCKED_BY_CLIENT");
    expect(bad.getURL()).toBe(`${ORIGIN}/`);
    expect(recs[1].outcome).toBe("ok");
    expect(good.getURL()).toBe(BLANK);
  });

  describe("页面刚被 beforeunload 拦过一次导航（探针 D：Tab 上留着没结算的离开确认框，新导航会 ERR_FAILED）", () => {
    // 数 loadURL 的调用而不是 wc.loads：mockImplementationOnce 会绕过夹具里记录 loads 的真实现
    const blankLoads = (wc: FakeWc) => wc.loadURL.mock.calls.filter(([u]) => u === BLANK).length;

    it("Tab 上挂着 beforeunload → 先确认掉（确认 = 离开页面）再终止，一次就成、不走重试（探针 D2）", async () => {
      const wc = typical();
      const tab = new FakeTab(wc);
      tab.pendingDialog = { type: "beforeunload" };
      wc.blockWhile = () => tab.pendingDialog !== null;
      const [rec] = await haltTabsForClear([tab]);
      expect(tab.answerDialog).toHaveBeenCalledTimes(1);
      expect(tab.answerDialog).toHaveBeenCalledWith(true, undefined, { by: "user" });
      expect(rec.outcome).toBe("ok");
      expect(blankLoads(wc)).toBe(1);
      expect(wc.getURL()).toBe(BLANK);
    });

    it("挂着的是页面的 confirm / alert / prompt → 绝不替用户点（可能是「确定删除全部？」），终止失败、页面原地不动", async () => {
      for (const type of ["confirm", "alert", "prompt"]) {
        const wc = typical();
        const tab = new FakeTab(wc);
        tab.pendingDialog = { type };
        wc.blockWhile = () => tab.pendingDialog !== null;
        const [rec] = await haltTabsForClear([tab], { timeoutMs: 80, retryDelaysMs: [5, 5] });
        expect(tab.answerDialog, type).not.toHaveBeenCalled();
        expect(rec.outcome, type).toBe("error:ERR_FAILED");
        expect(wc.getURL(), type).toBe(`${ORIGIN}/`);
      }
    });

    it("Tab 没跟踪到的残留（没有 pendingDialog 但仍 ERR_FAILED）：在时限内重试，等它结算后终止成功（探针 D3）", async () => {
      const wc = typical();
      wc.failHaltTimes = 2;
      const tab = new FakeTab(wc);
      const [rec] = await haltTabsForClear([tab], { retryDelaysMs: [5, 5, 5] });
      expect(rec.outcome).toBe("ok");
      expect(blankLoads(wc)).toBe(3);
      expect(wc.getURL()).toBe(BLANK);
      expect(wc.listenerCount("will-prevent-unload")).toBe(0);
    });

    it("一直 ERR_FAILED：重试次数有界、到点放弃，不会挂住清除；监听照样摘干净", async () => {
      const wc = typical();
      wc.failHaltTimes = 999;
      const t0 = Date.now();
      const [rec] = await haltTabsForClear([new FakeTab(wc)], { timeoutMs: 120, retryDelaysMs: [5, 5, 5] });
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(rec.outcome).toBe("error:ERR_FAILED");
      expect(blankLoads(wc)).toBe(4); // 1 次 + 3 次重试
      expect(wc.listenerCount("will-prevent-unload")).toBe(0);
    });

    it("重试预算被时限截断：下一次等待会越过截止时间就不等了", async () => {
      const wc = typical();
      wc.failHaltTimes = 999;
      await haltTabsForClear([new FakeTab(wc)], { timeoutMs: 40, retryDelaysMs: [5, 5000] });
      expect(blankLoads(wc)).toBe(2); // 第二次重试要等 5s、越过 40ms 的截止时间 → 放弃
    });

    it("只有 ERR_FAILED 重试：别的失败（例如被用户另一次导航顶掉的 ERR_ABORTED）重试只会和用户抢导航", async () => {
      const wc = typical();
      wc.loadURL.mockImplementationOnce(() => Promise.reject(Object.assign(new Error("x"), { code: "ERR_ABORTED" })));
      const [rec] = await haltTabsForClear([new FakeTab(wc)], { retryDelaysMs: [5, 5] });
      expect(rec.outcome).toBe("error:ERR_ABORTED");
      expect(blankLoads(wc)).toBe(1);
    });

    it("answerDialog 抛错：日志记一笔、不抛，终止流程继续", async () => {
      const wc = typical();
      const tab = new FakeTab(wc);
      tab.pendingDialog = { type: "beforeunload" };
      tab.answerDialog.mockRejectedValueOnce(new Error("CDP 断了"));
      const log = vi.fn();
      const [rec] = await haltTabsForClear([tab], { log });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("确认离开提示出错"));
      expect(rec.outcome).toBe("ok"); // 没有 blockWhile：终止本身能成
    });

    it("tab 没有 answerDialog / pendingDialog（假对象）也不抛", async () => {
      const wc = typical();
      const tab = new FakeTab(wc) as any;
      tab.answerDialog = undefined;
      tab.pendingDialog = { type: "beforeunload" };
      const [rec] = await haltTabsForClear([tab]);
      expect(rec.outcome).toBe("ok");
    });
  });

  it("wc 方法同步抛错：不抛出来，日志记一笔", async () => {
    const wc = typical();
    wc.getURL = () => {
      throw new Error("Object has been destroyed");
    };
    const log = vi.fn();
    const [rec] = await haltTabsForClear([new FakeTab(wc)], { log });
    expect(rec.outcome).toMatch(/^error:/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("终止页面出错"));
  });

  it("多个标签并发终止；已销毁的标签被滤掉；非数组入参 = 空", async () => {
    const a = typical();
    const b = typical();
    const dead = new FakeTab(typical());
    dead.destroyed = true;
    const recs = await haltTabsForClear([new FakeTab(a), dead, new FakeTab(b)]);
    expect(recs).toHaveLength(2);
    expect(a.getURL()).toBe(BLANK);
    expect(b.getURL()).toBe(BLANK);
    await expect(haltTabsForClear(undefined as any)).resolves.toEqual([]);
  });
});

// ───────────────────────── 恢复 + 修剪 ─────────────────────────

describe("resumeTabsAfterClear：回到原地址，后退栈原样", () => {
  it("终止 → 恢复 → 修剪：历史栈与当前下标复原（探针 C3）；经 loadUrlByUser 发起（登记浏览器发起令牌）", async () => {
    const wc = typical();
    const tab = new FakeTab(wc);
    const halted = await haltTabsForClear([tab]);
    expect(resumeTabsAfterClear(halted)).toBe(1);
    expect(tab.loadUrlByUser).toHaveBeenCalledWith(`${ORIGIN}/`);
    await flush();
    expect(urls(wc)).toEqual([BLANK, "/p1", "/p2", "/"]);
    expect(wc.active).toBe(3);
    expect(wc.navigationHistory.length()).toBe(4);
  });

  it("带 beforeunload 的页面也能走完整个流程", async () => {
    const wc = typical();
    wc.hasBeforeUnload = true;
    const tab = new FakeTab(wc);
    const halted = await haltTabsForClear([tab]);
    expect(resumeTabsAfterClear(halted)).toBe(1);
    await flush();
    expect(urls(wc)).toEqual([BLANK, "/p1", "/p2", "/"]);
  });

  it("用户停在历史中间（后退过）：前进栈丢失——about:blank 是一次真实导航（已知限制，探针 C4）", async () => {
    const wc = new FakeWc([BLANK, `${ORIGIN}/p1`, `${ORIGIN}/p2`, `${ORIGIN}/`], 2);
    const tab = new FakeTab(wc);
    const halted = await haltTabsForClear([tab]);
    resumeTabsAfterClear(halted);
    await flush();
    expect(urls(wc)).toEqual([BLANK, "/p1", "/p2"]);
    expect(wc.active).toBe(2);
    expect(wc.navigationHistory.length()).toBe(3);
  });

  it("终止没生效（页面还在原地）→ 不动、不计数", async () => {
    const wc = typical();
    wc.hasBeforeUnload = true;
    const tab = new FakeTab(wc);
    const halted = [{ tab, url: `${ORIGIN}/`, idx: 3 }]; // 没经过 halt：页面仍停在原地
    expect(resumeTabsAfterClear(halted)).toBe(0);
    expect(tab.loadUrlByUser).not.toHaveBeenCalled();
    expect(urls(wc)).toEqual([BLANK, "/p1", "/p2", "/"]);
  });

  it("终止超时、页面稍后才进入 about:blank：恢复阶段补救，不让标签停在空白页", async () => {
    const wc = typical();
    wc.hangHalt = true;
    const tab = new FakeTab(wc);
    const halted = await haltTabsForClear([tab], { timeoutMs: 15 });
    expect(halted[0].outcome).toBe("timeout");
    wc.commit(BLANK); // 迟到的导航终于提交了
    wc.hangHalt = false;
    expect(resumeTabsAfterClear(halted)).toBe(1);
    expect(wc.getURL()).toBe(`${ORIGIN}/`);
  });

  it("恢复地址被策略拒绝（应用自身地址）→ 不恢复", async () => {
    const wc = typical();
    const tab = new FakeTab(wc);
    const halted = await haltTabsForClear([tab]);
    expect(resumeTabsAfterClear(halted, { isAppUrl: (u: string) => u.startsWith(ORIGIN) })).toBe(0);
    expect(wc.getURL()).toBe(BLANK);
  });

  it("恢复时 tab 已销毁 / loadUrlByUser 同步抛错：不抛，其余标签照常恢复，日志记一笔", async () => {
    const a = new FakeTab(typical());
    const b = new FakeTab(typical());
    const c = new FakeTab(typical());
    const halted = await haltTabsForClear([a, b, c]);
    a.destroyed = true;
    b.loadUrlByUser.mockImplementationOnce(() => {
      throw new Error("Object has been destroyed");
    });
    const log = vi.fn();
    expect(resumeTabsAfterClear(halted, { log })).toBe(1);
    expect(c.wc.getURL()).toBe(`${ORIGIN}/`);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("恢复页面出错"));
  });

  it("没有 loadUrlByUser 的 tab：回退到 wc.loadURL", async () => {
    const wc = typical();
    const tab = new FakeTab(wc) as any;
    tab.loadUrlByUser = undefined;
    const halted = await haltTabsForClear([tab]);
    expect(resumeTabsAfterClear(halted)).toBe(1);
    expect(wc.getURL()).toBe(`${ORIGIN}/`);
  });

  it("页面迟迟不提交（超时）→ 不修剪：宁可多留两条历史，也不在页面没提交时乱删", async () => {
    const wc = typical();
    wc.hangRestore = true;
    const tab = new FakeTab(wc);
    const halted = await haltTabsForClear([tab]);
    resumeTabsAfterClear(halted, { timeoutMs: 15 });
    await new Promise((r) => setTimeout(r, 60));
    expect(wc.navigationHistory.length()).toBe(6); // 原 4 + about:blank + 新页
  });

  it("恢复期间标签 / wc 被销毁 → 页面提交后不再去碰它的历史（不修剪、不抛）", async () => {
    for (const destroy of [(t: FakeTab) => (t.destroyed = true), (t: FakeTab) => (t.wc.destroyedFlag = true)]) {
      const wc = typical();
      const tab = new FakeTab(wc);
      const halted = await haltTabsForClear([tab]);
      const log = vi.fn();
      expect(resumeTabsAfterClear(halted, { log })).toBe(1);
      destroy(tab); // 发起恢复之后、结果落地之前
      await flush();
      expect(wc.navigationHistory.length(), "没有修剪").toBe(6);
      expect(log).not.toHaveBeenCalled();
    }
  });
});

describe("pruneClearHistory：只在栈恰好是 [旧页, about:blank, 新页] 时才删", () => {
  /** 终止 / 恢复之后的典型栈：原下标 3 → 现在 [.., 旧页(3), blank(4), 新页(5)] */
  const afterRestore = () => {
    const wc = typical();
    wc.commit(BLANK);
    wc.commit(`${ORIGIN}/`);
    return wc;
  };

  it("形状对 → 先删 about:blank、再删旧页，返回 true", () => {
    const wc = afterRestore();
    expect(pruneClearHistory(wc, 3)).toBe(true);
    expect(urls(wc)).toEqual([BLANK, "/p1", "/p2", "/"]);
    expect(wc.active).toBe(3);
  });

  it("栈长度对不上（用户在这期间又导航了）→ 不动", () => {
    const wc = afterRestore();
    wc.commit(`${ORIGIN}/more`);
    expect(pruneClearHistory(wc, 3)).toBe(false);
    expect(wc.navigationHistory.length()).toBe(7);
  });

  it("当前条目不是栈顶（用户又后退了）→ 不动", () => {
    const wc = afterRestore();
    wc.active = 4;
    expect(pruneClearHistory(wc, 3)).toBe(false);
    expect(wc.navigationHistory.length()).toBe(6);
  });

  it("新页后面还有前进条目（用户又导航了一次、再后退回新页）→ 不动：当前下标虽然对得上，形状不是「恰好三条」", () => {
    const wc = afterRestore();
    wc.commit(`${ORIGIN}/more`);
    wc.active = 5; // 回到新页：active === idx + 2，但栈长是 idx + 4
    expect(pruneClearHistory(wc, 3)).toBe(false);
    expect(urls(wc)).toEqual([BLANK, "/p1", "/p2", "/", BLANK, "/", "/more"]);
  });

  it("idx+1 不是 about:blank → 不动", () => {
    const wc = afterRestore();
    wc.entries[4].url = `${ORIGIN}/other`;
    expect(pruneClearHistory(wc, 3)).toBe(false);
    expect(wc.navigationHistory.length()).toBe(6);
  });

  it("idx 未知（< 0 / NaN）或 API 不全（旧 Electron / 假 wc）→ 不动、不抛", () => {
    const wc = afterRestore();
    expect(pruneClearHistory(wc, -1)).toBe(false);
    expect(pruneClearHistory(wc, Number.NaN)).toBe(false);
    expect(pruneClearHistory({ navigationHistory: { canGoBack: () => false } }, 3)).toBe(false);
    expect(pruneClearHistory({}, 3)).toBe(false);
    expect(pruneClearHistory(null, 3)).toBe(false);
    expect(wc.navigationHistory.length()).toBe(6);
  });

  it("idx 未知时，哪怕栈凑巧是 [about:blank, 新页]（去掉 idx+1 / idx 会删错条目）也不动", () => {
    const wc = new FakeWc([BLANK, `${ORIGIN}/`], 1);
    expect(pruneClearHistory(wc, -1)).toBe(false);
    expect(urls(wc)).toEqual([BLANK, "/"]);
    expect(wc.active).toBe(1);
  });

  it("removeEntryAtIndex 抛错 → 返回 false，日志记一笔", () => {
    const wc = afterRestore();
    wc.navigationHistory.removeEntryAtIndex = () => {
      throw new Error("boom");
    };
    const log = vi.fn();
    expect(pruneClearHistory(wc, 3, log)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("修剪历史出错"));
  });
});

// ───────────────────────── 经真 createBrowserManager：browser:clearBrowsingData ─────────────────────────

describe("browser:clearBrowsingData（真 manager + 假 electron）：终止 → 清除 → 恢复", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const makeManager = (opts: { isAppUrl?: (url: string) => boolean } = {}) => {
    const order: string[] = [];
    const wcs: any[] = [];
    class MWc extends EventEmitter {
      inner: FakeWc;
      prefs: Record<string, unknown> = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true };
      setWindowOpenHandler = vi.fn();
      setAudioMuted = vi.fn();
      destroyedFlag = false;
      isDestroyed = () => this.destroyedFlag;
      isLoading = () => false;
      getTitle = () => "";
      stop = vi.fn();
      getZoomLevel = () => 0;
      getLastWebPreferences = () => this.prefs;
      capturePage = vi.fn(async () => ({ isEmpty: () => true }));
      debugger = { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), on: vi.fn(), sendCommand: vi.fn(async () => ({})) };
      close = vi.fn(() => {
        queueMicrotask(() => {
          this.destroyedFlag = true;
          this.emit("destroyed");
        });
      });
      constructor() {
        super();
        // 空栈起步：真 Tab 创建后会自己 loadURL("about:blank") 产生第一条，之后 navigate 才是第二条
        this.inner = new FakeWc([], -1);
      }
      getURL = () => this.inner.getURL();
      loadURL = vi.fn((url: string) => {
        order.push(`load:${url}`);
        return this.inner.loadURL(url);
      });
      get navigationHistory() {
        return { canGoBack: () => this.inner.active > 0, canGoForward: () => this.inner.active < this.inner.entries.length - 1, ...this.inner.navigationHistory };
      }
    }
    class FakeView {
      webContents: MWc;
      setBounds = vi.fn();
      setVisible = vi.fn();
      setBackgroundColor = vi.fn();
      constructor(o: Record<string, any>) {
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
        s = {
          name,
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          setDevicePermissionHandler: vi.fn(),
          on: vi.fn(),
          clearStorageData: vi.fn(async () => void order.push("clearStorageData")),
          clearCache: vi.fn(async () => void order.push("clearCache")),
          clearAuthCache: vi.fn(async () => void order.push("clearAuthCache")),
          closeAllConnections: vi.fn(async () => void order.push("closeAllConnections")),
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
      isAppUrl: opts.isAppUrl ?? (() => false),
      isTrustedIpcSender: () => true,
      log: (m: string) => logs.push(m),
      startPicker: () => ({ cancel() {} }),
    } as never);
    (manager as any).registerIpc();
    const dispatch = (op: string, args: Record<string, unknown>, taskId = "T1") => (manager as any).dispatch(op, args, { taskId, signal: undefined });
    const clear = () => handlers.get("browser:clearBrowsingData")!({}) as Promise<unknown>;
    const tabsOf = (taskId: string) => (manager as any).getSession(taskId).tabs as { wc: MWc; incognito: boolean }[];
    return { manager, dispatch, clear, tabsOf, order, sessions, logs, wcs };
  };

  it("顺序钉死：终止页面 → clearStorageData → clearCache → clearAuthCache → closeAllConnections → 恢复页面；返回 reloadedTabs", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "https://a.example/" });
    env.order.length = 0;
    await expect(env.clear()).resolves.toEqual({ reloadedTabs: 1 });
    expect(env.order).toEqual(["load:about:blank", "clearStorageData", "clearCache", "clearAuthCache", "closeAllConnections", "load:https://a.example/"]);
    await flush();
    const inner = env.tabsOf("T1")[0].wc.inner;
    expect(urls(inner).map((u) => u.replace("https://a.example", ""))).toEqual([BLANK, "/"]); // 历史修剪后与清除前一致
  });

  it("清除步骤失败：照样把页面还回去（不能让标签停在空白页），错误仍抛给渲染进程", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "https://a.example/" });
    env.sessions.get(BROWSER_PARTITION)!.clearStorageData = vi.fn(async () => {
      throw new Error("磁盘忙");
    });
    await expect(env.clear()).rejects.toThrow("磁盘忙");
    expect(env.tabsOf("T1")[0].wc.getURL()).toBe("https://a.example/");
  });

  it("流程中途意外抛出（不在逐步隔离的那几步里）：finally 仍把页面还回去，错误照样抛给渲染进程", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "https://a.example/" });
    // 例外表清除那一段遍历会话扩展——它不在 attempt() 的隔离里；让它抛，模拟任何没想到的异常
    (env.manager as any).getSession("T1").ext = {
      values: () => {
        throw new Error("ext boom");
      },
    };
    await expect(env.clear()).rejects.toThrow("ext boom");
    expect(env.tabsOf("T1")[0].wc.getURL()).toBe("https://a.example/");
  });

  it("Flowship 自身地址的标签不碰：不终止、不恢复（manager 把 isAppUrl 传给了收集阶段）", async () => {
    const env = makeManager({ isAppUrl: (u) => u.startsWith("http://flowship.local") });
    await env.dispatch("navigate", { url: "https://a.example/" });
    const [tab] = env.tabsOf("T1");
    tab.wc.inner.commit("http://flowship.local/board"); // 标签眼下停在应用自己的页面上（导航策略拦的是新导航，不拦这种既成事实）
    tab.wc.loadURL.mockClear();
    await expect(env.clear()).resolves.toEqual({ reloadedTabs: 0 });
    expect(tab.wc.loadURL).not.toHaveBeenCalled();
    expect(tab.wc.getURL()).toBe("http://flowship.local/board");
  });

  it("无痕标签不碰：既不终止也不恢复；空白页标签同样不动；reloadedTabs 只数真正重载的", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "https://a.example/" });
    await env.dispatch("tabs", { action: "new" }); // 空白页标签
    await env.dispatch("tabs", { action: "new", incognito: true });
    await env.dispatch("navigate", { url: "https://inc.example/" }); // 新建后激活的是无痕标签
    const [normal, blank, inc] = env.tabsOf("T1");
    expect(inc.incognito).toBe(true);
    for (const t of [normal, blank, inc]) t.wc.loadURL.mockClear();
    await expect(env.clear()).resolves.toEqual({ reloadedTabs: 1 });
    expect(normal.wc.loadURL.mock.calls.map((c) => c[0])).toEqual([BLANK, "https://a.example/"]);
    expect(blank.wc.loadURL).not.toHaveBeenCalled();
    expect(inc.wc.loadURL).not.toHaveBeenCalled();
    expect(inc.wc.getURL()).toBe("https://inc.example/");
  });

  it("清除作用于整份持久档案：多个任务（会话）里的标签都处理", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "https://a.example/" }, "T1");
    await env.dispatch("navigate", { url: "https://b.example/" }, "T2");
    await expect(env.clear()).resolves.toEqual({ reloadedTabs: 2 });
    await flush();
    expect(env.tabsOf("T1")[0].wc.getURL()).toBe("https://a.example/");
    expect(env.tabsOf("T2")[0].wc.getURL()).toBe("https://b.example/");
  });

  it("单飞：并发的两次调用只跑一轮（共用结果）；这一轮结束后可以再来", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "https://a.example/" });
    const persistent = env.sessions.get(BROWSER_PARTITION)!;
    const [r1, r2] = await Promise.all([env.clear(), env.clear()]);
    expect(r1).toEqual({ reloadedTabs: 1 });
    expect(r2).toBe(r1);
    expect(persistent.clearStorageData).toHaveBeenCalledTimes(1);
    await flush();
    await env.clear();
    expect(persistent.clearStorageData).toHaveBeenCalledTimes(2);
  });

  it("上一轮失败后单飞锁会释放：下一次调用能正常再跑", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "https://a.example/" });
    const persistent = env.sessions.get(BROWSER_PARTITION)!;
    persistent.clearStorageData.mockImplementationOnce(async () => {
      throw new Error("第一次失败");
    });
    await expect(env.clear()).rejects.toThrow("第一次失败");
    await flush();
    await expect(env.clear()).resolves.toEqual({ reloadedTabs: 1 });
  });
});
