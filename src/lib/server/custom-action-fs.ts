/**
 * 自定义 action 定义的文件存储（V0.9 平铺 md → v1.1.x 目录化）
 *
 * v1.1.x 起对齐 skill 规范（用户拍板「action 就是 task 模式的 skill 接入口、
 * 目录形式分享 / AI 帮建都更方便」）：
 *   存 `dataRoot()/custom-actions/<id>/ACTION.md`（目录可带附属参考文件）：
 *   - frontmatter（YAML）：label / summary / skills / freshAgent / placeholder / createdAt / updatedAt
 *   - 正文：playbook（这个 action 让 agent 干什么 / 怎么干 / 产出什么）
 *   - id = 目录名（新建时按 label slug 化、AI 帮建直接给 kebab-case 名）
 *
 * 老布局（平铺 `<id>.md`）读到即自动迁移成目录形式、id 不变——
 * actionLayout / 任务历史里对旧 id 的引用全部不受影响。
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
import type { CustomActionDef, CustomActionInput } from "@/lib/types";

// 对外 re-export、让 route 等调用方能从 fs 层一并拿到入参类型
export type { CustomActionInput };

// 自定义 action 目录（懒算、跟 dataRoot 一致、支持 test 实例隔离）
// export：「AI 帮建」入口要拿它当对话 cwd
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

// 生成唯一 id：优先 label slug 化（人类可读、分享 / AI 排查友好）、
// 中文等非 ASCII 全丢时回退随机 id
const genId = async (label: string): Promise<string> => {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const fallback = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  if (!slug) return fallback;
  // 撞名（同 slug 已存在、含旧平铺文件）→ 探 -2 / -3 …
  for (let i = 0; i < 20; i += 1) {
    const candidate = i === 0 ? slug : `${slug}-${i + 1}`;
    const exists =
      (await pathExists(dirOf(candidate))) ||
      (await pathExists(legacyFileOf(candidate)));
    if (!exists) return candidate;
  }
  return fallback;
};

const pathExists = async (p: string): Promise<boolean> =>
  !!(await fs.stat(p).catch(() => null));

/** 清洗 skills（字符串数组、trim、去空）——读文件 / route 入参共用 */
export const sanitizeSkills = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
  return out.length > 0 ? out : undefined;
};

// 解析单个 md 文件 → CustomActionDef（label 缺失视为非法、返 null）
// 注：老文件 frontmatter 里可能残留 checkCommands 字段（v0.9.13 删）、直接忽略、下次写回时自然清掉。
const parseDef = (id: string, raw: string): CustomActionDef | null => {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const label = typeof data.label === "string" ? data.label.trim() : "";
  if (!label) return null;
  return {
    id,
    label,
    summary:
      typeof data.summary === "string" && data.summary.trim()
        ? data.summary.trim()
        : undefined,
    playbook: parsed.content.trim(),
    skills: sanitizeSkills(data.skills),
    freshAgent: typeof data.freshAgent === "boolean" ? data.freshAgent : undefined,
    placeholder:
      typeof data.placeholder === "string" && data.placeholder.trim()
        ? data.placeholder.trim()
        : undefined,
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
  };
};

// CustomActionDef → md 文件内容（frontmatter 只放元信息、playbook 当正文）
const serialize = (def: CustomActionDef): string => {
  const fm: Record<string, unknown> = {
    label: def.label,
    ...(def.summary ? { summary: def.summary } : {}),
    ...(def.skills && def.skills.length > 0 ? { skills: def.skills } : {}),
    ...(typeof def.freshAgent === "boolean" ? { freshAgent: def.freshAgent } : {}),
    ...(def.placeholder ? { placeholder: def.placeholder } : {}),
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
  };
  // 正文前后留空行、读起来跟内置 prompt 一致
  const body = def.playbook.trim();
  return matter.stringify(body ? `\n${body}\n` : "\n", fm);
};

const writeDef = async (def: CustomActionDef): Promise<void> => {
  await fs.mkdir(dirOf(def.id), { recursive: true });
  await fs.writeFile(fileOf(def.id), serialize(def), "utf-8");
};

// 老平铺文件 → 目录布局的一次性搬迁（读到旧文件时调、幂等）：
// `<id>.md` → `<id>/ACTION.md`、内容原样、id 不变（引用它的 actionLayout / 任务历史都不受影响）
const migrateLegacyFile = async (id: string, raw: string): Promise<void> => {
  try {
    await fs.mkdir(dirOf(id), { recursive: true });
    await fs.writeFile(fileOf(id), raw, "utf-8");
    await fs.rm(legacyFileOf(id), { force: true });
    console.log(`[custom-action-fs] 已迁移到目录布局：${id}`);
  } catch (err) {
    // 迁移失败不影响读取（下次再试）
    console.warn(`[custom-action-fs] 目录化迁移失败（下次重试）：${id}`, err);
  }
};

/** 列出所有自定义 action（按更新时间倒序、最近改的在前）；读到旧平铺文件顺手迁移 */
export const listCustomActions = async (): Promise<CustomActionDef[]> => {
  const dir = customActionsDir();
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // 目录不存在 = 还没建过任何自定义 action、返空
    return [];
  }
  const defs: CustomActionDef[] = [];
  for (const ent of entries) {
    // 新布局：<id>/ACTION.md
    if (ent.isDirectory()) {
      const id = ent.name;
      if (!isSafeId(id)) continue;
      try {
        const raw = await fs.readFile(path.join(dir, id, "ACTION.md"), "utf-8");
        const def = parseDef(id, raw);
        if (def) defs.push(def);
      } catch {
        // 没有 ACTION.md 的目录（半截 / 无关）跳过
      }
      continue;
    }
    // 旧布局：<id>.md → 读出来 + 顺手迁移成目录
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const id = ent.name.slice(0, -3);
    if (!isSafeId(id)) continue;
    try {
      const raw = await fs.readFile(path.join(dir, ent.name), "utf-8");
      const def = parseDef(id, raw);
      if (def) {
        defs.push(def);
        await migrateLegacyFile(id, raw);
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

/** 读单个自定义 action（找不到 / 解析失败 → null）；兼容旧平铺文件（读到即迁移） */
export const getCustomAction = async (
  id: string,
): Promise<CustomActionDef | null> => {
  if (!isSafeId(id)) return null;
  try {
    const raw = await fs.readFile(fileOf(id), "utf-8");
    return parseDef(id, raw);
  } catch {
    // 新布局没有 → 试旧平铺文件（读到顺手迁移）
    try {
      const raw = await fs.readFile(legacyFileOf(id), "utf-8");
      const def = parseDef(id, raw);
      if (def) await migrateLegacyFile(id, raw);
      return def;
    } catch {
      return null;
    }
  }
};

/** 新建自定义 action（自动分配 id + 时间戳） */
export const createCustomAction = async (
  input: CustomActionInput,
): Promise<CustomActionDef> => {
  const now = Date.now();
  const def: CustomActionDef = {
    id: await genId(input.label.trim()),
    label: input.label.trim(),
    summary: input.summary?.trim() || undefined,
    playbook: input.playbook,
    skills: input.skills,
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
  const next: CustomActionDef = {
    ...existing,
    ...patch,
    label: (patch.label ?? existing.label).trim(),
    summary:
      patch.summary !== undefined
        ? patch.summary.trim() || undefined
        : existing.summary,
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

/** 删除自定义 action（幂等、不存在不报错；新目录 + 旧平铺文件都清） */
export const removeCustomAction = async (id: string): Promise<void> => {
  await fs.rm(dirOf(id), { recursive: true, force: true });
  await fs.rm(legacyFileOf(id), { force: true });
};

// ----------------- 导入 / 导出（团队点对点分享、飞书传 md 文件即可）-----------------

// 单文件导入上限：防误选大文件（正常 playbook 几 KB、1MB 已远超合理范围）
const IMPORT_MAX_BYTES = 1024 * 1024;

// label → 安全文件名（去路径分隔 / 非法字符、空了兜底 action）
const safeFileName = (label: string): string => {
  const cleaned = label
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, "")
    .trim()
    .slice(0, 80);
  return cleaned || "action";
};

export interface ImportResult {
  imported: CustomActionDef[];
  failed: { path: string; reason: string }[];
}

/**
 * 从文件夹批量导入（用户拍板「批量就用文件夹」）：
 * - v1.1.x 目录布局：扫第一层子目录里的 ACTION.md（导出 / 团队仓的标准形态）
 * - 兼容旧分享包：第一层平铺的 *.md 也收
 * 选中的目录本身就是一个 action 目录（含 ACTION.md）也认。
 */
export const importCustomActionsFromDir = async (
  dir: string,
): Promise<ImportResult> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  // 选的目录本身就是单个 action 目录
  if (entries.some((e) => e.isFile() && e.name === "ACTION.md")) {
    files.push(path.join(dir, "ACTION.md"));
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const inner = path.join(dir, e.name, "ACTION.md");
      if (await pathExists(inner)) files.push(inner);
      continue;
    }
    if (e.isFile() && e.name.toLowerCase().endsWith(".md") && e.name !== "ACTION.md") {
      files.push(path.join(dir, e.name));
    }
  }
  if (files.length === 0) {
    return {
      imported: [],
      failed: [{ path: dir, reason: "文件夹里没有 ACTION.md 目录或 md 文件" }],
    };
  }
  return importCustomActionFiles(files);
};

/**
 * 逐文件导入（每个文件 = 一个 action 定义、同 serialize 格式）。
 * id 一律重新生成（防跟本机已有的撞）、时间戳取当下；label 重名不拦（用户自己删旧的）。
 * 单文件失败不影响其余（收集进 failed、调用方 toast 汇总）。
 */
const importCustomActionFiles = async (
  paths: string[],
): Promise<ImportResult> => {
  const result: ImportResult = { imported: [], failed: [] };
  for (const p of paths) {
    try {
      if (!p.toLowerCase().endsWith(".md")) {
        result.failed.push({ path: p, reason: "不是 md 文件" });
        continue;
      }
      const stat = await fs.stat(p);
      if (stat.size > IMPORT_MAX_BYTES) {
        result.failed.push({ path: p, reason: "文件超过 1MB" });
        continue;
      }
      const raw = await fs.readFile(p, "utf-8");
      // 借 parseDef 做解析 + 字段清洗（id 只是占位、下面重新生成）
      const parsed = parseDef("import_tmp", raw);
      if (!parsed) {
        result.failed.push({ path: p, reason: "frontmatter 缺 label、不是有效的 action 定义" });
        continue;
      }
      const def = await createCustomAction({
        label: parsed.label,
        summary: parsed.summary,
        playbook: parsed.playbook,
        skills: parsed.skills,
        freshAgent: parsed.freshAgent,
        placeholder: parsed.placeholder,
      });
      result.imported.push(def);
    } catch (err) {
      result.failed.push({
        path: p,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
};

export interface ExportResult {
  exported: { id: string; file: string }[];
  failed: { id: string; reason: string }[];
}

/**
 * 批量导出到目录（v1.1.x 目录布局）：每个 action 写 `<label>/ACTION.md`
 * （跟存储 / 团队分享形态一致、对方选这个文件夹即可导入）。
 * 目录内重名自动加 -2 / -3 后缀、不覆盖已有目录。
 */
export const exportCustomActions = async (
  ids: string[],
  dir: string,
): Promise<ExportResult> => {
  const result: ExportResult = { exported: [], failed: [] };
  await fs.mkdir(dir, { recursive: true });
  // 本批次内 + 目录已有条目都参与去重
  const taken = new Set(
    (await fs.readdir(dir).catch(() => [] as string[])).map((n) =>
      n.toLowerCase(),
    ),
  );
  for (const id of ids) {
    try {
      const def = await getCustomAction(id);
      if (!def) {
        result.failed.push({ id, reason: "定义不存在" });
        continue;
      }
      const base = safeFileName(def.label);
      let name = base;
      for (let i = 2; taken.has(name.toLowerCase()); i += 1) {
        name = `${base}-${i}`;
      }
      taken.add(name.toLowerCase());
      const targetDir = path.join(dir, name);
      await fs.mkdir(targetDir, { recursive: true });
      const target = path.join(targetDir, "ACTION.md");
      await fs.writeFile(target, serialize(def), "utf-8");
      result.exported.push({ id, file: target });
    } catch (err) {
      result.failed.push({
        id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
};
