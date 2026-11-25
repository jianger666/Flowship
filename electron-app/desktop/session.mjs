/**
 * 电脑操作会话（纯逻辑状态机，全部依赖注入，不 import electron / koffi）。
 *
 * 一个「会话」= AI 在某个任务里连续操作电脑的一段时间。它负责三件事：
 *   1. 开始：电脑没锁屏就直接开始；锁屏就按策略自动解锁并盖上遮罩（解锁器 / 遮罩由外面注入）。
 *      Windows 有「锁屏后台档」（注入了 background）：锁屏时默认不解锁，直接对已打开的应用窗口发消息 + 逐窗口截图，
 *      只有 AI 明确要求（foreground）或后台档不够用时才升级成解锁（upgradeToForeground）。
 *   2. 进行中：每个动作前检查「用户有没有动键鼠」（有就立刻让位）、会话有没有超时 / 被关 / 被另一任务占用。
 *   3. 结束：撤遮罩；如果电脑是我们解锁的，就把它锁回去（用户接管时不锁——用户就在电脑前）。
 *
 * 会话模式 mode：foreground = 真实键鼠（没锁屏 / 我们解锁了）；background = 电脑一直锁着，没有解锁、没有遮罩、不碰密码。
 * 后台档同样受「锁屏时也能用」开关与请求来源两道闸门约束，同样有看门狗和用户接管让位；
 * 它的结束不需要锁屏（我们没解锁），会话期间电脑被解锁了（用户回来了）就结束，由下一次调用按正常方式重新开始。
 *
 * 安全不变量（单测逐条钉死，改动前先读 tests/desktop-session.test.ts 的头注释）：
 * - 默认拒绝：设置没开 / 来源不被允许 / 没凭据 / 不支持 / 冷却中，一律不碰锁屏界面。
 * - 一次错误即停：自动解锁失败后进入冷却，期间不再尝试（输错密码会触发账户锁定）。
 * - 预写冷却落盘失败 = 不输密码：输密码之前要先把冷却记录写进盘（防「输入途中崩溃、重启后冷却是空的、同一个密码再输一遍」）；
 *   写不进去（磁盘只读 / 写满）这层保护就没了，所以拒绝解锁（SCREEN_LOCKED）——和「读到坏记录按整段冷却」一样 fail-closed。这不算「输过密码」：不进冷却、不发 unlock_failed。
 * - 用户优先：解锁前发现用户在操作键鼠就不介入；会话中检测到真实输入立刻结束并让位，且用户停手前不抢回。
 * - 安全桌面不是锁屏：屏幕上是 UAC 权限确认之类的系统安全桌面（driver.isSecureDesktopActive）时，开始 / 升级一律拒绝（SECURE_DESKTOP），
 *   会话进行中遇到就结束（不锁屏）——绝不当成锁屏去解锁（解锁器往里输开机密码再回车 = 替用户点了「是」）。
 * - 看门狗：硬上限 + 空闲超时，到点必结束；遮罩一定会撤；结束时电脑锁回去（我们解锁的前提下）。
 * - 结束先等在飞的注入动作停手（上限 actionDrainMs，输入循环自己也看 shouldStop 提前收手），再锁屏 / 撤遮罩：
 *   否则长文本剩下的字和 submit 的回车会打进锁屏界面的密码框，等于一次错误登录。
 * - 锁回去要「确认真的锁上了」才算数：默认方式没锁上就用快捷键兜底再试一次；两次都没成功才报 relock_failed。
 * - 解锁成功后遮罩盖不上：不能把电脑留在「已解锁、没遮罩、人不在」，立刻锁回去并中止这次开始。
 * - 同一时刻只有一个任务持有会话；开始 / 结束并发调用互不踩踏（解锁过程中被取消会等它停手，刚解开的会锁回去）。
 *
 * 「用户有没有动键鼠」的判断（差值法，不依赖 HID / 合成事件的区分）：
 *   最后一次输入时刻 = now − idleSeconds；若它晚于「我们最后一次注入结束时刻 + 宽限」，说明注入之后用户又动了。
 *   动作进行中（acting）不判断——此时的 idle 全是我们自己造成的。
 */
import { DesktopError } from "./types.mjs";

export const SESSION_LIMITS = Object.freeze({
  /** 会话硬上限：到点必结束并锁回去（AI 想继续要重新开始，会再次走完整的解锁流程） */
  maxSessionMs: 15 * 60_000,
  /** 没有任何动作这么久，自动结束 */
  idleEndMs: 3 * 60_000,
  /** 注入结束后多久之内出现的输入仍算「我们自己造成的」（系统处理事件有延迟） */
  takeoverGraceMs: 600,
  /** 后台轮询真实输入 / 超时的间隔 */
  takeoverPollMs: 300,
  /** 用户接管后，要空闲这么久才允许 AI 重新开始 */
  takeoverQuietMs: 30_000,
  /** 解锁前若用户在这么多秒内动过键鼠，视为用户在场（可能正在自己解锁），不介入 */
  userPresentIdleSec: 3,
  /** 自动解锁失败后的冷却：期间不再尝试 */
  unlockCooldownMs: 10 * 60_000,
  /** 结束时等待「锁屏真的生效」的上限（每一次尝试） */
  relockWaitMs: 3_000,
  /** 结束时等在飞的注入动作停手的上限（desktop_type 最长约 2 秒；超时也要锁，不能让电脑一直解着） */
  actionDrainMs: 3_000,
});

/** 等在飞动作停手的轮询间隔 */
const DRAIN_STEP_MS = 50;

/** 结束原因 → 是否把我们解锁的电脑锁回去。user_took_over / relocked_externally / unlocked_externally / secure_desktop 不锁：用户就在电脑前 / 已经是锁屏 / 用户自己解的锁 / 屏幕上有要用户亲自处理的安全提示 */
const RELOCK_REASONS = new Set([
  "task_done",
  "explicit",
  "idle",
  "max_duration",
  "disabled",
  "server_gone",
  "cancelled",
  "app_quit",
  // 会话中途遮罩盖不全（有显示器是裸的）：和「解锁后遮罩盖不上」同口径——锁回去，别让 AI 在「已解锁、有屏幕没遮罩、人不在」的状态下接着干
  "overlay_incomplete",
]);

/**
 * 屏幕上是系统安全桌面（Windows UAC 权限确认等）时给 AI 的话。写成「模型能照着办」的样子：交还用户、别重试。
 * 它不是锁屏：会话没锁、键鼠注入和截图也碰不到它；更不能去「解锁」——解锁器会往里输开机密码再回车，等于替用户点了「是」。
 */
const SECURE_DESKTOP_MESSAGE =
  "电脑屏幕上正显示 Windows 的系统安全提示（比如 UAC「是否允许此应用对你的设备进行更改」的权限确认）。这类提示只能由用户本人在电脑前处理，AI 不会、也不能替用户点；系统也没有把它当成锁屏去解锁。请告诉用户：电脑上有一个需要他亲自处理的系统权限弹窗，处理完再让你继续。不要重试";

/**
 * 读不到「电脑现在是不是锁屏」（驱动返回 null）时给 AI 的话。和解锁器同一个口径（unlockers/darwin.mjs、win32.mjs 对 null 都是
 * 「为安全起见不介入」）：不能把「不知道」当成「没锁」放行——macOS 上键鼠注入会直接落进锁屏界面的密码框（第二轮评审 P1-2）。
 * 用 INTERNAL 码（不新增错误码：码表是 types.mjs ↔ server 镜像 ↔ preload 三处对账的契约）。
 */
const LOCK_STATE_UNKNOWN_MESSAGE =
  "读不到电脑当前是不是锁屏状态，为安全起见这次没有操作电脑（电脑要是其实锁着，键鼠输入会打进锁屏界面的密码框）。请告诉用户：稍后再试；反复出现的话，请在设置的「电脑操作」里导出诊断信息反馈给开发者";
const lockStateUnknownError = () => new DesktopError("INTERNAL", LOCK_STATE_UNKNOWN_MESSAGE);

/**
 * 输密码之前预写冷却记录、但写不进磁盘时给 AI 的话（拒绝解锁）。code 用 SCREEN_LOCKED：电脑仍是锁屏、没碰锁屏界面，
 * server 对它的固定文案是「不要重试、告诉用户回到电脑前解锁」，且详情（本句）按可信文本原样写给 AI；
 * 不用 UNLOCK_FAILED（server 会说「已进入冷却、10 分钟内不再试、请检查开机密码」，与事实不符）。
 * server 对详情最多留 300 个字符：要点（原因 → 没输过密码 → 请用户怎么办）按这个顺序放，别写长。
 */
const COOLDOWN_NOT_PERSISTED_MESSAGE =
  "没能把自动解锁的冷却记录写到磁盘（磁盘可能已满、只读或没有写入权限）。为避免输入开机密码途中程序崩溃、重启后又把同一个（可能错的）密码再输一遍，这次没有自动解锁，也没有输入过开机密码，电脑仍是锁屏。请告诉用户：检查磁盘空间和 Flowship 数据文件夹的写入权限，或亲自解锁电脑；处理好后再让你重试";

/**
 * 解锁器说「根本没输过密码」（attempted === false）时，解锁器给的 code → 会话抛给调用方的错误码；不在表里的一律 UNLOCK_FAILED。
 * 用 Map 而不是普通对象：code 是外部来的字符串，普通对象会把 "constructor" / "valueOf" 这类名字当成命中。
 */
const UNATTEMPTED_UNLOCK_CODES = new Map([
  ["NEED_PERMISSION", "NEED_PERMISSION"],
  ["USER_PRESENT", "USER_TOOK_OVER"],
  ["SECURE_DESKTOP", "SECURE_DESKTOP"],
]);

/**
 * @typedef {{ kind: string, taskId: string | null, at: number, reason?: string, error?: string, unlockedByUs?: boolean, relocked?: boolean, mode?: string }} SessionEvent
 *
 * @param {{
 *   driver: import("./types.mjs").DesktopDriver,
 *   unlocker?: import("./types.mjs").ScreenUnlocker | null,
 *   overlay: import("./types.mjs").DesktopOverlay,
 *   getPolicy: () => { enabled: boolean, lockedAccess: boolean },
 *   background?: { available: () => boolean, reset?: () => void } | null,
 *   notify?: (evt: SessionEvent) => void,
 *   audit?: (entry: Record<string, unknown>) => void,
 *   cooldownStore?: { load: () => number, save: (until: number) => void } | null,
 *   keepAwake?: { acquire: () => (() => void) | void } | null,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (msg: string) => void,
 *   limits?: Partial<typeof SESSION_LIMITS>,
 * }} deps  cooldownStore：冷却截止时刻的落盘（见 cooldown-store.mjs；不传 = 只放内存，单测默认）
 *   keepAwake：前台会话期间不让显示器睡眠（睡了会锁屏、会话被打断、截图是黑的）；acquire() 返回释放函数（index.mjs 用 powerSaveBlocker 实现；不传 = 不管）
 */
export const createDesktopSession = (deps) => {
  const {
    driver,
    unlocker = null,
    overlay,
    getPolicy,
    background = null,
    notify = () => {},
    audit = () => {},
    cooldownStore = null,
    keepAwake = null,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = () => {},
  } = deps;
  const limits = { ...SESSION_LIMITS, ...(deps.limits ?? {}) };

  /**
   * 收尾 / 通知路径上的日志：日志后端自己出问题（磁盘满 / 管道断）不能打断「锁屏 / 撤遮罩 / 复位 / 发事件」——
   * 这些步骤哪一步被一个日志异常带跑，都可能把电脑留在「已解锁、遮罩还在 / 状态卡死」的样子（第二轮评审 P1-3）。
   */
  const safeLog = (msg) => {
    try {
      log(msg);
    } catch {
      /* 日志本身出问题：无处可报，忽略 */
    }
  };

  /** idle | unlocking | active | ending */
  let state = "idle";
  /**
   * 本次会话的操作方式：foreground = 真实键鼠（电脑没锁屏，或我们解锁了）；
   * background = 电脑一直是锁屏状态，靠窗口消息 / 逐窗口截图操作（Windows 锁屏后台档），没有解锁、没有遮罩。
   */
  let mode = "foreground";
  let ownerTaskId = null;
  let unlockedByUs = false;
  let startedAt = 0;
  let lastActionAt = 0;
  let lastInjectedAt = 0;
  /** 进行中的「注入类」动作数（>0 时不判断用户接管） */
  let acting = 0;
  /**
   * 动作世代：每次会话收尾 +1（见 abandonInFlightActions）。runAction / runRead 开始时记下当时的世代，
   * 结束时只有世代没变才去动计数 / 时间戳。
   * 为什么需要：收尾等在飞的动作停手有上限（actionDrainMs），超时了照常收尾——那个卡住的动作还没返回，它占的计数却不能留着：
   * 留着会让下一个会话里 userInputDetected 恒为 false（用户碰了键鼠 AI 也不让位）；
   * 而它事后才返回时，又会去减新会话的计数（减成负数 / 把新会话自己的注入当成用户）、刷新新会话的「最后注入时刻」。
   */
  let actionEpoch = 0;
  let watchTimer = null;
  /** 用户接管过：用户停手（空闲满 takeoverQuietMs）之前不允许重新开始 */
  let tookOver = false;
  /**
   * 自动解锁的冷却截止时刻。落盘（cooldownStore）：输错之后重启 / 崩溃重启 / 自动更新 relaunch 不能把冷却清零，
   * 否则下一次请求会把同一个错密码再输一遍（第二轮评审 P1-1）。
   * 读不了 / 读不懂记录 = fail-closed，按一整段冷却算；记录里的截止时刻最多只认「现在起一整段冷却」那么远
   *（时钟被往回拨过 / 文件被改成很远的未来，都不能让功能永久不可用）。
   */
  let unlockCooldownUntil = (() => {
    if (!cooldownStore) return 0;
    try {
      const until = cooldownStore.load();
      // 返回的不是有效时间戳（NaN 之类）：NaN 参与比较永远为假，直接放行就等于「没失败过」——按坏记录处理（下面 catch 里整段冷却）
      if (typeof until !== "number" || !Number.isFinite(until) || until < 0) throw new Error("冷却记录返回了无效的值");
      if (until <= now()) return 0;
      return Math.min(until, now() + limits.unlockCooldownMs);
    } catch (err) {
      safeLog(`[desktop-session] 冷却记录读不了、按一整段冷却处理：${err?.message || err}`);
      return now() + limits.unlockCooldownMs;
    }
  })();
  let beginPromise = null;
  let beginAbort = null;
  /** 后台档 → 前台档的升级（和开始是两件事：开始返回 { unlockedByUs, locked, mode }，升级返回 { upgraded, mode }，不能共用 beginPromise） */
  let upgradePromise = null;
  let upgradeAbort = null;
  let endPromise = null;

  const emit = (kind, extra = {}) => {
    const evt = { kind, taskId: ownerTaskId, at: now(), ...extra };
    try {
      notify(evt);
    } catch (err) {
      safeLog(`[desktop-session] 通知回调出错（已忽略）：${err?.message || err}`);
    }
    try {
      audit({ type: "session", ...evt });
    } catch {
      /* 审计失败不影响主流程 */
    }
  };

  /**
   * 前台会话期间不让显示器睡眠：睡了会锁屏（会话被 relocked_externally 打断）、之后的截图是黑的。
   * 只在前台档 active 期间持有（锁屏后台档本来就是锁着的），收尾 / 退出 / 出错的每条路都要释放（dropAwake 幂等）。
   * 拿不到 / 放不掉只记日志，不影响会话。
   */
  let releaseAwake = null;
  const holdAwake = () => {
    if (releaseAwake || !keepAwake) return;
    try {
      const release = keepAwake.acquire();
      if (typeof release === "function") releaseAwake = release;
    } catch (err) {
      safeLog(`[desktop-session] 防显示器睡眠没能开启（已忽略，会话继续）：${err?.message || err}`);
    }
  };
  const dropAwake = () => {
    const release = releaseAwake;
    releaseAwake = null;
    if (!release) return;
    try {
      release();
    } catch (err) {
      safeLog(`[desktop-session] 防显示器睡眠没能解除（已忽略）：${err?.message || err}`);
    }
  };

  const busy = () => new DesktopError("DENIED", "另一个任务正在操作这台电脑，等它结束后再试");

  /**
   * 把当前的冷却截止时刻落盘（0 = 没有冷却）。返回有没有真的落盘：没注入 cooldownStore（单测默认）= 没有「落盘」这回事，算成功。
   * 写不进去只记日志、不抛——怎么办由调用方定：输密码之前的预写（armUnlockCooldown）失败 = 拒绝解锁；
   * 结算 / 重置时的写失败只记日志，不抛、不重试。
   * @param {string} [consequence] 写失败时日志里交代的后果。默认说法只适用于结算时「保持」那一种（startUnlockCooldown：输错了，
   *   内存里的冷却照样生效）。这时输密码之前的预写已经落盘，盘上留着的就是预写的那一段，只是起点比这次失败早（输入 + 等验证的耗时，十几秒）——
   *   所以重启后冷却**仍在**、只是会早结束一点，不是「会丢」（第六轮评审 P3：旧默认文案写「重启后会丢」是错的）；
   *   写 0 的场合（预写、撤销、重置）方向正好相反，各自传自己的——
   *   预写由 armUnlockCooldown 传（冷却已回滚），撤销 / 重置（内存已是 0、盘上还留着旧冷却）由 settleUnlockCooldown / resetUnlockCooldown 传
   * @returns {boolean}
   */
  const persistCooldown = (consequence = "内存里仍然生效；盘上还留着输密码之前预写的那一段（起点比这次失败早十几秒）：重启后冷却仍在，只是会早结束一点") => {
    if (!cooldownStore) return true;
    try {
      cooldownStore.save(unlockCooldownUntil);
      return true;
    } catch (err) {
      safeLog(`[desktop-session] 冷却记录写不进去（${consequence}）：${err?.message || err}`);
      return false;
    }
  };
  /**
   * 冷却是「预写」出来的、结果还没出：unlock() 还在进行（输密码 → 等验证），盘上已经是一整段冷却，但这还不算「输错了」。
   * 为 true 时 status() 不对外报冷却（设置页不该在 AI 正常解锁的十来秒里闪一下「解锁失败、冷却中」）。
   */
  let cooldownProvisional = false;
  /** 一次输错（或疑似输错）：进入冷却并落盘 */
  const startUnlockCooldown = () => {
    unlockCooldownUntil = now() + limits.unlockCooldownMs;
    cooldownProvisional = false;
    persistCooldown();
  };
  /**
   * 输密码**之前**先把冷却预写进盘（第三轮评审 P1-2）。以前冷却要等 unlock() 返回之后才落盘，可输密码到 unlock() 返回之间最长要十来秒
   * （输入 + 等验证 + 取消观察）——这段窗口里应用退出 / 崩溃 / 自动更新重启，重启后冷却是空的，下一次请求把同一个（可能是错的）密码再输一遍。
   * 先按「这次会输错」落盘；结果出来后由 settleUnlockCooldown 改写：解开了 / 根本没输过 → 撤销，输过没解开 → 保持并刷新起点。
   * 预写没落盘 = 这层保护没了（进程在输密码途中死掉，重启后冷却是空的）：把内存里的冷却时刻与 provisional 标记**回滚**到预写之前，
   * 返回 false 让调用方拒绝解锁——这次一个键都没输过，不能留下一段冷却（否则磁盘恢复后下一次请求还被一段不存在的失败挡着）。
   * @returns {boolean} 冷却记录是否已经落盘（false = 已回滚，调用方不能去输密码）
   */
  const armUnlockCooldown = () => {
    const prevUntil = unlockCooldownUntil;
    const prevProvisional = cooldownProvisional;
    unlockCooldownUntil = now() + limits.unlockCooldownMs;
    cooldownProvisional = true;
    if (persistCooldown("输密码之前的预写没落盘：冷却已回滚，这次不解锁、不输密码")) return true;
    unlockCooldownUntil = prevUntil;
    cooldownProvisional = prevProvisional;
    return false;
  };
  /** 结算预写的冷却：输过密码却没解开（含解锁器抛异常 / 没声明 attempted）才算输错；解开了 / 根本没输过（attempted === false）撤销 */
  const settleUnlockCooldown = (result) => {
    const typedAndFailed = !result.ok && result.attempted !== false;
    if (typedAndFailed) {
      startUnlockCooldown();
      return;
    }
    unlockCooldownUntil = 0;
    cooldownProvisional = false;
    // 撤销 = 把盘上预写的那一整段冷却改写成 0。这次写失败时内存里已经是 0、盘上还留着预写的那段——
    // 默认文案（「内存里仍然生效」）恰好说反了；方向是 fail-closed（重启后多一次冷却，不危险），但日志要说准，别误导排障。
    // 没有兜底删除：cooldown-store 没有删除接口（它刻意不删文件，见 cooldown-store.mjs 顶部说明）
    persistCooldown("冷却已在内存里撤销，但盘上还留着预写的那一段：重启后会多出一次冷却");
  };

  /** 输入桌面是不是系统安全桌面（UAC 权限确认等）。只有 Windows 驱动会答；没有这个方法 / 读不到 / 抛错 = 不是 */
  const secureDesktopActive = () => {
    try {
      return driver.isSecureDesktopActive?.() === true;
    } catch {
      return false;
    }
  };
  const secureDesktopError = () => new DesktopError("SECURE_DESKTOP", SECURE_DESKTOP_MESSAGE);

  const safeOverlay = (fn, what) => {
    try {
      fn();
    } catch (err) {
      safeLog(`[desktop-session] 遮罩${what}失败（已忽略，会话继续）：${err?.message || err}`);
    }
  };

  /** 遮罩盖全了没有：只认明确的 false；没有 isComplete / 抛了 → null（不知道） */
  const overlayComplete = () => {
    try {
      const r = overlay.isComplete?.();
      return typeof r === "boolean" ? r : null;
    } catch {
      return null;
    }
  };

  /** 读锁屏状态，驱动抛了就当「读不到」（null）：收尾路径 / 看门狗上的读取出错不能打断锁屏 / 撤遮罩 / 复位 */
  const readLockedOrNull = () => {
    try {
      return driver.isScreenLocked();
    } catch {
      return null;
    }
  };

  // ── 用户接管判断 ──

  const userInputDetected = () => {
    if (acting > 0) return false;
    const idleMs = driver.idleSeconds() * 1000;
    const lastInputAt = now() - idleMs;
    return lastInputAt > lastInjectedAt + limits.takeoverGraceMs;
  };

  const takeover = async () => {
    if (state !== "active") return;
    tookOver = true;
    // unlockedByUs 带上：电脑是我们解锁的、人又不在（猫 / 路人 / 鼠标抖动都会触发接管）时，server 要提醒用户「没有重新锁屏」
    emit("user_took_over", { unlockedByUs });
    await end("user_took_over", { relock: false });
  };

  // ── 看门狗 ──

  const tick = () => {
    if (state !== "active") return;
    try {
      if (!getPolicy().enabled) {
        void end("disabled");
        return;
      }
      const t = now();
      if (t - startedAt > limits.maxSessionMs) {
        void end("max_duration");
        return;
      }
      if (acting === 0 && t - lastActionAt > limits.idleEndMs) {
        void end("idle");
        return;
      }
      if (userInputDetected()) {
        void takeover();
        return;
      }
      // 前台档会话进行中电脑被锁屏了（屏保 / 用户手动锁 / 合盖睡眠）：立刻结束，不等下一个动作的 guard（第三轮评审 P1-3）。
      // guard 只在动作开始时看一眼；desktop_type 要打约 2 秒，锁屏发生在中途时剩下的字（和 submit 的回车）会落进锁屏界面的密码框，
      // 等于一次错误登录，而且不进冷却。结束后 state 不再是 active，驱动的输入循环在下一个批次看 shouldStop 就收手。
      // 动作进行中（acting > 0）照样检查——那恰恰是最危险的时候。只认明确的 true：读不到（null）不结束，与 guard 的口径一致
      // （那边是「这一下不放行」、下一次读到再说）；后台档本来就锁着，不看
      if (mode === "foreground" && readLockedOrNull() === true) {
        void end("relocked_externally", { relock: false });
        return;
      }
      // 遮罩盖不全（会话中途接入的显示器 / 改分辨率之后窗口建不出来 / 窗口被销毁了）：那块屏幕此刻是裸的，旁人看得见 AI 在干什么，而用户不在场
      // （第三轮评审「overlay 补建失败」：以前只记一行日志）。和「解锁后盖不上遮罩就锁回去」同一个口径：结束会话并锁回去，
      // 下一次 desktop_* 会重新开始、重新盖——还盖不上就在开始阶段报「遮罩没能显示」。
      // 只在遮罩该在的时候查（前台档 + 我们解锁的；用户在场 / 后台档没有遮罩）；遮罩实现没有 isComplete（旧实现 / 假遮罩）、或探测本身抛了：当没问题，不为一次读不到结束会话
      if (unlockedByUs && mode === "foreground" && overlayComplete() === false) void end("overlay_incomplete");
    } catch (err) {
      safeLog(`[desktop-session] 看门狗检查出错（已忽略）：${err?.message || err}`);
    }
  };

  const stopWatch = () => {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
  };

  const startWatch = () => {
    stopWatch();
    watchTimer = setInterval(tick, limits.takeoverPollMs);
    watchTimer.unref?.();
  };

  // ── 开始 ──

  const waitFor = async (predicate, timeoutMs, stepMs = 200) => {
    const deadline = now() + timeoutMs;
    for (;;) {
      if (predicate()) return true;
      if (now() >= deadline) return false;
      await sleep(stepMs);
    }
  };

  const cancelledError = () => new DesktopError("CANCELLED", "电脑操作在开始前被取消了");

  /**
   * 把电脑锁回去，并确认真的进入了锁屏状态。永不抛。
   * 第一次用解锁器的默认方式；没成功（命令失败 / relockWaitMs 内没进入锁屏）就换快捷键再试一次——
   * 一次失败就放弃的话，电脑会被留在「已解锁」状态，而用户很可能不在场。
   * @returns {Promise<{ relocked: boolean, error: string | null }>}
   */
  const relockNow = async () => {
    try {
      if (!unlocker) return { relocked: false, error: "没有解锁器" };
      let error = null;
      for (const method of ["auto", "shortcut"]) {
        // 第二次之前再看一眼：第一次也许只是慢了点，这会儿已经锁上了就别再按快捷键
        if (method === "shortcut" && readLockedOrNull() === true) return { relocked: true, error: null };
        try {
          const r = await unlocker.lock({ method });
          if (!r?.ok) {
            error = r?.error ?? "未知原因";
            continue;
          }
        } catch (err) {
          error = String(err?.message || err);
          continue;
        }
        if (await waitFor(() => readLockedOrNull() === true, limits.relockWaitMs)) return { relocked: true, error: null };
        error = "已发出锁屏命令，但电脑没有进入锁屏状态";
      }
      return { relocked: false, error };
    } catch (err) {
      // 注释说「永不抛」就要真的永不抛：以前 driver.isScreenLocked() 在 try 外、抛了就带着整个收尾一起出错——
      // 「要锁回去」的债丢了、遮罩没撤（第二轮评审 P1-3）。这里兜住，让调用方走 relock_failed 的正常路径
      return { relocked: false, error: String(err?.message || err) };
    }
  };

  /** 锁屏时能不能碰电脑的两道闸（设置里「锁屏时也能用」+ 这次请求的来源）：开始 / 后台升级前台共用，文案不变 */
  const requireLockedAccess = (opts) => {
    const policy = getPolicy();
    if (!policy.lockedAccess) {
      throw new DesktopError(
        "SCREEN_LOCKED",
        "电脑现在是锁屏状态。要让 AI 在锁屏时也能用，请在 Flowship 设置的「电脑操作」里开启「锁屏时也能用」并保存开机密码；否则等用户回到电脑前解锁后再继续",
      );
    }
    if (!opts.allowUnlock) {
      throw new DesktopError(
        "SCREEN_LOCKED",
        "电脑现在是锁屏状态，而这次指令的来源不被允许自动解锁（只有用户本人在 Flowship 里或飞书私聊里发的指令才可以）。请告诉用户电脑已锁屏",
      );
    }
  };

  /** 锁屏后台档现在能不能用（平台驱动支持 + 就绪）。没注入 = 不支持（macOS 永远走解锁） */
  const backgroundAvailable = () => {
    try {
      return background?.available?.() === true;
    } catch {
      return false;
    }
  };

  /**
   * 解锁并盖遮罩（电脑此刻是锁屏状态，且 requireLockedAccess 已通过）。成功后 unlockedByUs = true、遮罩已盖。
   * 开始（锁屏时）和「后台档升级到前台档」共用。失败一律抛 DesktopError，调用方负责把 state 还原。
   * 遮罩时机：默认解锁成功后才盖；解锁器声明 overlayBeforeUnlock（Windows：解锁由 SYSTEM 组件在登录界面输密码，
   * 桌面一出现就要已经被盖住）时先盖再解锁，解锁失败 / 取消再撤。
   */
  const unlockAndCover = async (ac) => {
    if (!unlocker || unlocker.supported === false) {
      throw new DesktopError("UNSUPPORTED", "当前系统暂不支持锁屏自动解锁。请告诉用户电脑已锁屏，需要用户解锁后才能继续");
    }
    if (unlockCooldownUntil > now()) {
      // 不一口咬定「刚刚失败过、去检查密码」（第六轮评审 P3）：这段冷却多半来自上一次输错，但「输密码途中程序退出、重启后读回预写的冷却」
      // 与「撤销预写时写 0 失败、盘上遗留的那一段」也会让它生效——这两种情形根本没有「输错」，密码未必有问题。
      // 详情的开头是「自动解锁正在冷却中」，tools.ts 的 UNLOCK_FAILED 说明据此告诉 AI：别断言密码不对
      throw new DesktopError(
        "UNLOCK_FAILED",
        "自动解锁正在冷却中：为避免连续输错密码导致账户被锁定，一段时间内不再自动尝试。冷却多半是刚刚自动解锁失败过，但程序中途退出时留下的冷却记录也会让它生效（那种情况下密码未必有问题）。请告诉用户：电脑仍是锁屏，需要他亲自解锁；只有他确认之前确实自动解锁失败过，才建议他检查设置里保存的开机密码",
      );
    }
    const hasCredential = await unlocker.hasCredential();
    if (ac.signal.aborted) throw cancelledError();
    if (!hasCredential) {
      throw new DesktopError(
        "SCREEN_LOCKED",
        driver.platform === "win32"
          ? "还没有安装解锁组件或保存开机密码：请告诉用户到 Flowship 设置的「电脑操作」里安装解锁组件并保存开机密码（也可以继续用锁屏后台模式，但它只能操作已经打开的应用）"
          : "还没有保存开机密码：请告诉用户到 Flowship 设置的「电脑操作」里保存",
      );
    }
    // 用户刚动过键鼠 = 人在电脑前（也许正自己输密码），AI 不要凑上去
    if (driver.idleSeconds() < limits.userPresentIdleSec) {
      throw new DesktopError("USER_TOOK_OVER", "检测到用户正在操作电脑（可能正在自己解锁），AI 先不介入");
    }

    state = "unlocking";
    emit("unlocking");
    const coverFirst = unlocker.overlayBeforeUnlock === true;
    if (coverFirst) {
      try {
        overlay.show();
      } catch (err) {
        // 还没解锁：什么都没改变，不用锁回去
        const why = String(err?.message || err).slice(0, 120);
        safeLog(`[desktop-session] 解锁前遮罩显示失败，不解锁：${why}`);
        safeOverlay(() => overlay.hide(), "撤除");
        throw new DesktopError(
          "INTERNAL",
          `没能先盖上遮罩（${why}），为安全起见没有解锁。请告诉用户：这次没能操作电脑（遮罩没能显示）；反复出现的话，请在设置的「电脑操作」里导出诊断信息反馈给开发者`,
        );
      }
    }
    // 输密码之前先把冷却预写进盘（见 armUnlockCooldown）：从这里到 unlock() 返回之间进程死掉，重启后也不会把同一个密码再输一遍。
    // 预写没落盘（磁盘只读 / 写满）= 这层保护没了：不输密码、不解锁（fail-closed，和「读到坏记录按整段冷却」同一个口径）。
    // 这不算「输过密码」：armUnlockCooldown 已把冷却回滚（不进冷却），也不发 unlock_failed（那是「输过没解开」的事件，会让 server 说「10 分钟内不再试」）；
    // 先盖了遮罩（coverFirst）的要撤掉——电脑没解锁，遮罩不能留着
    if (!armUnlockCooldown()) {
      if (coverFirst) safeOverlay(() => overlay.hide(), "撤除");
      throw new DesktopError("SCREEN_LOCKED", COOLDOWN_NOT_PERSISTED_MESSAGE);
    }
    let result;
    try {
      result = await unlocker.unlock({
        signal: ac.signal,
        onStep: (s) => {
          try {
            audit({ type: "unlock_step", name: s.name, ok: s.ok, ms: s.ms });
          } catch {
            /* ignore */
          }
        },
      });
    } catch (err) {
      result = { ok: false, error: `自动解锁出现异常：${err?.message || err}` };
    }
    // 解锁器没给出结果（返回了 undefined / 非对象）：按「输过且没解开」算，别让下面的 result.ok 抛 TypeError、把预写的冷却卡在「待结算」
    if (!result || typeof result !== "object") result = { ok: false, error: "解锁器没有返回结果" };
    // 结算预写的冷却：解开了 / 根本没输过 → 撤销；输过没解开（含被取消得太晚、提交后验证中被打断）→ 保持并刷新起点
    settleUnlockCooldown(result);
    if (ac.signal.aborted) {
      // 解锁过程中被取消：已经解开的要锁回去（并确认真的锁上了、把结果告诉用户），别把电脑留在解锁状态
      if (result.ok) {
        const r = await relockNow();
        if (r.relocked) emit("relocked", { reason: "cancelled" });
        else emit("relock_failed", { reason: "cancelled", error: String(r.error ?? "未知原因").slice(0, 200) });
      } else if (result.attempted !== false) {
        // 没解开、但密码已经输进去过（取消来得太晚 / 提交后验证中被打断；解锁器没声明 attempted 也按「输过了」算）：
        // 和「输错了」同样处理——进冷却（上面 settleUnlockCooldown 已落盘）+ 告诉用户。否则下一次请求会立刻再输一遍：密码本来就是错的话，
        // 一次取消就多送了一次输错，违背「一次错误即停」（连续输错会触发账户锁定）。
        // attempted === false（没权限 / 没锁屏 / 读不到密码）= 根本没输过，不算，保持静默取消。
        const reason = String(result.error ?? "解锁过程被中途取消，没能确认是否解开");
        emit("unlock_failed", { error: reason.slice(0, 200), cooldown: true });
      }
      if (coverFirst) safeOverlay(() => overlay.hide(), "撤除");
      throw cancelledError();
    }
    if (!result.ok) {
      if (coverFirst) safeOverlay(() => overlay.hide(), "撤除");
      const reason = String(result.error ?? "未知原因");
      // cooldown：这次失败会不会让「10 分钟内不再试」生效——server 据此说对话（没输过密码的失败不进冷却，别告诉用户要等 10 分钟）
      emit("unlock_failed", { error: reason.slice(0, 200), cooldown: result.attempted !== false });
      if (result.attempted === false) {
        // 密码根本没输过（没权限 / 没锁屏 / 读不到密码 / 用户自己解开了）：不算「输错」，不进冷却
        const code = UNATTEMPTED_UNLOCK_CODES.get(result.code) ?? "UNLOCK_FAILED";
        throw new DesktopError(code, `没能开始自动解锁：${reason}`);
      }
      // 一次错误即停：进入冷却（上面 settleUnlockCooldown 已落盘，重启不清零），绝不重试（输错密码会触发账户锁定）
      throw new DesktopError("UNLOCK_FAILED", `自动解锁失败，已停手、不会重试：${reason}。请告诉用户电脑仍是锁屏状态`);
    }
    unlockedByUs = true;
    // 解锁成功立刻盖遮罩（旁人看不到 AI 在干什么；先盖的解锁器此时已经盖着）。盖不上就不能继续：电脑已经被我们解开了，
    // 再让 AI 在「已解锁、没遮罩、人不在」的状态下干活，比没解锁更糟——锁回去、中止这次开始
    try {
      if (!coverFirst) overlay.show();
    } catch (err) {
      const why = String(err?.message || err).slice(0, 120);
      safeLog(`[desktop-session] 遮罩显示失败，中止并锁回去：${why}`);
      const r = await relockNow();
      // 先锁屏再撤遮罩（show() 失败时自己已经清掉了半成品，这里是兜底）
      safeOverlay(() => overlay.hide(), "撤除");
      unlockedByUs = false;
      emit(r.relocked ? "relocked" : "relock_failed", {
        reason: "overlay_failed",
        ...(r.relocked ? {} : { error: String(r.error ?? "未知原因").slice(0, 200) }),
      });
      throw new DesktopError(
        "INTERNAL",
        `解锁之后没能盖上遮罩（${why}），为安全起见已中止这次操作${
          r.relocked ? "，并把电脑锁回去了" : "；想把电脑锁回去但没成功，电脑可能还是解锁状态"
        }。请告诉用户：这次没能操作电脑（遮罩没能显示）；反复出现的话，请在设置的「电脑操作」里导出诊断信息反馈给开发者`,
      );
    }
    emit("unlocked");
  };

  const doBegin = async (taskId, opts, ac) => {
    // 用户接管之后的静默期：用户还在动就不抢
    if (tookOver) {
      if (driver.idleSeconds() * 1000 < limits.takeoverQuietMs) {
        throw new DesktopError("USER_TOOK_OVER", "用户刚刚在操作电脑，AI 已让位。等用户停手（约 30 秒没有键鼠操作）后再试");
      }
      tookOver = false;
    }

    // 屏幕上是 UAC 之类的系统安全桌面：它不是锁屏（会话没锁），键鼠注入和截图也碰不到它。绝不能往下走到「当锁屏去解锁」——
    // 解锁器会往里输开机密码再回车，等于替用户点了「是」。停手交还用户
    if (secureDesktopActive()) throw secureDesktopError();

    const locked = driver.isScreenLocked();
    // 读不到 = 不知道：不能当「没锁」往下走（会直接对一台可能锁着的电脑注入键鼠）。和解锁器对 null 的口径一致，见 LOCK_STATE_UNKNOWN_MESSAGE
    if (locked === null || locked === undefined) throw lockStateUnknownError();
    mode = "foreground";
    if (locked === true) {
      requireLockedAccess(opts);
      if (backgroundAvailable() && opts.foreground !== true) {
        // 锁屏后台档（Windows）：不解锁、不盖遮罩、不输密码——直接对用户锁屏前已经打开的应用窗口操作。
        // 不做「用户在场」检查：电脑是锁着的，用户要用得先解锁，而解锁本身（输密码）会被接管判断抓到
        mode = "background";
        try {
          background.reset?.();
        } catch {
          /* 清理失败不影响开始 */
        }
      } else {
        await unlockAndCover(ac);
      }
    }

    startedAt = now();
    lastActionAt = startedAt;
    lastInjectedAt = startedAt;
    state = "active";
    startWatch();
    // 前台档：会话期间不让显示器睡眠（锁屏后台档本来就是锁着的，不管）。收尾的每条路都会释放，见 dropAwake
    if (mode === "foreground") holdAwake();
    audit({ type: "session", kind: "begin", taskId, unlockedByUs, locked: locked === true, mode });
    if (mode === "background") emit("background_started");
    return { unlockedByUs, locked: locked === true, mode };
  };

  /**
   * 开始（或续用）会话。
   * @param {string} taskId
   * @param {{ allowUnlock?: boolean, foreground?: boolean }} [opts]
   *   allowUnlock：这次请求的来源是否被允许自动解锁（server 判定，默认 false = 拒绝）
   *   foreground：锁屏时不走后台档，直接解锁走前台（AI 明确要求，比如它知道目标应用在锁屏后台里画不出东西）
   */
  const begin = async (taskId, opts = {}) => {
    if (!getPolicy().enabled) {
      throw new DesktopError("ACCESS_DISABLED", "「电脑操作」没有开启：请告诉用户在 Flowship 设置里打开「电脑操作」");
    }
    if (endPromise) await endPromise;
    if (beginPromise) {
      if (ownerTaskId !== taskId) throw busy();
      return beginPromise;
    }
    if (upgradePromise) {
      // 后台档正在升级成前台档（同一任务的并行工具调用）：等它有结果再续用——成功了就是前台会话，失败了仍是后台会话
      if (ownerTaskId !== taskId) throw busy();
      try {
        await upgradePromise;
      } catch {
        /* 升级失败不影响续用后台会话；被取消时下面会看到 state 已经不是 active */
      }
      if (endPromise) await endPromise;
    }
    if (state === "active") {
      if (ownerTaskId !== taskId) throw busy();
      return { unlockedByUs, locked: mode === "background", resumed: true, mode };
    }
    ownerTaskId = taskId;
    const ac = new AbortController();
    beginAbort = ac;
    const p = doBegin(taskId, opts, ac)
      .catch((err) => {
        // 开始失败：回到干净的 idle（被 end 打断时 state 是 ending，由 doEnd 自己收尾）
        if (state === "unlocking") state = "idle";
        if (state === "idle") ownerTaskId = null;
        throw err;
      })
      .finally(() => {
        if (beginPromise === p) beginPromise = null;
        if (beginAbort === ac) beginAbort = null;
      });
    beginPromise = p;
    return p;
  };

  /**
   * 锁屏后台档 → 前台档：电脑还锁着，但 AI 发现后台操作不够用（目标应用锁屏时画不出东西 / 需要 Win 键这类系统级按键），
   * 要求解锁走真实键鼠。和「锁屏时开始」同一套闸门与解锁流程（单次尝试 / 冷却 / 遮罩 / 用户在场检查），成功后 mode = foreground，
   * 结束时照常锁回去。解锁没成：会话仍是后台档（电脑还锁着，后台操作可以继续），错误抛给调用方。
   * 非后台会话（没会话 / 已经是前台）→ 什么都不做，返回 { upgraded: false }。
   * @param {string} taskId
   * @param {{ allowUnlock?: boolean }} [opts]
   * @returns {Promise<{ upgraded: boolean, mode: string }>}
   */
  const upgradeToForeground = (taskId, opts = {}) => {
    // 已经有一次升级在进行（还在查凭据 / 输密码）：同一任务并入它，别的任务让位
    if (upgradePromise) {
      if (ownerTaskId !== taskId) return Promise.reject(busy());
      return upgradePromise;
    }
    if (state !== "active" || mode !== "background") return Promise.resolve({ upgraded: false, mode });
    if (ownerTaskId !== taskId) return Promise.reject(busy());
    const ac = new AbortController();
    upgradeAbort = ac;
    const p = (async () => {
      // 安全桌面（UAC 等）不是锁屏：不能去解锁，也不能把它当成「用户解锁了、没什么可升级的」悄悄放过——交还用户
      if (secureDesktopActive()) throw secureDesktopError();
      requireLockedAccess(opts);
      // 此刻电脑真的还锁着吗？用户可能刚好解锁了：没什么可升级的（下一次动作前 guard 会收掉这个后台会话）
      const lockedNow = driver.isScreenLocked();
      if (lockedNow === false) return { upgraded: false, mode };
      // 读不到：不去解锁（解锁器自己对 null 也是拒绝，这里不依赖它；会话仍是后台档）
      if (lockedNow !== true) throw lockStateUnknownError();
      await unlockAndCover(ac);
      mode = "foreground";
      const t = now();
      lastActionAt = t;
      lastInjectedAt = t; // 刚输完密码：别把它算成用户的输入
      state = "active";
      holdAwake(); // 升级成了前台档：从这一刻起不让显示器睡眠（后台档时没持有）
      audit({ type: "session", kind: "upgraded", taskId });
      emit("foreground_started");
      return { upgraded: true, mode };
    })()
      .catch((err) => {
        // 解锁没成：会话还是后台档（被 end 打断时 state 是 ending，由 doEnd 自己收尾）
        if (state === "unlocking") state = "active";
        throw err;
      })
      .finally(() => {
        if (upgradePromise === p) upgradePromise = null;
        if (upgradeAbort === ac) upgradeAbort = null;
      });
    upgradePromise = p;
    return p;
  };

  // ── 动作 ──

  /** 动作前检查（同步）：会话有效 + 归属 + 系统安全桌面（UAC 等）+ 外部锁屏 + 用户接管；通过则续期 */
  const guard = (taskId) => {
    if (state !== "active") {
      throw new DesktopError("SESSION_EXPIRED", "电脑操作会话已经结束了：请重新调用一次桌面工具以重新开始");
    }
    if (ownerTaskId !== taskId) throw busy();
    if (secureDesktopActive()) {
      // 会话期间弹出了 UAC 之类的系统安全提示：交还用户。不锁屏——锁屏请求会和这个提示抢桌面，而且要处理它的用户多半就在旁边
      void end("secure_desktop", { relock: false });
      throw secureDesktopError();
    }
    const lockedNow = driver.isScreenLocked();
    if (mode === "background") {
      // 后台档的前提就是「电脑锁着」：确认已经解锁了（用户回来了 / 屏保结束）就结束这个会话，
      // 下一次调用会按「没锁屏」正常开始（真实键鼠，用户在场时照常让位）。读不到状态（null）不动它
      if (lockedNow === false) {
        void end("unlocked_externally", { relock: false });
        throw new DesktopError("SESSION_EXPIRED", "电脑已经被解锁了（用户回来了？），锁屏后台会话已结束：再调用一次桌面工具会以正常方式重新开始");
      }
    } else if (lockedNow === true) {
      // 会话期间电脑被锁屏了（屏保 / 用户手动锁 / AI 自己按了锁屏快捷键）：结束这个会话，下一次调用会重新走解锁
      void end("relocked_externally", { relock: false });
      throw new DesktopError("SESSION_EXPIRED", "电脑在操作过程中被锁屏了，会话已结束：再调用一次桌面工具会重新开始（如允许会自动解锁）");
    } else if (lockedNow !== false) {
      // 前台档读不到锁屏状态（null）：这一下动作不放行（电脑要是其实锁着，键鼠会打进锁屏界面的密码框）。
      // 不结束会话——下一次动作再读一遍，读到「没锁」就照常继续；一直读不到则靠空闲看门狗收掉
      throw lockStateUnknownError();
    }
    if (userInputDetected()) {
      void takeover();
      throw new DesktopError("USER_TOOK_OVER", "用户碰了键盘或鼠标，AI 已让位并停止操作。请告诉用户你做到哪一步了，等用户说可以再继续");
    }
    lastActionAt = now();
  };

  /**
   * 会话收尾时调用：此刻还没返回的动作都算「上一个会话的」——计数清零、世代 +1。
   * 等到了（计数本来就是 0）时是空操作；没等到（drain 超时）时，卡住的动作之后不管返回不返回，都碰不到下一个会话的状态。
   */
  const abandonInFlightActions = () => {
    actionEpoch += 1;
    acting = 0;
  };

  /**
   * 执行一个会改变电脑状态 / 注入输入的动作。
   * fn 会拿到 `{ shouldStop }`：这个动作**自己的**「该收手了」判断——会话不在 active，**或者**世代变了（它属于一个已经收尾的会话）。
   * 为什么不直接用会话级的 shouldStop：收尾等在飞动作停手有上限（actionDrainMs），超时了照常收尾，卡住的「僵尸动作」稍后才返回；
   * 那时新会话可能已经 active——会话级判断是「没事」，僵尸动作就会接着把剩下的字打进新会话里（可能是别的任务、刚解开的电脑）（第三轮评审）。
   * @param {string} taskId
   * @param {(ctx: { shouldStop: () => boolean }) => any} fn
   */
  const runAction = async (taskId, fn) => {
    guard(taskId);
    const epoch = actionEpoch;
    acting += 1;
    const shouldStopThisAction = () => state !== "active" || epoch !== actionEpoch;
    try {
      return await fn({ shouldStop: shouldStopThisAction });
    } finally {
      // 世代变了 = 这个动作属于一个已经收尾的会话（被 drain 超时丢下的）：它的计数在收尾时已经清掉，别再碰新会话的状态
      if (epoch === actionEpoch) {
        acting -= 1;
        const t = now();
        lastInjectedAt = t;
        lastActionAt = t;
      }
    }
  };

  /**
   * 执行只读动作（截图 / 列应用）：不注入，所以不更新「最后注入时刻」，免得吞掉用户此刻的输入。
   * 读的过程中会话结束了（任务被停 / 超时 / 总开关被关 / 用户接管 / 被锁屏）：读到的内容不再交给 AI——
   * 否则收尾期间（锁屏 / 撤遮罩之前后，最长 drain + 两次锁屏等待）飞着的截图照样返回，AI 在用户已经说「停」之后仍拿到屏幕画面（第二轮评审）。
   * 「unlocking」不算结束（后台档升级前台档的中间态），不误伤。
   */
  const runRead = async (taskId, fn) => {
    guard(taskId);
    const epoch = actionEpoch;
    let result;
    try {
      result = await fn();
    } finally {
      if (epoch === actionEpoch) lastActionAt = now();
    }
    if (epoch !== actionEpoch || state === "ending" || state === "idle") {
      throw new DesktopError(
        "SESSION_EXPIRED",
        "电脑操作会话在读取过程中结束了（用户接管、超时、任务被停止或电脑被锁屏）：这次读到的内容已作废、没有交给 AI。需要继续的话，请重新调用一次桌面工具以开始新的会话",
      );
    }
    return result;
  };

  // ── 结束 ──

  /**
   * 三个阶段，**阶段三一定会跑**（try/finally）：
   *  一、让进行中的开始 / 升级 / 注入动作停手（任何意外只记日志、继续往下——它们不能挡住锁屏和撤遮罩）；
   *  二、我们解锁的、该锁回去的：锁回去并确认（relockNow 永不抛）；
   *  三、不管前面怎么了：撤遮罩、释放防睡眠、状态复位、发事件。
   * 以前没有 finally：阶段二里 isScreenLocked() 一抛，整个收尾带着异常出去——「要锁回去」的债丢了、遮罩没撤、没有任何事件，
   * 本机通知（relock_failed 才会弹）也不会弹（第二轮评审 P1-3）。
   */
  const doEnd = async (reason, opts) => {
    const taskId = ownerTaskId;
    state = "ending";
    stopWatch();
    let relocked = false;
    let relockError = null;
    try {
      try {
        // 开始阶段（含解锁）/ 后台档升级还没跑完：叫它停手并等它收尾，免得两段键盘注入同时进行
        beginAbort?.abort();
        upgradeAbort?.abort();
        for (const pending of [beginPromise, upgradePromise]) {
          if (!pending) continue;
          try {
            await pending;
          } catch {
            /* 取消 / 失败都无所谓 */
          }
        }
        // 在飞的注入动作：state 已经是 ending（guard 不会再放新动作进来，驱动的输入循环看 shouldStop 提前收手）。
        // 先等它们真的停下来再锁屏 / 撤遮罩——否则 desktop_type 剩下的字和 submit 的回车会打进锁屏界面的密码框。
        // 有上限：等不到也要锁，不能为了一个卡住的动作让电脑一直解着
        if (acting > 0) {
          const drained = await waitFor(() => acting === 0, limits.actionDrainMs, DRAIN_STEP_MS);
          if (!drained) {
            safeLog(`[desktop-session] 等在飞的动作停手超时（${limits.actionDrainMs}ms），照常收尾`);
            try {
              audit({ type: "session", kind: "drain_timeout", taskId, reason });
            } catch {
              /* 审计失败不影响主流程 */
            }
          }
        }
      } catch (err) {
        safeLog(`[desktop-session] 收尾前的等待阶段出了意外（已忽略，继续锁屏 / 撤遮罩）：${err?.message || err}`);
      }
      // 不管等没等到（等的过程中出没出意外）：从这里起没返回的动作都不再算数（否则卡住的动作会让下一个会话的用户接管检测永远失灵，见 actionEpoch）
      abandonInFlightActions();
      const wantRelock = opts.relock ?? (unlockedByUs && RELOCK_REASONS.has(reason));
      if (unlockedByUs && wantRelock) {
        const r = await relockNow();
        relocked = r.relocked;
        relockError = r.error;
      }
    } finally {
      // 不管锁屏成败（也不管上面出没出意外），遮罩一定撤：遮罩永远不能成为「用户回来也进不去」的原因
      dropAwake();
      safeOverlay(() => overlay.hide(), "撤除");
      const wasUnlockedByUs = unlockedByUs;
      const endedMode = mode;
      state = "idle";
      mode = "foreground";
      unlockedByUs = false;
      try {
        background?.reset?.();
      } catch {
        /* 清理失败不影响收尾 */
      }
      ownerTaskId = taskId; // 事件要带上任务 id，发完再清
      if (relockError) emit("relock_failed", { reason, error: String(relockError).slice(0, 200) });
      else if (relocked) emit("relocked", { reason });
      emit("session_ended", { reason, unlockedByUs: wasUnlockedByUs, relocked, mode: endedMode });
      ownerTaskId = null;
    }
    return { relocked };
  };

  /**
   * 结束会话。幂等；并发调用共用同一次收尾。
   * @param {string} reason task_done / explicit / idle / max_duration / disabled / server_gone / cancelled / app_quit / user_took_over / relocked_externally / unlocked_externally / secure_desktop / overlay_incomplete
   * @param {{ relock?: boolean }} [opts] relock 不传：按 reason 决定（用户接管不锁）
   */
  const end = (reason, opts = {}) => {
    if (endPromise) return endPromise;
    if (state === "idle" && !beginPromise) return Promise.resolve({ relocked: false });
    endPromise = doEnd(reason, opts)
      .catch((err) => {
        // doEnd 自己有 try/finally，走到这里说明连兜底都出了意外（理论上不会）：最后一道保险，别卡死在 ending
        safeLog(`[desktop-session] 结束会话出错：${err?.message || err}`);
        dropAwake();
        safeOverlay(() => overlay.hide(), "撤除");
        state = "idle";
        mode = "foreground";
        ownerTaskId = null;
        unlockedByUs = false;
        abandonInFlightActions(); // 出错可能发生在等动作停手之前：不能把没清掉的计数带进下一个会话
        return { relocked: false };
      })
      .finally(() => {
        endPromise = null;
      });
    return endPromise;
  };

  /** 只在会话属于该任务时结束（任务被停 / 任务结束） */
  const endForTask = (taskId, reason) => {
    if (ownerTaskId !== taskId || (state === "idle" && !beginPromise)) return Promise.resolve({ relocked: false });
    return end(reason);
  };

  /** 应用退出：同步撤遮罩；如果电脑是我们解锁的，同步发出锁屏命令（尽力而为，不等结果） */
  const destroy = () => {
    stopWatch();
    // 正在解锁（输密码 / 等验证）时退出（第三轮评审）：unlock() 的结果没人等了，电脑可能马上（甚至已经）被解开，而此刻 unlockedByUs 还是 false——
    // 不锁回去，电脑就被留在「已解锁、没遮罩、人不在」的状态。读得出仍锁着（true）就不用动；解开了 / 读不到 → 一并锁回去（宁可多锁一次）。
    // 先取这一刻的状态：下面 abort 之后 state 会被复位
    const unlockingNow = state === "unlocking";
    beginAbort?.abort();
    upgradeAbort?.abort();
    dropAwake();
    safeOverlay(() => overlay.hide(), "撤除");
    if (unlockedByUs || (unlockingNow && readLockedOrNull() !== true)) {
      try {
        const r = driver.lockScreen();
        // 异步失败不能静默吞掉：退出路径上没有第二次机会，至少留一行日志
        if (r && typeof r.catch === "function") r.catch((err) => safeLog(`[desktop-session] 退出时锁屏失败：${err?.message || err}`));
      } catch (err) {
        safeLog(`[desktop-session] 退出时锁屏失败：${err?.message || err}`);
      }
    }
    state = "idle";
    mode = "foreground";
    ownerTaskId = null;
    unlockedByUs = false;
    abandonInFlightActions();
    try {
      background?.reset?.();
    } catch {
      /* 退出时清理失败无所谓 */
    }
  };

  const status = () => ({
    state,
    taskId: ownerTaskId,
    active: state === "active",
    /** foreground | background（只在会话期间有意义） */
    mode,
    unlockedByUs,
    startedAt: state === "active" ? startedAt : undefined,
    /** 自动解锁的冷却截止时刻（毫秒时间戳）；0 = 不在冷却。预写的、结果还没出的冷却（见 armUnlockCooldown）不对外报：它还不算「输错」 */
    unlockCooldownUntil: !cooldownProvisional && unlockCooldownUntil > now() ? unlockCooldownUntil : 0,
  });

  /** 会话已经不在 active（结束中 / 已结束）：输入循环 / 长动作每个批次检查一次，true 就尽快收手 */
  const shouldStop = () => state !== "active";

  /** 用户亲自重新保存了开机密码：之前的失败多半是旧密码不对，不再作数，立刻解除冷却 */
  const resetUnlockCooldown = () => {
    unlockCooldownUntil = 0;
    cooldownProvisional = false;
    // 同 settleUnlockCooldown 的撤销分支：写 0 失败 = 内存里已解除、盘上还留着之前的冷却（重启后会重新出现），不是「内存里仍然生效」
    persistCooldown("冷却已在内存里解除，但盘上还留着之前的那一段：重启后冷却会重新出现");
  };

  return { begin, upgradeToForeground, guard, runAction, runRead, end, endForTask, destroy, status, shouldStop, resetUnlockCooldown };
};
