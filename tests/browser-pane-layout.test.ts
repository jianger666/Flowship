/**
 * 任务页左栏随标签切换的布局决策 + 「收起是谁干的」判定（R2-14 ③）
 *
 * 背景（react-resizable-panels 4.11.1 源码已读，真窗口表现**未验证**）：
 *  - 浏览器标签激活时 Panel 的 minSize 从 "20%" 换成 "300px"，Panel 重新注册、库按新约束重新校验当前布局：
 *    栏宽 < 新下限的一半 → 直接折叠；一半以上 → 夹到下限（且不会在切回产物时复原）；
 *  - 命令式 `expand()` 读的是上一次注册的约束，`setLeftTab("browser")` 之后立刻 expand() 用的还是旧下限；
 *  - 以前 hook 把任何 展开→收起 都记成「用户手动收起」，库自动折叠也会被记，污染 R1-17 的 dismissed。
 * 修法：切标签**之前**先在旧约束下展开 / 放宽到像素下限（prepareBrowserPaneEntry）；
 * 收起只在「用户意图」时才记 dismissed（classifyPanelTransition + createUserCloseIntent）。
 * 这里测的是决策与操作顺序（纯逻辑，句柄用假的）；库的实际折叠 / 夹取行为需要真窗口，不在这里。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyPanelTransition,
  createUserCloseIntent,
  decideAutoOpen,
  initialAutoOpenMemory,
  noteUserClosedPanel,
  noteUserOpenedPanel,
  USER_CLOSE_INTENT_MS,
} from "@/components/browser/browser-auto-open";
import {
  planBrowserPaneEntry,
  prepareBrowserPaneEntry,
  TASK_BROWSER_MIN_PX,
  type PaneHandleLike,
} from "@/components/browser/browser-layout-memory";
import type { BrowserSignals } from "@/components/browser/browser-state-store";

describe("planBrowserPaneEntry：栏宽不足浏览器下限就放宽到下限", () => {
  it("下限是 300px（与 chat 页同口径）", () => {
    expect(TASK_BROWSER_MIN_PX).toBe(300);
  });

  it.each<[string, number, number, string | null]>([
    // [说明, 栏宽百分比, 分栏组像素宽, 期望]
    ["主区 703px、栏被拖到 10%（≈70px，< 下限一半，库会直接折叠）→ 放宽", 10, 703, "300px"],
    ["主区 703px、栏 20%（≈141px）→ 放宽", 20, 703, "300px"],
    ["主区 703px、栏 35%（≈246px，库会夹到下限但不会复原）→ 放宽", 35, 703, "300px"],
    ["折叠态（0%）→ 放宽", 0, 703, "300px"],
    ["刚好等于下限 → 不动", (300 / 703) * 100, 703, null],
    ["差不到 0.5px 的浮点误差 → 不动", ((300 - 0.4) / 703) * 100, 703, null],
    ["差 0.6px → 放宽", ((300 - 0.6) / 703) * 100, 703, "300px"],
    ["已经比下限宽 → 不动（不把用户拖宽的栏缩回去）", 60, 703, null],
    ["大屏：20% 就有 384px → 不动", 20, 1920, null],
  ])("%s", (_name, percent, groupWidthPx, expected) => {
    expect(planBrowserPaneEntry({ percent, groupWidthPx }).resizeTo).toBe(expected);
  });

  it("量不到宽度（null / undefined / 0 / 负数 / NaN / Infinity）→ 不动，交回库按它的规则处理（= 修复前行为）", () => {
    for (const w of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planBrowserPaneEntry({ percent: 10, groupWidthPx: w }).resizeTo, String(w)).toBeNull();
    }
  });

  it("栏宽百分比不是有限非负数 → 不动（不拿猜出来的值去 resize）", () => {
    for (const p of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      expect(planBrowserPaneEntry({ percent: p, groupWidthPx: 703 }).resizeTo, String(p)).toBeNull();
    }
  });

  it("minPx 可注入", () => {
    expect(planBrowserPaneEntry({ percent: 10, groupWidthPx: 1000, minPx: 400 }).resizeTo).toBe("400px");
    expect(planBrowserPaneEntry({ percent: 50, groupWidthPx: 1000, minPx: 400 }).resizeTo).toBeNull();
  });
});

/** 假的 Panel 句柄：记录调用顺序；percent 随 expand / resize 变（模拟库同步更新布局） */
const makeHandle = (init: { collapsed: boolean; percent: number; expandTo?: number; groupWidthPx?: number }) => {
  const calls: string[] = [];
  let collapsed = init.collapsed;
  let percent = init.percent;
  const groupWidthPx = init.groupWidthPx ?? 703;
  const handle: PaneHandleLike = {
    isCollapsed: () => {
      calls.push("isCollapsed");
      return collapsed;
    },
    expand: () => {
      calls.push("expand");
      collapsed = false;
      percent = init.expandTo ?? 20;
    },
    resize: (size) => {
      calls.push(`resize(${String(size)})`);
      const px = typeof size === "string" && size.endsWith("px") ? Number.parseFloat(size) : Number.NaN;
      percent = (px / groupWidthPx) * 100;
      collapsed = false;
    },
    getSize: () => {
      calls.push("getSize");
      return { asPercentage: percent };
    },
  };
  return { handle, calls, now: () => ({ collapsed, percent }) };
};

describe("prepareBrowserPaneEntry：切标签前的命令式操作", () => {
  it("折叠态：先 expand（恢复折叠前宽度）→ 读宽度；恢复出来够宽就不再 resize", () => {
    const h = makeHandle({ collapsed: true, percent: 0, expandTo: 50 });
    expect(prepareBrowserPaneEntry(h.handle, 703)).toEqual({ expanded: true, widenedTo: null });
    expect(h.calls).toEqual(["isCollapsed", "expand", "getSize"]);
  });

  it("折叠态：expand 只恢复到旧下限（20%≈141px）→ 紧接着 resize 到 300px（旧约束下合法）", () => {
    const h = makeHandle({ collapsed: true, percent: 0, expandTo: 20 });
    expect(prepareBrowserPaneEntry(h.handle, 703)).toEqual({ expanded: true, widenedTo: "300px" });
    expect(h.calls).toEqual(["isCollapsed", "expand", "getSize", "resize(300px)"]);
    expect(h.now().collapsed).toBe(false);
  });

  it("折叠态：expand 之后读到的仍是 0（库没动）→ 仍然 resize 到 300px，不会停在折叠", () => {
    const h = makeHandle({ collapsed: true, percent: 0, expandTo: 0 });
    // expandTo=0 → `init.expandTo ?? 20` 取 0：模拟 expand 没能把栏撑开
    expect(prepareBrowserPaneEntry(h.handle, 703).widenedTo).toBe("300px");
  });

  it("展开态但太窄（< 下限）→ 不 expand、直接 resize 到下限", () => {
    const h = makeHandle({ collapsed: false, percent: 12 });
    expect(prepareBrowserPaneEntry(h.handle, 703)).toEqual({ expanded: false, widenedTo: "300px" });
    expect(h.calls).toEqual(["isCollapsed", "getSize", "resize(300px)"]);
  });

  it("展开态且够宽 → 什么都不动（不 expand、不 resize）", () => {
    const h = makeHandle({ collapsed: false, percent: 45 });
    expect(prepareBrowserPaneEntry(h.handle, 703)).toEqual({ expanded: false, widenedTo: null });
    expect(h.calls).toEqual(["isCollapsed", "getSize"]);
  });

  it("量不到分栏组宽度：折叠态仍 expand（保持修复前的行为），但不 resize", () => {
    const h = makeHandle({ collapsed: true, percent: 0, expandTo: 20 });
    expect(prepareBrowserPaneEntry(h.handle, null)).toEqual({ expanded: true, widenedTo: null });
    expect(h.calls).toEqual(["isCollapsed", "expand", "getSize"]);
  });

  it("没有句柄（Group 还没挂好）→ 什么都不做、不抛", () => {
    expect(prepareBrowserPaneEntry(null, 703)).toEqual({ expanded: false, widenedTo: null });
    expect(prepareBrowserPaneEntry(undefined, 703)).toEqual({ expanded: false, widenedTo: null });
  });

  it("句柄任何一步抛错（约束冲突 / Group 未注册）→ 吞掉，返回没动；状态切换照常进行由调用方负责", () => {
    for (const failAt of ["isCollapsed", "expand", "getSize", "resize"] as const) {
      const h = makeHandle({ collapsed: failAt === "expand", percent: failAt === "expand" ? 0 : 10 });
      const wrapped: PaneHandleLike = {
        ...h.handle,
        [failAt]: () => {
          throw new Error(`boom ${failAt}`);
        },
      } as PaneHandleLike;
      expect(() => prepareBrowserPaneEntry(wrapped, 703), failAt).not.toThrow();
    }
  });
});

describe("createUserCloseIntent / classifyPanelTransition：库自动折叠不算用户收起", () => {
  it("意图只在窗口内有效；之前没 mark 过 / 过期 / 时钟回拨都不算", () => {
    const i = createUserCloseIntent();
    expect(i.isRecent(1_000)).toBe(false); // 从没 mark
    i.mark(1_000);
    expect(i.isRecent(1_000)).toBe(true);
    expect(i.isRecent(1_000 + USER_CLOSE_INTENT_MS)).toBe(true); // 边界含
    expect(i.isRecent(1_000 + USER_CLOSE_INTENT_MS + 1)).toBe(false);
    expect(i.isRecent(999)).toBe(false); // 时钟回拨：宁可漏记也不把过期意图当有效
    // 后一次 mark 覆盖前一次
    i.mark(5_000);
    expect(i.isRecent(5_500)).toBe(true);
  });

  it("窗口可注入", () => {
    const i = createUserCloseIntent(50);
    i.mark(0);
    expect(i.isRecent(50)).toBe(true);
    expect(i.isRecent(51)).toBe(false);
  });

  const obs = (open: boolean, taskId: string | null = "t1") => ({ taskId, open });

  it("展开态 → opened（用户展开 / ask 弹开）；不问 isUserClose", () => {
    let asked = 0;
    const ask = () => {
      asked += 1;
      return true;
    };
    expect(classifyPanelTransition(obs(false), obs(true), ask)).toBe("opened");
    expect(classifyPanelTransition(obs(true), obs(true), ask)).toBe("opened");
    expect(asked).toBe(0);
  });

  it("同一任务内 展开→收起：用户意图 → user-closed；非用户意图（库自动折叠）→ auto-closed", () => {
    expect(classifyPanelTransition(obs(true), obs(false), () => true)).toBe("user-closed");
    expect(classifyPanelTransition(obs(true), obs(false), () => false)).toBe("auto-closed");
  });

  it("本来就收起 / 切任务导致的重置 → none，且不去问意图", () => {
    let asked = 0;
    const ask = () => {
      asked += 1;
      return true;
    };
    expect(classifyPanelTransition(obs(false), obs(false), ask)).toBe("none");
    expect(classifyPanelTransition(obs(true, "t1"), obs(false, "t2"), ask)).toBe("none");
    expect(classifyPanelTransition(obs(true, null), obs(false, "t1"), ask)).toBe("none");
    expect(asked).toBe(0);
  });

  // 与 hook 里一样的串联：classify → （user-closed 才）noteUserClosedPanel / （opened 才）noteUserOpenedPanel → decideAutoOpen
  const sig = (over: Partial<BrowserSignals> = {}): BrowserSignals => ({
    exists: true,
    controller: "ai",
    askMessage: null,
    askSince: null,
    pendingUserActivity: 0,
    ...over,
  });
  const step = (
    memory: ReturnType<typeof initialAutoOpenMemory>,
    prev: { taskId: string; open: boolean },
    next: { taskId: string; open: boolean },
    userClose: boolean,
    signals: BrowserSignals,
  ) => {
    const kind = classifyPanelTransition(prev, next, () => userClose);
    if (kind === "opened") return noteUserOpenedPanel(memory);
    if (kind === "user-closed") return noteUserClosedPanel(memory, signals);
    return memory;
  };

  it("库自动折叠（AI 正在操作）不记 dismissed：AI 的下一个动作仍会把面板弹开", () => {
    let mem = initialAutoOpenMemory();
    mem = step(mem, { taskId: "t1", open: true }, { taskId: "t1", open: false }, false, sig());
    expect(mem.dismissed).toBe(false);
    // 轮次内 controller 回过 idle 再变 ai（AI 想了一会儿又动手）
    const d = decideAutoOpen(mem, sig({ controller: "ai" }), { panelOpen: false, source: "push" });
    expect(d.open).toBe(true);
  });

  it("用户手动收起（AI 正在操作）→ 记 dismissed：之后 AI 的动作不再弹（R1-17 原语义不变）", () => {
    let mem = initialAutoOpenMemory();
    mem = step(mem, { taskId: "t1", open: true }, { taskId: "t1", open: false }, true, sig());
    expect(mem.dismissed).toBe(true);
    mem = { ...mem, controller: "idle" };
    expect(decideAutoOpen(mem, sig({ controller: "ai" }), { panelOpen: false, source: "push" }).open).toBe(false);
    // 用户再手动展开 → 复位
    mem = step(mem, { taskId: "t1", open: false }, { taskId: "t1", open: true }, false, sig());
    expect(mem.dismissed).toBe(false);
  });

  it("库自动折叠不会清掉已有的 dismissed（用户之前手动关过，库折叠只是又一次收起）", () => {
    let mem = initialAutoOpenMemory();
    mem = step(mem, { taskId: "t1", open: true }, { taskId: "t1", open: false }, true, sig());
    expect(mem.dismissed).toBe(true);
    const after = step(mem, { taskId: "t1", open: true }, { taskId: "t1", open: false }, false, sig());
    expect(after).toBe(mem);
  });
});

describe("接线（源码契约）", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const page = strip(read("src/app/tasks/[id]/page.tsx"));

  /** 取 `const name = useCallback(` 起、到配对括号结束的整段 */
  const callbackBody = (src: string, name: string): string => {
    const start = src.indexOf(`const ${name} = useCallback(`);
    expect(start, `找不到 ${name}`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = src.indexOf("useCallback(", start); i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`${name} 括号不配对`);
  };

  it("showBrowserPane：先 prepareBrowserPaneEntry（旧约束下展开 / 放宽）、后 switchLeftTab(\"browser\")（= 换标签并记忆）；不再在换标签之后 expand()", () => {
    const body = callbackBody(page, "showBrowserPane");
    const iPrepare = body.indexOf("prepareBrowserPaneEntry(");
    const iSet = body.indexOf('switchLeftTab("browser")');
    expect(iPrepare).toBeGreaterThan(-1);
    expect(iSet).toBeGreaterThan(iPrepare);
    expect(body).not.toContain(".expand()");
    // 用的是「此刻」的分栏组宽度（元素 clientWidth），不是挂载时量一次就不变的 mainWidth state
    expect(body).toContain("mainElRef.current?.clientWidth");
    expect(body).not.toContain("mainWidth,");
  });

  it("主区容器的 ref 回调除了量一次宽度，还把元素留在 mainElRef（卸载时置空）", () => {
    expect(page).toMatch(/const mainElRef = useRef<HTMLDivElement \| null>\(null\)/);
    expect(page).toMatch(/const mainWidthRef = useCallback\(\(el: HTMLDivElement \| null\) => \{[^}]*mainElRef\.current = el;/);
  });

  it("左栏「产物 | 浏览器」分段切换走 onLeftTabChange：切到浏览器与头部入口同一条路径，切回产物是用户收起", () => {
    expect(page).toContain("<LeftPaneSwitch value={leftTab} onChange={onLeftTabChange} />");
    expect(page).not.toMatch(/<LeftPaneSwitch[^>]*onChange=\{(?:setLeftTab|switchLeftTab)\}/);
    const body = callbackBody(page, "onLeftTabChange");
    expect(body).toContain("showBrowserPane()");
    expect(body.indexOf("userCloseIntentRef.current.mark(")).toBeGreaterThan(-1);
    expect(body.indexOf("userCloseIntentRef.current.mark(")).toBeLessThan(body.indexOf("switchLeftTab(tab)"));
  });

  it("用户收起的入口都先 mark 意图再改状态：头部按钮 / 浏览器面板自己的 X（同走 closeBrowserPane）、折叠按钮 collapse、切回产物标签", () => {
    // 头部「浏览器」按钮收起 = closeBrowserPane；浏览器面板里的 X（onClose）也是它：mark 在 setLeftTab 之前
    const toggle = callbackBody(page, "toggleBrowserPane");
    expect(toggle).toContain("closeBrowserPane()");
    const close = callbackBody(page, "closeBrowserPane");
    expect(close.indexOf("userCloseIntentRef.current.mark(")).toBeGreaterThan(-1);
    expect(close.indexOf("userCloseIntentRef.current.mark(")).toBeLessThan(close.indexOf('switchLeftTab("artifact")'));
    expect(page).toMatch(/<BrowserPanel[^>]*onClose=\{closeBrowserPane\}/);
    // 头部唯一的分栏按钮：toggleSplitLayout 收起产物栏（= 连带关掉浏览器）前先 mark；展开类动作不 mark
    const split = callbackBody(page, "toggleSplitLayout");
    expect(split.indexOf("userCloseIntentRef.current.mark(")).toBeGreaterThan(-1);
    expect(split.indexOf("userCloseIntentRef.current.mark(")).toBeLessThan(split.indexOf("artifact?.collapse()"));
    expect(split.match(/userCloseIntentRef\.current\.mark\(/g)).toHaveLength(1);
  });

  it("任务页「放大」= 折叠事件流：关闭浏览器 / 切回产物都要把「放大造成的」折叠还原；用户自己折叠的不替他展开（R8-04 L06）", () => {
    // 还原函数：只有放大造成的才动，且先复位标记再展开
    const restore = callbackBody(page, "restoreEventStreamFromMaximize");
    expect(restore).toContain("if (!browserMaximizedRef.current) return;");
    expect(restore.indexOf("browserMaximizedRef.current = false")).toBeLessThan(restore.indexOf(".expand()"));
    expect(restore).toContain("isCollapsed()");
    // 放大：先记「是放大造成的」、再折叠；已折叠时再点 = 还原并清标记
    const max = callbackBody(page, "toggleBrowserMaximize");
    expect(max.indexOf("browserMaximizedRef.current = true")).toBeGreaterThan(-1);
    expect(max.indexOf("browserMaximizedRef.current = true")).toBeLessThan(max.indexOf("eventStream.collapse()"));
    // 关闭浏览器（头部按钮与面板 X 都走它）：先还原事件流、再切回产物
    const close = callbackBody(page, "closeBrowserPane");
    expect(close).toContain("restoreEventStreamFromMaximize()");
    expect(close.indexOf("restoreEventStreamFromMaximize()")).toBeLessThan(close.indexOf('switchLeftTab("artifact")'));
    // 分段切换：只有切回产物的分支还原；切到浏览器不还原（放大中切到浏览器不该把事件流弹出来）
    const tab = callbackBody(page, "onLeftTabChange");
    const iElse = tab.indexOf("else {");
    expect(iElse).toBeGreaterThan(-1);
    expect(tab.slice(0, iElse)).not.toContain("restoreEventStreamFromMaximize()");
    expect(tab.slice(iElse)).toContain("restoreEventStreamFromMaximize()");
    expect(tab.slice(iElse).indexOf("restoreEventStreamFromMaximize()")).toBeLessThan(tab.slice(iElse).indexOf("switchLeftTab(tab)"));
    // 事件流被用户拖开 / 展开后，「放大」标记随之复位（切任务重挂 Group 时也靠它兜底）
    expect(page).toContain("if (!collapsed) browserMaximizedRef.current = false;");
  });

  it("自动展开 hook 拿到 isUserClose（= mark 意图 或 分隔条拖拽意图）；userResizeIntentRef 只声明一次、在使用之前", () => {
    expect(page).toMatch(/useBrowserAutoOpen\(\{[^}]*isUserClose: isUserClosePane/);
    const body = callbackBody(page, "isUserClosePane");
    expect(body).toContain("userCloseIntentRef.current.isRecent(now)");
    expect(body).toContain("userResizeIntentRef.current.isActive(now)");
    expect(page.match(/const userResizeIntentRef = /g)).toHaveLength(1);
    expect(page.indexOf("const userResizeIntentRef")).toBeLessThan(page.indexOf("const isUserClosePane"));
  });

  it("切到浏览器只有 showBrowserPane 一处（绕过就没有先放宽）；setLeftTab 只剩 switchLeftTab 本体与切任务时的复位两处，不会有人绕过记忆", () => {
    // 换到浏览器标签一律经 switchLeftTab("browser")，且只在 showBrowserPane 里
    expect(page.match(/switchLeftTab\("browser"\)/g) ?? []).toHaveLength(1);
    expect(callbackBody(page, "showBrowserPane")).toContain('switchLeftTab("browser")');
    // 不允许直接 setLeftTab("browser")：那样既绕过先放宽、也绕过左栏标签记忆
    expect(page).not.toContain('setLeftTab("browser")');
    // setLeftTab 的全部调用：switchLeftTab 本体（setLeftTab(tab)）+ 切任务时复位成产物（不写记忆）
    expect(page.match(/setLeftTab\(/g) ?? []).toHaveLength(2);
    expect(page.match(/setLeftTab\("artifact"\)/g) ?? []).toHaveLength(1);
    expect(page.match(/setLeftTab\(tab\)/g) ?? []).toHaveLength(1);
    // 按「单词」数（评审 R16-08）：`/setLeftTab\(/` 抓不到 `onChange={setLeftTab}` 这种把 setter 直接递出去的旁路。
    // 全部出现 = useState 的声明 1 处 + 上面两处调用；多一处引用就是有人拿到了裸 setter
    expect(page.match(/\bsetLeftTab\b/g) ?? []).toHaveLength(3);
  });

  it("自动展开 hook：isUserClose 缺省 = 一律当用户收起（旧行为，向后兼容）；有传才按它判", () => {
    const hook = strip(read("src/components/browser/use-browser-auto-open.ts"));
    expect(hook).toContain("isUserClose?: () => boolean");
    expect(hook).toContain("() => isUserCloseRef.current?.() ?? true");
  });

  it("chat 页浏览器栏：头部按钮收起前 mark 意图；isUserClose = mark 意图 或 分隔条拖拽意图", () => {
    const chat = strip(read("src/components/browser/use-chat-browser-pane.ts"));
    expect(chat).toContain("isUserClose: isUserClosePane");
    expect(chat).toContain("userCloseIntentRef.current.isRecent(now)");
    expect(chat).toContain("intentRef.current.isActive(now)");
    const toggle = chat.slice(chat.indexOf("const toggle = useCallback("));
    expect(toggle.indexOf("userCloseIntentRef.current.mark(")).toBeGreaterThan(-1);
    expect(toggle.indexOf("userCloseIntentRef.current.mark(")).toBeLessThan(toggle.indexOf("setOpen(!openRef.current)"));
  });
});
