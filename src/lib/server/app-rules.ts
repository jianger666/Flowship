/**
 * app 自管 Rules 管理（v1.1.x Rules 独立化、能力页 Rules tab 的 server 侧）
 *
 * 文件布局：`<dataRoot>/rules/<name>.mdc`（gray-matter frontmatter：
 * description / alwaysApply、正文 = 规则内容——跟 Cursor rules 同规范）。
 * 注入走 cursor-config.readGlobalCursorRulesForPrompt（全局 Cursor rules + 这里的
 * 自管 rules 合并、disabledRules 名单过滤）。
 *
 * 分层约定（用户拍板）：Cursor 全局 rules = 个人偏好（只读展示、要改去 Cursor）；
 * app 自管 rules = 团队 / 项目级（可建可关可导入）。
 *
 * 安全约束：rule 名做文件名白名单校验（字母数字 - _ .、拒绝路径穿越）、
 * 所有写操作锚定在 getAppRulesDir() 之下。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import { getAppRulesDir, getGlobalCursorDirs } from "./cursor-config";

export interface AppRuleEntry {
  /** 文件名（不含 .mdc）、开关 / 增删按它记 */
  name: string;
  description: string;
  alwaysApply: boolean;
  absPath: string;
  /** 正文第一行非空行——列表主文字用（一句话规则直接看到内容） */
  bodyPreview: string;
}

// rule 名 = 文件名：只允许安全字符、防路径穿越
const isSafeRuleName = (name: string): boolean =>
  /^[a-zA-Z0-9\u4e00-\u9fa5][a-zA-Z0-9\u4e00-\u9fa5._-]{0,63}$/.test(name);

/** 取正文第一行非空行（列表预览；空正文返空串） */
const firstBodyLine = (body: string): string => {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
};

// 扫一个目录下的 *.mdc → 条目列表（解析失败的 silent skip）
const scanRulesDir = async (dir: string): Promise<AppRuleEntry[]> => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: AppRuleEntry[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith(".mdc")) continue;
    const abs = path.join(dir, ent.name);
    try {
      const parsed = matter(await fs.readFile(abs, "utf-8"));
      const data = parsed.data as Record<string, unknown>;
      out.push({
        name: path.basename(ent.name, path.extname(ent.name)),
        description:
          typeof data.description === "string" ? data.description.trim() : "",
        alwaysApply: data.alwaysApply === true,
        absPath: abs,
        bodyPreview: firstBodyLine(parsed.content),
      });
    } catch {
      // 单文件坏了跳过
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

/** 列 app 自管 rules */
export const listAppRules = async (): Promise<AppRuleEntry[]> =>
  scanRulesDir(getAppRulesDir());

/** 列全局 ~/.cursor/rules 里可导入的 rule（导入 dialog 数据源） */
export const listCursorGlobalRules = async (): Promise<AppRuleEntry[]> => {
  for (const dir of getGlobalCursorDirs()) {
    const got = await scanRulesDir(path.join(dir, "rules"));
    if (got.length > 0) return got;
  }
  return [];
};

/** 读某个自管 rule 的 .mdc 全文（不存在返 null） */
export const readAppRuleContent = async (
  name: string,
): Promise<string | null> => {
  if (!isSafeRuleName(name)) return null;
  try {
    return await fs.readFile(
      path.join(getAppRulesDir(), `${name}.mdc`),
      "utf-8",
    );
  } catch {
    return null;
  }
};

/**
 * 新增 / 覆盖自管 rule
 * @returns null = 成功；string = 用户可读的失败原因
 */
export const writeAppRule = async (
  name: string,
  content: string,
): Promise<string | null> => {
  if (!isSafeRuleName(name)) {
    return "rule 名只能用字母 / 数字 / 中文 / - _ .（将作为文件名）";
  }
  if (!content.trim()) return "规则内容不能为空";
  try {
    await fs.mkdir(getAppRulesDir(), { recursive: true });
    await fs.writeFile(
      path.join(getAppRulesDir(), `${name}.mdc`),
      content,
      "utf-8",
    );
    return null;
  } catch (err) {
    return `写入失败：${err instanceof Error ? err.message : String(err)}`;
  }
};

/** 删自管 rule（不存在也当成功、幂等） */
export const deleteAppRule = async (name: string): Promise<string | null> => {
  if (!isSafeRuleName(name)) return "rule 名非法";
  try {
    await fs.rm(path.join(getAppRulesDir(), `${name}.mdc`), { force: true });
    return null;
  } catch (err) {
    return `删除失败：${err instanceof Error ? err.message : String(err)}`;
  }
};

/** 从全局 ~/.cursor/rules 导入（按名字拷文件、同名覆盖） */
export const importRulesFromCursor = async (
  names: string[],
): Promise<{ imported: string[]; failed: Array<{ name: string; error: string }> }> => {
  const imported: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  const candidates = getGlobalCursorDirs().map((d) => path.join(d, "rules"));
  for (const rawName of names) {
    const name = rawName.trim();
    if (!isSafeRuleName(name)) {
      failed.push({ name, error: "名字含非法字符" });
      continue;
    }
    let src: string | null = null;
    for (const parent of candidates) {
      const p = path.join(parent, `${name}.mdc`);
      try {
        const stat = await fs.stat(p);
        if (stat.isFile()) {
          src = p;
          break;
        }
      } catch {
        // 试下一个候选
      }
    }
    if (!src) {
      failed.push({ name, error: "在 ~/.cursor/rules 下没找到" });
      continue;
    }
    try {
      await fs.mkdir(getAppRulesDir(), { recursive: true });
      await fs.copyFile(src, path.join(getAppRulesDir(), `${name}.mdc`));
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
