/**
 * boot recovery 的失败重试按 id 做（P3：以前整进程只缓存一个 promise，某个任务恢复时的瞬时失败 = 本进程内永久跳过）。
 *
 * 旧行为：`ensureBootRecovery` 缓存同一个 promise；`recoverOneTask` 内读 meta / 追加事件 / 写 meta 失败、
 * 或顶层 `readdir(DATA_DIR)` 失败，都只 warn 一下——那个僵尸 `running` 任务在本进程活着的整段时间里
 * 都不会被标 error（侧栏永远转圈），只能等下次重启。
 *
 * 现在：失败的 id 记进全局失败表；冷却期（30s）后由 ensureBootRecovery 的后续调用在后台**只重试这些 id**
 * （成功的不重做，不重复追加 error 事件），每个 id 最多再试 3 次。重试比首轮多两道闸，防止误杀本进程里
 * 刚启动的 run：持任务锁 + 只处理「meta.updatedAt 早于本进程 boot 时刻」的僵尸
 *（本进程内任何 run 启动都会写 meta、把 updatedAt 推到 boot 之后）。
 *
 * DATA_DIR 在 task-fs-core 模块加载时冻结：必须先钉 FLOWSHIP_DATA_DIR 再动态 import（同 task-fs-bad-dir-names.test.ts）。
 * 只把 Date 换成假的（vi.setSystemTime 快进冷却期）；定时器 / fs 仍是真的。
 */
import { mkdtempSync, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

vi.mock("@/lib/server/sdk-store-gc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/sdk-store-gc")>()),
  maybeGcSdkStore: vi.fn(),
}));

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-boot-retry-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const { DATA_DIR, META_FILE, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { listTasksWithCorrupt } = await import("@/lib/server/task-fs");

if (!DATA_DIR.startsWith(TMP_ROOT)) {
  throw new Error(`boot-retry DATA_DIR 未隔离到 TMP：${DATA_DIR}`);
}

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const RETRY_STATE = "__flowshipBootRecoveryRetryV1__";
const g = globalThis as unknown as Record<string, unknown>;
type RetryState = { failed: Map<string, number>; listFailed: boolean; sweeping: boolean };
const retryState = (): RetryState | undefined => g[RETRY_STATE] as RetryState | undefined;

const COOLDOWN_PLUS = 31_000; // 冷却期 30s
const RETRY_MAX = 3;

const baseMeta = (id: string, patch: Partial<TaskMetaV06> = {}): TaskMetaV06 => ({
  id,
  title: `任务 ${id}`,
  mode: "chat",
  repoStatus: "developing",
  runStatus: "running",
  currentActionId: null,
  actions: [],
  mrs: [],
  repoPaths: [],
  createdAt: 1_000,
  updatedAt: 1_000, // 远早于本进程 boot：是「上一个进程留下的僵尸」
  ...patch,
});

/** 绕过 spy：同步读盘看 meta 的真实 runStatus */
const runStatusOf = (id: string): string =>
  (JSON.parse(readFileSync(path.join(taskDir(id), META_FILE), "utf-8")) as TaskMetaV06).runStatus;

const bootEventCount = (id: string): number => {
  try {
    const text = readFileSync(path.join(taskDir(id), "events.jsonl"), "utf-8");
    return text.split("\n").filter((l) => l.includes("[boot-recovery]")).length;
  } catch {
    return 0;
  }
};

/** 让某个任务 meta.json 的异步读失败（EBUSY）；返回开关 */
const failMetaReads = (id: string) => {
  const target = path.join(taskDir(id), META_FILE);
  const real = fs.readFile.bind(fs) as (...a: unknown[]) => Promise<unknown>;
  const ctl = { fail: true, hits: 0 };
  vi.spyOn(fs, "readFile").mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (ctl.fail && String(p) === target) {
      ctl.hits += 1;
      return Promise.reject(Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }));
    }
    return real(p, ...rest);
  }) as unknown as typeof fs.readFile);
  return ctl;
};

const resetBoot = (): void => {
  delete g[RECOVERY_FLAG];
  delete g[RETRY_STATE];
};

let warnSpy: MockInstance<typeof console.warn>;
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  resetBoot();
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(async () => {
  resetBoot();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

/** 等后台重试扫完（失败表清空 / 不再 sweeping） */
const waitSweepDone = (): Promise<void> =>
  vi.waitFor(() => {
    const st = retryState();
    expect(st?.sweeping ?? false).toBe(false);
  });

describe("boot recovery：失败的 id 只重试它自己", () => {
  it("某任务首轮读 meta 瞬时失败：其余照常恢复；冷却期后后台只重试它，已恢复的不重做（不重复追加事件）", async () => {
    await writeMeta(baseMeta("t_flaky_1"));
    await writeMeta(baseMeta("t_fine_1"));
    const ctl = failMetaReads("t_flaky_1");

    await listTasksWithCorrupt(); // 触发首轮恢复
    expect(runStatusOf("t_fine_1")).toBe("error");
    expect(bootEventCount("t_fine_1")).toBe(1);
    expect(runStatusOf("t_flaky_1")).toBe("running"); // 读不出来 → 没能标 error
    expect(retryState()?.failed.has("t_flaky_1")).toBe(true);
    expect(retryState()?.failed.has("t_fine_1")).toBe(false);

    ctl.fail = false; // 故障消失
    vi.setSystemTime(Date.now() + COOLDOWN_PLUS);
    await listTasksWithCorrupt(); // 后续调用触发后台重试
    await vi.waitFor(() => expect(runStatusOf("t_flaky_1")).toBe("error"));
    await waitSweepDone();

    expect(bootEventCount("t_flaky_1")).toBe(1);
    expect(bootEventCount("t_fine_1")).toBe(1); // 成功的没被重做
    expect(retryState()?.failed.size).toBe(0);
  });

  it("冷却期内不重试（避免列表每 2s 轮询一次就重试一次）", async () => {
    await writeMeta(baseMeta("t_flaky_2"));
    const ctl = failMetaReads("t_flaky_2");
    await listTasksWithCorrupt();
    expect(retryState()?.failed.has("t_flaky_2")).toBe(true);

    ctl.fail = false;
    vi.setSystemTime(Date.now() + 5_000); // 远不到 30s
    await listTasksWithCorrupt();
    await new Promise((r) => setTimeout(r, 60));
    expect(runStatusOf("t_flaky_2")).toBe("running");
    expect(retryState()?.failed.has("t_flaky_2")).toBe(true);
  });

  it("闸门：失败 id 的 meta 在本进程 boot 之后又被写过（run 已在本进程启动）→ 不当僵尸、不标 error，并移出失败表", async () => {
    await writeMeta(baseMeta("t_started_1"));
    const ctl = failMetaReads("t_started_1");
    await listTasksWithCorrupt();
    expect(retryState()?.failed.has("t_started_1")).toBe(true);

    ctl.fail = false;
    vi.setSystemTime(Date.now() + 10_000);
    // 用户在本进程里重新发起了一次 run：runStatus=running 且 updatedAt 是「现在」（> boot 时刻）
    await writeMeta(baseMeta("t_started_1", { updatedAt: Date.now() }));
    vi.setSystemTime(Date.now() + COOLDOWN_PLUS);
    await listTasksWithCorrupt();
    await vi.waitFor(() => expect(retryState()?.failed.has("t_started_1")).toBe(false));
    await waitSweepDone();

    expect(runStatusOf("t_started_1")).toBe("running"); // 没被误杀
    expect(bootEventCount("t_started_1")).toBe(0);
  });

  it("每个 id 最多再试 3 次：一直失败不会无限重试 / 刷日志", async () => {
    await writeMeta(baseMeta("t_dead_1"));
    failMetaReads("t_dead_1"); // 永远失败
    await listTasksWithCorrupt();

    for (let i = 0; i < RETRY_MAX + 3; i++) {
      vi.setSystemTime(Date.now() + COOLDOWN_PLUS);
      await listTasksWithCorrupt();
      await waitSweepDone();
    }
    const failWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("boot recovery: 读 meta 失败 id=t_dead_1"));
    // 首轮 1 次 + 重试 3 次
    expect(failWarns).toHaveLength(1 + RETRY_MAX);
    expect(retryState()?.failed.has("t_dead_1")).toBe(false); // 放弃后移出，不再占着
    expect(runStatusOf("t_dead_1")).toBe("running");
  });

  it("顶层 readdir(DATA_DIR) 失败：首轮整体没恢复；冷却期后重新列目录并恢复（只补没做成的）", async () => {
    await writeMeta(baseMeta("t_zombie_1"));
    const realReaddir = fs.readdir.bind(fs) as (...a: unknown[]) => Promise<unknown>;
    let failures = 2; // cleanupTombstonedTaskDirs 一次 + runBootRecovery 自己一次
    vi.spyOn(fs, "readdir").mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (String(p) === DATA_DIR && failures > 0) {
        failures -= 1;
        return Promise.reject(Object.assign(new Error("EBUSY: readdir"), { code: "EBUSY" }));
      }
      return realReaddir(p, ...rest);
    }) as unknown as typeof fs.readdir);

    await listTasksWithCorrupt();
    expect(failures).toBe(0);
    expect(runStatusOf("t_zombie_1")).toBe("running"); // 首轮没扫到
    expect(retryState()?.listFailed).toBe(true);

    vi.setSystemTime(Date.now() + COOLDOWN_PLUS);
    await listTasksWithCorrupt();
    await vi.waitFor(() => expect(runStatusOf("t_zombie_1")).toBe("error"));
    await waitSweepDone();
    expect(bootEventCount("t_zombie_1")).toBe(1);
    expect(retryState()?.listFailed).toBe(false);
  });

  it("没有失败时：不产生重试状态、后续调用零额外开销（RECOVERY_FLAG 契约不变：仍是同一个已完成的 promise）", async () => {
    await writeMeta(baseMeta("t_ok_1", { runStatus: "idle" }));
    await listTasksWithCorrupt();
    const first = g[RECOVERY_FLAG];
    expect(first).toBeInstanceOf(Promise);
    vi.setSystemTime(Date.now() + COOLDOWN_PLUS);
    await listTasksWithCorrupt();
    expect(g[RECOVERY_FLAG]).toBe(first);
    expect((retryState()?.failed.size ?? 0) === 0).toBe(true);
  });
});
