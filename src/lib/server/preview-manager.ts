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
 * - 日志环形缓冲（最近 200 行）+ URL 探测（dev server 打出的 localhost 地址）、
 *   UI 轮询 status 拿去展示「打开」按钮 / 失败排查
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot } from "./data-root";
import type { PreviewSlotStatus } from "@/lib/types";

// ----------------- 类型 -----------------

interface PreviewSlot extends Omit<PreviewSlotStatus, "logTail"> {
  proc: ChildProcess;
  log: string[];
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

const MAX_LOG_LINES = 200;

// pidfile：跨进程残留兜底（app 重启后内存 slot 丢、dev server 还占着端口）
const pidFilePath = (): string => path.join(dataRoot(), "preview.json");

const writePidFile = async (pid: number): Promise<void> => {
  try {
    await fs.writeFile(pidFilePath(), JSON.stringify({ pid, at: Date.now() }));
  } catch {
    // 写不进去只是失去崩溃兜底、不挡启动
  }
};

const clearPidFile = async (): Promise<void> => {
  await fs.rm(pidFilePath(), { force: true }).catch(() => {});
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

/** 清上一次进程遗留的 dev server（pidfile 兜底、boot / 每次 start 前调） */
export const killStalePreview = async (): Promise<void> => {
  try {
    const raw = await fs.readFile(pidFilePath(), "utf8");
    const pid = (JSON.parse(raw) as { pid?: number }).pid;
    if (typeof pid === "number" && pid > 1) await killProcessGroup(pid);
  } catch {
    // 没 pidfile / 内容坏、没得清
  }
  await clearPidFile();
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

/** 停当前预览（没有在跑也算成功、幂等） */
export const stopPreview = async (): Promise<void> => {
  const ref = getSlotRef();
  const slot = ref.current;
  ref.current = null;
  if (slot && slot.proc.pid) await killProcessGroup(slot.proc.pid);
  await clearPidFile();
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
 * @returns 被顶掉的上一个任务标题（UI toast 用、没有则 null）
 */
export const startPreview = async (
  input: StartPreviewInput,
): Promise<{ replacedTaskTitle: string | null; status: PreviewSlotStatus }> => {
  const ref = getSlotRef();
  const replaced = ref.current;
  const replacedTaskTitle =
    replaced && !replaced.exited && replaced.taskId !== input.taskId
      ? replaced.taskTitle
      : null;

  // 停旧（内存 slot）+ 杀跨进程残留（pidfile）——两条都清才能保证端口空出来
  await stopPreview();
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
    void clearPidFile();
  });
  proc.on("error", (err) => {
    slot.exited = true;
    slot.log.push(`spawn 失败：${err.message}`);
  });

  ref.current = slot;
  if (proc.pid) await writePidFile(proc.pid);

  return { replacedTaskTitle, status: toStatus(slot) };
};
