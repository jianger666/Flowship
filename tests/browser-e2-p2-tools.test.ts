/**
 * E2·P2 / A6 无痕标签（server / 渲染侧）：
 *   - browser_tabs 的 incognito 参数：schema、描述（内存 partition / 不共享登录态 / 关闭即销毁）、校验（严格：看不懂的值报错而不是悄悄变成普通标签）、透传、结果文案
 *   - 列表里无痕标签带 [无痕] 标记
 *   - 事件流摘要（browserToolSummary）区分「新建无痕标签页」
 *   - 面板 TabStrip 的无痕徽章：Tooltip 文本纯函数 + 源码约定（Tooltip 而非原生 title、图标 aria-hidden + sr-only 文案、关闭按钮有 aria-label）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INCOGNITO_TAB_HINT, tabTooltipText } from "@/components/browser/browser-status";
import { browserToolSummary } from "@/lib/browser-tool-display";
import { __resetBrowserSettingsForTest } from "@/lib/server/browser/settings";
import { getBrowserTools } from "@/lib/server/browser/tools";
import type { FlowshipToolDef, FlowshipToolResult } from "@/lib/server/flowship-tools";

import { installFakeBrowser, type FakeBrowser } from "./helpers/browser-bridge-fake";

const TASK = "task-1";
let fake: FakeBrowser | null = null;

const tool = (name: string): FlowshipToolDef => {
  const t = getBrowserTools({ taskId: TASK }).find((x) => x.name === name);
  if (!t) throw new Error(`工具 ${name} 未注册`);
  return t;
};
const call = (args: Record<string, unknown>) => tool("browser_tabs").handler(args, "caller-token", { taskId: TASK });
const textOf = (r: FlowshipToolResult): string => r.content.map((c) => (c.type === "text" ? c.text : `<img:${c.mimeType}>`)).join("\n");
const tabsCalls = () => fake!.calls.filter((c) => c.op === "tabs");

beforeEach(() => {
  __resetBrowserSettingsForTest();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  fake?.cleanup();
  fake = null;
  vi.restoreAllMocks();
});

const withBrowser = (handlers: Parameters<typeof installFakeBrowser>[0] = {}) => {
  fake = installFakeBrowser({ status: () => ({ exists: true, pendingCount: 0 }), ...handlers });
  return fake;
};

const TABS_RESULT = {
  tabs: [
    { id: "t1", title: "A", url: "https://a.test/", isActive: false },
    { id: "t2", title: "Login", url: "https://b.test/", isActive: true, incognito: true },
  ],
  activeTabId: "t2",
};

describe("browser_tabs 的 incognito 参数：schema 与描述", () => {
  it("schema 有可选布尔参数 incognito，不在 required 里；参数描述说清楚「内存 partition / 不共享登录态 / 关闭即销毁」", () => {
    withBrowser();
    const params = tool("browser_tabs").parameters as { properties: Record<string, { type?: string; description?: string }>; required?: string[] };
    expect(params.properties.incognito.type).toBe("boolean");
    expect(params.required ?? []).not.toContain("incognito");
    const d = params.properties.incognito.description ?? "";
    expect(d).toContain("内存 partition");
    expect(d).toContain("不共享");
    expect(d).toContain("登录态");
    expect(d).toContain("关闭即销毁");
  });

  it("工具描述提到无痕（内存 partition、不共享登录态、关闭即销毁），且仍不超过 2 句（工具描述精炼约定）", () => {
    withBrowser();
    const desc = tool("browser_tabs").description;
    expect(desc).toContain("incognito");
    expect(desc).toContain("内存 partition");
    expect(desc).toContain("不共享");
    expect(desc).toContain("关闭即销毁");
    expect(desc.split("。").filter((s) => s.trim()).length).toBeLessThanOrEqual(2);
  });
});

describe("browser_tabs new incognito：透传与结果文案", () => {
  it("incognito:true → 发给主进程的 args 带 incognito:true；结果明确说是无痕（独立内存档案 / 不共享登录态 / 关闭即销毁）", async () => {
    withBrowser({ tabs: () => TABS_RESULT });
    const text = textOf(await call({ action: "new", url: "https://b.test/", incognito: true }));
    expect(tabsCalls()[0].args).toEqual({ action: "new", url: "https://b.test/", incognito: true });
    expect(text).toContain("已新建无痕标签页");
    expect(text).toContain("不共享登录态");
    expect(text).toContain("关闭即销毁");
    expect(text).toContain("重新 browser_snapshot");
  });

  it("字符串 'true' 也认（模型常把布尔写成字符串）", async () => {
    withBrowser({ tabs: () => TABS_RESULT });
    await call({ action: "new", incognito: "true" });
    expect(tabsCalls()[0].args).toEqual({ action: "new", incognito: true });
  });

  it("incognito:false / 缺省 / null → args 里没有该键；文案是普通的「已新建标签页」（默认仍是共享持久档案）", async () => {
    withBrowser({ tabs: () => TABS_RESULT });
    for (const args of [{ action: "new" }, { action: "new", incognito: false }, { action: "new", incognito: "false" }, { action: "new", incognito: null }]) {
      const text = textOf(await call(args));
      expect(text, JSON.stringify(args)).toContain("已新建标签页");
      expect(text).not.toContain("无痕标签页（");
    }
    for (const c of tabsCalls()) expect("incognito" in c.args).toBe(false);
  });

  it("列表里无痕标签带 [无痕] 标记，普通标签不带", async () => {
    withBrowser({ tabs: () => TABS_RESULT });
    const text = textOf(await call({ action: "list" }));
    const lines = text.split("\n");
    expect(lines.find((l) => l.startsWith("t2"))).toContain("[无痕]");
    expect(lines.find((l) => l.startsWith("t1"))).not.toContain("[无痕]");
  });
});

describe("browser_tabs incognito 校验（不发请求）", () => {
  it("只能和 new 一起用：list / select / close 带 true → 参数有误", async () => {
    const f = withBrowser({ tabs: () => TABS_RESULT });
    for (const args of [
      { action: "list", incognito: true },
      { action: "select", tab_id: "t1", incognito: true },
      { action: "close", tab_id: "t1", incognito: "true" },
    ]) {
      const r = await call(args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(r)).toContain("参数有误");
      expect(textOf(r)).toContain("action=new");
    }
    expect(f.calls.filter((c) => c.op === "tabs")).toHaveLength(0);
  });

  it("看不懂的值（'yes' / 1 / 对象）→ 参数有误；不能悄悄退化成普通标签（那会让「要无痕」的请求拿到共享登录态的标签）", async () => {
    const f = withBrowser({ tabs: () => TABS_RESULT });
    for (const incognito of ["yes", "1", 1, 0, {}, []]) {
      const r = await call({ action: "new", incognito });
      expect(r.isError, JSON.stringify(incognito)).toBe(true);
      expect(textOf(r)).toContain("参数有误");
      expect(textOf(r)).toContain("布尔值");
    }
    expect(f.calls.filter((c) => c.op === "tabs")).toHaveLength(0);
  });

  it("带 incognito:false 的 list / select 不报错（等于没给）", async () => {
    withBrowser({ tabs: () => TABS_RESULT });
    expect((await call({ action: "list", incognito: false })).isError).toBeUndefined();
    expect((await call({ action: "select", tab_id: "t1", incognito: false })).isError).toBeUndefined();
  });

  it("既有校验不变：select 缺 tab_id / 非法 action", async () => {
    withBrowser({ tabs: () => TABS_RESULT });
    expect((await call({ action: "select" })).isError).toBe(true);
    expect((await call({ action: "explode" })).isError).toBe(true);
  });
});

describe("事件流摘要", () => {
  it("新建无痕标签页单独成文案（用户一眼看出 AI 用了不共享登录态的身份）；带 URL 只显示 host/path", () => {
    expect(browserToolSummary("browser_tabs", '{"action":"new","incognito":true}')).toBe("新建无痕标签页");
    expect(browserToolSummary("browser_tabs", '{"action":"new","url":"https://a.com/x?y=1","incognito":true}')).toBe("新建无痕标签页 a.com/x");
    expect(browserToolSummary("browser_tabs", '{"action":"new","incognito":"true"}')).toBe("新建无痕标签页");
  });

  it("对照：普通新建 / incognito:false / 非 new 动作的摘要不变", () => {
    expect(browserToolSummary("browser_tabs", '{"action":"new","url":"https://a.com/x?y=1"}')).toBe("新建标签页 a.com/x");
    expect(browserToolSummary("browser_tabs", '{"action":"new","incognito":false}')).toBe("新建标签页");
    expect(browserToolSummary("browser_tabs", '{"action":"close","tab_id":"t2"}')).toBe("关闭标签页");
    expect(browserToolSummary("browser_tabs", '{"action":"list"}')).toBe("列出标签页");
  });
});

describe("面板 TabStrip 无痕徽章", () => {
  it("tabTooltipText：非无痕原样；无痕追加说明；基础文本为空时只剩说明", () => {
    expect(tabTooltipText("标题", undefined)).toBe("标题");
    expect(tabTooltipText("标题", false)).toBe("标题");
    expect(tabTooltipText("标题", true)).toBe(`标题（${INCOGNITO_TAB_HINT}）`);
    expect(tabTooltipText("", true)).toBe(INCOGNITO_TAB_HINT);
    expect(INCOGNITO_TAB_HINT).toContain("不共享登录态");
    expect(INCOGNITO_TAB_HINT).toContain("关闭即销毁");
  });

  const panel = readFileSync(path.join(process.cwd(), "src/components/browser/browser-panel.tsx"), "utf8");
  const strip = (() => {
    const start = panel.indexOf("const TabStrip = memo(");
    const end = panel.indexOf("/** 状态条：role=\"status\"", start);
    return panel.slice(start, end);
  })();

  it("TabStrip：无痕 tab 渲染 VenetianMask 徽章（aria-hidden，不是按钮）+ sr-only 文案；Tooltip 文本经 tabTooltipText", () => {
    expect(strip).toContain("tab.incognito");
    expect(strip).toContain("<VenetianMask");
    expect(strip).toMatch(/<VenetianMask[^>]*aria-hidden/);
    expect(strip).toContain('<span className="sr-only">无痕标签页：</span>');
    expect(strip).toContain("tabTooltipText(");
    expect(strip).toContain("clipOneLine(tab.title, TOOLTIP_TEXT_MAX)"); // 既有约定（browser-ui-logic.test.ts）保持
  });

  it("TabStrip 不用原生 title；图标按钮（关闭 / 新建）都有 aria-label", () => {
    expect(strip).not.toMatch(/\btitle=/);
    expect(strip).toContain('aria-label={`关闭标签页 ${tabDisplayTitle(tab)}`}');
    expect(strip).toContain('aria-label="新建标签页"');
  });
});
