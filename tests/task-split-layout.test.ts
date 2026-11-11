/**
 * 窄栏策略的页面布局部分（第二轮 review V13-01/03/04/05 + §4 第 5 条，task 详情页）：
 *  - 事件流面板改像素下限（320px）：默认窗口下它只有约 307px（侧栏 257 + 默认 30%），表格 / 答题卡 / 搜索框全部失效；
 *  - 默认宽度 `max(30%, 380px)`：react-resizable-panels 的 defaultSize 写不了 CSS max()，所以量出容器宽度再换算百分比；
 *  - 产物栏可一键折叠：现有布局没有任何折叠能力（Panel 没有 collapsible / panelRef），所以新增。
 *
 * 窗口 minWidth / minHeight（960×600）在 Electron main 进程里改，不在本次范围。
 * 没有在浏览器里看过实际手感：这里只钉纯函数口径 + 源码接线。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveTaskLeftPaneMinSize } from "@/components/browser/browser-layout-memory";

import {
  ARTIFACT_PANEL_MAX_PERCENT,
  EVENT_STREAM_DEFAULT_MIN_PX,
  EVENT_STREAM_MAX_PERCENT,
  EVENT_STREAM_MIN_PX,
  isArtifactCollapsedSize,
  isValidArtifactPanelSize,
  planSplitToggle,
  resolveArtifactDefaultPercent,
  SPLIT_TOGGLE_LABEL,
  type SplitToggleAction,
} from "@/lib/task-split-layout";

describe("resolveArtifactDefaultPercent", () => {
  it("没有已存布局 + 量到宽度：事件流 = max(30%, 380px)，产物栏 = 余下", () => {
    // 1023（默认 1280 窗口减侧栏 257）：30% = 307 < 380 → 事件流取 380px ≈ 37.14%
    expect(resolveArtifactDefaultPercent({ persisted: undefined, containerWidth: 1023 })).toBeCloseTo(62.86, 1);
    // 宽窗口：30% 已经够 380 → 仍是 70/30
    expect(resolveArtifactDefaultPercent({ persisted: undefined, containerWidth: 1600 })).toBe(70);
    // 恰好 30% = 380px
    expect(
      resolveArtifactDefaultPercent({ persisted: undefined, containerWidth: EVENT_STREAM_DEFAULT_MIN_PX / 0.3 }),
    ).toBeCloseTo(70, 1);
  });

  it("极窄容器：默认布局里事件流不超过 80%（EVENT_STREAM_MAX_PERCENT），产物栏保底 20%", () => {
    expect(resolveArtifactDefaultPercent({ persisted: undefined, containerWidth: 400 })).toBe(
      100 - EVENT_STREAM_MAX_PERCENT,
    );
    expect(EVENT_STREAM_MAX_PERCENT).toBe(80);
  });

  it("产物栏 Panel 的 maxSize = 100%：事件流栏能折叠成 0，折叠后产物栏必须能占满，否则库会把 20% 还给事件流", () => {
    expect(ARTIFACT_PANEL_MAX_PERCENT).toBe(100);
  });

  it("已存的合法布局优先（用户拖过 / 以前存过），不被默认值覆盖", () => {
    expect(resolveArtifactDefaultPercent({ persisted: 55, containerWidth: 1023 })).toBe(55);
    expect(resolveArtifactDefaultPercent({ persisted: 70, containerWidth: 1023 })).toBe(70);
  });

  it("已存值不合法（折叠时的 0 / 越界 / NaN / 非数字）按没存处理", () => {
    for (const bad of [0, 5, 95, Number.NaN, "70" as unknown as number, null as unknown as number]) {
      expect(resolveArtifactDefaultPercent({ persisted: bad, containerWidth: 1600 })).toBe(70);
    }
  });

  it("量不到宽度（SSR / 0 / 负数 / NaN）→ 回落旧默认 70", () => {
    for (const w of [null, 0, -5, Number.NaN]) {
      expect(resolveArtifactDefaultPercent({ persisted: undefined, containerWidth: w })).toBe(70);
    }
  });
});

describe("isValidArtifactPanelSize / isArtifactCollapsedSize", () => {
  it("读与写同一个口径：10..90 的有限数才算有效（折叠态的 0 不会被存成布局偏好）", () => {
    expect(isValidArtifactPanelSize(10)).toBe(true);
    expect(isValidArtifactPanelSize(90)).toBe(true);
    expect(isValidArtifactPanelSize(70)).toBe(true);
    expect(isValidArtifactPanelSize(0)).toBe(false);
    expect(isValidArtifactPanelSize(9.9)).toBe(false);
    expect(isValidArtifactPanelSize(90.1)).toBe(false);
    expect(isValidArtifactPanelSize(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidArtifactPanelSize(undefined)).toBe(false);
  });

  it("折叠判定：产物栏宽度（百分比）< 1 视为折叠（collapsedSize=0）", () => {
    expect(isArtifactCollapsedSize(0)).toBe(true);
    expect(isArtifactCollapsedSize(0.4)).toBe(true);
    expect(isArtifactCollapsedSize(20)).toBe(false);
    expect(isArtifactCollapsedSize(70)).toBe(false);
  });
});

// ---- 接线契约 ----
const repoDir = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(repoDir, rel), "utf-8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("task 详情页布局接线", () => {
  const raw = read("src/app/tasks/[id]/page.tsx");
  const page = stripComments(raw);

  it("事件流面板：最小宽度是像素下限（EVENT_STREAM_MIN_PX），不再是 20%", () => {
    expect(EVENT_STREAM_MIN_PX).toBe(320);
    const i = page.indexOf('id="event-stream"');
    expect(i).toBeGreaterThan(-1);
    const panel = page.slice(i, i + 400);
    expect(panel).toContain("minSize={`${EVENT_STREAM_MIN_PX}px`}");
    expect(panel).not.toContain('minSize="20%"');
  });

  it("事件流面板不设 maxSize：产物栏折叠后它才能吃满整行（未折叠时上限由产物栏 minSize=20% 保证）", () => {
    const i = page.indexOf('id="event-stream"');
    const panel = page.slice(i, page.indexOf("<aside", i));
    expect(panel).not.toMatch(/maxSize=/);
    const a = page.indexOf('id="artifact"');
    // R1-37：产物标签下仍是 20%（resolveTaskLeftPaneMinSize(false)），浏览器标签激活时换像素下限（见 tests/browser-ui-logic.test.ts）
    expect(page.slice(a, page.indexOf(">", page.indexOf("onResize", a)))).toContain(
      'minSize={resolveTaskLeftPaneMinSize(leftTab === "browser")}',
    );
    expect(resolveTaskLeftPaneMinSize(false)).toBe("20%");
  });

  it("默认宽度走 resolveArtifactDefaultPercent(量到的容器宽度)；量到之前不挂 Group（避免先按 70/30 挂、再重挂）", () => {
    expect(page).toContain("resolveArtifactDefaultPercent({");
    expect(page).toMatch(/containerWidth: mainWidth/);
    expect(page).toMatch(/mainWidth == null \? null : \(\s*<ResizablePanelGroup/);
    // 量宽度在主区容器的 ref 回调里做（提交阶段、绘制前），不在 render 里读 DOM
    expect(page).toMatch(/<div\s+ref=\{mainWidthRef\}\s+className="flex flex-1 min-h-0"/);
    expect(page).toMatch(/const mainWidthRef = useCallback\(\(el: HTMLDivElement \| null\) => \{\s*if \(el\) setMainWidth\(el\.clientWidth\);/);
    // 事件流 / 产物栏的 defaultSize 都来自它，没有残留的旧常量 70
    expect(page).not.toContain("artifactSizePercent");
  });

  it("产物栏 Panel 可折叠：collapsible + collapsedSize=0 + panelRef，并用 onResize 同步折叠态", () => {
    const i = page.indexOf('id="artifact"');
    expect(i).toBeGreaterThan(-1);
    const panel = page.slice(i, i + 500);
    expect(panel).toContain("collapsible");
    expect(panel).toContain("collapsedSize={0}");
    expect(panel).toContain("panelRef={artifactPanelRef}");
    expect(panel).toMatch(/onResize=\{/);
    expect(page).toContain("isArtifactCollapsedSize(");
  });

  it("折叠入口：头部 chip 行里**一颗**状态感知的图标按钮，按 planSplitToggle 的决策命令式驱动 Panel（expand / collapse）", () => {
    // 三个图标都用得上：收起产物栏 / 展开产物栏 / 展开事件流（PanelRightClose 不再有——没有「收起事件流」入口了）
    expect(page).toContain("PanelLeftClose");
    expect(page).toContain("PanelLeftOpen");
    expect(page).toContain("PanelRightOpen");
    expect(page).not.toContain("PanelRightClose");
    expect(page).toMatch(/planSplitToggle\(/);
    expect(page).toMatch(/const artifact = artifactPanelRef\.current;/);
    expect(page).toMatch(/eventStream\?\.expand\(\)/);
    expect(page).toMatch(/artifact\?\.expand\(\)/);
    expect(page).toMatch(/artifact\?\.collapse\(\)/);
    // 按钮：label / Tooltip 都来自 SPLIT_TOGGLE_LABEL[当前动作]；onClick 只有 toggleSplitLayout 一个
    expect(page).toMatch(/<Tooltip content=\{SPLIT_TOGGLE_LABEL\[splitToggleAction\]\}>/);
    expect(page).toMatch(/aria-label=\{SPLIT_TOGGLE_LABEL\[splitToggleAction\]\}/);
    expect(page.match(/onClick=\{toggleSplitLayout\}/g)).toHaveLength(1);
    // label 随状态变，就不能再挂 aria-pressed / aria-expanded（R9a-06：读屏念「展开产物栏，开关按钮，已按下」自相矛盾）
    const btnAt = page.indexOf("onClick={toggleSplitLayout}");
    const btn = page.slice(Math.max(0, btnAt - 400), btnAt + 700);
    expect(btn).not.toMatch(/aria-pressed|aria-expanded/);
    expect(page).not.toMatch(/aria-pressed=\{artifactCollapsed\}/);
    // 折叠态面板内容 inert：退出 Tab 序与读屏
    expect(page).toMatch(/inert=\{artifactCollapsed\}/);
    // 不用原生 title（规范：提示一律 Tooltip）
    expect(btn).not.toMatch(/\btitle=/);
  });

  it("头部不再有两颗分栏按钮：旧的「产物栏」「事件流栏」按钮与它们的回调都没了", () => {
    expect(page).not.toMatch(/aria-label="产物栏"/);
    expect(page).not.toMatch(/aria-label="事件流栏"/);
    expect(page).not.toContain("toggleArtifactPanel");
    expect(page).not.toContain("toggleEventStreamPanel");
    expect(page).not.toContain("toggleSplitPane");
    // 分栏开关只出现一次：Tooltip 内容、aria-label、onClick 各一处
    expect(page.match(/SPLIT_TOGGLE_LABEL\[splitToggleAction\]/g)).toHaveLength(2);
  });

  it("持久化只存有效值：折叠时 0 不能覆盖用户上次拖出来的宽度", () => {
    expect(page).toMatch(/isValidArtifactPanelSize\(artifact\)/);
    // 读取侧也走同一个判定，读写不漂移
    expect(page).toMatch(/resolveArtifactDefaultPercent\(\{\s*persisted: task\?\.uiLayout\?\.artifactPanelSize/);
  });
});

describe("planSplitToggle：一颗按钮、三种动作，永远至少一栏看得见", () => {
  it.each<[string, boolean, boolean, SplitToggleAction]>([
    // [说明, 产物栏已折叠, 事件流已折叠, 期望动作]
    ["分栏（两栏都展开）：收起产物栏，事件流占满", false, false, "collapse-artifact"],
    ["事件流占满（产物栏已折叠）：展开产物栏，回到分栏", true, false, "expand-artifact"],
    ["产物 / 浏览器占满（事件流已折叠，放大或拖出来的）：展开事件流，回到分栏", false, true, "expand-event-stream"],
    ["两栏都折叠（本不该出现）：先让事件流回来，不留一片空白", true, true, "expand-event-stream"],
  ])("%s", (_name, artifactCollapsed, eventStreamCollapsed, expected) => {
    expect(planSplitToggle({ artifactCollapsed, eventStreamCollapsed })).toBe(expected);
  });

  it("任何状态下点一次，结果都不会是两栏同时折叠；连点两次回到出发点（分栏 ↔ 事件流占满）", () => {
    // 把动作作用到状态上（展开 = 对应栏变展开；收起产物栏 = 产物栏变折叠，事件流此时一定是展开的）
    const apply = (st: { a: boolean; e: boolean }, action: SplitToggleAction) => {
      if (action === "expand-event-stream") return { ...st, e: false };
      if (action === "expand-artifact") return { ...st, a: false };
      return { ...st, a: true };
    };
    for (const a of [true, false]) {
      for (const e of [true, false]) {
        const next = apply({ a, e }, planSplitToggle({ artifactCollapsed: a, eventStreamCollapsed: e }));
        // 出发点两栏都折叠时只展开了事件流：产物栏仍折叠，但事件流看得见
        expect(next.a && next.e).toBe(false);
      }
    }
    const split = { a: false, e: false };
    const once = apply(split, planSplitToggle({ artifactCollapsed: split.a, eventStreamCollapsed: split.e }));
    const twice = apply(once, planSplitToggle({ artifactCollapsed: once.a, eventStreamCollapsed: once.e }));
    expect(once).toEqual({ a: true, e: false });
    expect(twice).toEqual(split);
  });

  it("每个动作都有自己的提示文案，三条互不相同，且都说清点下去会发生什么", () => {
    const actions: SplitToggleAction[] = ["collapse-artifact", "expand-artifact", "expand-event-stream"];
    expect(new Set(actions.map((a) => SPLIT_TOGGLE_LABEL[a])).size).toBe(3);
    expect(SPLIT_TOGGLE_LABEL["collapse-artifact"]).toBe("收起产物栏，事件流占满宽度");
    expect(SPLIT_TOGGLE_LABEL["expand-artifact"]).toBe("展开产物栏");
    expect(SPLIT_TOGGLE_LABEL["expand-event-stream"]).toBe("展开事件流");
    expect(Object.isFrozen(SPLIT_TOGGLE_LABEL)).toBe(true);
  });
});

describe("事件流栏可折叠的页面接线（源码契约）", () => {
  const root = process.cwd();
  const page = readFileSync(path.join(root, "src/app/tasks/[id]/page.tsx"), "utf8");
  const panelAt = page.indexOf('id="event-stream"');
  const panel = page.slice(panelAt, panelAt + 2200);

  it("事件流 Panel：collapsible + collapsedSize=0 + panelRef，onResize 回写折叠态；保留像素下限", () => {
    expect(panelAt).toBeGreaterThan(-1);
    expect(panel).toContain("panelRef={eventStreamPanelRef}");
    expect(panel).toContain("collapsible");
    expect(panel).toContain("collapsedSize={0}");
    expect(panel).toContain("setEventStreamCollapsed(collapsed)");
    expect(panel).toContain("minSize={`${EVENT_STREAM_MIN_PX}px`}");
  });

  it("折叠态：内容固定 min-width（不重排）+ inert（退出 Tab 序 / 读屏）+ 内层 overflow 裁掉", () => {
    expect(panel).toContain("style={{ minWidth: EVENT_STREAM_MIN_PX }}");
    expect(panel).toContain("inert={eventStreamCollapsed}");
    expect(panel).toContain('{ overflow: "hidden" }');
  });

  it("折叠态同步给「搜索此栏」路由，卸载时复位；切任务时折叠态复位（新 Group 总是展开着挂）", () => {
    expect(page).toMatch(/setEventStreamPaneCollapsed\(eventStreamCollapsed\)/);
    expect(page).toMatch(/\(\) => setEventStreamPaneCollapsed\(false\)/);
    expect(page).toMatch(/setEventStreamCollapsed\(false\);/);
  });

  it("浏览器面板：X 关闭、放大 = 折叠事件流；放大造成的折叠，关闭 / 切回产物时自动还原，用户自己折叠的不动", () => {
    expect(page).toMatch(/<BrowserPanel[^>]*maximized=\{eventStreamCollapsed\}/);
    expect(page).toMatch(/<BrowserPanel[^>]*onToggleMaximize=\{toggleBrowserMaximize\}/);
    expect(page).toContain("browserMaximizedRef.current = true;");
    // 还原只认「放大造成的」；事件流被重新展开（任何方式）后标记作废
    expect(page).toMatch(/if \(!browserMaximizedRef\.current\) return;/);
    expect(page).toMatch(/if \(!collapsed\) browserMaximizedRef\.current = false;/);
  });
});
