/**
 * 播放器的时间工具：显示、解析、引用文本里的秒数写法
 *
 * 全是纯函数，不碰 DOM / 存储，方便单测。
 */

/** 把 n 限制在 [min, max]；非有限数按 min */
export const clampNumber = (n: number, min: number, max: number): number => {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
};

/**
 * 秒 → 时钟显示。
 * - `digits` 小数位（0–3），默认 0；四舍五入前先截断到该精度，避免 59.96s 显示成 `0:60`
 * - 不满 1 小时 `m:ss`，满 1 小时 `h:mm:ss`；`pad` 为 true 时分钟也补零（`00:12.4`，引用文本用）
 * - 负数 / NaN / Infinity 一律当 0
 */
export const formatClock = (
  seconds: number,
  opts: { digits?: 0 | 1 | 2 | 3; pad?: boolean } = {},
): string => {
  const digits = opts.digits ?? 0;
  const factor = 10 ** digits;
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  // 向下取整到目标精度：播放位置从来是「已经过了多少」，向上进位会让时钟跑到真实位置前面
  const total = Math.floor(safe * factor + 1e-9) / factor;
  const whole = Math.floor(total);
  const frac = digits > 0 ? Math.round((total - whole) * factor) : 0;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = String(s).padStart(2, "0");
  const fracText = digits > 0 ? `.${String(frac).padStart(digits, "0")}` : "";
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}${fracText}`;
  const mm = opts.pad ? String(m).padStart(2, "0") : String(m);
  return `${mm}:${ss}${fracText}`;
};

const SECONDS_RE = /^\d+(?:\.\d+)?$/;
const COLON_RE = /^(?:(\d+):)?(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/;
const UNIT_RE = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i;

/**
 * 解析用户 / AI 写的时间：
 * - 纯秒：`12`、`12.5`
 * - 冒号：`1:02`、`1:02.5`、`01:02:03.25`（分、秒部分按 60 进位校验：`1:75` 不合法）
 * - 单位：`1m30s`、`90s`、`1h2m3s`
 * 解析不了 → null。
 */
export const parseClock = (input: string): number | null => {
  const s = input.trim();
  if (!s) return null;
  if (SECONDS_RE.test(s)) return Number(s);
  const colon = COLON_RE.exec(s);
  if (colon) {
    const hasHours = colon[1] !== undefined;
    const a = Number(colon[2]);
    const sec = Number(colon[3]);
    if (sec >= 60) return null;
    if (hasHours) {
      const h = Number(colon[1]);
      if (a >= 60) return null;
      return h * 3600 + a * 60 + sec;
    }
    return a * 60 + sec;
  }
  // 单位写法至少要有一段；UNIT_RE 全可选，空串已在上面挡掉
  const unit = UNIT_RE.exec(s);
  if (unit && (unit[1] || unit[2] || unit[3])) {
    return Number(unit[1] ?? 0) * 3600 + Number(unit[2] ?? 0) * 60 + Number(unit[3] ?? 0);
  }
  return null;
};

/**
 * 字节数 → 人话（卡片上显示文件大小）。
 * 判档按「四舍五入之后的显示值」：1048575 B 是 1023.999 KB，toFixed(0) 会写成 `1024 KB`，
 * 应该进到 `1.0 MB`（和 formatClock 不让 59.96 秒显示成 0:60 同一个道理）。
 */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (Math.round(kb) < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (Math.round(mb) < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
};
