/**
 * MCP 配置源 + Cursor 全局配置读取
 *
 * V0.13「MCP 独立化」（用户拍板：为后续接 Codex / Claude Code 等多 backend 留口子）：
 * - agent 运行时 **只读 fe 自管配置**（config.json → settings.mcpServers）、
 *   不再 live 合并 `~/.cursor/mcp.json`——在 Cursor 里改配置不再影响本 app。
 * - Cursor mcp.json 仅作**导入源**：设置页「从 Cursor 导入」拷贝成自管条目、之后互不影响。
 * - 老用户无感迁移：升级后首次 boot 把 Cursor mcp.json 一次性快照进自管（见
 *   migrateCursorMcpOnce）；全新安装不自动迁、用户在设置页自己导入。
 *
 * 历史（V0.6.2「跟 Cursor 共用工具」、已废弃）：曾经每次起 agent 实时合并 Cursor 配置、
 * `settingSources:["project"]` 只加载 repo 层所以全局配置由 fe 自己读。
 *
 * 本文件还保留「读 `~/.cursor/` 全局 rules」（prompt 注入用、与 MCP 独立化无关）。
 * 全局 skills 在 `skills-loader.ts` 读（复用它的 scanSkillsDir、避免循环依赖）。
 */

import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type { McpServerConfig } from "@cursor/sdk";

import { mergeMcpSources, RESERVED_MCP_NAMES } from "../mcp-config";
import { dataRoot } from "./data-root";

/**
 * 全局 Cursor 配置目录候选（按优先级、取第一个能命中的）
 * - mac/linux/win 官方都是 home 下的 `.cursor/`（`os.homedir()` 自适配跨平台）
 * - win 旧版个别落在 `%APPDATA%/Cursor/`、加 fallback 兜底（官方文档以 home 为准）
 */
export const getGlobalCursorDirs = (): string[] => {
  const dirs: string[] = [];
  const home = os.homedir();
  if (home) dirs.push(path.join(home, ".cursor"));
  if (process.platform === "win32" && process.env.APPDATA) {
    dirs.push(path.join(process.env.APPDATA, "Cursor"));
  }
  return dirs;
};

/**
 * 读全局 `~/.cursor/mcp.json` → `{ name: McpServerConfig }`
 * - V0.13 起仅作**导入源**（设置页导入 dialog + 老用户一次性迁移）、运行时不再读它
 * - 文件不存在 / 解析失败 → 返 `{}`（不抛；MCP 是可选能力）
 * - 多候选目录取第一个能读到的
 */
export const readGlobalCursorMcpServers = async (): Promise<
  Record<string, McpServerConfig>
> => {
  for (const dir of getGlobalCursorDirs()) {
    const file = path.join(dir, "mcp.json");
    try {
      const raw = await fs.readFile(file, "utf-8");
      const parsed = JSON.parse(raw) as { mcpServers?: unknown };
      const servers = parsed?.mcpServers;
      if (servers && typeof servers === "object" && !Array.isArray(servers)) {
        return servers as Record<string, McpServerConfig>;
      }
    } catch {
      // 文件不存在 / JSON 坏 → 试下一个候选目录
    }
  }
  return {};
};

/** 读 fe 自管 MCP（data/config.json → settings.mcpServers） */
export const readAppMcpServers = async (): Promise<
  Record<string, McpServerConfig>
> => {
  try {
    const raw = await fs.readFile(path.join(dataRoot(), "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers?: unknown };
    const servers = parsed?.mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      return servers as Record<string, McpServerConfig>;
    }
  } catch {
    // 文件不存在 / 坏 JSON → 当空
  }
  return {};
};

/**
 * 运行时有效 MCP 集（V0.13 = fe 自管、不再合并 Cursor）
 * RESERVED 名（aiFlowChat）剔除——runtime 强制注入、不允许用户条目顶掉
 */
export const readEffectiveMcpServers = async (): Promise<
  Record<string, McpServerConfig>
> => {
  const app = await readAppMcpServers();
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(app)) {
    if (!RESERVED_MCP_NAMES.has(name)) out[name] = cfg;
  }
  return out;
};

/** agent 启动用：有效集再按 task 黑名单过滤 */
export const resolveTaskMcpServers = async (
  disabled: string[] | undefined,
): Promise<Record<string, McpServerConfig>> =>
  filterDisabledMcp(await readEffectiveMcpServers(), disabled);

/**
 * 老用户无感迁移（V0.13、boot 时跑一次）：把 Cursor mcp.json 快照进自管配置。
 *
 * 判定「老 / 新」用 config.json 是否存在：
 * - 存在（升级上来的老用户、此前依赖 live 合并 Cursor）→ Cursor servers 合入
 *   settings.mcpServers（自管同名优先）、行为零变化
 * - 不存在（全新安装）→ 只落标记、不自动迁——新用户在设置页自己挑着导入
 *
 * 标记文件 `data/.mcp-cursor-migrated` 保证只跑一次；config.json 解析失败时
 * 不写标记（下次 boot 重试）。boot 时 client 还没加载、无与 /api/settings 写并发。
 */
export const migrateCursorMcpOnce = async (): Promise<void> => {
  const marker = path.join(dataRoot(), ".mcp-cursor-migrated");
  if (existsSync(marker)) return;
  const configFile = path.join(dataRoot(), "config.json");
  let raw: string | null = null;
  try {
    raw = await fs.readFile(configFile, "utf-8");
  } catch {
    raw = null;
  }
  if (raw === null) {
    // 全新安装：没有历史行为要保、落标记即可
    await fs.mkdir(dataRoot(), { recursive: true }).catch(() => {});
    await fs.writeFile(marker, new Date().toISOString()).catch(() => {});
    return;
  }
  try {
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const app =
      cfg.mcpServers && typeof cfg.mcpServers === "object" && !Array.isArray(cfg.mcpServers)
        ? (cfg.mcpServers as Record<string, McpServerConfig>)
        : {};
    const cursor = await readGlobalCursorMcpServers();
    const merged = mergeMcpSources(cursor, app);
    const addedCount = Object.keys(merged).length - Object.keys(app).length;
    cfg.mcpServers = merged;
    await fs.writeFile(configFile, JSON.stringify(cfg, null, 2), "utf-8");
    await fs.writeFile(marker, new Date().toISOString(), "utf-8");
    console.log(
      `[cursor-config] MCP 独立化迁移完成：从 Cursor 快照 ${addedCount} 个 server 进自管配置（共 ${Object.keys(merged).length} 个）`,
    );
  } catch (err) {
    // config.json 坏 / 写失败：不落标记、下次 boot 重试
    console.warn("[cursor-config] MCP 迁移失败（下次启动重试）：", err);
  }
};

/**
 * 按 task 黑名单过滤 MCP（server 端用、对应 `task.disabledMcpServers`）
 * - disabled 空 → 原样返回
 * - 否则删掉这些 key（per-task 精简：本任务不挂的 MCP 不进 agent）
 */
export const filterDisabledMcp = (
  servers: Record<string, McpServerConfig>,
  disabled: string[] | undefined,
): Record<string, McpServerConfig> => {
  if (!disabled || disabled.length === 0) return servers;
  const set = new Set(disabled);
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (!set.has(name)) out[name] = cfg;
  }
  return out;
};

/**
 * 读全局 `~/.cursor/rules/*.mdc` → 拼成 prompt 段
 *
 * - `alwaysApply:true` → 全文注入（用户要求「总遵守」的通用偏好、如 mac-use）
 * - 其余（globs / description 触发）→ 列 index（desc + 绝对路径）、agent 命中场景再 `read`
 * - 无 rules → 返空提示串
 *
 * 注：repo 级 rules 靠 `settingSources:["project"]` 加载、不在此读（避免同一份进两次）。
 */
export const readGlobalCursorRulesForPrompt = async (): Promise<string> => {
  const NONE = "（无全局规则）";

  // 找第一个存在的 rules 目录
  let rulesDir: string | null = null;
  for (const dir of getGlobalCursorDirs()) {
    const candidate = path.join(dir, "rules");
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        rulesDir = candidate;
        break;
      }
    } catch {
      // 试下一个候选
    }
  }
  if (!rulesDir) return NONE;

  let files: string[];
  try {
    const entries = await fs.readdir(rulesDir, { withFileTypes: true });
    files = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".mdc"))
      .map((e) => path.join(rulesDir as string, e.name))
      .sort();
  } catch {
    return NONE;
  }
  if (files.length === 0) return NONE;

  const always: string[] = []; // alwaysApply 全文
  const indexed: string[] = []; // 按需 read 的 index
  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf-8");
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;
      const desc =
        typeof data.description === "string" ? data.description.trim() : "";
      const body = parsed.content.trim();
      if (data.alwaysApply === true) {
        always.push(body);
      } else {
        indexed.push(`- ${desc || path.basename(file)}（按需读 \`${file}\`）`);
      }
    } catch {
      // 单文件解析失败、跳过、不让整段炸
    }
  }

  const sections: string[] = [];
  if (always.length > 0) sections.push(always.join("\n\n"));
  if (indexed.length > 0) {
    sections.push(
      `以下全局规则按需用 \`read\` 工具读全文：\n${indexed.join("\n")}`,
    );
  }
  return sections.length > 0 ? sections.join("\n\n") : NONE;
};
