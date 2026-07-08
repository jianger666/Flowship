/**
 * 读 Cursor 全局配置（`~/.cursor/`）给 fe agent 用
 *
 * 背景（2026-06「跟 Cursor 共用工具」定案、详见 ROADMAP）：
 * - `settingSources:["project"]` 只加载目标 repo 的 `.cursor/`（project 层）、
 *   够不着全局 `~/.cursor/`（user 层、SDK 要 settingSources 含 `"user"` 才加载）。
 * - 但 `"user"` 是粗开关、一开会把全局 MCP 全量塞进 agent context（用户 20-30 个）、
 *   且没法 per-task 精简。所以全局配置改由 fe 后端自己读：可控、可 per-task 过滤。
 * - 职责分工：MCP server 本体在 Cursor 配（fe 只读、不改）；「哪个 task 用哪些」在 fe per-task 开关。
 *
 * 本文件集中「读 `~/.cursor/` 全局配置」：mcp.json + rules/。
 * 全局 skills 在 `skills-loader.ts` 读（复用它的 scanSkillsDir、避免循环依赖）。
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type { McpServerConfig } from "@cursor/sdk";

import { mergeMcpSources } from "../mcp-config";
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
 * - 文件不存在 / 解析失败 → 返 `{}`（不抛、不阻塞 agent 启动；MCP 是可选能力）
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

/** Cursor + fe 自管合并（fe 同名覆盖） */
export const readMergedMcpServers = async (): Promise<
  Record<string, McpServerConfig>
> =>
  mergeMcpSources(
    await readGlobalCursorMcpServers(),
    await readAppMcpServers(),
  );

/** agent 启动用：合并后再按 task 黑名单过滤 */
export const resolveTaskMcpServers = async (
  disabled: string[] | undefined,
): Promise<Record<string, McpServerConfig>> =>
  filterDisabledMcp(await readMergedMcpServers(), disabled);

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
