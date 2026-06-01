/**
 * fe-ai-flow Skills Loader
 *
 * 加载 SKILL.md 风格的能力扩展（Anthropic Agent Skills 标准）。
 *
 * 设计要点（用户已拍板、2026-05-29 起单一来源、配合 settingSources 双向绑定）：
 *   - **只加载 fe-ai-flow 平台自带** `<fe-ai-flow>/skills/`（跟 git 仓库一起发布、所有用户共享）
 *   - **repo + 全局 skills 不在这里读**：task-runner / chat-runner 的 Agent.create 开了
 *     `settingSources: ["project"]`、Cursor SDK 会按 Cursor 标准自动加载目标仓库 `.cursor/skills/`
 *     + 全局 `~/.cursor/skills/`（跟 Cursor IDE 行为一致）。fe 这里再读一遍 = 同一份 SKILL.md
 *     进 prompt 两次、故只管「SDK 盖不到的平台自带」——settingSources 的 cwd=目标仓库、
 *     够不着 fe-ai-flow 自己的 `skills/`、那一份必须靠本 loader 注入。
 *   - **progressive loading**：启动 agent 时只把每个 skill 的 name + description + absPath 拼进 prompt、
 *     agent 看到场景匹配时**主动用 `read` 工具读** 完整 SKILL.md 拿到详情。
 *     节省 prompt token、跟 Cursor IDE 加载行为一致。
 *
 * 不做的事（V1）：
 *   - 读 `<repo>/.cursor/rules/` 注入 prompt（rules 由 settingSources 交给 SDK 加载）
 *   - `paths` 字段的 file-scope 过滤（V2 再做、需要知道当前 agent 在动哪些文件）
 *   - `disable-model-invocation`（slash-command 触发、SDK chat 模式用不上）
 *   - 远程 skill 拉取（飞书 / GitHub link、V2 再加）
 *
 * 错误语义：单个 SKILL.md 解析失败 → warn + skip、不让整个 loader 炸
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

// fe-ai-flow 平台自身 skills 目录的相对路径
// V0.3 起：从 `.fe-ai-flow/skills/` 挪到顶级 `skills/`、跟 `prompts/` 平级、
// 命名直白、避免「fe-ai-flow inside fe-ai-flow」的冗余目录层
const FE_AI_FLOW_OWN_SKILLS_DIR = "skills";

// 递归深度上限：防止 skills 嵌套过深、扫描爆栈 / 卡 IO
// 实际 SKILL.md 一般 2~3 层（category/skill-name/SKILL.md）、5 层够用
const MAX_SCAN_DEPTH = 5;

export interface SkillEntry {
  // skill 唯一名字（取 frontmatter.name、不存在则用 SKILL.md 父目录名）
  name: string;
  // skill 简介、agent 看 description 决定要不要 read 完整内容
  description: string;
  // 可选：限定该 skill 对哪些 paths 生效（V1 列出但不强制过滤、给 LLM 做参考）
  paths?: string[];
  // SKILL.md 绝对路径、agent 用这个调 `read` 工具读
  absPath: string;
}

/**
 * 递归扫描某个目录下所有 SKILL.md
 *
 * @param rootDir   要扫的根目录绝对路径
 * @returns         所有解析出的 SkillEntry（解析失败的 silent skip）
 */
const scanSkillsDir = async (rootDir: string): Promise<SkillEntry[]> => {
  // 目录不存在 / 不可读、直接当作 0 个 skill、不抛错
  // skill 是「可选能力」、没装就是没装、不该让 chat 启动失败
  try {
    const stat = await fs.stat(rootDir);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  const found: SkillEntry[] = [];

  // 递归 walk、深度限制 + 跳过隐藏目录（.git 之类）
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      // 跳过 . 开头隐藏文件 / 目录（.git / .DS_Store 等）；
      // depth=0 的 root 本身已经在外面 stat 过、这里只过滤子项
      if (ent.name.startsWith(".") && depth > 0) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs, depth + 1);
        continue;
      }
      // 只要文件名是 SKILL.md（大小写不敏感、避免 macOS HFS+ 大小写差异）
      if (ent.name.toUpperCase() !== "SKILL.MD") continue;
      try {
        const parsed = await parseSkillFile(abs);
        if (parsed) found.push(parsed);
      } catch (err) {
        console.warn(
          `[skills-loader] 解析 SKILL.md 失败、跳过：${abs}`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  };
  await walk(rootDir, 0);
  return found;
};

/**
 * 解析单个 SKILL.md 文件
 *
 * frontmatter 字段（按 Anthropic Agent Skills 标准）：
 *   - name (required): 跟父目录名一致、用于 LLM 引用
 *   - description (required): agent 看这个判断是否加载
 *   - paths (optional): glob list、限定文件范围
 *
 * 缺失 name / description 视为非法 skill、return null
 */
const parseSkillFile = async (absPath: string): Promise<SkillEntry | null> => {
  const raw = await fs.readFile(absPath, "utf-8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;

  // name 必填、缺省用 SKILL.md 父目录名作为兜底
  let name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name) {
    name = path.basename(path.dirname(absPath));
  }

  const description =
    typeof data.description === "string" ? data.description.trim() : "";
  if (!description) {
    console.warn(
      `[skills-loader] ${absPath} 缺 description、skip。skill 必须有 description 才能被 agent 看到。`,
    );
    return null;
  }

  let paths: string[] | undefined;
  if (Array.isArray(data.paths)) {
    paths = data.paths.filter((s) => typeof s === "string").map(String);
  } else if (typeof data.paths === "string") {
    // 标准允许逗号分隔字符串、按 spec 拆开
    paths = data.paths
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    name,
    description,
    paths,
    absPath,
  };
};

/**
 * 加载本次 agent 可用的「平台自带」skills（只此一类）
 *
 * 只扫 fe-ai-flow 平台自身 `process.cwd()/skills/`。
 * repo `.cursor/skills/` + 全局 `~/.cursor/skills/` 由 Agent.create 的
 * `settingSources: ["project"]` 交给 Cursor SDK 加载（跟 Cursor IDE 一致）、这里不重复读、
 * 否则同一份 SKILL.md 会进 prompt 两次。
 */
export const loadSkills = async (): Promise<SkillEntry[]> => {
  const feAiFlowOwnRoot = path.join(process.cwd(), FE_AI_FLOW_OWN_SKILLS_DIR);
  const ownSkills = await scanSkillsDir(feAiFlowOwnRoot);

  // 按 name 字母序、稳定输出顺序、方便 prompt 复用 / 调试 diff
  return ownSkills.sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * 把 skills 渲染成 prompt 末尾的 [AVAILABLE_SKILLS] 段
 *
 * 每个 skill 占 3 行：
 *   - skill_name
 *   - desc: 单行简介
 *   - path: 绝对路径（agent 调 `read` 工具用）
 *
 * 整段总 token 量预估：N × 80~120 token；N=10 时 ~1k token、可接受
 */
export const renderSkillsForPrompt = (skills: SkillEntry[]): string => {
  if (skills.length === 0) {
    return "（当前没有平台自带 skill。平台 skill 放在 fe-ai-flow `skills/<name>/SKILL.md`；仓库 / 全局 skill 走 Cursor `.cursor/skills/`、已由 settingSources 自动加载、不在此列。）";
  }
  const lines: string[] = [];
  for (const s of skills) {
    lines.push(`- **${s.name}**`);
    lines.push(`  desc: ${s.description.replace(/\n/g, " ")}`);
    lines.push(`  path: ${s.absPath}`);
    if (s.paths && s.paths.length > 0) {
      lines.push(`  paths: ${s.paths.join(", ")}`);
    }
  }
  return lines.join("\n");
};
