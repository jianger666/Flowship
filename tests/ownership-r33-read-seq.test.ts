/**
 * R33 退出矩阵第 4、6 条：R32-5 tombstone 提交前复查 + 前端 epoch；R32-7 seq 尾窗强制全量扫
 *
 * ① listTasks：readMetaRaw 后 failpoint 挂起 → 写 tombstone → 放行 → 列表不含该任务
 * ② getTask：同型（taskread.beforeHydrate）→ 返 null
 * ③ 前端 epoch：DELETE 推进世代后，旧 refresh 响应不得提交（纯函数直测）
 * ④ sidecar 合法落后 + 末条 4MB−1 / 4MB+1 / 8MB → 模拟重启 → next seq > durable max
 * ⑤ 两路异步 sidecar 写反序 → 盘上水位不倒退
 * ⑥ sidecar 缺失 / 损坏路径回归（与 R32 既有矩阵同构）
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
import type { TaskSummary } from "@/lib/types";

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-ownership-r33-read-seq-"),
);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: vi.fn(),
  },
}));
vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T>(servers: T) => servers,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({
    servers,
    dropped: [],
  }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));

const {
  clearEventSeqCounter,
  EVENT_SEQ_SIDECAR_FILE,
  EVENTS_FILE,
  persistSeqSidecar,
  readSeqSidecar,
  taskDir,
  writeMeta,
} = await import("@/lib/server/task-fs-core");
const { appendEvent, getTask, listTasks, writeDeleteTombstone } = await import(
  "@/lib/server/task-fs"
);
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  canCommitTaskListRefresh,
  filterTaskListAfterRefresh,
  rememberSuccessfulDeletedId,
  SUCCESSFUL_DELETED_IDS_MAX,
} = await import("@/lib/task-list-refresh");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r33-read-seq DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";

const skipBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  g[RECOVERY_FLAG] = Promise.resolve();
};

afterAll(() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:fs").rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const installHangingFailpoint = (name: string) => {
  let hitResolve!: () => void;
  const hit = new Promise<void>((r) => {
    hitResolve = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setFailpoint(name, async () => {
    hitResolve();
    await gate;
  });
  return { waitHit: () => hit, release: () => release() };
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: "r33-read-seq",
    mode: "chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    repoStatus: "developing",
    runStatus: "idle",
    actions: [],
    mrs: [],
    repoPaths: [],
    currentActionId: null,
  }) as unknown as TaskMetaV06;

const sidecarPath = (id: string): string =>
  path.join(taskDir(id), EVENT_SEQ_SIDECAR_FILE);

/** 构造目标字节长度的单行 JSON 事件（不含末尾 \\n） */
const makeFatEventLine = (seq: number, targetBytes: number): string => {
  const base = {
    id: `ev_fat_${seq}`,
    ts: seq,
    kind: "assistant_message",
    text: "",
    seq,
  };
  // 先估开销，再微调到精确长度
  const padLen = Math.max(0, targetBytes - JSON.stringify(base).length);
  base.text = "Y".repeat(padLen);
  let line = JSON.stringify(base);
  while (line.length < targetBytes) {
    base.text += "Y";
    line = JSON.stringify(base);
  }
  while (line.length > targetBytes && base.text.length > 0) {
    base.text = base.text.slice(0, -1);
    line = JSON.stringify(base);
  }
  expect(line.length).toBe(targetBytes);
  return line;
};

/**
 * sidecar=0（合法落后 ≤15）+ seq 1..15 小事件 + seq=16 超大末条。
 * 模拟「批量推进未完成 / rename 前 crash」。
 */
const seedLaggingSidecarWithFatTail = async (
  id: string,
  fatLineBytes: number,
): Promise<number> => {
  await writeMeta(makeMeta(id));
  const lines: string[] = [];
  for (let i = 1; i <= 15; i++) {
    lines.push(
      JSON.stringify({
        id: `ev_small_${i}`,
        ts: i,
        kind: "info",
        text: "x",
        seq: i,
      }),
    );
  }
  lines.push(makeFatEventLine(16, fatLineBytes));
  const body = lines.join("\n") + "\n";
  await fs.writeFile(path.join(taskDir(id), EVENTS_FILE), body, "utf-8");
  await fs.writeFile(sidecarPath(id), "0", "utf-8");
  return 16; // durable max
};

/** 复刻 R31-4 >4MB 重号日志（缺 sidecar 全量扫路径） */
const writeOver4MbRenumberedLog = async (id: string): Promise<void> => {
  const pad = "Y".repeat(8_000);
  const lines: string[] = [
    JSON.stringify({
      id: "ev_hw_1000",
      ts: 1,
      kind: "info",
      text: "historical-high-water",
      seq: 1000,
    }),
  ];
  for (let i = 0; i < 650; i++) {
    const seq = (i % 10) + 1;
    lines.push(
      JSON.stringify({
        id: `ev_loop_${i}`,
        ts: i + 2,
        kind: "info",
        text: pad,
        seq,
      }),
    );
  }
  await fs.writeFile(
    path.join(taskDir(id), EVENTS_FILE),
    lines.join("\n") + "\n",
    "utf-8",
  );
};

describe("R32-5：list/get tombstone 提交前复查", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r33_tb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    clearFailpoints();
    skipBootRecovery();
  });

  afterEach(async () => {
    clearFailpoints();
    for (const id of ids.splice(0)) {
      clearEventSeqCounter(id);
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
  });

  it("① listTasks：readMeta 挂起期间落 tombstone → 返回不含该任务", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const { waitHit, release } = installHangingFailpoint(
      "listTasks.afterReadMeta",
    );

    const listP = listTasks();
    await waitHit();
    await writeDeleteTombstone(id);
    release();

    const list = await listP;
    expect(list.some((t) => t.id === id)).toBe(false);
  });

  it("② getTask：hydrate 前挂起期间落 tombstone → 返 null", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    // 空 events 即可 hydrate
    await fs.writeFile(path.join(taskDir(id), EVENTS_FILE), "", "utf-8");

    const { waitHit, release } = installHangingFailpoint(
      "taskread.beforeHydrate",
    );
    const getP = getTask(id);
    await waitHit();
    await writeDeleteTombstone(id);
    release();

    expect(await getP).toBeNull();
  });
});

describe("R32-5：前端 refresh epoch + successfulDeletedIds", () => {
  it("③ DELETE 推进 epoch 后，旧 refresh 不得提交", () => {
    let epoch = 0;
    const startEpoch = epoch; // 旧 refresh 发起时
    // 模拟 DELETE 200 成功推进
    epoch += 1;
    expect(canCommitTaskListRefresh(startEpoch, epoch)).toBe(false);
    // 新 refresh 可提交
    const newStart = epoch;
    expect(canCommitTaskListRefresh(newStart, epoch)).toBe(true);
  });

  it("③b successfulDeletedIds 过滤迟到 list 中的已删 id", () => {
    const stub = (id: string): TaskSummary =>
      ({
        id,
        title: id,
        repoStatus: "developing",
        runStatus: "idle",
        createdAt: 1,
        updatedAt: 1,
        actionCount: 0,
        repoPaths: [],
        currentActionId: null,
        mrs: [],
      }) as unknown as TaskSummary;
    const list: TaskSummary[] = [stub("gone"), stub("keep")];
    const deleted = new Set<string>();
    rememberSuccessfulDeletedId(deleted, "gone");
    const filtered = filterTaskListAfterRefresh(list, new Set(), deleted);
    expect(filtered.map((t) => t.id)).toEqual(["keep"]);
  });

  it("③c successfulDeletedIds 有界淘汰最旧", () => {
    const set = new Set<string>();
    for (let i = 0; i < SUCCESSFUL_DELETED_IDS_MAX + 3; i++) {
      rememberSuccessfulDeletedId(set, `id_${i}`, SUCCESSFUL_DELETED_IDS_MAX);
    }
    expect(set.size).toBe(SUCCESSFUL_DELETED_IDS_MAX);
    expect(set.has("id_0")).toBe(false);
    expect(set.has(`id_${SUCCESSFUL_DELETED_IDS_MAX + 2}`)).toBe(true);
  });
});

describe("R32-7：seq 尾窗强制全量扫 + sidecar 只升不降", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r33_seq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  afterEach(async () => {
    for (const id of ids.splice(0)) {
      clearEventSeqCounter(id);
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
  });

  const MB = 1024 * 1024;

  it.each([
    ["4MB−1", MB * 4 - 1],
    ["4MB+1", MB * 4 + 1],
    ["8MB", MB * 8],
  ] as const)(
    "④ sidecar=0 + 末条 %s → 重启后 next seq > durable max",
    async (_label, fatBytes) => {
      const id = alloc();
      const durableMax = await seedLaggingSidecarWithFatTail(id, fatBytes);
      clearEventSeqCounter(id); // 模拟重启：丢内存 counter，盘上 sidecar=0 仍在
      const next = await appendEvent(id, {
        kind: "info",
        text: `r33-after-fat-${fatBytes}`,
      });
      expect(next?.seq).toBeGreaterThan(durableMax);
      expect(next?.seq).toBe(durableMax + 1);
    },
    60_000,
  );

  it("⑤ 两路异步 sidecar 写反序 → 水位不倒退", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    // 先落到高水位，再并发调度「低水位覆盖」——串行链 + 只升不降应保住 16
    await persistSeqSidecar(id, 16);
    expect(await readSeqSidecar(id)).toBe(16);

    await Promise.all([
      persistSeqSidecar(id, 16),
      persistSeqSidecar(id, 1),
      persistSeqSidecar(id, 0),
    ]);
    // 再给链一点时间（best-effort 已 await，但保险）
    await sleep(20);
    expect(await readSeqSidecar(id)).toBe(16);
  });

  it("⑤b 先调度低水位再调度高水位 → 最终为高", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await Promise.all([persistSeqSidecar(id, 3), persistSeqSidecar(id, 42)]);
    expect(await readSeqSidecar(id)).toBe(42);
  });

  it("⑥ sidecar 缺失 → 全量扫恢复（>4MB 历史高水位）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await writeOver4MbRenumberedLog(id);
    await fs.unlink(sidecarPath(id)).catch(() => {});
    clearEventSeqCounter(id);
    const next = await appendEvent(id, {
      kind: "info",
      text: "r33-missing-sidecar",
    });
    expect(next?.seq).toBe(1001);
  });

  it("⑥b sidecar 损坏 → 不崩、fallback 扫描得正确 max", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await writeOver4MbRenumberedLog(id);
    await fs.writeFile(sidecarPath(id), "not-a-number!!!", "utf-8");
    clearEventSeqCounter(id);
    const next = await appendEvent(id, {
      kind: "info",
      text: "r33-corrupt-sidecar",
    });
    expect(next?.seq).toBe(1001);
  });
});
