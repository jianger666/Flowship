/**
 * 清队调用点（stop / finalize / archive / DELETE）真实接线测试。
 *
 * 文档 docs/feishu-group-collab.md「talk 队列」一节约定：
 *   - finalize / archive / DELETE：整队清（app + 群属主 + 托办回执 + 群问题）——
 *     群问题条目带启动凭据（boot.apiKey），终态后不留内存；
 *   - stop：只清 app 输入条，群来源保留、空闲后照常送达（G5-01：这是文档设计，不是漏洞）。
 *
 * 此前只有 clearTalkQueue / clearGroupQuestionQueue 自身的单测，四个调用点没人守——
 * 谁删掉那一行（或把 stop 的 onlySources 改成整队清）都不会有测试变红。
 * 这里不 mock 队列：向**真实**队列塞满四种来源，跑真实的 stopTaskAgent / finalizeTask /
 * archiveTaskWithCleanup / DELETE 路由，再看队列剩什么。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
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

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-talk-queue-clear-callsites-"),
);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: vi.fn(),
  },
}));
vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T>(servers: T) => servers,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({
    servers,
    dropped: [],
  }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));
vi.mock("@/lib/server/update-pending", () => ({
  assertNoUpdatePendingRestart: async () => {},
}));
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
}));

const { readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { droppedNoticeTitle, extractDroppedTexts } = await import(
  "@/lib/chat-stream-display"
);
const { getTask, listTasks } = await import("@/lib/server/task-fs");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const taskWorktrees = await import("@/lib/server/task-worktrees");
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const { finalizeTask, archiveTaskWithCleanup } = await import(
  "@/lib/server/task-runner"
);
const { DELETE } = await import("@/app/api/tasks/[id]/route");
const {
  __resetTaskTalkQueueForTest,
  buildTalkQueueSnapshot,
  enqueueTalkMessage,
} = await import("@/lib/server/task-talk-queue");
const {
  __resetGroupReplyStateForTest,
  enqueueGroupQuestion,
  groupQuestionQueueLength,
} = await import("@/lib/server/feishu-bridge/group-shared");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `talk-queue-clear-callsites DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

// 跳过 boot 恢复：别让它在 listTasks 里扫到别的测试的残留
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
await listTasks();
(globalThis as unknown as Record<string, Promise<void> | undefined>)[
  RECOVERY_FLAG
] = Promise.resolve();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const makeMeta = (
  id: string,
  over: Partial<TaskMetaV06> = {},
): TaskMetaV06 =>
  ({
    id,
    title: `talk-queue-clear ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  }) as unknown as TaskMetaV06;

/** 四种来源各塞一条：app 输入条 / 群属主 / 托办回执（本模块队列）+ 群问题（群模块队列） */
const seedAllSources = (taskId: string): void => {
  const base = { options: {}, senderName: "t" };
  enqueueTalkMessage(taskId, {
    ...base,
    source: "app",
    rawBody: { text: "app 输入条" },
    clientItemId: "client-1",
  });
  enqueueTalkMessage(taskId, {
    ...base,
    source: "group_owner",
    rawBody: { text: "属主在群里说" },
  });
  enqueueTalkMessage(taskId, {
    ...base,
    source: "group_reply",
    rawBody: { text: "托办回执" },
    options: { correlatedAnswer: true },
  });
  const r = enqueueGroupQuestion(taskId, {
    messageId: "om_q1",
    chatId: "oc_x",
    text: "群友的问题",
    parsed: { text: "群友的问题", images: [], attachments: [] } as never,
    requester: { openId: "ou_li", name: "李四" },
    boot: { apiKey: "k-test", model: { id: "m" } },
  });
  expect(r.queued).toBe(true);
};

const sourcesLeft = (taskId: string): string[] =>
  buildTalkQueueSnapshot(taskId)
    .map((i) => i.source)
    .sort();

const ALL_SOURCES = [
  "app",
  "group_owner",
  "group_question",
  "group_reply",
];

const ids: string[] = [];
const alloc = (): string => {
  const id = `t_tqclear_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  return id;
};

beforeEach(() => {
  __resetTaskTalkQueueForTest();
  __resetGroupReplyStateForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // 先清队列再删目录：队列里有活的 drain 定时器，别让它在目录没了之后触发
  __resetTaskTalkQueueForTest();
  __resetGroupReplyStateForTest();
  for (const id of ids.splice(0)) {
    clearChatGate(id);
    await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  }
});

describe("清队调用点接线", () => {
  it("前置：seed 确实把四种来源都塞进了真实队列（防止下面的「清空」断言空转）", () => {
    const id = alloc();
    seedAllSources(id);
    expect(sourcesLeft(id)).toEqual(ALL_SOURCES);
    expect(groupQuestionQueueLength(id)).toBe(1);
  });

  it("stop（stopTaskAgent）：只清 app 输入条，群属主 / 托办回执 / 群问题保留（文档设计）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const task = (await getTask(id))!;
    seedAllSources(id);

    await stopTaskAgent(task);

    expect(sourcesLeft(id)).toEqual([
      "group_owner",
      "group_question",
      "group_reply",
    ]);
    // 群问题带启动凭据、真身在群队列：stop 不能顺手清它
    expect(groupQuestionQueueLength(id)).toBe(1);
  });

  it("stop：清掉的 app 输入条要落一条「未送达」事件（完整原文），排在「用户停止了…」之后；群来源的话不进该事件（D8-04）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const task = (await getTask(id))!;
    seedAllSources(id);

    await stopTaskAgent(task);

    const evs = await readEvents(id);
    const stopIdx = evs.findIndex(
      (e) => e.kind === "info" && e.meta?.stopped === true,
    );
    const dropIdx = evs.findIndex(
      (e) => e.kind === "info" && extractDroppedTexts(e.meta).length > 0,
    );
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeGreaterThan(stopIdx);
    const dropped = evs[dropIdx]!;
    expect(extractDroppedTexts(dropped.meta)).toEqual(["app 输入条"]);
    expect(droppedNoticeTitle(dropped.text)).toBe(
      "已停止，1 条排队消息未送达、请重新发送",
    );
    // 群来源保留、照常送达——它们的话不能被说成「未送达」
    const all = JSON.stringify(evs);
    expect(all).not.toContain("属主在群里说");
    expect(all).not.toContain("托办回执");
  });

  it("stop：队里没有 app 输入条时不写「未送达」事件（不制造空提示）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const task = (await getTask(id))!;

    await stopTaskAgent(task);

    const evs = await readEvents(id);
    expect(evs.some((e) => e.text?.includes("未送达"))).toBe(false);
  });

  it("finalize（abandoned）：整队清——含群问题（带 boot.apiKey）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    seedAllSources(id);

    await finalizeTask(id, "abandoned");

    expect(sourcesLeft(id)).toEqual([]);
    expect(groupQuestionQueueLength(id)).toBe(0);
  });

  it("archive（隔离 worktree 任务）：整队清——休眠任务的问题不等它醒", async () => {
    const id = alloc();
    await writeMeta(
      makeMeta(id, {
        isolateWorktree: true,
        repoPaths: [path.join(TMP_ROOT, "no-such-repo")],
      } as Partial<TaskMetaV06>),
    );
    // 不做真 git：清 worktree 这一步本测试不关心，换成空结果
    vi.spyOn(taskWorktrees, "removeTaskWorktrees").mockResolvedValue({
      removedAny: false,
      snapshotRepos: [],
      snapshotFailedRepos: [],
    } as never);
    seedAllSources(id);

    const res = await archiveTaskWithCleanup(id, true);

    expect(res).not.toBeNull();
    expect(sourcesLeft(id)).toEqual([]);
    expect(groupQuestionQueueLength(id)).toBe(0);
  });

  it("DELETE 路由：整队清——任务没了不能留带凭据的排队条目", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await fs.mkdir(path.join(taskDir(id), "workspace"), { recursive: true });
    seedAllSources(id);

    const res = await DELETE(new Request("http://local/api/tasks/" + id), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBeLessThan(300);
    expect(sourcesLeft(id)).toEqual([]);
    expect(groupQuestionQueueLength(id)).toBe(0);
  });
});
