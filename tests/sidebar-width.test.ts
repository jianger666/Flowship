/**
 * 全局侧栏可拖动 / 可收起（图1 / 图2 左侧列表）：宽度规则的纯函数 + 接线契约。
 *
 * 纯函数部分钉死口径（夹取、拖动收起阈值、键盘、持久化）；真窗口里的拖动手感没有在这里验证（需要界面），
 * 接线部分只守「AppShell 持宽度并渲染手柄、AppSidebar 受控宽度、拖动时关过渡」这几条不被改回去。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  SIDEBAR_COLLAPSE_BELOW,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_KEY_STEP,
  SIDEBAR_MAIN_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_KEY,
  __resetSidebarWidthStoreForTests,
  clampSidebarWidth,
  getSidebarWidthServerSnapshot,
  getSidebarWidthSnapshot,
  maxSidebarWidth,
  readSidebarWidth,
  resolveSidebarDrag,
  resolveSidebarKey,
  resolveStoredSidebarWidth,
  setSidebarWidth,
  subscribeSidebarWidth,
  writeSidebarWidth,
} from "@/lib/sidebar-width";

const memStorage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    raw: m,
  };
};

describe("常量口径", () => {
  it("默认宽度仍是原来的 256px（不改老用户的初始观感）", () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(256);
  });

  it("MIN < 默认 < MAX；收起阈值低于 MIN（MIN 与阈值之间是夹住的缓冲带，不是卡死）", () => {
    expect(SIDEBAR_MIN_WIDTH).toBeLessThan(SIDEBAR_DEFAULT_WIDTH);
    expect(SIDEBAR_DEFAULT_WIDTH).toBeLessThan(SIDEBAR_MAX_WIDTH);
    expect(SIDEBAR_COLLAPSE_BELOW).toBeLessThan(SIDEBAR_MIN_WIDTH);
  });

  it("最小窗口 960 下侧栏最宽 320：主区保底 640，放得下任务页「产物 300 + 事件流 320」", () => {
    expect(maxSidebarWidth(960)).toBe(960 - SIDEBAR_MAIN_MIN_WIDTH);
    expect(maxSidebarWidth(960)).toBe(320);
    expect(SIDEBAR_MAIN_MIN_WIDTH).toBeGreaterThanOrEqual(300 + 320);
  });
});

describe("maxSidebarWidth / clampSidebarWidth", () => {
  it("大窗口封顶 MAX；窗口很窄也不低于 MIN；量不到容器宽度只看 MAX", () => {
    expect(maxSidebarWidth(2560)).toBe(SIDEBAR_MAX_WIDTH);
    expect(maxSidebarWidth(700)).toBe(SIDEBAR_MIN_WIDTH);
    for (const w of [null, undefined, 0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(maxSidebarWidth(w as number | null | undefined), String(w)).toBe(SIDEBAR_MAX_WIDTH);
    }
  });

  it("夹进 [MIN, 当前最大] 并取整", () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(300.6)).toBe(301);
    expect(clampSidebarWidth(400, 960)).toBe(320);
    expect(clampSidebarWidth(250, 960)).toBe(250);
  });

  it("不是有限数 → 默认宽度（再按范围夹）", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "300", null, undefined, {}]) {
      expect(clampSidebarWidth(bad), String(bad)).toBe(SIDEBAR_DEFAULT_WIDTH);
    }
  });
});

describe("resolveSidebarDrag：分隔条拖到哪儿，侧栏就是什么状态", () => {
  it("拖到收起阈值以左 → 收起、不改宽度（再展开回到上次宽度）", () => {
    expect(resolveSidebarDrag(0)).toEqual({ open: false, width: null });
    expect(resolveSidebarDrag(SIDEBAR_COLLAPSE_BELOW - 1)).toEqual({ open: false, width: null });
    expect(resolveSidebarDrag(Number.NaN)).toEqual({ open: false, width: null });
  });

  it("阈值到 MIN 之间 → 展开并夹到 MIN（缓冲带，抖一下不会反复开合）", () => {
    expect(resolveSidebarDrag(SIDEBAR_COLLAPSE_BELOW)).toEqual({ open: true, width: SIDEBAR_MIN_WIDTH });
    expect(resolveSidebarDrag(SIDEBAR_MIN_WIDTH - 1)).toEqual({ open: true, width: SIDEBAR_MIN_WIDTH });
  });

  it("正常范围里跟手；超过最大夹住；窄窗口按容器宽度夹", () => {
    expect(resolveSidebarDrag(300)).toEqual({ open: true, width: 300 });
    expect(resolveSidebarDrag(5000)).toEqual({ open: true, width: SIDEBAR_MAX_WIDTH });
    expect(resolveSidebarDrag(500, 960)).toEqual({ open: true, width: 320 });
  });

  it("从收起态拖出来：越过阈值就展开（收起态与展开态用同一条规则）", () => {
    expect(resolveSidebarDrag(60).open).toBe(false);
    expect(resolveSidebarDrag(200).open).toBe(true);
  });
});

describe("resolveSidebarKey：分隔条聚焦时的键盘操作", () => {
  const open = { open: true, width: 256 };
  const closed = { open: false, width: 256 };

  it("← / → 按步长调整", () => {
    expect(resolveSidebarKey("ArrowLeft", open)).toEqual({ open: true, width: 256 - SIDEBAR_KEY_STEP });
    expect(resolveSidebarKey("ArrowRight", open)).toEqual({ open: true, width: 256 + SIDEBAR_KEY_STEP });
  });

  it("方向键不会把侧栏调到收起：到 MIN 就停（收起走 Enter / 拖动 / 按钮）", () => {
    expect(resolveSidebarKey("ArrowLeft", { open: true, width: SIDEBAR_MIN_WIDTH })).toEqual({
      open: true,
      width: SIDEBAR_MIN_WIDTH,
    });
    expect(resolveSidebarKey("ArrowRight", { open: true, width: SIDEBAR_MAX_WIDTH })).toEqual({
      open: true,
      width: SIDEBAR_MAX_WIDTH,
    });
  });

  it("收起态：→ 展开回上次宽度；← 不处理（不吞按键）", () => {
    expect(resolveSidebarKey("ArrowRight", closed)).toEqual({ open: true, width: 256 });
    expect(resolveSidebarKey("ArrowLeft", closed)).toBeNull();
  });

  it("Home / End 到最小 / 最大（最大随窗口宽度）", () => {
    expect(resolveSidebarKey("Home", open)).toEqual({ open: true, width: SIDEBAR_MIN_WIDTH });
    expect(resolveSidebarKey("End", open)).toEqual({ open: true, width: SIDEBAR_MAX_WIDTH });
    expect(resolveSidebarKey("End", open, 960)).toEqual({ open: true, width: 320 });
  });

  it("Enter 切换开合、不改宽度", () => {
    expect(resolveSidebarKey("Enter", open)).toEqual({ open: false, width: null });
    expect(resolveSidebarKey("Enter", closed)).toEqual({ open: true, width: null });
  });

  it("其它键不处理（调用方据此决定要不要 preventDefault）", () => {
    for (const k of ["a", "Tab", "Escape", " ", "ArrowUp", "ArrowDown"]) {
      expect(resolveSidebarKey(k, open), k).toBeNull();
    }
  });
});

describe("持久化", () => {
  it("存的值有效就用（夹进范围）；缺失 / 非法 → 默认", () => {
    expect(resolveStoredSidebarWidth("300")).toBe(300);
    expect(resolveStoredSidebarWidth(320)).toBe(320);
    expect(resolveStoredSidebarWidth("99999")).toBe(SIDEBAR_MAX_WIDTH);
    expect(resolveStoredSidebarWidth("10")).toBe(SIDEBAR_MIN_WIDTH);
    for (const bad of [null, undefined, "", "abc", "NaN", Number.NaN]) {
      expect(resolveStoredSidebarWidth(bad), String(bad)).toBe(SIDEBAR_DEFAULT_WIDTH);
    }
  });

  it("读写回环；没有 storage / storage 抛错都不炸", () => {
    const s = memStorage();
    expect(readSidebarWidth(s)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(writeSidebarWidth(310, s)).toBe(true);
    expect(s.raw.get(SIDEBAR_WIDTH_KEY)).toBe("310");
    expect(readSidebarWidth(s)).toBe(310);
    expect(writeSidebarWidth(Number.NaN, s)).toBe(false);
    expect(readSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readSidebarWidth(broken)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(writeSidebarWidth(300, broken)).toBe(false);
  });
});

describe("运行期 store（useSyncExternalStore 用）", () => {
  beforeEach(() => __resetSidebarWidthStoreForTests());

  it("服务端快照恒为默认宽度（hydration 阶段不依赖 localStorage）", () => {
    expect(getSidebarWidthServerSnapshot()).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("setSidebarWidth 夹取后通知订阅者；相同值不重复通知；取消订阅后不再通知", () => {
    let calls = 0;
    const off = subscribeSidebarWidth(() => {
      calls += 1;
    });
    setSidebarWidth(300, { persist: false });
    expect(getSidebarWidthSnapshot()).toBe(300);
    expect(calls).toBe(1);
    setSidebarWidth(300, { persist: false });
    expect(calls).toBe(1);
    setSidebarWidth(99999, { persist: false });
    expect(getSidebarWidthSnapshot()).toBe(SIDEBAR_MAX_WIDTH);
    expect(calls).toBe(2);
    off();
    setSidebarWidth(260, { persist: false });
    expect(calls).toBe(2);
  });
});

describe("接线契约（源码）", () => {
  const root = process.cwd();
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const shell = strip(read("src/components/app-shell.tsx"));
  const sidebar = strip(read("src/components/app-sidebar.tsx"));
  const handle = strip(read("src/components/sidebar-resize-handle.tsx"));

  it("AppShell：宽度走 useSyncExternalStore（SSR 默认值，免 hydration 不一致），有效宽度按视口夹取，手柄夹在侧栏与主区之间", () => {
    expect(shell).toContain("getSidebarWidthServerSnapshot");
    expect(shell).toMatch(/clampSidebarWidth\(storedSidebarWidth, viewportWidth\)/);
    const iSidebar = shell.indexOf("<AppSidebar");
    const iHandle = shell.indexOf("<SidebarResizeHandle");
    const iMain = shell.indexOf("<main");
    expect(iSidebar).toBeGreaterThan(-1);
    expect(iHandle).toBeGreaterThan(iSidebar);
    expect(iMain).toBeGreaterThan(iHandle);
  });

  it("AppShell：拖动中不写盘（persist:false），结束（resizing=false）才写一次；双击复位默认宽度并展开", () => {
    expect(shell).toContain("setSidebarWidth(next.width, { persist: false })");
    expect(shell).toMatch(/if \(!resizing\) setSidebarWidth\(getSidebarWidthSnapshot\(\)\)/);
    expect(shell).toMatch(/setSidebarWidth\(SIDEBAR_DEFAULT_WIDTH\);\s*setSidebarOpen\(true\)/);
  });

  it("AppSidebar：宽度受控（不再写死 w-64），拖动时关掉宽度过渡", () => {
    expect(sidebar).not.toContain('"w-64"');
    expect(sidebar).toMatch(/style=\{\{ width: open \? width : 0 \}\}/);
    expect(sidebar).toMatch(/!resizing && "transition-\[width\]/);
  });

  it("收起 / 展开侧栏只有一个入口：顶栏固定位置的开关，图标随状态变；侧栏里不再有第二个「收起」按钮（用户反馈：收起后找不到展开在哪）", () => {
    // 侧栏里没有收起按钮、AppShell 也不再传 onCollapse
    expect(sidebar).not.toContain("onCollapse");
    expect(sidebar).not.toContain('aria-label="收起侧栏"');
    expect(sidebar).not.toContain("PanelLeftClose");
    expect(shell).not.toContain("onCollapse");
    expect(shell).not.toContain("collapseSidebar");
    // 顶栏开关：展开时「收起」图标、收起后「展开」图标，文案与 aria 同步；⌘B / Ctrl+B 仍走同一个 toggleSidebar
    const header = strip(read("src/components/app-header.tsx"));
    expect(header).toContain("{sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}");
    expect(header).toContain('aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}');
    expect(header.match(/onClick=\{onToggleSidebar\}/g)).toHaveLength(1);
    expect(shell).toContain("onToggleSidebar={toggleSidebar}");
    expect(shell).toContain("createModHotkeyHandler(isSidebarToggleCombo, toggleSidebar)");
  });

  it("手柄：ARIA separator + 可聚焦、双击复位、拖动期间锁全局光标与选区、只认主键", () => {
    expect(handle).toContain('role="separator"');
    expect(handle).toContain('aria-orientation="vertical"');
    expect(handle).toContain("tabIndex={0}");
    expect(handle).toContain("onDoubleClick={onReset}");
    expect(handle).toContain('document.body.style.cursor = "col-resize"');
    expect(handle).toContain("e.button !== 0");
    expect(handle).toContain("setPointerCapture");
  });
});
