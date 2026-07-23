/**
 * 团队库 skill「创建人」索引（2026-07-22 三件收尾之一）
 *
 * 从共享库 clone 的 git 历史解析每个 skill 目录的首次引入者：
 *   creator = 第一个新增该目录 SKILL.md 的 commit 的 author。
 *
 * 设计要点：
 * - **一次全量扫描建索引**（`git log --reverse --diff-filter=A --name-only`）、
 *   不做 per-skill 的 59 次 git 调用；
 * - 结果缓存在 globalThis、缓存键含 HEAD sha——sync 拉到新提交后 HEAD 变、自动重建；
 * - cache miss 时 inFlight promise 单飞（并发调用只打一次全量 git log）；
 * - 零业务依赖（只 fs 无关的 child_process/path）——app-skills 与 team-library
 *   都要消费它、放独立小模块避免循环 import（与 team-skill-states 同理）。
 *
 * 错误语义：git 失败 / 目录不存在 → 返回空索引（作者是锦上添花展示、不阻断列表）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// git log 单条 commit 头行的前缀标记（\x01 不会出现在 author 名里、天然分隔）
const COMMIT_MARK = "\u0001";

/**
 * 解析 `git log --reverse --diff-filter=A --name-only --format=%x01%aN` 输出 →
 * { skill 目录相对路径（SKILL.md 的父目录、posix 分隔） → 首次引入者 }。
 * --reverse 保证时间正序、首个命中即创建人；后续 commit 再新增同路径（删了重加）不覆盖。
 * 导出供单测。
 */
export const parseAuthorIndexFromGitLog = (
  stdout: string,
): Record<string, string> => {
  const byDir: Record<string, string> = {};
  let author = "";
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(COMMIT_MARK)) {
      author = line.slice(1).trim();
      continue;
    }
    // 只认 SKILL.md 的新增记录（skill 目录粒度的锚点文件）
    if (!author || !line.endsWith("SKILL.md")) continue;
    const dir = line.slice(0, -"/SKILL.md".length);
    if (!dir || dir === line) continue; // 根目录裸 SKILL.md 不索引
    if (!(dir in byDir)) byDir[dir] = author;
  }
  return byDir;
};

// ---------- globalThis 缓存（key 含 HEAD sha、防 route-chunk/HMR 分裂） ----------

const AUTHOR_CACHE_KEY = "__flowshipTeamSkillAuthorsV1__";

type AuthorCache = {
  /** 建索引时的 HEAD sha；sync 后 HEAD 变则重建 */
  headSha: string;
  byDir: Record<string, string>;
} | null;

type AuthorState = {
  cache: AuthorCache;
  /** cache miss 时进行中的建索引 promise（同 HEAD 并发去重） */
  inFlight: Promise<Record<string, string>> | null;
  /** inFlight 对应的 HEAD（HEAD 变了不能搭旧车） */
  inFlightHead: string | null;
};

const getAuthorState = (): AuthorState => {
  const g = globalThis as unknown as Record<string, AuthorState | undefined>;
  if (!g[AUTHOR_CACHE_KEY]) {
    g[AUTHOR_CACHE_KEY] = {
      cache: null,
      inFlight: null,
      inFlightHead: null,
    };
  }
  return g[AUTHOR_CACHE_KEY]!;
};

/** 单测用：清掉缓存 / inFlight，避免用例互相污染 */
export const __resetTeamSkillAuthorsForTest = (): void => {
  const g = globalThis as unknown as Record<string, AuthorState | undefined>;
  g[AUTHOR_CACHE_KEY] = {
    cache: null,
    inFlight: null,
    inFlightHead: null,
  };
};

/** 只读 git 调用（不需要 token / 不需要仓锁；失败返回 null） */
const runGitReadonly = async (
  repoDir: string,
  args: string[],
): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return typeof stdout === "string" ? stdout : String(stdout);
  } catch {
    return null;
  }
};

type RunGitReadonly = (
  repoDir: string,
  args: string[],
) => Promise<string | null>;

/**
 * 拿共享库 clone 全部 skill 目录的创建人索引（相对 clone 根、posix 路径）。
 * 失败 fail-open 返回空表——调用方拿不到 author 就不显示、不报错。
 *
 * @param _testRunGit 仅单测注入（替代真实 git）；生产勿传。
 */
export const getTeamSkillAuthors = async (
  repoDir: string,
  _testRunGit?: RunGitReadonly,
): Promise<Record<string, string>> => {
  const runGit = _testRunGit ?? runGitReadonly;
  const state = getAuthorState();
  const head = (await runGit(repoDir, ["rev-parse", "HEAD"]))?.trim();
  if (!head) return {};
  if (state.cache && state.cache.headSha === head) return state.cache.byDir;

  // 同 HEAD 的 inFlight 单飞：并发 cache miss 只打一次全量 git log
  if (state.inFlight && state.inFlightHead === head) {
    return state.inFlight;
  }

  const run = (async (): Promise<Record<string, string>> => {
    const log = await runGit(repoDir, [
      "log",
      "--reverse",
      // A=新增、R=改名（目录被 git mv 重组时旧 A 记录挂在旧路径上，
      // 只认 A 会漏掉新路径——rename commit 的 author 作为兜底归属）
      "--diff-filter=AR",
      "--name-only",
      `--format=%x01%aN`,
      "--",
      "skills",
      "knowledge/skills",
    ]);
    const byDir = log ? parseAuthorIndexFromGitLog(log) : {};
    state.cache = { headSha: head, byDir };
    return byDir;
  })();

  state.inFlight = run;
  state.inFlightHead = head;
  try {
    return await run;
  } finally {
    // 只清自己发起的那趟（防止晚到的 finally 清掉更新一轮的 inFlight）
    if (state.inFlight === run) {
      state.inFlight = null;
      state.inFlightHead = null;
    }
  }
};
