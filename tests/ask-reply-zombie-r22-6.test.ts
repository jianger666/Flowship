/**
 * R22-6：ask-reply 僵尸态兜底——先锁内条件写 runStatus，再决定是否落「Agent 已断开」
 *
 * 回归：并发后继已把盘上写成 running 时，不得留下假断开 error 事件、应 409 + info。
 * 对照：真僵尸（仍 awaiting_user）→ 410 + error 事件 + runStatus=error。
 *
 * 手法：DATA_DIR 隔离 + 真 task-fs；mock pending（内存已丢）与 agent 唤醒重依赖。
 * 竞态窗口：存图 await 内把盘上翻成 running（模拟后继 B 接管）。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ask-reply-r22-6-"));
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

const mockSaveImageAttachments = vi.fn();
vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments: (...args: unknown[]) =>
    mockSaveImageAttachments(...args),
}));

vi.mock("@/lib/server/chat-pending", () => ({
  invalidateCallerToken: vi.fn(),
  // 僵尸前提：pending 内存已丢
  getPendingAsk: vi.fn(() => null),
  clearPendingAsk: vi.fn(),
}));

vi.mock("@/lib/server/task-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-runner")>();
  return {
    ...actual,
    // 无凭据路径本就不会调到；钉死防误起 agent
    resumeCurrentActionWithMessage: vi.fn(),
    deliverAskReply: vi.fn(),
  };
});

vi.mock("@/lib/server/chat-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/chat-runner")>();
  return {
    ...actual,
    deliverChatAskReply: vi.fn(),
    hasChatSession: vi.fn(() => false),
  };
});

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, readMetaV06, taskDir, writeMeta } = taskFsCore;
const { appendEvent } = await import("@/lib/server/task-fs");
const { agentSessions, clearTaskStarting } = await import(
  "@/lib/server/task-stream"
);
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { POST } = await import("@/app/api/tasks/[id]/ask-reply/route");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ask-reply-r22-6 DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

/** 1×1 透明 PNG——仅竞态用例用来触发存图 await 窗口 */
const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ASK_ID = "ask_r22_6";
const Q_ID = "q1";
const ACTION_ID = "act_plan_1";

const makeMeta = (id: string, runStatus: TaskMetaV06["runStatus"]): TaskMetaV06 =>
  ({
    id,
    title: `r22-6 ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus,
    currentActionId: ACTION_ID,
    actions: [
      {
        id: ACTION_ID,
        n: 1,
        type: "plan",
        status: "running",
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: ["/tmp/fake-repo"],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const seedZombieAsk = async (id: string): Promise<void> => {
  await writeMeta(makeMeta(id, "awaiting_user"));
  const ev = await appendEvent(id, {
    kind: "ask_user_request",
    actionId: ACTION_ID,
    text: "需要确认",
    meta: {
      askId: ASK_ID,
      token: "tok_r22_6",
      questions: [{ id: Q_ID, question: "怎么走？", allowText: true }],
    },
  });
  if (!ev) throw new Error("seed ask_user_request 失败");
};

const callAskReply = async (
  id: string,
  body: Record<string, unknown>,
): Promise<Response> => {
  const req = new Request(`http://local/api/tasks/${id}/ask-reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id }) });
};

describe("R22-6 ask-reply 僵尸态：先条件写再落断开事件", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_r226_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockSaveImageAttachments.mockReset();
    mockSaveImageAttachments.mockResolvedValue([]);
  });

  afterEach(async () => {
    for (const id of ids) {
      agentSessions.delete(id);
      clearTaskStarting(id);
      clearChatGate(id);
      endChatLifecycle(id);
    }
    await new Promise((r) => setTimeout(r, 20));
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("盘上仍 awaiting_user → 410 +「Agent 已断开」error + runStatus=error", async () => {
    const id = alloc();
    await seedZombieAsk(id);

    const res = await callAskReply(id, {
      askId: ASK_ID,
      answers: [{ questionId: Q_ID, answer: "走 A" }],
      // 无 bootArgs → wake 返 null，走标 error 分支
    });

    expect(res.status).toBe(410);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/agent 已断开/);

    expect((await readMetaV06(id))?.runStatus).toBe("error");
    const events = await readEvents(id);
    const disconnect = events.find(
      (e) =>
        e.kind === "error" &&
        typeof e.text === "string" &&
        e.text.includes("Agent 已断开"),
    );
    expect(disconnect).toBeTruthy();
  });

  it("存图窗口内盘上已被写成 running → 409 + 失效 info、无断开 error", async () => {
    const id = alloc();
    await seedZombieAsk(id);

    // 竞态：僵尸分支 persistAnswerAssets 调存图时，模拟后继 B 已写 running
    mockSaveImageAttachments.mockImplementation(async (taskId: string) => {
      const meta = await readMetaV06(taskId);
      if (!meta) throw new Error("meta 丢失");
      meta.runStatus = "running";
      meta.updatedAt = Date.now();
      await writeMeta(meta);
      return [];
    });

    const res = await callAskReply(id, {
      askId: ASK_ID,
      answers: [{ questionId: Q_ID, answer: "走 B" }],
      imagesByQuestion: {
        [Q_ID]: [
          {
            data: PNG_1X1_B64,
            mimeType: "image/png",
            filename: "race.png",
          },
        ],
      },
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("这组提问已失效、AI 已继续工作，无需再回答");

    // 后继接管态不得被本请求盖成 error
    expect((await readMetaV06(id))?.runStatus).toBe("running");

    const events = await readEvents(id);
    const disconnect = events.find(
      (e) =>
        e.kind === "error" &&
        typeof e.text === "string" &&
        e.text.includes("Agent 已断开"),
    );
    expect(disconnect).toBeUndefined();

    const info = events.find(
      (e) =>
        e.kind === "info" &&
        e.meta?.supersededAskId === ASK_ID &&
        typeof e.text === "string" &&
        e.text.includes("上一组提问已失效"),
    );
    expect(info).toBeTruthy();
  });
});
