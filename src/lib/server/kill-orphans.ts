/**
 * 杀掉 agent 通过 shell 工具拉起、停止后没被回收的孤儿进程（V0.6.8）
 *
 * # 背景（一次真实事故）
 * 停止 task 时 `run.cancel()` 只能停 agent 本体、**杀不到 agent 用 shell 工具拉起的孙子进程**。
 * 典型事故：agent 在 build 里跑 `cd <repo> && npm run lint`、而该仓的 `lint` = `ng lint --fix=true`
 *（Angular 自动改写）；用户「停止」后 agent 死了、但这个 lint 子进程 reparent 到 init 继续 `--fix`
 * 整个仓库 → 代码仓库被「疯狂改写」。
 *
 * # 进程拓扑（macOS 打包版 + Cursor SDK 本地 agent、2026-10-14 真机实测）
 *   Flowship（Electron 主进程、ppid=1）
 *     └─ next-server（即本 server、`process.pid`）
 *          └─ /bin/zsh -c IFS= builtin read -r -d '' __cursor_command <&5; ...; snap=$(command cat <&3); ...
 *               └─（agent 跑的命令：npm / ng lint / node ...）
 * 即 agent shell 的 **ppid 直接等于 server 的 pid、中间没有 agent-exec**。
 * 早期版本 / 其它 provider 下 `agent-exec` 可能夹在中间（server → agent-exec → shell）；
 * 「祖先链含本 server 进程」的判据（hasAncestor 沿 ppid 往上走）对两种拓扑都成立。
 * 未验证：pi provider 的 shell 拓扑（走 pi-coding-tools 自己 spawn、未必带下面的签名、
 * 也未实测祖先链）——本模块不保证覆盖它，pi 的 shell 孤儿能否被收走需另行实测。
 *
 * # 做法
 * 在停止 / 收尾时主动扫一遍系统进程、把满足以下条件的进程连同其子树一起 kill：
 *   - **cwd 落在调用方传入的工作目录里**（限定作用域、不波及无关仓库），且
 *   - 命中下面两条候选之一：
 *     a. 带 **Cursor agent shell 签名**（agent 的 shell 工具 wrapper、见下）**且**「属于本 Flowship」：
 *        父进程链上有本 server 进程（agent 还活着、是 server 的后代），或已 orphan（ppid=1、agent 已死）；
 *     b. 已 **orphan（ppid=1）**（父 agent 已死、reparent 到 init）且命令像构建 / 脚本进程，
 *        **且 cwd 在 Flowship 自己管理的 worktree 根（`<dataRoot>/worktrees`）之下**（N10-03，见下）
 *
 * # 为什么签名分支要额外收窄（S06-01）
 * 签名 `command cat <&3` 是 Cursor agent 的 shell 工具通用 wrapper——用户在同一目录里用 Cursor IDE 自己起的 agent shell
 * 也带它。只靠「签名 + cwd」会把那些 shell 连子树一起 SIGKILL。Flowship 目前**没有记录**自己拉起的 agent shell 的 pid
 *（shell 由 Cursor SDK 内部拉起、server 拿不到 pid；补记录要改 SDK 链路、超出本模块），所以用「祖先链含本 server 进程」
 * 作为「Flowship 自己的」判据：SDK 本地 agent 的 shell 是 server 的后代（见上方实测拓扑），用户 IDE 的 shell 挂在 Cursor.app 下、不在这条链上。
 * 剩余风险：agent-exec 已死但 shell 被 reparent 到非 init 的 subreaper（如 Linux systemd --user）时、本进程既非后代
 * 也非 ppid=1，会漏杀（宁可漏杀、不误杀）；ppid=1 的签名 shell 仍无法区分是谁的（极罕见：用户 IDE 退出后同目录残留）。
 *
 * # 为什么无签名的 orphan 分支只认 worktree 根（N10-03）
 * 分支 b 没有任何「是 Flowship 拉起的」证据——只有 ppid=1 + 命令名像 node / npm。而非隔离任务（isolateWorktree=false、
 * 日常轻量态、非 git / 只读仓）的工作目录就是**用户自己的原仓**，用户在里面自己跑的、已被 reparent 到 init 的 node / npm
 * 进程（nohup 起的 dev server、nx / gradle / turbo daemon、IDE 工具链残留）同样满足 ppid=1 + cwd 命中，会被误杀。
 * 所以 b 只在 cwd 位于 `<dataRoot>/worktrees` 之下时生效：那是 Flowship 为任务建的隔离目录，除 agent 外没人会在里面起进程。
 * 原仓目录里的孤儿**不再被 b 杀**（宁可漏杀）——它们只有在带 agent shell 签名且归属本 Flowship（分支 a）时才会被收走。
 *
 * 为什么不用「进程启动时间晚于 server 启动」当额外信号：① 用户在 server 之后自己起的 daemon 一样晚于 server，区分不了；
 * ② server 崩溃重启后要收的恰恰是**旧 server 时代**拉起的孤儿，启动时间早于新 server，会把真孤儿也放掉。
 * 所以只用「位置」这个确定性信号、不引入时间启发式。
 *
 * 调用方应传 **agent 实际工作目录**（`getTaskWorkRepoPaths(task)`），不是裸 `task.repoPaths`——
 * 隔离 worktree 任务的 cwd 在 `<dataRoot>/worktrees/<taskId>/...`，传原仓路径会漏杀孤儿。
 *
 * 这样**不会误杀用户在自己终端里手动跑的 dev server / lint**——那些进程的父进程是用户的
 * shell（不是 init）、也没有 agent shell 签名。
 *
 * # 注意
 * - 仅 best-effort：失败只 log、不抛、不阻断停止流程。
 * - macOS / Linux 通用（依赖 `ps` + `lsof`）；Windows 没有这俩、入口直接跳过
 *   （孤儿风险仍在、但树杀由壳退出时 taskkill /T 兜底、不值得为此接 wmic/CIM）。
 * - **不要在 force-new-agent（换新 agent）场景做延迟二次扫**——新 agent 会在同仓拉起带同样签名的 shell、
 *   会被误杀。调用方应传 `{ delayedRescan: false }` 只做即时扫；真正停止 / 自然结束 / 报错保持默认二次扫
 *   （见 task-runner resume 路径 + stop / finally）。
 */
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

// 只依赖 data-root（零外部依赖的叶子模块）算 worktree 根，不 import task-worktrees：
// 后者带 task-op / resource-jobs 等一串依赖，且不少测试会 partial mock 它，
// 本模块不该因此被拖累（也避免将来 task-worktrees 反向依赖本模块时成环）。
import { dataRoot } from "./data-root";

const execAsync = promisify(exec);

// Cursor agent 的 shell 工具跑命令时套的 wrapper 特征串（用户手动终端不会有这个）。
// 形如：/bin/zsh -c snap=$(command cat <&3); builtin unsetopt aliases ...
const AGENT_SHELL_SIGNATURE = "command cat <&3";

// orphan(ppid=1) 分支的命令白名单——macOS 下大量系统 daemon 也挂在 launchd(ppid=1) 下、
// 用这个把候选收窄到「构建 / 脚本 / shell」类、避免对几十个系统进程做 lsof（也防误伤）。
// cwd 落在工作目录的二次过滤仍在、这里只是减负 + 加一道保险。
// 注意：它只是命令名白名单、**不是**「Flowship 拉起」的证据——所以命中它的候选还要额外要求
// cwd 在 worktree 根下（见 killOrphansInRepos 里的 roots 过滤 / N10-03）。
const ORPHAN_CMD_HINT =
  /\b(node|npm|pnpm|yarn|npx|deno|bun|ng|vue-cli-service|vite|webpack|rollup|esbuild|jest|vitest|mocha|eslint|tslint|stylelint|tsc|prettier|biome|java|gradlew?|mvn|python\d?|ruby|go|cargo|sh|zsh|bash|fish)\b/;

interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
}

/** 列出全部进程（pid / ppid / 完整命令行） */
const listProcesses = async (): Promise<ProcInfo[]> => {
  // -axww：全进程 + 不截断命令行；-o ...= ：去表头
  const { stdout } = await execAsync("ps -axww -o pid=,ppid=,command=", {
    maxBuffer: 16 * 1024 * 1024,
  });
  const procs: ProcInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? "" });
  }
  return procs;
};

/**
 * 解析 `lsof -Fpn` 输出（p<pid> 行 + n<path> 行）进 `into`。
 * `dropTail`：丢掉没有换行收尾的最后一段——命令失败 / 输出被截断时它可能只是半条路径，
 * 半条路径恰好是工作目录前缀（`…/repo-evil` 被截成 `…/repo`）会被误圈进作用域，宁可丢。
 */
const parseLsofCwds = (
  stdout: string,
  into: Map<number, string>,
  dropTail: boolean,
): void => {
  const lines = stdout.split("\n");
  if (dropTail) lines.pop();
  let cur = 0;
  for (const line of lines) {
    if (line.startsWith("p")) cur = Number(line.slice(1));
    else if (line.startsWith("n") && cur) into.set(cur, line.slice(1));
  }
};

/** 批量取一组 pid 的 cwd（lsof 一次查完）→ Map<pid, cwd> */
const getCwds = async (pids: number[]): Promise<Map<number, string>> => {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;
  try {
    // -a -d cwd 只看 cwd 这个 fd；-Fpn 机读格式：p<pid> 行 + n<path> 行
    const { stdout } = await execAsync(
      `lsof -a -d cwd -Fpn -p ${pids.join(",")}`,
      { maxBuffer: 8 * 1024 * 1024 },
    );
    parseLsofCwds(stdout, result, false);
  } catch (err) {
    // 候选里只要有一个 pid 在 ps 与 lsof 之间退出，lsof 就非零退出——但其余 pid 的 cwd 照常打印在 stdout 里
    //（promisify(exec) 把它挂在 reject 的 Error 上）。整个丢掉等于一次竞态就让本轮所有候选查不到 cwd、
    // 一个孤儿都不收；所以这里要把已输出的完整行捡回来（最后一段可能被截断、不采信）
    const stdout = (err as { stdout?: unknown } | null)?.stdout;
    if (typeof stdout === "string") parseLsofCwds(stdout, result, true);
  }
  return result;
};

/**
 * 路径集合 → 字面量路径 + 对应的 realpath（去重）。
 *
 * 为什么要补 realpath：lsof 报的 cwd 永远是真实路径（软链摊平、macOS 上还是磁盘上的真实大小写），
 * 而调用方 / dataRoot 给的是字面量——数据目录或工作目录经软链访问（换盘后软链回来）、或大小写与磁盘不一致时，
 * 只比字面量前缀会永远对不上，整个保护悄悄失灵（孤儿 `ng lint --fix` 继续改写仓库）。
 * 两种形态都留着：是「放宽」不是「替换」——realpath 取不到（目录已不存在 / 无权限）就只剩字面量。
 * 必须用 `fs.promises.realpath`（原生 realpath(3)，会规整大小写）；同步的 JS 版 `realpathSync` 不规整大小写。
 */
const withRealpaths = async (paths: string[]): Promise<string[]> => {
  const out = new Set<string>();
  for (const p of paths) {
    const abs = path.resolve(p);
    out.add(abs);
    try {
      out.add(await fs.realpath(abs));
    } catch {
      // 目录不存在 / 无权限：没有进程能把 cwd 放在不存在的目录里，字面量足够
    }
  }
  return [...out];
};

/** child 是否在 parent 目录内（含等于） */
const isUnder = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  // 只有「恰好是 ..」或「以 ../ 开头」才是跑到外面；`..cache` 这种以点点开头的普通子目录名不算
  return (
    rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  );
};

const isUnderAny = (child: string, parents: string[]): boolean =>
  parents.some((p) => isUnder(child, p));

/**
 * pid 的父进程链上是否含 ancestorPid（不含自身）。
 * 带环 / 超深保护：最多走 64 层，走到 pid<=1 或找不到父进程即停。
 */
const hasAncestor = (
  pid: number,
  ancestorPid: number,
  parentOf: Map<number, number>,
): boolean => {
  let cur = parentOf.get(pid);
  for (let depth = 0; cur !== undefined && cur > 1 && depth < 64; depth++) {
    if (cur === ancestorPid) return true;
    cur = parentOf.get(cur);
  }
  return false;
};

/** 从 root 收集整棵子树的 pid（含 root 本身） */
const collectSubtree = (
  root: number,
  childrenMap: Map<number, number[]>,
): number[] => {
  const out: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    out.push(pid);
    for (const c of childrenMap.get(pid) ?? []) stack.push(c);
  }
  return out;
};

/**
 * 扫描并杀掉落在工作目录里的孤儿 / agent-shell 进程树。best-effort、不抛。
 * @param workDirs agent 实际 cwd 列表（隔离任务传 worktree 路径，见 reapTaskOrphans 调用方）
 */
const killOrphansInRepos = async (
  workDirs: string[],
): Promise<void> => {
  // Windows：没有 ps / lsof、这套「按 cwd 扫孤儿」实施不了——直接跳过、
  // 不让每次停止任务都白跑 + 打 error 日志（本保护本就 best-effort、
  // Windows 端 agent 子进程树最终由壳退出时 taskkill /T 兜底）
  if (process.platform === "win32") return;
  if (!workDirs || workDirs.length === 0) return;
  const repos = workDirs.map((p) => path.resolve(p));
  const selfPid = process.pid;

  try {
    const procs = await listProcesses();

    // ppid → children，供收子树用；pid → ppid，供查祖先链
    const childrenMap = new Map<number, number[]>();
    const parentOf = new Map<number, number>();
    for (const p of procs) {
      parentOf.set(p.pid, p.ppid);
      const arr = childrenMap.get(p.ppid);
      if (arr) arr.push(p.pid);
      else childrenMap.set(p.ppid, [p.pid]);
    }

    // 候选 root（排除自己 / init）：
    //  a. 带 agent shell 签名 **且** 是本 Flowship 的（祖先链含本 server 进程 / 已 orphan ppid=1）——
    //     不满足的（如用户 Cursor IDE 在同目录自己起的 agent shell）一律不碰（S06-01）；
    //  b. 已 orphan(ppid=1)且像构建/脚本进程——无任何「Flowship 拉起」证据、
    //     下面还要额外要求 cwd 在 worktree 根下才算数（N10-03）。
    const isSignatureOwned = (p: ProcInfo): boolean =>
      p.command.includes(AGENT_SHELL_SIGNATURE) &&
      (p.ppid === 1 || hasAncestor(p.pid, selfPid, parentOf));
    const isHintedOrphan = (p: ProcInfo): boolean =>
      p.ppid === 1 && ORPHAN_CMD_HINT.test(p.command);
    const candidates = procs.filter(
      (p) =>
        p.pid !== selfPid &&
        p.pid > 1 &&
        (isSignatureOwned(p) || isHintedOrphan(p)),
    );
    if (candidates.length === 0) return;

    // worktree 根在这里现算（读 dataRoot 的环境变量、不缓存）：2.5s 后的二次扫也走同一口径。
    // 放进 try 里——取不到就整次放弃（漏杀），而不是退化成「到处都能杀」。
    const worktreesRoots = await withRealpaths([
      path.join(dataRoot(), "worktrees"),
    ]);
    // lsof 报的是 realpath，作用域两边都要有真实路径形态（见 withRealpaths）
    const repoScopes = await withRealpaths(repos);

    // 取候选的 cwd：先要落在任一 workDir 内（限定作用域）；
    // 无签名证据的 b 候选再额外要求 cwd 在 worktree 根下（原仓里的孤儿 node 不碰）。
    // 同时满足 a 的按 a 论（签名 + 归属已经是足够的证据），不受 worktree 根限制。
    const cwds = await getCwds(candidates.map((p) => p.pid));
    const roots = candidates.filter((p) => {
      const cwd = cwds.get(p.pid);
      if (!cwd || !isUnderAny(cwd, repoScopes)) return false;
      return isSignatureOwned(p) || isUnderAny(cwd, worktreesRoots);
    });
    if (roots.length === 0) return;

    // 命中 root 连子树一起收（catch 住 npm/ng 等还没 reparent 的子进程）
    const victims = new Set<number>();
    for (const r of roots) {
      for (const pid of collectSubtree(r.pid, childrenMap)) {
        if (pid !== selfPid && pid > 1) victims.add(pid);
      }
    }
    if (victims.size === 0) return;

    console.log(
      `[kill-orphans] 清理孤儿进程 ${victims.size} 个（repoPaths=${repos.join(", ")}）：${[...victims].join(" ")}`,
    );
    for (const pid of victims) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已退出 / 无权限、忽略
      }
    }
  } catch (err) {
    console.error("[kill-orphans] 扫描/清理失败（忽略）", err);
  }
};

/** 仅供单测：直接 await 一次扫描（生产走 reapTaskOrphans fire-and-forget） */
export const __killOrphansInReposForTest = killOrphansInRepos;

export interface ReapTaskOrphansOptions {
  /**
   * 是否在 2.5s 后再扫一次（默认 true）。
   * 真正 stop / finally 收尾保持二次扫，接住延迟 reparent；
   * resume / 换新 agent 路径传 false——只做即时扫，避免二次扫误杀新 agent 刚拉的 shell。
   */
  delayedRescan?: boolean;
}

/**
 * 停止时调：立即扫一次；默认 2.5s 后再扫一次。
 * 第二次为了接住「run.cancel() 后 agent 才慢慢死、子进程刚 reparent 到 init」的漏网。
 * fire-and-forget、调用方 `void` 即可。
 *
 * @param workDirs 应传 agent 实际工作目录（`getTaskWorkRepoPaths(task)`），勿传裸 `task.repoPaths`
 * @param options.delayedRescan 默认 true；换新 agent / resume 传 false 跳过二次扫
 */
export const reapTaskOrphans = (
  workDirs: string[],
  options: ReapTaskOrphansOptions = {},
): void => {
  const delayedRescan = options.delayedRescan !== false;
  void killOrphansInRepos(workDirs);
  if (!delayedRescan) return;
  // unref：别让这 2.5s 定时器拖住进程退出（测试环境 mock 可能无 unref）
  setTimeout(() => {
    void killOrphansInRepos(workDirs);
  }, 2500).unref?.();
};

// ----------------- 长驻子进程登记（飞书桥接 event consume 等） -----------------

/**
 * 进程级登记表：server 退出时统一优雅停掉，避免 lark-cli consumer 漏退订。
 * 挂 globalThis 防 dev HMR 丢引用。
 */
type ManagedChildEntry = {
  label: string;
  /** 优雅停止（stdin EOF / SIGTERM）；勿 kill -9 */
  stop: () => Promise<void> | void;
};

const MANAGED_KEY = "__flowshipManagedChildrenV1__";

const getManagedMap = (): Map<string, ManagedChildEntry> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, ManagedChildEntry> | undefined
  >;
  if (!g[MANAGED_KEY]) g[MANAGED_KEY] = new Map();
  return g[MANAGED_KEY]!;
};

/** 登记长驻子进程（幂等按 id 覆盖） */
export const registerManagedChild = (
  id: string,
  entry: ManagedChildEntry,
): void => {
  getManagedMap().set(id, entry);
};

/** 注销（子进程已自行退出时调） */
export const unregisterManagedChild = (id: string): void => {
  getManagedMap().delete(id);
};

/** server 退出前：停掉所有登记的长驻子进程（best-effort） */
export const stopAllManagedChildren = async (): Promise<void> => {
  const map = getManagedMap();
  const entries = [...map.entries()];
  map.clear();
  await Promise.all(
    entries.map(async ([id, e]) => {
      try {
        await e.stop();
      } catch (err) {
        console.warn(
          `[kill-orphans] 停止托管子进程失败 id=${id} label=${e.label}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
};

// ----------------- 二进制占用方登记（Windows 覆盖安装用） -----------------

/**
 * Windows 不能覆盖正在运行的 exe：安装/升级前先优雅停掉占用方、装完再拉起。
 * 占用方（飞书桥接 consumers）在 inbound.ts 登记；安装链（feishu-cli.ts）调用。
 * 放这里是因为双方都已依赖本模块（本文件零 import），无循环 import 风险。
 */
export const LARK_CLI_BINARY_USER = "lark-cli";
export const MEEGLE_BINARY_USER = "meegle";

export type BinaryUserHooks = {
  /**
   * 优雅停掉所有占用该二进制的常驻进程，返回已停标识（供日志）。
   * 抛错 → 安装链 abort（旧版本不受损）；调用方必须 finally resume 复位 hold。
   */
  suspend: () => Promise<string[]>;
  /** 重拉占用进程（新二进制生效；失败只 warn、30s 轮询会再兜） */
  resume: () => Promise<void>;
};

const BINARY_USERS_KEY = "__flowshipBinaryUsersV1__";

const getBinaryUsersMap = (): Map<string, BinaryUserHooks> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, BinaryUserHooks> | undefined
  >;
  if (!g[BINARY_USERS_KEY]) g[BINARY_USERS_KEY] = new Map();
  return g[BINARY_USERS_KEY]!;
};

/** 占用方登记（模块加载时一次，幂等按名覆盖） */
export const registerBinaryUser = (
  binName: string,
  hooks: BinaryUserHooks,
): void => {
  getBinaryUsersMap().set(binName, hooks);
};

/** 单测清理（生产只注册不注销） */
export const __clearBinaryUsersForTest = (): void => {
  getBinaryUsersMap().clear();
};

/**
 * 停掉占用方（未登记 = 无常驻占用，直接过，返回空）。
 * suspend 抛错 → 调用方必须 abort 安装并 finally resume（复位 hold）。
 */
export const suspendBinaryUsers = async (
  binName: string,
): Promise<string[]> => {
  const hooks = getBinaryUsersMap().get(binName);
  if (!hooks) return [];
  return hooks.suspend();
};

/**
 * 重拉占用方（best-effort：失败只 warn，轮询/下次 sync 会再兜）。
 * 二进制已替换，resume 失败不回滚、不抛。
 */
export const resumeBinaryUsers = async (binName: string): Promise<void> => {
  const hooks = getBinaryUsersMap().get(binName);
  if (!hooks) return;
  try {
    await hooks.resume();
  } catch (err) {
    console.warn(
      `[kill-orphans] 重拉二进制占用方失败 bin=${binName}（轮询会再兜）:`,
      err instanceof Error ? err.message : err,
    );
  }
};
