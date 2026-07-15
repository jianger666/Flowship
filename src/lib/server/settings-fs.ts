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
 *
 * P1-04：读结果三态分流——ok / missing（仅 ENOENT）/ error（损坏 / 权限等），
 * 避免把「可读失败」当成「首次安装」去 PUT 覆盖。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  dataRoot,
  hardenPathMode,
  writePrivateFileAtomic,
} from "./data-root";

export const settingsFilePath = (): string => path.join(dataRoot(), "config.json");

/** 读 config.json 三态：ok / missing（ENOENT）/ error（损坏、权限等） */
export type SettingsReadResult =
  | { status: "ok"; settings: Record<string, unknown> }
  | { status: "missing" }
  | { status: "error"; reason: string };

/**
 * JSON 损坏时备份原文件一次：`config.json.corrupt-<ts>`。
 * 同目录已有任意 `config.json.corrupt-*` 则跳过（避免每次读都再备一份）。
 */
const backupCorruptSettingsOnce = async (raw: string): Promise<void> => {
  const filePath = settingsFilePath();
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const prefix = `${base}.corrupt-`;
  try {
    const entries = await fs.readdir(dir);
    if (entries.some((name) => name.startsWith(prefix))) return;
  } catch {
    // 列目录失败仍尝试备份——宁可多一份也不丢用户数据
  }
  const backupPath = path.join(dir, `${prefix}${Date.now()}`);
  try {
    await fs.writeFile(backupPath, raw, "utf-8");
    await hardenPathMode(backupPath, 0o600);
    console.warn(`[settings-fs] config.json 损坏、已备份到 ${path.basename(backupPath)}`);
  } catch (err) {
    console.warn(
      "[settings-fs] config.json 损坏备份失败:",
      err instanceof Error ? err.message : err,
    );
  }
};

/** 读整份 config.json：ENOENT → missing；JSON 坏 / 权限等 → error（坏 JSON 会先备份） */
export const readSettingsFile = async (): Promise<SettingsReadResult> => {
  const filePath = settingsFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { status: "missing" };
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      reason: code ? `${code}: ${message}` : message,
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { status: "ok", settings: parsed as Record<string, unknown> };
    }
    // 根节点不是对象（数组 / 原始类型）= 内容损坏
    await backupCorruptSettingsOnce(raw);
    return { status: "error", reason: "settings_json_invalid" };
  } catch (err) {
    await backupCorruptSettingsOnce(raw);
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", reason: `json_parse: ${message}` };
  }
};

/**
 * 原子写 config.json（0600 + tmp/rename）。
 * 含 API key / GitLab PAT——写入即收紧权限（P0-02）。
 */
export const writeSettingsFileAtomic = async (
  settings: Record<string, unknown>,
): Promise<void> => {
  await writePrivateFileAtomic(
    settingsFilePath(),
    JSON.stringify(settings, null, 2),
  );
};

/**
 * 启动幂等迁移：已存在的 config.json 收紧为 0600。
 * 失败只 warn、不阻断启动；日志不含文件内容。
 */
export const hardenConfigFilePerms = async (): Promise<void> => {
  await hardenPathMode(settingsFilePath(), 0o600);
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

// 掩码特征（maskSecret 的产物）——PUT 进来带这个 = client 把脱敏展示值当真值回写了
const MASK_MARKER = "已脱敏";

/**
 * PUT 掩码兜底：进来的 apiKey / gitToken 带脱敏掩码（maskSecret 产物）→ 保留盘上真值。
 *
 * 只拦「client 误把脱敏展示值当真值回写」这一种明确坏数据——掩码串写进盘、agent 直接全挂。
 * **空值不拦**（用户拍板「自己清 key 是合法操作」）：清空放行。
 */
export const preserveSecretsOnPut = (
  incoming: Record<string, unknown>,
  current: Record<string, unknown> | null,
): { settings: Record<string, unknown>; preserved: string[] } => {
  if (!current) return { settings: incoming, preserved: [] };
  const preserved: string[] = [];
  const out = { ...incoming };
  for (const key of ["apiKey", "gitToken"] as const) {
    const cur = typeof current[key] === "string" ? (current[key] as string) : "";
    if (!cur) continue; // 盘上本来就没有、不管
    const inc = typeof out[key] === "string" ? (out[key] as string) : "";
    if (inc.includes(MASK_MARKER)) {
      out[key] = cur;
      preserved.push(key);
    }
  }
  return { settings: out, preserved };
};

/**
 * 按仓库路径查设置页配的「预览启动命令」（CR-01：/api/preview 唯一命令来源）。
 * 没配 / 配置文件缺失 / 读失败 → null（route 拒绝启动预览）。
 */
export const getRepoPreviewCommand = async (
  repoPath: string,
): Promise<string | null> => {
  const result = await readSettingsFile();
  const settings = result.status === "ok" ? result.settings : null;
  const repos = Array.isArray(settings?.repos)
    ? (settings.repos as Array<{ path?: unknown; previewCommand?: unknown }>)
    : [];
  const repo = repos.find((r) => r?.path === repoPath);
  const cmd = typeof repo?.previewCommand === "string" ? repo.previewCommand.trim() : "";
  return cmd || null;
};
