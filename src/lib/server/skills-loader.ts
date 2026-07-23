/**
 * Flowship Skills Loader
 *
 * 加载 SKILL.md 风格的能力扩展（Anthropic Agent Skills 标准）。
 *
 * 设计要点（settingSources:[] 后全部 fe 自管注入 prompt）：
 *   - **只读四源**：`<Flowship>/skills/`（随包）+ `<dataRoot>/skills/`（能力页自管）
 *     + 飞书 CLI skills（`<dataRoot>/tools/skills/`）+ 组共享库 team（clone 的 skills/ + knowledge/skills/）。
 *   - **不扫 `~/.cursor/skills/`**：Cursor 全局不再注入；要从 IDE 带过来用能力页「从 Cursor 导入」拷成自管副本。
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
 *
 * 错误语义：单个 SKILL.md 解析失败 → warn + skip、不让整个 loader 炸
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import { dataRoot } from "./data-root";
import { getToolsSkillsDir } from "./feishu-cli";
import { readSettingsFile } from "./settings-fs";
// 路径 + 白名单零依赖（不 import team-library、防循环）
import {
  getTeamLibraryKnowledgeRoot,
  getTeamLibraryKnowledgeSkillsDir,
  getTeamLibrarySkillsDir,
  isSafeTeamSkillName,
} from "./team-library-paths";
// team skill 启停独立存储（零依赖小模块、不 import team-library 防循环）
import { readTeamSkillStates } from "./team-skill-states";

/** app 自管 skills 目录（V0.13 独立化、设置页可视化管理、随 data 目录走） */
export const getAppSkillsDir = (): string => path.join(dataRoot(), "skills");

// 组共享库路径 re-export（调用方原从本模块拿；实现已下沉 team-library-paths）
export {
  getTeamLibraryKnowledgeSkillsDir,
  getTeamLibrarySkillsDir,
};

// Flowship 平台自身 skills 目录的相对路径
// V0.3 起：从 `.ai-flow/skills/` 挪到顶级 `skills/`、跟 `prompts/` 平级、
// 命名直白、避免「Flowship inside Flowship」的冗余目录层
const FLOWSHIP_OWN_SKILLS_DIR = "skills";

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
  /**
   * 知识库根（仅 team 源 knowledge/skills/** 有）：
   * skill 内相对路径（如 knowledge-base/projects/...、scripts/*.py）以此目录为根解析。
   */
  kbRoot?: string;
}

/** parseSkillFile / scanSkillsDir 可选行为 */
export type ParseSkillFileOpts = {
  /**
   * 仅 team 源打开：frontmatter name 过 isSafeTeamSkillName 白名单；
   * 不过 → fallback 目录名；目录名也不过 → null + warn。
   * app 自管 / 内置 / 飞书 CLI 不要开（各自有自己的命名规则）。
   */
  enforceTeamName?: boolean;
};

/**
 * 递归扫描某个目录下所有 SKILL.md
 *
 * @param rootDir   要扫的根目录绝对路径
 * @param opts      传给 parseSkillFile（team 源传 enforceTeamName）
 * @returns         所有解析出的 SkillEntry（解析失败的 silent skip）
 * export：app-skills.ts（设置页 Skill 管理）复用
 */
export const scanSkillsDir = async (
  rootDir: string,
  opts?: ParseSkillFileOpts,
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
      // 与 copyTree 对齐：不跟随 symlink（防共享仓误放/恶意链扫出仓外）
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs, depth + 1);
        continue;
      }
      // 只要文件名是 SKILL.md（大小写不敏感、避免 macOS HFS+ 大小写差异）
      if (ent.name.toUpperCase() !== "SKILL.MD") continue;
      try {
        const parsed = await parseSkillFile(abs, opts);
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
 * export：importCustomActionBundle 导入前复用同一套校验
 */
export const parseSkillFile = async (
  absPath: string,
  opts?: ParseSkillFileOpts,
): Promise<SkillEntry | null> => {
  const raw = await fs.readFile(absPath, "utf-8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;

  // name 必填、缺省用 SKILL.md 父目录名作为兜底
  let name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name) {
    name = path.basename(path.dirname(absPath));
  }

  // 仅 team 源收紧：frontmatter name 不过白名单 → 目录名；目录名也不过 → skip
  if (opts?.enforceTeamName) {
    if (!isSafeTeamSkillName(name)) {
      const dirName = path.basename(path.dirname(absPath));
      if (isSafeTeamSkillName(dirName)) {
        console.warn(
          `[skills-loader] team skill frontmatter name「${name}」非法、改用目录名「${dirName}」：${absPath}`,
        );
        name = dirName;
      } else {
        console.warn(
          `[skills-loader] team skill name「${name}」与目录名「${dirName}」均非法、skip：${absPath}`,
        );
        return null;
      }
    }
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
 * 加载本次 agent 可用的 skills：平台自带 + app 自管 + 飞书 CLI + 组共享库
 *
 * 来源（都由 fe 注入 prompt、`settingSources:[]` 不靠 SDK 加载 .cursor）：
 *   1. **平台自带** `<Flowship>/skills/`（跟 git 仓库发布、所有用户共享）
 *   2. **app 自管** `<dataRoot>/skills/`（V0.13 独立化：设置页可视化增删改、见 app-skills.ts）
 *   3. **飞书 CLI 官方** `<dataRoot>/tools/skills/`（V0.12 一键安装时落盘）
 *   4. **组共享库 team** clone 的 `skills/` + `knowledge/skills/`（最低优先级）
 *
 * 不读 `~/.cursor/skills/`（导入源仅供「从 Cursor 导入」、不注入）；
 * 不读 repo `.cursor/skills/`（SDK 已不加载 project 层；要用请导入到 app 自管）。
 *
 * 同名去重优先级：app 自管 > 平台自带 > 飞书 CLI > team
 * （用户自建覆盖平台默认，与 findSkillByName / playbook 注入一致；平台 skill
 * 如 action-creator 被同名自管 skill 顶掉属预期）。
 */
/** 用户禁用的 skill 名单（settings.disabledSkills、按 name 记；仅作用于 app 自管源） */
export const readDisabledSkills = async (): Promise<Set<string>> => {
  try {
    const result = await readSettingsFile();
    const raw = result.status === "ok" ? result.settings : null;
    const arr = raw?.disabledSkills;
    return new Set(
      Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [],
    );
  } catch {
    return new Set();
  }
};

/**
 * 团队规范总开关（settings.teamKnowledgeEnabled）——一键隔离 wk 知识库那套。
 * 缺省 / 非 false → true；关了日常 loadSkills / loadSkillsForTask 跳过 knowledge
 *（含按仓自动匹配）。共享 skills/ 无总开关（市场模型、装不装用户按 skill 定）。
 * findSkillByName / readSkillBodyByName 不读此开关（action 挂载直读语义保留）。
 */
export const readTeamKnowledgeEnabled = async (): Promise<boolean> => {
  try {
    const result = await readSettingsFile();
    const raw = result.status === "ok" ? result.settings : null;
    return raw?.teamKnowledgeEnabled !== false;
  } catch {
    return true;
  }
};

/** 给 knowledge/skills 扫出的条目打 kbRoot（库内相对路径解析根） */
const withKbRoot = (
  entries: SkillEntry[],
  kbRoot: string,
): SkillEntry[] => entries.map((e) => ({ ...e, kbRoot }));

export const loadSkills = async (): Promise<SkillEntry[]> => {
  const own = await scanSkillsDir(
    path.join(process.cwd(), FLOWSHIP_OWN_SKILLS_DIR),
  );
  // app 自管 <dataRoot>/skills/（V0.13、设置页管理）
  const app = await scanSkillsDir(getAppSkillsDir());
  // V0.12：内置飞书 CLI 的官方 skills（<dataRoot>/tools/skills、一键安装时落盘）
  const feishuCli = await scanSkillsDir(getToolsSkillsDir());
  // 组共享库：shared 无总开关（市场模型）；knowledge 受团队规范开关控制
  // team 源扫 name 白名单（app / 内置 / 飞书 CLI 不收紧）
  const knowledgeEnabled = await readTeamKnowledgeEnabled();
  const teamGroup = await scanSkillsDir(getTeamLibrarySkillsDir(), {
    enforceTeamName: true,
  });
  const teamKb = knowledgeEnabled
    ? withKbRoot(
        await scanSkillsDir(getTeamLibraryKnowledgeSkillsDir(), {
          enforceTeamName: true,
        }),
        getTeamLibraryKnowledgeRoot(),
      )
    : [];
  // 合并去重（后 set 的覆盖先 set 的、所以低优先级先放）；带来源标记——启停过滤三分：
  //   team → skill-states（enabled=已安装才注入）；app 自管 → settings.disabledSkills；
  //   内置 / 飞书 CLI → 必备只读、永远注入（不查任何禁用表）
  // 优先级：app 自管 > 平台自带 > 飞书 CLI > team（team 内：组 skills/ > 知识库 knowledge/skills/）
  type Gate = "team" | "app" | "fixed";
  const byName = new Map<string, { entry: SkillEntry; gate: Gate }>();
  for (const s of teamKb) byName.set(s.name, { entry: s, gate: "team" });
  for (const s of teamGroup) byName.set(s.name, { entry: s, gate: "team" });
  for (const s of feishuCli) byName.set(s.name, { entry: s, gate: "fixed" });
  for (const s of own) byName.set(s.name, { entry: s, gate: "fixed" });
  for (const s of app) byName.set(s.name, { entry: s, gate: "app" });
  // team：单一 owner 的 skill-states（disabled=未安装不注入；不在表里 = 默认已安装、
  // sync 后策略会补写——fail-open 保证首次 sync 前 loader 不空转）
  const disabled = await readDisabledSkills();
  const teamStates = await readTeamSkillStates();
  // 按 name 字母序、稳定输出顺序、方便 prompt 复用 / 调试 diff
  return [...byName.values()]
    .filter(({ entry, gate }) => {
      if (gate === "team") return teamStates[entry.name] !== "disabled";
      if (gate === "app") return !disabled.has(entry.name);
      return true;
    })
    .map(({ entry }) => entry)
    .sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * 在 knowledge/skills/<category>/<basename>/ 下扫 SKILL.md（目录名精确匹配 basename）。
 * category 不写死枚举——列 knowledge/skills 下一层目录即可。
 */
const scanRepoMatchedTeamSkills = async (
  basenames: string[],
): Promise<SkillEntry[]> => {
  const kbSkillsDir = getTeamLibraryKnowledgeSkillsDir();
  const kbRoot = getTeamLibraryKnowledgeRoot();
  let categories: string[] = [];
  try {
    const ents = await fs.readdir(kbSkillsDir, { withFileTypes: true });
    categories = ents
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const found: SkillEntry[] = [];
  const seen = new Set<string>();
  for (const cat of categories) {
    for (const basename of basenames) {
      const dir = path.join(kbSkillsDir, cat, basename);
      const entries = withKbRoot(
        await scanSkillsDir(dir, { enforceTeamName: true }),
        kbRoot,
      );
      for (const e of entries) {
        if (seen.has(e.name)) continue;
        seen.add(e.name);
        found.push(e);
      }
    }
  }
  return found;
};

/**
 * 任务 / chat 注入用：在 loadSkills() 之上，按仓库 basename 强制并入
 * knowledge/skills/<cat>/<basename>/ 命中的工程 skill（即使 skill-states 标 disabled 也加）。
 * 团队规范开关为 false 时不注入匹配命中（与 knowledge 同源）；chat 无仓传 [] ≡ loadSkills。
 */
export const loadSkillsForTask = async (
  repoPaths: string[],
): Promise<SkillEntry[]> => {
  const base = await loadSkills();
  const knowledgeEnabled = await readTeamKnowledgeEnabled();
  if (!knowledgeEnabled) return base;

  const basenames = [
    ...new Set(
      repoPaths
        .map((p) => path.basename(String(p ?? "").trim()))
        .filter((b) => !!b && b !== "." && b !== ".."),
    ),
  ];
  if (basenames.length === 0) return base;

  const matched = await scanRepoMatchedTeamSkills(basenames);
  if (matched.length === 0) return base;

  // 已有同名保留 base（更高优先级来源）；缺的才强制并入（含被 disabled 滤掉的）
  const byName = new Map(base.map((s) => [s.name, s]));
  for (const s of matched) {
    if (!byName.has(s.name)) byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * 按名找 skill（自定义 action 主 skill 注入用）。
 * 优先级：app 自管 > 平台自带 > 飞书 CLI > team（与 loadSkills 同名去重一致；
 * 用户自建覆盖平台默认）。
 * 不走 disabledSkills 过滤——action 已显式挂载、关掉开关也不该让壳跑空
 *（推进面板入口另由 filterAdvanceByDisabledAppSkills 拦、历史任务重启仍直读）。
 */
export const findSkillByName = async (
  name: string,
): Promise<SkillEntry | null> => {
  const needle = name.trim();
  if (!needle) return null;
  // 高优先级在前；team 两个目录排最后（team 扫强制 name 白名单）
  const sources: Array<{
    dir: string;
    kbRoot?: string;
    enforceTeamName?: boolean;
  }> = [
    { dir: getAppSkillsDir() },
    { dir: path.join(process.cwd(), FLOWSHIP_OWN_SKILLS_DIR) },
    { dir: getToolsSkillsDir() },
    { dir: getTeamLibrarySkillsDir(), enforceTeamName: true },
    {
      dir: getTeamLibraryKnowledgeSkillsDir(),
      kbRoot: getTeamLibraryKnowledgeRoot(),
      enforceTeamName: true,
    },
  ];
  for (const { dir, kbRoot, enforceTeamName } of sources) {
    const entries = await scanSkillsDir(
      dir,
      enforceTeamName ? { enforceTeamName: true } : undefined,
    );
    const hit = entries.find((e) => e.name === needle);
    if (hit) return kbRoot ? { ...hit, kbRoot } : hit;
  }
  return null;
};

/**
 * 读 skill 的 SKILL.md 正文（去掉 frontmatter、只返 content）。
 * 找不到 / 读失败 → null（调用方出「定义缺失」兜底文案）。
 */
export const readSkillBodyByName = async (
  name: string,
): Promise<string | null> => {
  const entry = await findSkillByName(name);
  if (!entry) return null;
  try {
    const raw = await fs.readFile(entry.absPath, "utf-8");
    return matter(raw).content.trim();
  } catch {
    return null;
  }
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
    return "（当前没有可用 skill。平台 skill 放在 Flowship `skills/<name>/SKILL.md`、自管 skill 在能力页管理；也可从 Cursor 导入为自管副本。）";
  }
  const lines: string[] = [];
  for (const s of skills) {
    lines.push(`- **${s.name}**`);
    lines.push(`  desc: ${s.description.replace(/\n/g, " ")}`);
    lines.push(`  path: ${s.absPath}`);
    // 知识库 skill：相对路径以此根解析（knowledge-base/...、scripts/*.py）
    if (s.kbRoot) {
      lines.push(
        `  kbRoot: ${s.kbRoot}（本 skill 内的相对路径以此目录为根解析）`,
      );
    }
    if (s.paths && s.paths.length > 0) {
      lines.push(`  paths: ${s.paths.join(", ")}`);
    }
  }
  return lines.join("\n");
};
