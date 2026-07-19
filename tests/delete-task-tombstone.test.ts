/**
 * Windows EBUSY 删除降级：tombstone + listTasks skip + boot 清扫
 *
 * 回归（v1.1.20 诊断包）：目录句柄被残留 shell 子进程占用时 fs.rm 长期失败，
 * deleteTask 应降级写 tombstone、卸 meta，boot 只清带标记的目录。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；ESM 静态 import 会 hoist，
 * 必须先钉 FLOWSHIP_DATA_DIR 再动态 import，否则全量并行时多文件撞 cwd/data/tasks。
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

// OS 保证唯一；必须在动态 import 之前钉死 env
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-delete-tombstone-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const {
  DATA_DIR,
  DELETED_TOMBSTONE_FILE,
  META_FILE,
  taskDir,
  writeMeta,
} = await import("@/lib/server/task-fs-core");
const { deleteTask, getTask, listTasks } = await import("@/lib/server/task-fs");

if (!DATA_DIR.startsWith(TMP_ROOT)) {
  throw new Error(`delete-tombstone DATA_DIR 未隔离到 TMP：${DATA_DIR}`);
}

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";

/** 跳过真实 boot recovery（含 tombstone 清扫），方便测 listTasks skip */
const skipBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  g[RECOVERY_FLAG] = Promise.resolve();
};

/** 清掉 recovery 单例，下次 listTasks 会重新跑 boot（含 tombstone 清扫） */
const resetBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  delete g[RECOVERY_FLAG];
};

const baseMeta = (id: string, title: string): TaskMetaV06 => ({
  id,
  title,
  repoStatus: "developing",
  runStatus: "idle",
  currentActionId: null,
  actions: [],
  mrs: [],
  repoPaths: [],
  createdAt: 1_000,
  updatedAt: 1_000,
});

const seedTask = async (id: string, title: string): Promise<void> => {
  await writeMeta(baseMeta(id, title));
};

const writeTombstone = async (id: string): Promise<void> => {
  await fs.writeFile(
    path.join(taskDir(id), DELETED_TOMBSTONE_FILE),
    JSON.stringify({ deletedAt: Date.now() }),
    "utf-8",
  );
};

const dirExists = async (dir: string): Promise<boolean> => {
  try {
    await fs.access(dir);
    return true;
  } catch {
    return false;
  }
};

afterAll(async () => {
  resetBootRecovery();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  skipBootRecovery();
  // 每测清空 tasks 目录，避免串扰
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteTask tombstone 降级", () => {
  it("fs.rm 抛 EBUSY → 写 tombstone、删 meta、返回 true", async () => {
    const id = "t_busy_1";
    await seedTask(id, "被锁任务");

    const busy = Object.assign(new Error("EBUSY: resource busy or locked"), {
      code: "EBUSY",
    });
    vi.spyOn(fs, "rm").mockRejectedValue(busy);

    const ok = await deleteTask(id);
    expect(ok).toBe(true);

    const dir = taskDir(id);
    expect(await dirExists(dir)).toBe(true);
    expect(await dirExists(path.join(dir, DELETED_TOMBSTONE_FILE))).toBe(true);
    expect(await dirExists(path.join(dir, META_FILE))).toBe(false);

    const raw = await fs.readFile(
      path.join(dir, DELETED_TOMBSTONE_FILE),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as { deletedAt: number };
    expect(typeof parsed.deletedAt).toBe("number");
  });

  it("fs.rm 抛其它错误 → 仍抛出", async () => {
    const id = "t_other_err";
    await seedTask(id, "其它错误");
    const boom = Object.assign(new Error("EIO"), { code: "EIO" });
    vi.spyOn(fs, "rm").mockRejectedValue(boom);
    await expect(deleteTask(id)).rejects.toThrow(/EIO/);
  });
});

describe("listTasks skip tombstone", () => {
  it("带 tombstone 的目录即使仍有 meta 也不进列表", async () => {
    await seedTask("t_live", "正常任务");
    await seedTask("t_ghost", "幽灵任务");
    await writeTombstone("t_ghost");

    const list = await listTasks();
    expect(list.map((t) => t.id)).toEqual(["t_live"]);
  });
});

describe("getTask skip tombstone", () => {
  it("带 tombstone 即使仍有 meta 也返回 null", async () => {
    await seedTask("t_ghost_get", "幽灵直连");
    await writeTombstone("t_ghost_get");

    expect(await getTask("t_ghost_get")).toBeNull();
  });
});

describe("boot tombstone 清扫", () => {
  it("只删带 tombstone 的目录，不碰无标记目录", async () => {
    await seedTask("t_keep", "应保留");
    // 无 meta 的手工 fixture 目录——绝不能误删
    const fixture = path.join(DATA_DIR, "bench-fixture");
    await fs.mkdir(fixture, { recursive: true });
    await fs.writeFile(path.join(fixture, "note.txt"), "keep me", "utf-8");

    // 已降级：有 tombstone、meta 已卸
    const tombId = "t_tomb";
    await fs.mkdir(taskDir(tombId), { recursive: true });
    await writeTombstone(tombId);
    await fs.writeFile(
      path.join(taskDir(tombId), "events.jsonl"),
      "{}\n",
      "utf-8",
    );

    resetBootRecovery();
    const list = await listTasks();

    expect(list.map((t) => t.id)).toEqual(["t_keep"]);
    expect(await dirExists(taskDir("t_keep"))).toBe(true);
    expect(await dirExists(fixture)).toBe(true);
    expect(await dirExists(taskDir(tombId))).toBe(false);
  });
});
