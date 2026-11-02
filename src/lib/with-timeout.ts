/**
 * 给 Promise 加超时出口（纯逻辑）。
 *
 * 用途：弹窗保存中拦住 Esc / X 关闭时，请求若挂住（fetch 本身无超时）不能让弹窗永远关不掉——
 * 超时后以 `message` reject，调用方走失败分支（toast + 解锁 + 保留草稿）。
 *
 * 两种入参：
 * - 直接传 Promise：超时只是「不再等」，不会取消底层请求；底层迟到的结果被忽略；
 * - 传工厂函数 `(signal) => Promise`：超时时先 `abort()` 这个 signal 再 reject，调用方把 signal 交给 fetch 就能真正
 *   掐掉底层请求（避免用户再点保存时旧请求还在飞）。注意 abort 只断开本端连接——服务端可能已经处理完了，
 *   所以超时文案里要说清「可能已保存成功」。
 */
export const withTimeout = <T>(
  source: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  ms: number,
  message: string,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let controller: AbortController | null = null;
    let promise: Promise<T>;
    try {
      if (typeof source === "function") {
        controller = new AbortController();
        promise = source(controller.signal);
      } else {
        promise = source;
      }
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      // 先 abort 再 reject：abort 触发的底层 AbortError 走下面的 then(_, onRejected)，此时已 settle、被忽略
      controller?.abort();
      reject(new Error(message));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

/**
 * 「保存中拦关闭」守卫：忙时忽略「关」（Esc / X），其余原样放行。
 * 配合 {@link withTimeout} 使用——忙状态在 finally 里复位（成功 / 失败 / 超时都会走），所以不会造成关不掉。
 */
export const guardCloseWhileBusy = (
  busy: boolean,
  next: boolean,
  onOpenChange: (open: boolean) => void,
): void => {
  if (!next && busy) return;
  onOpenChange(next);
};
