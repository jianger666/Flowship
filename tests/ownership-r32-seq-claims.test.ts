/**
 * R32 退出矩阵第 4、5 条：R31-4 seq high-water sidecar + R31-5 runningCheck claim 同条目
 *
 * ① >4MB 日志、历史 max=1000 在 4MB 窗外、尾部 seq 循环 1~10 → 清 counter 模拟重启 → 新 append 得 1001
 * ② sidecar 缺失 → 首次恢复全量流式扫描重建
 * ③ sidecar 损坏（垃圾内容）→ 恢复不崩、fallback 扫描得正确 max
 * ④ 跨 vi.resetModules 双模块实例：A 登记 check、B abortRunningCheck → claim 立即释放；
 *    A 迟到 drop/release 不影响后来 token
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-ownership-r32-seq-claims-"),
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
  taskDir,
  writeMeta,
} = await import("@/lib/server/task-fs-core");
const { appendEvent } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r32-seq-claims DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

afterAll(() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:fs").rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: "r32-seq",
    mode: "chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    repoStatus: "idle",
    runStatus: "idle",
    actions: [],
    mrs: [],
    repoPaths: [],
    currentActionId: null,
  }) as unknown as TaskMetaV06;

/** 复刻 Codex R31-4 探针：首行 seq=1000，后 650 条大事件 seq 循环 1~10，总 >4MB */
const writeOver4MbRenumberedLog = async (id: string): Promise<number> => {
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
  const body = lines.join("\n") + "\n";
  const p = path.join(taskDir(id), EVENTS_FILE);
  await fs.writeFile(p, body, "utf-8");
  const st = await fs.stat(p);
  expect(st.size).toBeGreaterThan(4 * 1024 * 1024);
  return st.size;
};

const sidecarPath = (id: string): string =>
  path.join(taskDir(id), EVENT_SEQ_SIDECAR_FILE);

const waitForSidecar = async (
  id: string,
  expectValue: number,
  ms = 2000,
): Promise<void> => {
  const deadline = Date.now() + ms;
  const p = sidecarPath(id);
  while (Date.now() < deadline) {
    try {
      const raw = (await fs.readFile(p, "utf-8")).trim();
      if (raw === String(expectValue)) return;
    } catch {
      // 尚未写出
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  let got = "(missing)";
  try {
    got = (await fs.readFile(p, "utf-8")).trim();
  } catch {
    // keep
  }
  throw new Error(
    `sidecar 未在 ${ms}ms 内变为 ${expectValue}，当前=${got}`,
  );
};

describe("R31-4：seq high-water sidecar", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r32_seq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  afterEach(async () => {
    for (const id of ids.splice(0)) {
      clearEventSeqCounter(id);
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
  });

  it("① >4MB 且历史 max 在窗外 → 重启恢复后新 append 得 1001", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await writeOver4MbRenumberedLog(id);
    // 无 sidecar：旧实现尾扫只见 max≈10 → 下一号 11；修复后全量扫 / sidecar 得 1000→1001
    clearEventSeqCounter(id);
    const next = await appendEvent(id, {
      kind: "info",
      text: "r32-after-4mb-restart",
    });
    expect(next?.seq).toBe(1001);
  });

  it("② sidecar 缺失 → 首次恢复全量扫描并重建 sidecar", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await writeOver4MbRenumberedLog(id);
    await fs.unlink(sidecarPath(id)).catch(() => {});
    clearEventSeqCounter(id);

    const next = await appendEvent(id, {
      kind: "info",
      text: "r32-missing-sidecar",
    });
    expect(next?.seq).toBe(1001);
    // 懒恢复后立即异步写回 sidecar=durable max（1000）；批量 flush 每 16 条才推进，故仍为 1000
    await waitForSidecar(id, 1000);
  });

  it("③ sidecar 损坏 → 不崩、fallback 扫描得 1001", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await writeOver4MbRenumberedLog(id);
    await fs.writeFile(sidecarPath(id), "not-a-number!!!\n", "utf-8");
    clearEventSeqCounter(id);

    const next = await appendEvent(id, {
      kind: "info",
      text: "r32-corrupt-sidecar",
    });
    expect(next?.seq).toBe(1001);
  });

  it("sidecar 合法但落后于尾部 → max(sidecar, 尾扫) 取较大者", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    // 短日志：sidecar=5，盘上 max=10
    const lines = [8, 9, 10].map((seq, i) =>
      JSON.stringify({
        id: `ev_tail_${seq}`,
        ts: i + 1,
        kind: "info",
        text: `t-${seq}`,
        seq,
      }),
    );
    await fs.writeFile(
      path.join(taskDir(id), EVENTS_FILE),
      lines.join("\n") + "\n",
      "utf-8",
    );
    await fs.writeFile(sidecarPath(id), "5", "utf-8");
    clearEventSeqCounter(id);

    const next = await appendEvent(id, {
      kind: "info",
      text: "r32-sidecar-lag",
    });
    expect(next?.seq).toBe(11);
  });
});

describe("R31-5：runningCheck claimHandle 跨模块实例", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r32_claim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  afterEach(async () => {
    // 清 global claim + check，避免污染
    const { clearActionSideEffects } = await import(
      "@/lib/server/action-side-effects"
    );
    const { runningChecks } = await import("@/lib/server/task-stream");
    for (const id of ids.splice(0)) {
      clearActionSideEffects(id);
      runningChecks.delete(id);
      clearEventSeqCounter(id);
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    vi.resetModules();
  });

  it("④ A 登记 / B abort → hasActionSideEffect 立即 false；A 迟到 release 不影响新 token", async () => {
    const id = alloc();
    const actionId = "act_ship";
    await writeMeta(makeMeta(id));

    // —— 实例 A：claim + 挂 RunningCheck（模拟 runActionPostCheck 登记）——
    const sideA = await import("@/lib/server/action-side-effects");
    const streamA = await import("@/lib/server/task-stream");
    const claim = await sideA.waitAndClaimPostCheck(id, actionId);
    expect(claim.result).toBe("claimed");
    if (claim.result !== "claimed") throw new Error("expected claimed");
    const oldHandle = claim.handle;

    const controller = new AbortController();
    streamA.runningChecks.set(id, {
      actionId,
      controller,
      claimHandle: oldHandle,
    });
    expect(sideA.hasActionSideEffect(id, actionId)).toBe(true);

    // —— 实例 B：resetModules 清掉 module-local；globalThis.runningChecks 仍在 ——
    // 旧 bug：companion Map 在 B 侧为空 → abort 摘 check 却放不掉 claim
    vi.resetModules();
    const runnerB = await import("@/lib/server/task-runner");
    const sideB = await import("@/lib/server/action-side-effects");
    const streamB = await import("@/lib/server/task-stream");

    expect(streamB.runningChecks.get(id)?.claimHandle?.claimId).toBe(
      oldHandle.claimId,
    );
    runnerB.abortRunningCheck(id);

    expect(sideB.hasActionSideEffect(id, actionId)).toBe(false);
    expect(streamB.runningChecks.has(id)).toBe(false);
    expect(controller.signal.aborted).toBe(true);

    // A 迟到 dropSelf / release（旧 handle）不得影响随后新 token
    sideA.releaseSideEffect(oldHandle);
    expect(sideB.hasActionSideEffect(id, actionId)).toBe(false);

    const claim2 = await sideB.waitAndClaimPostCheck(id, actionId);
    expect(claim2.result).toBe("claimed");
    if (claim2.result !== "claimed") throw new Error("expected claimed");
    expect(claim2.handle.claimId).not.toBe(oldHandle.claimId);

    // 旧 handle 再 release 一次：精确 claimId 对不上 → 新 token 仍在
    sideA.releaseSideEffect(oldHandle);
    expect(sideB.hasActionSideEffect(id, actionId)).toBe(true);
    expect(sideB.getActionSideEffectClaimId(id, actionId)).toBe(
      claim2.handle.claimId,
    );

    sideB.releaseSideEffect(claim2.handle);
  });
});
