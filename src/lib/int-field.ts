/**
 * 整数输入框（端口 / DB 序号）的失焦校验纯函数（S13-16）
 *
 * 背景：原实现 onChange 里 `Number(e.target.value) || 22` ——用户清空准备重敲就被立刻回填默认值、
 * 想把「22」改成「2222」得先把光标挪到中间；且没有范围校验，70000 / -1 / 1.5 都能落盘。
 * 现在编辑中允许为空，失焦时才判定：空 → 回填默认；非整数 / 越界 → 拒绝（调用方回退旧值并提示）。
 */

export interface IntFieldRange {
  min: number;
  max: number;
  /** 失焦时留空回填的默认值 */
  fallback: number;
}

export type IntFieldResult =
  | { status: "ok"; value: number }
  /** 留空：回填 fallback（不算错误） */
  | { status: "empty"; value: number }
  /** 非整数 / 超出范围：不应落盘 */
  | { status: "invalid" };

export interface ParseIntFieldFlags {
  /**
   * 浏览器对 `<input type="number">` 的 `validity.badInput`：用户敲了无法解析成数字的内容（`22e`、`2-2`）时为 true。
   * 此时 `.value` 是空串、和「用户清空」在文本层面无法区分，必须由调用方把这个标记带进来。
   */
  badInput?: boolean;
}

/** 解析失焦时的输入文本 */
export const parseIntField = (
  text: string,
  range: IntFieldRange,
  flags: ParseIntFieldFlags = {},
): IntFieldResult => {
  // 先于「留空」判断：否则 `22e` 会被当成留空、静默回填默认值并提交（把用户的端口悄悄改掉）
  if (flags.badInput) return { status: "invalid" };
  const t = text.trim();
  if (!t) return { status: "empty", value: range.fallback };
  // 只认纯十进制整数；拒绝 1e3 / 0x10 / 1.5 / 22abc（Number() 会放过前两种）
  if (!/^[+-]?\d+$/.test(t)) return { status: "invalid" };
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < range.min || n > range.max) {
    return { status: "invalid" };
  }
  return { status: "ok", value: n };
};

/** 端口范围：1–65535（SSH / PG / Redis 共用） */
export const PORT_MIN = 1;
export const PORT_MAX = 65535;
