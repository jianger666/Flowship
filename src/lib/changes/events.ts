/**
 * 「工作区的 git 状态变了」的轻量通知（window 事件，无 React）。
 *
 * 改动面板只在「agent 运行中」才轮询；chat 里用户自己切分支、在终端里 commit / stash 之后，
 * 没有任何信号告诉面板「该重读了」。所以：
 * - 分支切换器切分支成功后派发 GIT_BRANCH_CHANGED_EVENT；
 * - 面板监听它（以及窗口重新聚焦）静默刷新清单。
 */

export const GIT_BRANCH_CHANGED_EVENT = "flowship:git-branch-changed";

interface GitBranchChangedDetail {
  taskId: string;
}

/** 通知「这个任务 / 会话的分支变了」。SSR 下什么都不做 */
export const dispatchGitBranchChanged = (taskId: string): void => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<GitBranchChangedDetail>(GIT_BRANCH_CHANGED_EVENT, { detail: { taskId } }),
  );
};

/** 订阅某个任务的分支变化；返回取消订阅函数 */
export const onGitBranchChanged = (taskId: string, cb: () => void): (() => void) => {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<GitBranchChangedDetail | undefined>).detail;
    if (detail?.taskId === taskId) cb();
  };
  window.addEventListener(GIT_BRANCH_CHANGED_EVENT, handler);
  return () => window.removeEventListener(GIT_BRANCH_CHANGED_EVENT, handler);
};
