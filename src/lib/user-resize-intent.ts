/**
 * 「用户真的在拖分栏」意图记录（第三轮 R9a-03）
 *
 * 背景：react-resizable-panels 在挂载 / ResizeObserver 重算后也会触发 `onLayoutChanged`，
 * 页面原先只要拿到有效的产物栏比例就 500ms 后写回 meta——窄窗口打开一个任务，
 * 用户当初拖出来的 70/30 就被「窗口校准后的值」（如 54%）永久覆盖，回到大屏也回不去。
 * 现在只有「分隔条上刚发生过指针按下 / 键盘操作」才认为是用户意图、才写回；其余（挂载、窗口缩放）一律不写。
 *
 * 纯逻辑 + 注入时间，可在 node 测：
 *  - 指针：按下起一直算活跃，直到松开后再留一个短窗口（库在松开后才触发 onLayoutChanged）；
 *  - 键盘：操作后留同样的短窗口（方向键调整是同步触发 onLayoutChanged）。
 */

/** 松开 / 按键之后仍认为是用户意图的窗口（毫秒）：覆盖库在 pointerup 后派发 onLayoutChanged 的延迟 */
export const USER_RESIZE_GRACE_MS = 300;

export interface UserResizeIntent {
  pointerDown: () => void;
  pointerUp: (now: number) => void;
  key: (now: number) => void;
  isActive: (now: number) => boolean;
}

export const createUserResizeIntent = (
  graceMs: number = USER_RESIZE_GRACE_MS,
): UserResizeIntent => {
  let pointerHeld = false;
  let activeUntil = 0;
  return {
    pointerDown: () => {
      pointerHeld = true;
    },
    pointerUp: (now) => {
      if (!pointerHeld) return;
      pointerHeld = false;
      activeUntil = now + graceMs;
    },
    key: (now) => {
      activeUntil = now + graceMs;
    },
    isActive: (now) => pointerHeld || now < activeUntil,
  };
};

/**
 * 这次 pointerdown 算不算「用户真的开始拖分栏」（Q8-01）。
 *
 * 旧判据只看 `e.target` 是不是分隔条，与库的命中区口径不一致：
 *  - 库把每个分隔条的命中区扩到 resizeTargetMinimumSize（fine 10px / coarse 20px），分隔条自身只有 6px，
 *    落在外圈 ±(4,5]px 死带里时库已经 `preventDefault` 并开始拖了，`e.target` 却是相邻面板内容 → 这次拖拽不持久化；
 *  - 右键：库对 button>0 直接 return 不拖，旧判据却记成「按下」，macOS 右键菜单吞掉 pointerup → 意图卡在活跃。
 * 新判据：只认主键（button===0）；且「库已接受这次按下」（它在 document 捕获阶段先于页面的 React 根捕获
 * `preventDefault`，所以 `defaultPrevented` 就是库的裁决）或事件目标本身就是分隔条（库没 preventDefault 的版本兜底）。
 */
export const shouldRecordResizePointerDown = (e: {
  button: number;
  defaultPrevented: boolean;
  target: unknown;
}): boolean => e.button === 0 && (e.defaultPrevented || isSeparatorTarget(e.target));

/** 事件目标是不是（或在）分隔条上：库给 separator 渲染 role="separator" */
export const isSeparatorTarget = (target: unknown): boolean => {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return target.closest('[role="separator"]') !== null;
};
