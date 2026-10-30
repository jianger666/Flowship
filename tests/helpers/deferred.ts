/**
 * 测试用的小工具：手动放行的 Promise、「是否还在等」。
 *
 * （tests/use-merge-mr-behavior.test.ts 里有一份内联的同款 deferred；这里独立一份，不去改那个已审过的文件。）
 */
export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

export const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * 让出一轮宏任务后 p 还没落定 = 仍在等。
 * 不依赖假时钟：已就绪的微任务都会先于这个 setTimeout(0) 跑完，所以「还没落定」就是真的在等外部放行。
 */
export const stillPending = async (p: Promise<unknown>): Promise<boolean> => {
  const pending = Symbol("pending");
  const winner = await Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 0)),
  ]);
  return winner === pending;
};
