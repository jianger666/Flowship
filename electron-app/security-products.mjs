/**
 * Windows 安全中心杀软清单探测（脚本常量 + 纯函数、无 electron 依赖，可被 vitest 直接单测）。
 *
 * 为什么让 PowerShell 输出 Base64、而不是直接打印名字：
 * PowerShell 5.1 的 stdout 被重定向到管道时，用的是控制台输出代码页（OEM；简体中文 Windows 是 GBK/936），
 * 而 Node 的 execFile 默认按 UTF-8 解码——360 安全卫士 / 火绒 / 腾讯电脑管家的 displayName 含中文，
 * 恰恰是这个功能最需要认出来的对象，直接打印会变乱码。Base64 全是 ASCII、不依赖任何代码页：
 * 脚本里按 UTF-8 编码、这里按 UTF-8 解码，两端自己约定、与控制台无关。
 * 不靠设置 [Console]::OutputEncoding：windowsHide 下没有可见控制台，设置它可能抛错。
 *
 * 脚本约束：只含 ASCII、只用单引号（不含双引号）——避免 argv 引号转义、以及脚本文本被代码页吃掉。
 * 输出约定（只有这两种前缀）：
 *   OK:<base64(UTF-8 的名字列表，换行分隔)>   查到了（列表可以为空 = 安全中心里没登记杀软）
 *   ERR:<异常类型名>                          查询抛了异常（如 Server 版 Windows 没有 SecurityCenter2 命名空间）
 * 区分这几种结局是为了日志能回答「为什么没有清单」：没登记 / 查询失败 / 超时 / 拉不起 PowerShell。
 */

/** 探测超时：纯取证、绝不能拖住任何东西，10s 到了就杀。 */
export const SECURITY_PROBE_TIMEOUT_MS = 10_000;

// ⚠️ 不能用 join("; ") 拼：PowerShell 里 `try { } ; catch { }` 中间的分号会把 catch 变成孤立的语法错误。
export const SECURITY_PROBE_SCRIPT =
  "$ErrorActionPreference = 'Stop'; " +
  "try { " +
  "$n = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct " +
  "| ForEach-Object { $_.displayName }) -join [char]10; " +
  "'OK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($n)) " +
  "} catch { 'ERR:' + $_.Exception.GetType().Name }";

/** 只留可打印 ASCII 并截断：异常名 / 杂散输出进日志前清洗，避免把乱码或超长内容写进去。 */
const sanitize = (s, max) =>
  String(s ?? "")
    .replace(/[^\x20-\x7e]/g, "?")
    .trim()
    .slice(0, max);

/**
 * 解析 execFile 回调的 (err, stdout)。
 * @param {(Error & { killed?: boolean, signal?: string | null, code?: string | number | null }) | null} err
 * @param {string | Buffer | undefined} stdout
 * @returns {{ kind: "ok" | "none" | "query-error" | "timeout" | "exec-error" | "unparsable", names: string[], detail?: string }}
 */
export const parseSecurityProbe = (err, stdout) => {
  if (err) {
    // execFile 的 timeout 选项到点会 kill 子进程：killed = true、signal = SIGTERM
    if (err.killed === true || err.signal) return { kind: "timeout", names: [] };
    const code = err.code;
    const detail = typeof code === "number" ? `exit ${code}` : sanitize(code ?? err.message ?? "unknown", 60);
    return { kind: "exec-error", names: [], detail };
  }
  // trim() 会一并去掉 BOM（U+FEFF 在 ECMAScript 里算空白）和 PowerShell 的 CRLF
  const text = String(stdout ?? "").trim();
  if (text.startsWith("ERR:")) {
    return { kind: "query-error", names: [], detail: sanitize(text.slice(4), 60) };
  }
  if (!text.startsWith("OK:")) {
    return { kind: "unparsable", names: [], detail: sanitize(text, 40) || "（空输出）" };
  }
  const decoded = Buffer.from(text.slice(3).trim(), "base64").toString("utf8");
  const names = [
    ...new Set(
      decoded
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  return names.length > 0 ? { kind: "ok", names } : { kind: "none", names: [] };
};

/** 给日志用的一句话：每种结局文案不同，事后才能分清「没装杀软」和「没查到」。 */
export const describeSecurityProbe = (result) => {
  switch (result.kind) {
    case "ok":
      return result.names.join("、");
    case "none":
      return "（安全中心里没有登记杀毒软件）";
    case "timeout":
      return `（查询超过 ${SECURITY_PROBE_TIMEOUT_MS / 1000}s 被放弃）`;
    case "query-error":
      return `（安全中心查询失败：${result.detail}；Server 版 Windows 没有该命名空间属正常）`;
    case "exec-error":
      return `（无法运行 PowerShell：${result.detail}）`;
    default:
      return `（输出无法解析：${result.detail}）`;
  }
};
