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
  scanSkillsDir,
  type SkillEntry,
} from "./skills-loader";
import {
  getTeamLibraryKnowledgeRoot,
  getTeamLibraryKnowledgeSkillsDir,
  getTeamLibrarySkillsDir,
  teamLibraryRepoDir,
} from "./team-library";
import { getTeamSkillAuthors } from "./team-skill-authors";

/** skill 来源（设置页标签 + 是否可编辑的判定；不含 Cursor 全局——那只作导入源） */
export type SkillSource = "builtin" | "app" | "feishu-cli" | "team";

export interface SkillWithSource extends SkillEntry {
  source: SkillSource;
  /** 只有 app 自管的可编辑 / 删除 */
  editable: boolean;
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
export const listSkillsWithSource = async (): Promise<SkillWithSource[]> => {
  const out: SkillWithSource[] = [];
  const push = (
    entries: SkillEntry[],
    source: SkillSource,
    teamCategory?: string,
  ) => {
    for (const e of entries) {
      out.push({
        ...e,
        source,
        editable: source === "app",
        ...(teamCategory !== undefined ? { teamCategory } : {}),
      });
    }
  };
  push(await scanSkillsDir(path.join(process.cwd(), "skills")), "builtin");
  push(await scanSkillsDir(getAppSkillsDir()), "app");
  push(await scanSkillsDir(getToolsSkillsDir()), "feishu-cli");
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

/**
 * 按名读任意已知来源 skill 的 SKILL.md 全文（只读详情 / 编辑共用）。
 * 可选 source 消歧同名；未指定时按列表顺序取首个命中。
 * 名字必须落在 listSkillsWithSource 结果内——防任意路径读。
 */
export const readSkillContentByName = async (
  name: string,
  source?: SkillSource,
): Promise<string | null> => {
  if (!isSafeSkillName(name)) return null;
  const all = await listSkillsWithSource();
  const hit = source
    ? all.find((s) => s.name === name && s.source === source)
    : all.find((s) => s.name === name);
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
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), content, "utf-8");
    return null;
  } catch (err) {
    return `写入失败：${err instanceof Error ? err.message : String(err)}`;
  }
};

/** 删除 app 自管 skill（整目录删、含附属文件）；不存在也当成功（幂等） */
export const deleteAppSkill = async (name: string): Promise<string | null> => {
  if (!isSafeSkillName(name)) return "skill 名非法";
  try {
    await fs.rm(path.join(getAppSkillsDir(), name), {
      recursive: true,
      force: true,
    });
    return null;
  } catch (err) {
    return `删除失败：${err instanceof Error ? err.message : String(err)}`;
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
      const dest = path.join(getAppSkillsDir(), name);
      await fs.rm(dest, { recursive: true, force: true });
      await fs.cp(srcDir, dest, { recursive: true });
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
