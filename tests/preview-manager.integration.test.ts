/**
 * preview-manager 并发与 pidfile 归属（CR-10）——真实 spawn 小进程做集成回归。
 *
 * 回归点（旧实现上会失败）：
 * - 并发双 start：串行队列下后到顶掉先到、先到的进程被真正杀掉、不留孤儿
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
  stopPreview,
} from "@/lib/server/preview-manager";

const PID_FILE = path.join(TMP_ROOT, "preview.json");

const readPidFile = async (): Promise<{
  pid: number;
  token?: string;
  command?: string;
} | null> => {
  try {
    return JSON.parse(await fs.readFile(PID_FILE, "utf8"));
  } catch {
    return null;
  }
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

const input = (taskId: string, command: string) => ({
  taskId,
  taskTitle: `任务 ${taskId}`,
  repoPath: `/repo/${taskId}`,
  workDir: TMP_ROOT,
  command,
});

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterEach(async () => {
  await stopPreview();
});

describe("preview-manager（CR-10）", () => {
  it("并发双 start：串行执行、最终 slot 是后到的、pidfile 归属后到进程", async () => {
    const [r1, r2] = await Promise.all([
      startPreview(input("task-a", "sleep 30")),
      startPreview(input("task-b", "sleep 31")),
    ]);
    expect(r1.status.taskId).toBe("task-a");
    expect(r2.status.taskId).toBe("task-b");
    // 单预览位：最终在跑的是 b、pidfile 也是 b 的
    expect(getPreviewStatus()?.taskId).toBe("task-b");
    const rec = await readPidFile();
    expect(rec?.command).toBe("sleep 31");
    expect(rec?.token).toBeTruthy();
    // a 的进程组被真正停掉（不是孤儿）——等 TERM→KILL 兜底窗口
    await sleep(2500);
    const recAfter = await readPidFile();
    expect(recAfter?.command).toBe("sleep 31");
    expect(isAlive(recAfter!.pid)).toBe(true);
  }, 15_000);

  it("start + stop 并发：顺序确定（先 start 后 stop）、最终无预览、pidfile 清空", async () => {
    await Promise.all([
      startPreview(input("task-c", "sleep 30")),
      stopPreview(),
    ]);
    expect(getPreviewStatus()).toBeNull();
    expect(await readPidFile()).toBeNull();
  }, 15_000);

  it("被顶掉的旧进程迟到 exit：不清新进程的 pidfile", async () => {
    // 第一个命令极快退出——被顶掉后其 exit 事件迟到触发
    await startPreview(input("task-d", "sleep 0.05"));
    await startPreview(input("task-e", "sleep 30"));
    // 等 d 的 exit 事件肯定触发过
    await sleep(2600);
    const rec = await readPidFile();
    // 旧实现：d 的 exit 回调无条件 clearPidFile → 这里读到 null、测试失败
    expect(rec?.command).toBe("sleep 30");
    expect(getPreviewStatus()?.taskId).toBe("task-e");
  }, 15_000);

  it("killStalePreview：pidfile 命令与实际进程不符（PID 复用）→ 不误杀、只清文件", async () => {
    // 起一个跟 pidfile 记录无关的「无辜进程」
    const decoy = spawn("sleep", ["30"], { stdio: "ignore" });
    const decoyPid = decoy.pid!;
    try {
      await fs.writeFile(
        PID_FILE,
        JSON.stringify({
          pid: decoyPid,
          at: Date.now(),
          token: "tok",
          command: "npm run dev", // 与 decoy 实际命令（sleep 30）不符
        }),
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
      JSON.stringify({ pid: stalePid, at: Date.now(), token: "tok", command: "sleep 30" }),
    );
    await killStalePreview();
    await sleep(2500); // TERM→KILL 兜底窗口
    expect(isAlive(stalePid)).toBe(false);
    expect(await readPidFile()).toBeNull();
  }, 15_000);
});
