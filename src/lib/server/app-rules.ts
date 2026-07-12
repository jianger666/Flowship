/**
 * app 自管 Rules 管理（v1.1.x Rules 独立化、能力页 Rules tab 的 server 侧）
 *
 * 文件布局：`<dataRoot>/rules/<name>.mdc`
 * - 纯文本一句话（无 frontmatter）= 常驻注入
 * - 带 frontmatter 的跟 Cursor rules 同规范（description / alwaysApply）
 * 注入走 cursor-config.readGlobalCursorRulesForPrompt（全局 Cursor rules + 这里的
 * 自管 rules 合并、disabledRules 名单过滤）。
 *
 * 分层约定（用户拍板）：Cursor 全局 rules = 个人偏好（运行时照常注入、不提供 UI 导入）；
 * app 自管 rules = 团队 / 项目级（可建可关可删；主路径一句话、编辑可改 frontmatter）。
 *
 * 安全约束：rule 名做文件名白名单校验（字母数字 - _ .、拒绝路径穿越）、
 * 所有写操作锚定在 getAppRulesDir() 之下。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import { getAppRulesDir, isAlwaysApplyRule } from "./cursor-config";

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
        // 跟注入分流一致：无 frontmatter = 常驻
        alwaysApply: isAlwaysApplyRule(data),
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
