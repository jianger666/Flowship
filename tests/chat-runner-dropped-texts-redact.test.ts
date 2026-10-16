/**
 * 第五轮：error 收尾清队后写进 events.jsonl 的「排队消息未送达」提示（正文摘要 + meta.droppedTexts）
 * 不得带出凭据——包括「凭据恰好横跨截断点、被切成半截」的情形。
 *
 * 为什么原先会漏：落盘前全局有一道按**精确值**的脱敏（event-secret-redact，见 appendEventLine），
 * 但 noticeQueuedItemsDropped 先把用户文本截断（摘要 80 字符 / droppedTexts 2000 字符）再交给它。
 * 凭据横跨截断点时，留下的只是凭据的前几个字符——不再等于完整值、精确匹配命不中，前缀就原样落了盘
 *（也经 SSE 推给了所有订阅者）。修法：截断之前先脱敏，截断只会切到占位符而不是凭据。
 *
 * 用真实 chat-runner + 假 SDK run：run 用「不可重试错误」结束 → error 收尾 → 清队 → 提示事件。
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
import type { Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-dropped-redact-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const { getEventsLogPath, readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  closeChatSessionUnconditional,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { clearChatQueue, enqueueChatMessage } = await import(
  "@/lib/server/chat-queue"
);
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-runner-dropped-texts-redact DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000010000_dropped_redact";
const AGENT_ID = "agent_fake_dropped_redact";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};
/** 假 PAT：≥8 字符才会进脱敏集合；前 8 字符 "glpat-FA" 就是要断言「不许漏」的前缀 */
const FAKE_GIT_TOKEN = "glpat-FAKEdroppedTextsToken0123456789";
const LEAKED_PREFIX = FAKE_GIT_TOKEN.slice(0, 8);

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `dropped redact ${id}`,
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

let failStream: (() => void) | null = null;

/** 起会话 + 一轮在飞的 run：等 failStream() 后抛不可重试错 → error 收尾 */
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
  const task = asTask(makeMeta(TASK_ID));
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

const waitDroppedNotice = async (): Promise<DroppedInfo> => {
  const box: { found?: DroppedInfo } = {};
  await vi.waitFor(
    async () => {
      const evs: TaskEvent[] = await readEvents(TASK_ID);
      const hit = evs.find(
        (e) => e.kind === "info" && e.text.includes("排队消息未送达"),
      );
      expect(hit).toBeTruthy();
      box.found = hit as unknown as DroppedInfo;
    },
    { timeout: 5_000, interval: 30 },
  );
  return box.found!;
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
    JSON.stringify({
      apiKey: "server-key",
      gitToken: FAKE_GIT_TOKEN,
      defaultModel: { id: "gpt-test", params: [] },
    }),
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

describe("error 清队提示：凭据在截断前脱敏（正文摘要 + meta.droppedTexts）", () => {
  it("凭据横跨摘要 80 字符截断点 / droppedTexts 2000 字符截断点：前缀不得落盘", async () => {
    await startFailableRun();
    // 摘要截在第 80 个字符：前 70 个是普通字、后 10 个落在凭据开头
    enqueueText("cq_straddle_snippet", `${"前".repeat(70)}${FAKE_GIT_TOKEN}`);
    // meta 截在第 2000 个字符：同理（摘要里也会出现这条，所以它同时被两处截断覆盖）
    enqueueText("cq_straddle_meta", `${"后".repeat(1990)}${FAKE_GIT_TOKEN}`);

    failStream!();
    const notice = await waitDroppedNotice();

    const raw = await fs.readFile(getEventsLogPath(TASK_ID), "utf-8");
    expect(raw).not.toContain(LEAKED_PREFIX);
    expect(raw).not.toContain(FAKE_GIT_TOKEN);
    // 对外可见的两处同样干净（事件流 / SSE 用的是同一份文本）
    expect(notice.text).not.toContain(LEAKED_PREFIX);
    for (const t of notice.meta?.droppedTexts ?? []) {
      expect(t).not.toContain(LEAKED_PREFIX);
    }
  }, 20_000);

  it("凭据完整出现在短消息里：被替换成占位符；普通文本原样保留（脱敏不误伤）", async () => {
    await startFailableRun();
    enqueueText("cq_whole_token", `帮我用 ${FAKE_GIT_TOKEN} 拉一下代码`);
    enqueueText("cq_benign", "请帮我看下这个 PR");

    failStream!();
    const notice = await waitDroppedNotice();

    const texts = notice.meta?.droppedTexts ?? [];
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("[REDACTED:gitToken]");
    expect(texts[0]).not.toContain(FAKE_GIT_TOKEN);
    expect(texts[1]).toBe("请帮我看下这个 PR");
    expect(notice.meta?.droppedItemIds).toEqual([
      "cq_whole_token",
      "cq_benign",
    ]);
    expect(notice.text).toContain("请帮我看下这个 PR");
  }, 20_000);
});
