/**
 * 自定义 action 定义的文件存储（V0.9 平铺 md → v1.1.x 目录化 → skill 挂载壳）
 *
 * 当前形态（用户拍板「自定义 action = skill 挂载壳」）：
 *   存 `dataRoot()/custom-actions/<id>/ACTION.md`（frontmatter-only、正文留空）：
 *   - frontmatter：label / summary / skill（主 skill）/ output（产出要求）/
 *     extraSkills / freshAgent / placeholder / createdAt / updatedAt
 *   - 正文：空（playbook 内容已迁到对应 skill 的 SKILL.md）
 *   - id = 目录名（新建时按 label slug 化）
 *
 * 存量自动迁移（读到即迁、幂等）：
 *   1. 老平铺 `<id>.md` → `<id>/ACTION.md`（目录化，既有）
 *   2. 老 ACTION.md 有非空 playbook 正文 → 抽成 app 自管 skill + 壳重写为新格式
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
import {
  findSkillByName,
  getAppSkillsDir,
  loadSkills,
} from "./skills-loader";
import type { CustomActionDef, CustomActionInput } from "@/lib/types";

// 对外 re-export、让 route 等调用方能从 fs 层一并拿到入参类型
export type { CustomActionInput };

// 自定义 action 目录（懒算、跟 dataRoot 一致、支持 test 实例隔离）
export const customActionsDir = (): string =>
  path.join(dataRoot(), "custom-actions");

// id 安全校验：只允许 字母 / 数字 / _ / -（防路径穿越 + 非法文件名）
const isSafeId = (id: string): boolean => /^[A-Za-z0-9_-]+$/.test(id);

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

// label → ASCII slug（作 id / skill 目录名）；中文等非 ASCII 全丢时返空串
const slugify = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

// 生成唯一 action id：优先 label slug、撞名探 -2/-3、全丢时回退随机
const genId = async (label: string): Promise<string> => {
  const slug = slugify(label);
  const fallback = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  if (!slug) return fallback;
  for (let i = 0; i < 20; i += 1) {
    const candidate = i === 0 ? slug : `${slug}-${i + 1}`;
    const exists =
      (await pathExists(dirOf(candidate))) ||
      (await pathExists(legacyFileOf(candidate)));
    if (!exists) return candidate;
  }
  return fallback;
};

/** 清洗 skill 名数组（trim、去空）——读文件 / route 入参共用 */
export const sanitizeSkills = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
  return out.length > 0 ? out : undefined;
};

/** 清洗单个必填 skill 名 */
export const sanitizeSkillName = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  return s.length > 0 ? s : undefined;
};

// 解析单个 md → CustomActionDef（label / skill 缺失视为非法、返 null）
// 注：老文件可能残留 checkCommands / skills / 正文 playbook——调用方先走迁移再 parse
const parseDef = (id: string, raw: string): CustomActionDef | null => {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const label = typeof data.label === "string" ? data.label.trim() : "";
  if (!label) return null;
  // 新格式必填 skill；兼容读：老 skills 数组已迁完不会走到这里无 skill
  const skill =
    sanitizeSkillName(data.skill) ??
    // 半迁移 / 手改残留：若 frontmatter 还写着老 skills[0] 且无 skill、不当合法壳
    undefined;
  if (!skill) return null;
  return {
    id,
    label,
    summary:
      typeof data.summary === "string" && data.summary.trim()
        ? data.summary.trim()
        : undefined,
    skill,
    // 产出要求：多行文本、trim 后空则不写（跟 summary / placeholder 同构）
    output:
      typeof data.output === "string" && data.output.trim()
        ? data.output.trim()
        : undefined,
    extraSkills: sanitizeSkills(data.extraSkills) ?? sanitizeSkills(data.skills),
    freshAgent: typeof data.freshAgent === "boolean" ? data.freshAgent : undefined,
    placeholder:
      typeof data.placeholder === "string" && data.placeholder.trim()
        ? data.placeholder.trim()
        : undefined,
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
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
    ...(def.extraSkills && def.extraSkills.length > 0
      ? { extraSkills: def.extraSkills }
      : {}),
    ...(typeof def.freshAgent === "boolean" ? { freshAgent: def.freshAgent } : {}),
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

/**
 * 挑一个不撞名的 skill 目录名（不覆盖已存在 skill）。
 * 撞名范围：app 自管目录已有 + loadSkills 已注册同名（避免写了却被平台 / 全局同名盖住）。
 */
const allocateSkillSlug = async (
  preferred: string,
  takenNames: Set<string>,
): Promise<string> => {
  const appDir = getAppSkillsDir();
  const base = preferred || `migrated-${Date.now().toString(36)}`;
  for (let i = 0; i < 30; i += 1) {
    // 首次用原名、之后 -2 / -3…（跟 action id 撞名约定一致）
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (takenNames.has(candidate)) continue;
    if (await pathExists(path.join(appDir, candidate))) continue;
    return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
};

/**
 * 老 playbook 正文 → app 自管 skill + ACTION.md 瘦身壳（读到旧格式即迁、幂等）。
 * 触发条件：正文非空（旧格式把 playbook 写在 ACTION.md 正文）。
 * 已是新格式（正文空 + 有 skill）再读不会进这里。
 */
const migratePlaybookToSkill = async (
  id: string,
  raw: string,
): Promise<CustomActionDef | null> => {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const playbook = parsed.content.trim();
  if (!playbook) return parseDef(id, raw);

  const label =
    typeof data.label === "string" && data.label.trim()
      ? data.label.trim()
      : id;
  const summary =
    typeof data.summary === "string" && data.summary.trim()
      ? data.summary.trim()
      : undefined;
  // 原 skills 引用并入 extraSkills（附加参考）；主内容已是新建的 skill
  const extraSkills = sanitizeSkills(data.extraSkills) ?? sanitizeSkills(data.skills);

  try {
    // 已注册名集合：写新 skill 时避开、免得被同名平台 / 全局 skill 盖住后内容丢了
    const taken = new Set((await loadSkills()).map((s) => s.name));
    const preferred = slugify(label) || slugify(id) || `action-${id}`;
    const skillSlug = await allocateSkillSlug(preferred, taken);

    // 写入 app 自管 skills/<slug>/SKILL.md（不覆盖已有——allocate 已探空位）
    const skillDir = path.join(getAppSkillsDir(), skillSlug);
    await fs.mkdir(skillDir, { recursive: true });
    const skillMd = matter.stringify(`\n${playbook}\n`, {
      name: skillSlug,
      // description 给 agent 扫一眼用；优先 summary、否则用动作名
      description: summary || label,
    });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMd, "utf-8");

    const def: CustomActionDef = {
      id,
      label,
      summary,
      skill: skillSlug,
      extraSkills,
      freshAgent:
        typeof data.freshAgent === "boolean" ? data.freshAgent : undefined,
      placeholder:
        typeof data.placeholder === "string" && data.placeholder.trim()
          ? data.placeholder.trim()
          : undefined,
      createdAt: typeof data.createdAt === "number" ? data.createdAt : Date.now(),
      updatedAt: Date.now(),
    };
    await writeDef(def);
    console.log(
      `[custom-action-fs] 已迁移 playbook→skill：action=${id} skill=${skillSlug}`,
    );
    return def;
  } catch (err) {
    console.warn(
      `[custom-action-fs] playbook→skill 迁移失败（下次重试）：${id}`,
      err,
    );
    return null;
  }
};

/**
 * 读 ACTION.md 原始内容 → 必要时迁移 → 解析成 Def。
 * 迁移链：正文非空（旧 playbook）先迁 skill；再 parse。
 */
const readAndMaybeMigrate = async (
  id: string,
  raw: string,
): Promise<CustomActionDef | null> => {
  const parsed = matter(raw);
  const playbook = parsed.content.trim();
  // 旧格式：正文里还塞着 playbook → 抽 skill + 重写壳
  if (playbook) {
    const migrated = await migratePlaybookToSkill(id, raw);
    if (migrated) return migrated;
    // 迁移失败：没法当新壳用（无 skill 字段）、返 null 让上层跳过 / 报缺失
    return null;
  }
  return parseDef(id, raw);
};

/** 列出所有自定义 action（按更新时间倒序）；读到旧格式顺手迁移 */
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
      const def = await readAndMaybeMigrate(id, raw);
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
      // 先目录化、再 playbook→skill（migrateLegacyFile 写完后读目录版走同一条迁移链）
      await migrateLegacyFile(id, raw);
      if (seen.has(id)) continue;
      const dirRaw = await fs.readFile(fileOf(id), "utf-8").catch(() => raw);
      const def = await readAndMaybeMigrate(id, dirRaw);
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

/** 读单个自定义 action；兼容旧平铺 / 旧 playbook（读到即迁移） */
export const getCustomAction = async (
  id: string,
): Promise<CustomActionDef | null> => {
  if (!isSafeId(id)) return null;
  try {
    const raw = await fs.readFile(fileOf(id), "utf-8");
    return readAndMaybeMigrate(id, raw);
  } catch {
    try {
      const raw = await fs.readFile(legacyFileOf(id), "utf-8");
      await migrateLegacyFile(id, raw);
      const dirRaw = await fs.readFile(fileOf(id), "utf-8").catch(() => raw);
      return readAndMaybeMigrate(id, dirRaw);
    } catch {
      return null;
    }
  }
};

/** 新建自定义 action（自动分配 id + 时间戳；skill 必填由调用方校验） */
export const createCustomAction = async (
  input: CustomActionInput,
): Promise<CustomActionDef> => {
  const skill = input.skill.trim();
  if (!skill) throw new Error("skill 必填");
  const now = Date.now();
  const def: CustomActionDef = {
    id: await genId(input.label.trim()),
    label: input.label.trim(),
    summary: input.summary?.trim() || undefined,
    skill,
    output: input.output?.trim() || undefined,
    extraSkills: input.extraSkills,
    freshAgent: input.freshAgent,
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
    // 显式传 extraSkills（含空数组清掉）时用新值；没传保留原值
    extraSkills:
      patch.extraSkills !== undefined ? patch.extraSkills : existing.extraSkills,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  // 空数组归一成 undefined、序列化时不写字段
  if (next.extraSkills && next.extraSkills.length === 0) {
    next.extraSkills = undefined;
  }
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
  extraSkills?: string[];
  freshAgent?: boolean;
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
    ...(def.extraSkills && def.extraSkills.length > 0
      ? { extraSkills: def.extraSkills }
      : {}),
    ...(typeof def.freshAgent === "boolean"
      ? { freshAgent: def.freshAgent }
      : {}),
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
      `skill 目录名非法「${skillName}」（只用字母数字 / _ / -）`,
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
        extraSkills: sanitizeSkills(meta.extraSkills),
        freshAgent:
          typeof meta.freshAgent === "boolean" ? meta.freshAgent : undefined,
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
