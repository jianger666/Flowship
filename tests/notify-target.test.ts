/**
 * N1-12：点收件箱系统通知 → 打开收件箱（原先只聚焦窗口）。
 * 覆盖：壳侧 payload 解析（parseNotifyPayload）+ 页面侧订阅（onNotifyTargetClick）+ 发送侧接线（补充）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseNotifyPayload } from "../electron-app/notify-target.mjs";
import { onNotifyTargetClick } from "@/lib/shell-notify";

describe("parseNotifyPayload（壳侧）", () => {
  it("收件箱通知：无 taskId + target:inbox → 保留 target", () => {
    expect(parseNotifyPayload({ title: "新增 3 条", body: "x", target: "inbox" })).toEqual({
      title: "新增 3 条",
      body: "x",
      taskId: "",
      target: "inbox",
    });
  });

  it("旧用法不变：只带 taskId → 任务通知，没有 target", () => {
    const r = parseNotifyPayload({ title: "t", taskId: "t_1" });
    expect(r.taskId).toBe("t_1");
    expect(r.target).toBe("");
  });

  it("taskId 与 target 同时给：以 taskId 为准（任务语义更具体）", () => {
    const r = parseNotifyPayload({ title: "t", taskId: "t_1", target: "inbox" });
    expect(r.taskId).toBe("t_1");
    expect(r.target).toBe("");
  });

  it("IPC 入参不可信：未知 target / 非字符串 / 非对象一律收敛", () => {
    expect(parseNotifyPayload({ title: "t", target: "settings" }).target).toBe("");
    expect(parseNotifyPayload({ title: "t", target: 1 }).target).toBe("");
    expect(parseNotifyPayload(null)).toEqual({ title: "Flowship", body: "", taskId: "", target: "" });
    expect(parseNotifyPayload("x")).toEqual({ title: "Flowship", body: "", taskId: "", target: "" });
    expect(parseNotifyPayload({ title: "a".repeat(200), body: "b".repeat(500) })).toMatchObject({
      title: "a".repeat(80),
      body: "b".repeat(200),
    });
  });
});

describe("onNotifyTargetClick（页面侧）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("壳回传 inbox → 回调；其它 target 不回调；返回的取消函数会转发给壳", () => {
    let shellCb: ((t: string) => void) | null = null;
    const unsub = vi.fn();
    vi.stubGlobal("window", {
      __notify: {
        send: vi.fn(),
        onNotifyClick: () => () => {},
        onTargetClick: (cb: (t: string) => void) => {
          shellCb = cb;
          return unsub;
        },
      },
    });
    const got: string[] = [];
    const off = onNotifyTargetClick((t) => got.push(t));
    shellCb!("inbox");
    shellCb!("unknown");
    expect(got).toEqual(["inbox"]);
    off();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("旧壳（无 onTargetClick）/ 非桌面端：返回 no-op，不抛", () => {
    vi.stubGlobal("window", {
      __notify: { send: vi.fn(), onNotifyClick: () => () => {} },
    });
    expect(() => onNotifyTargetClick(() => {})()).not.toThrow();
    vi.stubGlobal("window", {});
    expect(() => onNotifyTargetClick(() => {})()).not.toThrow();
  });
});

describe("接线（补充）", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

  it("收件箱通知带 target:inbox；壳点击后 send notify-target-click；preload 暴露 onTargetClick", () => {
    expect(read("src/hooks/use-mr-inbox.tsx")).toMatch(/sendTaskNotification\(\{\s*\.\.\.copy,\s*target:\s*"inbox"/);
    const main = read("electron-app/main.js");
    expect(main).toContain("parseNotifyPayload(payload)");
    expect(main).toContain('"notify-target-click"');
    expect(read("electron-app/preload.cjs")).toContain("notify-target-click");
    expect(read("src/components/mr-inbox/mr-inbox-bell.tsx")).toContain("onNotifyTargetClick");
  });
});
