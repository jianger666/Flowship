/**
 * 存储降级提示文案（R14 B2-2 / Q9-01 = Q15-02）——前后端共用的纯函数模块（无 server-only 依赖）。
 *
 * 事件写盘失败（磁盘满 / 数据目录只读 / IO 错误 / 被占用且重试穿透）时，服务端置「存储降级」标志，
 * 经 `storage_degraded` 流帧告诉界面；界面顶部画红条（`StorageDegradedBar`），
 * 服务端发的 error toast 也用同一份标题文案——两处说的话保持一致。
 *
 * 文案面向普通用户：不出现 errno 码（ENOSPC / EROFS…），码只进服务端日志。
 * 三档只按「用户该做什么」分：磁盘空间 / 只读 / 其它（权限、IO 错误、被占用）。
 */

/**
 * 界面持有的「存储降级中」状态（null = 没降级 / 已恢复，由持有方自己表示）。
 * code = 触发降级的 errno 码；服务端没给 / 帧里缺失 = 空串（按「其它」档文案）。
 */
export interface StorageDegradedState {
  code: string;
}

export interface StorageDegradedCopy {
  /** 一句话标题：toast 与红条共用 */
  title: string;
  /** 红条里的补充说明：发生了什么、用户该做什么、什么时候自己消失 */
  detail: string;
}

// 「可能」「新产生的」：这段时间 AI 的输出只显示在当前页面（没落盘）；用户自己发的消息写失败时则根本没显示（接口会报错）。
const LOST_ON_REFRESH =
  "在恢复保存之前，新产生的内容可能只显示在当前页面，刷新或重启后会丢失。";
// 「下一次保存成功后」：恢复判定没有定时器，要等任务产生下一条能写进盘的事件，且距最近一次写失败满 10s（粘滞）才收；
// 写「恢复保存后」会让人以为腾出空间的瞬间就消失——空闲时红条会一直挂着，直到下一次成功保存（审查 AI R14 B2-2 P3）
const AUTO_CLEARS = "下一次保存成功后这条提示会自动消失。";

/**
 * 两个降级状态是否相同——bootstrap 补发与实时帧常常是同一份，相同就别 setState（省一次整页重渲染）。
 * null（没降级）只和 null 相同；有值时只比 code。
 */
export const sameStorageDegraded = (
  a: StorageDegradedState | null,
  b: StorageDegradedState | null,
): boolean => (a === null || b === null ? a === b : a.code === b.code);

export const describeStorageDegraded = (
  code: string | null | undefined,
): StorageDegradedCopy => {
  switch (code) {
    case "ENOSPC":
    case "EDQUOT":
      return {
        title: "磁盘空间不足，新内容没能保存",
        detail: `${LOST_ON_REFRESH}请先释放磁盘空间，${AUTO_CLEARS}`,
      };
    case "EROFS":
      return {
        title: "数据目录是只读的，新内容没能保存",
        detail: `${LOST_ON_REFRESH}请检查数据目录所在的磁盘是否被设为只读或已卸载，${AUTO_CLEARS}`,
      };
    default:
      return {
        title: "磁盘写入失败，新内容没能保存",
        detail: `${LOST_ON_REFRESH}请检查数据目录的权限和磁盘状态，${AUTO_CLEARS}`,
      };
  }
};
