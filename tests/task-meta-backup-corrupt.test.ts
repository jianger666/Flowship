/**
 * meta.json 的写入加固 + 损坏任务不再静默消失（review #15）
 *
 * 之前的缺陷：
 *  - 写入只有 tmp + rename：没有 fsync（断电后 meta.json 可能是空文件）、没有备份；
 *  - 坏 JSON / 缺字段 / 未知枚举（新版写入新枚举后回滚旧版）的 meta.json 会让任务从侧栏静默消失，
 *    连 console.warn 都到不了（getTaskVisibility 先把它判 unavailable 跳过了）。
 *
 * 分四块：
 *   A. 写入：fsync 先于 rename；.bak 滚动；坏旧文件不顶掉好 .bak；被 finalGuard 拒写的事务不碰 .bak
 *   B. restoreMetaFromBackup：内容损坏 + .bak 有效 → 恢复；其余情形（有效 / 缺失 / I/O 错 / 无备份）一律不动
 *   C. 启动恢复接线：损坏 + .bak → listTasks 能看到任务（且仍按 boot recovery 把 running 标 error）
 *   D. listTasksWithCorrupt：损坏任务进独立的 corrupt 数组（带 id / 类别 / 原因 / 路径 / backupValid），
 *      不混进 tasks；已删除 / 无 meta 的目录不算损坏；reason 不回显文件内容
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 加载时冻结，必须先钉 FLOWSHIP_DATA_DIR 再动态 import（同 delete-task-tombstone）。
 */
import { mkdtempSync, promises as fs, readFileSync } from "node:fs";
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-meta-backup-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const {
  DATA_DIR,
  DELETED_TOMBSTONE_FILE,
  META_BACKUP_FILE,
  META_FILE,
  META_INVALID_FILE,
  inspectMetaCorruptionSync,
  prepareMetaWrite,
  restoreMetaFromBackup,
  taskDir,
  writeMeta,
} = await import("@/lib/server/task-fs-core");
const { listTasks, listTasksWithCorrupt } = await import("@/lib/server/task-fs");

if (!DATA_DIR.startsWith(TMP_ROOT)) {
  throw new Error(`task-meta-backup DATA_DIR 未隔离到 TMP：${DATA_DIR}`);
}

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const skipBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  g[RECOVERY_FLAG] = Promise.resolve();
};
const resetBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  delete g[RECOVERY_FLAG];
};

const baseMeta = (id: string, title: string, over: Partial<TaskMetaV06> = {}): TaskMetaV06 => ({
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
  ...over,
});

const metaPath = (id: string): string => path.join(taskDir(id), META_FILE);
const bakPath = (id: string): string => path.join(taskDir(id), META_BACKUP_FILE);
const invalidPath = (id: string): string => path.join(taskDir(id), META_INVALID_FILE);

const readTitle = (p: string): string => (JSON.parse(readFileSync(p, "utf-8")) as { title: string }).title;

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

/** 三类坏内容：空文件 / 截断的 JSON / 合法 JSON 但未知枚举（新版值、回滚旧版）/ 合法 JSON 但缺必填字段 */
const CORRUPTIONS = {
  empty: { text: "", kind: "empty" },
  invalid_json: { text: '{"id": "x", "title": ', kind: "invalid_json" },
  unknown_enum: {
    text: JSON.stringify({ ...baseMeta("t_x", "x"), runStatus: "future_state" }),
    kind: "schema_mismatch",
  },
  missing_field: {
    text: JSON.stringify({ ...baseMeta("t_x", "x"), title: undefined }),
    kind: "schema_mismatch",
  },
} as const;
type CorruptionName = keyof typeof CORRUPTIONS;
const CORRUPTION_NAMES = Object.keys(CORRUPTIONS) as CorruptionName[];

afterAll(async () => {
  resetBootRecovery();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  skipBootRecovery();
  // 静音预期内的 warn / error（损坏路径本来就会打日志），断言只看返回值
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A. 写入：fsync + .bak 滚动", () => {
  it("首次写：没有旧文件、不产生 .bak", async () => {
    await writeMeta(baseMeta("t_a1", "v1"));
    expect(readTitle(metaPath("t_a1"))).toBe("v1");
    expect(await fileExists(bakPath("t_a1"))).toBe(false);
  });

  it("每次覆盖写都把上一版滚成 .bak（.bak 永远是 meta.json 的上一版）", async () => {
    await writeMeta(baseMeta("t_a2", "v1"));
    await writeMeta(baseMeta("t_a2", "v2"));
    expect(readTitle(metaPath("t_a2"))).toBe("v2");
    expect(readTitle(bakPath("t_a2"))).toBe("v1");
    await writeMeta(baseMeta("t_a2", "v3"));
    expect(readTitle(metaPath("t_a2"))).toBe("v3");
    expect(readTitle(bakPath("t_a2"))).toBe("v2");
  });

  it("rename 之前对 tmp 做了 fsync（防断电后 meta.json 变空 / 半截）", async () => {
    const order: string[] = [];
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const fh = await realOpen(...args);
      const realSync = fh.sync.bind(fh);
      fh.sync = async () => {
        order.push(`sync:${path.basename(String(args[0]))}`);
        return realSync();
      };
      return fh;
    });
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      order.push(`rename:${path.basename(String(to))}`);
      return realRename(from, to);
    });

    await writeMeta(baseMeta("t_a3", "v1"));

    const iSync = order.findIndex((s) => s.startsWith("sync:meta.json.tmp."));
    const iRename = order.indexOf("rename:meta.json");
    expect(iSync).toBeGreaterThanOrEqual(0);
    expect(iRename).toBeGreaterThan(iSync);
  });

  it.each(CORRUPTION_NAMES)(
    "旧 meta.json 已坏（%s）：写入照常成功，但不拿坏文件覆盖好 .bak",
    async (name) => {
      const id = "t_a4";
      await writeMeta(baseMeta(id, "v1"));
      await writeMeta(baseMeta(id, "v2")); // .bak = v1
      await fs.writeFile(metaPath(id), CORRUPTIONS[name].text, "utf-8");

      await writeMeta(baseMeta(id, "v3"));

      expect(readTitle(metaPath(id))).toBe("v3");
      // .bak 仍是之前的好版本 v1，没被坏文件顶掉
      expect(readTitle(bakPath(id))).toBe("v1");
    },
  );

  it("事务被 finalGuard 拒写：meta.json 与 .bak 都不动", async () => {
    const id = "t_a5";
    await writeMeta(baseMeta(id, "v1"));
    await writeMeta(baseMeta(id, "v2")); // .bak = v1
    const prepared = await prepareMetaWrite(baseMeta(id, "rejected"));
    expect(await prepared.commit(() => false)).toBe(false);
    expect(readTitle(metaPath(id))).toBe("v2");
    expect(readTitle(bakPath(id))).toBe("v1");
  });
});

describe("B. restoreMetaFromBackup", () => {
  const seedWithBackup = async (id: string): Promise<void> => {
    await writeMeta(baseMeta(id, "good-old", { runStatus: "idle" }));
    await writeMeta(baseMeta(id, "good-new")); // .bak = good-old
  };

  it.each(CORRUPTION_NAMES)("主文件损坏（%s）+ .bak 有效 → 恢复主文件", async (name) => {
    const id = "t_b1";
    await seedWithBackup(id);
    const bad = CORRUPTIONS[name].text;
    await fs.writeFile(metaPath(id), bad, "utf-8");

    expect(await restoreMetaFromBackup(id)).toBe("restored");

    // 主文件回到 .bak 的内容、且现在合法（读侧不再判损坏）
    expect(readTitle(metaPath(id))).toBe("good-old");
    expect(inspectMetaCorruptionSync(id)).toBeNull();
    // .bak 保留
    expect(readTitle(bakPath(id))).toBe("good-old");
    // 非空的坏原件留成 .invalid（降级再升级时被判坏的是较新的数据，不能销毁）；空文件没有可留的
    if (bad.length > 0) {
      expect(readFileSync(invalidPath(id), "utf-8")).toBe(bad);
    } else {
      expect(await fileExists(invalidPath(id))).toBe(false);
    }
    // 不留 tmp 残渣
    const leftovers = (await fs.readdir(taskDir(id))).filter((n) => n.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });

  it("主文件有效 → not_needed、什么都不动", async () => {
    const id = "t_b2";
    await seedWithBackup(id);
    expect(await restoreMetaFromBackup(id)).toBe("not_needed");
    expect(readTitle(metaPath(id))).toBe("good-new");
    expect(readTitle(bakPath(id))).toBe("good-old");
  });

  it("主文件损坏但没有 .bak → no_backup、主文件原样", async () => {
    const id = "t_b3";
    await writeMeta(baseMeta(id, "only"));
    await fs.writeFile(metaPath(id), CORRUPTIONS.invalid_json.text, "utf-8");
    expect(await restoreMetaFromBackup(id)).toBe("no_backup");
    expect(readFileSync(metaPath(id), "utf-8")).toBe(CORRUPTIONS.invalid_json.text);
  });

  it(".bak 也坏 → no_backup、不拿坏备份顶替", async () => {
    const id = "t_b4";
    await seedWithBackup(id);
    await fs.writeFile(bakPath(id), CORRUPTIONS.unknown_enum.text, "utf-8");
    await fs.writeFile(metaPath(id), CORRUPTIONS.invalid_json.text, "utf-8");
    expect(await restoreMetaFromBackup(id)).toBe("no_backup");
    expect(readFileSync(metaPath(id), "utf-8")).toBe(CORRUPTIONS.invalid_json.text);
  });

  it("主文件不存在（deleteTask 降级卸掉了 meta）→ 绝不复活", async () => {
    const id = "t_b5";
    await seedWithBackup(id);
    await fs.unlink(metaPath(id));
    expect(await restoreMetaFromBackup(id)).toBe("not_needed");
    expect(await fileExists(metaPath(id))).toBe(false);
  });

  it("读主文件本身失败（EACCES，I/O 故障不是内容损坏）→ not_needed、不拿旧备份顶上去", async () => {
    const id = "t_b6";
    await seedWithBackup(id);
    const target = metaPath(id);
    const realRead = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      if (String(p) === target) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return (realRead as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as typeof fs.readFile);

    expect(await restoreMetaFromBackup(id)).toBe("not_needed");
    vi.restoreAllMocks();
    // 主文件没被 .bak 回退
    expect(readTitle(target)).toBe("good-new");
  });
});

describe("C. 启动恢复接线", () => {
  it("meta 损坏 + .bak 有效：重启后 listTasks 能看到任务（并仍按 boot recovery 把 running 标 error）", async () => {
    const id = "t_c1";
    await writeMeta(baseMeta(id, "崩溃前", { runStatus: "running", mode: "chat" }));
    await writeMeta(baseMeta(id, "崩溃时", { runStatus: "running", mode: "chat" })); // .bak = 崩溃前
    await fs.writeFile(metaPath(id), "", "utf-8"); // 断电后常见：空文件

    // 重启前：任务读不出来、但也不是静默消失——在 corrupt 里
    skipBootRecovery();
    const before = await listTasksWithCorrupt();
    expect(before.tasks.map((t) => t.id)).not.toContain(id);
    expect(before.corrupt.map((c) => c.id)).toEqual([id]);
    expect(before.corrupt[0].backupValid).toBe(true);

    // 重启 = 重跑 boot recovery
    resetBootRecovery();
    const after = await listTasksWithCorrupt();
    expect(after.corrupt).toEqual([]);
    const t = after.tasks.find((x) => x.id === id);
    expect(t).toBeDefined();
    expect(t?.title).toBe("崩溃前");
    // 恢复出来的 meta 是 running → 照常被 boot recovery 标 error
    expect(t?.runStatus).toBe("error");
  });

  it("meta 损坏且没有 .bak：重启后仍不可读、但保持在 corrupt 里（不会被误删 / 误恢复）", async () => {
    const id = "t_c2";
    await writeMeta(baseMeta(id, "无备份"));
    await fs.writeFile(metaPath(id), CORRUPTIONS.invalid_json.text, "utf-8");
    resetBootRecovery();
    const r = await listTasksWithCorrupt();
    expect(r.tasks.map((t) => t.id)).not.toContain(id);
    expect(r.corrupt.map((c) => c.id)).toEqual([id]);
    expect(r.corrupt[0].backupValid).toBe(false);
    // 目录与坏文件原样保留
    expect(readFileSync(metaPath(id), "utf-8")).toBe(CORRUPTIONS.invalid_json.text);
  });
});

describe("D. listTasksWithCorrupt：损坏任务单独暴露、不混进 tasks", () => {
  it.each(CORRUPTION_NAMES)("meta 损坏（%s）→ 进 corrupt（带类别 / 原因 / 路径），不进 tasks；健康任务不受影响", async (name) => {
    await writeMeta(baseMeta("t_d_ok", "健康"));
    await writeMeta(baseMeta("t_d_bad", "会坏"));
    await fs.writeFile(metaPath("t_d_bad"), CORRUPTIONS[name].text, "utf-8");

    const r = await listTasksWithCorrupt();

    expect(r.tasks.map((t) => t.id)).toEqual(["t_d_ok"]);
    expect(r.corrupt).toHaveLength(1);
    const c = r.corrupt[0];
    expect(c.id).toBe("t_d_bad");
    expect(c.kind).toBe(CORRUPTIONS[name].kind);
    expect(c.reason.length).toBeGreaterThan(0);
    expect(c.metaPath).toBe(metaPath("t_d_bad"));
    expect(c.backupValid).toBe(false);
  });

  it("listTasks 的返回与改前同形：只有真任务，没有任何假任务", async () => {
    await writeMeta(baseMeta("t_d2_ok", "健康"));
    await writeMeta(baseMeta("t_d2_bad", "会坏"));
    await fs.writeFile(metaPath("t_d2_bad"), CORRUPTIONS.unknown_enum.text, "utf-8");

    const tasks = await listTasks();
    expect(tasks.map((t) => t.id)).toEqual(["t_d2_ok"]);
  });

  it("backupValid：同目录 .bak 有效才为 true", async () => {
    await writeMeta(baseMeta("t_d3", "v1"));
    await writeMeta(baseMeta("t_d3", "v2")); // 有 .bak
    await fs.writeFile(metaPath("t_d3"), "", "utf-8");
    expect((await listTasksWithCorrupt()).corrupt[0].backupValid).toBe(true);

    await fs.writeFile(bakPath("t_d3"), CORRUPTIONS.invalid_json.text, "utf-8");
    expect((await listTasksWithCorrupt()).corrupt[0].backupValid).toBe(false);
  });

  it("读文件本身失败（meta.json 是个目录 → EISDIR）→ kind=read_error", async () => {
    const id = "t_d4";
    await fs.mkdir(metaPath(id), { recursive: true });
    const r = await listTasksWithCorrupt();
    expect(r.corrupt.map((c) => [c.id, c.kind])).toEqual([[id, "read_error"]]);
    expect(r.corrupt[0].backupValid).toBe(false);
  });

  it("不算损坏：没有 meta.json 的目录 / 已 tombstone 的目录（即便 meta 是坏的）", async () => {
    await fs.mkdir(taskDir("t_d5_nometa"), { recursive: true });
    await writeMeta(baseMeta("t_d5_tomb", "已删"));
    await fs.writeFile(metaPath("t_d5_tomb"), CORRUPTIONS.invalid_json.text, "utf-8");
    await fs.writeFile(
      path.join(taskDir("t_d5_tomb"), DELETED_TOMBSTONE_FILE),
      JSON.stringify({ deletedAt: Date.now() }),
      "utf-8",
    );

    const r = await listTasksWithCorrupt();
    expect(r.tasks).toEqual([]);
    expect(r.corrupt).toEqual([]);
  });

  it("reason 不回显文件内容（只有类别 / 位置 / 字段路径）", async () => {
    const SECRET = "SECRET-MARKER-9f3a";
    await writeMeta(baseMeta("t_d6_json", "x"));
    await fs.writeFile(metaPath("t_d6_json"), `{"title": "${SECRET}", `, "utf-8");
    await writeMeta(baseMeta("t_d6_schema", "x"));
    await fs.writeFile(
      metaPath("t_d6_schema"),
      JSON.stringify({ ...baseMeta("t_d6_schema", SECRET), runStatus: SECRET }),
      "utf-8",
    );

    const r = await listTasksWithCorrupt();
    expect(r.corrupt).toHaveLength(2);
    for (const c of r.corrupt) {
      expect(c.reason).not.toContain(SECRET);
      expect(JSON.stringify(c)).not.toContain(SECRET);
    }
  });

  it("GET /api/tasks 把 corrupt 作为独立字段透传（没有损坏时不带字段）", () => {
    const route = readFileSync(
      path.join(process.cwd(), "src/app/api/tasks/route.ts"),
      "utf-8",
    );
    expect(route).toContain("listTasksWithCorrupt");
    expect(route).toMatch(/listed\.corrupt\.length > 0 \? \{ corrupt: listed\.corrupt \} : \{\}/);
  });
});
