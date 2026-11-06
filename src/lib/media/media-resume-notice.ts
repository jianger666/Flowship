/**
 * 播放器顶栏那条「已从上次的 12:30 继续 · 从头播放」提示的收起规则。
 *
 * 用户自己动了进度（拖进度条 / 键盘跳转 / 「跳转到…」/ 媒体键 / 点「从头播放」）之后，
 * 「已从上次的 X 继续」就不再描述当前状态了，提示应该自己消失，而不是一直挂着等人点「×」。
 * （2026-11-06 第一版只在「拖回开头」时收；用户随后说「任何手动拖动都收」，这里改成：除了续播自己的那一跳，任何 seek 都收。）
 */

/** 只用到的那一小块 media 元素接口（方便测试里传假对象） */
export type SeekedSource = Pick<HTMLMediaElement, "addEventListener" | "removeEventListener" | "currentTime">;

/**
 * 续播那一跳落地后的位置与目标的容差（秒）。
 * 浏览器 seek 可能吸附到相邻帧 / 关键帧，不会精确等于 `currentTime = t` 里的 t。
 */
export const RESUME_JUMP_TOLERANCE_SECONDS = 1.5;

export interface ResumeNoticeWatch {
  /**
   * 告诉监听器：马上要由续播自己把进度跳到 `time`——紧随其后的那一次 seeked 不算「用户动了进度」。
   * 必须在 `video.currentTime = time` 之前调用。
   */
  expectResumeJump: (time: number) => void;
  /** 取消监听（effect 清理用） */
  stop: () => void;
}

/**
 * 监听 seeked：除了续播自己的那一跳，任何一次落点都算「用户动了进度」，调 onUserSeek。
 *
 * 为什么挂 seeked 而不是 timeupdate：所有改位置的路径（进度条 / 快捷键 / 跳转 / 媒体键 / 循环重播）
 * 最终都会触发它，且它只在「跳」之后发一次，不会和正常播放的位置更新混在一起。
 *
 * 续播那一跳要排除，否则提示刚出现就被自己收掉：{@link ResumeNoticeWatch.expectResumeJump} 登记目标位置，
 * 第一次 seeked 如果落在目标附近（容差 {@link RESUME_JUMP_TOLERANCE_SECONDS}）就当作续播自己的、不通知。
 * 登记只管**下一次** seeked：无论它是否命中，之后都清掉——这样即使续播那一跳因为什么原因没触发 seeked，
 * 登记也不会一直挂着、吞掉用户后面真正的第一次拖动（落点不在目标附近时本来也不会被吞）。
 */
export const watchUserSeek = (video: SeekedSource, onUserSeek: () => void): ResumeNoticeWatch => {
  let expected: number | null = null;
  const onSeeked = () => {
    const target = expected;
    expected = null;
    if (target !== null && Math.abs(video.currentTime - target) <= RESUME_JUMP_TOLERANCE_SECONDS) return;
    onUserSeek();
  };
  video.addEventListener("seeked", onSeeked);
  return {
    // NaN / Infinity 不用特判：它们与任何落点的距离比较都不成立，等于没登记
    expectResumeJump: (time) => {
      expected = time;
    },
    stop: () => video.removeEventListener("seeked", onSeeked),
  };
};
