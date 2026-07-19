/**
 * 按仓多预览位 dev server 管理（V0.10.1 单预览位 → 按仓多位）
 *
 * 背景：worktree 隔离后每个任务有独立工作区、想看页面效果得手动 cd 深路径起
 * dev server。本模块按 repoPath 隔离预览位——不同仓可同时各跑一个（端口天然
 * 不同、不撞）；同一个仓全局仍只有一个位（同仓同端口会撞），别的任务再起同仓
 * 预览时顶掉前一个。
 *
 * 设计要点：
 * - app 不理解命令语义：启动命令来自设置页 per-repo 配置（如 `npm run dev`）、只负责执行
 * - 进程组隔离：spawn detached + kill(-pid)——dev server 常拉子进程（node → webpack workers）、
 *   只杀父进程会留孤儿占端口
 * - pidfile 兜底（dataRoot/preview.json）：数组记录各仓 pid；app 重启 / 崩溃后内存丢了、
 *   但 dev server 还活着占端口——下次 start / boot 时按记录杀掉残留进程组
 * - CR-10：start/stop 走全局串行队列（并发不交错）；pidfile 记 command + 随机 token、
 *   杀前核验 PID 归属防误杀、exit 回调按 token 只清自己那条
 * - 日志环形缓冲（最近 200 行）+ URL 探测（dev server 打出的 localhost 地址）、
 *   UI 轮询 status 拿去展示「打开」按钮 / 失败排查
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { dataRoot } from "./data-root";
import { getChatLifecycle } from "./chat-gate";
import { failpoint } from "./failpoints";
import type { PreviewSlotStatus } from "@/lib/types";

const execFileAsync = promisify(execFile);

// ----------------- per-task「启动中」计数（入队 → spawn 完成） -----------------

const PREVIEW_STARTING_KEY = "__flowshipPreviewStartingV1__";
const getPreviewStartingMap = (): Map<string, number> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, number> | undefined
  >;
  if (!g[PREVIEW_STARTING_KEY]) g[PREVIEW_STARTING_KEY] = new Map();
  return g[PREVIEW_STARTING_KEY]!;
};

const beginPreviewStarting = (taskId: string): void => {
  const m = getPreviewStartingMap();
  m.set(taskId, (m.get(taskId) ?? 0) + 1);
};

const endPreviewStarting = (taskId: string): void => {
  const m = getPreviewStartingMap();
  const n = (m.get(taskId) ?? 0) - 1;
  if (n <= 0) m.delete(taskId);
  else m.set(taskId, n);
};

/** 测试可见：某 task 是否仍有 startPreview 在「入队→spawn 完成」窗口 */
export const hasPreviewStarting = (taskId: string): boolean =>
  (getPreviewStartingMap().get(taskId) ?? 0) > 0;

/**
 * 等「启动中」归零（上限 ms）。
 * lifecycle 已占时 in-flight start 会在 spawn 前 admission 自退，短等即可，
 * 避免与卡在 preview.beforeSpawn 的 start 空耗满 10s。
 */
const waitPreviewStartingClear = async (
  taskId: string,
  maxMs: number,
): Promise<void> => {
  const deadline = Date.now() + maxMs;
  while (hasPreviewStarting(taskId) && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 50));
  }
};

/**
 * spawn 前最终准入——fresh 读盘 repoStatus + lifecycle。
 * 用 readTaskRepoStatusFresh（轻量、不 hydrate）避 preview-manager ↔ task-fs 环，
 * 且不踩 getTask 的 hydrate failpoint。
 */
const admitPreviewSpawn = async (
  taskId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  if (getChatLifecycle(taskId) !== null) {
    return { ok: false, reason: "任务正在停止/终结、暂不能起预览" };
  }
  const { readTaskRepoStatusFresh } = await import("./task-fs");
  const status = await readTaskRepoStatusFresh(taskId);
  if (status === null) {
    return { ok: false, reason: "task 不存在" };
  }
  if (status === "merged" || status === "abandoned") {
    return { ok: false, reason: "任务已终结、不能起预览" };
  }
  return { ok: true };
};

// ----------------- 类型 -----------------

interface PreviewSlot extends Omit<PreviewSlotStatus, "logTail"> {
  /** 存活时持有；进程 exit 后置 null，避免弱泄漏（保留 status / 日志快照） */
  proc: ChildProcess | null;
  log: string[];
  /** 本次 spawn 的随机 ownership token（pidfile 归属核验用、CR-10） */
  token: string;
}

// ----------------- 进程级单例（dev hot reload 下不同 chunk 共享） -----------------

// V2：按 repoPath 多预览位；换 key 名避免 hot reload 残留 V1 单 slot 结构
const SLOTS_KEY = "__flowshipPreviewSlotsV2__";
const getSlotsRef = (): Map<string, PreviewSlot> => {
  const g = globalThis as unknown as Record<string, Map<string, PreviewSlot> | undefined>;
  if (!g[SLOTS_KEY]) g[SLOTS_KEY] = new Map();
  return g[SLOTS_KEY]!;
};

// start / stop 全局串行队列（CR-10）：并发双 start / start+stop 交错会导致
// 「先起的进程变孤儿没人能停」「stop 停掉的是别人」——所有变更操作排队执行
const QUEUE_KEY = "__flowshipPreviewOpQueueV1__";
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

// app 重启后内存 slot 丢、dev server 还占着端口——pidfile 记下各仓 spawn 的进程、
// 下次 boot / start 前清残留。CR-10 起额外记 command + 随机 token：
// - command：杀前对照 ps 输出、PID 被系统复用给无关进程时不误杀
// - token：exit 回调 / stop 只清「自己写的那条」、旧进程迟到退出不清新进程的
interface PidFileRecord {
  pid: number;
  at: number;
  token: string;
  command: string;
  repoPath: string;
}

const pidFilePath = (): string => path.join(dataRoot(), "preview.json");

/** 读 pidfile 数组；旧格式单对象包成数组（升级后残留 dev server 还能被杀） */
const readPidFile = async (): Promise<Partial<PidFileRecord>[]> => {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(pidFilePath(), "utf8"));
    if (Array.isArray(raw)) return raw as Partial<PidFileRecord>[];
    if (raw && typeof raw === "object") return [raw as Partial<PidFileRecord>];
    return [];
  } catch {
    return [];
  }
};

const writePidFileAll = async (recs: PidFileRecord[]): Promise<void> => {
  try {
    if (recs.length === 0) {
      await fs.rm(pidFilePath(), { force: true });
      return;
    }
    await fs.writeFile(pidFilePath(), JSON.stringify(recs));
  } catch {
    // 写不进去只是失去崩溃兜底、不挡启动
  }
};

/** 写入 / 覆盖同仓那条（同仓单位语义） */
const upsertPidFile = async (rec: PidFileRecord): Promise<void> => {
  const cur = await readPidFile();
  const kept: PidFileRecord[] = [];
  for (const r of cur) {
    if (typeof r.pid !== "number" || !r.token || !r.command) continue;
    // 同仓旧记录丢掉（即将被本次覆盖）；无 repoPath 的旧格式也清掉（全局单位时代残留）
    if (!r.repoPath || r.repoPath === rec.repoPath) continue;
    kept.push({
      pid: r.pid,
      at: typeof r.at === "number" ? r.at : Date.now(),
      token: r.token,
      command: r.command,
      repoPath: r.repoPath,
    });
  }
  kept.push(rec);
  await writePidFileAll(kept);
};

/**
 * 清 pidfile。带 token 时只删「token 匹配的那条」——旧进程迟到的 exit 回调
 * 绝不能把新进程刚写的记录清掉（否则崩溃兜底失效、残留进程没人杀）。
 * 不带 token = 整文件清（killStale 扫完后用）。
 */
const clearPidFileIf = async (token?: string): Promise<void> => {
  if (!token) {
    await fs.rm(pidFilePath(), { force: true }).catch(() => {});
    return;
  }
  const cur = await readPidFile();
  const next: PidFileRecord[] = [];
  for (const r of cur) {
    if (r.token === token) continue; // 自己那条、删
    if (typeof r.pid !== "number" || !r.token || !r.command || !r.repoPath) continue;
    next.push({
      pid: r.pid,
      at: typeof r.at === "number" ? r.at : Date.now(),
      token: r.token,
      command: r.command,
      repoPath: r.repoPath,
    });
  }
  await writePidFileAll(next);
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
 *
 * 词边界匹配（禁止纯前缀）：`npm run develop` / `npm run dev:local` 不得命中记录的
 * `npm run dev`——否则 PID 复用场景会误杀。
 */
const pidLooksOurs = (psCommand: string, recCommand: string): boolean => {
  if (process.platform === "win32") {
    return /^(cmd\.exe|node\.exe|powershell\.exe)$/i.test(psCommand.trim());
  }
  if (!recCommand) return false;
  let from = 0;
  while (from <= psCommand.length) {
    const idx = psCommand.indexOf(recCommand, from);
    if (idx === -1) return false;
    const beforeOk =
      idx === 0 ||
      /\s/.test(psCommand.charAt(idx - 1)) ||
      (idx >= 3 && psCommand.slice(idx - 3, idx) === "-c ");
    const afterIdx = idx + recCommand.length;
    const afterOk =
      afterIdx >= psCommand.length || /[\s;&|]/.test(psCommand.charAt(afterIdx));
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
  return false;
};

/** 进程是否仍存活（kill(pid,0)；ESRCH = 已退出） */
const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * 进程组是否仍存在。
 * shell:true + detached 时组长常是 shell——TERM 后 shell 可能先退，占端口的
 * 子进程仍在同一组；只查组长 PID 会误判「已清干净」而跳过 SIGKILL。
 * Unix：kill(-pid,0) 探组；EPERM 也表示组内仍有成员，仅 ESRCH 表示组已空。
 * 负号语义不可用时回退 processAlive（查组长）。
 */
const processGroupAlive = (pid: number): boolean => {
  if (pid <= 0) return processAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return processAlive(pid);
  }
};

// 杀整棵进程树。
// - mac/linux：detached spawn 后 pid = 进程组长、kill(-pid) 杀全组；先 TERM 给优雅退出机会、
//   按「进程组是否仍在」轮询最多 2s、超时再对 -pid 发 KILL 兜底（组已空则提前返回）
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
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!processGroupAlive(pid)) return;
  tryKill("SIGKILL");
};

/** 对单条 pidfile 记录做归属核验后 kill（匹配才杀、不匹配只丢记录） */
const killOneStaleRecord = async (rec: Partial<PidFileRecord>): Promise<void> => {
  if (typeof rec.pid !== "number" || rec.pid <= 1) return;
  const psCommand = await getProcessCommand(rec.pid);
  if (psCommand === null) {
    // 进程已不在
  } else if (typeof rec.command === "string" && rec.command && pidLooksOurs(psCommand, rec.command)) {
    await killProcessGroup(rec.pid);
  } else {
    console.warn(
      `[preview] pidfile 的 PID ${rec.pid} 命令行对不上（现为「${psCommand}」）、疑似被复用、不发信号只清记录`,
    );
  }
};

/**
 * 清上一次进程遗留的全部 dev server（pidfile 兜底、boot 调）。
 * CR-10：杀前核验 PID 归属——对不上（PID 被复用 / 旧格式 pidfile 无 command）
 * 只清记录不发信号、绝不误杀无关进程。
 */
export const killStalePreview = async (): Promise<void> => {
  const recs = await readPidFile();
  for (const rec of recs) {
    await killOneStaleRecord(rec);
  }
  await clearPidFileIf();
};

/**
 * 只清指定仓的 pidfile 残留（start 同仓顶掉前调用、不动其它仓）。
 * 无 repoPath 的旧格式记录也一并清（全局单位时代残留、归属不明）。
 */
const killStalePreviewForRepo = async (repoPath: string): Promise<void> => {
  const recs = await readPidFile();
  const keep: PidFileRecord[] = [];
  for (const rec of recs) {
    const sameRepo = !rec.repoPath || rec.repoPath === repoPath;
    if (sameRepo) {
      await killOneStaleRecord(rec);
      continue;
    }
    if (typeof rec.pid !== "number" || !rec.token || !rec.command || !rec.repoPath) continue;
    keep.push({
      pid: rec.pid,
      at: typeof rec.at === "number" ? rec.at : Date.now(),
      token: rec.token,
      command: rec.command,
      repoPath: rec.repoPath,
    });
  }
  await writePidFileAll(keep);
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

/** 返回当前全部预览位状态（按仓） */
export const getPreviewStatus = (): PreviewSlotStatus[] =>
  [...getSlotsRef().values()].map(toStatus);

/** 停指定仓预览（没有在跑也算成功、幂等）。经全局串行队列。 */
export const stopPreview = (repoPath: string): Promise<void> =>
  enqueue(() => doStopPreview(repoPath));

/** 停全部预览位（boot / DELETE 不带 repoPath / 全清用） */
export const stopAllPreviews = (): Promise<void> => enqueue(doStopAllPreviews);

/**
 * 停掉属于某 task 的所有 slot（删任务 / 终结任务前调用）。
 * 先等「启动中」归零（覆盖已过 route 闸、还在队列里的 start），再停已有 slot。
 * 不经全局 start 队列直接停——避免与卡在 preview.beforeSpawn 的 doStartPreview 死锁；
 * spawn 后另有终态复查自停孤儿。
 */
export const stopPreviewsForTask = async (taskId: string): Promise<void> => {
  // lifecycle 已占（finalize/DELETE）→ admission 会挡 spawn，短等；否则最多 ~10s
  const cap = getChatLifecycle(taskId) !== null ? 500 : 10_000;
  await waitPreviewStartingClear(taskId, cap);
  await doStopPreviewsForTask(taskId);
};

const doStopPreview = async (repoPath: string): Promise<void> => {
  const map = getSlotsRef();
  const slot = map.get(repoPath);
  if (!slot) return;
  map.delete(repoPath);
  if (slot.proc?.pid) await killProcessGroup(slot.proc.pid);
  // 只清自己那条（token 核验）——理论上串行队列已保证无交错、token 是带子
  await clearPidFileIf(slot.token);
};

const doStopAllPreviews = async (): Promise<void> => {
  const map = getSlotsRef();
  const paths = [...map.keys()];
  for (const repoPath of paths) {
    await doStopPreview(repoPath);
  }
};

const doStopPreviewsForTask = async (taskId: string): Promise<void> => {
  const map = getSlotsRef();
  const paths = [...map.values()]
    .filter((s) => s.taskId === taskId)
    .map((s) => s.repoPath);
  for (const repoPath of paths) {
    await doStopPreview(repoPath);
  }
};

export interface StartPreviewInput {
  taskId: string;
  taskTitle: string;
  repoPath: string;
  /** dev server 实际运行目录（隔离 task = worktree、否则 = 原仓库） */
  workDir: string;
  command: string;
}

/** startPreview 返回值；yielded=true 表示最终准入拒绝、未 spawn（route → 409） */
export interface StartPreviewResult {
  replacedTaskTitle: string | null;
  status: PreviewSlotStatus;
  /** spawn 前最终准入失败 */
  yielded?: boolean;
  yieldReason?: string;
}

/**
 * 起预览（按仓单位：只停同 repoPath 旧位、其它仓不动）。
 * 经全局串行队列（CR-10）：同仓并发双 start 顺序执行、后到的顶掉先到的。
 * 入队起登记「启动中」，cleanup 后、spawn 前最终准入复查。
 */
export const startPreview = (
  input: StartPreviewInput,
): Promise<StartPreviewResult> => {
  // 入队即登记——stopPreviewsForTask 可等「还在队列里」的窗口
  beginPreviewStarting(input.taskId);
  return enqueue(() => doStartPreview(input)).finally(() => {
    endPreviewStarting(input.taskId);
  });
};

const doStartPreview = async (
  input: StartPreviewInput,
): Promise<StartPreviewResult> => {
  const map = getSlotsRef();
  const replaced = map.get(input.repoPath) ?? null;
  const replacedTaskTitle =
    replaced && !replaced.exited && replaced.taskId !== input.taskId
      ? replaced.taskTitle
      : null;

  // 只停同仓旧位（内存）+ 同仓 pidfile 残留——不动其它仓
  //（直接调 do 版本：本函数已在队列内、再 enqueue 会自锁）
  await doStopPreview(input.repoPath);
  await killStalePreviewForRepo(input.repoPath);

  // cleanup 之后、紧贴 spawn 前——插桩 + 最终准入（fresh task + lifecycle）
  await failpoint("preview.beforeSpawn");
  const admission = await admitPreviewSpawn(input.taskId);
  if (!admission.ok) {
    // 让位：不 spawn；合成已退出 status 给调用方（无 pid）
    const yieldedStatus: PreviewSlotStatus = {
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      repoPath: input.repoPath,
      workDir: input.workDir,
      command: input.command,
      startedAt: Date.now(),
      url: null,
      exited: true,
      exitCode: null,
      logTail: [`最终准入拒绝——${admission.reason}`],
    };
    return {
      replacedTaskTitle: null,
      status: yieldedStatus,
      yielded: true,
      yieldReason: admission.reason,
    };
  }

  // shell 模式跑用户配置的命令串（可能带 && / 环境变量前缀）。
  // - unix：detached 自成进程组、kill(-pid) 整组杀
  // - Windows：detached 会给子进程开独立控制台黑框（用户可见）、而树杀走 taskkill /T
  //   本就不依赖进程组 → 不 detach + windowsHide 压掉窗口
  // 剔掉 app 自用的 PORT / HOSTNAME（Electron 壳给内置 Next server 注入的）——
  // 原封漏给 dev server 会被 umi/webpack 等优先读走、顶掉用户 --port 配置，
  // 再因 8876 被 app 自己占着自动 +1 全跑到 8877（用户实测：--port=8888 实跑 8877）
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
  delete env.PORT;
  delete env.HOSTNAME;
  const proc = spawn(input.command, {
    cwd: input.workDir,
    shell: true,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  // 随机 ownership token：pidfile 归属核验（exit 回调 / stop 只清自己写的那条）
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
    // 自然退出：放下 ChildProcess 引用，保留 status / 日志快照，避免弱泄漏
    slot.proc = null;
    // CR-10：只有自己还是「该仓当前预览位」才清 pidfile——被顶掉的旧进程迟到的 exit
    // 不得清掉新进程刚写的那条（token 双保险）。
    // 必须进串行队列：pidfile 现在是数组读改写、exit 回调裸跑会与别的仓
    // start 的 upsertPidFile 交错、可能丢掉对方刚写的记录（崩溃兜底失效）
    if (map.get(input.repoPath) === slot) {
      void enqueue(() => clearPidFileIf(token));
    }
  });
  proc.on("error", (err) => {
    slot.exited = true;
    slot.log.push(`spawn 失败：${err.message}`);
  });

  map.set(input.repoPath, slot);
  if (proc.pid) {
    await upsertPidFile({
      pid: proc.pid,
      at: Date.now(),
      token,
      command: input.command,
      repoPath: input.repoPath,
    });
  }

  // spawn 后终态复查——stopPreviewsForTask 可能已在 admission~map.set 窗口跑过
  const post = await admitPreviewSpawn(input.taskId);
  if (!post.ok) {
    map.delete(input.repoPath);
    if (proc.pid) await killProcessGroup(proc.pid);
    await clearPidFileIf(token);
    return {
      replacedTaskTitle: null,
      status: {
        ...toStatus(slot),
        exited: true,
        logTail: [`spawn 后复查拒绝——${post.reason}`],
      },
      yielded: true,
      yieldReason: post.reason,
    };
  }

  return { replacedTaskTitle, status: toStatus(slot) };
};
