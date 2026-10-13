/**
 * 事件流的「回合节奏」：每一条 item 上方留多少空白。
 *
 * 为什么单拎成纯函数：节奏是靠「几档间距之间的相对关系」读出来的——AI 说了一句话和它接着干的活
 * 要读成一组，下一段话要读成新的一组。这几档数值原来是 JSX 里的两层嵌套三元（chat / log 各一套），
 * 想看「组内到底比组间小多少」得心算，改的时候也没有任何东西拦着「改着改着整列又等距了」。
 *
 * 2026-10-12 用户反馈「右边时间流每条之间看着都没间隔了、分辨力太低」，实测（task 样本、1440 宽、
 * 文字到文字的间距）：
 * - 旧：说话 → 工作过程 19px、工作过程 → 下一条说话 27px，比值 1.42——整列几乎等距；
 *   「你的回答」卡 → 工作过程是 26px，跟 27px 也分不出来。
 * - 新：15px / 39px，比值 2.60。拉开的办法是**把组间拉大、把组内收紧**（不是整体放大）：
 *   对话档 pt-4/pt-6 → pt-7，紧跟对话的过程行 pt-2 → pt-1。
 *
 * chat 与 task(log) 用同一套数值（用户拍板「task 和 chat 保持一致」）：task 栏比 chat 窄，
 * 更需要靠间距分组——窄栏里没有左右留白可以用来分隔。只有「列表第一条」「最后一条」的
 * 首尾留白按形态区分（chat 窄列居中、首尾要给呼吸感）。
 */

export type RhythmVariant = "chat" | "log";

/** 节奏档：决定这一条上方留多少空白 */
export type RhythmTier =
  /** 列表第一条：只管离顶部的呼吸，不是「组间」 */
  | "first"
  /** 对话类（AI 回复 / 用户消息 / 流式回复 / 提问）：一段新的话开头，组间间距 */
  | "conversation"
  /** 紧跟在对话后面的过程行（工作过程组 / 工具块）：「说了一句 + 接着干的活」，组内、紧贴 */
  | "process-after-talk"
  /** 紧跟在对话后面的卡片（回执 / 错误 / 通知）：自带边框和底色，不能像过程行那样贴着上文 */
  | "card-after-talk"
  /** 其余：连续的过程行 / 卡片，堆叠成一组 */
  | "process";

/** 一条 item 对节奏有意义的两个事实（由调用方从自己的 item 类型里算出来） */
export interface RhythmFacts {
  /** 对话类：AI 回复 / 用户消息 / 流式 / 待发送气泡 / 提问 */
  talk: boolean;
  /** 过程层的「行」：工作过程组 / 工具块 / 工具动词组（折叠态只有一行小字） */
  process: boolean;
}

/**
 * 算一条 item 的节奏档。
 * 优先级：第一条 > 对话 > 紧跟对话（再分过程行 / 卡片） > 其余。
 *
 * @param index 在列表里的下标（0 = 第一条）
 * @param item 这一条的事实
 * @param prev 上一条的事实（第一条没有）
 */
export const rhythmTier = (
  index: number,
  item: RhythmFacts,
  prev: RhythmFacts | null,
): RhythmTier => {
  if (index === 0) return "first";
  if (item.talk) return "conversation";
  if (prev?.talk) return item.process ? "process-after-talk" : "card-after-talk";
  return "process";
};

/**
 * 节奏档 → padding-top 类名。
 * 类名必须是完整字面量（Tailwind 靠扫源码里的整串生成 CSS，拼接的类名不会被生成）。
 */
export const rhythmPaddingTop = (
  variant: RhythmVariant,
  tier: RhythmTier,
): string => {
  switch (tier) {
    case "first":
      return variant === "chat" ? "pt-6" : "pt-4";
    case "conversation":
      return "pt-7";
    case "process-after-talk":
      return "pt-1";
    case "card-after-talk":
      return "pt-2";
    case "process":
      return "pt-0.5";
  }
};

/** 最后一条的底部留白（给输入框 / 悬浮按钮留出呼吸；chat 窄列居中、比 log 大一档） */
export const rhythmPaddingBottom = (variant: RhythmVariant): string =>
  variant === "chat" ? "pb-6" : "pb-4";
