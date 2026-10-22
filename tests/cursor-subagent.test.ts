/**
 * Cursor 路径的子代理工具 `subagent`：入参 → 模型 / effort 解析 → 嵌套子 agent → 结果，
 * 以及「父 run 取消 → 子 run 一起停」的联动（回调拿不到 AbortSignal，必须自己接力）。
 *
 * 不碰真实 SDK：子 agent / 模型目录都是注入的假依赖。真实 SDK 下的行为（Sonnet 5.5 + effort 真的生效、
 * 取消 58ms 内子 shell 进程消失、取消后同一 agent 下一轮照常、resume 路径）见 docs/HANDOFF.md 的实测记录。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSubagentResumablesForTests,
  __resumableChildIdsForTests,
  createCursorSubagentLink,
  CURSOR_SUBAGENT_DESCRIPTION,
  CURSOR_SUBAGENT_READONLY_TOOLS,
  formatSubagentTrailer,
  RESUMABLE_CHILDREN_PER_PARENT_MAX,
  withNativeTaskDisabled,
  type CursorSubagentDeps,
  type SubagentChildAgent,
  type SubagentChildRun,
} from "@/lib/server/cursor-subagent";
import {
  getSubagentDisplayLookup,
  getSubagentParentModel,
} from "@/lib/server/subagent-parent-model";
import { SUBAGENT_INPUT_JSON_SCHEMA, type ModelCatalogEntry } from "@/lib/subagent-spec";

// ----------------- 假依赖 -----------------

const CATALOG: ModelCatalogEntry[] = [
  { id: "composer-2.5", displayName: "Composer 2.5", efforts: [] },
  {
    id: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    effortParamId: "reasoning_effort",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    effortParamId: "effort",
    efforts: ["low", "medium", "high"],
  },
];

interface FakeRunOpts {
  status?: string;
  result?: string | undefined;
  error?: { message?: string } | null;
  /** 流里吐的 assistant 文本（result 缺省时兜底用） */
  streamText?: string;
  /** wait / stream 一直挂着，直到 cancel */
  hangUntilCancel?: boolean;
  streamThrows?: boolean;
}

const fakeRun = (o: FakeRunOpts = {}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let cancelled = false;
  const run: SubagentChildRun & { cancelled: () => boolean } = {
    cancelled: () => cancelled,
    cancel: vi.fn(async () => {
      cancelled = true;
      release();
    }),
    stream: () =>
      (async function* () {
        if (o.streamThrows) throw new Error("stream broke");
        if (o.hangUntilCancel) await gate;
        if (o.streamText) {
          yield { type: "assistant", message: { content: [{ text: o.streamText }] } };
        }
      })(),
    wait: async () => {
      if (o.hangUntilCancel) await gate;
      if (cancelled) return { status: "cancelled" };
      return {
        status: o.status ?? "finished",
        ...(o.result !== undefined || o.status === undefined ? { result: o.result ?? "ok" } : {}),
        ...(o.error !== undefined ? { error: o.error } : {}),
      };
    },
  };
  return run;
};

const makeDeps = (
  over: Partial<CursorSubagentDeps> & {
    run?: FakeRunOpts;
    sendDelay?: Promise<void>;
    createDelay?: Promise<void>;
    /** 子 agent 带 agentId（child-1 / child-2…）并提供 resumeChild——resume 相关用例用；缺省不带，结果不含尾注 */
    withIds?: boolean;
    /** resumeChild 抛这个错（模拟 SDK 里找不到那个 agent） */
    resumeError?: string;
  } = {},
) => {
  const runs: ReturnType<typeof fakeRun>[] = [];
  const children: Array<SubagentChildAgent & { close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }> = [];
  const loadCatalog = vi.fn(async () => CATALOG);
  let seq = 0;
  const makeChild = (agentId: string | undefined) => {
    const child = {
      ...(agentId ? { agentId } : {}),
      send: vi.fn(async () => {
        if (over.sendDelay) await over.sendDelay;
        const r = fakeRun(over.run);
        runs.push(r);
        return r;
      }),
      close: vi.fn(),
    };
    children.push(child);
    return child;
  };
  const createChild = vi.fn(async (opts: { model?: unknown; explore: boolean }) => {
    void opts; // 形参只为让 mock.calls 带类型
    if (over.createDelay) await over.createDelay;
    seq += 1;
    return makeChild(over.withIds ? `child-${seq}` : undefined);
  });
  const resumeChild = vi.fn(
    async (opts: { agentId: string; model?: unknown; explore: boolean }) => {
      void opts;
      if (over.resumeError) throw new Error(over.resumeError);
      return makeChild(opts.agentId);
    },
  );
  const deps: CursorSubagentDeps = {
    parentModel: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
    loadCatalog,
    createChild,
    ...(over.withIds ? { resumeChild } : {}),
    ...(over.parentModel !== undefined ? { parentModel: over.parentModel } : {}),
    ...(over.loadCatalog ? { loadCatalog: over.loadCatalog } : {}),
  };
  return {
    deps,
    loadCatalog: over.loadCatalog ?? loadCatalog,
    createChild,
    resumeChild,
    runs,
    children,
  };
};

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const call = async (
  link: ReturnType<typeof createCursorSubagentLink>,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> => {
  const r = (await link.tool.execute(args as never, {} as never)) as ToolResult;
  return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
};

// ----------------- 工具本身 -----------------

describe("subagent 工具定义", () => {
  it("描述写明可并行、可 resume；不再提原生 task（它已被关掉）；schema 含 model / effort / subagentType / resume", () => {
    const { deps } = makeDeps();
    const { tool } = createCursorSubagentLink(deps);
    expect(tool.description).toBe(CURSOR_SUBAGENT_DESCRIPTION);
    expect(CURSOR_SUBAGENT_DESCRIPTION).not.toContain("原生");
    expect(CURSOR_SUBAGENT_DESCRIPTION).toContain("并行");
    expect(CURSOR_SUBAGENT_DESCRIPTION).toContain("resume");
    const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual([
      "description",
      "effort",
      "model",
      "prompt",
      "resume",
      "subagentType",
    ]);
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["prompt"]);
  });

  it("共享 schema（pi task 也用）不含 resume——resume 是 Cursor 路径独有的", () => {
    expect(Object.keys(SUBAGENT_INPUT_JSON_SCHEMA.properties)).not.toContain("resume");
  });

  it("explore 白名单只有读 / 搜", () => {
    expect([...CURSOR_SUBAGENT_READONLY_TOOLS].sort()).toEqual(["glob", "grep", "ls", "read"]);
  });
});

// ----------------- 模型 / effort 解析 -----------------

describe("模型与 effort", () => {
  it("缺省 = 沿用父模型（含其 params），且不为此拉模型目录", async () => {
    const { deps, loadCatalog, createChild } = makeDeps();
    const link = createCursorSubagentLink(deps);
    const out = await call(link, { prompt: "做点事" });
    expect(out).toEqual({ text: "ok", isError: false });
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(createChild).toHaveBeenCalledWith({
      model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
      explore: false,
    });
  });

  it("inherit / 同 id 都算沿用", async () => {
    const { deps, createChild } = makeDeps();
    const link = createCursorSubagentLink(deps);
    await call(link, { prompt: "x", model: "inherit" });
    await call(link, { prompt: "x", model: "composer-2.5" });
    for (const c of createChild.mock.calls) {
      expect(c[0].model).toEqual({ id: "composer-2.5", params: [{ id: "fast", value: "false" }] });
    }
  });

  it("换模型 + effort：用目录里该模型自己的 effort 参数 id，且不带父模型的 params", async () => {
    const { deps, createChild } = makeDeps();
    const link = createCursorSubagentLink(deps);
    await call(link, { prompt: "x", model: "claude-sonnet-5-5", effort: "low" });
    await call(link, { prompt: "x", model: "claude-sonnet-5", effort: "high" });
    expect(createChild.mock.calls[0][0].model).toEqual({
      id: "claude-sonnet-5-5",
      params: [{ id: "reasoning_effort", value: "low" }],
    });
    expect(createChild.mock.calls[1][0].model).toEqual({
      id: "claude-sonnet-5",
      params: [{ id: "effort", value: "high" }],
    });
  });

  it("按 displayName 也能选（唯一时）", async () => {
    const { deps, createChild } = makeDeps();
    await call(createCursorSubagentLink(deps), { prompt: "x", model: "Claude Sonnet 5.5" });
    expect((createChild.mock.calls[0][0].model as { id: string }).id).toBe("claude-sonnet-5-5");
  });

  it("沿用模型但改 effort：换掉同 id 的参数、保留其它", async () => {
    const parent = {
      id: "claude-sonnet-5-5",
      params: [
        { id: "reasoning_effort", value: "high" },
        { id: "thinking", value: "true" },
      ],
    };
    const { deps, createChild } = makeDeps({ parentModel: parent });
    await call(createCursorSubagentLink(deps), { prompt: "x", effort: "low" });
    expect(createChild.mock.calls[0][0].model).toEqual({
      id: "claude-sonnet-5-5",
      params: [
        { id: "thinking", value: "true" },
        { id: "reasoning_effort", value: "low" },
      ],
    });
  });

  it("无效 model：报错并列出可选项，不起子 agent（不静默回退）", async () => {
    const { deps, createChild } = makeDeps();
    const out = await call(createCursorSubagentLink(deps), { prompt: "x", model: "gpt-9" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("gpt-9");
    expect(out.text).toContain("claude-sonnet-5-5");
    expect(createChild).not.toHaveBeenCalled();
  });

  it("无效 effort / 模型没有 effort：报错并列出可选档", async () => {
    const { deps, createChild } = makeDeps();
    const link = createCursorSubagentLink(deps);
    const bad = await call(link, { prompt: "x", model: "claude-sonnet-5-5", effort: "ultra" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("low | medium | high");
    const none = await call(link, { prompt: "x", model: "composer-2.5", effort: "low" });
    expect(none.isError).toBe(true);
    expect(createChild).not.toHaveBeenCalled();
  });

  it("要写 effort 但拿不到目录：明确报错、不乱猜参数 id（猜错 SDK 会静默忽略）", async () => {
    const { deps, createChild } = makeDeps({ loadCatalog: vi.fn(async () => null) });
    const out = await call(createCursorSubagentLink(deps), { prompt: "x", effort: "low" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("effort");
    expect(createChild).not.toHaveBeenCalled();
  });

  it("拿不到目录但只换模型：直接放行（SDK 自己会拒绝无效 id）", async () => {
    const { deps, createChild } = makeDeps({ loadCatalog: vi.fn(async () => null) });
    const out = await call(createCursorSubagentLink(deps), { prompt: "x", model: "some-new-model" });
    expect(out.isError).toBe(false);
    expect((createChild.mock.calls[0][0].model as { id: string }).id).toBe("some-new-model");
  });

  it("model:list → 返回当前模型 + 可选清单，不起子 agent", async () => {
    const { deps, createChild } = makeDeps();
    const out = await call(createCursorSubagentLink(deps), { prompt: "x", model: "list" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("当前模型：composer-2.5");
    expect(out.text).toContain("claude-sonnet-5-5");
    // 清单里要带各模型的 effort 档，模型才知道怎么填
    expect(out.text).toContain("effort: low | medium | high | xhigh | max");
    expect(createChild).not.toHaveBeenCalled();
  });

  it("model:list 拿不到目录 → 说明而不是报错", async () => {
    const { deps } = makeDeps({ loadCatalog: vi.fn(async () => null) });
    const out = await call(createCursorSubagentLink(deps), { prompt: "x", model: "list" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("拿不到");
  });

  it("父会话没显式选模型：沿用时不替它编模型 id（交给 SDK 默认）", async () => {
    const { deps, createChild } = makeDeps();
    const link = createCursorSubagentLink({ ...deps, parentModel: undefined });
    await call(link, { prompt: "x" });
    expect(createChild.mock.calls[0][0].model).toBeUndefined();
  });

  it("prompt 为空 → 用法错误", async () => {
    const { deps, createChild } = makeDeps();
    const out = await call(createCursorSubagentLink(deps), { prompt: "  " });
    expect(out).toEqual({ text: "prompt 不能为空", isError: true });
    expect(createChild).not.toHaveBeenCalled();
  });
});

// ----------------- 子 agent 配置 / 结果 -----------------

describe("子 agent 与结果", () => {
  it("subagentType=explore → 只读；其余 → 可读写", async () => {
    const { deps, createChild } = makeDeps();
    const link = createCursorSubagentLink(deps);
    await call(link, { prompt: "x", subagentType: "explore" });
    await call(link, { prompt: "x", subagentType: "general" });
    await call(link, { prompt: "x" });
    expect(createChild.mock.calls.map((c) => c[0].explore)).toEqual([true, false, false]);
  });

  it("子 agent 收到的就是 prompt 原文；结果取 run.result", async () => {
    const { deps, children } = makeDeps({ run: { result: "最终结论" } });
    const out = await call(createCursorSubagentLink(deps), { prompt: "查一下 X" });
    expect(children[0].send).toHaveBeenCalledWith("查一下 X");
    expect(out).toEqual({ text: "最终结论", isError: false });
  });

  it("run.result 缺省时用流里的 assistant 文本兜底", async () => {
    const { deps } = makeDeps();
    // 直接构造「完成但没有 result」的 run（fakeRun 缺省会补 result:"ok"）
    const link = createCursorSubagentLink({
      ...deps,
      createChild: async () => ({
        send: async () => ({
          stream: () =>
            (async function* () {
              yield { type: "assistant", message: { content: [{ text: "流里的文本" }] } };
            })(),
          wait: async () => ({ status: "finished" }),
          cancel: async () => {},
        }),
        close: () => {},
      }),
    });
    expect(await call(link, { prompt: "x" })).toEqual({ text: "流里的文本", isError: false });
  });

  it("完全无输出 → 明示「无输出」而不是空串", async () => {
    const { deps } = makeDeps({ run: { result: "" } });
    expect(await call(createCursorSubagentLink(deps), { prompt: "x" })).toEqual({
      text: "(子任务无输出)",
      isError: false,
    });
  });

  it("子 run 失败：带原因、标 isError，不吞成「无输出」", async () => {
    const { deps } = makeDeps({ run: { status: "error", error: { message: "模型被拒" } } });
    const out = await call(createCursorSubagentLink(deps), { prompt: "x" });
    expect(out.isError).toBe(true);
    expect(out.text).toBe("子任务失败：error：模型被拒");
  });

  it("子 run 中途失败时保留已产出的部分内容", async () => {
    const { deps } = makeDeps({ run: { status: "error", result: "写到一半", error: { message: "断了" } } });
    const out = await call(createCursorSubagentLink(deps), { prompt: "x" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("断了");
    expect(out.text).toContain("写到一半");
  });

  it("流中途断：终态以 wait() 为准", async () => {
    const { deps } = makeDeps({ run: { streamThrows: true, result: "仍然完成" } });
    expect(await call(createCursorSubagentLink(deps), { prompt: "x" })).toEqual({
      text: "仍然完成",
      isError: false,
    });
  });

  it("起子 agent 失败（SDK 抛错）→ 子任务失败 + isError，不抛给 SDK", async () => {
    const { deps } = makeDeps();
    const link = createCursorSubagentLink({
      ...deps,
      createChild: async () => {
        throw new Error("Invalid model");
      },
    });
    const out = await call(link, { prompt: "x" });
    expect(out).toEqual({ text: "子任务失败：Invalid model", isError: true });
  });

  it("成功 / 失败 / 取消 三条路径都会关子 agent", async () => {
    for (const run of [{ result: "a" }, { status: "error", error: { message: "x" } }]) {
      const { deps, children } = makeDeps({ run });
      await call(createCursorSubagentLink(deps), { prompt: "x" });
      expect(children[0].close).toHaveBeenCalledTimes(1);
    }
    const { deps, children } = makeDeps({ run: { hangUntilCancel: true } });
    const link = createCursorSubagentLink(deps);
    const p = call(link, { prompt: "x" });
    await vi.waitFor(() => expect(children[0]?.send).toHaveBeenCalled());
    await link.cancelAll();
    await p;
    expect(children[0].close).toHaveBeenCalledTimes(1);
  });

  it("关闭子 agent 抛错不影响结果", async () => {
    const { deps } = makeDeps();
    const link = createCursorSubagentLink({
      ...deps,
      createChild: async () => ({
        send: async () => fakeRun({ result: "还是拿到了" }),
        close: () => {
          throw new Error("close failed");
        },
      }),
    });
    expect(await call(link, { prompt: "x" })).toEqual({ text: "还是拿到了", isError: false });
  });
});

// ----------------- 取消联动 -----------------

describe("取消联动：回调拿不到 AbortSignal，父取消必须接力到子 run", () => {
  it("cancelAll 取消在跑的子 run；回调以「子任务已取消」结束（不是失败）", async () => {
    const { deps, runs, children } = makeDeps({ run: { hangUntilCancel: true } });
    const link = createCursorSubagentLink(deps);
    const p = call(link, { prompt: "x" });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await link.cancelAll();
    const out = await p;
    expect(runs[0].cancel).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ text: "子任务已取消", isError: false });
    expect(children[0].close).toHaveBeenCalled();
  });

  it("并行的多个子 run 都被取消", async () => {
    const { deps, runs } = makeDeps({ run: { hangUntilCancel: true } });
    const link = createCursorSubagentLink(deps);
    const ps = [call(link, { prompt: "a" }), call(link, { prompt: "b" }), call(link, { prompt: "c" })];
    await vi.waitFor(() => expect(runs).toHaveLength(3));
    await link.cancelAll();
    const outs = await Promise.all(ps);
    expect(runs.every((r) => r.cancelled())).toBe(true);
    expect(outs.every((o) => o.text === "子任务已取消")).toBe(true);
  });

  it("子 agent 还在创建时被取消：创建完不再 send、直接关掉", async () => {
    let releaseCreate: () => void = () => {};
    const createDelay = new Promise<void>((r) => {
      releaseCreate = r;
    });
    const { deps, children } = makeDeps({ createDelay });
    const link = createCursorSubagentLink(deps);
    const p = call(link, { prompt: "x" });
    await vi.waitFor(() => expect(deps.createChild).toHaveBeenCalled());
    await link.cancelAll();
    releaseCreate();
    const out = await p;
    expect(out.text).toBe("子任务已取消");
    expect(children[0].send).not.toHaveBeenCalled();
    expect(children[0].close).toHaveBeenCalled();
  });

  it("send 还没返回时被取消：run 一拿到就补取消，不留孤儿", async () => {
    let releaseSend: () => void = () => {};
    const sendDelay = new Promise<void>((r) => {
      releaseSend = r;
    });
    const { deps, runs, children } = makeDeps({ sendDelay, run: { hangUntilCancel: true } });
    const link = createCursorSubagentLink(deps);
    const p = call(link, { prompt: "x" });
    await vi.waitFor(() => expect(children[0]?.send).toHaveBeenCalled());
    await link.cancelAll(); // 此刻 live 里还没有 run
    releaseSend();
    const out = await p;
    expect(out.text).toBe("子任务已取消");
    expect(runs[0].cancel).toHaveBeenCalled();
  });

  it("取消只作用于那一刻在跑的：之后同一个 link 的新调用照常（agent 下一轮要能继续派）", async () => {
    const { deps } = makeDeps({ run: { result: "第二轮结果" } });
    const link = createCursorSubagentLink(deps);
    await link.cancelAll();
    expect(await call(link, { prompt: "x" })).toEqual({ text: "第二轮结果", isError: false });
  });

  it("子 run 结束后从集合里摘掉（cancelAll 不会去取消早已完成的 run）", async () => {
    const { deps, runs } = makeDeps();
    const link = createCursorSubagentLink(deps);
    await call(link, { prompt: "x" });
    await link.cancelAll();
    expect(runs[0].cancel).not.toHaveBeenCalled();
  });

  it("两个 link（两个父 agent 实例）互不影响——不按 agentId 全局存", async () => {
    const a = makeDeps({ run: { hangUntilCancel: true } });
    const b = makeDeps({ run: { hangUntilCancel: true } });
    const la = createCursorSubagentLink(a.deps);
    const lb = createCursorSubagentLink(b.deps);
    const pa = call(la, { prompt: "a" });
    const pb = call(lb, { prompt: "b" });
    await vi.waitFor(() => expect(a.runs.length + b.runs.length).toBe(2));
    await la.cancelAll();
    expect((await pa).text).toBe("子任务已取消");
    expect(b.runs[0].cancelled()).toBe(false);
    await lb.cancelAll();
    await pb;
  });
});

// ----------------- attach：Proxy 包一层（send→run.cancel / close / asyncDispose） -----------------

const fakeParent = () => {
  const parentCancel = vi.fn(async () => "parent-cancelled");
  const run = { cancel: parentCancel, id: "r1", status: "running" };
  const agent = {
    agentId: "agent-1",
    send: vi.fn<(...args: unknown[]) => Promise<typeof run>>(async () => run),
    close: vi.fn(() => "closed"),
    [Symbol.asyncDispose]: vi.fn(async () => "disposed"),
  };
  return { agent, run, parentCancel };
};

describe("attach：把父 run 的取消联动到子 run", () => {
  it("父 run.cancel() 先取消子 run，再放行父的 cancel，并返回父的结果", async () => {
    const { deps, runs } = makeDeps({ run: { hangUntilCancel: true } });
    const link = createCursorSubagentLink(deps);
    const { agent, parentCancel } = fakeParent();
    const wrapped = link.attach(agent);
    const run = await wrapped.send();
    const p = call(link, { prompt: "x" });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const ret = await run.cancel();
    expect(ret).toBe("parent-cancelled");
    expect(parentCancel).toHaveBeenCalledTimes(1);
    expect(runs[0].cancel).toHaveBeenCalledTimes(1);
    expect((await p).text).toBe("子任务已取消");
  });

  it("不改原对象：原 agent / run 上的方法仍是原来的 spy（断言原方法的代码不受影响）", async () => {
    const { deps } = makeDeps();
    const link = createCursorSubagentLink(deps);
    const { agent, run, parentCancel } = fakeParent();
    const origSend = agent.send;
    const origClose = agent.close;
    const wrapped = link.attach(agent);
    expect(agent.send).toBe(origSend);
    expect(agent.close).toBe(origClose);
    const r = await wrapped.send("hi");
    expect(origSend).toHaveBeenCalledWith("hi");
    expect(run.cancel).toBe(parentCancel);
    expect(vi.isMockFunction(run.cancel)).toBe(true);
    await r.cancel();
    expect(parentCancel).toHaveBeenCalledTimes(1);
    wrapped.close();
    expect(origClose).toHaveBeenCalledTimes(1);
  });

  it("其余属性 / 方法原样透传（agentId、run.id / status、send 的参数）", async () => {
    const { deps } = makeDeps();
    const link = createCursorSubagentLink(deps);
    const { agent } = fakeParent();
    const wrapped = link.attach(agent);
    expect(wrapped.agentId).toBe("agent-1");
    const run = await wrapped.send("a", { onDelta: 1 });
    expect(agent.send).toHaveBeenCalledWith("a", { onDelta: 1 });
    expect(run.id).toBe("r1");
    expect(run.status).toBe("running");
  });

  it("真实 SDK 的 Run / Agent 是带私有字段的 class：代理不能破坏 this（方法里读 #私有字段 / getter）", async () => {
    const { deps, runs } = makeDeps({ run: { hangUntilCancel: true } });
    const link = createCursorSubagentLink(deps);
    class FakeSdkRun {
      #state = "running";
      #cancelled = false;
      get status(): string {
        return this.#state;
      }
      async cancel(): Promise<string> {
        this.#cancelled = true;
        this.#state = "cancelled";
        return "ok";
      }
      get cancelled(): boolean {
        return this.#cancelled;
      }
      async wait(): Promise<string> {
        return this.#state;
      }
    }
    class FakeSdkAgent {
      #closed = false;
      readonly run = new FakeSdkRun();
      get agentId(): string {
        return "agent-class";
      }
      async send(): Promise<FakeSdkRun> {
        return this.run;
      }
      close(): boolean {
        this.#closed = true;
        return this.#closed;
      }
    }
    const agent = new FakeSdkAgent();
    const wrapped = link.attach(agent);
    expect(wrapped.agentId).toBe("agent-class");
    const run = await wrapped.send();
    expect(run.status).toBe("running");
    const p = call(link, { prompt: "x" });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(await run.cancel()).toBe("ok");
    expect(run.status).toBe("cancelled");
    expect(agent.run.cancelled).toBe(true); // 原对象确实被取消了
    expect(runs[0].cancelled()).toBe(true); // 子 run 也被联动取消
    expect(wrapped.close()).toBe(true);
    await p;
  });

  it("run 不是 thenable：await 代理不会被当成 promise 吞掉", async () => {
    const { deps } = makeDeps();
    const link = createCursorSubagentLink(deps);
    const { agent } = fakeParent();
    const wrapped = link.attach(agent);
    const run = await wrapped.send();
    expect((run as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it("父 cancel 自己失败：错误原样抛出，且子 run 照样被取消", async () => {
    const { deps, runs } = makeDeps({ run: { hangUntilCancel: true } });
    const link = createCursorSubagentLink(deps);
    const { agent, parentCancel } = fakeParent();
    parentCancel.mockRejectedValueOnce(new Error("cancel failed"));
    const run = await link.attach(agent).send();
    const p = call(link, { prompt: "x" });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await expect(run.cancel()).rejects.toThrow("cancel failed");
    expect(runs[0].cancel).toHaveBeenCalled();
    await p;
  });

  it("子 run 取消失败不挡父的 cancel", async () => {
    const { deps, runs } = makeDeps({ run: { hangUntilCancel: true } });
    const link = createCursorSubagentLink(deps);
    const { agent, parentCancel } = fakeParent();
    const run = await link.attach(agent).send();
    const p = call(link, { prompt: "x" });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    (runs[0].cancel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("child cancel failed"));
    await expect(run.cancel()).resolves.toBe("parent-cancelled");
    expect(parentCancel).toHaveBeenCalled();
    // 清理：让挂着的子 run 收尾
    (runs[0].cancel as ReturnType<typeof vi.fn>).mockImplementation(async () => {});
    await link.cancelAll();
    void p;
  });

  it("没有子 run 时 run.cancel() 就是父 cancel（无副作用）", async () => {
    const { deps } = makeDeps();
    const link = createCursorSubagentLink(deps);
    const { agent, parentCancel } = fakeParent();
    const run = await link.attach(agent).send();
    expect(await run.cancel()).toBe("parent-cancelled");
    expect(parentCancel).toHaveBeenCalledTimes(1);
  });

  it("agent.close() / asyncDispose 也先停子 run（会话被关后子代理不能继续烧 token）", async () => {
    for (const dispose of ["close", "dispose"] as const) {
      const { deps, runs } = makeDeps({ run: { hangUntilCancel: true } });
      const link = createCursorSubagentLink(deps);
      const { agent } = fakeParent();
      const wrapped = link.attach(agent);
      const p = call(link, { prompt: "x" });
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      const ret =
        dispose === "close"
          ? wrapped.close()
          : await wrapped[Symbol.asyncDispose]();
      expect(ret).toBe(dispose === "close" ? "closed" : "disposed");
      await vi.waitFor(() => expect(runs[0].cancelled()).toBe(true));
      await p;
    }
  });

  it("agent / run 被冻结（Proxy 改不了返回值）：不抛、原样返回并留痕", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { deps } = makeDeps();
      const link = createCursorSubagentLink(deps);
      const frozenRun = Object.freeze({ cancel: async () => "x" });
      const agent = { send: async () => frozenRun, close: () => {} };
      const wrapped = link.attach(agent);
      await expect(wrapped.send()).resolves.toBe(frozenRun);
      const frozenAgent = Object.freeze({ send: async () => frozenRun });
      expect(link.attach(frozenAgent)).toBe(frozenAgent);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("send 本身失败：错误原样抛出", async () => {
    const { deps } = makeDeps();
    const link = createCursorSubagentLink(deps);
    const agent = { send: vi.fn(async () => { throw new Error("send failed"); }) };
    await expect(link.attach(agent).send()).rejects.toThrow("send failed");
  });

  it("send 返回 undefined / 非对象也不炸", async () => {
    const { deps } = makeDeps();
    const link = createCursorSubagentLink(deps);
    const agent = { send: vi.fn(async () => undefined) };
    await expect(link.attach(agent).send()).resolves.toBeUndefined();
  });
});

// ----------------- resume：接着之前的子代理 -----------------

/** 一个只带 agentId 的假父 agent（attach 用它的 id 给登记表分桶） */
const parentOf = (agentId: string) => ({
  agentId,
  send: vi.fn(async () => ({ cancel: vi.fn(async () => {}) })),
  close: vi.fn(),
});

/** 建 link 并 attach 到名为 parentId 的假父 agent（登记表的桶 key = 这个 id） */
const linkFor = (deps: CursorSubagentDeps, parentId: string) => {
  const link = createCursorSubagentLink(deps);
  link.attach(parentOf(parentId));
  return link;
};

describe("resume：成功结果给 id、之后能接着做", () => {
  beforeEach(() => __resetSubagentResumablesForTests());

  it("子 agent 有 agentId：结果末尾给 id + 实际模型 + 怎么 resume；没有 agentId 则一个字不加", async () => {
    const plain = makeDeps();
    expect(await call(createCursorSubagentLink(plain.deps), { prompt: "x" })).toEqual({
      text: "ok",
      isError: false,
    });

    const { deps } = makeDeps({ withIds: true });
    const out = await call(linkFor(deps, "P1"), { prompt: "x" });
    expect(out.isError).toBe(false);
    expect(out.text.startsWith("ok\n\n[子代理 child-1 · composer-2.5 (fast=false)]")).toBe(true);
    expect(out.text).toContain('resume="child-1"');
  });

  it("resume：沿用当初的模型 / 思考档，不再拉目录、不另起新 agent；提示词送给原来那个子 agent", async () => {
    const { deps, createChild, resumeChild, loadCatalog, children } = makeDeps({ withIds: true });
    const link = linkFor(deps, "P1");
    await call(link, { prompt: "第一次", model: "claude-sonnet-5-5", effort: "low" });
    const catalogLoads = vi.mocked(loadCatalog).mock.calls.length;
    expect(catalogLoads).toBeGreaterThan(0); // 第一次要拉目录才能解析 effort

    const out = await call(link, { prompt: "接着改", resume: "child-1" });
    expect(out.isError).toBe(false);
    expect(createChild).toHaveBeenCalledTimes(1); // 没有另起
    expect(vi.mocked(loadCatalog).mock.calls.length).toBe(catalogLoads); // resume 不再拉
    expect(resumeChild).toHaveBeenCalledWith({
      agentId: "child-1",
      model: { id: "claude-sonnet-5-5", params: [{ id: "reasoning_effort", value: "low" }] },
      explore: false,
    });
    expect(children[1].send).toHaveBeenCalledWith("接着改");
    expect(children[1].close).toHaveBeenCalled(); // 用完照常关
    expect(out.text).toContain("[子代理 child-1 · claude-sonnet-5-5 (reasoning_effort=low)]");
  });

  it("explore 的只读属性沿用：resume 时 explore 原样再传（SDK 的 tools 白名单不持久化）", async () => {
    const { deps, resumeChild } = makeDeps({ withIds: true });
    const link = linkFor(deps, "P1");
    await call(link, { prompt: "查", subagentType: "explore" });
    await call(link, { prompt: "再查", resume: "child-1" });
    expect(resumeChild.mock.calls[0][0].explore).toBe(true);
    // 显式再写一遍同类型也行
    await call(link, { prompt: "再查", resume: "child-1", subagentType: "explore" });
    expect(resumeChild.mock.calls[1][0].explore).toBe(true);
  });

  it("父会话没显式选模型：登记的就是「SDK 默认」，resume 也不替它编模型", async () => {
    const { deps, resumeChild } = makeDeps({ withIds: true });
    const link = linkFor({ ...deps, parentModel: undefined }, "P1");
    const first = await call(link, { prompt: "x" });
    expect(first.text).toContain("[子代理 child-1 · SDK 默认模型]");
    await call(link, { prompt: "y", resume: "child-1" });
    expect(resumeChild.mock.calls[0][0].model).toBeUndefined();
  });

  it("resume 成功后依然可以继续 resume（多轮追问）", async () => {
    const { deps, resumeChild } = makeDeps({ withIds: true });
    const link = linkFor(deps, "P1");
    await call(link, { prompt: "1" });
    for (let i = 0; i < 3; i++) {
      const out = await call(link, { prompt: `追问${i}`, resume: "child-1" });
      expect(out.isError).toBe(false);
    }
    expect(resumeChild).toHaveBeenCalledTimes(3);
  });
});

describe("resume：入参校验——填错直接报错，不静默当成新任务", () => {
  beforeEach(() => __resetSubagentResumablesForTests());

  it("不认识的 id：isError、不创建新子代理（模型要自己决定另起）", async () => {
    const { deps, createChild, resumeChild } = makeDeps({ withIds: true });
    const out = await call(linkFor(deps, "P1"), { prompt: "x", resume: "child-404" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("找不到子代理");
    expect(out.text).toContain("另起");
    expect(createChild).not.toHaveBeenCalled();
    expect(resumeChild).not.toHaveBeenCalled();
  });

  it("不能接别的父会话派出的子代理（登记按父 agentId 分桶，不是任意 id 都能接）", async () => {
    const a = makeDeps({ withIds: true });
    await call(linkFor(a.deps, "P-A"), { prompt: "x" });
    expect(__resumableChildIdsForTests("P-A")).toEqual(["child-1"]);

    const b = makeDeps({ withIds: true });
    const out = await call(linkFor(b.deps, "P-B"), { prompt: "x", resume: "child-1" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("找不到子代理");
    expect(b.resumeChild).not.toHaveBeenCalled();
  });

  it("同一个父 agentId 的新 link（会话被恢复成新实例）能接着之前派出的子代理", async () => {
    const a = makeDeps({ withIds: true });
    await call(linkFor(a.deps, "P-A"), { prompt: "x" });

    const again = makeDeps({ withIds: true });
    const out = await call(linkFor(again.deps, "P-A"), { prompt: "接着", resume: "child-1" });
    expect(out.isError).toBe(false);
    expect(again.resumeChild).toHaveBeenCalledTimes(1);
  });

  it("resume 时 model / effort 不能改（填了就报错）；model=inherit 等于没填、允许", async () => {
    const { deps, resumeChild } = makeDeps({ withIds: true });
    const link = linkFor(deps, "P1");
    await call(link, { prompt: "x" });

    for (const extra of [{ model: "claude-sonnet-5-5" }, { effort: "low" }, { model: "list" }]) {
      const out = await call(link, { prompt: "y", resume: "child-1", ...extra });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("不能改");
    }
    expect(resumeChild).not.toHaveBeenCalled();

    const ok = await call(link, { prompt: "y", resume: "child-1", model: "inherit" });
    expect(ok.isError).toBe(false);
  });

  it("resume 时 subagentType 与当初不一致 → 报错；没填 / 一致 → 通过", async () => {
    const { deps } = makeDeps({ withIds: true });
    const link = linkFor(deps, "P1");
    await call(link, { prompt: "x", subagentType: "explore" });
    const bad = await call(link, { prompt: "y", resume: "child-1", subagentType: "general" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("subagentType");
    expect((await call(link, { prompt: "y", resume: "child-1" })).isError).toBe(false);

    // 反过来：当初是可读写的，不能 resume 成只读
    await call(link, { prompt: "z" }); // child-2（general）
    const bad2 = await call(link, { prompt: "y", resume: "child-2", subagentType: "explore" });
    expect(bad2.isError).toBe(true);
  });

  it("resume 传空串 / 纯空白 = 没传 = 新建一个", async () => {
    const { deps, createChild, resumeChild } = makeDeps({ withIds: true });
    const link = linkFor(deps, "P1");
    await call(link, { prompt: "x", resume: "   " });
    expect(createChild).toHaveBeenCalledTimes(1);
    expect(resumeChild).not.toHaveBeenCalled();
  });

  it("环境不支持 resume（没提供 resumeChild）：明确报错，且不卡死登记", async () => {
    const { deps } = makeDeps({ withIds: true });
    const { resumeChild: _drop, ...noResume } = deps;
    void _drop;
    const link = linkFor(noResume, "P1");
    await call(link, { prompt: "x" });
    for (let i = 0; i < 2; i++) {
      const out = await call(link, { prompt: "y", resume: "child-1" });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("不支持 resume"); // 两次都是这条——busy 没有残留成「还在运行」
    }
  });
});

describe("resume：并发 / 失败 / 取消", () => {
  beforeEach(() => __resetSubagentResumablesForTests());

  it("同一个子代理同时只允许一个 run：并发 resume 第二个被拒，跑完后又能接", async () => {
    const { deps } = makeDeps({ withIds: true });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = {
      ...deps,
      resumeChild: vi.fn(async (o: { agentId: string }) => ({
        agentId: o.agentId,
        send: vi.fn(async () => {
          await gate;
          return fakeRun();
        }),
        close: vi.fn(),
      })),
    };
    const link = linkFor(slow, "P1");
    await call(link, { prompt: "x" });

    const first = call(link, { prompt: "a", resume: "child-1" }); // 同步占位
    const second = await call(link, { prompt: "b", resume: "child-1" });
    expect(second.isError).toBe(true);
    expect(second.text).toContain("还在运行");

    release();
    expect((await first).isError).toBe(false);
    expect((await call(link, { prompt: "c", resume: "child-1" })).isError).toBe(false);
  });

  it("SDK 里接不上那个 agent：报错 + 忘掉这条登记（下次直接是「找不到」），提示另起", async () => {
    const { deps } = makeDeps({ withIds: true, resumeError: "agent not found" });
    const link = linkFor(deps, "P1");
    await call(link, { prompt: "x" });
    expect(__resumableChildIdsForTests("P1")).toEqual(["child-1"]);

    const out = await call(link, { prompt: "y", resume: "child-1" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("agent not found");
    expect(out.text).toContain("另起");
    expect(__resumableChildIdsForTests("P1")).toEqual([]);
    expect((await call(link, { prompt: "y", resume: "child-1" })).text).toContain("找不到子代理");
  });

  it("失败 / 取消的子任务不登记（状态不确定，不鼓励接着做），也不给 id", async () => {
    const failing = makeDeps({ withIds: true, run: { status: "error", error: { message: "boom" } } });
    const out = await call(linkFor(failing.deps, "P1"), { prompt: "x" });
    expect(out.isError).toBe(true);
    expect(out.text).not.toContain("child-1");
    expect(__resumableChildIdsForTests("P1")).toEqual([]);

    const hang = makeDeps({ withIds: true, run: { hangUntilCancel: true } });
    const link = linkFor(hang.deps, "P2");
    const p = call(link, { prompt: "x" });
    await vi.waitFor(() => expect(hang.runs).toHaveLength(1));
    await link.cancelAll();
    await p;
    expect(__resumableChildIdsForTests("P2")).toEqual([]);
  });

  it("resume 的那一轮失败：已登记的保留（之前成功的上下文还在），busy 释放、能再接", async () => {
    const { deps } = makeDeps({ withIds: true });
    const failingResume = {
      ...deps,
      resumeChild: vi
        .fn()
        .mockImplementationOnce(async (o: { agentId: string }) => ({
          agentId: o.agentId,
          send: vi.fn(async () => fakeRun({ status: "error", error: { message: "boom" } })),
          close: vi.fn(),
        }))
        .mockImplementation(async (o: { agentId: string }) => ({
          agentId: o.agentId,
          send: vi.fn(async () => fakeRun()),
          close: vi.fn(),
        })),
    };
    const link = linkFor(failingResume, "P1");
    await call(link, { prompt: "x" });
    const bad = await call(link, { prompt: "y", resume: "child-1" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("boom");
    expect(__resumableChildIdsForTests("P1")).toEqual(["child-1"]);
    expect((await call(link, { prompt: "z", resume: "child-1" })).isError).toBe(false);
  });

  it("resume 出来的子 run 同样被 cancelAll 取消；取消后还能再接", async () => {
    const { deps } = makeDeps({ withIds: true });
    const hangRuns: ReturnType<typeof fakeRun>[] = [];
    const hanging = {
      ...deps,
      resumeChild: vi
        .fn()
        .mockImplementationOnce(async (o: { agentId: string }) => ({
          agentId: o.agentId,
          send: vi.fn(async () => {
            const r = fakeRun({ hangUntilCancel: true });
            hangRuns.push(r);
            return r;
          }),
          close: vi.fn(),
        }))
        .mockImplementation(async (o: { agentId: string }) => ({
          agentId: o.agentId,
          send: vi.fn(async () => fakeRun()),
          close: vi.fn(),
        })),
    };
    const link = linkFor(hanging, "P1");
    await call(link, { prompt: "x" });

    const p = call(link, { prompt: "y", resume: "child-1" });
    await vi.waitFor(() => expect(hangRuns).toHaveLength(1));
    await link.cancelAll();
    expect((await p).text).toBe("子任务已取消");
    expect(hangRuns[0].cancel).toHaveBeenCalledTimes(1);
    expect((await call(link, { prompt: "z", resume: "child-1" })).isError).toBe(false);
  });
});

describe("resume：登记表容量上限", () => {
  beforeEach(() => __resetSubagentResumablesForTests());

  it(`每个父会话最多记 ${RESUMABLE_CHILDREN_PER_PARENT_MAX} 个，超出淘汰最久没用的`, async () => {
    const { deps } = makeDeps({ withIds: true });
    const link = linkFor(deps, "P1");
    for (let i = 0; i < RESUMABLE_CHILDREN_PER_PARENT_MAX + 1; i++) {
      await call(link, { prompt: `t${i}` });
    }
    const ids = __resumableChildIdsForTests("P1");
    expect(ids).toHaveLength(RESUMABLE_CHILDREN_PER_PARENT_MAX);
    expect(ids).not.toContain("child-1"); // 最老的被淘汰
    expect(ids).toContain(`child-${RESUMABLE_CHILDREN_PER_PARENT_MAX + 1}`);
  });

  it("resume 过的会刷新为最近使用（不会因为是最早建的就先被淘汰）", async () => {
    const { deps } = makeDeps({ withIds: true });
    const link = linkFor(deps, "P1");
    for (let i = 0; i < RESUMABLE_CHILDREN_PER_PARENT_MAX; i++) await call(link, { prompt: `t${i}` });
    await call(link, { prompt: "再用一下最老的", resume: "child-1" });
    await call(link, { prompt: "再来一个新的" }); // 挤掉最久没用的 = child-2
    const ids = __resumableChildIdsForTests("P1");
    expect(ids).toContain("child-1");
    expect(ids).not.toContain("child-2");
  });
});

describe("withNativeTaskDisabled / formatSubagentTrailer", () => {
  it("补上 task；已有的保留、不重复、不改入参", () => {
    expect(withNativeTaskDisabled(undefined)).toEqual(["task"]);
    expect(withNativeTaskDisabled([])).toEqual(["task"]);
    const src = ["shell"] as never[];
    expect(withNativeTaskDisabled(src)).toEqual(["shell", "task"]);
    expect(src).toEqual(["shell"]);
    expect(withNativeTaskDisabled(["task", "shell"] as never[])).toEqual(["task", "shell"]);
  });

  it("尾注：带 id、模型（含思考档）、resume 用法；没模型 = SDK 默认", () => {
    const t = formatSubagentTrailer({
      agentId: "agent-9",
      model: { id: "m", params: [{ id: "effort", value: "high" }] },
    });
    expect(t).toContain("agent-9");
    expect(t).toContain("m (effort=high)");
    expect(t).toContain('resume="agent-9"');
    expect(formatSubagentTrailer({ agentId: "a" })).toContain("SDK 默认模型");
  });
});

describe("attach：登记父会话模型（卡片徽标用）", () => {
  it("attach 返回的（被包装的）父 agent 能查到父模型；原对象 / 别的对象查不到", () => {
    const { deps } = makeDeps();
    const link = createCursorSubagentLink(deps);
    const raw = parentOf("P1");
    const wrapped = link.attach(raw);
    expect(getSubagentParentModel(wrapped)).toEqual(deps.parentModel);
    expect(getSubagentParentModel(raw)).toBeUndefined();
    expect(getSubagentParentModel(parentOf("P2"))).toBeUndefined();
    expect(getSubagentParentModel(undefined)).toBeUndefined();
    expect(getSubagentParentModel("str")).toBeUndefined();
  });

  it("父会话没显式选模型：查到的是 undefined（但不抛）", () => {
    const { deps } = makeDeps();
    const link = createCursorSubagentLink({ ...deps, parentModel: undefined });
    expect(getSubagentParentModel(link.attach(parentOf("P1")))).toBeUndefined();
  });
});

describe("onParentCancel：父取消联动的搭便车钩子（wait 用它在 run 被取消时叫醒睡着的回调）", () => {
  it("cancelAll 调一次；run.cancel() / close() 经 attach 的代理都会触发", async () => {
    const onParentCancel = vi.fn();
    const { deps } = makeDeps();
    const link = createCursorSubagentLink({ ...deps, onParentCancel });

    await link.cancelAll();
    expect(onParentCancel).toHaveBeenCalledTimes(1);

    const parentCancel = vi.fn(async () => {});
    const raw = {
      agentId: "P1",
      // 只声明签名（不写占位形参，免得 lint 报未使用）：attach 返回的包装沿用这个类型，下面 send("hi") 才过得了 tsc
      send: vi.fn<(prompt?: string) => Promise<{ cancel: () => Promise<void> }>>(
        async () => ({ cancel: parentCancel }),
      ),
      close: vi.fn(),
    };
    const wrapped = link.attach(raw);
    onParentCancel.mockClear();
    await (await wrapped.send("hi")).cancel();
    expect(onParentCancel).toHaveBeenCalledTimes(1);
    expect(parentCancel).toHaveBeenCalledTimes(1);
    wrapped.close();
    expect(onParentCancel).toHaveBeenCalledTimes(2);
    expect(raw.close).toHaveBeenCalledTimes(1);
  });

  it("钩子抛错只告警：父的取消照常完成、子 run 照常被取消", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = makeDeps();
    const link = createCursorSubagentLink({
      ...deps,
      onParentCancel: () => {
        throw new Error("boom");
      },
    });
    await expect(link.cancelAll()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("不传钩子 = 行为不变", async () => {
    const { deps } = makeDeps();
    await expect(createCursorSubagentLink(deps).cancelAll()).resolves.toBeUndefined();
  });
});

// ----------------- 展示用查表：默认 effort / resume 子代理的模型 -----------------

/** 带默认档的目录（形状同 2026-10-19 真实清单：sonnet-5-5 默认 high、gemini-4-argon 默认 medium） */
const CATALOG_WITH_DEFAULTS: ModelCatalogEntry[] = [
  { id: "composer-2.5", displayName: "Composer 2.5", efforts: [] },
  {
    id: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    effortParamId: "reasoning_effort",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
  },
  {
    id: "gemini-4-argon",
    displayName: "Gemini 4 Argon",
    effortParamId: "reasoning_effort",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
];

describe("展示用查表：该模型的默认 effort", () => {
  beforeEach(() => __resetSubagentResumablesForTests());

  const lookupOf = (link: ReturnType<typeof createCursorSubagentLink>) =>
    getSubagentDisplayLookup(link.attach(parentOf("P-lookup")))!;

  it("attach 返回的对象上登记了查表函数；原对象 / 别的对象查不到", () => {
    const { deps } = makeDeps();
    const link = createCursorSubagentLink(deps);
    const raw = parentOf("P1");
    const wrapped = link.attach(raw);
    expect(getSubagentDisplayLookup(wrapped)).toEqual({
      defaultEffortOf: expect.any(Function),
      resumedChildOf: expect.any(Function),
    });
    expect(getSubagentDisplayLookup(raw)).toBeUndefined();
    expect(getSubagentDisplayLookup(parentOf("P2"))).toBeUndefined();
  });

  it("目录还没拉过、也没有可偷看的缓存：查不到（不发网络请求、不抛）", () => {
    const { deps, loadCatalog } = makeDeps();
    const lookup = lookupOf(createCursorSubagentLink(deps));
    expect(lookup.defaultEffortOf!("claude-sonnet-5-5")).toBeUndefined();
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("peekCatalog 有缓存：直接查得到；peekCatalog 本身只读，不触发 loadCatalog", () => {
    const { deps, loadCatalog } = makeDeps();
    const peekCatalog = vi.fn(() => CATALOG_WITH_DEFAULTS);
    const lookup = lookupOf(createCursorSubagentLink({ ...deps, peekCatalog }));
    expect(lookup.defaultEffortOf!("claude-sonnet-5-5")).toBe("high");
    expect(lookup.defaultEffortOf!("gemini-4-argon")).toBe("medium");
    expect(lookup.defaultEffortOf!("composer-2.5")).toBeUndefined();
    expect(lookup.defaultEffortOf!("not-in-catalog")).toBeUndefined();
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("peekCatalog 抛错 / 返回 null：当没有，不抛、不影响查表", () => {
    const { deps } = makeDeps();
    const throwing = lookupOf(
      createCursorSubagentLink({
        ...deps,
        peekCatalog: () => {
          throw new Error("cache boom");
        },
      }),
    );
    expect(throwing.defaultEffortOf!("claude-sonnet-5-5")).toBeUndefined();
    const empty = lookupOf(createCursorSubagentLink({ ...deps, peekCatalog: () => null }));
    expect(empty.defaultEffortOf!("claude-sonnet-5-5")).toBeUndefined();
  });

  it("显式选模型的调用拉过目录后，这份目录被记住：之后（同步）就查得到，peekCatalog 缺省也行", async () => {
    const { deps, loadCatalog } = makeDeps({
      loadCatalog: vi.fn(async () => CATALOG_WITH_DEFAULTS),
    });
    const link = createCursorSubagentLink(deps);
    const lookup = lookupOf(link);
    expect(lookup.defaultEffortOf!("claude-sonnet-5-5")).toBeUndefined();
    await call(link, { prompt: "x", model: "claude-sonnet-5-5" });
    expect(lookup.defaultEffortOf!("claude-sonnet-5-5")).toBe("high");
    // 记住目录不等于不再拉：每次显式选模型仍照常 loadCatalog（目录可能在两次调用之间变了）
    await call(link, { prompt: "y", model: "gemini-4-argon" });
    expect(loadCatalog).toHaveBeenCalledTimes(2);
  });

  it("缓存（peekCatalog）比记住的那份新鲜：两边都有时以缓存为准——长会话里目录变了不用旧默认档", async () => {
    const changed = CATALOG_WITH_DEFAULTS.map((e) =>
      e.id === "claude-sonnet-5-5" ? { ...e, defaultEffort: "medium" } : e,
    );
    const { deps } = makeDeps({
      loadCatalog: vi.fn(async () => CATALOG_WITH_DEFAULTS),
    });
    let peeked: ModelCatalogEntry[] | null = null;
    const link = createCursorSubagentLink({ ...deps, peekCatalog: () => peeked });
    const lookup = lookupOf(link);
    await call(link, { prompt: "x", model: "claude-sonnet-5-5" }); // 记住：默认 high
    expect(lookup.defaultEffortOf!("claude-sonnet-5-5")).toBe("high"); // 缓存没有 → 兜底用记住的
    peeked = changed; // 之后目录刷新了
    expect(lookup.defaultEffortOf!("claude-sonnet-5-5")).toBe("medium");
    peeked = null; // 缓存过期 → 又退回记住的
    expect(lookup.defaultEffortOf!("claude-sonnet-5-5")).toBe("high");
  });

  it("peekCatalog 抛错时退回记住的那份（不是直接当没有）", async () => {
    const { deps } = makeDeps({
      loadCatalog: vi.fn(async () => CATALOG_WITH_DEFAULTS),
    });
    const link = createCursorSubagentLink({
      ...deps,
      peekCatalog: () => {
        throw new Error("cache boom");
      },
    });
    const lookup = lookupOf(link);
    await call(link, { prompt: "x", model: "claude-sonnet-5-5" });
    expect(lookup.defaultEffortOf!("claude-sonnet-5-5")).toBe("high");
  });

  it("loadCatalog 拿不到（null）：不覆盖之前记住的目录", async () => {
    let n = 0;
    const loadCatalog = vi.fn(async () => (n++ === 0 ? CATALOG_WITH_DEFAULTS : null));
    const { deps } = makeDeps({ loadCatalog });
    const link = createCursorSubagentLink(deps);
    const lookup = lookupOf(link);
    await call(link, { prompt: "x", model: "claude-sonnet-5-5" });
    await call(link, { prompt: "y", model: "gemini-4-argon" }); // 这次拿不到、不校验
    expect(lookup.defaultEffortOf!("claude-sonnet-5-5")).toBe("high");
  });
});

describe("展示用查表：resume 接着的子代理当初用的模型 / effort", () => {
  beforeEach(() => __resetSubagentResumablesForTests());

  it("显式别的模型、没写 effort：模型 + 该模型的默认档", async () => {
    const { deps } = makeDeps({
      withIds: true,
      loadCatalog: vi.fn(async () => CATALOG_WITH_DEFAULTS),
    });
    const link = createCursorSubagentLink(deps);
    const lookup = getSubagentDisplayLookup(link.attach(parentOf("P-r1")))!;
    await call(link, { prompt: "x", model: "claude-sonnet-5-5" });
    expect(lookup.resumedChildOf!("child-1")).toEqual({
      model: "claude-sonnet-5-5",
      effort: "high",
    });
  });

  it("显式写了 effort：用写的那个，不是默认档", async () => {
    const { deps } = makeDeps({
      withIds: true,
      loadCatalog: vi.fn(async () => CATALOG_WITH_DEFAULTS),
    });
    const link = createCursorSubagentLink(deps);
    const lookup = getSubagentDisplayLookup(link.attach(parentOf("P-r2")))!;
    await call(link, { prompt: "x", model: "claude-sonnet-5-5", effort: "xhigh" });
    expect(lookup.resumedChildOf!("child-1")).toEqual({
      model: "claude-sonnet-5-5",
      effort: "xhigh",
    });
  });

  it("沿用父会话：用父会话当前档（参数里有就不退到默认档）", async () => {
    const { deps } = makeDeps({
      withIds: true,
      parentModel: {
        id: "claude-sonnet-5-5",
        params: [{ id: "reasoning_effort", value: "low" }],
      },
    });
    const link = createCursorSubagentLink({
      ...deps,
      peekCatalog: () => CATALOG_WITH_DEFAULTS,
    });
    const lookup = getSubagentDisplayLookup(link.attach(parentOf("P-r3")))!;
    await call(link, { prompt: "x" });
    expect(lookup.resumedChildOf!("child-1")).toEqual({
      model: "claude-sonnet-5-5",
      effort: "low",
    });
  });

  it("没有 effort 可显示（模型没有档位）：只给 model，不带 effort 键", async () => {
    const { deps } = makeDeps({
      withIds: true,
      loadCatalog: vi.fn(async () => CATALOG_WITH_DEFAULTS),
    });
    const link = createCursorSubagentLink(deps);
    const lookup = getSubagentDisplayLookup(link.attach(parentOf("P-r4")))!;
    await call(link, { prompt: "x", model: "composer-2.5" });
    const info = lookup.resumedChildOf!("child-1");
    expect(info).toEqual({ model: "composer-2.5" });
    expect(info).not.toHaveProperty("effort");
  });

  it("登记表里没有这个 id / 当初没有显式模型（父会话没选、也没换）→ undefined", async () => {
    const { deps } = makeDeps({ withIds: true, parentModel: undefined });
    const link = createCursorSubagentLink({ ...deps, parentModel: undefined });
    const lookup = getSubagentDisplayLookup(link.attach(parentOf("P-r5")))!;
    await call(link, { prompt: "x" });
    expect(lookup.resumedChildOf!("child-1")).toBeUndefined();
    expect(lookup.resumedChildOf!("agent-never-seen")).toBeUndefined();
  });

  it("按父会话分桶：别的父会话派的子代理查不到", async () => {
    const { deps } = makeDeps({
      withIds: true,
      loadCatalog: vi.fn(async () => CATALOG_WITH_DEFAULTS),
    });
    const a = createCursorSubagentLink(deps);
    const lookupA = getSubagentDisplayLookup(a.attach(parentOf("P-A")))!;
    const b = createCursorSubagentLink(deps);
    const lookupB = getSubagentDisplayLookup(b.attach(parentOf("P-B")))!;
    await call(a, { prompt: "x", model: "claude-sonnet-5-5" });
    expect(lookupA.resumedChildOf!("child-1")).toBeDefined();
    expect(lookupB.resumedChildOf!("child-1")).toBeUndefined();
  });
});
