/**
 * 杀掉 agent 通过 shell 工具拉起、停止后没被回收的孤儿进程（V0.6.8）
 *
 * # 背景（一次真实事故）
 * Flowship 的 agent 跑在 Cursor.app 底下的 `agent-exec`、**不是本服务器的子进程**。
 * 停止 task 时 `run.cancel()` 只能停 agent 本体、**杀不到 agent 用 shell 工具拉起的孙子进程**。
 * 典型事故：agent 在 build 里跑 `cd <repo> && npm run lint`、而该仓的 `lint` = `ng lint --fix=true`
 *（Angular 自动改写）；用户「停止」后 agent 死了、但这个 lint 子进程 reparent 到 init 继续 `--fix`
 * 整个仓库 → 代码仓库被「疯狂改写」。
 *
 * # 做法
 * 在停止 / 收尾时主动扫一遍系统进程、把满足以下条件的进程连同其子树一起 kill：
 *   - **cwd 落在调用方传入的工作目录里**（限定作用域、不波及无关仓库），且
 *   - 带 **Cursor agent shell 签名**（agent 的 shell 工具 wrapper、见下），或
 *   - 已 **orphan（ppid=1）**（父 agent 已死、reparent 到 init）
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
import { promisify } from "node:util";
import path from "node:path";

const execAsync = promisify(exec);

// Cursor agent 的 shell 工具跑命令时套的 wrapper 特征串（用户手动终端不会有这个）。
// 形如：/bin/zsh -c snap=$(command cat <&3); builtin unsetopt aliases ...
const AGENT_SHELL_SIGNATURE = "command cat <&3";

// orphan(ppid=1) 分支的命令白名单——macOS 下大量系统 daemon 也挂在 launchd(ppid=1) 下、
// 用这个把候选收窄到「构建 / 脚本 / shell」类、避免对几十个系统进程做 lsof（也防误伤）。
// cwd 落在工作目录的二次过滤仍在、这里只是减负 + 加一道保险。
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
    let cur = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) cur = Number(line.slice(1));
      else if (line.startsWith("n") && cur) result.set(cur, line.slice(1));
    }
  } catch {
    // 部分 pid 已退出会让 lsof 非零退出、忽略；已解析到的 cwd 仍有效
  }
  return result;
};

/** child 是否在 parent 目录内（含等于） */
const isUnder = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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

    // ppid → children，供收子树用
    const childrenMap = new Map<number, number[]>();
    for (const p of procs) {
      const arr = childrenMap.get(p.ppid);
      if (arr) arr.push(p.pid);
      else childrenMap.set(p.ppid, [p.pid]);
    }

    // 候选 root：带 agent shell 签名、或已 orphan(ppid=1)且像构建/脚本进程；排除自己 / init
    const candidates = procs.filter(
      (p) =>
        p.pid !== selfPid &&
        p.pid > 1 &&
        (p.command.includes(AGENT_SHELL_SIGNATURE) ||
          (p.ppid === 1 && ORPHAN_CMD_HINT.test(p.command))),
    );
    if (candidates.length === 0) return;

    // 取候选的 cwd、命中 = cwd 落在任一 repoPath 内
    const cwds = await getCwds(candidates.map((p) => p.pid));
    const roots = candidates.filter((p) => {
      const cwd = cwds.get(p.pid);
      return cwd ? repos.some((r) => isUnder(cwd, r)) : false;
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
