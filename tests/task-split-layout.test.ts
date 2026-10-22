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

import {
  ARTIFACT_PANEL_MAX_PERCENT,
  EVENT_STREAM_DEFAULT_MIN_PX,
  EVENT_STREAM_MIN_PX,
  isArtifactCollapsedSize,
  isValidArtifactPanelSize,
  resolveArtifactDefaultPercent,
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

  it("极窄容器：事件流不超过 maxSize(80%)，产物栏保底 20%", () => {
    expect(resolveArtifactDefaultPercent({ persisted: undefined, containerWidth: 400 })).toBe(
      100 - 80,
    );
    expect(ARTIFACT_PANEL_MAX_PERCENT).toBe(80);
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
    expect(page.slice(a, page.indexOf(">", page.indexOf("onResize", a)))).toContain('minSize="20%"');
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

  it("折叠入口：头部 chip 行里一颗带 Tooltip + aria-label 的图标按钮，调 panel.expand()/collapse()", () => {
    expect(page).toContain("PanelLeftClose");
    expect(page).toContain("PanelLeftOpen");
    expect(page).toMatch(/artifactPanelRef\.current\?\.expand\(\)/);
    expect(page).toMatch(/artifactPanelRef\.current\?\.collapse\(\)/);
    // R9a-06：label 固定、状态走 aria-expanded（以前 label 随状态变 + aria-pressed，读屏念出自相矛盾的话）
    expect(page).toMatch(/aria-label="产物栏"/);
    expect(page).toMatch(/aria-expanded=\{!artifactCollapsed\}/);
    expect(page).not.toMatch(/aria-pressed=\{artifactCollapsed\}/);
    // 折叠态面板内容 inert：退出 Tab 序与读屏
    expect(page).toMatch(/inert=\{artifactCollapsed\}/);
    // 不用原生 title（规范：提示一律 Tooltip）
    const btnAt = page.indexOf('aria-label="产物栏"');
    expect(page.slice(Math.max(0, btnAt - 600), btnAt + 300)).not.toMatch(/\btitle=/);
  });

  it("持久化只存有效值：折叠时 0 不能覆盖用户上次拖出来的宽度", () => {
    expect(page).toMatch(/isValidArtifactPanelSize\(artifact\)/);
    // 读取侧也走同一个判定，读写不漂移
    expect(page).toMatch(/resolveArtifactDefaultPercent\(\{\s*persisted: task\?\.uiLayout\?\.artifactPanelSize/);
  });
});
