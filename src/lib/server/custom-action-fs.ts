/**
 * 自定义 action 定义的文件存储（V0.9）
 *
 * 存 `dataRoot()/custom-actions/<id>.md`：
 *   - frontmatter（YAML）：label / summary / skills / checkCommands / freshAgent / createdAt / updatedAt
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
import type {
  CheckCommand,
  CustomActionDef,
  CustomActionInput,
} from "@/lib/types";

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

// checkCommands 反序列化——只挑结构合法的、防脏数据进运行时（读文件 / route 入参共用）
export const sanitizeCheckCommands = (
  raw: unknown,
): CheckCommand[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const out: CheckCommand[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.name !== "string" || typeof c.cmd !== "string") continue;
    out.push({
      name: c.name,
      cmd: c.cmd,
      kind: (typeof c.kind === "string" ? c.kind : "custom") as CheckCommand["kind"],
      required: c.required === true,
      timeoutMs: typeof c.timeoutMs === "number" ? c.timeoutMs : undefined,
      source: c.source === "auto" ? "auto" : "manual",
    });
  }
  return out.length > 0 ? out : undefined;
};

// 解析单个 md 文件 → CustomActionDef（label 缺失视为非法、返 null）
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
    checkCommands: sanitizeCheckCommands(data.checkCommands),
    freshAgent: typeof data.freshAgent === "boolean" ? data.freshAgent : undefined,
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
    ...(def.checkCommands && def.checkCommands.length > 0
      ? { checkCommands: def.checkCommands }
      : {}),
    ...(typeof def.freshAgent === "boolean" ? { freshAgent: def.freshAgent } : {}),
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
    checkCommands: input.checkCommands,
    freshAgent: input.freshAgent,
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
