/** 设置页 per-repo 依赖初始化命令（setupCommand）长度上限（输入框 maxLength 同值） */
export const REPO_SHELL_COMMAND_MAX_LEN = 500;

/**
 * 单行 shell 命令归一：trim；空串 / 非 string / 含换行 / 超长 → undefined（不落盘）。
 *
 * ⚠️ 超长**不截断**：被截断的 shell 命令可能变成另一条完全不同的命令（如砍掉 `&&` 前后半段），
 * 宁可丢弃回退 agent 自装；输入框已设 maxLength、正常输入到不了这里。
 * 只用于 setupCommand——previewCommand 保持原有宽松行为（不在这里归一）。
 */
export const sanitizeRepoShellCommand = (
  v: unknown,
): string | undefined => {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return undefined;
  if (trimmed.length > REPO_SHELL_COMMAND_MAX_LEN) return undefined;
  return trimmed;
};
