/**
 * preview-manager 并发与 pidfile 归属（CR-10）——真实 spawn 小进程做集成回归。
 *
 * 回归点（旧实现上会失败）：
 * - 同仓并发双 start：串行队列下后到顶掉先到、先到的进程被真正杀掉、不留孤儿
 * - 不同仓并行 start：两个都在跑、互不顶
 * - start + stop 并发：结果确定（先 start 后 stop）、最终无预览、pidfile 清空
 * - 被顶掉的旧进程迟到 exit 不清新进程的 pidfile（旧实现 exit 回调无条件清）
 * - killStalePreview 杀前核验 PID 归属：pidfile 记的命令跟实际进程对不上（PID
 *   被复用）时不发信号（旧实现盲杀）
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-preview-it-${Date.now()}`);
process.env.FE_AI_FLOW_DATA_DIR = TMP_ROOT;

import {
  getPreviewStatus,
  killStalePreview,
  startPreview,
  stopAllPreviews,
  stopPreview,
} from "@/lib/server/preview-manager";

const PID_FILE = path.join(TMP_ROOT, "preview.json");

const readPidFile = async (): Promise<
  | { pid: number; token?: string; command?: string; repoPath?: string }
  | Array<{ pid: number; token?: string; command?: string; repoPath?: string }>
  | null
> => {
  try {
    return JSON.parse(await fs.readFile(PID_FILE, "utf8"));
  } catch {
    return null;
  }
};

/** pidfile 现为数组；兼容测试里按 command 找记录 */
const pidRecords = async (): Promise<
  Array<{ pid: number; token?: string; command?: string; repoPath?: string }>
> => {
  const raw = await readPidFile();
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const input = (taskId: string, command: string, repoPath?: string) => ({
  taskId,
  taskTitle: `任务 ${taskId}`,
  repoPath: repoPath ?? `/repo/${taskId}`,
  workDir: TMP_ROOT,
  command,
});

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterEach(async () => {
  await stopAllPreviews();
});

describe("preview-manager（CR-10 / 按仓多位）", () => {
  it("同仓并发双 start：串行执行、最终 slot 是后到的、pidfile 归属后到进程", async () => {
    const repo = "/repo/same";
    const [r1, r2] = await Promise.all([
      startPreview(input("task-a", "sleep 30", repo)),
      startPreview(input("task-b", "sleep 31", repo)),
    ]);
    expect(r1.status.taskId).toBe("task-a");
    expect(r2.status.taskId).toBe("task-b");
    // 同仓单位：最终在跑的是 b
    const slots = getPreviewStatus();
    expect(slots).toHaveLength(1);
    expect(slots[0]?.taskId).toBe("task-b");
    const recs = await pidRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]?.command).toBe("sleep 31");
    expect(recs[0]?.token).toBeTruthy();
    // a 的进程组被真正停掉（不是孤儿）——等 TERM→KILL 兜底窗口
    await sleep(2500);
    const recsAfter = await pidRecords();
    expect(recsAfter).toHaveLength(1);
    expect(recsAfter[0]?.command).toBe("sleep 31");
    expect(isAlive(recsAfter[0]!.pid)).toBe(true);
  }, 15_000);

  it("两个不同 repoPath 并行 start → 两个都在跑、互不顶", async () => {
    const [r1, r2] = await Promise.all([
      startPreview(input("task-x", "sleep 30", "/repo/one")),
      startPreview(input("task-y", "sleep 31", "/repo/two")),
    ]);
    expect(r1.replacedTaskTitle).toBeNull();
    expect(r2.replacedTaskTitle).toBeNull();
    const slots = getPreviewStatus();
    expect(slots).toHaveLength(2);
    const ids = new Set(slots.map((s) => s.taskId));
    expect(ids.has("task-x")).toBe(true);
    expect(ids.has("task-y")).toBe(true);
    const recs = await pidRecords();
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => isAlive(r.pid))).toBe(true);
  }, 15_000);

  it("同 repoPath 二次 start → 顶掉第一个（别的任务时返回 replacedTaskTitle）", async () => {
    const repo = "/repo/bump";
    const first = await startPreview(input("task-old", "sleep 30", repo));
    expect(first.replacedTaskTitle).toBeNull();
    const second = await startPreview(input("task-new", "sleep 31", repo));
    expect(second.replacedTaskTitle).toBe("任务 task-old");
    const slots = getPreviewStatus();
    expect(slots).toHaveLength(1);
    expect(slots[0]?.taskId).toBe("task-new");
    await sleep(2500);
    const recs = await pidRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]?.command).toBe("sleep 31");
    expect(isAlive(recs[0]!.pid)).toBe(true);
  }, 15_000);

  it("start + stop 并发：顺序确定（先 start 后 stop）、最终无预览、pidfile 清空", async () => {
    const repo = "/repo/stop";
    await Promise.all([
      startPreview(input("task-c", "sleep 30", repo)),
      stopPreview(repo),
    ]);
    expect(getPreviewStatus()).toHaveLength(0);
    expect(await readPidFile()).toBeNull();
  }, 15_000);

  it("被顶掉的旧进程迟到 exit：不清新进程的 pidfile", async () => {
    const repo = "/repo/late-exit";
    // 第一个命令极快退出——被顶掉后其 exit 事件迟到触发
    await startPreview(input("task-d", "sleep 0.05", repo));
    await startPreview(input("task-e", "sleep 30", repo));
    // 等 d 的 exit 事件肯定触发过
    await sleep(2600);
    const recs = await pidRecords();
    // 旧实现：d 的 exit 回调无条件 clearPidFile → 这里读到空、测试失败
    expect(recs).toHaveLength(1);
    expect(recs[0]?.command).toBe("sleep 30");
    expect(getPreviewStatus()[0]?.taskId).toBe("task-e");
  }, 15_000);

  it("killStalePreview：pidfile 命令与实际进程不符（PID 复用）→ 不误杀、只清文件", async () => {
    // 起一个跟 pidfile 记录无关的「无辜进程」
    const decoy = spawn("sleep", ["30"], { stdio: "ignore" });
    const decoyPid = decoy.pid!;
    try {
      await fs.writeFile(
        PID_FILE,
        JSON.stringify([
          {
            pid: decoyPid,
            at: Date.now(),
            token: "tok",
            command: "npm run dev", // 与 decoy 实际命令（sleep 30）不符
            repoPath: "/repo/decoy",
          },
        ]),
      );
      await killStalePreview();
      // 旧实现盲发 SIGKILL、decoy 已死、本断言失败
      expect(isAlive(decoyPid)).toBe(true);
      expect(await readPidFile()).toBeNull();
    } finally {
      decoy.kill("SIGKILL");
    }
  }, 15_000);

  it("killStalePreview：命令匹配的残留进程照常杀掉（原有兜底语义不回归）", async () => {
    const stale = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    const stalePid = stale.pid!;
    stale.unref();
    await fs.writeFile(
      PID_FILE,
      JSON.stringify([
        {
          pid: stalePid,
          at: Date.now(),
          token: "tok",
          command: "sleep 30",
          repoPath: "/repo/stale",
        },
      ]),
    );
    await killStalePreview();
    await sleep(2500); // TERM→KILL 兜底窗口
    expect(isAlive(stalePid)).toBe(false);
    expect(await readPidFile()).toBeNull();
  }, 15_000);
});
