/**
 * M2：历史 task meta 里 repoBranchTemplates 的 {username} 残留清理
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TMP_DATA = path.join(os.tmpdir(), `fe-migrate-username-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_DATA;

import {
  migrateUsernameBranchTemplates,
  pruneUsernameBranchTemplates,
} from "@/lib/server/migrate-username-templates";
import { META_FILE } from "@/lib/server/task-fs-core";

const tasksRoot = () => path.join(TMP_DATA, "tasks");

const writeFakeMeta = async (
  id: string,
  partial: Record<string, unknown>,
): Promise<void> => {
  const dir = path.join(tasksRoot(), id);
  await fs.mkdir(dir, { recursive: true });
  // 最小合法 V0.6 meta 形状（isValidMetaShape 过关即可）
  const meta = {
    id,
    title: "t",
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: ["/repo/a"],
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
  await fs.writeFile(
    path.join(dir, META_FILE),
    JSON.stringify(meta, null, 2),
    "utf-8",
  );
};

beforeAll(async () => {
  await fs.mkdir(TMP_DATA, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_DATA, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(tasksRoot(), { recursive: true, force: true });
  await fs.mkdir(tasksRoot(), { recursive: true });
});

describe("pruneUsernameBranchTemplates", () => {
  it("只删含 {username} 的条目、其它原样", () => {
    const { changed, next } = pruneUsernameBranchTemplates({
      "/repo/a": "feature/{username}/{storyId}",
      "/repo/b": "feature/{storyId}-{taskTitle}",
      "/repo/c": "feat/{date:MM-dd}/{storyId}",
    });
    expect(changed).toBe(true);
    expect(next).toEqual({
      "/repo/b": "feature/{storyId}-{taskTitle}",
      "/repo/c": "feat/{date:MM-dd}/{storyId}",
    });
  });

  it("全是坏值 → next 为 undefined（空 map）", () => {
    const { changed, next } = pruneUsernameBranchTemplates({
      "/repo/a": "feature/{username}/x",
    });
    expect(changed).toBe(true);
    expect(next).toBeUndefined();
  });

  it("无残留 → changed=false、引用不变", () => {
    const src = { "/repo/a": "feature/{storyId}" };
    const { changed, next } = pruneUsernameBranchTemplates(src);
    expect(changed).toBe(false);
    expect(next).toBe(src);
  });
});

describe("migrateUsernameBranchTemplates", () => {
  it("扫 meta：删 {username} override、其它字段原样；二次跑幂等", async () => {
    await writeFakeMeta("task_keep", {
      repoBranchTemplates: {
        "/repo/a": "feature/{username}/{storyId}-{taskTitle}",
        "/repo/b": "feature/{storyId}-{taskTitle}",
      },
      feishuStoryUrl: "https://example.com/detail/123456",
      pinned: true,
    });
    await writeFakeMeta("task_clean", {
      repoBranchTemplates: {
        "/repo/a": "feature/{storyId}",
      },
    });

    const n1 = await migrateUsernameBranchTemplates();
    expect(n1).toBe(1);

    const kept = JSON.parse(
      await fs.readFile(
        path.join(tasksRoot(), "task_keep", META_FILE),
        "utf-8",
      ),
    ) as {
      repoBranchTemplates?: Record<string, string>;
      feishuStoryUrl?: string;
      pinned?: boolean;
      title: string;
    };
    expect(kept.repoBranchTemplates).toEqual({
      "/repo/b": "feature/{storyId}-{taskTitle}",
    });
    // 其它字段原样
    expect(kept.feishuStoryUrl).toBe("https://example.com/detail/123456");
    expect(kept.pinned).toBe(true);
    expect(kept.title).toBe("t");

    const clean = JSON.parse(
      await fs.readFile(
        path.join(tasksRoot(), "task_clean", META_FILE),
        "utf-8",
      ),
    ) as { repoBranchTemplates?: Record<string, string> };
    expect(clean.repoBranchTemplates).toEqual({
      "/repo/a": "feature/{storyId}",
    });

    // 幂等：第二次零操作
    const n2 = await migrateUsernameBranchTemplates();
    expect(n2).toBe(0);
  });
});
