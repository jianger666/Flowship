/**
 * 事件流折叠 / 展开的动效阶段机（2026-10-17「完成后抖一下、全是大动作」）
 *
 * 背景：思考行、工具块、工作过程组「完成 → 自动收起」原来都是 `{collapsed ? null : <body/>}`，
 * 一帧之内整块 body 消失（或整块冒出来），高度瞬间少几十 ~ 上百像素，下面的内容跟着硬跳——
 * 用户实测「自动折叠机制没问题，但页面太生硬、全是大动作」。
 *
 * 做法：高度动画（CSS grid 的 `grid-template-rows: 1fr ↔ 0fr`，不需要量高度）+ 关闭时「先动画、后卸载」。
 * 这个文件只放不碰 DOM 的阶段转移，组件在 components/tasks/event-stream/collapse.tsx。
 *
 * 五个阶段（只有 `open` 是「静止展开」，其余都是过渡中间态）：
 *
 *   closed      未挂载（折叠后的稳定态：body 不在 DOM 里，跟旧行为一致，也不给 Virtuoso 添测量负担）
 *   enter-from  已挂载、高度 0fr 的「起跑线」——必须先画出 0fr 这一帧，下一步变 1fr 才会触发 transition
 *   entering    目标 1fr、过渡进行中
 *   open        1fr 且过渡结束（此时撤掉 overflow:hidden，免得裁掉焦点环 / 阴影）
 *   leaving     目标 0fr、过渡进行中；结束后卸载
 *
 * 两条规矩：
 * 1. **首次挂载不播动画**：Virtuoso 里的行会随滚动反复挂载 / 卸载，滚进视口时已展开的组不能每次「长」出来。
 *    初始阶段 = open / closed，动画只在「已经挂着的行」翻转 open 时出现。
 * 2. **「减少动态效果」直接跳阶段**（open ↔ closed），不走过渡——否则 transition 被 CSS 关掉后
 *    transitionend 永远不来，只能靠兜底定时器收尾。
 */

/** 过渡时长（毫秒）。组件里的 Tailwind 类 `duration-[220ms]` 必须与它同值（有契约测试盯着）。 */
export const COLLAPSE_MOTION_MS = 220;

/**
 * 兜底收尾的额外余量（毫秒）：transitionend 在标签页后台 / 元素被 display:none 时可能不触发，
 * 超过「时长 + 余量」就强制收尾，免得卡在 leaving 里一直占着 DOM。
 */
export const COLLAPSE_END_SLACK_MS = 80;

export type CollapsePhase =
  | "closed"
  | "enter-from"
  | "entering"
  | "open"
  | "leaving";

/** 初始阶段：首次挂载不播动画 */
export const initialCollapsePhase = (open: boolean): CollapsePhase =>
  open ? "open" : "closed";

/**
 * 渲染期同步：把「想要 open / 想要关」翻译成下一个阶段。幂等——同一输入连算多次结果不变，
 * 所以可以直接在渲染里算（StrictMode 双渲染安全）。
 */
export const stepCollapse = (
  phase: CollapsePhase,
  wantOpen: boolean,
  reducedMotion: boolean,
): CollapsePhase => {
  if (wantOpen) {
    switch (phase) {
      case "closed":
        return reducedMotion ? "open" : "enter-from";
      case "leaving":
        // 收到一半又要展开：从当前高度往回长（CSS 过渡自己接着当前计算值走，不会跳）
        return reducedMotion ? "open" : "entering";
      default:
        return phase;
    }
  }
  switch (phase) {
    case "open":
    case "entering":
      return reducedMotion ? "closed" : "leaving";
    case "enter-from":
      // 还没来得及开始就被关了：直接卸载
      return "closed";
    default:
      return phase;
  }
};

/** 起跑线那一帧画完（强制样式计算之后）→ 进入过渡 */
export const collapseOnFrame = (phase: CollapsePhase): CollapsePhase =>
  phase === "enter-from" ? "entering" : phase;

/** 过渡结束（transitionend 或兜底定时器）：展开中 → 静止展开，收起中 → 卸载 */
export const collapseOnEnd = (phase: CollapsePhase): CollapsePhase => {
  if (phase === "entering") return "open";
  if (phase === "leaving") return "closed";
  return phase;
};

/** 这一阶段 grid 行高的目标是不是 1fr（展开方向）。enter-from / leaving 是 0fr */
export const collapseRowsExpanded = (phase: CollapsePhase): boolean =>
  phase === "entering" || phase === "open";

/** 过渡进行中（需要挂 transition 类、需要 overflow:hidden 裁内容、需要 inert） */
export const collapseIsAnimating = (phase: CollapsePhase): boolean =>
  phase === "entering" || phase === "leaving";

/** 要不要把子节点渲染出来（closed 是唯一不渲染的阶段） */
export const collapseMounted = (phase: CollapsePhase): boolean =>
  phase !== "closed";
