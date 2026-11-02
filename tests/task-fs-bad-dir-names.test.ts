/**
 * `tasks/` 下混进不符合 id 白名单的目录（`abc copy` / `abc.bak` / 中文名…）不能拖垮任务扫描。
 *
 * 回归（P1）：三处扫描（tombstone 清扫 / boot recovery / listTasksWithCorrupt）曾把目录名直接当 id，
 * `taskDir()` 在白名单处抛错——boot recovery 整体 reject 被顶层 `.catch` 吞掉、promise 已缓存不重试
 * （僵尸 running 任务不标 error、孤儿 worktree 不清、SDK store GC 不跑），`/api/tasks` 500、侧栏整个为空。
 * 现在统一走 `listTaskDirIds()`（readdir + isDirectory + id 白名单），循环里每个 id 单独 try/catch。
 *
 * DATA_DIR 在 task-fs-core 模块加载时冻结：必须先钉 FLOWSHIP_DATA_DIR 再动态 import（同 delete-task-tombstone.test.ts）。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

// boot recovery 末尾会 fire-and-forget 一轮 SDK store 瘦身：它在 `<DATA_DIR>/sdk-agent-store` 下后台写文件，
// 会与 afterAll 的 rm 交错（ENOTEMPTY）。本文件测扫描，与 GC 无关，只桩掉这个后台动作（同 delete-task-tombstone.test.ts）
vi.mock("@/lib/server/sdk-store-gc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/sdk-store-gc")>()),
  maybeGcSdkStore: vi.fn(),
}));

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-task-bad-dirs-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const { DATA_DIR, DELETED_TOMBSTONE_FILE, META_FILE, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { listTaskDirIds, listTasks, listTasksWithCorrupt } = await import("@/lib/server/task-fs");
const { setFailpoint, clearFailpoints } = await import("@/lib/server/failpoints");

if (!DATA_DIR.startsWith(TMP_ROOT)) {
  throw new Error(`bad-dir-names DATA_DIR 未隔离到 TMP：${DATA_DIR}`);
}

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
const skipBootRecovery = (): void => {
  g[RECOVERY_FLAG] = Promise.resolve();
};
const resetBootRecovery = (): void => {
  delete g[RECOVERY_FLAG];
};

const baseMeta = (id: string, patch: Partial<TaskMetaV06> = {}): TaskMetaV06 => ({
  id,
  title: `任务 ${id}`,
  mode: "chat",
  repoStatus: "developing",
  runStatus: "idle",
  currentActionId: null,
  actions: [],
  mrs: [],
  repoPaths: [],
  createdAt: 1_000,
  updatedAt: 1_000,
  ...patch,
});

/** 在 tasks/ 下手工造一个「不合法 id」的目录，里面放一份看起来像任务的 meta（模拟 `cp -r abc "abc copy"`） */
const seedBadDir = async (
  name: string,
  meta: TaskMetaV06,
  opts: { tombstone?: boolean } = {},
): Promise<{ dir: string; metaText: string }> => {
  const dir = path.join(DATA_DIR, name);
  await fs.mkdir(dir, { recursive: true });
  const metaText = JSON.stringify(meta);
  await fs.writeFile(path.join(dir, META_FILE), metaText, "utf-8");
  if (opts.tombstone) {
    await fs.writeFile(path.join(dir, DELETED_TOMBSTONE_FILE), "{}", "utf-8");
  }
  return { dir, metaText };
};

const dirExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

const readMetaText = (id: string): Promise<string> =>
  fs.readFile(path.join(taskDir(id), META_FILE), "utf-8");

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  skipBootRecovery();
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
});

afterEach(() => {
  clearFailpoints();
  vi.restoreAllMocks();
});

afterAll(async () => {
  resetBootRecovery();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("listTaskDirIds", () => {
  it("只返回合法 id 的目录：滤掉带空格 / 点号 / 中文的目录与普通文件", async () => {
    await writeMeta(baseMeta("t_ok_1"));
    await fs.mkdir(path.join(DATA_DIR, "bench-fixture"), { recursive: true }); // 合法（无 meta 的手工目录照旧返回）
    await fs.mkdir(path.join(DATA_DIR, "t_x-y_2"), { recursive: true });
    for (const bad of ["abc copy", "abc.bak", "t_ok_1 (1)", "中文目录", ".hidden", "a_b x"]) {
      await fs.mkdir(path.join(DATA_DIR, bad), { recursive: true });
    }
    await fs.writeFile(path.join(DATA_DIR, "note.txt"), "x", "utf-8");

    expect((await listTaskDirIds()).sort()).toEqual(["bench-fixture", "t_ok_1", "t_x-y_2"]);
  });

  it("readdir 本身失败仍抛给调用方（各调用点按原口径处理）", async () => {
    await fs.rm(DATA_DIR, { recursive: true, force: true });
    await expect(listTaskDirIds()).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("listTasksWithCorrupt：坏目录名不让列表 500", () => {
  it("`abc copy` / `abc.bak` 混在里面：正常任务照常列出，坏目录既不报错也不进列表", async () => {
    await writeMeta(baseMeta("t_live_1"));
    await writeMeta(baseMeta("t_live_2"));
    await seedBadDir("t_live_1 copy", baseMeta("t_live_1"));
    await seedBadDir("abc.bak", baseMeta("abc"));
    await seedBadDir("中文备份", baseMeta("zh"));

    const { tasks, corrupt } = await listTasksWithCorrupt();
    expect(tasks.map((t) => t.id).sort()).toEqual(["t_live_1", "t_live_2"]);
    expect(corrupt).toEqual([]);
    // listTasks 同口径
    expect((await listTasks()).map((t) => t.id).sort()).toEqual(["t_live_1", "t_live_2"]);
  });

  it("每个 id 单独 try/catch：某个任务处理时抛错只让它自己消失，不拖垮其余任务", async () => {
    await writeMeta(baseMeta("t_a_1"));
    await writeMeta(baseMeta("t_b_2"));
    let hits = 0;
    setFailpoint("listTasks.afterReadMeta", () => {
      hits += 1;
      if (hits === 1) throw new Error("boom：模拟该任务处理中的意外");
    });

    const { tasks } = await listTasksWithCorrupt();
    expect(hits).toBe(2);
    // 恰好少一个（谁先扫由 readdir 顺序决定），另一个必须在
    expect(tasks).toHaveLength(1);
    expect(["t_a_1", "t_b_2"]).toContain(tasks[0]!.id);
  });
});

describe("boot recovery：坏目录名不让启动恢复整体中止", () => {
  it("僵尸 running 任务照常被标 error，坏目录里的「副本」原样不动", async () => {
    await writeMeta(baseMeta("t_zombie_1", { runStatus: "running" }));
    await writeMeta(baseMeta("t_idle_1"));
    // 备份脚本 / 手工复制出来的副本：里面是同样的 running meta——绝不能被当任务恢复（也不能让恢复崩）
    const copy = await seedBadDir("t_zombie_1 copy", baseMeta("t_zombie_1", { runStatus: "running" }));
    const bak = await seedBadDir("t_zombie_1.bak", baseMeta("t_zombie_1", { runStatus: "running" }));

    resetBootRecovery();
    const tasks = await listTasks();

    // 恢复跑完了：僵尸被标 error 并追加了 boot-recovery 事件（修前整体 reject → 这里仍是 running）
    const recovered = JSON.parse(await readMetaText("t_zombie_1")) as TaskMetaV06;
    expect(recovered.runStatus).toBe("error");
    expect(await fs.readFile(path.join(taskDir("t_zombie_1"), "events.jsonl"), "utf-8")).toContain(
      "[boot-recovery]",
    );
    expect(tasks.map((t) => t.id).sort()).toEqual(["t_idle_1", "t_zombie_1"]);

    // 副本原样：meta 字节不变、没有被追加事件
    for (const c of [copy, bak]) {
      expect(await fs.readFile(path.join(c.dir, META_FILE), "utf-8")).toBe(c.metaText);
      expect(await dirExists(path.join(c.dir, "events.jsonl"))).toBe(false);
    }
  });

  it("tombstone 清扫：合法的带标记目录被清掉；坏目录名下的 tombstone 不碰（不是任务、绝不误删）", async () => {
    await writeMeta(baseMeta("t_keep_1"));
    // 已降级删除：有 tombstone、meta 已卸
    await fs.mkdir(taskDir("t_tomb_1"), { recursive: true });
    await fs.writeFile(path.join(taskDir("t_tomb_1"), DELETED_TOMBSTONE_FILE), "{}", "utf-8");
    // 名字排在合法目录前 / 后的坏目录各一个：谁先谁后都不能影响合法目录的清扫
    const before = await seedBadDir("0 bad before", baseMeta("x1"), { tombstone: true });
    const after = await seedBadDir("zzz bad after", baseMeta("x2"), { tombstone: true });

    resetBootRecovery();
    const tasks = await listTasks();

    expect(tasks.map((t) => t.id)).toEqual(["t_keep_1"]);
    expect(await dirExists(taskDir("t_tomb_1"))).toBe(false);
    expect(await dirExists(before.dir)).toBe(true);
    expect(await dirExists(after.dir)).toBe(true);
  });

  it("恢复只跑一次且是完整的：第二次 listTasks 不重复恢复（promise 已缓存，坏目录名不再让它半途而废）", async () => {
    await writeMeta(baseMeta("t_zombie_2", { runStatus: "running" }));
    await seedBadDir("junk dir", baseMeta("t_zombie_2", { runStatus: "running" }));

    resetBootRecovery();
    await listTasks();
    expect(JSON.parse(await readMetaText("t_zombie_2")).runStatus).toBe("error");
    const cached = g[RECOVERY_FLAG];
    expect(cached).toBeDefined();
    await expect(cached).resolves.toBeUndefined();
  });
});

describe("listTasksWithCorrupt：处理某个目录出意外时不能让任务静默消失（R1-14）", () => {
  it("外层 catch：该任务进 corrupt（read_error，带 id / metaPath），其余任务照常；reason 不含异常消息 / 文件内容", async () => {
    await writeMeta(baseMeta("t_a_1"));
    await writeMeta(baseMeta("t_b_2"));
    const LEAK = "文件内容片段-MUST-NOT-LEAK";
    let hits = 0;
    setFailpoint("listTasks.afterReadMeta", () => {
      hits += 1;
      if (hits === 1) throw Object.assign(new Error(`EIO: ${LEAK}`), { code: "EIO" });
    });

    const { tasks, corrupt } = await listTasksWithCorrupt();
    expect(hits).toBe(2);
    expect(tasks).toHaveLength(1);
    // 谁先扫由 readdir 顺序决定：丢的那个必须出现在 corrupt，而不是凭空消失
    const lostId = ["t_a_1", "t_b_2"].find((id) => id !== tasks[0]!.id)!;
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]).toMatchObject({ id: lostId, kind: "read_error", backupValid: false });
    expect(corrupt[0]!.metaPath).toBe(path.join(taskDir(lostId), META_FILE));
    expect(corrupt[0]!.reason).toContain("EIO");
    expect(corrupt[0]!.reason).not.toContain(LEAK);
  });

  it("没有 errno 的意外（普通 Error）：reason 给出类别而不是异常消息", async () => {
    await writeMeta(baseMeta("t_c_1"));
    const LEAK = "secret-detail-from-message";
    setFailpoint("listTasks.afterReadMeta", () => {
      throw new TypeError(LEAK);
    });
    const { tasks, corrupt } = await listTasksWithCorrupt();
    expect(tasks).toEqual([]);
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]).toMatchObject({ id: "t_c_1", kind: "read_error" });
    expect(corrupt[0]!.reason).toContain("TypeError");
    expect(corrupt[0]!.reason).not.toContain(LEAK);
  });

  it("读 meta 的 I/O 失败（EACCES）：同样进 corrupt，而不是只 warn 后 continue", async () => {
    await writeMeta(baseMeta("t_ok_1"));
    await writeMeta(baseMeta("t_denied_1"));
    const target = path.join(taskDir("t_denied_1"), META_FILE);
    const realReadFile = fs.readFile.bind(fs) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, "readFile").mockImplementation(((p: unknown, ...rest: unknown[]) =>
      String(p) === target
        ? Promise.reject(
            Object.assign(new Error("EACCES: permission denied 机密文本-MUST-NOT-LEAK"), {
              code: "EACCES",
            }),
          )
        : realReadFile(p, ...rest)) as unknown as typeof fs.readFile);

    const { tasks, corrupt } = await listTasksWithCorrupt();
    expect(tasks.map((t) => t.id)).toEqual(["t_ok_1"]);
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]).toMatchObject({ id: "t_denied_1", kind: "read_error" });
    expect(corrupt[0]!.reason).toContain("EACCES");
    expect(corrupt[0]!.reason).not.toContain("机密文本");
  });

  it("基线：正常任务不产生 corrupt 条目", async () => {
    await writeMeta(baseMeta("t_fine_1"));
    const { tasks, corrupt } = await listTasksWithCorrupt();
    expect(tasks.map((t) => t.id)).toEqual(["t_fine_1"]);
    expect(corrupt).toEqual([]);
  });
});
