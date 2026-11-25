/**
 * 截图守卫：遮罩盖着的时候，怎么截到「遮罩下面的真实屏幕」。
 *
 * 背景：遮罩（overlay.mjs）靠 setContentProtection(true) 想把自己排除在截图之外，但系统不保证这一点——
 * macOS 27.2 + Electron 42（ScreenCaptureKit）上实测：**整个屏幕被截成一片纯黑**（只剩 Dock 的图标），既不是真实屏幕，
 * 也不是遮罩的深蓝色。AI 拿到的每一张图都是黑的，什么也干不了（真实任务里就因此没能给微信联系人发出消息）。
 * 「被不被影响、影响成什么样」取决于系统版本，没法提前写死，只能在运行时自己判断，而且**不能只靠猜遮罩应该是什么颜色**：
 * 守卫对照两张图——带遮罩截的、撤了遮罩截的——比它们是不是同一个屏幕：
 *
 *   遮罩没盖着            → 直接截（不用管遮罩）
 *   模式 exposed          → 每次截图前把遮罩短暂变透明（suspend），截完立刻恢复（resume）
 *   模式 unknown          → 先直接截一张，再撤遮罩截一张对照（两张图的颜色指纹 sig 一比就知道）：
 *                           两张一样 → clear（遮罩不影响截图，之后直接截）；不一样 → exposed；返回的永远是撤了遮罩的那张
 *   模式 clear            → 直接截；这张看着被盖住了（几乎全黑 / 全是遮罩色）就再对照一次，不是终身判决
 *
 * 判断是「每一轮遮罩」做一次：遮罩每次 show() 成功 generation 就 +1，守卫发现换了一轮就把上一轮的结论作废、重新对照
 * （系统升级 / 显示器变化 / 屏幕保护设置变化都可能改变截图的表现，而对照只多花一次截图）。
 * 读不到颜色指纹（旧的 / 测试用的截图器）时退回只看颜色比例：几乎全是遮罩色或纯黑 = 被盖住。
 *
 * 「对照出来没影响」要等遮罩稳定了才算数：真机实测，AI 的第一次截图常常抢在遮罩合成到屏幕之前——带遮罩那张拍到的还是真实桌面，
 * 和撤了遮罩的那张当然一样，据此判成 clear 就错了（下一张才发现是一片黑）。所以遮罩出现不到 steadyAfterShowMs（1 秒）时对照出
 * 「一样」，只当临时结果（模式仍是 unknown、这次返回撤了遮罩的那张，下一次截图再对照）；对照出「不一样」是偏安全的方向，立刻生效。
 *
 * 取舍（别悄悄改掉）：
 * - exposed 模式下每次截图旁人能在大约半秒内瞥见真实桌面（撤遮罩 → 等合成器生效 → 截图 → 恢复）。
 *   这是在「AI 完全看不见屏幕」和「截图瞬间屏幕裸露」之间选后者；遮罩不影响截图的系统上完全不会撤。
 * - 撤遮罩永远不能让屏幕一直裸着：resume 放在 finally 里，overlay.suspend 自己还有超时兜底。
 * - 撤了遮罩之后截出来「还是被盖住」不立刻下结论：合成器可能还没把透明度落到屏幕上，换更长的等待再试（hideSettleStepsMs）。
 * - 新一轮遮罩刚出现的几百毫秒里，带遮罩的截图可能是过渡态（实测出现过一整片发亮的杂色），所以「带遮罩截到的那张」
 *   从来不直接交给 AI——要么撤了遮罩截（exposed / 对照），要么已经对照过确认遮罩不影响截图（clear）。
 */
import { isSameScreen, signatureDistance } from "./image-stats.mjs";

export const CAPTURE_GUARD_DEFAULTS = Object.freeze({
  /** 黑色 / 遮罩色占比 ≥ 它 = 这张图几乎是被盖住的 */
  threshold: 0.85,
  /** 撤遮罩后等多久再截；截出来还像被盖住就换下一个更长的（最后一个也不行才放弃） */
  hideSettleStepsMs: Object.freeze([120, 300, 700]),
  /** 自检前等遮罩真的出现在屏幕上（窗口刚创建，合成器还要几帧） */
  selfCheckOverlayWaitMs: 600,
  /** 遮罩出现多久之后画面才算稳定：在这之前对照出「遮罩没影响」不算数（见文件头注释） */
  steadyAfterShowMs: 1000,
});

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pct = (ratio) => `${Math.round(ratio * 100)}%`;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 颜色占比：黑色和遮罩色里大的那个（都读不到 = null） */
const coverRatio = (shot) => {
  const o = num(shot?.overlayRatio);
  const b = num(shot?.blackRatio);
  if (o === null && b === null) return null;
  return Math.max(o ?? 0, b ?? 0);
};

const hasSig = (shot) => Boolean(shot?.sig) && typeof shot.sig.length === "number" && shot.sig.length > 0;

/** 给人看的一句：这张图主要被什么颜色盖住了 */
const describeCover = (shot) => {
  const o = num(shot?.overlayRatio);
  const b = num(shot?.blackRatio);
  if (o === null && b === null) return "读不到像素";
  if ((b ?? 0) >= (o ?? 0) && (b ?? 0) > 0) return `黑色占 ${pct(b)}`;
  if ((o ?? 0) > 0) return `遮罩色占 ${pct(o)}`;
  return "黑色和遮罩色都很少";
};

/**
 * @typedef {'unknown'|'clear'|'exposed'} CaptureMode
 *   unknown：这一轮遮罩还没对照过；clear：遮罩不影响截图（或屏幕本来就是黑 / 深色）；exposed：遮罩会影响截图，截图前要撤
 */

/**
 * @param {{
 *   overlay: import("./types.mjs").DesktopOverlay,
 *   screenshotter: { capture: () => Promise<{ jpeg: Buffer, frame: any, overlayRatio?: number | null, blackRatio?: number | null, sig?: ArrayLike<number> | null }>, screenPermission?: () => string },
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (msg: string) => void,
 *   threshold?: number,
 *   hideSettleStepsMs?: readonly number[],
 *   selfCheckOverlayWaitMs?: number,
 *   steadyAfterShowMs?: number,
 *   now?: () => number,
 * }} deps
 */
export const createCaptureGuard = (deps) => {
  const { overlay, screenshotter, sleep = defaultSleep, log = () => {}, now = Date.now } = deps;
  const threshold = deps.threshold ?? CAPTURE_GUARD_DEFAULTS.threshold;
  const steps = deps.hideSettleStepsMs ?? CAPTURE_GUARD_DEFAULTS.hideSettleStepsMs;
  const selfCheckOverlayWaitMs = deps.selfCheckOverlayWaitMs ?? CAPTURE_GUARD_DEFAULTS.selfCheckOverlayWaitMs;
  const steadyAfterShowMs = deps.steadyAfterShowMs ?? CAPTURE_GUARD_DEFAULTS.steadyAfterShowMs;

  /** @type {CaptureMode} */
  let mode = "unknown";
  /** 上面的 mode 是针对哪一轮遮罩判断的（遮罩换了一轮就作废）。没有 generation() 的遮罩恒为 0 = 只判断一次 */
  let modeGeneration = -1;

  /** 遮罩实现里没有 suspend / resume（旧的 / 测试用的假遮罩）：没法撤，守卫退化成直通 */
  const canHide = typeof overlay.suspend === "function" && typeof overlay.resume === "function";

  const currentGeneration = () => (typeof overlay.generation === "function" ? overlay.generation() : 0);
  /** 换了一轮遮罩：上一轮的结论作废，这一轮重新对照 */
  const syncGeneration = () => {
    const g = currentGeneration();
    if (g === modeGeneration) return;
    modeGeneration = g;
    mode = "unknown";
  };

  /** 遮罩已经出现多久（ms）；遮罩实现里没有 shownAt()（旧的 / 测试用的假遮罩）= 无穷久，即「早就稳定了」 */
  const sinceShow = () => (typeof overlay.shownAt === "function" ? now() - overlay.shownAt() : Number.POSITIVE_INFINITY);

  /** 几乎是被盖住的：黑色或遮罩色占比 ≥ 阈值（读不到像素 = 不下结论，不算被盖住） */
  const looksCovered = (shot) => {
    const r = coverRatio(shot);
    return r !== null && r >= threshold;
  };

  /** 撤遮罩 → 等 settleMs → 截图 → 无论成败都恢复遮罩 */
  const captureHidden = async (settleMs) => {
    overlay.suspend();
    try {
      await sleep(settleMs);
      return await screenshotter.capture();
    } finally {
      overlay.resume();
    }
  };

  /**
   * 撤遮罩截一张「干净」的：截出来还像被盖住就换更长的等待再试。
   * @returns {Promise<{ shot: any, clean: boolean }>} clean=false：试到最后一档截出来仍几乎全黑 / 全是遮罩色（shot 是最后那张）
   */
  const captureClean = async () => {
    let shot;
    for (const ms of steps) {
      shot = await captureHidden(ms);
      if (!looksCovered(shot)) return { shot, clean: true };
    }
    return { shot, clean: false };
  };

  /**
   * 对照「带遮罩截的」和「撤了遮罩截的」，给出这一轮的结论。
   * 两张图都有指纹就比指纹（是不是同一个屏幕）；比不了就退回颜色比例（带遮罩那张几乎被盖住 = 遮罩影响了截图）。
   * @returns {{ verdict: CaptureMode, dist: { meanAbs: number, fracBig: number } | null }}
   *   verdict=unknown：撤了遮罩之后仍几乎全黑、且和带遮罩那张不是同一个画面——撤遮罩多半没生效，不下结论
   */
  const judge = (withShot, hiddenShot, clean) => {
    const dist = signatureDistance(withShot?.sig, hiddenShot?.sig);
    if (clean) {
      if (dist) return { verdict: isSameScreen(dist) ? "clear" : "exposed", dist };
      return { verdict: looksCovered(withShot) ? "exposed" : "clear", dist };
    }
    // 撤了遮罩截出来仍几乎全黑 / 全是遮罩色：两张一样 = 屏幕本来就这样（深色桌面），遮罩没影响；对不上 = 说不清
    if (dist && !isSameScreen(dist)) return { verdict: "unknown", dist };
    return { verdict: "clear", dist };
  };

  /**
   * 这一轮的对照做完了：记下结论（只在 capture 的发现路径用，自检自己处理）。
   * early=true：带遮罩那张是在遮罩刚出现的一秒内截的，画面还没稳定——「一样」只是临时结果，不记成 clear（模式保持原样，下一次再对照）。
   */
  const applyVerdict = (verdict, dist, withShot, hiddenShot, early) => {
    if (verdict === "exposed") {
      mode = "exposed";
      log(
        `[desktop-capture] 遮罩会影响截图（带遮罩时${describeCover(withShot)}，撤掉后${describeCover(hiddenShot)}` +
          `${dist ? `，两张图平均差 ${dist.meanAbs.toFixed(1)}` : ""}）：系统没有把遮罩排除在截图之外，之后每次截图前会短暂撤掉遮罩`,
      );
      return;
    }
    if (verdict === "clear") {
      if (!early) mode = "clear";
      return;
    }
    log(
      `[desktop-capture] 撤掉遮罩之后截图仍几乎全是黑色 / 遮罩色（${describeCover(hiddenShot)}），而且和带遮罩时（${describeCover(withShot)}）不是同一个画面：` +
        "撤遮罩可能没有生效，这一轮先不下结论",
    );
  };

  /** 给 manager 用的截图入口，签名和 screenshotter.capture 一样 */
  const capture = async () => {
    if (!canHide || !overlay.isShown()) return screenshotter.capture();
    syncGeneration();
    if (mode === "exposed") {
      const { shot, clean } = await captureClean();
      if (!clean) log("[desktop-capture] 撤掉遮罩之后截图仍几乎全是黑色 / 遮罩色：屏幕可能本来就是这样，或撤遮罩没有生效");
      return shot;
    }
    // 带遮罩那张开拍时遮罩出现多久了（取开拍时刻：画面一定不早于它，所以「≥ 稳定时间」就一定是稳定的）
    const early = sinceShow() < steadyAfterShowMs;
    const first = await screenshotter.capture();
    if (!hasSig(first)) {
      // 没有指纹，只能看颜色比例：量得出像素、且没被盖住 = 这套截图方式没受遮罩影响；量不出来（null）什么也不下结论
      if (!looksCovered(first)) {
        if (coverRatio(first) !== null) mode = "clear";
        return first;
      }
    } else if (mode === "clear" && !looksCovered(first)) {
      // 这一轮已经对照过、确认遮罩不影响截图，这张看着也正常：直接用
      return first;
    }
    // 这一轮还没对照过（unknown），或这张看着被盖住了：撤掉遮罩再截一张对照来分辨，返回对照图
    const { shot, clean } = await captureClean();
    const { verdict, dist } = judge(first, shot, clean);
    applyVerdict(verdict, dist, first, shot, early);
    return shot;
  };

  /**
   * 设置页「测试」用：遮罩已经盖着，主动对照一次——带遮罩截一张、撤遮罩截一张，看遮罩影响了截图没有。
   * 结果同时更新守卫的模式（这一轮之后的截图按它走）。
   * @returns {Promise<{ ok: boolean, skipped?: boolean, mode: CaptureMode, detail: string, withOverlayRatio?: number, cleanRatio?: number }>}
   *   ok=false 只在「AI 拿不到干净截图」时出现（遮罩影响了截图、又撤不掉 / 撤了也是黑的）；
   *   skipped=true：没法做这次自检（遮罩没了 / 量不出像素），不算失败
   */
  const selfCheck = async () => {
    if (!overlay.isShown()) {
      return { ok: true, skipped: true, mode, detail: "遮罩已经撤了（可能你动了键盘或鼠标），这次没做遮罩自检" };
    }
    await sleep(selfCheckOverlayWaitMs);
    // 自检的结论会直接告诉用户「遮罩有没有影响截图」，不能拿还没稳定的画面下结论：等到遮罩出现满 steadyAfterShowMs
    const remaining = steadyAfterShowMs - sinceShow();
    if (remaining > 0) await sleep(remaining);
    if (!overlay.isShown()) {
      return { ok: true, skipped: true, mode, detail: "自检等待期间遮罩已经撤了（可能你动了键盘或鼠标），这次没做遮罩自检" };
    }
    syncGeneration();
    const withOverlay = await screenshotter.capture();
    const r = coverRatio(withOverlay);
    if (r === null && !hasSig(withOverlay)) {
      return { ok: true, skipped: true, mode, detail: "读不到截图的像素，没法判断遮罩有没有影响截图，已跳过" };
    }
    const withRatio = r === null ? {} : { withOverlayRatio: r };
    if (!canHide) {
      if (looksCovered(withOverlay)) {
        return {
          ok: false,
          mode,
          detail: `带遮罩时截到的画面几乎被盖住了（${describeCover(withOverlay)}），而且这套遮罩没有临时撤掉的办法：AI 看到的会是一整页黑 / 遮罩`,
          ...withRatio,
        };
      }
      mode = "clear";
      return { ok: true, mode, detail: `遮罩没有影响截图（画面里${describeCover(withOverlay)}），截图无需撤遮罩`, ...withRatio };
    }
    if (!hasSig(withOverlay) && !looksCovered(withOverlay)) {
      // 没有指纹可比，颜色比例又显示没被盖住：按「遮罩没影响」处理，不需要撤
      mode = "clear";
      return { ok: true, mode, detail: `遮罩没有影响截图（画面里${describeCover(withOverlay)}），截图无需撤遮罩`, ...withRatio };
    }
    const { shot, clean } = await captureClean();
    const cr = coverRatio(shot);
    const cleanRatio = cr === null ? {} : { cleanRatio: cr };
    const { verdict, dist } = judge(withOverlay, shot, clean);
    if (!clean) {
      return {
        ok: false,
        mode,
        detail:
          `带遮罩和撤掉遮罩截出来都几乎全是黑色或遮罩色（${describeCover(withOverlay)} / ${describeCover(shot)}）：` +
          "可能是你的桌面本来就很暗（换个亮一点的桌面再测一次），也可能是撤遮罩没有生效（AI 会看不到真实屏幕）",
        ...withRatio,
        ...cleanRatio,
      };
    }
    mode = verdict;
    if (verdict === "clear") {
      return {
        ok: true,
        mode,
        detail: `遮罩没有影响截图（${dist ? "带遮罩和撤掉遮罩截到的画面一致" : `带遮罩时${describeCover(withOverlay)}`}），截图无需撤遮罩`,
        ...withRatio,
        ...cleanRatio,
      };
    }
    const b = num(withOverlay.blackRatio) ?? 0;
    const o = num(withOverlay.overlayRatio) ?? 0;
    const what =
      b >= threshold && b >= o
        ? `系统会把遮罩截成一片黑（${describeCover(withOverlay)}）`
        : o >= threshold
          ? `系统会把遮罩截进画面（${describeCover(withOverlay)}）`
          : `带遮罩时截到的画面和撤掉遮罩后明显不同（${describeCover(withOverlay)}）`;
    return {
      ok: true,
      mode,
      detail: `${what}：已改成每次截图前短暂撤掉遮罩，撤掉后截图正常（${describeCover(shot)}）`,
      ...withRatio,
      ...cleanRatio,
    };
  };

  return {
    capture,
    selfCheck,
    screenPermission: () => screenshotter.screenPermission?.() ?? "unknown",
    getMode: () => mode,
  };
};
