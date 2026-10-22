/**
 * 推进弹窗「关闭意图」的裁决（纯函数、可单测；client / server 都能 import）
 *
 * 背景（第二轮 review V6-03）：推进提交中「取消」被禁用，但 Esc / X 仍能关弹窗——
 * 关闭即 `rich.reset()` 清掉指令 + 附件；随后失败的 toast 指向一个已不在的弹窗，再打开还挂陈旧错误条。
 *
 * 口径与 ShareToGroupDialog（`if (sharing) return`）一致：**提交中不可关**。
 * 失败后弹窗本来就不关（planAdvanceUi 契约：失败不关、不清预填），所以只要提交中不可被关掉，
 * 失败态草稿自然保住——`rich.reset` 只挂在 `open` 变 false 的 effect 上，没有关闭就没有 reset。
 */

export type AdvanceDialogOpenChangeDecision =
  /** 提交中：吞掉这次关闭意图 */
  | "block"
  /** slash / `@` 菜单开着时的 Esc 归菜单：只关菜单，弹窗留着（避免一按 Esc 连草稿一起关没） */
  | "close-menu"
  /** 照常交给上层 onOpenChange */
  | "pass";

export const resolveAdvanceDialogOpenChange = (input: {
  /** base-ui 传来的目标开关态：false = 想关 */
  next: boolean;
  /** base-ui 的变更原因（"escape-key" / "close-press" / "outside-press" / …） */
  reason: string | undefined;
  /** 推进请求是否在飞 */
  submitting: boolean;
  /** slash / `@` 菜单当前是否开着 */
  menuOpen: boolean;
}): AdvanceDialogOpenChangeDecision => {
  // 打开永远放行
  if (input.next) return "pass";
  // 守卫排在菜单分支之前：提交中任何关闭意图都不处理（也不去碰菜单）
  if (input.submitting) return "block";
  if (input.reason === "escape-key" && input.menuOpen) return "close-menu";
  return "pass";
};
