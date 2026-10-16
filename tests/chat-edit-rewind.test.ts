/**
 * 编辑已发送的消息 → 服务端回退（executeChatConversationRewind / executeChatEditRewind）。
 *
 * 只回退对话、不碰文件：截断目标 user_reply 及之后的事件、关会话、清 sessionAgentId，
 * 没有文件检查点（没绑仓 / 检查点被裁掉 / 打点失败）的消息也能用；
 * 有检查点则 executeChatEditRewind 走完整回退（还原文件）。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 加载时冻结，必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-edit-rewind-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const {
  EDIT_REWIND_CONVERSATION_ONLY_INFO,
  appendRewindPoint,
  checkpointRefName,
  executeChatConversationRewind,
  executeChatEditRewind,
  readRewindPoints,
  snapshotRepoTree,
  writeRewindPoints,
} = await import("@/lib/server/chat-checkpoint");
const taskFsCore = await import("@/lib/server/task-fs-core");
const { appendEventLine, newEventId, readEvents, readMetaV06, taskDir, writeMeta } =
  taskFsCore;
const { clearChatGate, endChatRewind, tryBeginChatRewind, tryReserveChatStart, releaseChatStart } =
  await import("@/lib/server/chat-gate");
const { clearChatQueue, enqueueChatMessage } = await import(
  "@/lib/server/chat-queue"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`chat-edit-rewind DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const TASK_ID = "t_1700000008000_editrw";
const REPO = path.join(TMP_ROOT, "repo");
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const makeMeta = (over: Partial<TaskMetaV06> = {}): TaskMetaV06 =>
  ({
    id: TASK_ID,
    title: "edit rewind",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    sessionAgentId: "agent_old",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  }) as unknown as TaskMetaV06;

const deps = (
  over: Partial<{
    closeSession: (id: string) => void;
    isRunActive: (id: string) => boolean;
    isQueueDraining: (id: string) => boolean;
    appendInfoEvent: (
      id: string,
      text: string,
      info: { keptEventCount: number },
    ) => Promise<TaskEvent | null>;
    getTask: (id: string) => Promise<Task | null>;
  }> = {},
) => ({
  closeSession: vi.fn(),
  isRunActive: () => false,
  isQueueDraining: () => false,
  appendInfoEvent: vi.fn(async () => null),
  getTask: async () => ({ id: TASK_ID, mode: "chat", events: [] }) as unknown as Task,
  ...over,
});

/** 三轮对话：u1 a1 u2 a2 u3 a3；返回各 user_reply 的 id */
const seedConversation = async (
  checkpointed: Partial<Record<"u1" | "u2" | "u3", boolean>> = {},
) => {
  await fs.writeFile(path.join(taskDir(TASK_ID), "events.jsonl"), "", "utf-8");
  const ids = { u1: newEventId(), u2: newEventId(), u3: newEventId() };
  let ts = Date.now();
  const user = async (key: "u1" | "u2" | "u3", text: string) =>
    appendEventLine(TASK_ID, {
      id: ids[key],
      ts: ts++,
      kind: "user_reply",
      text,
      ...(checkpointed[key] ? { meta: { checkpointed: true } } : {}),
    } as TaskEvent);
  const asst = async (text: string) =>
    appendEventLine(TASK_ID, {
      id: newEventId(),
      ts: ts++,
      kind: "assistant_message",
      text,
    } as TaskEvent);
  await user("u1", "第一句");
  await asst("答一");
  await user("u2", "第二句");
  await asst("答二");
  await user("u3", "第三句");
  await asst("答三");
  return ids;
};

beforeAll(async () => {
  await fs.mkdir(REPO, { recursive: true });
  git(REPO, "init", "-b", "main");
  git(REPO, "config", "user.email", "t@t.local");
  git(REPO, "config", "user.name", "t");
  await fs.writeFile(path.join(REPO, "tracked.txt"), "v1\n");
  git(REPO, "add", "-A");
  git(REPO, "commit", "-m", "init");
  await fs.mkdir(taskDir(TASK_ID), { recursive: true });
  await writeMeta(makeMeta());
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  clearChatGate(TASK_ID);
  clearChatQueue(TASK_ID);
  await writeMeta(makeMeta());
  await writeRewindPoints(TASK_ID, []);
});

afterEach(() => {
  clearChatGate(TASK_ID);
  clearChatQueue(TASK_ID);
});

describe("executeChatConversationRewind：只回退对话", () => {
  it("没有任何文件检查点也能回退：删掉目标消息及之后、保留之前；关会话、清 sessionAgentId", async () => {
    const ids = await seedConversation();
    const d = deps();

    const res = await executeChatConversationRewind(TASK_ID, ids.u2, d);

    expect(res.ok).toBe(true);
    expect(res.restoredRepos).toEqual([]);
    expect(res.truncatedEventCount).toBe(4); // u2 a2 u3 a3
    expect(res.keptEventCount).toBe(2); // u1 a1
    const left = await readEvents(TASK_ID);
    expect(left.map((e) => e.text)).toEqual(["第一句", "答一"]);
    expect(d.closeSession).toHaveBeenCalledWith(TASK_ID);
    const meta = await readMetaV06(TASK_ID);
    expect(meta?.sessionAgentId).toBeUndefined();
    expect(meta?.runStatus).toBe("idle");
  });

  it("回退标记 info 带保留条数、文案说明文件未改动", async () => {
    const ids = await seedConversation();
    const d = deps();
    await executeChatConversationRewind(TASK_ID, ids.u3, d);
    expect(d.appendInfoEvent).toHaveBeenCalledTimes(1);
    expect(d.appendInfoEvent).toHaveBeenCalledWith(
      TASK_ID,
      EDIT_REWIND_CONVERSATION_ONLY_INFO,
      { keptEventCount: 4 },
    );
    expect(EDIT_REWIND_CONVERSATION_ONLY_INFO).toContain("文件未改动");
  });

  it("不动文件：绑了仓的任务回退对话后，工作区内容原样（不做任何还原 / 安全快照）", async () => {
    await writeMeta(makeMeta({ repoPaths: [REPO] }));
    const ids = await seedConversation();
    await fs.writeFile(path.join(REPO, "tracked.txt"), "AI 后来改的\n");
    await fs.writeFile(path.join(REPO, "new.txt"), "untracked\n");

    await executeChatConversationRewind(TASK_ID, ids.u1, deps());

    await expect(fs.readFile(path.join(REPO, "tracked.txt"), "utf8")).resolves.toBe(
      "AI 后来改的\n",
    );
    await expect(fs.readFile(path.join(REPO, "new.txt"), "utf8")).resolves.toBe(
      "untracked\n",
    );
    // 没打 pre_rewind 安全点（没动文件）
    expect(
      (await readRewindPoints(TASK_ID)).some((p) => p.kind === "pre_rewind"),
    ).toBe(false);
    await fs.rm(path.join(REPO, "new.txt"), { force: true });
    git(REPO, "checkout", "--", ".");
  });

  it("rewind_points：丢掉锚在被删事件上的，保留更早的；pre_rewind 安全点保留", async () => {
    const ids = await seedConversation();
    const snap = await snapshotRepoTree(REPO);
    if ("error" in snap) throw new Error(snap.error);
    const repoSnapshots = [{ repoPath: REPO, treeOid: snap.treeOid }];
    await appendRewindPoint(TASK_ID, {
      eventId: ids.u1,
      createdAt: 1,
      repoSnapshots,
      kind: "checkpoint",
    });
    await appendRewindPoint(TASK_ID, {
      eventId: "pre_rewind_999",
      createdAt: 2,
      repoSnapshots,
      kind: "pre_rewind",
    });
    await appendRewindPoint(TASK_ID, {
      eventId: ids.u2,
      createdAt: 3,
      repoSnapshots,
      kind: "checkpoint",
    });
    await appendRewindPoint(TASK_ID, {
      eventId: ids.u3,
      createdAt: 4,
      repoSnapshots,
      kind: "checkpoint",
    });

    await executeChatConversationRewind(TASK_ID, ids.u2, deps());

    const left = (await readRewindPoints(TASK_ID)).map((p) => p.eventId);
    expect(left).toEqual([ids.u1, "pre_rewind_999"]);
  });

  it("被丢掉的检查点的 git 引用一并清掉（不在用户仓里留垃圾）；保留的点引用还在", async () => {
    await writeMeta(makeMeta({ repoPaths: [REPO] }));
    const ids = await seedConversation();
    const snapOf = async (content: string) => {
      await fs.writeFile(path.join(REPO, "tracked.txt"), content);
      const s = await snapshotRepoTree(REPO);
      if ("error" in s) throw new Error(s.error);
      return s.treeOid;
    };
    const oid1 = await snapOf("给 u1 的\n");
    const oid2 = await snapOf("给 u2 的\n");
    for (const [eventId, oid, at] of [
      [ids.u1, oid1, 1],
      [ids.u2, oid2, 2],
    ] as const) {
      await appendRewindPoint(TASK_ID, {
        eventId,
        createdAt: at,
        repoSnapshots: [{ repoPath: REPO, treeOid: oid }],
        kind: "checkpoint",
      });
    }
    const refExists = (oid: string): boolean => {
      try {
        git(REPO, "show-ref", "--verify", "--quiet", checkpointRefName(TASK_ID, oid));
        return true;
      } catch {
        return false;
      }
    };
    expect(refExists(oid1)).toBe(true);
    expect(refExists(oid2)).toBe(true);

    await executeChatConversationRewind(TASK_ID, ids.u2, deps());

    expect(refExists(oid1)).toBe(true);
    expect(refExists(oid2)).toBe(false);
    git(REPO, "update-ref", "-d", checkpointRefName(TASK_ID, oid1));
    git(REPO, "checkout", "--", ".");
  }, 20_000);

  it("目标不是 user_reply → bad_target(400)，什么都不删", async () => {
    await seedConversation();
    const asst = (await readEvents(TASK_ID)).find((e) => e.kind === "assistant_message")!;
    await expect(
      executeChatConversationRewind(TASK_ID, asst.id, deps()),
    ).rejects.toMatchObject({ name: "RewindError", code: "bad_target", status: 400 });
    expect(await readEvents(TASK_ID)).toHaveLength(6);
  });

  it("找不到该消息 → not_found(404)，什么都不删", async () => {
    await seedConversation();
    await expect(
      executeChatConversationRewind(TASK_ID, "e_nope", deps()),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(await readEvents(TASK_ID)).toHaveLength(6);
  });

  it("agent 正在跑 / 队列在发送 / 起新会话中 / 还有排队消息 → run_active(409)，什么都不删、不关会话", async () => {
    const ids = await seedConversation();
    const cases: Array<[string, () => (() => void) | void, Parameters<typeof deps>[0]]> = [
      ["正在跑", () => {}, { isRunActive: () => true }],
      ["队列发送中", () => {}, { isQueueDraining: () => true }],
      [
        "起新会话中",
        () => {
          const token = tryReserveChatStart(TASK_ID);
          return () => releaseChatStart(TASK_ID, token!);
        },
        {},
      ],
      [
        "还有排队消息",
        () => {
          enqueueChatMessage(TASK_ID, {
            itemId: "cq_1",
            agentText: "排着",
            displayText: "排着",
            enqueuedAt: Date.now(),
          });
        },
        {},
      ],
    ];
    for (const [name, setup, over] of cases) {
      const cleanup = setup();
      const d = deps(over);
      await expect(
        executeChatConversationRewind(TASK_ID, ids.u1, d),
        name,
      ).rejects.toMatchObject({ code: "run_active", status: 409 });
      expect(d.closeSession, name).not.toHaveBeenCalled();
      expect(await readEvents(TASK_ID), name).toHaveLength(6);
      if (typeof cleanup === "function") cleanup();
      clearChatQueue(TASK_ID);
      clearChatGate(TASK_ID);
    }
  });

  it("meta 标着 running（即使内存里没 run）也拒绝", async () => {
    const ids = await seedConversation();
    await writeMeta(makeMeta({ runStatus: "running" }));
    await expect(
      executeChatConversationRewind(TASK_ID, ids.u1, deps()),
    ).rejects.toMatchObject({ code: "run_active" });
    expect(await readEvents(TASK_ID)).toHaveLength(6);
  });

  it("不是 chat 任务 → not_chat；任务不存在 → not_found", async () => {
    const ids = await seedConversation();
    await writeMeta(makeMeta({ mode: "task" } as Partial<TaskMetaV06>));
    await expect(
      executeChatConversationRewind(TASK_ID, ids.u1, deps()),
    ).rejects.toMatchObject({ code: "not_chat" });
    await expect(
      executeChatConversationRewind("t_does_not_exist", ids.u1, deps()),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("门闩被占（另一个回退在进行）→ run_active，且不会释放别人的门闩", async () => {
    const ids = await seedConversation();
    expect(tryBeginChatRewind(TASK_ID)).toBe(true);
    try {
      await expect(
        executeChatConversationRewind(TASK_ID, ids.u1, deps()),
      ).rejects.toMatchObject({ code: "run_active" });
      // 门闩仍被原持有者占着
      expect(tryBeginChatRewind(TASK_ID)).toBe(false);
    } finally {
      endChatRewind(TASK_ID);
    }
  });

  it("成功 / 失败后门闩都释放（之后还能再发消息 / 再回退）", async () => {
    const ids = await seedConversation();
    await expect(
      executeChatConversationRewind(TASK_ID, "e_nope", deps()),
    ).rejects.toBeTruthy();
    await executeChatConversationRewind(TASK_ID, ids.u3, deps());
    expect(tryBeginChatRewind(TASK_ID)).toBe(true);
    endChatRewind(TASK_ID);
  });

  it("截断后记账失败（writeMeta 抛错）→ 前滚：仍按成功返回，对话已截断、会话已关，不报错诱导重试", async () => {
    const ids = await seedConversation();
    const d = deps();
    const spy = vi
      .spyOn(taskFsCore, "writeMeta")
      .mockRejectedValueOnce(new Error("writeMeta boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await executeChatConversationRewind(TASK_ID, ids.u2, d);
      expect(res.ok).toBe(true);
      expect(res.keptEventCount).toBe(2);
      expect((await readEvents(TASK_ID)).map((e) => e.text)).toEqual(["第一句", "答一"]);
      expect(d.closeSession).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it("读最新 Task 失败 → 回退照常成功，refreshRequired=true（不报错）", async () => {
    const ids = await seedConversation();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await executeChatConversationRewind(
        TASK_ID,
        ids.u3,
        deps({ getTask: async () => null }),
      );
      expect(res.ok).toBe(true);
      expect(res.task).toBeNull();
      expect(res.refreshRequired).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("executeChatEditRewind：有检查点 → 完整回退；没有 → 只回退对话", () => {
  it("没有检查点：走只回退对话（文件不动、restoredRepos 为空）", async () => {
    await writeMeta(makeMeta({ repoPaths: [REPO] }));
    const ids = await seedConversation({ u2: true }); // 事件标了 checkpointed，但 points 里没有（被裁掉了）
    await fs.writeFile(path.join(REPO, "tracked.txt"), "保持\n");

    const res = await executeChatEditRewind(TASK_ID, ids.u2, deps());

    expect(res.restoredRepos).toEqual([]);
    expect((await readEvents(TASK_ID)).map((e) => e.text)).toEqual(["第一句", "答一"]);
    await expect(fs.readFile(path.join(REPO, "tracked.txt"), "utf8")).resolves.toBe(
      "保持\n",
    );
    git(REPO, "checkout", "--", ".");
  });

  it("有检查点：走完整回退（文件还原到那条消息发出时、同时截断对话）", async () => {
    await writeMeta(makeMeta({ repoPaths: [REPO] }));
    const ids = await seedConversation({ u2: true });
    await fs.writeFile(path.join(REPO, "tracked.txt"), "发第二句时\n");
    const snap = await snapshotRepoTree(REPO);
    if ("error" in snap) throw new Error(snap.error);
    await appendRewindPoint(TASK_ID, {
      eventId: ids.u2,
      createdAt: Date.now(),
      repoSnapshots: [{ repoPath: REPO, treeOid: snap.treeOid }],
      kind: "checkpoint",
    });
    // 之后 AI 又改了文件
    await fs.writeFile(path.join(REPO, "tracked.txt"), "AI 之后又改了\n");

    const res = await executeChatEditRewind(TASK_ID, ids.u2, deps());

    expect(res.restoredRepos).toHaveLength(1);
    expect(res.restoredRepos[0]!.ok).toBe(true);
    await expect(fs.readFile(path.join(REPO, "tracked.txt"), "utf8")).resolves.toBe(
      "发第二句时\n",
    );
    expect((await readEvents(TASK_ID)).map((e) => e.text)).toEqual(["第一句", "答一"]);
    git(REPO, "checkout", "--", ".");
  }, 20_000);

  it("检查点只有 pre_rewind 安全点（eventId 相同也不算）/ 快照为空 → 当没有检查点", async () => {
    const ids = await seedConversation({ u2: true });
    await writeRewindPoints(TASK_ID, [
      { eventId: ids.u2, createdAt: 1, repoSnapshots: [], kind: "checkpoint" },
      {
        eventId: ids.u2,
        createdAt: 2,
        repoSnapshots: [{ repoPath: REPO, treeOid: "a".repeat(40) }],
        kind: "pre_rewind",
      },
    ]);
    const res = await executeChatEditRewind(TASK_ID, ids.u2, deps());
    expect(res.restoredRepos).toEqual([]);
    expect((await readEvents(TASK_ID)).map((e) => e.text)).toEqual(["第一句", "答一"]);
  });
});
