/**
 * 自定义 action 定义的文件存储（skill 托管收敛）
 *
 * 当前形态（2026-07-23 用户拍板「推进入口 = skill 目录 + .flowship-action.json」）：
 *   - 自建：`<dataRoot>/skills/<name>/.flowship-action.json` → id=`app:<name>`、origin=`app-skill`
 *   - 共享：team clone 同构 json → id=`team:<name>`、origin=`team`（已安装态派生）
 *   - 旧 `custom-actions/<id>/ACTION.md`：非 legacy 启动/list 时迁进 skill json 后删；
 *     legacy（playbook 正文、无 skill）保留只读展示 + 转建
 *
 * 错误语义：
 *   - list：单文件解析失败 → warn + skip（不让整个列表炸）
 *   - get：找不到 / 解析失败 → 返 null
 *   - update / remove：找不到 → 抛（调用方转 404）
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import { dataRoot, writePrivateFileAtomic } from "./data-root";
import {
  findSkillByName,
  getAppSkillsDir,
  parseSkillFile,
  scanSkillsDir,
} from "./skills-loader";
import { readSettingsFile } from "./settings-fs";
// 路径 + 白名单零依赖（不 import team-library、防循环）
import {
  getTeamLibraryKnowledgeSkillsDir,
  getTeamLibrarySkillsDir,
  isSafeTeamSkillName,
  teamLibraryRepoDir,
} from "./team-library-paths";
// team skill 启停（安装态）——派生 team action 的数据源（零依赖模块、不会循环 import）
import { getTeamSkillAuthors } from "./team-skill-authors";
import { readTeamSkillStates } from "./team-skill-states";
import type { CustomActionDef, CustomActionInput } from "@/lib/types";

// 对外 re-export、让 route 等调用方能从 fs 层一并拿到入参类型
export type { CustomActionInput };

/** skill 目录内挂载壳文件名（自建 / 共享同构） */
export const FLOWSHIP_ACTION_JSON = ".flowship-action.json";

/** fs 层业务错误码——route 按 code 判 HTTP，禁止依赖文案子串 */
export type CustomActionFsErrorCode =
  | "ALREADY_MOUNTED"
  | "NOT_FOUND"
  | "INVALID";

export class CustomActionFsError extends Error {
  readonly code: CustomActionFsErrorCode;
  constructor(code: CustomActionFsErrorCode, message: string) {
    super(message);
    this.name = "CustomActionFsError";
    this.code = code;
  }
}

export const isCustomActionFsError = (
  err: unknown,
): err is CustomActionFsError =>
  err instanceof CustomActionFsError ||
  (err instanceof Error &&
    err.name === "CustomActionFsError" &&
    typeof (err as CustomActionFsError).code === "string");

// 自定义 action 旧目录（懒算、跟 dataRoot 一致、支持 test 实例隔离；仅留 legacy）
export const customActionsDir = (): string =>
  path.join(dataRoot(), "custom-actions");

// ---------- id 空间 ----------

/** 自建派生 action id 前缀（冒号刻意不过 isSafeId、与旧目录名隔离） */
export const APP_ACTION_ID_PREFIX = "app:";
/** 共享库派生 action id 前缀 */
export const TEAM_ACTION_ID_PREFIX = "team:";

export const isAppActionId = (id: string): boolean =>
  id.startsWith(APP_ACTION_ID_PREFIX);

export const isTeamActionId = (id: string): boolean =>
  id.startsWith(TEAM_ACTION_ID_PREFIX);

/** app: / team: 派生 id（非旧 custom-actions 目录名） */
export const isDerivedActionId = (id: string): boolean =>
  isAppActionId(id) || isTeamActionId(id);

export const appActionIdFor = (skillName: string): string =>
  `${APP_ACTION_ID_PREFIX}${skillName}`;

export const teamActionIdFor = (skillName: string): string =>
  `${TEAM_ACTION_ID_PREFIX}${skillName}`;

export const skillNameFromAppActionId = (id: string): string | null => {
  if (!isAppActionId(id)) return null;
  const name = id.slice(APP_ACTION_ID_PREFIX.length);
  return sanitizeSkillName(name) ?? null;
};

export const skillNameFromTeamActionId = (id: string): string | null => {
  if (!isTeamActionId(id)) return null;
  const name = id.slice(TEAM_ACTION_ID_PREFIX.length);
  return sanitizeSkillName(name) ?? null;
};

// id / skill 目录名安全校验：字母数字中文 + ._-；拒绝 / \ 与以 . 开头（拦 .. 路径穿越）
// 与 app-rules isSafeRuleName / app-skills isSafeSkillName 同构
const isSafeId = (id: string): boolean =>
  /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5._-]*$/.test(id);

// id → 目录 / ACTION.md 路径（非法 id 直接抛、不让拼出越界路径）——仅 legacy 路径用
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
 * 清洗单个必填 skill 名（白名单：字母数字中文 + ._-；拒 `.` / `..` / 前导点 / 路径分隔）。
 * 与 app-skills isSafeSkillName 同构，防 `../evil` 路径穿越。
 */
export const sanitizeSkillName = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s || s === "." || s === "..") return undefined;
  if (s.startsWith(".")) return undefined;
  if (!/^[a-zA-Z0-9\u4e00-\u9fa5][a-zA-Z0-9\u4e00-\u9fa5._-]{0,63}$/.test(s)) {
    return undefined;
  }
  return s;
};

/** dest 是否落在 absRoot 之内（含自身）；用 resolve 后再比前缀，防 `..` 穿越 */
const isPathInside = (absRoot: string, absDest: string): boolean => {
  const root = path.resolve(absRoot);
  const dest = path.resolve(absDest);
  if (dest === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return dest.startsWith(prefix);
};

/** 递归删除目录树内全部 symlink（导入 bundle 后清仓外链接） */
const stripSymlinksUnder = async (root: string): Promise<number> => {
  let removed = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        await fs.rm(full, { force: true });
        removed += 1;
        continue;
      }
      if (ent.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return removed;
};

// ----------------- .flowship-action.json -----------------

/**
 * 导出包 / 托管壳里的挂载参数（写在 `<skill 目录>/.flowship-action.json`）。
 * 不含 id——id 由目录名派生（app:<name> / team:<name>）。
 * skill 名由目录名决定、不写进 json。
 */
export interface ExportedActionMeta {
  label: string;
  output?: string;
  placeholder?: string;
  /** 流程默认顺序（可选）；有则 listCustomActions 升序排前 */
  order?: number;
  /** 严格 true 才写入；缺省 / 假值不落盘 */
  requiresKnowledge?: boolean;
  exportedAt: number;
}

/**
 * 解析 .flowship-action.json → ExportedActionMeta。
 * label 必填；requiresKnowledge 仅严格 boolean true；解析失败 / label 空 → null。
 */
export const parseFlowshipActionMeta = (
  raw: string,
): ExportedActionMeta | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  const label = typeof o.label === "string" ? o.label.trim() : "";
  if (!label) return null;
  const meta: ExportedActionMeta = {
    label,
    exportedAt:
      typeof o.exportedAt === "number" && Number.isFinite(o.exportedAt)
        ? o.exportedAt
        : Date.now(),
  };
  if (typeof o.output === "string" && o.output.trim()) {
    meta.output = o.output.trim();
  }
  if (typeof o.placeholder === "string" && o.placeholder.trim()) {
    meta.placeholder = o.placeholder.trim();
  }
  // 仅有限数字；字符串 / NaN / Infinity 不认
  if (typeof o.order === "number" && Number.isFinite(o.order)) {
    meta.order = o.order;
  }
  // 严格 true：字符串 "true" / 1 都不认，防脏数据
  if (o.requiresKnowledge === true) {
    meta.requiresKnowledge = true;
  }
  return meta;
};

/** 写出 .flowship-action.json（原子写、0600） */
export const writeFlowshipActionJson = async (
  skillDir: string,
  meta: ExportedActionMeta,
): Promise<void> => {
  const payload: ExportedActionMeta = {
    label: meta.label,
    exportedAt: meta.exportedAt,
    ...(meta.output ? { output: meta.output } : {}),
    ...(meta.placeholder ? { placeholder: meta.placeholder } : {}),
    ...(typeof meta.order === "number" && Number.isFinite(meta.order)
      ? { order: meta.order }
      : {}),
    ...(meta.requiresKnowledge === true ? { requiresKnowledge: true } : {}),
  };
  await writePrivateFileAtomic(
    path.join(skillDir, FLOWSHIP_ACTION_JSON),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
};

/** meta → 派生 CustomActionDef（app / team 共用字段拼装） */
const defFromMeta = (
  id: string,
  skill: string,
  meta: ExportedActionMeta,
  extra?: Partial<CustomActionDef>,
): CustomActionDef => ({
  id,
  label: meta.label,
  skill,
  output: meta.output,
  placeholder: meta.placeholder,
  ...(typeof meta.order === "number" && Number.isFinite(meta.order)
    ? { order: meta.order }
    : {}),
  ...(meta.requiresKnowledge === true ? { requiresKnowledge: true } : {}),
  createdAt: meta.exportedAt,
  updatedAt: meta.exportedAt,
  ...extra,
});

// ---------- 旧 ACTION.md 解析（仅 legacy + 迁移扫描） ----------

// 解析单个 md → CustomActionDef
// 新格式：frontmatter 有 skill、正文空（迁移前旧壳）。
// 旧格式（无 skill 字段、正文塞 playbook）→ 返回带 legacyPlaybook 的 def。
const parseDef = (id: string, raw: string): CustomActionDef | null => {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const label = typeof data.label === "string" ? data.label.trim() : "";
  if (!label) return null;
  const skill = sanitizeSkillName(data.skill);
  const playbook = parsed.content.trim();
  const common = {
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
    output:
      typeof data.output === "string" && data.output.trim()
        ? data.output.trim()
        : undefined,
    // 旧 ACTION.md 若写过 requiresKnowledge（极少）——迁移时一并带上
    ...(data.requiresKnowledge === true ? { requiresKnowledge: true } : {}),
    ...common,
  };
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

// ---------- 派生 app / team action ----------

/**
 * 扫自管 skills/：带有效 .flowship-action.json 的 → 派生 app:<name>。
 */
const deriveAppActions = async (): Promise<CustomActionDef[]> => {
  const root = getAppSkillsDir();
  const entries = await scanSkillsDir(root);
  const out: CustomActionDef[] = [];
  for (const e of entries) {
    const skillName = sanitizeSkillName(e.name);
    if (!skillName) continue;
    const skillDir = path.dirname(e.absPath);
    let meta: ExportedActionMeta | null = null;
    try {
      meta = parseFlowshipActionMeta(
        await fs.readFile(path.join(skillDir, FLOWSHIP_ACTION_JSON), "utf-8"),
      );
    } catch {
      continue; // 无标记 = 纯 skill、不派生
    }
    if (!meta) continue;
    out.push(
      defFromMeta(appActionIdFor(skillName), skillName, meta, {
        origin: "app-skill",
      }),
    );
  }
  return out;
};

/**
 * 实时合成共享库来源的虚拟 action def：
 * 已安装且同目录带 .flowship-action.json 的 team skill → CustomActionDef。
 */
const deriveTeamActions = async (): Promise<CustomActionDef[]> => {
  const states = await readTeamSkillStates();
  const authors = await getTeamSkillAuthors(teamLibraryRepoDir());
  const out: CustomActionDef[] = [];
  const seenSkill = new Set<string>();
  // shared 在前（同名以 shared 为准、与 loadSkills 的 team 内优先级一致）
  const dirs = [
    { root: getTeamLibrarySkillsDir(), kind: "shared" as const },
    { root: getTeamLibraryKnowledgeSkillsDir(), kind: "knowledge" as const },
  ];
  for (const { root, kind } of dirs) {
    const entries = await scanSkillsDir(root, { enforceTeamName: true });
    for (const e of entries) {
      if (seenSkill.has(e.name)) continue;
      if (states[e.name] === "disabled") continue;
      if (!isSafeTeamSkillName(e.name)) {
        console.warn(
          `[custom-action-fs] 派生 team action 跳过：skill name「${e.name}」非法`,
        );
        continue;
      }
      const skillDir = path.dirname(e.absPath);
      let meta: ExportedActionMeta | null = null;
      try {
        meta = parseFlowshipActionMeta(
          await fs.readFile(path.join(skillDir, FLOWSHIP_ACTION_JSON), "utf-8"),
        );
      } catch {
        continue;
      }
      if (!meta) continue;
      seenSkill.add(e.name);
      const parts = path
        .relative(root, e.absPath)
        .split(path.sep)
        .filter(Boolean);
      const teamCategory =
        kind === "shared"
          ? `shared:${parts.length >= 3 ? (parts[0] ?? "common") : "common"}`
          : (parts[0] ?? "unknown");
      const relDir = path
        .relative(teamLibraryRepoDir(), skillDir)
        .split(path.sep)
        .join("/");
      out.push(
        defFromMeta(teamActionIdFor(e.name), e.name, meta, {
          origin: "team",
          teamCategory,
          ...(authors[relDir] ? { author: authors[relDir] } : {}),
        }),
      );
    }
  }
  return out;
};

/**
 * 仅列 custom-actions/ 里带 legacyPlaybook 的旧定义（供能力页查看 / 转建）。
 * 非 legacy 应由 migrateCustomActionsToSkillHosted 迁走；残留不进列表。
 */
const listLegacyLocalActions = async (): Promise<CustomActionDef[]> => {
  const dir = customActionsDir();
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const defs: CustomActionDef[] = [];
  const seen = new Set<string>();
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    if (!isSafeId(id)) continue;
    try {
      const raw = await fs.readFile(path.join(dir, id, "ACTION.md"), "utf-8");
      const def = parseDef(id, raw);
      if (def?.legacyPlaybook) {
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
      await migrateLegacyFile(id, raw);
      if (seen.has(id)) continue;
      const dirRaw = await fs.readFile(fileOf(id), "utf-8").catch(() => raw);
      const def = parseDef(id, dirRaw);
      if (def?.legacyPlaybook) {
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
  return defs;
};

/** 是否带有效流程 order（与 .flowship-action.json 解析口径一致） */
const hasFlowOrder = (d: CustomActionDef): boolean =>
  typeof d.order === "number" && Number.isFinite(d.order);

/**
 * 列出所有自定义 action = legacy 残留 + 派生 app + 派生 team。
 * 排序：有 order 的按 order 升序排前；没有的按 updatedAt 倒序排后。
 * 同 skill 名：app 源优先、team 源跳过（用户本地版就是他自己的；Skill 市场两侧展示不改）。
 */
export const listCustomActions = async (): Promise<CustomActionDef[]> => {
  await migrateCustomActionsToSkillHosted();
  const legacy = await listLegacyLocalActions();
  const app = await deriveAppActions();
  const team = await deriveTeamActions();
  // app 已挂壳的 skill 名 → 推进「我的」列表不再叠同名 team 行
  const appSkills = new Set(app.map((d) => d.skill));
  const teamDeduped = team.filter((d) => !appSkills.has(d.skill));
  return [...legacy, ...app, ...teamDeduped].sort((a, b) => {
    const aOrd = hasFlowOrder(a);
    const bOrd = hasFlowOrder(b);
    if (aOrd && bOrd) return a.order! - b.order!;
    if (aOrd) return -1;
    if (bOrd) return 1;
    return b.updatedAt - a.updatedAt;
  });
};

/** 读单个自定义 action；app:/team: 走派生；旧 safe id 只读 custom-actions（legacy / 未迁残留） */
export const getCustomAction = async (
  id: string,
): Promise<CustomActionDef | null> => {
  if (isAppActionId(id)) {
    const name = skillNameFromAppActionId(id);
    if (!name) return null;
    const skillDir = path.join(getAppSkillsDir(), name);
    try {
      const meta = parseFlowshipActionMeta(
        await fs.readFile(path.join(skillDir, FLOWSHIP_ACTION_JSON), "utf-8"),
      );
      if (!meta) return null;
      return defFromMeta(appActionIdFor(name), name, meta, {
        origin: "app-skill",
      });
    } catch {
      return null;
    }
  }
  if (isTeamActionId(id)) {
    const name = skillNameFromTeamActionId(id);
    if (!name) return null;
    // 与 list 一致：同名 app 壳存在时 team: id 视为不可见（返 null）
    if (await pathExists(path.join(getAppSkillsDir(), name, FLOWSHIP_ACTION_JSON))) {
      return null;
    }
    const all = await deriveTeamActions();
    return all.find((d) => d.id === id) ?? null;
  }
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

/**
 * 新建自建 action：skill 必须已在自管目录存在；写 .flowship-action.json；
 * id 固定为 app:<skill>，不再按 label genId。
 */
export const createCustomAction = async (
  input: CustomActionInput,
): Promise<CustomActionDef> => {
  const label = input.label.trim();
  if (!label) throw new CustomActionFsError("INVALID", "label 不能为空");
  const skill = sanitizeSkillName(input.skill);
  if (!skill) {
    throw new CustomActionFsError(
      "INVALID",
      "skill 名非法或为空（只用字母 / 数字 / 中文 / _ - .，不以 . 开头）",
    );
  }
  const skillDir = path.join(getAppSkillsDir(), skill);
  if (!(await pathExists(skillDir))) {
    throw new CustomActionFsError(
      "NOT_FOUND",
      `skill「${skill}」不存在于自管目录、请先创建 / 导入 skill`,
    );
  }
  const jsonPath = path.join(skillDir, FLOWSHIP_ACTION_JSON);
  if (await pathExists(jsonPath)) {
    throw new CustomActionFsError(
      "ALREADY_MOUNTED",
      `skill「${skill}」已挂载 action、不能重复创建`,
    );
  }
  const now = Date.now();
  const meta: ExportedActionMeta = {
    label,
    exportedAt: now,
    ...(input.output?.trim() ? { output: input.output.trim() } : {}),
    ...(input.placeholder?.trim()
      ? { placeholder: input.placeholder.trim() }
      : {}),
    ...(typeof input.order === "number" && Number.isFinite(input.order)
      ? { order: input.order }
      : {}),
    ...(input.requiresKnowledge === true ? { requiresKnowledge: true } : {}),
  };
  await writeFlowshipActionJson(skillDir, meta);
  return defFromMeta(appActionIdFor(skill), skill, meta, {
    origin: "app-skill",
  });
};

/**
 * 更新自定义 action。
 * - team: 抛（定义在共享库）
 * - app: 改 skill 目录 json；skill 字段不可变
 * - 旧目录 id：旧格式不可编辑
 */
export const updateCustomAction = async (
  id: string,
  patch: Partial<CustomActionInput>,
): Promise<CustomActionDef> => {
  if (isTeamActionId(id)) {
    throw new Error("定义在共享库、修改请上传新版");
  }
  if (isAppActionId(id)) {
    const name = skillNameFromAppActionId(id);
    if (!name) throw new Error(`非法 app action id：${id}`);
    const existing = await getCustomAction(id);
    if (!existing) throw new Error(`custom action 不存在：${id}`);
    // skill 字段不可变：patch 带了不同 skill → 抛；同名 / 未传 → 忽略
    if (patch.skill !== undefined) {
      const nextSkill = sanitizeSkillName(patch.skill);
      if (nextSkill && nextSkill !== name) {
        throw new Error("挂载 skill 不可改（action 与 skill 一一对应）");
      }
    }
    const now = Date.now();
    // order：patch 显式传有限数字则覆盖；传 undefined 保留原值；其它（如 null）清掉
    const nextOrder =
      patch.order !== undefined
        ? typeof patch.order === "number" && Number.isFinite(patch.order)
          ? patch.order
          : undefined
        : existing.order;
    const meta: ExportedActionMeta = {
      label: (patch.label ?? existing.label).trim(),
      exportedAt: now,
      ...(patch.output !== undefined
        ? patch.output.trim()
          ? { output: patch.output.trim() }
          : {}
        : existing.output
          ? { output: existing.output }
          : {}),
      ...(patch.placeholder !== undefined
        ? patch.placeholder.trim()
          ? { placeholder: patch.placeholder.trim() }
          : {}
        : existing.placeholder
          ? { placeholder: existing.placeholder }
          : {}),
      ...(typeof nextOrder === "number" && Number.isFinite(nextOrder)
        ? { order: nextOrder }
        : {}),
      ...((patch.requiresKnowledge !== undefined
        ? patch.requiresKnowledge === true
        : existing.requiresKnowledge === true)
        ? { requiresKnowledge: true as const }
        : {}),
    };
    if (!meta.label) throw new Error("label 不能为空");
    await writeFlowshipActionJson(path.join(getAppSkillsDir(), name), meta);
    return defFromMeta(id, name, meta, { origin: "app-skill" });
  }
  // 旧目录 id：legacy 不可编辑；未迁残留也不再走 ACTION.md 写口
  const existing = await getCustomAction(id);
  if (!existing) throw new Error(`custom action 不存在：${id}`);
  if (existing.legacyPlaybook) {
    throw new Error(
      "旧格式 action 已停用、不能编辑——把原内容建成 skill 后重新新建挂载",
    );
  }
  throw new Error(
    "旧存储格式已废弃、请用 app:<skill> id 编辑（或删除后重建挂载）",
  );
};

/**
 * 删除自定义 action（API 兼容）：
 * - app: → 只删 .flowship-action.json（skill 目录保留）
 * - 旧 safe id → rm custom-actions 目录
 * - team: 抛（走卸载）
 */
export const removeCustomAction = async (id: string): Promise<void> => {
  if (isTeamActionId(id)) {
    throw new Error("共享库来源的 action 请走卸载（uninstall）、不能直接删除");
  }
  if (isAppActionId(id)) {
    const name = skillNameFromAppActionId(id);
    if (!name) throw new Error(`非法 app action id：${id}`);
    await removeActionShell(name);
    return;
  }
  await fs.rm(dirOf(id), { recursive: true, force: true });
  await fs.rm(legacyFileOf(id), { force: true });
};

/** 只删 skills/<name>/.flowship-action.json（挂载壳）；skill 名须合法 */
export const removeActionShell = async (skillName: string): Promise<void> => {
  const name = sanitizeSkillName(skillName);
  if (!name) throw new Error(`非法 skill 名：${skillName}`);
  await fs.rm(path.join(getAppSkillsDir(), name, FLOWSHIP_ACTION_JSON), {
    force: true,
  });
};

/** 删整棵自管 skill 目录（壳一并带走） */
export const removeAppSkillWithAction = async (
  skillName: string,
): Promise<void> => {
  const name = sanitizeSkillName(skillName);
  if (!name) throw new Error(`非法 skill 名：${skillName}`);
  const skillDir = path.join(getAppSkillsDir(), name);
  // 防穿越：必须落在 app skills 根内
  if (!isPathInside(getAppSkillsDir(), skillDir)) {
    throw new Error(`skill 路径越界：${skillName}`);
  }
  await fs.rm(skillDir, { recursive: true, force: true });
};

/**
 * 按 skill 写挂载壳（出厂预置用）。忽略入参 id 字符串作路径——
 * 实际写到 skills/<input.skill>/.flowship-action.json；已有 json → "exists"。
 */
export const ensureCustomActionById = async (
  _id: string,
  input: CustomActionInput,
): Promise<"created" | "exists"> => {
  const label = input.label.trim();
  if (!label) throw new Error("label 不能为空");
  const skill = sanitizeSkillName(input.skill);
  if (!skill) {
    throw new Error(
      "skill 名非法或为空（只用字母 / 数字 / 中文 / _ - .，不以 . 开头）",
    );
  }
  const skillDir = path.join(getAppSkillsDir(), skill);
  if (!(await pathExists(skillDir))) {
    throw new Error(`skill「${skill}」不存在于自管目录、请先安装 skill`);
  }
  const jsonPath = path.join(skillDir, FLOWSHIP_ACTION_JSON);
  if (await pathExists(jsonPath)) return "exists";
  const now = Date.now();
  await writeFlowshipActionJson(skillDir, {
    label,
    exportedAt: now,
    ...(input.output?.trim() ? { output: input.output.trim() } : {}),
    ...(input.placeholder?.trim()
      ? { placeholder: input.placeholder.trim() }
      : {}),
    ...(typeof input.order === "number" && Number.isFinite(input.order)
      ? { order: input.order }
      : {}),
    ...(input.requiresKnowledge === true ? { requiresKnowledge: true } : {}),
  });
  return "created";
};

// ----------------- 导出 / 导入 -----------------

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
 * 并写/覆盖 .flowship-action.json（含 requiresKnowledge）。
 */
export const exportCustomAction = async (
  id: string,
  targetDir: string,
): Promise<{ skillDir: string; skillName: string }> => {
  const absTarget = await assertExistingAbsDir(targetDir, "targetDir");
  const def = await getCustomAction(id);
  if (!def) throw new Error(`custom action 不存在：${id}`);
  if (def.legacyPlaybook) {
    throw new Error(
      "旧格式 action 已停用、无法导出——把原内容建成 skill 后重新新建挂载",
    );
  }

  const skillName = sanitizeSkillName(def.skill);
  if (!skillName) {
    throw new Error(`主 skill 名非法「${def.skill}」、拒绝导出`);
  }
  const skillEntry = await findSkillByName(skillName);
  if (!skillEntry) {
    throw new Error(
      `主 skill「${skillName}」本机找不到、无法导出（先确认 skill 已安装）`,
    );
  }
  const srcSkillDir = path.dirname(skillEntry.absPath);
  const destSkillDir = path.join(absTarget, skillName);
  if (!isPathInside(absTarget, destSkillDir)) {
    console.warn(
      `[custom-action-fs] 导出跳过：dest 越出 targetDir（skill=${skillName}）`,
    );
    throw new Error(`导出路径越界、拒绝写出：${skillName}`);
  }

  await fs.cp(srcSkillDir, destSkillDir, { recursive: true, force: true });

  const meta: ExportedActionMeta = {
    label: def.label,
    ...(def.output ? { output: def.output } : {}),
    ...(def.placeholder ? { placeholder: def.placeholder } : {}),
    ...(typeof def.order === "number" && Number.isFinite(def.order)
      ? { order: def.order }
      : {}),
    ...(def.requiresKnowledge === true ? { requiresKnowledge: true } : {}),
    exportedAt: Date.now(),
  };
  await writeFlowshipActionJson(destSkillDir, meta);
  return { skillDir: destSkillDir, skillName };
};

/**
 * 从本机文件夹导入：须含 SKILL.md → 拷进自管 skills（同名不覆盖）。
 * 若带 .flowship-action.json → **保留**为事实源、派生 app action（不再删 json 再 create）。
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

  const skillName = sanitizeSkillName(path.basename(absSource));
  if (!skillName) {
    throw new Error(
      `skill 目录名非法「${path.basename(absSource)}」（只用字母 / 数字 / 中文 / _ - .，不以 . 开头）`,
    );
  }

  let parsed;
  try {
    parsed = await parseSkillFile(skillMd);
  } catch {
    throw new Error("SKILL.md 缺 description / 格式不合法");
  }
  if (!parsed) {
    throw new Error("SKILL.md 缺 description / 格式不合法");
  }
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
  const nSym = await stripSymlinksUnder(destSkillDir);
  if (nSym > 0) {
    console.warn(
      `[custom-action-fs] 导入已删除 ${nSym} 个 symlink：${skillName}`,
    );
  }

  // json 是事实源：保留在自管目录；解析失败 → action=null + actionError，skill 仍留下
  const importedMetaPath = path.join(destSkillDir, FLOWSHIP_ACTION_JSON);
  let action: CustomActionDef | null = null;
  let actionError: string | undefined;
  if (await pathExists(importedMetaPath)) {
    try {
      const meta = parseFlowshipActionMeta(
        await fs.readFile(importedMetaPath, "utf-8"),
      );
      if (!meta) {
        throw new Error(".flowship-action.json 无效（缺 label）");
      }
      action = await getCustomAction(appActionIdFor(skillName));
      if (!action) {
        throw new Error("挂载壳写入后读回失败");
      }
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[custom-action-fs] 导入 skill 成功但挂壳解析失败：${skillName}`,
        err,
      );
    }
  }

  return { skillName, skillDir: destSkillDir, action, actionError };
};

// ---------- 迁移：旧 custom-actions → skill 托管 json ----------

/**
 * 纯函数：把 layout 里的旧 id 按 idMap 重映射；
 * 若 old 与 new 同时存在 → 只留一个（保留首次出现、去重）。
 */
export const remapActionLayoutIds = (
  layout: { order: string[]; hidden: string[] },
  idMap: Record<string, string>,
): { order: string[]; hidden: string[] } => {
  const remapList = (ids: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
      const next = idMap[id] ?? id;
      if (seen.has(next)) continue;
      seen.add(next);
      out.push(next);
    }
    return out;
  };
  return {
    order: remapList(layout.order),
    hidden: remapList(layout.hidden),
  };
};

/** 出厂预置旧 id → 新派生 id（记账 key 仍用 builtin-fix-bug，布局里要改） */
const BUILTIN_FIX_BUG_OLD_ID = "builtin-fix-bug";
const BUILTIN_FIX_BUG_NEW_ID = appActionIdFor("fix-bug");

type MigrateGlobal = {
  promise?: Promise<{ idMap: Record<string, string> }>;
};

const MIGRATE_KEY = "__flowshipMigrateCustomActionsToSkillHostedV1__";

/**
 * 幂等：把 custom-actions/ 里非 legacy 定义迁到 skills/<skill>/.flowship-action.json，
 * 并 remap config.json 的 actionLayout。single-flight via globalThis。
 */
export const migrateCustomActionsToSkillHosted = async (): Promise<{
  idMap: Record<string, string>;
}> => {
  const g = globalThis as unknown as Record<string, MigrateGlobal | undefined>;
  if (!g[MIGRATE_KEY]) g[MIGRATE_KEY] = {};
  const slot = g[MIGRATE_KEY]!;
  if (slot.promise) return slot.promise;

  // single-flight：并发共用同一 promise；结束后清掉以便下次幂等重扫（测试 / 热路径文件少）
  slot.promise = (async () => {
    const idMap: Record<string, string> = {
      // 固定映射：即便磁盘上没有旧目录也 remap 布局里残留的旧 id
      [BUILTIN_FIX_BUG_OLD_ID]: BUILTIN_FIX_BUG_NEW_ID,
    };

    const dir = customActionsDir();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // 目录不存在：仍可能要 remap 布局里的 builtin-fix-bug
      await remapLayoutInSettings(idMap);
      return { idMap };
    }

    // 先把平铺 md 目录化（迁移扫描只看目录版）
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
      const id = ent.name.slice(0, -3);
      if (!isSafeId(id)) continue;
      try {
        const raw = await fs.readFile(path.join(dir, ent.name), "utf-8");
        await migrateLegacyFile(id, raw);
      } catch (err) {
        console.warn(
          `[custom-action-fs] 平铺目录化失败：${ent.name}`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // 重新读目录（平铺可能已变目录）
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      await remapLayoutInSettings(idMap);
      return { idMap };
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      if (!isSafeId(id)) continue;
      let def: CustomActionDef | null = null;
      try {
        const raw = await fs.readFile(fileOf(id), "utf-8");
        def = parseDef(id, raw);
      } catch {
        continue;
      }
      if (!def || def.legacyPlaybook) continue; // legacy 保留
      const skill = sanitizeSkillName(def.skill);
      if (!skill) continue;

      const newId = appActionIdFor(skill);
      idMap[id] = newId;

      const skillDir = path.join(getAppSkillsDir(), skill);
      if (!(await pathExists(skillDir))) {
        console.warn(
          `[custom-action-fs] 迁移跳过：skill「${skill}」目录不存在（保留 ACTION.md：${id}）`,
        );
        continue;
      }

      const jsonPath = path.join(skillDir, FLOWSHIP_ACTION_JSON);
      if (await pathExists(jsonPath)) {
        // 已有 json = 事实源、不覆盖；只清旧 ACTION.md 目录
        await fs.rm(dirOf(id), { recursive: true, force: true });
        console.log(
          `[custom-action-fs] 迁移：${id} → ${newId}（skill 已有 json、仅删旧目录）`,
        );
        continue;
      }

      const exportedAt = def.updatedAt || def.createdAt || Date.now();
      await writeFlowshipActionJson(skillDir, {
        label: def.label,
        exportedAt,
        ...(def.output ? { output: def.output } : {}),
        ...(def.placeholder ? { placeholder: def.placeholder } : {}),
        ...(def.requiresKnowledge === true ? { requiresKnowledge: true } : {}),
      });
      await fs.rm(dirOf(id), { recursive: true, force: true });
      console.log(`[custom-action-fs] 迁移：${id} → ${newId}`);
    }

    await remapLayoutInSettings(idMap);
    return { idMap };
  })().finally(() => {
    const slot2 = g[MIGRATE_KEY];
    if (slot2) delete slot2.promise;
  });

  return slot.promise;
};

/** 读改写 config.json 的 actionLayout（直接 writePrivateFileAtomic、避免嵌套死锁） */
const remapLayoutInSettings = async (
  idMap: Record<string, string>,
): Promise<void> => {
  const result = await readSettingsFile();
  if (result.status !== "ok") return;
  const settings = result.settings;
  const rawLayout = settings.actionLayout;
  if (!rawLayout || typeof rawLayout !== "object" || Array.isArray(rawLayout)) {
    return;
  }
  const o = rawLayout as { order?: unknown; hidden?: unknown };
  const toStrArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const before = { order: toStrArr(o.order), hidden: toStrArr(o.hidden) };
  if (before.order.length === 0 && before.hidden.length === 0) return;

  const after = remapActionLayoutIds(before, idMap);
  const same =
    after.order.length === before.order.length &&
    after.hidden.length === before.hidden.length &&
    after.order.every((v, i) => v === before.order[i]) &&
    after.hidden.every((v, i) => v === before.hidden[i]);
  if (same) return;

  await writePrivateFileAtomic(
    path.join(dataRoot(), "config.json"),
    JSON.stringify({ ...settings, actionLayout: after }, null, 2),
  );
  console.log(`[custom-action-fs] 已 remap actionLayout id`);
};
