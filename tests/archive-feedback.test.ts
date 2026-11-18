/**
 * 侧栏归档的时序行为（runArchiveWithFeedback）：点了就走、慢才出 loading、成败同 id 就地换结果。
 * 组件没法在 vitest 里 import（jsx:preserve），所以编排抽成了纯函数、依赖（navigate / toast / 回调）全注入，这里直接跑行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runArchiveWithFeedback,
  type ArchiveResultToastOptions,
  type RunArchiveWithFeedbackInput,
} from "@/lib/archive-feedback";
import { ARCHIVE_PENDING_TOAST_DELAY_MS, archiveToastId } from "@/lib/worktree-report";

type ToastCall = {
  kind: "loading" | "success" | "warning" | "error";
  message: string;
  options: { id: string; description?: string } & Partial<ArchiveResultToastOptions>;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
const deferred = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

interface Harness {
  events: string[];
  toasts: ToastCall[];
  navigations: string[];
  undo: { label: string; onClick: () => void };
  archive: Deferred<{ tag: string }>;
  run: (over?: Partial<RunArchiveWithFeedbackInput<{ tag: string }>>) => Promise<void>;
}

const makeHarness = (base?: Partial<RunArchiveWithFeedbackInput<{ tag: string }>>): Harness => {
  const events: string[] = [];
  const toasts: ToastCall[] = [];
  const navigations: string[] = [];
  const undo = { label: "撤销", onClick: () => {} };
  const archive = deferred<{ tag: string }>();
  const record =
    (kind: ToastCall["kind"]) =>
    (message: string, options: ToastCall["options"]): void => {
      toasts.push({ kind, message, options });
      events.push(`toast.${kind}`);
    };
  const run: Harness["run"] = (over) =>
    runArchiveWithFeedback<{ tag: string }>({
      task: { id: "t1", title: "改文案", mode: "task" },
      activeId: "t1",
      willCleanup: true,
      archive: () => archive.promise,
      onArchived: () => void events.push("onArchived"),
      resultToast: () => ({ kind: "success", message: "已归档「改文案」" }),
      undoAction: () => undo,
      onFailed: () => void events.push("onFailed"),
      onSettled: () => void events.push("onSettled"),
      navigate: (to) => {
        navigations.push(to);
        events.push(`navigate:${to}`);
      },
      toast: {
        loading: record("loading"),
        success: record("success"),
        warning: record("warning"),
        error: record("error"),
      },
      ...base,
      ...over,
    });
  return { events, toasts, navigations, undo, archive, run };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("runArchiveWithFeedback：点了就走", () => {
  it("正看着这个任务 → 请求还没回就已经离开（task→排期首页）；请求回来后不再自动跳转", async () => {
    const h = makeHarness();
    const p = h.run();
    // 同步阶段就走了：此时请求还悬着
    expect(h.navigations).toEqual(["/"]);
    h.archive.resolve({ tag: "ok" });
    await p;
    expect(h.navigations).toEqual(["/"]);
  });

  it("chat 任务离开去对话列表", async () => {
    const h = makeHarness();
    const p = h.run({ task: { id: "t1", title: "闲聊", mode: "chat" } });
    expect(h.navigations).toEqual(["/chats"]);
    h.archive.resolve({ tag: "ok" });
    await p;
  });

  it("没在看这个任务（点击那一刻在别处）→ 全程不动路由，即便清理要很久", async () => {
    const h = makeHarness();
    const p = h.run({ activeId: "t2" });
    await vi.advanceTimersByTimeAsync(60_000);
    h.archive.resolve({ tag: "ok" });
    await p;
    expect(h.navigations).toEqual([]);
  });
});

describe("runArchiveWithFeedback：进行中反馈", () => {
  it("慢归档：超过延迟出现 loading（隔离工作区多一句说明），完成后同 id 就地换成结果 + 撤销按钮、loading 的说明不带过来", async () => {
    const h = makeHarness();
    const p = h.run();
    await vi.advanceTimersByTimeAsync(ARCHIVE_PENDING_TOAST_DELAY_MS + 1);
    expect(h.toasts.map((t) => t.kind)).toEqual(["loading"]);
    expect(h.toasts[0].message).toBe("正在归档「改文案」…");
    expect(h.toasts[0].options).toEqual({
      id: archiveToastId("t1"),
      description: "正在停止 agent、清理隔离工作区，可以先去做别的",
    });

    h.archive.resolve({ tag: "ok" });
    await p;
    expect(h.toasts.map((t) => t.kind)).toEqual(["loading", "success"]);
    const result = h.toasts[1];
    expect(result.message).toBe("已归档「改文案」");
    expect(result.options.id).toBe(archiveToastId("t1"));
    // 显式 undefined：sonner 就地更新时按 key 合并，缺省会把 loading 的 description 留下
    expect("description" in result.options && result.options.description === undefined).toBe(true);
    expect(result.options.action).toBe(h.undo);
  });

  it("快归档：延迟内就回来 → 从头到尾没有 loading（不闪），之后计时器也不会补发", async () => {
    const h = makeHarness();
    const p = h.run();
    await vi.advanceTimersByTimeAsync(ARCHIVE_PENDING_TOAST_DELAY_MS - 100);
    h.archive.resolve({ tag: "ok" });
    await p;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.toasts.map((t) => t.kind)).toEqual(["success"]);
  });

  it("非隔离任务的 loading 只有标题行（没有清理说明）", async () => {
    const h = makeHarness();
    const p = h.run({ willCleanup: false });
    await vi.advanceTimersByTimeAsync(ARCHIVE_PENDING_TOAST_DELAY_MS + 1);
    expect(h.toasts[0].options.description).toBeUndefined();
    h.archive.resolve({ tag: "ok" });
    await p;
  });

  it("结果是 warning（保留了目录等）→ 走 toast.warning 而不是 success", async () => {
    const h = makeHarness({ resultToast: () => ({ kind: "warning", message: "已归档，但保留了工作区" }) });
    const p = h.run();
    h.archive.resolve({ tag: "ok" });
    await p;
    expect(h.toasts.map((t) => t.kind)).toEqual(["warning"]);
    expect(h.toasts[0].message).toBe("已归档，但保留了工作区");
  });

  it("成功顺序：先落本地状态（onArchived）再出结果 toast，最后 onSettled；不会走失败回调", async () => {
    const h = makeHarness();
    const p = h.run();
    h.archive.resolve({ tag: "ok" });
    await p;
    expect(h.events).toEqual(["navigate:/", "onArchived", "toast.success", "onSettled"]);
  });

  it("onArchived / resultToast 拿到的就是请求的返回值", async () => {
    const seen: string[] = [];
    const h = makeHarness({
      onArchived: (r) => void seen.push(`archived:${r.tag}`),
      resultToast: (r) => {
        seen.push(`toast:${r.tag}`);
        return { kind: "success", message: "ok" };
      },
    });
    const p = h.run();
    h.archive.resolve({ tag: "R1" });
    await p;
    expect(seen).toEqual(["archived:R1", "toast:R1"]);
  });
});

describe("runArchiveWithFeedback：失败", () => {
  it("请求失败：同 id 的错误 toast 顶替 loading；已离开任务页 → 带「回到任务」，点了才跳；行状态恢复 + 放行各一次", async () => {
    const h = makeHarness();
    const p = h.run();
    await vi.advanceTimersByTimeAsync(ARCHIVE_PENDING_TOAST_DELAY_MS + 1);
    h.archive.reject(new Error("HTTP 500"));
    await p;

    expect(h.toasts.map((t) => t.kind)).toEqual(["loading", "error"]);
    const err = h.toasts[1];
    expect(err.message).toBe("归档失败：HTTP 500");
    expect(err.options.id).toBe(archiveToastId("t1"));
    expect(err.options.description).toBeUndefined();
    expect(err.options.action?.label).toBe("回到任务");
    // 失败本身不自动跳转；用户点了才回去
    expect(h.navigations).toEqual(["/"]);
    err.options.action?.onClick();
    expect(h.navigations).toEqual(["/", "/tasks/t1"]);

    expect(h.events.filter((e) => e === "onFailed")).toHaveLength(1);
    expect(h.events.filter((e) => e === "onSettled")).toHaveLength(1);
    expect(h.events).not.toContain("onArchived");
  });

  it("没离开过任务页（用户在别处）→ 失败 toast 不带「回到任务」", async () => {
    const h = makeHarness();
    const p = h.run({ activeId: "t2" });
    h.archive.reject(new Error("boom"));
    await p;
    expect(h.toasts[0].kind).toBe("error");
    expect(h.toasts[0].options.action).toBeUndefined();
    expect(h.navigations).toEqual([]);
  });

  it("失败后计时器已清：不会晚一步再冒出 loading 盖掉错误", async () => {
    const h = makeHarness();
    const p = h.run();
    h.archive.reject(new Error("fast fail"));
    await p;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.toasts.map((t) => t.kind)).toEqual(["error"]);
  });

  it("落本地状态时抛错也按「归档失败」处理（与重构前 try 块语义一致），不出成功 toast", async () => {
    const h = makeHarness({
      onArchived: () => {
        throw new Error("upsert 炸了");
      },
    });
    const p = h.run();
    h.archive.resolve({ tag: "ok" });
    await p;
    expect(h.toasts.map((t) => t.kind)).toEqual(["error"]);
    expect(h.toasts[0].message).toBe("归档失败：upsert 炸了");
    expect(h.events).toContain("onFailed");
    expect(h.events.filter((e) => e === "onSettled")).toHaveLength(1);
  });
});
