/**
 * 列表行的稳定 React key（S13-17）
 *
 * 背景：公司环境的服务器 / PG / Redis 等行没有持久 id，原来用下标当 key——
 * 删掉第 0 行后，原第 1 行的数据被下标 0 的组件实例接管，实例内部 state
 * （密码框「显示明文」）就串到了别的行上。
 *
 * 不给持久化数据加 id（会改 schema / 导入导出），而是在前端按「操作」对账：
 * - 行数不变：原地编辑，key 全保留
 * - 行数 +N（只会在末尾追加）：旧 key 保留，新增行发新 key
 * - 行数 -1：按内容找出被删的那一行，剩余行 key 不动
 * - 其它（导入整体覆盖 / 一次删多行）：全部重发新 key
 * 行内容用 `sig` 序列化比较，调用方传入稳定序列化函数。
 */

export interface RowKeySnapshot<T> {
  rows: readonly T[];
  keys: readonly string[];
}

let seq = 0;
/** 发新 key：模块级自增，进程内唯一即可（仅作 React key / 状态映射） */
export const nextRowKey = (): string => `row-${++seq}`;

/** 对账：根据上一次快照和新的行列表，算出新行列表对应的 key */
export const reconcileRowKeys = <T>(
  prev: RowKeySnapshot<T>,
  nextRows: readonly T[],
  sig: (row: T) => string,
  makeKey: () => string = nextRowKey,
): string[] => {
  const p = prev.rows.length;
  const n = nextRows.length;
  const fresh = (count: number) => Array.from({ length: count }, () => makeKey());

  if (n === p) return [...prev.keys];
  if (n > p && p > 0) {
    // 追加：前 p 行沿用旧 key
    return [...prev.keys, ...fresh(n - p)];
  }
  if (n === p - 1) {
    // 删一行：找第一个内容对不上的下标（都对得上 = 删的是最后一行）
    let removed = n;
    for (let i = 0; i < n; i += 1) {
      if (sig(prev.rows[i]) !== sig(nextRows[i])) {
        removed = i;
        break;
      }
    }
    return prev.keys.filter((_, i) => i !== removed);
  }
  return fresh(n);
};
