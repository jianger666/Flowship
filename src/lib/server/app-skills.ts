/**
 * app 自管 Skill 管理（V0.13-P1 独立化、设置页 Skills 卡的 server 侧）
 *
 * 目录布局：`<dataRoot>/skills/<skill 名>/SKILL.md`（+ 可能的附属文件、导入时整目录拷）。
 * 只有这个目录下的 skill 可增删改；平台内置 / 全局 ~/.cursor/skills / 飞书 CLI 官方只读展示。
 *
 * 安全约束：skill 名做目录名白名单校验（字母数字 - _ .、拒绝路径穿越）、
 * 所有写操作都锚定在 getAppSkillsDir() 之下。
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

/** skill 来源（设置页标签 + 是否可编辑的判定） */
export type SkillSource = "builtin" | "app" | "cursor" | "feishu-cli";

export interface SkillWithSource extends SkillEntry {
  source: SkillSource;
  /** 只有 app 自管的可编辑 / 删除 */
  editable: boolean;
}

// skill 名 = 目录名：只允许安全字符、防路径穿越（`../` / 绝对路径 / 分隔符全拒）
const isSafeSkillName = (name: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name);

/** 按来源列全部 skill（不去重——同名多来源都展示、用户能看清覆盖关系） */
export const listSkillsWithSource = async (): Promise<SkillWithSource[]> => {
  const out: SkillWithSource[] = [];
  const push = (entries: SkillEntry[], source: SkillSource) => {
    for (const e of entries) {
      out.push({ ...e, source, editable: source === "app" });
    }
  };
  push(await scanSkillsDir(path.join(process.cwd(), "skills")), "builtin");
  push(await scanSkillsDir(getAppSkillsDir()), "app");
  for (const dir of getGlobalCursorDirs()) {
    push(await scanSkillsDir(path.join(dir, "skills")), "cursor");
  }
  push(await scanSkillsDir(getToolsSkillsDir()), "feishu-cli");
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

/** 读某个 app 自管 skill 的 SKILL.md 全文（不存在返 null） */
export const readAppSkillContent = async (
  name: string,
): Promise<string | null> => {
  if (!isSafeSkillName(name)) return null;
  try {
    return await fs.readFile(
      path.join(getAppSkillsDir(), name, "SKILL.md"),
      "utf-8",
    );
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
    return "skill 名只能用字母 / 数字 / - _ .（将作为目录名）";
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
