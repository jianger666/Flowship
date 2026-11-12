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
 * - 2026-11-12「重启 Flowship 后 dev server 没关、再启动端口 +1」：`yarn custom` 经 sh exec 成
 *   `node /…/bin/yarn custom`，旧的词边界子串核验对不上 → 被当成「PID 被复用」只清记录不杀进程。
 *   见文末 describe「重启后残留 dev server 必须被清掉」（真实 spawn + 模拟 server 重启）。
 *
 * R29-3 适配：spawn 前最终准入读盘 repoStatus——本文件无真实 task meta，
 * mock readTaskRepoStatusFresh 恒返 developing（断言不弱化、只补准入前置）。
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

import { stopAllManagedChildren } from "@/lib/server/kill-orphans";
import {
  __setPreviewProbeExecForTest,
  fingerprintsMatch,
  getPreviewStatus,
  getProcessStartFingerprint,
  isRecordFromBeforeBoot,
  killStalePreview,
  pidLooksOurs,
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
  Array<{ pid: number; token?: string; command?: string; repoPath?: string; startedFp?: string }>
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

describe("server 退出钩子停全部预览（评审 R1-9）", () => {
  it("stopAllManagedChildren（SIGTERM 退出钩子走的入口）会把在跑的 preview dev server 整组停掉", async () => {
    const { status } = await startPreview(input("task-exit", "sleep 60", "/repo/exit-hook"));
    expect(status.exited).toBe(false);
    const rec = (await pidRecords()).find((r) => r.command === "sleep 60");
    expect(rec?.pid).toBeTruthy();
    const pid = rec!.pid;
    expect(isProcessGroupAlive(pid)).toBe(true);

    await stopAllManagedChildren();

    expect(await waitUntil(() => !isProcessGroupAlive(pid), 5000)).toBe(true);
    expect(getPreviewStatus().filter((s) => !s.exited)).toHaveLength(0);
  });
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
            // 归属核验（R15-12）要求进程 cwd 落在该预览的目录之下：sleep 继承的是测试进程的 cwd
            workDir: process.cwd(),
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

/**
 * Q13-09：dev server 输出里带 ANSI 转义时，访问地址照样探得到、日志尾巴是干净的。
 *
 * 真实来源：`buildPreviewEnv` 设了 FORCE_COLOR=0，但 picocolors（vite）判断的是 `!!env.FORCE_COLOR`，"0" 是真值，
 * 反而上色，端口被 ESC 码夹在 `localhost:` 后面——旧实现的 URL_RE 要求 `localhost:` 紧跟数字，探不到，预览一直显示「无地址」。
 * 下面的子进程不依赖任何真实 dev server，直接打印那种形态后常驻。
 */
describe("preview-manager：输出里的 ANSI 转义（Q13-09）", () => {
  const ESC = "\u001b";

  const writeChild = async (name: string, lines: string[]): Promise<string> => {
    const file = path.join(TMP_ROOT, name);
    await fs.writeFile(file, lines.join("\n"), "utf8");
    return file;
  };

  const urlOf = (repo: string): string | null =>
    getPreviewStatus().find((s) => s.repoPath === repo)?.url ?? null;

  it("vite 形态（端口单独加粗、前面还有一行带清行码的日志）→ 探到干净的 URL，logTail 里没有 ESC", async () => {
    const repo = "/repo/ansi-vite";
    const child = await writeChild("ansi-vite.js", [
      'const E = String.fromCharCode(27);',
      'console.log(E + "[2K" + E + "[1Gcompiling" + E + "[0m");',
      // 整行只有转义码（清行）：剥完是空行，不该在日志里留一条空串
      'console.log(E + "[2K");',
      // 第二行隔一会儿才来：探测不能只看第一个输出块
      'setTimeout(() => console.log("  " + E + "[32m➜" + E + "[39m  " + E + "[1mLocal" + E + "[22m:   " + E + "[36mhttp://localhost:" + E + "[1m5173" + E + "[22m/" + E + "[39m"), 150);',
      "setInterval(() => {}, 1e9);",
    ]);
    await startPreview(input("task-ansi-vite", `node "${child}"`, repo));
    expect(await waitUntil(() => urlOf(repo) !== null, 10_000)).toBe(true);
    expect(urlOf(repo)).toBe("http://localhost:5173/");
    const tail = getPreviewStatus().find((s) => s.repoPath === repo)!.logTail;
    expect(tail.join("\n")).not.toContain(ESC);
    expect(tail.join("\n")).toContain("compiling");
    expect(tail).not.toContain("");
    expect(tail.join("\n")).toContain("Local:");
  }, 20_000);

  it("整段 URL 上色 + 监听地址 0.0.0.0：尾部的 ESC[39m 不进地址，0.0.0.0 仍换成 localhost", async () => {
    const repo = "/repo/ansi-whole";
    const child = await writeChild("ansi-whole.js", [
      'const E = String.fromCharCode(27);',
      'console.log(E + "[36mhttp://0.0.0.0:3000/" + E + "[39m");',
      "setInterval(() => {}, 1e9);",
    ]);
    await startPreview(input("task-ansi-whole", `node "${child}"`, repo));
    expect(await waitUntil(() => urlOf(repo) !== null, 10_000)).toBe(true);
    expect(urlOf(repo)).toBe("http://localhost:3000/");
  }, 20_000);

  it("对照：不带 ANSI 的普通输出照常探到（没有被剥离逻辑弄坏）", async () => {
    const repo = "/repo/ansi-plain";
    const child = await writeChild("ansi-plain.js", [
      'console.log("  Local:   http://127.0.0.1:4321/docs");',
      "setInterval(() => {}, 1e9);",
    ]);
    await startPreview(input("task-ansi-plain", `node "${child}"`, repo));
    expect(await waitUntil(() => urlOf(repo) !== null, 10_000)).toBe(true);
    expect(urlOf(repo)).toBe("http://127.0.0.1:4321/docs");
  }, 20_000);
});


/**
 * 2026-11-12：重启 Flowship 后 dev server 没关、再启动端口 +1。
 *
 * 根因（实测复现）：用户的预览命令是 `yarn custom` / `yarn local` / `yarn dev`。`spawn(cmd, {shell:true})` 起的
 * `sh -c "yarn custom"` 会被 sh 直接 exec 成命令本体，ps 里是 `node /Users/x/.nvm/…/bin/yarn custom`——
 * 命令名前面是 `/`。旧的归属核验（pidLooksOurs）要求命中处前面是空白或 `-c `，于是判成「PID 被复用」→ 只清 pidfile 记录、
 * **不发信号**，残留的 dev server 一直占着端口，下次启动 umi / next 自动换 +1 端口。
 *
 * 修复：① 主判据换成启动时间指纹（`ps -o lstart=`，spawn 后写进 pidfile）；② 命令行退路补上「带路径的可执行文件」形态；
 * ③ 组长已退、组里还有成员时按组清理；④ 组长自己退出时同组残留成员当场清掉。
 * 下面用真实进程回放：先真起（经 PATH 解析的假 yarn、sh exec 形态），再「丢掉内存态 = 模拟 server 重启」，最后核验 killStalePreview。
 */
describe("重启后残留 dev server 必须被清掉（2026-11-12 端口 +1）", () => {
  const SLOTS_KEY = "__flowshipPreviewSlotsV2__";
  const BIN_DIR = path.join(TMP_ROOT, "fake-bin");
  const FAKE_YARN = path.join(BIN_DIR, "fakeyarn");

  const dropInMemoryState = (): void => {
    // 模拟 server 进程重启：内存里的 slot 表没了，OS 进程和 pidfile 还在
    delete (globalThis as Record<string, unknown>)[SLOTS_KEY];
  };

  const psCommandOf = (pid: number): string => {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };

  let oldPath: string | undefined;
  beforeAll(async () => {
    await fs.mkdir(BIN_DIR, { recursive: true });
    await fs.writeFile(
      FAKE_YARN,
      "#!/usr/bin/env node\nsetInterval(() => {}, 1e9);\n",
      { mode: 0o755 },
    );
    oldPath = process.env.PATH;
    process.env.PATH = `${BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}`;
  });
  afterAll(() => {
    process.env.PATH = oldPath;
  });
  // 本组用例里真起过的进程组组长 pid：killStalePreview 会先清 pidfile 记录，用例失败时（比如修复被回退）
  // 只靠 pidfile 兜底会漏掉残留进程——这里按 pid 另记一份，afterEach 无条件 SIGKILL，别把进程留在测试机上
  const startedPids = new Set<number>();
  const startTracked = async (...args: Parameters<typeof startPreview>) => {
    const res = await startPreview(...args);
    for (const r of await pidRecords()) startedPids.add(r.pid);
    return res;
  };
  afterEach(async () => {
    for (const r of await pidRecords()) startedPids.add(r.pid);
    for (const pid of startedPids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* 已死 */
      }
    }
    startedPids.clear();
    await fs.rm(PID_FILE, { force: true });
  });

  describe("pidLooksOurs（命令行退路）", () => {
    it.skipIf(process.platform === "win32").each([
      // [ps 命令行, 记录的命令, 期望]
      ["node /Users/x/.nvm/versions/node/v22/bin/yarn custom", "yarn custom", true], // 事故原形：sh exec 成带路径的可执行文件
      ["node /Users/x/.nvm/versions/node/v22/bin/pnpm dev", "pnpm dev", true],
      ["/usr/local/bin/node /app/server.js", "node server.js", false], // 路径不同 token 不连续（/app/server.js ≠ server.js）
      ["/bin/sh -c yarn custom", "yarn custom", true], // sh -c 整条命令形态（旧行为不回归）
      ["/bin/sh -c cd /a && yarn dev && echo", "yarn dev", true],
      ["node /x/bin/yarn custom:v2", "yarn custom", false], // 词边界：custom:v2 ≠ custom
      ["node /x/bin/yarn customize", "yarn custom", false],
      ["node /x/bin/yarn", "yarn custom", false],
      ["/bin/sh -c : npm run develop; sleep 30", "npm run dev", false], // 既有回归：纯前缀不得命中
      ["sleep 30", "npm run dev", false],
    ])("%s ⟷ 「%s」→ %s", (ps, rec, expected) => {
      expect(pidLooksOurs(ps as string, rec as string)).toBe(expected);
    });
  });

  it.skipIf(process.platform === "win32")(
    "【事故回放】fakeyarn（sh exec 形态）：丢掉内存态后 killStalePreview 把残留进程杀掉、pidfile 清空",
    async () => {
      const repo = "/repo/yarn-restart";
      await startTracked(input("task-yarn", "fakeyarn custom", repo));
      const rec = (await pidRecords()).find((r) => r.repoPath === repo) as
        | { pid: number; startedFp?: string }
        | undefined;
      expect(rec?.pid).toBeTruthy();
      const pid = rec!.pid;
      // 前提自检：确实是事故里的形态（sh 已 exec 成命令本体、命令名带路径）——不是这个形态这条回放就没意义
      const ps = psCommandOf(pid);
      expect(ps).toContain("fakeyarn custom");
      expect(ps).toMatch(/\/fakeyarn custom$/);
      // 新记录带启动时间指纹
      expect(rec!.startedFp).toBeTruthy();
      expect(rec!.startedFp).toBe(await getProcessStartFingerprint(pid));

      dropInMemoryState();
      expect(isAlive(pid)).toBe(true);
      await killStalePreview();

      expect(await waitUntil(() => !isProcessGroupAlive(pid), 8000)).toBe(true);
      expect(await readPidFile()).toBeNull();
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "旧版 pidfile（没有指纹）：靠命令行退路照样杀得掉 fakeyarn 形态",
    async () => {
      const repo = "/repo/yarn-legacy";
      await startTracked(input("task-yarn-legacy", "fakeyarn custom", repo));
      const recs = await pidRecords();
      const pid = recs.find((r) => r.repoPath === repo)!.pid;
      // 退回旧格式：抹掉指纹字段
      await fs.writeFile(
        PID_FILE,
        JSON.stringify(recs.map((r) => ({ ...r, startedFp: undefined }))),
      );
      dropInMemoryState();

      await killStalePreview();
      expect(await waitUntil(() => !isProcessGroupAlive(pid), 8000)).toBe(true);
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "指纹是主判据：命令行对得上、但启动时间对不上（PID 复用）→ 不误杀",
    async () => {
      const decoy = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
      const decoyPid = decoy.pid!;
      try {
        await fs.writeFile(
          PID_FILE,
          JSON.stringify([
            {
              pid: decoyPid,
              at: Date.now(),
              token: "tok",
              command: "sleep 30", // 命令行与 decoy 完全一致……
              repoPath: "/repo/fp-mismatch",
              startedFp: "Mon Jan  1 00:00:00 2001", // ……但启动时间对不上 = 不是当初那个进程
            },
          ]),
        );
        await killStalePreview();
        expect(isAlive(decoyPid)).toBe(true);
        expect(await readPidFile()).toBeNull();
      } finally {
        decoy.kill("SIGKILL");
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "组长已退出、进程组里还有成员（yarn 先退、worker 继续占端口）→ killStalePreview 按组清掉",
    async () => {
      // sh 起一个后台 sleep 后立刻退出：sh（组长）没了，sleep 仍在同一进程组
      // cwd 放在记录的 workDir 下：「组长已退、组还在」要靠成员 cwd 证明归属才按组杀（R15-04）
      const leader = spawn("sh", ["-c", "sleep 60 & exit 0"], { stdio: "ignore", detached: true, cwd: TMP_ROOT });
      const leaderPid = leader.pid!;
      await new Promise<void>((resolve) => leader.once("exit", () => resolve()));
      try {
        expect(isAlive(leaderPid)).toBe(false); // 组长确实没了
        expect(isProcessGroupAlive(leaderPid)).toBe(true); // 组还在（sleep）
        await fs.writeFile(
          PID_FILE,
          JSON.stringify([
            {
              pid: leaderPid,
              at: Date.now(),
              token: "tok",
              command: "yarn custom",
              repoPath: "/repo/orphan-group",
              workDir: TMP_ROOT,
              startedFp: "Thu Nov 12 08:44:21 2026",
            },
          ]),
        );
        await killStalePreview();
        expect(await waitUntil(() => !isProcessGroupAlive(leaderPid), 8000)).toBe(true);
        expect(await readPidFile()).toBeNull();
      } finally {
        try {
          process.kill(-leaderPid, "SIGKILL");
        } catch {
          /* 已清 */
        }
      }
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "组长自己先退出（命令把 worker 丢后台就走）→ 同组残留成员当场清掉，不留无人跟踪的孤儿",
    async () => {
      const repo = "/repo/leader-exits";
      const bgPidFile = path.join(TMP_ROOT, "bg.pid");
      await fs.rm(bgPidFile, { force: true });
      // 后台 sleep 把自己的 pid 写文件；sh 马上 exit
      await startTracked(input("task-leader-exit", `sleep 300 & echo $! > "${bgPidFile}"; exit 0`, repo));
      expect(await waitUntil(async () => fs.access(bgPidFile).then(() => true, () => false), 5000)).toBe(true);
      const bgPid = Number((await fs.readFile(bgPidFile, "utf8")).trim());
      expect(Number.isInteger(bgPid) && bgPid > 1).toBe(true);
      try {
        // 主进程退出 → slot 标 exited；同组的 sleep 被清掉
        expect(await waitUntil(() => getPreviewStatus().find((s) => s.repoPath === repo)?.exited === true, 5000)).toBe(true);
        expect(await waitUntil(() => !isAlive(bgPid), 8000)).toBe(true);
        expect(getPreviewStatus().find((s) => s.repoPath === repo)!.logTail.join("\n")).toContain("已一并清理");
        // 跟踪记录也清了（不会留下指向已死进程组的 pidfile）
        expect(await waitUntil(async () => (await pidRecords()).length === 0, 5000)).toBe(true);
      } finally {
        try {
          process.kill(bgPid, "SIGKILL");
        } catch {
          /* 已清 */
        }
      }
    },
    25_000,
  );

  it.skipIf(process.platform === "win32")(
    "多仓依次启动：后写的记录不会把先写的记录的指纹丢掉（读改写保留字段）",
    async () => {
      await startTracked(input("task-m1", "fakeyarn custom", "/repo/m1"));
      await startTracked(input("task-m2", "fakeyarn local", "/repo/m2"));
      const recs = (await pidRecords()) as Array<{ repoPath?: string; startedFp?: string }>;
      expect(recs).toHaveLength(2);
      for (const r of recs) expect(r.startedFp, `${r.repoPath} 的指纹`).toBeTruthy();
    },
    20_000,
  );

  /**
   * 评审 R15（R15-04 / 05 / 10 / 12 / 22）：任何会发信号的路径都要有归属证据，拿不到就只清记录。
   * 下面的用例分两类——「不得误杀」的负例（每个都带一条「去掉障碍后确实会杀」的对照，证明负例不是因为别的原因没杀）、
   * 以及「真重启」回放（旧 server 进程整个消失，不是只丢内存 Map）。
   */
  describe("归属证据（R15）", () => {
    const unrelatedDir = path.join(os.tmpdir(), `fe-preview-unrelated-${Date.now()}`);
    const realExec = promisify(execFile);
    beforeAll(async () => {
      await fs.mkdir(unrelatedDir, { recursive: true });
    });
    afterAll(async () => {
      await fs.rm(unrelatedDir, { recursive: true, force: true });
    });
    afterEach(() => {
      __setPreviewProbeExecForTest(null);
    });

    const decoys: Array<{ pid: number; kill: () => void }> = [];
    afterEach(() => {
      for (const d of decoys.splice(0)) d.kill();
    });
    /** 自成进程组的 `sleep 30`（命令行 / 启动时间都可以被记录对上，用来扮演「PID 被复用 / 或真残留」的进程） */
    const spawnDecoy = (cwd: string): number => {
      const c = spawn("sleep", ["30"], { stdio: "ignore", detached: true, cwd });
      const pid = c.pid!;
      decoys.push({
        pid,
        kill: () => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* 已死 */
          }
        },
      });
      return pid;
    };
    const writeRecord = async (rec: Record<string, unknown>): Promise<void> => {
      await fs.writeFile(PID_FILE, JSON.stringify([{ token: "tok", command: "sleep 30", repoPath: "/repo/r15", ...rec }]));
    };

    describe("纯逻辑", () => {
      it.each<[string, string, string, boolean]>([
        ["完全相同", "Thu Nov 12 08:44:21 2026", "Thu Nov 12 08:44:21 2026", true],
        ["相差 1 秒（Linux 上 NTP 校时漂移）", "Thu Nov 12 08:44:21 2026", "Thu Nov 12 08:44:22 2026", true],
        ["相差恰好 2 秒（容差边界）", "Thu Nov 12 08:44:21 2026", "Thu Nov 12 08:44:23 2026", true],
        ["相差 3 秒", "Thu Nov 12 08:44:21 2026", "Thu Nov 12 08:44:24 2026", false],
        ["差一整天（PID 复用）", "Thu Nov 12 08:44:21 2026", "Fri Nov 13 08:44:21 2026", false],
        ["Windows ISO：相同", "2026-11-12T02:09:48.1234567Z", "2026-11-12T02:09:48.1234567Z", true],
        ["Windows ISO：差一分钟", "2026-11-12T02:09:48.0000000Z", "2026-11-12T02:10:48.0000000Z", false],
        ["解析不了且不相等 → 不匹配（宁可漏杀）", "garbage", "Thu Nov 12 08:44:21 2026", false],
        ["两边都解析不了但字符串相等 → 匹配", "garbage", "garbage", true],
      ])("fingerprintsMatch：%s", (_name, a, b, expected) => {
        expect(fingerprintsMatch(a, b)).toBe(expected);
      });

      const NOW = Date.UTC(2026, 10, 12, 10, 0, 0);
      const UP = 3 * 3600; // 开机 3 小时
      it.each<[string, number | undefined, boolean]>([
        ["开机之前很久写的（昨天）", NOW - 24 * 3600_000, true],
        ["开机前 10 分钟写的", NOW - UP * 1000 - 10 * 60_000, true],
        ["开机前 30 秒写的（在余量内，不算开机前）", NOW - UP * 1000 - 30_000, false],
        ["开机后写的（1 小时前）", NOW - 3600_000, false],
        ["刚写的", NOW, false],
        ["没有 at（旧格式）→ 判不了，不算", undefined, false],
        ["at 是 NaN → 不算", Number.NaN, false],
      ])("isRecordFromBeforeBoot：%s", (_name, at, expected) => {
        expect(isRecordFromBeforeBoot(at, NOW, UP)).toBe(expected);
      });

      it("Windows 指纹（R15-05）：走 PowerShell 的 StartTime（UTC ISO）、带 timeout；pid 不是正整数时不拼命令；PowerShell 失败 → null", async () => {
        // 本机不是 Windows：临时把 process.platform 伪装成 win32，探测命令由注入的执行器接住（不会真跑）
        const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
        Object.defineProperty(process, "platform", { value: "win32" });
        try {
          const calls: Array<{ file: string; args: string[]; timeout: number | undefined }> = [];
          __setPreviewProbeExecForTest((file, args, opts) => {
            calls.push({ file, args, timeout: opts?.timeout });
            return Promise.resolve({ stdout: "2026-11-12T02:09:48.1234567Z\r\n" });
          });
          expect(await getProcessStartFingerprint(1234)).toBe("2026-11-12T02:09:48.1234567Z");
          expect(calls).toHaveLength(1);
          expect(calls[0].file).toBe("powershell.exe");
          expect(calls[0].args).toContain("-NoProfile");
          expect(calls[0].args.join(" ")).toContain(
            "(Get-Process -Id 1234).StartTime.ToUniversalTime().ToString('o')",
          );
          expect(calls[0].timeout).toBeGreaterThan(0);

          // 非正整数 pid：根本不发命令（防止把奇怪的值拼进 PowerShell 表达式）
          for (const bad of [Number.NaN, 12.5, 0, -3]) {
            expect(await getProcessStartFingerprint(bad)).toBeNull();
          }
          expect(calls).toHaveLength(1);

          __setPreviewProbeExecForTest(() => Promise.reject(new Error("powershell: not found")));
          expect(await getProcessStartFingerprint(1234)).toBeNull();
        } finally {
          Object.defineProperty(process, "platform", orig);
        }
      });

      it.skipIf(process.platform === "win32").each([
        // [ps 命令行, 记录的命令, 期望]
        ["node /x/bin/yarn dev", "PORT=3000 yarn dev", true], // 环境变量前缀：sh 设进环境后 exec，ps 里看不到
        ["node /x/bin/yarn dev:local", "FOO=1 BAR=2 yarn dev", false], // 前缀不改变词边界规则
        ["node /x/bin/yarn dev", "FOO=1 BAR=2", false], // 只有环境变量、没有命令 → 不匹配
        ["make", "make", true], // 单 token
        ["/usr/bin/make", "make", true],
        ["/usr/bin/cmake", "make", false], // basename 必须整段相等
        ["node /opt/my app/yarn dev", '"/opt/my app/yarn" dev', false], // 带引号 / 含空格路径：不支持、按「不是」处理（宁可漏杀）
      ])("pidLooksOurs（R15）：%s ⟷ 「%s」→ %s", (ps, rec, expected) => {
        expect(pidLooksOurs(ps as string, rec as string)).toBe(expected);
      });
    });

    it.skipIf(process.platform === "win32")(
      "记录写于开机之前 → 即便命令行、指纹、cwd 全对得上也不发信号（只清记录）；对照：同一条记录写成『刚写的』就会杀",
      async () => {
        const pid = spawnDecoy(TMP_ROOT);
        const fp = await getProcessStartFingerprint(pid);
        expect(fp).toBeTruthy();
        await writeRecord({ pid, at: 1_000, workDir: TMP_ROOT, startedFp: fp });
        await killStalePreview();
        expect(isAlive(pid)).toBe(true); // 没杀
        expect(await readPidFile()).toBeNull(); // 记录清了

        // 对照：去掉「开机前」这个障碍，其余完全一样 → 杀掉（证明上面不是因为别的原因没杀）
        await writeRecord({ pid, at: Date.now(), workDir: TMP_ROOT, startedFp: fp });
        await killStalePreview();
        expect(await waitUntil(() => !isProcessGroupAlive(pid), 8000)).toBe(true);
      },
      25_000,
    );

    it.skipIf(process.platform === "win32")(
      "ps 自己失败（EAGAIN）不当成『进程不存在』/ 不据此发信号；对照：ps 恢复后同一条记录会杀",
      async () => {
        const pid = spawnDecoy(TMP_ROOT);
        const fp = await getProcessStartFingerprint(pid);
        await writeRecord({ pid, at: Date.now(), workDir: TMP_ROOT, startedFp: fp });
        // 只让「查命令行」的 ps 失败（其余探测照常）：模拟 EAGAIN / EMFILE 之类的瞬时故障
        __setPreviewProbeExecForTest((file, args, opts) =>
          file === "ps" && args.includes("command=")
            ? Promise.reject(Object.assign(new Error("spawn ps EAGAIN"), { code: "EAGAIN" }))
            : realExec(file, args, opts).then((r) => ({ stdout: String(r.stdout) })),
        );
        await killStalePreview();
        expect(isAlive(pid)).toBe(true);
        // 评审 R16-07 a：这次没能核验（瞬时故障）→ 记录保留、下次再试，不能一清了之（清了就永远没有第二次机会）
        expect((await pidRecords()).map((r) => r.pid)).toEqual([pid]);

        // ps 恢复：不用重写记录——保留下来的那条这次就把它杀掉
        __setPreviewProbeExecForTest(null);
        await killStalePreview();
        expect(await waitUntil(() => !isProcessGroupAlive(pid), 8000)).toBe(true);
        expect(await readPidFile()).toBeNull();
      },
      25_000,
    );

    it.skipIf(process.platform === "win32")(
      "组长已退、组还在，但成员的 cwd 不在该预览的目录下（PID 被无关进程复用后留下的组）→ 不杀；对照：cwd 在目录下就杀",
      async () => {
        const spawnOrphanGroup = async (cwd: string): Promise<number> => {
          const leader = spawn("sh", ["-c", "sleep 30 & exit 0"], { stdio: "ignore", detached: true, cwd });
          const leaderPid = leader.pid!;
          decoys.push({
            pid: leaderPid,
            kill: () => {
              try {
                process.kill(-leaderPid, "SIGKILL");
              } catch {
                /* 已死 */
              }
            },
          });
          await new Promise<void>((resolve) => leader.once("exit", () => resolve()));
          expect(isAlive(leaderPid)).toBe(false);
          expect(isProcessGroupAlive(leaderPid)).toBe(true);
          return leaderPid;
        };

        const stranger = await spawnOrphanGroup(unrelatedDir); // cwd = 与记录无关的目录
        await writeRecord({ pid: stranger, at: Date.now(), workDir: TMP_ROOT, repoPath: "/repo/r15-a" });
        await killStalePreview();
        expect(isProcessGroupAlive(stranger)).toBe(true); // 没杀
        expect(await readPidFile()).toBeNull();

        const ours = await spawnOrphanGroup(TMP_ROOT); // cwd = 记录的 workDir
        await writeRecord({ pid: ours, at: Date.now(), workDir: TMP_ROOT, repoPath: "/repo/r15-b" });
        await killStalePreview();
        expect(await waitUntil(() => !isProcessGroupAlive(ours), 8000)).toBe(true);
      },
      30_000,
    );

    it.skipIf(process.platform === "win32")(
      "组长已退、组还在 + ps 探测失败 → 不当成『进程不存在』去杀组",
      async () => {
        const leader = spawn("sh", ["-c", "sleep 30 & exit 0"], { stdio: "ignore", detached: true, cwd: TMP_ROOT });
        const leaderPid = leader.pid!;
        decoys.push({
          pid: leaderPid,
          kill: () => {
            try {
              process.kill(-leaderPid, "SIGKILL");
            } catch {
              /* 已死 */
            }
          },
        });
        await new Promise<void>((resolve) => leader.once("exit", () => resolve()));
        expect(isProcessGroupAlive(leaderPid)).toBe(true);
        await writeRecord({ pid: leaderPid, at: Date.now(), workDir: TMP_ROOT });
        __setPreviewProbeExecForTest((file, args, opts) =>
          file === "ps" && args.includes("command=")
            ? Promise.reject(Object.assign(new Error("spawn ps EMFILE"), { code: "EMFILE" }))
            : realExec(file, args, opts).then((r) => ({ stdout: String(r.stdout) })),
        );
        await killStalePreview();
        expect(isProcessGroupAlive(leaderPid)).toBe(true);
      },
      20_000,
    );

    it.skipIf(process.platform === "win32")(
      "旧记录（无指纹）命令行对得上、但进程 cwd 不在该预览目录下（别处同名命令）→ 不杀；对照：cwd 在目录下就杀",
      async () => {
        const stranger = spawnDecoy(unrelatedDir);
        await writeRecord({ pid: stranger, at: Date.now(), workDir: TMP_ROOT, repoPath: "/repo/r15-c" });
        await killStalePreview();
        expect(isAlive(stranger)).toBe(true);

        const ours = spawnDecoy(TMP_ROOT);
        await writeRecord({ pid: ours, at: Date.now(), workDir: TMP_ROOT, repoPath: "/repo/r15-d" });
        await killStalePreview();
        expect(await waitUntil(() => !isProcessGroupAlive(ours), 8000)).toBe(true);
      },
      25_000,
    );

    it.skipIf(process.platform === "win32")(
      "指纹容差：记录的指纹与现在差 1 秒（NTP 漂移）仍判同一个进程 → 杀",
      async () => {
        const pid = spawnDecoy(TMP_ROOT);
        const fp = (await getProcessStartFingerprint(pid))!;
        // 把真实指纹平移 1 秒、再格式化回 lstart 形态
        const d = new Date(Date.parse(`${fp} UTC`) + 1000);
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const pad = (n: number) => String(n).padStart(2, "0");
        const lstart = `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
        expect(lstart).not.toBe(fp);
        await writeRecord({ pid, at: Date.now(), workDir: TMP_ROOT, startedFp: lstart });
        await killStalePreview();
        expect(await waitUntil(() => !isProcessGroupAlive(pid), 8000)).toBe(true);
      },
      20_000,
    );

    it.skipIf(process.platform === "win32")(
      "不受 TZ 影响：换一个时区取指纹得到同一个串（R15-10）",
      async () => {
        const pid = spawnDecoy(TMP_ROOT);
        const a = await getProcessStartFingerprint(pid);
        const oldTz = process.env.TZ;
        try {
          process.env.TZ = "Pacific/Auckland";
          const b = await getProcessStartFingerprint(pid);
          process.env.TZ = "America/Los_Angeles";
          const c = await getProcessStartFingerprint(pid);
          expect(a).toBeTruthy();
          expect(b).toBe(a);
          expect(c).toBe(a);
        } finally {
          if (oldTz === undefined) delete process.env.TZ;
          else process.env.TZ = oldTz;
        }
      },
      15_000,
    );

    it.skipIf(process.platform === "win32")(
      "ps 卡住 / 超时：探测带 timeout 参数（不会无限期拖住全局串行队列，R15-11）",
      async () => {
        const seen: Array<{ file: string; timeout: number | undefined }> = [];
        __setPreviewProbeExecForTest((file, args, opts) => {
          seen.push({ file, timeout: opts?.timeout });
          return realExec(file, args, opts).then((r) => ({ stdout: String(r.stdout) }));
        });
        const pid = spawnDecoy(TMP_ROOT);
        await getProcessStartFingerprint(pid);
        await writeRecord({ pid, at: Date.now(), workDir: TMP_ROOT });
        await killStalePreview();
        expect(seen.length).toBeGreaterThanOrEqual(2);
        for (const s of seen) expect(s.timeout, `${s.file} 的 timeout`).toBeGreaterThan(0);
      },
      20_000,
    );

    it.skipIf(process.platform === "win32")(
      "【真重启】旧 server 进程整个消失（不是只丢内存 Map）：dev server 被孤立（PPID=1）后，新 server 的 killStalePreview 仍能按指纹杀掉整组",
      async () => {
        // 「旧 Flowship」= 一个独立的 node 进程：起 fakeyarn（detached、shell 形态，同产品）后打印 pid 并退出
        const launcher = path.join(TMP_ROOT, "r15-old-server.cjs");
        await fs.writeFile(
          launcher,
          [
            'const { spawn } = require("node:child_process");',
            `const p = spawn("fakeyarn custom", { shell: true, detached: true, stdio: "ignore", cwd: ${JSON.stringify(TMP_ROOT)}, env: process.env });`,
            "console.log(p.pid);",
            "p.unref();",
            "process.exit(0);",
          ].join("\n"),
        );
        const out = execFileSync(process.execPath, [launcher], { encoding: "utf8", env: process.env });
        const pid = Number(out.trim());
        expect(Number.isInteger(pid) && pid > 1).toBe(true);
        startedPids.add(pid);
        // 前提自检：旧 server 进程已不在，dev server 被 init 接管、自成进程组
        expect(await waitUntil(() => psCommandOf(pid).includes("fakeyarn custom"), 5000)).toBe(true);
        expect(execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim()).toBe("1");
        expect(isProcessGroupAlive(pid)).toBe(true);

        // 「旧 server」写下的 pidfile 记录（字段与 doStartPreview 一致）
        const fp = await getProcessStartFingerprint(pid);
        expect(fp).toBeTruthy();
        await writeRecord({
          pid,
          at: Date.now(),
          command: "fakeyarn custom",
          repoPath: "/repo/real-restart",
          workDir: TMP_ROOT,
          startedFp: fp,
        });

        // 「新 server」：本进程里没有这个子进程的任何句柄 / 管道 / exit 监听，只有 pidfile
        await killStalePreview();
        expect(await waitUntil(() => !isProcessGroupAlive(pid), 8000)).toBe(true);
        expect(await readPidFile()).toBeNull();
      },
      30_000,
    );

    it.skipIf(process.platform === "win32")(
      "字段保留：stop 其中一个仓（clearPidFileIf 路径）后，另一个仓记录的指纹 / workDir 还在",
      async () => {
        await startTracked(input("task-k1", "fakeyarn custom", "/repo/k1"));
        await startTracked(input("task-k2", "fakeyarn local", "/repo/k2"));
        await stopPreview("/repo/k1");
        const recs = await pidRecords();
        expect(recs.map((r) => r.repoPath)).toEqual(["/repo/k2"]);
        expect(recs[0].startedFp).toBeTruthy();
        expect((recs[0] as { workDir?: string }).workDir).toBe(TMP_ROOT);
      },
      25_000,
    );

    it.skipIf(process.platform === "win32")(
      "字段保留：重启其中一个仓（killStalePreviewForRepo 的 keep 分支）后，另一个仓记录的指纹 / workDir 还在",
      async () => {
        await startTracked(input("task-j1", "fakeyarn custom", "/repo/j1"));
        await startTracked(input("task-j2", "fakeyarn local", "/repo/j2"));
        await startTracked(input("task-j1b", "fakeyarn custom", "/repo/j1")); // 同仓再起 = 顶掉并走 keep 分支
        const recs = (await pidRecords()) as Array<{ repoPath?: string; startedFp?: string; workDir?: string }>;
        expect(recs).toHaveLength(2);
        for (const r of recs) {
          expect(r.startedFp, `${r.repoPath} 的指纹`).toBeTruthy();
          expect(r.workDir, `${r.repoPath} 的 workDir`).toBe(TMP_ROOT);
        }
      },
      30_000,
    );

    /**
     * 评审 R16（R16-01 / 02 / 07）：启动恢复的总时限、记录自带指纹取不到现值时不落弱校验、
     * 瞬时探测失败保留记录、绝不对自己发信号、归属根收窄、stale 路径只发组信号、主进程退出后的组清理要等。
     */
    describe("评审 R16", () => {
      const realProbe = (file: string, args: string[], opts?: Parameters<typeof realExec>[2]) =>
        realExec(file, args, opts).then((r) => ({ stdout: String(r.stdout) }));

      /** 自成进程组的 `sh -c "sleep 30 & exit 0"`：组长已退、组里还有 sleep；cwd 可指定 */
      const spawnOrphanGroup = async (cwd: string): Promise<number> => {
        const leader = spawn("sh", ["-c", "sleep 30 & exit 0"], { stdio: "ignore", detached: true, cwd });
        const leaderPid = leader.pid!;
        decoys.push({
          pid: leaderPid,
          kill: () => {
            try {
              process.kill(-leaderPid, "SIGKILL");
            } catch {
              /* 已死 */
            }
          },
        });
        await new Promise<void>((resolve) => leader.once("exit", () => resolve()));
        expect(isProcessGroupAlive(leaderPid)).toBe(true);
        return leaderPid;
      };

      it.skipIf(process.platform === "win32")(
        "【R16-01】启动恢复有总时限：某个探测卡住时按期返回、不发信号、记录原样保留；卡住的探测之后才醒来也不会再杀",
        async () => {
          const pid = spawnDecoy(TMP_ROOT);
          const fp = await getProcessStartFingerprint(pid);
          await writeRecord({ pid, at: Date.now(), workDir: TMP_ROOT, startedFp: fp });
          let wake!: () => void;
          const gate = new Promise<void>((r) => {
            wake = r;
          });
          __setPreviewProbeExecForTest(async (file, args, opts) => {
            if (file === "ps" && args.includes("command=")) await gate; // 卡住（模拟 ps / lsof 陷进不可中断睡眠）
            return realProbe(file, args, opts);
          });
          const t0 = Date.now();
          await killStalePreview({ budgetMs: 300 });
          expect(Date.now() - t0).toBeLessThan(3000); // 按期返回（没有被卡住的探测拖住）
          expect(isAlive(pid)).toBe(true);
          expect((await pidRecords()).map((r) => r.pid)).toEqual([pid]); // 放弃本轮 = 记录原样留着

          // 卡住的探测现在「醒来」：指纹是一致的、本来会杀——取消之后不得再发信号，也不得再动 pidfile
          wake();
          await sleep(1500);
          expect(isAlive(pid)).toBe(true);
          expect((await pidRecords()).map((r) => r.pid)).toEqual([pid]);
        },
        25_000,
      );

      it.skipIf(process.platform === "win32")(
        "【R16-02】记录带指纹、但现值取不到（ps 失败）→ 不落命令行退路、不发信号，记录保留；对照：现值恢复后同一条记录会杀",
        async () => {
          const pid = spawnDecoy(TMP_ROOT);
          const fp = await getProcessStartFingerprint(pid);
          // 命令行（sleep 30）、cwd（TMP_ROOT）都对得上——去掉「现值取不到」这一条，旧代码就会经命令行退路杀掉它
          await writeRecord({ pid, at: Date.now(), workDir: TMP_ROOT, startedFp: fp });
          __setPreviewProbeExecForTest((file, args, opts) =>
            file === "ps" && args.includes("lstart=")
              ? Promise.reject(new Error("ps lstart 失败"))
              : realProbe(file, args, opts),
          );
          await killStalePreview();
          expect(isAlive(pid)).toBe(true);
          expect((await pidRecords()).map((r) => r.pid)).toEqual([pid]);

          __setPreviewProbeExecForTest(null);
          await killStalePreview();
          expect(await waitUntil(() => !isProcessGroupAlive(pid), 8000)).toBe(true);
        },
        25_000,
      );

      it(
        "【R16-02】Windows（平台桩）：记录带指纹但 PowerShell 取不到 → 记录保留、不落映像名弱校验；没有指纹的旧记录仍走映像名退路（已接受的取舍）",
        async () => {
          const FAKE_PID = 2_000_000_000; // 不存在的 pid：即使走到 taskkill（本机没有）也碰不到任何进程
          const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
          Object.defineProperty(process, "platform", { value: "win32" });
          try {
            __setPreviewProbeExecForTest(async (file) => {
              if (file === "tasklist") return { stdout: `"node.exe","${FAKE_PID}","Console","1","10,000 K"\r\n` };
              throw new Error("powershell 被策略禁用 / 超时");
            });
            await writeRecord({
              pid: FAKE_PID,
              at: Date.now(),
              command: "node server.js",
              workDir: TMP_ROOT,
              startedFp: "2026-11-12T02:09:48.0000000Z",
            });
            await killStalePreview();
            // 旧代码：落到映像名弱校验（node.exe 命中）→ 跳过 cwd 证据 → taskkill /T /F，处理完清记录
            expect((await pidRecords()).map((r) => r.pid)).toEqual([FAKE_PID]);

            // 旧记录（没有指纹）：升级后第一次启动的取舍——仍走映像名退路，处理完清记录
            await writeRecord({ pid: FAKE_PID, at: Date.now(), command: "node server.js", workDir: TMP_ROOT });
            await killStalePreview();
            expect(await pidRecords()).toEqual([]);
          } finally {
            Object.defineProperty(process, "platform", orig);
          }
        },
        15_000,
      );

      it.skipIf(process.platform === "win32")(
        "【R16-07 a】ps 出错时记录保留（24 小时内）；超过 24 小时不再留——持续出错的机器别让它一直挂着",
        async () => {
          const uptime = vi.spyOn(os, "uptime").mockReturnValue(30 * 24 * 3600); // 开机很久：「开机前」判定不抢先清掉它
          try {
            const pid = spawnDecoy(TMP_ROOT);
            const fp = await getProcessStartFingerprint(pid);
            __setPreviewProbeExecForTest((file, args, opts) =>
              file === "ps" && args.includes("command=")
                ? Promise.reject(Object.assign(new Error("spawn ps EAGAIN"), { code: "EAGAIN" }))
                : realProbe(file, args, opts),
            );
            await writeRecord({ pid, at: Date.now() - 3600_000, workDir: TMP_ROOT, startedFp: fp });
            await killStalePreview();
            expect((await pidRecords()).map((r) => r.pid)).toEqual([pid]); // 1 小时前的：留

            await writeRecord({ pid, at: Date.now() - 25 * 3600_000, workDir: TMP_ROOT, startedFp: fp });
            await killStalePreview();
            expect(await pidRecords()).toEqual([]); // 25 小时前的：不再留
            expect(isAlive(pid)).toBe(true); // 两次都没发信号
          } finally {
            uptime.mockRestore();
          }
        },
        20_000,
      );

      it.skipIf(process.platform === "win32")(
        "【R16-07 b】记录里的 PID 就是 Flowship 自己 / 它的父进程：绝不发信号（只清记录）",
        async () => {
          const realKill = process.kill.bind(process);
          const signals: Array<[number, unknown]> = [];
          const spy = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
            if (sig === undefined || sig === 0) return realKill(pid, 0); // 只放行「探活」，真信号一律吞掉并记下
            signals.push([pid, sig]);
            return true;
          }) as typeof process.kill);
          try {
            for (const p of [process.pid, process.ppid]) {
              if (p <= 1) continue;
              const fp = await getProcessStartFingerprint(p);
              // 命令行、指纹、cwd 全部对得上——唯一的障碍就是「它是我们自己」
              await writeRecord({ pid: p, at: Date.now(), command: "node", workDir: process.cwd(), startedFp: fp });
              await killStalePreview();
            }
            expect(signals).toEqual([]);
            expect(await pidRecords()).toEqual([]);
          } finally {
            spy.mockRestore();
          }
        },
        15_000,
      );

      it.skipIf(process.platform === "win32")(
        "【R16-07 b】组长已退、组里有 Flowship 自己：不按组清理，哪怕成员 cwd 在记录目录下；对照：成员是别的进程就会按组清",
        async () => {
          const FAKE_LEADER = 2_000_000_000; // 不存在的组长 pid
          const realKill = process.kill.bind(process);
          const signals: Array<[number, unknown]> = [];
          const spy = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
            if (sig === undefined || sig === 0) {
              if (pid === -FAKE_LEADER) return true; // 假装这个组还有成员
              return realKill(pid, 0);
            }
            signals.push([pid, sig]);
            return true;
          }) as typeof process.kill);
          try {
            // 组里只有 Flowship 自己（cwd = process.cwd()，记录的 workDir 也指向它）
            __setPreviewProbeExecForTest((file, args, opts) =>
              file === "pgrep" ? Promise.resolve({ stdout: `${process.pid}\n` }) : realProbe(file, args, opts),
            );
            await writeRecord({ pid: FAKE_LEADER, at: Date.now(), workDir: process.cwd() });
            await killStalePreview();
            expect(signals).toEqual([]);

            // 对照：组里是个 cwd 在记录目录下的别的进程 → 证据齐了，按组杀
            const decoy = spawnDecoy(TMP_ROOT);
            __setPreviewProbeExecForTest((file, args, opts) =>
              file === "pgrep" ? Promise.resolve({ stdout: `${decoy}\n` }) : realProbe(file, args, opts),
            );
            await writeRecord({ pid: FAKE_LEADER, at: Date.now(), workDir: TMP_ROOT });
            await killStalePreview();
            expect(signals.some(([p, sig]) => p === -FAKE_LEADER && sig === "SIGTERM")).toBe(true);
          } finally {
            spy.mockRestore();
          }
        },
        20_000,
      );

      it.skipIf(process.platform === "win32")(
        "【R16-07 b】记录带 workDir：只认它——别的任务 worktree 里的进程不算我们的；旧记录（没有 workDir）仍认 worktree 根",
        async () => {
          const workElsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "fe-preview-r16-work-"));
          const otherWorktree = path.join(TMP_ROOT, "worktrees", "other-task", "repo");
          await fs.mkdir(otherWorktree, { recursive: true });
          try {
            const stranger = await spawnOrphanGroup(otherWorktree);
            await writeRecord({ pid: stranger, at: Date.now(), workDir: workElsewhere, repoPath: "/repo/r16-roots-a" });
            await killStalePreview();
            expect(isProcessGroupAlive(stranger)).toBe(true); // 旧口径（整个 worktree 根都算）会把它杀掉

            // 旧记录没有 workDir：隔离任务当时跑在 worktree 里，记录里只有原仓库——必须仍认得出 worktree 根下的进程
            const legacy = await spawnOrphanGroup(otherWorktree);
            await writeRecord({ pid: legacy, at: Date.now(), repoPath: "/repo/r16-roots-b" });
            await killStalePreview();
            expect(await waitUntil(() => !isProcessGroupAlive(legacy), 8000)).toBe(true);
          } finally {
            await fs.rm(workElsewhere, { recursive: true, force: true });
            await fs.rm(path.join(TMP_ROOT, "worktrees"), { recursive: true, force: true });
          }
        },
        30_000,
      );

      it.skipIf(process.platform === "win32")(
        "【R16-07 c】stale 路径只对进程组发信号：目标 PID 不是组长（没有以它为组号的进程组）时，不退到单 PID",
        async () => {
          const c = spawn("sleep", ["30"], { stdio: "ignore" }); // 不 detached：与测试进程同组，pid ≠ pgid
          const pid = c.pid!;
          decoys.push({
            pid,
            kill: () => {
              try {
                c.kill("SIGKILL");
              } catch {
                /* 已死 */
              }
            },
          });
          expect(isProcessGroupAlive(pid)).toBe(false); // 前提：确实没有这个进程组
          const fp = await getProcessStartFingerprint(pid);
          // 指纹、命令行都对得上：旧代码 `kill(-pid)` 失败后会退到 `kill(pid)`，把它杀了
          await writeRecord({ pid, at: Date.now(), workDir: TMP_ROOT, startedFp: fp });
          await killStalePreview();
          await sleep(300);
          expect(isAlive(pid)).toBe(true);
        },
        15_000,
      );

      it.skipIf(process.platform === "win32")(
        "【R16-07 d】主进程自己退出后清同组残留要等 KILL（约 2 秒）：这期间 stop 必须等它做完，返回时进程组确实没了",
        async () => {
          const repo = "/repo/r16-group-cleanup";
          const bgPidFile = path.join(TMP_ROOT, "r16-bg.pid");
          await fs.rm(bgPidFile, { force: true });
          // 后台子 shell 忽略 TERM（子进程继承）——只有 2 秒后的 KILL 才杀得掉；前台 sh 立刻退出
          await startTracked(
            input("task-r16-gc", `(trap '' TERM; sleep 300) & echo $! > "${bgPidFile}"; exit 0`, repo),
          );
          expect(await waitUntil(() => fs.access(bgPidFile).then(() => true, () => false), 5000)).toBe(true);
          const bgPid = Number((await fs.readFile(bgPidFile, "utf8")).trim());
          expect(Number.isInteger(bgPid) && bgPid > 1).toBe(true);
          try {
            expect(
              await waitUntil(() => getPreviewStatus().find((x) => x.repoPath === repo)?.exited === true, 5000),
            ).toBe(true);
            // 前提自检：主进程已退，忽略 TERM 的后台进程还活着（清理在途）
            expect(isAlive(bgPid)).toBe(true);
            await stopPreview(repo);
            // 旧代码：stop 立即返回，忽略 TERM 的进程还要活约 2 秒。
            // 不能「立刻」断言：SIGKILL 发出后进程要等被收养它的 init 回收才会让 kill(pid,0) 报 ESRCH，
            // 满负载的全量里这一步偶发拖到几十毫秒以上（2026-11-12 全量跑红过一次）。给 800ms 回收窗口，
            // 远小于旧代码的 ~2 秒残留，所以仍然分得清「等了」与「没等」。
            expect(await waitUntil(() => !isAlive(bgPid), 800)).toBe(true);
          } finally {
            try {
              process.kill(bgPid, "SIGKILL");
            } catch {
              /* 已清 */
            }
          }
        },
        25_000,
      );
    });
  });

});
