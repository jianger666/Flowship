/**
 * MCP 配置源 + Cursor 全局配置读取
 *
 * V0.13「MCP 独立化」（用户拍板：为后续接 Codex / Claude Code 等多 backend 留口子）：
 * - agent 运行时 **只读 fe 自管配置**（config.json → settings.mcpServers）、
 *   不再 live 合并 `~/.cursor/mcp.json`——在 Cursor 里改配置不再影响本 app。
 * - Cursor mcp.json 仅作**导入源**：能力页「从 Cursor 导入」由用户手动勾选拷贝、之后互不影响。
 *   ⛔ 不自动搬——新用户首次落盘 config.json 也不会静默快照 Cursor 全局 MCP。
 *
 * 历史（V0.6.2「跟 Cursor 共用工具」、已废弃）：曾经每次起 agent 实时合并 Cursor 配置、
 * 也曾用 `settingSources:["project"]` 让 SDK 加载 repo `.cursor/`——已改为 `[]`、
 * 全部 fe 自管注入（本文件 + skills-loader + inline mcpServers）。
 * V0.13 曾有 `migrateCursorMcpOnce` 老用户一次性快照——已删（老用户迁完、新用户不自动搬）。
 *
 * 本文件还管 app 自管 rules 的 prompt 注入（readAppRulesForPrompt、只读
 * `<dataRoot>/rules`——`~/.cursor/rules` 已不再注入、用户拍板彻底脱离 Cursor 安装配置）。
 * 全局 skills 在 `skills-loader.ts` 读（复用它的 scanSkillsDir、避免循环依赖）。
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type { McpServerConfig } from "@cursor/sdk";

import { RESERVED_MCP_NAMES } from "../mcp-config";
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
 * - V0.13 起仅作**导入源**（能力页「从 Cursor 导入」dialog）、运行时不再读它
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
 * RESERVED 名（aiFlowChat）剔除——runtime 强制注入、不允许用户条目顶掉。
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

/** app 自管 rules 目录（v1.1.x Rules 独立化、能力页 Rules tab 管理） */
export const getAppRulesDir = (): string => path.join(dataRoot(), "rules");

/** 用户禁用的 rule 名单（settings.disabledRules、按文件名不含 .mdc） */
const readDisabledRules = async (): Promise<Set<string>> => {
  try {
    const raw = await fs.readFile(path.join(dataRoot(), "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as { disabledRules?: unknown };
    const arr = parsed?.disabledRules;
    return new Set(
      Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [],
    );
  } catch {
    return new Set();
  }
};

/**
 * 读 app 自管 rules（`<dataRoot>/rules/*.mdc`）→ 拼成 prompt 段
 *
 * - 所有启用中的规则**全文常驻注入**（规则间空行分隔）——「按需 index」档位已删
 * - 老文件带 frontmatter 的只取正文（gray-matter body）、frontmatter 不进 prompt
 * - settings.disabledRules 名单里的跳过
 * - 无规则 → 返占位提示串
 *
 * 注：repo 级 / 全局 `~/.cursor/rules` 都不读（`settingSources:[]` + 脱离 Cursor 安装配置；
 * 要用的规则在能力页自建、全部 fe 自管注入）。
 */
export const readAppRulesForPrompt = async (): Promise<string> => {
  const NONE = "（未配置规则）";
  const disabled = await readDisabledRules();
  let files: string[];
  try {
    const entries = await fs.readdir(getAppRulesDir(), { withFileTypes: true });
    files = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".mdc"))
      .map((e) => path.join(getAppRulesDir(), e.name))
      .sort();
  } catch {
    return NONE;
  }
  const bodies: string[] = [];
  for (const file of files) {
    if (disabled.has(path.basename(file, path.extname(file)))) continue;
    try {
      const parsed = matter(await fs.readFile(file, "utf-8"));
      // 老文件可能「只有 frontmatter description、正文为空」——退到 description、
      // 别把启用中的规则静默漏掉（Bugbot 揪出：UI 显示启用、prompt 里却没有）
      const body = parsed.content.trim();
      const desc =
        typeof parsed.data.description === "string"
          ? parsed.data.description.trim()
          : "";
      const effective = body || desc;
      if (effective) bodies.push(effective);
    } catch {
      // 单文件解析失败、跳过、不让整段炸
    }
  }
  return bodies.length > 0 ? bodies.join("\n\n") : NONE;
};
