/**
 * 给一个 promise 加**硬期限**（评审 R16-01）。
 *
 * 为什么不够用 `execFile({ timeout })`：timeout 只是到点给子进程发信号，回调要等子进程真的退出才触发。
 * `lsof` / `ps` 一旦陷进不可中断睡眠（失联的网络卷 / 卡住的 FUSE 挂载），SIGTERM / SIGKILL 都杀不掉它，
 * 回调永远不来、`await` 永远不返回。启动恢复里 `await killStalePreview()` 又挂在好几个任务读取接口前面，
 * 一个卡死的探测就能让任务列表 / 详情整个拿不到返回。
 *
 * 这里用 Promise.race 的方式保证**调用方按期拿到结果**：到点 reject（`code: "ETIMEDOUT"`），
 * 底层 promise 之后无论成败都被吞掉（不产生 unhandled rejection）。子进程本身不由这里负责。
 */
export class HardDeadlineError extends Error {
  readonly code = "ETIMEDOUT";
  constructor(label: string, ms: number) {
    super(`${label} 超过 ${ms}ms 未返回`);
    this.name = "HardDeadlineError";
  }
}

export const withHardDeadline = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HardDeadlineError(label, ms)), ms);
    // 不让这个定时器单独撑住进程 / 事件循环
    (timer as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
