/**
 * 电脑操作：渲染进程 ⇄ 主进程的类型（纯类型 + 一个取桥函数，无其他运行时代码）
 *
 * 唯一权威是 electron-app/desktop/types.mjs 里的 ComputerUseStatus / ComputerUseBridge（JSDoc）；
 * 这里只是把契约抄成 TS，设置页「电脑操作」卡和任何要读 `window.__computerUse` 的代码共用。
 * 要改协议先改契约，别在这里悄悄加字段。
 *
 * `window.__computerUse` 只在 Electron 桌面端的主窗口里存在（preload 暴露）：
 * 网页版（pnpm dev:web）没有它，所以声明成可选，访问处一律走 getComputerUseBridge() 判空，
 * 且只能在 effect / 事件回调里碰（SSR 阶段没有 window）。
 *
 * 安全约定：开机密码只能经 `setCredential` 单向写进主进程（系统钥匙串），
 * 桥上没有任何「读回凭据」的方法，状态快照里也只有 `credentialSet` 这个布尔。
 */

/** 系统权限状态（macOS 辅助功能 / 屏幕录制；Windows 恒 granted） */
export type PermissionState =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "unknown";

/** 电脑操作需要用户在系统里授予的两项权限 */
export type ComputerUsePermissionKind = "accessibility" | "screen";

/**
 * 设置页看到的状态快照（`computer-use:status` 的返回值）。
 * 只含布尔 / 枚举 / 时间，绝不含凭据内容。
 */
export interface ComputerUseStatus {
  platform: "darwin" | "win32" | "other";
  /** 「电脑操作」总开关（以 server 推送到主进程的为准；断连时 fail-closed 为 false） */
  enabled: boolean;
  /** 「锁屏时也能用」开关 */
  lockedAccessEnabled: boolean;
  /** 本平台有桌面驱动实现、且这次启动装配成功（Linux 等没有驱动、或有驱动的平台上装配失败时为 false → 整张卡不可用；装配失败的原因在 driverError） */
  supported: boolean;
  /** 锁屏时 AI 能工作：有「自动解锁」（macOS 钥匙串 / Windows 解锁组件）或有「锁屏后台档」（Windows）；都没有 → 锁屏区块只给说明、不出开关 */
  lockedAccessSupported: boolean;
  /** 本平台有「锁屏后台档」实现（Windows）：锁屏时不解锁，直接对已打开的应用窗口操作 */
  backgroundSupported?: boolean;
  /** 后台档组件初始化成功、可用 */
  backgroundReady?: boolean;
  /** 后台档没初始化成功时的原因（中文） */
  backgroundError?: string;
  /** 「自动解锁」路线本平台有实现（macOS 恒 true；Windows = 解锁组件已装好） */
  unlockSupported?: boolean;
  /** 自动解锁路线具备全部条件（组件 + 开机密码 + 权限，且不在冷却中；不看总开关） */
  unlockReady?: boolean;
  /** 自动解锁路线不就绪的一句话原因 */
  unlockNote?: string;
  /** Windows 解锁组件（以 SYSTEM 身份运行的小服务）的安装状态；其它平台没有 */
  unlockHelper?: { installed: boolean; canInstall: boolean; detail?: string } | null;
  /** 原生组件（koffi）加载成功 */
  driverReady: boolean;
  /** 没加载成功时的原因（中文）；supported 为 false 且带这一项 = 装配失败，是一整句给用户看的说明（卡片替换掉「当前系统暂不支持」） */
  driverError?: string;
  /** Windows 恒 granted */
  permissions: {
    accessibility: PermissionState;
    screen: PermissionState;
  };
  /** 当前是否锁屏（null = 读不到） */
  locked: boolean | null;
  /** 屏幕上现在是系统安全提示（UAC 权限确认等），不是锁屏；只在确实是时才出现且恒为 true（Windows）。此时开始操作会被拒（SECURE_DESKTOP） */
  secureDesktop?: boolean;
  /** 是否已保存解锁凭据（只告诉有没有，永远不回传内容） */
  credentialSet: boolean;
  /** 「锁屏时也能用」是否具备全部条件（开关开 + 凭据已存 + 权限齐 + 驱动就绪 + 本平台支持） */
  lockedAccessReady: boolean;
  /** 不就绪 / 不支持时给用户看的一句话原因（如 Windows 暂不支持） */
  lockedAccessNote?: string;
  session: {
    active: boolean;
    unlockedByUs: boolean;
    /** 只在会话进行中有：foreground = 真实键鼠；background = 电脑一直锁着、靠窗口消息操作（Windows 后台档） */
    mode?: "foreground" | "background";
    startedAt?: number;
  };
}

/** 「测试锁屏可用」的单个步骤结果 */
export interface LockedAccessTestStep {
  name: string;
  ok: boolean;
  /** 该步骤耗时（毫秒） */
  ms: number;
  detail?: string;
}

/** 「测试锁屏可用」的整体结果：锁屏 → 自动解锁 → 回到桌面，逐步返回 */
export interface LockedAccessTestResult {
  ok: boolean;
  steps: LockedAccessTestStep[];
  error?: string;
}

/** preload 暴露给渲染进程的电脑操作桥（契约 ComputerUseBridge） */
export interface ComputerUseBridge {
  getStatus(): Promise<ComputerUseStatus>;
  /** 触发系统授权提示（并按需打开系统设置），返回最新状态 */
  requestPermission(kind: ComputerUsePermissionKind): Promise<ComputerUseStatus>;
  /** 直达系统设置对应页 */
  openSettings(kind: ComputerUsePermissionKind): Promise<void>;
  /**
   * 只写不读：保存后不会再回传。
   * `ok:false` + `saved:true` = 密码其实已经存好了、只是附带的收尾没做成（Windows：上一次自动解锁失败留下的冷却记录没清掉），
   * `error` 是该告诉用户的话——要按「已保存」处理（关对话框、刷新状态、把 error 当提示），不是「保存失败」
   */
  setCredential(input: { password: string }): Promise<{ ok: boolean; saved?: boolean; error?: string }>;
  /** 返回真实结果：钥匙串里没删掉就 ok:false（别让用户以为已经清掉了）；本来就没有也算成功 */
  clearCredential(): Promise<{ ok: boolean; error?: string }>;
  /** 设置页「测试锁屏可用」：锁屏 → 自动解锁 → 回到桌面；逐步返回结果 */
  testLockedAccess(): Promise<LockedAccessTestResult>;
  /**
   * 设置页「测试后台操作」（Windows）：开一个测试窗口 → 锁屏 → 在锁屏状态下对它截图 / 打字验证；逐步返回结果。
   * 测完电脑仍是锁屏状态（没有密码可输、也不该输），用户自己解锁；结果在用户解锁回到设置页后才看得到。
   */
  testBackground(): Promise<LockedAccessTestResult>;
  /** 安装 Windows 解锁组件（会弹系统管理员授权框，只由用户亲自触发）；返回真实结果 */
  installUnlockHelper(): Promise<{ ok: boolean; error?: string }>;
  /** 卸载 Windows 解锁组件并清掉它保存的开机密码；返回真实结果 */
  uninstallUnlockHelper(): Promise<{ ok: boolean; error?: string }>;
  /** 导出诊断文件（不含用户内容 / 凭据），返回路径 */
  exportDiagnostics(): Promise<{ path: string }>;
}

declare global {
  interface Window {
    /** Electron preload 暴露的电脑操作桥（仅桌面端主窗口有；网页版为 undefined） */
    __computerUse?: ComputerUseBridge;
  }
}

/**
 * 取电脑操作桥：桌面端返回 `window.__computerUse`，网页版 / SSR 返回 null。
 * 调用方据此降级成「仅桌面端可用」，别直接读 `window.__computerUse`（SSR 会炸）。
 */
export const getComputerUseBridge = (): ComputerUseBridge | null =>
  typeof window === "undefined" ? null : (window.__computerUse ?? null);
