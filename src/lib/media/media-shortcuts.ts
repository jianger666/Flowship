/**
 * 播放器快捷键：按键 → 命令（纯函数，组件只负责执行命令）
 *
 * 键位参照 YouTube / 剪辑软件的肌肉记忆：空格 / K 播放，J / L 后退前进 10 秒，← → 5 秒，
 * `,` `.` 逐帧，数字键（有对比组时）切换第几个文件。
 * 带 ⌘ / Ctrl / Alt 的组合一律不处理——留给应用的全局快捷键（⌘K / ⌘B 等）。
 * 关闭播放器是「连按两次 Esc」（有状态，见 decideEscapeClose），不走 resolveMediaShortcut。
 */

import { RATES } from "@/lib/media/media-memory";
import type { MediaKind } from "@/lib/media/media-kind";

export type MediaCommand =
  | { type: "toggle" }
  | { type: "seekBy"; seconds: number }
  | { type: "seekStart" }
  | { type: "seekEnd" }
  | { type: "seekPercent"; percent: number }
  | { type: "frame"; dir: 1 | -1 }
  | { type: "rateStep"; dir: 1 | -1 }
  | { type: "rateReset" }
  | { type: "volumeBy"; delta: number }
  | { type: "mute" }
  | { type: "loop" }
  | { type: "fullscreen" }
  | { type: "pip" }
  | { type: "captions" }
  | { type: "item"; index: number }
  | { type: "prev" }
  | { type: "next" }
  | { type: "help" }
  /** 仅界面入口（点时间弹输入框），没有对应按键 */
  | { type: "gotoTime" };

export interface ShortcutEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}

export interface ShortcutContext {
  /** 当前对比组里有几个文件 */
  groupSize: number;
  kind: MediaKind;
}

export const resolveMediaShortcut = (
  e: ShortcutEventLike,
  ctx: ShortcutContext,
): MediaCommand | null => {
  if (e.isComposing) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const shift = !!e.shiftKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  switch (key) {
    case " ":
    case "k":
      return { type: "toggle" };
    case "ArrowLeft":
      return { type: "seekBy", seconds: shift ? -30 : -5 };
    case "ArrowRight":
      return { type: "seekBy", seconds: shift ? 30 : 5 };
    case "j":
      return { type: "seekBy", seconds: -10 };
    case "l":
      return { type: "seekBy", seconds: 10 };
    case ",":
      return ctx.kind === "video" ? { type: "frame", dir: -1 } : { type: "seekBy", seconds: -1 };
    case ".":
      return ctx.kind === "video" ? { type: "frame", dir: 1 } : { type: "seekBy", seconds: 1 };
    case "[":
      return { type: "rateStep", dir: -1 };
    case "]":
      return { type: "rateStep", dir: 1 };
    case "\\":
      return { type: "rateReset" };
    case "ArrowUp":
      return { type: "volumeBy", delta: 0.05 };
    case "ArrowDown":
      return { type: "volumeBy", delta: -0.05 };
    case "m":
      return { type: "mute" };
    case "r":
      return { type: "loop" };
    case "f":
      return ctx.kind === "video" ? { type: "fullscreen" } : null;
    case "p":
      return ctx.kind === "video" ? { type: "pip" } : null;
    case "c":
      return ctx.kind === "video" ? { type: "captions" } : null;
    case "Home":
      return { type: "seekStart" };
    case "End":
      return { type: "seekEnd" };
    case "PageUp":
      return ctx.groupSize > 1 ? { type: "prev" } : null;
    case "PageDown":
      return ctx.groupSize > 1 ? { type: "next" } : null;
    case "?":
      return { type: "help" };
    default:
      break;
  }

  if (/^[0-9]$/.test(key)) {
    const n = Number(key);
    if (ctx.groupSize > 1) {
      if (n === 0) return { type: "seekPercent", percent: 0 };
      return n <= ctx.groupSize ? { type: "item", index: n - 1 } : null;
    }
    return { type: "seekPercent", percent: n * 10 };
  }
  return null;
};

/**
 * 连按 Esc 关闭播放器：第一下到第二下的最长间隔（毫秒）。
 *
 * 为什么不是按一下就关：Esc 是最顺手的「取消」键，又是浏览器退出全屏的键——
 * 用户退出全屏后习惯性再按一下，或在别处想取消什么时鼠标刚好停在播放窗上，都会把正在看的视频关掉。
 * 所以第一下只「上膛」（界面提示再按一次），窗口内第二下才真关。
 */
export const ESC_CLOSE_WINDOW_MS = 1500;

/**
 * 退出全屏之后的缓冲（毫秒）：这段时间内的 Esc 一律不算，也不上膛。
 * 不确定浏览器在「Esc 退出全屏」时会不会把这次 keydown 也交给页面（交了的话，状态已经是非全屏，
 * 会被当成第一下）；留一段缓冲，「退出全屏 → 习惯性再按一下」就不会连上第二下关掉播放器。
 */
export const ESC_AFTER_FULLSCREEN_GRACE_MS = 800;

export interface EscapeCloseContext {
  /** 当前时间（毫秒，与 armedAt / fullscreenExitedAt 同一时钟，组件里用 performance.now()） */
  now: number;
  /** 上一次「第一下」的时间；null = 没上膛 */
  armedAt: number | null;
  /** 播放器正处于全屏：Esc 归浏览器（退出全屏），这里不处理 */
  fullscreen: boolean;
  /** 最近一次退出全屏的时间；null = 没有过 */
  fullscreenExitedAt: number | null;
  /** 播放窗里的倍速 / 「更多」菜单开着：Esc 归菜单（关菜单），不能顺手把整个播放器关了 */
  menuOpen: boolean;
  /** 页面上有模态弹窗（确认框 / 输入框 / 设置…）开着：Esc 归它 */
  modalOpen: boolean;
}

/**
 * - `pass`：什么都不做（不是 Esc / 输入法组字中 / 带修饰键 / 长按产生的重复帧——长按不能自己连按成两下）
 * - `reset`：Esc 该归别人处理，清掉上膛状态，不关
 * - `arm`：第一下，上膛并提示「再按一次 Esc 关闭」
 * - `close`：窗口内的第二下，关闭播放器
 */
export type EscapeCloseDecision = "pass" | "reset" | "arm" | "close";

/** Esc 要不要关播放器（纯函数：组件只负责按结果执行；不吞事件，Esc 照样继续传给侧栏 / 菜单等） */
export const decideEscapeClose = (
  e: ShortcutEventLike & { repeat?: boolean },
  ctx: EscapeCloseContext,
): EscapeCloseDecision => {
  if (e.key !== "Escape") return "pass";
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return "pass";
  if (e.repeat) return "pass";
  if (ctx.fullscreen || ctx.menuOpen || ctx.modalOpen) return "reset";
  if (ctx.fullscreenExitedAt !== null && ctx.now - ctx.fullscreenExitedAt < ESC_AFTER_FULLSCREEN_GRACE_MS) {
    return "reset";
  }
  if (ctx.armedAt !== null && ctx.now >= ctx.armedAt && ctx.now - ctx.armedAt <= ESC_CLOSE_WINDOW_MS) {
    return "close";
  }
  return "arm";
};

/** 倍速档位里往上 / 往下走一档；当前值不在档位上时取最近的下一档；到头不动 */
export const stepRate = (current: number, dir: 1 | -1): number => {
  const list = RATES as readonly number[];
  if (dir === 1) return list.find((r) => r > current + 1e-6) ?? list[list.length - 1]!;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]! < current - 1e-6) return list[i]!;
  }
  return list[0]!;
};
