/**
 * watch-task（SSE）路由：心跳 + 订阅前 / 读盘期间客户端已断开的清理。
 *
 * ① 心跳：bootstrap 之后定期发 SSE 注释帧（`: ping`），中间代理 / NAT 空闲掐连接不再静默；
 *    客户端 parseSseEvent 只认 data: 行，注释帧解析为 null 被忽略（用真实 watchTaskStream 钉死）。
 *    流被 cancel 后定时器必须清掉（不泄漏）。
 * ② abort 监听器此前只挂在订阅之后：客户端在订阅之前就断开（signal 已 aborted）时 abort 事件早发完了，
 *    监听器永远不触发——订阅挂到进程结束。现在注册后立刻复查 aborted。
 *
 * 真实路由 + 临时数据目录；订阅 / 退订次数用 task-stream 的包装计数。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-watch-heartbeat-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const hoisted = vi.hoisted(() => ({ active: 0 }));

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
}));
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return {
    ...actual,
    // 包一层：统计「当前仍挂着的订阅」（退订幂等，只在第一次调用时减）
    subscribeTaskStream: (
      taskId: string,
      listener: Parameters<typeof actual.subscribeTaskStream>[1],
    ) => {
      const unsub = actual.subscribeTaskStream(taskId, listener);
      hoisted.active += 1;
      let done = false;
      return () => {
        if (!done) {
          done = true;
          hoisted.active -= 1;
        }
        unsub();
      };
    },
  };
});

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { listTasks } = await import("@/lib/server/task-fs");
const { GET } = await import("@/app/api/tasks/[id]/watch-task/route");
const { watchTaskStream } = await import("@/lib/task-store");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`watch-task-heartbeat-abort DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const skipBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  g[RECOVERY_FLAG] = Promise.resolve();
};
await listTasks();
skipBootRecovery();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `watch-heartbeat ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const ids: string[] = [];
const alloc = async (): Promise<string> => {
  const id = `t_whb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  await writeMeta(makeMeta(id));
  return id;
};

beforeEach(() => {
  hoisted.active = 0;
  skipBootRecovery();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const id of ids.splice(0)) {
    await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  }
});

const watch = (id: string, signal?: AbortSignal): Promise<Response> =>
  GET(new Request(`http://local/api/tasks/${id}/watch-task?tail=50`, { signal }), {
    params: Promise.resolve({ id }),
  });

/** 把 reader 里当前已排队的 chunk 全读出来拼成文本（不等新数据：流里没有时用短超时收口） */
const drain = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  until: (text: string) => boolean,
): Promise<string> => {
  const dec = new TextDecoder();
  let text = "";
  for (let i = 0; i < 200 && !until(text); i++) {
    const r = await Promise.race([
      reader.read(),
      new Promise<null>((res) => setImmediate(() => res(null))),
    ]);
    if (r === null) continue;
    if (r.done) break;
    text += dec.decode(r.value, { stream: true });
  }
  return text;
};

describe("心跳", () => {
  it("bootstrap 之后每个间隔发一帧 `: ping` 注释帧；cancel 后定时器清掉、订阅退掉", async () => {
    const id = await alloc();
    // 只假 interval：fs / 微任务照常（路由里 await 的是真实磁盘读取）
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const res = await watch(id);
    const reader = res.body!.getReader();

    // 先把 bootstrap 帧读完（最后一帧是 thinking_snapshot）
    const boot = await drain(reader, (t) => t.includes('"thinking_snapshot"'));
    expect(boot).toContain('"type":"task"');
    expect(boot, "bootstrap 阶段没有心跳").not.toContain(": ping");
    expect(vi.getTimerCount(), "bootstrap 完成后起了心跳定时器").toBe(1);
    expect(hoisted.active).toBe(1);

    // 过一个心跳间隔（路由内部 20s；这里推 25s 取一帧）
    vi.advanceTimersByTime(25_000);
    const hb = await drain(reader, (t) => t.includes(": ping"));
    expect(hb).toContain(": ping\n\n");

    await reader.cancel();
    expect(vi.getTimerCount(), "cancel 后定时器已清").toBe(0);
    expect(hoisted.active, "cancel 后订阅已退").toBe(0);
  });

  it("终态任务（bootstrap 完直接关流）不起心跳定时器", async () => {
    const id = await alloc();
    await writeMeta({ ...makeMeta(id), repoStatus: "merged" } as unknown as TaskMetaV06);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const res = await watch(id);
    const reader = res.body!.getReader();
    const text = await drain(reader, () => false); // 读到流关闭
    expect(text).toContain('"type":"done"');
    expect(vi.getTimerCount()).toBe(0);
    expect(hoisted.active).toBe(0);
  });

  it("客户端解析：注释帧被 watchTaskStream 忽略，不产生回调、不报错", async () => {
    const enc = new TextEncoder();
    const task = { id: "t1", mode: "chat", runStatus: "idle", repoStatus: "developing", events: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "task", task })}\n\n`));
              c.enqueue(enc.encode(": ping\n\n"));
              c.enqueue(enc.encode(": ping\n\n"));
              c.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );
    try {
      const onTaskUpdate = vi.fn();
      const onEvent = vi.fn();
      const onError = vi.fn();
      await watchTaskStream("t1", { onTaskUpdate, onEvent, onError });
      expect(onTaskUpdate).toHaveBeenCalledTimes(1);
      expect(onEvent).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("订阅前 / 读盘期间客户端已断开", () => {
  it("订阅前复查：请求的 signal 在进路由时就已 aborted → 不留订阅（改前：监听器永不触发、订阅泄漏）", async () => {
    const id = await alloc();
    const ac = new AbortController();
    ac.abort();
    const res = await watch(id, ac.signal);
    expect(hoisted.active, "已断开的请求不能留下订阅").toBe(0);
    // 没有可读的流体（客户端已走）
    expect(res.body).toBeNull();
  });

  it("订阅已挂上之后、读盘 await 期间才断开 → 命中「读盘后复查」：订阅已清、不构造 bootstrap 流", async () => {
    const id = await alloc();
    const ac = new AbortController();
    const pending = watch(id, ac.signal);
    // 不能在 watch() 之后立刻 abort：那时路由还停在最前面的 `await params`、订阅都没挂，
    // 命中的是上一个用例的「订阅前复查」。这里用微任务轮询等到订阅挂上（订阅与进入读盘 await 之间没有别的 await，
    // 读盘是真实磁盘 IO、要等宏任务，所以微任务里看到订阅 = 路由已卡在 getTaskWithTailEvents 上），再 abort。
    for (let i = 0; i < 10_000 && hoisted.active === 0; i++) await Promise.resolve();
    expect(hoisted.active, "abort 之前订阅已挂上（确认走的是读盘后那条复查）").toBe(1);
    ac.abort();
    const res = await pending;
    expect(hoisted.active).toBe(0);
    expect(res.body).toBeNull();
  });

  it("正常连接不受影响：订阅 1 个、cancel 后清 0", async () => {
    const id = await alloc();
    const res = await watch(id, new AbortController().signal);
    const reader = res.body!.getReader();
    await drain(reader, (t) => t.includes('"thinking_snapshot"'));
    expect(hoisted.active).toBe(1);
    await reader.cancel();
    expect(hoisted.active).toBe(0);
  });
});
