/**
 * 页面权限决策（增强包 E2 · A8，契约 §15.2）：纯函数 + 内存授予表，与 electron 零耦合，可直接在 vitest 里测真值表。
 *
 * 决策三态：
 *  - `allow`：直接放行；
 *  - `deny`：直接拒绝（不打扰用户）；
 *  - `ask`：交给 PromptHub 的 `permission` 提示，由**用户**在面板上决定（默认拒绝，60 秒）。
 *
 * 分类（宁可拒绝也不放行；下面三张表之外的权限名一律 deny，Electron 以后新增的名字也是如此）：
 *  - ALLOWED：`clipboard-sanitized-write`（页面往剪贴板写文字，无隐私面，沿用旧行为）；
 *    `speaker-selection`（只让页面看到「输出设备」的名字并能切换播放到哪个扬声器：不能录音 / 录像 / 采集任何东西；
 *    没有它，Chromium 对 `enumerateDevices()` 只给一个空名占位，声音检测 / 会议类页面就「检测不到扬声器」。
 *    只给顶层站点自己的框架，见 `FRAME_RESTRICTED_ALLOWED_PERMISSIONS`）；
 *  - NEVER：屏幕共享 / USB·HID·串口·蓝牙 / `openExternal` 永远拒绝，**AI 与用户提示都不能放开**；
 *    另外保持旧行为拒绝的：`fullscreen` / `keyboardLock`（页面能盖住 Flowship 自己的界面，伪造提示条）、`fileSystem`（读写本机文件）、
 *    `window-management` / `mediaKeySystem` / `storage-access` / `top-level-storage-access` / `unknown`；
 *  - ASKABLE：麦克风（`microphone`）/ 摄像头（`camera`）（声音 / 视频检测、会议、录音类页面都要用，和外部浏览器一样由用户在提示里点允许，
 *    **不是红线**——曾经永远拒绝，用户明确要求放开）/ 定位 / 通知 / 剪贴板读 / MIDI / 空闲检测 / 指针锁定 / 传感器 / 后台同步 → 提示。
 *    只有「用户点了允许」或「设置里打开了 AI 管理页面权限后 AI 授予」才放行，其余（含无人处理 / 跨源子框架）一律拒绝，
 *    不会让陌生页面在用户不知情时直接开麦克风 / 摄像头。
 *    **麦克风与摄像头是两个独立的授予**（R9-02）：Electron 把两者都报成 `media`（请求带 `details.mediaTypes`、检查带 `details.mediaType`），
 *    由 permission-gate 按类型拆成 `microphone` / `camera` 再来问本模块——只要麦克风、用户点「本会话一直允许」之后，摄像头仍要再问；
 *    提示条写的就是点「允许」之后授予的范围。`media` 本身不是可决策的权限名（直接问本模块 = 未知权限 = 拒绝），
 *    只在入口处当作「两个一起」展开（{@link MEDIA_PERMISSION} / {@link mediaAtomsOf}）。
 *
 * 授予只存在**会话内存**里、按 origin：`allow-session`（用户在提示里点「本会话一直允许」）与 AI 的 `permissions grant` 都写进去，
 * `reset` / 会话销毁 / 清除浏览数据清空，**不落盘**。AI 写的授予（source:"ai"）只在 `config.pagePermissions === true` 时生效——
 * 用户事后在设置里关掉开关，已有的 AI 授予立刻失效（主进程独立判断，不信 server）。
 */

// ───────────────────────── 权限名分类 ─────────────────────────

/** 直接放行 */
export const ALLOWED_PERMISSIONS = Object.freeze(["clipboard-sanitized-write", "speaker-selection"]);

/**
 * ALLOWED 里「只给顶层站点自己的框架」的那部分：被别的站点嵌着的框架（广告 / 第三方嵌入）一律不给，
 * 不依赖 Chromium 的 Permissions Policy 一直替我们挡（剪贴板写保持旧行为不分框架，所以不在这里）。
 */
export const FRAME_RESTRICTED_ALLOWED_PERMISSIONS = Object.freeze(["speaker-selection"]);

/** 永远拒绝（含设备类）。AI 的 grant / deny 对它们返回 DENIED，提示条里也不会出现 */
export const NEVER_PERMISSIONS = Object.freeze([
  "display-capture",
  "usb",
  "hid",
  "serial",
  "bluetooth",
  "openExternal",
  "fullscreen",
  "keyboardLock",
  "fileSystem",
  "window-management",
  "mediaKeySystem",
  "storage-access",
  "top-level-storage-access",
  "unknown",
]);

/**
 * Electron 的 `media` 权限名 = 麦克风 + 摄像头两件事的合称（请求 / 检查里用 `mediaTypes` / `mediaType` 区分）。
 * 它不是可决策的权限名，不在任何一张表里：只在 gate / AI 工具入口处展开成 {@link MEDIA_ATOMS}。
 */
export const MEDIA_PERMISSION = "media";

/** `media` 展开后的两个独立权限（顺序固定：麦克风在前）；授予表 / 提示 / 活动日志里都用这两个名字 */
export const MEDIA_ATOMS = Object.freeze(["microphone", "camera"]);

/**
 * Electron 报的媒体类型（请求的 `details.mediaTypes` 是数组、检查的 `details.mediaType` 是字符串）→ 要决策的独立权限名。
 * 请求里写了 audio / video 就只问对应的；**没给 / 空 / 认不出（含检查处理器的 `unknown`）= 两个都要**——宁可多问一项，不少问一项。
 * @param {unknown} types
 * @returns {("microphone" | "camera")[]} 至少一项、去重
 */
export const mediaAtomsOf = (types) => {
  const list = Array.isArray(types) ? types : typeof types === "string" ? [types] : [];
  const audio = list.includes("audio");
  const video = list.includes("video");
  if (!audio && !video) return [...MEDIA_ATOMS];
  return [...(audio ? ["microphone"] : []), ...(video ? ["camera"] : [])];
};

/** 需要用户决定的权限 */
export const ASKABLE_PERMISSIONS = Object.freeze([
  "microphone",
  "camera",
  "geolocation",
  "notifications",
  "clipboard-read",
  "midi",
  "midiSysex",
  "idle-detection",
  "pointerLock",
  "sensors",
  "background-sync",
]);

/** 提示 / 日志里用的中文名（认不出的原样用权限名） */
export const PERMISSION_LABEL_ZH = Object.freeze({
  geolocation: "位置信息",
  notifications: "通知",
  "clipboard-read": "读取剪贴板",
  "clipboard-sanitized-write": "写入剪贴板",
  "speaker-selection": "选择扬声器",
  microphone: "麦克风",
  camera: "摄像头",
  // 合称：只出现在「同时问麦克风和摄像头」的那一条提示 / 日志里，以及 AI 写 `media` 表示「两个一起」时
  media: "摄像头 + 麦克风",
  "display-capture": "屏幕共享",
  midi: "MIDI 设备",
  midiSysex: "MIDI 系统独占消息",
  "idle-detection": "空闲检测",
  pointerLock: "鼠标锁定",
  sensors: "传感器",
  "background-sync": "后台同步",
  openExternal: "打开外部应用",
  fullscreen: "全屏",
  fileSystem: "访问本机文件",
});

/** 同义写法 → 规范名（模型常写 camera / location / notification；别名只用于入参，不改变 Electron 给的名字） */
const PERMISSION_ALIASES = Object.freeze({
  location: "geolocation",
  gps: "geolocation",
  notification: "notifications",
  notify: "notifications",
  mic: "microphone",
  audio: "microphone",
  video: "camera",
  // 合称保持 `media`（大小写不敏感地认出来，调用方据此展开成两个独立权限）
  media: MEDIA_PERMISSION,
  clipboard: "clipboard-read",
  "clipboard-write": "clipboard-sanitized-write",
  screen: "display-capture",
  "screen-capture": "display-capture",
  "screen-share": "display-capture",
  "deprecated-sync-clipboard-read": "clipboard-read",
  "sensor": "sensors",
  "motion-sensors": "sensors",
  "pointer-lock": "pointerLock",
  "midi-sysex": "midiSysex",
  "external-protocol": "openExternal",
});

const PERMISSION_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;

/**
 * 权限名规整：返回规范名；不是合法的名字格式返回 null（调用方给 BAD_ARGS）。
 * 注意：格式合法但不在三张表里的名字原样返回（决策里会按「未知 → deny」处理）。
 */
export const canonicalPermission = (name) => {
  if (typeof name !== "string") return null;
  const raw = name.trim();
  if (!PERMISSION_NAME_RE.test(raw)) return null;
  const alias = PERMISSION_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  // 大小写不敏感地对上规范名（Electron 的名字有 midiSysex / pointerLock 这类驼峰）
  const hit = [...ASKABLE_PERMISSIONS, ...ALLOWED_PERMISSIONS, ...NEVER_PERMISSIONS].find((p) => p.toLowerCase() === raw.toLowerCase());
  return hit ?? raw;
};

export const isNeverPermission = (permission) => NEVER_PERMISSIONS.includes(permission);
export const isAskablePermission = (permission) => ASKABLE_PERMISSIONS.includes(permission);

// ───────────────────────── origin ─────────────────────────

/**
 * URL / origin 字符串 → 规整的 origin（`https://a.com:8443`）；只认 http(s)，其余（about:blank / file: / data: / 不透明的 "null" / 垃圾）返回 null。
 * 一律走 `new URL()` 的真实解析：`http://localhost@evil.com` 的 origin 是 evil.com。
 */
export const originOf = (value) => {
  if (typeof value !== "string" || value === "" || value.length > 2048) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.hostname === "") return null;
    return u.origin;
  } catch {
    return null;
  }
};

/** 入参里的 origin（AI 可能写成 `example.com` / `localhost:3000`）：先按原样，不成再按 https 补协议；仍不行返回 null */
export const parseOriginArg = (value) => {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return null;
  const direct = originOf(raw);
  if (direct) return direct;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/]+:\d+(\/|$)/.test(raw)) return null; // 明确写了别的协议（file: / javascript: …）：不替它补
  return originOf(`https://${raw}`);
};

// ───────────────────────── 授予表（会话内存） ─────────────────────────

/** 单个会话里最多保存多少条授予 / 拒绝记录（AI 能写入，所以要有上限） */
export const MAX_GRANT_ENTRIES = 200;

/**
 * 会话级授予表：origin → permission → { decision:"allow"|"deny", source:"user"|"ai", at }。
 * `deny` 是显式拒绝记录（AI 的 `permissions deny`）：命中后直接拒绝、不再弹提示；`allow` 是授予。
 */
export const createPermissionGrants = ({ now = Date.now, max = MAX_GRANT_ENTRIES } = {}) => {
  /** @type {Map<string, Map<string, { decision: "allow"|"deny", source: "user"|"ai", at: number }>>} */
  const byOrigin = new Map();
  let count = 0;

  const get = (origin, permission) => byOrigin.get(origin)?.get(permission);

  const put = (origin, permission, decision, source) => {
    if (typeof origin !== "string" || typeof permission !== "string") return false;
    let m = byOrigin.get(origin);
    if (!m) byOrigin.set(origin, (m = new Map()));
    if (!m.has(permission)) {
      if (count >= max) return false;
      count += 1;
    }
    m.set(permission, { decision, source: source === "ai" ? "ai" : "user", at: now() });
    return true;
  };

  const remove = (origin, permission) => {
    const m = byOrigin.get(origin);
    if (!m || !m.delete(permission)) return false;
    count -= 1;
    if (m.size === 0) byOrigin.delete(origin);
    return true;
  };

  return {
    get,
    allow: (origin, permission, source) => put(origin, permission, "allow", source),
    deny: (origin, permission, source) => put(origin, permission, "deny", source),
    /** reset：不给 origin = 所有 origin；不给 permission = 该 origin 的全部；返回清掉的条数 */
    reset: ({ origin, permission } = {}) => {
      let n = 0;
      for (const o of [...byOrigin.keys()]) {
        if (origin !== undefined && o !== origin) continue;
        for (const p of [...(byOrigin.get(o)?.keys() ?? [])]) {
          if (permission !== undefined && p !== permission) continue;
          if (remove(o, p)) n += 1;
        }
      }
      return n;
    },
    list: () => {
      const out = [];
      for (const [origin, m] of byOrigin) for (const [permission, e] of m) out.push({ origin, permission, decision: e.decision, source: e.source, at: e.at });
      return out;
    },
    clear: () => {
      byOrigin.clear();
      count = 0;
    },
    get size() {
      return count;
    },
  };
};

// ───────────────────────── 决策 ─────────────────────────

/**
 * 决策（附原因，单测与日志用）。
 * @param {{
 *   permission: string,
 *   origin: string | null,                      // 请求来源 origin（originOf 的结果；不是 http(s) = null）
 *   grants?: ReturnType<typeof createPermissionGrants> | null,
 *   config?: { pagePermissions?: boolean } | null,
 *   emulatedGeolocationOrigins?: string[],      // 「定位模拟」当前对哪些 origin 生效（tab 级，导航到别的 origin 就不在里面了）
 *   isAppOrigin?: boolean,                      // 请求来源是 Flowship 自己的 origin
 * }} input
 * @returns {{ decision: "allow" | "deny" | "ask", reason: string }}
 */
export const decidePermissionWithReason = (input) => {
  const permission = canonicalPermission(input?.permission) ?? String(input?.permission ?? "");
  const origin = typeof input?.origin === "string" ? input.origin : null;
  const grants = input?.grants ?? null;
  const config = input?.config ?? null;

  // 1) Flowship 自己的 origin：什么都不给（红线 1；其实浏览器根本导航不过去，这是纵深防御）
  if (input?.isAppOrigin === true) return { decision: "deny", reason: "app-origin" };
  // 2) 永远拒绝
  if (NEVER_PERMISSIONS.includes(permission)) return { decision: "deny", reason: "never" };
  // 3) 无隐私面的放行
  if (ALLOWED_PERMISSIONS.includes(permission)) return { decision: "allow", reason: "allowed" };
  // 4) 不在可询问清单里的未知权限：fail closed
  if (!ASKABLE_PERMISSIONS.includes(permission)) return { decision: "deny", reason: "unknown-permission" };
  // 5) 没有可授予的 origin（about:blank / data: / 不透明来源）：拒绝，不弹提示（提示条无法说明「谁」在请求）
  if (origin === null) return { decision: "deny", reason: "opaque-origin" };

  const entry = grants?.get(origin, permission);
  if (entry?.decision === "deny") return { decision: "deny", reason: `explicit-deny-${entry.source}` };
  if (entry?.decision === "allow") {
    // AI 写的授予只在设置开关打开时生效；用户在提示里点的 allow-session 永远有效
    if (entry.source === "user" || config?.pagePermissions === true) return { decision: "allow", reason: `grant-${entry.source}` };
  }
  if (permission === "geolocation" && Array.isArray(input?.emulatedGeolocationOrigins) && input.emulatedGeolocationOrigins.includes(origin)) {
    return { decision: "allow", reason: "emulated-geolocation" };
  }
  return { decision: "ask", reason: "needs-user" };
};

/** 契约接口：只要决策三态 */
export const decidePermission = (input) => decidePermissionWithReason(input).decision;
