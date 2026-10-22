/**
 * 发送失败恢复时与「发送期间新敲的内容」合并（纯函数；第二轮 review V5-01）
 *
 * 发送条乐观提交：先快照 + 秒清输入框，再 POST；失败才把快照放回去。
 * 旧版 POST 期间编辑器是锁灰的，输入框必为空、恢复可以整个覆盖。
 * V5-01 起编辑器不再锁——POST 飞行的一两分钟里用户可能已经敲了下一句、贴了新图，
 * 失败恢复若整个覆盖，新敲的内容就丢了。规则：被恢复的原文放前、新内容接后，一个字都不丢。
 */

import {
  restoreOptimisticDraft,
  type PendingUploadImage,
} from "./optimistic-submit";
import type { RichInputPayload } from "./rich-input-payload";

/** 文本：输入框空 → 原文；原文空 → 新内容；两边一样 → 不重复；否则 原文 + 换行 + 新内容 */
export const mergeRestoredText = (restored: string, current: string): string => {
  if (!current.trim()) return restored;
  if (!restored.trim()) return current;
  if (current === restored) return restored;
  return `${restored.replace(/\s+$/, "")}\n${current}`;
};

/** 路径 / 图片：恢复项在前、当前已有的在后，按 key 去重保序，超上限从后面截断（恢复项优先保住） */
export const mergeRestoredList = <T>(
  restored: readonly T[],
  current: readonly T[],
  keyOf: (item: T) => string,
  max: number,
): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of [...restored, ...current]) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
};

export interface MergedRestoreSinks {
  /** 编辑器正文（updater 形式：基于「此刻」的内容合并，不是闭包里的陈旧值） */
  setValue: (updater: (current: string) => string) => void;
  /** 此刻的路径附件（读最新值，不能是发送那一刻闭包里的） */
  currentPaths: () => readonly string[];
  /** 此刻的图片附件 */
  currentImages: () => readonly PendingUploadImage[];
  replacePaths: (paths: string[]) => void;
  replaceImages: (images: PendingUploadImage[]) => void;
  maxPaths: number;
  maxImages: number;
}

/**
 * 乐观提交失败后的恢复：正文 + 路径 + 图片，一律与「发送期间新敲的内容」合并而不是覆盖
 * （第三轮 review R5-01：chat 输入岛原先整体覆盖，飞行中敲的下一句 / 贴的图 / 拖的文件被快照吞掉）。
 *
 * 与 task 说话条（task-talk-composer.handleSubmit）同一套规则，只是把「读最新值」的接线抽成纯函数，
 * 便于在 node 里写行为测试。图片按 base64 内容去重（同一张图重复贴不堆叠）。
 */
export const restoreDraftMerged = (
  p: RichInputPayload,
  sinks: MergedRestoreSinks,
): void =>
  restoreOptimisticDraft(
    p,
    (t) => sinks.setValue((cur) => mergeRestoredText(t, cur)),
    (paths) =>
      sinks.replacePaths(
        mergeRestoredList(paths, sinks.currentPaths(), (x) => x, sinks.maxPaths),
      ),
    (imgs) =>
      sinks.replaceImages(
        mergeRestoredList(imgs, sinks.currentImages(), (i) => i.data, sinks.maxImages),
      ),
  );
