/**
 * 停止（stopTaskAgent）× 群成员（group_other）排的队。
 *
 * 真实的 stopTaskAgent + 真实队列（同 talk-queue-clear-callsites 的手法），钉死：
 * - 停止会清掉 group_other 并通知发言人（reason=stopped）+ 属主事件流留一行 info
 * - 停止对其它群来源（group_owner / group_reply）的口径不变：保留（G5-01）
 * - 停止仍然只清 app 输入条那一步（onlySources:["app"]）——group_other 是**另一步**，不是改了那一步的口径
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-stop-clears-group-other-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({ Agent: { create: vi.fn(), resume: vi.fn() } }));
vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T>(servers: T) => servers,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({ servers, dropped: [] }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({ reapTaskOrphans: vi.fn() }));
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

const { readEvents, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { getTask, listTasks } = await import("@/lib/server/task-fs");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const {
  __resetTaskTalkQueueForTest,
  buildTalkQueueSnapshot,
  enqueueTalkMessage,
  setTalkQueueGroupOtherDropHandler,
} = await import("@/lib/server/task-talk-queue");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`stop-clears-group-other DATA_DIR 未隔离：${taskDir("probe")}`);
}
await listTasks();
(globalThis as unknown as Record<string, Promise<void> | undefined>)[
  "__flowshipBootRecoveryPromiseV2__"
] = Promise.resolve();

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
    title: `stop-group-other ${id}`,
    mode: "task",
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
const alloc = (): string => {
  const id = `t_stopgo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  return id;
};
const sourcesLeft = (taskId: string): string[] =>
  buildTalkQueueSnapshot(taskId)
    .map((i) => i.source)
    .sort();

let dropped: Array<{ reason: string; meta?: Record<string, unknown> }> = [];

beforeEach(() => {
  __resetTaskTalkQueueForTest();
  dropped = [];
  setTalkQueueGroupOtherDropHandler((info) => {
    dropped.push({ reason: info.reason, meta: info.meta });
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  setTalkQueueGroupOtherDropHandler(null);
  __resetTaskTalkQueueForTest();
  for (const id of ids.splice(0)) {
    clearChatGate(id);
    await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  }
});

describe("停止 × group_other", () => {
  it("清 group_other + 通知发言人（stopped）+ 事件流留 info；group_owner / group_reply 保留；app 输入条照旧被清", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const task = (await getTask(id))!;
    const sender = (openId: string, name: string) => ({
      source: "group_other" as const,
      rawBody: { text: `${name} 的问题` },
      options: {
        userReplyMetaExtra: {
          groupChatId: "oc_x",
          groupSender: name,
          groupSenderOpenId: openId,
        },
      },
      senderName: name,
      senderKey: openId,
    });
    enqueueTalkMessage(id, sender("ou_a", "甲"));
    enqueueTalkMessage(id, sender("ou_b", "乙"));
    enqueueTalkMessage(id, {
      source: "group_owner",
      rawBody: { text: "属主在群里说" },
      options: {},
    });
    enqueueTalkMessage(id, {
      source: "group_reply",
      rawBody: { text: "回执" },
      options: { correlatedAnswer: true },
    });
    enqueueTalkMessage(id, {
      source: "app",
      rawBody: { text: "app 输入条" },
      options: {},
      clientItemId: "c1",
    });
    expect(sourcesLeft(id)).toEqual([
      "app",
      "group_other",
      "group_other",
      "group_owner",
      "group_reply",
    ]);

    await stopTaskAgent(task);

    expect(sourcesLeft(id)).toEqual(["group_owner", "group_reply"]);
    expect(dropped.map((d) => d.reason)).toEqual(["stopped", "stopped"]);
    expect(dropped.map((d) => d.meta?.groupSenderOpenId).sort()).toEqual([
      "ou_a",
      "ou_b",
    ]);
    // 属主在事件流里看得到「已停止，N 条群成员排队的消息已清除」
    const events = await readEvents(id);
    expect(
      events.some(
        (e) => e.kind === "info" && String(e.text ?? "").includes("2 条群成员排队的消息已清除"),
      ),
    ).toBe(true);
  });

  it("队里没有 group_other：不通知、不多写那行 info", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const task = (await getTask(id))!;
    enqueueTalkMessage(id, {
      source: "group_owner",
      rawBody: { text: "属主在群里说" },
      options: {},
    });
    await stopTaskAgent(task);
    expect(dropped).toHaveLength(0);
    expect(sourcesLeft(id)).toEqual(["group_owner"]);
    const events = await readEvents(id);
    expect(
      events.some((e) => String(e.text ?? "").includes("群成员排队的消息已清除")),
    ).toBe(false);
  });
});
