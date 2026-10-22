/**
 * 旁路群答疑 run 的信号不得动属主 UI（第三轮 review D9-01）
 *
 * 事实（D9 two-client S4）：task 的 build / plan 正在吐字时，群里有人提问 → 旁路答疑 run 写一条
 * `assistant_message`、收尾发 `done`。路由对 `assistant_delta` 判 origin 跳过，但 `event` / `done` 帧
 * 不带 origin；页面 `onEvent` 见到 assistant_message、`onDone` 无条件 `clearStreaming()`——
 * 属主**正在吐字**的流式气泡被清空，用户只看到后半句。旁路 done 在 runStatus 非 running 的收尾期
 * 还会把属主的 run latch 提前放掉。
 *
 * 修法：
 *   - 服务端 `done` 帧带 `origin`（旁路才有；属主主链的 done 没有这个字段，形状不变）；
 *   - 客户端 `onDone(task, ok, origin)`；`event` 上本来就有 `meta.groupRun`（落盘时打标）；
 *   - 判定收成纯函数（owner-run-signal）：只有属主主链的 assistant_message / done 才清属主流式态 / 放 latch。
 *
 * 钉死：纯函数的行为表；以及真实路由 + 真实 `writeOwnedEventAndPublish(…, origin)` + 真实客户端解析
 * （watchTaskStream）的端到端——用页面同一组纯函数驱动一个「属主 UI 状态机」，旁路穿插进来不影响属主气泡。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { RunStatus, Task, TaskEvent } from "@/lib/types";
import {
  isSideRunEvent,
  planDoneFrame,
  shouldClearStreamingOnEvent,
} from "@/lib/owner-run-signal";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-side-run-owner-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({ Agent: { create: vi.fn(), resume: vi.fn() } }));

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { listTasks } = await import("@/lib/server/task-fs");
const { GET } = await import("@/app/api/tasks/[id]/watch-task/route");
const { watchTaskStream } = await import("@/lib/task-store");
const { publishTaskStreamEvent, writeOwnedEventAndPublish } = await import(
  "@/lib/server/task-stream"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`side-run-owner-isolation DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const skipBootRecovery = (): void => {
  (globalThis as unknown as Record<string, Promise<void> | undefined>)[RECOVERY_FLAG] =
    Promise.resolve();
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ev = (p: Partial<TaskEvent> & Pick<TaskEvent, "kind">): TaskEvent => ({
  id: "e1",
  ts: 1,
  text: "",
  ...p,
});

// ---------- 纯函数 ----------

describe("owner-run-signal 纯函数", () => {
  it("isSideRunEvent：只认 meta.groupRun 非空字符串", () => {
    expect(isSideRunEvent(ev({ kind: "assistant_message", meta: { groupRun: "tag1" } }))).toBe(true);
    for (const meta of [undefined, {}, { groupRun: "" }, { groupRun: "  " }, { groupRun: 1 }, { groupRun: null }]) {
      expect(isSideRunEvent(ev({ kind: "assistant_message", meta: meta as TaskEvent["meta"] }))).toBe(false);
    }
  });

  it("shouldClearStreamingOnEvent：属主的 assistant_message 才清；旁路的、其它 kind 的都不清", () => {
    expect(shouldClearStreamingOnEvent(ev({ kind: "assistant_message" }))).toBe(true);
    expect(shouldClearStreamingOnEvent(ev({ kind: "assistant_message", meta: { groupRun: "t" } }))).toBe(false);
    for (const kind of ["tool_call", "tool_result", "info", "thinking", "user_reply", "error"] as const) {
      expect(shouldClearStreamingOnEvent(ev({ kind }))).toBe(false);
    }
  });

  describe("planDoneFrame", () => {
    const plan = (over: Partial<Parameters<typeof planDoneFrame>[0]> = {}) =>
      planDoneFrame({
        origin: undefined,
        doneUpdatedAt: 10,
        currentUpdatedAt: 5,
        runStatus: "idle" as RunStatus,
        ...over,
      });

    it("属主主链 done（无 origin）+ 终态：清流式、吸收快照、放 latch、清直播缓冲（与改前一致）", () => {
      expect(plan()).toEqual({
        clearStreaming: true,
        absorbSnapshot: true,
        releaseRunLatch: true,
      });
    });

    it("属主主链 done 但 runStatus 仍是 running：清流式、吸收，不放 latch", () => {
      expect(plan({ runStatus: "running" })).toEqual({
        clearStreaming: true,
        absorbSnapshot: true,
        releaseRunLatch: false,
      });
    });

    it("属主主链的过期 done（updatedAt 比本地旧）：清流式但不吸收、不放 latch（唤醒后迟到的失败 done 不得解锁）", () => {
      expect(plan({ doneUpdatedAt: 3, currentUpdatedAt: 5 })).toEqual({
        clearStreaming: true,
        absorbSnapshot: false,
        releaseRunLatch: false,
      });
    });

    it("旁路 run 的 done（有 origin）：什么属主态都不动——不清流式、不放 latch；快照照常吸收（按 updatedAt 守卫）", () => {
      expect(plan({ origin: "side_tag", runStatus: "idle" })).toEqual({
        clearStreaming: false,
        absorbSnapshot: true,
        releaseRunLatch: false,
      });
      expect(plan({ origin: "side_tag", doneUpdatedAt: 3, currentUpdatedAt: 5 })).toEqual({
        clearStreaming: false,
        absorbSnapshot: false,
        releaseRunLatch: false,
      });
    });

    it("没有本地快照（currentUpdatedAt 缺省）：属主 done 照常吸收", () => {
      expect(plan({ currentUpdatedAt: undefined }).absorbSnapshot).toBe(true);
    });

    it("origin 是空串 / 空白：视为没有（不当旁路）", () => {
      expect(plan({ origin: "" }).clearStreaming).toBe(true);
      expect(plan({ origin: null }).clearStreaming).toBe(true);
    });
  });
});

// ---------- 端到端：真实路由 + 真实旁路写入 + 真实客户端解析 ----------

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `side-run ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const ids: string[] = [];
const alloc = async (): Promise<string> => {
  const id = `t_sro_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  await writeMeta(makeMeta(id));
  return id;
};

beforeEach(() => skipBootRecovery());
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const id of ids.splice(0)) {
    await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  }
});

const routeAsFetch = (res: Response) => {
  const routeReader = res.body!.getReader();
  return vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
    init?.signal?.addEventListener("abort", () => void routeReader.cancel().catch(() => {}), {
      once: true,
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const r = await routeReader.read();
        if (r.done) c.close();
        else c.enqueue(r.value);
      },
      cancel: () => routeReader.cancel().catch(() => {}),
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
};

/** 页面 onEvent / onDone 的属主 UI 状态：流式气泡 + run latch */
interface OwnerUi {
  streaming: string;
  runActive: boolean;
  doneFrames: Array<{ origin?: string }>;
}

describe("D9-01 端到端：属主吐字时旁路答疑穿插进来", () => {
  it("旁路 assistant_message / done 不清属主的流式气泡；属主自己的 assistant_message 才清", async () => {
    const id = await alloc();
    const res = await GET(new Request(`http://local/api/tasks/${id}/watch-task?tail=50`), {
      params: Promise.resolve({ id }),
    });
    vi.stubGlobal("fetch", routeAsFetch(res));

    const ui: OwnerUi = { streaming: "", runActive: true, doneFrames: [] };
    const ctrl = new AbortController();
    let bootstrapped = false;
    const finished = watchTaskStream(
      id,
      {
        onTaskUpdate: () => {
          bootstrapped = true;
        },
        onAssistantDelta: (t) => {
          ui.streaming += t;
        },
        // —— 与 tasks/[id]/page.tsx 的 onEvent / onDone 用同一组纯函数 ——
        onEvent: (e) => {
          if (shouldClearStreamingOnEvent(e)) ui.streaming = "";
        },
        onDone: (t, _ok, origin) => {
          ui.doneFrames.push({ origin });
          const p = planDoneFrame({
            origin,
            doneUpdatedAt: t.updatedAt,
            currentUpdatedAt: 0,
            runStatus: t.runStatus,
          });
          if (p.clearStreaming) ui.streaming = "";
          if (p.releaseRunLatch) ui.runActive = false;
        },
      },
      ctrl.signal,
    );
    for (let i = 0; i < 100 && !bootstrapped; i++) await sleep(20);
    expect(bootstrapped).toBe(true);

    const lease = () => true;
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 100 && !cond(); i++) await sleep(20);
      expect(cond()).toBe(true);
    };

    // 属主主 run 正在吐字
    publishTaskStreamEvent(id, { kind: "assistant_delta", text: "属主这一段回答正在流式输出…" });
    await waitFor(() => ui.streaming === "属主这一段回答正在流式输出…");

    // 群里有人提问 → 旁路 run 落一条 assistant_message（带 origin，meta.groupRun 打标）、收尾发 done（带 origin）
    await writeOwnedEventAndPublish(id, lease, { kind: "assistant_message", text: "旁路回答" }, "side_run_tag_1");
    publishTaskStreamEvent(id, {
      kind: "done",
      task: { ...makeMeta(id), events: [] } as unknown as Task,
      ok: true,
      origin: "side_run_tag_1",
    });
    await waitFor(() => ui.doneFrames.length === 1);
    expect(ui.doneFrames[0]!.origin).toBe("side_run_tag_1"); // done 帧确实带了 origin 过来
    // 旁路穿插之后：属主气泡完好、latch 没被放
    expect(ui.streaming).toBe("属主这一段回答正在流式输出…");
    expect(ui.runActive).toBe(true);

    // 主 run 继续吐字：气泡是完整的前半句 + 后半句（改前只剩后半句）
    publishTaskStreamEvent(id, { kind: "assistant_delta", text: "，主流继续" });
    await waitFor(() => ui.streaming.endsWith("，主流继续"));
    expect(ui.streaming).toBe("属主这一段回答正在流式输出…，主流继续");

    // 属主自己的 assistant_message 落盘 → 正式清流式气泡（不带 origin / groupRun）
    await writeOwnedEventAndPublish(id, lease, { kind: "assistant_message", text: "属主完整回答" });
    await waitFor(() => ui.streaming === "");

    // 属主自己的 done（无 origin，终态）→ 放 latch
    publishTaskStreamEvent(id, {
      kind: "done",
      task: { ...makeMeta(id), runStatus: "idle", events: [] } as unknown as Task,
      ok: true,
    });
    await waitFor(() => ui.doneFrames.length === 2);
    expect(ui.doneFrames[1]!.origin).toBeUndefined(); // 属主 done 的帧形状不变：没有 origin 字段
    expect(ui.runActive).toBe(false);

    ctrl.abort();
    await finished.catch(() => {});
  });
});
