/**
 * 归档释放会话缓存（2026-11-12）：
 *  - 归档 = 会话不再活着：关空闲的内存会话 → 条件清盘上 sessionAgentId → 无人引用的 pi 会话文件一并删；
 *  - 在忙的会话 / 被别的流程接管的会话绝不动；
 *  - 路径安全：锚点是读出来的字符串，只有「pi-sessions 目录内的 .jsonl」才允许删；
 *  - chat / 非隔离任务的归档早退路径原先既不停预览、也不放会话（实测 3.2 GB SDK store 里 2.65 GB 属于已归档任务）。
 *
 * 诚实声明：真实的 Cursor SDK 会话 / 内存里的 chat 热会话在这里造不出来（SDK 被 mock），所以「在忙就不动」用注入的 deps
 * 验证决策、chat-runner 那一侧的守卫用源码契约钉住；SDK store 的 GC 回收空间不在本测试范围（见 sdk-store-gc*.test.ts）。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-session-cache-release-"));
const DATA = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA;

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));

const taskFs = await import("@/lib/server/task-fs");
const previewManager = await import("@/lib/server/preview-manager");
const release = await import("@/lib/server/session-cache-release");
const taskRunner = await import("@/lib/server/task-runner");

// 不跑 boot recovery（它会清孤儿 worktree / 杀预览进程 / GC SDK store）
(globalThis as unknown as Record<string, Promise<void> | undefined>)["__flowshipBootRecoveryPromiseV2__"] =
  Promise.resolve();

const PI_DIR = path.join(DATA, "pi-sessions");
mkdirSync(PI_DIR, { recursive: true });

const idle = {
  closeIdleSession: () => "none" as const,
  hasLiveSession: () => false,
};

let seq = 0;
const ids: string[] = [];
const mkTask = async (
  over: {
    mode?: "chat" | "task";
    archived?: boolean;
    anchor?: string;
    repo?: boolean;
    /** 缺省 = 新建任务的常态（带 provider）；传 null = 没有 provider 字段的老任务（R16-03） */
    provider?: string | null;
  } = {},
): Promise<string> => {
  seq += 1;
  const task = await taskFs.createTask({
    title: `release #${seq}`,
    repoPaths: over.repo ? [mkdtempSync(path.join(TMP_ROOT, "repo-"))] : [],
    mode: over.mode ?? "chat",
    workRole: "other",
    ...(over.provider === null ? {} : { provider: over.provider ?? "cursor" }),
  });
  ids.push(task.id);
  if (over.anchor) await taskFs.setTaskSessionAgentId(task.id, over.anchor);
  if (over.archived) await taskFs.setTaskPinArchive(task.id, { archived: true });
  return task.id;
};
const anchorOf = async (id: string): Promise<string | undefined> =>
  (await taskFs.getTaskMeta(id))?.sessionAgentId;

const piFile = (name: string, bytes = 100): string => {
  const f = path.join(PI_DIR, name);
  writeFileSync(f, "x".repeat(bytes));
  return f;
};

afterEach(async () => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  // 目录由 hermetic-env 的 tmp 根兜底清理；这里只清自己 mkdtemp 的
  const { rmSync } = await import("node:fs");
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("piSessionFileOf：只认 pi-sessions 目录内的 .jsonl", () => {
  it("目录内 .jsonl → 规整后的绝对路径", () => {
    const f = path.join(PI_DIR, "a_b.jsonl");
    expect(release.piSessionFileOf(f)).toBe(f);
  });

  it.each([
    ["Cursor SDK 的 UUID 锚点", "3f2b8c1e-aaaa-bbbb-cccc-123456789abc"],
    ["空串", ""],
    ["目录外、路径里碰巧带 pi-sessions", "/tmp/elsewhere/pi-sessions/a.jsonl"],
    // 注意不能用 path.join：它会先把 .. 归一掉、路径里就没有 pi-sessions 了，测不到后面的前缀校验
    ["用 .. 跳出目录", `${PI_DIR}/../config.json.jsonl`],
    ["pi-sessions 内但不是 .jsonl", path.join(PI_DIR, "a.txt")],
    // 评审 R16-09：不接受子目录——删除只 lstat 末级，子目录若是软链就越界了
    ["pi-sessions 的子目录里的 .jsonl", path.join(PI_DIR, "sub", "x.jsonl")],
    ["就是 pi-sessions 目录本身", PI_DIR],
  ])("%s → null（绝不拿它去删文件）", (_label, anchor) => {
    expect(release.piSessionFileOf(anchor)).toBeNull();
  });

  it("undefined / null → null", () => {
    expect(release.piSessionFileOf(undefined)).toBeNull();
    expect(release.piSessionFileOf(null)).toBeNull();
  });
});

describe("releaseTaskSessionCache", () => {
  it("Cursor 锚点：清掉盘上 sessionAgentId，不涉及文件", async () => {
    const id = await mkTask({ anchor: "11111111-2222-3333-4444-555555555555", archived: true });
    expect(await anchorOf(id)).toBeTruthy();
    const res = await release.releaseTaskSessionCache(
      { id, sessionAgentId: "11111111-2222-3333-4444-555555555555" },
      idle,
    );
    expect(res).toEqual({ status: "released", piBytes: 0 });
    expect(await anchorOf(id)).toBeUndefined();
  });

  it("pi 锚点：清锚点 + 删会话文件，回报释放的字节数", async () => {
    const f = piFile("own.jsonl", 321);
    const id = await mkTask({ anchor: f, archived: true });
    const res = await release.releaseTaskSessionCache({ id, sessionAgentId: f }, idle);
    expect(res).toEqual({ status: "released", piBytes: 321 });
    expect(await anchorOf(id)).toBeUndefined();
    expect(existsSync(f)).toBe(false);
  });

  it("两个任务共用同一条 pi 锚点：先释放的那个不删文件，最后一个释放时才删", async () => {
    const f = piFile("shared.jsonl", 50);
    const a = await mkTask({ anchor: f, archived: true });
    const b = await mkTask({ anchor: f, archived: true });
    const r1 = await release.releaseTaskSessionCache({ id: a, sessionAgentId: f }, idle);
    expect(r1).toEqual({ status: "released", piBytes: 0 });
    expect(existsSync(f)).toBe(true);
    const r2 = await release.releaseTaskSessionCache({ id: b, sessionAgentId: f }, idle);
    expect(r2).toEqual({ status: "released", piBytes: 50 });
    expect(existsSync(f)).toBe(false);
  });

  it("会话在忙（busy）：什么都不动——锚点、文件原样", async () => {
    const f = piFile("busy.jsonl", 10);
    const id = await mkTask({ anchor: f, archived: true });
    const res = await release.releaseTaskSessionCache(
      { id, sessionAgentId: f },
      { closeIdleSession: () => "busy", hasLiveSession: () => false },
    );
    expect(res).toEqual({ status: "busy", piBytes: 0 });
    expect(await anchorOf(id)).toBe(f);
    expect(existsSync(f)).toBe(true);
  });

  it("内存里又有会话了（被别的流程接管）：守卫拦下条件清，锚点与文件原样（kept）", async () => {
    const f = piFile("taken-over.jsonl", 10);
    const id = await mkTask({ anchor: f, archived: true });
    const res = await release.releaseTaskSessionCache(
      { id, sessionAgentId: f },
      { closeIdleSession: () => "none", hasLiveSession: () => true },
    );
    expect(res).toEqual({ status: "kept", piBytes: 0 });
    expect(await anchorOf(id)).toBe(f);
    expect(existsSync(f)).toBe(true);
  });

  it("盘上锚点已经换成别的（快照过期）：不乱清，kept", async () => {
    const id = await mkTask({ anchor: "fresh-anchor-uuid", archived: true });
    const res = await release.releaseTaskSessionCache(
      { id, sessionAgentId: "stale-anchor-uuid" },
      idle,
    );
    expect(res.status).toBe("kept");
    expect(await anchorOf(id)).toBe("fresh-anchor-uuid");
  });

  it("本来就没有锚点：none", async () => {
    const id = await mkTask({ archived: true });
    expect(await release.releaseTaskSessionCache({ id }, idle)).toEqual({ status: "none", piBytes: 0 });
  });

  it("closeIdleSession 抛错也不外泄（best-effort、绝不挡归档）", async () => {
    const id = await mkTask({ anchor: "x-anchor", archived: true });
    const res = await release.releaseTaskSessionCache(
      { id, sessionAgentId: "x-anchor" },
      {
        closeIdleSession: () => {
          throw new Error("boom");
        },
        hasLiveSession: () => false,
      },
    );
    expect(res.status).toBe("kept");
    expect(await anchorOf(id)).toBe("x-anchor");
  });
});

describe("requireArchived：批量释放在「释放那一刻」复核仍是已归档（R15-07）", () => {
  it("名单是前面列的、期间用户取消了归档：不动锚点与文件，也不白关空闲会话", async () => {
    const f = piFile("unarchived-meanwhile.jsonl", 40);
    const id = await mkTask({ anchor: f, archived: true });
    // 「清理缓存」列出名单之后、轮到它之前，用户把它取消归档了
    await taskFs.setTaskPinArchive(id, { archived: false });
    const closeIdleSession = vi.fn(() => "none" as const);
    const res = await release.releaseTaskSessionCache(
      { id, sessionAgentId: f },
      { closeIdleSession, hasLiveSession: () => false },
      { requireArchived: true },
    );
    expect(res).toEqual({ status: "kept", piBytes: 0 });
    expect(await anchorOf(id)).toBe(f);
    expect(existsSync(f)).toBe(true);
    expect(closeIdleSession).not.toHaveBeenCalled();
  });

  it("仍是已归档：照常释放", async () => {
    const f = piFile("still-archived.jsonl", 40);
    const id = await mkTask({ anchor: f, archived: true });
    const res = await release.releaseTaskSessionCache({ id, sessionAgentId: f }, idle, {
      requireArchived: true,
    });
    expect(res).toEqual({ status: "released", piBytes: 40 });
    expect(await anchorOf(id)).toBeUndefined();
  });

  it("不开 requireArchived 的调用（归档流程自己，在落 archived 标记之前释放）行为不变", async () => {
    const id = await mkTask({ anchor: "not-yet-archived-anchor" }); // 还没归档
    const res = await release.releaseTaskSessionCache(
      { id, sessionAgentId: "not-yet-archived-anchor" },
      idle,
    );
    expect(res.status).toBe("released");
    expect(await anchorOf(id)).toBeUndefined();
  });

  it("锁内复核（预检之后、提交之前才被取消归档的竞态由这一层兜住）：clearTaskSessionAgentIdIf 对未归档任务不清", async () => {
    const unarchived = await mkTask({ anchor: "guard-anchor-a", archived: true });
    await taskFs.setTaskPinArchive(unarchived, { archived: false });
    expect(
      await taskFs.clearTaskSessionAgentIdIf(unarchived, "guard-anchor-a", undefined, {
        requireArchived: true,
      }),
    ).toBe(false);
    expect(await anchorOf(unarchived)).toBe("guard-anchor-a");

    const archived = await mkTask({ anchor: "guard-anchor-b", archived: true });
    expect(
      await taskFs.clearTaskSessionAgentIdIf(archived, "guard-anchor-b", undefined, {
        requireArchived: true,
      }),
    ).toBe(true);
    expect(await anchorOf(archived)).toBeUndefined();

    // 默认（不带选项）语义不变：未归档任务照清（停止路径的 fire-and-forget 清锚点靠它）
    const plain = await mkTask({ anchor: "guard-anchor-c" });
    expect(await taskFs.clearTaskSessionAgentIdIf(plain, "guard-anchor-c")).toBe(true);
  });

  it("【R16-08】预检看到「仍已归档」、之后（closeIdleSession 之后、条件清之前）才被取消归档：锁内复核兜住——锚点与文件原样", async () => {
    const f = piFile("race-unarchive.jsonl", 12);
    const id = await mkTask({ anchor: f, archived: true });
    const metaFile = path.join(DATA, "tasks", id, "meta.json");
    const res = await release.releaseTaskSessionCache(
      { id, sessionAgentId: f },
      {
        // closeIdleSession 在预检之后、锁内条件清之前被调用：在这里把 archived 翻回去，模拟「用户恰好此刻取消归档」
        closeIdleSession: () => {
          const meta = JSON.parse(readFileSync(metaFile, "utf8"));
          meta.archived = false;
          writeFileSync(metaFile, JSON.stringify(meta));
          return "none" as const;
        },
        hasLiveSession: () => false,
      },
      { requireArchived: true },
    );
    expect(res).toEqual({ status: "kept", piBytes: 0 });
    expect(await anchorOf(id)).toBe(f);
    expect(existsSync(f)).toBe(true);
  });

  it("清理缓存路由对每个任务都带 requireArchived（源码契约）", () => {
    const src = readFileSync(
      path.join(__dirname, "..", "src", "app", "api", "system", "storage", "caches", "route.ts"),
      "utf8",
    );
    expect(src).toMatch(/releaseArchivedTaskSessionCache\(\s*\{[^}]*\},\s*\{ requireArchived: true \}/);
  });
});

describe("老任务保留提供方证据（评审 R16-03）", () => {
  /** 没有 provider 字段、锚点是 pi-sessions 形态：provider 只能靠这个锚点推断，清了就无声改走 Cursor 云端 */
  it("没有 provider + pi 锚点：释放返回 legacy，锚点与会话文件原样，也不白关空闲会话", async () => {
    const f = piFile("legacy-provider.jsonl", 55);
    const id = await mkTask({ anchor: f, archived: true, provider: null });
    expect((await taskFs.getTaskMeta(id))?.provider).toBeUndefined(); // 前提：真的是老任务
    const closeIdleSession = vi.fn(() => "none" as const);
    const res = await release.releaseTaskSessionCache(
      { id, sessionAgentId: f },
      { closeIdleSession, hasLiveSession: () => false },
      { requireArchived: true },
    );
    expect(res).toEqual({ status: "legacy", piBytes: 0 });
    expect(await anchorOf(id)).toBe(f);
    expect(existsSync(f)).toBe(true);
    expect(closeIdleSession).not.toHaveBeenCalled();
  });

  it("归档流程（不带 requireArchived）同样保留——否则取消归档后发消息会改走 Cursor", async () => {
    const f = piFile("legacy-archive-flow.jsonl", 20);
    const id = await mkTask({ anchor: f, provider: null }); // 还没归档
    const res = await release.releaseTaskSessionCache({ id, sessionAgentId: f }, idle);
    expect(res.status).toBe("legacy");
    expect(await anchorOf(id)).toBe(f);
  });

  it("对照：同样是 pi 锚点，只要有 provider 就照常释放（证明上面是 provider 缺失导致的）", async () => {
    const f = piFile("with-provider.jsonl", 33);
    const id = await mkTask({ anchor: f, archived: true, provider: "deepseek-internal" });
    const res = await release.releaseTaskSessionCache({ id, sessionAgentId: f }, idle, {
      requireArchived: true,
    });
    expect(res).toEqual({ status: "released", piBytes: 33 });
    expect(await anchorOf(id)).toBeUndefined();
  });

  it("对照：没有 provider 但锚点是 Cursor 的 UUID 形态——推断结果本来就是 Cursor，清掉不丢信息，照常释放", async () => {
    const id = await mkTask({ anchor: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb", archived: true, provider: null });
    const res = await release.releaseTaskSessionCache(
      { id, sessionAgentId: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb" },
      idle,
      { requireArchived: true },
    );
    expect(res.status).toBe("released");
  });

  it("锁内复核（预检看到「有 provider」、之后才变成没有）：clearTaskSessionAgentIdIf 带 keepProviderEvidence 就不清；不带照清", async () => {
    const f1 = piFile("lock-legacy.jsonl", 5);
    const legacy = await mkTask({ anchor: f1, archived: true, provider: null });
    expect(
      await taskFs.clearTaskSessionAgentIdIf(legacy, f1, undefined, { keepProviderEvidence: true }),
    ).toBe(false);
    expect(await anchorOf(legacy)).toBe(f1);

    // 默认语义不变：停止 / resume 失败路径的清锚点不受影响（那是必须清的）
    expect(await taskFs.clearTaskSessionAgentIdIf(legacy, f1)).toBe(true);
    expect(await anchorOf(legacy)).toBeUndefined();

    // 有 provider：带选项也照清
    const f2 = piFile("lock-withprov.jsonl", 5);
    const modern = await mkTask({ anchor: f2, archived: true, provider: "deepseek-internal" });
    expect(
      await taskFs.clearTaskSessionAgentIdIf(modern, f2, undefined, { keepProviderEvidence: true }),
    ).toBe(true);
  });

  it("预检之后、锁之前才失去 provider：返回 legacy（不是 kept / released），锚点仍在", async () => {
    const f = piFile("race-legacy.jsonl", 8);
    const id = await mkTask({ anchor: f, archived: true, provider: "deepseek-internal" });
    // closeIdleSession 在预检之后、条件清之前被调用——在这里把 provider 抹掉，模拟竞态
    const metaFile = path.join(DATA, "tasks", id, "meta.json");
    const res = await release.releaseTaskSessionCache(
      { id, sessionAgentId: f },
      {
        closeIdleSession: () => {
          const meta = JSON.parse(readFileSync(metaFile, "utf8"));
          delete meta.provider;
          writeFileSync(metaFile, JSON.stringify(meta));
          return "none" as const;
        },
        hasLiveSession: () => false,
      },
      { requireArchived: true },
    );
    expect(res).toEqual({ status: "legacy", piBytes: 0 });
    expect(await anchorOf(id)).toBe(f);
    expect(existsSync(f)).toBe(true);
  });

  it("listArchivedSessionHolders 标出 keepsProviderEvidence（调用方据此数「保留了几个」）", async () => {
    const f = piFile("flag-legacy.jsonl", 3);
    const legacy = await mkTask({ anchor: f, archived: true, provider: null });
    const modernFile = piFile("flag-modern.jsonl", 3);
    const modern = await mkTask({ anchor: modernFile, archived: true, provider: "deepseek-internal" });
    const byId = new Map((await release.listArchivedSessionHolders()).map((h) => [h.id, h]));
    expect(byId.get(legacy)?.keepsProviderEvidence).toBe(true);
    expect(byId.get(modern)?.keepsProviderEvidence).toBe(false);
  });
});

describe("孤儿判定不依赖路径写法逐字相等（评审 R16-05）", () => {
  it("活任务的锚点用另一种写法（数据目录别名 / 搬过家）指向当前目录里的同名文件：不算孤儿；对照：没人引用的照旧算", async () => {
    const live = piFile("alias-live.jsonl", 60);
    const stray = piFile("alias-stray.jsonl", 70);
    const longAgo = new Date(Date.now() - 3 * 3600_000);
    utimesSync(live, longAgo, longAgo);
    utimesSync(stray, longAgo, longAgo);
    // 锚点写的是「另一个根」下的同名文件：piSessionFileOf 认不出（不在当前 pi-sessions 里），但文件名对得上
    const aliasAnchor = path.join(TMP_ROOT, "moved-data", "pi-sessions", "alias-live.jsonl");
    expect(release.piSessionFileOf(aliasAnchor)).toBeNull(); // 前提：确实是「认不出」的写法
    await mkTask({ anchor: aliasAnchor, provider: "deepseek-internal" });

    const files = new Set(((await release.listOrphanPiSessionFiles()) ?? []).map((o) => o.file));
    expect(files.has(live)).toBe(false); // 仍被引用的活会话文件不能被当孤儿
    expect(files.has(stray)).toBe(true); // 对照：真孤儿照旧列出
  });

  it("Windows 反斜杠写法的锚点：按文件名也认得出", async () => {
    const live = piFile("alias-win.jsonl", 10);
    const longAgo = new Date(Date.now() - 3 * 3600_000);
    utimesSync(live, longAgo, longAgo);
    await mkTask({ anchor: "C:\\Users\\x\\AppData\\pi-sessions\\alias-win.jsonl", provider: "deepseek-internal" });
    const files = new Set(((await release.listOrphanPiSessionFiles()) ?? []).map((o) => o.file));
    expect(files.has(live)).toBe(false);
  });
});

describe("历史清理的两份名单", () => {
  it("listArchivedSessionHolders：只列「已归档 + 仍有锚点」，未归档的、没锚点的都不在", async () => {
    const holder = await mkTask({ anchor: "holder-uuid", archived: true });
    const f = piFile("holder-pi.jsonl", 77);
    const piHolder = await mkTask({ anchor: f, archived: true });
    const activeWithAnchor = await mkTask({ anchor: "active-uuid" });
    const archivedNoAnchor = await mkTask({ archived: true });

    const list = await release.listArchivedSessionHolders();
    const byId = new Map(list.map((h) => [h.id, h]));
    expect(byId.has(holder)).toBe(true);
    expect(byId.get(holder)?.piBytes).toBeNull(); // Cursor 会话没法按任务拆开量
    expect(byId.get(piHolder)?.piBytes).toBe(77);
    expect(byId.has(activeWithAnchor)).toBe(false);
    expect(byId.has(archivedNoAnchor)).toBe(false);
  });

  it("listOrphanPiSessionFiles：被任务引用的 / 宽限内的 / 非 jsonl 的都不算孤儿，只剩真孤儿", async () => {
    const referenced = piFile("ref.jsonl", 1);
    await mkTask({ anchor: referenced });
    const oldOrphan = piFile("old-orphan.jsonl", 500);
    const recentOrphan = piFile("recent-orphan.jsonl", 9);
    writeFileSync(path.join(PI_DIR, "note.txt"), "keep me");
    const longAgo = new Date(Date.now() - 3 * 3600_000);
    utimesSync(oldOrphan, longAgo, longAgo);
    utimesSync(referenced, longAgo, longAgo);
    // recentOrphan：刚写、在宽限内——可能是还在跑的旁路会话

    const orphans = await release.listOrphanPiSessionFiles();
    expect(orphans).not.toBeNull();
    const files = new Set((orphans ?? []).map((o) => o.file));
    expect(files.has(oldOrphan)).toBe(true);
    expect(files.has(referenced)).toBe(false);
    expect(files.has(recentOrphan)).toBe(false);
    expect(files.has(path.join(PI_DIR, "note.txt"))).toBe(false);
    expect((orphans ?? []).find((o) => o.file === oldOrphan)?.bytes).toBe(500);
  });

  it("活名单读不出（某个任务 meta 坏了且没有备份）→ 返回 null，整轮不动，宁可少清", async () => {
    const id = await mkTask({ anchor: "will-be-corrupt" });
    const dir = path.join(DATA, "tasks", id);
    writeFileSync(path.join(dir, "meta.json"), "{ not json");
    // 备份也毁掉：collectLiveAgentIds 才会判「读不出」
    for (const bak of ["meta.json.bak"]) {
      try {
        writeFileSync(path.join(dir, bak), "{ not json");
      } catch {
        /* ignore */
      }
    }
    expect(await release.listOrphanPiSessionFiles()).toBeNull();
    // 复原，别影响后面的用例
    writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id, title: "restored", mode: "chat", repoStatus: "developing", createdAt: 1, updatedAt: 1, repoPaths: [], actions: [] }),
    );
    writeFileSync(path.join(dir, "meta.json.bak"), readFileSync(path.join(dir, "meta.json")));
  });
});

describe("归档接线：chat / 非隔离任务的早退路径", () => {
  it("归档 chat 任务：停预览、放会话缓存（锚点清掉、pi 文件删掉）、回报 sessionCacheReleased", async () => {
    const f = piFile("archive-chat.jsonl", 64);
    const id = await mkTask({ mode: "chat", anchor: f });
    const stopSpy = vi.spyOn(previewManager, "stopPreviewsForTask");

    const out = await taskRunner.archiveTaskWithReport(id, true);

    expect(out?.task.archived).toBe(true);
    expect(stopSpy).toHaveBeenCalledWith(id);
    expect(out?.report.sessionCacheReleased).toBe(true);
    expect(await anchorOf(id)).toBeUndefined();
    expect(existsSync(f)).toBe(false);
  });

  it("归档没锚点的 chat 任务：照常归档，不谎报「已释放」", async () => {
    const id = await mkTask({ mode: "chat" });
    const out = await taskRunner.archiveTaskWithReport(id, true);
    expect(out?.task.archived).toBe(true);
    expect(out?.report.sessionCacheReleased).toBe(false);
  });

  it("停预览抛错也不影响归档本身", async () => {
    const id = await mkTask({ mode: "chat", anchor: "some-uuid" });
    vi.spyOn(previewManager, "stopPreviewsForTask").mockRejectedValueOnce(new Error("preview boom"));
    const out = await taskRunner.archiveTaskWithReport(id, true);
    expect(out?.task.archived).toBe(true);
    expect(await anchorOf(id)).toBeUndefined();
  });

  it("归档非隔离的 task 模式任务（没在跑）：同样放会话缓存", async () => {
    const id = await mkTask({ mode: "task", anchor: "task-uuid-anchor", repo: true });
    const out = await taskRunner.archiveTaskWithReport(id, true);
    expect(out?.task.archived).toBe(true);
    expect(out?.report.sessionCacheReleased).toBe(true);
    expect(await anchorOf(id)).toBeUndefined();
  });

  it("取消归档不动任何缓存（只翻标记；下次发消息起新会话）", async () => {
    const id = await mkTask({ mode: "chat", anchor: "restore-anchor", archived: true });
    const out = await taskRunner.archiveTaskWithReport(id, false);
    expect(out?.task.archived).toBeFalsy();
    expect(out?.report.sessionCacheReleased).toBeUndefined();
    expect(await anchorOf(id)).toBe("restore-anchor");
  });
});

describe("源码契约（造不出的运行时状态用接线钉住）", () => {
  const read = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");

  it("chat 侧只关「守卫放行」的空闲会话（与空闲清扫 / 水位门同一道 chatReclaimBlock），且 keepPersisted（锚点由调用方条件清）", () => {
    const src = read("src/lib/server/chat-runner.ts");
    const at = src.indexOf("export const closeIdleChatSessionForArchive");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n};", at));
    expect(body).toContain("chatReclaimBlock(taskId, rec) !== null");
    expect(body).toContain('return "busy"');
    expect(body).toContain("keepPersisted: true");
  });

  it("task 侧：在跑 / 在启动都算 busy；reap:false 不去碰非隔离任务的真仓库目录", () => {
    const src = read("src/lib/server/task-runner.ts");
    const at = src.indexOf("export const closeIdleTaskSessionForArchive");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n};", at));
    expect(body).toContain("runningTasks.has(taskId) || isTaskStarting(taskId)");
    expect(body).toContain("reap: false");
    expect(body).toContain("keepPersisted: true");
  });

  it("worktree 归档路径也补了确定性释放（在 cancelTaskRun 等真停之后、删 worktree 之前）", () => {
    const src = read("src/lib/server/task-runner.ts");
    const at = src.indexOf("const archiveWorktreeTaskLocked = async");
    const body = src.slice(at, src.indexOf("\n};", at));
    expect(body.indexOf("cancelTaskRun(taskId)")).toBeLessThan(body.indexOf("releaseSessionCacheForArchive(task)"));
    expect(body.indexOf("releaseSessionCacheForArchive(task)")).toBeLessThan(body.indexOf("removeTaskWorktrees(task)"));
  });

  it("归档路径不跑 SDK store GC（宽限期内白跑 + 久未活动时整库重写不该挂在一次点击上）", () => {
    const src = read("src/lib/server/task-runner.ts");
    const at = src.indexOf("const releaseSessionCacheForArchive");
    const body = src.slice(at, src.indexOf("\n};", at));
    expect(body).not.toContain("maybeGcSdkStore");
    expect(body).not.toContain("gcSdkStoreOnce");
  });
});
