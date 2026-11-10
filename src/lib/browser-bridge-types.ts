/**
 * 内嵌浏览器：渲染进程 ⇄ 主进程的类型（纯类型，无运行时代码）
 *
 * 唯一权威是 docs/BROWSER-AUTOMATION.md §5 / §4.3 / §4.4；这里只是把契约抄成 TS，
 * 前端 UI（src/components/browser/**）和任何要读 `window.__browser` 的代码共用。
 * 要改协议先改契约文档，别在这里悄悄加字段。
 *
 * `window.__browser` 只在 Electron 桌面端的主窗口里存在（preload.cjs 暴露）：
 * 网页版（pnpm dev:web）没有它，所以声明成可选，访问处一律先判空、且只能在 effect / 事件回调里碰
 * （SSR 阶段没有 window）。
 */

/** CSS 像素，相对主窗口内容区左上角；主进程会再取整 */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 单个标签页（契约 §4.3） */
export interface TabInfo {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isActive: boolean;
  /** 设备 / 环境模拟摘要（契约 §14.1 emulate），如「iPhone 15 · 暗色」；没有模拟时缺省或 null */
  emulation?: string | null;
  /** 缩放百分比整数（契约 §14.3），100 / 缺省 = 不缩放 */
  zoom?: number;
  /** 无痕标签（契约 §15 A6）：独立的内存 partition，关闭即销毁；缺省 / false = 共享的持久档案 */
  incognito?: boolean;
}

/** 会话里谁在操作（契约 §6） */
export type BrowserController = "idle" | "ai" | "user";

/** 活动日志条目的操作者 */
export type ActivityActor = "user" | "ai" | "system";

/** 活动日志条目的类型（契约 §4.4） */
export type ActivityKind =
  | "click"
  | "type"
  | "key"
  | "scroll"
  | "select"
  | "submit"
  | "navigate"
  | "load"
  | "tab_open"
  | "tab_close"
  | "download"
  | "dialog"
  | "takeover"
  | "handback"
  | "pick";

/** 活动日志条目（AI 与用户共用；summary 已压缩已脱敏，一行中文） */
export interface ActivityEntry {
  /** 会话内单调递增 */
  id: number;
  ts: number;
  actor: ActivityActor;
  kind: ActivityKind;
  tabId: string;
  url: string;
  summary: string;
  target?: { role?: string; name?: string; ref?: string };
  /** 被合并的原始事件数 */
  count?: number;
}

/** `ask_user_to_act` 挂起中的请求 */
export interface BrowserAskRequest {
  message: string;
  since: number;
}

/** 下载条目（契约 §14.1）；url 已去掉 query / hash */
export interface DownloadInfo {
  id: number;
  fileName: string;
  path: string;
  url: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  endedAt?: number;
  tabId?: string;
}

/** 挂起中的 JS 对话框（契约 §14.1 对话框策略） */
export interface DialogInfo {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
  url: string;
  since: number;
}

/**
 * 等待用户处理的提示（契约 §15.1）：HTTP 认证 / 证书错误 / 页面权限 / evaluate 授权 / 客户端证书。
 * 只含展示用的字段——凭据、证书口令这类秘密永远不进状态、不进日志、不给 AI（只在 IPC 回答时从渲染进程直达主进程）。
 * 所有文字字段（host / detail 的值）都来自页面或网络，渲染前仍要当不可信文本处理（纯文本渲染、不 dangerouslySetInnerHTML）。
 */
export type BrowserPromptKind = "auth" | "cert" | "permission" | "evaluate" | "clientcert";

export interface BrowserPromptInfo {
  id: string;
  kind: BrowserPromptKind;
  tabId?: string;
  /** 站点（host[:port]）；evaluate 授权没有站点时是空串 */
  host: string;
  /** 展示用的键值（realm / 错误码 / 权限名 / 证书指纹摘要…），值已剥格式字符、限长 */
  detail: Record<string, string>;
  /** 用户可以选的动作（auth: submit|cancel；cert: allow-host|deny；permission: allow|allow-session|deny；evaluate: task|always|deny；clientcert: select|decline） */
  actions: string[];
  since: number;
  /** 到这个时间点自动取消（毫秒时间戳） */
  expiresAt: number;
}

/** 页内查找的进度推送（`browser:found`，契约 §14.3） */
export interface FoundInPage {
  taskId: string;
  activeMatchOrdinal: number;
  matches: number;
}

/** 某个任务的浏览器会话状态（主进程 50ms 去抖后推送） */
export interface BrowserState {
  taskId: string;
  exists: boolean;
  controller: BrowserController;
  /** ask_user_to_act 挂起中 */
  askRequest: BrowserAskRequest | null;
  /** 最近一次 AI 动作的人话描述，如 点击 按钮「登录」 */
  aiLabel: string | null;
  aiLabelAt: number | null;
  activeTabId: string | null;
  tabs: TabInfo[];
  /** 视图当前是否挂在主窗口 */
  attached: boolean;
  covered: boolean;
  picking: boolean;
  /** AI 还没看到的用户操作条数 */
  pendingUserActivity: number;
  /** 最近 20 条（AI + 用户 + 系统），UI 时间线用 */
  recent: ActivityEntry[];
  /** 挂起中的 JS 对话框（契约 §14.1）；老壳 / 没有时缺省或 null */
  dialog?: DialogInfo | null;
  /** 最近 10 条下载（契约 §14.1）；老壳缺省 */
  downloads?: DownloadInfo[];
  /**
   * 主窗口此刻是否有系统焦点（BrowserWindow.isFocused()，焦点在原生浏览器视图里时也为 true；R1-35）。
   * 由主进程在推送 / 读状态的出口附加；老壳缺省——渲染端缺省时按「不确定」处理，不静音后台通知。
   */
  windowFocused?: boolean;
  /** 等待用户处理的提示（契约 §15.1）；老壳缺省，主进程总是给（至少 []） */
  prompts?: BrowserPromptInfo[];
  /** AI 设置的网络规则（契约 §15 A5）：count = 生效条数（0 = 没有）；paused = 用户接管期间暂停中 */
  netRules?: { count: number; paused: boolean } | null;
  /** JS 调试器暂停中（契约 §15 B5）；没有暂停为 null */
  debug?: { paused: boolean; reason?: string; url?: string; line?: number; since: number } | null;
  /** 录制中（契约 §15 B7）；没有为 null */
  recording?: { frames: number; startedAt: number } | null;
}

/** 元素拾取结果（P3） */
export interface PickedElement {
  url: string;
  title: string;
  /** 尽量稳定的 CSS 选择器 */
  selector: string;
  role?: string;
  name?: string;
  /** 截断到 4000 字符；被隐藏（无法确认其中的输入框都已脱敏）时是空串，原因见 outerHTMLNote */
  outerHTML: string;
  /**
   * outerHTML 为什么是空 / 为什么来自降级路径（主进程写的固定说明，≤300 字符）。没有这个字段 = 一切正常。
   * 展示前仍按「页面数据」处理（flatten + clip），见 pick-compose。
   */
  outerHTMLNote?: string;
  /** 元素可见文本，截断到 500 字符 */
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  /** 元素截图 jpeg dataURL（≤ 200KB，超了不带） */
  screenshot?: string;
  /** 尽力而为，拿不到就 null */
  reactSource?: { file: string; line?: number; component?: string } | null;
}

/** preload 暴露给渲染进程的浏览器桥（契约 §5） */
export interface BrowserBridge {
  // —— 视图生命周期（面板挂载 / 卸载 / 尺寸）——
  /** 懒创建会话，把该会话的视图搬到主窗口并设 bounds */
  attach(taskId: string, bounds: Bounds): Promise<BrowserState>;
  /** 拖分栏 / 缩放时高频调用（渲染端 rAF 节流） */
  setBounds(taskId: string, bounds: Bounds): void;
  /** 搬回停车场（面板卸载 / 离开任务页） */
  detach(taskId: string): void;
  /**
   * covered=true：对视图截图 → 隐藏视图 → 返回 jpeg dataURL（UI 画占位图）；
   * covered=false：恢复显示；失败返回 null
   */
  setCovered(taskId: string, covered: boolean): Promise<string | null>;

  // —— 用户导航（地址栏 / 按钮，走 URL 策略；裸词按搜索处理）——
  navigate(taskId: string, input: string): Promise<{ ok: boolean; error?: string }>;
  back(taskId: string): void;
  forward(taskId: string): void;
  reload(taskId: string): void;
  stop(taskId: string): void;
  newTab(taskId: string, url?: string): Promise<string | null>;
  selectTab(taskId: string, tabId: string): void;
  closeTab(taskId: string, tabId: string): void;

  // —— 谁在操作 ——
  /** 用户接管：解锁输入、中断 AI 当前动作 */
  takeover(taskId: string): void;
  /** 交还给 AI：→ server evt "handback" */
  handback(taskId: string, note?: string): void;
  /** 响应 ask_user_to_act */
  answerAsk(taskId: string, outcome: "done" | "skipped", note?: string): void;

  // —— 元素拾取（P3）——
  startPick(taskId: string): void;
  cancelPick(taskId: string): void;

  // —— 状态 ——
  getState(taskId: string): Promise<BrowserState | null>;
  /** 推送全部任务的状态（主进程 50ms 去抖），返回取消订阅 */
  onState(cb: (taskId: string, state: BrowserState) => void): () => void;
  onPicked(cb: (taskId: string, picked: PickedElement) => void): () => void;
  /** 清登录态（cookies / storage），面板溢出菜单用 */
  clearBrowsingData(): Promise<void>;

  // —— V4 用户侧（契约 §14.3）。老壳没有这些方法：调用处一律可选链 / 先判存在 ——
  /** 缩放当前 tab（每 tab 独立，−3…+5 档、步进 0.5；TabInfo.zoom 是百分比） */
  zoom?(taskId: string, action: "in" | "out" | "reset"): void;
  /** 页内查找；text 为空等价于 stopFind */
  find?(taskId: string, text: string, opts?: FindOptions): void;
  /** 结束查找并清掉页内高亮 */
  stopFind?(taskId: string): void;
  /** 查找进度推送，返回取消订阅 */
  onFound?(cb: (found: FoundInPage) => void): () => void;
  /** 页面持有焦点时按了 Cmd/Ctrl+F → 面板应打开查找条，返回取消订阅 */
  onFindRequested?(cb: (taskId: string) => void): () => void;
  /** 打开当前 tab 的开发者工具（独立窗口） */
  openDevTools?(taskId: string): void;
  /** 在文件夹中显示下载；只传会话内的下载 id，路径由主进程从登记表取 */
  revealDownload?(taskId: string, id: number): Promise<DownloadActionResult>;
  /** 打开下载（可执行类扩展名主进程会拒绝） */
  openDownload?(taskId: string, id: number): Promise<DownloadActionResult>;
  /** 处理挂起的 JS 对话框（prompt 时带输入） */
  answerDialog?(taskId: string, accept: boolean, promptText?: string): void;
  /** 清掉当前 tab 的设备 / 环境模拟 */
  resetEmulation?(taskId: string): void;
  /**
   * 契约 §15.1 的通用扩展通道：`browser:ext`，按名字分发到主进程注册的处理器（`prompt.answer` / `netrules.clear` / `debug.resume` / `record.stop` …）。
   * 名字不在主进程的注册表里 → 抛错。老壳没有它。
   */
  ext?(name: string, taskId: string, ...args: unknown[]): Promise<unknown>;
  /**
   * R7：把本地 .html / .htm 登记成一次性 token 的只读 loopback URL（`http://<token>.localhost:<端口>/<文件名>`，每个 token 一个 origin，不是 `file:`，
   * 也不是 Flowship 自己的地址，所以 AI 的 `browser_*` 工具能用）。只传绝对路径；范围 / 敏感文件 / 大小校验都在主进程。
   * `scope`："dir" = 能加载同目录的相对资源；"file" = 目录太宽（家目录 / 桌面 / 根…）只放这一个文件。
   * 永不 reject：失败 `{ ok:false, error }`，调用方回退系统打开。老壳没有它。
   */
  serveLocalHtml?(absPath: string): Promise<ServeLocalHtmlResult>;
}

/** `serveLocalHtml` 的结果 */
export type ServeLocalHtmlResult = { ok: true; url: string; scope: "dir" | "file" } | { ok: false; error: string };

/** `browser:find` 的选项（主进程只认这三个布尔） */
export interface FindOptions {
  /** 默认 true；false = 往上一个 */
  forward?: boolean;
  /**
   * 沿用 Electron `findInPage` 的原语义（与直觉相反）：true = **开始新一轮**查找（首次 / 词变了），
   * false（缺省）= 同一轮里的后续请求（下一个 / 上一个，配合 forward）。
   */
  findNext?: boolean;
  matchCase?: boolean;
}

/** revealDownload / openDownload 的结果 */
export interface DownloadActionResult {
  ok: boolean;
  error?: string;
}

declare global {
  interface Window {
    /** Electron preload 暴露的浏览器桥（仅桌面端主窗口有；网页版为 undefined） */
    __browser?: BrowserBridge;
  }
}
