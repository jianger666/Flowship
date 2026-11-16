/**
 * 锁屏必黑屏（2026-11-16）——纯逻辑，main.js 与单测 / e2e 共用。
 *
 * 现象：Flowship 里有页面在播放视频（典型：抖音排班页静音在后台一直播）时，Chromium 会为它持有
 *   NoDisplaySleepAssertion "Video Wake Lock"（= PreventUserIdleDisplaySleep），锁屏之后 macOS 的「锁屏后自动熄屏」
 *   被这把锁挡住，显示器一直亮着。pmset 日志里 11-14 / 11-15 两天这把锁创建 363 / 851 次，同期没有任何一次熄屏。
 *
 * 为什么不去「让页面别播 / 暂停视频」：
 *   - 用户要的是「Flowship 在播什么我不管，锁屏就该黑；而且黑屏后 AI 仍要能操作内置浏览器」。暂停视频会改页面状态，
 *     AI 正好要看 / 要播视频的任务会被误伤（解决了黑屏、丢了 AI 能操作）。
 *   - 试过且都不能释放这把锁：静音（setAudioMuted / element.muted）、setBackgroundThrottling(true)、view.setVisible(false)、
 *     win.hide()。内置浏览器的视图是 backgroundThrottling=false，Chromium 一旦把它判为「可见过」就一直当可见。
 *   - 唯一可靠的是 video.pause()，但它正是上面说的代价。
 *
 * 做法：不碰页面，锁屏时直接让显示器熄灭（系统自带命令 `pmset displaysleepnow`，不改任何系统设置、不需要权限）。
 *
 * 真机实测（macOS，锁屏延迟「立即」，Flowship 同时持有 Video Wake Lock 与 "Capturing" 锁）：
 *   1. displaysleepnow 能压过这些锁：日志出现 `Display is turned off`；
 *   2. 黑屏期间 Flowship 又新建了 5 把 Video Wake Lock，屏幕没有被点亮（亮屏只来自键盘输入）；
 *   3. 黑屏 + 会话锁定（IOConsoleLocked=Yes）期间，内置浏览器里的页面照常工作：计时器没被降速（500ms 间隔
 *      约 33 秒 +67）、视频持续播放并循环、点击 / 截图（拿到真实视频画面）/ 导航 / 读快照全部成功。
 *   4. 这些亮屏锁同时也让系统不会空闲睡眠——我们不去碰它们，所以黑屏期间 AI 任务不会因为系统睡眠而中断。
 *
 * 「只是优化、不改原有行为」——凡是系统本来会做的事，尽量和系统一致：
 *   - 影响范围只限「Flowship 自己造成的亮屏」：用 `pmset -g assertions` 看谁在阻止熄屏，
 *     必须「Flowship 持有、且没有任何其他程序持有」才介入；Flowship 没持有、别的程序（Chrome / `caffeinate -d` /
 *     AirPlay / 视频会议……）也在阻止熄屏、或探测失败（看不清谁在阻止）——一律不介入，交给系统。
 *     这样熄屏的结果等于「Flowship 没持这把锁时系统本来就会做的事」，不会替用户的其他程序做主。
 *   - 「没介入」不是一锤子买卖：Flowship 的亮屏锁是断断续续的（pmset 日志里一把锁常只持续几秒，两把之间隔 2 秒~几十秒），
 *     锁屏那一刻的探测可能刚好落在空档里，别的程序也可能随后放手。所以锁屏期间用户空闲满 15 秒后重新评估，
 *     间隔 5 → 10 → 20 → 40 → 60 秒封顶（用户一碰键鼠回到起步）；评估的条件和第一次完全一样。
 *   - 用户锁屏后碰了键鼠把屏幕点亮、然后走开：没有 Flowship 的锁时系统会自己再熄（pmset 日志：2026-11-09 ~ 11-13
 *     「锁屏界面有活动 → 14 秒后 Display is turned off」「点亮 → 11 / 30 秒后熄灭」），但有这把锁时系统不会再熄。
 *     所以锁屏期间每 5 秒看一次，「熄屏之后有过新的键鼠输入、且现在又空闲 ≥ 15 秒」就再熄一次（15 秒取自上面那几次的中位数附近）。
 *   - 「熄屏之后有没有新输入」要分得清熄屏后很短时间内的触碰（快捷键锁屏后手还在鼠标上蹭一下）：
 *     Electron 的 getSystemIdleTime 只有整秒，取整会留下 1 秒多的盲区，所以优先读 IOHIDSystem 的 HIDIdleTime
 *     （纳秒精度，约 10~50ms 一次，只在锁屏期间每 5 秒读一次）；读不到才退回整秒。
 *
 * 逃生口：环境变量 FLOWSHIP_LOCK_DISPLAY_OFF=0 整体关闭。只在 macOS 生效（亮屏锁 / pmset 都是 macOS 的）。
 */

export const LOCK_DISPLAY_OFF_ENV = "FLOWSHIP_LOCK_DISPLAY_OFF";

/** 锁屏事件到真正动手之间留一点时间，让锁屏界面先稳下来 */
export const LOCK_GRACE_MS = 1000;
/** 锁屏期间的巡检间隔 */
export const LOCK_POLL_MS = 5000;
/** 用户点亮屏幕后，空闲满这么久才再次熄屏（贴近系统自己的 11~30 秒） */
export const LOCK_IDLE_THRESHOLD_SEC = 15;
/**
 * 上一次「没介入」（Flowship 刚好没持锁 / 别的程序也在阻止 / 探测失败 / 熄屏命令失败）之后，
 * 用户空闲满阈值时重新评估的退避间隔：起步 5 秒、翻倍、封顶 60 秒；用户一碰键鼠就回到起步。
 */
export const LOCK_RETRY_MIN_MS = 5000;
export const LOCK_RETRY_MAX_MS = 60000;
/** 毫秒级读数：读取延迟 + 取样时刻的抖动（取样时刻取读取前后的中点） */
export const PRECISE_SLACK_MS = 400;
/** 整秒读数（退路）：向下取整的误差 < 1000ms，再留一点余量 */
export const COARSE_SLACK_MS = 1500;
const PMSET_TIMEOUT_MS = 5000;
const IOREG_TIMEOUT_MS = 3000;

/** 只有 macOS 且没被环境变量关掉才启用 */
export const isLockDisplayOffEnabled = (env, platform) =>
  platform === "darwin" && String(env?.[LOCK_DISPLAY_OFF_ENV] ?? "").trim() !== "0";

/** 「不让显示器休眠」的断言类型；不同 macOS 版本里叫法不一样，都认 */
const DISPLAY_LOCK_TYPE_RE = /^(?:NoDisplaySleepAssertion|PreventUserIdleDisplaySleep|PreventDisplaySleep)$/;
/** `pmset -g assertions` 里逐条记录的一行：pid、进程名（可含括号）、类型 */
const ASSERTION_LINE_RE = /^\s*pid\s+(\d+)\((.*?)\):\s*\[0x[0-9a-fA-F]+\]\s+\S+\s+(\w+)\b/;

/**
 * 解析 `pmset -g assertions` 的输出：谁在阻止显示器休眠。
 * 只看「Listed by owning process」里的逐条记录（系统级汇总行没有 pid，不算）：
 *   `   pid 681(Flowship): [0x0000471400059203] 00:00:00 NoDisplaySleepAssertion named: "Video Wake Lock"`
 * - `mine`：属主 pid 是 `pid`（本进程）的亮屏锁是否存在；
 * - `others`：其他进程持有的亮屏锁（`{ pid, name, type }`，一个进程多把锁会出现多次）。
 * `InternalPreventDisplaySleep`（系统自己的延时熄屏记账，属主 powerd）不在上面三种类型里，不算任何人持有。
 */
export const analyzeDisplayLocks = (stdout, pid) => {
  const want = String(pid);
  let mine = false;
  const others = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const m = ASSERTION_LINE_RE.exec(line);
    if (!m || !DISPLAY_LOCK_TYPE_RE.test(m[3])) continue;
    if (m[1] === want) mine = true;
    else others.push({ pid: Number(m[1]), name: m[2], type: m[3] });
  }
  return { mine, others };
};

/** 本进程是否持有亮屏锁（不管别人有没有） */
export const parseHoldsDisplayLock = (stdout, pid) => analyzeDisplayLocks(stdout, pid).mine;

/**
 * 解析 `ioreg -c IOHIDSystem -r -d 1` 里的键鼠空闲时间（纳秒）→ 毫秒；解析不出来返回 null。
 *   `      "HIDIdleTime" = 236595291`
 */
export const parseHidIdleMs = (stdout) => {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(stdout ?? ""));
  if (!m) return null;
  const ms = Number(m[1]) / 1e6;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

/**
 * 读「距上次键鼠输入过去了多久」：优先毫秒级（ioreg），读不到退回 Electron 的整秒值；都读不到返回 null。
 * @returns {Promise<{ idleMs: number, precise: boolean } | null>}
 */
export const readIdle = async (execFile, getSystemIdleSeconds) => {
  const out = await new Promise((resolve) => {
    try {
      execFile("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-r", "-d", "1"], { timeout: IOREG_TIMEOUT_MS }, (err, stdout) => {
        resolve(err ? null : String(stdout ?? ""));
      });
    } catch {
      resolve(null);
    }
  });
  const ms = out == null ? null : parseHidIdleMs(out);
  if (ms != null) return { idleMs: ms, precise: true };
  try {
    const s = getSystemIdleSeconds?.();
    if (Number.isFinite(s) && s >= 0) return { idleMs: Math.floor(s) * 1000, precise: false };
  } catch {
    /* 退路也读不到就返回 null */
  }
  return null;
};

/**
 * @param {{
 *   enabled?: boolean,
 *   pid: number,
 *   execPmset: (args: string[]) => Promise<{ ok: boolean, stdout: string }>,
 *   readIdle: () => Promise<{ idleMs: number, precise: boolean } | null>,
 *   log?: (msg: string) => void,
 *   now?: () => number,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout,
 *   setTick?: typeof setInterval, clearTick?: typeof clearInterval,
 *   graceMs?: number, pollMs?: number, idleThresholdSec?: number,
 * }} deps
 */
export const createLockDisplayOff = (deps) => {
  const {
    enabled = true,
    pid,
    execPmset,
    readIdle: readIdleDep,
    log = () => {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    setTick = setInterval,
    clearTick = clearInterval,
    graceMs = LOCK_GRACE_MS,
    pollMs = LOCK_POLL_MS,
    idleThresholdSec = LOCK_IDLE_THRESHOLD_SEC,
  } = deps;

  let locked = false;
  let busy = false;
  let ticking = false;
  /** 已经处理过一次（熄过屏，或确认 Flowship 没持锁）：之后巡检才有「上次输入时间」这条基线可比 */
  let decided = false;
  /** 处理当时「最后一次键鼠输入」发生的时刻（毫秒时间戳）；取不到为 null，由第一次巡检补上 */
  let decidedInputAt = null;
  /**
   * 上一次处理的结果：true = 已经让显示器熄灭（之后只在「熄屏后有新输入、又空闲满阈值」时再熄）；
   * false = 没介入（之后空闲满阈值就按退避间隔重新评估——Flowship 的亮屏锁是断断续续的，
   * 锁屏那一刻探测可能刚好落在空档里；别的程序也可能随后放手）
   */
  let settled = false;
  let retryDelayMs = LOCK_RETRY_MIN_MS;
  let nextRetryAt = 0;
  let graceTimer = null;
  let tickTimer = null;
  // 同一次锁屏里同类日志只记一条，免得每 5 秒刷屏
  let loggedNotHolding = false;
  let loggedOthersHold = false;
  let loggedProbeFailed = false;
  let loggedSleepFailed = false;

  const clearTimers = () => {
    if (graceTimer) clearTimer(graceTimer);
    if (tickTimer) clearTick(tickTimer);
    graceTimer = null;
    tickTimer = null;
  };

  const safeLog = (msg) => {
    try {
      log(msg);
    } catch {
      /* 日志不能让系统事件回调抛 */
    }
  };

  /** 「最后一次键鼠输入」的时刻 + 这个估计的误差范围；读不到返回 null */
  const sampleLastInput = async () => {
    try {
      const t0 = now();
      const r = await readIdleDep();
      const t1 = now();
      if (!r || !Number.isFinite(r.idleMs)) return null;
      return { at: (t0 + t1) / 2 - r.idleMs, slackMs: r.precise ? PRECISE_SLACK_MS : COARSE_SLACK_MS, idleMs: r.idleMs };
    } catch {
      return null;
    }
  };

  const decide = async (why) => {
    if (!locked || busy) return;
    busy = true;
    let slept = false;
    try {
      // 先记下「此刻最后一次输入是什么时候」，再动手：之后任何晚于它的输入都说明用户把屏幕点亮过
      const base = await sampleLastInput();
      decided = true;
      decidedInputAt = base ? base.at : null;
      let locks = null; // null = 没能确认谁在阻止熄屏
      try {
        const probe = await execPmset(["-g", "assertions"]);
        if (probe?.ok) locks = analyzeDisplayLocks(probe.stdout, pid);
      } catch {
        locks = null;
      }
      // 影响范围只限 Flowship：看不清、Flowship 没持有、或还有别的程序在阻止熄屏，都交给系统，一律不碰
      if (!locks) {
        if (!loggedProbeFailed) {
          loggedProbeFailed = true;
          safeLog(`[power] ${why}：没能确认当前是谁在阻止熄屏（pmset 出错），为不影响其他程序，不介入`);
        }
        return;
      }
      if (!locks.mine) {
        if (!loggedNotHolding) {
          loggedNotHolding = true;
          safeLog(`[power] ${why}：Flowship 当前没有持有亮屏锁，熄屏交给系统`);
        }
        return;
      }
      if (locks.others.length > 0) {
        if (!loggedOthersHold) {
          loggedOthersHold = true;
          const names = [...new Set(locks.others.map((o) => o.name))].slice(0, 3).join("、");
          safeLog(`[power] ${why}：除 Flowship 外还有「${names}」在阻止熄屏，不介入（只处理 Flowship 自己造成的亮屏）`);
        }
        return;
      }
      if (!locked) return; // 探测期间已经解锁
      const res = await execPmset(["displaysleepnow"]);
      if (res?.ok) {
        slept = true;
        safeLog(`[power] ${why}：Flowship 持有亮屏锁，且没有其他程序在阻止熄屏，已让显示器熄灭（页面与 AI 操作不受影响）`);
      } else if (!loggedSleepFailed) {
        loggedSleepFailed = true;
        safeLog(`[power] ${why}：让显示器熄灭失败（pmset displaysleepnow 出错），锁屏后屏幕可能不黑`);
      }
    } catch (err) {
      safeLog(`[power] ${why}：处理出错（不影响使用）：${err?.message || err}`);
    } finally {
      busy = false;
      if (locked) {
        settled = slept;
        if (slept) {
          retryDelayMs = LOCK_RETRY_MIN_MS;
          nextRetryAt = 0;
        } else {
          nextRetryAt = now() + retryDelayMs;
          retryDelayMs = Math.min(retryDelayMs * 2, LOCK_RETRY_MAX_MS);
        }
      }
    }
  };

  const tick = async () => {
    if (!locked || busy || ticking || !decided) return;
    ticking = true;
    try {
      const s = await sampleLastInput();
      if (!s || !locked || busy) return;
      if (decidedInputAt === null) {
        // 处理时没读到空闲时间：用这次读到的当基线（假设此前没人碰过），下一次起才能比较
        decidedInputAt = s.at;
        return;
      }
      if (s.idleMs < idleThresholdSec * 1000) {
        // 用户还在操作 / 刚操作完，别急着熄；没介入的状态下，等他走开后要尽快重新评估（退避回到起步）
        if (!settled) {
          retryDelayMs = LOCK_RETRY_MIN_MS;
          nextRetryAt = 0;
        }
        return;
      }
      if (settled) {
        // 最后一次输入晚于「处理时的最后一次输入」（超出估计误差）= 熄屏之后用户碰过屏幕又走开了；
        // 否则屏幕还是黑的，什么都不用做。
        if (s.at <= decidedInputAt + s.slackMs) return;
        void decide("点亮后无人操作");
        return;
      }
      // 上次没介入：用户已空闲满阈值，按退避间隔重新评估一次（只在「只有 Flowship 在阻止」时才会真的熄屏）
      if (now() < nextRetryAt) return;
      void decide("再次检查");
    } finally {
      ticking = false;
    }
  };

  if (!enabled) {
    return { onLock() {}, onUnlock() {}, isLocked: () => false };
  }

  return {
    onLock() {
      if (locked) return;
      locked = true;
      busy = false;
      ticking = false;
      decided = false;
      decidedInputAt = null;
      settled = false;
      retryDelayMs = LOCK_RETRY_MIN_MS;
      nextRetryAt = 0;
      loggedNotHolding = false;
      loggedOthersHold = false;
      loggedProbeFailed = false;
      loggedSleepFailed = false;
      clearTimers();
      graceTimer = setTimer(() => {
        graceTimer = null;
        void decide("锁屏");
      }, graceMs);
      graceTimer?.unref?.();
      tickTimer = setTick(() => void tick(), pollMs);
      tickTimer?.unref?.();
    },
    onUnlock() {
      locked = false;
      clearTimers();
    },
    isLocked: () => locked,
  };
};

/** main.js 用：spawn pmset，出错 / 超时都不抛，返回 `{ ok, stdout }` */
export const runPmset = (execFile, args) =>
  new Promise((resolve) => {
    try {
      execFile("/usr/bin/pmset", args, { timeout: PMSET_TIMEOUT_MS }, (err, stdout) => {
        resolve({ ok: !err, stdout: String(stdout ?? "") });
      });
    } catch {
      resolve({ ok: false, stdout: "" });
    }
  });
