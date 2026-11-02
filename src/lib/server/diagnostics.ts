/**
 * 诊断包导出（V0.11.9、用户点名「同事出问题让他找日志文件太麻烦」）
 *
 * 一键把排查所需信息打成**单个 txt** 落到用户「下载」目录、发给维护者即可：
 * - 版本 / 平台 / Node 信息
 * - IDE 探测结果（探到哪个可执行文件、「在 IDE 打开没反应」类问题一眼定位）
 * - 配置概要（**脱敏**：apiKey / gitToken 只留前 6 位 + 长度、MCP 配置只留 server 名）
 * - installer.log（Windows 安装器每次安装 / 自动更新写的几行：耗时 / 剩余空间 / 预检结果；没有则不出现）
 * - main.log 尾部（壳 + server 全部输出都在这份里、默认取最后 ~300KB；刚轮转完不足 300KB 时从 main.log.1 补足）
 *
 * 落地位置：~/Downloads（找不到回退数据目录）、文件名带时间戳不互相覆盖。
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { dataRoot, describeConfigReadError, stripBom } from "./data-root";
import { redactSecretsInText } from "./event-secret-redact";
import { listIdeToolsDetailed } from "./ide-tools";

// main.log 尾部截取量——太大发飞书费劲、300KB 足够覆盖最近几小时
const LOG_TAIL_BYTES = 300 * 1024;

// installer.log（Windows 安装器每次安装 / 自动更新追加几行，与 main.log 同目录）：
// 总共才几 KB，64KB 只是防被写爆的兜底，取尾部即可
const INSTALLER_LOG_TAIL_BYTES = 64 * 1024;

// 秘钥脱敏：留前 6 位 + 总长度（足够对上「配没配 / 配的是不是那把」、不泄漏本体）
const maskSecret = (v: unknown): string => {
  if (typeof v !== "string" || v.length === 0) return "（未配置）";
  return `${v.slice(0, 6)}…（长度 ${v.length}）`;
};

/**
 * 日志文本脱敏（评审 P2：诊断包里的 main.log / installer.log 尾部原样带出，而用户会把它发给别人排查）。
 * 两层：
 *  1. 已知凭据的精确值（gitToken / apiKey / 公司环境口令及其编码变体）——与事件落盘同一套 `redactSecretsInText`；
 *  2. 常见凭据形态的通用兜底（日志里可能出现的、不在上面清单里的：别处的 token、curl -v 的头、带口令的 URL）。
 * 通用兜底只抓高置信形态，宁可漏一点也不把日志改得没法读；它是兜底、不是保证——原则仍是日志里不该打印凭据。
 */
export const redactDiagnosticText = (text: string): string => {
  if (!text) return text;
  let out = redactSecretsInText(text);
  // GitLab 家族令牌（PAT / deploy / CI / feed / OAuth 应用 secret）
  out = out.replace(/\bgl(?:pat|dt|cbt|ptt|rt|oas|soat|ffct)-[A-Za-z0-9_-]{16,}/g, "gl***-[REDACTED]");
  // OpenAI 风格 / 常见 sk- 前缀密钥
  out = out.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "sk-[REDACTED]");
  // Authorization / Bearer 头（整个取值）
  out = out.replace(/(\bAuthorization\s*[:=]\s*(?:Bearer|Basic|Token)?\s*)[A-Za-z0-9._~+\/=-]{8,}/gi, "$1[REDACTED]");
  out = out.replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]{16,}=*/gi, "$1[REDACTED]");
  // URL 里的 userinfo 口令：scheme://user:pass@host
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\/\s:@]+:)[^\/\s@]+@/gi, "$1[REDACTED]@");
  // 凭据命名的 key=value / key: value（取值 ≥ 12 个字符才算，短值多半是状态词）
  out = out.replace(
    /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token)["']?\s*[=:]\s*["']?)[^\s"'&,;]{12,}/gi,
    "$1[REDACTED]",
  );
  return out;
};

// 读 config.json 并脱敏成概要文本。
// 只读这一个固定文件、不枚举数据目录：同目录的 config.json.bak / .bak.shrink（含已被清掉 / 轮换掉的旧 key）/
// .corrupt-<ts> / .tmp.* 都含明文凭据，不会、也不能被带进诊断包——日后若要加「打包 / 列出数据目录」，必须整族排除
// （行为钉在 tests/settings-backup-exclusion.test.ts）。
const readSanitizedConfig = async (): Promise<string> => {
  try {
    const raw = await fs.readFile(path.join(dataRoot(), "config.json"), "utf-8");
    const cfg = JSON.parse(stripBom(raw)) as Record<string, unknown>;
    const lines: string[] = [
      `apiKey: ${maskSecret(cfg.apiKey)}`,
      `gitToken: ${maskSecret(cfg.gitToken)}`,
      `gitHost: （不入 settings、按任务仓库 remote 现推）`,
      `jumpIde: ${String(cfg.jumpIde ?? "cursor")}`,
      `provider: ${String(cfg.provider ?? "cursor")}`,
      `defaultModel: ${JSON.stringify(cfg.defaultModel ?? null)}`,
      `customProviders: ${
        Array.isArray(cfg.customProviders)
          ? (cfg.customProviders as Array<{ id?: string; name?: string; defaultModel?: unknown }>)
              .map(
                (p) =>
                  `${p.name || p.id || "?"} defaultModel=${JSON.stringify(p.defaultModel ?? null)}`,
              )
              .join("；") || "（空）"
          : "（空）"
      }`,
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
    // 不带 err.message：V8 的 JSON 报错会夹带出错处附近的原文，而 config.json 开头就是密钥；诊断包是要发给别人的
    return `（config.json 读取失败：${describeConfigReadError(err)}）`;
  }
};

// 读文件尾部 maxBytes 字节（文件不存在 / 读不了会抛、由调用方决定怎么呈现）
const readFileTail = async (file: string, maxBytes: number): Promise<string> => {
  const stat = await fs.stat(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(stat.size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
};

// 壳日志目录：dataRoot = <userData>/data、日志在 <userData>/logs
const shellLogsDir = (): string => path.join(dataRoot(), "..", "logs");

/**
 * 读 main.log 尾部（壳把 server stdout 也写进这份、一份日志全覆盖）。
 *
 * 轮转（electron-app/shell-log.mjs：main.log 超过 20MB 就改名成 main.log.1、再开新的 main.log）之后新文件可能只有几行，
 * 只读它的话诊断包恰好在「刚轮转完」时缺最近的上下文——所以主文件不足 300KB 时，从 main.log.1 的尾部补足到 300KB
 * （补读量按字节算）。.1 不存在 / 读不了就算了（没轮转过是常态）。
 */
export const readMainLogTail = async (): Promise<string> => {
  const logPath = path.join(shellLogsDir(), "main.log");
  let main: string;
  let mainBytes = 0;
  try {
    main = await readFileTail(logPath, LOG_TAIL_BYTES);
    mainBytes = Buffer.byteLength(main);
  } catch (err) {
    main = `（main.log 读取失败：${logPath}、${err instanceof Error ? err.message : String(err)}——dev 模式没有壳日志属正常）`;
  }
  if (mainBytes >= LOG_TAIL_BYTES) return main;
  let older = "";
  try {
    older = await readFileTail(`${logPath}.1`, LOG_TAIL_BYTES - mainBytes);
  } catch {
    // 没轮转过 / 旧日志读不了：只给主文件
  }
  if (older === "") return main;
  return [
    "----- 以下来自 main.log.1（轮转前的旧日志，补足最近的上下文） -----",
    older.replace(/\r?\n$/, ""),
    "----- 以下来自 main.log（轮转后的新日志） -----",
    main,
  ].join("\n");
};

/**
 * 读 installer.log 尾部：Windows 安装器每次安装 / 自动更新写几行（init / done / ABORT，含耗时与剩余空间）。
 * 「更新后 App 没了 / 装到一半」这类黑盒问题靠它定位。文件不存在（mac / 没走过新安装器）返回 null、
 * 诊断包里就不出现这一节，不制造「读取失败」的噪声。
 */
export const readInstallerLogTail = async (): Promise<string | null> => {
  try {
    return await readFileTail(
      path.join(shellLogsDir(), "installer.log"),
      INSTALLER_LOG_TAIL_BYTES,
    );
  } catch {
    return null;
  }
};

/**
 * 组装诊断包并写到「下载」目录。
 * @param appVersion 壳版本号（客户端从 window.__appVersion 带来、server 自己拿不到）
 * @returns 落盘绝对路径
 */
export const exportDiagnostics = async (appVersion?: string): Promise<string> => {
  const [ideTools, config, logTail, installerLog] = await Promise.all([
    listIdeToolsDetailed(),
    readSanitizedConfig(),
    readMainLogTail(),
    readInstallerLogTail(),
  ]);

  const rawContent = [
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
    ...(installerLog === null
      ? []
      : [
          `===== installer.log（Windows 安装 / 自动更新记录，最后 ${Math.round(INSTALLER_LOG_TAIL_BYTES / 1024)}KB；ts 是 Unix 秒） =====`,
          installerLog,
          "",
        ]),
    `===== main.log 尾部（最后 ${Math.round(LOG_TAIL_BYTES / 1024)}KB） =====`,
    logTail,
  ].join("\n");
  // 整份内容过一遍日志脱敏（config 概要已按固定格式脱过，这里主要管 main.log / installer.log 尾部）
  const content = redactDiagnosticText(rawContent);

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
