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
 * - **停止跟随** = 用户主动上滚**意图**（滚轮 / 触摸 / 键盘 / 拖滚动条），跟距离无关
 * - **恢复跟随** = 用户**往下翻**的输入 + 这一帧确实朝底部走 + 已进贴底带（距底 <= FOLLOW_PIN_THRESHOLD）
 * 内容增高、程序化滚动既不是用户意图、也不能恢复跟随，所以再也不会影响跟随态。
 *
 * 2026-10-12 补（用户实测「在底部往回滚一点点，它会自己弹回底部去」）。浏览器里逐帧复现、
 * 逐项消融、读 Virtuoso 源码，找到**四条互相独立**的「把人拉回底部」的路径——缺一条没修都还会弹：
 * 1. **恢复跟随被滚动动画的后续帧骗了**：浏览器把一次上滚（键盘 ↑ / 滚轮一格）拆成十来帧平滑动画、
 *    每帧一个 scroll 事件，意图只被第一帧消费；起步几帧离底只有几 px、落在 48px 贴底带里，
 *    旧规则「距底 <= 48 就恢复」当它们是「用户滚回了底部」——跟随态当场翻回 true
 *    （实测 ArrowUp 后第二帧就恢复、200ms 内回到距底 0）。→ nextFollowing：恢复必须有用户往下翻的输入。
 * 2. **Virtuoso 自己的「内容增高就贴底」**：不问我们的跟随态、只看它的 atBottomState。
 *    → VIRTUOSO_NEVER_AT_BOTTOM。
 * 3. **Virtuoso 的「向上滚动补偿」**：用户上滚后内容在下方增长，它会 scrollBy(+增长量) 把 scrollTop
 *    往下推（实测 +28px）——只看「scrollTop 变大」的状态机会把它读成用户在往底部走。
 *    → 同 1：没有用户往下翻的输入就不恢复。
 * 4. **Virtuoso 的 scrollToIndex 重试链**：每次 scrollToIndex 都会盯着列表 150ms，期间只要列表又变了
 *    （流式时每 80ms 一次）就重新滚一遍、再盯 150ms——内容在长，链就永远不会自己结束。
 *    用户上滚后我们早已不再发起贴底，链却还在每 ~100ms 一次 scrollTo 把人拉回底部
 *    （实测同一次滚轮输入，有的次数停在原处、有的次数被拉回，取决于上滚那一刻链是否还活着）。
 *    链没有取消接口，而起点有两个：我们自己的 scrollToIndex 贴底，以及 Virtuoso 的 followOutput
 *    （条数变化时它自己 scrollToIndex——流式第一个 chunk 让条数 +1 就会触发；函数形式下
 *    跟不跟只看返回值、跟 isAtBottom 无关）。
 *    → 两个起点一起拆：跟随的贴底不再经过 scrollToIndex（控制器直接写 scrollTop、自己复查，
 *    可取消、用户一上滚就停，见 hooks/use-stream-follow），也不再给 Virtuoso 传 followOutput。
 *
 * 只放纯函数：DOM 事件接线在 hooks/use-stream-follow.ts。
 */

/**
 * 距底多少像素以内算「贴底」（恢复跟随的判定线；**不**喂给 Virtuoso——原因见下面的
 * VIRTUOSO_NEVER_AT_BOTTOM）。
 * - 太小：亚像素 / 页面缩放下几乎回不到跟随态
 * - 太大：用户往下滚时被过早吸回跟随——老实现 120px 的病
 * 48px ≈ 两行正文：够容忍误触和亚像素。它只管「往下滚进这条线才恢复」；
 * 没有往下翻的输入、或者不是朝底部走，离底多近都不会恢复（nextFollowing）。
 */
export const FOLLOW_PIN_THRESHOLD = 48;

/**
 * 「往下翻」输入的有效期（毫秒）：覆盖浏览器平滑滚动动画（键盘 End / 点滚动条轨道翻页
 * 可持续数百毫秒）+ 余量。意图只在这段时间内能让「进入贴底带」恢复跟随。
 */
export const DOWN_INTENT_TTL_MS = 1000;

/**
 * 喂给 Virtuoso `atBottomThreshold` 的值：**永远不算「在底部」**。
 *
 * Virtuoso 有两条不问我们跟随态的自动贴底，都拿它自己的 atBottomState 当闸门：
 * - 「列表原本在底部带内、因内容增高掉出带外」（notAtBottomBecause === "SIZE_INCREASED"）
 *   → 自己 scrollToIndex("LAST")；
 * - 「视口变矮」（"VIEWPORT_HEIGHT_DECREASING"）→ 同上。
 * 底部带只要是个正数，用户往回滚 <= 带宽就仍在带内，下一个 chunk 撑高内容就被拽回——
 * 带给 48px 时实测滚轮上滚 30px 后 49ms 弹回，而此刻我们的跟随态明明是 false；
 * 收窄到 4px 也不行：用户的上滚帧恰好和内容增长同帧时仍会触发，且一旦触发就自己续命（见文件头第 4 条）。
 *
 * -Infinity 让 atBottom 恒为 false；Virtuoso 的 atBottomState 只在 atBottom 翻转时才发值，
 * 于是它再也不发值、上面两条路径一起关死。
 * 副作用：Virtuoso 的 isAtBottom 恒为 false（我们不用它）；视口变矮时的贴底改由
 * 控制器的 ResizeObserver 接手，并受跟随态闸门约束。
 */
export const VIRTUOSO_NEVER_AT_BOTTOM = Number.NEGATIVE_INFINITY;

/**
 * 控制器贴底后要「连续贴着」几帧才算稳了：写完 scrollTop，Virtuoso 才渲染新露出的项、
 * 测量真实高度、总高变化——距底会在滞后几帧后又被拉开，一次贴底不够。
 */
export const PIN_SETTLE_STABLE_FRAMES = 3;

/**
 * 一次贴底请求最多盯多少帧（约 0.5s）：内容一直在长时不无限续命，
 * 盯完靠下一个 chunk / 下一次渲染重新发起。
 */
export const PIN_SETTLE_MAX_FRAMES = 30;

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
  /** 刚刚（DOWN_INTENT_TTL_MS 内）有没有用户「往下翻」的输入 */
  userIntentDown: boolean;
  /** 本次 scroll 相对上一次 scroll 的 scrollTop 变化：> 0 朝底部、< 0 朝顶部、0 没动 */
  scrollDelta: number;
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
 *
 * 恢复跟随要三样同时成立：**用户刚往下翻过 + 这一帧确实朝底部走 + 已进贴底带**。
 * 只看几何会被程序化滚动骗：Virtuoso 的「向上滚动补偿」、重试贴底、prepend 锚定都会让
 * scrollTop 变大——它们也「朝底部、进了贴底带」，却不是用户想回底部（见文件头 2026-10-12）。
 * 没动（0）也不算朝底部——亚像素下相邻帧可能同值。
 */
export const nextFollowing = (prev: boolean, input: FollowInput): boolean => {
  const pin = input.pinThreshold ?? FOLLOW_PIN_THRESHOLD;
  if (input.userIntentUp) return false;
  if (
    input.userIntentDown &&
    input.scrollDelta > 0 &&
    input.distanceFromBottom <= pin
  ) {
    return true;
  }
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

/**
 * 头部整体变化的增量：**尾部没动、总数却变多** = 多出来的那些在头部（整体重拉 / 回退对齐 / 头部补页），
 * 不是用户没看到的新内容。调用方把它当作 prependDelta 的下限同步抬高基线（取 max、别和 loadEarlier 的显式增量相加：
 * 上拉分页同时满足两者，相加会让基线欠下一截）。
 *
 * 为什么需要（2026-10-23 用户反馈「切 effort 点确定后右边冒出 99+ 条新内容、内容区滚到很早的位置」）：
 * 只比总数差，任何让头部突然变长的路径（mutation 响应整体替换本地窗口等）都会被算成「几百条新内容」。
 * 回退对齐的根因已在 task-store.truncateForRewind 修掉，这里是兜底：以后别的路径再让头部变长，也不会误报。
 *
 * tailId = 最后一个内容单元的稳定身份（工作过程组取最后一个成员——否则长 action 里新增成员时尾 id 不变、会被当成头部变化）；
 * 任一侧为 null（空列表）不判定。
 */
export const headGrowthWithoutNewTail = (
  prev: { count: number; tailId: string | null },
  count: number,
  tailId: string | null,
): number =>
  tailId !== null && tailId === prev.tailId && count > prev.count
    ? count - prev.count
    : 0;

/** 基线到当前条数的差值（负数夹到 0） */
export const countNewItems = (baseline: number, itemCount: number): number =>
  Math.max(0, itemCount - baseline);

/**
 * 「N 条新内容」的完整状态（回到最新按钮）：**尾锚点**优先、条数基线兜底。
 *
 * - `anchorId`：用户离开底部那一刻，**最后一个内容单元**的稳定身份。之后 N = 该单元**之后**有几个单元——
 *   任何头部变化（整体重拉 / 回退对齐 / 上拉分页）都改不动它，哪怕同一次渲染里头部变长、尾部也来了新内容
 *   （评审 N2：RC3 的 headGrowthWithoutNewTail 只管「尾没动」，这种情形仍会报 99+）。
 * - 锚点找不到（它所在的块被合并进别的块 / 被回退裁掉）：退回条数基线（nextNewItemsBaseline + 头部增量兜底），
 *   并**立刻重新落锚**到「新内容之前的那一个单元」——之后又是锚点计数，不会一直靠条数差。
 * - `lastCount` / `lastTailId`：上一帧的快照，给 headGrowthWithoutNewTail 判「尾没动而总数变多」用。
 *
 * 幂等：同一输入重复推进结果不变（渲染期写 ref + StrictMode 双渲）——第二次进来锚点已落在第一次算出的位置。
 */
export interface NewItemsTracker {
  baseline: number;
  anchorId: string | null;
  lastCount: number;
  lastTailId: string | null;
}

export const initNewItemsTracker = (ids: readonly string[]): NewItemsTracker => {
  const tailId = ids.length > 0 ? ids[ids.length - 1]! : null;
  return { baseline: ids.length, anchorId: tailId, lastCount: ids.length, lastTailId: tailId };
};

export const advanceNewItemsTracker = (
  prev: NewItemsTracker,
  /** 当前全部内容单元的稳定身份，按时间顺序（工作过程组已按成员摊开） */
  ids: readonly string[],
  following: boolean,
  /** 非跟随态下 loadEarlier 头部 prepend 的条数（锚点丢了才会用到） */
  prependDelta = 0,
): { tracker: NewItemsTracker; newCount: number } => {
  const count = ids.length;
  const tailId = count > 0 ? ids[count - 1]! : null;
  // 跟随中：最新内容就在眼前，一切跟平
  if (following) {
    return { tracker: initNewItemsTracker(ids), newCount: 0 };
  }
  const anchorAt = prev.anchorId === null ? -1 : ids.lastIndexOf(prev.anchorId);
  if (anchorAt >= 0) {
    const newCount = count - 1 - anchorAt;
    return {
      tracker: {
        baseline: count - newCount,
        anchorId: prev.anchorId,
        lastCount: count,
        lastTailId: tailId,
      },
      newCount,
    };
  }
  // 锚点丢了：条数基线兜底，再重新落锚
  const growth = headGrowthWithoutNewTail(
    { count: prev.lastCount, tailId: prev.lastTailId },
    count,
    tailId,
  );
  const baseline = nextNewItemsBaseline(
    prev.baseline,
    count,
    false,
    Math.max(prependDelta, growth),
  );
  const newCount = countNewItems(baseline, count);
  const anchorIdx = count - 1 - newCount;
  return {
    tracker: {
      baseline,
      anchorId: anchorIdx >= 0 ? ids[anchorIdx]! : null,
      lastCount: count,
      lastTailId: tailId,
    },
    newCount,
  };
};

/** 键盘上翻键：焦点落在列表内某个按钮上时按这些键也会把列表往上滚 */
const UP_INTENT_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "PageUp",
  "Home",
]);

export const isUpIntentKey = (key: string): boolean => UP_INTENT_KEYS.has(key);

/** 滚轮：deltaY < 0 = 往上翻 */
export const isUpIntentWheel = (deltaY: number): boolean => deltaY < 0;

/** 手势（滚轮 / 触摸 / 键盘）目标沿 parentElement 向上走时只需要的几何字段（单测用假对象、运行时是 HTMLElement） */
export interface ScrollAncestorLike {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  parentElement: ScrollAncestorLike | null;
}

/**
 * 这次**上滚**手势（滚轮 / 触摸下拖 / ↑ PageUp Home）其实不会让外层事件流滚动吗——是的话不该登记「用户上滚」意图。
 * 三条输入路径共用本判断（评审 R3：触摸 / 键盘路径此前未对称过滤）：滚轮传 WheelEvent 本身，
 * 触摸传 {deltaX: 横向位移, deltaY: -纵向位移}（手指下拖 = 内容上滚 = deltaY 为负），键盘传 {deltaY: -1}。
 *
 * 为什么要排除（2026-10-23 评审 N1，「点确定前 following 就已经是 false」的一个成因）：
 * 意图位只在**外层** scroll 事件里被消费；滚轮事件却会从内层冒泡到外层监听器。两类滚轮外层根本不滚：
 *  1. **横向为主**（触控板左右滑、shift+滚轮）——`deltaY` 常带小负数；
 *  2. **被嵌套可滚区吃掉**（工具输出框 / 代码块 / 表格，内层 scrollTop > 0 时上滚先滚内层）。
 * 意图没人消费、残留 UP_INTENT_TTL_MS；这期间流式的贴底写会引出外层 scroll 事件，意图被它消费 →
 * 被当成「用户上滚」把跟随关掉——用户明明停在底部、什么都没滚。
 *
 * 只处理**上滚**方向：这是会误关跟随的那个方向，而且判「内层还能往上滚」只需 `scrollTop > 0`，
 * 不用读 overflow 样式（overflow:hidden 的元素 scrollTop 恒为 0）。往下方向不做同类排除——
 * 内层「还能往下滚」得读 overflow 才判得准，而漏掉一次往下意图只是少一次恢复跟随的机会、不会误关。
 *
 * 刻意**不改** onScroll 里「意图被任意 scroll 消费」的语义：Virtuoso 向上补偿的 scrollBy(+28) 可能和用户的一次小幅
 * 上滚合并成同一个 scroll 事件（净 delta 为正），按 delta 方向丢意图会把真上滚吞掉、人被贴底拽回（老的「一滚就抖」）。
 *
 * target 缺失（单测里派发的假事件）→ 只做横向判断。
 */
export const isUpScrollHandledElsewhere = (
  e: { deltaX?: number; deltaY: number },
  target: ScrollAncestorLike | null | undefined,
  scroller: unknown,
): boolean => {
  if (Math.abs(e.deltaX ?? 0) > Math.abs(e.deltaY)) return true;
  for (let el = target ?? null; el && el !== scroller; el = el.parentElement) {
    if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) return true;
  }
  return false;
};

/**
 * 触摸：手指相对起点往**下**拖（clientY 变大）= 内容往下走 = 在看更早的内容。
 * 给 2px 死区、过滤点击时的轻微抖动。
 */
export const isUpIntentTouch = (touchMoveDeltaY: number): boolean =>
  touchMoveDeltaY > 2;

/** 键盘下翻键：对称于 UP_INTENT_KEYS，用来认「用户想回到底部」 */
const DOWN_INTENT_KEYS: ReadonlySet<string> = new Set([
  "ArrowDown",
  "PageDown",
  "End",
]);

export const isDownIntentKey = (key: string): boolean =>
  DOWN_INTENT_KEYS.has(key);

/** 滚轮：deltaY > 0 = 往下翻 */
export const isDownIntentWheel = (deltaY: number): boolean => deltaY > 0;

/** 触摸：手指相对起点往**上**拖（clientY 变小）= 内容往上走 = 朝最新内容去；同样 2px 死区 */
export const isDownIntentTouch = (touchMoveDeltaY: number): boolean =>
  touchMoveDeltaY < -2;

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

// ---------- 「回到最新」的平滑滚动（2026-10-17「全是大动作」） ----------
//
// 点「回到最新」/ Cmd+End 原来是下一帧直接把 scrollTop 写成 scrollHeight——离底部几屏远时画面
// 啪地一下换了个世界，用户丢了上下文。改成短缓动：控制器自己逐帧写 scrollTop（不用浏览器的
// behavior:smooth——流式期间内容还在长，原生平滑滚动的目标是点击那一刻的值，落地后又差一截，
// 还会被我们自己的贴底写入打断），每帧**重新读**当前最大可滚位置当终点，内容在长也追得上。
//
// 离得太远（超过 SMOOTH_BOTTOM_MAX_VIEWPORTS 个视口）不做动画：几千像素的「滑行」本身就是
// 一个长达半秒的大动作，直接跳（Slack / Discord 同款取舍）。离得太近（贴底带内）更不用动。

/** 超过这么多个视口高度的距离直接跳、不做滑行 */
export const SMOOTH_BOTTOM_MAX_VIEWPORTS = 3;
/** 滑行时长下限 / 上限（毫秒）：近的快、远的稍慢，但都压在「一眨眼」的量级 */
export const SMOOTH_BOTTOM_MIN_MS = 180;
export const SMOOTH_BOTTOM_MAX_MS = 360;

/** 这次回到最新要不要做滑行动画 */
export const shouldAnimateScrollToBottom = (
  distance: number,
  clientHeight: number,
  reducedMotion: boolean,
): boolean =>
  !reducedMotion &&
  distance > FOLLOW_PIN_THRESHOLD &&
  distance <= clientHeight * SMOOTH_BOTTOM_MAX_VIEWPORTS;

/** 滑行时长：随距离（以视口高度为单位）线性加长，夹在 [MIN, MAX] */
export const smoothBottomDuration = (
  distance: number,
  clientHeight: number,
): number => {
  const viewports = distance / Math.max(clientHeight, 1);
  return Math.min(
    SMOOTH_BOTTOM_MAX_MS,
    Math.max(SMOOTH_BOTTOM_MIN_MS, SMOOTH_BOTTOM_MIN_MS + viewports * 60),
  );
};

/** easeOutCubic：起步快、收尾慢——「甩过去再轻轻落地」 */
export const easeOutCubic = (progress: number): number => {
  const p = Math.min(1, Math.max(0, progress));
  return 1 - (1 - p) ** 3;
};

/** 滑行第 elapsed 毫秒时该写的 scrollTop（终点 target 每帧由调用方重读） */
export const smoothBottomTop = (
  from: number,
  target: number,
  elapsed: number,
  duration: number,
): number =>
  from + (target - from) * easeOutCubic(duration <= 0 ? 1 : elapsed / duration);
