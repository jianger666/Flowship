/**
 * 「塞进输入框」的桥 + 分支切换事件（都是模块级纯逻辑，不依赖 DOM 渲染）
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendToDraft,
  insertIntoComposer,
  registerComposerInsert,
} from "@/lib/composer-insert-bridge";
import { dispatchGitBranchChanged, onGitBranchChanged } from "@/lib/changes/events";

describe("composer 桥", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it("按 taskId 投递；没有接收者返回 false（调用方据此提示用户）", () => {
    const got: string[] = [];
    cleanups.push(registerComposerInsert("t1", (t) => got.push(t)));
    expect(insertIntoComposer("t1", "hello")).toBe(true);
    expect(got).toEqual(["hello"]);
    expect(insertIntoComposer("other", "x")).toBe(false);
  });

  it("注销后不再接收；重复注册以后者为准，旧的注销不误伤新的", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = registerComposerInsert("t2", a);
    const offB = registerComposerInsert("t2", b);
    cleanups.push(offB);
    insertIntoComposer("t2", "1");
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith("1");

    offA(); // 旧的注销：不能把后来者也清掉
    expect(insertIntoComposer("t2", "2")).toBe(true);
    expect(b).toHaveBeenCalledTimes(2);

    offB();
    expect(insertIntoComposer("t2", "3")).toBe(false);
  });
});

describe("appendToDraft", () => {
  it("草稿空：就是片段（末尾留空行好接着写）；草稿非空：隔一个空行接在后面", () => {
    expect(appendToDraft("", "引用")).toBe("引用\n\n");
    expect(appendToDraft("   \n", "引用")).toBe("引用\n\n");
    expect(appendToDraft("先看这个", "引用")).toBe("先看这个\n\n引用\n\n");
    expect(appendToDraft("先看这个\n\n\n", "引用\n\n")).toBe("先看这个\n\n引用\n\n");
  });

  it("片段为空：草稿原样不动", () => {
    expect(appendToDraft("草稿", "")).toBe("草稿");
    expect(appendToDraft("草稿", " \n ")).toBe("草稿");
  });
});

describe("分支切换事件", () => {
  it("只通知同一个任务的订阅者；取消订阅后不再触发", () => {
    const listeners = new Map<string, Set<(e: Event) => void>>();
    const fakeWindow = {
      addEventListener: (type: string, fn: (e: Event) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(fn);
      },
      removeEventListener: (type: string, fn: (e: Event) => void) => {
        listeners.get(type)?.delete(fn);
      },
      dispatchEvent: (e: Event) => {
        for (const fn of listeners.get(e.type) ?? []) fn(e);
        return true;
      },
    };
    class FakeCustomEvent extends Event {
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        super(type);
        this.detail = init?.detail;
      }
    }
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("CustomEvent", FakeCustomEvent);
    try {
      const a = vi.fn();
      const b = vi.fn();
      const offA = onGitBranchChanged("task-a", a);
      const offB = onGitBranchChanged("task-b", b);
      dispatchGitBranchChanged("task-a");
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();

      offA();
      dispatchGitBranchChanged("task-a");
      expect(a).toHaveBeenCalledTimes(1);
      offB();
      expect(listeners.get("flowship:git-branch-changed")?.size ?? 0).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("没有 window（SSR）：派发 / 订阅都是空操作、不抛", () => {
    // node 环境本来就没有 window
    expect(() => dispatchGitBranchChanged("x")).not.toThrow();
    const off = onGitBranchChanged("x", () => {});
    expect(() => off()).not.toThrow();
  });
});
