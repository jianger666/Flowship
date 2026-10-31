/**
 * app 自管 Skill 管理（V0.13-P1 独立化、设置页 Skills 卡的 server 侧）
 *
 * 目录布局：`<dataRoot>/skills/<skill 名>/SKILL.md`（+ 可能的附属文件、导入时整目录拷）。
 * 只有这个目录下的 skill 可增删改；平台内置 / 飞书 CLI 官方只读展示。
 * Cursor 全局（~/.cursor/skills）仅作「从 Cursor 导入」数据源、不进列表 / 不注入。
 *
 * 安全约束：skill 名做目录名白名单校验（字母数字中文 - _ .、拒绝路径穿越）、
 * 所有写操作都锚定在 getAppSkillsDir() 之下。与 app-rules isSafeRuleName 同构。
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getGlobalCursorDirs } from "./cursor-config";
import { writeFileFsynced } from "./data-root";
import { getToolsSkillsDir } from "./feishu-cli";
import {
  getAppSkillsDir,
  getGlobalAgentsSkillsDir,
  scanSkillsDir,
  type SkillEntry,
} from "./skills-loader";
import { readSettingsFile } from "./settings-fs";
import {
  getTeamLibraryKnowledgeRoot,
  getTeamLibraryKnowledgeSkillsDir,
  getTeamLibrarySkillsDir,
  teamLibraryRepoDir,
} from "./team-library";
import { getTeamSkillAuthors } from "./team-skill-authors";

/**
 * skill 来源（设置页标签 + 是否可编辑的判定；不含 Cursor 全局——那只作导入源）。
 * - global-std = agentskills.io 标准全局目录 ~/.agents/skills/（用户自装）
 * - project-std = agentskills.io 标准项目目录 <repo>/.agents/skills/（用户加入仓库）
 * 这两个 + app / feishu-cli 都是「可管理」源：可开关、可删除；builtin / team 只读。
 */
export type SkillSource =
  | "builtin"
  | "app"
  | "feishu-cli"
  | "global-std"
  | "project-std"
  | "team";

/** 可管理源（可开关 / 可删除；与 skills-loader 的 disabledSkills 门禁范围一致） */
export const MANAGEABLE_SKILL_SOURCES: readonly SkillSource[] = [
  "app",
  "feishu-cli",
  "global-std",
  "project-std",
];

export const isManageableSkillSource = (source: SkillSource): boolean =>
  MANAGEABLE_SKILL_SOURCES.includes(source);

export interface SkillWithSource extends SkillEntry {
  source: SkillSource;
  /** 只有 app 自管的可编辑 / 删除 */
  editable: boolean;
  /** 仅 project-std 源：skill 所在仓根路径（删除 API 要回传） */
  repoPath?: string;
  /**
   * 仅 source=team：来自 clone `skills/<cat>/...` → `shared:<cat>`（如 shared:fe）；
   * 来自 `knowledge/skills/<dir>/...` → `<dir>` 原样（如 global/frontend，路径推导不写死枚举）。
   */
  teamCategory?: string;
  /** 仅 source=team：同目录有 .flowship-action.json（安装时会顺带挂 custom action） */
  hasActionMarker?: boolean;
  /** 仅 source=team：创建人（共享库 git 历史首次引入者；解析不到不带） */
  author?: string;
}

/** SKILL.md 同目录是否有 .flowship-action.json */
const hasActionMarkerFor = async (skillMdAbsPath: string): Promise<boolean> => {
  try {
    await fs.stat(
      path.join(path.dirname(skillMdAbsPath), ".flowship-action.json"),
    );
    return true;
  } catch {
    return false;
  }
};

// skill 名 = 目录名：字母数字中文 + ._-、首字符不能是点（拦 `..`）；拒绝 / \
const isSafeSkillName = (name: string): boolean =>
  /^[a-zA-Z0-9\u4e00-\u9fa5][a-zA-Z0-9\u4e00-\u9fa5._-]{0,63}$/.test(name);

/** 按来源列全部 skill（不去重——同名多来源都展示、用户能看清覆盖关系） */
export const listSkillsWithSource = async (
  opts?: { repoPaths?: string[] },
): Promise<SkillWithSource[]> => {
  const out: SkillWithSource[] = [];
  const push = (
    entries: SkillEntry[],
    source: SkillSource,
    extra?: { repoPath?: string },
  ) => {
    for (const e of entries) {
      out.push({
        ...e,
        source,
        // 编辑仍仅 app 自管（其它源的编辑会静默写成 app 副本、语义混乱）；
        // 删除能力由 isManageableSkillSource 判定、不占 editable 字段
        editable: source === "app",
        ...(extra?.repoPath ? { repoPath: extra.repoPath } : {}),
      });
    }
  };
  push(await scanSkillsDir(path.join(process.cwd(), "skills")), "builtin");
  push(await scanSkillsDir(getAppSkillsDir()), "app");
  push(await scanSkillsDir(getToolsSkillsDir()), "feishu-cli");
  // agentskills 标准全局 / 项目目录（用户自装能力；此前不在设置页露出、盲区收口）
  push(await scanSkillsDir(getGlobalAgentsSkillsDir()), "global-std");
  for (const repo of opts?.repoPaths ?? []) {
    const root = String(repo ?? "").trim();
    if (!root) continue;
    push(
      await scanSkillsDir(path.join(root, ".agents", "skills")),
      "project-std",
      { repoPath: root },
    );
  }
  // team 条目附创建人：git 历史索引（HEAD 级缓存、失败空表不阻断）
  const repoDir = teamLibraryRepoDir();
  const authors = await getTeamSkillAuthors(repoDir);
  const authorOf = (skillMdAbsPath: string): string | undefined => {
    const relDir = path
      .relative(repoDir, path.dirname(skillMdAbsPath))
      .split(path.sep)
      .join("/");
    return authors[relDir];
  };
  // 组共享库 skills/<cat>/<name>/ → teamCategory = shared:<cat>（路径推导）
  // 相对路径 ≥3 段（cat/skill/SKILL.md）取顶层为 cat；旧扁平 skills/<name>/SKILL.md → common
  const sharedDir = getTeamLibrarySkillsDir();
  const sharedEntries = await scanSkillsDir(sharedDir, {
    enforceTeamName: true,
  });
  for (const e of sharedEntries) {
    const parts = path
      .relative(sharedDir, e.absPath)
      .split(path.sep)
      .filter(Boolean);
    const category = parts.length >= 3 ? (parts[0] ?? "common") : "common";
    out.push({
      ...e,
      source: "team",
      editable: false,
      teamCategory: `shared:${category}`,
      hasActionMarker: await hasActionMarkerFor(e.absPath),
      ...(authorOf(e.absPath) ? { author: authorOf(e.absPath) } : {}),
    });
  }
  // 知识库镜像 knowledge/skills/<dir>/... → teamCategory = <dir>（路径推导）
  const kbRoot = getTeamLibraryKnowledgeRoot();
  const kbSkillsDir = getTeamLibraryKnowledgeSkillsDir();
  const kbEntries = await scanSkillsDir(kbSkillsDir, {
    enforceTeamName: true,
  });
  for (const e of kbEntries) {
    const rel = path.relative(kbSkillsDir, e.absPath);
    const top = rel.split(path.sep).filter(Boolean)[0] ?? "";
    out.push({
      ...e,
      kbRoot,
      source: "team",
      editable: false,
      teamCategory: top || "unknown",
      hasActionMarker: await hasActionMarkerFor(e.absPath),
      ...(authorOf(e.absPath) ? { author: authorOf(e.absPath) } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

const normRepoPath = (p: string): string =>
  String(p ?? "").trim().replace(/[/\\]+$/, "");

/**
 * 在列表里挑出要读的那条：name 必须一致；可选 source 消歧同名多来源；
 * 可选 repoPath 消歧「多个仓有同名项目级 skill」（S13-06：原来永远命中第一个仓）。
 * 未指定的维度按列表顺序取首个命中。
 */
export const pickSkillHit = <
  T extends { name: string; source: SkillSource; repoPath?: string },
>(
  all: T[],
  name: string,
  source?: SkillSource,
  repoPath?: string,
): T | undefined => {
  const repo = repoPath ? normRepoPath(repoPath) : "";
  return all.find(
    (s) =>
      s.name === name &&
      (!source || s.source === source) &&
      (!repo || (s.repoPath !== undefined && normRepoPath(s.repoPath) === repo)),
  );
};

/**
 * 按名读任意已知来源 skill 的 SKILL.md 全文（只读详情 / 编辑共用）。
 * 可选 source 消歧同名；可选 repoPath 在多个仓同名项目级 skill 时指定仓；
 * 未指定时按列表顺序取首个命中。
 * 名字必须落在 listSkillsWithSource 结果内——防任意路径读。
 */
export const readSkillContentByName = async (
  name: string,
  source?: SkillSource,
  repoPath?: string,
): Promise<string | null> => {
  if (!isSafeSkillName(name)) return null;
  // 项目级源也要能查到（设置页「查看」用）：带已登记仓根路径；读失败退化为非项目源
  let repoPaths: string[] | undefined;
  try {
    const result = await readSettingsFile();
    if (result.status === "ok") {
      // settings 读盘结果是宽类型、repos 字段显式收窄（与 previewCommandFor 同套路）
      const repos = Array.isArray(result.settings?.repos)
        ? (result.settings.repos as Array<{ path?: unknown }>)
        : [];
      repoPaths = repos
        .map((r) => String(r?.path ?? "").trim())
        .filter(Boolean);
    }
  } catch {
    // 忽略
  }
  const all = await listSkillsWithSource({ repoPaths });
  const hit = pickSkillHit(all, name, source, repoPath);
  if (!hit) return null;
  try {
    return await fs.readFile(hit.absPath, "utf-8");
  } catch {
    return null;
  }
};

/**
 * 新增 / 覆盖 app 自管 skill（写 `<dataRoot>/skills/<name>/SKILL.md`）
 * @returns null = 成功；string = 用户可读的失败原因
 */
export const writeAppSkill = async (
  name: string,
  content: string,
): Promise<string | null> => {
  if (!isSafeSkillName(name)) {
    return "skill 名只能用字母 / 数字 / 中文 / - _ .（将作为目录名）";
  }
  if (!content.trim()) return "SKILL.md 内容不能为空";
  const dir = path.join(getAppSkillsDir(), name);
  const file = path.join(dir, "SKILL.md");
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.mkdir(dir, { recursive: true });
    // 先写临时文件再 rename 覆盖：写到一半失败（磁盘满 / 被打断）时旧 SKILL.md 不会被截成半截；
    // rename 之前 fsync(tmp)（Q9-04）：断电后不会得到 0 字节的 SKILL.md——这是用户自己写的内容，丢了没处找
    await writeFileFsynced(tmp, content);
    await fs.rename(tmp, file);
    return null;
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return `写入失败：${err instanceof Error ? err.message : String(err)}`;
  }
};

/** 各可管理源的删除锚点根目录（project-std 需 repoPath 且仓已在 settings.repos 登记） */
const deletionRootFor = async (
  source: SkillSource,
  repoPath?: string,
): Promise<string | null> => {
  if (source === "app") return getAppSkillsDir();
  if (source === "feishu-cli") return getToolsSkillsDir();
  if (source === "global-std") return getGlobalAgentsSkillsDir();
  if (source === "project-std") {
    const root = String(repoPath ?? "").trim();
    if (!root) return null;
    // 只允许删「设置页已登记仓」下的项目级 skill——防拿任意路径当仓库
    try {
      const result = await readSettingsFile();
      const repos =
        result.status === "ok" && Array.isArray(result.settings?.repos)
          ? (result.settings.repos as Array<{ path?: unknown }>)
          : [];
      const norm = (p: string) => String(p ?? "").replace(/[/\\]+$/, "");
      if (!repos.some((r) => norm(String(r?.path)) === norm(root))) return null;
    } catch {
      return null;
    }
    return path.join(root, ".agents", "skills");
  }
  return null; // builtin / team 不是可管理源
};

/**
 * 删除任意可管理源 skill（整目录删、含附属文件）；不存在也当成功（幂等）。
 * 可管理源 = app 自管 / 飞书 CLI / 全局 ~/.agents/skills / 项目 <repo>/.agents/skills
 * （都是用户意向安装/加入的，允许真删；飞书 CLI 源重装 lark-cli 可能装回、接受）。
 * builtin / team 只读 → 返回用户可读原因。
 */
export const deleteSkillBySource = async (
  name: string,
  source: SkillSource,
  opts?: { repoPath?: string },
): Promise<string | null> => {
  if (!isSafeSkillName(name)) return "skill 名非法";
  if (!isManageableSkillSource(source))
    return `${source} 来源的 skill 不可删除`;
  const root = await deletionRootFor(source, opts?.repoPath);
  if (!root) return "仓库未在设置里登记，拒绝删除项目级 skill";
  // 锚定校验：目标必须真落在根目录下（isSafeSkillName 已拦穿越字符、这里双保险）
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, name);
  if (!target.startsWith(resolvedRoot + path.sep)) return "skill 路径非法";
  try {
    await fs.rm(target, { recursive: true, force: true });
    return null;
  } catch (err) {
    return `删除失败：${err instanceof Error ? err.message : String(err)}`;
  }
};

/** 删除 app 自管 skill（兼容旧调用方；完整能力见 deleteSkillBySource） */
export const deleteAppSkill = async (name: string): Promise<string | null> =>
  deleteSkillBySource(name, "app");

/**
 * 把 `srcDir` 整个拷成 `dest`，已有的 `dest` 在**新版完整拷好之后**才换掉（review D2b-04）。
 *
 * 旧写法是先 `rm(dest)` 再 `cp(src, dest)`：源里任何一个读不了的文件（权限 / 坏链）让 cp 中途抛错，
 * 用户原来装好的同名 skill 已经被删光、只剩半截目录。现在：
 *  1. 先拷到数据根下的临时目录（失败 → 清临时目录、`dest` 一个字节不动）；
 *  2. 旧 `dest` 改名成备份 → 临时目录改名成 `dest`；第二步失败就把备份改回去；
 *  3. 成功后删备份。
 * 临时目录放在 skills 目录的同级（同一文件系统、rename 才是原子的；也不会被 skills 扫描当成 skill）。
 */
const SKILL_IMPORT_TMP_PREFIX = ".skill-import-";
/** 导入临时目录 / 备份目录的残留保留多久（超过才清：别误删另一个正在跑的导入的临时目录） */
export const SKILL_IMPORT_LEFTOVER_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * 清掉数据根下遗留的 `.skill-import-*`（含 `.old` 备份）临时目录（Q9-03）。
 * 来源：导入过程中进程被杀 / Windows 上成功路径末尾 `rm(backup)` 被占用失败后被吞——此前没有任何清扫，永久残留。
 * 只清 mtime 超过 `maxAgeMs` 的；任何一步失败都忽略（清扫是尽力而为，不能挡住导入）。返回清掉的条目名。
 */
export const sweepStaleSkillImportLeftovers = async (
  root: string,
  now: number = Date.now(),
  maxAgeMs: number = SKILL_IMPORT_LEFTOVER_MAX_AGE_MS,
): Promise<string[]> => {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!name.startsWith(SKILL_IMPORT_TMP_PREFIX)) continue;
    const abs = path.join(root, name);
    try {
      const st = await fs.stat(abs);
      if (now - st.mtimeMs < maxAgeMs) continue;
      await fs.rm(abs, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // 尽力而为
    }
  }
  return removed;
};

/**
 * 拷一个 skill 目录的体量上限（Q13-10 的补充）。
 * `copySkillTree` 把软链解引用成真内容：互相指向的目录、层层指向同一目录的钻石结构、pnpm 式 `node_modules` 会按路径成倍展开
 * （旧行为不解引用，没有这个问题）——没有上限的话，一个来路不明的 skill 就能把大块磁盘拷进应用库、把导入卡住。
 * 超了整个 skill 导入失败（不是拷一半就算成功），同名旧版不动。
 *  - 条目 20 万：拷出去的每个条目算一条——文件、目录、解引用后的软链，另加 skill 目录自己；被跳过的断链 / 环不算；
 *  - 字节 2 GiB：只算文件内容（指向文件的软链按目标文件的大小算，目录不算）。
 * 两个都是「大于」才算超，恰好等于放行。
 * 取值依据：正常 skill 的软链个位数、文件几十到几百个、总共几 MB，上限高出三个数量级以上；7 个目录两两互指（源 57 条拷出 27399 条）仍然放行；
 * pnpm 式 `node_modules` 按展开判据数到约 20 万条时累计已超过 2 GiB（不解引用也有 40 万条）——两个上限都会被它冲破，哪个先到取决于遍历顺序，结果都是整个 skill 失败。
 * 「大而没有软链」的真目录也计入：旧行为能导入的大 skill，只要在上限以内就不受影响。详见 HANDOFF B7-3 决策依据 ⑨。
 */
export const SKILL_COPY_MAX_ENTRIES = 200_000;
export const SKILL_COPY_MAX_BYTES = 2 * 1024 ** 3;

export interface SkillCopyLimits {
  maxEntries: number;
  maxBytes: number;
}

/** 默认上限是 2 GiB，显示成 GB；测试注入的小值显示成字节 */
const formatLimitBytes = (n: number): string => (n >= 1024 ** 3 ? `${Number((n / 1024 ** 3).toFixed(1))} GB` : `${n} 字节`);

/** 超限的报错文案：带 skill 目录名、上限数值和清理建议；不带临时目录路径（调用方看不懂它） */
const tooLargeMessage = (skillName: string, limits: SkillCopyLimits): string =>
  `目录 ${skillName} 展开后超过上限（${limits.maxEntries.toLocaleString("en-US")} 个文件 / 目录，或 ${formatLimitBytes(limits.maxBytes)}）：` +
  "里面可能有 node_modules，或有互相指向的软链被逐个展开成了真内容。请清理后重试。";

/**
 * 把 skill 源目录拷成一份**自包含**的副本（Q13-10）。
 *
 * 旧写法 `fs.cp(src, tmp, { recursive: true })` 默认不解引用软链：
 *  - `~/.cursor/skills/<name>` 本身是软链（agentskills 里常见的链接装法）→ 拷出来的 `dest` 还是一条软链，等于没拷；
 *  - 目录里的软链被原样拷成软链，而且相对链会被改写成指向「源目录」的绝对路径——源一挪 / 删，导入的 skill 就坏。
 *
 * 现在：先取顶层的真目录（`realpath`）再拷，里面的软链一律解引用成真内容。两类软链**跳过、不让整个导入失败**：
 *  - 断链（目标不存在）——旧行为是原样拷成断链、导入「成功」，这里不能退化成整条失败；
 *  - 环——`fs.cp` 对解引用的软链没有环检测，会一路往里钻、直到系统的软链层数上限才停：多数形态以 ELOOP 让整个导入失败（旧行为不解引用，这类 skill 能导入）；
 *    深层的 `realpath` 抛错若被下面 `filter` 里的 `catch` 当成断链吞掉，则变成嵌套复制几十层（Node 22 / macOS 实测 32 层）。两种：
 *      ① 指向源目录自己或它的祖先——放行的话还会把兄弟 skill / 祖先里的其他文件一并拷进来；
 *      ② 指向「从顶层走到这条软链所经过的某一层目录」（含它所在的那一层）：子目录里的 `self → .`、`a/b/up → ..`、
 *         两个子目录互相指、目录外的共享目录里自带的环。判据：目标的真路径等于它各级上层目录的真路径之一。
 *         **沿路径判、不是全局去重**：同一个目录被两条软链各指一次（`p → shared`、`q → shared`）不是环，各拷一份。
 * 指向别处的软链（如 `shared/` 共享目录）照常拷内容。**不限制目标位置**：旧行为是把软链原样拷成软链、不读目标，
 * 现在目录里指向目录外的软链会把对方整份内容拷进来——来路不明的 skill 里的软链能把本机上任何可读的文件 / 目录带进应用库，导入前要自己看一眼。
 * 展开后的体量**设上限**（`SKILL_COPY_MAX_ENTRIES` / `SKILL_COPY_MAX_BYTES`）：互相指的目录、层层指向同一目录的钻石结构会按路径成倍展开
 * （实测 7 个目录两两互指：源 57 条拷出 27399 条）；超了整个 skill 导入失败、不是静默截断，见 HANDOFF B7-3 决策依据 ⑨。
 * `limits` 缺省取上面两个常量，只有测试注入小值时才传。
 */
const copySkillTree = async (
  srcDir: string,
  tmp: string,
  limits: SkillCopyLimits = { maxEntries: SKILL_COPY_MAX_ENTRIES, maxBytes: SKILL_COPY_MAX_BYTES },
): Promise<void> => {
  const realSrc = await fs.realpath(srcDir);
  // 上层目录的真路径：filter 对每个条目都会被问一遍，按目录缓存（fs.cp 对目录条目是串行处理的，Map 没有并发问题）
  const realDirCache = new Map<string, string>();
  const realDirOf = async (dir: string): Promise<string> => {
    let real = realDirCache.get(dir);
    if (real === undefined) {
      real = await fs.realpath(dir);
      realDirCache.set(dir, real);
    }
    return real;
  };
  // 软链的目标是不是「从顶层走到这条软链所经过的某一层目录」（含它所在的那一层）？是 = 环②：解引用后会一路往里钻。
  // 比的是真路径；一直比到顶层为止（再往上的祖先由环①管）。
  // 软链只有在目标的真路径不等于当前路径上任何一层时才放行，放行后它就在路径上了，所以沿一条路径被放行的目标互不相同、至多真目录总数个；
  // 两次放行之间只有真下降，深度有限；故拷贝一定会停。
  const pointsBackIntoOwnPath = async (link: string, target: string): Promise<boolean> => {
    for (let dir = path.dirname(link); ; dir = path.dirname(dir)) {
      if ((await realDirOf(dir)) === target) return true;
      if (dir === realSrc || path.dirname(dir) === dir) return false;
    }
  };
  // 这个条目拷不拷：不拷 → null；拷 → 它要拷多少字节（文件按大小，指向文件的软链按目标文件的大小，目录 0）。
  // 判定过程中的任何报错（断链、读不了、拷贝中途被删）都当成「跳过这一条」。
  const bytesToCopy = async (src: string): Promise<number | null> => {
    try {
      const lst = await fs.lstat(src);
      if (!lst.isSymbolicLink()) return lst.isFile() ? lst.size : 0;
      const target = await fs.realpath(src); // 断链会抛 → 落到 catch 跳过
      // 环①：从目标走到源目录，不用爬出去（不是 ".." / "../x"，也不是跨盘的绝对路径）= 源目录就在目标里面
      // （空串 = 就是它自己）= 指向它自己 / 祖先。".." 本身是「目标在源目录里面」（指向自己的子目录），不是环。
      const rel = path.relative(target, realSrc);
      const srcInsideTarget = rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
      if (srcInsideTarget) return null;
      // 环②：目标是路径上的某一层目录（子目录里指向自己 / 更高一层、互指、目录外的共享目录自带的环）
      if (await pointsBackIntoOwnPath(src, target)) return null;
      const st = await fs.stat(target);
      return st.isFile() ? st.size : 0;
    } catch {
      return null;
    }
  };
  // 计数和超限检查放在 bytesToCopy 的 try / catch 之外：超限的报错若落进 catch，会被当成「断链」吞掉——
  // fs.cp 照常返回、导入「成功」但缺文件（静默截断，比失败更糟）。
  let entries = 0;
  let bytes = 0;
  await fs.cp(realSrc, tmp, {
    recursive: true,
    dereference: true,
    filter: async (src) => {
      const size = await bytesToCopy(src);
      if (size === null) return false;
      entries += 1;
      bytes += size;
      if (entries > limits.maxEntries || bytes > limits.maxBytes) {
        throw new Error(tooLargeMessage(path.basename(srcDir), limits));
      }
      return true;
    },
  });
};

const replaceDirWithCopy = async (srcDir: string, dest: string, limits?: SkillCopyLimits): Promise<void> => {
  const parent = path.dirname(dest);
  const stamp = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(path.dirname(parent), `${SKILL_IMPORT_TMP_PREFIX}${stamp}`);
  const backup = `${tmp}.old`;
  let backedUp = false;
  // 下次导入时顺手清上次崩溃 / 占用遗留的临时目录（Q9-03）
  await sweepStaleSkillImportLeftovers(path.dirname(parent));
  try {
    await fs.mkdir(parent, { recursive: true });
    try {
      await copySkillTree(srcDir, tmp, limits);
    } catch (err) {
      // 报错里带的是临时目录路径，用户看不懂：换回目标 skill 路径（Q9-03e）
      if (err instanceof Error && err.message.includes(tmp)) {
        err.message = err.message.split(tmp).join(dest);
      }
      throw err;
    }
    try {
      await fs.rename(dest, backup);
      backedUp = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // 本来就没有旧版
    }
    try {
      await fs.rename(tmp, dest);
    } catch (err) {
      if (backedUp) {
        await fs.rename(backup, dest).catch(() => {});
        backedUp = false;
      }
      throw err;
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (backedUp) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * 从全局 `~/.cursor/skills/` 导入（整目录拷贝、含 scripts 等附属文件——
 * SKILL.md 常引用同目录脚本、只拷 md 会导入残废 skill）。
 * @param names 要导入的 skill 目录名列表
 * @param options.limits 单个 skill 展开后的体量上限，缺省取 `SKILL_COPY_MAX_ENTRIES` / `SKILL_COPY_MAX_BYTES`。**仅测试注入小值用**：API 路由不传、也不得把请求体里的任何值传进来——上限不能由 HTTP 调用方指定，否则保护就交给了调用者
 * @returns 实际导入成功的名字；展开后超限的 skill 整个失败、进 failed
 */
export const importSkillsFromCursor = async (
  names: string[],
  options: { limits?: Partial<SkillCopyLimits> } = {},
): Promise<{ imported: string[]; failed: Array<{ name: string; error: string }> }> => {
  const imported: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  const limits: SkillCopyLimits = {
    maxEntries: options.limits?.maxEntries ?? SKILL_COPY_MAX_ENTRIES,
    maxBytes: options.limits?.maxBytes ?? SKILL_COPY_MAX_BYTES,
  };

  // 找每个名字在哪个全局目录下（多候选目录取第一个命中的）
  const candidates = getGlobalCursorDirs().map((d) => path.join(d, "skills"));
  for (const rawName of names) {
    const name = rawName.trim();
    if (!isSafeSkillName(name)) {
      failed.push({ name, error: "名字含非法字符" });
      continue;
    }
    let srcDir: string | null = null;
    for (const parent of candidates) {
      const p = path.join(parent, name);
      try {
        const stat = await fs.stat(p);
        if (stat.isDirectory()) {
          srcDir = p;
          break;
        }
      } catch {
        // 试下一个候选
      }
    }
    if (!srcDir) {
      failed.push({ name, error: "在 ~/.cursor/skills 下没找到" });
      continue;
    }
    try {
      await replaceDirWithCopy(srcDir, path.join(getAppSkillsDir(), name), limits);
      imported.push(name);
    } catch (err) {
      failed.push({
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { imported, failed };
};

/** 列全局 ~/.cursor/skills 里可导入的 skill（导入 dialog 数据源、带目录名） */
export const listCursorGlobalSkills = async (): Promise<
  Array<{ dirName: string; name: string; description: string }>
> => {
  const out: Array<{ dirName: string; name: string; description: string }> = [];
  const seen = new Set<string>();
  for (const dir of getGlobalCursorDirs()) {
    const entries = await scanSkillsDir(path.join(dir, "skills"));
    for (const e of entries) {
      // 导入按「skill 目录名」操作（SKILL.md 的父目录）、跟 frontmatter name 可能不同
      const dirName = path.basename(path.dirname(e.absPath));
      if (seen.has(dirName)) continue;
      seen.add(dirName);
      out.push({ dirName, name: e.name, description: e.description });
    }
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName));
};

/** 展示用：把 absPath 里的 home 前缀替换成 ~（设置页列表更短更可读） */
export const shortenHomePath = (p: string): string => {
  const home = os.homedir();
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};
