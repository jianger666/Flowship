/**
 * tool_call running 去重（tryMarkToolCallRunningSeen）的两个缺口：
 *
 * ① 去重 key 只有 callId、全局共享：自定义 provider 常见 `call_0` 之类的短序号 id，
 *    不同任务之间会撞，后到的任务的 running 事件被整条吞掉（工具卡没有开始帧）。→ key 带 taskId。
 * ② 先标记后写盘：写盘没成功（返回 null / 抛错 / 写前失主）时标记不回滚，
 *    同 callId 之后的重发（重连续流 / SDK 补 args 的第二次 running）被当成「已写过」吞掉。→ 没写成就回滚。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type WrittenEvent = {
  kind: string;
  text?: string;
  meta?: Record<string, unknown>;
};

type WriteOwnedFn = (
  taskId: string,
  stillCurrent: () => boolean,
  event: WrittenEvent,
) => Promise<unknown>;
type AppendEventFn = (
  taskId: string,
  event: WrittenEvent,
  lease?: () => boolean,
) => Promise<unknown>;

const writeOwnedEventAndPublish = vi.fn<WriteOwnedFn>(async () => ({ id: "ev" }));
const appendEvent = vi.fn<AppendEventFn>(async () => ({ id: "ev" }));

vi.mock("@/lib/server/task-fs", () => ({
  getTask: vi.fn(),
  patchActionIfOwner: vi.fn(),
  appendEvent: (taskId: string, event: WrittenEvent, lease?: () => boolean) =>
    appendEvent(taskId, event, lease),
}));

vi.mock("@/lib/server/failpoints", () => ({
  failpoint: vi.fn(async () => {}),
}));

vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return {
    ...actual,
    writeOwnedEventAndPublish: (
      taskId: string,
      stillCurrent: () => boolean,
      event: WrittenEvent,
    ) => writeOwnedEventAndPublish(taskId, stillCurrent, event),
    publish: vi.fn(),
    publishIfCurrent: vi.fn(),
  };
});

vi.mock("@/lib/server/tool-result-persist", () => ({
  buildToolResultMeta: vi.fn(
    async (input: { callId: string; rawName: string; msgStatus: string }) => ({
      callId: input.callId,
      name: input.rawName,
      status: input.msgStatus === "error" ? "error" : "ok",
      output: "ok",
    }),
  ),
}));

const { handleSdkMessage, __resetToolCallRunningSeenForTest } = await import(
  "@/lib/server/sdk-message-handler"
);
import type { AssistantBufferCtx } from "@/lib/server/sdk-message-handler";

const newCtx = (): AssistantBufferCtx => ({ buffer: "", flush: async () => {} });
const leaseOk = () => true;

const runningMsg = (callId: string, name = "shell") =>
  ({
    type: "tool_call",
    name,
    call_id: callId,
    status: "running",
    args: { command: "echo hi" },
  }) as never;

const toolCallWrites = (): WrittenEvent[] =>
  writeOwnedEventAndPublish.mock.calls
    .map((c) => c[2])
    .filter((e) => e.kind === "tool_call");

beforeEach(() => {
  writeOwnedEventAndPublish.mockReset();
  writeOwnedEventAndPublish.mockImplementation(async () => ({ id: "ev" }));
  appendEvent.mockReset();
  appendEvent.mockImplementation(async () => ({ id: "ev" }));
  __resetToolCallRunningSeenForTest();
});

describe("running 去重 key 带 taskId", () => {
  it("两个任务用同一个 call_id（自定义 provider 的短序号）→ 各自都落 running（改前：后到的被吞）", async () => {
    await handleSdkMessage("task-A", runningMsg("call_0"), newCtx(), leaseOk);
    await handleSdkMessage("task-B", runningMsg("call_0"), newCtx(), leaseOk);

    const tasks = writeOwnedEventAndPublish.mock.calls.map((c) => c[0]);
    expect(tasks).toEqual(["task-A", "task-B"]);
  });

  it("同一任务同 call_id 的第二次 running 仍然被去重（原有行为不变）", async () => {
    await handleSdkMessage("task-A", runningMsg("call_dup"), newCtx(), leaseOk);
    await handleSdkMessage("task-A", runningMsg("call_dup"), newCtx(), leaseOk);
    expect(toolCallWrites()).toHaveLength(1);
  });
});

describe("running 写盘没成功 → 回滚去重标记，重发能再写", () => {
  it("写盘返回 null（落盘失败被吞 / 失主拒写）→ 同 call_id 重发再写一次（改前：被吞）", async () => {
    writeOwnedEventAndPublish.mockImplementationOnce(async () => null);

    await handleSdkMessage("task-A", runningMsg("call_retry"), newCtx(), leaseOk);
    await handleSdkMessage("task-A", runningMsg("call_retry"), newCtx(), leaseOk);
    // 第一次没写成、第二次写成 = 共 2 次调用
    expect(toolCallWrites()).toHaveLength(2);

    // 第二次成功之后，第三次重发又该被去重
    await handleSdkMessage("task-A", runningMsg("call_retry"), newCtx(), leaseOk);
    expect(toolCallWrites()).toHaveLength(2);
  });

  it("写盘抛错 → 异常照常往上抛，且标记已回滚（重发能再写）", async () => {
    writeOwnedEventAndPublish.mockImplementationOnce(async () => {
      throw new Error("EIO");
    });

    await expect(
      handleSdkMessage("task-A", runningMsg("call_throw"), newCtx(), leaseOk),
    ).rejects.toThrow("EIO");
    await handleSdkMessage("task-A", runningMsg("call_throw"), newCtx(), leaseOk);
    expect(toolCallWrites()).toHaveLength(2);
  });

  it("写前已失主（await 之后 stillCurrent=false）→ 不写、标记回滚；新实例重发能写", async () => {
    // 先探路：正常写一条，数出「到写盘前 handler 一共查了几次 lease」——
    // 最后一次就是「标记之后、写盘之前」的那道复查，只让它翻 false
    let leaseCalls = 0;
    let callsAtWrite = 0;
    writeOwnedEventAndPublish.mockImplementationOnce(async () => {
      callsAtWrite = leaseCalls;
      return { id: "ev" };
    });
    await handleSdkMessage("task-A", runningMsg("call_probe"), newCtx(), () => {
      leaseCalls++;
      return true;
    });
    expect(callsAtWrite).toBeGreaterThanOrEqual(2);
    writeOwnedEventAndPublish.mockClear();

    let n = 0;
    const flipAtPreWriteCheck = () => {
      n++;
      return n < callsAtWrite;
    };
    await handleSdkMessage(
      "task-A",
      runningMsg("call_lost"),
      newCtx(),
      flipAtPreWriteCheck,
    );
    expect(toolCallWrites(), "写前已失主：不写").toHaveLength(0);

    // 新实例（lease 正常）重发同一个 call_id → 必须能落（改前：标记留着、被吞）
    await handleSdkMessage("task-A", runningMsg("call_lost"), newCtx(), leaseOk);
    expect(toolCallWrites()).toHaveLength(1);
  });

  it("提问消音分支（appendEvent）同样：写盘抛错后标记回滚", async () => {
    const ctx = newCtx();
    ctx.askSeen = true;
    appendEvent.mockImplementationOnce(async () => {
      throw new Error("ENOSPC");
    });

    await expect(
      handleSdkMessage("task-A", runningMsg("call_muted", "read"), ctx, leaseOk),
    ).rejects.toThrow("ENOSPC");
    await handleSdkMessage("task-A", runningMsg("call_muted", "read"), ctx, leaseOk);
    expect(appendEvent).toHaveBeenCalledTimes(2);
  });
});
