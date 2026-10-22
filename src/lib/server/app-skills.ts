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
    // 先写临时文件再 rename 覆盖：写到一半失败（磁盘满 / 被打断）时旧 SKILL.md 不会被截成半截
    await fs.writeFile(tmp, content, "utf-8");
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

const replaceDirWithCopy = async (srcDir: string, dest: string): Promise<void> => {
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
      await fs.cp(srcDir, tmp, { recursive: true });
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
 * @returns 实际导入成功的名字
 */
export const importSkillsFromCursor = async (
  names: string[],
): Promise<{ imported: string[]; failed: Array<{ name: string; error: string }> }> => {
  const imported: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

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
      await replaceDirWithCopy(srcDir, path.join(getAppSkillsDir(), name));
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
