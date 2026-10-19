/**
 * 有界并发 map：items 很多时别一次性全发出去（成千上万个 stat / readFile 会短暂占满 libuv 线程池，
 * 拖慢同进程里其它所有文件 IO）。结果按入参顺序返回（不是完成顺序）。
 *
 * `fn` 抛错 → 整体 reject（其余在途的会继续跑完、结果丢弃）；需要「单个失败不影响整体」的调用方在 `fn` 里自己 try/catch。
 */
export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  // limit 不是数字（NaN / undefined）时退化成串行：否则一个 worker 都不起、fn 一次不跑、还返回一个空槽数组且不报错
  const cap = typeof limit === "number" && !Number.isNaN(limit) ? limit : 1;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, cap), items.length) }, worker),
  );
  return out;
};
