/**
 * resumeChatSession claimRun / sendChatMessage ownerInstanceId（复审 G1 / K1）
 * + 复审 H1：owner 释放 claim 后等 rewind 门闩解除须 drain 排队消息
 * + 复审 K1/L2：stop 摘除 claim → owner send 终态 cancelled、不触达 agent；
 *   forceClear 换实例 → 旧 owner send/release 因 instanceId 不匹配全 no-op
 * + 复审 L3：claim 消亡且无 record 时迟到 release 不得调度 drain
 *
 * 验证：owner 在注册瞬间认领首发 → 第三方 send busy；
 * 无 claim 时 idle；owner 早退释放认领；releaseChatRunClaim 幂等；
 * H1 故障注入：claim 释放 + 队列非空 + rewind 结束后 B 被消费。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；ESM 静态 import 会 hoist，
 * 必须先钉 FE_AI_FLOW_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-resume-owner-"));
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  cancelChatRun,
  closeChatSessionUnconditional,
  consumeChatClaimCancelled,
  forceClearChatRun,
  hasChatSession,
  isChatRunActive,
  releaseChatRunClaim,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { endChatRewind, tryBeginChatRewind } = await import(
  "@/lib/server/chat-gate"
);
const { enqueueChatMessage, getChatQueueCount } = await import(
  "@/lib/server/chat-queue"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-runner-resume-owner DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000000999_resume_owner";
const AGENT_ID = "agent_fake_resume_owner";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

/** 假 run：空 stream + finished，让 consumeChatRun 能走完 */
const makeFakeRun = () => ({
  stream: async function* () {
    /* 无事件 */
  },
  wait: async () => ({ status: "finished" as const }),
  cancel: vi.fn(),
});

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `resume owner ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    sessionAgentId: AGENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

beforeEach(async () => {
  mockResume.mockReset();
  mockResume.mockResolvedValue({
    agentId: AGENT_ID,
    close: vi.fn(),
    send: vi.fn().mockResolvedValue(makeFakeRun()),
  });
  // 先关会话再 rm：避免上一轮 void setTaskSessionAgentId 与删目录竞态
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
});

afterEach(async () => {
  closeChatSessionUnconditional(TASK_ID);
  endChatRewind(TASK_ID);
  // 等 close 触发的落盘清锚点完成，避免 afterAll rm 撞上 rename
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("resumeChatSession claimRun / ownerInstanceId（G1 / K1）", () => {
  it("claimRun:true → 返回 instanceId、注册后 runActive，非 owner send 立即 false", async () => {
    const task = asTask(makeMeta(TASK_ID));
    const instanceId = await resumeChatSession(task, BOOT, { claimRun: true });
    expect(instanceId).not.toBeNull();
    expect(typeof instanceId).toBe("number");
    expect(isChatRunActive(TASK_ID)).toBe(true);

    // 第三方不带 ownerInstanceId：见 runActive 早退（busy），认领仍属 owner
    const sent = await sendChatMessage(task, "插队消息");
    expect(sent).toBe("busy");
    expect(isChatRunActive(TASK_ID)).toBe(true);
  });

  it("不带 claimRun → 返回 instanceId、注册后 idle（isChatRunActive===false）", async () => {
    const task = asTask(makeMeta(TASK_ID));
    const instanceId = await resumeChatSession(task, BOOT);
    expect(instanceId).not.toBeNull();
    expect(isChatRunActive(TASK_ID)).toBe(false);
  });

  it("ownerInstanceId + rewind 门闩 → send false 且释放认领", async () => {
    const task = asTask(makeMeta(TASK_ID));
    const ownerId = await resumeChatSession(task, BOOT, { claimRun: true });
    expect(ownerId).not.toBeNull();
    expect(isChatRunActive(TASK_ID)).toBe(true);

    expect(tryBeginChatRewind(TASK_ID)).toBe(true);
    try {
      const sent = await sendChatMessage(task, "owner 消息", undefined, undefined, {
        ownerInstanceId: ownerId!,
      });
      expect(sent).toBe("busy");
      // 认领已释放，否则假 busy 永久挡 flush
      expect(isChatRunActive(TASK_ID)).toBe(false);
    } finally {
      endChatRewind(TASK_ID);
    }
  });

  it("releaseChatRunClaim 无会话时幂等不抛", () => {
    expect(() =>
      releaseChatRunClaim("t_missing_no_session_zzzz", 1),
    ).not.toThrow();
    expect(() => releaseChatRunClaim(TASK_ID, 1)).not.toThrow();
  });
});

describe("releaseChatRunClaim handoff drain（复审 H1）", () => {
  it("owner 撞 rewind 释放 claim 后，门闩解除须消费已排队的 B", async () => {
    const mockSend = vi.fn().mockResolvedValue(makeFakeRun());
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: mockSend,
    });

    const task = asTask(makeMeta(TASK_ID));
    const ownerId = await resumeChatSession(task, BOOT, { claimRun: true });
    expect(ownerId).not.toBeNull();

    // B：模拟并发 chat-reply 已 202 入队
    expect(
      enqueueChatMessage(TASK_ID, {
        agentText: "queued-B",
        displayText: "queued-B",
        enqueuedAt: Date.now(),
        skipPersistEvent: true,
      }).ok,
    ).toBe(true);
    expect(getChatQueueCount(TASK_ID)).toBe(1);

    // owner 撞 rewind 门闩 → send busy → releaseChatRunClaim 调度 deferred drain
    expect(tryBeginChatRewind(TASK_ID)).toBe(true);
    const sent = await sendChatMessage(task, "owner-A", undefined, undefined, {
      ownerInstanceId: ownerId!,
    });
    expect(sent).toBe("busy");
    expect(isChatRunActive(TASK_ID)).toBe(false);
    // 门闩仍在：flush 入口会 return，队列暂存
    expect(getChatQueueCount(TASK_ID)).toBe(1);

    // rewind 因队列非空被拒、释放门闩——补 drain 须把 B 发出去
    endChatRewind(TASK_ID);

    await vi.waitFor(
      () => {
        expect(mockSend).toHaveBeenCalled();
        expect(getChatQueueCount(TASK_ID)).toBe(0);
      },
      { timeout: 5_000, interval: 50 },
    );

    // B 的正文进了 agent.send（owner-A 因门闩未发）
    const prompt = String(mockSend.mock.calls[0]?.[0] ?? "");
    expect(prompt).toContain("queued-B");
  });
});

describe("K1：claim 实例化 token × stop / 实例替换", () => {
  it("resume claim → 用户 stop 摘除 → owner send 返 cancelled、agent.send 不得调用、会话不复活", async () => {
    const mockSend = vi.fn().mockResolvedValue(makeFakeRun());
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: mockSend,
    });

    const task = asTask(makeMeta(TASK_ID));
    const ownerId = await resumeChatSession(task, BOOT, { claimRun: true });
    expect(ownerId).not.toBeNull();
    expect(isChatRunActive(TASK_ID)).toBe(true);

    // 模拟 owner 在 checkpoint await 窗口内用户点停止（stop 路由调 cancelChatRun）：
    // claim 记录的 cancel 必须真正摘除本实例并落 cancelled 标记
    expect(cancelChatRun(TASK_ID)).toBe(true);
    expect(hasChatSession(TASK_ID)).toBe(false);
    expect(isChatRunActive(TASK_ID)).toBe(false);

    // checkpoint 放行后 owner send：终态 cancelled——绝不触达 agent、不复活会话
    const sent = await sendChatMessage(
      task,
      "stop 之后迟到的 owner 消息",
      undefined,
      undefined,
      { ownerInstanceId: ownerId! },
    );
    expect(sent).toBe("cancelled");
    expect(mockSend).not.toHaveBeenCalled();
    expect(hasChatSession(TASK_ID)).toBe(false);
    expect(isChatRunActive(TASK_ID)).toBe(false);
    // runStatus 未被重新拉起（sendChatMessage 只有送达才置 running）
    const meta = await readMetaV06(TASK_ID);
    expect(meta?.runStatus).toBe("idle");
    // cancelled 标记一次性：已被 send 内部消费
    expect(consumeChatClaimCancelled(TASK_ID, ownerId!)).toBe(false);
  });

  it("claim A → forceClear → 实例 B 认领：A 的 send/release 因实例不匹配全 no-op", async () => {
    const sendA = vi.fn().mockResolvedValue(makeFakeRun());
    const sendB = vi.fn().mockResolvedValue(makeFakeRun());
    mockResume
      .mockResolvedValueOnce({ agentId: AGENT_ID, close: vi.fn(), send: sendA })
      .mockResolvedValueOnce({ agentId: AGENT_ID, close: vi.fn(), send: sendB });

    const task = asTask(makeMeta(TASK_ID));
    const ownerA = await resumeChatSession(task, BOOT, { claimRun: true });
    expect(ownerA).not.toBeNull();

    // 懒重启超时兜底：forceClear 摘掉 A（不是用户 stop、无 cancelled 标记）
    forceClearChatRun(TASK_ID);
    expect(hasChatSession(TASK_ID)).toBe(false);

    // 新 owner B 注册并认领（Agent.resume 同一持久化 agentId、instanceId 必不同）
    const ownerB = await resumeChatSession(task, BOOT, { claimRun: true });
    expect(ownerB).not.toBeNull();
    expect(ownerB).not.toBe(ownerA);
    expect(isChatRunActive(TASK_ID)).toBe(true);

    // 迟到的 A owner send：owner_invalid——不发送到 B、不动 B 的任何状态
    const late = await sendChatMessage(
      task,
      "A 迟到的消息",
      undefined,
      undefined,
      { ownerInstanceId: ownerA! },
    );
    expect(late).toBe("owner_invalid");
    expect(sendB).not.toHaveBeenCalled();
    expect(isChatRunActive(TASK_ID)).toBe(true);

    // 迟到的 A release：no-op——不能把 B.runActive 清零（给并发 send 开口子）
    releaseChatRunClaim(TASK_ID, ownerA!);
    expect(isChatRunActive(TASK_ID)).toBe(true);
  });

  it("L3：claim 消亡且当前无 record，迟到 release 不得调度 drain（队列归新 owner）", async () => {
    const task = asTask(makeMeta(TASK_ID));
    const ownerA = await resumeChatSession(task, BOOT, { claimRun: true });
    expect(ownerA).not.toBeNull();

    // stop 摘除 claim → 无 record
    expect(cancelChatRun(TASK_ID)).toBe(true);
    expect(hasChatSession(TASK_ID)).toBe(false);

    // 模拟新 owner 启动预约期间已 202 入队的消息（队列归新 owner 的启动状态机）
    expect(
      enqueueChatMessage(TASK_ID, {
        agentText: "queued-new-owner",
        displayText: "queued-new-owner",
        enqueuedAt: Date.now(),
        skipPersistEvent: true,
      }).ok,
    ).toBe(true);
    expect(getChatQueueCount(TASK_ID)).toBe(1);

    // 迟到 release：record 不存在 → 整段 no-op。若误调度 drain，flush 会因
    // 无会话清队并写 info——断言队列原样保留即可证明没有发生
    releaseChatRunClaim(TASK_ID, ownerA!);
    await new Promise((r) => setTimeout(r, 300));
    expect(getChatQueueCount(TASK_ID)).toBe(1);

    // 收尾：消费 stop 落下的 cancelled 标记（顺带断言 stop 确实落了标记）
    expect(consumeChatClaimCancelled(TASK_ID, ownerA!)).toBe(true);
  });
});

describe("M1：stop / 替换发生在 await agent.send() 期间（send-accept 窗口）", () => {
  /** 可手动放行的挂起 send + 可断言的 fake run */
  const makePendingSend = () => {
    let resolveSend!: (run: unknown) => void;
    let rejectSend!: (err: unknown) => void;
    const gate = new Promise((resolve, reject) => {
      resolveSend = resolve;
      rejectSend = reject;
    });
    const fakeRun = {
      stream: vi.fn(async function* (): AsyncGenerator<never> {
        /* 空 */
      }),
      wait: vi.fn().mockResolvedValue({ status: "cancelled" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const mockSend = vi.fn().mockImplementation(() => gate);
    return { resolveSend, rejectSend, fakeRun, mockSend };
  };

  it("owner send pending 时 stop → resolve 后返 cancelled、run.cancel 被调、不置 running、不启动 consume", async () => {
    const { resolveSend, fakeRun, mockSend } = makePendingSend();
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: mockSend,
    });

    const task = asTask(makeMeta(TASK_ID));
    const ownerId = await resumeChatSession(task, BOOT, { claimRun: true });
    expect(ownerId).not.toBeNull();

    // owner send 已通过前置 token 校验、卡在 await agent.send()
    const sendPromise = sendChatMessage(
      task,
      "pending 期间被停止的消息",
      undefined,
      undefined,
      { ownerInstanceId: ownerId! },
    );
    expect(mockSend).toHaveBeenCalledTimes(1);

    // 用户 stop：claim cancel 摘除实例
    expect(cancelChatRun(TASK_ID)).toBe(true);
    expect(hasChatSession(TASK_ID)).toBe(false);

    // 放行 send → resolve 出迟到 run
    resolveSend(fakeRun);
    const sent = await sendPromise;
    expect(sent).toBe("cancelled");

    // 迟到 run 必须被取消；consume 不得启动；task 不得重新置 running
    expect(fakeRun.cancel).toHaveBeenCalled();
    expect(fakeRun.stream).not.toHaveBeenCalled();
    expect(hasChatSession(TASK_ID)).toBe(false);
    const meta = await readMetaV06(TASK_ID);
    expect(meta?.runStatus).toBe("idle");
  });

  it("非 owner 普通 send pending 时 stop → 同样 cancelled、不复活会话", async () => {
    const { resolveSend, fakeRun, mockSend } = makePendingSend();
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: mockSend,
    });

    const task = asTask(makeMeta(TASK_ID));
    // 不带 claim 的 idle 会话（正常 follow-up 场景）
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(isChatRunActive(TASK_ID)).toBe(false);

    const sendPromise = sendChatMessage(task, "普通 follow-up 消息");
    expect(mockSend).toHaveBeenCalledTimes(1);

    expect(cancelChatRun(TASK_ID)).toBe(true);

    resolveSend(fakeRun);
    const sent = await sendPromise;
    expect(sent).toBe("cancelled");
    expect(fakeRun.cancel).toHaveBeenCalled();
    expect(fakeRun.stream).not.toHaveBeenCalled();
    expect(hasChatSession(TASK_ID)).toBe(false);
    const meta = await readMetaV06(TASK_ID);
    expect(meta?.runStatus).toBe("idle");
  });

  it("owner send pending 时 forceClear + 实例 B 就位 → resolve 后返 owner_invalid、不动 B", async () => {
    const pendingA = makePendingSend();
    const sendB = vi.fn().mockResolvedValue(makeFakeRun());
    mockResume
      .mockResolvedValueOnce({
        agentId: AGENT_ID,
        close: vi.fn(),
        send: pendingA.mockSend,
      })
      .mockResolvedValueOnce({ agentId: AGENT_ID, close: vi.fn(), send: sendB });

    const task = asTask(makeMeta(TASK_ID));
    const ownerA = await resumeChatSession(task, BOOT, { claimRun: true });
    expect(ownerA).not.toBeNull();

    const sendPromise = sendChatMessage(task, "A 的消息", undefined, undefined, {
      ownerInstanceId: ownerA!,
    });
    expect(pendingA.mockSend).toHaveBeenCalledTimes(1);

    // 懒重启兜底：forceClear 摘 A、实例 B 注册并认领
    forceClearChatRun(TASK_ID);
    const ownerB = await resumeChatSession(task, BOOT, { claimRun: true });
    expect(ownerB).not.toBeNull();

    // A 的 send resolve：实例已被替换 → owner_invalid、迟到 run 被取消、B 状态不动
    pendingA.resolveSend(pendingA.fakeRun);
    const sent = await sendPromise;
    expect(sent).toBe("owner_invalid");
    expect(pendingA.fakeRun.cancel).toHaveBeenCalled();
    expect(pendingA.fakeRun.stream).not.toHaveBeenCalled();
    expect(hasChatSession(TASK_ID)).toBe(true);
    expect(isChatRunActive(TASK_ID)).toBe(true);
    expect(sendB).not.toHaveBeenCalled();
  });

  it("send pending 时 stop、随后 send 抛错 → 仍返 cancelled 而非 send_failed", async () => {
    const { rejectSend, mockSend } = makePendingSend();
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: mockSend,
    });

    const task = asTask(makeMeta(TASK_ID));
    const ownerId = await resumeChatSession(task, BOOT, { claimRun: true });
    expect(ownerId).not.toBeNull();

    const sendPromise = sendChatMessage(task, "抛错前被停止", undefined, undefined, {
      ownerInstanceId: ownerId!,
    });
    expect(cancelChatRun(TASK_ID)).toBe(true);

    rejectSend(new Error("network blip"));
    const sent = await sendPromise;
    // send_failed 会让 chat-reply 落 mode 2 重放消息——stop 后必须是终态 cancelled
    expect(sent).toBe("cancelled");
    expect(hasChatSession(TASK_ID)).toBe(false);
    const meta = await readMetaV06(TASK_ID);
    expect(meta?.runStatus).toBe("idle");
  });
});

describe("11 轮复审：send 尾窗复查 / 正向分支 / 迟到收尾门控", () => {
  it("send resolve 后、置 running 写盘窗口内 stop → 返 cancelled、runStatus 回归 idle、不启动 consume", async () => {
    const fakeRun = {
      stream: vi.fn(async function* (): AsyncGenerator<never> {
        /* 空 */
      }),
      wait: vi.fn().mockResolvedValue({ status: "cancelled" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const send = vi.fn().mockResolvedValue(fakeRun);
    mockResume.mockResolvedValue({ agentId: AGENT_ID, close: vi.fn(), send });

    const task = asTask(makeMeta(TASK_ID));
    const ownerId = await resumeChatSession(task, BOOT, { claimRun: true });
    expect(ownerId).not.toBeNull();

    // 在「置 running」的 writeMeta 写盘窗口内触发 stop（send 已 resolve、复查一已过）
    const origWriteMeta = taskFsCore.writeMeta;
    const spy = vi
      .spyOn(taskFsCore, "writeMeta")
      .mockImplementation(async (meta: TaskMetaV06) => {
        if (meta.id === TASK_ID && meta.runStatus === "running") {
          spy.mockRestore();
          cancelChatRun(TASK_ID);
        }
        return origWriteMeta(meta);
      });

    const sent = await sendChatMessage(task, "写盘窗口内被停止", undefined, undefined, {
      ownerInstanceId: ownerId!,
    });
    expect(sent).toBe("cancelled");
    expect(fakeRun.cancel).toHaveBeenCalled();
    expect(fakeRun.stream).not.toHaveBeenCalled();
    expect(hasChatSession(TASK_ID)).toBe(false);
    // 刚写入的 running 必须被撤销（stop 的 idle 不能被迟到状态盖掉）
    const meta = await readMetaV06(TASK_ID);
    expect(meta?.runStatus).toBe("idle");
  });

  it("send 抛错且未 stop → send_failed、会话已关（chat-reply 可走 mode 2）", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"));
    mockResume.mockResolvedValue({ agentId: AGENT_ID, close: vi.fn(), send });

    const task = asTask(makeMeta(TASK_ID));
    const ownerId = await resumeChatSession(task, BOOT, { claimRun: true });
    expect(ownerId).not.toBeNull();

    const sent = await sendChatMessage(task, "会失败的消息", undefined, undefined, {
      ownerInstanceId: ownerId!,
    });
    expect(sent).toBe("send_failed");
    expect(hasChatSession(TASK_ID)).toBe(false);
  });

  it("无会话 + 非 owner → no_session", async () => {
    const task = asTask(makeMeta(TASK_ID));
    expect(hasChatSession(TASK_ID)).toBe(false);
    expect(await sendChatMessage(task, "无会话消息")).toBe("no_session");
  });

  it("迟到的旧 run 取消收尾：新实例已接管 → 不清新会话队列、不关新会话", async () => {
    // 可控阻塞 run：release 后 stream 结束、wait 返 cancelled
    let release!: () => void;
    const gateP = new Promise<void>((r) => {
      release = r;
    });
    const blockingRun = {
      stream: async function* (): AsyncGenerator<never> {
        await gateP;
      },
      wait: async () => ({ status: "cancelled" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const sendA = vi.fn().mockResolvedValue(blockingRun);
    mockResume.mockResolvedValueOnce({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: sendA,
    });

    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "旧实例的消息")).toBe("sent");

    // 懒重启：forceClear 摘旧实例、注册新实例 B
    forceClearChatRun(TASK_ID);
    mockResume.mockResolvedValueOnce({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: vi.fn(),
    });
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();

    // B 的队列里有一条排队消息
    enqueueChatMessage(TASK_ID, {
      agentText: "排队给 B",
      displayText: "排队给 B",
      enqueuedAt: Date.now(),
    });
    expect(getChatQueueCount(TASK_ID)).toBe(1);

    // 放行旧 run → 迟到的取消收尾：实例门控必须拒绝清 B 的队列 / 关 B 的会话
    release();
    await new Promise((r) => setTimeout(r, 150));
    expect(getChatQueueCount(TASK_ID)).toBe(1);
    expect(hasChatSession(TASK_ID)).toBe(true);
  });
});
