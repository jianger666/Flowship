/**
 * E2·P10 · C6：标签页上限（`browserMaxTabs` → `config.maxTabs` → `session.maxTabs()`）的补充用例。
 * 已有覆盖不重复：server 侧 `normalizeBrowserMaxTabs` 的 4/5/60/61/小数/字符串/NaN（tests/browser-bridge-settings.test.ts）、
 * `session.maxTabs()` 的 4/61/5.5/60 与 openTab 判上限（tests/browser-e2-infra.test.ts）、预留票占名额（tests/browser-e2-p2-popup-session.test.ts）。
 * 这里补：宿主返回的各种怪值、上限实时调整（getMaxTabs 每次现读）、关闭后可再开、弹窗收养也判上限、错误码与文案、
 * 以及主进程 `onConfig` / server-channel 对 maxTabs 的「只认 5–60 整数、坏值不改」的源码契约（真行为见 scripts/browser-e2e/e2-c6-maxtabs.cjs）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../electron-app/browser/activity-log.mjs";
import { BrowserSession, MAX_TABS } from "../electron-app/browser/session.mjs";
import { normalizeBrowserMaxTabs } from "@/lib/server/browser/settings";

class FakeTab {
  ready = Promise.resolve();
  opener: string | null = null;
  hadRecentGesture = () => true;
  url = "https://example.com/";
  title = "t";
  destroy = vi.fn();
  setInputIgnored = vi.fn(async () => {});
  releaseHeldButtons = vi.fn(async () => {});
  overlaySetActive = vi.fn(async () => {});
  overlayHide = vi.fn(async () => {});
  moveToMain = vi.fn();
  moveToParking = vi.fn();
  setBounds = vi.fn();
  setVisible = vi.fn();
  capturePlaceholder = vi.fn(async () => null);
  navigate = vi.fn(async () => ({ url: this.url, title: this.title, status: 200 }));
  constructor(public id: string) {}
  info(isActive: boolean) {
    return { id: this.id, url: this.url, title: this.title, favicon: null, loading: false, canGoBack: false, canGoForward: false, isActive };
  }
}

const makeSession = (getMaxTabs: () => unknown) => {
  const created: FakeTab[] = [];
  const host = {
    createTab: ({ id }: { id: string }) => {
      const t = new FakeTab(id);
      created.push(t);
      return t;
    },
    getMaxTabs,
    getMainWindow: () => ({}),
    getParkingWindow: () => ({}),
    onChange: vi.fn(),
    emitEvent: vi.fn(),
    emitPicked: vi.fn(),
    startPicker: () => ({ cancel: vi.fn() }),
  };
  const session = new BrowserSession({ taskId: "task-c6", host: host as never, activityLog: createActivityLog() });
  return { session, created };
};

describe("session.maxTabs()：宿主返回怪值一律回 20", () => {
  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["负数", -1],
    ["0", 0],
    ["undefined", undefined],
    ["null", null], // Number(null) === 0
    ["对象", {}],
    ["数组", [30]], // Number([30]) === 30，但整数且在范围内——见下方单独断言
    ["非数字字符串", "many"],
    ["小数", 20.5],
    ["越界 4", 4],
    ["越界 61", 61],
  ])("%s", (label, v) => {
    const got = makeSession(() => v).session.maxTabs();
    // 数组 [30] 会被 Number() 转成 30：宿主层（server 的 normalizeBrowserMaxTabs 与 onConfig）已拦成 number，这里只要求「结果一定在 5–60 或回 20」
    expect(Number.isInteger(got) && got >= 5 && got <= 60, label).toBe(true);
    if (label !== "数组") expect(got, label).toBe(MAX_TABS);
  });

  it("字符串数字会被 Number() 转换（'30' → 30）：但主进程 config 只存整数，这条是 session 的二道防线而不是入口", () => {
    expect(makeSession(() => "30").session.maxTabs()).toBe(30);
  });

  it("边界 5 / 60 合法；server 侧规整与主进程口径一致（同一批值，结果相同）", () => {
    for (const v of [4, 5, 6, 59, 60, 61, 5.5, "30", NaN, null, undefined, 0, -1]) {
      const server = normalizeBrowserMaxTabs(v);
      // 主进程 onConfig 的口径：整数 5–60 才改，否则保持原值；session 的口径：不合法回 20。对「合法 → 原值」这半边必须一致
      const legal = Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 60;
      expect(server === v, String(v)).toBe(legal);
    }
  });
});

describe("上限实时调整 / 关闭后可再开 / 弹窗收养也判上限", () => {
  it("getMaxTabs 每次现读：先 5 再 8 能继续开；下调到 5 不强关已有，但再开被拒", async () => {
    let max = 5;
    const { session } = makeSession(() => max);
    for (let i = 0; i < 5; i++) await session.openTab({ activate: false });
    await expect(session.openTab({ activate: false })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringMatching(/已达上限（5 个）.*browser_tabs close/) });
    max = 8;
    for (let i = 0; i < 3; i++) await session.openTab({ activate: false });
    expect(session.tabs).toHaveLength(8);
    await expect(session.openTab({ activate: false })).rejects.toThrow(/已达上限（8 个）/);
    max = 5;
    expect(session.tabs).toHaveLength(8); // 不强关
    await expect(session.openTab({ activate: false })).rejects.toThrow(/已达上限（5 个）/);
  });

  it("关闭 tab 后名额释放：满额 → close 一个 → 可再开", async () => {
    const { session } = makeSession(() => 5);
    for (let i = 0; i < 5; i++) await session.openTab({ activate: false });
    await expect(session.openTab({ activate: false })).rejects.toThrow(/已达上限/);
    await session.closeTab(session.tabs[session.tabs.length - 1].id);
    expect(session.tabs).toHaveLength(4);
    await session.openTab({ activate: false });
    expect(session.tabs).toHaveLength(5);
  });

  it("被拒的 openTab 不留半个 tab（createTab 没被调用、tabSeq 不前进）", async () => {
    const { session, created } = makeSession(() => 5);
    for (let i = 0; i < 5; i++) await session.openTab({ activate: false });
    const seq = session.tabSeq;
    await expect(session.openTab({ activate: false })).rejects.toThrow();
    expect(created).toHaveLength(5);
    expect(session.tabSeq).toBe(seq);
  });

  it("openPopupTab（弹窗收养）满额同样 BAD_ARGS，不建 tab；腾出名额后能收养", async () => {
    const { session, created } = makeSession(() => 5);
    for (let i = 0; i < 5; i++) await session.openTab({ activate: false });
    const opener = session.tabs[0].id;
    expect(() => session.openPopupTab({ opener, url: "https://example.com/pop", webContents: {} })).toThrow(/已达上限（5 个）/);
    expect(created).toHaveLength(5);
    await session.closeTab(session.tabs[4].id);
    const popup = session.openPopupTab({ opener, url: "https://example.com/pop", webContents: {} });
    expect(popup).toBeTruthy();
    expect(session.tabs).toHaveLength(5);
  });

  it("planPopup：已有 tab + 预留票 ≥ 上限 → 不放行（动态上限同样适用）", async () => {
    let max = 6;
    const { session } = makeSession(() => max);
    for (let i = 0; i < 5; i++) await session.openTab({ activate: false });
    const first = session.planPopup({ url: "https://example.com/a", openerTabId: session.tabs[0].id });
    expect(first).toBeTruthy(); // 5 个 + 0 票 < 6 → 放行，拿到 1 张票（占名额）
    expect(session.planPopup({ url: "https://example.com/b", openerTabId: session.tabs[0].id })).toBeNull(); // 5 + 1 票 = 6 ≥ 6
    max = 7;
    expect(session.planPopup({ url: "https://example.com/c", openerTabId: session.tabs[0].id })).toBeTruthy();
  });
});

describe("主进程 onConfig / server-channel：maxTabs 只认 5–60 整数（源码契约）", () => {
  it("index.mjs 的 onConfig：Number.isInteger 且 5–60 才写入 config.maxTabs（坏值保持原值，不是回 20）", async () => {
    const src = await fs.readFile(path.join(__dirname, "../electron-app/browser/index.mjs"), "utf8");
    expect(src).toMatch(/Number\.isInteger\(cfg\?\.maxTabs\) && cfg\.maxTabs >= 5 && cfg\.maxTabs <= 60\) config\.maxTabs = cfg\.maxTabs/);
    expect(src).toMatch(/getMaxTabs: \(\) => config\.maxTabs/);
  });

  it("server-channel 的 config 消息：同口径，且缺省不带 maxTabs（沿用主进程当前值）", async () => {
    const src = await fs.readFile(path.join(__dirname, "../electron-app/browser/server-channel.mjs"), "utf8");
    expect(src).toMatch(/Number\.isInteger\(msg\.maxTabs\) && msg\.maxTabs >= 5 && msg\.maxTabs <= 60\) cfg\.maxTabs = msg\.maxTabs/);
  });
});
