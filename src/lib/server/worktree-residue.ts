/**
 * 「`git worktree add` 被硬杀」残留的判定（R14 B5-2 / Q10-01）——纯逻辑 + 一张进程内登记表，
 * **不跑 git、不读盘**（读 `locked` 文件、找登记目录、真正动手都在 task-worktrees.ts 里做）。
 *
 * 背景：`git worktree add` 先在 `<主仓>/.git/worktrees/<名>/` 写一个 `locked`（内容恰好 `initializing`），
 * 检出完成后自己删掉它。检出途中被 SIGKILL / 崩溃 / 断电：`locked`、`index.lock` 和半截检出原样留下
 * （SIGTERM / SIGINT 下 git 会自己清理 junk、不留残留——只有硬杀才留，真 git 实验见 HANDOFF「R14 B5-2」）。此后：
 * - `rev-parse --is-inside-work-tree` 为 true、`branch --show-current` 是任务分支 → ensure 当健康 worktree 复用；
 * - `worktree remove --force` 拒绝（locked），退回 `fs.rm` + `prune` 又清不掉被锁定的登记 →
 *   目录没了、登记还在，同名分支永远报 `already checked out`。
 *
 * 判据只认 `locked` 的内容：trim 后**严格等于** `initializing`。用户手动 `git worktree lock --reason X` 的 X、
 * 无 reason 的空串、`add --lock` 写的 `added with --lock` 都不是它。`index.lock` 单独存在、`status` 全是删除
 * 单独出现都**不**构成判据（前者可能是另一个 git 进程在跑，后者可能是用户自己删光了文件）。
 *
 * 「进行中」与「残留」在 git 状态上**逐字相同**（真 git 实验：`locked`、`index.lock`、`worktree list` 输出一致），
 * 分不开，只能靠 Flowship 自己的信息：
 * 1. 本进程里有这个目录的 `git worktree add` 在跑（{@link beginWorktreeAdd} 登记，含孤儿自愈后的 retry）→ live；
 * 2. `locked` 的 mtime 距今不足 {@link STALE_INITIALIZING_AFTER_MS} → live（可能是本机另一个实例 / 终端在 add）；
 * 3. 否则 → stale。
 * 不用「`locked` 早于本进程启动就是残留」：同机可能同时开着正式 + test 两个实例，更早启动的那个 add 还活着会被误判。
 */
import path from "node:path";

/** git 在 `worktree add` 进行期间写进 `<gitdir>/locked` 的原因串（builtin/worktree.c）；add 成功后 git 自己删掉这个文件 */
export const INITIALIZING_LOCK_REASON = "initializing";

/**
 * `locked` 停在 initializing 多久才当残留。
 * 依据：Flowship 自己的 `git worktree add` 最长 120s（超时发 SIGTERM，git 自清理、不留残留）；
 * 本机另一个实例同样受这个超时约束 → 留 2.5 倍余量取 5 分钟。超过它还停在 initializing 就没有活的持有者。
 * 代价：被硬杀后 5 分钟内重试会被拒（带「约 N 秒后重试」文案）——误判的后果是破坏别人正在建的目录，所以宁可保守。
 */
export const STALE_INITIALIZING_AFTER_MS = 5 * 60_000;

export type InitializingLockVerdict =
  /** 没有 initializing 锁（含：没登记 / 没有 `locked` / 用户手动 lock 的） */
  | { kind: "none" }
  /** 看起来有一次 add 还在进行（本进程在途，或 `locked` 太新）——不得动目录与登记 */
  | { kind: "live"; why: "in-flight" | "recent"; ageMs: number }
  /** 没有活的持有者：add 被硬杀留下的残留 */
  | { kind: "stale"; ageMs: number };

/** `<gitdir>/locked` 文本是否恰好是 git add 的中间态（trim 后严格相等；`includes` 会把用户 lock 的 reason 误判进来） */
export const isInitializingLockText = (text: string | null | undefined): boolean =>
  typeof text === "string" && text.trim() === INITIALIZING_LOCK_REASON;

/**
 * 综合判定。
 * @param lockText `<gitdir>/locked` 的内容；null = 没有这个文件
 * @param ageMs `locked` 的 mtime 距今毫秒数（负数 = 时钟回拨 / 未来 mtime，按 live 处理）
 * @param inFlight 本进程里是否有这个目录的 `git worktree add` 在跑
 */
export const judgeInitializingLock = (input: {
  lockText: string | null;
  ageMs: number;
  inFlight: boolean;
}): InitializingLockVerdict => {
  if (!isInitializingLockText(input.lockText)) return { kind: "none" };
  if (input.inFlight) return { kind: "live", why: "in-flight", ageMs: input.ageMs };
  if (input.ageMs < STALE_INITIALIZING_AFTER_MS) {
    return { kind: "live", why: "recent", ageMs: input.ageMs };
  }
  return { kind: "stale", ageMs: input.ageMs };
};

/** live 时给用户 / 日志看的说明（含「约 N 秒后重试」；时钟回拨的负年龄按 0 算，N 不超过阈值本身） */
export const describeLiveInitializing = (
  verdict: Extract<InitializingLockVerdict, { kind: "live" }>,
): string => {
  if (verdict.why === "in-flight") {
    return "本进程里另一次 git worktree add 还在进行";
  }
  const age = Math.max(0, verdict.ageMs);
  const retryAfterSec = Math.max(1, Math.ceil((STALE_INITIALIZING_AFTER_MS - age) / 1000));
  return `git 的 initializing 锁才 ${Math.round(age / 1000)}s，可能是本机另一个实例 / 终端正在 add；约 ${retryAfterSec}s 后重试`;
};

/**
 * 解析 worktree 目录里 `.git` 指针文件的 `gitdir:` 值（= 该 worktree 在主仓里的登记目录；可能是相对路径）。
 * 没有合法的 `gitdir:` 行返回 null。
 */
export const parseGitdirPointerValue = (text: string): string | null => {
  const m = text.match(/^gitdir:\s*(.+)$/m);
  const value = m?.[1]?.trim();
  return value ? value : null;
};

/**
 * 登记目录里 `gitdir` 文件的内容（`<worktree>/.git` 的绝对路径，git 写的是 realpath）→ worktree 目录路径。
 * 去掉末尾的 `/.git`（Windows 上 git 也写正斜杠，两种分隔符都认）；空内容返回 null。
 */
export const worktreePathFromAdminGitdirFile = (text: string): string | null => {
  const line = text.split(/\r?\n/)[0]?.trim() ?? "";
  if (!line) return null;
  return line.replace(/[\\/]\.git$/, "");
};

// ----------------- 进程内「add 在跑」登记表 -----------------

/**
 * 登记表放 globalThis：Next 把不同 route / 入口分别打包时同一模块可能有多份实例，
 * 一份实例登记、另一份实例判断，分裂的表会让 in-flight 判断落空（年龄阈值仍兜底，但别白白丢掉第一道防线）。
 * 沿用 task-worktrees 里 DepPrepareGlobals 的做法。
 */
type AddRegistryGlobals = { __flowshipWorktreeAddInFlight?: Map<string, number> };
const registry = (): Map<string, number> => {
  const g = globalThis as AddRegistryGlobals;
  if (!g.__flowshipWorktreeAddInFlight) g.__flowshipWorktreeAddInFlight = new Map();
  return g.__flowshipWorktreeAddInFlight;
};

/** 登记键：绝对化 + 去尾分隔符；Windows 不分大小写、统一正斜杠。调用方应先把路径 realpath 规范化（见 task-worktrees） */
const addKey = (workDir: string): string => {
  let k = path.resolve(workDir);
  if (process.platform === "win32") k = k.replace(/\\/g, "/").toLowerCase();
  return k.length > 1 ? k.replace(/[\\/]+$/, "") : k;
};

/**
 * 登记「本进程正要对这个目录跑 `git worktree add`」；返回的函数在 add 结束（成功 / 失败 / 抛错）时调、可重复调。
 * 同一目录可嵌套登记（计数），最后一个结束才算不在途。
 */
export const beginWorktreeAdd = (workDir: string): (() => void) => {
  const k = addKey(workDir);
  const map = registry();
  map.set(k, (map.get(k) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (map.get(k) ?? 1) - 1;
    if (left <= 0) map.delete(k);
    else map.set(k, left);
  };
};

/** 本进程里是否有这个目录的 `git worktree add` 在跑 */
export const isWorktreeAddInFlight = (workDir: string): boolean =>
  registry().has(addKey(workDir));

/** 仅供测试：清空登记表，防跨用例串扰 */
export const __resetWorktreeAddInFlightForTest = (): void => {
  registry().clear();
};
