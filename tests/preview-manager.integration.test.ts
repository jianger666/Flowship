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
 *
 * R29-3 适配：spawn 前最终准入读盘 repoStatus——本文件无真实 task meta，
 * mock readTaskRepoStatusFresh 恒返 developing（断言不弱化、只补准入前置）。
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-preview-it-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

// R29-3：准入查盘——集成测无 meta，mock 成 developing 以保留原 spawn/pidfile 回归
vi.mock("@/lib/server/task-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-fs")>();
  return {
    ...actual,
    readTaskRepoStatusFresh: async () => "developing" as const,
  };
});

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

/** 进程组是否仍存在（与 product processGroupAlive 同语义；仅 ESRCH = 已空） */
const isProcessGroupAlive = (pid: number): boolean => {
  if (pid <= 0) return isAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return isAlive(pid);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询等待条件成立（替代固定 sleep，减轻高负载机器上的时序 flaky）。
 * 超时后返回 false，由调用方 assert 自然失败。
 */
const waitUntil = async (
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
};

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
    // a 被顶掉后 TERM→KILL；轮询等到 pidfile 仍归属后到进程（且进程存活）。
    // 这里轮询 kill(pid,0) 可靠：进程由 preview-manager 持有 ChildProcess、Node 会
    // reap，死后 ESRCH；与下方「命令匹配残留」fixture 自 spawn + unref 的 zombie 歧义不同。
    expect(
      await waitUntil(async () => {
        const recsAfter = await pidRecords();
        return (
          recsAfter.length === 1 &&
          recsAfter[0]?.command === "sleep 31" &&
          isAlive(recsAfter[0]!.pid)
        );
      }, 10_000),
    ).toBe(true);
    const recsAfter = await pidRecords();
    expect(recsAfter).toHaveLength(1);
    expect(recsAfter[0]?.command).toBe("sleep 31");
    expect(isAlive(recsAfter[0]!.pid)).toBe(true);
  }, 20_000);

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
    const oldPid = (await pidRecords())[0]?.pid;
    const second = await startPreview(input("task-new", "sleep 31", repo));
    expect(second.replacedTaskTitle).toBe("任务 task-old");
    const slots = getPreviewStatus();
    expect(slots).toHaveLength(1);
    expect(slots[0]?.taskId).toBe("task-new");
    // 轮询等到旧进程真正退出（TERM→KILL），再断言 pidfile 归属新进程。
    // product 持有 ChildProcess 句柄并 reap，kill(pid,0) 失败即已真正退出（无 zombie）。
    if (typeof oldPid === "number") {
      expect(await waitUntil(() => !isAlive(oldPid), 10_000)).toBe(true);
    }
    const recs = await pidRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]?.command).toBe("sleep 31");
    expect(isAlive(recs[0]!.pid)).toBe(true);
  }, 20_000);

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
    const dPid = (await pidRecords())[0]?.pid;
    await startPreview(input("task-e", "sleep 30", repo));
    // 等 d 进程真正退出（exit 事件肯定触发过），再断言新进程 pidfile 仍在。
    // product 内部 spawn 并监听 exit、会 reap；kill(pid,0) 轮询这里可靠（见 F3 对照用例）。
    if (typeof dPid === "number") {
      expect(await waitUntil(() => !isAlive(dPid), 10_000)).toBe(true);
    }
    const recs = await pidRecords();
    // 旧实现：d 的 exit 回调无条件 clearPidFile → 这里读到空、测试失败
    expect(recs).toHaveLength(1);
    expect(recs[0]?.command).toBe("sleep 30");
    expect(getPreviewStatus()[0]?.taskId).toBe("task-e");
  }, 20_000);

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

  it("killStalePreview：命令纯前缀命中（npm run develop ⊃ npm run dev）→ 不误杀", async () => {
    // PID 复用场景：无辜进程命令行含「npm run develop」，旧 includes 会误判为记录的「npm run dev」
    const decoy = spawn(
      "sh",
      ["-c", ": npm run develop; sleep 30"],
      { stdio: "ignore" },
    );
    const decoyPid = decoy.pid!;
    try {
      await fs.writeFile(
        PID_FILE,
        JSON.stringify([
          {
            pid: decoyPid,
            at: Date.now(),
            token: "tok",
            command: "npm run dev",
            repoPath: "/repo/prefix",
          },
        ]),
      );
      await killStalePreview();
      expect(isAlive(decoyPid)).toBe(true);
      expect(await readPidFile()).toBeNull();
    } finally {
      decoy.kill("SIGKILL");
    }
  }, 15_000);

  it("killStalePreview：命令匹配的残留进程照常杀掉（原有兜底语义不回归）", async () => {
    // 复审 F3：勿在断言前 unref——测试进程不 reap 时子进程会成 zombie，
    // process.kill(pid,0) 仍成功，把「已杀」误判为存活；纯延长 isAlive 轮询修不了。
    // 改挂 ChildProcess exit 事件：触发即内核已回收、无 zombie 歧义。
    const stale = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    const stalePid = stale.pid!;
    const staleExited = new Promise<boolean>((resolve) => {
      stale.once("exit", () => resolve(true));
    });
    // 与 exit 竞速：超时则 false；exit 先到时 clearTimeout，避免拖住 vitest
    const exitOrTimeout = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 10_000);
      void staleExited.then((ok) => {
        clearTimeout(t);
        resolve(ok);
      });
    });
    try {
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
      // exit 事件 = 已真正退出（强于 isAlive 轮询）；pidfile 清理由 waitUntil 兜底时序
      expect(await exitOrTimeout).toBe(true);
      expect(await waitUntil(async () => (await readPidFile()) === null, 10_000)).toBe(true);
      expect(await readPidFile()).toBeNull();
    } finally {
      // 保底：exit 未到则补杀，防孤儿占资源
      if (isAlive(stalePid)) {
        try {
          process.kill(stalePid, "SIGKILL");
        } catch {
          /* 已死 */
        }
      }
    }
  }, 20_000);

  // S5：shell:true + detached 时组长是 shell；TERM 后 shell 常先退，忽略 TERM 的
  // 子进程仍占组。旧实现只查组长 PID 会提前 return、跳过对 -pid 的 SIGKILL。
  // 必须 `& wait`：否则 sh -c 会 exec 掉唯一前台命令，组长即 node、复现不了「组长先退」。
  // 子进程用临时脚本（避免 node -e 嵌套引号）；并忽略 HUP（leader 退时可能收到）。
  // Windows 走 taskkill /T，无此路径；本用例仅 Unix。
  it.skipIf(process.platform === "win32")(
    "stop：组长 shell 先退、忽略 TERM 的子进程仍被进程组 SIGKILL 清掉",
    async () => {
      const repo = "/repo/orphan-pg";
      const childJs = path.join(TMP_ROOT, "orphan-ignore-term.js");
      await fs.writeFile(
        childJs,
        [
          "for (const s of ['SIGTERM','SIGHUP','SIGINT']) process.on(s, () => {});",
          "setInterval(() => {}, 1e9);",
        ].join("\n"),
      );
      const cmd = `node "${childJs}" & wait`;
      let leaderPid: number | undefined;
      try {
        await startPreview(input("task-orphan", cmd, repo));
        leaderPid = (await pidRecords())[0]?.pid;
        expect(typeof leaderPid).toBe("number");
        expect(isAlive(leaderPid!)).toBe(true);
        expect(isProcessGroupAlive(leaderPid!)).toBe(true);
        // 等子进程跑过 process.on（过早 TERM 会在 handler 装上前杀掉 node）
        await sleep(500);

        const t0 = Date.now();
        // stop → TERM 组：shell 先退、忽略 TERM 的 node 仍占组 → 超时后 SIGKILL
        await stopPreview(repo);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(1800);
        // SIGKILL 后短瞬可能残留 zombie，kill(-pid,0) 仍成功——等到组真正空
        expect(
          await waitUntil(() => !isProcessGroupAlive(leaderPid!), 5000),
        ).toBe(true);
      } finally {
        if (typeof leaderPid === "number" && isProcessGroupAlive(leaderPid)) {
          try {
            process.kill(-leaderPid, "SIGKILL");
          } catch {
            /* 已空 */
          }
        }
      }
    },
    20_000,
  );
});
