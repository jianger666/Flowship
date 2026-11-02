/**
 * 崩溃遗留 tmp 的启动期清扫 + meta.json.bak 的原子写。
 *
 * 旧行为：
 * - `meta.json.bak` 由 `fs.writeFile` 直接覆盖：写到一半崩溃 / 磁盘写满会把**上一份好备份**截成半截；
 * - 崩溃遗留的 `meta.json.tmp.*`（任务目录里）与含明文服务器 / PG / Redis 密码的 `company-env.json.tmp.*`（数据目录顶层）无人清理
 *   （config.json 家族的 tmp 早有清扫、company-env 明确是已知缺口）。
 * 现在：.bak 走 tmp + rename；meta tmp 在 boot recovery 里按任务目录清扫；company-env tmp 并进 cleanupStaleSettingsTmpFiles。
 * 清扫都是：数据 / 任务目录**顶层**、文件名**严格**匹配（`<目标>.tmp.<数字 pid>.<[a-z0-9]+>`）、lstat 是普通文件、mtime 超过 1 小时才删；
 * 正式文件、名字只差一点的、目录、软链、不够老的一概不碰。
 *
 * DATA_DIR 在 task-fs-core 模块加载时冻结：先钉 FLOWSHIP_DATA_DIR 再动态 import。全程只写临时目录，凭据全是假值。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

vi.mock("@/lib/server/sdk-store-gc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/sdk-store-gc")>()),
  maybeGcSdkStore: vi.fn(),
}));

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-stale-tmp-sweep-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const { DATA_DIR, META_FILE, sweepStaleMetaTmpFiles, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { listTasksWithCorrupt } = await import("@/lib/server/task-fs");
const { cleanupStaleSettingsTmpFiles } = await import("@/lib/server/settings-fs");

if (!DATA_DIR.startsWith(TMP_ROOT)) throw new Error(`stale-tmp DATA_DIR 未隔离到 TMP：${DATA_DIR}`);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const FAKE_SECRET = "FAKE-COMPANY-PASSWORD-SENTINEL-0001";
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const RETRY_STATE = "__flowshipBootRecoveryRetryV1__";
const g = globalThis as unknown as Record<string, unknown>;

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

const lexists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false);
const writeAged = async (p: string, ageMs: number, content = FAKE_SECRET): Promise<void> => {
  await fs.writeFile(p, content, "utf-8");
  const t = new Date(Date.now() - ageMs);
  await fs.utimes(p, t, t);
};

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  delete g[RECOVERY_FLAG];
  delete g[RETRY_STATE];
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  delete g[RECOVERY_FLAG];
  delete g[RETRY_STATE];
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("meta.json.bak：tmp + rename 原子写", () => {
  it("滚备份：第二次写之后 .bak 是上一版完整内容，且不留 .tmp 残留", async () => {
    const id = "t_bak_atomic_1";
    await writeMeta(baseMeta(id, { title: "v1" }));
    await writeMeta(baseMeta(id, { title: "v2" }));

    const bak = JSON.parse(await fs.readFile(path.join(taskDir(id), "meta.json.bak"), "utf-8")) as TaskMetaV06;
    expect(bak.title).toBe("v1");
    expect((await fs.readdir(taskDir(id))).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  it("写 .bak 中途失败（半截写入 + ENOSPC）：上一份好备份不被截断、不挡主写、不留 tmp", async () => {
    const id = "t_bak_atomic_2";
    await writeMeta(baseMeta(id, { title: "v1" }));
    await writeMeta(baseMeta(id, { title: "v2" })); // 此刻 .bak = v1
    const bakPath = path.join(taskDir(id), "meta.json.bak");
    const goodBak = await fs.readFile(bakPath, "utf-8");

    // 任何以 meta.json.bak 开头的文件（直写 .bak 或写它的 tmp）：只写进前 5 字节就报 ENOSPC。
    // .bak 的 tmp 走 writeFileFsynced（fs.open + fh.writeFile + fh.sync），所以在 open 这一层注入；
    // 同时拦 fs.writeFile（旧实现直接用它写 .bak），任何实现都逃不过
    const realWrite = fs.writeFile.bind(fs) as (...a: unknown[]) => Promise<void>;
    vi.spyOn(fs, "writeFile").mockImplementation((async (p: unknown, data: unknown, ...rest: unknown[]) => {
      if (path.basename(String(p)).startsWith("meta.json.bak")) {
        await realWrite(p, String(data).slice(0, 5), ...rest);
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return realWrite(p, data, ...rest);
    }) as unknown as typeof fs.writeFile);
    const realOpen = fs.open.bind(fs) as (...a: unknown[]) => Promise<import("node:fs/promises").FileHandle>;
    vi.spyOn(fs, "open").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      const fh = await realOpen(p, ...rest);
      if (!path.basename(String(p)).startsWith("meta.json.bak")) return fh;
      return {
        writeFile: async (data: unknown) => {
          await fh.writeFile(String(data).slice(0, 5), "utf-8");
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        },
        sync: () => fh.sync(),
        close: () => fh.close(),
      };
    }) as unknown as typeof fs.open);

    await writeMeta(baseMeta(id, { title: "v3" })); // 备份失败只 warn、主写照常成功

    vi.restoreAllMocks();
    expect(((JSON.parse(await fs.readFile(path.join(taskDir(id), META_FILE), "utf-8")) as TaskMetaV06)).title).toBe("v3");
    expect(await fs.readFile(bakPath, "utf-8")).toBe(goodBak); // 好备份原封不动（旧实现：被截成 5 字节）
    expect((await fs.readdir(taskDir(id))).filter((n) => n.includes(".tmp."))).toEqual([]);
  });
});

describe("meta.json.bak：tmp 先 fsync 再 rename（断电不留 0 字节 .bak）", () => {
  it(".bak 的 tmp 在 fsync 时内容已写完、而 .bak 本体还是上一版；之后才被替换；且不走 fs.promises.rename", async () => {
    const id = "t_bak_fsync_1";
    await writeMeta(baseMeta(id, { title: "v1" }));
    await writeMeta(baseMeta(id, { title: "v2" })); // .bak = v1
    const dir = taskDir(id);
    const bakPath = path.join(dir, "meta.json.bak");
    const v1 = await fs.readFile(bakPath, "utf-8");

    const syncs: Array<{ file: string; tmpText: string; bakText: string }> = [];
    const realOpen = fs.open.bind(fs) as (...a: unknown[]) => Promise<import("node:fs/promises").FileHandle>;
    vi.spyOn(fs, "open").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      const fh = await realOpen(p, ...rest);
      const file = String(p);
      const realSync = fh.sync.bind(fh);
      fh.sync = async () => {
        syncs.push({
          file: path.basename(file),
          tmpText: await fs.readFile(file, "utf-8"),
          bakText: await fs.readFile(bakPath, "utf-8").catch(() => ""),
        });
        return realSync();
      };
      return fh;
    }) as unknown as typeof fs.open);
    const renameDests: string[] = [];
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      renameDests.push(path.basename(String(to)));
      return realRename(from, to);
    });

    await writeMeta(baseMeta(id, { title: "v3" })); // 刷新 .bak：v2 → .bak
    vi.restoreAllMocks();

    const bakSync = syncs.find((x) => x.file.startsWith("meta.json.bak.tmp."));
    expect(bakSync, "meta.json.bak 的 tmp 必须 fsync").toBeDefined();
    expect((JSON.parse(bakSync!.tmpText) as TaskMetaV06).title).toBe("v2"); // fsync 时内容已经写完
    expect(bakSync!.bakText).toBe(v1); // 此刻 .bak 本体还是上一版：rename 在 fsync 之后
    expect(((JSON.parse(await fs.readFile(bakPath, "utf-8")) as TaskMetaV06)).title).toBe("v2");
    expect(renameDests).not.toContain("meta.json.bak"); // 约定：.bak 用同步 rename，不占 promises.rename 的调用序号
    expect((await fs.readdir(dir)).filter((n) => n.includes(".tmp."))).toEqual([]);
  });
});

describe("meta 遗留 tmp 清扫（sweepStaleMetaTmpFiles）", () => {
  const seedDir = async (id: string): Promise<string> => {
    await writeMeta(baseMeta(id));
    return taskDir(id);
  };

  it("超过 1 小时、严格匹配的 meta.json.tmp.* / meta.json.bak.tmp.* 被删，返回个数", async () => {
    const dir = await seedDir("t_sweep_1");
    await writeAged(path.join(dir, "meta.json.tmp.4242.k3j9x0"), 2 * HOUR);
    await writeAged(path.join(dir, "meta.json.bak.tmp.4242.zz81q0w9e8r"), 3 * HOUR);

    expect(await sweepStaleMetaTmpFiles("t_sweep_1")).toBe(2);

    expect(await lexists(path.join(dir, "meta.json.tmp.4242.k3j9x0"))).toBe(false);
    expect(await lexists(path.join(dir, "meta.json.bak.tmp.4242.zz81q0w9e8r"))).toBe(false);
  });

  it("不够老（< 1 小时）的 tmp 不动——可能是另一路正在进行的写", async () => {
    const dir = await seedDir("t_sweep_2");
    await writeAged(path.join(dir, "meta.json.tmp.4242.abc123"), 30 * MIN);
    expect(await sweepStaleMetaTmpFiles("t_sweep_2")).toBe(0);
    expect(await lexists(path.join(dir, "meta.json.tmp.4242.abc123"))).toBe(true);
  });

  it("正式文件与名字只差一点的一律不动（再老也不删）；目录 / 软链形态的同名也不碰", async () => {
    const dir = await seedDir("t_sweep_3");
    const keep = [
      "meta.json.bak", // 正式备份
      "meta.json.invalid",
      "meta.json.tmp", // 没有 `.tmp.` 后缀段
      "meta.json.tmp.my-copy", // 用户手工留的：pid 段不是数字
      "meta.json.tmp.4242", // 缺随机段
      "meta.json.tmp.4242.ABC", // 大写不是 Math.random().toString(36) 的形态
      "xmeta.json.tmp.4242.abc",
      "meta.json.bak.old.tmp.4242.abc",
      "events.jsonl.tmp.4242.abc",
      "config.json.tmp.4242.abc",
    ];
    for (const n of keep) await writeAged(path.join(dir, n), 48 * HOUR);
    await fs.mkdir(path.join(dir, "meta.json.tmp.4242.dirlike"));
    await fs.symlink(path.join(dir, "meta.json"), path.join(dir, "meta.json.tmp.4242.linklike"));
    const aged = new Date(Date.now() - 48 * HOUR);
    await fs.lutimes(path.join(dir, "meta.json.tmp.4242.linklike"), aged, aged);

    expect(await sweepStaleMetaTmpFiles("t_sweep_3")).toBe(0);

    for (const n of [...keep, "meta.json", "meta.json.tmp.4242.dirlike", "meta.json.tmp.4242.linklike"]) {
      expect(await lexists(path.join(dir, n)), n).toBe(true);
    }
  });

  it("只扫任务目录顶层：子目录里的同名文件不动；目录不存在 / 读不了不抛", async () => {
    const dir = await seedDir("t_sweep_4");
    await fs.mkdir(path.join(dir, "actions"), { recursive: true });
    await writeAged(path.join(dir, "actions", "meta.json.tmp.4242.abc"), 48 * HOUR);
    expect(await sweepStaleMetaTmpFiles("t_sweep_4")).toBe(0);
    expect(await lexists(path.join(dir, "actions", "meta.json.tmp.4242.abc"))).toBe(true);

    await expect(sweepStaleMetaTmpFiles("t_not_exist_dir")).resolves.toBe(0);
  });

  it("启动期入口：boot recovery 过任务目录时顺手清掉遗留 tmp（正式 meta 不受影响）", async () => {
    const dir = await seedDir("t_sweep_boot");
    const stale = path.join(dir, "meta.json.tmp.4242.crashed1");
    const fresh = path.join(dir, "meta.json.tmp.4242.inflight");
    await writeAged(stale, 5 * HOUR);
    await writeAged(fresh, 1 * MIN);

    const { tasks } = await listTasksWithCorrupt(); // 触发首轮 boot recovery

    expect(tasks.map((t) => t.id)).toContain("t_sweep_boot");
    expect(await lexists(stale)).toBe(false);
    expect(await lexists(fresh)).toBe(true);
    expect(await lexists(path.join(dir, META_FILE))).toBe(true);
  });
});

describe("company-env.json 遗留 tmp 清扫（并进 cleanupStaleSettingsTmpFiles）", () => {
  it("超过 1 小时、严格匹配的 company-env.json.tmp.<pid>.<rand> 被删（含明文密码，优先清）", async () => {
    const p = path.join(TMP_ROOT, "company-env.json.tmp.4242.k3j9x0a1b2c");
    await writeAged(p, 2 * HOUR);
    expect(await cleanupStaleSettingsTmpFiles()).toBe(1);
    expect(await lexists(p)).toBe(false);
  });

  it("不够 1 小时的不动（比 config.json 家族的 10 分钟更保守）；config.json 家族的 10 分钟口径不变", async () => {
    const company = path.join(TMP_ROOT, "company-env.json.tmp.4242.abc");
    const cfg = path.join(TMP_ROOT, "config.json.tmp.4242.abc");
    await writeAged(company, 30 * MIN);
    await writeAged(cfg, 30 * MIN);

    expect(await cleanupStaleSettingsTmpFiles()).toBe(1); // 只清 config 的（> 10 分钟）

    expect(await lexists(company)).toBe(true);
    expect(await lexists(cfg)).toBe(false);
  });

  it("正式 company-env.json 与名字只差一点的变体不动（再老也不删）", async () => {
    const keep = [
      "company-env.json", // 正式文件
      "company-env.json.bak",
      "company-env.json.tmp",
      "company-env.json.tmp.my-copy",
      "company-env.json.tmp.4242", // 缺随机段
      "company-env.json.bak.tmp.4242.abc",
      "xcompany-env.json.tmp.4242.abc",
      "company-env.json.tmp.4242.abc.old",
    ];
    for (const n of keep) await writeAged(path.join(TMP_ROOT, n), 48 * HOUR);
    await fs.mkdir(path.join(TMP_ROOT, "company-env.json.tmp.4242.dirlike"));
    const nested = path.join(TMP_ROOT, "sub");
    await fs.mkdir(nested);
    await writeAged(path.join(nested, "company-env.json.tmp.4242.abc"), 48 * HOUR);

    expect(await cleanupStaleSettingsTmpFiles()).toBe(0);

    for (const n of keep) expect(await lexists(path.join(TMP_ROOT, n)), n).toBe(true);
    expect(await lexists(path.join(TMP_ROOT, "company-env.json.tmp.4242.dirlike"))).toBe(true);
    expect(await lexists(path.join(nested, "company-env.json.tmp.4242.abc"))).toBe(true);
  });
});
