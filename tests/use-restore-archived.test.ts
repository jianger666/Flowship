/**
 * 详情页「恢复归档」动作的行为（R14 B6-3 / Q3-03）：src/hooks/use-restore-archived.ts。
 *
 * 口径同会话页 handleOpen 的恢复分支：先标记「恢复中」（旧快照不得盖回去）→ PATCH archived:false →
 * 服务端返回的任务塞回列表与详情页 → 置顶任务把手动序接回 → 提示取服务端回报；失败只弹错、放闸、可重试；双击只发一次。
 *
 * 仓里没有 jsdom：用 tests/helpers/react-hook-stub.ts 的槽位桩真跑 hook（useState / useRef / useCallback 都是真读写），
 * 列表 / 请求 / toast / 本地存储用 mock 顶替，用一条事件日志验顺序。
 * 「按钮点下去之后画面怎么变」只有真机能看——这里测的是决策与顺序。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";
import { buildRestoreToast } from "@/lib/worktree-report";

import { deferred } from "./helpers/deferred";
import { createHookHarness } from "./helpers/react-hook-stub";

const h = vi.hoisted(() => ({
  upsertTask: vi.fn(),
  markArchiving: vi.fn(),
  unmarkArchiving: vi.fn(),
  patch: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  loadOrder: vi.fn(),
  saveOrder: vi.fn(),
  events: [] as string[],
}));

vi.mock("@/hooks/use-task-list", () => ({
  useTaskList: () => ({
    upsertTask: h.upsertTask,
    markArchiving: h.markArchiving,
    unmarkArchiving: h.unmarkArchiving,
  }),
}));
vi.mock("@/lib/task-store", () => ({ setTaskArchivedWithReport: h.patch }));
vi.mock("sonner", () => ({ toast: { success: h.success, error: h.error } }));
vi.mock("@/lib/view-memory", () => ({
  loadSidebarPinnedOrder: h.loadOrder,
  saveSidebarPinnedOrder: h.saveOrder,
}));

import { useRestoreArchived } from "@/hooks/use-restore-archived";

beforeEach(() => {
  h.events.length = 0;
  h.upsertTask.mockReset().mockImplementation(() => {
    h.events.push("upsert");
  });
  h.markArchiving.mockReset().mockImplementation((id: string, expected: boolean) => {
    h.events.push(`mark(${id},${expected})`);
  });
  h.unmarkArchiving.mockReset().mockImplementation((id: string) => {
    h.events.push(`unmark(${id})`);
  });
  h.patch.mockReset().mockImplementation(async () => {
    h.events.push("patch");
    throw new Error("没设置 patch 的返回值");
  });
  h.success.mockReset().mockImplementation(() => {
    h.events.push("toast.success");
  });
  h.error.mockReset().mockImplementation(() => {
    h.events.push("toast.error");
  });
  h.loadOrder.mockReset().mockReturnValue([]);
  h.saveOrder.mockReset().mockImplementation(() => {
    h.events.push("saveOrder");
  });
});

const asTask = (over: Partial<Task> = {}): Task =>
  ({ id: "t1", title: "旧会话", ...over }) as unknown as Task;

const mount = (task: { id: string; title: string; pinned?: boolean } = { id: "t1", title: "旧会话" }) => {
  const harness = createHookHarness();
  const onRestored = vi.fn<(updated: Task) => void>(() => {
    h.events.push("restored");
  });
  const render = () => harness.render(() => useRestoreArchived(task, onRestored));
  return { harness, onRestored, render };
};

/** 让 patch 这一次成功地返回 updated + report */
const patchOk = (updated: Task, report?: unknown) => {
  h.patch.mockImplementationOnce(async () => {
    h.events.push("patch");
    return { task: updated, report };
  });
};

describe("成功路径", () => {
  it("顺序：先标记恢复中 → PATCH → 塞回列表 → 塞回详情页 → 提示 → 放标记；PATCH 只发一次，参数是 (id, false)", async () => {
    const { render, onRestored } = mount();
    const updated = asTask();
    patchOk(updated);
    await render().restore();
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.patch).toHaveBeenCalledWith("t1", false);
    expect(h.events).toEqual([
      "mark(t1,false)",
      "patch",
      "upsert",
      "restored",
      "toast.success",
      "unmark(t1)",
    ]);
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("列表和详情页拿到的都是服务端返回的那个任务对象（不是本地拼的）", async () => {
    const { render, onRestored } = mount();
    const updated = asTask({ title: "服务端改过的标题" });
    patchOk(updated);
    await render().restore();
    expect(h.upsertTask.mock.calls[0][0]).toBe(updated);
    expect(onRestored.mock.calls[0][0]).toBe(updated);
  });

  it("提示取服务端回报：恢复了几个定时由 buildRestoreToast 说", async () => {
    const { render } = mount();
    const report = { restoredSchedules: 2, missedSchedules: 1 };
    patchOk(asTask(), report);
    await render().restore();
    const text = h.success.mock.calls[0][0] as string;
    expect(text).toBe(buildRestoreToast("旧会话", report as never));
    expect(text).toContain("2 个定时已恢复");
    expect(text).toContain("1 个定时在归档期间已过点");
  });

  it("服务端没回报定时情况：只说已恢复", async () => {
    const { render } = mount();
    patchOk(asTask());
    await render().restore();
    expect(h.success.mock.calls[0][0]).toBe("已恢复「旧会话」");
  });

  it("恢复中状态：发出请求时为 true，结束后回到 false", async () => {
    const { render } = mount();
    const d = deferred<{ task: Task; report?: unknown }>();
    h.patch.mockImplementationOnce(() => d.promise);
    const p = render().restore();
    expect(render().restoring).toBe(true);
    d.resolve({ task: asTask() });
    await p;
    expect(render().restoring).toBe(false);
  });
});

describe("防重入", () => {
  it("双击：请求还没回来时第二下直接丢掉，PATCH / 标记 / 提示都只有一次", async () => {
    const { render } = mount();
    const d = deferred<{ task: Task }>();
    h.patch.mockImplementationOnce(() => d.promise);
    const p1 = render().restore();
    const p2 = render().restore();
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.markArchiving).toHaveBeenCalledTimes(1);
    d.resolve({ task: asTask() });
    await Promise.all([p1, p2]);
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.success).toHaveBeenCalledTimes(1);
    expect(h.unmarkArchiving).toHaveBeenCalledTimes(1);
  });

  it("完成之后闸放开：可以再来一次（比如又被归档了）", async () => {
    const { render } = mount();
    patchOk(asTask());
    await render().restore();
    patchOk(asTask());
    await render().restore();
    expect(h.patch).toHaveBeenCalledTimes(2);
    expect(h.success).toHaveBeenCalledTimes(2);
  });
});

describe("失败路径", () => {
  it("请求失败：弹错误（带原因）、不碰列表 / 详情页 / 置顶序、放标记放闸", async () => {
    const { render, onRestored } = mount({ id: "t1", title: "旧会话", pinned: true });
    h.patch.mockImplementationOnce(async () => {
      h.events.push("patch");
      throw new Error("HTTP 500");
    });
    await render().restore();
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.error.mock.calls[0][0]).toBe("恢复失败：HTTP 500");
    expect(h.success).not.toHaveBeenCalled();
    expect(h.upsertTask).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
    expect(h.saveOrder).not.toHaveBeenCalled();
    expect(h.events).toEqual(["mark(t1,false)", "patch", "toast.error", "unmark(t1)"]);
    expect(render().restoring).toBe(false);
  });

  it("失败后可以直接重试，第二次成功", async () => {
    const { render } = mount();
    h.patch.mockImplementationOnce(async () => {
      throw new Error("网络断了");
    });
    await render().restore();
    patchOk(asTask());
    await render().restore();
    expect(h.patch).toHaveBeenCalledTimes(2);
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.success).toHaveBeenCalledTimes(1);
  });

  it("抛出来的不是 Error（字符串）：照样拼进提示、不吞", async () => {
    const { render } = mount();
    h.patch.mockImplementationOnce(async () => {
      throw "boom";
    });
    await render().restore();
    expect(h.error.mock.calls[0][0]).toBe("恢复失败：boom");
  });

  it("成功之后的收尾（提示 / 置顶序）出错也不能让闸卡死：下一次还能点", async () => {
    const { render } = mount();
    patchOk(asTask());
    h.success.mockImplementationOnce(() => {
      throw new Error("toast 炸了");
    });
    await render().restore();
    expect(render().restoring).toBe(false);
    patchOk(asTask());
    await render().restore();
    expect(h.patch).toHaveBeenCalledTimes(2);
  });
});

describe("置顶任务的手动序", () => {
  it("置顶的任务恢复后接回手动序末尾（归档时它被摘掉了）", async () => {
    h.loadOrder.mockReturnValue(["a", "b"]);
    const { render } = mount({ id: "t1", title: "旧会话", pinned: true });
    patchOk(asTask());
    await render().restore();
    expect(h.saveOrder).toHaveBeenCalledTimes(1);
    expect(h.saveOrder).toHaveBeenCalledWith(["a", "b", "t1"]);
  });

  it("手动序里已经有它：不重复写入", async () => {
    h.loadOrder.mockReturnValue(["t1", "a"]);
    const { render } = mount({ id: "t1", title: "旧会话", pinned: true });
    patchOk(asTask());
    await render().restore();
    expect(h.saveOrder).not.toHaveBeenCalled();
  });

  it("没置顶的任务：不读也不写手动序", async () => {
    const { render } = mount({ id: "t1", title: "旧会话", pinned: false });
    patchOk(asTask());
    await render().restore();
    expect(h.loadOrder).not.toHaveBeenCalled();
    expect(h.saveOrder).not.toHaveBeenCalled();
  });
});
