/**
 * 飞书卡片 2.0 全局 `config` 的公共部分——**我们发的每一张卡都从这里取**，别再手写。
 *
 * - `update_multi: true`：共享卡（所有人看到同一份、可被后续更新）；流式更新与按钮回写都要求它为 true。
 * - `width_mode: "fill"`：宽度自适应、撑满窗口。飞书不设时默认 `default`（宽度不超过约 600px、
 *   不随窗口变宽）；另一个值 `compact` 约 400px。2026-11-06 用户拍板「改成自适应」，
 *   所以每张卡都显式设成 `fill`（普通回复 / 流式 / 推进 / 提问 / 会话列表 / 分享 / 控制卡都一样）。
 *
 * 更新卡片 settings（开 / 关 `streaming_mode`）的 PATCH 也要带上同一份：官方示例的 config 里就带
 * `width_mode`，带上对「增量更新」没副作用，万一飞书按「整份替换」处理，收尾那一下卡片也不会回弹成窄的。
 *
 * 本文件刻意零依赖（纯常量），谁都可以 import，不会引入循环依赖。
 */

/** 卡片宽度模式：撑满窗口（自适应）。 */
export const CARD_WIDTH_MODE = "fill" as const;

/** 所有卡片 config 的公共部分；用法 `config: { ...CARD_BASE_CONFIG, summary: … }`。 */
export const CARD_BASE_CONFIG = {
  update_multi: true,
  width_mode: CARD_WIDTH_MODE,
} as const;
