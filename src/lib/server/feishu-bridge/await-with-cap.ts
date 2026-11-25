/**
 * 「最多等 capMs，等不到就放手」：给 status 接口等桥接对账用（R20-15）。
 *
 * 为什么需要：`syncBridgeRuntime()` 被并入在途对账时会一直等到那次（含补跑轮）真正收尾才返回，而收尾要经过
 * `event status` 探测（lark-cli 默认 30 秒超时）、停 consumer（两段各最多 5 秒）等步骤——lark-cli 卡住时，
 * status 接口会跟着挂几十秒、设置页一直转圈。status 是诊断接口，这时更需要的是「先给出当前能看到的状态」。
 *
 * 语义（每一条都有用例钉着，见 tests/feishu-bridge-await-with-cap.test.ts）：
 * - cap 之前 `p` 兑现 → `{ capped: false, value }`；
 * - cap 之前 `p` 拒绝 → **照样抛给调用方**（发起方自己的对账失败由调用方记日志，这里不吞）；
 * - 先到 cap → `{ capped: true }`，**不取消 `p`**（对账继续在后台跑完，只是不再等它）；
 *   cap 之后 `p` 才拒绝的错误不会变成 unhandledRejection，而是交给 `onLateError`（缺省静默）；
 * - 不论哪种结果，计时器都清掉（不留悬挂的定时器、不拖住进程退出——另外 unref 兜底）。
 *
 * 不做的事：不重试、不重新发起对账（对账由写盘通知 / 30 秒轮询 / 调用方自己负责）。
 */

export type CapResult<T> = { capped: false; value: T } | { capped: true };

export const awaitWithCap = async <T>(
  p: Promise<T>,
  capMs: number,
  onLateError?: (err: unknown) => void,
): Promise<CapResult<T>> => {
  let capped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CapResult<T>>((resolve) => {
    timer = setTimeout(() => {
      capped = true;
      resolve({ capped: true });
    }, capMs);
    timer.unref?.();
  });
  // p 的结果统一经这里：cap 之前的拒绝照抛；cap 之后的拒绝交给 onLateError（并且不再抛 → 没有 unhandledRejection）
  const settled = p.then(
    (value): CapResult<T> => ({ capped: false, value }),
    (err: unknown): CapResult<T> => {
      if (!capped) throw err;
      try {
        onLateError?.(err);
      } catch {
        // 记日志的回调自己出错也不能变成 unhandledRejection
      }
      return { capped: true };
    },
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
