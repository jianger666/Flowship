/**
 * 播放器快捷键：按键 → 命令（纯函数，组件只负责执行命令）
 *
 * 键位参照 YouTube / 剪辑软件的肌肉记忆：空格 / K 播放，J / L 后退前进 10 秒，← → 5 秒，
 * `,` `.` 逐帧，数字键（有对比组时）切换第几个文件。
 * 带 ⌘ / Ctrl / Alt 的组合一律不处理——留给应用的全局快捷键（⌘K / ⌘B 等）。
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

/** 倍速档位里往上 / 往下走一档；当前值不在档位上时取最近的下一档；到头不动 */
export const stepRate = (current: number, dir: 1 | -1): number => {
  const list = RATES as readonly number[];
  if (dir === 1) return list.find((r) => r > current + 1e-6) ?? list[list.length - 1]!;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]! < current - 1e-6) return list[i]!;
  }
  return list[0]!;
};
