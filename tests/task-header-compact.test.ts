/**
 * task 详情页头部「浏览器紧凑态」：
 *  ① 纯逻辑：什么时候紧凑 / 展开态怎么存（脏值、storage 抛错都回到默认「收起」）；
 *  ② 页面接线契约（page.tsx 是 1800 行的客户端页面，没法 SSR 整页，只能守源码文本）：
 *     - 收起 = `hidden`（display:none），**不卸载**——改动面板 / 批次进度的状态与已拉的数据展开后还在；
 *     - 判定吃 `browserPaneOpen`（浏览器真的看得见），不是裸的 `leftTab`——产物栏折叠、事件流占满时头部照常完整；
 *     - 分栏按钮 JSX 只定义一处：左栏在浏览器标签时固定在标题行（与紧凑与否、产物栏是否折叠无关，R15-21），
 *       在产物标签时在 chip 行，任何模式下都有入口还原事件流；
 *     - 预览胶囊紧凑态也要可见（R15-03）：WorkspaceActions 挂在 hidden 容器外面，由 compact 让它自己只留有预览的仓；
 *     - 「任务详情」展开钮只在浏览器可见时出现，读屏名固定 + aria-expanded，点击会落盘；
 *     - 提测提醒横幅是告警，紧凑态也不能被收起。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  TASK_HEADER_DETAILS_IN_BROWSER_KEY,
  isTaskHeaderCompact,
  readTaskHeaderDetailsOpen,
  writeTaskHeaderDetailsOpen,
} from "@/lib/task-header-compact";

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
};

describe("isTaskHeaderCompact：只有浏览器看得见、且用户没点展开时才紧凑", () => {
  it.each<[string, boolean, boolean, boolean]>([
    // [说明, browserPaneOpen, detailsOpen, 期望紧凑]
    ["浏览器可见、默认（没展开）", true, false, true],
    ["浏览器可见、用户点了展开", true, true, false],
    ["浏览器不可见（产物标签 / 产物栏折叠），没展开：头部完整", false, false, false],
    ["浏览器不可见，展开态是上次记下的：头部仍然完整（展开态只在浏览器可见时才有意义）", false, true, false],
  ])("%s", (_name, browserPaneOpen, detailsOpen, expected) => {
    expect(isTaskHeaderCompact({ browserPaneOpen, detailsOpen })).toBe(expected);
  });
});

describe("展开态的读写：只认精确的 \"1\"，任何异常回到默认「收起」", () => {
  it("没有记录 → 收起（默认给浏览器最大空间）", () => {
    expect(readTaskHeaderDetailsOpen(memoryStorage())).toBe(false);
  });

  it("写 true 再读 true，写 false 再读 false；落在固定的 key 上", () => {
    const s = memoryStorage();
    expect(writeTaskHeaderDetailsOpen(true, s)).toBe(true);
    expect(s.data.get(TASK_HEADER_DETAILS_IN_BROWSER_KEY)).toBe("1");
    expect(readTaskHeaderDetailsOpen(s)).toBe(true);
    expect(writeTaskHeaderDetailsOpen(false, s)).toBe(true);
    expect(s.data.get(TASK_HEADER_DETAILS_IN_BROWSER_KEY)).toBe("0");
    expect(readTaskHeaderDetailsOpen(s)).toBe(false);
  });

  it.each(["", "0", "true", "yes", "11", " 1", "1 ", "null", "undefined", "{}"])("脏值 %j → 收起", (raw) => {
    expect(readTaskHeaderDetailsOpen(memoryStorage({ [TASK_HEADER_DETAILS_IN_BROWSER_KEY]: raw }))).toBe(false);
  });

  it("storage 为 null（SSR / 隐私模式禁用 localStorage）：读 → 收起，写 → false，都不抛", () => {
    expect(readTaskHeaderDetailsOpen(null)).toBe(false);
    expect(writeTaskHeaderDetailsOpen(true, null)).toBe(false);
  });

  it("storage 读 / 写抛错：读 → 收起，写 → false，都不抛", () => {
    const boom = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(readTaskHeaderDetailsOpen(boom)).toBe(false);
    expect(writeTaskHeaderDetailsOpen(true, boom)).toBe(false);
  });

  it("key 带 flowship. 前缀（与其它本机记忆同一命名空间）", () => {
    expect(TASK_HEADER_DETAILS_IN_BROWSER_KEY.startsWith("flowship.")).toBe(true);
  });
});

describe("页面接线契约（task 详情页头部）", () => {
  const repoDir = path.resolve(import.meta.dirname, "..");
  const page = readFileSync(path.join(repoDir, "src/app/tasks/[id]/page.tsx"), "utf-8");
  /** 去掉 JSX 注释与行注释：断言「代码」而不是被注释里的字样骗过 */
  const code = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("判定吃 browserPaneOpen（浏览器真的看得见），不是裸的 leftTab：产物栏折叠时头部照常完整", () => {
    expect(code).toMatch(/isTaskHeaderCompact\(\{\s*browserPaneOpen,\s*detailsOpen: headerDetailsOpen\s*\}\)/);
    expect(code).toMatch(/const browserPaneOpen = leftTab === "browser" && !artifactCollapsed;/);
    // 展开态的初值读本机记忆（惰性初始值），不是写死 false
    expect(code).toMatch(/useState\(readTaskHeaderDetailsOpen\)/);
  });

  it("MR 链接收进 hidden 容器；WorkspaceActions 在容器外、吃 compact（预览胶囊紧凑态也要可见），且仍紧跟 TaskMrLinks", () => {
    expect(code).toMatch(
      /<WorkspaceActions task=\{task\} compact=\{headerCompact\} \/>\s*<div className=\{cn\(headerCompact && "hidden"\)\}>\s*<TaskMrLinks\b/,
    );
    // WorkspaceActions 自己不能被 headerCompact 的 hidden 容器包住（否则预览的停止 / 重启 / 日志在浏览器可见时找不到）
    const wsAt = code.indexOf("<WorkspaceActions");
    const before = code.slice(Math.max(0, wsAt - 200), wsAt).replace(/\s+/g, " ");
    expect(before).not.toMatch(/headerCompact && "hidden"\)\}> *$/);
  });

  it("辅助入口 chip 行用 hidden 收起、保留 mt-3 / flex-wrap 原样，并且仍是同一行里挂着改动 / 批次 / MCP / 需求群入口", () => {
    const rowAt = code.indexOf('className={cn("mt-3 flex flex-wrap items-center gap-2", headerCompact && "hidden")}');
    expect(rowAt).toBeGreaterThan(-1);
    const rowEnd = code.indexOf("<MrInboxTaskBanner", rowAt);
    expect(rowEnd).toBeGreaterThan(rowAt);
    const row = code.slice(rowAt, rowEnd);
    for (const c of ["<ContextDocsPanel", "<TaskMcpPanel", "<BatchProgress", "<TaskChangesPanel", "<BrowserToggleButton", "<TaskUtilityActions"]) {
      expect(row, c).toContain(c);
    }
  });

  it("收起是 hidden 而不是卸载：这些组件都不在 headerCompact 条件渲染里（卸载会丢改动面板 / 批次进度的状态，展开时重新请求）", () => {
    expect(code).not.toMatch(
      /headerCompact\s*(?:&&|\?)\s*\(?\s*<(WorkspaceActions|TaskMrLinks|TaskChangesPanel|BatchProgress|ContextDocsPanel|TaskMcpPanel|TaskUtilityActions|BrowserToggleButton)\b/,
    );
    expect(code).not.toMatch(/!headerCompact\s*&&\s*\(?\s*<(WorkspaceActions|TaskMrLinks|TaskChangesPanel|BatchProgress|ContextDocsPanel|TaskMcpPanel|TaskUtilityActions|BrowserToggleButton)\b/);
  });

  it("分栏按钮：JSX 只定义一处；左栏在浏览器标签时在标题行、在产物标签时在 chip 行——位置只跟 leftTab 走，不跟 headerCompact 走", () => {
    expect(code.match(/const splitToggleButton = \(/g)).toHaveLength(1);
    expect(code.match(/onClick=\{toggleSplitLayout\}/g)).toHaveLength(1);
    // 浏览器标签：标题行右侧
    expect(code).toMatch(/\{leftTab === "browser" && splitToggleButton\}/);
    // 产物标签：chip 行最右（ml-auto）
    expect(code).toMatch(/\{leftTab !== "browser" && <span className="ml-auto">\{splitToggleButton\}<\/span>\}/);
    // 两处互斥（=== / !==）、合起来覆盖全部状态；除定义外只有这两处引用，没有第三处
    expect(code.match(/\bsplitToggleButton\b/g)).toHaveLength(3); // 定义 1 + 浏览器标签引用 1 + 产物标签引用 1
    expect(code.match(/\{splitToggleButton\}/g)).toHaveLength(1);
    // 不再按 headerCompact 换位置：折叠产物栏会让 headerCompact 翻回 false，按钮跟着换位 = 用户刚点的按钮在眼前消失、焦点丢失
    expect(code).not.toMatch(/headerCompact && splitToggleButton/);
    expect(code).not.toMatch(/!headerCompact && <span className="ml-auto">/);
  });

  it("「任务详情」展开钮：只在浏览器可见时出现；读屏名固定 + aria-expanded；点击走 toggleHeaderDetails 并落盘", () => {
    const at = code.indexOf('aria-label="任务详情"');
    expect(at).toBeGreaterThan(-1);
    // 在 browserPaneOpen 条件里
    const before = code.slice(Math.max(0, at - 900), at);
    expect(before).toMatch(/\{browserPaneOpen && \(/);
    const btn = code.slice(Math.max(0, at - 300), at + 400);
    expect(btn).toContain("onClick={toggleHeaderDetails}");
    expect(btn).toContain("aria-expanded={!headerCompact}");
    // 不用原生 title（项目规范：提示一律 Tooltip）
    expect(btn).not.toMatch(/\btitle=/);
    // 点击会写回本机记忆
    expect(code).toMatch(/const toggleHeaderDetails = useCallback\(\(\) => \{\s*const next = !headerDetailsOpen;\s*setHeaderDetailsOpen\(next\);\s*writeTaskHeaderDetailsOpen\(next\);\s*\}, \[headerDetailsOpen\]\);/);
  });

  it("标题行本身（返回 / 标题 / 状态徽标 / 推进 / 停止 / 恢复）不受紧凑态影响", () => {
    for (const s of ["回工作台", "{task.title}", "REPO_STATUS_LABEL[task.repoStatus]", "推进", "isStopButtonVisible(task)", "恢复"]) {
      expect(code, s).toContain(s);
    }
    // 它们都在 chip 行（hidden 容器）之前：精确锚定 chip 行自己的 className，不是更靠前的「仓库 / 分支」hidden 包裹层
    const rowAt = code.indexOf('className={cn("mt-3 flex flex-wrap items-center gap-2", headerCompact && "hidden")}');
    expect(rowAt).toBeGreaterThan(-1);
    expect(code.indexOf("setAdvanceDialogOpen(true)")).toBeLessThan(rowAt);
    // 标题行右侧的「任务详情」展开钮也在 chip 行之前（紧凑态它是头部唯一可见的一行）
    expect(code.indexOf('aria-label="任务详情"')).toBeLessThan(rowAt);
  });

  it("提测提醒横幅是告警：在 hidden 的 chip 行**之外**（紧接 chip 行闭合标签之后），也没有被 headerCompact 条件包着", () => {
    const banner = code.indexOf("<MrInboxTaskBanner");
    expect(banner).toBeGreaterThan(-1);
    const rowAt = code.indexOf('className={cn("mt-3 flex flex-wrap items-center gap-2", headerCompact && "hidden")}');
    expect(banner).toBeGreaterThan(rowAt);
    const between = code.slice(rowAt, banner);
    // chip 行以紧贴横幅之前的 </div> 闭合（横幅是它的兄弟，不是子节点）
    expect(between).toMatch(/<\/div>\s*$/);
    // 横幅自己前面没有 headerCompact 条件渲染（&& / 三元）
    expect(between.replace(/\s+/g, " ")).not.toMatch(/headerCompact\s*(?:&&|\?)\s*\(?\s*$/);
  });

  it("顶部条的上下留白紧凑态收小（py-2），其余照旧（py-3）", () => {
    expect(code).toContain('className={cn("shrink-0 px-6", headerCompact ? "py-2" : "py-3")}');
  });
});
