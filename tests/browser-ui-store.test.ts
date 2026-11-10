/**
 * 浏览器状态 store：全应用共用一个 onState 订阅、结构共享（内容没变不唤醒订阅者）、
 * 信号订阅（自动展开 / 头部入口用）、seed 与 push 的区分。bridge 全部是假的，不碰真窗口。
 */
import { describe, expect, it, vi } from "vitest";

import type {
  ActivityEntry,
  BrowserBridge,
  BrowserState,
  DialogInfo,
  DownloadInfo,
  TabInfo,
} from "@/lib/browser-bridge-types";
import {
  createBrowserStore,
  deriveSignals,
  mergeBrowserState,
  signalsEqual,
} from "@/components/browser/browser-state-store";

// 夹具带上 V4 消费的全部新字段（dialog / downloads / tab.zoom / tab.emulation）：
// 以前夹具里没有它们，mergeBrowserState 漏比这些字段也没有任何测试会红（R1-12 / R1-33）
const tab = (over: Partial<TabInfo> = {}): TabInfo => ({
  id: "a",
  url: "https://a.com",
  title: "A",
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true,
  zoom: 100,
  emulation: null,
  ...over,
});

const dl = (over: Partial<DownloadInfo> = {}): DownloadInfo => ({
  id: 1,
  fileName: "report.pdf",
  path: "/tmp/report.pdf",
  url: "https://a.com/report.pdf",
  state: "progressing",
  receivedBytes: 100,
  totalBytes: 1000,
  startedAt: 1,
  ...over,
});

const dlg = (over: Partial<DialogInfo> = {}): DialogInfo => ({
  type: "confirm",
  message: "确定？",
  url: "https://a.com",
  since: 1,
  ...over,
});

const st = (over: Partial<BrowserState> = {}): BrowserState => ({
  taskId: "t1",
  exists: true,
  controller: "idle",
  askRequest: null,
  aiLabel: null,
  aiLabelAt: null,
  activeTabId: "a",
  tabs: [tab()],
  attached: true,
  covered: false,
  picking: false,
  pendingUserActivity: 0,
  recent: [],
  dialog: null,
  downloads: [dl()],
  ...over,
});

const makeBridge = (initial: BrowserState | null = null) => {
  let push: ((taskId: string, s: BrowserState) => void) | null = null;
  const unsub = vi.fn(() => {
    push = null;
  });
  const onState = vi.fn((cb: (taskId: string, s: BrowserState) => void) => {
    push = cb;
    return unsub;
  });
  const getState = vi.fn(async () => initial);
  const bridge = { onState, getState } as unknown as BrowserBridge;
  return { bridge, onState, getState, unsub, emit: (tid: string, s: BrowserState) => push?.(tid, s) };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("mergeBrowserState：结构共享", () => {
  it("整体没变 → 返回旧对象（引用不变）", () => {
    const prev = st();
    expect(mergeBrowserState(prev, st())).toBe(prev);
  });

  it("只有标量变了 → tabs / recent 沿用旧引用", () => {
    const prev = st();
    const next = mergeBrowserState(prev, st({ controller: "ai" }));
    expect(next).not.toBe(prev);
    expect(next.tabs).toBe(prev.tabs);
    expect(next.recent).toBe(prev.recent);
  });

  it("tabs 变了 → 新数组；recent 没变仍沿用旧引用", () => {
    const prev = st();
    const changed = st({ tabs: [{ ...prev.tabs[0]!, title: "B" }] });
    const next = mergeBrowserState(prev, changed);
    expect(next.tabs).not.toBe(prev.tabs);
    expect(next.recent).toBe(prev.recent);
  });

  // R1-12：下面这些字段单独变化（其它全没变）时必须返回新对象，否则订阅者不被唤醒、UI 冻结
  describe("只有 V4 字段变化时必须返回新对象（R1-12）", () => {
    it("夹具确实带了这些字段（防夹具又被改回没有）", () => {
      const s = st();
      expect(s.dialog).toBeNull();
      expect(s.downloads).toHaveLength(1);
      expect(s.tabs[0]).toMatchObject({ zoom: 100, emulation: null });
    });

    it("下载进度：只有 receivedBytes 变 → 新对象，且新值带进去", () => {
      const prev = st();
      const next = mergeBrowserState(prev, st({ downloads: [dl({ receivedBytes: 500 })] }));
      expect(next).not.toBe(prev);
      expect(next.downloads?.[0]?.receivedBytes).toBe(500);
      // tabs / recent 没变，仍沿用旧引用
      expect(next.tabs).toBe(prev.tabs);
      expect(next.recent).toBe(prev.recent);
    });

    it.each<[string, Partial<DownloadInfo>]>([
      ["state", { state: "completed" }],
      ["totalBytes", { totalBytes: 2000 }],
      ["endedAt", { endedAt: 9 }],
      ["fileName", { fileName: "other.pdf" }],
      ["path", { path: "/tmp/other.pdf" }],
      ["url", { url: "https://a.com/other.pdf" }],
      ["startedAt", { startedAt: 2 }],
      ["tabId", { tabId: "a" }],
      ["id", { id: 2 }],
    ])("下载条目的 %s 单独变化 → 新对象", (_f, change) => {
      const prev = st();
      expect(mergeBrowserState(prev, st({ downloads: [dl(change)] }))).not.toBe(prev);
    });

    it("下载条数变化（新增 / 清空 / 缺省）→ 新对象；缺省与空数组等价（不凭空唤醒）", () => {
      const prev = st();
      expect(mergeBrowserState(prev, st({ downloads: [dl(), dl({ id: 2 })] }))).not.toBe(prev);
      expect(mergeBrowserState(prev, st({ downloads: [] }))).not.toBe(prev);
      const none = st({ downloads: [] });
      expect(mergeBrowserState(none, st({ downloads: undefined }))).toBe(none);
    });

    it("下载完全一样 → 返回旧对象；downloads 数组引用沿用旧的（弹层 memo 命得中）", () => {
      const prev = st();
      expect(mergeBrowserState(prev, st({ downloads: [dl()] }))).toBe(prev);
      // 别的字段变了、下载没变：downloads 引用沿用
      const next = mergeBrowserState(prev, st({ controller: "ai", downloads: [dl()] }));
      expect(next).not.toBe(prev);
      expect(next.downloads).toBe(prev.downloads);
    });

    it("对话框：出现 / 消失 / 内容变化 → 新对象；一样（含 null 与缺省）→ 旧对象", () => {
      const none = st();
      expect(mergeBrowserState(none, st({ dialog: dlg() }))).not.toBe(none);
      const withDlg = st({ dialog: dlg() });
      expect(mergeBrowserState(withDlg, st({ dialog: null }))).not.toBe(withDlg);
      expect(mergeBrowserState(withDlg, st({ dialog: undefined }))).not.toBe(withDlg);
      expect(mergeBrowserState(withDlg, st({ dialog: dlg({ message: "换了一句" }) }))).not.toBe(withDlg);
      expect(mergeBrowserState(withDlg, st({ dialog: dlg({ type: "prompt" }) }))).not.toBe(withDlg);
      expect(mergeBrowserState(withDlg, st({ dialog: dlg({ defaultPrompt: "x" }) }))).not.toBe(withDlg);
      expect(mergeBrowserState(withDlg, st({ dialog: dlg({ since: 2 }) }))).not.toBe(withDlg);
      expect(mergeBrowserState(withDlg, st({ dialog: dlg({ url: "https://b.com" }) }))).not.toBe(withDlg);
      expect(mergeBrowserState(withDlg, st({ dialog: dlg() }))).toBe(withDlg);
      expect(mergeBrowserState(none, st({ dialog: undefined }))).toBe(none);
    });

    it("tab.zoom 单独变化（⌘= 缩放）→ 新对象", () => {
      const prev = st();
      const next = mergeBrowserState(prev, st({ tabs: [tab({ zoom: 120 })] }));
      expect(next).not.toBe(prev);
      expect(next.tabs[0]?.zoom).toBe(120);
      expect(next.tabs).not.toBe(prev.tabs);
    });

    it("tab.emulation 单独变化（设备模拟开 / 关 / 换）→ 新对象；null 与缺省等价", () => {
      const prev = st();
      expect(mergeBrowserState(prev, st({ tabs: [tab({ emulation: "iPhone 15" })] }))).not.toBe(prev);
      const emu = st({ tabs: [tab({ emulation: "iPhone 15" })] });
      expect(mergeBrowserState(emu, st({ tabs: [tab({ emulation: "iPhone 15 · 暗色" })] }))).not.toBe(emu);
      expect(mergeBrowserState(emu, st({ tabs: [tab({ emulation: null })] }))).not.toBe(emu);
      expect(mergeBrowserState(prev, st({ tabs: [tab({ emulation: undefined })] }))).toBe(prev);
    });

    it("经 store 推送：只有这些字段变化也会唤醒订阅者", () => {
      const { bridge, emit } = makeBridge();
      const store = createBrowserStore(() => bridge);
      const l = vi.fn();
      store.subscribe("t1", l);
      emit("t1", st());
      expect(l).toHaveBeenCalledTimes(1);
      emit("t1", st({ downloads: [dl({ receivedBytes: 300 })] }));
      expect(l).toHaveBeenCalledTimes(2);
      emit("t1", st({ downloads: [dl({ receivedBytes: 300 })], tabs: [tab({ zoom: 125 })] }));
      expect(l).toHaveBeenCalledTimes(3);
      emit("t1", st({ downloads: [dl({ receivedBytes: 300 })], tabs: [tab({ zoom: 125 })], dialog: dlg() }));
      expect(l).toHaveBeenCalledTimes(4);
      emit("t1", st({ downloads: [dl({ receivedBytes: 300 })], tabs: [tab({ zoom: 125, emulation: "iPad" })], dialog: dlg() }));
      expect(l).toHaveBeenCalledTimes(5);
      // 原样再推一次：不唤醒
      emit("t1", st({ downloads: [dl({ receivedBytes: 300 })], tabs: [tab({ zoom: 125, emulation: "iPad" })], dialog: dlg() }));
      expect(l).toHaveBeenCalledTimes(5);
    });
  });

  // R2-14 ①：scalarsSame 漏了 windowFocused、sameEntry 漏了 target——都是「别的字段没变、只有它变」时推送被吞的潜伏项
  describe("windowFocused / ActivityEntry.target 单独变化必须返回新对象（R2-14 ①）", () => {
    const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
      id: 1,
      ts: 100,
      actor: "ai",
      kind: "click",
      tabId: "a",
      url: "https://a.com",
      summary: "点击 按钮「登录」",
      target: { role: "button", name: "登录", ref: "e1" },
      ...over,
    });

    it("windowFocused：缺省 / true / false 两两不同，各自单独变化都换新对象", () => {
      const cases: Array<[boolean | undefined, boolean | undefined]> = [
        [undefined, true],
        [undefined, false], // 缺省 = 老壳 / 不确定，与「确实不在前台」语义不同，不能当作 false
        [true, false],
        [false, true],
        [true, undefined],
      ];
      for (const [from, to] of cases) {
        const prev = st({ windowFocused: from });
        const next = mergeBrowserState(prev, st({ windowFocused: to }));
        expect(next, `${String(from)} → ${String(to)}`).not.toBe(prev);
        expect(next.windowFocused).toBe(to);
        // 别的字段没变：tabs / recent 仍沿用旧引用（只是标量变了）
        expect(next.tabs).toBe(prev.tabs);
        expect(next.recent).toBe(prev.recent);
      }
    });

    it("windowFocused 没变（含都缺省）→ 旧对象", () => {
      for (const v of [undefined, true, false]) {
        const prev = st({ windowFocused: v });
        expect(mergeBrowserState(prev, st({ windowFocused: v }))).toBe(prev);
      }
    });

    it("target 的 role / name / ref 任一单独变化 → 新对象，recent 换成新数组", () => {
      const prev = st({ recent: [entry()] });
      const changes: Array<Partial<NonNullable<ActivityEntry["target"]>>> = [
        { role: "link" },
        { name: "注册" },
        { ref: "e9" },
      ];
      for (const c of changes) {
        const next = mergeBrowserState(prev, st({ recent: [entry({ target: { ...entry().target, ...c } })] }));
        expect(next, JSON.stringify(c)).not.toBe(prev);
        expect(next.recent).not.toBe(prev.recent);
        expect(next.recent[0]?.target).toMatchObject(c);
      }
    });

    it("target 出现 / 消失 / 子字段缺省 → 新对象", () => {
      const withTarget = st({ recent: [entry()] });
      expect(mergeBrowserState(withTarget, st({ recent: [entry({ target: undefined })] }))).not.toBe(withTarget);
      const without = st({ recent: [entry({ target: undefined })] });
      expect(mergeBrowserState(without, st({ recent: [entry()] }))).not.toBe(without);
      expect(
        mergeBrowserState(withTarget, st({ recent: [entry({ target: { role: "button", name: "登录" } })] })),
      ).not.toBe(withTarget);
    });

    it("target 内容一样但对象引用不同（IPC 每次都是新反序列化）→ 旧对象，recent 引用沿用", () => {
      const prev = st({ recent: [entry()] });
      const again = st({ recent: [entry({ target: { role: "button", name: "登录", ref: "e1" } })] });
      expect(again.recent[0]?.target).not.toBe(prev.recent[0]?.target);
      expect(mergeBrowserState(prev, again)).toBe(prev);
      // 都没有 target 也算一样
      const bare = st({ recent: [entry({ target: undefined })] });
      expect(mergeBrowserState(bare, st({ recent: [entry({ target: undefined })] }))).toBe(bare);
    });

    it("经 store 推送：只有 windowFocused / 只有 target 变化也唤醒订阅者；原样再推不唤醒", () => {
      const { bridge, emit } = makeBridge();
      const store = createBrowserStore(() => bridge);
      const l = vi.fn();
      store.subscribe("t1", l);
      emit("t1", st({ recent: [entry()], windowFocused: true }));
      expect(l).toHaveBeenCalledTimes(1);
      emit("t1", st({ recent: [entry()], windowFocused: false }));
      expect(l).toHaveBeenCalledTimes(2);
      emit("t1", st({ recent: [entry({ target: { role: "button", name: "登录", ref: "e2" } })], windowFocused: false }));
      expect(l).toHaveBeenCalledTimes(3);
      emit("t1", st({ recent: [entry({ target: { role: "button", name: "登录", ref: "e2" } })], windowFocused: false }));
      expect(l).toHaveBeenCalledTimes(3);
    });
  });

  it("信号：只看 controller / ask / 未读数 / exists", () => {
    const a = deriveSignals(st());
    expect(signalsEqual(a, deriveSignals(st({ aiLabel: "点击" })))).toBe(true);
    expect(signalsEqual(a, deriveSignals(st({ controller: "ai" })))).toBe(false);
    expect(signalsEqual(a, deriveSignals(st({ askRequest: { message: "x", since: 1 } })))).toBe(false);
    expect(deriveSignals(null).exists).toBe(false);
  });
});

describe("createBrowserStore", () => {
  it("没有 bridge：订阅不报错、getState 为空", () => {
    const store = createBrowserStore(() => undefined);
    const off = store.subscribe("t1", () => {});
    expect(store.getState("t1")).toBeUndefined();
    off();
  });

  it("全应用只挂一个 onState，最后一个订阅者离开才取消并清缓存", async () => {
    const { bridge, onState, unsub, emit } = makeBridge();
    const store = createBrowserStore(() => bridge);
    const off1 = store.subscribe("t1", () => {});
    const off2 = store.subscribe("t2", () => {});
    expect(onState).toHaveBeenCalledTimes(1);

    emit("t1", st());
    expect(store.getState("t1")?.exists).toBe(true);

    off1();
    expect(unsub).not.toHaveBeenCalled();
    off2();
    // 订阅者归零后延后一拍才真正清理（R1-36）：同一拍里不动
    expect(unsub).not.toHaveBeenCalled();
    await flush();
    expect(unsub).toHaveBeenCalledTimes(1);
    // 没人订阅时收不到推送，缓存会过期：清掉
    expect(store.getState("t1")).toBeUndefined();
  });

  // R1-36：切任务时 React 先跑旧页面的全部 cleanup、再跑新页面的 effect，订阅者在这一瞬间归零；
  // 立刻清缓存的话新任务面板会先读到空缓存、闪一下「还没有浏览器会话」
  describe("订阅者归零后延后一拍清理（R1-36）", () => {
    it("同一拍里有新订阅（切任务）：缓存不清、onState 不摘不重挂、新任务的缓存可直接读到", () => {
      const { bridge, onState, unsub, emit } = makeBridge();
      const store = createBrowserStore(() => bridge);
      const off = store.subscribe("t1", () => {});
      emit("t1", st());
      emit("t2", st({ taskId: "t2", controller: "ai" })); // 全任务推送：别的任务的状态也在缓存里
      expect(store.getState("t2")?.controller).toBe("ai");

      // 切到 t2：先 cleanup 旧订阅，再订阅新任务（同步，同一拍）
      off();
      expect(store.getState("t1")).toBeDefined(); // cleanup 之后立刻读：还在
      const l = vi.fn();
      store.subscribe("t2", l);
      expect(store.getState("t2")?.controller).toBe("ai"); // 新任务面板第一次渲染就有数据，不闪空态
      expect(onState).toHaveBeenCalledTimes(1);
      expect(unsub).not.toHaveBeenCalled();
    });

    it("取消清理后订阅仍然有效：之后的推送照常到达；真正归零再等一拍才清", async () => {
      const { bridge, onState, unsub, emit } = makeBridge();
      const store = createBrowserStore(() => bridge);
      const off1 = store.subscribe("t1", () => {});
      emit("t1", st());
      off1();
      const l = vi.fn();
      const off2 = store.subscribe("t1", l);
      await flush(); // 那一拍过去了：没有清理发生（被新订阅取消）
      expect(unsub).not.toHaveBeenCalled();
      expect(store.getState("t1")).toBeDefined();
      emit("t1", st({ controller: "ai" }));
      expect(l).toHaveBeenCalledTimes(1);
      expect(onState).toHaveBeenCalledTimes(1);

      off2();
      expect(store.getState("t1")).toBeDefined();
      await flush();
      expect(unsub).toHaveBeenCalledTimes(1);
      expect(store.getState("t1")).toBeUndefined();
    });

    it("等待期间（还没清）到达的推送仍会更新缓存（监听没摘，缓存不会陈旧）", async () => {
      const { bridge, emit } = makeBridge();
      const store = createBrowserStore(() => bridge);
      const off = store.subscribe("t1", () => {});
      emit("t1", st());
      off();
      emit("t1", st({ controller: "user" }));
      expect(store.getState("t1")?.controller).toBe("user");
      store.subscribe("t1", () => {});
      await flush();
      expect(store.getState("t1")?.controller).toBe("user");
    });

    it("清理之后重新订阅：重新挂 onState 并重新补 seed", async () => {
      const { bridge, onState, getState, emit } = makeBridge(st({ controller: "ai" }));
      const store = createBrowserStore(() => bridge);
      const off = store.subscribe("t1", () => {});
      emit("t1", st());
      off();
      await flush();
      expect(store.getState("t1")).toBeUndefined();
      store.subscribe("t1", () => {});
      expect(onState).toHaveBeenCalledTimes(2);
      expect(getState).toHaveBeenCalledTimes(2);
      await flush();
      expect(store.getState("t1")?.controller).toBe("ai");
    });

    it("可注入延迟：teardownDelayMs 期间保留，到点才清", () => {
      vi.useFakeTimers();
      try {
        const { bridge, unsub, emit } = makeBridge();
        const store = createBrowserStore(() => bridge, { teardownDelayMs: 100 });
        const off = store.subscribe("t1", () => {});
        emit("t1", st());
        off();
        vi.advanceTimersByTime(99);
        expect(unsub).not.toHaveBeenCalled();
        expect(store.getState("t1")).toBeDefined();
        vi.advanceTimersByTime(1);
        expect(unsub).toHaveBeenCalledTimes(1);
        expect(store.getState("t1")).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // R2-14 ②：getState 在途期间发生 teardown（订阅者归零 + 缓存清空），迟到的应答不能再写进缓存。
  // 否则它写进的是「没有监听的缓存」，重新订阅后新 seed 因 states.has 被丢，会话空闲时过期状态要一直显示到下一次 push
  describe("hydrate 感知 teardown（R2-14 ②）", () => {
    type Pending = {
      resolve: (s: BrowserState | null) => void;
      reject: (e: unknown) => void;
    };
    const makeDeferredBridge = () => {
      const pending: Pending[] = [];
      let push: ((taskId: string, s: BrowserState) => void) | null = null;
      const onState = vi.fn((cb: (taskId: string, s: BrowserState) => void) => {
        push = cb;
        return () => {
          push = null;
        };
      });
      const getState = vi.fn(
        () =>
          new Promise<BrowserState | null>((resolve, reject) => {
            pending.push({ resolve, reject });
          }),
      );
      const bridge = { onState, getState } as unknown as BrowserBridge;
      return { bridge, getState, pending, emit: (tid: string, s: BrowserState) => push?.(tid, s) };
    };
    // 事件驱动：只排空微任务队列（应答的 then / catch 回调），不依赖任何真实时间
    const microtasks = async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    };
    const withFakeTimers = async (fn: () => Promise<void>) => {
      vi.useFakeTimers();
      try {
        await fn();
      } finally {
        vi.useRealTimers();
      }
    };

    it("teardown 后迟到的旧应答被丢；重新订阅的新 seed 才是缓存里的值", () =>
      withFakeTimers(async () => {
        const { bridge, getState, pending } = makeDeferredBridge();
        const store = createBrowserStore(() => bridge);
        const off = store.subscribe("t1", () => {});
        expect(getState).toHaveBeenCalledTimes(1);

        off();
        vi.advanceTimersByTime(0); // teardown：摘监听、清缓存、hydrated 清空
        const seen: string[] = [];
        store.subscribeSignals("t1", (next) => seen.push(next.controller));
        expect(getState).toHaveBeenCalledTimes(2); // 新一代自己重新 hydrate

        // 上一代的应答（过期：controller=ai）先回来
        pending[0]!.resolve(st({ controller: "ai" }));
        await microtasks();
        expect(store.getState("t1")).toBeUndefined();
        expect(seen).toEqual([]);

        // 新一代的应答（新鲜：controller=user）后回来：必须能写进缓存
        pending[1]!.resolve(st({ controller: "user" }));
        await microtasks();
        expect(store.getState("t1")?.controller).toBe("user");
        expect(seen).toEqual(["user"]);
      }));

    it("teardown 后没人再订阅：迟到的应答不写进缓存", () =>
      withFakeTimers(async () => {
        const { bridge, pending } = makeDeferredBridge();
        const store = createBrowserStore(() => bridge);
        const off = store.subscribe("t1", () => {});
        off();
        vi.advanceTimersByTime(0);
        pending[0]!.resolve(st({ controller: "ai" }));
        await microtasks();
        expect(store.getState("t1")).toBeUndefined();
      }));

    it("teardown 被取消（同一拍内又有人订阅）不算换代：在途应答照常写入", () =>
      withFakeTimers(async () => {
        const { bridge, getState, pending } = makeDeferredBridge();
        const store = createBrowserStore(() => bridge);
        const off = store.subscribe("t1", () => {});
        off();
        store.subscribe("t1", () => {}); // 同一拍内重订阅：teardown 取消，hydrated 仍在、不会重复拉
        vi.advanceTimersByTime(0);
        expect(getState).toHaveBeenCalledTimes(1);
        pending[0]!.resolve(st({ controller: "ai" }));
        await microtasks();
        expect(store.getState("t1")?.controller).toBe("ai");
      }));

    it("上一代的失败不能撤销这一代的 hydrated 标记（否则每个新订阅者都重复拉一次）", () =>
      withFakeTimers(async () => {
        const { bridge, getState, pending } = makeDeferredBridge();
        const store = createBrowserStore(() => bridge);
        const off = store.subscribe("t1", () => {});
        off();
        vi.advanceTimersByTime(0);
        store.subscribe("t1", () => {}); // 新一代 hydrate（在途）
        expect(getState).toHaveBeenCalledTimes(2);

        pending[0]!.reject(new Error("旧壳"));
        await microtasks();
        store.subscribe("t1", () => {}); // 又一个订阅者：这一代已经在拉了，不能再拉
        expect(getState).toHaveBeenCalledTimes(2);
      }));

    it("这一代自己的失败仍会放开 hydrated（下一个订阅者可以重试）", () =>
      withFakeTimers(async () => {
        const { bridge, getState, pending } = makeDeferredBridge();
        const store = createBrowserStore(() => bridge);
        store.subscribe("t1", () => {});
        pending[0]!.reject(new Error("主进程还没就绪"));
        await microtasks();
        store.subscribe("t1", () => {});
        expect(getState).toHaveBeenCalledTimes(2);
      }));

    it("期间已有推送：应答不覆盖（原有语义保持）", () =>
      withFakeTimers(async () => {
        const { bridge, pending, emit } = makeDeferredBridge();
        const store = createBrowserStore(() => bridge);
        store.subscribe("t1", () => {});
        emit("t1", st({ controller: "user" }));
        pending[0]!.resolve(st({ controller: "ai" }));
        await microtasks();
        expect(store.getState("t1")?.controller).toBe("user");
      }));

    it("还有订阅者就不换代：别的任务退订不会作废在途应答", () =>
      withFakeTimers(async () => {
        const { bridge, pending } = makeDeferredBridge();
        const store = createBrowserStore(() => bridge);
        const off1 = store.subscribe("t1", () => {});
        store.subscribe("t2", () => {});
        // t1 先退订，但 t2 还订着：不会 teardown，两个在途应答都有效
        off1();
        vi.advanceTimersByTime(0);
        pending[0]!.resolve(st({ taskId: "t1", controller: "ai" }));
        pending[1]!.resolve(st({ taskId: "t2", controller: "user" }));
        await microtasks();
        expect(store.getState("t1")?.controller).toBe("ai");
        expect(store.getState("t2")?.controller).toBe("user");
      }));
  });

  it("推送按 taskId 分桶：别的任务的推送不唤醒我；内容没变不唤醒", () => {
    const { bridge, emit } = makeBridge();
    const store = createBrowserStore(() => bridge);
    const l1 = vi.fn();
    store.subscribe("t1", l1);
    emit("t2", st({ taskId: "t2" }));
    expect(l1).not.toHaveBeenCalled();
    emit("t1", st());
    expect(l1).toHaveBeenCalledTimes(1);
    emit("t1", st());
    expect(l1).toHaveBeenCalledTimes(1);
    emit("t1", st({ controller: "ai" }));
    expect(l1).toHaveBeenCalledTimes(2);
  });

  it("订阅时补一次 getState（标记为 seed）；期间已到的推送不被它覆盖", async () => {
    const { bridge, emit, getState } = makeBridge(st({ controller: "ai" }));
    const store = createBrowserStore(() => bridge);
    const seen: Array<{ controller: string; source: string }> = [];
    store.subscribeSignals("t1", (next, _prev, source) => seen.push({ controller: next.controller, source }));
    await flush();
    expect(getState).toHaveBeenCalledWith("t1");
    expect(seen).toEqual([{ controller: "ai", source: "seed" }]);

    // 回包晚于推送：已有数据就不覆盖
    const { bridge: b2, emit: emit2 } = makeBridge(st({ controller: "idle" }));
    const store2 = createBrowserStore(() => b2);
    store2.subscribe("t1", () => {});
    emit2("t1", st({ controller: "user" }));
    await flush();
    expect(store2.getState("t1")?.controller).toBe("user");
    void emit;
  });

  it("subscribeSignals：只有信号变了才回调，带前值与来源 push", () => {
    const { bridge, emit } = makeBridge();
    const store = createBrowserStore(() => bridge);
    const cb = vi.fn();
    store.subscribeSignals("t1", cb);
    emit("t1", st()); // exists: false → true，信号变了
    expect(cb).toHaveBeenCalledTimes(1);
    emit("t1", st({ aiLabel: "点击 按钮「登录」" })); // 只是 aiLabel，信号没变
    expect(cb).toHaveBeenCalledTimes(1);
    emit("t1", st({ controller: "ai" }));
    expect(cb).toHaveBeenCalledTimes(2);
    const [next, prev, source] = cb.mock.calls[1]!;
    expect(next.controller).toBe("ai");
    expect(prev.controller).toBe("idle");
    expect(source).toBe("push");
  });

  it("setState（attach 回包）走同一套比较，来源按 push", () => {
    const { bridge } = makeBridge();
    const store = createBrowserStore(() => bridge);
    const l = vi.fn();
    store.subscribe("t1", l);
    store.setState(st());
    store.setState(st());
    expect(l).toHaveBeenCalledTimes(1);
  });

  it("推送里的 taskId 以通道参数为准", () => {
    const { bridge, emit } = makeBridge();
    const store = createBrowserStore(() => bridge);
    store.subscribe("t1", () => {});
    emit("t1", st({ taskId: "wrong" }));
    expect(store.getState("t1")?.taskId).toBe("t1");
  });
});
