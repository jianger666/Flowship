/**
 * 日志行的级别识别（纯函数）：给 .log 文件的查看器按级别着色
 *
 * 口径偏保守——宁可漏标也不要把「no error found」这种普通信息行标成错误：
 * 级别词要求是**大写**独立单词（ERROR / WARN …，各家日志框架的默认输出），
 * 或 `level=error` / `"level":"warn"` / `[error]` 这类带结构的写法（这两类不区分大小写）。
 * 堆栈帧（`    at x`、`Caused by:`、`... 12 more`）没有级别词，继承上一条有级别的行，
 * 这样一段异常堆栈整块着同一个颜色。
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

const UPPER_WORD =
  /(?:^|[\s[|:=(])(FATAL|CRITICAL|SEVERE|ERROR|ERR|WARNING|WARN|INFO|NOTICE|DEBUG|TRACE|VERBOSE)(?=$|[\s\]|:,)])/;
const STRUCTURED =
  /(?:level|lvl|severity)["']?\s*[=:]\s*["']?(fatal|critical|error|err|warning|warn|info|notice|debug|trace)\b|\[(fatal|critical|error|warning|warn|info|debug|trace)\]/i;
const STACK_CONTINUATION = /^\s+at\s|^\s*Caused by:|^\s*\.\.\.\s+\d+\s+(?:more|common frames)|^\s+\.\.\.\s/;

const toLevel = (word: string): LogLevel | null => {
  switch (word.toUpperCase()) {
    case "FATAL":
    case "CRITICAL":
    case "SEVERE":
    case "ERROR":
    case "ERR":
      return "error";
    case "WARNING":
    case "WARN":
      return "warn";
    case "INFO":
    case "NOTICE":
      return "info";
    case "DEBUG":
    case "TRACE":
    case "VERBOSE":
      return "debug";
    default:
      return null;
  }
};

/** 只看行首一段（时间戳 + 级别都在开头），避免长行末尾的 payload 里碰巧出现 ERROR */
const HEAD_CHARS = 160;

export const detectLogLevel = (line: string): LogLevel | null => {
  const head = line.length > HEAD_CHARS ? line.slice(0, HEAD_CHARS) : line;
  const upper = UPPER_WORD.exec(head);
  if (upper) return toLevel(upper[1]!);
  const structured = STRUCTURED.exec(head);
  if (structured) return toLevel((structured[1] ?? structured[2])!);
  return null;
};

/** 逐行分类；堆栈续行继承上一条有级别的行 */
export const classifyLogLines = (lines: readonly string[]): (LogLevel | null)[] => {
  const out: (LogLevel | null)[] = [];
  let last: LogLevel | null = null;
  for (const line of lines) {
    const own = detectLogLevel(line);
    if (own) {
      last = own;
      out.push(own);
    } else if (last && STACK_CONTINUATION.test(line)) {
      out.push(last);
    } else {
      // 普通无级别行（多行消息体 / 空行）：不继承，也不清掉 last——堆栈帧之间夹空行很常见
      out.push(null);
    }
  }
  return out;
};
