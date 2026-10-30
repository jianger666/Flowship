/**
 * PiRunAdapter 收尾后退订 · 接线层（真 createCustomAgent.send + 与 pi 同订阅语义的假会话）
 *
 * R14 Q11-03：PiRunAdapter 的 unsub 以前只存不用——createCustomAgent 的 send 每调一次就
 * `session.subscribe` 一个监听者，收尾后从不退订。同一会话每多一轮、旧 run 的监听者就多留一个：
 * 下一轮的增量（bash 输出 / 工具调用…）会灌进已经结束的旧 run 的 onDelta / onStep（串台），监听者只增不减。
 *
 * 假会话照抄 pi AgentSession 的订阅语义（node_modules/@earendil-works/pi-coding-agent 的 dist/core/agent-session.js：
 * subscribe = push、退订 = indexOf + splice、_emit = for…of 遍历「活」数组），因为「必须在微任务里退订、
 * 不能同步退」就是由这个语义决定的：监听者在派发中途同步 splice 自己，会让排在它后面的监听者漏收这一次事件。
 * 所以 B 用例要把另一个监听者注册在 run 之后。
 *
 * 退订时机的细节（收尾前不退、收尾那一刻不同步退、各条收尾路径都退）不依赖假会话，在
 * tests/pi-run-adapter.test.ts 的「收尾后退订」里直接喂事件钉。
 */
import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ createAgentSession: vi.fn() }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: hoisted.createAgentSession };
});

const { createCustomAgent } = await import("@/lib/server/custom-agent-backend");
const { seedModelsDevCatalogForTest } = await import("@/lib/server/models-dev-catalog");

type Listener = (ev: unknown) => void;

const makeSession = (opts: { unsubThrows?: boolean } = {}) => {
  const listeners: Listener[] = [];
  let unsubCalls = 0;
  return {
    listeners,
    /** 退订函数被调用的次数（含「已经不在数组里」的空调用） */
    get unsubCalls() {
      return unsubCalls;
    },
    sessionFile: "fake-session-file",
    sessionId: "fake-session",
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    state: { messages: [] as unknown[], errorMessage: undefined as string | undefined },
    subscribe: vi.fn((cb: Listener) => {
      listeners.push(cb);
      return () => {
        unsubCalls += 1;
        if (opts.unsubThrows) throw new Error("unsub boom");
        const i = listeners.indexOf(cb);
        if (i !== -1) listeners.splice(i, 1);
      };
    }),
    /** 与 pi 的 _emit 同语义：遍历活数组、没有 try/catch */
    emit(ev: unknown) {
      for (const l of listeners) l(ev);
    },
    prompt: vi.fn(async () => {}),
  };
};

const mk = async (opts: { unsubThrows?: boolean } = {}) => {
  seedModelsDevCatalogForTest({});
  const session = makeSession(opts);
  hoisted.createAgentSession.mockResolvedValue({ session });
  const agent = await createCustomAgent({
    kind: "custom",
    apiKey: "k",
    baseUrl: "http://127.0.0.1:1",
    format: "openai",
    model: { id: "m" },
    local: { cwd: process.cwd() },
  } as never);
  return { session, agent };
};

const SETTLED = { type: "agent_settled" };
const textDelta = (delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta },
});
const bashCall = (id: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "toolcall_end", toolCall: { id, name: "bash", arguments: {} } },
});
const bashOut = (delta: string) => ({ type: "bash_execution_update", delta });
/** 让微任务和一个宏任务都过一遍 */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// 用例超时收紧到 2s：改坏时（比如一开始就收不到事件）要快速失败，不是每条都撑满默认的 5s
describe("PiRunAdapter 收尾后退订 · 接线层（R14 Q11-03）", { timeout: 2000 }, () => {
  it("两轮之后只剩 1 个订阅，第 2 轮的 shell 增量不进第 1 轮的 onDelta（旧：2 个订阅、旧 run 串台）", async () => {
    const { session, agent } = await mk();
    const d1: unknown[] = [];
    const d2: unknown[] = [];
    const r1 = await agent.send("a", { onDelta: (a) => d1.push(a.update) });
    session.emit(textDelta("hi"));
    session.emit(SETTLED);
    await r1.wait();
    // 这里不能 tick：事件先到、之后才 await wait()，wait() 一返回退订就该已经完成——钉的是「退订走微任务、不是宏任务」
    await agent.send("b", { onDelta: (a) => d2.push(a.update) });
    expect(session.listeners.length).toBe(1);
    const before = d1.length;
    session.emit(bashCall("c1"));
    session.emit(bashOut("hello"));
    expect(d1.length).toBe(before);
    expect(d2.length).toBeGreaterThan(0);
  });

  it("wait() 先挂起、续体排在退订之前：续体里发起的下一轮不会被旧 run 的退订误删（退订按监听函数自己 indexOf + splice）", async () => {
    const { session, agent } = await mk();
    const d2: unknown[] = [];
    const r1 = await agent.send("a", {});
    let seenInContinuation = -1;
    // 先挂起 wait()、再收尾——真实调用方的常见写法：续体先于退订的微任务执行（endResolve 先于 queueMicrotask），
    // 并在里面立刻订阅下一轮。settle() 里的注释依赖这个顺序，这里把它钉住，免得注释悄悄失实
    const next = r1.wait().then(() => {
      const p = agent.send("b", { onDelta: (a) => d2.push(a.update) }); // send 的同步部分已经订阅
      seenInContinuation = session.listeners.length;
      return p;
    });
    session.emit(textDelta("hi"));
    session.emit(SETTLED);
    await next;
    expect(seenInContinuation).toBe(2); // 续体里：旧 run 还没退 + 新 run 刚订阅
    await tick();
    expect(session.listeners.length).toBe(1); // 旧 run 退了，新 run 的没被误删
    session.emit(bashCall("c1"));
    session.emit(bashOut("hello"));
    expect(d2.length).toBeGreaterThan(0); // 新 run 照常收到后续事件
  });

  it("多轮不累积：每轮 send 后订阅数是 1，收尾后回到 0（旧：每轮 +1、永不减）", async () => {
    const { session, agent } = await mk();
    for (let i = 0; i < 3; i += 1) {
      const r = await agent.send(`p${i}`, {});
      expect(session.listeners.length).toBe(1);
      session.emit(textDelta(`t${i}`));
      session.emit(SETTLED);
      expect((await r.wait()).status).toBe("finished");
      // 同样不 tick：await wait() 返回时退订已经完成（emit 在 await 之前，退订的微任务排在续跑之前）
      expect(session.listeners.length).toBe(0);
    }
    expect(session.subscribe).toHaveBeenCalledTimes(3);
  });

  it("不能在 agent_settled 的派发里同步退订：排在 run 后面的监听者照样收到这一次事件（pi 的 _emit 遍历活数组）", async () => {
    const { session, agent } = await mk();
    const r = await agent.send("a", {});
    session.emit(textDelta("hi"));
    const tap: string[] = [];
    session.subscribe((ev) => tap.push((ev as { type: string }).type)); // 注册在 run 的监听者之后
    session.emit(SETTLED);
    expect((await r.wait()).status).toBe("finished");
    expect(tap).toEqual(["agent_settled"]);
  });

  it("已收尾的 run 不再收到后续事件（比如 pi 补发的尾巴）", async () => {
    const { session, agent } = await mk();
    const d1: unknown[] = [];
    const r = await agent.send("a", { onDelta: (a) => d1.push(a.update) });
    session.emit(SETTLED);
    await r.wait();
    await tick();
    const before = d1.length;
    session.emit(bashOut("late"));
    expect(d1.length).toBe(before);
  });

  it("收尾之前不退订：中途的事件照常送达", async () => {
    const { session, agent } = await mk();
    const d: unknown[] = [];
    const r = await agent.send("a", { onDelta: (a) => d.push(a.update) });
    session.emit(bashCall("c1"));
    session.emit(bashOut("out-1"));
    const afterFirst = d.length;
    expect(afterFirst).toBeGreaterThan(0);
    await tick(); // 没收尾就不该退订：微任务和宏任务都过一遍再看
    expect(session.listeners.length).toBe(1);
    session.emit(bashOut("out-2"));
    expect(d.length).toBeGreaterThan(afterFirst);
    session.emit(textDelta("done"));
    session.emit(SETTLED);
    expect((await r.wait()).status).toBe("finished");
  });

  it("prompt 抛错（onPromptError 收尾）也退订", async () => {
    const { session, agent } = await mk();
    session.prompt.mockRejectedValueOnce(new Error("boom"));
    const r = await agent.send("a", {});
    expect(await r.wait()).toEqual({ status: "error", result: "boom" });
    await tick();
    expect(session.listeners.length).toBe(0);
  });

  it("取消：cancel() 时监听者必须还在（pi 随后补发的 agent_settled 要靠它收尾），收尾后才退订", async () => {
    const { session, agent } = await mk();
    const r = await agent.send("a", {});
    await r.cancel();
    expect(session.listeners.length).toBe(1);
    session.emit(SETTLED);
    expect((await r.wait()).status).toBe("cancelled");
    await tick();
    expect(session.listeners.length).toBe(0);
  });

  it("同一个 run 只退订一次：重复的 agent_settled、收尾之后才冒出来的 prompt 错误都不再退订，也不改写结果", async () => {
    const { session, agent } = await mk();
    const r = await agent.send("a", {});
    session.emit(textDelta("hi"));
    session.emit(SETTLED);
    session.emit(SETTLED);
    await r.wait();
    r.onPromptError(new Error("late"));
    await tick();
    expect(session.unsubCalls).toBe(1);
    expect((await r.wait()).status).toBe("finished");
  });

  it("退订抛错不外溢：wait() 照常返回、没有未捕获异常（最多是回到旧行为：监听者留着）", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const { session, agent } = await mk({ unsubThrows: true });
      const r = await agent.send("a", {});
      session.emit(textDelta("hi"));
      session.emit(SETTLED);
      expect((await r.wait()).status).toBe("finished");
      await tick();
      expect(session.unsubCalls).toBe(1); // 确实尝试退订过了
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
