/** 本地时区某时刻所在日的 0 点（毫秒时间戳） */
export const startOfLocalDay = (now: number): number => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * 距离下一个本地零点的毫秒数（始终 > 0）。
 * 用「明天 0 点 - 现在」而不是固定 24h，DST 切换日也准。
 * 多留 50ms 余量：定时器偶尔会比目标早几 ms 触发，早了会还停在昨天、白转一圈。
 */
export const msUntilNextLocalMidnight = (now: number): number => {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return Math.max(1, d.getTime() - now) + 50;
};
