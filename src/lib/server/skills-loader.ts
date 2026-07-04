/**
 * ai-flow Skills Loader
 *
 * 加载 SKILL.md 风格的能力扩展（Anthropic Agent Skills 标准）。
 *
 * 设计要点（2026-06「跟 Cursor 共用工具」定案、详见 ROADMAP）：
 *   - **平台自带 + 全局两类都读**：`<ai-flow>/skills/`（git 发布、所有用户共享）
 *     + 全局 `~/.cursor/skills/`（user 层、跟 Cursor IDE 共用）。
 *   - **repo `.cursor/skills/` 不在这里读**：project 层、由 Agent.create 的
 *     `settingSources:["project"]` 交给 SDK 加载、fe 再读 = 同一份 SKILL.md 进 prompt 两次。
 *     （为什么全局要 fe 读、repo 不用：`["project"]` 只读 project 层、够不着 user 层的全局 skills。）
 *   - **progressive loading**：启动 agent 时只把每个 skill 的 name + description + absPath 拼进 prompt、
 *     agent 看到场景匹配时**主动用 `read` 工具读** 完整 SKILL.md 拿到详情。
 *     节省 prompt token、跟 Cursor IDE 加载行为一致。
 *
 * 不做的事（V1）：
 *   - 读 `<repo>/.cursor/rules/` 注入（repo rules 由 settingSources 加载；全局 rules 在 cursor-config 读）
 *   - `paths` 字段的 file-scope 过滤（V2 再做、需要知道当前 agent 在动哪些文件）
 *   - `disable-model-invocation`（slash-command 触发、SDK chat 模式用不上）
 *   - 远程 skill 拉取（飞书 / GitHub link、V2 再加）
 *
 * 错误语义：单个 SKILL.md 解析失败 → warn + skip、不让整个 loader 炸
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import { getGlobalCursorDirs } from "./cursor-config";

// ai-flow 平台自身 skills 目录的相对路径
// V0.3 起：从 `.ai-flow/skills/` 挪到顶级 `skills/`、跟 `prompts/` 平级、
// 命名直白、避免「ai-flow inside ai-flow」的冗余目录层
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
 * 加载本次 agent 可用的 skills：平台自带 + 全局 `~/.cursor/skills/`
 *
 * 两类来源（都由 fe 注入 prompt、不靠 settingSources）：
 *   1. **平台自带** `<ai-flow>/skills/`（跟 git 仓库发布、所有用户共享）
 *   2. **全局** `~/.cursor/skills/`（user 层、跟 Cursor IDE 共用）——
 *      `settingSources:["project"]` 只读 project 层、够不着 user 层、必须 fe 自己读
 *
 * 不读 repo `.cursor/skills/`（project 层、由 `settingSources:["project"]` 交给 SDK 加载、
 * 避免同一份 SKILL.md 进 prompt 两次）。
 *
 * 同名去重：平台自带优先（own 覆盖 global、平台 skill 是 fe 特定行为、不该被全局同名顶掉）。
 */
export const loadSkills = async (): Promise<SkillEntry[]> => {
  const own = await scanSkillsDir(
    path.join(process.cwd(), FE_AI_FLOW_OWN_SKILLS_DIR),
  );
  // 全局 ~/.cursor/skills/（user 层、settingSources["project"] 够不着、fe 自己读）
  const global: SkillEntry[] = [];
  for (const dir of getGlobalCursorDirs()) {
    global.push(...(await scanSkillsDir(path.join(dir, "skills"))));
  }
  // 合并去重（同名平台自带优先：先放 global、再放 own 覆盖同名）
  const byName = new Map<string, SkillEntry>();
  for (const s of global) byName.set(s.name, s);
  for (const s of own) byName.set(s.name, s);
  // 按 name 字母序、稳定输出顺序、方便 prompt 复用 / 调试 diff
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * 本机「可用 skill 名字」全集：loadSkills（平台 + 全局）∪ 各绑定仓的 `.cursor/skills/`。
 *
 * 给自定义 action 的 skills 点名做存在性判定（v0.9.14 skill 缺失兜底）：
 * 定义文件可能是别人导出的、引用了对方个人 skill——渲染 playbook 前按这个集合
 * 静默过滤、agent 不会拿到「点了名却查无此人」的引用去瞎找。
 * repo 层也要算进来：SDK settingSources 会加载它们、agent 实际用得上、不能误杀。
 */
export const listAvailableSkillNames = async (
  repoPaths: string[],
): Promise<Set<string>> => {
  const names = new Set<string>();
  for (const s of await loadSkills()) names.add(s.name);
  for (const repo of repoPaths) {
    const entries = await scanSkillsDir(path.join(repo, ".cursor", "skills"));
    for (const s of entries) names.add(s.name);
  }
  return names;
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
    return "（当前没有可用 skill。平台 skill 放在 ai-flow `skills/<name>/SKILL.md`、全局 skill 走 `~/.cursor/skills/`；仓库级 skill 由 settingSources 自动加载、不在此列。）";
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
