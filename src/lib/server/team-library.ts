/**
 * 组共享库（team library）
 *
 * GitLab 仓作为团队 skill / action 分发中心 + 知识库镜像载体。
 * 对用户无感：地址内置代码、不进设置页；app 启动 fire-and-forget sync。
 *
 * 目录约定（远端仓）：
 *   skills/<skill名>/SKILL.md [+ .flowship-action.json]
 *   knowledge/  ← wk-harness-platform 整库镜像（排除 MIRROR_EXCLUDED_TOP_DIRS）
 *     knowledge-base/  工程知识档案
 *     scripts/         知识库维护脚本（kb_refresh.sh / pull_*_repos.sh）——**不是**门禁脚本
 *     skills/{global,frontend,backend,client}/<工程>/<skill>/SKILL.md
 *       └─ global/wk-harness/scripts/  ← 七个 wk 门禁脚本在这（doc-quality-gate.py 等、
 *          `wk-gate.wkScriptsDir()` 指向它）
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
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ExportedActionMeta } from "./custom-action-fs";
import {
  listCustomActions,
  parseFlowshipActionMeta,
} from "./custom-action-fs";
import { dataRoot } from "./data-root";
import { createMR } from "./gitlab-client";
import {
  getTeamSkillAuthorIdentities,
  getTeamSkillAuthors,
} from "./team-skill-authors";
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
import {
  formatSensitiveScanError,
  gateSensitiveUpload,
  scanSensitiveFiles,
  type SecretScanFile,
  type SecretScanHit,
} from "./team-library-secret-scan";
import {
  decideSharedSkillUpdate,
  ownerFromGitLabIdentity,
  parseSharedSkillOwner,
  type GitLabUploadIdentity,
  type SharedSkillOwner,
} from "./team-library-ownership";

export {
  getTeamLibraryKnowledgeRoot,
  getTeamLibraryKnowledgeSkillsDir,
  getTeamLibrarySkillsDir,
  isSafeTeamSkillName,
  teamLibraryKnowledgeSrcDir,
  teamLibraryRepoDir,
  teamLibraryRoot,
};

// 敏感扫描纯函数 re-export（单测 / API 共用类型）
export {
  formatSensitiveScanError,
  gateSensitiveUpload,
  isPlaceholderSecretValue,
  isProbablyBinaryText,
  looksHighEntropySecret,
  redactSecretValue,
  scanSensitiveFiles,
  type SecretScanFile,
  type SecretScanHit,
} from "./team-library-secret-scan";

const execFileAsync = promisify(execFile);

/** 内置默认配置（地址不进设置页 UI；正式仓 = 组内 action hub） */
export const DEFAULT_TEAM_LIBRARY = {
  repoUrl: "https://gitlab.wukongedu.net/frontend/infra/ai-flow-action-hub.git",
  branch: "main",
  // 2026-07-27 源仓迁移：wukong/wk-knowledgebase → wukong/wk-harness-platform（旧路径已 404）
  knowledgeSourceUrl: "https://gitlab.wukongedu.net/wukong/wk-harness-platform.git",
  // 兜底分支：正常由 detectRemoteDefaultBranch 探远端默认分支（当前也是 release/1.0），
  // 只有探测失败（离线 / 远端不给 symref）才落到这个写死值
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
 * 默认启停策略（两种场景，2026-07-24 拆开）：
 *
 * 1. **首次初始化**（`isFirstInit: true`）：skill-states 表空 / 文件不存在。
 *    团队库刚 clone，存量几十个 skill 不能让用户挨个点安装 → 表外新名一律
 *    `enabled`（对齐「同步即全量可用」；实测 ≈ 1.5 万 tokens 可接受）。
 *
 * 2. **后续 sync 增量**（`isFirstInit: false`）：表已非空，表外新名 = 同事新上传。
 *    一律 `disabled`（未安装）——用户在共享市场手动点「安装」才进注入集。
 *    旧逻辑把增量也写成 enabled，等于 sync 后自动安装，不合理。
 *
 * 已在表里（known）的一律不动——用户改过的永不被策略覆盖。
 * 调用方须自行判定 isFirstInit；损坏保护在 apply 层（trusted:false 绝不当首次）。
 *
 * @returns 仅含新写入项的增量表（known 里的名字不出现）
 */
export const computeDefaultSkillStates = (input: {
  /** 每个 team skill：name + 相对 clone 根的目录（hasActionMarker 已退役、不再参与判定） */
  skills: Array<{ name: string; relDir: string }>;
  /** 已在 skill-states 表里的名字（含用户手动改过的） */
  known: ReadonlySet<string>;
  /**
   * true = 表空 / 文件不存在（首次）；false = 表非空后的增量 sync。
   * 损坏文件绝不能传 true——由 applyDefaultSkillStates 在 trusted:false 时直接跳过。
   */
  isFirstInit: boolean;
}): Record<string, TeamSkillState> => {
  const next: Record<string, TeamSkillState> = {};
  // 首次全装；增量未装（市场里点「安装」）
  const defaultState: TeamSkillState = input.isFirstInit ? "enabled" : "disabled";
  for (const s of input.skills) {
    // 已在表里（用户改过 / 早批次默认）→ 不动；同批重名首个胜出
    if (input.known.has(s.name) || s.name in next) continue;
    next[s.name] = defaultState;
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

const SHARED_OWNER_FILE = ".flowship-owner.json";
const GITLAB_IDENTITY_CACHE_TTL_MS = 5 * 60 * 1000;
const gitLabIdentityCache = new Map<
  string,
  { identity: GitLabUploadIdentity; expiresAt: number }
>();

/** 用实际执行 push 的 GitLab Token 查询身份；operator/本地 git author 不作为新归属依据。 */
const getGitLabUploadIdentity = async (
  repoUrl: string,
  token: string,
): Promise<
  | { ok: true; identity: GitLabUploadIdentity }
  | { ok: false; error: string }
> => {
  const parsed = parseGitLabRepoUrl(repoUrl);
  if (!parsed) {
    return { ok: false, error: `无法解析共享库 GitLab 地址：${repoUrl}` };
  }
  const tokenDigest = createHash("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 12);
  const cacheKey = `${parsed.host}:${tokenDigest}`;
  const cached = gitLabIdentityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, identity: cached.identity };
  }
  try {
    const response = await fetch(`https://${parsed.host}/api/v4/user`, {
      method: "GET",
      headers: {
        "PRIVATE-TOKEN": token,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `无法确认 GitLab 上传身份（${response.status} ${response.statusText}）`,
      };
    }
    const body = (await response.json()) as Record<string, unknown>;
    const userId =
      typeof body.id === "number" && Number.isFinite(body.id)
        ? body.id
        : null;
    const username =
      typeof body.username === "string" ? body.username.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const emails = [
      body.email,
      body.public_email,
      body.commit_email,
    ]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    if (userId === null || !username) {
      return { ok: false, error: "GitLab 用户信息缺少 id/username" };
    }
    const identity: GitLabUploadIdentity = {
      host: parsed.host,
      userId,
      username,
      name: name || username,
      emails: [...new Set(emails)],
    };
    gitLabIdentityCache.set(cacheKey, {
      identity,
      expiresAt: Date.now() + GITLAB_IDENTITY_CACHE_TTL_MS,
    });
    return { ok: true, identity };
  } catch (err) {
    return {
      ok: false,
      error: `无法确认 GitLab 上传身份：${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
};

const readSharedSkillOwner = async (
  skillDir: string,
): Promise<SharedSkillOwner | null> => {
  try {
    return parseSharedSkillOwner(
      JSON.parse(
        await fs.readFile(path.join(skillDir, SHARED_OWNER_FILE), "utf-8"),
      ) as unknown,
    );
  } catch {
    return null;
  }
};

const writeSharedSkillOwner = async (
  skillDir: string,
  identity: GitLabUploadIdentity,
): Promise<void> => {
  await fs.writeFile(
    path.join(skillDir, SHARED_OWNER_FILE),
    `${JSON.stringify(ownerFromGitLabIdentity(identity), null, 2)}\n`,
    "utf-8",
  );
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

/**
 * 递归拷贝：先清空 dest（可选）、排除 .git / __pycache__ / *.pyc / .DS_Store，
 * 外加调用方给的顶层目录名（镜像用 MIRROR_EXCLUDED_TOP_DIRS）。
 *
 * `clearDest` 是镜像「整体替换」的关键：先 rm -rf dest 再重建，源仓删掉的文件
 * 不会在本地残留成幽灵（随后 `git add -A` 把删除也 stage 上）。
 * export 仅供单测（验排除规则 + 整体替换语义）。
 */
export const copyTree = async (
  src: string,
  dest: string,
  opts?: { excludeTopNames?: readonly string[]; clearDest?: boolean },
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
 * 用户改过的永不被策略覆盖。
 * 调用方（syncInternal）已持仓锁，这里直接读改写。
 *
 * 「首次」判定：读到的表为空（ENOENT 或合法空对象 `{}`）→ isFirstInit。
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
  // 表空 / 文件不存在（ENOENT→states:{}）= 首次；表非空 = 增量。损坏已在上方跳过。
  const isFirstInit = Object.keys(states).length === 0;
  const added = computeDefaultSkillStates({
    skills,
    known: new Set(Object.keys(states)),
    isFirstInit,
  });
  const addedNames = Object.keys(added);
  if (addedNames.length === 0) return;
  await writeTeamSkillStates({ ...states, ...added });
  const enabledCount = addedNames.filter((n) => added[n] === "enabled").length;
  const disabledCount = addedNames.length - enabledCount;
  console.log(
    isFirstInit
      ? `[team-library] 首次初始化 team skill ${addedNames.length} 个（默认安装 ${enabledCount}）`
      : `[team-library] sync 增量发现 team skill ${addedNames.length} 个（默认未安装 ${disabledCount}）`,
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

  // 顺带把数据分支（成员注册表）拉到 refs/remotes/origin/<branch>——读路径直接读它。
  // 只动 ref 不动工作树；分支可能压根还没人建，失败一律只 warn、绝不判 sync 失败。
  const dataFetch = await fetchDataBranch(
    teamLibraryRepoDir(),
    TEAM_LIBRARY_DATA_BRANCH,
    token,
  );
  if (!dataFetch.ok) {
    console.warn(
      `[team-library] 拉取数据分支 ${TEAM_LIBRARY_DATA_BRANCH} 失败（不阻断 sync）:`,
      dataFetch.error,
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
  | {
      ok: false;
      error: string;
      /** 敏感扫描命中（已脱敏）；有此字段时调用方勿推送 */
      sensitiveHits?: SecretScanHit[];
    };

/**
 * 敏感扫描的豁免前缀。
 *
 * `knowledge/` 下是知识库源仓的**整库机器镜像**：内容不由本机用户撰写，源仓与共享库
 * 同在一个 GitLab、受众相同，扫它挡不住任何真实泄露，只会撞满误报——高熵规则会把
 * py 脚本里的标识符、XML 属性值、文档里的示例 URL 全判成密钥（2026-07-27 实测：
 * 一次常规镜像仅 18 个变更文件就命中 106 处、无一为真），结果是镜像永远推不上去。
 *
 * 扫描真正要防的是「用户手动上传自管 skill 时带出私货」，那条路径只写 `skills/`。
 */
const SCAN_EXEMPT_PREFIXES = ["knowledge/"] as const;

/** 该 staged 路径是否需要过敏感扫描（export 供单测） */
export const shouldScanStagedPath = (relPath: string): boolean => {
  const p = relPath.replace(/\\/g, "/");
  return !SCAN_EXEMPT_PREFIXES.some((prefix) => p.startsWith(prefix));
};

/**
 * 读「已 staged、将推送」的新增/变更文本文件（跳过删除 / 二进制 / 豁免前缀）。
 * 在 git add -A 之后调用；路径相对 repoDir。
 */
const collectStagedTextFilesForScan = async (
  repoDir: string,
): Promise<SecretScanFile[]> => {
  // -z + ACMR：只看将写入远端的路径，NUL 分隔避空格坑
  const listed = await runGit(
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    repoDir,
  );
  if (!listed.ok || !listed.stdout) return [];
  const relPaths = listed.stdout.split("\0").filter(Boolean);
  const out: SecretScanFile[] = [];
  for (const rel of relPaths) {
    // 豁免前缀先挡掉（顺带省掉整棵镜像树的读盘）
    if (!shouldScanStagedPath(rel)) continue;
    const abs = path.resolve(repoDir, rel);
    // 锚定仓内（防御 git 吐出奇怪路径）
    if (!isStrictlyInside(repoDir, abs)) continue;
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch {
      continue; // 偶发消失 / 目录项跳过
    }
    // 二进制：NUL 或非打印占比过高
    if (buf.includes(0)) continue;
    const sample = buf.subarray(0, Math.min(buf.length, 8192));
    let nonPrintable = 0;
    for (let i = 0; i < sample.length; i++) {
      const c = sample[i]!;
      if (c === 9 || c === 10 || c === 13) continue;
      if (c < 32 || c === 127) nonPrintable++;
    }
    if (sample.length > 0 && nonPrintable / sample.length > 0.1) continue;
    out.push({
      path: rel.replace(/\\/g, "/"),
      content: buf.toString("utf-8"),
    });
  }
  return out;
};

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
  /**
   * true = 跳过敏感扫描（上传 dialog「确认无敏感信息、强制上传」误报出口）。
   * mirror 默认 false、始终扫描。
   */
  force?: boolean;
}): Promise<CommitPushResult> => {
  const {
    repoDir,
    cleanUrl,
    branch,
    token,
    message,
    restage,
    mrFallback,
    force = false,
  } = opts;
  // token 走 env + inline credential helper、push 用干净的 origin（不再拼 authed URL）
  const env = buildGitTokenEnv(token);

  const tryOnce = async (): Promise<
    | { ok: true }
    | {
        ok: false;
        error: string;
        kind: PushRejectionKind | "sensitive";
        sensitiveHits?: SecretScanHit[];
      }
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

    // 推送前敏感扫描（force 放行误报）；命中则不 commit
    const files = await collectStagedTextFilesForScan(repoDir);
    const hits = scanSensitiveFiles(files);
    const gate = gateSensitiveUpload(hits, force);
    if (gate.blocked) {
      return {
        ok: false,
        error: formatSensitiveScanError(gate.hits),
        kind: "sensitive",
        sensitiveHits: gate.hits,
      };
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
  // 敏感命中：不重试、不降级 MR，直接把脱敏清单抛给调用方
  if (first.kind === "sensitive") {
    return {
      ok: false,
      error: first.error,
      sensitiveHits: first.sensitiveHits,
    };
  }
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
  if (second.kind === "sensitive") {
    return {
      ok: false,
      error: second.error,
      sensitiveHits: second.sensitiveHits,
    };
  }
  // 重试路径上也可能撞保护分支（如首次误判）——同样降级（mirror 无降级参数则透传）
  if (second.kind === "protected" && mrFallback) return fallbackToMR(mrFallback);
  return { ok: false, error: second.error };
};

// ---------- 数据分支：多人自动写的小文件（成员注册表等） ----------

/**
 * 「每台 Flowship 自动写」的小文件放的**专用孤儿分支**。
 *
 * ⚠️ **这个分支不能开保护**：`main` 受保护、developer 直推被拒——注册表放 main
 * 等于自动注册永远失败。首次由有推送权限的人创建（或由第一个注册成功的人自动建）。
 * 详见 `docs/feishu-group-collab.md`。
 *
 * 孤儿分支（无父提交、树里只有那几个数据文件）：与 skill 库历史完全隔离，
 * 高频自动提交不会把 `main` 的历史搅乱，体积也可忽略。
 */
export const TEAM_LIBRARY_DATA_BRANCH = "members";

/** 仓根下的单层文件名白名单（拒目录 / 穿越 / 隐藏文件） */
const isSafeTeamLibraryFileName = (name: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name);

/** 分支名白名单（拼进 refspec，必须挡住空格 / `..` / 前导横杠等） */
const isSafeTeamLibraryBranch = (name: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/.test(name) && !name.includes("..");

/** 数据分支的远程跟踪 ref（单分支 clone 的默认 refspec 不含它，必须显式写） */
const dataBranchRef = (branch: string): string => `refs/remotes/origin/${branch}`;

const dataBranchRefspec = (branch: string): string =>
  `+refs/heads/${branch}:${dataBranchRef(branch)}`;

/**
 * 读某个 rev 下的文件内容（`git show <rev>:<path>`）。
 *
 * **刻意不走 `runGit`**：那层对 stdout 做凭据脱敏，那是给「命令输出」准备的，
 * 文件内容必须原样返回。rev / 文件不存在一律返 null（当「还没有」）。
 */
const showGitFile = async (
  repoDir: string,
  rev: string,
  relPath: string,
): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", ["show", `${rev}:${relPath}`], {
      cwd: repoDir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });
    return typeof stdout === "string" ? stdout : String(stdout);
  } catch {
    return null;
  }
};

/** fetch 数据分支到远程跟踪 ref。区分「分支还没人建」与「网络 / 认证挂了」 */
const fetchDataBranch = async (
  repoDir: string,
  branch: string,
  token: string,
): Promise<{ ok: boolean; exists: boolean; error?: string }> => {
  const r = await runGit(
    buildAuthedGitArgs(["fetch", "--no-tags", "origin", dataBranchRefspec(branch)]),
    repoDir,
    buildGitTokenEnv(token),
  );
  if (r.ok) return { ok: true, exists: true };
  // 分支还没被任何人创建过——这不是错误，第一个注册的人负责建它
  if (/couldn't find remote ref|no matching|not our ref/i.test(`${r.error}${r.stderr}`)) {
    return { ok: true, exists: false };
  }
  return { ok: false, exists: false, error: r.error };
};

/**
 * 读数据分支上的某个文件（**无锁、零副作用**）。
 *
 * 直接读上次 fetch 下来的 `origin/<branch>`——新鲜度由 `syncTeamLibrary` 负责
 *（它每轮顺带 fetch 这个分支）。分支 / 文件不存在返 null，调用方自行降级。
 */
export const readTeamLibraryBranchFile = async (opts: {
  relPath: string;
  branch?: string;
}): Promise<string | null> => {
  const branch = opts.branch ?? TEAM_LIBRARY_DATA_BRANCH;
  if (!isSafeTeamLibraryFileName(opts.relPath) || !isSafeTeamLibraryBranch(branch)) {
    return null;
  }
  return showGitFile(teamLibraryRepoDir(), dataBranchRef(branch), opts.relPath);
};

export type WriteTeamLibraryFileResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: string };

/** 读改写的最大轮数（每轮 = fetch → mutate → commit-tree → push） */
const WRITE_FILE_MAX_ATTEMPTS = 3;

/**
 * 在数据分支上**读改写单个文件**并直推（对外入口、进仓锁）。
 *
 * # 铁律：绝不动主克隆的 HEAD / 索引 / 工作树
 *
 * 团队库主克隆同时被 skill 同步 / 上传 / 镜像链路使用，`git checkout` 把 HEAD
 * 切走会直接搞坏它们。所以这条链**全程走底层 plumbing**、一次 checkout 都不做：
 *
 * ```
 * fetch  +refs/heads/<branch>:refs/remotes/origin/<branch>   ← 只动 ref
 * show   origin/<branch>:<file>                              ← 读旧内容（只读对象库）
 * hash-object -w  <仓库外的临时文件>                          ← 写 blob（只动对象库）
 * read-tree / update-index / write-tree（GIT_INDEX_FILE=临时索引）← 不碰 .git/index
 * commit-tree <tree> [-p <parent>]                           ← 造提交（不动 HEAD）
 * push origin <commit-sha>:refs/heads/<branch>               ← 只动远端 ref
 * ```
 *
 * 分支不存在时 `commit-tree` 不带 `-p`，推上去就是一条**孤儿分支**的根提交。
 *
 * # 其它语义
 *
 * - `mutate` 返回 null 或与原文相同 → 幂等成功（`changed:false`）、不造提交不 push
 * - push 撞 non-fast-forward（别人抢先写了）→ 重新 fetch 后整轮重来，最多 3 轮
 * - 保护分支拒绝 / 其它错误 → 直接返回错误，**不降级开 MR**（自动写入不值得开 MR、
 *   调用方按静默失败处理）
 * - 全程不写工作树，所以**不需要任何收尾恢复**——失败最多在对象库里留几个
 *   悬空对象，git gc 自己会清
 */
export const writeTeamLibraryBranchFile = async (opts: {
  /** 仓根下的文件名（单层、白名单校验） */
  relPath: string;
  branch?: string;
  /** 收到分支上的最新原文（不存在 = null）→ 返回新内容；返 null = 无需改动 */
  mutate: (currentRaw: string | null) => Promise<string | null> | string | null;
  message: string;
}): Promise<WriteTeamLibraryFileResult> =>
  withTeamLibraryLock(() => writeTeamLibraryBranchFileInternal(opts));

const writeTeamLibraryBranchFileInternal = async (opts: {
  relPath: string;
  branch?: string;
  mutate: (currentRaw: string | null) => Promise<string | null> | string | null;
  message: string;
}): Promise<WriteTeamLibraryFileResult> => {
  const { relPath, mutate, message } = opts;
  const branch = opts.branch ?? TEAM_LIBRARY_DATA_BRANCH;
  if (!isSafeTeamLibraryFileName(relPath)) {
    return { ok: false, error: `relPath 非法（只允许仓根单层文件名）：${relPath}` };
  }
  if (!isSafeTeamLibraryBranch(branch)) {
    return { ok: false, error: `分支名非法：${branch}` };
  }
  const token = await readGitToken();
  if (!token) {
    return { ok: false, error: "未配置 GitLab Token（设置页 gitToken）" };
  }
  const repoDir = teamLibraryRepoDir();
  // 本函数只用对象库 + ref，不自愈克隆（那是 sync 的事）——没克隆就等下一轮
  if (!(await pathExists(path.join(repoDir, ".git")))) {
    return { ok: false, error: "团队库尚未同步到本机（等启动 sync 完成后自动重试）" };
  }
  const env = buildGitTokenEnv(token);
  // 临时索引 + 暂存内容都放系统临时目录：绝不能落在仓库工作树里
  // （会被 `git clean -fd` 删、或被 upload 的 `git add -A` 捡走）
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowship-tl-"));
  const indexFile = path.join(tmpDir, "index");
  const blobFile = path.join(tmpDir, "blob");
  const indexEnv = { ...process.env, GIT_INDEX_FILE: indexFile };

  let lastError = "";
  try {
    for (let attempt = 0; attempt < WRITE_FILE_MAX_ATTEMPTS; attempt++) {
      // 1) 对齐远端分支（只动 refs/remotes，不碰工作树）
      const fetched = await fetchDataBranch(repoDir, branch, token);
      if (!fetched.ok) {
        lastError = `fetch ${branch} 失败：${fetched.error}`;
        continue; // 网络抖动：下一轮再试
      }

      // 2) 读分支上的当前内容 → 调用方合并
      const parent = fetched.exists
        ? (await runGit(["rev-parse", "--verify", "-q", dataBranchRef(branch)], repoDir))
        : null;
      const parentSha = parent?.ok ? parent.stdout.trim() : "";
      const currentRaw = parentSha
        ? await showGitFile(repoDir, parentSha, relPath)
        : null;
      const next = await mutate(currentRaw);
      if (next === null || next === currentRaw) {
        return { ok: true, changed: false };
      }

      // 3) 内容 → blob（--no-filters：按字节存，不受 autocrlf 等本地配置影响）
      await fs.writeFile(blobFile, next, "utf-8");
      const hashed = await runGit(
        ["hash-object", "-w", "--no-filters", "--", blobFile],
        repoDir,
      );
      if (!hashed.ok) {
        lastError = `git hash-object 失败：${hashed.error}`;
        break;
      }
      const blobSha = hashed.stdout.trim();

      // 4) 临时索引造树：有父就以父树打底（保住分支上别的文件），否则从空树起
      await fs.rm(indexFile, { force: true });
      if (parentSha) {
        const readTree = await runGit(["read-tree", parentSha], repoDir, indexEnv);
        if (!readTree.ok) {
          lastError = `git read-tree 失败：${readTree.error}`;
          break;
        }
      }
      const updateIndex = await runGit(
        ["update-index", "--add", "--cacheinfo", `100644,${blobSha},${relPath}`],
        repoDir,
        indexEnv,
      );
      if (!updateIndex.ok) {
        lastError = `git update-index 失败：${updateIndex.error}`;
        break;
      }
      const written = await runGit(["write-tree"], repoDir, indexEnv);
      if (!written.ok) {
        lastError = `git write-tree 失败：${written.error}`;
        break;
      }
      const treeSha = written.stdout.trim();

      // 5) 造提交（不动 HEAD）；无父 = 孤儿分支的根提交
      const committed = await runGit(
        [
          "commit-tree",
          treeSha,
          ...(parentSha ? ["-p", parentSha] : []),
          "-m",
          message,
        ],
        repoDir,
      );
      if (!committed.ok) {
        lastError = `git commit-tree 失败：${committed.error}`;
        break;
      }
      const commitSha = committed.stdout.trim();

      // 6) 推 sha 到远端分支（本地一个分支都不建）
      const push = await runGit(
        buildAuthedGitArgs([
          "push",
          "origin",
          `${commitSha}:refs/heads/${branch}`,
        ]),
        repoDir,
        env,
      );
      if (push.ok) {
        // 推的是裸 sha（本地没建分支），远程跟踪 ref 不会自动前进——手动对齐，
        // 否则「刚写完立刻读」会读到旧内容 / 分支首建时压根读不到
        const updated = await runGit(
          ["update-ref", dataBranchRef(branch), commitSha],
          repoDir,
        );
        if (!updated.ok) {
          console.warn(
            `[team-library] 推送成功但更新 ${dataBranchRef(branch)} 失败（下次 sync 兜底）:`,
            updated.error,
          );
        }
        return { ok: true, changed: true };
      }

      lastError = `git push 失败：${push.error}`;
      // 只有「别人抢先写了」值得重来；保护分支 / 钩子拒绝重试也没用
      if (classifyPushRejection(push.error + push.stderr) !== "non-fast-forward") {
        break;
      }
      console.warn(
        `[team-library] ${branch}:${relPath} push 撞并发写、重新 fetch 后重试（第 ${attempt + 1} 轮）`,
      );
    }
    return { ok: false, error: lastError || "写共享库失败" };
  } catch (err) {
    return {
      ok: false,
      error: redactGitText(err instanceof Error ? err.message : String(err)),
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
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
  /** 敏感扫描命中清单（已脱敏）；有则未推送 */
  sensitiveHits?: SecretScanHit[];
};

/** upload 实现体（不加锁）：对外入口 uploadSkillsToTeamLibrary 持仓锁后进来 */
const uploadSkillsInternal = async (
  names: string[],
  category: string,
  opts?: { force?: boolean },
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
  const identity = await getGitLabUploadIdentity(cfg.repoUrl, token);
  if (!identity.ok) {
    return {
      ok: false,
      results: unique.map((name) => ({
        name,
        ok: false,
        error: identity.error,
      })),
      error: identity.error,
    };
  }
  const repoDir = teamLibraryRepoDir();
  // 上传前先列一次、作 app skill json 缺失时的兜底；优先读自管目录现成 json
  const actions = await listCustomActions();
  // 全库跨分类索引 + 创建人（stage 循环内复用；restage 时再扫一轮）
  const loadConflictContext = async () => {
    const sharedEntries = await listSharedSkillDirs(repoDir);
    const authorIdentities = await getTeamSkillAuthorIdentities(repoDir);
    const authors = Object.fromEntries(
      Object.entries(authorIdentities).map(([relDir, author]) => [
        relDir,
        author.name,
      ]),
    );
    return { sharedEntries, authors, authorIdentities };
  };

  const stageAll = async (): Promise<UploadSkillResult[]> => {
    const { sharedEntries, authors, authorIdentities } =
      await loadConflictContext();
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
      if (conflict.status === "overwrite") {
        const relDir = `skills/${category}/${name}`;
        const existingDir = path.join(repoDir, relDir);
        const decision = decideSharedSkillUpdate({
          exists: true,
          owner: await readSharedSkillOwner(existingDir),
          legacyAuthor: authors[relDir],
          legacyAuthorEmail: authorIdentities[relDir]?.email,
          currentUser: identity.identity,
        });
        if (!decision.allowed) {
          results.push({ name, ok: false, error: decision.reason });
          continue;
        }
      }
      try {
        await copyAppSkillIntoRepo(name, repoDir, category);
        const uploadedSkillDir = path.join(
          repoDir,
          "skills",
          category,
          name,
        );
        // 本地目录内容不可信任其 owner 文件；每次都用实际 GitLab token 身份覆盖写入。
        await writeSharedSkillOwner(uploadedSkillDir, identity.identity);
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
              uploadedSkillDir,
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
    // dialog「确认无敏感信息」勾选后带 force 放行误报
    force: opts?.force === true,
  });

  if (!push.ok) {
    return {
      ok: false,
      results: results.map((r) =>
        r.ok ? { ...r, ok: false, error: push.error } : r,
      ),
      error: push.error,
      ...(push.sensitiveHits ? { sensitiveHits: push.sensitiveHits } : {}),
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
 * opts.force：跳过敏感扫描阻断（误报出口；默认仍扫描）。
 */
export const uploadSkillsToTeamLibrary = async (
  names: string[],
  category: string,
  opts?: { force?: boolean },
): Promise<UploadSkillsResult> =>
  withTeamLibraryLock(() => uploadSkillsInternal(names, category, opts));

/**
 * 镜像时排除的**源仓顶层目录**（单一来源、只在这里列一次，由 copyTree 的
 * excludeTopNames 消费——不散落成到处 if 的路径黑名单）：
 *
 * - `codes/`：历史遗留的大体积代码样本
 * - `harness-delivery-hub/`：交付平台服务端项目（delivery-fe + delivery-server +
 *   docker-compose，实测 1.2M / 176 文件、0 个 SKILL.md）——是可部署服务、不是知识内容，
 *   镜像进来只白撑共享库体积
 */
export const MIRROR_EXCLUDED_TOP_DIRS = [
  "codes",
  "harness-delivery-hub",
] as const;

/**
 * 从 `git ls-remote --symref <url> HEAD` 输出里解析远端默认分支名。
 * 典型输出（第一行才是 symref）：
 * ```
 * ref: refs/heads/release/1.0	HEAD
 * ed319c8b81358256217570f5b38c329ad0487409	HEAD
 * ```
 * 解析不到（老 git / 远端不给 symref / 空输出）返 null，调用方回退配置值。
 */
export const parseSymrefDefaultBranch = (stdout: string): string | null => {
  const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD\s*$/m.exec(stdout);
  const branch = m?.[1]?.trim();
  return branch ? branch : null;
};

/**
 * 探测源仓的远端默认分支。
 *
 * 为什么不写死：默认分支归对方仓库维护者管（wk-harness-platform 当前是
 * `release/1.0`、`main` 反而是另一条受保护的分支），写死等于对方改一次我们就
 * clone 到空分支或直接失败。探测失败一律返 null、不阻断，由调用方回退配置值。
 */
const detectRemoteDefaultBranch = async (
  cleanUrl: string,
  token: string,
): Promise<string | null> => {
  const r = await runGit(
    buildAuthedGitArgs(["ls-remote", "--symref", cleanUrl, "HEAD"]),
    undefined,
    buildGitTokenEnv(token),
  );
  if (!r.ok) {
    console.warn("[team-library] 探测源仓默认分支失败、回退配置分支:", r.error);
    return null;
  }
  return parseSymrefDefaultBranch(r.stdout);
};

/**
 * 镜像实际使用的源分支：探到的远端默认分支优先、探不到或不合法回退配置值。
 * 必须过分支名白名单——它会被拼进 `git clone --branch` / `fetch` 的参数位。
 */
export const resolveMirrorSourceBranch = (
  detected: string | null,
  configured: string,
): string =>
  detected && isSafeTeamLibraryBranch(detected) ? detected : configured;

/** mirror 实现体（不加锁）：对外入口 mirrorKnowledgeBase 持仓锁后进来 */
const mirrorKnowledgeBaseInternal = async (): Promise<{
  ok: boolean;
  error?: string;
  sensitiveHits?: SecretScanHit[];
}> => {
  const token = await readGitToken();
  if (!token) {
    return { ok: false, error: "未配置 GitLab Token（设置页 gitToken）" };
  }
  const cfg = await getTeamLibraryConfig();

  // 1) 同步共享库（目标仓）——已持仓锁、走不加锁的 syncInternal
  const sync = await syncInternal();
  if (!sync.ok) return { ok: false, error: sync.error };

  // 2) 同步知识库源缓存（分支：探远端默认分支优先、配置值兜底）
  const sourceBranch = resolveMirrorSourceBranch(
    await detectRemoteDefaultBranch(cfg.knowledgeSourceUrl, token),
    cfg.knowledgeSourceBranch,
  );
  const srcEnsured = await ensureRepoAt({
    dir: teamLibraryKnowledgeSrcDir(),
    cleanUrl: cfg.knowledgeSourceUrl,
    branch: sourceBranch,
    token,
  });
  if (!srcEnsured.ok) {
    return { ok: false, error: `知识库源同步失败：${srcEnsured.error}` };
  }

  const repoDir = teamLibraryRepoDir();
  const knowledgeDest = path.join(repoDir, "knowledge");

  // clearDest：整棵 knowledge/ 先删后建——源仓结构调整 / 删文件时本地不留幽灵，
  // 随后的 `git add -A` 会把这些删除一并 stage 上去
  const stageMirror = async (): Promise<void> => {
    await copyTree(teamLibraryKnowledgeSrcDir(), knowledgeDest, {
      clearDest: true,
      excludeTopNames: MIRROR_EXCLUDED_TOP_DIRS,
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
    message: "chore(knowledge): mirror wk-harness-platform from Flowship",
    restage: stageMirror,
  });
  if (!push.ok) {
    return {
      ok: false,
      error: push.error,
      ...(push.sensitiveHits ? { sensitiveHits: push.sensitiveHits } : {}),
    };
  }
  return { ok: true };
};

/**
 * 把 wk-harness-platform 镜像进共享库 `knowledge/`（对外入口、进仓锁）。
 * 源分支走远端默认分支探测；排除 .git / __pycache__ / *.pyc /
 * MIRROR_EXCLUDED_TOP_DIRS；`knowledge/` 不过敏感扫描（见 SCAN_EXEMPT_PREFIXES）。
 */
export const mirrorKnowledgeBase = async (): Promise<{
  ok: boolean;
  error?: string;
  sensitiveHits?: SecretScanHit[];
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

export type TeamUploadPermission = {
  category: string;
  canUpdate: boolean;
  author?: string;
  reason?: string;
};

export type TeamUploadPermissionsResult =
  | {
      ok: true;
      permissions: Record<string, TeamUploadPermission>;
    }
  | { ok: false; error: string; permissions: Record<string, never> };

/**
 * 上传弹窗使用的只读归属快照。不存在于 permissions 的名字是新上传；
 * 已存在项必须明确 canUpdate=true 才能在 UI 解禁，服务端 POST 仍会再次校验。
 */
export const getTeamUploadPermissions =
  async (): Promise<TeamUploadPermissionsResult> => {
    const token = await readGitToken();
    if (!token) {
      return {
        ok: false,
        error: "未配置 GitLab Token",
        permissions: {},
      };
    }
    const cfg = await getTeamLibraryConfig();
    const identity = await getGitLabUploadIdentity(cfg.repoUrl, token);
    if (!identity.ok) {
      return { ok: false, error: identity.error, permissions: {} };
    }
    const repoDir = teamLibraryRepoDir();
    const [entries, authorIdentities] = await Promise.all([
      listSharedSkillDirs(repoDir),
      getTeamSkillAuthorIdentities(repoDir),
    ]);
    const counts = new Map<string, number>();
    for (const entry of entries) {
      counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    }

    const permissions: Record<string, TeamUploadPermission> = {};
    for (const entry of entries) {
      const relDir = `skills/${entry.category}/${entry.name}`;
      const authorIdentity = authorIdentities[relDir];
      const author = authorIdentity?.name.trim() || undefined;
      if ((counts.get(entry.name) ?? 0) > 1) {
        permissions[entry.name] = {
          category: entry.category,
          canUpdate: false,
          ...(author ? { author } : {}),
          reason: "库内存在多个同名分类，不能自动覆盖",
        };
        continue;
      }
      const owner = await readSharedSkillOwner(entry.absDir);
      const decision = decideSharedSkillUpdate({
        exists: true,
        owner,
        legacyAuthor: author,
        legacyAuthorEmail: authorIdentity?.email,
        currentUser: identity.identity,
      });
      permissions[entry.name] = {
        category: entry.category,
        canUpdate: decision.allowed,
        ...(author ? { author } : {}),
        ...(!decision.allowed ? { reason: decision.reason } : {}),
      };
    }
    return { ok: true, permissions };
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
