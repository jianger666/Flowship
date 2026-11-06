/**
 * 需求群弹窗里「群里 AI 的回复方式」三选一：跟随全局 / 流式 / 整条发送。
 *
 * 存储是 `task.feishuGroupStreaming`（`true` / `false` / 缺省）：缺省 = 跟随设置页的全局「流式回复」。
 * 这里只放「UI 三态 ↔ 存储值」的换算与文案，纯函数、前后端都能引，单测不用渲染组件。
 */

export type GroupStreamingChoice = "follow" | "on" | "off";

/** 存储值 → UI 选项（缺省 / 非布尔一律当「跟随全局」） */
export const groupStreamingChoiceOf = (
  value: boolean | undefined | null,
): GroupStreamingChoice =>
  value === true ? "on" : value === false ? "off" : "follow";

/** UI 选项 → 要写给服务端的值（跟随全局 = null，服务端据此清掉覆盖） */
export const groupStreamingValueOf = (
  choice: GroupStreamingChoice,
): boolean | null => (choice === "on" ? true : choice === "off" ? false : null);

export const GROUP_STREAMING_OPTIONS: ReadonlyArray<{
  choice: GroupStreamingChoice;
  label: string;
  hint: string;
}> = [
  {
    choice: "follow",
    label: "跟随全局",
    hint: "看设置页「飞书集成」里的「流式回复」开关。",
  },
  {
    choice: "on",
    label: "流式",
    hint: "群里 AI 的回复边写边出现，写完整张卡换成终稿。",
  },
  {
    choice: "off",
    label: "整条发送",
    hint: "AI 写完后一次性发到群里。",
  },
];
