/**
 * 桌面操作（desktop.v1）共享契约：能力名、op 清单、错误码、IPC 通道名，以及跨层接口的 JSDoc 类型。
 *
 * 纯声明 + 极少量常量：不 import electron / koffi（只依赖协议层的 BrowserError），
 * 主进程、平台驱动、单测、渲染端类型对账都能 import。
 *
 * 分层（上层只依赖下层的接口，不依赖实现）：
 *   server 工具（src/lib/server/desktop）
 *     → server-channel（与内置浏览器共用同一条 Node ipc，能力名 desktop.v1）
 *       → manager（会话 / 安全 / 截图 / 遮罩 / 设置，本目录 manager.mjs）
 *         → session（锁屏会话状态机，纯逻辑、全部依赖注入，session.mjs）
 *           → DesktopDriver（平台驱动：只管把一个低层动作交给系统，drivers/*.mjs）
 *           → ScreenUnlocker（解锁器：唤醒 / 验证锁屏 / 输入凭据 / 校验 / 重新锁屏，unlockers/*.mjs）
 */
import { BrowserError } from "../browser/server-channel.mjs";

/** hello-ack 的 capabilities 里带上它，server 才会注册 desktop_* 工具 */
export const DESKTOP_CAPABILITY = "desktop.v1";

/** op 清单（server → 主进程）。扁平命名、`desktop_` 前缀，和内置浏览器的 op 共用同一条 ipc 通道 */
export const DESKTOP_OPS = Object.freeze([
  "desktop_status",
  "desktop_screenshot",
  "desktop_click",
  "desktop_move",
  "desktop_drag",
  "desktop_scroll",
  "desktop_type",
  "desktop_key",
  "desktop_apps",
  "desktop_open_app",
  "desktop_end_session",
]);

/** 错误码全集（协议层原样透传 code；message 写成「模型 / 用户能照着自修复」的中文） */
export const DESKTOP_ERROR_CODES = Object.freeze([
  "ACCESS_DISABLED", // 设置里「电脑操作」没开
  "UNSUPPORTED", // 当前系统 / 安装包不支持，或原生组件没装上
  "NEED_PERMISSION", // 缺系统权限（macOS 辅助功能 / 屏幕录制）
  "SCREEN_LOCKED", // 电脑锁屏中，且「锁屏可用」没就绪（没开 / 没存凭据 / 来源不被信任 / 输密码前预写的冷却记录写不进磁盘，为安全起见没解锁）
  "NEED_FOREGROUND", // 锁屏后台模式做不到这个动作（Win 键 / Alt+Tab 等需要真实键鼠）：要解锁走前台（desktop_screenshot foreground:true）
  "UNLOCK_FAILED", // 自动解锁失败：已停手、不重试
  "SECURE_DESKTOP", // 屏幕上是系统安全提示（Windows UAC 权限确认等）：只能用户本人处理，已停手、没有当锁屏去解锁
  "USER_TOOK_OVER", // 用户碰了键盘 / 鼠标：立刻让位
  "SESSION_EXPIRED", // 会话到时（硬上限 / 空闲）已结束，需要重新开始
  "BLOCKED", // 被安全规则拦下（注销组合键等）
  "CANCELLED",
  "BAD_ARGS",
  "TIMEOUT",
  "INTERNAL",
]);

/** 带协议错误码的异常。继承 BrowserError：server-channel 的 toErrorPayload 靠 instanceof 保留 code */
export class DesktopError extends BrowserError {
  /**
   * @param {string} code DESKTOP_ERROR_CODES 之一
   * @param {string} message 中文
   */
  constructor(code, message) {
    super(code, message);
    this.name = "DesktopError";
  }
}

/** 渲染进程（设置页）⇄ 主进程 的 IPC 通道名（preload.cjs 里是同样的字符串，改这里要同步） */
export const COMPUTER_USE_CHANNELS = Object.freeze({
  status: "computer-use:status",
  requestPermission: "computer-use:request-permission",
  openSettings: "computer-use:open-settings",
  setCredential: "computer-use:set-credential",
  clearCredential: "computer-use:clear-credential",
  testLockedAccess: "computer-use:test-locked-access",
  testBackground: "computer-use:test-background",
  installUnlockHelper: "computer-use:install-unlock-helper",
  uninstallUnlockHelper: "computer-use:uninstall-unlock-helper",
  exportDiagnostics: "computer-use:export-diagnostics",
});

/**
 * @typedef {'granted'|'denied'|'not-determined'|'restricted'|'unknown'} PermissionState
 */

/**
 * 设置页看到的状态快照（`computer-use:status` 的返回值）。只含布尔 / 枚举 / 时间，绝不含凭据内容。
 * @typedef {Object} ComputerUseStatus
 * @property {'darwin'|'win32'|'other'} platform
 * @property {boolean} enabled              「电脑操作」总开关（以 server 推送到主进程的为准；断连时 fail-closed 为 false）
 * @property {boolean} lockedAccessEnabled  「锁屏可用」开关
 * @property {boolean} supported            本平台有桌面驱动实现、且这次启动装配成功（macOS / Windows；Linux 等没有驱动、或有驱动的平台上装配失败时为 false → 整张卡不可用；装配失败的原因在 driverError）
 * @property {boolean} lockedAccessSupported  锁屏时 AI 能工作：本平台实现了「自动解锁」路线（macOS 钥匙串 / Windows 解锁组件，后者装没装另看 unlockHelper）或「锁屏后台档」初始化成功（Windows）；都没有 → 锁屏区块只给说明、不出开关
 * @property {boolean} [backgroundSupported]  本平台有「锁屏后台档」实现（Windows）：锁屏时不解锁，直接对已打开的应用窗口操作
 * @property {boolean} [backgroundReady]    后台档组件初始化成功、可用
 * @property {string} [backgroundError]     后台档没初始化成功时的原因（中文）
 * @property {boolean} [unlockSupported]    「自动解锁」路线本平台有实现（macOS 恒 true；Windows = 解锁组件已装好）
 * @property {boolean} [unlockReady]        自动解锁路线具备全部条件（组件 + 开机密码 + 权限，且不在冷却中；不看总开关）
 * @property {string} [unlockNote]          自动解锁路线不就绪的一句话原因
 * @property {{ installed: boolean, canInstall: boolean, detail?: string } | null} [unlockHelper]  Windows 解锁组件（以 SYSTEM 身份运行的小服务）的安装状态；其它平台 null / 缺省
 * @property {boolean} driverReady          原生组件（koffi）加载成功
 * @property {string} [driverError]         没加载成功时的原因（中文）；supported 为 false 且带这一项 = 装配失败，是一整句给用户看的说明（卡片替换掉「当前系统暂不支持」）
 * @property {{ accessibility: PermissionState, screen: PermissionState }} permissions  Windows 恒 granted
 * @property {boolean|null} locked          当前是否锁屏（null = 读不到）
 * @property {boolean} [secureDesktop]      屏幕上现在是系统安全提示（UAC 权限确认等），不是锁屏；只在确实是时才出现且恒为 true（Windows）。此时开始操作会被拒（SECURE_DESKTOP），AI 的 desktop_status 据此提醒用户自己处理
 * @property {boolean} credentialSet        是否已保存解锁凭据
 * @property {boolean} lockedAccessReady    「锁屏可用」是否具备全部条件（开关开 + 凭据已存 + 权限齐 + 驱动就绪 + 本平台支持）
 * @property {string} [lockedAccessNote]    不就绪 / 不支持时给用户看的一句话原因（如 Windows 暂不支持）
 * @property {{ active: boolean, unlockedByUs: boolean, mode?: 'foreground'|'background', startedAt?: number }} session  mode 只在会话进行中有
 */

/**
 * `window.__computerUse`（preload 暴露；网页热更 dev:web 下不存在 → UI 降级为「仅桌面端可用」）。
 * @typedef {Object} ComputerUseBridge
 * @property {() => Promise<ComputerUseStatus>} getStatus
 * @property {(kind: 'accessibility'|'screen') => Promise<ComputerUseStatus>} requestPermission  触发系统授权提示（并按需打开系统设置）
 * @property {(kind: 'accessibility'|'screen') => Promise<void>} openSettings  直达系统设置对应页
 * @property {(input: { password: string }) => Promise<{ ok: boolean, saved?: boolean, error?: string }>} setCredential  只写不读：保存后不会再回传。saved:true = 密码已经存上、但这次不算成功（Windows：解锁组件没能清掉上一次失败留下的冷却记录，ok 仍是 false，冷却结束前不会自动解锁）；没存上时不带 saved
 * @property {() => Promise<{ ok: boolean, error?: string }>} clearCredential  返回真实结果：钥匙串里没删掉就 ok:false（别让用户以为已经清掉了）
 * @property {() => Promise<{ ok: boolean, steps: Array<{ name: string, ok: boolean, ms: number, detail?: string }>, error?: string }>} testLockedAccess
 *     设置页「测试锁屏可用」：锁屏 → 自动解锁 → 回到桌面；逐步返回结果
 * @property {() => Promise<{ ok: boolean, steps: Array<{ name: string, ok: boolean, ms: number, detail?: string }>, error?: string }>} testBackground
 *     设置页「测试后台操作」（Windows）：开一个测试窗口 → 锁屏 → 在锁屏状态下截图 / 打字验证；测完电脑仍是锁屏，用户自己解锁
 * @property {() => Promise<{ ok: boolean, error?: string }>} installUnlockHelper
 *     安装 Windows 解锁组件（会弹系统管理员授权框，只由用户在设置页亲自触发）；返回真实结果，失败带原因
 * @property {() => Promise<{ ok: boolean, error?: string }>} uninstallUnlockHelper
 *     卸载 Windows 解锁组件并清掉它保存的开机密码；返回真实结果
 * @property {() => Promise<{ path: string }>} exportDiagnostics  导出诊断文件（不含用户内容 / 凭据），返回路径
 */

/**
 * @typedef {Object} DesktopRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/** @typedef {'left'|'right'|'middle'} MouseButton */

/**
 * @typedef {Object} DesktopWindowInfo
 * @property {string} title
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {boolean} [minimized]
 */

/**
 * @typedef {Object} DesktopAppInfo
 * @property {string} name
 * @property {number} pid
 * @property {string} [bundleId]   仅 macOS
 * @property {boolean} frontmost
 * @property {DesktopWindowInfo[]} windows
 */

/**
 * 平台驱动：只管「把一个低层动作交给系统」，**不含任何策略**（权限判断、会话、安全规则、日志、审计都在上层）。
 *
 * 约定：
 * - 所有坐标 = 该平台的「输入坐标系」。macOS：全局显示坐标（单位「点」，原点在主显示器左上，Retina 不乘 2）；
 *   Windows：虚拟桌面物理像素（原点在虚拟屏左上，副屏在主屏左 / 上方时坐标可为负）。
 * - 方法可同步，也可返回 Promise；失败抛 Error（message 中文、写成能照着自修复的话）。返回值必须可 JSON 化。
 * - 驱动自己不得打印 / 记录 typeText 的文本（里面可能是密码）。
 * - init() 之前调用其它方法的行为未定义；init() 失败时驱动整体视为不可用。
 *
 * @typedef {Object} DesktopDriver
 * @property {'darwin'|'win32'} platform
 * @property {() => Promise<{ ok: true } | { ok: false, error: string }>} init  加载 FFI 等；失败不抛，返回 ok:false 与原因（中文）
 * @property {() => Record<string, unknown>} diagnostics  诊断快照（库加载状态 / DPI / 会话信息…），JSON 可序列化，不含用户内容
 * @property {() => boolean | null} [inputPermitted]  系统是否允许本进程合成键鼠输入（macOS 辅助功能）；false = 事件会被静默丢弃；缺省 / null = 不适用或未知
 * @property {() => boolean | null} isScreenLocked  null = 读不到。UAC 权限确认 / Ctrl+Alt+Del 这类系统安全桌面不算「锁屏」（见 isSecureDesktopActive）
 * @property {() => boolean} [isSecureDesktopActive]  现在是不是系统安全桌面（Windows：UAC 权限确认等——会话没锁，但键鼠注入和截图碰不到它）。
 *   true 时会话必须停手交还用户（SECURE_DESKTOP），绝不能当锁屏去解锁；缺省（macOS）= 没有这回事
 * @property {() => number} idleSeconds  距离上一次键盘 / 鼠标输入（含本进程合成的）已过去的秒数
 * @property {() => DesktopRect} getPrimaryDisplay  主显示器在输入坐标系里的矩形
 * @property {(x: number, y: number) => void | Promise<void>} mouseMove
 * @property {(x: number, y: number, opts?: { button?: MouseButton, count?: number }) => void | Promise<void>} click  count 1–3（双击 / 三击）
 * @property {(from: { x: number, y: number }, to: { x: number, y: number }, opts?: { button?: MouseButton, durationMs?: number }) => void | Promise<void>} drag
 * @property {(x: number, y: number, dx: number, dy: number) => void | Promise<void>} scroll  dy>0 向下、dx>0 向右；单位「格」（一格约三行）
 * @property {(combo: { mods: Array<'meta'|'ctrl'|'alt'|'shift'>, key: string }) => void | Promise<void>} keyCombo  combo 来自 keys.mjs 的 parseCombo
 * @property {(text: string, opts?: { mode?: 'unicode'|'keys', shouldStop?: () => boolean }) => void | Promise<void>} typeText  逐字符输入。
 *     unicode（默认）：Unicode 安全，含中文 / emoji，不依赖键盘布局；keys：真实键码，仅 ASCII（锁屏输密码用；驱动不支持时可忽略 mode）。
 *     shouldStop（unicode 模式）：每个批次开头问一次，返回 true 就立刻收手（正常返回、不抛错、也不再按剩下的键）——
 *     会话已在收尾时，剩下的字不能再打（锁屏界面一出来，它们就会进密码框）。
 *     注意 typeText 并不总是静默返回：输入过程中驱动自己发现输入桌面变了（Windows 前台驱动，每个批次发送前复查）会**抛 DesktopError**——
 *     锁屏 / 切桌面 = SESSION_EXPIRED，系统安全桌面（UAC 之类）= SECURE_DESKTOP。不静默返回是因为会话没结束时（UAC）静默返回会让调用方以为字都打完了、
 *     随后 submit 的回车还可能放行。已经打出去的字撤不回：调用方按「动作作废、字可能已经打了一部分」处理，不要假设「抛错 = 一个字都没打」
 * @property {(text: string) => boolean} [canTypeKeys]  keys 模式能不能打出这段文字（锁屏密码保存 / 解锁前的预检；缺省 = 不预检）
 * @property {() => DesktopAppInfo | null} frontmostApp
 * @property {() => Promise<DesktopAppInfo[]> | DesktopAppInfo[]} listApps
 * @property {(nameOrPath: string) => Promise<void>} openApp  打开 / 切到前台
 * @property {() => Promise<void>} wakeDisplay  唤醒熄灭的显示器
 * @property {(opts?: { method?: 'auto'|'shortcut' }) => Promise<void>} lockScreen  method:"shortcut"：绕开系统 API 直接按锁屏快捷键（上一次没锁上时的兜底）；缺省 / auto = 驱动自己挑最稳的
 */

/**
 * 锁屏后台档截图里的一个窗口（只有应用进程名 + 位置 + 画面状态；位置在截图像素坐标里；不含窗口标题 / 内容）。
 * status：ok = 画出来了；blank = 画面是纯黑 / 纯白（多半是锁屏时停止渲染的应用）；failed / timeout / skipped = 没截到
 * （skipped = 窗口大到超过单个位图上限，或这一帧所有窗口位图合起来的内存预算用完了——窗口按 Z 序从上到下取，预算用完后更下面的窗口记 skipped。
 * 预算里还算着「超时后被搁置、PrintWindow 还没返回」的位图（它们还占着内存，直到那次调用返回才归还）：
 * 永远不返回的大窗口会一直占着预算，之后的窗口可能都只能记 skipped——位图确实还占着，再建新的只会更糟，所以这是有意为之。）
 * @typedef {Object} BackgroundWindowInfo
 * @property {string} [className]
 * @property {string} [processName]
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {'ok'|'blank'|'failed'|'timeout'|'skipped'} status
 */

/**
 * 锁屏后台档驱动（Windows）：电脑锁屏期间不解锁、不碰真实键鼠，对用户桌面上已经打开的应用窗口发窗口消息、逐窗口截图。
 * 约定同 DesktopDriver：坐标 = 虚拟桌面物理像素；方法可返回 Promise；失败抛 DesktopError / Error；文本不进日志。
 * keyCombo 对后台做不到的组合键（Win 键 / Alt+Tab …）抛 NEED_FOREGROUND；带「尽力而为」性质的返回 { note }。
 * @typedef {Object} BackgroundDriver
 * @property {() => Promise<{ ok: true } | { ok: false, error: string }>} init  懒初始化（需要核心驱动先 init 成功）；失败不抛
 * @property {() => boolean} supported
 * @property {() => Record<string, unknown>} diagnostics
 * @property {() => void} reset  会话开始 / 结束时清掉「最近点过的窗口」等状态
 * @property {(x: number, y: number) => Promise<void>} mouseMove
 * @property {(x: number, y: number, opts?: { button?: MouseButton, count?: number }) => Promise<void>} click
 * @property {(from: { x: number, y: number }, to: { x: number, y: number }, opts?: { button?: MouseButton, durationMs?: number }) => Promise<void>} drag
 * @property {(x: number, y: number, dx: number, dy: number) => Promise<void>} scroll
 * @property {(combo: { mods: Array<'meta'|'ctrl'|'alt'|'shift'>, key: string }) => Promise<{ note?: string }>} keyCombo
 * @property {(text: string, opts?: { shouldStop?: () => boolean }) => Promise<void>} typeText
 * @property {(nameOrPath: string) => Promise<void>} openApp  打开应用但不抢前台（锁屏时前台切不过去）
 * @property {() => Promise<{ width: number, height: number, bgra: Buffer, elapsedMs: number, windows: BackgroundWindowInfo[] }>} capture
 */

/**
 * 锁屏解锁器：把「怎么让一台锁屏的电脑回到桌面、再锁回去」封装起来。mac / win 各一份实现。
 * 凭据只在实现内部使用：不进日志、不进事件流、不回传给渲染端 / server / AI。
 *
 * @typedef {Object} UnlockStep
 * @property {string} name
 * @property {boolean} ok
 * @property {number} ms
 * @property {string} [detail]
 *
 * @typedef {Object} ScreenUnlocker
 * @property {boolean} supported  本平台是否实现了解锁路线（macOS / Windows 恒 true）。Windows 上「解锁组件装没装」由 helperStatus().installed 与 hasCredential() 表达、不动 supported——它一旦为 false，设置页整块隐藏，用户就看不到安装入口了
 * @property {boolean} [overlayBeforeUnlock]  true = 解锁动作在系统登录界面里完成、桌面一出现就能被看到：要先盖遮罩再解锁（Windows 系统级解锁组件）。缺省 / false = 解锁成功后再盖（macOS）
 * @property {() => Promise<{ installed: boolean, canInstall: boolean, detail?: string }>} [helperStatus]  需要额外安装组件的平台（Windows）：组件安装状态
 * @property {() => Promise<{ ok: boolean, error?: string }>} [installHelper]  安装解锁组件（会弹系统管理员授权框，只由用户在设置页亲自触发）
 * @property {() => Promise<{ ok: boolean, error?: string }>} [uninstallHelper]  卸载解锁组件并清掉它保存的凭据
 * @property {() => Promise<boolean>} hasCredential  「能用来解锁的」已保存密码（Windows：组件装好、版本对得上、里面有密码）。解锁预检用它
 * @property {() => Promise<boolean>} [hasStoredCredential]  可选：保存着一份开机密码吗——不看解锁组件版本够不够新（Windows：装着旧版组件时也如实回答）。只给设置页状态用；缺省 = 用 hasCredential
 * @property {(secret: { password: string }) => Promise<{ ok: boolean, saved?: boolean, error?: string }>} setCredential  失败时 saved:true = 密码其实已经存上了（Windows：冷却记录没清掉）；没存上不带 saved
 * @property {() => Promise<{ ok: boolean, error?: string }>} clearCredential
 * @property {() => Promise<{ ok: boolean, error?: string }>} [checkCredential]  保存的凭据读得出、打得出吗（设置页「测试」在真的锁屏之前先问；缺省 = 不预检）。会读一次凭据存储，只在用户亲自触发时调用
 * @property {(ctx: { signal?: AbortSignal, onStep?: (s: UnlockStep) => void }) => Promise<{ ok: boolean, code?: string, error?: string, attempted?: boolean }>} unlock
 *     必须依次：唤醒屏幕 → 验证当前确实是锁屏界面 → 输入凭据 → 校验已回到桌面。
 *     任何一步异常都停手、返回 ok:false，**绝不重试**（输错密码会触发账户锁定）。
 *     attempted：是不是真的把凭据输进去过。false（没权限 / 没锁屏 / 读不到凭据 / 凭据里有输不了的字符 / 用户自己解开了）的失败不触发冷却；缺省按 true 处理。
 *     取消时（signal 被 abort）：已提交过回车的，以「电脑实际是否已解锁」为准返回 ok（上层据此决定要不要锁回去）。
 * @property {(opts?: { method?: 'auto'|'shortcut' }) => Promise<{ ok: boolean, error?: string }>} lock
 *     method:"shortcut"：默认方式没生效时 session 换这条路再试一次（直接按锁屏快捷键）
 */

/**
 * 遮罩：解锁后盖住整个屏幕（旁人看不到 AI 在干什么），鼠标事件穿透、不抢键盘焦点、尽量不进屏幕截图。
 * 「尽量」：macOS 上有的系统版本会无视防截屏设置，capture-guard.mjs 靠 suspend / resume 在截图的一瞬间把遮罩变透明兜底。
 * @typedef {Object} DesktopOverlay
 * @property {(opts?: { message?: string }) => void} show
 * @property {() => void} hide
 * @property {() => boolean} isShown
 * @property {() => boolean} [isComplete]  遮罩有没有盖全：会话中途接入的显示器 / 改分辨率之后窗口建不出来、或窗口被销毁了 → false（那块屏幕是裸的）；会话看门狗据此结束并锁回去
 * @property {() => void} [suspend]  截图前把遮罩变透明；可嵌套，每次配一次 resume；超时自动恢复
 * @property {() => void} [resume]
 * @property {() => boolean} [isSuspended]
 * @property {() => number} [generation]  第几轮遮罩（每次 show() 成功 +1）；capture-guard 用它在新一轮遮罩开始时重新判断「遮罩会不会影响截图」
 * @property {() => number} [shownAt]  最近一次 show() 成功的时间（ms）；capture-guard 用它判断遮罩出现多久了（刚出现的一秒内画面不稳定）
 */
