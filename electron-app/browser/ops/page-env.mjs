/**
 * V5 页面环境类新增 op：dialog / emulate（契约 §14.1）。
 *
 * - dialog：处理 / 查看挂起的 JS 对话框。**不走 runAction**——它的存在意义就是解开页面阻塞，
 *   而被阻塞时任何经 runAction 的动作都会被对话框竞速短路，再靠 runAction 的门槛拦它就成了死锁。
 *   但「处理」（accept / dismiss）在用户接管（controller=user）期间被拒（评审 R1-28）：接管意味着用户要掌控，
 *   AI 替用户点掉 confirm / beforeunload（可能是「确认删除？」）是越权；不会死锁——用户接管时自己有面板上的对话框条可点。
 *   只读的 status 不受限。
 * - emulate：设备 / 环境模拟，动作类（走 runAction：控制权 / 输入锁 / 接管打断一致），状态存在 tab 上。
 *
 * 纯逻辑（预设 / 叠加 / 摘要 / CDP 命令）在 ../emulation.mjs；本文件只管参数校验与 op 编排。
 */
import {
  describeEmulation,
  DEVICE_NAMES,
  describePatch,
  findDevicePreset,
  FORCED_COLORS_VALUES,
  MEDIA_TYPES,
  mergeEmulation,
  NETWORK_NAMES,
  ORIENTATION_LIMITS,
  PREFERS_CONTRAST_VALUES,
  SAFE_AREA_MAX,
  validateUserAgent,
  VISION_DEFICIENCIES,
} from "../emulation.mjs";
import { BrowserError } from "../server-channel.mjs";

export const OPS = Object.freeze(["dialog", "emulate"]);

const DIALOG_ACTIONS = ["status", "accept", "dismiss"];
const COLOR_SCHEMES = ["light", "dark"];

/** 数字范围校验：越界直接 BAD_ARGS（静默钳制会让模拟出和 AI 想要的不一样的尺寸，AI 无从发现） */
const rangedNum = (h, args, key, min, max, { integer = false } = {}) => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw h.bad(`参数 ${key} 必须是有限数字`);
  if (v < min || v > max) throw h.bad(`参数 ${key} 必须在 ${min}–${max} 之间，收到 ${v}`);
  return integer ? Math.round(v) : v;
};

/** 时区名交给 Intl 校验：非法时区交给 CDP 会得到一句难懂的内部错误 */
const validTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const validLocale = (l) => {
  try {
    return Intl.getCanonicalLocales(l).length === 1;
  } catch {
    return false;
  }
};

const normalizeGeolocation = (h, args) => {
  const g = args.geolocation;
  if (g === undefined || g === null) return undefined;
  if (!h.isObj(g)) throw h.bad("参数 geolocation 必须是对象 { latitude, longitude, accuracy? }");
  const latitude = rangedNum(h, g, "latitude", -90, 90);
  const longitude = rangedNum(h, g, "longitude", -180, 180);
  if (latitude === undefined || longitude === undefined) throw h.bad("geolocation 需要 latitude 与 longitude");
  const accuracy = rangedNum(h, g, "accuracy", 0, 100_000);
  return { latitude, longitude, ...(accuracy !== undefined ? { accuracy } : {}) };
};

/** emulate 的参数 → 规整后的 patch（只含给了的项）；可单测 */
export const normalizeEmulate = (args, h) => {
  const out = {};
  const reset = h.optBool(args, "reset", undefined);
  if (reset !== undefined) out.reset = reset;

  const device = h.optStr(args, "device", 80);
  if (device !== undefined) {
    const key = findDevicePreset(device);
    if (!key) throw h.bad(`未知设备预设「${device.slice(0, 40)}」。可选：${DEVICE_NAMES.join("、")}`);
    out.device = key;
  }
  const width = rangedNum(h, args, "width", 200, 4000, { integer: true });
  if (width !== undefined) out.width = width;
  const height = rangedNum(h, args, "height", 200, 4000, { integer: true });
  if (height !== undefined) out.height = height;
  const dsf = rangedNum(h, args, "deviceScaleFactor", 1, 4);
  if (dsf !== undefined) out.deviceScaleFactor = dsf;
  const mobile = h.optBool(args, "mobile", undefined);
  if (mobile !== undefined) out.mobile = mobile;
  const userAgent = h.optStr(args, "userAgent", 500);
  if (userAgent !== undefined) {
    // R1-24：UA 会原样进 CDP 的 Emulation.setUserAgentOverride（进而成为 HTTP 请求头）：含 CR/LF 等控制字符就是头注入。
    // 在参数校验阶段就拒绝（更早、不进 runAction）；mergeEmulation 里还有同一份校验兜底
    const v = validateUserAgent(userAgent);
    if (!v.ok) throw h.bad(v.reason);
    out.userAgent = userAgent;
  }
  const colorScheme = h.optEnum(args, "colorScheme", COLOR_SCHEMES, undefined);
  if (colorScheme !== undefined) out.colorScheme = colorScheme;
  const reducedMotion = h.optBool(args, "reducedMotion", undefined);
  if (reducedMotion !== undefined) out.reducedMotion = reducedMotion;
  const offline = h.optBool(args, "offline", undefined);
  if (offline !== undefined) out.offline = offline;
  const network = h.optEnum(args, "network", NETWORK_NAMES, undefined);
  if (network !== undefined) out.network = network;
  const cpuThrottle = rangedNum(h, args, "cpuThrottle", 1, 20);
  if (cpuThrottle !== undefined) out.cpuThrottle = cpuThrottle;
  const geolocation = normalizeGeolocation(h, args);
  if (geolocation) out.geolocation = geolocation;
  const timezone = h.optStr(args, "timezone", 64);
  if (timezone !== undefined) {
    if (!validTimezone(timezone)) throw h.bad(`无效的时区「${timezone.slice(0, 40)}」，应为 IANA 名称，如 Asia/Shanghai`);
    out.timezone = timezone;
  }
  const locale = h.optStr(args, "locale", 35);
  if (locale !== undefined) {
    if (!validLocale(locale)) throw h.bad(`无效的语言标签「${locale.slice(0, 40)}」，应形如 zh-CN / en-US`);
    out.locale = locale;
  }
  normalizeEmulateE2(args, h, out);
  if (Object.keys(out).length === 0 || (Object.keys(out).length === 1 && out.reset === false)) {
    throw h.bad("emulate 至少要给一个模拟项，或 reset:true 清空全部模拟");
  }
  return out;
};

/**
 * E2·P5b（C1）新增项的校验，结果写进 out。每项非法值都是 BAD_ARGS，文案带可选值，让模型能自修复。
 * 清除语义：visionDeficiency:"none" / media:空串或 null / 开关类 false → 在 mergeEmulation 里等价于清掉该项。
 */
const normalizeEmulateE2 = (args, h, out) => {
  const vision = h.optEnum(args, "visionDeficiency", VISION_DEFICIENCIES, undefined);
  if (vision !== undefined) out.visionDeficiency = vision;
  const forcedColors = h.optEnum(args, "forcedColors", FORCED_COLORS_VALUES, undefined);
  if (forcedColors !== undefined) out.forcedColors = forcedColors;
  const contrast = h.optEnum(args, "prefersContrast", PREFERS_CONTRAST_VALUES, undefined);
  if (contrast !== undefined) out.prefersContrast = contrast;
  // media：空串 / null = 恢复默认（optEnum 会把它们当「没给」，所以单独判）
  if (args.media === null || args.media === "") {
    if (Object.prototype.hasOwnProperty.call(args, "media")) out.media = null;
  } else if (args.media !== undefined) {
    if (typeof args.media !== "string" || !MEDIA_TYPES.includes(args.media)) {
      throw h.bad(`参数 media 只能是 ${MEDIA_TYPES.join(" / ")}（空字符串 = 恢复默认），收到「${String(args.media).slice(0, 20)}」`);
    }
    out.media = args.media;
  }
  const disableCache = h.optBool(args, "disableCache", undefined);
  if (disableCache !== undefined) out.disableCache = disableCache;
  const disableJavascript = h.optBool(args, "disableJavascript", undefined);
  if (disableJavascript !== undefined) out.disableJavascript = disableJavascript;
  const touch = h.optBool(args, "touch", undefined);
  if (touch !== undefined) out.touch = touch;

  const o = args.orientation;
  if (o !== undefined && o !== null) {
    if (!h.isObj(o)) throw h.bad("参数 orientation 必须是对象 { alpha?, beta?, gamma? }（度）");
    const orientation = {};
    for (const [k, [lo, hi]] of Object.entries(ORIENTATION_LIMITS)) {
      const v = rangedNum(h, o, k, lo, hi);
      orientation[k] = v ?? 0;
    }
    if (o.alpha === undefined && o.beta === undefined && o.gamma === undefined) throw h.bad("orientation 至少要给 alpha / beta / gamma 之一");
    out.orientation = orientation;
  }
  const sa = args.safeArea;
  if (sa !== undefined && sa !== null) {
    if (!h.isObj(sa)) throw h.bad("参数 safeArea 必须是对象 { top?, right?, bottom?, left? }（CSS 像素）");
    if (sa.top === undefined && sa.right === undefined && sa.bottom === undefined && sa.left === undefined) {
      throw h.bad("safeArea 至少要给 top / right / bottom / left 之一");
    }
    const safeArea = {};
    for (const side of ["top", "right", "bottom", "left"]) {
      // 整数：CDP 的 SafeAreaInsets 各边是 integer
      safeArea[side] = rangedNum(h, sa, side, 0, SAFE_AREA_MAX, { integer: true }) ?? 0;
    }
    out.safeArea = safeArea;
  }
};

export const normalize = (op, args, h) => {
  switch (op) {
    case "dialog": {
      const action = h.optEnum(args, "action", DIALOG_ACTIONS, "status");
      const promptText = typeof args.promptText === "string" ? args.promptText.slice(0, 2000) : undefined;
      if (args.promptText !== undefined && args.promptText !== null && typeof args.promptText !== "string") throw h.bad("参数 promptText 必须是字符串");
      return h.withTab(args, { action, ...(promptText !== undefined ? { promptText } : {}) });
    }
    case "emulate":
      return h.withTab(args, normalizeEmulate(args, h));
    default:
      throw h.bad(`未实现的浏览器操作：${String(op).slice(0, 40)}`);
  }
};

/** emulate 参数里「patch」部分（去掉 tabId） */
const patchOf = (a) => {
  const { tabId, ...patch } = a;
  void tabId;
  return patch;
};

export const createHandlers = (deps) => ({
  /** dialog：status / accept / dismiss。不走 runAction（见文件头）；用户接管期间只允许 status。 */
  dialog: async (taskId, a) => {
    const session = deps.requireSession(taskId);
    const tab = session.getTab(a.tabId);
    if (a.action === "status") return { pending: tab.pendingDialog ? { ...tab.pendingDialog } : null };
    if (session.controller === "user") {
      throw new BrowserError(
        "USER_CONTROL",
        "用户正在接管浏览器，不能替用户处理页面对话框（它可能是用户操作触发的确认框）。请调用 ask_user_to_act 请用户处理，或等用户点「交还给 AI」后再继续",
      );
    }
    const accept = a.action === "accept";
    const r = await tab.answerDialog(accept, a.promptText, { by: "ai" });
    if (r.handled && r.dialog) {
      // AI 处置写 actor:"ai" 条目，用户在面板时间线上能看到 AI 做了什么（§14.5）；页面文字只带到 80 字符
      const kindText = { alert: "提示框", confirm: "确认框", prompt: "输入框", beforeunload: "离开确认框" }[r.dialog.type] ?? "对话框";
      const msg = r.dialog.message ? `「${r.dialog.message.slice(0, 80)}」` : "";
      session.activityLog.addAI({
        kind: "dialog",
        tabId: tab.id,
        url: tab.url,
        summary: `${accept ? "确定" : "取消"}了页面的${kindText}${msg}`,
      });
      session.aiLabel = accept ? "确定对话框" : "取消对话框";
      session.aiLabelAt = Date.now();
    }
    scheduleSafe(deps, taskId);
    return { pending: tab.pendingDialog ? { ...tab.pendingDialog } : null, handled: r.handled };
  },

  /** emulate：增量叠加到该 tab 当前的模拟上（reset:true 先清空） */
  emulate: async (taskId, a, signal) => {
    const session = deps.requireSession(taskId);
    const patch = patchOf(a);
    return session.runAction({ op: "emulate", tabId: a.tabId, signal }, async (ctx) => {
      const tab = ctx.tab;
      // 先按「叠加后」的状态算摘要写活动日志：describe 在 fn 结束后才读取，所以这里提前算也只影响文案
      const after = describeEmulation(mergeEmulation(tab.emulation, patch));
      const label = patch.reset === true && Object.keys(patch).length === 1 ? "重置设备模拟" : "设备模拟";
      ctx.describe({
        kind: "select",
        summary: patch.reset === true && !after ? "重置了设备模拟" : `设置了设备模拟：${after ?? "无"}`,
        label,
      });
      ctx.check();
      const r = await tab.applyEmulation(patch);
      return { tabId: tab.id, applied: describePatch(patch), emulation: r.emulation };
    });
  },
});

const scheduleSafe = (deps, taskId) => {
  try {
    deps.scheduleState?.(taskId);
  } catch {
    /* 状态推送失败不影响结果 */
  }
};
