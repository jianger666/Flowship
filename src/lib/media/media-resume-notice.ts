/**
 * 播放器顶栏那条「已从上次的 12:30 继续 · 从头播放」提示的收起规则。
 *
 * 用户自己动了进度（拖进度条 / 键盘跳转 / 「跳转到…」/ 媒体键 / 点「从头播放」）之后，
 * 「已从上次的 X 继续」就不再描述当前状态了，提示应该自己消失，而不是一直挂着等人点「×」。
 * （2026-11-06 第一版只在「拖回开头」时收；用户随后说「任何手动拖动都收」，这里改成：除了续播自己的那一跳，任何 seek 都收。）
 *
 * 另一条收起规则：续播后**实际播放满几秒**也自己收（用户都看了好几秒了，肯定不想回去）。见 {@link watchPlayedFor}。
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

/** 续播后实际播放满多少秒，「已从上次的 X 继续」提示就自己收（用户：播了好几秒就说明不想回去了） */
export const RESUME_NOTICE_PLAYED_SECONDS = 5;

/**
 * 一次 timeupdate 之间「用户实际看了多久」最多多少秒才算「正常播放」（按倍速折回墙钟后比较，见 watchPlayedFor）。
 * 正常播放每次只隔零点几秒（后台标签页被限频时也不过几秒）；更大的跳变是 seek，不记入播放时长。
 * 按墙钟比而不是按媒体位置比：4x 下 timeupdate 晚到 1.5 秒位置就走了 6 秒，按位置比会被误当成 seek 丢掉、提示收得更晚。
 * seek 本身已由 seeking / seeked 重置基准，这里只是第二道保险。
 */
const MAX_PLAY_STEP_SECONDS = 5;

/** {@link watchPlayedFor} 用到的 media 元素接口（方便测试里传假对象） */
export type PlaybackSource = Pick<
  HTMLMediaElement,
  "addEventListener" | "removeEventListener" | "currentTime" | "paused" | "playbackRate"
>;

/** 倍速取不到 / 不合法（0、负数、NaN）时按 1x 算：宁可当正常速度，也别让累计停摆或炸成 Infinity */
const effectiveRate = (rate: number): number => (Number.isFinite(rate) && rate > 0 ? rate : 1);

/**
 * 累计「实际播放」的时长，满 `seconds` 秒调一次 onElapsed（只调一次）。
 *
 * - 按媒体位置的前进量累计（timeupdate 之间的差值），**暂停 / 缓冲 / seek 都不算**：
 *   暂停期间位置不动；seeking 把基准清掉、seeked 再重新取基准，所以拖进度那一跳不会被当成「播放了几十秒」。
 * - 前进量要按倍速折回「用户实际看了多久」：2x 下位置每秒走 2 秒，不折算的话 5 秒阈值只需 2.5 秒就到、
 *   4x 只要 1.25 秒——提示还没看清就没了。折算后阈值始终是墙钟意义上的几秒。
 * - 累计的是总量、不要求连续：播 3 秒、暂停、再播 2 秒 = 5 秒。
 * - 想重新计时就 stop 掉重建一个（dock 里每次出现提示都新建）。
 */
export const watchPlayedFor = (
  video: PlaybackSource,
  seconds: number,
  onElapsed: () => void,
): { stop: () => void } => {
  // 基准从监听建立时的位置起算（dock 里监听是提示出现时才建的，此刻位置已是续播落点）
  let last: number | null = video.currentTime;
  let played = 0;
  let fired = false;
  const onTimeUpdate = () => {
    const now = video.currentTime;
    if (!video.paused && last !== null) {
      // 位置前进量折成「用户实际看了多久」（墙钟）：累计和「是不是 seek」都按它判（倍速 1x 时与位置步长相同）
      const step = now - last;
      const watched = step / effectiveRate(video.playbackRate);
      if (step > 0 && watched <= MAX_PLAY_STEP_SECONDS) played += watched;
    }
    last = now;
    if (!fired && played >= seconds) {
      fired = true;
      onElapsed();
    }
  };
  const onSeeking = () => {
    last = null;
  };
  const onSeeked = () => {
    last = video.currentTime;
  };
  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("seeking", onSeeking);
  video.addEventListener("seeked", onSeeked);
  return {
    stop: () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
    },
  };
};
