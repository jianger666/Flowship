/**
 * 服务端 settings（data/config.json）读取 + 脱敏 helper（CR-01 抽出）
 *
 * 动机：
 * - `/api/settings` GET 原来把整份 config.json（含 Cursor API Key / GitLab Token）
 *   原样返回——默认口径改脱敏、全量读取收敛到专门的 `/api/settings/full`。
 * - `/api/preview` 原来信客户端传的 shell command——改为服务端按 repoPath 从
 *   权威 config.json 查 previewCommand、客户端只能选「预览哪个仓」、不能注入命令。
 *
 * 读 config.json 的其它模块（cursor-config / task-runner…）各有自己的窄读取、
 * 这里只收「settings 路由 + preview 命令」这两处新需求、不做大一统重构。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot } from "./data-root";

export const settingsFilePath = (): string => path.join(dataRoot(), "config.json");

/** 读整份 config.json（不存在 / 坏 JSON → null、调用方按「未初始化」处理） */
export const readSettingsFile = async (): Promise<Record<string, unknown> | null> => {
  try {
    const raw = await fs.readFile(settingsFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

// 秘钥掩码：留前 4 位 + 长度（跟 diagnostics 的脱敏口径一致——够对「配没配 / 是不是那把」、不泄本体）
const maskSecret = (v: unknown): string => {
  if (typeof v !== "string" || v.length === 0) return "";
  return `${v.slice(0, 4)}…（已脱敏、长度 ${v.length}）`;
};

/**
 * settings 对象脱敏（apiKey / gitToken 掩码、其余原样）。
 * `/api/settings` GET / PUT 响应的默认口径；client 初始化用 `/api/settings/full`。
 */
export const maskSettingsSecrets = (
  settings: Record<string, unknown>,
): Record<string, unknown> => ({
  ...settings,
  apiKey: maskSecret(settings.apiKey),
  gitToken: maskSecret(settings.gitToken),
});

/**
 * 按仓库路径查设置页配的「预览启动命令」（CR-01：/api/preview 唯一命令来源）。
 * 没配 / 配置文件缺失 → null（route 拒绝启动预览）。
 */
export const getRepoPreviewCommand = async (
  repoPath: string,
): Promise<string | null> => {
  const settings = await readSettingsFile();
  const repos = Array.isArray(settings?.repos)
    ? (settings.repos as Array<{ path?: unknown; previewCommand?: unknown }>)
    : [];
  const repo = repos.find((r) => r?.path === repoPath);
  const cmd = typeof repo?.previewCommand === "string" ? repo.previewCommand.trim() : "";
  return cmd || null;
};
