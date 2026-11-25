/**
 * tab.evalInFrames / tab.frameInventory（第二十一、二十二轮）：
 *  - evalInFrames：在每个 frame 的**隔离世界**里各跑一遍表达式、按值取回；CDP 没就绪回 null；分批并发（R22-3）。
 *  - frameInventory：各会话 Page.getFrameTree 合并成 `[{ id, url }]`，权限闸用它确认「同 origin 的框架都回应了」（R22-3）。
 * 权限闸用它们核对「跨源 iframe 是否被顶层委托了麦克风 / 摄像头」（permission-gate.mjs 的 frameDelegation）。
 *  - 第二十三轮（R23-5）：evalInFrames 的总时限（框架多又都卡死时不再按批累加）。
 *  - 第二十三轮（R23-3）：addEarlySessionHook——页内权限桩注册在这里，与域启用并行、先于 setAutoAttach / 页面脚本 / 普通会话钩子。
 *  - 第二十四轮（R24-1 / P3-2）：收养弹窗的迟到登记要补调；ensureCdp 队列外自愈单飞。
 *  - 第二十五轮（N-2 / N-3 / N-4 与评审测试 A / B / F）：单飞结束后重判（最多 CDP_HEAL_MAX_ROUNDS 轮）；早钩子循环里判仍在集合、销毁守卫、同函数重复登记；门的真桩钩子 + 真收养 BrowserTab 的联合用例。
 *  - 第二十六轮（T-5 / X-2）：轮数用完放行前再判一次（tab 已关抛 TAB_NOT_FOUND、仍没就绪写一行日志，醒来后 tab 已关也统一抛）；崩溃循环用例的崩溃次数改成有限值（用 Infinity，实现一旦被改成无界追逐就卡死而不是变红）。
 * 真 BrowserTab + 假 wc / 假 debugger；OOPIF 子会话的执行上下文用 Runtime.executionContextCreated 事件模拟。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPermissionGate, MEDIA_QUERY_STUB_SOURCE } from "../electron-app/browser/permission-gate.mjs";
import { BrowserTab, CDP_HEAL_MAX_ROUNDS, EVAL_IN_FRAMES_CONCURRENCY, EVAL_IN_FRAMES_TOTAL_MS } from "../electron-app/browser/tab.mjs";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type Sent = { method: string; params: Record<string, unknown>; sessionId?: string };

type FrameTreeNode = { frame: { id: string; url?: string }; childFrames?: FrameTreeNode[] };

type MakeTabOpts = {
  /** 按「收养的 window.open 弹窗」构造（deps.adopt）：不先 loadURL，构造函数里就同步跑到主会话初始化的第一步（R24-1） */
  adopt?: boolean;
  /** 每条 CDP 命令发出之后、应答之前先等它（返回 Promise 就挂住这条命令；返回 undefined 不等）——造「自愈悬挂」用 */
  gate?: (method: string, sessionId?: string) => Promise<unknown> | undefined;
};

const makeTab = (
  onEvaluate: (params: Record<string, unknown>, sessionId?: string) => unknown,
  onFrameTree: (sessionId?: string) => unknown = () => ({ frameTree: { frame: { id: "F1" } } as FrameTreeNode }),
  opts: MakeTabOpts = {},
) => {
  let attached = false;
  const sent: Sent[] = [];
  let onMessage: (e: unknown, method: string, params: unknown, sessionId?: string) => void = () => {};
  const dbg = {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    detach: () => {
      attached = false;
    },
    on: vi.fn((event: string, fn: typeof onMessage) => {
      if (event === "message") onMessage = fn;
    }),
    sendCommand: vi.fn(async (method: string, params: Record<string, unknown>, sessionId?: string) => {
      sent.push({ method, params, sessionId });
      const held = opts.gate?.(method, sessionId);
      if (held) await held;
      if (method === "Page.getFrameTree") return onFrameTree(sessionId);
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "s1" };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate" && params.returnByValue === true) return onEvaluate(params, sessionId);
      return {};
    }),
  };
  let destroyed = false;
  const wc = {
    debugger: dbg,
    on: vi.fn(),
    isDestroyed: () => destroyed,
    setWindowOpenHandler: vi.fn(),
    setAudioMuted: vi.fn(),
    loadURL: vi.fn(() => Promise.resolve()),
    // 收养弹窗前 tab 会核对它的偏好不比普通 tab 宽松（isSafePopupPrefs）
    getLastWebPreferences: () => ({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }),
    getURL: () => "https://a.example.com/",
    getTitle: () => "t",
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    close: vi.fn(),
  };
  class FakeView {
    webContents = wc;
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    setVisible = vi.fn();
  }
  const hooks = {
    onChange: vi.fn(),
    onLoaded: vi.fn(),
    onNewTab: vi.fn(),
    onRecorder: vi.fn(),
    onBlocked: vi.fn(),
    onDialog: vi.fn(),
    onNeedLockSync: vi.fn(),
    onCrashed: vi.fn(),
  };
  const logs: string[] = [];
  const tab = new BrowserTab({
    id: "t1",
    WebContentsView: FakeView as never,
    parkingWindow: { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } },
    pageScripts: { PAGE_WORLD_NAME: "flowship", RECORDER_BINDING: "__rec", buildPageScript: () => "//" } as never,
    isAppUrl: () => false,
    hooks,
    log: (m: string) => logs.push(m),
    ...(opts.adopt ? { adopt: { webContents: wc } } : {}),
  });
  return {
    tab,
    sent,
    logs,
    /** 模拟 CDP 事件：一个 OOPIF 子会话挂接上来（进 tab.children） */
    attachChild: (sessionId: string, targetId = `T-${sessionId}`) =>
      onMessage({}, "Target.attachedToTarget", { sessionId, targetInfo: { type: "iframe", targetId } }, undefined),
    /** 模拟 CDP 事件：一个 OOPIF 子会话 detach 了（出 tab.children） */
    detachChild: (sessionId: string) => onMessage({}, "Target.detachedFromTarget", { sessionId }, undefined),
    /** 模拟 CDP 事件：一个 OOPIF 子会话里的框架建好了隔离世界 */
    childWorld: (sessionId: string, frameId: string, contextId: number) =>
      onMessage({}, "Runtime.executionContextCreated", { context: { id: contextId, name: "flowship", auxData: { frameId } } }, sessionId),
    destroy: () => {
      destroyed = true;
    },
  };
};

const evals = (sent: Sent[]) => sent.filter((s) => s.method === "Runtime.evaluate" && s.params.returnByValue === true);

describe("tab.evalInFrames", () => {
  it("每个 frame 的隔离世界各跑一遍：带 contextId / returnByValue，OOPIF 子会话的发到自己的 sessionId；返回 [{ key, value }]", async () => {
    const h = makeTab((params, sessionId) => ({ result: { value: { ctx: params.contextId, sid: sessionId ?? null } } }));
    await h.tab.ready;
    h.childWorld("child-1", "F2", 9);
    const rows = await h.tab.evalInFrames("1+1");
    expect(rows).toEqual(
      expect.arrayContaining([
        { key: "main:F1", value: { ctx: 7, sid: null } },
        { key: "child-1:F2", value: { ctx: 9, sid: "child-1" } },
      ]),
    );
    expect(rows).toHaveLength(2);
    const calls = evals(h.sent);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.params).toMatchObject({ expression: "1+1", returnByValue: true, silent: true });
    }
    // 不抢主世界：没有往页面主世界（不带 contextId）发过这个表达式
    expect(calls.every((c) => typeof c.params.contextId === "number")).toBe(true);
  });

  it("抛异常（exceptionDetails）/ 命令失败 / 超时的 frame 不出现在结果里，其余照常返回；不抛", async () => {
    const h = makeTab((params) => {
      if (params.contextId === 9) return { exceptionDetails: { text: "boom" }, result: {} };
      if (params.contextId === 11) throw new Error("context destroyed");
      if (params.contextId === 12) return new Promise(() => {}); // 永不应答
      return { result: { value: "ok" } };
    });
    await h.tab.ready;
    h.childWorld("c1", "F2", 9);
    h.childWorld("c2", "F3", 11);
    h.childWorld("c3", "F4", 12);
    const p = h.tab.evalInFrames("x", { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toEqual([{ key: "main:F1", value: "ok" }]);
  });

  it("没有任何隔离世界 → 空数组；标签页已销毁 → 空数组（不抛）", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }));
    await h.tab.ready;
    h.tab.isoContexts.clear();
    expect(await h.tab.evalInFrames("x")).toEqual([]);
    const g = makeTab(() => ({ result: { value: 1 } }));
    await g.tab.ready;
    g.destroy();
    expect(await g.tab.evalInFrames("x")).toEqual([]);
  });
});

describe("tab.evalInFrames：CDP 没就绪 / 并发上限（R22-3）", () => {
  it("cdpReady 为假（渲染进程崩溃重载 / debugger 掉线）：isoContexts 里是旧上下文——直接回 null、一条命令都不发，不空等 timeoutMs", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }));
    await h.tab.ready;
    h.childWorld("child-1", "F2", 9);
    expect(h.tab.isoContexts.size).toBeGreaterThan(0);
    const before = evals(h.sent).length;
    h.tab.cdpReady = false;
    expect(await h.tab.evalInFrames("x")).toBeNull();
    expect(evals(h.sent)).toHaveLength(before);
    // 对照：就绪时同样的上下文正常取值
    h.tab.cdpReady = true;
    expect(await h.tab.evalInFrames("x")).toHaveLength(2);
  });

  it("分批并发：框架很多时同时在飞的 Runtime.evaluate 不超过 EVAL_IN_FRAMES_CONCURRENCY；全部结果照常返回", async () => {
    expect(EVAL_IN_FRAMES_CONCURRENCY).toBe(8);
    let inflight = 0;
    let maxInflight = 0;
    const h = makeTab(
      () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        return new Promise((resolve) =>
          setTimeout(() => {
            inflight -= 1;
            resolve({ result: { value: "ok" } });
          }, 10),
        );
      },
    );
    await h.tab.ready;
    for (let i = 0; i < 20; i++) h.childWorld(`c${i}`, `FX${i}`, 100 + i);
    const p = h.tab.evalInFrames("x");
    await vi.advanceTimersByTimeAsync(2000);
    const rows = await p;
    expect(rows).toHaveLength(21); // 主 frame + 20 个子框架
    expect(maxInflight).toBe(EVAL_IN_FRAMES_CONCURRENCY); // 真的并发了（不是串行），也没超过上限
  });
});

describe("tab.frameInventory：各会话的 Page.getFrameTree 合并（权限闸的兄弟框架核对用，R22-3）", () => {
  const tree = (id: string, url: string, kids: FrameTreeNode[] = []): { frameTree: FrameTreeNode } => ({ frameTree: { frame: { id, url }, childFrames: kids } });

  it("主会话树 + OOPIF 子会话树合并成 [{ id, url }]；同一 frameId 只出现一次、以子会话里的 url 为准；每个会话各发一条 Page.getFrameTree", async () => {
    const h = makeTab(
      () => ({ result: { value: 1 } }),
      (sessionId) =>
        sessionId === "child-1"
          ? tree("F3", "https://c.example.com/real")
          : tree("F1", "https://a.example.com/", [
              { frame: { id: "F2", url: "https://b.example.com/f" } },
              { frame: { id: "F3", url: "about:blank" } }, // OOPIF 的根 frame 在父会话的树里是个叶子，url 不可靠
            ]),
    );
    await h.tab.ready;
    h.attachChild("child-1");
    await vi.advanceTimersByTimeAsync(10);
    const before = h.sent.filter((x) => x.method === "Page.getFrameTree").length;
    const inv = await h.tab.frameInventory();
    expect(inv).toHaveLength(3);
    expect(inv).toEqual(
      expect.arrayContaining([
        { id: "F1", url: "https://a.example.com/" },
        { id: "F2", url: "https://b.example.com/f" },
        { id: "F3", url: "https://c.example.com/real" },
      ]),
    );
    const trees = h.sent.filter((x) => x.method === "Page.getFrameTree");
    expect(trees.length - before).toBe(2); // 子会话 + 主会话
    expect(trees.slice(before).map((x) => x.sessionId ?? null)).toEqual(expect.arrayContaining([null, "child-1"]));
  });

  it("任何一个会话取不到（抛错 / 超时）→ 整体 null（清单不完整就等于没有）；cdpReady 为假 → null 且不发命令", async () => {
    const h = makeTab(
      () => ({ result: { value: 1 } }),
      (sessionId) => {
        if (sessionId === "child-1") throw new Error("session gone");
        return tree("F1", "https://a.example.com/");
      },
    );
    await h.tab.ready;
    h.attachChild("child-1");
    await vi.advanceTimersByTimeAsync(10);
    expect(await h.tab.frameInventory()).toBeNull();

    let hang = false; // 初始化（读主 frame id 等）要先过，之后才让 getFrameTree 永不应答
    const g = makeTab(
      () => ({ result: { value: 1 } }),
      () => (hang ? new Promise(() => {}) : tree("F1", "https://a.example.com/")),
    );
    await g.tab.ready;
    hang = true;
    const p = g.tab.frameInventory({ timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(400);
    expect(await p).toBeNull();

    const k = makeTab(() => ({ result: { value: 1 } }));
    await k.tab.ready;
    const n = k.sent.length;
    k.tab.cdpReady = false;
    expect(await k.tab.frameInventory()).toBeNull();
    expect(k.sent).toHaveLength(n);
  });
});

describe("tab.evalInFrames：总时限是硬的（R23-5）", () => {
  it("框架很多又都卡死：总共不超过 totalMs（缺省 EVAL_IN_FRAMES_TOTAL_MS = 3 秒），到点后面的批次不再发——此前按批各等满 timeoutMs，100 个卡死的框架会悬挂约 19 秒", async () => {
    expect(EVAL_IN_FRAMES_TOTAL_MS).toBe(3000);
    const h = makeTab(() => new Promise(() => {})); // 所有 evaluate 永不应答
    await h.tab.ready;
    for (let i = 0; i < 100; i++) h.childWorld(`c${i}`, `FX${i}`, 100 + i);
    let done = false;
    const p = h.tab.evalInFrames("x").then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(EVAL_IN_FRAMES_TOTAL_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
    expect(await p).toEqual([]);
    // 3 秒 = 两批各 1.5 秒；之后剩余时间为 0，其余 85 个框架没有被发命令
    expect(evals(h.sent)).toHaveLength(EVAL_IN_FRAMES_CONCURRENCY * 2);
  });

  it("totalMs 小于 timeoutMs：单次超时被压到剩余时间，到点就返回；totalMs 为 0 / 负数一条命令都不发", async () => {
    const h = makeTab(() => new Promise(() => {}));
    await h.tab.ready;
    for (let i = 0; i < 20; i++) h.childWorld(`c${i}`, `FX${i}`, 100 + i);
    let done = false;
    const p = h.tab.evalInFrames("x", { timeoutMs: 1500, totalMs: 400 }).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(401);
    expect(done).toBe(true); // 不是等满 1.5 秒
    expect(await p).toEqual([]);
    expect(evals(h.sent)).toHaveLength(EVAL_IN_FRAMES_CONCURRENCY); // 只发了第一批
    const before = evals(h.sent).length;
    expect(await h.tab.evalInFrames("x", { totalMs: 0 })).toEqual([]);
    expect(await h.tab.evalInFrames("x", { totalMs: -5 })).toEqual([]);
    expect(evals(h.sent)).toHaveLength(before);
  });

  it("没卡死时总时限不影响结果：所有框架都在剩余时间内应答 → 全部返回（对照，防空转）", async () => {
    const h = makeTab(() => new Promise((resolve) => setTimeout(() => resolve({ result: { value: "ok" } }), 100)));
    await h.tab.ready;
    for (let i = 0; i < 20; i++) h.childWorld(`c${i}`, `FX${i}`, 100 + i);
    const p = h.tab.evalInFrames("x");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toHaveLength(21);
  });
});

describe("tab.addEarlySessionHook（R23-3）：与域启用并行，先于 setAutoAttach / 页内脚本 / 普通会话钩子", () => {
  const STUB = "STUB-SOURCE";
  // tab.mjs 里 `send(method, params = {}, sessionId = null, …)` 的 JS 默认值被 TS 推成 `null`，传子会话 id（string）会报类型错——这里按真实用法（主会话 null / 子会话字符串）收窄成宽类型再调
  type SendWithSession = (method: string, params: object, sessionId: string | null) => Promise<unknown>;
  const registerStub = (h: ReturnType<typeof makeTab>, seen: Array<string | null> = []) =>
    h.tab.addEarlySessionHook(async (sid: string | null) => {
      seen.push(sid);
      await (h.tab.send as unknown as SendWithSession).call(h.tab, "Page.addScriptToEvaluateOnNewDocument", { source: STUB }, sid);
    });
  const methodsOf = (sent: Sent[], sessionId: string | null = null) => sent.filter((s) => (s.sessionId ?? null) === sessionId).map((s) => `${s.method}${s.params.source === STUB ? "(stub)" : ""}`);

  it("主会话：早钩子最先被调用，它发的命令排在 Target.setAutoAttach / 页面脚本 / 普通会话钩子之前；普通会话钩子仍在 setAutoAttach 之后", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }));
    const seen: Array<string | null> = [];
    registerStub(h, seen);
    let sentWhenNormalHook = -1;
    h.tab.addSessionHook(() => {
      sentWhenNormalHook = methodsOf(h.sent).length;
    });
    await h.tab.ready;
    expect(seen).toEqual([null]);
    const ms = methodsOf(h.sent);
    const stub = ms.indexOf("Page.addScriptToEvaluateOnNewDocument(stub)");
    expect(stub).toBeGreaterThanOrEqual(0);
    expect(stub).toBeLessThan(ms.indexOf("Target.setAutoAttach"));
    expect(stub).toBeLessThan(ms.indexOf("Runtime.addBinding")); // 页面脚本（#installPageScripts）的第一条
    expect(stub).toBeLessThan(ms.indexOf("Page.enable")); // 早钩子的命令先于各域的 enable 发出
    expect(ms.indexOf("Page.enable")).toBeGreaterThanOrEqual(0);
    // 普通会话钩子照旧在 setup 末尾（setAutoAttach 与页面脚本之后）
    expect(sentWhenNormalHook).toBeGreaterThan(ms.indexOf("Target.setAutoAttach"));
  });

  it("并行：早钩子还在跑（没结束）时各域的 enable 已经发出去了；Target.setAutoAttach 要等早钩子结束才发——早钩子慢也不拖慢 enable，更不会被甩在后面", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }));
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    h.tab.addEarlySessionHook(async () => {
      await hold;
    });
    await vi.advanceTimersByTimeAsync(20);
    const during = methodsOf(h.sent);
    for (const m of ["Page.enable", "Runtime.enable", "DOM.enable", "Network.enable", "Log.enable"]) expect(during, m).toContain(m);
    expect(during).not.toContain("Target.setAutoAttach");
    release();
    await h.tab.ready;
    expect(methodsOf(h.sent)).toContain("Target.setAutoAttach");
  });

  it("OOPIF 子会话也跑早钩子（sessionId = 子会话 id），命令发到子会话，且先于该子会话自己的 Target.setAutoAttach", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }));
    const seen: Array<string | null> = [];
    registerStub(h, seen);
    await h.tab.ready;
    h.attachChild("child-1");
    await vi.advanceTimersByTimeAsync(20);
    expect(seen).toEqual([null, "child-1"]);
    const child = methodsOf(h.sent, "child-1");
    expect(child).toContain("Page.addScriptToEvaluateOnNewDocument(stub)");
    expect(child.indexOf("Page.addScriptToEvaluateOnNewDocument(stub)")).toBeLessThan(child.indexOf("Target.setAutoAttach"));
    // 子会话的桩命令没有发到主会话上
    expect(methodsOf(h.sent).filter((m) => m.endsWith("(stub)"))).toHaveLength(1);
  });

  it("早钩子抛错（同步 / 异步）只记日志：初始化照常完成，后面的早钩子照常跑，setAutoAttach 与普通钩子不受影响", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }));
    const ran: string[] = [];
    h.tab.addEarlySessionHook(() => {
      ran.push("sync-boom");
      throw new Error("sync boom");
    });
    h.tab.addEarlySessionHook(async () => {
      ran.push("async-boom");
      throw new Error("async boom");
    });
    h.tab.addEarlySessionHook(() => {
      ran.push("fine");
    });
    h.tab.addSessionHook(() => {
      ran.push("normal");
    });
    await expect(h.tab.ready).resolves.toBeUndefined();
    expect(ran).toEqual(["sync-boom", "async-boom", "fine", "normal"]);
    expect(h.logs.filter((l) => l.includes("会话早钩子出错（已忽略）"))).toHaveLength(2);
    expect(h.logs.join("\n")).toContain("sync boom");
    expect(h.logs.join("\n")).toContain("async boom");
    expect(methodsOf(h.sent)).toContain("Target.setAutoAttach");
    expect(h.tab.cdpReady).toBe(true);
  });

  it("返回取消函数；主会话重连（debugger 掉线后 ensureCdp 自愈）会重放早钩子；destroy 清空", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }));
    const seen: Array<string | null> = [];
    const off = registerStub(h, seen);
    await h.tab.ready;
    expect(seen).toEqual([null]);
    // 掉线后自愈：重新初始化会话 → 早钩子再跑一遍
    h.tab.cdpReady = false;
    await h.tab.ensureCdp();
    expect(seen).toEqual([null, null]);
    // 取消后不再跑
    off();
    expect(h.tab.earlySessionHooks.size).toBe(0);
    h.tab.cdpReady = false;
    await h.tab.ensureCdp();
    expect(seen).toEqual([null, null]);
    // destroy 清空
    h.tab.addEarlySessionHook(() => {});
    expect(h.tab.earlySessionHooks.size).toBe(1);
    h.tab.destroy();
    expect(h.tab.earlySessionHooks.size).toBe(0);
  });

  it("收养的 window.open 弹窗（R24-1）：构造函数里主会话初始化的第一步（早钩子那一批）就已同步跑完、此刻钩子清单还是空的——构造返回之后才登记的早钩子要对主会话补调一次（收到 null），只一次", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }), undefined, { adopt: true });
    expect(h.tab.adopted).toBe(true);
    // 构造函数返回的此刻：各域的 enable 已经同步发出（#setupSession(null) 跑过了它的第一段），早钩子清单是空的
    expect(methodsOf(h.sent)).toContain("Page.enable");
    expect(h.tab.earlySessionHooks.size).toBe(0);
    expect(h.tab.cdpReady).toBe(false);
    const seen: Array<string | null> = [];
    registerStub(h, seen); // createTab 里 bindTab 的时机：new BrowserTab() 返回之后
    expect(seen).toEqual([null]); // 补调是同步发起的：不用等初始化结束
    await h.tab.ready;
    expect(seen).toEqual([null]); // 初始化之后也没有再多一次
    expect(methodsOf(h.sent)).toContain("Page.addScriptToEvaluateOnNewDocument(stub)"); // 桩命令真的发出了
    // 之后的自愈重连走正常的「每次 setup 都跑早钩子」，与补课无关
    h.tab.cdpReady = false;
    await h.tab.ensureCdp();
    expect(seen).toEqual([null, null]);
  });

  it("普通 tab（先 loadURL 再 attach）登记早钩子时还没有任何会话跑过它们：不补调、不重复调——初始化里恰好一次；对照：初始化完成之后再登记的才补调", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }));
    const seen: Array<string | null> = [];
    registerStub(h, seen);
    expect(seen).toEqual([]); // 没有补调
    await h.tab.ready;
    expect(seen).toEqual([null]); // 初始化里一次
    const late: Array<string | null> = [];
    registerStub(h, late); // 对照：这时主会话已经跑过早钩子这一批、没有这个钩子 → 补调
    expect(late).toEqual([null]);
    expect(seen).toEqual([null]); // 别的钩子不受牵连
  });

  it("迟到登记的早钩子对「仍存在」的会话（主会话 + 现有子会话）各补调一次；已 detach 的子会话不补；补调出错只记日志、不抛、不影响别的钩子", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }));
    await h.tab.ready;
    h.attachChild("child-1");
    h.attachChild("child-2");
    await vi.advanceTimersByTimeAsync(20); // 子会话的初始化（含它们的早钩子这一批）跑完
    h.detachChild("child-1");
    const seen: Array<string | null> = [];
    registerStub(h, seen);
    h.tab.addEarlySessionHook(() => {
      throw new Error("late boom");
    });
    const after: Array<string | null> = [];
    registerStub(h, after);
    await vi.advanceTimersByTimeAsync(20);
    expect([...seen].map(String).sort()).toEqual(["child-2", "null"]);
    expect([...after].map(String).sort()).toEqual(["child-2", "null"]); // 出错的钩子夹在中间也不影响后面的
    expect(h.logs.filter((l) => l.includes("会话早钩子出错（已忽略）") && l.includes("late boom"))).toHaveLength(2); // 主会话 + child-2 各一次
    // 自愈重连清掉子会话表（没有 detach 事件）之后再登记：也不对已不存在的子会话补
    h.tab.cdpReady = false;
    await h.tab.ensureCdp();
    const afterHeal: Array<string | null> = [];
    registerStub(h, afterHeal);
    await vi.advanceTimersByTimeAsync(20);
    expect(afterHeal.map(String)).toEqual(["null"]);
  });

  it("进行中登记（第二十五轮评审测试 B）：早钩子这一批正在跑（前一个钩子还没结束）时登记的钩子不在那份拷贝里，由补调恰好调一次——不漏、不重；拷贝里的钩子仍各调一次", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }));
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const first: Array<string | null> = [];
    h.tab.addEarlySessionHook(async (sid: string | null) => {
      first.push(sid);
      await hold;
    });
    await vi.advanceTimersByTimeAsync(20); // 初始化已进入早钩子这一批：第一个钩子挂在 hold 上
    expect(first).toEqual([null]);
    const late: Array<string | null> = [];
    registerStub(h, late); // 这一批进行中登记：不在拷贝里
    expect(late).toEqual([null]); // 补调同步发起
    release();
    await h.tab.ready;
    expect(first).toEqual([null]); // 拷贝里的第一个仍只调一次
    expect(late).toEqual([null]); // 迟到的这个没有因为「这一批」又被调一次
  });

  it("早钩子循环里：拷贝之后、轮到它之前被取消的钩子不再调；同一函数登记两次只算一次，补调也只一次（第二十五轮 N-3 / N-4；评审测试 B）", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }));
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    h.tab.addEarlySessionHook(async () => {
      await hold;
    });
    const second: Array<string | null> = [];
    const off = h.tab.addEarlySessionHook((sid: string | null) => {
      second.push(sid);
    });
    await vi.advanceTimersByTimeAsync(20); // 第一个钩子挂住：第二个在拷贝里、还没轮到
    off(); // 轮到之前取消
    release();
    await h.tab.ready;
    expect(second).toEqual([]); // 取消了就不该再被调（此前循环里不判还在不在集合）

    // 同一个函数登记两次（初始化完成之后）：集合去重，补调也只发生一次
    const dup: Array<string | null> = [];
    const fn = (sid: string | null) => {
      dup.push(sid);
    };
    const base = h.tab.earlySessionHooks.size; // 第一个（挂着 hold 的）钩子还在集合里
    const cancel1 = h.tab.addEarlySessionHook(fn);
    const cancel2 = h.tab.addEarlySessionHook(fn);
    expect(h.tab.earlySessionHooks.size).toBe(base + 1);
    expect(dup).toEqual([null]); // 此前第二次登记会再补调一次（Set 去重、补调照跑）
    // 两次拿到的取消函数都能把它摘掉
    cancel2();
    expect(h.tab.earlySessionHooks.size).toBe(base);
    cancel1(); // 重复取消无害
    expect(h.tab.earlySessionHooks.size).toBe(base);
    // 重新登记（已摘掉）算新的一次：再补调一次
    h.tab.addEarlySessionHook(fn);
    expect(dup).toEqual([null, null]);
  });

  it("销毁之后（OAuth 之类的弹窗一出来就关）：销毁时已清空的钩子集合不会被循环里已拷贝的清单复活；销毁后才登记的钩子不会被之后到的子会话初始化调用（第二十五轮 N-3：#callEarlyHook 的 destroyed 守卫；评审测试 B）", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }));
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    h.tab.addEarlySessionHook(async () => {
      await hold;
    });
    const behind: Array<string | null> = [];
    h.tab.addEarlySessionHook((sid: string | null) => {
      behind.push(sid);
    });
    await vi.advanceTimersByTimeAsync(20); // 第一个钩子挂住，第二个排在后面
    h.tab.destroy(); // 销毁：集合清空
    release();
    await vi.advanceTimersByTimeAsync(20);
    expect(behind).toEqual([]); // 销毁后不再调后面的钩子
    expect(h.logs.filter((l) => l.includes("会话早钩子出错"))).toEqual([]); // 没有对已销毁的 tab 发命令、也就没有误导的「桩装不上」类日志

    // 销毁之后才登记（bindTab 落在已销毁的 tab 上）：集合里有它，但之后到的子会话初始化不能再调它
    const g = makeTab(() => ({ result: { value: 1 } }));
    await g.tab.ready;
    g.tab.destroy();
    const post: Array<string | null> = [];
    g.tab.addEarlySessionHook((sid: string | null) => {
      post.push(sid);
    });
    expect(post).toEqual([]); // 销毁后登记不补调（原有行为）
    g.attachChild("child-late"); // 之后到的子会话初始化：早钩子这一批
    await vi.advanceTimersByTimeAsync(20);
    expect(post).toEqual([]);
  });

  it("门的真桩钩子 + 真收养的 BrowserTab 联合（第二十五轮评审测试 F）：收养弹窗构造时早钩子那一批已同步跑完，bindTab 在构造返回之后才登记——桩的新文档脚本与当前文档补装仍恰好各发一次、都发在主会话上", async () => {
    const h = makeTab(() => ({ result: { value: 1 } }), undefined, { adopt: true });
    expect(h.tab.adopted).toBe(true);
    expect(h.tab.earlySessionHooks.size).toBe(0); // 构造返回的此刻：早钩子清单是空的、这一批已经跑过
    const gate = createPermissionGate({ findOwner: () => null, getConfig: () => ({ pagePermissions: true }), isAppUrl: () => false, log: () => {} });
    gate.bindTab(h.tab); // createTab 里 bindTab 的时机
    await h.tab.ready;
    await vi.advanceTimersByTimeAsync(20);
    const stubAdds = h.sent.filter((s) => s.method === "Page.addScriptToEvaluateOnNewDocument" && s.params.source === MEDIA_QUERY_STUB_SOURCE);
    expect(stubAdds).toHaveLength(1);
    expect(stubAdds[0].sessionId ?? null).toBeNull();
    const stubEvals = h.sent.filter((s) => s.method === "Runtime.evaluate" && s.params.expression === MEDIA_QUERY_STUB_SOURCE);
    expect(stubEvals).toHaveLength(1);
    expect(stubEvals[0].sessionId ?? null).toBeNull();
    // 对照：普通 tab（先 loadURL 再 attach）同样走门的真钩子，初始化里恰好一次
    const g = makeTab(() => ({ result: { value: 1 } }));
    createPermissionGate({ findOwner: () => null, getConfig: () => ({ pagePermissions: true }), isAppUrl: () => false, log: () => {} }).bindTab(g.tab);
    await g.tab.ready;
    await vi.advanceTimersByTimeAsync(20);
    expect(g.sent.filter((s) => s.method === "Page.addScriptToEvaluateOnNewDocument" && s.params.source === MEDIA_QUERY_STUB_SOURCE)).toHaveLength(1);
  });
});

describe("tab.ensureCdp 自愈单飞（第二十四轮 P3-2；第二十五轮 N-2：单飞结束后重判）", () => {
  const countOf = (sent: Sent[], method: string) => sent.filter((s) => s.method === method && (s.sessionId ?? null) === null).length;

  it("队列外的并发调用共用同一次自愈：只重新初始化一次（setAutoAttach / 早钩子各一次），都等到它完成；完成后再调不重复自愈", async () => {
    let hold: Promise<void> | null = null;
    const h = makeTab(() => ({ result: { value: 1 } }), undefined, { gate: (method) => (method === "Page.enable" && hold ? hold : undefined) });
    await h.tab.ready;
    const seen: Array<string | null> = [];
    h.tab.addEarlySessionHook((sid: string | null) => {
      seen.push(sid);
    });
    seen.length = 0; // 补调那一次不算
    const base = countOf(h.sent, "Target.setAutoAttach");
    h.tab.cdpReady = false;
    let release: () => void = () => {};
    hold = new Promise<void>((resolve) => (release = resolve)); // 自愈卡在 Page.enable：并发调用有时间重叠
    const calls = [h.tab.ensureCdp(), h.tab.ensureCdp(), h.tab.ensureCdp()];
    let done = 0;
    for (const c of calls) void c.then(() => (done += 1));
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toBe(0); // 后到的在等先到的那一次
    release();
    await Promise.all(calls);
    expect(done).toBe(3);
    expect(seen).toEqual([null]);
    expect(countOf(h.sent, "Target.setAutoAttach") - base).toBe(1);
    expect(h.tab.cdpReady).toBe(true);
    hold = null;
    await h.tab.ensureCdp(); // 已经恢复：不再自愈
    expect(seen).toEqual([null]);
    expect(countOf(h.sent, "Target.setAutoAttach") - base).toBe(1);
  });

  it("自愈失败：等的人都拿到同一个错误；单飞登记随之释放，之后的调用能重新尝试（不会永远卡在失败的那一次上）", async () => {
    let failEnable = false;
    const h = makeTab(() => ({ result: { value: 1 } }), undefined, {
      gate: (method) => (method === "Page.enable" && failEnable ? Promise.reject(new Error("attach boom")) : undefined),
    });
    await h.tab.ready;
    h.tab.cdpReady = false;
    failEnable = true;
    const results = await Promise.allSettled([h.tab.ensureCdp(), h.tab.ensureCdp()]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    for (const r of results) expect((r as PromiseRejectedResult).reason?.message).toContain("attach boom");
    // 「同一个错误」要断言到同一个实例（第二十五轮评审测试 A）：各自重新自愈、各自失败也会得到两个 message 相同的 Error——只有共用同一次自愈才是同一个对象
    expect((results[0] as PromiseRejectedResult).reason).toBe((results[1] as PromiseRejectedResult).reason);
    failEnable = false;
    await expect(h.tab.ensureCdp()).resolves.toBeUndefined(); // 重新尝试、成功
    expect(h.tab.cdpReady).toBe(true);
  });

  it("队列内的自愈（模拟应用时发现 CDP 没就绪）不等队列外那一次：它的模拟重放要排进此刻被占着的队列，等它就是等自己（死锁）——队列外那次悬挂着，模拟应用照样完成；放开之后两边都收尾", async () => {
    let holdFirstEnable = false;
    let release: () => void = () => {};
    const h = makeTab(() => ({ result: { value: 1 } }), undefined, {
      gate: (method) => {
        if (method !== "Page.enable" || !holdFirstEnable) return undefined;
        holdFirstEnable = false; // 只卡第一个（队列外那次自愈）的 Page.enable
        return new Promise<void>((resolve) => (release = resolve));
      },
    });
    await h.tab.ready;
    h.tab.cdpReady = false;
    holdFirstEnable = true;
    const outside = h.tab.ensureCdp(); // 队列外：悬挂在 Page.enable
    let outsideDone = false;
    void outside.then(() => (outsideDone = true));
    await vi.advanceTimersByTimeAsync(20);
    expect(outsideDone).toBe(false);
    const inside = h.tab.applyEmulation({ colorScheme: "dark" }); // 队列内：自己发现 cdpReady 为假 → 自己愈合一次
    let insideDone = false;
    void inside.then(() => (insideDone = true));
    await vi.advanceTimersByTimeAsync(50);
    expect(insideDone).toBe(true); // 没有等队列外那次（那次还卡着）
    expect(outsideDone).toBe(false);
    release();
    await outside;
    expect(outsideDone).toBe(true);
    await expect(inside).resolves.toMatchObject({ emulation: expect.any(String) });
  });

  /**
   * 自愈里 `#syncMainFrameId` 的 `Page.getFrameTree`（发生在 cdpReady 已置真之后、单飞结束之前）到达时，按 `crashes` 次数模拟渲染进程再崩一次（render-process-gone 只置 cdpReady = false）。
   * 同一轮自愈里还有一次更早的 `Page.getFrameTree`（`#installPageScripts`，此时 cdpReady 还是假）——只在 cdpReady 为真时才算「崩」，那一次不动它。
   */
  const makeCrashingTab = () => {
    // destroyToo + destroyAtCrash：在第几次崩溃时顺带销毁 tab（默认第 1 次）；seen = 已经崩过几次
    const state = { crashes: 0, destroyToo: false, destroyAtCrash: 1, seen: 0 };
    const holder: { h: ReturnType<typeof makeTab> | null } = { h: null };
    const h = makeTab(() => ({ result: { value: 1 } }), undefined, {
      gate: (method) => {
        if (method === "Page.getFrameTree" && state.crashes > 0 && holder.h && holder.h.tab.cdpReady === true) {
          state.crashes -= 1;
          state.seen += 1;
          holder.h.tab.cdpReady = false;
          if (state.destroyToo && state.seen === state.destroyAtCrash) holder.h.destroy();
        }
        return undefined;
      },
    });
    holder.h = h;
    return { h, state };
  };

  it("单飞结束时页面又崩了（等待期间 cdpReady 被置回 false）：醒来的调用方重判、再自愈一轮——三个等待者只多一轮、不是各来一轮；之后 cdpReady 为真（第二十五轮 N-2）", async () => {
    const { h, state } = makeCrashingTab();
    await h.tab.ready; // 初始化走完之后才布置崩溃（初始化里的 getFrameTree 不算）
    const base = countOf(h.sent, "Target.setAutoAttach");
    h.tab.cdpReady = false;
    state.crashes = 1;
    await Promise.all([h.tab.ensureCdp(), h.tab.ensureCdp(), h.tab.ensureCdp()]);
    expect(countOf(h.sent, "Target.setAutoAttach") - base).toBe(2); // 第一轮 + 醒来后补的一轮
    expect(h.tab.cdpReady).toBe(true);
    // 没崩的对照：只有一轮
    const again = countOf(h.sent, "Target.setAutoAttach");
    h.tab.cdpReady = false;
    await Promise.all([h.tab.ensureCdp(), h.tab.ensureCdp()]);
    expect(countOf(h.sent, "Target.setAutoAttach") - again).toBe(1);
  });

  it("页面一直在崩溃循环（每一轮自愈结束时又崩了）：最多 CDP_HEAL_MAX_ROUNDS 轮就放行、不无限追；ensureCdp 本身不抛，由调用方的命令自己报错（N-2）；放行前写一行日志说明自愈追不上（第二十六轮 T-5）", async () => {
    expect(CDP_HEAL_MAX_ROUNDS).toBe(2);
    const { h, state } = makeCrashingTab();
    await h.tab.ready;
    const base = countOf(h.sent, "Target.setAutoAttach");
    h.tab.cdpReady = false;
    // 崩溃次数取**有限**值（第二十六轮 X-2）：这里的假 CDP 全是微任务、没有定时器——若实现被改成无界追逐，用 Infinity 会把事件循环占满、
    // vitest 的超时器也触发不了，用例卡死而不是变红；有限次数时无界实现会在崩溃用完后停下，多出来的轮数直接让下面的等式失败
    state.crashes = 10;
    const logsBefore = h.logs.length;
    await expect(h.tab.ensureCdp()).resolves.toBeUndefined();
    expect(countOf(h.sent, "Target.setAutoAttach") - base).toBe(CDP_HEAL_MAX_ROUNDS);
    expect(state.crashes).toBe(10 - CDP_HEAL_MAX_ROUNDS); // 每一轮恰好崩一次——没有多追、也没有少追
    expect(h.tab.cdpReady).toBe(false);
    // T-5：不再是静默放行——写明「重试了几轮、仍未就绪」，用户 / AI 在日志里能看出是自愈追不上，而不是只看到后续命令等满 20 秒超时
    const notes = h.logs.slice(logsBefore).filter((l) => l.includes("CDP 自愈已重试"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`${CDP_HEAL_MAX_ROUNDS} 轮`);
  });

  it("最后一轮自愈刚好成功（没有再崩）：不写那行「追不上」日志、正常返回（T-5 对照；N-2）", async () => {
    const { h, state } = makeCrashingTab();
    await h.tab.ready;
    h.tab.cdpReady = false;
    state.crashes = CDP_HEAL_MAX_ROUNDS - 1; // 前 N-1 轮各崩一次，最后一轮没崩
    const logsBefore = h.logs.length;
    await expect(h.tab.ensureCdp()).resolves.toBeUndefined();
    expect(h.tab.cdpReady).toBe(true);
    expect(h.logs.slice(logsBefore).some((l) => l.includes("CDP 自愈已重试"))).toBe(false);
  });

  it("单飞期间 tab 被销毁：醒来后不再追第二轮（#wcGone 判定），不对已销毁的 wc 再自愈一遍；与函数开头一致地抛 TAB_NOT_FOUND，不是静默放行（N-2；第二十六轮 T-5 统一成 throw）", async () => {
    const { h, state } = makeCrashingTab();
    await h.tab.ready;
    const base = countOf(h.sent, "Target.setAutoAttach");
    h.tab.cdpReady = false;
    state.crashes = 1;
    state.destroyToo = true;
    await expect(h.tab.ensureCdp()).rejects.toMatchObject({ code: "TAB_NOT_FOUND" });
    expect(countOf(h.sent, "Target.setAutoAttach") - base).toBe(1);
    // 函数开头本来就抛同一个错（对照：已销毁的 tab 上再调一次）
    await expect(h.tab.ensureCdp()).rejects.toMatchObject({ code: "TAB_NOT_FOUND" });
  });

  it("两轮都用完、而 tab 恰好在最后一轮里被销毁（第 2 次崩溃时）：放行前的最后一判抛 TAB_NOT_FOUND，不写「追不上」日志、不把一个已销毁的 tab 当成「仍没就绪」放行（第二十六轮 T-5）", async () => {
    const { h, state } = makeCrashingTab();
    await h.tab.ready;
    const base = countOf(h.sent, "Target.setAutoAttach");
    h.tab.cdpReady = false;
    state.crashes = 10;
    state.destroyToo = true;
    state.destroyAtCrash = 2; // 第 1 轮崩一次（tab 还在、进入第 2 轮）；第 2 轮崩的同时销毁——此后没有「下一轮开头」的判断了，只有循环之后那一判
    const logsBefore = h.logs.length;
    await expect(h.tab.ensureCdp()).rejects.toMatchObject({ code: "TAB_NOT_FOUND" });
    expect(countOf(h.sent, "Target.setAutoAttach") - base).toBe(CDP_HEAL_MAX_ROUNDS); // 两轮都跑了
    expect(state.seen).toBe(2);
    expect(h.logs.slice(logsBefore).some((l) => l.includes("CDP 自愈已重试"))).toBe(false);
  });
});
