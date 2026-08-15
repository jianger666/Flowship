/**
 * 事件流「贴底跟随」判定纯逻辑（2026-07-28 流式滚动手感重构）
 *
 * 背景（用户实测「AI 流式吐字时去滚动会抖动」）：老实现让 Virtuoso 的
 * `atBottomThreshold=120` 同时背两个互相矛盾的职责——
 *   1) 流式最后一项每来一个 chunk 就增高若干像素、阈值太小会被误判成「离开底部」
 *   2) 用户主动往上翻时要停止自动跟随
 * 结果是用户往上滚 50px（< 120px）仍被判「贴底」、下一个 chunk 把他拽回底部，
 * 他再滚又被拽回 = 持续抖动。
 *
 * 这里把两件事拆开、各归各的信号源：
 * - **恢复跟随** = 几何判定（距底 <= FOLLOW_PIN_THRESHOLD）
 * - **停止跟随** = 用户主动上滚**意图**（滚轮 / 触摸 / 键盘 / 拖滚动条），跟距离无关
 * 内容增高既不是几何贴底、也不是用户意图，所以再也不会影响跟随态。
 *
 * 只放纯函数：DOM 事件接线在 hooks/use-stream-follow.ts。
 */

/**
 * 距底多少像素以内算「贴底」（恢复跟随的判定线，同时喂给 Virtuoso 的
 * atBottomThreshold 保持两边口径一致）。
 * - 太小（Virtuoso 默认 4px）：亚像素 / 页面缩放下几乎回不到跟随态
 * - 太大：用户的小幅上滚被无视，就是老实现 120px 的病
 * 48px ≈ 两行正文：够容忍误触和亚像素，又吞不掉真实的「我要往上看」。
 */
export const FOLLOW_PIN_THRESHOLD = 48;

/** 滚动容器几何（只取判定要用的三个值，方便单测构造） */
export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 距底像素（负数夹到 0：橡皮筋回弹 / 亚像素误差都可能算出负值） */
export const distanceFromBottom = (g: ScrollGeometry): number =>
  Math.max(0, g.scrollHeight - g.scrollTop - g.clientHeight);

export interface FollowInput {
  /** 当前距底像素 */
  distanceFromBottom: number;
  /** 本次滚动是不是「用户主动往上翻」造成的 */
  userIntentUp: boolean;
  /** 覆盖贴底阈值（默认 FOLLOW_PIN_THRESHOLD、单测用） */
  pinThreshold?: number;
}

/**
 * 跟随态状态机（唯一判定入口）。
 *
 * 优先级：**用户上滚意图 > 几何贴底**——只要用户主动上滚（不管滚多远）就离开跟随；
 * 滚回底部（距底 <= pin）才恢复。老实现反过来：距离 <= 48px 就强制维持跟随，
 * 用户在底部附近往回滚时意图被无视 → 流式内容一增长就被拽回底部 → 上下抖动
 * （用户实测「往回滚到某些消息时滚动条一直上下抖」）。
 */
export const nextFollowing = (prev: boolean, input: FollowInput): boolean => {
  const pin = input.pinThreshold ?? FOLLOW_PIN_THRESHOLD;
  if (input.userIntentUp) return false;
  if (input.distanceFromBottom <= pin) return true;
  return prev;
};

/**
 * 「离开底部后新追加了几条」计数器的基线推进（回到底部按钮上的「N 条新内容」）。
 *
 * 基线 = 用户离开底部那一刻的条数，之后的差值就是他没看到的新内容。
 * - 跟随中：基线持续跟平当前条数（计数恒 0、离开时天然就是当下这条）
 * - 离开后：基线冻住；但仍取 min——条数变少（切 task / 事件被裁）时基线要跟着降下来，
 *   否则会「欠着一大截」、之后真来了新内容也一直显示 0
 * - 非跟随态下头部 prepend 历史：调用方传入 prependDelta、同步抬高基线，避免历史加载被误计
 *
 * 幂等（同一输入重复跑结果不变），所以可以在渲染期直接写进 ref。
 */
export const nextNewItemsBaseline = (
  prevBaseline: number,
  itemCount: number,
  following: boolean,
  /** 非跟随态下头部 prepend 的历史条数——同步抬高基线，避免被误算成「新内容」 */
  prependDelta = 0,
): number => {
  const base = following ? itemCount : Math.min(prevBaseline, itemCount);
  return following || prependDelta <= 0 ? base : base + prependDelta;
};

/** 基线到当前条数的差值（负数夹到 0） */
export const countNewItems = (baseline: number, itemCount: number): number =>
  Math.max(0, itemCount - baseline);

/** 键盘上翻键：焦点落在列表内某个按钮上时按这些键也会把列表往上滚 */
const UP_INTENT_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "PageUp",
  "Home",
]);

export const isUpIntentKey = (key: string): boolean => UP_INTENT_KEYS.has(key);

/** 滚轮：deltaY < 0 = 往上翻 */
export const isUpIntentWheel = (deltaY: number): boolean => deltaY < 0;

/**
 * 触摸：手指相对起点往**下**拖（clientY 变大）= 内容往下走 = 在看更早的内容。
 * 给 2px 死区、过滤点击时的轻微抖动。
 */
export const isUpIntentTouch = (touchMoveDeltaY: number): boolean =>
  touchMoveDeltaY > 2;

/**
 * 可编辑元素里的按键不算滚动意图——事件流里内联着「编辑上一条消息」的 textarea
 * 和答题卡输入框，在里面按 ↑ / Home 是移动光标、不是翻历史。
 */
export const isEditableTarget = (
  tagName: string,
  isContentEditable: boolean,
): boolean =>
  isContentEditable ||
  tagName === "TEXTAREA" ||
  tagName === "INPUT" ||
  tagName === "SELECT";

/**
 * pointerdown 是否落在原生滚动条槽里。
 * 拖滚动条不产生 wheel / touch 事件，只能靠命中测试认出来：
 * 滚动条画在 padding box 外侧，`offsetX` 超过 clientWidth 就是点在槽上。
 */
export const isScrollbarPointer = (
  offsetX: number,
  clientWidth: number,
): boolean => offsetX > clientWidth;

/**
 * 工作过程组的自动收起要不要被「钉住展开」（2026-07-28、用户实测「自动折叠也感觉怪」）。
 *
 * 组跑完 / 不再是尾组的那一刻本来会自动收起，高度一下少几十上百像素。
 * 用户贴底跟随时无所谓（视线在最新一行、收起只是尾部整理，事件流会立刻重新贴底）；
 * 用户正滚在历史里读这一段时就是灾难——下面的内容整块被顶走。
 *
 * 所以只在「自动展开 → 自动收起」这个下降沿、且用户没在跟随时钉住。
 */
export const shouldPinWorkGroupOpen = (
  prevAutoExpanded: boolean,
  autoExpanded: boolean,
  following: boolean,
): boolean => prevAutoExpanded && !autoExpanded && !following;
