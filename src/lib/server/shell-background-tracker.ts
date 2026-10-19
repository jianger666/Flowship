/**
 * 后台 shell 追踪：shell 工具结果落盘后，查它是不是「已转后台、进程还在跑」，
 * 是就落 phase=running 标记、跑完再落 phase=ended（渲染层据此转圈，见 src/lib/shell-background.ts）。
 *
 * 为什么读终端文件：Cursor SDK 公开的 tool_call / shell-output-delta 里没有「已转后台」信号
 * （proto 里的 pid / shellId / isBackground / backgrounded 事件在转公开 JSON 时被剥掉了），
 * 但 SDK 给**每个** shell 都在 `<CURSOR_DATA_DIR || ~/.cursor>/projects/<workspace>/terminals/<shellId>.txt`
 * 写一份终端文件（模型自己就是靠读它拿后台命令的输出）。文件头是稳定的 front matter：
 *
 *   ---
 *   pid: 6568
 *   cwd: "/path"
 *   command: "<命令；\ \" \n \r \t 转义成单行>"
 *   title: "<description>"
 *   status: running      ← running | succeeded | failed | aborted（退出瞬间改写）
 *   started_at: 2026-10-18T02:35:31.772Z
 *   running_for_ms: 291117
 *   ---
 *
 * 所以：用「命令原文 + 开始时刻」在最近被写过的终端文件里认出本次 shell，status 还是 running = 转后台了。
 * 不依赖 workspace 目录怎么映射成 projects 子目录（chat 随时可换 cwd）——命令 + 时间窗足够认人。
 *
 * 找不到 / 读不了 → 静默放弃（效果退回「按已完成显示」），绝不影响主流程。
 * pi 后端的 bash 是同步跑完的、不写终端文件，同样走「找不到」路径，白扫一次目录而已。
 *
 * 防误认 / 防拖垮：
 * - **排他认领**：一份终端文件同一时刻只归一个追踪——两个并发的同命令调用（同时 `pnpm build`）不会绑到同一个文件上；
 *   已正常结束的匹配、追踪结束的文件也留一小段时间不被后来的同命令调用再认走（见 `CLAIM_TTL_MS`）；
 * - **有界并发 stat**：终端文件长期累积上千份很常见，不能每个成功的 shell 调用都 readdir 后一次性全量并发 stat
 *   （会和 events.jsonl 的追加抢 libuv 线程池）。⚠ **不能按文件名里的 shellId 截断「只看最新 N 份」**：
 *   shellId 不随时间递增（实测同一个会话里新 shell 的 id 比一周前的还小），截断会让新文件有约 1 − N/总数 的概率落在窗口外、
 *   静默认不到、整个功能悄悄失效。所以全部都 stat（16 并发），再按 mtime 过滤；
 * - **探活**：文件头永远停在 running（SDK 被 kill / 机器睡眠后进程没了）时，用 `process.kill(pid, 0)` 兜底，
 *   pid 已不在就收尾，不让转圈挂到 run 结束；
 * - 进程级状态（目录缓存 / 追踪表 / 认领表）放 globalThis：Next dev 下各 route 是不同 chunk，模块级变量会各持一份，
 *   收尾（finalize 在另一个 chunk）就停不掉这边的追踪。
 */

import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildShellBackgroundEvent,
  type ShellBackgroundMeta,
} from "@/lib/shell-background";

import { mapLimit } from "./map-limit";
import { writeOwnedEventAndPublish } from "./task-stream";

/**
 * tool_result 落盘后先等一会再查。
 * 正常结束的 shell 在返回结果前终端文件就已经改成 succeeded/failed，这里只是给「文件头改写落盘」留余量，
 * 避免极短的窗口里把刚退出的命令当成「还在跑」闪一下转圈。
 */
export const TERMINAL_PROBE_DELAY_MS = 600;
/** 进程还在跑时的复查间隔（SDK 自己每 5s 刷一次文件头，退出时立刻改 status） */
export const TERMINAL_POLL_INTERVAL_MS = 2000;
/** 终端文件头读取上限（命令原文可能很长：heredoc / 内联脚本） */
const HEADER_READ_BYTES = 64 * 1024;
/** 终端文件 started_at 与「结果到达时刻 − executionTime」的容差 */
const START_TOLERANCE_MS = 20_000;
/** 文件 mtime 早于「估计开始时刻 − 这个值」的不看（运行中的文件每 5s 被刷新，不会早于它） */
const MTIME_SLACK_MS = 10_000;
/** 轮询时连续读不出文件头多少次才当作已结束 */
const UNREADABLE_LIMIT = 3;
/** taskId → 上次认出终端文件所在目录（下次先扫它，不用再扫全部 projects） */
const DIR_CACHE_MAX = 200;
/** readdir 之后 stat 类探测的并发上限 */
const PROBE_CONCURRENCY = 16;
/** 认领的保留时长：已结束的匹配 / 追踪结束后，这段时间内同命令的后来者不再认走同一份文件 */
export const CLAIM_TTL_MS = 30_000;
/** 探活：连续几次轮询发现 pid 已不在、而文件头仍写 running，就当它已退出 */
const DEAD_PID_LIMIT = 2;
/** finalize 等在途追踪落定的上限（不能让一次卡死的写盘拖住 run 收尾） */
export const STOP_WAIT_MS = 2000;

export type TerminalHeader = {
  pid?: number;
  /** 命令原文的「已编码」形态（含两侧引号），与 {@link encodeTerminalCommand} 同口径，直接比字符串 */
  commandEncoded: string;
  status: string;
  startedAtMs?: number;
};

/** 与 SDK 写终端文件头时的命令转义一致：反斜杠 / 双引号 / \n / \r / \t，两侧加引号 */
export const encodeTerminalCommand = (command: string): string =>
  `"${command
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;

/**
 * 解析终端文件头（第一对 `---` 之间）。形态不对（没有 command / status）→ null。
 * 只认头，不看后面的输出正文。
 */
export const parseTerminalHeader = (rawText: string): TerminalHeader | null => {
  // Windows 上文件头可能是 CRLF：先统一成 LF（命令里的 \r 已被转义成两个字符 `\r`，不会有裸的回车混进来）
  const text = rawText.includes("\r\n") ? rawText.replace(/\r\n/g, "\n") : rawText;
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---\n", 4);
  // 头没读全（超长命令把 64KB 吃满）→ 不认，宁可漏也别拿半截头去匹配
  if (end < 0) return null;
  const lines = text.slice(4, end).split("\n");
  let commandEncoded: string | undefined;
  let status: string | undefined;
  let pid: number | undefined;
  let startedAtMs: number | undefined;
  for (const line of lines) {
    if (line.startsWith("command: ")) {
      commandEncoded = line.slice("command: ".length);
    } else if (line.startsWith("status:")) {
      status = line.slice("status:".length).trim();
    } else if (line.startsWith("pid:")) {
      const n = Number(line.slice("pid:".length).trim());
      if (Number.isInteger(n) && n > 0) pid = n;
    } else if (line.startsWith("started_at:")) {
      const t = Date.parse(line.slice("started_at:".length).trim());
      if (Number.isFinite(t)) startedAtMs = t;
    }
  }
  if (commandEncoded === undefined || !status) return null;
  return {
    commandEncoded,
    status,
    ...(pid !== undefined ? { pid } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
  };
};

/** SDK 终端文件所在的 projects 根目录（对齐 SDK：CURSOR_DATA_DIR 优先、否则 ~/.cursor） */
export const cursorProjectsRoot = (): string => {
  const override = process.env.CURSOR_DATA_DIR;
  const base =
    override && override.trim() ? override : path.join(os.homedir(), ".cursor");
  return path.join(base, "projects");
};

// ----------------- 进程级状态（globalThis） -----------------

type Tracker = {
  stopped: boolean;
  wake?: () => void;
  /** 旁路 run 身份（属主主链为 undefined）：旁路收尾时只停自己的追踪 */
  origin?: string;
  /** 追踪彻底结束（含在途写盘落定）时 resolve：收尾方据此等「在途写入」 */
  done: Promise<void>;
};
interface TrackerState {
  /** taskId → 上次认出终端文件所在目录 */
  dirCache: Map<string, string>;
  trackersByTask: Map<string, Set<Tracker>>;
  /** 终端文件绝对路径 → 认领到期时刻（Infinity = 有存活的追踪占着） */
  claims: Map<string, number>;
}
const STATE_KEY = "__flowshipShellBgTrackerStateV1__";
const state = (): TrackerState => {
  const g = globalThis as unknown as Record<
    string,
    Partial<TrackerState> | undefined
  >;
  const s = (g[STATE_KEY] ??= {});
  s.dirCache ??= new Map();
  s.trackersByTask ??= new Map();
  s.claims ??= new Map();
  return s as TrackerState;
};

/** 进程还在不在：EPERM = 在（只是不归我们管）；ESRCH = 不在 */
export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
};

const claimedNow = (file: string): boolean => {
  const claims = state().claims;
  const until = claims.get(file);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    claims.delete(file);
    return false;
  }
  return true;
};
/** 顺手清掉过期的认领（只在被再次查询时才清的话，没人再碰的文件会让表缓慢增长） */
const pruneClaims = (): void => {
  const claims = state().claims;
  const now = Date.now();
  for (const [file, until] of claims) {
    if (until <= now) claims.delete(file);
  }
};
/** 同步地「查 + 占」：成功占上返回 true（两个并发的认人只会有一个赢） */
const tryClaim = (file: string): boolean => {
  pruneClaims();
  if (claimedNow(file)) return false;
  state().claims.set(file, Date.now() + CLAIM_TTL_MS);
  return true;
};
const holdClaim = (file: string): void => {
  state().claims.set(file, Number.POSITIVE_INFINITY);
};
const releaseClaim = (file: string): void => {
  // 不是立刻删：同命令的后来者在一小段时间内仍可能把这份刚结束的文件认成自己的
  state().claims.set(file, Date.now() + CLAIM_TTL_MS);
};

/** 测试用：清空目录缓存与认领（不动在途追踪） */
export const resetShellBackgroundTrackerStateForTest = (): void => {
  state().dirCache.clear();
  state().claims.clear();
};

/** 测试用：认领表里实际存着的条目数（含已过期但还没被清掉的——用来验证确实会清） */
export const shellTerminalClaimTableSize = (): number => state().claims.size;

/** 测试用：当前还留着的认领个数（只数未过期的） */
export const shellTerminalClaimCount = (): number => {
  let n = 0;
  const now = Date.now();
  for (const until of state().claims.values()) if (until > now) n += 1;
  return n;
};

const readHeaderOf = async (file: string): Promise<TerminalHeader | null> => {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const buf = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEADER_READ_BYTES, 0);
    return parseTerminalHeader(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};

type FoundTerminal = {
  file: string;
  dir: string;
  header: TerminalHeader;
};

/** 在一个 terminals 目录里找「命令一致、开始时刻吻合」的最新一份终端文件（跳过已被别的追踪认领的） */
const findInTerminalsDir = async (
  dir: string,
  commandEncoded: string,
  startedAtMs: number,
  isClaimed?: (file: string) => boolean,
): Promise<FoundTerminal | null> => {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const minMtime = startedAtMs - MTIME_SLACK_MS;
  // 全部 stat（有界并发）再按 mtime 过滤——shellId 不随时间递增，不能靠文件名挑「最新的」
  const candidates = names.filter((n) => /^\d+\.txt$/.test(n));
  const recent: string[] = [];
  await mapLimit(candidates, PROBE_CONCURRENCY, async (n) => {
    try {
      const st = await fs.stat(path.join(dir, n));
      if (st.mtimeMs >= minMtime) recent.push(path.join(dir, n));
    } catch {
      /* 文件刚被删：跳过 */
    }
  });
  // stat 的完成顺序不确定：排个序，两份「命令相同、时间差也相同」的文件才有确定的先后
  recent.sort();
  let best: FoundTerminal | null = null;
  let bestGap = Infinity;
  for (const file of recent) {
    if (isClaimed?.(file)) continue;
    const header = await readHeaderOf(file);
    if (!header || header.commandEncoded !== commandEncoded) continue;
    const gap =
      header.startedAtMs === undefined
        ? START_TOLERANCE_MS
        : Math.abs(header.startedAtMs - startedAtMs);
    if (gap > START_TOLERANCE_MS || gap >= bestGap) continue;
    bestGap = gap;
    best = { file, dir, header };
  }
  return best;
};

const rememberDir = (taskId: string, dir: string): void => {
  const dirCache = state().dirCache;
  dirCache.delete(taskId);
  dirCache.set(taskId, dir);
  while (dirCache.size > DIR_CACHE_MAX) {
    const oldest = dirCache.keys().next().value;
    if (oldest === undefined) break;
    dirCache.delete(oldest);
  }
};

/** 认出这次 shell 对应的终端文件：先查该任务上次命中的目录，没有再扫全部 projects/<ws>/terminals */
export const locateShellTerminal = async (input: {
  taskId: string;
  command: string;
  startedAtMs: number;
  /** 这份文件是否已被别的追踪认领（认领是追踪方的事，locate 本身无状态；缺省 = 都没被认领） */
  isClaimed?: (file: string) => boolean;
}): Promise<FoundTerminal | null> => {
  const commandEncoded = encodeTerminalCommand(input.command);
  const cached = state().dirCache.get(input.taskId);
  if (cached) {
    const hit = await findInTerminalsDir(
      cached,
      commandEncoded,
      input.startedAtMs,
      input.isClaimed,
    );
    if (hit) return hit;
  }
  const root = cursorProjectsRoot();
  let projects: string[];
  try {
    projects = await fs.readdir(root);
  } catch {
    return null;
  }
  const minDirMtime = input.startedAtMs - MTIME_SLACK_MS;
  const dirs: string[] = [];
  await mapLimit(projects, PROBE_CONCURRENCY, async (p) => {
    const dir = path.join(root, p, "terminals");
    if (dir === cached) return;
    try {
      // 新建终端文件会刷新目录 mtime——本次 shell 的文件一定让它晚于开始时刻
      const st = await fs.stat(dir);
      if (st.mtimeMs >= minDirMtime) dirs.push(dir);
    } catch {
      /* 没有 terminals 目录：跳过 */
    }
  });
  for (const dir of dirs) {
    const hit = await findInTerminalsDir(
      dir,
      commandEncoded,
      input.startedAtMs,
      input.isClaimed,
    );
    if (hit) {
      rememberDir(input.taskId, dir);
      return hit;
    }
  }
  return null;
};

// ----------------- 追踪 -----------------

const register = (taskId: string, t: Tracker): void => {
  const trackersByTask = state().trackersByTask;
  let set = trackersByTask.get(taskId);
  if (!set) {
    set = new Set();
    trackersByTask.set(taskId, set);
  }
  set.add(t);
};

const unregister = (taskId: string, t: Tracker): void => {
  const trackersByTask = state().trackersByTask;
  const set = trackersByTask.get(taskId);
  if (!set) return;
  set.delete(t);
  if (set.size === 0) trackersByTask.delete(taskId);
};

/**
 * 停掉某任务的追踪（run 收尾时调）：不再轮询、不再写标记。
 * - 不传 origin = 全部（属主 run 的 finalize：它把任务里所有 running 的后台 shell 一并收尾，旁路的也算）；
 * - 传 origin = 只停这个旁路 run 自己的追踪。
 *
 * 返回的 promise 在被停的追踪全部落定后 resolve（有上限 {@link STOP_WAIT_MS}、永不 reject）：
 * 追踪可能正好在写 running 标记——收尾方必须等它落盘再读事件尾巴，否则读到的尾巴里没有这条 running，
 * 随后它晚到落盘，就成了永远没人补 ended 的孤儿。不关心的调用方（`void`）也无妨。
 */
export const stopBackgroundShellTracking = (
  taskId: string,
  origin?: string,
): Promise<void> => {
  const set = state().trackersByTask.get(taskId);
  if (!set) return Promise.resolve();
  const waits: Promise<void>[] = [];
  for (const t of [...set]) {
    if (origin !== undefined && t.origin !== origin) continue;
    t.stopped = true;
    t.wake?.();
    waits.push(t.done);
  }
  if (waits.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STOP_WAIT_MS);
    timer.unref?.();
    void Promise.allSettled(waits).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
};

/** 测试用：当前还挂着的追踪个数 */
export const activeBackgroundShellTrackerCount = (): number => {
  let n = 0;
  for (const set of state().trackersByTask.values()) n += set.size;
  return n;
};

const sleepUnlessStopped = (ms: number, t: Tracker): Promise<void> =>
  new Promise((resolve) => {
    if (t.stopped) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      t.wake = undefined;
      resolve();
    }, ms);
    // 不拦进程退出
    timer.unref?.();
    t.wake = () => {
      clearTimeout(timer);
      t.wake = undefined;
      resolve();
    };
  });

export type TrackBackgroundShellInput = {
  taskId: string;
  callId: string;
  /** shell 工具入参里的命令原文 */
  command: string;
  /** 本次 shell 开始时刻（ms）：结果到达时刻 − SDK 报告的 executionTime */
  startedAtMs: number;
  /** run 所有权闸门：失主 → 不写、停轮询 */
  lease: () => boolean;
  /** 旁路 run 身份（属主主链不传）：标记要带同一个 origin，才会跟着它的 tool 事件一起被折叠 */
  origin?: string;
  /** 测试注入 */
  probeDelayMs?: number;
  pollIntervalMs?: number;
  write?: (meta: ShellBackgroundMeta) => Promise<unknown>;
  /** 轮询时读文件头（测试用来脚本化「偶发读不出」；缺省读真文件） */
  readHeader?: (file: string) => Promise<TerminalHeader | null>;
  /** 探活（测试注入；缺省 process.kill(pid, 0)） */
  isPidAlive?: (pid: number) => boolean;
};

/**
 * 查一次、必要时轮询到进程结束。fire-and-forget：调用方 `void` 它；
 * 返回的 promise 只在追踪结束（没转后台 / 已结束 / 被停 / 失主）时 resolve、永不 reject。
 */
export const trackBackgroundShell = async (
  input: TrackBackgroundShellInput,
): Promise<void> => {
  let resolveDone: () => void = () => {};
  const tracker: Tracker = {
    stopped: false,
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    done: new Promise<void>((resolve) => {
      resolveDone = resolve;
    }),
  };
  register(input.taskId, tracker);
  let claimedFile: string | undefined;
  const write =
    input.write ??
    ((meta: ShellBackgroundMeta) =>
      writeOwnedEventAndPublish(
        input.taskId,
        input.lease,
        buildShellBackgroundEvent(meta),
        input.origin,
      ));
  const alive = (): boolean => !tracker.stopped && input.lease();
  try {
    await sleepUnlessStopped(
      input.probeDelayMs ?? TERMINAL_PROBE_DELAY_MS,
      tracker,
    );
    if (!alive()) return;

    // 认人 + 排他认领：locate 是异步的、两个并发的同命令调用可能同时挑中同一份文件，
    // 所以「查 + 占」放在 locate 返回后的同步段里，输家换个文件再认（最多几轮）
    let found: Awaited<ReturnType<typeof locateShellTerminal>> = null;
    for (let attempt = 0; attempt < 3 && !found; attempt += 1) {
      const hit = await locateShellTerminal({
        taskId: input.taskId,
        command: input.command,
        startedAtMs: input.startedAtMs,
        isClaimed: claimedNow,
      });
      if (!hit) break;
      if (tryClaim(hit.file)) {
        found = hit;
        claimedFile = hit.file;
      }
    }
    // 找不到 / 已正常结束 → 这就是一次普通 shell，什么都不用做（已结束的认领留着自然过期）
    if (!found || found.header.status !== "running") return;
    if (!alive()) return;

    const pid = found.header.pid;
    const pidAlive = input.isPidAlive ?? isPidAlive;
    // 头写着 running、进程却早没了（SDK 被 kill / 睡眠后残留）：别再亮转圈
    if (pid !== undefined && !pidAlive(pid)) return;
    holdClaim(found.file);
    await write({
      callId: input.callId,
      phase: "running",
      ...(pid !== undefined ? { pid } : {}),
    });

    const pollMs = input.pollIntervalMs ?? TERMINAL_POLL_INTERVAL_MS;
    let unreadable = 0;
    let deadPid = 0;
    for (;;) {
      await sleepUnlessStopped(pollMs, tracker);
      if (!alive()) return;
      const header = await (input.readHeader ?? readHeaderOf)(found.file);
      if (header) {
        unreadable = 0;
        if (header.status === "running") {
          // 探活兜底：文件头永远写 running 的情形（连续几次都发现进程不在才收，防一次偶发）
          if (pid === undefined || pidAlive(pid)) {
            deadPid = 0;
            continue;
          }
          deadPid += 1;
          if (deadPid < DEAD_PID_LIMIT) continue;
        }
      } else {
        // SDK 原地改写文件头，偶发读到半截不能就当结束；连续读不出来（被清理 / 头损坏）才收，别让转圈挂死
        unreadable += 1;
        if (unreadable < UNREADABLE_LIMIT) continue;
      }
      await write({
        callId: input.callId,
        phase: "ended",
        reason: "exited",
        ...(pid !== undefined ? { pid } : {}),
      });
      return;
    }
  } catch (err) {
    console.warn(
      `[shell-background] 追踪失败 task=${input.taskId} call=${input.callId}`,
      err,
    );
  } finally {
    unregister(input.taskId, tracker);
    if (claimedFile !== undefined) releaseClaim(claimedFile);
    resolveDone();
  }
};
