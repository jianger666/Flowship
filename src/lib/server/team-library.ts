/**
 * 组共享库（team library）
 *
 * GitLab 仓作为团队 skill / action 分发中心 + 知识库镜像载体。
 * 对用户无感：地址内置代码、不进设置页；app 启动 fire-and-forget sync。
 *
 * 目录约定（远端仓）：
 *   skills/<skill名>/SKILL.md [+ .flowship-action.json]
 *   knowledge/  ← wk-knowledgebase 整库镜像
 *     skills/{global,frontend,...}/<工程>/<skill>/SKILL.md
 *
 * 本地：
 *   <dataRoot>/team-library/repo          ← 共享库 clone
 *   <dataRoot>/team-library/knowledge-src ← 知识库源缓存（仅 mirror 用）
 *   <dataRoot>/team-library.json          ← 可选覆盖配置
 *   <dataRoot>/team-library/skill-states.json ← team skill 启停状态（单一 owner = 本模块）
 *
 * token 不落盘也不进命令行：clone/fetch/push 一律用干净 URL + inline credential helper、
 * token 经 env（TL_GIT_TOKEN）传给 helper——.git/config、FETCH_HEAD、ps 命令行里都无凭据。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { ExportedActionMeta } from "./custom-action-fs";
import {
  listCustomActions,
  parseFlowshipActionMeta,
} from "./custom-action-fs";
import { dataRoot } from "./data-root";
import { createMR } from "./gitlab-client";
import { getTeamSkillAuthors } from "./team-skill-authors";
import { readSettingsFile } from "./settings-fs";
import {
  getAppSkillsDir,
  parseSkillFile,
  scanSkillsDir,
  type SkillEntry,
} from "./skills-loader";
import { labelTeamSharedCategory } from "@/lib/types";
// 路径 + 白名单零依赖模块（skills-loader 也引、避免循环）；此处 re-export 保持对外 API
import {
  getTeamLibraryKnowledgeRoot,
  getTeamLibraryKnowledgeSkillsDir,
  getTeamLibrarySkillsDir,
  isSafeTeamSkillName,
  teamLibraryKnowledgeSrcDir,
  teamLibraryRepoDir,
  teamLibraryRoot,
} from "./team-library-paths";
import {
  readTeamSkillStates,
  readTeamSkillStatesForSync,
  writeTeamSkillStates,
  type TeamSkillState,
} from "./team-skill-states";

export {
  getTeamLibraryKnowledgeRoot,
  getTeamLibraryKnowledgeSkillsDir,
  getTeamLibrarySkillsDir,
  isSafeTeamSkillName,
  teamLibraryKnowledgeSrcDir,
  teamLibraryRepoDir,
  teamLibraryRoot,
};

const execFileAsync = promisify(execFile);

/** 内置默认配置（地址不进设置页 UI；正式仓 = 组内 action hub） */
export const DEFAULT_TEAM_LIBRARY = {
  repoUrl: "https://gitlab.wukongedu.net/frontend/infra/ai-flow-action-hub.git",
  branch: "main",
  knowledgeSourceUrl: "https://gitlab.wukongedu.net/wukong/wk-knowledgebase.git",
  knowledgeSourceBranch: "release/1.0",
} as const;

export type TeamLibraryConfig = {
  repoUrl: string;
  branch: string;
  knowledgeSourceUrl: string;
  knowledgeSourceBranch: string;
};

const overrideConfigPath = (): string =>
  path.join(dataRoot(), "team-library.json");

// ---------- globalThis 状态（防 route-chunk / HMR 分裂） ----------

const TEAM_LIB_STATE_KEY = "__flowshipTeamLibraryStateV1__";

type TeamLibState = {
  /** sync 进行中的单例 promise（防并发重入） */
  inFlight: Promise<{ ok: boolean; syncedAt?: number; error?: string }> | null;
  /** 最近一次成功 sync 的时间戳（内存、不落盘） */
  syncedAt: number | null;
};

const getTeamLibState = (): TeamLibState => {
  const g = globalThis as unknown as Record<string, TeamLibState | undefined>;
  if (!g[TEAM_LIB_STATE_KEY]) {
    g[TEAM_LIB_STATE_KEY] = { inFlight: null, syncedAt: null };
  }
  return g[TEAM_LIB_STATE_KEY]!;
};

// ---------- 纯函数（测试友好） ----------

/** 默认 + 覆盖文件字段合并（只认 string 字段、非法值忽略） */
export const mergeTeamLibraryConfig = (
  defaults: TeamLibraryConfig,
  override: unknown,
): TeamLibraryConfig => {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return { ...defaults };
  }
  const o = override as Record<string, unknown>;
  const pick = (key: keyof TeamLibraryConfig): string => {
    const v = o[key];
    return typeof v === "string" && v.trim() ? v.trim() : defaults[key];
  };
  return {
    repoUrl: pick("repoUrl"),
    branch: pick("branch"),
    knowledgeSourceUrl: pick("knowledgeSourceUrl"),
    knowledgeSourceBranch: pick("knowledgeSourceBranch"),
  };
};

/**
 * 团队流程核心 skill（UI「推荐」标 + 卸载时 toast 提醒用；
 * 2026-07-22 起默认策略改全量安装、本名单不再参与默认启停判定）
 */
export const KNOWLEDGE_GLOBAL_DEFAULT_ENABLED = [
  "requirement-analyzer",
  "wk-harness",
  "knowledge-base-qa",
] as const;

/**
 * 默认启停策略（2026-07-22 用户拍板「全量默认安装」）：
 * 对「还不在 skill-states 表里」（= 首次发现）的 team skill **一律默认 enabled**——
 * 用户不动 = 全都有（对齐 Codex / 领导库全量注入的心智、同步即全量可用）；
 * 动了 = 个性化（卸载单个 / 团队规范总开关一键隔离仍在）。
 * 实测全量注入 ≈ 1.5 万 tokens、成本可接受、换「用户零决策」。
 * 已在表里（known）的一律不动——用户改过的永不被策略覆盖。
 *
 * @returns 仅含新写入项的增量表（known 里的名字不出现）
 */
export const computeDefaultSkillStates = (input: {
  /** 每个 team skill：name + 相对 clone 根的目录（hasActionMarker 已退役、不再参与判定） */
  skills: Array<{ name: string; relDir: string }>;
  /** 已在 skill-states 表里的名字（含用户手动改过的） */
  known: ReadonlySet<string>;
}): Record<string, TeamSkillState> => {
  const next: Record<string, TeamSkillState> = {};
  for (const s of input.skills) {
    // 已在表里（用户改过 / 早批次默认）→ 不动；同批重名首个胜出
    if (input.known.has(s.name) || s.name in next) continue;
    next[s.name] = "enabled";
  }
  return next;
};

/**
 * 脱敏 git 输出 / 错误文本：URL userinfo（oauth2:<token>@ / user:pass@）→ ***@。
 * execFile 失败的 message 会带完整命令行、git 错误也常回显 URL——
 * 所有对外 error / console 输出都必须过这层（runGit 出口统一做；export 供单测与复用）。
 */
export const redactGitText = (text: string): string =>
  text
    .replace(/:\/\/[^@/\s]+@/g, "://***@")
    .replace(/\boauth2:[^@\s]+@/gi, "***@");

/** inline credential helper 读 token 的 env 变量名（token 不进命令行、ps 不可见） */
export const GIT_TOKEN_ENV = "TL_GIT_TOKEN";

/**
 * inline credential helper：git 需要认证时经 sh 执行、从 env 读 token。
 * `!` 前缀 = shell 命令；$TL_GIT_TOKEN 由 git 子进程继承的 env 展开。
 */
const INLINE_CREDENTIAL_HELPER = `!f(){ echo username=oauth2; echo "password=$${GIT_TOKEN_ENV}"; }; f`;

/**
 * 组装带认证的 git 参数（clone / fetch / push 等网络操作专用）：
 * - 第一个空 helper（credential.helper=）清掉系统 keychain 等全局 helper 干扰
 * - token 走 env 不进命令行：.git/config、FETCH_HEAD、ps 里都只有干净 URL
 * - http.postBuffer 调大：镜像 5M+ 的 push 用默认 buffer 会被 GitLab HTTP 500 拒
 */
export const buildAuthedGitArgs = (subArgs: string[]): string[] => [
  "-c",
  "credential.helper=",
  "-c",
  `credential.helper=${INLINE_CREDENTIAL_HELPER}`,
  "-c",
  "http.postBuffer=157286400",
  ...subArgs,
];

/** 网络 git 操作的 env：继承进程 env + token（inline credential helper 从这读） */
const buildGitTokenEnv = (token: string): NodeJS.ProcessEnv => ({
  ...process.env,
  [GIT_TOKEN_ENV]: token,
});

/** push 失败分类：保护分支拒绝（降级 MR）vs non-fast-forward（fetch+reset 重试）vs 其它 */
export type PushRejectionKind = "protected" | "non-fast-forward" | "other";

/**
 * 按 git push 的 stderr/stdout 文本分类失败原因。
 * ⚠️ 保护分支拒绝也带 `[remote rejected]`——必须先判 protected；
 * non-fast-forward 只认明确信号（non-fast-forward / fetch first）——
 * 裸 `[remote rejected]`（钩子 / 权限拒）归 other、fetch+reset 重试救不了、不做徒劳重试。
 */
export const classifyPushRejection = (errorText: string): PushRejectionKind => {
  if (
    /not allowed to push code to protected branch|protected branch/i.test(
      errorText,
    )
  ) {
    return "protected";
  }
  if (/non-fast-forward|fetch first/i.test(errorText)) {
    return "non-fast-forward";
  }
  return "other";
};

/**
 * 从 GitLab https 仓库 URL 解析 host + projectPath（createMR / canMirror 探测共用）。
 * `https://gitlab.wukongedu.net/frontend/infra/repo.git` → host + `frontend/infra/repo`
 */
export const parseGitLabRepoUrl = (
  repoUrl: string,
): { host: string; projectPath: string } | null => {
  try {
    const u = new URL(repoUrl);
    const projectPath = u.pathname
      .replace(/^\/+/, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
    if (!u.hostname || !projectPath) return null;
    return { host: u.hostname, projectPath };
  } catch {
    return null;
  }
};

/** 上传降级 MR 用的临时分支名：`upload/<skill名slug>-<yyyyMMddHHmmss>` */
export const buildUploadBranchName = (
  skillNames: string[],
  now: Date = new Date(),
): string => {
  // 名字可能含中文——git/GitLab 分支名支持 UTF-8、只清掉空白与分支非法字符
  const slug =
    skillNames
      .join("-")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, "")
      .replace(/-+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 40) || "skills";
  const pad = (n: number): string => String(n).padStart(2, "0");
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `upload/${slug}-${ts}`;
};

/** dest 是否落在 absRoot 之内（含自身） */
const isPathInside = (absRoot: string, absDest: string): boolean => {
  const root = path.resolve(absRoot);
  const dest = path.resolve(absDest);
  if (dest === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return dest.startsWith(prefix);
};

/** dest 严格落在 absRoot 之内（不含 root 自身——拷贝 / 删除目标不允许是根目录本身） */
const isStrictlyInside = (absRoot: string, absDest: string): boolean =>
  isPathInside(absRoot, absDest) &&
  path.resolve(absDest) !== path.resolve(absRoot);

/**
 * 共享库上传分类白名单：小写字母数字连字符、1~32 位。
 * 拒绝路径穿越（. / .. / 斜杠 / 大写等一律不收）。
 */
export const isSafeTeamCategory = (category: string): boolean =>
  /^[a-z0-9-]{1,32}$/.test(category);

// ---------- 配置 / token / 状态 ----------

export const getTeamLibraryConfig = async (): Promise<TeamLibraryConfig> => {
  let override: unknown = null;
  try {
    const raw = await fs.readFile(overrideConfigPath(), "utf-8");
    override = JSON.parse(raw) as unknown;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn(
        "[team-library] 读 team-library.json 失败、用默认配置:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return mergeTeamLibraryConfig({ ...DEFAULT_TEAM_LIBRARY }, override);
};

const readGitToken = async (): Promise<string | null> => {
  const result = await readSettingsFile();
  if (result.status !== "ok") return null;
  const t = result.settings.gitToken;
  return typeof t === "string" && t.trim() ? t.trim() : null;
};

const pathExists = async (p: string): Promise<boolean> =>
  !!(await fs.stat(p).catch(() => null));

export type TeamLibraryStatus = {
  configured: boolean;
  cloned: boolean;
  syncedAt: number | null;
  needsToken: boolean;
  /** 当前 token 能否读到知识库源仓（决定「镜像」入口是否可用） */
  canMirror: boolean;
};

// ---------- canMirror 探测（globalThis 缓存、TTL 5 分钟） ----------

const CAN_MIRROR_CACHE_KEY = "__flowshipTeamLibCanMirrorV1__";
const CAN_MIRROR_TTL_MS = 5 * 60 * 1000;
const CAN_MIRROR_PROBE_TIMEOUT_MS = 10_000;

type CanMirrorCache = { key: string; value: boolean; expiresAt: number };

const getCanMirrorCache = (): { current: CanMirrorCache | null } => {
  const g = globalThis as unknown as Record<
    string,
    { current: CanMirrorCache | null } | undefined
  >;
  if (!g[CAN_MIRROR_CACHE_KEY]) {
    g[CAN_MIRROR_CACHE_KEY] = { current: null };
  }
  return g[CAN_MIRROR_CACHE_KEY]!;
};

/**
 * 探测当前 gitToken 是否能访问知识库源仓（GET /api/v4/projects/<path>、200 = 可镜像）。
 * 缓存键含 token 摘要（前 8 位 sha256）——换 token 后不吃陈旧结果。
 */
const probeCanMirror = async (
  cfg: TeamLibraryConfig,
  token: string,
): Promise<boolean> => {
  const tokenDigest = createHash("sha256").update(token).digest("hex").slice(0, 8);
  const cacheKey = `${cfg.knowledgeSourceUrl}|${tokenDigest}`;
  const cache = getCanMirrorCache();
  if (
    cache.current &&
    cache.current.key === cacheKey &&
    cache.current.expiresAt > Date.now()
  ) {
    return cache.current.value;
  }

  let value = false;
  const parsed = parseGitLabRepoUrl(cfg.knowledgeSourceUrl);
  if (parsed) {
    try {
      const res = await fetch(
        `https://${parsed.host}/api/v4/projects/${encodeURIComponent(parsed.projectPath)}`,
        {
          method: "GET",
          headers: { "PRIVATE-TOKEN": token },
          signal: AbortSignal.timeout(CAN_MIRROR_PROBE_TIMEOUT_MS),
        },
      );
      value = res.status === 200;
    } catch {
      // 网络异常 / 超时 → 按不可镜像处理（下次 TTL 过期再探）
      value = false;
    }
  }
  cache.current = { key: cacheKey, value, expiresAt: Date.now() + CAN_MIRROR_TTL_MS };
  return value;
};

export const getTeamLibraryStatus = async (): Promise<TeamLibraryStatus> => {
  const cfg = await getTeamLibraryConfig();
  const token = await readGitToken();
  const gitDir = path.join(teamLibraryRepoDir(), ".git");
  return {
    configured: !!cfg.repoUrl.trim(),
    cloned: await pathExists(gitDir),
    syncedAt: getTeamLibState().syncedAt,
    needsToken: !token,
    // 无 token 直接 false、不发探测请求
    canMirror: token ? await probeCanMirror(cfg, token) : false,
  };
};

// ---------- git helpers ----------

const GIT_TIMEOUT_MS = 120_000;

type GitResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string; stdout: string; stderr: string };

const runGit = async (
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
      // 不经 shell、防注入；env 仅网络操作显式传（credential helper 从 env 读 token）
      ...(env ? { env } : {}),
    });
    // 出口统一脱敏：即便上游哪天又把凭据带进 URL、这里兜底不外泄
    return {
      ok: true,
      stdout: redactGitText(typeof stdout === "string" ? stdout : String(stdout)),
      stderr: redactGitText(typeof stderr === "string" ? stderr : String(stderr)),
    };
  } catch (err) {
    const e = err as {
      message?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdout =
      typeof e.stdout === "string"
        ? e.stdout
        : e.stdout
          ? String(e.stdout)
          : "";
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : e.stderr
          ? String(e.stderr)
          : "";
    // execFile 失败的 message 含完整命令行——脱敏后才能对外（API / toast / 日志）
    const detail = redactGitText(
      (stderr || stdout || e.message || String(err)).trim(),
    );
    return {
      ok: false,
      error: detail || "git 命令失败",
      stdout: redactGitText(stdout),
      stderr: redactGitText(stderr),
    };
  }
};

/**
 * clone 或 fetch+hard-reset 到指定分支。
 * 认证走 inline credential helper + env token：origin / FETCH_HEAD 天然只有干净 URL。
 *
 * 半残自愈：`.git` 在但 `rev-parse --git-dir` 失败（clone 中途被杀等）→ 整目录删掉重 clone。
 * fetch/reset 失败仍返错、不删仓（网络抖动别误清缓存）；只有探活失败才删。
 * export：单测造半残 .git 验证自愈。
 */
export const ensureRepoAt = async (opts: {
  dir: string;
  cleanUrl: string;
  branch: string;
  token: string;
}): Promise<{ ok: true } | { ok: false; error: string }> => {
  const { dir, cleanUrl, branch, token } = opts;
  const env = buildGitTokenEnv(token);
  await fs.mkdir(path.dirname(dir), { recursive: true });

  const gitDir = path.join(dir, ".git");
  // 探活：无 .git、或 .git 半残（rev-parse 失败）→ 统一走 clone；健康仓才 fetch
  let usableRepo = false;
  if (await pathExists(gitDir)) {
    const probe = await runGit(["rev-parse", "--git-dir"], dir);
    usableRepo = probe.ok;
  }

  if (!usableRepo) {
    // 空目录 / 半残 .git → 清掉再 clone（复用同一套 clone，不另写一份）
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    const clone = await runGit(
      buildAuthedGitArgs([
        "clone",
        "--branch",
        branch,
        "--single-branch",
        cleanUrl,
        dir,
      ]),
      undefined,
      env,
    );
    if (!clone.ok) {
      // 防御：现代 git 失败多半自己清半截目录，仍可能残留空壳/部分对象；
      // force rm 兜底，避免下次探活误判或脏目录挡路。
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, error: `clone 失败：${clone.error}` };
    }
    // 防御校验：clone 用的就是干净 URL、origin 理应无 userinfo；
    // 万一带了（上游行为变化）且清不掉 → 整仓删掉、宁可不缓存也不让 token 落盘
    const originUrl = await runGit(["config", "--get", "remote.origin.url"], dir);
    if (originUrl.ok && originUrl.stdout.includes("@")) {
      const setUrl = await runGit(["remote", "set-url", "origin", cleanUrl], dir);
      if (!setUrl.ok) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        return {
          ok: false,
          error: "clone 后 origin URL 含凭据且清理失败、已删除本地缓存（防 token 落盘）",
        };
      }
    }
    return { ok: true };
  }

  // 已有健康仓：先修 origin URL（老版本 clone 可能残留带凭据的 URL）、再 fetch + hard reset
  await runGit(["remote", "set-url", "origin", cleanUrl], dir);
  const fetch = await runGit(
    buildAuthedGitArgs(["fetch", "origin", branch]),
    dir,
    env,
  );
  if (!fetch.ok) {
    return { ok: false, error: `fetch 失败：${fetch.error}` };
  }
  const reset = await runGit(["reset", "--hard", "FETCH_HEAD"], dir);
  if (!reset.ok) {
    return { ok: false, error: `reset 失败：${reset.error}` };
  }
  // 清掉未跟踪脏文件（避免上次失败残留挡住下次拷贝）
  await runGit(["clean", "-fd"], dir);
  return { ok: true };
};

// ---------- 文件拷贝 ----------

const shouldSkipName = (name: string, excludeNames: Set<string>): boolean => {
  if (name === ".DS_Store") return true;
  if (excludeNames.has(name)) return true;
  if (name === "__pycache__") return true;
  if (name.endsWith(".pyc")) return true;
  return false;
};

/** 递归拷贝：先清空 dest（可选）、排除 .git / codes / __pycache__ / *.pyc / .DS_Store */
const copyTree = async (
  src: string,
  dest: string,
  opts?: { excludeTopNames?: string[]; clearDest?: boolean },
): Promise<void> => {
  const exclude = new Set(opts?.excludeTopNames ?? []);
  if (opts?.clearDest) {
    await fs.rm(dest, { recursive: true, force: true });
  }
  await fs.mkdir(dest, { recursive: true });

  const walk = async (from: string, to: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(from, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      // 顶层可额外排除（如 knowledge-src 的 codes/）
      if (depth === 0 && exclude.has(ent.name)) continue;
      if (shouldSkipName(ent.name, new Set([".git"]))) continue;
      const fromPath = path.join(from, ent.name);
      const toPath = path.join(to, ent.name);
      if (ent.isSymbolicLink()) continue; // 不跟 symlink 出仓
      if (ent.isDirectory()) {
        await fs.mkdir(toPath, { recursive: true });
        await walk(fromPath, toPath, depth + 1);
        continue;
      }
      if (ent.isFile()) {
        await fs.mkdir(path.dirname(toPath), { recursive: true });
        await fs.copyFile(fromPath, toPath);
      }
    }
  };
  await walk(src, dest, 0);
};

/** 拷贝 app 自管 skill 目录到共享库 skills/<category>/<name>/（先删旧、排除 .DS_Store） */
const copyAppSkillIntoRepo = async (
  skillName: string,
  repoDir: string,
  category: string,
): Promise<void> => {
  const appDir = getAppSkillsDir();
  // 落点：skills/<category>/（分类层已白名单校验）
  const destRoot = path.join(repoDir, "skills", category);
  const src = path.join(appDir, skillName);
  const dest = path.join(destRoot, skillName);
  // 名字 / 分类已在 upload 入口白名单校验；这里再锚定一次目录边界（防御纵深、拦穿越）
  const skillsRoot = path.join(repoDir, "skills");
  if (
    !isStrictlyInside(appDir, src) ||
    !isStrictlyInside(skillsRoot, dest) ||
    !isStrictlyInside(skillsRoot, destRoot)
  ) {
    throw new Error(`skill 路径越界：${skillName}`);
  }
  if (!(await pathExists(src))) {
    throw new Error(`本机自管 skill 不存在：${skillName}`);
  }
  await fs.mkdir(destRoot, { recursive: true });
  await fs.rm(dest, { recursive: true, force: true });
  await copyTree(src, dest);
};

// ---------- skill-states / 默认启停 ----------

/**
 * sync 成功后：扫描 team 源 skill、对不在 skill-states 表里的按默认策略写入
 * enabled / disabled（见 computeDefaultSkillStates）。在表里的一律不动——
 * 用户改过的永不被策略覆盖。「首次发现」语义由「不在表里」承担、seen 记账已退役。
 * 调用方（syncInternal）已持仓锁，这里直接读改写。
 *
 * 损坏保护：skill-states.json 坏了绝不能当「空表首次」——否则会把用户的
 * disabled（卸载）偏好全冲成 enabled。trusted:false 时跳过，等文件恢复后再补。
 * export：单测验证「损坏 → 跳过」。
 */
export const applyDefaultSkillStates = async (
  repoDir: string,
): Promise<void> => {
  const skillsDir = path.join(repoDir, "skills");
  const knowledgeSkillsDir = path.join(repoDir, "knowledge", "skills");
  // team 源扫描：frontmatter name 走白名单（非法 fallback 目录名 / 仍非法则 skip）
  const [groupSkills, kbSkills] = await Promise.all([
    scanSkillsDir(skillsDir, { enforceTeamName: true }),
    scanSkillsDir(knowledgeSkillsDir, { enforceTeamName: true }),
  ]);

  const toEntry = (s: SkillEntry) => {
    const skillDir = path.dirname(s.absPath);
    return {
      name: s.name,
      relDir: path.relative(repoDir, skillDir).replace(/\\/g, "/"),
    };
  };
  const skills = [...groupSkills, ...kbSkills].map(toEntry);

  // sync 专用读：ENOENT 可走默认；损坏 → trusted:false，绝不能冲用户偏好
  const syncRead = await readTeamSkillStatesForSync();
  if (!syncRead.trusted) {
    console.warn(
      "[team-library] skill-states.json 损坏、跳过默认启停策略（已备份；恢复文件后再 sync）",
    );
    return;
  }
  const states = syncRead.states;
  const added = computeDefaultSkillStates({
    skills,
    known: new Set(Object.keys(states)),
  });
  const addedNames = Object.keys(added);
  if (addedNames.length === 0) return;
  await writeTeamSkillStates({ ...states, ...added });
  // 全量默认 enabled 策略下不再有「默认禁用」口径——日志只报安装数，免误导排障
  console.log(
    `[team-library] 首次发现 team skill ${addedNames.length} 个（默认安装 ${addedNames.length}）`,
  );
};

// ---------- 安装 / 卸载（市场模型：skill-states enabled = 已安装） ----------

/** 在两个 team 目录里按名找 skill；返回条目 + 同目录是否有 action 标记 */
const findTeamSkillByName = async (
  name: string,
): Promise<{ entry: SkillEntry; hasActionMarker: boolean } | null> => {
  const [groupSkills, kbSkills] = await Promise.all([
    scanSkillsDir(getTeamLibrarySkillsDir(), { enforceTeamName: true }),
    scanSkillsDir(getTeamLibraryKnowledgeSkillsDir(), {
      enforceTeamName: true,
    }),
  ]);
  const entry = [...groupSkills, ...kbSkills].find((s) => s.name === name);
  if (!entry) return null;
  const hasActionMarker = await pathExists(
    path.join(path.dirname(entry.absPath), ".flowship-action.json"),
  );
  return { entry, hasActionMarker };
};

export type InstallTeamSkillResult =
  | { ok: true; actionLabel?: string }
  | { ok: false; error: string };

/**
 * 安装 team skill（install API 唯一入口、进仓锁）：**只写 skill-states enabled**。
 * 带 .flowship-action.json 的推进 action 由 custom-action-fs 从安装态实时派生
 *（2026-07-22 派生模型、不再 createCustomAction——消灭双份状态）。
 * 返回 actionLabel 仅供 toast 文案（「已加入推进面板」）。
 */
export const installTeamSkill = async (
  name: string,
): Promise<InstallTeamSkillResult> =>
  withTeamLibraryLock(async () => {
    const needle = name.trim();
    if (!needle) return { ok: false, error: "name 必填" };
    const found = await findTeamSkillByName(needle);
    if (!found) return { ok: false, error: `team skill 不存在：${needle}` };

    const states = await readTeamSkillStates();
    states[needle] = "enabled";
    await writeTeamSkillStates(states);

    // 带 action 标记：读 label 供 toast（纯展示、不落任何文件）
    if (!found.hasActionMarker) return { ok: true };
    let meta: ExportedActionMeta | null = null;
    try {
      meta = parseFlowshipActionMeta(
        await fs.readFile(
          path.join(path.dirname(found.entry.absPath), ".flowship-action.json"),
          "utf-8",
        ),
      );
    } catch {
      // meta 读不出不影响安装本身
    }
    return { ok: true, ...(meta ? { actionLabel: meta.label } : {}) };
  });

export type UninstallTeamSkillResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * 卸载 team skill（uninstall API 唯一入口、进仓锁）：**只写 skill-states disabled**。
 * 派生的推进 action 随安装态消失、无需删任何文件。
 */
export const uninstallTeamSkill = async (
  name: string,
): Promise<UninstallTeamSkillResult> =>
  withTeamLibraryLock(async () => {
    const needle = name.trim();
    if (!needle) return { ok: false, error: "name 必填" };
    const found = await findTeamSkillByName(needle);
    if (!found) return { ok: false, error: `team skill 不存在：${needle}` };

    const states = await readTeamSkillStates();
    states[needle] = "disabled";
    await writeTeamSkillStates(states);
    return { ok: true };
  });

// ---------- sync ----------

export type SyncTeamLibraryResult = {
  ok: boolean;
  syncedAt?: number;
  error?: string;
  /** 没配 token 时静默跳过（启动路径用） */
  skipped?: boolean;
};

// ---------- 仓级写互斥（sync / upload / mirror 串行、防工作树互踩） ----------

const TEAM_LIB_LOCK_KEY = "__flowshipTeamLibraryLockV1__";

const getTeamLibLockChain = (): { current: Promise<unknown> } => {
  const g = globalThis as unknown as Record<
    string,
    { current: Promise<unknown> } | undefined
  >;
  if (!g[TEAM_LIB_LOCK_KEY]) {
    g[TEAM_LIB_LOCK_KEY] = { current: Promise.resolve() };
  }
  return g[TEAM_LIB_LOCK_KEY]!;
};

/**
 * team-library 仓级互斥：三个对外写入口（sync / upload / mirror）全部串进同一条链——
 * 并发的 upload∥mirror、双 upload、sync∥upload 都会排队而不是互踩工作树。
 * 内部互调走各自的 *Internal（已持锁、不重复进锁、防自嵌套死锁）。
 * export 仅为单测锁串行顺序；错误由调用方消费、不传染下一个排队者。
 */
export const withTeamLibraryLock = async <T>(
  fn: () => Promise<T>,
): Promise<T> => {
  const chain = getTeamLibLockChain();
  const run = chain.current.then(fn, fn);
  chain.current = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

/**
 * sync 实现体（**不加锁**）：upload / mirror 内部复用——它们已持有仓锁、
 * 再走对外的 syncTeamLibrary 会在同一条锁链上自己等自己（死锁）。
 */
const syncInternal = async (opts?: {
  silentWithoutToken?: boolean;
}): Promise<SyncTeamLibraryResult> => {
  const token = await readGitToken();
  if (!token) {
    if (opts?.silentWithoutToken) {
      return { ok: false, skipped: true, error: "needsToken" };
    }
    return { ok: false, error: "未配置 GitLab Token（设置页 gitToken）" };
  }
  const cfg = await getTeamLibraryConfig();
  const ensured = await ensureRepoAt({
    dir: teamLibraryRepoDir(),
    cleanUrl: cfg.repoUrl,
    branch: cfg.branch,
    token,
  });
  if (!ensured.ok) return { ok: false, error: ensured.error };

  try {
    await applyDefaultSkillStates(teamLibraryRepoDir());
  } catch (err) {
    console.warn(
      "[team-library] 默认启停策略失败（不阻断 sync）:",
      err instanceof Error ? err.message : err,
    );
  }

  const syncedAt = Date.now();
  getTeamLibState().syncedAt = syncedAt;
  return { ok: true, syncedAt };
};

/**
 * clone 或 fetch+reset 共享库（对外入口、进仓锁）。
 * inFlight 单例做并发去重（同时多处触发 sync 时搭同一趟车、不排队重复拉）；
 * 没配 gitToken → 返回 needsToken 语义错误（启动调用方应静默）。
 */
export const syncTeamLibrary = async (opts?: {
  /** true = 没 token 时不报 error、只标 skipped（启动 fire-and-forget） */
  silentWithoutToken?: boolean;
}): Promise<SyncTeamLibraryResult> => {
  const state = getTeamLibState();
  if (state.inFlight) return state.inFlight;

  const run = withTeamLibraryLock(() => syncInternal(opts));
  state.inFlight = run;
  try {
    return await run;
  } finally {
    if (state.inFlight === run) state.inFlight = null;
  }
};

// ---------- commit + push（含冲突重试 + 保护分支 MR 降级） ----------

type CommitPushResult =
  | {
      ok: true;
      /** 保护分支降级走 MR 时置 true（已提交待审核） */
      pendingReview?: boolean;
      mrUrl?: string;
    }
  | { ok: false; error: string };

const commitAndPush = async (opts: {
  repoDir: string;
  cleanUrl: string;
  branch: string;
  token: string;
  message: string;
  /** 冲突重试时：fetch+reset 后重新准备工作树 */
  restage: () => Promise<void>;
  /**
   * 保护分支拒绝时的 MR 降级参数（upload 传；mirror 不传——
   * 镜像操作者必为 maintainer、被保护规则拒直接报错）。
   */
  mrFallback?: {
    tempBranch: string;
    description: string;
  };
}): Promise<CommitPushResult> => {
  const { repoDir, cleanUrl, branch, token, message, restage, mrFallback } =
    opts;
  // token 走 env + inline credential helper、push 用干净的 origin（不再拼 authed URL）
  const env = buildGitTokenEnv(token);

  const tryOnce = async (): Promise<
    { ok: true } | { ok: false; error: string; kind: PushRejectionKind }
  > => {
    const add = await runGit(["add", "-A"], repoDir);
    if (!add.ok) {
      return { ok: false, error: `git add 失败：${add.error}`, kind: "other" };
    }

    const status = await runGit(["status", "--porcelain"], repoDir);
    if (!status.ok) {
      return {
        ok: false,
        error: `git status 失败：${status.error}`,
        kind: "other",
      };
    }
    if (!status.stdout.trim()) {
      // 无变更：视为成功（幂等）
      return { ok: true };
    }

    const commit = await runGit(
      ["commit", "-m", message, "--no-gpg-sign"],
      repoDir,
    );
    if (!commit.ok) {
      return {
        ok: false,
        error: `git commit 失败：${commit.error}`,
        kind: "other",
      };
    }

    const push = await runGit(
      buildAuthedGitArgs(["push", "origin", `HEAD:${branch}`]),
      repoDir,
      env,
    );
    if (!push.ok) {
      return {
        ok: false,
        error: `git push 失败：${push.error}`,
        kind: classifyPushRejection(push.error + push.stderr),
      };
    }
    return { ok: true };
  };

  /**
   * 保护分支降级：本地 commit 推临时分支 → 开 MR（target = 保护分支）→
   * 本地 clone 恢复远端态（缓存干净、下次 sync 不带私货）。
   */
  const fallbackToMR = async (
    fb: NonNullable<typeof mrFallback>,
  ): Promise<CommitPushResult> => {
    const parsed = parseGitLabRepoUrl(cleanUrl);
    if (!parsed) {
      return { ok: false, error: `无法从仓库 URL 解析 host/projectPath：${cleanUrl}` };
    }

    // 无论降级走到哪一步失败、本地 clone 都要恢复到远端态（丢掉本地 commit）；
    // 恢复失败只 warn——下次 sync 的 fetch+reset 会兜底
    const restoreClone = async (): Promise<void> => {
      const restored = await ensureRepoAt({
        dir: repoDir,
        cleanUrl,
        branch,
        token,
      });
      if (!restored.ok) {
        console.warn("[team-library] MR 降级后恢复本地 clone 失败:", restored.error);
      }
    };

    const pushTemp = await runGit(
      buildAuthedGitArgs(["push", "origin", `HEAD:refs/heads/${fb.tempBranch}`]),
      repoDir,
      env,
    );
    if (!pushTemp.ok) {
      // P1-6：推临时分支失败也要恢复——否则残留本地 commit 污染后续 list / loader / 下次上传
      await restoreClone();
      return {
        ok: false,
        error: `推临时分支失败：${pushTemp.error}`,
      };
    }

    const mr = await createMR({
      config: { host: parsed.host, token },
      projectPath: parsed.projectPath,
      sourceBranch: fb.tempBranch,
      targetBranch: branch,
      title: message,
      description: fb.description,
      // 临时分支合并后没有留存价值、直接删
      removeSourceBranch: true,
    });

    await restoreClone();

    if (!mr.ok) {
      // P2-10：MR 没开成、远端临时分支成孤儿——尽力删掉（失败仅 warn、不影响错误上抛）
      const del = await runGit(
        buildAuthedGitArgs(["push", "origin", `:refs/heads/${fb.tempBranch}`]),
        repoDir,
        env,
      );
      if (!del.ok) {
        console.warn(
          "[team-library] 删除孤儿临时分支失败:",
          fb.tempBranch,
          del.error,
        );
      }
      return { ok: false, error: `创建 MR 失败：${mr.error}` };
    }
    return { ok: true, pendingReview: true, mrUrl: mr.url };
  };

  const first = await tryOnce();
  if (first.ok) return { ok: true };
  if (first.kind === "protected") {
    // mirror 场景（无降级参数）：保护分支拒绝直接透传 git 错误
    if (!mrFallback) return { ok: false, error: first.error };
    return fallbackToMR(mrFallback);
  }
  if (first.kind !== "non-fast-forward") {
    return { ok: false, error: first.error };
  }

  // non-fast-forward：fetch+reset（丢掉本地 commit）→ restage → 再 commit/push 一次
  console.warn("[team-library] push 被拒（non-fast-forward）、fetch+reset 后重试一次");
  const ensured = await ensureRepoAt({
    dir: repoDir,
    cleanUrl,
    branch,
    token,
  });
  if (!ensured.ok) return { ok: false, error: ensured.error };
  try {
    await restage();
  } catch (err) {
    return {
      ok: false,
      error: `重试准备文件失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const second = await tryOnce();
  if (second.ok) return { ok: true };
  // 重试路径上也可能撞保护分支（如首次误判）——同样降级（mirror 无降级参数则透传）
  if (second.kind === "protected" && mrFallback) return fallbackToMR(mrFallback);
  return { ok: false, error: second.error };
};

// ---------- upload / mirror ----------

export type UploadSkillResult = {
  name: string;
  ok: boolean;
  error?: string;
};

export type UploadSkillsResult = {
  ok: boolean;
  results: UploadSkillResult[];
  error?: string;
  /** 保护分支降级走 MR：已提交待审核（ok 仍为 true） */
  pendingReview?: boolean;
  mrUrl?: string;
};

/** upload 实现体（不加锁）：对外入口 uploadSkillsToTeamLibrary 持仓锁后进来 */
const uploadSkillsInternal = async (
  names: string[],
  category: string,
): Promise<UploadSkillsResult> => {
  const unique = [
    ...new Set(
      names
        .map((n) => (typeof n === "string" ? n.trim() : ""))
        .filter(Boolean),
    ),
  ];
  if (unique.length === 0) {
    return { ok: false, results: [], error: "skillNames 不能为空" };
  }

  // 分类白名单：拒绝路径穿越 / 非法字符
  if (!isSafeTeamCategory(category)) {
    return {
      ok: false,
      results: unique.map((name) => ({
        name,
        ok: false,
        error: "category 非法（只允许小写字母数字连字符、1~32 位）",
      })),
      error: "category 非法（只允许小写字母数字连字符、1~32 位）",
    };
  }

  // P1-4：skill 名白名单——拦 `../`、分隔符等穿越（路径拼接前置校验、整批拒绝）
  const invalid = unique.filter((n) => !isSafeTeamSkillName(n));
  if (invalid.length > 0) {
    return {
      ok: false,
      results: unique.map((name) => ({
        name,
        ok: false,
        error: invalid.includes(name)
          ? "skill 名非法（只能字母 / 数字 / 中文 / ._-、不能以点开头）"
          : "同批次含非法 skill 名、已整体取消",
      })),
      error: `skill 名非法：${invalid.join("、")}`,
    };
  }

  const sync = await syncInternal();
  if (!sync.ok) {
    return {
      ok: false,
      results: unique.map((name) => ({
        name,
        ok: false,
        error: sync.error ?? "sync 失败",
      })),
      error: sync.error,
    };
  }

  const token = await readGitToken();
  if (!token) {
    return {
      ok: false,
      results: unique.map((name) => ({
        name,
        ok: false,
        error: "未配置 GitLab Token",
      })),
      error: "未配置 GitLab Token（设置页 gitToken）",
    };
  }
  const cfg = await getTeamLibraryConfig();
  const repoDir = teamLibraryRepoDir();
  // 上传前先列一次、作 app skill json 缺失时的兜底；优先读自管目录现成 json
  const actions = await listCustomActions();
  // 全库跨分类索引 + 创建人（stage 循环内复用；restage 时再扫一轮）
  const loadConflictContext = async () => {
    const sharedEntries = await listSharedSkillDirs(repoDir);
    const authors = await getTeamSkillAuthors(repoDir);
    return { sharedEntries, authors };
  };

  const stageAll = async (): Promise<UploadSkillResult[]> => {
    const { sharedEntries, authors } = await loadConflictContext();
    const results: UploadSkillResult[] = [];
    for (const name of unique) {
      // 跨分类同名 → 拒收该条（其余合法项继续）；同分类 → 覆盖
      const conflict = checkUploadNameAcrossCategories(
        name,
        category,
        sharedEntries,
        authors,
      );
      if (conflict.status === "conflict") {
        results.push({ name, ok: false, error: conflict.error });
        continue;
      }
      try {
        await copyAppSkillIntoRepo(name, repoDir, category);
        // 优先：自管 skill 目录里已有的 .flowship-action.json（事实源）
        let meta: ExportedActionMeta | null = null;
        const appJsonPath = path.join(
          getAppSkillsDir(),
          name,
          ".flowship-action.json",
        );
        try {
          meta = parseFlowshipActionMeta(
            await fs.readFile(appJsonPath, "utf-8"),
          );
        } catch {
          meta = null;
        }
        if (!meta) {
          // 兜底：list 里 origin=app-skill 且 skill 名匹配
          const matching = actions.filter(
            (a) =>
              a.skill === name &&
              !a.legacyPlaybook &&
              a.origin === "app-skill",
          );
          if (matching.length > 1) {
            console.warn(
              `[team-library] skill「${name}」挂了 ${matching.length} 个 custom action、只写第一个「${matching[0]!.label}」`,
            );
          }
          if (matching.length >= 1) {
            const def = matching[0]!;
            meta = {
              label: def.label,
              ...(def.output ? { output: def.output } : {}),
              ...(def.placeholder ? { placeholder: def.placeholder } : {}),
              ...(def.requiresKnowledge === true
                ? { requiresKnowledge: true }
                : {}),
              exportedAt: Date.now(),
            };
          }
        } else {
          // 上传时间戳刷新；字段沿用现有 json（含 requiresKnowledge）
          meta = { ...meta, exportedAt: Date.now() };
        }
        if (meta) {
          const payload: ExportedActionMeta = {
            label: meta.label,
            exportedAt: meta.exportedAt,
            ...(meta.output ? { output: meta.output } : {}),
            ...(meta.placeholder ? { placeholder: meta.placeholder } : {}),
            ...(meta.requiresKnowledge === true
              ? { requiresKnowledge: true }
              : {}),
          };
          await fs.writeFile(
            path.join(
              repoDir,
              "skills",
              category,
              name,
              ".flowship-action.json",
            ),
            `${JSON.stringify(payload, null, 2)}\n`,
            "utf-8",
          );
        }
        results.push({ name, ok: true });
      } catch (err) {
        results.push({
          name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  };

  let results = await stageAll();
  const stagedOk = results.some((r) => r.ok);
  if (!stagedOk) {
    return { ok: false, results, error: "全部 skill 准备失败" };
  }

  const message = `feat(skills): 上传 ${unique.join(", ")} → ${category} from Flowship`;
  const push = await commitAndPush({
    repoDir,
    cleanUrl: cfg.repoUrl,
    branch: cfg.branch,
    token,
    message,
    restage: async () => {
      results = await stageAll();
    },
    // main 受保护（developer 无直推权限）→ 推临时分支 + 开 MR
    mrFallback: {
      tempBranch: buildUploadBranchName(unique),
      description: [
        "来自 Flowship 组共享库上传（main 受保护、自动降级为 MR）。",
        "",
        `分类：${category}`,
        "包含 skill：",
        ...unique.map((n) => `- ${n}`),
      ].join("\n"),
    },
  });

  if (!push.ok) {
    return {
      ok: false,
      results: results.map((r) =>
        r.ok ? { ...r, ok: false, error: push.error } : r,
      ),
      error: push.error,
    };
  }
  const allOk = results.every((r) => r.ok);
  return {
    ok: allOk,
    results,
    ...(push.pendingReview ? { pendingReview: true, mrUrl: push.mrUrl } : {}),
  };
};

/**
 * 把本机自管 skill 上传到共享库 skills/<category>/<name>/（对外入口、进仓锁）。
 * 有对应 custom action 时写 .flowship-action.json（多挂载取第一个 + warn）。
 * main 受保护被拒时自动降级：推临时分支 + 开 MR（pendingReview:true + mrUrl）。
 */
export const uploadSkillsToTeamLibrary = async (
  names: string[],
  category: string,
): Promise<UploadSkillsResult> =>
  withTeamLibraryLock(() => uploadSkillsInternal(names, category));

/** mirror 实现体（不加锁）：对外入口 mirrorKnowledgeBase 持仓锁后进来 */
const mirrorKnowledgeBaseInternal = async (): Promise<{
  ok: boolean;
  error?: string;
}> => {
  const token = await readGitToken();
  if (!token) {
    return { ok: false, error: "未配置 GitLab Token（设置页 gitToken）" };
  }
  const cfg = await getTeamLibraryConfig();

  // 1) 同步共享库（目标仓）——已持仓锁、走不加锁的 syncInternal
  const sync = await syncInternal();
  if (!sync.ok) return { ok: false, error: sync.error };

  // 2) 同步知识库源缓存
  const srcEnsured = await ensureRepoAt({
    dir: teamLibraryKnowledgeSrcDir(),
    cleanUrl: cfg.knowledgeSourceUrl,
    branch: cfg.knowledgeSourceBranch,
    token,
  });
  if (!srcEnsured.ok) {
    return { ok: false, error: `知识库源同步失败：${srcEnsured.error}` };
  }

  const repoDir = teamLibraryRepoDir();
  const knowledgeDest = path.join(repoDir, "knowledge");

  const stageMirror = async (): Promise<void> => {
    await copyTree(teamLibraryKnowledgeSrcDir(), knowledgeDest, {
      clearDest: true,
      excludeTopNames: ["codes"],
    });
  };

  try {
    await stageMirror();
  } catch (err) {
    return {
      ok: false,
      error: `镜像拷贝失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const push = await commitAndPush({
    repoDir,
    cleanUrl: cfg.repoUrl,
    branch: cfg.branch,
    token,
    message: "chore(knowledge): mirror wk-knowledgebase from Flowship",
    restage: stageMirror,
  });
  if (!push.ok) return { ok: false, error: push.error };
  return { ok: true };
};

/** 把 wk-knowledgebase 镜像进共享库 knowledge/（对外入口、进仓锁；排除 .git / codes / __pycache__ / *.pyc） */
export const mirrorKnowledgeBase = async (): Promise<{
  ok: boolean;
  error?: string;
}> => withTeamLibraryLock(() => mirrorKnowledgeBaseInternal());

// ---------- list / install team actions ----------

export type TeamActionEntry = {
  /** 相对 clone 根的 skill 目录 */
  dirPath: string;
  skillName: string;
  label: string;
  /** SKILL.md description（安装列表展示用） */
  description?: string;
  output?: string;
  placeholder?: string;
  /**
   * 是否已安装：读 skill-states，`!== "disabled"`（不在表里 = enabled，fail-open）。
   * 派生模型下不再用「本地有无同名 custom action」启发式——同名自建会误标已装。
   */
  installed: boolean;
  /** 创建人（共享库 git 历史首次引入者；解析不到不带） */
  author?: string;
};

/** 扫 clone 内所有含 .flowship-action.json + SKILL.md 的目录（skills/ 与 knowledge/） */
export const listTeamActions = async (): Promise<TeamActionEntry[]> => {
  const repoDir = teamLibraryRepoDir();
  if (!(await pathExists(repoDir))) return [];

  // 创建人索引（HEAD 级缓存、失败空表不阻断）
  const authors = await getTeamSkillAuthors(repoDir);
  const found: TeamActionEntry[] = [];
  // 无锁读 states（与 api/skills / deriveTeamActions 同款 fail-open）
  const states = await readTeamSkillStates();

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    if (names.has(".flowship-action.json") && names.has("SKILL.md")) {
      const metaPath = path.join(dir, ".flowship-action.json");
      const skillMd = path.join(dir, "SKILL.md");
      try {
        const raw = await fs.readFile(metaPath, "utf-8");
        const meta = parseFlowshipActionMeta(raw);
        if (meta) {
          // team 源：frontmatter name 白名单（与 loader / 派生 action 一致）；
          // 解析失败（缺 description / name 双非法）→ skip，不出半残条目
          const parsed = await parseSkillFile(skillMd, {
            enforceTeamName: true,
          });
          if (parsed) {
            const skillName = parsed.name;
            const dirPath = path.relative(repoDir, dir).replace(/\\/g, "/");
            found.push({
              dirPath,
              skillName,
              label: meta.label,
              ...(parsed.description
                ? { description: parsed.description }
                : {}),
              ...(meta.output ? { output: meta.output } : {}),
              ...(meta.placeholder ? { placeholder: meta.placeholder } : {}),
              // 不在表里 = enabled（与 loader fail-open 一致）
              installed: states[skillName] !== "disabled",
              ...(authors[dirPath] ? { author: authors[dirPath] } : {}),
            });
          }
        }
      } catch (err) {
        console.warn(
          "[team-library] 解析 team action 失败、跳过:",
          dir,
          err instanceof Error ? err.message : err,
        );
      }
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
      await walk(path.join(dir, ent.name), depth + 1);
    }
  };

  // 只扫 skills/ 与 knowledge/（避免扫整个 .git）
  for (const sub of ["skills", "knowledge"]) {
    const p = path.join(repoDir, sub);
    if (await pathExists(p)) await walk(p, 0);
  }

  return found.sort((a, b) => a.label.localeCompare(b.label, "zh"));
};

// ---------- 从共享库远端删除（误上传清理） ----------

export type LocateSharedSkillResult =
  | { ok: true; category: string; relDir: string }
  | { ok: false; error: string };

/**
 * 上传前全库跨分类查重（纯逻辑、单测友好）。
 * - 不存在 → new
 * - 仅存在于目标分类 → overwrite（现状覆盖语义）
 * - 存在于其它分类 → conflict（挡串名；作者取 authors 索引、没有就省略）
 */
export type UploadNameConflictCheck =
  | { status: "new" }
  | { status: "overwrite" }
  | {
      status: "conflict";
      category: string;
      author?: string;
      error: string;
    };

export const checkUploadNameAcrossCategories = (
  name: string,
  targetCategory: string,
  entries: Array<{ category: string; name: string }>,
  authorsByRelDir?: Record<string, string>,
): UploadNameConflictCheck => {
  const hits = entries.filter((e) => e.name === name);
  const other = hits.find((h) => h.category !== targetCategory);
  if (other) {
    const relDir = `skills/${other.category}/${name}`;
    const authorRaw = authorsByRelDir?.[relDir];
    const author =
      typeof authorRaw === "string" && authorRaw.trim()
        ? authorRaw.trim()
        : undefined;
    const catLabel = labelTeamSharedCategory(other.category);
    const error = author
      ? `库里已有同名 skill（分类 ${catLabel}、创建人 ${author}），请换名或联系对方`
      : `库里已有同名 skill（分类 ${catLabel}），请换名或联系对方`;
    return {
      status: "conflict",
      category: other.category,
      ...(author ? { author } : {}),
      error,
    };
  }
  if (hits.some((h) => h.category === targetCategory)) {
    return { status: "overwrite" };
  }
  return { status: "new" };
};

/**
 * 纯逻辑：在共享 skills/ 扫描条目里按 name 定位 `skills/<cat>/<name>`。
 * knowledge 镜像不在 entries 里——本函数天然拒绝删知识库侧。
 * 越界名 / 不存在 / 同名多分类 → ok:false。
 */
export const locateSharedSkillPath = (
  entries: Array<{ category: string; name: string }>,
  name: string,
): LocateSharedSkillResult => {
  const needle = typeof name === "string" ? name.trim() : "";
  if (!needle || !isSafeTeamSkillName(needle)) {
    return {
      ok: false,
      error: "skill 名非法（只能字母 / 数字 / 中文 / ._-、不能以点开头）",
    };
  }
  const hits = entries.filter((e) => e.name === needle);
  if (hits.length === 0) {
    return { ok: false, error: `共享库不存在「${needle}」` };
  }
  if (hits.length > 1) {
    const cats = [...new Set(hits.map((h) => h.category))].join("、");
    return {
      ok: false,
      error: `「${needle}」在多个分类出现（${cats}），请先整理远端`,
    };
  }
  const category = hits[0]!.category;
  if (!isSafeTeamCategory(category)) {
    return { ok: false, error: `category 非法：${category}` };
  }
  return {
    ok: true,
    category,
    relDir: `skills/${category}/${needle}`,
  };
};

/**
 * 扫 clone 内 `skills/<cat>/<name>/`（仅共享沉淀、不含 knowledge）。
 * 返回 category + frontmatter name + 绝对目录，供 locate / 删除用。
 */
const listSharedSkillDirs = async (
  repoDir: string,
): Promise<Array<{ category: string; name: string; absDir: string }>> => {
  const skillsRoot = path.join(repoDir, "skills");
  const out: Array<{ category: string; name: string; absDir: string }> = [];
  let cats;
  try {
    cats = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const catEnt of cats) {
    if (!catEnt.isDirectory() || catEnt.name.startsWith(".")) continue;
    // 分类白名单：非法目录跳过（旧扁平 skills/<name>/ 也不当共享分类扫）
    if (!isSafeTeamCategory(catEnt.name)) continue;
    const catDir = path.join(skillsRoot, catEnt.name);
    let skillEnts;
    try {
      skillEnts = await fs.readdir(catDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sk of skillEnts) {
      if (!sk.isDirectory() || sk.name.startsWith(".")) continue;
      const absDir = path.join(catDir, sk.name);
      // 目录必须严格落在 skills/ 内（防 symlink / 穿越）
      if (!isStrictlyInside(skillsRoot, absDir)) continue;
      const skillMd = path.join(absDir, "SKILL.md");
      if (!(await pathExists(skillMd))) continue;
      const parsed = await parseSkillFile(skillMd, { enforceTeamName: true });
      if (!parsed) continue;
      out.push({
        category: catEnt.name,
        name: parsed.name,
        absDir,
      });
    }
  }
  return out;
};

export type DeleteFromTeamLibraryResult =
  | {
      ok: true;
      pendingReview?: boolean;
      mrUrl?: string;
    }
  | { ok: false; error: string };

/** delete 实现体（不加锁）：对外入口持仓锁后进来 */
const deleteFromTeamLibraryInternal = async (
  name: string,
): Promise<DeleteFromTeamLibraryResult> => {
  const needle = typeof name === "string" ? name.trim() : "";
  if (!needle) return { ok: false, error: "name 必填" };
  if (!isSafeTeamSkillName(needle)) {
    return {
      ok: false,
      error: "skill 名非法（只能字母 / 数字 / 中文 / ._-、不能以点开头）",
    };
  }

  // 先 sync，保证 clone 是远端最新（避免删陈旧副本）
  const sync = await syncInternal();
  if (!sync.ok) {
    return { ok: false, error: sync.error ?? "sync 失败" };
  }

  const token = await readGitToken();
  if (!token) {
    return { ok: false, error: "未配置 GitLab Token（设置页 gitToken）" };
  }

  const cfg = await getTeamLibraryConfig();
  const repoDir = teamLibraryRepoDir();
  const skillsRoot = path.join(repoDir, "skills");

  const listed = await listSharedSkillDirs(repoDir);
  const located = locateSharedSkillPath(
    listed.map((e) => ({ category: e.category, name: e.name })),
    needle,
  );
  if (!located.ok) return located;

  const hit = listed.find(
    (e) => e.name === needle && e.category === located.category,
  );
  if (!hit) {
    return { ok: false, error: `共享库不存在「${needle}」` };
  }
  // 再锚定一次路径边界（防御纵深）
  if (!isStrictlyInside(skillsRoot, hit.absDir)) {
    return { ok: false, error: `skill 路径越界：${needle}` };
  }

  const stageDelete = async (): Promise<void> => {
    // 冲突重试后目录可能已不在（远端别人先删）——幂等当作成功准备
    if (!(await pathExists(hit.absDir))) return;
    if (!isStrictlyInside(skillsRoot, hit.absDir)) {
      throw new Error(`skill 路径越界：${needle}`);
    }
    await fs.rm(hit.absDir, { recursive: true, force: true });
  };

  await stageDelete();

  const message = `chore(skills): 删除 ${needle}`;
  const push = await commitAndPush({
    repoDir,
    cleanUrl: cfg.repoUrl,
    branch: cfg.branch,
    token,
    message,
    restage: stageDelete,
    mrFallback: {
      tempBranch: buildUploadBranchName([`delete-${needle}`]),
      description: [
        "来自 Flowship 组共享库删除（main 受保护、自动降级为 MR）。",
        "",
        `删除 skill：${needle}`,
        `路径：${located.relDir}`,
      ].join("\n"),
    },
  });

  if (!push.ok) return { ok: false, error: push.error };

  // 保护分支降级：远端尚未删、本地 clone 已恢复——只回 MR、不清 states
  if (push.pendingReview) {
    return { ok: true, pendingReview: true, mrUrl: push.mrUrl };
  }

  // 直推成功：清本地 skill-states 该条 + 再 sync 对齐远端
  const states = await readTeamSkillStates();
  if (needle in states) {
    delete states[needle];
    await writeTeamSkillStates(states);
  }
  const resync = await syncInternal();
  if (!resync.ok) {
    // 远端已删成功、本地 sync 失败只 warn——下次启动 / 手动同步会兜底
    console.warn(
      "[team-library] 删除后 re-sync 失败:",
      resync.error,
    );
  }

  return { ok: true };
};

/**
 * 从共享库远端删除 skill（对外入口、进仓锁）。
 * 只删 `skills/<cat>/<name>/`（组沉淀）；knowledge 镜像不允许删。
 * main 受保护被拒 → 临时分支 + MR（pendingReview）。
 */
export const deleteFromTeamLibrary = async (
  name: string,
): Promise<DeleteFromTeamLibraryResult> =>
  withTeamLibraryLock(() => deleteFromTeamLibraryInternal(name));

