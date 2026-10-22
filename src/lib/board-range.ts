/**
 * 首页排期甘特的区间处理（client / server 共用、纯函数）
 *
 * 背景（第三轮 D2a-02）：飞书 workhour 接口单次跨度 ≤ 3 个月，服务端原来把超出部分按 90 天直接截断，
 * 而界面的「半年」预设是 181 天、日历也能选任意区间——后 91 天静默为空、界面照画满列，用户会当成「后面没排期」。
 * 现在服务端按 ≤90 天分段串行请求再合并去重。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 单次请求的最大跨度（飞书接口限制） */
export const MAX_BOARD_WINDOW_MS = 90 * DAY_MS;
/** 一次看板请求最多分几段（防止异常区间把串行队列堵满；6 段 ≈ 540 天，远超半年预设） */
export const MAX_BOARD_WINDOWS = 6;

export interface BoardWindow {
  from: number;
  to: number;
}

/**
 * 把 [from, to] 切成若干 ≤ MAX_BOARD_WINDOW_MS 的连续窗口。
 * - 相邻窗口首尾相接（后一段从前一段的 to 开始），边界上的工作项靠 mergeBoardWindows 去重；
 * - to <= from 或非有限数 → 返回单个原样窗口（交给上游按旧行为处理）；
 * - 超过 MAX_BOARD_WINDOWS 段时 truncated=true，只返回前 MAX_BOARD_WINDOWS 段。
 */
export const splitBoardWindows = (
  from: number,
  to: number,
  opts?: { maxSpanMs?: number; maxWindows?: number },
): { windows: BoardWindow[]; truncated: boolean } => {
  const span = opts?.maxSpanMs ?? MAX_BOARD_WINDOW_MS;
  const maxWindows = opts?.maxWindows ?? MAX_BOARD_WINDOWS;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return { windows: [{ from, to }], truncated: false };
  }
  const windows: BoardWindow[] = [];
  let cursor = from;
  while (cursor < to) {
    if (windows.length >= maxWindows) return { windows, truncated: true };
    const end = Math.min(to, cursor + span);
    windows.push({ from: cursor, to: end });
    cursor = end;
  }
  return { windows, truncated: false };
};

/** 合并多段结果：按 id 去重（跨窗口的工作项会在相邻两段都出现），保留首次出现的顺序与内容 */
export const mergeBoardWindows = <T extends { id: string }>(
  parts: ReadonlyArray<readonly T[]>,
): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const part of parts) {
    for (const it of part) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(it);
    }
  }
  return out;
};
