/**
 * R14 B5-2（Q10-01）测试基建：在真 git 上复现「`git worktree add` 被 SIGKILL」留下的半截检出。
 *
 * 复现手法（确定性，不靠文件多少碰运气）：仓里一个 `*.slowtxt` 文件挂了 smudge 过滤器，检出它时 `sleep 60`——
 * `git worktree add` 就卡在 checkout 阶段（此时 `<repo>/.git/worktrees/<n>/` 里已有 `locked=initializing` 与 `index.lock`）；
 * 等 `index.lock` 出现、冻结并杀掉整个进程组（先 SIGSTOP 再 SIGKILL，原因见 killGroup）；然后撤掉 smudge，之后所有 git 命令（含被测代码里的）不再卡。
 * 文件按字典序检出：`.gitattributes`、`a.txt` 先落盘，`slow.slowtxt` 卡住，`z.txt` 没来得及检出——所以残留里「有一部分、缺一部分」。
 *
 * 依赖 POSIX 进程组与 `sh`（`sleep` / `cat`）——Windows 上不可用，调用方须 skip（Windows 未验证，见 HANDOFF）。
 * 不 import 任何被测模块：判定残留的逻辑在这里独立实现（读文件、不复用产品代码），避免测试与实现互相“证明”。
 */
import { execFileSync, spawn } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const exists = async (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false,
  );

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: process.env }).trim();

/** git 命令是否成功（不关心输出） */
export const gitOk = (cwd: string, ...args: string[]): boolean => {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", env: process.env, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

/** 让 git 输出英文、不读用户全局 / 系统配置、不弹凭据提示（测试文件顶部调用，影响本 worker 内所有 git 子进程，含被测代码） */
export const hermeticGitEnv = (): void => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.LC_ALL = "C";
  process.env.LANG = "C";
};

/** 文件内容固定：a.txt / slow.slowtxt / z.txt（字典序 a < slow < z，slow 是被卡住的那个） */
export const REPO_FILES = {
  "a.txt": "a\n",
  "slow.slowtxt": "slow\n",
  "z.txt": "z\n",
} as const;

/** 造一个带「慢检出钩子」的主仓（main 分支、一个提交）；smudge 默认**未配置**（不卡），卡住由 {@link killAddMidCheckout} 临时打开 */
export const initRepoForHalfCheckout = async (repo: string): Promise<void> => {
  await fs.mkdir(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.local");
  git(repo, "config", "user.name", "t");
  await fs.writeFile(path.join(repo, ".gitattributes"), "*.slowtxt filter=slow\n");
  for (const [name, content] of Object.entries(REPO_FILES)) {
    await fs.writeFile(path.join(repo, name), content);
  }
  git(repo, "config", "filter.slow.clean", "cat");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
};

export interface KilledAdd {
  repo: string;
  workDir: string;
  branch: string;
  /** `<repo>/.git/worktrees/<n>`（git 起的名字，冲突时会带数字后缀，所以是反查出来的） */
  adminDir: string;
  /** `<adminDir>/locked` */
  lockFile: string;
}

/**
 * 在 `workDir` 上跑 `git worktree add`，卡在 checkout 阶段时 SIGKILL 整个进程组，返回残留态。
 * 返回前自检：`locked` 内容恰好是 `initializing`、`index.lock` 在、`.git` 指针在——任何一条不满足就抛，
 * 免得「没复现成功」的测试给出虚假的通过。
 *
 * @param opts.existingBranch true = 挂已有分支（`add <workDir> <branch>`）；缺省 = 新建分支（与 ensure 的 `-b --no-track` 同形）
 * @param opts.detach true = detached 预热的同形（`add --detach <workDir> <base>`，ensure 的 detached 预热就是这么建的）
 */
export const killAddMidCheckout = async (opts: {
  repo: string;
  workDir: string;
  branch: string;
  base?: string;
  existingBranch?: boolean;
  detach?: boolean;
}): Promise<KilledAdd> => {
  const { repo, workDir, branch } = opts;
  const base = opts.base ?? "main";
  const adminRoot = path.join(repo, ".git", "worktrees");
  const before = new Set<string>(await fs.readdir(adminRoot).catch(() => []));
  await fs.mkdir(path.dirname(workDir), { recursive: true });

  git(repo, "config", "filter.slow.smudge", "sleep 60; cat");
  const args = opts.detach
    ? ["worktree", "add", "--detach", workDir, base]
    : opts.existingBranch
      ? ["worktree", "add", workDir, branch]
      : ["worktree", "add", "--no-track", "-b", branch, workDir, base];
  const child = spawn("git", args, {
    cwd: repo,
    env: process.env,
    stdio: "ignore",
    detached: true, // 新进程组：下面 kill(-pid) 连同 smudge 的 sleep 一起杀
  });
  let exitNote = "";
  const exited = new Promise<void>((resolve) =>
    child.once("exit", (code, signal) => {
      exitNote = `code=${code} signal=${signal}`;
      resolve();
    }),
  );
  /**
   * 先 SIGSTOP 再 SIGKILL（顺序别改）。进程组里的父 git、checkout 子进程、smudge 的 sh / sleep 是被**逐个**投递信号的：
   * 只发 SIGKILL 时，机器很忙（16 个 yes 抢 CPU 的噪声压测里出现过一次）父 git 可能在「子已被杀、自己还没收到」的间隙里被调度到，
   * 然后按 git 自己的失败路径把登记目录和 `.git` 指针清掉（退出码 137、不是被信号杀死）——那就不是「被硬杀」的残留了。
   * 先 STOP 让所有成员都停在返回用户态之前，父就没有机会跑那段清理；已停止的进程收到 KILL 照样立即终止。
   * （真实的硬杀——整个 Electron 被 kill -9 / 断电——是父子同时消失，没有这个间隙；这里要复现的是后者。）
   */
  const killGroup = (): void => {
    for (const sig of ["SIGSTOP", "SIGKILL"] as const) {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        /* 已经没了 */
      }
    }
  };

  try {
    let adminDir = "";
    const deadline = Date.now() + 20_000;
    while (!adminDir && Date.now() < deadline) {
      const fresh = (await fs.readdir(adminRoot).catch(() => [])).filter((n) => !before.has(n));
      for (const n of fresh) {
        if (await exists(path.join(adminRoot, n, "index.lock"))) {
          adminDir = path.join(adminRoot, n);
          break;
        }
      }
      if (!adminDir) await sleep(20);
    }
    if (!adminDir) {
      throw new Error("复现失败：git worktree add 没有进入 checkout 阶段（index.lock 没出现）");
    }
    await sleep(80); // 让 .gitattributes / a.txt 先落盘
    killGroup();
    await exited;

    const lockFile = path.join(adminDir, "locked");
    let lockReadErr = "";
    const lockText = await fs.readFile(lockFile, "utf8").catch((e: NodeJS.ErrnoException) => {
      lockReadErr = String(e?.code ?? e);
      return null;
    });
    if (lockText === null || lockText.trim() !== "initializing") {
      // 诊断信息要能区分：登记目录被 git 自己清掉了（父 git 在被杀前自己退出）/ 读文件本身出错（句柄耗尽等）/ 别的
      throw new Error(
        `复现自检失败：locked 内容应是 initializing，实际 ${JSON.stringify(lockText)}` +
          `（读 locked：${lockReadErr || "成功"}；git worktree add 的退出：${exitNote}；` +
          `登记目录${(await exists(adminDir)) ? "还在" : "已被清掉"}；index.lock ${(await exists(path.join(adminDir, "index.lock"))) ? "在" : "不在"}）`,
      );
    }
    if (!(await exists(path.join(adminDir, "index.lock")))) {
      throw new Error("复现自检失败：被杀后 index.lock 应该还在");
    }
    if (!(await exists(path.join(workDir, ".git")))) {
      throw new Error("复现自检失败：工作目录里应该有 .git 指针");
    }
    return { repo, workDir, branch, adminDir, lockFile };
  } finally {
    killGroup(); // 任何异常都别留下 sleep 进程
    try {
      git(repo, "config", "--unset", "filter.slow.smudge");
    } catch {
      /* 没配过 */
    }
  }
};

/** 本 worker 里登记过、还没放行的 gate（见 {@link setGatedSmudge} / {@link openAllGates}） */
const pendingGates = new Set<string>();

/**
 * 让检出 `*.slowtxt` 卡在 gate 文件出现之前（smudge = 轮询 gate、出现后 `cat`）：
 * 用被测代码自己的 `git worktree add` 制造「add 正在进行」（不杀它）；测试往 gate 路径写个文件才放行——
 * 放行时机由测试精确控制、不依赖墙钟（高负载下也不会因为「add 提前跑完」变 flaky）。
 *
 * 防遗留孤儿进程（被测代码行为错误 / 用例超时时 finally 可能来不及执行，gate 就永远不会出现）有三层保险：
 * ① 脚本自带 30 秒上限，且 gate 所在目录没了（测试清理了临时目录）也立即放行；
 * ② 这里登记 gate，测试在 `afterEach` 里调 {@link openAllGates} 统一放行；
 * ③ 用例里等被测 promise 的地方用 {@link within} 加竞速超时。
 */
export const setGatedSmudge = (repo: string, gateFile: string): void => {
  pendingGates.add(gateFile);
  const dir = path.dirname(gateFile);
  // 一进 smudge 就写 `<gate>.reached`：git 是检出到 slow.slowtxt 时才**懒读取**这条配置的，
  // `locked` 出现时 add 可能还没读到——测试要在撤配置 / 改目录之前等这个标记（见 waitForGateReached）
  git(
    repo,
    "config",
    "filter.slow.smudge",
    `: > '${gateFile}.reached'; n=0; while [ ! -e '${gateFile}' ] && [ -d '${dir}' ] && [ $n -lt 600 ]; do sleep 0.05; n=$((n+1)); done; cat`,
  );
};

/** 等被 gate 卡住的 checkout 真的进入了 smudge（此后再改 / 撤 filter 配置不会影响这次 add） */
export const waitForGateReached = async (gateFile: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(`${gateFile}.reached`)) return;
    await sleep(20);
  }
  throw new Error("等不到 gate 被到达：checkout 没有进入 smudge");
};

/** 放行本 worker 里所有登记过的 gate（吞错：目录可能已被清理）。放在 `afterEach`：用例超时 / 中途失败也会执行 */
export const openAllGates = async (): Promise<void> => {
  const gates = [...pendingGates];
  pendingGates.clear();
  await Promise.all(gates.map((g) => fs.writeFile(g, "").catch(() => {})));
};

/** 给被测 promise 加竞速超时：被测代码行为错误时快速失败（而不是拖到用例超时、还留下卡住的 git 进程） */
export const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}：${ms}ms 内没有结果`)), ms)),
  ]);

/** 撤掉卡住的检出配置（之后新开的 checkout 不再卡；已经卡着的那次不受影响，要靠 gate 放行） */
export const clearSlowSmudge = (repo: string): void => {
  try {
    git(repo, "config", "--unset", "filter.slow.smudge");
  } catch {
    /* 没配过 */
  }
};

/**
 * 等某个仓的 `.git/worktrees/*` 里出现 mtime 距今不超过 `maxAgeMs` 的 `locked`（= 有一次**新的** add 进入了 checkout 阶段），
 * 返回 locked 文件路径。`maxAgeMs` 用来跳过测试里被 {@link ageLock} 拨老的旧残留锁。
 */
export const waitForFreshLock = async (
  repo: string,
  maxAgeMs = 60_000,
  timeoutMs = 20_000,
): Promise<string> => {
  const adminRoot = path.join(repo, ".git", "worktrees");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const n of await fs.readdir(adminRoot).catch(() => [])) {
      const lock = path.join(adminRoot, n, "locked");
      const st = await fs.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs < maxAgeMs) return lock;
    }
    await sleep(20);
  }
  throw new Error("等不到新的 locked：add 没有进入 checkout 阶段");
};

/** 等某个仓里出现任意 `locked`（不论新旧；仓里没有别的残留锁时用） */
export const waitForAnyLock = (repo: string, timeoutMs = 20_000): Promise<string> =>
  waitForFreshLock(repo, Number.POSITIVE_INFINITY, timeoutMs);

/** 把 `locked` 的 mtime 拨到 `ageMs` 毫秒之前（被测代码读真实 mtime，所以不用注入时钟） */
export const ageLock = async (lockFile: string, ageMs: number): Promise<void> => {
  const t = new Date(Date.now() - ageMs);
  await fs.utimes(lockFile, t, t);
};

export const readLocked = async (adminDir: string): Promise<string | null> =>
  fs.readFile(path.join(adminDir, "locked"), "utf8").catch(() => null);

/** 对最近的存在祖先取 realpath、再拼回不存在的尾段（macOS 的 /var → /private/var；目录已删时也能比较） */
export const realpathLoose = (p: string): string => {
  const tail: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
};

/** `git worktree list --porcelain` 里是否登记了这个目录（目录已删、登记还在也算） */
export const isRegistered = (repo: string, workDir: string): boolean => {
  const want = realpathLoose(workDir);
  return git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .some((p) => p === want || realpathLoose(p) === want);
};

export const branchTip = (repo: string, branch: string): string =>
  git(repo, "rev-parse", `refs/heads/${branch}`);

// ----------------- git 包装脚本（记录 argv / 模拟 unlock 失败） -----------------

export interface GitShim {
  /** 从安装起 git 被调用的全部命令行（每行一条，参数以空格连接；含测试自己的 git 调用，断言时按模式过滤） */
  calls: () => Promise<string[]>;
  /** 还原 PATH */
  restore: () => void;
}

/**
 * 在 PATH 最前面放一个 `git` 包装脚本：每次调用把 argv 追加到日志，再 exec 真 git。
 * `failUnlock`：`git worktree unlock …` 直接失败（exit 128），用来测「隔离成功、解锁失败」的二段式自愈。
 * 用完必须 restore()（afterEach），否则会污染同 worker 里后面的用例。
 */
export const installGitShim = async (
  dir: string,
  opts: { failUnlock?: boolean } = {},
): Promise<GitShim> => {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8", env: process.env }).trim();
  await fs.mkdir(dir, { recursive: true });
  const log = path.join(dir, "git-argv.log");
  const lines = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${log}"`,
    ...(opts.failUnlock
      ? [
          `case "$*" in *"worktree unlock"*) echo "fatal: simulated unlock failure" >&2; exit 128;; esac`,
        ]
      : []),
    `exec "${realGit}" "$@"`,
    "",
  ];
  const shim = path.join(dir, "git");
  await fs.writeFile(shim, lines.join("\n"), { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;
  return {
    calls: async () =>
      (await fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean),
    restore: () => {
      process.env.PATH = oldPath;
    },
  };
};
