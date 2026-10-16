/**
 * worktree 依赖准备的纯 IO 工具（从 task-worktrees.ts 拆出，便于单测）：
 *
 * - {@link discoverDepDirs}：要克隆哪些依赖目录（根目录白名单 + monorepo 子包的 node_modules）
 * - {@link detectLockfileDrift}：原仓库与 worktree 的锁文件是否一致（克隆来的依赖可能与任务分支不匹配）
 * - {@link rewriteBinShimPaths}：克隆后改写 `.bin` 里写死原仓库绝对路径的脚本（pnpm 的 shim）
 * - {@link runSetupCommand}：执行设置页配的「依赖初始化命令」（克隆不可用 / 没产出时的兜底）
 * - {@link summarizeDepDirs}：事件流里展示克隆结果的文案
 *
 * 这里不依赖 lease / ResourceJob（那些由 task-worktrees 编排）；只在需要时接 AbortSignal。
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { stripHostInjectedEnv } from "./host-env";
import { GITLAB_TOKEN_ENV_NAME } from "./git-token-env";

/**
 * 各生态「可安全整目录克隆」的依赖目录白名单（根目录级）：
 * - `node_modules`：JS/TS（npm / pnpm / yarn）
 * - `vendor`：PHP composer / Ruby bundler / Go vendor 模式
 * - `Pods`：iOS CocoaPods
 *
 * 明确**不在**白名单里：`.venv` / `venv`（shebang / activate 写死绝对路径、克隆过去是坏的）；
 * Java / Go module cache / .NET 走全局缓存、worktree 天然可用。
 */
export const ROOT_DEP_DIRS = ["node_modules", "vendor", "Pods"] as const;

/** monorepo 子包 node_modules 数量上限（防病态仓库把 clone 拖成几十个） */
const MAX_NESTED_DEP_DIRS = 64;
/** workspace 展开时访问目录总数上限 / 最大深度 */
const WORKSPACE_WALK_BUDGET = 3000;
const WORKSPACE_WALK_MAX_DEPTH = 5;
/** 展开 `**` 时不进入的目录名（node_modules / .git / 点目录另行排除） */
const WALK_SKIP_DIRS = new Set(["node_modules", "dist", "coverage"]);

/** 判存在（lstat：悬空软链也算存在，避免把它当「不存在」去覆盖） */
const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
};

// ----------------- monorepo workspace 展开 -----------------

/**
 * 解析 pnpm-workspace.yaml 的 `packages:` 列表（只认这一个键、不引 yaml 依赖）。
 * 支持块列表（`- 'apps/*'`）与行内数组（`packages: ['a', 'b']`）、忽略注释。
 */
export const parsePnpmWorkspaceYaml = (text: string): string[] => {
  const out: string[] = [];
  const unquote = (s: string): string =>
    s.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^packages\s*:\s*(.*)$/);
    if (!m) continue;
    const rest = m[1].replace(/\s+#.*$/, "").trim();
    if (rest.startsWith("[")) {
      const inner = rest.replace(/^\[/, "").replace(/\].*$/, "");
      for (const part of inner.split(",")) {
        const v = unquote(part);
        if (v) out.push(v);
      }
      return out;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\s*(#.*)?$/.test(l)) continue; // 空行 / 注释
      const item = l.match(/^\s+-\s*(.+?)\s*$/);
      if (!item) break; // 缩进列表结束（遇到新的顶层键）
      const v = unquote(item[1].replace(/\s+#.*$/, ""));
      if (v) out.push(v);
    }
    return out;
  }
  return out;
};

/** 读 monorepo 的 workspace 声明（package.json workspaces / pnpm-workspace.yaml / lerna.json），去重、去否定项 */
export const readWorkspacePatterns = async (
  repoPath: string,
): Promise<string[]> => {
  const raw: string[] = [];
  const pushArr = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) if (typeof x === "string") raw.push(x);
    }
  };
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(repoPath, "package.json"), "utf8"),
    ) as { workspaces?: unknown };
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) pushArr(ws);
    else if (ws && typeof ws === "object") {
      pushArr((ws as { packages?: unknown }).packages);
    }
  } catch {
    /* 没有 / 损坏的 package.json：当非 monorepo */
  }
  try {
    raw.push(
      ...parsePnpmWorkspaceYaml(
        await fs.readFile(path.join(repoPath, "pnpm-workspace.yaml"), "utf8"),
      ),
    );
  } catch {
    /* 没有 pnpm-workspace.yaml */
  }
  try {
    const lerna = JSON.parse(
      await fs.readFile(path.join(repoPath, "lerna.json"), "utf8"),
    ) as { packages?: unknown };
    pushArr(lerna.packages);
  } catch {
    /* 没有 lerna.json */
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    const norm = p
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    // 否定项 / 绝对路径 / 越界路径一律不碰
    if (!norm || norm.startsWith("!") || norm.startsWith("/")) continue;
    if (norm.split("/").includes("..")) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
};

/** 单段 glob（`*` / `?`）→ 正则；不含通配符的段走字面量分支、不会进到这里 */
const segToRegExp = (seg: string): RegExp =>
  new RegExp(
    `^${seg
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")}$`,
  );

const listChildDirs = async (absDir: string): Promise<string[]> => {
  try {
    const ents = await fs.readdir(absDir, { withFileTypes: true });
    return ents
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          !WALK_SKIP_DIRS.has(e.name),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
};

/**
 * 把 workspace 通配符展开成「含 package.json 的子包目录」（相对 repoPath、posix 分隔）。
 * 支持字面量段 / `*` / `?` / `**`；带访问预算与深度上限、不进 node_modules / 点目录。
 */
export const expandWorkspaceDirs = async (
  repoPath: string,
  patterns: string[],
): Promise<string[]> => {
  const out = new Set<string>();
  const budget = { n: WORKSPACE_WALK_BUDGET };

  const walk = async (
    relDir: string,
    segs: string[],
    depth: number,
  ): Promise<void> => {
    if (budget.n-- <= 0) return;
    const absDir = relDir ? path.join(repoPath, ...relDir.split("/")) : repoPath;
    if (segs.length === 0) {
      if (relDir && (await exists(path.join(absDir, "package.json")))) {
        out.add(relDir);
      }
      return;
    }
    const [seg, ...rest] = segs;
    const join = (child: string): string => (relDir ? `${relDir}/${child}` : child);
    if (seg === "**") {
      await walk(relDir, rest, depth); // `**` 匹配零层
      if (depth >= WORKSPACE_WALK_MAX_DEPTH) return;
      for (const child of await listChildDirs(absDir)) {
        await walk(join(child), segs, depth + 1);
      }
      return;
    }
    if (/[*?]/.test(seg)) {
      if (depth >= WORKSPACE_WALK_MAX_DEPTH) return;
      const re = segToRegExp(seg);
      for (const child of await listChildDirs(absDir)) {
        if (re.test(child)) await walk(join(child), rest, depth + 1);
      }
      return;
    }
    if (seg === "node_modules" || seg === ".git") return;
    await walk(join(seg), rest, depth + 1);
  };

  for (const p of patterns) {
    await walk("", p.split("/"), 0);
  }
  return [...out].sort();
};

/**
 * 原仓库里「值得克隆」的依赖目录清单（相对路径、posix 分隔）：
 * 根目录白名单（node_modules / vendor / Pods）在前，monorepo 子包的 `<pkg>/node_modules` 在后。
 *
 * 子包 node_modules 的必要性：yarn workspace 会把大多数依赖提升到根、但版本冲突的包留在子包里；
 * pnpm workspace 则每个子包的 node_modules 全是指向 .pnpm 的软链——不带过来子包直接起不来。
 */
export const discoverDepDirs = async (repoPath: string): Promise<string[]> => {
  const dirs: string[] = [];
  for (const d of ROOT_DEP_DIRS) {
    if (await exists(path.join(repoPath, d))) dirs.push(d);
  }
  const patterns = await readWorkspacePatterns(repoPath);
  if (patterns.length === 0) return dirs;
  const pkgDirs = await expandWorkspaceDirs(repoPath, patterns);
  let nested = 0;
  for (const rel of pkgDirs) {
    if (nested >= MAX_NESTED_DEP_DIRS) break;
    const nm = `${rel}/node_modules`;
    if (await exists(path.join(repoPath, ...nm.split("/")))) {
      dirs.push(nm);
      nested++;
    }
  }
  return dirs;
};

/** 事件流展示：根目录按名字、子包合并成「子包 node_modules ×N」 */
export const summarizeDepDirs = (dirs: string[]): string => {
  const root = dirs.filter((d) => !d.includes("/"));
  const nested = dirs.length - root.length;
  const parts = [...root];
  if (nested > 0) parts.push(`子包 node_modules ×${nested}`);
  return parts.join(" + ");
};

// ----------------- 锁文件漂移 -----------------

/** 与依赖目录对应的锁文件（根目录级）；两边都存在且内容不同才算漂移 */
const LOCKFILES = [
  "yarn.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "Gemfile.lock",
  "Podfile.lock",
] as const;

const hashFile = async (p: string): Promise<string> =>
  createHash("sha1").update(await fs.readFile(p)).digest("hex");

/**
 * 原仓库 vs worktree 的锁文件漂移：返回内容不一致的锁文件名。
 *
 * 为什么会漂移：克隆的是**原仓库当前检出分支**装好的依赖，而 worktree 检出的是任务基线分支——
 * 两个分支的锁文件不同时，克隆来的依赖可能缺包 / 版本不对。只有「两边都有这个文件」才比较
 * （一边缺失无法判断、不误报）。读失败静默当没漂移。
 */
export const detectLockfileDrift = async (
  repoPath: string,
  workDir: string,
): Promise<string[]> => {
  const drift: string[] = [];
  for (const name of LOCKFILES) {
    const a = path.join(repoPath, name);
    const b = path.join(workDir, name);
    try {
      const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
      if (!sa.isFile() || !sb.isFile()) continue;
      if (sa.size !== sb.size) {
        drift.push(name);
        continue;
      }
      const [ha, hb] = await Promise.all([hashFile(a), hashFile(b)]);
      if (ha !== hb) drift.push(name);
    } catch {
      /* 任一边不存在 / 读失败：不判漂移 */
    }
  }
  return drift;
};

// ----------------- .bin shim 路径改写 -----------------

const MAX_SHIM_BYTES = 256 * 1024;

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 把 `<nodeModulesDir>/.bin` 里写死的原仓库绝对路径改写成 worktree 路径。
 *
 * 动机：pnpm 生成的 `.bin/<cmd>` 是 shell 脚本、里面 `NODE_PATH="/原仓库/node_modules/.pnpm/…"`
 * 是安装时的绝对路径；克隆到 worktree 后仍指向原仓库——解析会悄悄读到原仓库的依赖。
 * npm / yarn 的 `.bin` 是相对软链（lstat 判软链后跳过）、不受影响。
 *
 * 只动 `.bin` 下的小文本文件；路径必须在边界处匹配（`/a/repo` 不会误伤 `/a/repo2`）。
 * 写回是对克隆文件的 copy-on-write、只破坏这几个小文件的块共享。
 * @returns 实际改写的文件数
 */
export const rewriteBinShimPaths = async (
  nodeModulesDir: string,
  fromRoots: string[],
  toRoot: string,
): Promise<number> => {
  const roots = [...new Set(fromRoots.filter((r) => r && r !== toRoot))].sort(
    (x, y) => y.length - x.length,
  );
  if (roots.length === 0) return 0;
  const binDir = path.join(nodeModulesDir, ".bin");
  let names: string[];
  try {
    names = await fs.readdir(binDir);
  } catch {
    return 0;
  }
  const re = new RegExp(
    `(?:${roots.map(escapeRegExp).join("|")})(?=[/\\\\"'\\s:;]|$)`,
    "g",
  );
  let changed = 0;
  for (const name of names) {
    const file = path.join(binDir, name);
    try {
      const st = await fs.lstat(file);
      if (!st.isFile() || st.size === 0 || st.size > MAX_SHIM_BYTES) continue;
      const buf = await fs.readFile(file);
      if (buf.includes(0)) continue; // 二进制
      const text = buf.toString("utf8");
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      re.lastIndex = 0;
      // 先删再写：保证落在新 inode 上、不会改到仍与原仓库共享的块
      const mode = st.mode & 0o777;
      await fs.rm(file, { force: true });
      // 函数替换：路径里若含 `$&` 之类序列不会被当成替换模式
      await fs.writeFile(file, text.replace(re, () => toRoot), { mode });
      changed++;
    } catch {
      /* 单个 shim 改写失败不挡整体：最差就是仍指向原仓库 */
    }
  }
  return changed;
};

// ----------------- 依赖初始化命令 -----------------

export interface SetupRunResult {
  ok: boolean;
  /** 退出码（被信号杀 / 超时为 null） */
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** 输出末尾（失败排查用、已限长） */
  tail: string;
}

const SETUP_OUTPUT_TAIL_BYTES = 2000;

/**
 * 超时 / abort 发出杀令后，等 `close` 的最长宽限（毫秒）。
 *
 * 为什么不能只等 `close`：`close` 要等 stdout/stderr 管道全部关闭，而孙进程（cmd.exe → yarn → node …）
 * 只要还活着就继续占着管道；Windows 上 `child.kill()` 只杀得到 cmd.exe，`exit` 早到了、`close` 永远不来，
 * 15 分钟超时形同虚设、整条依赖准备链（含 revoke join）被无限挂住。宽限一过就按「已终止」结算。
 */
const SETUP_KILL_SETTLE_GRACE_MS = 5000;

/** Windows 杀进程树的参数：`/T` 连子孙一起收、`/F` 强杀（与 wk-gate / preview-manager 的写法一致） */
export const buildTaskkillArgs = (pid: number): string[] => [
  "/PID",
  String(pid),
  "/T",
  "/F",
];

/** 默认的 Windows 树杀：taskkill 失败（命令不存在 / 进程已不在）时 reject，由调用方退回 child.kill */
const taskkillTree = (pid: number): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("taskkill", buildTaskkillArgs(pid), { windowsHide: true }, (err) =>
      err ? reject(err) : resolve(),
    );
  });

/**
 * 在 `cwd` 执行一条 shell 命令（设置页配的依赖初始化命令）。
 *
 * - env 走 {@link stripHostInjectedEnv} 清掉宿主注入变量，并摘掉 GitLab token（初始化命令不该拿到它）；
 *   额外注入 `ROOT_WORKTREE_PATH`（原仓库路径，对齐 Cursor worktrees.json 的同名变量）
 * - POSIX 下独立进程组、超时 / abort 时整组杀（yarn / npm 会再起子进程，只杀 sh 会漏）
 * - Windows 没有负号进程组语义：超时 / abort 用 `taskkill /T /F` 杀整棵树（失败才退回 `child.kill`）
 * - 任何平台：杀令发出后给 {@link SETUP_KILL_SETTLE_GRACE_MS} 宽限，close 没来就按「已终止」结算
 * - 命令来自设置页（服务端 config.json 权威源），不是任务 / 仓库里的文件
 */
export const runSetupCommand = (
  command: string,
  cwd: string,
  opts: {
    rootWorktreePath: string;
    timeoutMs: number;
    signal?: AbortSignal;
    /** 仅测试注入：假装在哪个平台（默认 process.platform）——mac 上才能覆盖 win32 分支的逻辑 */
    platform?: NodeJS.Platform;
    /** 仅测试注入：Windows 杀进程树的实现（默认 taskkill /T /F）；reject / 抛错 → 退回 child.kill */
    killWinTree?: (pid: number) => Promise<void> | void;
    /** 仅测试注入：杀令后等 close 的宽限（毫秒） */
    settleGraceMs?: number;
  },
): Promise<SetupRunResult> =>
  new Promise((resolve) => {
    const env = stripHostInjectedEnv();
    delete env[GITLAB_TOKEN_ENV_NAME];
    env.ROOT_WORKTREE_PATH = opts.rootWorktreePath;
    const isWin = (opts.platform ?? process.platform) === "win32";
    let tail = "";
    const onData = (chunk: Buffer): void => {
      tail = (tail + chunk.toString("utf8")).slice(-SETUP_OUTPUT_TAIL_BYTES);
    };
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWin,
      windowsHide: true,
    });
    const killDirectChild = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    };
    const killTree = (): void => {
      if (isWin) {
        // Windows 没有负号进程组语义：`child.kill()` 只杀得到 cmd.exe，孙进程（yarn / node …）照跑并占着管道。
        // 必须先 taskkill /T 收整棵树、不能先 child.kill——cmd.exe 一死，taskkill 按 PID 就找不到这棵树了；
        // taskkill 本身失败（命令缺失 / 进程已不在）才退回只杀直接子进程。
        const pid = child.pid;
        if (!pid) {
          killDirectChild();
          return;
        }
        try {
          void Promise.resolve((opts.killWinTree ?? taskkillTree)(pid)).catch(
            killDirectChild,
          );
        } catch {
          killDirectChild();
        }
        return;
      }
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        killDirectChild();
      }
    };
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    // 杀令发出后的兜底：close 迟迟不来（孙进程占着管道）就按「已终止」强制结算，
    // 否则 15 分钟超时 / revoke 中止都可能被一个杀不掉的孙进程无限挂住（F5-01）。
    const armSettleGrace = (): void => {
      if (graceTimer || settled) return;
      graceTimer = setTimeout(() => {
        // 主动销毁管道读端：不然这两个流还挂在事件循环上、孙进程活多久就拖多久
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(null);
      }, opts.settleGraceMs ?? SETUP_KILL_SETTLE_GRACE_MS);
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        ok: code === 0 && !timedOut && !aborted,
        code,
        timedOut,
        aborted,
        tail: tail.trim(),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      armSettleGrace();
    }, opts.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      killTree();
      armSettleGrace();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      tail = `${tail}\n${err.message}`.slice(-SETUP_OUTPUT_TAIL_BYTES);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
