/**
 * 认不认「提问等答案那条 curl」——纯字符串判定，client / server 共用。
 * 槽位状态机仍在 server 的 ask-wait.ts；这里故意不引，避免事件流打进全局 wait 表。
 */

export const isAskWaitCommand = (blob: string): boolean =>
  blob.includes("/ask-wait?") && blob.includes("token=");

export const toolArgsLookLikeAskWait = (args: unknown): boolean => {
  if (args == null) return false;
  if (typeof args === "string") return isAskWaitCommand(args);
  try {
    return isAskWaitCommand(JSON.stringify(args));
  } catch {
    return false;
  }
};
