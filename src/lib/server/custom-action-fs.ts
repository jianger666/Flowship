/**
 * 自定义 action 定义的文件存储（V0.9）
 *
 * 存 `dataRoot()/custom-actions/<id>.md`：
 *   - frontmatter（YAML）：label / summary / skills / freshAgent / placeholder / createdAt / updatedAt
 *   - 正文：playbook（这个 action 让 agent 干什么 / 怎么干 / 产出什么）
 *
 * 为什么用 md 文件、不用 JSON / DB：
 *   - 跟内置 `prompts/action-*.md` 同构、playbook 是大段 markdown、md 比 JSON 转义友好
 *   - 将来「个人 → 团队共享」只要把文件挪进业务仓 `.cursor/actions/` 就能 git 共享
 *   - 跟 tasks / config.json 一起在 userData 目录、更新 / 卸载不丢、test 实例天然隔离
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
const customActionsDir = (): string => path.join(dataRoot(), "custom-actions");

// id 安全校验：只允许 字母 / 数字 / _ / -（防路径穿越 + 非法文件名）
const isSafeId = (id: string): boolean => /^[A-Za-z0-9_-]+$/.test(id);

// id → 绝对文件路径（非法 id 直接抛、不让拼出越界路径）
const fileOf = (id: string): string => {
  if (!isSafeId(id)) throw new Error(`非法 custom action id：${id}`);
  return path.join(customActionsDir(), `${id}.md`);
};

// 生成唯一 id：custom_<时间戳36>_<随机6>
const genId = (): string =>
  `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

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
  await fs.mkdir(customActionsDir(), { recursive: true });
  await fs.writeFile(fileOf(def.id), serialize(def), "utf-8");
};

/** 列出所有自定义 action（按更新时间倒序、最近改的在前） */
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
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const id = ent.name.slice(0, -3);
    if (!isSafeId(id)) continue;
    try {
      const raw = await fs.readFile(path.join(dir, ent.name), "utf-8");
      const def = parseDef(id, raw);
      if (def) defs.push(def);
    } catch (err) {
      console.warn(
        `[custom-action-fs] 解析失败、跳过：${ent.name}`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return defs.sort((a, b) => b.updatedAt - a.updatedAt);
};

/** 读单个自定义 action（找不到 / 解析失败 → null） */
export const getCustomAction = async (
  id: string,
): Promise<CustomActionDef | null> => {
  if (!isSafeId(id)) return null;
  try {
    const raw = await fs.readFile(fileOf(id), "utf-8");
    return parseDef(id, raw);
  } catch {
    return null;
  }
};

/** 新建自定义 action（自动分配 id + 时间戳） */
export const createCustomAction = async (
  input: CustomActionInput,
): Promise<CustomActionDef> => {
  const now = Date.now();
  const def: CustomActionDef = {
    id: genId(),
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

/** 删除自定义 action（幂等、文件不存在不报错） */
export const removeCustomAction = async (id: string): Promise<void> => {
  await fs.rm(fileOf(id), { force: true });
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
 * 从文件夹批量导入：扫目录第一层的 md 文件逐个导入（不递归——导出是平铺写、导入对称扫一层）。
 * 用户拍板「批量就用文件夹的形式」：分享方导出得到一个文件夹、接收方选同一个文件夹即可、不用逐个挑文件。
 */
export const importCustomActionsFromDir = async (
  dir: string,
): Promise<ImportResult> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => path.join(dir, e.name));
  if (files.length === 0) {
    return {
      imported: [],
      failed: [{ path: dir, reason: "文件夹里没有 md 文件" }],
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
 * 批量导出到目录：每个 action 写一个 `<label>.md`（同存储格式、对方直接导入）。
 * 目录内重名自动加 -2 / -3 后缀、不覆盖已有文件。
 */
export const exportCustomActions = async (
  ids: string[],
  dir: string,
): Promise<ExportResult> => {
  const result: ExportResult = { exported: [], failed: [] };
  await fs.mkdir(dir, { recursive: true });
  // 本批次内 + 目录已有文件都参与去重
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
      let name = `${base}.md`;
      for (let i = 2; taken.has(name.toLowerCase()); i += 1) {
        name = `${base}-${i}.md`;
      }
      taken.add(name.toLowerCase());
      const target = path.join(dir, name);
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
