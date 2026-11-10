/**
 * 内置浏览器「请用户操作」通知决策（纯函数）。
 * 钉住：同一次提问只通知一次；提问结束后下一次提问能再通知；正看着该任务且聚焦时静音但不留陈旧通知；文案截断。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BROWSER_ASK_BODY_MAX, planBrowserAskNotification } from "@/lib/browser-ask-notify";

const ask = (taskId: string, since: number, message = "请登录公司账号") => ({
  taskId,
  askRequest: { message, since },
});
const none = (taskId: string) => ({ taskId, askRequest: null });
const away = { hasFocus: false, activeTaskId: null };

describe("planBrowserAskNotification", () => {
  it("新提问 → 一条 ask 类通知，标题用任务名，带任务 id（点通知能跳过去）", () => {
    const notified = new Map<string, number>();
    const item = planBrowserAskNotification({ state: ask("t1", 100), notified, title: "接手改代码", ...away });
    expect(item).toEqual({
      title: "接手改代码",
      body: "AI 请你在浏览器里操作一下：请登录公司账号",
      taskId: "t1",
      kind: "ask",
    });
  });

  it("同一次提问的重复推送（since 不变）不重复通知", () => {
    const notified = new Map<string, number>();
    expect(planBrowserAskNotification({ state: ask("t1", 100), notified, title: "x", ...away })).not.toBeNull();
    expect(planBrowserAskNotification({ state: ask("t1", 100), notified, title: "x", ...away })).toBeNull();
    expect(planBrowserAskNotification({ state: ask("t1", 100), notified, title: "x", ...away })).toBeNull();
  });

  it("提问结束后再来一次新提问 → 再通知；不同任务互不影响", () => {
    const notified = new Map<string, number>();
    planBrowserAskNotification({ state: ask("t1", 100), notified, title: "x", ...away });
    expect(planBrowserAskNotification({ state: none("t1"), notified, title: "x", ...away })).toBeNull();
    expect(notified.has("t1")).toBe(false);
    expect(planBrowserAskNotification({ state: ask("t1", 200), notified, title: "x", ...away })).not.toBeNull();
    expect(planBrowserAskNotification({ state: ask("t2", 200), notified, title: "y", ...away })).not.toBeNull();
  });

  it("窗口聚焦且正看着这个任务 → 静音，但记下 since：之后切走不补发陈旧通知", () => {
    const notified = new Map<string, number>();
    const watching = { hasFocus: true, activeTaskId: "t1" };
    expect(planBrowserAskNotification({ state: ask("t1", 100), notified, title: "x", ...watching })).toBeNull();
    expect(planBrowserAskNotification({ state: ask("t1", 100), notified, title: "x", ...away })).toBeNull();
  });

  it("聚焦但在看别的任务 / 在后台看着这个任务 → 都要通知", () => {
    const a = planBrowserAskNotification({
      state: ask("t1", 1),
      notified: new Map(),
      title: "x",
      hasFocus: true,
      activeTaskId: "other",
    });
    const b = planBrowserAskNotification({
      state: ask("t1", 1),
      notified: new Map(),
      title: "x",
      hasFocus: false,
      activeTaskId: "t1",
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it("没有任务名回落 Flowship；正文压空白、超长截断；空消息给兜底文案", () => {
    const long = `第一行\n第二行 ${"很长".repeat(100)}`;
    const item = planBrowserAskNotification({
      state: ask("t1", 1, long),
      notified: new Map(),
      title: undefined,
      ...away,
    })!;
    expect(item.title).toBe("Flowship");
    expect(item.body).not.toContain("\n");
    expect(item.body!.endsWith("…")).toBe(true);
    expect(item.body!.length).toBeLessThanOrEqual("AI 请你在浏览器里操作一下：".length + BROWSER_ASK_BODY_MAX + 1);

    const empty = planBrowserAskNotification({
      state: ask("t1", 2, "   "),
      notified: new Map(),
      title: "  ",
      ...away,
    })!;
    expect(empty.title).toBe("Flowship");
    expect(empty.body).toBe("AI 请你在浏览器里操作一下");
  });
});

describe("接线（源码级）", () => {
  const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

  it("BrowserAskWatcher 挂在 providers 里（全局，不依赖用户打开了哪个页面）", () => {
    const s = src("src/components/providers.tsx");
    expect(s).toContain('import { BrowserAskWatcher } from "@/components/browser/browser-ask-watcher"');
    expect(s).toContain("<BrowserAskWatcher />");
  });

  it("watcher 走现有通知通道与节流，且只在有 window.__browser 时订阅", () => {
    const s = src("src/components/browser/browser-ask-watcher.tsx");
    expect(s).toContain("sendTaskNotification");
    expect(s).toContain("applyNotifyThrottle");
    expect(s).toMatch(/window\.__browser/);
    expect(s).toMatch(/if \(!bridge\) return;/);
  });
});
