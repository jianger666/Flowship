/**
 * 事件流搜索与「跟随最新」的配合（R14 B6-3 / Q2-02，纯逻辑、可单测）。
 *
 * 旧行为：搜索框里一有字（query 非空）就关掉跟随，而且关闭搜索也不会恢复——
 * 流式期间想搜一下，关掉后事件流就停在半路，要自己滚回底部；
 * 反过来「只输入、没有命中」的时候视口明明没动，也被白白关了跟随。
 *
 * 新行为：只有「命中并把视口带走」才停跟随（pauseForHit），同时记下「搜索前是不是在跟随」；
 * Esc / × 关闭搜索时，搜索前在跟随的缓动回最新并恢复跟随（resumeOnClose）；
 * 搜索前本来就在翻历史的不动他。
 *
 * 为什么不能只删掉旧的「query 非空就停跟随」：已挂载的命中走 DOM 精确滚动（scrollDomSearchMatchIntoView）、
 * 不经 jumpToItem，程序化滚动不会让跟随状态机自己停——流式期间下一个 chunk 会把视口又拽回底部。
 * 所以命中带走视口之前必须显式停一次，而且要在 jumpToItem（它也会停跟随）之前调，
 * 否则「搜索前在不在跟随」就读不到了。
 */

/** 跟随控制器里搜索要用到的三个方法（StreamFollowController 的子集；单测可以直接给假的） */
export interface SearchFollowCtl {
  isFollowing: () => boolean;
  setFollowing: (next: boolean) => void;
  scrollToBottomSmooth: () => void;
}

export interface SearchFollowGate {
  /** 命中要把视口带走了：此刻在跟随就记下「关搜索时要还回去」，再停跟随。可重复调（幂等） */
  pauseForHit: () => void;
  /** 关闭搜索：只有「是搜索把跟随停掉的」才缓动回最新并恢复跟随；用户已自己滚回底部的不再滑一次 */
  resumeOnClose: () => void;
  /** 切到别的任务：丢掉上一个任务的记号，别让它在新任务里关搜索时触发滑动 */
  reset: () => void;
}

export const createSearchFollowGate = (ctl: SearchFollowCtl): SearchFollowGate => {
  /** 搜索把「原本在跟随」的视口停住了：关闭搜索时要还回去 */
  let resume = false;
  return {
    pauseForHit: () => {
      if (ctl.isFollowing()) resume = true;
      ctl.setFollowing(false);
    },
    resumeOnClose: () => {
      if (!resume) return;
      resume = false;
      if (ctl.isFollowing()) return;
      ctl.scrollToBottomSmooth();
    },
    reset: () => {
      resume = false;
    },
  };
};
