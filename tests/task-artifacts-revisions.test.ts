/**
 * artifact revision 剪枝 / 防增量相同快照（问句插话零差异误亮修订开关）
 *
 * 回归：
 * - pruneIdenticalRevisions：尾部与当前正文相同的快照被清；中间不同的保留
 * - snapshotActionArtifact：最新一份已相同则跳过写入
 * - shouldPruneIdenticalRevisionsOnList：running 态闸（route 调 prune 前判定；
 *   prune 本身不感知状态——agent 活跃时 route 跳过 prune，只列不清）
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-task-artifacts-rev-${Date.now()}`);
process.env.FE_AI_FLOW_DATA_DIR = TMP_ROOT;

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import { taskDir, writeMeta } from "@/lib/server/task-fs-core";
import {
  listActionRevisions,
  pruneIdenticalRevisions,
  shouldPruneIdenticalRevisionsOnList,
  snapshotActionArtifact,
} from "@/lib/server/task-artifacts";
import type { ActionRecord, ArtifactRevision, Task } from "@/lib/types";

const TASK_ID = "t_rev_test_1";
const ACTION_ID = "act_1";
const ARTIFACT_REL = "actions/1-plan.md";

const baseAction = (revisions: ArtifactRevision[] = []): ActionRecord => ({
  id: ACTION_ID,
  n: 1,
  type: "plan",
  status: "awaiting_ack",
  userInstruction: "写方案",
  artifactPath: ARTIFACT_REL,
  startedAt: 1_000,
  endedAt: null,
  revisions,
});

const baseMeta = (revisions: ArtifactRevision[] = []): TaskMetaV06 => ({
  id: TASK_ID,
  title: "修订剪枝单测",
  repoStatus: "developing",
  runStatus: "awaiting_user",
  currentActionId: ACTION_ID,
  actions: [baseAction(revisions)],
  mrs: [],
  role: "fe",
  repoPaths: ["/tmp/fake-repo"],
  createdAt: 1_000,
  updatedAt: 1_000,
});

/** 写当前 artifact + 若干 revision 文件，并把 meta 落盘 */
const seed = async (opts: {
  current: string;
  revisions: Array<{ timestamp: number; content: string }>;
}): Promise<void> => {
  const dir = taskDir(TASK_ID);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, "actions", ".revisions", ACTION_ID), {
    recursive: true,
  });
  await fs.writeFile(path.join(dir, ARTIFACT_REL), opts.current, "utf-8");

  const revs: ArtifactRevision[] = [];
  for (const r of opts.revisions) {
    const rel = path.join(
      "actions",
      ".revisions",
      ACTION_ID,
      `${r.timestamp}.md`,
    );
    await fs.writeFile(path.join(dir, rel), r.content, "utf-8");
    revs.push({
      timestamp: r.timestamp,
      path: rel,
      size: Buffer.byteLength(r.content, "utf-8"),
    });
  }
  await writeMeta(baseMeta(revs));
};

const revExists = async (timestamp: number): Promise<boolean> => {
  const abs = path.join(
    taskDir(TASK_ID),
    "actions",
    ".revisions",
    ACTION_ID,
    `${timestamp}.md`,
  );
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true });
});

describe("pruneIdenticalRevisions", () => {
  it("尾部与当前正文相同 → 文件 + meta 一并清掉", async () => {
    // 旧版不同、最新两份与当前相同（连续插话堆出来的）
    await seed({
      current: "# 当前方案\n未改\n",
      revisions: [
        { timestamp: 100, content: "# 旧方案\n已改过\n" },
        { timestamp: 200, content: "# 当前方案\n未改\n" },
        { timestamp: 300, content: "# 当前方案\n未改\n" },
      ],
    });

    await pruneIdenticalRevisions(TASK_ID, ACTION_ID);

    const listed = await listActionRevisions(TASK_ID, ACTION_ID);
    expect(listed.map((r) => r.timestamp)).toEqual([100]);
    expect(await revExists(100)).toBe(true);
    expect(await revExists(200)).toBe(false);
    expect(await revExists(300)).toBe(false);
  });

  it("中间有不同快照 → 只清尾部相同、中间不同的保留", async () => {
    // 时间线：相同 → 不同 → 相同（尾部）。从新往旧：清 300、停在 200（不同）
    await seed({
      current: "# 当前\n",
      revisions: [
        { timestamp: 100, content: "# 当前\n" },
        { timestamp: 200, content: "# 中间改过\n" },
        { timestamp: 300, content: "# 当前\n" },
      ],
    });

    await pruneIdenticalRevisions(TASK_ID, ACTION_ID);

    const listed = await listActionRevisions(TASK_ID, ACTION_ID);
    expect(listed.map((r) => r.timestamp)).toEqual([100, 200]);
    expect(await revExists(100)).toBe(true);
    expect(await revExists(200)).toBe(true);
    expect(await revExists(300)).toBe(false);
  });

  it("无 revisions / 当前读不到 → no-op", async () => {
    await seed({ current: "# x\n", revisions: [] });
    await expect(
      pruneIdenticalRevisions(TASK_ID, ACTION_ID),
    ).resolves.toBeUndefined();

    // 有 meta revisions 但删掉当前 artifact
    await seed({
      current: "# x\n",
      revisions: [{ timestamp: 1, content: "# x\n" }],
    });
    await fs.unlink(path.join(taskDir(TASK_ID), ARTIFACT_REL));
    await pruneIdenticalRevisions(TASK_ID, ACTION_ID);
    expect((await listActionRevisions(TASK_ID, ACTION_ID)).length).toBe(1);
  });
});

describe("shouldPruneIdenticalRevisionsOnList（running 态不清理闸）", () => {
  const idleTask = (actionStatus: ActionRecord["status"]): Pick<
    Task,
    "runStatus" | "actions"
  > => ({
    runStatus: "awaiting_user",
    actions: [{ ...baseAction(), status: actionStatus }],
  });

  it("task.runStatus === running → 跳过 prune", () => {
    expect(
      shouldPruneIdenticalRevisionsOnList(
        { runStatus: "running", actions: [baseAction()] },
        ACTION_ID,
      ),
    ).toBe(false);
  });

  it("该 action status === running → 跳过 prune", () => {
    expect(
      shouldPruneIdenticalRevisionsOnList(idleTask("running"), ACTION_ID),
    ).toBe(false);
  });

  it("idle + awaiting_ack → 允许 prune", () => {
    expect(
      shouldPruneIdenticalRevisionsOnList(idleTask("awaiting_ack"), ACTION_ID),
    ).toBe(true);
  });
});

describe("snapshotActionArtifact 防增量相同", () => {
  it("最新 revision 内容 === 当前正文 → 跳过写入、不增 meta", async () => {
    await seed({
      current: "# 相同正文\n",
      revisions: [{ timestamp: 100, content: "# 相同正文\n" }],
    });

    const result = await snapshotActionArtifact(TASK_ID, ACTION_ID);
    expect(result).toBeNull();
    expect((await listActionRevisions(TASK_ID, ACTION_ID)).length).toBe(1);
  });

  it("最新 revision 与当前不同 → 正常追加", async () => {
    await seed({
      current: "# 新正文\n",
      revisions: [{ timestamp: 100, content: "# 旧正文\n" }],
    });

    const result = await snapshotActionArtifact(TASK_ID, ACTION_ID);
    expect(result).not.toBeNull();
    expect((await listActionRevisions(TASK_ID, ACTION_ID)).length).toBe(2);
  });
});
