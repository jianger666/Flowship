/**
 * 删任务失败的人话说明（DELETE /api/tasks/[id] 的兜底 catch 用；零 IO、可单测）。
 *
 * 第三轮 review D4b-04：兜底 catch 原先把任何内部异常报成 `400 {"error":"bad_request"}`——
 * 状态码语义错了（不是请求的问题），文案也不透明。现在 500 + 这里给的一句话：
 * 说清「任务没被删、可以重试」，并把常见的系统错误码翻成人话；认不出的带上原始 message（截断）。
 */

const REASON_BY_CODE: Record<string, string> = {
  EACCES: "没有权限删除任务目录",
  EPERM: "没有权限删除任务目录",
  EBUSY: "任务目录正被其它程序占用",
  ENOTEMPTY: "任务目录里还有文件正在写入",
  ENOSPC: "磁盘空间不足",
  EMFILE: "系统打开的文件太多",
  ENFILE: "系统打开的文件太多",
  EIO: "磁盘读写出错",
  EROFS: "磁盘是只读的",
};

const MAX_MESSAGE_CHARS = 120;

export const describeDeleteFailure = (err: unknown): string => {
  const code =
    err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "";
  const known = REASON_BY_CODE[code];
  let reason = known;
  if (!reason) {
    const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
    const firstLine = raw.split("\n")[0]?.trim() ?? "";
    reason = firstLine
      ? firstLine.length > MAX_MESSAGE_CHARS
        ? `${firstLine.slice(0, MAX_MESSAGE_CHARS)}…`
        : firstLine
      : "未知原因";
  }
  return `删除失败：${reason}。任务没有被删除，可以稍后重试`;
};
