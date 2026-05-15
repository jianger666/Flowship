/**
 * fe-ai-flow Skills Loader
 *
 * 加载 SKILL.md 风格的能力扩展（Anthropic Agent Skills 标准）。
 *
 * 设计要点（用户已拍板）：
 *   - **两类来源**：
 *     1. `<fe-ai-flow>/skills/`：fe-ai-flow 平台自带（跟 git 仓库一起发布、所有用户共享）
 *     2. `<repo>/.cursor/skills/`：工作仓库自己的（直接复用 Cursor 标准约定、跟 rules 共用 .cursor/ 根）
 *        → 用户的项目仓库本来就有 `.cursor/` 目录（rules / 配置）、skills 跟着进 .cursor/skills/ 即可
 *        → 同一份 SKILL.md 既能给 fe-ai-flow chat 用、又能直接给 Cursor IDE 加载
 *   - **progressive loading**：启动 agent 时只把每个 skill 的 name + description + absPath 拼进 prompt、
 *     agent 看到场景匹配时**主动 read_file** 完整 SKILL.md 拿到详情。
 *     节省 prompt token、跟 Cursor IDE 加载行为一致。
 *
 * 不做的事（V1）：
 *   - 读 `<repo>/.cursor/rules/` 注入 prompt（rules 是另一层机制、下一轮再讨论）
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

// 工作仓库的 skills 目录：直接复用 Cursor IDE 约定的 .cursor/skills/
// 用户的项目仓库已经有 .cursor/（rules + 配置）、skills 跟进同目录、双向共用
const REPO_SKILLS_DIR = ".cursor/skills";

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
  // SKILL.md 绝对路径、agent 用这个去 read_file
  absPath: string;
  // 来源：fe-ai-flow 自带 / 工作仓库专属
  // UI 可能展示标签、prompt 里 agent 也能区分「项目通用」vs「这个仓库特化」
  source: "fe-ai-flow" | "repo";
}

/**
 * 递归扫描某个目录下所有 SKILL.md
 *
 * @param rootDir   要扫的根目录绝对路径
 * @param source    来源标签
 * @returns         所有解析出的 SkillEntry（解析失败的 silent skip）
 */
const scanSkillsDir = async (
  rootDir: string,
  source: "fe-ai-flow" | "repo",
): Promise<SkillEntry[]> => {
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
        const parsed = await parseSkillFile(abs, source);
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
const parseSkillFile = async (
  absPath: string,
  source: "fe-ai-flow" | "repo",
): Promise<SkillEntry | null> => {
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
    source,
  };
};

/**
 * 加载本次 agent 可用的所有 skills
 *
 * @param repoPath 当前任务工作仓库的绝对路径（agent cwd）；可为空（设置页未配仓库时）
 *
 * 加载顺序：
 *   1. fe-ai-flow 平台自身（process.cwd()/skills/）
 *   2. 工作仓库（repoPath/.cursor/skills/、repoPath 非空时）— 跟 Cursor IDE 共用同一份 SKILL.md
 *
 * 同名 skill 的处理：**仓库自带覆盖 fe-ai-flow 平台自带**（按 skill name 去重、后写胜出）
 *   - 用户希望某个仓库定制某个 skill 时、直接在仓库 .cursor/skills/ 加同名 skill 即可
 *   - 同一份 SKILL.md 在 Cursor IDE 和 fe-ai-flow chat 里都生效
 */
export const loadSkills = async (
  repoPath?: string,
): Promise<SkillEntry[]> => {
  const feAiFlowOwnRoot = path.join(process.cwd(), FE_AI_FLOW_OWN_SKILLS_DIR);
  const repoRoot =
    repoPath && repoPath.trim()
      ? path.join(repoPath.trim(), REPO_SKILLS_DIR)
      : null;

  // 并行扫两处、节省 IO 等待
  const [ownSkills, repoSkills] = await Promise.all([
    scanSkillsDir(feAiFlowOwnRoot, "fe-ai-flow"),
    repoRoot ? scanSkillsDir(repoRoot, "repo") : Promise.resolve([]),
  ]);

  // 合并：repo 优先级高、同名覆盖 fe-ai-flow 自带
  const byName = new Map<string, SkillEntry>();
  for (const s of ownSkills) byName.set(s.name, s);
  for (const s of repoSkills) byName.set(s.name, s);

  // 按 name 字母序、稳定输出顺序、方便 prompt 复用 / 调试 diff
  return Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
};

/**
 * 把 skills 渲染成 prompt 末尾的 [AVAILABLE_SKILLS] 段
 *
 * 每个 skill 占 3 行：
 *   - skill_name (source)
 *   - desc: 单行简介
 *   - path: 绝对路径（agent read_file 用）
 *
 * 整段总 token 量预估：N × 80~120 token；N=10 时 ~1k token、可接受
 */
export const renderSkillsForPrompt = (skills: SkillEntry[]): string => {
  if (skills.length === 0) {
    return "（当前没有可用 skill。skill 放在 fe-ai-flow 平台 `skills/<name>/SKILL.md`、或工作仓库 `.cursor/skills/<name>/SKILL.md`。）";
  }
  const lines: string[] = [];
  for (const s of skills) {
    lines.push(`- **${s.name}** (${s.source})`);
    lines.push(`  desc: ${s.description.replace(/\n/g, " ")}`);
    lines.push(`  path: ${s.absPath}`);
    if (s.paths && s.paths.length > 0) {
      lines.push(`  paths: ${s.paths.join(", ")}`);
    }
  }
  return lines.join("\n");
};
