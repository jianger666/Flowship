/**
 * 自定义 action 定义的文件存储（V0.9 平铺 md → v1.1.x 目录化 → skill 挂载壳）
 *
 * 当前形态（用户拍板「自定义 action = skill 挂载壳」）：
 *   存 `dataRoot()/custom-actions/<id>/ACTION.md`（frontmatter-only、正文留空）：
 *   - frontmatter：label / summary / skill（主 skill）/ output（产出要求）/
 *     placeholder / createdAt / updatedAt
 *   - 旧数据里残留的 extraSkills / freshAgent（壳瘦身前的配置）解析时忽略、不清写
 *   - 正文：空（playbook 内容已迁到对应 skill 的 SKILL.md）
 *   - id = 目录名（新建时按 label slug 化）
 *
 * 旧格式处理（用户拍板「不静默迁移、旧的直接停用」）：
 *   1. 老平铺 `<id>.md` → `<id>/ACTION.md` 的**目录化**迁移保留（无损布局搬家、不动内容）
 *   2. 老 ACTION.md 正文还塞着 playbook（无 skill 字段）→ **不再自动抽 skill**；
 *      parse 成带 `legacyPlaybook` 的 def（skill 空串）——已停用、能力页只供查看原文 + 删除，
 *      不进推进列表、不注入运行。用户把原内容建成 skill 后重新新建挂载。
 *
 * 错误语义：
 *   - list：单文件解析失败 → warn + skip（不让整个列表炸）
 *   - get：找不到 / 解析失败 → 返 null
 *   - update / remove：找不到 → 抛（调用方转 404）
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import { dataRoot } from "./data-root";
import { findSkillByName, getAppSkillsDir, parseSkillFile } from "./skills-loader";
import type { CustomActionDef, CustomActionInput } from "@/lib/types";

// 对外 re-export、让 route 等调用方能从 fs 层一并拿到入参类型
export type { CustomActionInput };

// 自定义 action 目录（懒算、跟 dataRoot 一致、支持 test 实例隔离）
export const customActionsDir = (): string =>
  path.join(dataRoot(), "custom-actions");

// id / skill 目录名安全校验：字母数字中文 + ._-；拒绝 / \ 与以 . 开头（拦 .. 路径穿越）
// 与 app-rules isSafeRuleName / app-skills isSafeSkillName 同构
const isSafeId = (id: string): boolean =>
  /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5._-]*$/.test(id);

// id → 目录 / ACTION.md 路径（非法 id 直接抛、不让拼出越界路径）
const dirOf = (id: string): string => {
  if (!isSafeId(id)) throw new Error(`非法 custom action id：${id}`);
  return path.join(customActionsDir(), id);
};
const fileOf = (id: string): string => path.join(dirOf(id), "ACTION.md");
// 旧布局（V0.9 平铺）：`custom-actions/<id>.md`——读到即迁移
const legacyFileOf = (id: string): string => {
  if (!isSafeId(id)) throw new Error(`非法 custom action id：${id}`);
  return path.join(customActionsDir(), `${id}.md`);
};

const pathExists = async (p: string): Promise<boolean> =>
  !!(await fs.stat(p).catch(() => null));

/**
 * label → 目录名 / skill 名：保留中文与 `[a-z0-9._-]`，空白变 `-`，其余丢弃。
 * before：纯 ASCII slug、中文全丢 → 空串 → 随机 `custom-xxx`（难看）
 * after：「写代码」→「写代码」；撞名由调用方探 `-2/-3`；全空才回退随机
 * 前导 `.` 剥掉：slugify(".env 清理") → "env-清理"；否则首字符 `.` 不过 isSafeId、
 * genId 里 dirOf 会直接抛、用不了 fallback。
 */
const slugify = (label: string): string =>
  label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "") // 剥前导 / 尾随 `.` 与 `-`（id 不许以 `.` 开头）
    .slice(0, 48);

// 生成唯一 action id：优先 label slug、撞名探 -2/-3、全丢 / 非法时回退随机
const genId = async (label: string): Promise<string> => {
  const slug = slugify(label);
  const fallback = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  if (!slug || !isSafeId(slug)) return fallback;
  for (let i = 0; i < 20; i += 1) {
    const candidate = i === 0 ? slug : `${slug}-${i + 1}`;
    // 防御：拼后缀后万一仍非法 → 别调 dirOf（会抛）、直接回退
    if (!isSafeId(candidate)) return fallback;
    const exists =
      (await pathExists(dirOf(candidate))) ||
      (await pathExists(legacyFileOf(candidate)));
    if (!exists) return candidate;
  }
  return fallback;
};

/** 清洗单个必填 skill 名 */
export const sanitizeSkillName = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  return s.length > 0 ? s : undefined;
};

// 解析单个 md → CustomActionDef
// 新格式：frontmatter 有 skill、正文空。
// 旧格式（无 skill 字段、正文塞 playbook）→ 返回带 legacyPlaybook 的 def（skill 空串）——
// 已停用、只供能力页展示原文；两者都不满足（无 skill 也无正文）视为非法、返 null。
const parseDef = (id: string, raw: string): CustomActionDef | null => {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const label = typeof data.label === "string" ? data.label.trim() : "";
  if (!label) return null;
  const skill = sanitizeSkillName(data.skill);
  const playbook = parsed.content.trim();
  // 公共可选字段（新旧格式同构读取）
  // 注：旧数据里的 extraSkills / freshAgent / skills（壳瘦身前的配置）在这里被忽略、不清写
  const common = {
    summary:
      typeof data.summary === "string" && data.summary.trim()
        ? data.summary.trim()
        : undefined,
    placeholder:
      typeof data.placeholder === "string" && data.placeholder.trim()
        ? data.placeholder.trim()
        : undefined,
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
  };
  if (!skill) {
    if (!playbook) return null;
    return { id, label, skill: "", legacyPlaybook: playbook, ...common };
  }
  return {
    id,
    label,
    skill,
    // 产出要求：多行文本、trim 后空则不写（跟 summary / placeholder 同构）
    output:
      typeof data.output === "string" && data.output.trim()
        ? data.output.trim()
        : undefined,
    ...common,
  };
};

// CustomActionDef → md（frontmatter-only、正文空行——内容在 skill 里）
const serialize = (def: CustomActionDef): string => {
  const fm: Record<string, unknown> = {
    label: def.label,
    ...(def.summary ? { summary: def.summary } : {}),
    skill: def.skill,
    // gray-matter 对多行字符串会用 YAML 字面量块、读写往返 OK
    ...(def.output ? { output: def.output } : {}),
    ...(def.placeholder ? { placeholder: def.placeholder } : {}),
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
  };
  return matter.stringify("\n", fm);
};

const writeDef = async (def: CustomActionDef): Promise<void> => {
  await fs.mkdir(dirOf(def.id), { recursive: true });
  await fs.writeFile(fileOf(def.id), serialize(def), "utf-8");
};

// 老平铺文件 → 目录布局（读到旧文件时调、幂等）；目录版已存在则不覆盖、只清平铺
const migrateLegacyFile = async (id: string, raw: string): Promise<void> => {
  try {
    let dirVersionExists = false;
    try {
      await fs.access(fileOf(id));
      dirVersionExists = true;
    } catch {
      /* 目录版不存在、正常迁移 */
    }
    if (!dirVersionExists) {
      await fs.mkdir(dirOf(id), { recursive: true });
      await fs.writeFile(fileOf(id), raw, "utf-8");
    }
    await fs.rm(legacyFileOf(id), { force: true });
    console.log(`[custom-action-fs] 已迁移到目录布局：${id}`);
  } catch (err) {
    console.warn(`[custom-action-fs] 目录化迁移失败（下次重试）：${id}`, err);
  }
};

/** 列出所有自定义 action（按更新时间倒序）；旧平铺文件只做目录化搬家、不动内容 */
export const listCustomActions = async (): Promise<CustomActionDef[]> => {
  const dir = customActionsDir();
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const defs: CustomActionDef[] = [];
  // 目录版优先、平铺版只补漏 + 触发清理、防半迁移残留重复 id
  const seen = new Set<string>();
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    if (!isSafeId(id)) continue;
    try {
      const raw = await fs.readFile(path.join(dir, id, "ACTION.md"), "utf-8");
      const def = parseDef(id, raw);
      if (def) {
        defs.push(def);
        seen.add(id);
      }
    } catch {
      // 没有 ACTION.md 的目录跳过
    }
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const id = ent.name.slice(0, -3);
    if (!isSafeId(id)) continue;
    try {
      const raw = await fs.readFile(path.join(dir, ent.name), "utf-8");
      // 平铺 → 目录化（无损搬家、内容原样；旧 playbook 格式由 parseDef 打 legacy 标记）
      await migrateLegacyFile(id, raw);
      if (seen.has(id)) continue;
      const dirRaw = await fs.readFile(fileOf(id), "utf-8").catch(() => raw);
      const def = parseDef(id, dirRaw);
      if (def) {
        defs.push(def);
        seen.add(id);
      }
    } catch (err) {
      console.warn(
        `[custom-action-fs] 解析失败、跳过：${ent.name}`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return defs.sort((a, b) => b.updatedAt - a.updatedAt);
};

/** 读单个自定义 action；旧平铺只目录化搬家、旧 playbook 格式带 legacy 标记返回（不迁移） */
export const getCustomAction = async (
  id: string,
): Promise<CustomActionDef | null> => {
  if (!isSafeId(id)) return null;
  try {
    const raw = await fs.readFile(fileOf(id), "utf-8");
    return parseDef(id, raw);
  } catch {
    try {
      const raw = await fs.readFile(legacyFileOf(id), "utf-8");
      await migrateLegacyFile(id, raw);
      const dirRaw = await fs.readFile(fileOf(id), "utf-8").catch(() => raw);
      return parseDef(id, dirRaw);
    } catch {
      return null;
    }
  }
};

/** 新建自定义 action（自动分配 id + 时间戳；skill 必填由调用方校验） */
export const createCustomAction = async (
  input: CustomActionInput,
): Promise<CustomActionDef> => {
  const label = input.label.trim();
  if (!label) throw new Error("label 不能为空");
  const skill = input.skill.trim();
  if (!skill) throw new Error("skill 必填");
  const now = Date.now();
  const def: CustomActionDef = {
    id: await genId(label),
    label,
    summary: input.summary?.trim() || undefined,
    skill,
    output: input.output?.trim() || undefined,
    placeholder: input.placeholder?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  await writeDef(def);
  return def;
};

/** 更新自定义 action（id / createdAt 不可改、updatedAt 自动刷新） */
export const updateCustomAction = async (
  id: string,
  patch: Partial<CustomActionInput>,
): Promise<CustomActionDef> => {
  const existing = await getCustomAction(id);
  if (!existing) throw new Error(`custom action 不存在：${id}`);
  // 旧格式已停用：编辑会把正文 playbook 冲掉（writeDef 只写 frontmatter）、直接挡
  if (existing.legacyPlaybook) {
    throw new Error("旧格式 action 已停用、不能编辑——把原内容建成 skill 后重新新建挂载");
  }
  const nextSkill = (patch.skill ?? existing.skill).trim();
  if (!nextSkill) throw new Error("skill 必填");
  const next: CustomActionDef = {
    ...existing,
    ...patch,
    label: (patch.label ?? existing.label).trim(),
    skill: nextSkill,
    summary:
      patch.summary !== undefined
        ? patch.summary.trim() || undefined
        : existing.summary,
    output:
      patch.output !== undefined
        ? patch.output.trim() || undefined
        : existing.output,
    placeholder:
      patch.placeholder !== undefined
        ? patch.placeholder.trim() || undefined
        : existing.placeholder,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  await writeDef(next);
  return next;
};

/** 删除自定义 action（幂等；新目录 + 旧平铺文件都清） */
export const removeCustomAction = async (id: string): Promise<void> => {
  await fs.rm(dirOf(id), { recursive: true, force: true });
  await fs.rm(legacyFileOf(id), { force: true });
};

// ----------------- 共享包（导出 / 导入：skill 目录 + 可选 .flowship-action.json）-----------------

/**
 * 导出包里的挂载参数（写在 `<skill 目录>/.flowship-action.json`）。
 * 不含 id——导入方会按 label 重新分配 action id（撞名探号）。
 * skill 名由目录名决定、不写进 json。
 */
export interface ExportedActionMeta {
  label: string;
  summary?: string;
  output?: string;
  placeholder?: string;
  exportedAt: number;
}

/** 校验绝对路径且是已存在的目录；失败抛带中文说明的 Error（route 转 400） */
const assertExistingAbsDir = async (
  dir: string,
  label: string,
): Promise<string> => {
  if (typeof dir !== "string" || !dir.trim()) {
    throw new Error(`${label} 必填`);
  }
  const abs = path.resolve(dir.trim());
  if (!path.isAbsolute(abs)) {
    throw new Error(`${label} 必须是绝对路径`);
  }
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    throw new Error(`${label} 不存在：${abs}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`${label} 不是目录：${abs}`);
  }
  return abs;
};

/**
 * 导出单个自定义 action：把主 skill 整目录拷到 `<targetDir>/<skill名>/`，
 * 并在目录里写 .flowship-action.json（挂载参数、不含 id）。
 * 主 skill 须在本机任一来源找得到（app / 平台 / 全局 / 飞书 CLI）。
 */
export const exportCustomAction = async (
  id: string,
  targetDir: string,
): Promise<{ skillDir: string; skillName: string }> => {
  const absTarget = await assertExistingAbsDir(targetDir, "targetDir");
  const def = await getCustomAction(id);
  if (!def) throw new Error(`custom action 不存在：${id}`);
  // 旧格式无挂载 skill、没有可导出的包
  if (def.legacyPlaybook) {
    throw new Error("旧格式 action 已停用、无法导出——把原内容建成 skill 后重新新建挂载");
  }

  const skillEntry = await findSkillByName(def.skill);
  if (!skillEntry) {
    throw new Error(
      `主 skill「${def.skill}」本机找不到、无法导出（先确认 skill 已安装）`,
    );
  }
  // absPath 指向 SKILL.md → 导出整棵 skill 目录（含 scripts 等附属文件）
  const srcSkillDir = path.dirname(skillEntry.absPath);
  const destSkillDir = path.join(absTarget, def.skill);

  await fs.cp(srcSkillDir, destSkillDir, { recursive: true, force: true });

  const meta: ExportedActionMeta = {
    label: def.label,
    ...(def.summary ? { summary: def.summary } : {}),
    ...(def.output ? { output: def.output } : {}),
    ...(def.placeholder ? { placeholder: def.placeholder } : {}),
    exportedAt: Date.now(),
  };
  await fs.writeFile(
    path.join(destSkillDir, ".flowship-action.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf-8",
  );
  return { skillDir: destSkillDir, skillName: def.skill };
};

/**
 * 从本机文件夹导入：须含 SKILL.md → 拷进自管 skills（同名不覆盖）→
 * 若带 .flowship-action.json 则顺手 createCustomAction 挂壳。
 * 硬失败（缺 SKILL.md / 同名已存在）抛 Error；挂壳失败不回滚 skill、action 返 null + actionError。
 */
export const importCustomActionBundle = async (
  sourceDir: string,
): Promise<{
  skillName: string;
  skillDir: string;
  action: CustomActionDef | null;
  actionError?: string;
}> => {
  const absSource = await assertExistingAbsDir(sourceDir, "sourceDir");
  const skillMd = path.join(absSource, "SKILL.md");
  if (!(await pathExists(skillMd))) {
    throw new Error("所选文件夹缺少 SKILL.md、不是合法 skill 包");
  }

  // 目录名 = skill 名（导出约定；导入方不改名、撞名直接报错）
  const skillName = path.basename(absSource);
  if (!isSafeId(skillName)) {
    throw new Error(
      `skill 目录名非法「${skillName}」（只用字母 / 数字 / 中文 / _ - .）`,
    );
  }

  // 导入前跑 skills-loader 同款解析：挂壳成功但运行时找不到 skill 的半残包直接拒
  let parsed;
  try {
    parsed = await parseSkillFile(skillMd);
  } catch {
    throw new Error("SKILL.md 缺 description / 格式不合法");
  }
  if (!parsed) {
    throw new Error("SKILL.md 缺 description / 格式不合法");
  }
  // frontmatter name 缺省时 parseSkillFile 会用父目录名兜底 → 与 skillName 一致；
  // 显式写了别的 name → 与目录不一致，运行时按目录扫会找不到或指向错内容
  if (parsed.name !== skillName) {
    throw new Error(
      `SKILL.md frontmatter name「${parsed.name}」与目录名「${skillName}」不一致`,
    );
  }

  const destSkillDir = path.join(getAppSkillsDir(), skillName);
  if (await pathExists(destSkillDir)) {
    throw new Error(`同名 skill 已存在：${skillName}`);
  }

  await fs.mkdir(getAppSkillsDir(), { recursive: true });
  await fs.cp(absSource, destSkillDir, { recursive: true });

  // 拷进来的 .flowship-action.json 是挂载参数、不是 skill 内容——读完后从自管目录删掉、
  // 避免以后编辑 skill 时把壳参数误当成 skill 附属文件
  const importedMetaPath = path.join(destSkillDir, ".flowship-action.json");
  let action: CustomActionDef | null = null;
  let actionError: string | undefined;
  if (await pathExists(importedMetaPath)) {
    try {
      const raw = await fs.readFile(importedMetaPath, "utf-8");
      const meta = JSON.parse(raw) as Partial<ExportedActionMeta>;
      const label =
        typeof meta.label === "string" && meta.label.trim()
          ? meta.label.trim()
          : skillName;
      action = await createCustomAction({
        label,
        skill: skillName,
        summary:
          typeof meta.summary === "string" && meta.summary.trim()
            ? meta.summary.trim()
            : undefined,
        output:
          typeof meta.output === "string" && meta.output.trim()
            ? meta.output.trim()
            : undefined,
        // 旧导出包里的 extraSkills / freshAgent（壳瘦身前的字段）忽略
        placeholder:
          typeof meta.placeholder === "string" && meta.placeholder.trim()
            ? meta.placeholder.trim()
            : undefined,
      });
    } catch (err) {
      actionError =
        err instanceof Error ? err.message : String(err);
      console.warn(
        `[custom-action-fs] 导入 skill 成功但挂壳失败：${skillName}`,
        err,
      );
    }
    await fs.rm(importedMetaPath, { force: true }).catch(() => {});
  }

  return { skillName, skillDir: destSkillDir, action, actionError };
};
