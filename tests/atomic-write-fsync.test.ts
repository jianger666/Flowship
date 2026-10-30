/**
 * 原子写的 fsync（Q9-04）：tmp 写完 → fsync(tmp) → 才 rename
 *
 * 之前的缺陷：只有 meta.json 的原子写有 fsync（S3-01）。
 * `writePrivateFileAtomic`（22 处调用：设置 / 自定义 action / 飞书桥状态 / mcp-oauth / schedule ……）、
 * chat-checkpoint 的 `atomicWriteTextFile`（回退整份重写 events.jsonl）与 `writeRewindPoints`、
 * `writeWkConfig`（~/.wk/config.yaml）都只有 tmp + rename——断电 / 内核崩溃后可能得到 0 字节文件
 * （设置里的 apiKey 没了；回退之后整段对话变空）。
 *
 * 断电本身在单测里造不出来，这里钉的是机制：
 *   A. writeFileFsynced：字符串 / 字节原样写入、新建文件的权限位、fsync 失败只 warn 不挡写（且 warn 不带内容）、
 *      写失败原样抛并关掉句柄
 *   B. writePrivateFileAtomic：fsync(tmp) 先于 rename(final)；0600；覆盖已有 0644 文件后收紧到 0600；
 *      失败时清 tmp、旧文件不动；并发写不残留 tmp
 *   C. chat-checkpoint 的三条原子写（截断 events / 恢复 events 原文 / 写 rewind_points）同样 fsync 先于 rename
 *   D. writeWkConfig 同
 *   E. 源码契约：这些原子写点不得退回 fs.writeFile(tmp…)；task-fs-core 不再自己定义一份 writeFileFsynced
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 加载时冻结，必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskEvent } from "@/lib/types";

// wk-config 的落盘要把 home 指到临时目录——绝不能碰用户真实的 ~/.wk/config.yaml
const hoisted = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => hoisted.home };
});

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-atomic-fsync-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { writeFileFsynced, writePrivateFileAtomic } = await import(
  "@/lib/server/data-root"
);
const { restoreEventsRawText, truncateEventsBeforeEventId, writeRewindPoints } =
  await import("@/lib/server/chat-checkpoint");
const { EVENTS_FILE, appendEventLine, newEventId, readEvents, taskDir } =
  await import("@/lib/server/task-fs-core");
const { writeWkConfig } = await import("@/lib/server/wk-config");
const { writeAppSkill } = await import("@/lib/server/app-skills");
const { getAppSkillsDir } = await import("@/lib/server/skills-loader");
const {
  commitDeletionJournal,
  getDeletionJournalPath,
  readDeletionJournal,
  removeDeletionJournal,
  writeDeletionJournal,
} = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`atomic-write-fsync DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const ids: string[] = [];
beforeEach(async () => {
  hoisted.home = await fs.mkdtemp(path.join(TMP_ROOT, "home-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of ids.splice(0)) {
    await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  }
});

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`mock ${code}`), { code });

const newDir = (): Promise<string> => fs.mkdtemp(path.join(TMP_ROOT, "w-"));

interface TraceOpts {
  /** fsync 抛这个错（模拟个别文件系统 / 网络盘不支持 fsync） */
  syncThrows?: NodeJS.ErrnoException;
  /** 写入内容时抛这个错（模拟磁盘满） */
  writeThrows?: NodeJS.ErrnoException;
}

/**
 * 记录 `fs.open` 出来的句柄上的 write / sync / close，以及 `fs.rename`——按发生顺序返回。
 * 条目形如 `sync:<文件名>` / `rename:<目标文件名>`（只有文件名，没有目录）。
 * 沿用 task-meta-backup-corrupt 里 meta 路径 fsync 测试的观测方式（同一个 `fs.promises` 对象）。
 */
const trace = (opts: TraceOpts = {}): string[] => {
  const order: string[] = [];
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const fh = await realOpen(...args);
    const name = path.basename(String(args[0]));
    const realSync = fh.sync.bind(fh);
    fh.sync = async () => {
      order.push(`sync:${name}`);
      if (opts.syncThrows) throw opts.syncThrows;
      return realSync();
    };
    const realClose = fh.close.bind(fh);
    fh.close = async () => {
      order.push(`close:${name}`);
      return realClose();
    };
    // 无论成败都记一条 `write:<名>`（成功路径也要能断言「写在 fsync 之前」）：
    // 先 fsync 空文件、再写内容的话，rename 之后数据照样可能丢——Q9-04 的核心机制就失效了。
    const realWriteFile = fh.writeFile.bind(fh) as unknown as (
      data: unknown,
      options?: unknown,
    ) => Promise<void>;
    fh.writeFile = (async (data: unknown, options?: unknown) => {
      order.push(`write:${name}`);
      if (opts.writeThrows) throw opts.writeThrows;
      return realWriteFile(data, options);
    }) as unknown as typeof fh.writeFile;
    return fh;
  });
  const realRename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    order.push(`rename:${path.basename(String(to))}`);
    return realRename(from, to);
  });
  return order;
};

/** 第一个满足条件的条目下标（找不到 = -1） */
const idx = (order: string[], pred: (s: string) => boolean): number =>
  order.findIndex(pred);

/**
 * 断言顺序：先写「<final>.tmp…」→ 再对它 fsync → 最后才 rename 到 <final>。
 * 「写在 fsync 之前」也要钉：先 fsync 空文件、再写内容，rename 之后数据照样可能丢（审查 AI P2）。
 */
const expectSyncBeforeRename = (order: string[], finalName: string): void => {
  const iWrite = idx(order, (s) => s.startsWith(`write:${finalName}.tmp`));
  const iSync = idx(order, (s) => s.startsWith(`sync:${finalName}.tmp`));
  const iRename = idx(order, (s) => s === `rename:${finalName}`);
  expect(iWrite, `没有对 ${finalName}.tmp 的写入记录：${order.join(" → ")}`).toBeGreaterThanOrEqual(0);
  expect(iSync, `没有对 ${finalName}.tmp 做 fsync：${order.join(" → ")}`).toBeGreaterThanOrEqual(0);
  expect(iRename, `没有 rename 到 ${finalName}：${order.join(" → ")}`).toBeGreaterThanOrEqual(0);
  expect(iSync, `fsync 先于写入（刷的是空文件）：${order.join(" → ")}`).toBeGreaterThan(iWrite);
  expect(iRename).toBeGreaterThan(iSync);
};

describe("A. writeFileFsynced", () => {
  it("字符串按 UTF-8 写入", async () => {
    const dir = await newDir();
    const p = path.join(dir, "a.txt");
    await writeFileFsynced(p, "你好 hello\n");
    expect(readFileSync(p, "utf-8")).toBe("你好 hello\n");
  });

  it("Uint8Array 按字节原样写入（含 NUL / 非法 UTF-8 序列，不经 string 往返）", async () => {
    const dir = await newDir();
    const p = path.join(dir, "raw.bin");
    const bytes = Buffer.from([0x7b, 0x00, 0x00, 0xff, 0xfe, 0xc3, 0x28, 0x0a, 0x80]);
    await writeFileFsynced(p, bytes);
    expect(readFileSync(p).equals(bytes)).toBe(true);
  });

  it("空内容：产生 0 字节文件（不是报错）", async () => {
    const dir = await newDir();
    const p = path.join(dir, "empty.txt");
    await writeFileFsynced(p, "");
    expect(readFileSync(p, "utf-8")).toBe("");
  });

  it.skipIf(process.platform === "win32")("opts.mode 对新建文件生效", async () => {
    const dir = await newDir();
    const p = path.join(dir, "private.txt");
    await writeFileFsynced(p, "x", { mode: 0o600 });
    expect((await fs.stat(p)).mode & 0o777).toBe(0o600);
  });

  it("成功路径：写 → fsync → 关句柄（句柄不泄漏）", async () => {
    const dir = await newDir();
    const order = trace();
    await writeFileFsynced(path.join(dir, "o.txt"), "x");
    // 写必须在 fsync 之前（fsync 刷的才是写进去的内容，不是空文件）；句柄最后关
    expect(order).toEqual(["write:o.txt", "sync:o.txt", "close:o.txt"]);
  });

  it("fsync 失败：不抛、内容完整、只 warn 一条（带文件名与错误码、不带内容）", async () => {
    const SECRET = "sk-should-never-be-logged-123456";
    const dir = await newDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const order = trace({ syncThrows: errno("ENOTSUP") });
    const p = path.join(dir, "x.txt.tmp");
    await writeFileFsynced(p, SECRET);

    expect(readFileSync(p, "utf-8")).toBe(SECRET);
    expect(order).toContain("close:x.txt.tmp"); // 失败后句柄照样关
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain("fsync 失败");
    expect(msg).toContain("x.txt.tmp");
    expect(msg).toContain("ENOTSUP");
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain(dir); // 只带文件名、不带目录
  });

  it("写入失败（ENOSPC）：原样抛、不 fsync、句柄仍然关掉", async () => {
    const dir = await newDir();
    const order = trace({ writeThrows: errno("ENOSPC") });
    await expect(writeFileFsynced(path.join(dir, "f.txt"), "x")).rejects.toMatchObject({
      code: "ENOSPC",
    });
    expect(order).toEqual(["write:f.txt", "close:f.txt"]);
  });
});

describe("B. writePrivateFileAtomic", () => {
  it("fsync(tmp) 先于 rename(final)，且 fsync 的是 tmp 而不是目标", async () => {
    const dir = await newDir();
    const order = trace();
    await writePrivateFileAtomic(path.join(dir, "settings.json"), '{"a":1}');
    expectSyncBeforeRename(order, "settings.json");
    // 没有任何一次是直接对最终文件名 fsync
    expect(order).not.toContain("sync:settings.json");
  });

  it("内容写对；目标目录不存在时自动建", async () => {
    const dir = await newDir();
    const p = path.join(dir, "deep", "er", "c.json");
    await writePrivateFileAtomic(p, '{"ok":true}');
    expect(readFileSync(p, "utf-8")).toBe('{"ok":true}');
  });

  it.skipIf(process.platform === "win32")(
    "新建 0600；覆盖已有 0644 文件后收紧到 0600",
    async () => {
      const dir = await newDir();
      const fresh = path.join(dir, "fresh.json");
      await writePrivateFileAtomic(fresh, "1");
      expect((await fs.stat(fresh)).mode & 0o777).toBe(0o600);

      const old = path.join(dir, "old.json");
      await fs.writeFile(old, "old");
      await fs.chmod(old, 0o644);
      await writePrivateFileAtomic(old, "new");
      expect(readFileSync(old, "utf-8")).toBe("new");
      expect((await fs.stat(old)).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "tmp 创建时就带 0600（rename 之前那段明文窗口也不能被别的用户读），不是靠事后 chmod 收紧",
    async () => {
      const dir = await newDir();
      const opened: Array<{ name: string; mode: unknown }> = [];
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        opened.push({ name: path.basename(String(args[0])), mode: args[2] });
        return realOpen(...args);
      });
      await writePrivateFileAtomic(path.join(dir, "secret.json"), "k");
      const tmpOpen = opened.find((o) => o.name.startsWith("secret.json.tmp."));
      expect(tmpOpen, `没有打开 tmp：${JSON.stringify(opened)}`).toBeDefined();
      expect(tmpOpen!.mode).toBe(0o600);
    },
  );

  it("fsync 失败：照常落盘（只 warn），没有 tmp 残留", async () => {
    const dir = await newDir();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    trace({ syncThrows: errno("EIO") });
    const p = path.join(dir, "s.json");
    await writePrivateFileAtomic(p, "payload");
    vi.restoreAllMocks();
    expect(readFileSync(p, "utf-8")).toBe("payload");
    expect((await fs.readdir(dir)).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  it("rename 失败：抛原错误、tmp 被清掉、旧文件内容不动", async () => {
    const dir = await newDir();
    const p = path.join(dir, "keep.json");
    await writePrivateFileAtomic(p, "OLD");
    vi.spyOn(fs, "rename").mockRejectedValue(errno("ENOSPC"));
    await expect(writePrivateFileAtomic(p, "NEW")).rejects.toMatchObject({ code: "ENOSPC" });
    vi.restoreAllMocks();
    expect(readFileSync(p, "utf-8")).toBe("OLD");
    expect((await fs.readdir(dir)).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  it("写 tmp 失败（ENOSPC）：抛原错误、tmp 被清掉、旧文件内容不动", async () => {
    const dir = await newDir();
    const p = path.join(dir, "keep2.json");
    await writePrivateFileAtomic(p, "OLD");
    trace({ writeThrows: errno("ENOSPC") });
    await expect(writePrivateFileAtomic(p, "NEW")).rejects.toMatchObject({ code: "ENOSPC" });
    vi.restoreAllMocks();
    expect(readFileSync(p, "utf-8")).toBe("OLD");
    expect((await fs.readdir(dir)).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  it("并发写同一目标：最终是其中一份完整内容，目录里没有 tmp 残留", async () => {
    const dir = await newDir();
    const p = path.join(dir, "race.json");
    await Promise.all(
      Array.from({ length: 12 }, (_, n) => writePrivateFileAtomic(p, JSON.stringify({ n }))),
    );
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as { n: number };
    expect(parsed.n).toBeGreaterThanOrEqual(0);
    expect(parsed.n).toBeLessThan(12);
    expect(await fs.readdir(dir)).toEqual(["race.json"]);
  });
});

const mkEv = (kind: TaskEvent["kind"], text: string): TaskEvent => ({
  id: newEventId(),
  ts: Date.now(),
  kind,
  text,
});

const alloc = async (): Promise<string> => {
  const id = `t_afs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  await fs.mkdir(taskDir(id), { recursive: true });
  return id;
};

/** 种一段「info → user_reply(目标) → assistant × 2」的历史 */
const seed = async (id: string): Promise<{ target: TaskEvent }> => {
  const target = mkEv("user_reply", "target");
  await appendEventLine(id, mkEv("info", "before"));
  await appendEventLine(id, target);
  await appendEventLine(id, mkEv("assistant_message", "after-1"));
  await appendEventLine(id, mkEv("assistant_message", "after-2"));
  return { target };
};

describe("C. chat-checkpoint 的原子写", () => {
  it("truncateEventsBeforeEventId：fsync(events tmp) 先于 rename(events.jsonl)；只剩目标之前的事件", async () => {
    const id = await alloc();
    const { target } = await seed(id);
    const order = trace();
    const res = await truncateEventsBeforeEventId(id, target.id);
    expectSyncBeforeRename(order, EVENTS_FILE);
    expect(res?.kept.map((e) => e.text)).toEqual(["before"]);
    vi.restoreAllMocks();
    expect((await readEvents(id)).map((e) => e.text)).toEqual(["before"]);
  });

  it("restoreEventsRawText（文件被改写过 → 写回备份）：fsync 先于 rename，内容 = 备份原文", async () => {
    const id = await alloc();
    const { target } = await seed(id);
    const eventsFile = path.join(taskDir(id), EVENTS_FILE);
    const backup = readFileSync(eventsFile, "utf-8");
    await truncateEventsBeforeEventId(id, target.id); // 文件被改写：当前内容不再以备份为前缀

    const order = trace();
    await restoreEventsRawText(id, backup);
    expectSyncBeforeRename(order, EVENTS_FILE);
    vi.restoreAllMocks();
    expect(readFileSync(eventsFile, "utf-8")).toBe(backup);
  });

  it("writeRewindPoints：fsync 先于 rename(rewind_points.jsonl)", async () => {
    const id = await alloc();
    const order = trace();
    await writeRewindPoints(id, [
      { eventId: "e_1", createdAt: 1, repoSnapshots: [], kind: "checkpoint" },
    ]);
    expectSyncBeforeRename(order, "rewind_points.jsonl");
  });

  it("truncateEventsBeforeEventId 写失败（ENOSPC）：照样抛出、tmp 被清掉、原 events.jsonl 一字不动", async () => {
    const id = await alloc();
    const { target } = await seed(id);
    const eventsFile = path.join(taskDir(id), EVENTS_FILE);
    const before = readFileSync(eventsFile);
    trace({ writeThrows: errno("ENOSPC") });
    await expect(truncateEventsBeforeEventId(id, target.id)).rejects.toThrow("mock ENOSPC");
    vi.restoreAllMocks();
    expect(readFileSync(eventsFile).equals(before)).toBe(true);
    expect((await fs.readdir(taskDir(id))).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("writeRewindPoints 写失败（ENOSPC）：照样抛出、tmp 被清掉", async () => {
    const id = await alloc();
    trace({ writeThrows: errno("ENOSPC") });
    await expect(
      writeRewindPoints(id, [
        { eventId: "e_1", createdAt: 1, repoSnapshots: [], kind: "checkpoint" },
      ]),
    ).rejects.toThrow("mock ENOSPC");
    vi.restoreAllMocks();
    expect((await fs.readdir(taskDir(id))).filter((n) => n.includes(".tmp"))).toEqual([]);
  });
});

describe("D. writeWkConfig（~/.wk/config.yaml）", () => {
  it("fsync(tmp) 先于 rename(config.yaml)", async () => {
    const order = trace();
    await writeWkConfig({ docRepoPath: "/tmp/wk-doc", hubBaseUrl: "", hubToken: "" });
    expectSyncBeforeRename(order, "config.yaml");
    vi.restoreAllMocks();
    expect(readFileSync(path.join(hoisted.home, ".wk", "config.yaml"), "utf-8")).toContain(
      "/tmp/wk-doc",
    );
  });

  it("写失败（ENOSPC）：照样抛出、tmp 被清掉、原 config.yaml 一字不动", async () => {
    await writeWkConfig({ docRepoPath: "/tmp/wk-doc-old", hubBaseUrl: "", hubToken: "" });
    const file = path.join(hoisted.home, ".wk", "config.yaml");
    const before = readFileSync(file, "utf-8");
    trace({ writeThrows: errno("ENOSPC") });
    await expect(
      writeWkConfig({ docRepoPath: "/tmp/wk-doc-new", hubBaseUrl: "", hubToken: "" }),
    ).rejects.toThrow("mock ENOSPC");
    vi.restoreAllMocks();
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect((await fs.readdir(path.dirname(file))).filter((n) => n.includes(".tmp"))).toEqual([]);
  });
});

describe("F. writeAppSkill（用户自己写的 skill）", () => {
  it("fsync(tmp) 先于 rename(SKILL.md)；内容写对", async () => {
    const name = `fsync-skill-${Date.now().toString(36)}-a`;
    const order = trace();
    const err = await writeAppSkill(name, "# 我的 skill\n内容");
    expect(err).toBeNull();
    expectSyncBeforeRename(order, "SKILL.md");
    vi.restoreAllMocks();
    expect(readFileSync(path.join(getAppSkillsDir(), name, "SKILL.md"), "utf-8")).toBe(
      "# 我的 skill\n内容",
    );
  });

  it("写失败（ENOSPC）：返回用户可读的失败原因、tmp 被清掉、旧 SKILL.md 不动", async () => {
    const name = `fsync-skill-${Date.now().toString(36)}-b`;
    expect(await writeAppSkill(name, "OLD")).toBeNull();
    trace({ writeThrows: errno("ENOSPC") });
    const err = await writeAppSkill(name, "NEW");
    vi.restoreAllMocks();
    expect(err).toContain("写入失败");
    const dir = path.join(getAppSkillsDir(), name);
    expect(readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toBe("OLD");
    expect((await fs.readdir(dir)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});

describe("G. 删除 journal（崩溃恢复协议）", () => {
  const manifest = (phase?: "prepared" | "committed") => ({
    deletedAt: 1_792_000_000_000,
    checkpointRefs: [],
    ...(phase ? { phase } : {}),
  });

  /**
   * journal 的 tmp 名是 `.<taskId>.<pid>.<ts>.tmp`（不是 `<final>.tmp…`），
   * 所以 expectSyncBeforeRename 的前缀匹配用不上：按「对点开头、.tmp 结尾的文件 fsync」找。
   */
  const expectJournalSyncBeforeRename = (order: string[], taskId: string): void => {
    const finalName = path.basename(getDeletionJournalPath(taskId));
    const iWrite = idx(order, (s) => s.startsWith(`write:.${taskId}.`) && s.endsWith(".tmp"));
    const iSync = idx(order, (s) => s.startsWith(`sync:.${taskId}.`) && s.endsWith(".tmp"));
    const iRename = idx(order, (s) => s === `rename:${finalName}`);
    expect(iWrite, `没有对 journal tmp 的写入记录：${order.join(" → ")}`).toBeGreaterThanOrEqual(0);
    expect(iSync, `没有对 journal tmp 做 fsync：${order.join(" → ")}`).toBeGreaterThanOrEqual(0);
    expect(iRename, `没有 rename 到 ${finalName}：${order.join(" → ")}`).toBeGreaterThanOrEqual(0);
    // 写在 fsync 之前（先 fsync 空文件、再写内容，rename 之后 journal 照样可能是空的）
    expect(iSync, `fsync 先于写入（刷的是空文件）：${order.join(" → ")}`).toBeGreaterThan(iWrite);
    expect(iRename).toBeGreaterThan(iSync);
  };

  it("writeDeletionJournal（prepared）：fsync(tmp) 先于 rename(journal)；读回内容一致", async () => {
    const taskId = `t_dj_${Date.now().toString(36)}_a`;
    const order = trace();
    await writeDeletionJournal(taskId, manifest("prepared"));
    expectJournalSyncBeforeRename(order, taskId);
    vi.restoreAllMocks();
    const j = await readDeletionJournal(taskId);
    if (j.kind !== "present") throw new Error(`journal 读回不是 present：${j.kind}`);
    expect(j.value.phase).toBe("prepared");
    expect(j.value.deletedAt).toBe(1_792_000_000_000);
    await removeDeletionJournal(taskId);
  });

  it("commitDeletionJournal（prepared → committed 重写）：同样 fsync 先于 rename", async () => {
    const taskId = `t_dj_${Date.now().toString(36)}_b`;
    await writeDeletionJournal(taskId, manifest("prepared"));
    const order = trace();
    await commitDeletionJournal(taskId);
    expectJournalSyncBeforeRename(order, taskId);
    vi.restoreAllMocks();
    const j = await readDeletionJournal(taskId);
    if (j.kind !== "present") throw new Error(`journal 读回不是 present：${j.kind}`);
    expect(j.value.phase).toBe("committed");
    await removeDeletionJournal(taskId);
  });

  it("写 tmp 失败（ENOSPC）：抛原错误、journal 目录里没有 tmp 残留、已有的 journal 一字不动", async () => {
    const taskId = `t_dj_${Date.now().toString(36)}_d`;
    await writeDeletionJournal(taskId, manifest("prepared"));
    const journalFile = getDeletionJournalPath(taskId);
    const before = readFileSync(journalFile, "utf-8");
    trace({ writeThrows: errno("ENOSPC") });
    await expect(writeDeletionJournal(taskId, manifest("committed"))).rejects.toThrow("mock ENOSPC");
    vi.restoreAllMocks();
    expect(readFileSync(journalFile, "utf-8")).toBe(before);
    const left = (await fs.readdir(path.dirname(journalFile))).filter(
      (n) => n.startsWith(`.${taskId}.`) && n.endsWith(".tmp"),
    );
    expect(left).toEqual([]);
    await removeDeletionJournal(taskId);
  });

  it("fsync 失败：journal 照常提交（只 warn）", async () => {
    const taskId = `t_dj_${Date.now().toString(36)}_c`;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    trace({ syncThrows: errno("EIO") });
    await writeDeletionJournal(taskId, manifest("committed"));
    vi.restoreAllMocks();
    const j = await readDeletionJournal(taskId);
    expect(j.kind).toBe("present");
    await removeDeletionJournal(taskId);
  });
});

describe("E. 源码契约：这些原子写点不得退回 fs.writeFile(tmp…)", () => {
  const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), "utf-8");

  /** 取 `[export ]const <name> = ` 起、到第一个独占一行的 `};` 止的源码片段 */
  const fnBody = (src: string, name: string): string => {
    const start = src.search(new RegExp(`(?:export )?const ${name} = `));
    expect(start, `找不到 ${name} 的定义`).toBeGreaterThanOrEqual(0);
    const end = src.indexOf("\n};\n", start);
    expect(end, `${name} 没找到结尾`).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  const CASES: ReadonlyArray<readonly [string, string]> = [
    ["src/lib/server/data-root.ts", "writePrivateFileAtomic"],
    ["src/lib/server/chat-checkpoint.ts", "atomicWriteTextFile"],
    ["src/lib/server/chat-checkpoint.ts", "writeRewindPoints"],
    ["src/lib/server/wk-config.ts", "writeWkConfig"],
    ["src/lib/server/app-skills.ts", "writeAppSkill"],
    ["src/lib/server/task-fs.ts", "writeDeletionJournal"],
  ];

  it.each(CASES)("%s 的 %s：走 writeFileFsynced、不再直接 fs.writeFile", (file, name) => {
    const body = fnBody(read(file), name);
    expect(body).toContain("writeFileFsynced(");
    expect(body).not.toMatch(/\bfs\.writeFile\(/);
  });

  it("writeFileFsynced 只有 data-root 一份实现；task-fs-core 从那里 import，不再自己定义", () => {
    expect(read("src/lib/server/data-root.ts")).toMatch(/export const writeFileFsynced\s*=/);
    const core = read("src/lib/server/task-fs-core.ts");
    expect(core).not.toMatch(/const writeFileFsynced\s*=/);
    expect(core).toMatch(/import \{[^}]*\bwriteFileFsynced\b[^}]*\} from "\.\/data-root"/);
  });
});
