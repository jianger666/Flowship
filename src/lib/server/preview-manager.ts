/**
 * 单预览位 dev server 管理（V0.10.1、worktree 隔离的配套体验）
 *
 * 背景：worktree 隔离后每个任务有独立工作区、想看页面效果得手动 cd 深路径起 dev server。
 * 本模块提供「全局唯一预览位」：任何时刻最多一个 dev server 在跑、点任务「预览」自动
 * 停掉上一个（无论属于哪个 task）、在当前任务工作区起新的——体验对齐单分支时代
 * 「永远只有一个本地服务」的心智、端口也不会互撞。
 *
 * 设计要点：
 * - app 不理解命令语义：启动命令来自设置页 per-repo 配置（如 `npm run dev`）、只负责执行
 * - 进程组隔离：spawn detached + kill(-pid)——dev server 常拉子进程（node → webpack workers）、
 *   只杀父进程会留孤儿占端口
 * - pidfile 兜底（dataRoot/preview.json）：app 重启 / 崩溃后内存 slot 丢了、但 dev server
 *   还活着占端口——下次 start / boot 时按 pidfile 杀掉残留进程组
 * - CR-10：start/stop 走全局串行队列（并发不交错）；pidfile 记 command + 随机 token、
 *   杀前核验 PID 归属防误杀、exit 回调按 ref/token 只清自己那份
 * - 日志环形缓冲（最近 200 行）+ URL 探测（dev server 打出的 localhost 地址）、
 *   UI 轮询 status 拿去展示「打开」按钮 / 失败排查
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { dataRoot } from "./data-root";
import type { PreviewSlotStatus } from "@/lib/types";

const execFileAsync = promisify(execFile);

// ----------------- 类型 -----------------

interface PreviewSlot extends Omit<PreviewSlotStatus, "logTail"> {
  proc: ChildProcess;
  log: string[];
  /** 本次 spawn 的随机 ownership token（pidfile 归属核验用、CR-10） */
  token: string;
}

// ----------------- 进程级单例（dev hot reload 下不同 chunk 共享） -----------------

const SLOT_KEY = "__feAiFlowPreviewSlotV1__";
const getSlotRef = (): { current: PreviewSlot | null } => {
  const g = globalThis as unknown as Record<
    string,
    { current: PreviewSlot | null } | undefined
  >;
  if (!g[SLOT_KEY]) g[SLOT_KEY] = { current: null };
  return g[SLOT_KEY]!;
};

// start / stop 全局串行队列（CR-10）：并发双 start / start+stop 交错会导致
// 「先起的进程变孤儿没人能停」「stop 停掉的是别人」——所有变更操作排队执行、
// 任意时刻最多一个在跑、slot 发布不再有竞态
const QUEUE_KEY = "__feAiFlowPreviewOpQueueV1__";
const getQueueRef = (): { current: Promise<void> } => {
  const g = globalThis as unknown as Record<
    string,
    { current: Promise<void> } | undefined
  >;
  if (!g[QUEUE_KEY]) g[QUEUE_KEY] = { current: Promise.resolve() };
  return g[QUEUE_KEY]!;
};

const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
  const q = getQueueRef();
  const run = q.current.then(fn);
  // 队列指针只关心「上一个是否结束」、错误由调用方消费、不传染下一个
  q.current = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const MAX_LOG_LINES = 200;

// ----------------- pidfile（跨进程残留兜底 + 归属核验、CR-10） -----------------

// app 重启后内存 slot 丢、dev server 还占着端口——pidfile 记下 spawn 的进程、
// 下次 boot / start 前清残留。CR-10 起额外记 command + 随机 token：
// - command：杀前对照 ps 输出、PID 被系统复用给无关进程时不误杀
// - token：exit 回调 / stop 只清「自己写的那份」pidfile、旧进程迟到退出不清新进程的
interface PidFileRecord {
  pid: number;
  at: number;
  token: string;
  command: string;
}

const pidFilePath = (): string => path.join(dataRoot(), "preview.json");

const readPidFile = async (): Promise<Partial<PidFileRecord> | null> => {
  try {
    return JSON.parse(await fs.readFile(pidFilePath(), "utf8")) as Partial<PidFileRecord>;
  } catch {
    return null; // 没文件 / 内容坏
  }
};

const writePidFile = async (rec: PidFileRecord): Promise<void> => {
  try {
    await fs.writeFile(pidFilePath(), JSON.stringify(rec));
  } catch {
    // 写不进去只是失去崩溃兜底、不挡启动
  }
};

/**
 * 清 pidfile。带 token 时只清「token 匹配的那份」——旧进程迟到的 exit 回调
 * 绝不能把新进程刚写的 pidfile 清掉（否则崩溃兜底失效、残留进程没人杀）。
 */
const clearPidFileIf = async (token?: string): Promise<void> => {
  if (token) {
    const cur = await readPidFile();
    if (cur && cur.token !== token) return; // 不是自己写的、不动
  }
  await fs.rm(pidFilePath(), { force: true }).catch(() => {});
};

// 查进程当前命令行（杀前核验用）。进程不存在 / 查不了返 null。
const getProcessCommand = async (pid: number): Promise<string | null> => {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { windowsHide: true },
      );
      const m = stdout.match(/^"([^"]+)"/m);
      return m ? m[1] : null;
    }
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

/**
 * PID 归属核验（CR-10）：pidfile 里的 PID 可能已被系统复用给无关进程、盲发信号会
 * 误杀。unix 下 spawn(shell:true) 的子进程命令行是 `/bin/sh -c <command>`（或 sh
 * 直接 exec 成 <command> 本体）、ps 输出应包含记录的 command；win 的 tasklist 只给
 * 映像名、只能弱校验是 shell/node 家族。
 */
const pidLooksOurs = (psCommand: string, recCommand: string): boolean => {
  if (process.platform === "win32") {
    return /^(cmd\.exe|node\.exe|powershell\.exe)$/i.test(psCommand.trim());
  }
  return psCommand.includes(recCommand);
};

// 杀整棵进程树。
// - mac/linux：detached spawn 后 pid = 进程组长、kill(-pid) 杀全组；先 TERM 给优雅退出机会、2s 后 KILL 兜底
// - Windows（V0.11.1）：没有进程组负号语义、kill(-pid) 会抛——用 `taskkill /T /F` 杀整棵树
//   （dev server 常见 node → webpack workers 多级子进程、只杀父进程会留孤儿占端口）
const killProcessGroup = async (pid: number): Promise<void> => {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true },
        () => resolve(), // 进程已死等错误一律吞、best-effort
      );
    });
    return;
  }
  const tryKill = (signal: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
  };
  if (!tryKill("SIGTERM")) return;
  await new Promise((r) => setTimeout(r, 2000));
  tryKill("SIGKILL");
};

/**
 * 清上一次进程遗留的 dev server（pidfile 兜底、boot / 每次 start 前调）。
 * CR-10：杀前核验 PID 归属——对不上（PID 被复用 / 旧格式 pidfile 无 command）
 * 只清 pidfile 不发信号、绝不误杀无关进程。
 */
export const killStalePreview = async (): Promise<void> => {
  const rec = await readPidFile();
  if (rec && typeof rec.pid === "number" && rec.pid > 1) {
    const psCommand = await getProcessCommand(rec.pid);
    if (psCommand === null) {
      // 进程已不在、只剩清文件
    } else if (typeof rec.command === "string" && rec.command && pidLooksOurs(psCommand, rec.command)) {
      await killProcessGroup(rec.pid);
    } else {
      console.warn(
        `[preview] pidfile 的 PID ${rec.pid} 命令行对不上（现为「${psCommand}」）、疑似被复用、不发信号只清 pidfile`,
      );
    }
  }
  await clearPidFileIf();
};

// 从 dev server 输出探本地访问地址（umi/vite/next 都会打 localhost URL）
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+[^\s'"]*/;

const toStatus = (slot: PreviewSlot): PreviewSlotStatus => ({
  taskId: slot.taskId,
  taskTitle: slot.taskTitle,
  repoPath: slot.repoPath,
  workDir: slot.workDir,
  command: slot.command,
  startedAt: slot.startedAt,
  url: slot.url,
  exited: slot.exited,
  exitCode: slot.exitCode,
  logTail: slot.log.slice(-50),
});

// ----------------- 对外 API -----------------

export const getPreviewStatus = (): PreviewSlotStatus | null => {
  const slot = getSlotRef().current;
  return slot ? toStatus(slot) : null;
};

/** 停当前预览（没有在跑也算成功、幂等）。经全局串行队列、不与 start 交错（CR-10）。 */
export const stopPreview = (): Promise<void> => enqueue(doStopPreview);

const doStopPreview = async (): Promise<void> => {
  const ref = getSlotRef();
  const slot = ref.current;
  ref.current = null;
  if (slot && slot.proc.pid) await killProcessGroup(slot.proc.pid);
  // 只清自己那份（token 核验）——理论上串行队列已保证无交错、token 是带子
  await clearPidFileIf(slot?.token);
};

export interface StartPreviewInput {
  taskId: string;
  taskTitle: string;
  repoPath: string;
  /** dev server 实际运行目录（隔离 task = worktree、否则 = 原仓库） */
  workDir: string;
  command: string;
}

/**
 * 起预览（单预览位语义：先停旧、再在 workDir 起 command）。
 * 经全局串行队列（CR-10）：并发双 start 顺序执行、后到的顶掉先到的、
 * 不会出现「两个都 spawn、先者变没人管的孤儿」。
 * @returns 被顶掉的上一个任务标题（UI toast 用、没有则 null）
 */
export const startPreview = (
  input: StartPreviewInput,
): Promise<{ replacedTaskTitle: string | null; status: PreviewSlotStatus }> =>
  enqueue(() => doStartPreview(input));

const doStartPreview = async (
  input: StartPreviewInput,
): Promise<{ replacedTaskTitle: string | null; status: PreviewSlotStatus }> => {
  const ref = getSlotRef();
  const replaced = ref.current;
  const replacedTaskTitle =
    replaced && !replaced.exited && replaced.taskId !== input.taskId
      ? replaced.taskTitle
      : null;

  // 停旧（内存 slot）+ 杀跨进程残留（pidfile）——两条都清才能保证端口空出来
  //（直接调 do 版本：本函数已在队列内、再 enqueue 会自锁）
  await doStopPreview();
  await killStalePreview();

  // shell 模式跑用户配置的命令串（可能带 && / 环境变量前缀）。
  // - unix：detached 自成进程组、kill(-pid) 整组杀
  // - Windows：detached 会给子进程开独立控制台黑框（用户可见）、而树杀走 taskkill /T
  //   本就不依赖进程组 → 不 detach + windowsHide 压掉窗口
  const proc = spawn(input.command, {
    cwd: input.workDir,
    shell: true,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  // 随机 ownership token：pidfile 归属核验（exit 回调 / stop 只清自己写的那份）
  const token = randomBytes(8).toString("hex");
  const slot: PreviewSlot = {
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    repoPath: input.repoPath,
    workDir: input.workDir,
    command: input.command,
    startedAt: Date.now(),
    url: null,
    exited: false,
    exitCode: null,
    proc,
    log: [],
    token,
  };

  const onChunk = (chunk: Buffer): void => {
    const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
    slot.log.push(...lines);
    if (slot.log.length > MAX_LOG_LINES) {
      slot.log.splice(0, slot.log.length - MAX_LOG_LINES);
    }
    if (!slot.url) {
      for (const line of lines) {
        const m = line.match(URL_RE);
        if (m) {
          // 0.0.0.0 是监听地址不是可访问地址、换成 localhost
          slot.url = m[0].replace("0.0.0.0", "localhost");
          break;
        }
      }
    }
  };
  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", onChunk);
  proc.on("exit", (code) => {
    slot.exited = true;
    slot.exitCode = code;
    // CR-10：只有自己还是「当前预览位」才清 pidfile——被顶掉的旧进程迟到的 exit
    // 不得清掉新进程刚写的那份（token 双保险）
    if (ref.current === slot) void clearPidFileIf(token);
  });
  proc.on("error", (err) => {
    slot.exited = true;
    slot.log.push(`spawn 失败：${err.message}`);
  });

  ref.current = slot;
  if (proc.pid) {
    await writePidFile({
      pid: proc.pid,
      at: Date.now(),
      token,
      command: input.command,
    });
  }

  return { replacedTaskTitle, status: toStatus(slot) };
};
