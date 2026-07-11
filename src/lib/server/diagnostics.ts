/**
 * 诊断包导出（V0.11.9、用户点名「同事出问题让他找日志文件太麻烦」）
 *
 * 一键把排查所需信息打成**单个 txt** 落到用户「下载」目录、发给维护者即可：
 * - 版本 / 平台 / Node 信息
 * - IDE 探测结果（探到哪个可执行文件、「在 IDE 打开没反应」类问题一眼定位）
 * - 配置概要（**脱敏**：apiKey / gitToken 只留前 6 位 + 长度、MCP 配置只留 server 名）
 * - main.log 尾部（壳 + server 全部输出都在这份里、默认取最后 ~300KB）
 *
 * 落地位置：~/Downloads（找不到回退数据目录）、文件名带时间戳不互相覆盖。
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { dataRoot } from "./data-root";
import { listIdeToolsDetailed } from "./ide-tools";

// main.log 尾部截取量——太大发飞书费劲、300KB 足够覆盖最近几小时
const LOG_TAIL_BYTES = 300 * 1024;

// 秘钥脱敏：留前 6 位 + 总长度（足够对上「配没配 / 配的是不是那把」、不泄漏本体）
const maskSecret = (v: unknown): string => {
  if (typeof v !== "string" || v.length === 0) return "（未配置）";
  return `${v.slice(0, 6)}…（长度 ${v.length}）`;
};

// 读 config.json 并脱敏成概要文本
const readSanitizedConfig = async (): Promise<string> => {
  try {
    const raw = await fs.readFile(path.join(dataRoot(), "config.json"), "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const lines: string[] = [
      `apiKey: ${maskSecret(cfg.apiKey)}`,
      `gitToken: ${maskSecret(cfg.gitToken)}`,
      `gitHost: ${typeof cfg.gitHost === "string" && cfg.gitHost ? cfg.gitHost : "（空、自动推导）"}`,
      `jumpIde: ${String(cfg.jumpIde ?? "cursor")}`,
      `defaultModel: ${JSON.stringify(cfg.defaultModel ?? null)}`,
      `repos: ${
        Array.isArray(cfg.repos)
          ? (cfg.repos as Array<{ path?: string }>).map((r) => r.path).join("、") || "（空）"
          : "（空）"
      }`,
      `自管 MCP: ${
        cfg.mcpServers && typeof cfg.mcpServers === "object"
          ? Object.keys(cfg.mcpServers as object).join("、") || "（空）"
          : "（空）"
      }`,
      `disabledMcpServers: ${JSON.stringify(cfg.disabledMcpServers ?? [])}`,
    ];
    return lines.join("\n");
  } catch (err) {
    return `（config.json 读取失败：${err instanceof Error ? err.message : String(err)}）`;
  }
};

// 读 main.log 尾部（壳把 server stdout 也写进这份、一份日志全覆盖）
const readMainLogTail = async (): Promise<string> => {
  // dataRoot = <userData>/data、日志在 <userData>/logs/main.log
  const logPath = path.join(dataRoot(), "..", "logs", "main.log");
  try {
    const stat = await fs.stat(logPath);
    const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
    const fh = await fs.open(logPath, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      await fh.read(buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch (err) {
    return `（main.log 读取失败：${logPath}、${err instanceof Error ? err.message : String(err)}——dev 模式没有壳日志属正常）`;
  }
};

/**
 * 组装诊断包并写到「下载」目录。
 * @param appVersion 壳版本号（客户端从 window.__appVersion 带来、server 自己拿不到）
 * @returns 落盘绝对路径
 */
export const exportDiagnostics = async (appVersion?: string): Promise<string> => {
  const [ideTools, config, logTail] = await Promise.all([
    listIdeToolsDetailed(),
    readSanitizedConfig(),
    readMainLogTail(),
  ]);

  const content = [
    "===== Flowship 诊断包 =====",
    `导出时间: ${new Date().toISOString()}`,
    `app 版本: ${appVersion || "（未知、可能是 dev / 旧壳）"}`,
    `平台: ${process.platform} ${process.arch} / Node ${process.version}`,
    `数据目录: ${dataRoot()}`,
    "",
    "===== IDE 探测 =====",
    ...ideTools.map(
      (t) => `${t.id}: ${t.available ? `✓ ${t.exec ?? ""}` : "✗ 未检测到"}`,
    ),
    "",
    "===== 配置概要（已脱敏） =====",
    config,
    "",
    `===== main.log 尾部（最后 ${Math.round(LOG_TAIL_BYTES / 1024)}KB） =====`,
    logTail,
  ].join("\n");

  // 时间戳文件名（本地时间、精确到分、重复导出不覆盖）
  const ts = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const filename = `Flowship诊断-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.txt`;

  // 首选「下载」目录（mac / win 都是 ~/Downloads）、写不进回退数据目录
  const downloads = path.join(os.homedir(), "Downloads");
  for (const dir of [downloads, dataRoot()]) {
    try {
      const target = path.join(dir, filename);
      await fs.writeFile(target, content, "utf8");
      return target;
    } catch {
      // 目录不存在 / 无权限、试下一个
    }
  }
  throw new Error("诊断包写不进下载目录和数据目录");
};
