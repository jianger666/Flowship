/**
 * Chat checkpoint / rewind 单元 + 临时 git fixture 集成
 *
 * 覆盖：打快照 → 改文件 / 加 untracked → 恢复断言；rewind_points 读写与保留策略；
 * checkpoint ref 防 gc、裁剪删 ref、事务回滚、门闩、drain 互斥、refs 清理。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；ESM 静态 import 会 hoist，
 * 必须先钉 FLOWSHIP_DATA_DIR 再动态 import，否则全量并行时多文件撞 cwd/data/tasks。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

/** 真实 git IO（snapshot / restore / gc / 多点裁剪）在满核并发下易超默认 5s */
const GIT_IT_TIMEOUT_MS = 20_000;

import type { Task, TaskEvent } from "@/lib/types";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

// OS 保证唯一；必须在动态 import 之前钉死 env
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-ckpt-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const {
  MAX_REWIND_POINTS,
  appendRewindPoint,
  captureChatCheckpoint,
  checkpointRefName,
  cleanupCheckpointRefsForTask,
  executeChatRewind,
  readRewindPoints,
  restoreRepoTree,
  snapshotRepoTree,
  truncateEventsBeforeEventId,
  writeRewindPoints,
  RewindError,
} = await import("@/lib/server/chat-checkpoint");
const taskFsCore = await import("@/lib/server/task-fs-core");
const {
  appendEventLine,
  newEventId,
  readEvents,
  taskDir,
  writeMeta,
} = taskFsCore;
const {
  clearChatGate,
  tryBeginChatRewind,
  tryReserveChatStart,
  endChatRewind,
  releaseChatStart,
} = await import("@/lib/server/chat-gate");
const { clearChatQueue } = await import("@/lib/server/chat-queue");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`chat-checkpoint DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const REPO = path.join(TMP_ROOT, "repo");
const REPO2 = path.join(TMP_ROOT, "repo2");
const TASK_ID = "t_1700000000999_ckpt";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const refExists = (cwd: string, ref: string): boolean => {
  try {
    git(cwd, "show-ref", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
};

/**
 * 用例超时会跳过 try/finally 体内的清 refs——afterEach 直接按前缀扫删，
 * 不依赖 rewind_points（cleanupCheckpointRefsForTask 在 points 为空时会早退）。
 */
const wipeCheckpointRefs = (cwd: string): void => {
  const prefix = `refs/ai-flow/checkpoints/${TASK_ID}/`;
  let listed = "";
  try {
    listed = git(cwd, "for-each-ref", "--format=%(refname)", prefix);
  } catch {
    return;
  }
  for (const line of listed.split("\n")) {
    const name = line.trim();
    if (!name) continue;
    try {
      git(cwd, "update-ref", "-d", name);
    } catch {
      /* best-effort */
    }
  }
};

const makeMeta = (repoPaths: string[] = [REPO]): TaskMetaV06 =>
  ({
    id: TASK_ID,
    title: "ckpt test",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const stubRewindDeps = (
  overrides: Partial<{
    closeSession: (taskId: string) => void;
    isRunActive: (taskId: string) => boolean;
    isQueueDraining: (taskId: string) => boolean;
    appendInfoEvent: (
      taskId: string,
      text: string,
    ) => Promise<TaskEvent | null>;
    getTask: (taskId: string) => Promise<Task | null>;
  }> = {},
) => ({
  closeSession: () => {},
  isRunActive: () => false,
  isQueueDraining: () => false,
  appendInfoEvent: async () => null,
  getTask: async () =>
    ({
      id: TASK_ID,
      title: "ckpt test",
      mode: "chat",
      events: [],
    }) as unknown as Task,
  ...overrides,
});

const initRepo = async (repoPath: string) => {
  await fs.mkdir(repoPath, { recursive: true });
  git(repoPath, "init", "-b", "main");
  git(repoPath, "config", "user.email", "t@t.local");
  git(repoPath, "config", "user.name", "t");
  await fs.writeFile(path.join(repoPath, "tracked.txt"), "v1\n");
  git(repoPath, "add", "-A");
  git(repoPath, "commit", "-m", "init");
};

const resetRepoWorktree = async (repoPath: string) => {
  await fs.chmod(repoPath, 0o755).catch(() => {});
  await fs.writeFile(path.join(repoPath, "tracked.txt"), "v1\n");
  await fs.chmod(path.join(repoPath, "tracked.txt"), 0o644).catch(() => {});
  git(repoPath, "add", "-A");
  try {
    await fs.unlink(path.join(repoPath, "new-untracked.txt"));
  } catch {
    /* noop */
  }
  try {
    await fs.rm(path.join(repoPath, "new-dir"), { recursive: true, force: true });
  } catch {
    /* noop */
  }
  git(repoPath, "checkout", "--", ".");
  git(repoPath, "clean", "-fd");
};

/** 准备单仓可 rewind 的 checkpoint + events */
const seedSingleRepoRewind = async (eventId: string) => {
  await writeRewindPoints(TASK_ID, []);
  await fs.writeFile(path.join(taskDir(TASK_ID), "events.jsonl"), "", "utf-8");
  const snap = await snapshotRepoTree(REPO);
  if ("error" in snap) throw new Error(snap.error);
  await appendRewindPoint(TASK_ID, {
    eventId,
    createdAt: Date.now(),
    repoSnapshots: [{ repoPath: REPO, treeOid: snap.treeOid }],
    kind: "checkpoint",
  });
  await appendEventLine(TASK_ID, {
    id: eventId,
    ts: Date.now(),
    kind: "user_reply",
    text: "to-rewind",
    meta: { checkpointed: true },
  } as TaskEvent);
  await appendEventLine(TASK_ID, {
    id: newEventId(),
    ts: Date.now() + 1,
    kind: "assistant_message",
    text: "after",
  } as TaskEvent);
  return snap;
};

beforeAll(async () => {
  await initRepo(REPO);
  await initRepo(REPO2);

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
  await resetRepoWorktree(REPO);
  await resetRepoWorktree(REPO2);
});

afterEach(async () => {
  // 超时/中断时用例体内 finally 可能没跑到——先恢复权限再清 refs，避免只读仓卡住后续用例
  await fs.chmod(REPO, 0o755).catch(() => {});
  await fs.chmod(REPO2, 0o755).catch(() => {});
  await fs.chmod(path.join(REPO, "tracked.txt"), 0o644).catch(() => {});
  await fs.chmod(path.join(REPO2, "tracked.txt"), 0o644).catch(() => {});
  wipeCheckpointRefs(REPO);
  wipeCheckpointRefs(REPO2);
  await writeRewindPoints(TASK_ID, []).catch(() => {});
});

describe("snapshotRepoTree / restoreRepoTree", () => {
  it(
    "改 tracked + 加 untracked 后恢复：内容回来、untracked 清掉",
    async () => {
      const before = await snapshotRepoTree(REPO);
      expect(before).toHaveProperty("treeOid");
      if ("error" in before) throw new Error(before.error);

      await fs.writeFile(path.join(REPO, "tracked.txt"), "v2-modified\n");
      await fs.writeFile(path.join(REPO, "new-untracked.txt"), "orphan\n");
      await fs.mkdir(path.join(REPO, "new-dir"), { recursive: true });
      await fs.writeFile(path.join(REPO, "new-dir", "x.txt"), "x\n");

      const restored = await restoreRepoTree(REPO, before.treeOid);
      expect(restored.ok).toBe(true);
      expect(restored.removedUntracked.length).toBeGreaterThan(0);

      await expect(
        fs.readFile(path.join(REPO, "tracked.txt"), "utf8"),
      ).resolves.toBe("v1\n");
      await expect(
        fs.access(path.join(REPO, "new-untracked.txt")),
      ).rejects.toThrow();
      await expect(fs.access(path.join(REPO, "new-dir"))).rejects.toThrow();
    },
    GIT_IT_TIMEOUT_MS,
  );

  it(
    "快照不碰真实 index：snapshot 前后 git status 一致",
    async () => {
      await fs.writeFile(path.join(REPO, "tracked.txt"), "dirty\n");
      const statusBefore = git(REPO, "status", "--porcelain");
      const snap = await snapshotRepoTree(REPO);
      expect(snap).toHaveProperty("treeOid");
      const statusAfter = git(REPO, "status", "--porcelain");
      expect(statusAfter).toBe(statusBefore);
    },
    GIT_IT_TIMEOUT_MS,
  );

  it(
    "captureChatCheckpoint 聚合多仓耗时",
    async () => {
      const r = await captureChatCheckpoint([REPO]);
      expect(r.ok).toBe(true);
      expect(r.repoSnapshots).toHaveLength(1);
      expect(r.elapsedMsByRepo[REPO]).toBeTypeOf("number");
    },
    GIT_IT_TIMEOUT_MS,
  );
});

describe("rewind_points.jsonl 读写与保留策略", () => {
  it("append 超过 MAX_REWIND_POINTS 时裁掉最老", async () => {
    await writeRewindPoints(TASK_ID, []);
    for (let i = 0; i < MAX_REWIND_POINTS + 3; i++) {
      await appendRewindPoint(TASK_ID, {
        eventId: `e_old_${i}`,
        createdAt: 1000 + i,
        repoSnapshots: [{ repoPath: REPO, treeOid: "a".repeat(40) }],
        kind: "checkpoint",
      });
    }
    const points = await readRewindPoints(TASK_ID);
    expect(points).toHaveLength(MAX_REWIND_POINTS);
    expect(points[0]!.eventId).toBe("e_old_3");
    expect(points[points.length - 1]!.eventId).toBe(
      `e_old_${MAX_REWIND_POINTS + 2}`,
    );
  });
});

describe("truncateEventsBeforeEventId", () => {
  it("截断到目标 eventId 之前（不含目标）", async () => {
    // 清 events
    await fs.writeFile(path.join(taskDir(TASK_ID), "events.jsonl"), "", "utf-8");

    const e1: TaskEvent = {
      id: newEventId(),
      ts: Date.now(),
      kind: "info",
      text: "a",
    };
    const e2: TaskEvent = {
      id: newEventId(),
      ts: Date.now() + 1,
      kind: "user_reply",
      text: "b",
      meta: { checkpointed: true },
    };
    const e3: TaskEvent = {
      id: newEventId(),
      ts: Date.now() + 2,
      kind: "assistant_message",
      text: "c",
    };
    await appendEventLine(TASK_ID, e1);
    await appendEventLine(TASK_ID, e2);
    await appendEventLine(TASK_ID, e3);

    const trunc = await truncateEventsBeforeEventId(TASK_ID, e2.id);
    expect(trunc).not.toBeNull();
    expect(trunc!.truncatedCount).toBe(2);
    expect(trunc!.kept.map((e) => e.id)).toEqual([e1.id]);

    const left = await readEvents(TASK_ID);
    expect(left.map((e) => e.id)).toEqual([e1.id]);
  });
});

describe("checkpoint refs 防 gc / 裁剪", () => {
  it(
    "GC 存活：append 后 gc --prune=now，tree 仍在且可 restore",
    async () => {
      await writeRewindPoints(TASK_ID, []);
      const snap = await snapshotRepoTree(REPO);
      expect(snap).toHaveProperty("treeOid");
      if ("error" in snap) throw new Error(snap.error);

      await appendRewindPoint(TASK_ID, {
        eventId: `e_gc_${Date.now()}`,
        createdAt: Date.now(),
        repoSnapshots: [{ repoPath: REPO, treeOid: snap.treeOid }],
        kind: "checkpoint",
      });

      expect(refExists(REPO, checkpointRefName(TASK_ID, snap.treeOid))).toBe(
        true,
      );

      git(REPO, "reflog", "expire", "--expire=now", "--all");
      git(REPO, "gc", "--prune=now");

      // ref 保活 → 对象仍在
      git(REPO, "cat-file", "-e", `${snap.treeOid}^{tree}`);

      await fs.writeFile(path.join(REPO, "tracked.txt"), "after-gc-dirty\n");
      const restored = await restoreRepoTree(REPO, snap.treeOid);
      expect(restored.ok).toBe(true);
      await expect(
        fs.readFile(path.join(REPO, "tracked.txt"), "utf8"),
      ).resolves.toBe("v1\n");
    },
    GIT_IT_TIMEOUT_MS,
  );

  it(
    "裁剪删 ref：超出 MAX 的旧点 ref 被删；共享 treeOid 不误删",
    async () => {
      await writeRewindPoints(TASK_ID, []);

      const uniqueOids: string[] = [];
      for (let i = 0; i < MAX_REWIND_POINTS + 3; i++) {
        await fs.writeFile(path.join(REPO, "tracked.txt"), `unique-${i}\n`);
        const snap = await snapshotRepoTree(REPO);
        if ("error" in snap) throw new Error(snap.error);
        uniqueOids.push(snap.treeOid);
        await appendRewindPoint(TASK_ID, {
          eventId: `e_unique_${i}`,
          createdAt: 2000 + i,
          repoSnapshots: [{ repoPath: REPO, treeOid: snap.treeOid }],
          kind: "checkpoint",
        });
      }

      // 被裁掉的前 3 条 ref 应已删
      for (let i = 0; i < 3; i++) {
        expect(refExists(REPO, checkpointRefName(TASK_ID, uniqueOids[i]!))).toBe(
          false,
        );
      }
      // 保留点的 ref 仍在
      for (let i = 3; i < uniqueOids.length; i++) {
        expect(refExists(REPO, checkpointRefName(TASK_ID, uniqueOids[i]!))).toBe(
          true,
        );
      }

      // 共享 treeOid：裁掉旧点后 ref 仍应在（剩余点还引用）
      await writeRewindPoints(TASK_ID, []);
      await fs.writeFile(path.join(REPO, "tracked.txt"), "shared-base\n");
      const shared = await snapshotRepoTree(REPO);
      if ("error" in shared) throw new Error(shared.error);

      for (let i = 0; i < MAX_REWIND_POINTS + 2; i++) {
        await appendRewindPoint(TASK_ID, {
          eventId: `e_shared_${i}`,
          createdAt: 3000 + i,
          repoSnapshots: [{ repoPath: REPO, treeOid: shared.treeOid }],
          kind: "checkpoint",
        });
      }
      expect(refExists(REPO, checkpointRefName(TASK_ID, shared.treeOid))).toBe(
        true,
      );
    },
    GIT_IT_TIMEOUT_MS,
  );

  it(
    "cleanupCheckpointRefsForTask：造两条点后清理，for-each-ref 为空",
    async () => {
      await writeRewindPoints(TASK_ID, []);

      const oids: string[] = [];
      for (let i = 0; i < 2; i++) {
        await fs.writeFile(path.join(REPO, "tracked.txt"), `cleanup-${i}\n`);
        const snap = await snapshotRepoTree(REPO);
        if ("error" in snap) throw new Error(snap.error);
        oids.push(snap.treeOid);
        await appendRewindPoint(TASK_ID, {
          eventId: `e_cleanup_${i}`,
          createdAt: 4000 + i,
          repoSnapshots: [{ repoPath: REPO, treeOid: snap.treeOid }],
          kind: "checkpoint",
        });
      }

      for (const oid of oids) {
        expect(refExists(REPO, checkpointRefName(TASK_ID, oid))).toBe(true);
      }

      await cleanupCheckpointRefsForTask(TASK_ID);

      const left = git(
        REPO,
        "for-each-ref",
        "--format=%(refname)",
        `refs/ai-flow/checkpoints/${TASK_ID}/`,
      );
      expect(left).toBe("");
    },
    GIT_IT_TIMEOUT_MS,
  );
});

describe("executeChatRewind 事务回滚与门闩", () => {
  it(
    "两仓场景：第二仓恢复失败时回滚第一仓，且落盘 pre_rewind",
    async () => {
      await writeMeta(makeMeta([REPO, REPO2]));
      await writeRewindPoints(TASK_ID, []);
      await fs.writeFile(
        path.join(taskDir(TASK_ID), "events.jsonl"),
        "",
        "utf-8",
      );

      const eventId = newEventId();
      const snap1 = await snapshotRepoTree(REPO);
      const snap2 = await snapshotRepoTree(REPO2);
      if ("error" in snap1) throw new Error(snap1.error);
      if ("error" in snap2) throw new Error(snap2.error);

      await appendRewindPoint(TASK_ID, {
        eventId,
        createdAt: Date.now(),
        repoSnapshots: [
          { repoPath: REPO, treeOid: snap1.treeOid },
          { repoPath: REPO2, treeOid: snap2.treeOid },
        ],
        kind: "checkpoint",
      });

      await appendEventLine(TASK_ID, {
        id: eventId,
        ts: Date.now(),
        kind: "user_reply",
        text: "to-rewind",
        meta: { checkpointed: true },
      } as TaskEvent);
      await appendEventLine(TASK_ID, {
        id: newEventId(),
        ts: Date.now() + 1,
        kind: "assistant_message",
        text: "after",
      } as TaskEvent);

      // rewind 前改两仓内容（安全快照会记住这些）
      await fs.writeFile(path.join(REPO, "tracked.txt"), "pre-rewind-repo1\n");
      await fs.writeFile(path.join(REPO2, "tracked.txt"), "pre-rewind-repo2\n");

      // 第二仓：把 treeOid 改成不存在的，使 restore 失败。
      // 为绕过 preflight 的 cat-file，先写入合法点，再在锁外把第二仓 oid 换成假的——
      // 但 preflight 会拦住。改用只读工作区让 read-tree -u 失败（tree 对象仍在）。
      await fs.chmod(path.join(REPO2, "tracked.txt"), 0o444);
      await fs.chmod(REPO2, 0o555);

      try {
        await expect(
          executeChatRewind(TASK_ID, eventId, stubRewindDeps()),
        ).rejects.toMatchObject({
          name: "RewindError",
          code: "restore_failed",
        });

        // 第一仓应已回滚到 rewind 前（不是 checkpoint 的 v1）
        await expect(
          fs.readFile(path.join(REPO, "tracked.txt"), "utf8"),
        ).resolves.toBe("pre-rewind-repo1\n");

        const points = await readRewindPoints(TASK_ID);
        expect(points.some((p) => p.kind === "pre_rewind")).toBe(true);
      } finally {
        // 超时也会走 afterEach 的 wipe；这里仍立刻恢复权限，避免拖到下一轮 reset
        await fs.chmod(REPO2, 0o755).catch(() => {});
        await fs
          .chmod(path.join(REPO2, "tracked.txt"), 0o644)
          .catch(() => {});
      }
    },
    GIT_IT_TIMEOUT_MS,
  );

  it(
    "后置写盘失败（11 轮改约）：truncate 已提交 → 前滚收尾按成功返回，不回滚仓库 / 不写回 events",
    async () => {
      const eventId = newEventId();
      const snap = await seedSingleRepoRewind(eventId);

      await fs.writeFile(path.join(REPO, "tracked.txt"), "pre-rewind-dirty\n");
      const eventsBefore = await fs.readFile(
        path.join(taskDir(TASK_ID), "events.jsonl"),
        "utf-8",
      );

      const spy = vi
        .spyOn(taskFsCore, "writeMeta")
        .mockRejectedValueOnce(new Error("writeMeta boom"));

      try {
        // truncate 成功后 writeMeta 失败 → 前滚：按成功 resolve，绝不 5xx 诱导重试破坏性 rewind
        const res = await executeChatRewind(TASK_ID, eventId, stubRewindDeps());
        expect(res.ok).toBe(true);

        // 仓库停在目标 tree（不回滚）——「仓库 + 对话」已双双到位
        await expect(
          fs.readFile(path.join(REPO, "tracked.txt"), "utf8"),
        ).resolves.toBe("v1\n");

        // events 已截断（不写回原文）
        const eventsAfter = await fs.readFile(
          path.join(taskDir(TASK_ID), "events.jsonl"),
          "utf-8",
        );
        expect(eventsAfter).not.toBe(eventsBefore);

        // 目标点已消费移除；pre_rewind 安全点保留
        const points = await readRewindPoints(TASK_ID);
        expect(points.some((p) => p.eventId === eventId)).toBe(false);
        expect(points.some((p) => p.kind === "pre_rewind")).toBe(true);

        // 前滚补写 meta（mock 只拒一次、重试成功）：runStatus 归位 idle、锚点已清
        const metaRaw = JSON.parse(
          await fs.readFile(path.join(taskDir(TASK_ID), "meta.json"), "utf-8"),
        ) as { runStatus?: string; sessionAgentId?: string };
        expect(metaRaw.runStatus).toBe("idle");
        expect(metaRaw.sessionAgentId).toBeUndefined();
      } finally {
        spy.mockRestore();
      }

      // 前滚路径不 prune refs（多留无害）：gc 后目标 tree 仍在
      git(REPO, "reflog", "expire", "--expire=now", "--all");
      git(REPO, "gc", "--prune=now");
      git(REPO, "cat-file", "-e", `${snap.treeOid}^{tree}`);
    },
    GIT_IT_TIMEOUT_MS,
  );

  it(
    "安全快照失败中止：非 git 仓 → restore_failed，目标仓未改动",
    async () => {
      const notGit = path.join(TMP_ROOT, "not-a-git-dir");
      await fs.mkdir(notGit, { recursive: true });
      await writeMeta(makeMeta([REPO, notGit]));

      const eventId = newEventId();
      await seedSingleRepoRewind(eventId);
      await fs.writeFile(path.join(REPO, "tracked.txt"), "must-stay\n");

      await expect(
        executeChatRewind(TASK_ID, eventId, stubRewindDeps()),
      ).rejects.toMatchObject({
        name: "RewindError",
        code: "restore_failed",
        message: expect.stringMatching(/安全快照/),
      });

      await expect(
        fs.readFile(path.join(REPO, "tracked.txt"), "utf8"),
      ).resolves.toBe("must-stay\n");
    },
    GIT_IT_TIMEOUT_MS,
  );


  it(
    "drain 互斥：isQueueDraining → run_active 且不动文件",
    async () => {
      const eventId = newEventId();
      await seedSingleRepoRewind(eventId);
      await fs.writeFile(path.join(REPO, "tracked.txt"), "drain-keep\n");

      await expect(
        executeChatRewind(
          TASK_ID,
          eventId,
          stubRewindDeps({ isQueueDraining: () => true }),
        ),
      ).rejects.toMatchObject({
        name: "RewindError",
        code: "run_active",
        message: expect.stringContaining("正在发送排队消息"),
      });

      await expect(
        fs.readFile(path.join(REPO, "tracked.txt"), "utf8"),
      ).resolves.toBe("drain-keep\n");
    },
    GIT_IT_TIMEOUT_MS,
  );

  it(
    "门闩：tryBeginChatRewind 占住后 executeChatRewind 抛 run_active",
    async () => {
      await writeRewindPoints(TASK_ID, []);
      await fs.writeFile(
        path.join(taskDir(TASK_ID), "events.jsonl"),
        "",
        "utf-8",
      );

      const eventId = newEventId();
      const snap = await snapshotRepoTree(REPO);
      if ("error" in snap) throw new Error(snap.error);
      await appendRewindPoint(TASK_ID, {
        eventId,
        createdAt: Date.now(),
        repoSnapshots: [{ repoPath: REPO, treeOid: snap.treeOid }],
        kind: "checkpoint",
      });
      await appendEventLine(TASK_ID, {
        id: eventId,
        ts: Date.now(),
        kind: "user_reply",
        text: "x",
        meta: { checkpointed: true },
      } as TaskEvent);

      await fs.writeFile(path.join(REPO, "tracked.txt"), "should-stay\n");

      expect(tryBeginChatRewind(TASK_ID)).toBe(true);
      try {
        await expect(
          executeChatRewind(TASK_ID, eventId, stubRewindDeps()),
        ).rejects.toMatchObject({
          name: "RewindError",
          code: "run_active",
          message: expect.stringContaining("已有回退在进行中"),
        });
        await expect(
          fs.readFile(path.join(REPO, "tracked.txt"), "utf8"),
        ).resolves.toBe("should-stay\n");
      } finally {
        endChatRewind(TASK_ID);
      }
    },
    GIT_IT_TIMEOUT_MS,
  );

  it(
    "门闩：hasChatStartReservation 占位时 rewind 拒绝且不动文件",
    async () => {
      await writeRewindPoints(TASK_ID, []);
      await fs.writeFile(
        path.join(taskDir(TASK_ID), "events.jsonl"),
        "",
        "utf-8",
      );

      const eventId = newEventId();
      const snap = await snapshotRepoTree(REPO);
      if ("error" in snap) throw new Error(snap.error);
      await appendRewindPoint(TASK_ID, {
        eventId,
        createdAt: Date.now(),
        repoSnapshots: [{ repoPath: REPO, treeOid: snap.treeOid }],
        kind: "checkpoint",
      });
      await appendEventLine(TASK_ID, {
        id: eventId,
        ts: Date.now(),
        kind: "user_reply",
        text: "x",
        meta: { checkpointed: true },
      } as TaskEvent);

      await fs.writeFile(path.join(REPO, "tracked.txt"), "reservation-keep\n");

      expect(tryReserveChatStart(TASK_ID)).toEqual(expect.any(Number));
      try {
        let err: unknown;
        try {
          await executeChatRewind(TASK_ID, eventId, stubRewindDeps());
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(RewindError);
        expect((err as InstanceType<typeof RewindError>).code).toBe(
          "run_active",
        );
        expect((err as InstanceType<typeof RewindError>).message).toMatch(
          /启动新会话/,
        );
        await expect(
          fs.readFile(path.join(REPO, "tracked.txt"), "utf8"),
        ).resolves.toBe("reservation-keep\n");
      } finally {
        releaseChatStart(TASK_ID);
      }
    },
    GIT_IT_TIMEOUT_MS,
  );
});
