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
import { META_FILE, withTaskLock } from "@/lib/server/task-fs-core";

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

// 第五轮评审 P2：迁移由 boot-warmup 在 server 就绪后后台触发，此时用户已经能操作任务。
// 「读 meta → 改 → 整份写回」不加任务锁，会拿旧快照盖掉别的写者（withTaskLock 里）刚写的字段。
describe("migrateUsernameBranchTemplates：和任务锁里的写者并发", () => {
  const metaFile = (id: string) => path.join(tasksRoot(), id, META_FILE);
  const readMeta = async (id: string) =>
    JSON.parse(await fs.readFile(metaFile(id), "utf-8")) as Record<string, unknown>;
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** 模拟任务锁里的写者：持锁后先读一份快照，等 gate 放行再把（改过的）快照整份写回——和 task-fs 的读-改-写同形 */
  const startLockedWriter = async (id: string, mutate: (snap: Record<string, unknown>) => void) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held!: () => void;
    const heldP = new Promise<void>((r) => {
      held = r;
    });
    const done = withTaskLock(id, async () => {
      const snap = await readMeta(id);
      held();
      await gate;
      mutate(snap);
      await fs.writeFile(metaFile(id), JSON.stringify(snap, null, 2), "utf-8");
    });
    await heldP;
    return { release, done };
  };

  it("写者持锁期间迁移要等它：写者写的字段（runStatus / updatedAt）保留，残留也清干净", async () => {
    await writeFakeMeta("task_race", {
      repoBranchTemplates: {
        "/repo/a": "feature/{username}/x",
        "/repo/b": "feature/{storyId}",
      },
    });
    const w = await startLockedWriter("task_race", (snap) => {
      snap.runStatus = "running";
      snap.updatedAt = 999;
    });
    const m = migrateUsernameBranchTemplates();
    await wait(50); // 无锁的实现此刻早已用旧快照写完了
    w.release();
    await w.done;
    const n = await m;

    expect(n).toBe(1);
    const meta = await readMeta("task_race");
    expect(meta.runStatus).toBe("running");
    expect(meta.updatedAt).toBe(999);
    expect(meta.repoBranchTemplates).toEqual({ "/repo/b": "feature/{storyId}" });
  });

  it("预检之后别人已经把残留清掉了：锁内重读重判，不再写（返回 0），别人写的内容原样", async () => {
    await writeFakeMeta("task_cleaned", {
      repoBranchTemplates: { "/repo/a": "feature/{username}/x" },
    });
    const w = await startLockedWriter("task_cleaned", (snap) => {
      snap.repoBranchTemplates = undefined;
      snap.runStatus = "running";
    });
    const m = migrateUsernameBranchTemplates();
    await wait(50);
    w.release();
    await w.done;

    expect(await m).toBe(0);
    const meta = await readMeta("task_cleaned");
    expect(meta.runStatus).toBe("running");
    expect(meta.repoBranchTemplates).toBeUndefined();
  });

  it("没有残留的任务不拿锁：别人长时间持有它的锁也不拖住迁移（稳态零排队）", async () => {
    await writeFakeMeta("task_clean_busy", { repoBranchTemplates: { "/repo/a": "feature/{storyId}" } });
    const w = await startLockedWriter("task_clean_busy", () => {});
    try {
      const outcome = await Promise.race([
        migrateUsernameBranchTemplates(),
        wait(1000).then(() => "blocked" as const),
      ]);
      expect(outcome).toBe(0);
    } finally {
      w.release();
      await w.done;
    }
  });
});
