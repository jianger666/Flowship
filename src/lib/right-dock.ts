/**
 * 右侧侧栏「只有一条位」的占位协调（纯模块，无 React，client 端单例）
 *
 * 为什么需要：文件预览、代码改动面板、子代理详情抽屉现在都是贴着右边缘的非模态侧栏（`Sheet`，
 * `fixed inset-y-0 right-0 z-50`），各自管自己的开关状态。互相不知道对方存在的话，同时打开就会叠在一起、
 * 谁后挂载谁在上，用户看到的是两条半遮着的栏。
 *
 * 规则（用户 2026-11-14 拍板）：**后开的替换先开的**。每个侧栏打开时「占位」，别人占位后自己让位（关掉自己）。
 * 这里只存「当前谁占着位」和订阅；「开着就占位 / 别人占了就让位」的 React 接线在 hooks/use-right-dock-slot。
 *
 * 不管的事：模态弹窗（确认框 / 设置 / 推进弹窗）不占位——它们自带蒙层、本来就盖在侧栏上面；
 * 音视频浮窗（media dock）与内置浏览器也不占位，它们不是「右侧一条栏」。
 */

/** 会占右侧那条位的侧栏；新增侧栏时在这里加一个 id */
export type RightDockId = "file-preview" | "changes" | "subagent-detail";

let owner: RightDockId | null = null;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const l of listeners) l();
};

/** 现在谁占着位（null = 没人） */
export const getRightDockOwner = (): RightDockId | null => owner;

/** 占位：已是自己就什么都不做（不重复通知）；别人占着则顶掉它——别人会在订阅回调里让位 */
export const claimRightDock = (id: RightDockId): void => {
  if (owner === id) return;
  owner = id;
  emit();
};

/** 还位：只有现在占着位的就是自己才清空（让位的那一方关自己时，位子已经是别人的，不能把它清掉） */
export const releaseRightDock = (id: RightDockId): void => {
  if (owner !== id) return;
  owner = null;
  emit();
};

/** 订阅占位变化（useSyncExternalStore 的 subscribe）；返回取消订阅 */
export const subscribeRightDock = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * 该不该让位：自己开着、且位子被别人占着。
 * 自己没开不用让（已经关了）；没人占位（null）不用让；占位的是自己也不用让。
 */
export const shouldYieldRightDock = (
  me: RightDockId,
  open: boolean,
  current: RightDockId | null,
): boolean => open && current !== null && current !== me;

/** 仅测试用：清空占位与订阅，保证用例之间互不污染 */
export const __resetRightDockForTest = (): void => {
  owner = null;
  listeners.clear();
};
