/**
 * 内置浏览器：server 侧用到的协议类型（对应 docs/BROWSER-AUTOMATION.md §4）。
 *
 * 纯类型 + 一个错误类，无其它运行时依赖——bridge.ts 会被 instrumentation 提前加载，
 * 这里不能拖进任何重模块。
 */

export type BrowserOp =
  | "navigate"
  | "nav_history"
  | "snapshot"
  | "screenshot"
  | "click"
  | "hover"
  | "type"
  | "press_key"
  | "select"
  | "scroll"
  | "drag"
  | "wait_for"
  | "tabs"
  | "console"
  | "network"
  | "evaluate"
  | "user_activity"
  | "ask_user_to_act"
  | "status"
  | "close_session"
  // 增强包 E1（契约 §14）
  | "mouse"
  | "fill_form"
  | "read"
  | "inspect"
  | "network_detail"
  | "save"
  | "upload"
  | "downloads"
  | "dialog"
  | "emulate"
  // 增强包 E2（契约 §15）
  | "permissions"
  | "storage"
  | "net_rules"
  | "net_export"
  | "perf"
  | "sources"
  | "debug"
  | "touch"
  | "record"
  | "clipboard";

export type BrowserErrorCode =
  | "NO_SESSION"
  | "USER_CONTROL"
  | "USER_TOOK_OVER"
  | "URL_BLOCKED"
  | "REF_STALE"
  | "REF_NOT_FOUND"
  | "NOT_INTERACTABLE"
  | "TIMEOUT"
  | "NAV_FAILED"
  | "TAB_NOT_FOUND"
  | "CANCELLED"
  | "DISABLED"
  | "BAD_ARGS"
  | "INTERNAL"
  // 增强包 E2（契约 §15）
  | "ACCESS_DISABLED"
  | "DENIED"
  | "UNSUPPORTED";

/** server 侧额外的本地错误码：通道不可用（没有壳 / 握手失败 / 断线） */
export type BrowserBridgeErrorCode = BrowserErrorCode | "UNAVAILABLE";

export class BrowserBridgeError extends Error {
  readonly code: BrowserBridgeErrorCode;
  /**
   * 这条错误是不是 bridge **自己**生成的（取消 / 超时 / 通道不可用 / 发送失败：文案是我们写的，不含页面可控文字）。
   * 只有 bridge.ts 里本地构造的错误显式传 `{ local: true }`；来自主进程 `res` 的错误（message 里可能带遮挡物文字 /
   * option 文字 / 导航失败描述）与任何没标记的都是 false——fail-closed：拿不准来源就当页面内容包裹（R2-02）。
   */
  readonly local: boolean;
  constructor(code: BrowserBridgeErrorCode, message: string, opts: { local?: boolean } = {}) {
    super(message);
    this.name = "BrowserBridgeError";
    this.code = code;
    this.local = opts.local === true;
  }
}

export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
  favicon?: string | null;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isActive?: boolean;
  /** 设备 / 环境模拟的摘要（V3），没有模拟时缺省或 null */
  emulation?: string | null;
  /** 无痕标签（契约 §15 A6）：内存 partition，关闭即销毁 */
  incognito?: boolean;
}

export interface BrowserActivityEntry {
  id: number;
  ts: number;
  actor: "user" | "ai" | "system";
  kind: string;
  tabId?: string;
  url?: string;
  /** 一行中文、已压缩已脱敏；里面可能带页面文字，一律当不可信内容处理 */
  summary: string;
  target?: { role?: string; name?: string; ref?: string };
  count?: number;
}

export interface BrowserStatusResult {
  exists: boolean;
  controller?: "idle" | "ai" | "user";
  activeTabId?: string | null;
  url?: string | null;
  title?: string | null;
  pendingCount?: number;
}

export interface BrowserUserActivityResult {
  entries?: BrowserActivityEntry[];
  pendingCount?: number;
  controller?: "idle" | "ai" | "user";
}

/** server → main 的 config 消息载荷（hello-ack 之后推一次，设置变化再推） */
/** 增强包 E2 新增字段缺省 = 各自默认值（storageAccess / pagePermissions 关；trustLoopbackCerts / networkBodyRead 开；maxTabs 20） */
export interface BrowserConfig {
  recordInputValues: boolean;
  evaluateEnabled: boolean;
  /** 契约 §15 A1：true 才允许明文读写 cookie / storage（主进程侧二次校验，不只靠 server 工具注册） */
  storageAccess?: boolean;
  /** 契约 §15 A8：true 才允许 AI 授予 / 拒绝页面权限 */
  pagePermissions?: boolean;
  /** 契约 §15 A4：自动放行本机自签证书错误（默认 true） */
  trustLoopbackCerts?: boolean;
  /** 契约 §15 A7：允许读网络请求 / 响应体（默认 true） */
  networkBodyRead?: boolean;
  /** 契约 §15 C6：标签页上限（5–60，缺省 20） */
  maxTabs?: number;
}

export interface BrowserRequestOptions {
  /** 本地超时（毫秒），默认 60s */
  timeoutMs?: number;
  /** 取消信号（pi 有；Cursor 靠 bridge.cancel 在停止时主动拒绝） */
  signal?: AbortSignal;
}

export interface BrowserEventPayload {
  name: string;
  taskId: string;
  data: Record<string, unknown>;
}
