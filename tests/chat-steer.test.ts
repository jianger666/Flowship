/**
 * chat「立即发送」steer 插话的 runner 层（canSteerChatRun / steerChatRun / flushChatAssistantBuffer）
 *
 * 用真实 chat-runner + 假 SDK run 驱动：run 在流里挂着时，steer 把消息插进这一轮；
 * 各种落定结果（收下 / 要求当后续消息 / 抛错 / run 被停止 / run 先结束）都得有确定的归宿，
 * 消息不丢、也不重复投递。
 *
 * 并行隔离：先钉 FLOWSHIP_DATA_DIR 再动态 import。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-steer-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const { readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  canSteerChatRun,
  cancelChatRun,
  closeChatSessionUnconditional,
  composeChatPrompt,
  flushChatAssistantBuffer,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
  steerChatRun,
} = await import("@/lib/server/chat-runner");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`chat-steer DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const TASK_ID = "t_1700000004000_steer";
const AGENT_ID = "agent_fake_steer";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `steer ${id}`,
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

type SteerOutcome = "complete_delivered" | "revert_to_followup";

/** 一个在流里挂着的假 run：release() 放行流（自然结束）、cancel() 也放行并让 wait 报 cancelled */
const makeRun = (opts: {
  steer?: (text: string) => Promise<SteerOutcome>;
  /** 流里先吐的文本（模拟 AI 说了半句） */
  textBeforeHold?: string;
  /** 流结束后 wait() 仍挂着（模拟「流已完、收尾还没走完」的空窗） */
  holdWait?: Promise<void>;
}) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let cancelled = false;
  const run: Record<string, unknown> = {
    stream: async function* () {
      if (opts.textBeforeHold) {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: opts.textBeforeHold }] },
        };
      }
      await gate;
    },
    wait: async () => {
      await gate;
      if (opts.holdWait) await opts.holdWait;
      return { status: cancelled ? ("cancelled" as const) : ("finished" as const) };
    },
    cancel: vi.fn().mockImplementation(async () => {
      cancelled = true;
      release();
    }),
  };
  if (opts.steer) run.steer = vi.fn(opts.steer);
  return { run, release };
};

const startRun = async (
  run: Record<string, unknown>,
): Promise<{ send: ReturnType<typeof vi.fn> }> => {
  const send = vi.fn().mockResolvedValue(run);
  mockResume.mockResolvedValue({
    agentId: AGENT_ID,
    close: vi.fn(),
    send,
  });
  const task = asTask(makeMeta(TASK_ID));
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  expect(await sendChatMessage(task, "先干这个")).toBe("sent");
  expect(isChatRunActive(TASK_ID)).toBe(true);
  return { send };
};

beforeEach(async () => {
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
});

afterEach(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("canSteerChatRun：什么时候能插话", () => {
  it("没有会话 → 不能", () => {
    expect(canSteerChatRun("t_no_such_task")).toBe(false);
  });

  it("run 在跑且本轮 run 带 steer（Cursor 本地）→ 能", async () => {
    const { run } = makeRun({ steer: async () => "complete_delivered" });
    await startRun(run);
    expect(canSteerChatRun(TASK_ID)).toBe(true);
  });

  it("本轮 run 没有 steer（pi 自研后端形态）→ 不能，调用方回退打断重发", async () => {
    const { run } = makeRun({});
    await startRun(run);
    expect(canSteerChatRun(TASK_ID)).toBe(false);
  });

  it("流结束后（收尾空窗 / 空闲）→ 不能：句柄已清，不会对已结束的 run 插话", async () => {
    const { run, release } = makeRun({
      steer: async () => "complete_delivered",
    });
    await startRun(run);
    release();
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });
    expect(hasChatSession(TASK_ID)).toBe(true); // 会话保留、等下一条
    expect(canSteerChatRun(TASK_ID)).toBe(false);
  });

  it("流已结束但收尾还没走完（runActive 仍为 true）→ 不能：这一轮已经不会再读新消息", async () => {
    let releaseWait!: () => void;
    const holdWait = new Promise<void>((r) => {
      releaseWait = r;
    });
    const { run, release } = makeRun({
      steer: async () => "complete_delivered",
      holdWait,
    });
    await startRun(run);
    expect(canSteerChatRun(TASK_ID)).toBe(true);

    release(); // 流结束；wait() 仍被 holdWait 拖着 → 收尾未完成
    await new Promise((r) => setTimeout(r, 50));
    expect(isChatRunActive(TASK_ID)).toBe(true);
    expect(canSteerChatRun(TASK_ID)).toBe(false);

    releaseWait();
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });
  });

  it("下一轮 send 起手就作废上一轮句柄，之后 steer 打到新一轮的 run 上", async () => {
    const first = makeRun({ steer: async () => "complete_delivered" });
    const { send } = await startRun(first.run);
    first.release();
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });

    const second = makeRun({ steer: async () => "complete_delivered" });
    send.mockResolvedValue(second.run);
    expect(await sendChatMessage(asTask(makeMeta(TASK_ID)), "第二轮")).toBe(
      "sent",
    );
    expect(canSteerChatRun(TASK_ID)).toBe(true);

    expect(await steerChatRun(TASK_ID, "插话")).toBe("delivered");
    expect(first.run.steer).not.toHaveBeenCalled();
    expect(second.run.steer).toHaveBeenCalledWith("插话");
  });
});

describe("steerChatRun：落定结果", () => {
  it("这一轮收下（complete_delivered）→ delivered，prompt 原样交给 run.steer", async () => {
    const { run } = makeRun({ steer: async () => "complete_delivered" });
    await startRun(run);

    expect(await steerChatRun(TASK_ID, "换个思路")).toBe("delivered");
    expect(run.steer).toHaveBeenCalledWith("换个思路");
  });

  it("SDK 要求当后续消息发（revert_to_followup）→ followup", async () => {
    const { run } = makeRun({ steer: async () => "revert_to_followup" });
    await startRun(run);

    expect(await steerChatRun(TASK_ID, "换个思路")).toBe("followup");
  });

  it("steer 抛错但会话还在 → followup（消息不丢）", async () => {
    const { run } = makeRun({
      steer: async () => {
        throw new Error("network blip");
      },
    });
    await startRun(run);

    expect(await steerChatRun(TASK_ID, "换个思路")).toBe("followup");
  });

  it("steer 挂着期间用户停止（会话被摘除）→ cancelled，不会被当后续消息重发", async () => {
    // steer 永不落定：模拟主 AI 卡在长工具里；停止后 run.wait 报 cancelled
    const { run } = makeRun({ steer: () => new Promise<SteerOutcome>(() => {}) });
    await startRun(run);

    const pending = steerChatRun(TASK_ID, "换个思路", { settleGraceMs: 20 });
    expect(cancelChatRun(TASK_ID)).toBe(true);

    expect(await pending).toBe("cancelled");
  });

  it("run 自然结束而 steer 迟迟不落定 → 宽限后按 followup 收尾，不让「立即发送」永远悬着", async () => {
    const { run, release } = makeRun({
      steer: () => new Promise<SteerOutcome>(() => {}),
    });
    await startRun(run);

    const pending = steerChatRun(TASK_ID, "换个思路", { settleGraceMs: 20 });
    release();

    expect(await pending).toBe("followup");
  });

  it("没有会话 / 本轮 run 不支持 steer → followup（调用方按普通消息处理）", async () => {
    expect(await steerChatRun("t_no_such_task", "x")).toBe("followup");

    const { run } = makeRun({});
    await startRun(run);
    expect(await steerChatRun(TASK_ID, "x")).toBe("followup");
  });
});

describe("flushChatAssistantBuffer：插话前先落 AI 的半截话", () => {
  it("流里已缓冲的半截回复被立即落成 assistant_message（不等工具 / 收尾）", async () => {
    const { run, release } = makeRun({
      steer: async () => "complete_delivered",
      textBeforeHold: "我先把这个文件读一下",
    });
    await startRun(run);

    // 等流把那段文本吃进缓冲（assistant 事件经 handleSdkMessage 异步处理）；
    // 此时文本只在缓冲里、还没落盘（遇到工具调用 / 收尾才写）
    await new Promise((r) => setTimeout(r, 50));
    expect(
      (await readEvents(TASK_ID)).some((e) => e.kind === "assistant_message"),
    ).toBe(false);

    await flushChatAssistantBuffer(TASK_ID);

    const evs = await readEvents(TASK_ID);
    const assistant = evs.filter((e) => e.kind === "assistant_message");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatchObject({ text: "我先把这个文件读一下" });

    // 收尾时不会重复落同一段
    release();
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });
    const after = (await readEvents(TASK_ID)).filter(
      (e) => e.kind === "assistant_message",
    );
    expect(after).toHaveLength(1);
  });

  it("没有会话 / 没有可冲刷的东西 → 安静返回", async () => {
    await expect(flushChatAssistantBuffer("t_no_such_task")).resolves.toBeUndefined();
  });
});

describe("composeChatPrompt：与普通 send 同口径", () => {
  it("只有正文 → 原样", () => {
    expect(composeChatPrompt("你好")).toBe("你好");
  });

  it("带图片与路径 → 追加两段标记", () => {
    const p = composeChatPrompt("看下", ["/tmp/a.png"], ["/tmp/b.txt"]);
    expect(p.startsWith("看下\n")).toBe(true);
    expect(p).toContain("[ATTACHED_IMAGES]");
    expect(p).toContain("  1. /tmp/a.png");
    expect(p).toContain("[ATTACHED_PATHS]");
    expect(p).toContain("  1. /tmp/b.txt");
  });

  it("sendChatMessage 用的就是它（不再各自拼一份）", async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), "src/lib/server/chat-runner.ts"),
      "utf-8",
    );
    const start = src.indexOf("export const sendChatMessage = async");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("\nexport const ", start + 10));
    expect(body).toContain(
      "composeChatPrompt(text, imagePaths, attachmentPaths)",
    );
    // 附件段文案不许在 sendChatMessage 里再拼一份（steer 与普通 send 喂给模型的文本必须一致）
    expect(body).not.toContain("[ATTACHED_IMAGES]");
    expect(body).not.toContain("[ATTACHED_PATHS]");
  });
});
