/**
 * 旧版明文 tool-outputs 的启动期一次性迁移（R1-5）。
 *
 * 背景：写盘前脱敏上线之前落盘的 `tool-outputs/<callId>.txt` 是命令原始输出（可能含凭据）。GET 接口读时会再脱敏，
 * 但盘上的明文仍在（诊断包 / 备份 / 别的进程都读得到）。`migrateLegacyToolOutputs` 在 boot recovery 末尾后台把它们就地脱敏：
 * 读 → 脱敏 → 有变化才原子写回（0600、保留 mtime）；目录扫完写 `.redacted-v1` 标记，之后启动跳过；有预算；失败吞掉。
 *
 * 全程假凭据 + 临时数据目录。DATA_DIR 须在动态 import 前钉死。
 */
import { mkdtempSync, promises as fs, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// boot recovery 末尾会 fire-and-forget 一轮 SDK store 瘦身，与 afterAll 的 rm 会交错：本文件测迁移，桩掉它
vi.mock("@/lib/server/sdk-store-gc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/sdk-store-gc")>()),
  maybeGcSdkStore: vi.fn(),
}));

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-tool-output-migrate-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const GIT_TOKEN = "glpat-FAKE0123456789abcdefXYZ";
const API_KEY = "fake-api-key-for-tool-output-0001";
const LATE_KEY = "fake-late-added-key-for-migrate-0009";
const GIT_PLACEHOLDER = "[REDACTED:gitToken]";
const API_PLACEHOLDER = "[REDACTED:apiKey]";
const CONFIG = path.join(TMP_ROOT, "config.json");
const isWin = process.platform === "win32";

const writeConfig = (cfg: Record<string, unknown> | null): void => {
  if (cfg === null) writeFileSync(CONFIG, "{}", "utf-8");
  else writeFileSync(CONFIG, JSON.stringify(cfg), "utf-8");
};
writeConfig({ gitToken: GIT_TOKEN, apiKey: API_KEY });

const {
  migrateLegacyToolOutputs,
  pruneToolOutputsDir,
  TOOL_OUTPUT_MIGRATE_MARKER,
  TOOL_OUTPUT_REDACT_MAX_CHARS,
  TOOL_OUTPUTS_MAX_FILES,
} = await import("../src/lib/server/tool-result-persist");
const { DATA_DIR, writeMeta } = await import("../src/lib/server/task-fs-core");
const { listTasks } = await import("../src/lib/server/task-fs");

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const g = globalThis as unknown as Record<string, unknown>;

const outDir = (taskId: string): string => path.join(DATA_DIR, taskId, "tool-outputs");
const outFile = (taskId: string, callId: string): string => path.join(outDir(taskId), `${callId}.txt`);
const markerPath = (taskId: string): string => path.join(outDir(taskId), TOOL_OUTPUT_MIGRATE_MARKER);

const seedTask = async (taskId: string): Promise<void> => {
  await fs.mkdir(outDir(taskId), { recursive: true });
};
const seedFile = async (taskId: string, callId: string, text: string, ageMs = 0): Promise<void> => {
  await seedTask(taskId);
  const file = outFile(taskId, callId);
  await fs.writeFile(file, text, "utf-8");
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    await fs.utimes(file, t, t);
  }
};
const read = (taskId: string, callId: string): Promise<string> => fs.readFile(outFile(taskId, callId), "utf-8");
const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

const leaky = (n: number): string =>
  `PATH=/usr/bin\nGITLAB_TOKEN=${GIT_TOKEN}\nOPENAI=${API_KEY}\n${"pad\n".repeat(n)}end\n`;
const redactedLeaky = (n: number): string =>
  `PATH=/usr/bin\nGITLAB_TOKEN=${GIT_PLACEHOLDER}\nOPENAI=${API_PLACEHOLDER}\n${"pad\n".repeat(n)}end\n`;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  g[RECOVERY_FLAG] = Promise.resolve(); // 默认不跑 boot recovery（专门的用例再放开）
  writeConfig({ gitToken: GIT_TOKEN, apiKey: API_KEY });
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  delete g[RECOVERY_FLAG];
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("migrateLegacyToolOutputs：就地脱敏旧明文", () => {
  it("含凭据的旧文件被改写成脱敏版（行数不变）；没凭据的文件不重写（inode / mtime 都不动）", async () => {
    await seedFile("t_a_1", "call_leaky", leaky(50), 3 * 24 * 3600 * 1000);
    await seedFile("t_a_1", "call_clean", "clean line 1\nclean line 2\n", 3 * 24 * 3600 * 1000);
    const cleanBefore = statSync(outFile("t_a_1", "call_clean"));

    const r = await migrateLegacyToolOutputs(["t_a_1"]);

    expect(r).toMatchObject({ filesChecked: 2, filesRewritten: 1, tasksDone: 1, budgetExhausted: false });
    expect(await read("t_a_1", "call_leaky")).toBe(redactedLeaky(50));
    const cleanAfter = statSync(outFile("t_a_1", "call_clean"));
    expect(cleanAfter.ino).toBe(cleanBefore.ino); // 没重写（原子写会换 inode）
    expect(cleanAfter.mtimeMs).toBe(cleanBefore.mtimeMs);
    expect(await read("t_a_1", "call_clean")).toBe("clean line 1\nclean line 2\n");
  });

  it("改写后保留原 mtime（否则 prune 按 mtime 淘汰「最老」时，迁移过的老文件会比新文件还新）", async () => {
    await seedFile("t_mtime_1", "call_old", leaky(5), 10 * 24 * 3600 * 1000);
    const before = statSync(outFile("t_mtime_1", "call_old")).mtimeMs;
    await migrateLegacyToolOutputs(["t_mtime_1"]);
    expect(await read("t_mtime_1", "call_old")).not.toContain(GIT_TOKEN);
    expect(Math.abs(statSync(outFile("t_mtime_1", "call_old")).mtimeMs - before)).toBeLessThan(1000);
  });

  it.skipIf(isWin)("改写出来的文件权限是 0600（原来是 0644 的明文文件）", async () => {
    await seedFile("t_perm_1", "call_p", leaky(3));
    await fs.chmod(outFile("t_perm_1", "call_p"), 0o644);
    await migrateLegacyToolOutputs(["t_perm_1"]);
    expect(statSync(outFile("t_perm_1", "call_p")).mode & 0o777).toBe(0o600);
  });

  it("幂等 + 一次性：扫完落 .redacted-v1 标记；再跑一次不读任何文件", async () => {
    await seedFile("t_once_1", "call_a", leaky(5));
    await seedFile("t_once_1", "call_b", "nothing here\n");
    const first = await migrateLegacyToolOutputs(["t_once_1"]);
    expect(first.tasksDone).toBe(1);
    expect(await exists(markerPath("t_once_1"))).toBe(true);
    const afterFirst = await read("t_once_1", "call_a");

    const second = await migrateLegacyToolOutputs(["t_once_1"]);
    expect(second).toMatchObject({ filesChecked: 0, filesRewritten: 0, bytesRead: 0, tasksDone: 0 });
    expect(await read("t_once_1", "call_a")).toBe(afterFirst);
  });

  it("没有 tool-outputs 目录的任务 / 非法 id / 带 tombstone 的目录：安静跳过，不抛、不建目录", async () => {
    await fs.mkdir(path.join(DATA_DIR, "t_nodir_1"), { recursive: true });
    await seedFile("t_tomb_1", "call_x", leaky(2));
    await fs.writeFile(path.join(DATA_DIR, "t_tomb_1", ".deleted-tombstone"), "{}", "utf-8");

    const r = await migrateLegacyToolOutputs(["t_nodir_1", "bad id with space", "../escape", "t_tomb_1"]);
    expect(r.filesChecked).toBe(0);
    expect(await exists(outDir("t_nodir_1"))).toBe(false);
    // tombstone 目录里的文件原样（正在被删的任务不碰）
    expect(await read("t_tomb_1", "call_x")).toContain(GIT_TOKEN);
  });

  it("只认 <callId>.txt：.tmp 残留 / 其它文件不碰", async () => {
    await seedFile("t_other_1", "call_a", leaky(2));
    await fs.writeFile(path.join(outDir("t_other_1"), "call_a.txt.tmp.123.abc"), leaky(2), "utf-8");
    await fs.writeFile(path.join(outDir("t_other_1"), "notes.md"), leaky(2), "utf-8");
    await migrateLegacyToolOutputs(["t_other_1"]);
    expect(await fs.readFile(path.join(outDir("t_other_1"), "call_a.txt.tmp.123.abc"), "utf-8")).toContain(GIT_TOKEN);
    expect(await fs.readFile(path.join(outDir("t_other_1"), "notes.md"), "utf-8")).toContain(GIT_TOKEN);
  });

  it("超过脱敏输入上限（16M 字符）的旧文件：干净的原样不动（不截断、不换 inode）；含凭据的只替换凭据、内容一字不丢（R1-5）", async () => {
    const big = TOOL_OUTPUT_REDACT_MAX_CHARS + 4096;
    const body = "x".repeat(big);
    await seedFile("t_big_1", "call_big_clean", body);
    await seedFile("t_big_1", "call_big_leaky", `${GIT_TOKEN}\n${body}\n${API_KEY}\n`);
    const cleanBefore = statSync(outFile("t_big_1", "call_big_clean"));

    const r = await migrateLegacyToolOutputs(["t_big_1"]);

    expect(r).toMatchObject({ filesChecked: 2, filesRewritten: 1, tasksDone: 1 });
    const cleanAfter = statSync(outFile("t_big_1", "call_big_clean"));
    expect(cleanAfter.ino).toBe(cleanBefore.ino);
    expect(cleanAfter.size).toBe(big);
    const leaked = await read("t_big_1", "call_big_leaky");
    expect(leaked).toBe(`${GIT_PLACEHOLDER}\n${body}\n${API_PLACEHOLDER}\n`);
    expect(leaked).not.toContain("输出过大");
  });
});

describe("预算：目录之间检查，扫不完的下次启动继续（不饥饿）", () => {
  it("maxFiles=3、每个任务 3 个文件：一次只处理一个任务；连跑 3 次全部迁完", async () => {
    for (const t of ["t_b_1", "t_b_2", "t_b_3"]) {
      for (const c of ["c1", "c2", "c3"]) await seedFile(t, c, leaky(2));
    }
    const ids = ["t_b_1", "t_b_2", "t_b_3"];

    const r1 = await migrateLegacyToolOutputs(ids, { maxFiles: 3 });
    expect(r1).toMatchObject({ filesChecked: 3, filesRewritten: 3, tasksDone: 1, budgetExhausted: true });
    expect(await read("t_b_1", "c1")).not.toContain(GIT_TOKEN);
    expect(await read("t_b_2", "c1")).toContain(GIT_TOKEN); // 还没轮到

    const r2 = await migrateLegacyToolOutputs(ids, { maxFiles: 3 });
    expect(r2).toMatchObject({ filesChecked: 3, tasksDone: 1, budgetExhausted: true }); // t_b_1 已有标记、不占预算
    expect(await read("t_b_2", "c3")).not.toContain(GIT_TOKEN);
    expect(await read("t_b_3", "c1")).toContain(GIT_TOKEN);

    const r3 = await migrateLegacyToolOutputs(ids, { maxFiles: 3 });
    expect(r3).toMatchObject({ filesChecked: 3, tasksDone: 1 });
    for (const t of ids) for (const c of ["c1", "c2", "c3"]) expect(await read(t, c)).not.toContain(GIT_TOKEN);
  });

  it("maxBytes 同样按目录之间检查", async () => {
    await seedFile("t_bytes_1", "c1", leaky(2000)); // ~8KB
    await seedFile("t_bytes_2", "c1", leaky(2000));
    const r = await migrateLegacyToolOutputs(["t_bytes_1", "t_bytes_2"], { maxBytes: 1024 });
    expect(r.tasksDone).toBe(1);
    expect(r.budgetExhausted).toBe(true);
    expect(await read("t_bytes_2", "c1")).toContain(GIT_TOKEN);
  });
});

describe("失败只记日志、不抛；该目录不落标记、下次再试", () => {
  it("某个文件写盘失败：其余文件照常迁移，不落标记，整体不抛；下次（故障消失）补完并落标记", async () => {
    await seedFile("t_fail_1", "call_bad", leaky(2));
    await seedFile("t_fail_1", "call_good", leaky(3));
    const realWrite = fs.writeFile.bind(fs) as (...a: unknown[]) => Promise<unknown>;
    let failing = true;
    vi.spyOn(fs, "writeFile").mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (failing && String(p).includes("call_bad.txt.tmp.")) {
        return Promise.reject(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
      }
      return realWrite(p, ...rest);
    }) as unknown as typeof fs.writeFile);

    const r = await migrateLegacyToolOutputs(["t_fail_1"]);
    expect(r.filesRewritten).toBe(1);
    expect(r.tasksDone).toBe(0);
    expect(await exists(markerPath("t_fail_1"))).toBe(false);
    expect(await read("t_fail_1", "call_good")).not.toContain(GIT_TOKEN);
    expect(await read("t_fail_1", "call_bad")).toContain(GIT_TOKEN); // 失败的原样（没被写坏）
    // 失败日志不含文件内容
    const logged = vi.mocked(console.warn).mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("t_fail_1");
    expect(logged).not.toContain(GIT_TOKEN);
    // tmp 残留已清
    expect((await fs.readdir(outDir("t_fail_1"))).filter((n) => n.includes(".tmp."))).toEqual([]);

    failing = false;
    const r2 = await migrateLegacyToolOutputs(["t_fail_1"]);
    expect(r2.tasksDone).toBe(1);
    expect(await read("t_fail_1", "call_bad")).not.toContain(GIT_TOKEN);
  });

  it("读到写回之间文件被别人改写（同 callId 重写）：放弃这个文件、不拿旧内容覆盖新内容，也不落标记", async () => {
    await seedFile("t_race_1", "call_r", leaky(2));
    const file = outFile("t_race_1", "call_r");
    const realWrite = fs.writeFile.bind(fs) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, "writeFile").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      const out = await realWrite(p, ...rest);
      if (String(p).includes("call_r.txt.tmp.")) {
        // 迁移的 tmp 写完后、换回之前：别的写者把原文件改成了新内容
        await realWrite(file, "BRAND NEW OUTPUT\n", "utf-8");
        const future = new Date(Date.now() + 60_000);
        await fs.utimes(file, future, future);
      }
      return out;
    }) as unknown as typeof fs.writeFile);

    const r = await migrateLegacyToolOutputs(["t_race_1"]);
    expect(r.filesRewritten).toBe(0);
    expect(r.tasksDone).toBe(0);
    expect(await fs.readFile(file, "utf-8")).toBe("BRAND NEW OUTPUT\n");
    expect(await exists(markerPath("t_race_1"))).toBe(false);
    expect((await fs.readdir(outDir("t_race_1"))).filter((n) => n.includes(".tmp."))).toEqual([]);
  });
});

describe("凭据集合与标记", () => {
  it("没有任何已知凭据：什么都不做、不落标记（没东西可脱敏；凭据出现后下次再迁）", async () => {
    writeConfig(null); // 空配置
    await seedFile("t_nosecret_1", "call_a", `k=${GIT_TOKEN}\n`);
    const r = await migrateLegacyToolOutputs(["t_nosecret_1"]);
    expect(r).toMatchObject({ filesChecked: 0, tasksDone: 0 });
    expect(await exists(markerPath("t_nosecret_1"))).toBe(false);
    expect(await read("t_nosecret_1", "call_a")).toContain(GIT_TOKEN);
  });

  it("标记记录当时的凭据条数：之后凭据变多（配置补全 / 新增 key）会重扫一次", async () => {
    await seedFile("t_grow_1", "call_a", leaky(2));
    await migrateLegacyToolOutputs(["t_grow_1"]);
    expect(await exists(markerPath("t_grow_1"))).toBe(true);

    // 标记之后：又落了一个旧文件（模拟「首轮时某个凭据来源暂时读不出来、漏脱了」），同时配置里出现了更多凭据
    await seedFile("t_grow_1", "call_late", `k=${LATE_KEY}\n`);
    writeConfig({ gitToken: GIT_TOKEN, apiKey: API_KEY, customProviders: [{ apiKey: LATE_KEY }] });
    const r = await migrateLegacyToolOutputs(["t_grow_1"]);
    expect(r.filesChecked).toBeGreaterThan(0);
    expect(await read("t_grow_1", "call_late")).not.toContain(LATE_KEY);
  });
});

describe("pruneToolOutputsDir 不把迁移标记当 tool-output", () => {
  it("目录里有标记时：它不计入 200 文件上限、也不会被当成「最老文件」删掉", async () => {
    await seedTask("t_prune_1");
    await fs.writeFile(markerPath("t_prune_1"), '{"v":1,"n":2}', "utf-8");
    const old = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    await fs.utimes(markerPath("t_prune_1"), old, old); // 标记是目录里最老的
    for (let i = 0; i < TOOL_OUTPUTS_MAX_FILES; i++) {
      await fs.writeFile(outFile("t_prune_1", `c${String(i).padStart(3, "0")}`), "x", "utf-8");
    }
    await pruneToolOutputsDir("t_prune_1");
    expect(await exists(markerPath("t_prune_1"))).toBe(true);
    expect((await fs.readdir(outDir("t_prune_1"))).filter((n) => n.endsWith(".txt"))).toHaveLength(TOOL_OUTPUTS_MAX_FILES);
  });
});

describe("接线：boot recovery 末尾在后台触发迁移", () => {
  it("真实 listTasks → ensureBootRecovery 之后，旧明文文件被脱敏（不挡 listTasks 返回）", async () => {
    await writeMeta({
      id: "t_boot_1",
      title: "t",
      mode: "chat",
      repoStatus: "developing",
      runStatus: "idle",
      currentActionId: null,
      actions: [],
      mrs: [],
      repoPaths: [],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await seedFile("t_boot_1", "call_legacy", leaky(10));

    delete g[RECOVERY_FLAG]; // 放开：让这次 listTasks 真跑 boot recovery
    const tasks = await listTasks();
    expect(tasks.map((t) => t.id)).toContain("t_boot_1");

    await vi.waitFor(async () => {
      expect(await read("t_boot_1", "call_legacy")).toBe(redactedLeaky(10));
      expect(await exists(markerPath("t_boot_1"))).toBe(true);
    }, { timeout: 15_000, interval: 50 }); // 后台迁移要动态 import tool-result-persist（冷加载 task-stream 等，慢机器上要 1~2s）
  });

  it("没有已知凭据时：boot recovery 不触发迁移（零开销）", async () => {
    writeConfig(null);
    await writeMeta({
      id: "t_boot_2",
      title: "t",
      mode: "chat",
      repoStatus: "developing",
      runStatus: "idle",
      currentActionId: null,
      actions: [],
      mrs: [],
      repoPaths: [],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await seedFile("t_boot_2", "call_legacy", `k=${GIT_TOKEN}\n`);
    delete g[RECOVERY_FLAG];
    await listTasks();
    await new Promise((r) => setTimeout(r, 80));
    expect(await read("t_boot_2", "call_legacy")).toContain(GIT_TOKEN);
    expect(await exists(markerPath("t_boot_2"))).toBe(false);
  });
});
