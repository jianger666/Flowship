/**
 * Cursor 路径的子代理工具 `subagent`：入参 → 模型 / effort 解析 → 嵌套子 agent → 结果，
 * 以及「父 run 取消 → 子 run 一起停」的联动（回调拿不到 AbortSignal，必须自己接力）。
 *
 * 不碰真实 SDK：子 agent / 模型目录都是注入的假依赖。真实 SDK 下的行为（Sonnet 5.5 + effort 真的生效、
 * 取消 58ms 内子 shell 进程消失、取消后同一 agent 下一轮照常、resume 路径）见 docs/HANDOFF.md 的实测记录。
 */
import { describe, expect, it, vi } from "vitest";

import {
  createCursorSubagentLink,
  CURSOR_SUBAGENT_DESCRIPTION,
  CURSOR_SUBAGENT_READONLY_TOOLS,
  type CursorSubagentDeps,
  type SubagentChildAgent,
  type SubagentChildRun,
} from "@/lib/server/cursor-subagent";
import type { ModelCatalogEntry } from "@/lib/subagent-spec";

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
  over: Partial<CursorSubagentDeps> & { run?: FakeRunOpts; sendDelay?: Promise<void>; createDelay?: Promise<void> } = {},
) => {
  const runs: ReturnType<typeof fakeRun>[] = [];
  const children: Array<SubagentChildAgent & { close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }> = [];
  const loadCatalog = vi.fn(async () => CATALOG);
  const createChild = vi.fn(async (opts: { model?: unknown; explore: boolean }) => {
    void opts; // 形参只为让 mock.calls 带类型
    if (over.createDelay) await over.createDelay;
    const child = {
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
  });
  const deps: CursorSubagentDeps = {
    parentModel: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
    loadCatalog,
    createChild,
    ...(over.parentModel !== undefined ? { parentModel: over.parentModel } : {}),
    ...(over.loadCatalog ? { loadCatalog: over.loadCatalog } : {}),
  };
  return { deps, loadCatalog: over.loadCatalog ?? loadCatalog, createChild, runs, children };
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
  it("描述写明与原生 task 的区别、可并行；schema 含 model / effort / subagentType", () => {
    const { deps } = makeDeps();
    const { tool } = createCursorSubagentLink(deps);
    expect(tool.description).toBe(CURSOR_SUBAGENT_DESCRIPTION);
    expect(CURSOR_SUBAGENT_DESCRIPTION).toContain("原生 task");
    expect(CURSOR_SUBAGENT_DESCRIPTION).toContain("并行");
    const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(["description", "effort", "model", "prompt", "subagentType"]);
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["prompt"]);
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
