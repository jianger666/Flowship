/**
 * R2-02（第三轮 review）：定时样板消息不得进「排队消息未送达」卡。
 *
 * 会话在跑、定时到点 → 消息（`[SCHEDULE_FIRED id=…] 定时任务到点了…` 样板，itemId 形如 `sch_xxx.seq.attempt`）
 * 进 chat 队列 → run 出错清队 → 原先 noticeQueuedItemsDropped 把样板原文写进 meta.droppedTexts：
 * 卡里露出给 AI 看的内部样板，还提供「放回输入框」（= 冒充用户重发一条定时）。
 *
 * 两层：
 *   1. 纯函数：isScheduleBoilerplateText / extractDroppedTexts（前端读侧防御，老事件也生效）；
 *   2. 真实 chat-runner + 假 SDK run：error 收尾清队，提示里只有普通用户消息，条数不含定时项；
 *      只有定时项时不写「未送达」提示（定时被清由 schedule-queue-loss 另写专属提示）。
 * 并行隔离：先钉 FLOWSHIP_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractDroppedTexts, isScheduleBoilerplateText } from "@/lib/chat-stream-display";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-dropped-schedule-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const { readEvents, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { closeChatSessionUnconditional, isChatRunActive, resumeChatSession, sendChatMessage } =
  await import("@/lib/server/chat-runner");
const { clearChatQueue, enqueueChatMessage } = await import("@/lib/server/chat-queue");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`dropped-schedule-boilerplate DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const BOILERPLATE =
  "[SCHEDULE_FIRED id=sch_abc123] 定时任务到点了。这条是系统按你之前设的定时自动发出的，不是用户刚发的消息。";

describe("isScheduleBoilerplateText / extractDroppedTexts（读侧防御）", () => {
  it("只认以 [SCHEDULE_FIRED 开头（容忍前导空白）的样板", () => {
    expect(isScheduleBoilerplateText(BOILERPLATE)).toBe(true);
    expect(isScheduleBoilerplateText(`\n  ${BOILERPLATE}`)).toBe(true);
    expect(isScheduleBoilerplateText("帮我看一下 [SCHEDULE_FIRED id=x] 是什么")).toBe(false);
    expect(isScheduleBoilerplateText("[SCHEDULE_FIREDX] 不是")).toBe(false);
    expect(isScheduleBoilerplateText("")).toBe(false);
  });

  it("extractDroppedTexts：老事件里已落盘的定时样板被滤掉，普通消息 / 顺序不变；脏项照旧丢", () => {
    const got = extractDroppedTexts({
      droppedTexts: ["先出方案", BOILERPLATE, "  ", 42, "再改一下"],
    });
    expect(got).toEqual(["先出方案", "再改一下"]);
  });

  it("只有定时样板 → 空数组（卡不渲染，退回单行 info）", () => {
    expect(extractDroppedTexts({ droppedTexts: [BOILERPLATE] })).toEqual([]);
  });
});

// ---------- 真实 chat-runner ----------

const TASK_ID = "t_1700000020000_dropped_sched";
const AGENT_ID = "agent_fake_dropped_sched";
const BOOT = { apiKey: "test-key", model: { id: "gpt-test", params: [] as never[] } };

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `dropped schedule ${id}`,
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

let failStream: (() => void) | null = null;

const startFailableRun = async (): Promise<void> => {
  const gate = new Promise<void>((r) => {
    failStream = r;
  });
  mockResume.mockResolvedValueOnce({
    agentId: AGENT_ID,
    close: vi.fn(),
    send: vi.fn().mockResolvedValue({
      stream: async function* (): AsyncGenerator<never> {
        await gate;
        throw new Error("invalid api key");
      },
      wait: () => new Promise<never>(() => {}),
      cancel: vi.fn().mockResolvedValue(undefined),
    }),
  });
  const task = makeMeta(TASK_ID) as unknown as Task;
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  expect(await sendChatMessage(task, "先干这个")).toBe("sent");
  expect(isChatRunActive(TASK_ID)).toBe(true);
};

const enqueueText = (itemId: string, text: string): void => {
  expect(
    enqueueChatMessage(TASK_ID, {
      itemId,
      agentText: text,
      displayText: text,
      enqueuedAt: Date.now(),
    }),
  ).toMatchObject({ ok: true });
};

type DroppedInfo = {
  text: string;
  meta?: { droppedTexts?: string[]; droppedItemIds?: string[] };
};

beforeEach(async () => {
  failStream = null;
  mockResume.mockReset();
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  await getTask(TASK_ID);
  await fs.writeFile(
    path.join(DATA_DIR, "config.json"),
    JSON.stringify({ apiKey: "server-key", defaultModel: { id: "gpt-test", params: [] } }),
    "utf-8",
  );
});

afterEach(async () => {
  failStream?.();
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 60));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("error 清队：定时样板不进「未送达」提示", () => {
  it("用户消息 + 定时项一起被清：提示只列用户消息、条数不含定时项、样板原文不落进任何字段", async () => {
    await startFailableRun();
    enqueueText("cq_user_1", "把日志贴给我");
    enqueueText("sch_abc123.1.1", BOILERPLATE);

    failStream!();
    const box: { found?: DroppedInfo } = {};
    await vi.waitFor(
      async () => {
        const evs: TaskEvent[] = await readEvents(TASK_ID);
        const hit = evs.find((e) => e.kind === "info" && e.text.includes("排队消息未送达"));
        expect(hit).toBeTruthy();
        box.found = hit as unknown as DroppedInfo;
      },
      { timeout: 5_000, interval: 30 },
    );
    const notice = box.found!;
    expect(notice.text).toContain("1 条排队消息未送达");
    expect(notice.text).toContain("把日志贴给我");
    expect(notice.text).not.toContain("SCHEDULE_FIRED");
    expect(notice.meta?.droppedTexts).toEqual(["把日志贴给我"]);
    expect(notice.meta?.droppedItemIds).toEqual(["cq_user_1"]);
  }, 20_000);

  it("正文是样板但 itemId 不是定时格式（老数据 / 别的投递路径）：同样按正文识别、剔除", async () => {
    await startFailableRun();
    enqueueText("cq_user_2", "继续");
    enqueueText("cq_odd_id", BOILERPLATE);

    failStream!();
    const box: { found?: DroppedInfo } = {};
    await vi.waitFor(
      async () => {
        const evs: TaskEvent[] = await readEvents(TASK_ID);
        const hit = evs.find((e) => e.kind === "info" && e.text.includes("排队消息未送达"));
        expect(hit).toBeTruthy();
        box.found = hit as unknown as DroppedInfo;
      },
      { timeout: 5_000, interval: 30 },
    );
    expect(box.found!.text).toContain("1 条排队消息未送达");
    expect(box.found!.meta?.droppedTexts).toEqual(["继续"]);
  }, 20_000);

  it("清掉的全是定时项：不写「排队消息未送达」提示（没有用户的话丢失）", async () => {
    await startFailableRun();
    enqueueText("sch_abc123.2.1", BOILERPLATE);

    failStream!();
    // run 收尾（error）完成后会话闩锁放掉
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });
    // 给收尾后的清队通知留足落盘时间，再断言「没有」
    await new Promise((r) => setTimeout(r, 300));
    const evs: TaskEvent[] = await readEvents(TASK_ID);
    expect(evs.filter((e) => e.text?.includes("排队消息未送达"))).toEqual([]);
    expect(JSON.stringify(evs)).not.toContain("SCHEDULE_FIRED");
  }, 20_000);
});
