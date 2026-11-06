/** 预览窗里的数值展示（纯函数） */

export const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** 本地时间 `2026-11-06 15:23`；今年内省略年份 */
export const formatModified = (ms: number, now: Date = new Date()): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === now.getFullYear() ? date : `${d.getFullYear()}-${date}`;
};

/** 紧凑计数：1234 → 1,234（行数 / 条数） */
export const formatCount = (n: number): string => n.toLocaleString("en-US");
