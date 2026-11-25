/**
 * 第五轮评审 N3：加上下文文档「已落盘、但服务端读回任务视图失败」的前端处理。
 *
 * 服务端（路由）这时回 201 `{ ok: true, committed: true, warning }`（没有 task，路由测试在 owner-note.test.ts）。
 * 以前回 500 → 前端弹「加文档失败：上下文文档已保存…」（自相矛盾）、不清表单，用户再点一次就重复添加。
 *
 * 钉的是：
 * - 客户端封装 addContextDoc：有 task → { task }；committed → { task: null, committed, warning }（缺 warning 用兜底文案）；
 *   2xx 却两样都没有 → 抛（不把 undefined 当成功交给调用方）；真失败（4xx）照旧抛；
 * - 提示文案纯函数 describeAddFeedback；
 * - 面板 handleAdd（槽位桩下真跑组件）：committed → 清表单 + warning toast（不弹错误）+ 重拉任务；重拉失败静默；
 *   非 committed 失败 → error toast、不清表单。
 */
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHookHarness } from "./helpers/react-hook-stub";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

// 贴图 hook 换成可观测的假实现（本测试只关心 handleAdd 的分支，不测贴图交互）
const attachMock = vi.hoisted(() => ({
  reset: vi.fn(),
  toUploadPayload: vi.fn(() => undefined),
}));
vi.mock("@/hooks/use-image-attach", () => ({
  useImageAttach: () => ({
    images: [],
    isDragging: false,
    fileInputRef: { current: null },
    maxImages: 6,
    removeImage: vi.fn(),
    replaceAll: vi.fn(),
    reset: attachMock.reset,
    triggerFilePicker: vi.fn(),
    onPaste: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onFileInputChange: vi.fn(),
    toUploadPayload: attachMock.toUploadPayload,
  }),
}));

const { addContextDoc } = await import("@/lib/task-store");
const { ContextDocsPanel, describeAddFeedback, refreshTaskAfterCommittedAdd } = await import(
  "@/components/tasks/context-docs-panel"
);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const WARNING = "上下文文档已保存，但读取最新任务状态失败：EIO: 读事件失败";
const TASK = { id: "t1", runStatus: "idle", contextDocs: [] } as never;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  for (const f of [...Object.values(toastMock), attachMock.reset, attachMock.toUploadPayload]) f.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("addContextDoc（客户端封装）：能处理「已保存、但响应里没有 task」", () => {
  it("正常响应带 task → { task }，没有 committed / warning", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { ok: true, task: { id: "t1" } }));
    const r = await addContextDoc("t1", { title: "a", content: "b" });
    expect(r).toEqual({ task: { id: "t1" } });
  });

  it("201 + committed + warning（没有 task）→ { task: null, committed: true, warning } 原样透传，不抛", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { ok: true, committed: true, warning: WARNING }));
    const r = await addContextDoc("t1", { title: "a", content: "b" });
    expect(r).toEqual({ task: null, committed: true, warning: WARNING });
  });

  it("committed 但 warning 缺失 / 为空白 → 用兜底文案（仍说明「已保存」）", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { ok: true, committed: true }));
    const r1 = await addContextDoc("t1", { title: "a", content: "b" });
    fetchMock.mockResolvedValueOnce(json(201, { ok: true, committed: true, warning: "  " }));
    const r2 = await addContextDoc("t1", { title: "a", content: "b" });
    for (const r of [r1, r2]) {
      expect(r.task).toBeNull();
      expect(r.warning).toContain("已保存");
    }
  });

  it("2xx 既没有 task 也不是 committed（协议异常）→ 抛错，不把 undefined 当成功", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { ok: true }));
    await expect(addContextDoc("t1", { title: "a", content: "b" })).rejects.toThrow("缺少 task");
  });

  it("真失败（400 / 500 error body）照旧抛、带服务端文案", async () => {
    fetchMock.mockResolvedValueOnce(json(400, { error: "title 不能超过 100 字" }));
    await expect(addContextDoc("t1", { title: "a", content: "b" })).rejects.toThrow("title 不能超过 100 字");
    fetchMock.mockResolvedValueOnce(json(500, { error: "boom" }));
    await expect(addContextDoc("t1", { title: "a", content: "b" })).rejects.toThrow("boom");
  });
});

describe("describeAddFeedback：加成功后给用户什么提示", () => {
  it("committed（task 为 null）→ warning，文案说清「已保存、刷新失败、请稍后刷新页面确认」，服务端原文放 description", () => {
    const fb = describeAddFeedback({ task: null, committed: true, warning: WARNING }, false);
    expect(fb.level).toBe("warning");
    expect(fb.message).toBe("文档已保存，但刷新任务状态失败，请稍后刷新页面确认");
    expect(fb.description).toBe(WARNING);
  });

  it("committed 时不看任务是否在跑，一律 warning（不会被 isLive 的 info 盖掉）", () => {
    expect(describeAddFeedback({ task: null, committed: true, warning: WARNING }, true).level).toBe("warning");
  });

  it("正常：任务在跑 → info（下次推进生效）；否则 success", () => {
    const task = { id: "t1" } as never;
    expect(describeAddFeedback({ task }, true).level).toBe("info");
    expect(describeAddFeedback({ task }, false)).toEqual({ level: "success", message: "上下文文档已加" });
  });
});

describe("refreshTaskAfterCommittedAdd：尽力重拉，失败静默", () => {
  it("拉到 → 交给 onTaskUpdate、返回 true；用任务页同口径的 tail 300 + anchored", async () => {
    const fresh = { id: "t1" } as never;
    const fetcher = vi.fn(async () => fresh);
    const onUpdate = vi.fn();
    await expect(refreshTaskAfterCommittedAdd("t1", onUpdate, fetcher)).resolves.toBe(true);
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(fresh);
    expect(fetcher).toHaveBeenCalledWith("t1", { tail: 300, anchored: true });
  });

  it("拉取抛错 / 任务已不存在（null）→ 不抛、不调 onTaskUpdate、返回 false", async () => {
    const onUpdate = vi.fn();
    await expect(
      refreshTaskAfterCommittedAdd("t1", onUpdate, vi.fn(async () => { throw new Error("503"); })),
    ).resolves.toBe(false);
    await expect(refreshTaskAfterCommittedAdd("t1", onUpdate, vi.fn(async () => null))).resolves.toBe(false);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 面板 handleAdd：槽位桩下真跑组件，拿元素树直接调 onChange / onClick
// ---------------------------------------------------------------------------
type El = ReactElement<Record<string, unknown>>;
const walk = (node: unknown, out: El[] = []): El[] => {
  if (Array.isArray(node)) {
    for (const c of node) walk(c, out);
  } else if (isValidElement(node)) {
    const el = node as El;
    out.push(el);
    for (const v of Object.values(el.props)) {
      if (Array.isArray(v) || isValidElement(v)) walk(v, out);
    }
  }
  return out;
};

const mountPanel = (onTaskUpdate: (t: unknown) => void) => {
  const harness = createHookHarness();
  const render = () => walk(harness.render(() => ContextDocsPanel({ task: TASK, onTaskUpdate })));
  const byId = (id: string) => {
    const hit = render().filter((el) => el.props.id === id);
    if (hit.length !== 1) throw new Error(`找不到唯一的 #${id}（${hit.length}）`);
    return hit[0]!;
  };
  const fill = (title: string, content: string) => {
    (byId("ctx-title").props.onChange as (e: unknown) => void)({ target: { value: title } });
    (byId("ctx-content").props.onChange as (e: unknown) => void)({ target: { value: content } });
  };
  const submitBtn = () => {
    const hit = render().filter((el) => el.props.children === "添加");
    if (hit.length !== 1) throw new Error(`找不到唯一的「添加」按钮（${hit.length}）`);
    return hit[0]!;
  };
  const submit = async () => {
    await (submitBtn().props.onClick as () => Promise<void>)();
    // refreshTaskAfterCommittedAdd 是 void 出去的：让它的微任务跑完
    await new Promise((r) => setTimeout(r, 0));
  };
  return { fill, submit, submitBtn, titleValue: () => byId("ctx-title").props.value };
};

describe("ContextDocsPanel.handleAdd：committed（已保存、没有 task）", () => {
  it("清表单 + warning toast（不弹错误）+ 重拉任务交给 onTaskUpdate；POST 只发一次（没有重复添加）", async () => {
    const fresh = { id: "t1", contextDocs: [{ id: "d1" }] };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json(201, { ok: true, committed: true, warning: WARNING })
        : json(200, { task: fresh }),
    );
    const onTaskUpdate = vi.fn();
    const p = mountPanel(onTaskUpdate);
    p.fill("方案", "见文档");
    expect(p.titleValue()).toBe("方案");
    await p.submit();

    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.warning.mock.calls[0]![0]).toBe("文档已保存，但刷新任务状态失败，请稍后刷新页面确认");
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(attachMock.reset).toHaveBeenCalledTimes(1);
    expect(p.titleValue()).toBe(""); // 表单已清
    // 重拉到的任务交给父组件
    expect(onTaskUpdate).toHaveBeenCalledExactlyOnceWith(fresh);
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(1);
    // 重拉走的是 GET /api/tasks/t1?tail=300&anchor=1
    const gets = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== "POST");
    expect(gets.map(([u]) => u)).toEqual(["/api/tasks/t1?tail=300&anchor=1"]);
  });

  it("重拉也失败：静默——不抛、不再弹错误、不调 onTaskUpdate，表单仍已清、warning 仍在", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json(201, { ok: true, committed: true, warning: WARNING })
        : json(503, { error: "还在恢复" }),
    );
    const onTaskUpdate = vi.fn();
    const p = mountPanel(onTaskUpdate);
    p.fill("方案", "见文档");
    await p.submit();

    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(onTaskUpdate).not.toHaveBeenCalled();
    expect(attachMock.reset).toHaveBeenCalledTimes(1);
    expect(p.titleValue()).toBe("");
  });
});

describe("ContextDocsPanel.handleAdd：其它路径保持原样", () => {
  it("非 committed 的失败（400）：error toast、不清表单、不重拉、不调 onTaskUpdate", async () => {
    fetchMock.mockResolvedValue(json(400, { error: "所有者备注最多 1000 字" }));
    const onTaskUpdate = vi.fn();
    const p = mountPanel(onTaskUpdate);
    p.fill("方案", "见文档");
    await p.submit();

    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(toastMock.error.mock.calls[0]![0]).toContain("加文档失败：所有者备注最多 1000 字");
    expect(toastMock.warning).not.toHaveBeenCalled();
    expect(attachMock.reset).not.toHaveBeenCalled();
    expect(p.titleValue()).toBe("方案");
    expect(onTaskUpdate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("正常成功：onTaskUpdate(task)、清表单、success toast，不额外重拉", async () => {
    const task = { id: "t1", contextDocs: [{ id: "d1" }] };
    fetchMock.mockResolvedValue(json(201, { ok: true, task }));
    const onTaskUpdate = vi.fn();
    const p = mountPanel(onTaskUpdate);
    p.fill("方案", "见文档");
    await p.submit();

    expect(onTaskUpdate).toHaveBeenCalledExactlyOnceWith(task);
    expect(toastMock.success).toHaveBeenCalledWith("上下文文档已加", undefined);
    expect(toastMock.warning).not.toHaveBeenCalled();
    expect(attachMock.reset).toHaveBeenCalledTimes(1);
    expect(p.titleValue()).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
