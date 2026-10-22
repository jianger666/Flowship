/**
 * 输入岛右侧动作组（附件 / 转圈 / 停止 / 发送）的决策（纯函数、无 React；第三轮 review D7-03 / R3-02）
 *
 * 之前这些散在 ConversationComposer 的 JSX 条件里：`running` 一个开关同时管附件、转圈、停止、排队发送，
 * 于是「后台子代理还在跑」只想要一个停止键，却把整套运行态带了出来（R3-02）；
 * 「发送中」只在常态发送键上转（D7-03）。决策抽到这里，组件只负责画。
 *
 * 转圈只留一个（事件流 v2「同屏只留一处主动效」）：
 * - 运行态、没有在提交：左侧「AI 在跑」转圈；
 * - 提交飞行中：转圈挪到发送键上，提示「发送中」（左侧不再叠第二个圈）。
 */

export interface ComposerActionsInput {
  /** 完整运行态（run 进行中 / 提交飞行；见 shouldShowComposerRunning） */
  running: boolean;
  /** 只多出停止键（后台子代理在跑、主 AI 空闲；见 shouldShowComposerStopOnly）——不改其它键的语义 */
  stopOnly: boolean;
  /** 提交飞行中 */
  submitting: boolean;
  /** chat 排队：运行态仍可发送 */
  allowQueueWhileRunning: boolean;
}

export interface ComposerSendAction {
  label: "发送" | "排队发送";
  /** 发送键转圈 */
  spinning: boolean;
  /** tooltip / aria-label：提交飞行中是「发送中」，否则是 label */
  tip: string;
}

export interface ComposerActions {
  /** 附件按钮（运行态让位） */
  showAttach: boolean;
  /** 左侧「AI 在跑」转圈 */
  runSpinner: boolean;
  stopButton: boolean;
  /** null = 没有发送键 */
  send: ComposerSendAction | null;
}

export const deriveComposerActions = (i: ComposerActionsInput): ComposerActions => {
  if (i.running) {
    const send: ComposerSendAction | null = i.allowQueueWhileRunning
      ? {
          label: "排队发送",
          spinning: i.submitting,
          tip: i.submitting ? "发送中" : "排队发送",
        }
      : null;
    return {
      showAttach: false,
      // 提交飞行且有发送键可转时，转圈归发送键；没有发送键就仍用左侧这个（没有别处可转）
      runSpinner: !(i.submitting && send),
      stopButton: true,
      send,
    };
  }
  return {
    showAttach: true,
    runSpinner: false,
    stopButton: i.stopOnly,
    send: {
      label: "发送",
      spinning: i.submitting,
      tip: i.submitting ? "发送中" : "发送",
    },
  };
};

// ---------- 提交防双发（Q6-03 / Q6-10）：Enter 键路径的两道防线抽成纯函数，才有测试可守 ----------
//
// D7-03 让「提交在途编辑器仍可输入」之后，Enter 键路径的防双发只剩两道：
//   ① ConversationComposer.handleSubmit 对 submitting 的拦截（canComposerSubmit）；
//   ② event-stream.submitVia 的同步闩（createSubmitLatch）——`isSubmitting` 是 React state、晚一帧才更新，
//      同一帧内连按两次 Enter 只有同步闩能拦。
// 发送键 `disabled` 只防鼠标。以前这两道都埋在组件里、没有任何行为测试（同时拆掉两道 27 个测试文件全绿）。

/** 提交为什么被拦：disabled / 提交在途 / 没内容；null = 放行 */
export type ComposerSubmitBlock = "disabled" | "submitting" | "empty";

/**
 * 当前能不能提交（Enter 与发送键共用同一判据）。
 * 优先级：整体禁用 > 没内容 > 提交在途——「提交在途」放最后，是因为只有它值得给用户一点反馈
 * （Q6-10：用户确实有话要发、只是上一条还没落地；空消息 / 禁用时按 Enter 本来就没动作，不必提示）。
 */
export const composerSubmitBlock = (s: {
  disabled?: boolean;
  submitting?: boolean;
  hasContent: boolean;
}): ComposerSubmitBlock | null => {
  if (s.disabled) return "disabled";
  if (!s.hasContent) return "empty";
  if (s.submitting) return "submitting";
  return null;
};

/** 同步提交闩：tryAcquire 成功才能提交；提交落定（成功 / 失败 / 抛错）后必须 release */
export interface SubmitLatch {
  /** 没被占时占上并返回 true；已被占返回 false（同一帧连按 Enter 的第二次） */
  tryAcquire: () => boolean;
  /** 释放（幂等） */
  release: () => void;
  /** 当前是否被占（只读） */
  readonly held: boolean;
}

export const createSubmitLatch = (): SubmitLatch => {
  let held = false;
  return {
    tryAcquire: () => {
      if (held) return false;
      held = true;
      return true;
    },
    release: () => {
      held = false;
    },
    get held() {
      return held;
    },
  };
};

/**
 * 带闩的提交入口（event-stream.submitVia 的骨架）：
 * 没发送函数 / 没内容 / 闩被占 → 什么都不做返回 false；否则占闩、同步调 `run`（同帧第二次调用必被闩拦下），
 * `run` 落定（resolve / reject）或同步抛错都释放闩——闩不会因为一次异常而永远卡死、再也发不出消息。
 */
export const startLatchedSubmit = (args: {
  latch: SubmitLatch;
  hasSend: boolean;
  hasContent: boolean;
  run: () => Promise<unknown>;
}): boolean => {
  if (!args.hasSend || !args.hasContent) return false;
  if (!args.latch.tryAcquire()) return false;
  let pending: Promise<unknown>;
  try {
    pending = Promise.resolve(args.run());
  } catch (err) {
    args.latch.release();
    throw err;
  }
  void pending.then(
    () => args.latch.release(),
    () => args.latch.release(),
  );
  return true;
};
