/**
 * ai-flow Skills Loader
 *
 * 加载 SKILL.md 风格的能力扩展（Anthropic Agent Skills 标准）。
 *
 * 设计要点（settingSources:[] 后全部 fe 自管注入 prompt）：
 *   - **平台自带 + app 自管 + 全局三类都读**：`<ai-flow>/skills/`（git 发布）
 *     + `<dataRoot>/skills/`（设置页管理）+ 全局 `~/.cursor/skills/`（可导入源 / 兼容存量）。
 *   - **不读 repo `.cursor/skills/`**：SDK 已不再加载 project 层；仓库级 skill 若要用、
 *     请导入到 app 自管 skills（能力页）。
 *   - **progressive loading**：启动 agent 时只把每个 skill 的 name + description + absPath 拼进 prompt、
 *     agent 看到场景匹配时**主动用 `read` 工具读** 完整 SKILL.md 拿到详情。
 *     节省 prompt token、跟 Cursor IDE 加载行为一致。
 *
 * 不做的事（V1）：
 *   - 读 `<repo>/.cursor/rules/` 注入（repo rules 不进；app 自管 rules 在 cursor-config 读）
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
import { dataRoot } from "./data-root";
import { getToolsSkillsDir } from "./feishu-cli";
import { readSettingsFile } from "./settings-fs";

/** app 自管 skills 目录（V0.13 独立化、设置页可视化管理、随 data 目录走） */
export const getAppSkillsDir = (): string => path.join(dataRoot(), "skills");

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
 * export：app-skills.ts（设置页 Skill 管理）复用
 */
export const scanSkillsDir = async (rootDir: string): Promise<SkillEntry[]> => {
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
 * 加载本次 agent 可用的 skills：平台自带 + app 自管 + 全局 `~/.cursor/skills/` + 飞书 CLI
 *
 * 来源（都由 fe 注入 prompt、`settingSources:[]` 不靠 SDK 加载 .cursor）：
 *   1. **平台自带** `<ai-flow>/skills/`（跟 git 仓库发布、所有用户共享）
 *   2. **app 自管** `<dataRoot>/skills/`（V0.13 独立化：设置页可视化增删改、见 app-skills.ts）
 *   3. **全局** `~/.cursor/skills/`（兼容存量 / 导入源）
 *   4. **飞书 CLI 官方** `<dataRoot>/tools/skills/`（V0.12 一键安装时落盘）
 *
 * 不读 repo `.cursor/skills/`（SDK 已不加载 project 层；要用请导入到 app 自管）。
 *
 * 同名去重优先级：平台自带 > app 自管 > 全局 > 飞书 CLI
 * （自管是用户在本 app 里的显式配置、该压过跟 Cursor 共用的全局；平台 skill 是 fe 特定行为、不被顶掉）。
 */
/** 用户禁用的 skill 名单（v1.1.x 可关、settings.disabledSkills、按 name 记） */
export const readDisabledSkills = async (): Promise<Set<string>> => {
  try {
    const raw = await readSettingsFile();
    const arr = raw?.disabledSkills;
    return new Set(
      Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [],
    );
  } catch {
    return new Set();
  }
};

export const loadSkills = async (): Promise<SkillEntry[]> => {
  const own = await scanSkillsDir(
    path.join(process.cwd(), FE_AI_FLOW_OWN_SKILLS_DIR),
  );
  // app 自管 <dataRoot>/skills/（V0.13、设置页管理）
  const app = await scanSkillsDir(getAppSkillsDir());
  // 全局 ~/.cursor/skills/（兼容存量；全部 fe 注入、不靠 settingSources）
  const global: SkillEntry[] = [];
  for (const dir of getGlobalCursorDirs()) {
    global.push(...(await scanSkillsDir(path.join(dir, "skills"))));
  }
  // V0.12：内置飞书 CLI 的官方 skills（<dataRoot>/tools/skills、一键安装时落盘）
  const feishuCli = await scanSkillsDir(getToolsSkillsDir());
  // 合并去重（后 set 的覆盖先 set 的、所以低优先级先放）
  const byName = new Map<string, SkillEntry>();
  for (const s of feishuCli) byName.set(s.name, s);
  for (const s of global) byName.set(s.name, s);
  for (const s of app) byName.set(s.name, s);
  for (const s of own) byName.set(s.name, s);
  // v1.1.x：用户关掉的不注入（settings.disabledSkills、能力页 Skill tab 开关）
  const disabled = await readDisabledSkills();
  // 按 name 字母序、稳定输出顺序、方便 prompt 复用 / 调试 diff
  return [...byName.values()]
    .filter((s) => !disabled.has(s.name))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * 本机「可用 skill 名字」全集：loadSkills（平台 + 全局）∪ 各绑定仓的 `.cursor/skills/`。
 *
 * 给自定义 action 的 skills 点名做存在性判定（v0.9.14 skill 缺失兜底）：
 * 定义文件可能是别人导出的、引用了对方个人 skill——渲染 playbook 前按这个集合
 * 静默过滤、agent 不会拿到「点了名却查无此人」的引用去瞎找。
 * repo 层仍算进「名字是否存在」（定义里点了名就算有、避免误杀）；真正注入 prompt 的仍只有 loadSkills。
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
    return "（当前没有可用 skill。平台 skill 放在 ai-flow `skills/<name>/SKILL.md`、自管 skill 在能力页管理；也可从 `~/.cursor/skills/` 导入。）";
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
