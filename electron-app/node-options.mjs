/**
 * NODE_OPTIONS 取值的引用（纯函数，main.js 与单测共用）。
 *
 * 为什么需要：NODE_OPTIONS 按空格切词。取值里有空格（macOS 的「Application Support」）又不加引号时，
 * Node 只取到空格前那一截、后半段被静默丢弃——`--report-directory=/Users/x/Library/Application Support/…`
 * 实测变成 `/Users/x/Library/Application`（一个不存在的目录），崩溃取证报告（OOM / 未捕获异常）写不出来，
 * 而且没有任何报错。
 *
 * 规则（对照 Node 的 NODE_OPTIONS 解析，单测里用真 Node 往返验证）：
 * - 双引号内的空格不切词；
 * - 引号**内**的反斜杠是转义符，所以取值里的 `\` 与 `"` 都要各补一个反斜杠（Windows 路径必需）；
 * - 引号**外**的反斜杠就是普通字符：不含空格 / 引号的取值保持原样，不加引号（行为与过去完全一致）。
 */
export const quoteNodeOptionValue = (value) =>
  /[\s"]/.test(value) ? `"${value.replace(/[\\"]/g, "\\$&")}"` : value;
