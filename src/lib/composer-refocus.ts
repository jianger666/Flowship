/**
 * 发送返回后要不要把焦点还给编辑器（纯函数；第二轮 review V5-01）
 *
 * 旧：task 说话条整个发送 POST 期间把编辑器锁灰（disabled）、返回后不重新聚焦——
 * 用户得再点一下输入框才能接着打字。现在编辑器不再锁，但「点发送键提交」时焦点在发送键上，
 * 键 disabled 的瞬间浏览器会把焦点掉到 body，返回后同样得手点。
 *
 * 规则（只在不会抢用户焦点时才还）：
 * - 用户已切到别的任务 → 不还（那是另一个任务的输入条）；
 * - 焦点本来就在编辑器 → 不动（重设选区会打断用户正在敲的字）；
 * - 焦点掉到 body / 无焦点，或停在输入条内的按钮（发送键等）上 → 还；
 * - 焦点在别处（侧栏、别的输入框、弹窗）→ 不抢。
 */

/** 只要求有 contains（HTMLElement 满足；方法简写使参数双变、可直接赋值） */
export interface ContainsLike {
  contains(other: unknown): boolean;
}

export interface RefocusProbe {
  /** 发送返回时，这条任务仍是当前任务 */
  sameTask: boolean;
  /** document.activeElement */
  active: unknown;
  /** document.body */
  body: unknown;
  /** 输入条根节点（取不到传 null） */
  root: ContainsLike | null;
  /** 当前焦点已经是编辑器（contenteditable）本身 */
  activeIsEditor: boolean;
}

/** window.getSelection() 的最小形状 */
export interface SelectionLike {
  isCollapsed: boolean;
  toString(): string;
}

/** 页面上有没有「非空选区」：用户正选着一段字（多半是在复制上一条 AI 回复） */
export const hasNonEmptySelection = (
  sel: SelectionLike | null | undefined,
): boolean => !!sel && !sel.isCollapsed && sel.toString().length > 0;

/**
 * 「进入可输入」时的自动聚焦要不要执行（第三轮 review R5-01 ◐）。
 *
 * 受理后 / 一轮说完，输入框从不可输入回到可输入，自动聚焦会把焦点拉进输入框——
 * 用户若正选着上一条 AI 回复要复制，选区会被抢走。所以：
 * - 焦点在右侧抽屉里（正盯着子代理详情）→ 不抢（原有规则）；
 * - 页面上有非空选区 → 不抢。
 * 没有这两种情形才聚焦。
 */
export const shouldAutoFocusComposer = (p: {
  activeInsideSheet: boolean;
  selection: SelectionLike | null | undefined;
}): boolean => !p.activeInsideSheet && !hasNonEmptySelection(p.selection);

export const shouldRefocusComposerAfterSend = (p: RefocusProbe): boolean => {
  if (!p.sameTask) return false;
  if (p.activeIsEditor) return false;
  if (p.active === null || p.active === undefined || p.active === p.body) {
    return true;
  }
  return !!p.root && p.root.contains(p.active);
};
