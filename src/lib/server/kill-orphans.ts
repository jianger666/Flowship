/**
 * 杀掉 agent 通过 shell 工具拉起、停止后没被回收的孤儿进程（V0.6.8）
 *
 * # 背景（一次真实事故）
 * ai-flow 的 agent 跑在 Cursor.app 底下的 `agent-exec`、**不是本服务器的子进程**。
 * 停止 task 时 `run.cancel()` 只能停 agent 本体、**杀不到 agent 用 shell 工具拉起的孙子进程**。
 * 典型事故：agent 在 build 里跑 `cd <repo> && npm run lint`、而该仓的 `lint` = `ng lint --fix=true`
 *（Angular 自动改写）；用户「停止」后 agent 死了、但这个 lint 子进程 reparent 到 init 继续 `--fix`
 * 整个仓库 → 代码仓库被「疯狂改写」。
 *
 * # 做法
 * 在停止 / 收尾时主动扫一遍系统进程、把满足以下条件的进程连同其子树一起 kill：
 *   - **cwd 落在本 task 的 repoPaths 里**（限定作用域、不波及无关仓库），且
 *   - 带 **Cursor agent shell 签名**（agent 的 shell 工具 wrapper、见下），或
 *   - 已 **orphan（ppid=1）**（父 agent 已死、reparent 到 init）
 *
 * 这样**不会误杀用户在自己终端里手动跑的 dev server / lint**——那些进程的父进程是用户的
 * shell（不是 init）、也没有 agent shell 签名。
 *
 * # 注意
 * - 仅 best-effort：失败只 log、不抛、不阻断停止流程。
 * - macOS / Linux 通用（依赖 `ps` + `lsof`）。
 * - **不要在 force-new-agent（换新 agent）场景调**——新 agent 会在同仓拉起带同样签名的 shell、
 *   会被误杀。调用方负责只在「真正停止 / 自然结束 / 报错」时调（见 task-runner stop 路径 + finally 守卫）。
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
// cwd 落在 repoPaths 的二次过滤仍在、这里只是减负 + 加一道保险。
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
 * 扫描并杀掉落在 repoPaths 里的孤儿 / agent-shell 进程树。best-effort、不抛。
 */
export const killOrphansInRepos = async (
  repoPaths: string[],
): Promise<void> => {
  if (!repoPaths || repoPaths.length === 0) return;
  const repos = repoPaths.map((p) => path.resolve(p));
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

/**
 * 停止时调：立即扫一次 + 2.5s 后再扫一次。
 * 第二次为了接住「run.cancel() 后 agent 才慢慢死、子进程刚 reparent 到 init」的漏网。
 * fire-and-forget、调用方 `void` 即可。
 */
export const reapTaskOrphans = (repoPaths: string[]): void => {
  void killOrphansInRepos(repoPaths);
  setTimeout(() => {
    void killOrphansInRepos(repoPaths);
  }, 2500);
};
