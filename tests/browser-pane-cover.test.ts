/**
 * 浏览器抽屉：关闭 X、放大（盖住对话 / 事件流）。
 *
 * 背景：chat 页对话栏有 320px 像素下限、浏览器栏最大 70%，1000px 宽的主区里浏览器最多 ~680px——「最宽也没多宽」；
 * 抽屉里也没有关闭入口（只能再点头部的「浏览器」）。现在浏览器栏 maxSize=100%、对话栏 collapsible，
 * 拖宽 / 点「放大」就把对话栏折叠成 0（= 盖住对话）；工作台里「放大」= 折叠事件流栏（见 task-split-layout.test.ts）。
 *
 * 这里钉纯函数口径（打开宽度夹取 / 盖住判定 / 记忆范围）和接线契约；库在真窗口里的折叠表现需要界面，不在这里验证。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyChatSplitCommand,
  CHAT_BROWSER_MAX_PERCENT,
  CHAT_BROWSER_MIN_PX,
  CHAT_BROWSER_PANEL_ID,
  CHAT_BROWSER_REMEMBER_MAX_PERCENT,
  CHAT_MAIN_MIN_PX,
  CHAT_MAIN_PANEL_ID,
  isChatCoveredSize,
  repairChatSplitAfterMount,
  resolveChatBrowserOpenPercent,
  writeChatBrowserPercent,
  type ChatSplitHandles,
} from "@/components/browser/browser-layout-memory";

describe("浏览器栏宽度上限", () => {
  it("面板 maxSize = 100%（可以盖住整个对话栏）；可记住的上限 90%，盖住（100%）不记", () => {
    expect(CHAT_BROWSER_MAX_PERCENT).toBe(100);
    expect(CHAT_BROWSER_REMEMBER_MAX_PERCENT).toBe(90);
    expect(CHAT_BROWSER_REMEMBER_MAX_PERCENT).toBeLessThan(CHAT_BROWSER_MAX_PERCENT);
  });

  it("写入记忆：大屏上拖出来的 85% 要记住；盖住时的 100%、折叠态的 0 不记", () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(writeChatBrowserPercent(85, storage)).toBe(true);
    expect(writeChatBrowserPercent(100, storage)).toBe(false);
    expect(writeChatBrowserPercent(0, storage)).toBe(false);
    expect([...m.values()]).toEqual(["85"]);
  });
});

describe("isChatCoveredSize：对话栏折叠成 0 = 被盖住", () => {
  it("0 / 接近 0 → 盖住；正常宽度 → 没盖住", () => {
    expect(isChatCoveredSize(0)).toBe(true);
    expect(isChatCoveredSize(0.49)).toBe(true);
    expect(isChatCoveredSize(0.5)).toBe(false);
    expect(isChatCoveredSize(58)).toBe(false);
    expect(isChatCoveredSize(100)).toBe(false);
  });
});

describe("resolveChatBrowserOpenPercent：打开 / 还原时别把对话栏挤到被库折叠", () => {
  it("量不到分栏组宽度（null / undefined / 0 / 负数 / NaN）→ 原样返回记住的宽度", () => {
    for (const w of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveChatBrowserOpenPercent(42, w), String(w)).toBe(42);
    }
  });

  it("宽屏：记住的宽度本来就给对话栏留足 320px → 不动", () => {
    expect(resolveChatBrowserOpenPercent(42, 1400)).toBe(42);
    // 大屏记下的 80%：1900px 宽时对话栏还剩 380px
    expect(resolveChatBrowserOpenPercent(80, 1900)).toBe(80);
  });

  it("窗口比记宽度时小：封顶到「对话栏恰好 320px」，否则对话栏会被库折叠（点浏览器却把对话盖没了）", () => {
    // 1000px 宽：浏览器最多 680px = 68%
    expect(resolveChatBrowserOpenPercent(80, 1000)).toBe(68);
    const percent = resolveChatBrowserOpenPercent(90, 1200);
    expect((1200 * (100 - percent)) / 100).toBeGreaterThanOrEqual(CHAT_MAIN_MIN_PX - 0.5);
  });

  it("记住的宽度不足浏览器像素下限 → 抬到下限（与库夹到 minSize 的行为一致，不再差一次 resize）", () => {
    // 25% × 1000px = 250px < 300px
    expect(resolveChatBrowserOpenPercent(25, 1000)).toBe(30);
    expect((1000 * 30) / 100).toBeGreaterThanOrEqual(CHAT_BROWSER_MIN_PX);
  });

  it("窄到放不下「对话下限 + 浏览器下限」：保浏览器下限（这时库自己裁决，不由这里猜）", () => {
    // 500px：对话 320 + 浏览器 300 = 620 > 500
    expect(resolveChatBrowserOpenPercent(42, 500)).toBe(60);
  });

  it("结果取两位小数", () => {
    const p = resolveChatBrowserOpenPercent(90, 777);
    expect(Math.round(p * 100) / 100).toBe(p);
  });
});

/**
 * 假的 chat 分栏（两栏：chat-main | chat-browser），模拟 react-resizable-panels 4.11.1 里和本功能相关的两个行为：
 *   ① 「最后一个 Panel 缩小、且它前面的 Panel 全是折叠态」→ 直接设成 100 − 前面之和 = 100，即**什么都不变、不抛错**
 *      （盖住态下对浏览器栏 resize(记住宽度) / collapse() 就撞上它——审核 R8-02）；
 *   ② 其余命令按字面生效；Group.setLayout 直接给整份布局。
 * 真库行为由 scripts/browser-e2e/r9-chat-split-cover.cjs 验证；这里钉的是「命令发给了谁」，node 环境里没有布局，只能用模型。
 */
const makeFakeSplit = (
  initial: { main: number; browser: number },
  opts: { deadMain?: boolean; deadBrowser?: boolean; noGroup?: boolean } = {},
) => {
  const state = { ...initial };
  const calls: string[] = [];
  const pct = (s: string) => Number.parseFloat(s);
  const setBrowserSize = (size: number) => {
    // 特判①：缩小浏览器栏、而对话栏已折叠 → 无事发生
    if (size < state.browser && state.main < 0.5) return;
    state.browser = size;
    state.main = 100 - size;
  };
  const handles: ChatSplitHandles = {
    main: {
      resize: (s) => {
        calls.push(`main.resize(${s})`);
        if (opts.deadMain) return;
        state.main = pct(s);
        state.browser = 100 - state.main;
      },
      collapse: () => {
        calls.push("main.collapse()");
        if (opts.deadMain) return;
        state.main = 0;
        state.browser = 100;
      },
      isCollapsed: () => state.main < 0.5,
    },
    browser: {
      resize: (s) => {
        calls.push(`browser.resize(${s})`);
        if (opts.deadBrowser) return;
        setBrowserSize(pct(s));
      },
      collapse: () => {
        calls.push("browser.collapse()");
        if (opts.deadBrowser) return;
        setBrowserSize(0);
      },
      isCollapsed: () => state.browser < 0.5,
    },
    group: opts.noGroup
      ? null
      : {
          setLayout: (layout) => {
            calls.push(`group.setLayout(${JSON.stringify(layout)})`);
            state.main = layout[CHAT_MAIN_PANEL_ID];
            state.browser = layout[CHAT_BROWSER_PANEL_ID];
            return layout;
          },
        },
  };
  return { state, calls, handles };
};

describe("假分栏自检：模型确实复现了库的特判（否则下面的测试没有意义）", () => {
  it("盖住态下对浏览器栏 resize(42%) / collapse() 都是静默无效；对对话栏 resize 才生效", () => {
    const a = makeFakeSplit({ main: 0, browser: 100 });
    a.handles.browser!.resize("42%");
    expect(a.state).toEqual({ main: 0, browser: 100 });
    a.handles.browser!.collapse();
    expect(a.state).toEqual({ main: 0, browser: 100 });
    a.handles.main!.resize("58%");
    expect(a.state).toEqual({ main: 58, browser: 42 });
    // 没盖住时对浏览器栏缩小是正常生效的
    const b = makeFakeSplit({ main: 58, browser: 42 });
    b.handles.browser!.collapse();
    expect(b.state).toEqual({ main: 100, browser: 0 });
  });
});

describe("applyChatSplitCommand：放大 / 还原 / 关闭（R8-02）", () => {
  it("放大：浏览器栏占满，对话栏折叠成 0", () => {
    const f = makeFakeSplit({ main: 58, browser: 42 });
    expect(applyChatSplitCommand({ kind: "cover" }, f.handles)).toBe(true);
    expect(f.state).toEqual({ main: 0, browser: 100 });
    expect(f.calls).toEqual(["browser.resize(100%)"]);
  });

  it("还原：命令发给**对话栏**（浏览器栏是最后一个 Panel，盖住态下对它缩小静默无效），回到放大前的宽度", () => {
    const f = makeFakeSplit({ main: 0, browser: 100 });
    expect(applyChatSplitCommand({ kind: "restore", browserPercent: 42 }, f.handles)).toBe(true);
    expect(f.state).toEqual({ main: 58, browser: 42 });
    expect(f.calls).toEqual(["main.resize(58%)"]);
    expect(f.calls.some((c) => c.startsWith("browser."))).toBe(false);
  });

  it("还原的百分比取两位小数，且两栏之和 = 100", () => {
    const f = makeFakeSplit({ main: 0, browser: 100 });
    applyChatSplitCommand({ kind: "restore", browserPercent: 41.6666 }, f.handles);
    expect(f.calls).toEqual(["main.resize(58.33%)"]);
    expect(f.state.main + f.state.browser).toBeCloseTo(100, 5);
  });

  it("盖住态下关闭：让对话栏占满（浏览器栏随之折叠），不对浏览器栏 collapse()", () => {
    const f = makeFakeSplit({ main: 0, browser: 100 });
    expect(applyChatSplitCommand({ kind: "close" }, f.handles)).toBe(true);
    expect(f.state).toEqual({ main: 100, browser: 0 });
    expect(f.calls).toEqual(["main.resize(100%)"]);
  });

  it("没盖住时关闭：照常折叠浏览器栏", () => {
    const f = makeFakeSplit({ main: 58, browser: 42 });
    expect(applyChatSplitCommand({ kind: "close" }, f.handles)).toBe(true);
    expect(f.state).toEqual({ main: 100, browser: 0 });
    expect(f.calls).toEqual(["browser.collapse()"]);
  });

  it("命令没生效（回读折叠态不对）→ 走 Group.setLayout 兜底，不再靠 try/catch 吞掉静默无效", () => {
    // 还原：对话栏的命令没起作用
    const r = makeFakeSplit({ main: 0, browser: 100 }, { deadMain: true });
    expect(applyChatSplitCommand({ kind: "restore", browserPercent: 42 }, r.handles)).toBe(true);
    expect(r.state).toEqual({ main: 58, browser: 42 });
    expect(r.calls[r.calls.length - 1]).toBe(`group.setLayout(${JSON.stringify({ [CHAT_MAIN_PANEL_ID]: 58, [CHAT_BROWSER_PANEL_ID]: 42 })})`);
    // 放大：浏览器栏的命令没起作用
    const c = makeFakeSplit({ main: 58, browser: 42 }, { deadBrowser: true });
    expect(applyChatSplitCommand({ kind: "cover" }, c.handles)).toBe(true);
    expect(c.state).toEqual({ main: 0, browser: 100 });
    // 关闭（没盖住）：浏览器栏 collapse 没起作用
    const x = makeFakeSplit({ main: 58, browser: 42 }, { deadBrowser: true });
    expect(applyChatSplitCommand({ kind: "close" }, x.handles)).toBe(true);
    expect(x.state).toEqual({ main: 100, browser: 0 });
    // 关闭（盖住态）：对话栏 resize 没起作用
    const y = makeFakeSplit({ main: 0, browser: 100 }, { deadMain: true });
    expect(applyChatSplitCommand({ kind: "close" }, y.handles)).toBe(true);
    expect(y.state).toEqual({ main: 100, browser: 0 });
  });

  it("命令与兜底都没生效 → 返回 false（调用方能知道），不抛错", () => {
    const f = makeFakeSplit({ main: 0, browser: 100 }, { deadMain: true, noGroup: true });
    expect(applyChatSplitCommand({ kind: "restore", browserPercent: 42 }, f.handles)).toBe(false);
    expect(f.state).toEqual({ main: 0, browser: 100 });
  });

  it("句柄缺失 / 库抛错 → false，不抛错", () => {
    expect(applyChatSplitCommand({ kind: "cover" }, { main: null, browser: null, group: null })).toBe(false);
    expect(applyChatSplitCommand({ kind: "close" }, { main: undefined, browser: undefined, group: undefined })).toBe(false);
    const boom = () => {
      throw new Error("Group not mounted");
    };
    const throwing: ChatSplitHandles = {
      main: { resize: boom, collapse: boom, isCollapsed: boom },
      browser: { resize: boom, collapse: boom, isCollapsed: boom },
      group: { setLayout: boom },
    };
    for (const kind of ["cover", "close"] as const) {
      expect(applyChatSplitCommand({ kind }, throwing)).toBe(false);
    }
    expect(applyChatSplitCommand({ kind: "restore", browserPercent: 42 }, throwing)).toBe(false);
  });
});

describe("repairChatSplitAfterMount：挂载即被库折叠的对话栏要还回来（R8-03）", () => {
  it("挂载时对话栏正常 → 不动任何东西", () => {
    const f = makeFakeSplit({ main: 58, browser: 42 });
    expect(repairChatSplitAfterMount(f.handles, 42, 1400)).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("记住 85% 而容器只有 1000px → 对话栏被折叠成 0 的话，还原到夹取后的宽度（对话恰好 320px）", () => {
    const f = makeFakeSplit({ main: 0, browser: 100 });
    expect(repairChatSplitAfterMount(f.handles, 85, 1000)).toBe(true);
    // 1000px 宽：浏览器最多 68% = 680px
    expect(f.state).toEqual({ main: 32, browser: 68 });
    expect((1000 * f.state.main) / 100).toBeGreaterThanOrEqual(CHAT_MAIN_MIN_PX);
  });

  it("量不到容器宽度 → 按记住的宽度还原（不夹取）", () => {
    const f = makeFakeSplit({ main: 0, browser: 100 });
    expect(repairChatSplitAfterMount(f.handles, 42, undefined)).toBe(true);
    expect(f.state).toEqual({ main: 58, browser: 42 });
  });

  it("Panel 还没注册完（句柄缺失 / isCollapsed 抛错）→ false，交回库处理，不抛错", () => {
    expect(repairChatSplitAfterMount({ main: null, browser: null, group: null }, 85, 1000)).toBe(false);
    const f = makeFakeSplit({ main: 0, browser: 100 });
    f.handles.main!.isCollapsed = () => {
      throw new Error("not registered");
    };
    expect(repairChatSplitAfterMount(f.handles, 85, 1000)).toBe(false);
  });
});

describe("接线契约（源码）", () => {
  const root = process.cwd();
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const split = strip(read("src/components/browser/chat-browser-split.tsx"));
  const hook = strip(read("src/components/browser/use-chat-browser-pane.ts"));
  const panel = strip(read("src/components/browser/browser-panel.tsx"));

  it("对话栏：collapsible + collapsedSize=0 + onResize 回写盖住态；保留像素下限", () => {
    const i = split.indexOf('id="chat-main"');
    const chat = split.slice(i, split.indexOf("</ResizablePanel>", i));
    expect(i).toBeGreaterThan(-1);
    expect(chat).toContain("collapsible");
    expect(chat).toContain("collapsedSize={0}");
    expect(chat).toContain("onResize={pane.onMainResize}");
    expect(chat).toContain("minSize={`${CHAT_MAIN_MIN_PX}px`}");
  });

  it("盖住时：内容固定 min-width（只裁切不重排）+ inert + 内层 overflow 裁掉；平时不动内层样式", () => {
    expect(split).toContain("style={{ minWidth: CHAT_MAIN_MIN_PX }}");
    expect(split).toContain("inert={chatCovered}");
    expect(split).toContain('chatCovered ? { overflow: "hidden" } : undefined');
  });

  it("浏览器栏 maxSize 来自 CHAT_BROWSER_MAX_PERCENT（100）；面板挂 X / 放大，放大态 = 对话被盖住", () => {
    expect(split).toContain("maxSize={`${CHAT_BROWSER_MAX_PERCENT}%`}");
    expect(split).toContain("onClose={pane.close}");
    expect(split).toContain("maximized={chatCovered}");
    expect(split).toContain("onToggleMaximize={pane.toggleCover}");
    expect(split).toContain('coverTarget="对话"');
  });

  it("hook：X 关闭只关不开且先 mark 用户收起意图", () => {
    const close = hook.slice(hook.indexOf("const close = useCallback("));
    expect(close.indexOf("if (!openRef.current) return;")).toBeGreaterThan(-1);
    expect(close.indexOf("userCloseIntentRef.current.mark(")).toBeLessThan(close.indexOf("setOpen(false)"));
  });

  it("hook：放大 / 还原 / 关闭都走 applyChatSplitCommand（命令发给谁由它决定，行为见下面的假句柄测试）；打开仍经夹取", () => {
    const setOpen = hook.slice(hook.indexOf("const setOpen = useCallback("), hook.indexOf("const show = useCallback("));
    expect(setOpen).toContain('applyChatSplitCommand({ kind: "close" }, splitHandles())');
    // 关闭不能再直接对浏览器栏 collapse()——盖住态下那是静默无效（R8-02）
    expect(setOpen).not.toContain("panel.collapse()");
    expect(setOpen).toContain("resolveChatBrowserOpenPercent(");

    const cover = hook.slice(hook.indexOf("const toggleCover = useCallback("), hook.indexOf("useLayoutEffect("));
    // 是否盖住以布局本身（对话栏折叠态）为准，React 状态只做兜底
    expect(cover).toContain("handles.main?.isCollapsed()");
    expect(cover).toContain('applyChatSplitCommand({ kind: "cover" }, handles)');
    expect(cover).toContain('applyChatSplitCommand({ kind: "restore", browserPercent }, handles)');
    expect(cover).toContain("resolveChatBrowserOpenPercent(");
    expect(cover).not.toContain('panel.resize("100%")');
  });

  it("hook：挂载即开着的情况在首帧绘制前修一次（R8-03）；只在 initial.open 时做", () => {
    const i = hook.indexOf("useLayoutEffect(() => {");
    expect(i).toBeGreaterThan(-1);
    const effect = hook.slice(i, hook.indexOf("}, [initial, splitHandles]);", i));
    expect(effect).toContain("if (!initial.open) return;");
    expect(effect).toContain("repairChatSplitAfterMount(splitHandles(), initial.percent, wrapperRef.current?.clientWidth)");
  });

  it("分栏：Group 与对话栏都把句柄交给 hook；Panel id 与命令层常量一致（setLayout 靠 id 对号入座）", () => {
    expect(split).toContain("groupRef={pane.groupRef}");
    const iMain = split.indexOf('id="chat-main"');
    expect(split.slice(iMain, split.indexOf("</ResizablePanel>", iMain))).toContain("panelRef={pane.mainPanelRef}");
    const iBrowser = split.indexOf('id="chat-browser"');
    expect(iBrowser).toBeGreaterThan(-1);
    expect(split.slice(iBrowser, split.indexOf("</ResizablePanel>", iBrowser))).toContain("panelRef={pane.panelRef}");
    expect(CHAT_MAIN_PANEL_ID).toBe("chat-main");
    expect(CHAT_BROWSER_PANEL_ID).toBe("chat-browser");
  });

  it("hook：盖住态按任务隔离（key 对不上当没盖住），不写进宽度记忆", () => {
    expect(hook).toContain("coverState.taskId === taskId && coverState.covered");
    const onLayout = hook.slice(hook.indexOf("const onLayoutChanged = useCallback("));
    // 只有 chat-browser 的有效宽度会写；100% 在 writeChatBrowserPercent 里被 isValid 挡掉（见上面的行为测试）
    expect(onLayout).toContain('layout["chat-browser"]');
    expect(onLayout).toContain("writeChatBrowserPercent(browser)");
  });

  it("BrowserPanel：关闭 / 放大是可选 prop，不传不画（别处调用方零影响）；关闭用 X、有 Tooltip 文案", () => {
    expect(panel).toMatch(/\{onToggleMaximize && \(/);
    expect(panel).toMatch(/\{onClose && \(/);
    expect(panel).toContain('label="关闭浏览器"');
    expect(panel).toContain("onClick={onClose}");
    expect(panel).toContain("放大浏览器，盖住${coverTarget}");
    // 「停止加载」的 X 还在（两个 X 靠位置与 tooltip 区分）
    expect(panel).toContain('label="停止加载"');
  });
});
