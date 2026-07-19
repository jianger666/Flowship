/**
 * Windows Agent shell：把 process.env.SHELL 指到 Git Bash，绕开 SDK PowerShell 执行器
 *
 * 背景：Cursor SDK 在 Windows 上默认走 PowerShell，有官方已认的「命令结束检测失败→挂死 /
 * 输出为空」bug。SDK 选壳逻辑优先读 process.env.SHELL，若指向 Git Bash 的 bash.exe
 *（路径匹配 /git.*bash\.exe$/i）就改走 Bash 执行器。本模块探测 git-bash 路径并按设置项
 * 写入 SHELL；Agent.create 是本进程子进程，会继承。
 *
 * ⚠️ SDK 选壳器与 Bash 执行器是两套逻辑（v1.1.18 线上事故）：选壳器读 SHELL，但 win32
 * 下 Bash 执行器只靠 userTerminalHint / PATH 里 `where bash` 找 `/git.*bash/i`——装 Git
 * 默认只把 `Git\cmd` 加进 PATH（无 bash.exe），只写 SHELL 会选中 Bash 执行器却抛
 * `Can't find Bash`，工具调用永不结束。因此开关打开时必须同时把 `Git\bin` 前置进 PATH。
 *
 * ⚠️ 同步顺序（v1.1.19）：所有异步验证在改环境之前完成——先验绝对路径可启动、
 * 再在候选 PATH（不写 process.env）上 where bash 链校验，两项都过才同步一次性提交
 * PATH+SHELL。旧实现「注入后再 where」在最多 5s 窗口里把临时环境暴露给并发 agent。
 *
 * ⚠️ 跨 bundle 共享状态（v1.1.19）：production build 里 instrumentation 与
 * settings route 各自打出一份 agent-shell 模块实例。ORIGINAL_SHELL / injectedBinDir 若
 * 仍 module-local，关开关时 settings 实例会把「已注入的 Git Bash」当原始值恢复、PATH
 * 清理因 injectedBinDir=null 变成 noop。三样状态必须挂同一 globalThis 对象。
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { readSettingsFile } from "@/lib/server/settings-fs";

const execFileAsync = promisify(execFile);

/** 子进程探测超时——reg / where 挂起时别拖死启动 / 设置保存 */
const EXEC_TIMEOUT_MS = 5_000;

/** 探测结果缓存 TTL（设置页开一次探一轮、别每次开关都扫盘） */
const DETECT_CACHE_TTL_MS = 60_000;

/**
 * 与 SDK Bash 执行器同款：PATH 里 `where bash` 的命中必须像 Git Bash 路径。
 * 光验绝对路径可启动不够——WSL 的 System32\bash.exe 也能启动，但不被 SDK 认。
 */
const GIT_BASH_PATH_RE = /git.*bash/i;

/**
 * 跨 webpack chunk 共享的环境状态。
 * production build 里 instrumentation / settings route 各有一份模块实例，
 * module-local 的 ORIGINAL_SHELL / injectedBinDir 互不可见。
 */
const AGENT_SHELL_STATE_KEY = "__feAiFlowAgentShellStateV1__";

type AgentShellGlobalState = {
  /**
   * 是否已捕获进程启动时的 SHELL。
   * 与 originalShell===undefined 区分：后者语义是「启动时就没有 SHELL」，
   * 不能再用 undefined 双关「尚未捕获」。
   */
  originalShellCaptured: boolean;
  /** 首次 sync 时捕获的原始 SHELL；undefined = 启动时本就没有 */
  originalShell: string | undefined;
  /**
   * 本程序在 PATH 首位新增的那一段 Git Bash bin 目录。
   * null = 当前没有由我们新增（关开关只删这一条首位新增段，不动用户原有同名段）。
   */
  injectedBinDir: string | null;
  /** apply 串行链——启动 fire-and-forget 与设置 PUT 共用 */
  applyChain: Promise<void>;
};

const getAgentShellState = (): AgentShellGlobalState => {
  const g = globalThis as unknown as Record<
    string,
    AgentShellGlobalState | undefined
  >;
  if (!g[AGENT_SHELL_STATE_KEY]) {
    g[AGENT_SHELL_STATE_KEY] = {
      originalShellCaptured: false,
      originalShell: undefined,
      injectedBinDir: null,
      applyChain: Promise.resolve(),
    };
  }
  return g[AGENT_SHELL_STATE_KEY]!;
};

/**
 * 首次真正需要时捕获一次原始 SHELL，之后永不覆盖。
 * 不能用模块顶层 const——第二个 bundle 实例加载时 SHELL 可能已被第一个改过。
 */
const ensureOriginalShellCaptured = (): void => {
  const state = getAgentShellState();
  if (state.originalShellCaptured) return;
  state.originalShell = process.env.SHELL;
  state.originalShellCaptured = true;
};

type DetectCache = { at: number; path: string | null };

let detectCache: DetectCache | null = null;

/**
 * 从 git.exe 位置推导同安装根下的 bash.exe（可单测纯函数）。
 * 覆盖 Git for Windows 三种常见布局；不认识的路径返 null。
 */
export const deriveBashFromGitExe = (gitExePath: string): string | null => {
  const trimmed = gitExePath.trim();
  if (!trimmed) return null;
  // 统一用 win32 语义拼路径——单测可能在 mac 上跑、不能跟当前平台 path 走
  const normalized = path.win32.normalize(trimmed.replace(/\//g, "\\"));
  const baseName = path.win32.basename(normalized).toLowerCase();
  if (baseName !== "git.exe" && baseName !== "git") return null;

  const dir = path.win32.dirname(normalized);
  const dirBase = path.win32.basename(dir).toLowerCase();

  // <root>\cmd\git.exe → <root>\bin\bash.exe
  if (dirBase === "cmd") {
    return path.win32.join(path.win32.dirname(dir), "bin", "bash.exe");
  }

  if (dirBase === "bin") {
    const parent = path.win32.dirname(dir);
    const parentBase = path.win32.basename(parent).toLowerCase();
    // <root>\mingw64\bin\git.exe（或 mingw32）→ <root>\bin\bash.exe
    if (parentBase === "mingw64" || parentBase === "mingw32") {
      return path.win32.join(path.win32.dirname(parent), "bin", "bash.exe");
    }
    // <root>\bin\git.exe → <root>\bin\bash.exe
    return path.win32.join(dir, "bash.exe");
  }

  return null;
};

/** fs.access 验证文件存在且可读；失败返 null */
const accessOrNull = async (absPath: string): Promise<string | null> => {
  try {
    await fs.access(absPath);
    return absPath;
  } catch {
    return null;
  }
};

/** 解析 `reg query ... /v InstallPath` 的 REG_SZ 值 */
const parseRegInstallPath = (stdout: string): string | null => {
  const m = stdout.match(/InstallPath\s+REG_\w+\s+(.+)/i);
  const value = m?.[1]?.trim();
  return value || null;
};

/** 注册表 GitForWindows InstallPath → bin\bash.exe */
const detectViaRegistry = async (): Promise<string | null> => {
  const hives = [
    "HKLM\\SOFTWARE\\GitForWindows",
    "HKCU\\SOFTWARE\\GitForWindows",
  ];
  for (const hive of hives) {
    try {
      const { stdout } = await execFileAsync(
        "reg",
        ["query", hive, "/v", "InstallPath"],
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
      );
      const installPath = parseRegInstallPath(stdout);
      if (!installPath) continue;
      const bash = path.win32.join(installPath, "bin", "bash.exe");
      const hit = await accessOrNull(bash);
      if (hit) return hit;
    } catch {
      // 该 hive 无键 / 超时 / reg 失败 → 试下一层
    }
  }
  return null;
};

/** `where git.exe` 第一条 → deriveBashFromGitExe → access */
const detectViaWhere = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("where", ["git.exe"], {
      timeout: EXEC_TIMEOUT_MS,
      windowsHide: true,
    });
    const first = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!first) return null;
    const bash = deriveBashFromGitExe(first);
    if (!bash) return null;
    return accessOrNull(bash);
  } catch {
    return null;
  }
};

/** 常规安装路径兜底（含用户级 LocalAppData） */
const detectViaWellKnownPaths = async (): Promise<string | null> => {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    path.win32.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
  ];
  for (const candidate of candidates) {
    const hit = await accessOrNull(candidate);
    if (hit) return hit;
  }
  return null;
};

export type DetectGitBashOptions = {
  /**
   * 强制旁路缓存重探。设置开关打开时用——负缓存（path: null）会挡住
   * 「刚装完 Git 立刻开开关」的场景（审查修复）。
   */
  bypassCache?: boolean;
};

/**
 * 探测本机 Git Bash（bash.exe）路径。
 * 仅 win32 有动作；结果缓存 60s（含失败负缓存）。按 注册表 → where → 常规路径 顺序命中即返。
 */
export const detectGitBashPath = async (
  options: DetectGitBashOptions = {},
): Promise<string | null> => {
  if (process.platform !== "win32") return null;

  const now = Date.now();
  if (
    !options.bypassCache &&
    detectCache &&
    now - detectCache.at < DETECT_CACHE_TTL_MS
  ) {
    return detectCache.path;
  }

  let found: string | null = null;
  found = await detectViaRegistry();
  if (!found) found = await detectViaWhere();
  if (!found) found = await detectViaWellKnownPaths();

  detectCache = { at: now, path: found };
  return found;
};

/** 恢复首次捕获的原始 SHELL（原本没有就删掉，避免残留空串） */
const restoreOriginalShell = (): void => {
  ensureOriginalShellCaptured();
  const state = getAgentShellState();
  if (state.originalShell === undefined) {
    delete process.env.SHELL;
  } else {
    process.env.SHELL = state.originalShell;
  }
};

/**
 * PATH 分隔符固定用 win32 的 `;`。
 * 本模块只服务 Windows Agent shell；若跟宿主 path.delimiter 走，mac 单测会把
 * `C:\...` 盘符里的冒号拆碎（v1.1.18 修复单测踩过）。
 */
const WIN_PATH_DELIM = path.win32.delimiter;

/**
 * Windows PATH 段相等：大小写不敏感 + 尾部斜杠归一化。
 * `C:\Git\bin\` == `c:\git\bin`。
 */
const pathSegmentEquals = (a: string, b: string): boolean => {
  const norm = (s: string) =>
    s.trim().replace(/[/\\]+$/g, "").toLowerCase();
  return norm(a) === norm(b);
};

/**
 * 从 PATH 段列表里删掉「第一个」与 target 相等的段（Windows 语义比较）。
 * 用于卸掉我们新增的那一条首位段——不能 filter 全删，用户后部同名段必须留。
 */
const removeFirstMatchingSegment = (
  parts: string[],
  target: string,
): string[] => {
  const idx = parts.findIndex((p) => pathSegmentEquals(p, target));
  if (idx === -1) return parts;
  return [...parts.slice(0, idx), ...parts.slice(idx + 1)];
};

/**
 * 构造「把 binDir 前置进 basePath」的候选 PATH 字符串，不写 process.env。
 * 仅当首段已是目标 binDir 时 noop；后部已有同目录仍要再前置一段，
 * 否则 where 会先命中 System32\WSL bash，造成安全但不必要的功能失败。
 */
const buildCandidatePath = (
  binDir: string,
  basePath: string,
): string => {
  const parts = basePath ? basePath.split(WIN_PATH_DELIM) : [];
  if (parts.length > 0 && pathSegmentEquals(parts[0]!, binDir)) {
    return basePath;
  }
  if (!basePath) return binDir;
  return `${binDir}${WIN_PATH_DELIM}${basePath}`;
};

/**
 * 为 where 预检构造候选 PATH：若将换安装路径，先从当前 PATH 模拟卸掉旧注入段
 * （只删第一个匹配 = 我们新增的那条），再前置新 binDir——全程不碰 process.env。
 */
const buildCandidatePathForSync = (binDir: string): string => {
  const state = getAgentShellState();
  let base = process.env.PATH ?? "";
  if (
    state.injectedBinDir !== null &&
    !pathSegmentEquals(state.injectedBinDir, binDir)
  ) {
    base = removeFirstMatchingSegment(
      base.split(WIN_PATH_DELIM),
      state.injectedBinDir,
    ).join(WIN_PATH_DELIM);
  }
  return buildCandidatePath(binDir, base);
};

/**
 * 把 Git Bash 的 bin 目录前置进 PATH（幂等）。
 * 仅首段已是目标时 noop；否则在首位新增一段（不删/不移用户原有同名段）。
 * 真正新增时记下 injectedBinDir——关开关只删这一条新增段。
 */
export const injectGitBashBinToPath = (binDir: string): void => {
  const state = getAgentShellState();
  const cur = process.env.PATH ?? "";
  const parts = cur ? cur.split(WIN_PATH_DELIM) : [];
  // 首段已是目标 → 无需再插；已注入时标记保留，用户自带时标记仍为 null
  if (parts.length > 0 && pathSegmentEquals(parts[0]!, binDir)) return;
  process.env.PATH = cur
    ? `${binDir}${WIN_PATH_DELIM}${cur}`
    : binDir;
  state.injectedBinDir = binDir;
};

/**
 * 仅移除本模块在首位新增的那一条 bin 段。
 * 用「删第一个匹配段」而非 filter 全删——用户 PATH 后部同名段必须保留。
 * injectedBinDir 为 null 时 noop。
 */
export const removeInjectedGitBashBinFromPath = (): void => {
  const state = getAgentShellState();
  if (state.injectedBinDir === null) return;
  const dir = state.injectedBinDir;
  const cur = process.env.PATH ?? "";
  const parts = cur ? cur.split(WIN_PATH_DELIM) : [];
  process.env.PATH = removeFirstMatchingSegment(parts, dir).join(
    WIN_PATH_DELIM,
  );
  state.injectedBinDir = null;
};

/**
 * 最小自检：真能拉起 bash 才算成功，防「SHELL/PATH 写了但执行器仍挂」的假成功。
 * 失败不抛——调用方回滚后继续用 PowerShell。
 */
export const verifyGitBashRunnable = async (
  gitBash: string,
): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync(
      gitBash,
      ["-c", "echo __shell_ok__"],
      { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
    );
    return String(stdout).includes("__shell_ok__");
  } catch (err) {
    console.warn(
      "[agent-shell] Git Bash 自检失败:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
};

/** 自检实现可替换（单测 mock，避免真拉子进程） */
let verifyGitBashImpl: typeof verifyGitBashRunnable = verifyGitBashRunnable;

/**
 * 在候选 PATH 环境里跑 `where bash`，取 stdout 首个非空行。
 * 不改 process.env——预检用。失败 / 超时返 null。
 */
const resolveWhereBashFirstHit = async (
  candidatePath: string,
): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("where", ["bash"], {
      env: { ...process.env, PATH: candidatePath },
      timeout: EXEC_TIMEOUT_MS,
      windowsHide: true,
    });
    const first = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return first ?? null;
  } catch {
    return null;
  }
};

/** where bash 查找可替换（单测 mock；mac 上没有 where 命令） */
type WhereBashResolver = (
  candidatePath: string,
) => Promise<string | null>;

let resolveWhereBashImpl: WhereBashResolver = resolveWhereBashFirstHit;

/**
 * 在候选 PATH 上校验：SDK 会看到的第一个 bash 必须是 Git Bash。
 * 不匹配（如 WSL System32\bash.exe 排在前面）→ 失败。
 * 预检阶段调用——此时 process.env 尚未改写。
 */
const verifyWhereBashChain = async (
  candidatePath: string,
): Promise<boolean> => {
  const first = await resolveWhereBashImpl(candidatePath);
  if (!first) {
    console.warn(
      "[agent-shell] where bash 未命中（命令失败/超时/空输出），不提交环境改动",
    );
    return false;
  }
  if (!GIT_BASH_PATH_RE.test(first)) {
    console.warn(
      `[agent-shell] where bash 首个命中不是 Git Bash（${first}），不提交环境改动`,
    );
    return false;
  }
  return true;
};

/**
 * 预检全部通过后，同步一次性提交 PATH + SHELL（无 await 夹缝）。
 * 换安装路径时先卸旧再注新。
 */
const commitShellEnv = (gitBash: string, binDir: string): void => {
  const state = getAgentShellState();
  if (
    state.injectedBinDir !== null &&
    !pathSegmentEquals(state.injectedBinDir, binDir)
  ) {
    removeInjectedGitBashBinFromPath();
  }
  injectGitBashBinToPath(binDir);
  process.env.SHELL = gitBash;
};

/**
 * 按开关状态同步 SHELL + PATH（幂等、可单测）。
 *
 * 开启且有 bash 路径时的顺序（全部预检后再提交）：
 * ① 捕获原始 SHELL（仅首次）
 * ② 绝对路径自检（注入前主闸）
 * ③ 构造候选 PATH（不写 process.env）+ where bash 链校验
 * ④ 两项都过 → 同步一次性：卸旧注入 → 写 PATH → 写 SHELL
 * 任一预检失败 → 全局环境从未被本次改动；只走恢复分支清「上次开通过」的残留
 */
export const syncAgentShellEnv = async (
  enabled: boolean,
  gitBash: string | null,
): Promise<void> => {
  // 首次真正需要时捕获——第二个 bundle 实例加载时 SHELL 可能已被改过，不能顶层 const
  ensureOriginalShellCaptured();

  if (enabled && gitBash) {
    // win32 语义取 dirname——单测在 mac 上跑时 path.dirname 会把整段当文件名
    const binDir = path.win32.dirname(gitBash);

    // ① 先验：绝对路径能启动才继续
    const ok = await verifyGitBashImpl(gitBash);
    if (!ok) {
      console.warn(
        "[agent-shell] Git Bash 自检未通过，回滚 SHELL+PATH（退回 PowerShell）",
      );
      // 处理「之前开过、这次验证失败」的残留；本次尚未注入
      restoreOriginalShell();
      removeInjectedGitBashBinFromPath();
      return;
    }

    // ② 候选 PATH where 链校验（仍不写 process.env）
    const candidatePath = buildCandidatePathForSync(binDir);
    const whereOk = await verifyWhereBashChain(candidatePath);
    if (!whereOk) {
      // 本次从未改环境；清上次残留
      restoreOriginalShell();
      removeInjectedGitBashBinFromPath();
      return;
    }

    // ③ 同步一次性提交（无 await）
    commitShellEnv(gitBash, binDir);
    console.log(`[agent-shell] SHELL → Git Bash: ${gitBash}`);
    return;
  }

  if (enabled && !gitBash) {
    console.warn(
      "[agent-shell] 已开启「用 Git Bash」但未探测到 bash.exe，恢复原始 SHELL",
    );
  }

  restoreOriginalShell();
  removeInjectedGitBashBinFromPath();
};

/**
 * 把实际工作串到全局 promise 链上；前一次失败不阻断下一次。
 * 返回本次工作的 promise（调用方可 await 本次结果）。
 */
const enqueueApply = (fn: () => Promise<void>): Promise<void> => {
  const state = getAgentShellState();
  const next = state.applyChain.then(fn, fn);
  // 链本身吞掉 rejection，避免永久卡在 rejected 态挡后续
  state.applyChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
};

/** 测试用：替换 apply 实际工作体（验证串行链）；传 null 恢复默认 */
let applyWorkImpl: (() => Promise<void>) | null = null;

/**
 * 按设置项应用 / 恢复 process.env.SHELL + PATH（幂等、可反复调用）。
 * 仅 win32：agentShellGitBash === true 且探测到路径 → 写入；否则恢复启动时快照。
 * 并发调用（启动 fire-and-forget + 设置 PUT）经全局链串行，避免交错乱序。
 */
export const applyAgentShellPreference = (): Promise<void> =>
  enqueueApply(async () => {
    if (applyWorkImpl) {
      await applyWorkImpl();
      return;
    }
    if (process.platform !== "win32") return;

    const result = await readSettingsFile();
    const enabled =
      result.status === "ok" && result.settings.agentShellGitBash === true;

    if (enabled) {
      // 设置开关路径强制重探，避免吃到「未安装时」留下的 60s 负缓存
      const gitBash = await detectGitBashPath({ bypassCache: true });
      await syncAgentShellEnv(true, gitBash);
      return;
    }

    await syncAgentShellEnv(false, null);
  });

/** 测试用：清探测缓存（不导出给业务） */
export const __resetDetectCacheForTests = (): void => {
  detectCache = null;
};

/** 测试用：写入探测缓存（模拟负缓存 / 命中） */
export const __setDetectCacheForTests = (path: string | null): void => {
  detectCache = { at: Date.now(), path };
};

/** 测试用：读当前注入标记（跨 bundle 共享态） */
export const __getInjectedBinDirForTests = (): string | null =>
  getAgentShellState().injectedBinDir;

/** 测试用：只清注入标记（PATH 由用例 afterEach 自己还原） */
export const __resetInjectedBinDirForTests = (): void => {
  getAgentShellState().injectedBinDir = null;
};

/** 测试用：替换 / 恢复自检实现 */
export const __setVerifyGitBashForTests = (
  fn: typeof verifyGitBashRunnable | null,
): void => {
  verifyGitBashImpl = fn ?? verifyGitBashRunnable;
};

/** 测试用：替换 / 恢复 where bash 查找（接收候选 PATH；mac 无 where，单测必须 mock） */
export const __setWhereBashForTests = (
  fn: WhereBashResolver | null,
): void => {
  resolveWhereBashImpl = fn ?? resolveWhereBashFirstHit;
};

/** 测试用：替换 apply 工作体（验证串行）；传 null 恢复 */
export const __setApplyWorkForTests = (
  fn: (() => Promise<void>) | null,
): void => {
  applyWorkImpl = fn;
};

/** 测试用：重置 apply 串行链（避免用例间互相拖累） */
export const __resetApplyChainForTests = (): void => {
  getAgentShellState().applyChain = Promise.resolve();
};

/**
 * 测试用：清掉整个 globalThis 共享状态（含 originalShell 捕获标记）。
 * 双模块实例回归用例必须在 afterEach 调，避免污染后续用例。
 */
export const __resetAgentShellGlobalStateForTests = (): void => {
  const g = globalThis as unknown as Record<
    string,
    AgentShellGlobalState | undefined
  >;
  delete g[AGENT_SHELL_STATE_KEY];
};

/** 测试用：暴露状态 key（双实例用例 afterEach 直接 delete） */
export const __AGENT_SHELL_STATE_KEY_FOR_TESTS = AGENT_SHELL_STATE_KEY;
