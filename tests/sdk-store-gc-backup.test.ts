/**
 * SDK store GC 的备份必须可靠：备份没做成 → 整轮 GC 中止（不重写 store）、不删旧备份。
 *
 * 旧行为：`backupStoreFiles` 里 `copyFile` 的错误整个被吞——磁盘写满只拷了一半时仍返回成功，
 * 随后 `pruneBackups`（KEEP_BACKUPS=1）把上一份完整备份删了，GC 接着重写 store，手里只剩一份残缺备份。
 * 现在：新备份逐文件校验大小、写完成标记；标记落地后才淘汰旧备份；任何一步失败 → 清掉半截备份、返回 backup-failed。
 *
 * 只写 mkdtemp 出来的临时目录（`dir` 覆盖 → 走文件路径，不碰真实 SDK store）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { gcSdkStoreOnce } from "@/lib/server/sdk-store-gc";

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const NAMES = ["checkpoints.ndjson", "runs.ndjson", "agents.ndjson", "run_events.ndjson"] as const;
const MARK = ".complete";

const roots: string[] = [];
const mkTmpStore = async (): Promise<{ root: string; store: string }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-gc-backup-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "tasks", "t1"), { recursive: true });
  await fs.writeFile(
    path.join(root, "tasks", "t1", "meta.json"),
    JSON.stringify({ sessionAgentId: "agent-live-1" }),
  );
  const store = path.join(root, "sdk-agent-store");
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(
    path.join(store, "checkpoints.ndjson"),
    line({ agentId: "agent-live-1", blobId: "keep-1" }) + line({ agentId: "agent-dead-9", blobId: "drop-1" }),
  );
  await fs.writeFile(
    path.join(store, "runs.ndjson"),
    line({ agentId: "agent-live-1", runId: "run-1" }) + line({ agentId: "agent-dead-9", runId: "run-9" }),
  );
  await fs.writeFile(
    path.join(store, "agents.ndjson"),
    line({ agentId: "agent-live-1" }) + line({ agentId: "agent-dead-9" }),
  );
  await fs.writeFile(
    path.join(store, "run_events.ndjson"),
    line({ runId: "run-1", seq: 1, payload: { agentId: "agent-live-1" } }) +
      line({ runId: "run-9", seq: 1, payload: { agentId: "agent-dead-9" } }),
  );
  return { root, store };
};

/** 造一份「上一轮留下的完整备份」：四份文件 + 完成标记 */
const seedOldBackup = async (store: string, name = ".gc-backup-1000"): Promise<string> => {
  const dir = path.join(store, name);
  await fs.mkdir(dir, { recursive: true });
  for (const n of NAMES) await fs.writeFile(path.join(dir, n), `old-good-${n}\n`);
  await fs.writeFile(path.join(dir, MARK), "{}");
  return dir;
};

const readAll = (store: string): Promise<Buffer[]> => Promise.all(NAMES.map((n) => fs.readFile(path.join(store, n))));
const backupDirs = async (store: string): Promise<string[]> =>
  (await fs.readdir(store)).filter((n) => n.startsWith(".gc-backup-")).sort();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

describe("备份失败 → 整轮 GC 中止，旧备份不删，store 不重写", () => {
  it("copyFile 抛 ENOSPC（磁盘写满）：backup-failed、四份 ndjson 字节不动、旧完整备份原样保留、没留半截备份", async () => {
    const { store } = await mkTmpStore();
    const old = await seedOldBackup(store);
    const before = await readAll(store);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const realCopy = fs.copyFile.bind(fs) as (...a: unknown[]) => Promise<void>;
    vi.spyOn(fs, "copyFile").mockImplementation(((src: unknown, dst: unknown, ...rest: unknown[]) => {
      if (String(src).endsWith("runs.ndjson")) {
        return Promise.reject(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
      }
      return realCopy(src, dst, ...rest);
    }) as unknown as typeof fs.copyFile);

    const stats = await gcSdkStoreOnce({ dir: store, minBytes: 1 });

    expect(stats.skipped).toBe("backup-failed");
    const after = await readAll(store);
    for (const [i] of NAMES.entries()) expect(Buffer.compare(after[i], before[i])).toBe(0);
    // 旧备份完整保留，且是唯一的备份目录（半截的新备份已清掉）
    expect(await backupDirs(store)).toEqual([path.basename(old)]);
    expect(await fs.readFile(path.join(old, "checkpoints.ndjson"), "utf8")).toBe("old-good-checkpoints.ndjson\n");
    expect(await fs.access(path.join(old, MARK)).then(() => true, () => false)).toBe(true);
  });

  it("copyFile 「成功」但只写了一半（静默截断）：大小校验不过 → backup-failed，旧备份与 store 都不动", async () => {
    const { store } = await mkTmpStore();
    const old = await seedOldBackup(store);
    const before = await readAll(store);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const realCopy = fs.copyFile.bind(fs) as (...a: unknown[]) => Promise<void>;
    vi.spyOn(fs, "copyFile").mockImplementation((async (src: unknown, dst: unknown, ...rest: unknown[]) => {
      await realCopy(src, dst, ...rest);
      if (String(src).endsWith("checkpoints.ndjson")) await fs.truncate(String(dst), 5); // 只剩前 5 字节
    }) as unknown as typeof fs.copyFile);

    const stats = await gcSdkStoreOnce({ dir: store, minBytes: 1 });

    expect(stats.skipped).toBe("backup-failed");
    const after = await readAll(store);
    for (const [i] of NAMES.entries()) expect(Buffer.compare(after[i], before[i])).toBe(0);
    expect(await backupDirs(store)).toEqual([path.basename(old)]);
    expect(await fs.readFile(path.join(old, "agents.ndjson"), "utf8")).toBe("old-good-agents.ndjson\n");
  });

  it("完成标记写不进去（磁盘满）同样算备份失败：旧备份保留、store 不动", async () => {
    const { store } = await mkTmpStore();
    const old = await seedOldBackup(store);
    const before = await readAll(store);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const realWrite = fs.writeFile.bind(fs) as (...a: unknown[]) => Promise<void>;
    vi.spyOn(fs, "writeFile").mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (String(p).endsWith(MARK) && !String(p).includes("gc-backup-1000")) {
        return Promise.reject(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));
      }
      return realWrite(p, ...rest);
    }) as unknown as typeof fs.writeFile);

    const stats = await gcSdkStoreOnce({ dir: store, minBytes: 1 });

    expect(stats.skipped).toBe("backup-failed");
    const after = await readAll(store);
    for (const [i] of NAMES.entries()) expect(Buffer.compare(after[i], before[i])).toBe(0);
    expect(await backupDirs(store)).toEqual([path.basename(old)]);
  });
});

describe("备份成功 → 新备份完整后才淘汰旧的", () => {
  it("成功路径：新备份四份文件大小与 GC 前一致且带完成标记；旧完整备份与无标记的半截备份被清掉", async () => {
    const { store } = await mkTmpStore();
    await seedOldBackup(store, ".gc-backup-1000");
    // 旧版本 / 崩溃遗留的无标记目录：不算完整备份，成功后一并清掉
    await fs.mkdir(path.join(store, ".gc-backup-2000"), { recursive: true });
    await fs.writeFile(path.join(store, ".gc-backup-2000", "checkpoints.ndjson"), "half");
    const sizesBefore = await Promise.all(NAMES.map(async (n) => (await fs.stat(path.join(store, n))).size));

    const stats = await gcSdkStoreOnce({ dir: store, minBytes: 1 });

    expect(stats.skipped).toBeUndefined();
    const dirs = await backupDirs(store);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).not.toBe(".gc-backup-1000");
    const bak = path.join(store, dirs[0]);
    expect(await fs.access(path.join(bak, MARK)).then(() => true, () => false)).toBe(true);
    for (const [i, n] of NAMES.entries()) {
      expect((await fs.stat(path.join(bak, n))).size, n).toBe(sizesBefore[i]);
    }
    // 备份里是 GC 前的完整内容（含孤儿行）、live store 里已瘦身
    expect(await fs.readFile(path.join(bak, "checkpoints.ndjson"), "utf8")).toContain("drop-1");
    expect(await fs.readFile(path.join(store, "checkpoints.ndjson"), "utf8")).not.toContain("drop-1");
  });

  it("源文件缺失（ENOENT）照旧只跳过那一份，不算备份失败", async () => {
    const { store } = await mkTmpStore();
    await fs.rm(path.join(store, "run_events.ndjson"));

    const stats = await gcSdkStoreOnce({ dir: store, minBytes: 1 });

    expect(stats.skipped).toBeUndefined();
    const dirs = await backupDirs(store);
    expect(dirs).toHaveLength(1);
    expect(await fs.readdir(path.join(store, dirs[0]))).not.toContain("run_events.ndjson");
  });
});
