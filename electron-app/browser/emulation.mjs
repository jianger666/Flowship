/**
 * 设备 / 环境模拟（契约 §14.1 `emulate`）：预设表、增量叠加、人话摘要、翻成 CDP 命令序列。
 *
 * 纯函数、与 electron 零耦合：状态（plain object）存在 tab 上，tab 负责在 CDP 就绪 / 重连后重放。
 * 把「状态 → 命令」做成纯函数的原因：
 *   - 换页 / 渲染进程重建 / debugger 重连后，需要用同一份状态重放一遍，不能依赖「上次发过什么」；
 *   - 增量叠加 / reset 需要的 clear 命令只有对比前后状态才知道，放在这里统一算，可单测。
 *
 * 状态形状（全部可选，缺省 = 该项没有被模拟）：
 *   { device?, width?, height?, deviceScaleFactor?, mobile?, userAgent?,
 *     colorScheme?: "light"|"dark", reducedMotion?: boolean,
 *     offline?: true, network?: "slow3g"|"fast3g"|"4g", cpuThrottle?: number,
 *     geolocation?: {latitude,longitude,accuracy?}, timezone?, locale?,
 *     // E2·P5b（C1）
 *     visionDeficiency?: "blurredVision"|"reducedContrast"|"achromatopsia"|"deuteranopia"|"protanopia"|"tritanopia",
 *     forcedColors?: "active"|"none", prefersContrast?: "more"|"less"|"no-preference"|"custom",
 *     media?: "print"|"screen", disableCache?: true, disableJavascript?: true, touch?: boolean,
 *     orientation?: {alpha,beta,gamma}, safeArea?: {top,right,bottom,left} }
 * `offline:false` / `network:"none"` / `visionDeficiency:"none"` / `disableCache:false` 不进状态（它们的含义就是「不限制」）。
 */

import { BrowserError } from "./server-channel.mjs";

/** 预设设备表。userAgent 缺省（桌面预设）= 不改 UA，沿用浏览器自带的。 */
export const DEVICE_PRESETS = Object.freeze({
  "iPhone 15": Object.freeze({
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  }),
  "iPhone SE": Object.freeze({
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  }),
  "Pixel 8": Object.freeze({
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  }),
  iPad: Object.freeze({
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  }),
  "Galaxy S23": Object.freeze({
    width: 360,
    height: 780,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  }),
  "Desktop 1440": Object.freeze({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }),
  "Desktop 1920": Object.freeze({ width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }),
});

export const DEVICE_NAMES = Object.freeze(Object.keys(DEVICE_PRESETS));

/** 网络档位 → CDP Network.emulateNetworkConditions 参数（吞吐单位 bytes/s；latency 单位 ms） */
export const NETWORK_PROFILES = Object.freeze({
  // 约 400kbps 下行 / 上行、400ms 延迟
  slow3g: Object.freeze({ latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 }),
  // 约 1.6Mbps 下行 / 750kbps 上行、150ms 延迟
  fast3g: Object.freeze({ latency: 150, downloadThroughput: 200_000, uploadThroughput: 93_750 }),
  // 约 9Mbps 下行 / 1.5Mbps 上行、170ms 延迟
  "4g": Object.freeze({ latency: 170, downloadThroughput: 1_125_000, uploadThroughput: 187_500 }),
});

export const NETWORK_NAMES = Object.freeze(["none", ...Object.keys(NETWORK_PROFILES)]);

// ── E2·P5b（C1）新增项的取值表（server / op / 纯函数三处共用同一份，避免漂移） ──
/** `Emulation.setEmulatedVisionDeficiency` 的 type；`none` = 取消 */
export const VISION_DEFICIENCIES = Object.freeze(["none", "blurredVision", "reducedContrast", "achromatopsia", "deuteranopia", "protanopia", "tritanopia"]);
export const FORCED_COLORS_VALUES = Object.freeze(["active", "none"]);
/** CSS prefers-contrast 的合法取值（`custom` 对应 Chromium 的 prefers-contrast: custom） */
export const PREFERS_CONTRAST_VALUES = Object.freeze(["more", "less", "no-preference", "custom"]);
export const MEDIA_TYPES = Object.freeze(["print", "screen"]);
/** 设备方向范围（W3C DeviceOrientationEvent）：alpha 0–360、beta -180–180、gamma -90–90 */
export const ORIENTATION_LIMITS = Object.freeze({ alpha: [0, 360], beta: [-180, 180], gamma: [-90, 90] });
/** safe-area-inset 上限（CSS 像素）：真机刘海 / 灵动岛 / Home 条都在 100 以内，1000 只是防手滑 */
export const SAFE_AREA_MAX = 1000;
const SAFE_AREA_SIDES = Object.freeze(["top", "right", "bottom", "left"]);
const VISION_LABEL = Object.freeze({
  blurredVision: "模糊视力",
  reducedContrast: "低对比度视力",
  achromatopsia: "全色盲",
  deuteranopia: "绿色盲",
  protanopia: "红色盲",
  tritanopia: "蓝色盲",
});

/** 摘要里的网络档位文案 */
const NETWORK_LABEL = Object.freeze({ slow3g: "弱网 3G", fast3g: "快速 3G", "4g": "4G" });

/** 设备名宽松匹配：忽略大小写 / 空格 / 连字符 / 下划线（模型常写 iphone15、iPhone-15）。找不到返回 null。 */
export const findDevicePreset = (name) => {
  if (typeof name !== "string") return null;
  const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const want = norm(name);
  if (!want) return null;
  for (const key of DEVICE_NAMES) if (norm(key) === want) return key;
  return null;
};

const VIEWPORT_KEYS = ["width", "height", "deviceScaleFactor", "mobile", "userAgent"];

/**
 * UA 里不允许出现的字符（R1-24）：C0 控制符（含 NUL / TAB / CR / LF）、DEL、C1 控制符、行 / 段分隔符 U+2028 / U+2029。
 * UA 会作为 HTTP 请求头的值发出去：含 CR / LF 时 CDP 的 `Emulation.setUserAgentOverride` 会拒绝（评审结论，
 * 具体报错文案以 Chromium 为准，未在真实 Electron 里复现），而同一 patch 里别的项可能已经套上了一半；
 * 真实 UA 从来不含这些字符，所以一律在入口（op 校验 / mergeEmulation）就挡掉，根本不发命令。
 */
const UA_FORBIDDEN_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/**
 * 校验要模拟的 User-Agent（纯函数，不改入参；长度上限由 op 层的 optStr 管，这里只管字符）。
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export const validateUserAgent = (ua) => {
  if (typeof ua !== "string") return { ok: false, reason: "userAgent 必须是字符串" };
  const m = UA_FORBIDDEN_CHAR.exec(ua);
  if (m) {
    const code = m[0].codePointAt(0) ?? 0;
    return {
      ok: false,
      reason: `userAgent 不能包含控制字符（第 ${m.index + 1} 个字符是 U+${code.toString(16).toUpperCase().padStart(4, "0")}，如换行 / 回车 / 制表符 / 不可见字符），请只传一行可见文本`,
    };
  }
  return { ok: true };
};

/** 状态里「真的有内容」的键（false / null / undefined 的开关不算） */
const isActive = (k, v) => {
  if (v === undefined || v === null) return false;
  if (k === "offline") return v === true;
  if (k === "reducedMotion") return typeof v === "boolean"; // false = 显式 no-preference，也要发
  if (k === "network") return v !== "none";
  if (k === "visionDeficiency") return v !== "none";
  if (k === "disableCache" || k === "disableJavascript") return v === true;
  if (k === "touch") return typeof v === "boolean"; // false = 显式关闭触屏（即使 mobile 预设），也要发
  if (k === "media") return v === "print" || v === "screen";
  return true;
};

/**
 * 增量叠加：patch 里给了的项覆盖 prev，没给的保留。
 *  - `reset:true`：先清空再叠加 patch 里的其它项；
 *  - `device`：先铺预设（尺寸 / dsf / mobile / UA），patch 里显式给的 width / height / … 再覆盖预设；
 *  - 值为 null：清掉该项；`offline:false` / `network:"none"`：等价于清掉。
 * 返回新对象，不改入参。
 */
export const mergeEmulation = (prev, patch) => {
  const p = patch && typeof patch === "object" ? patch : {};
  // R1-24 兜底：op 层（normalizeEmulate）本该先拒；这里再拒一次，保证任何调用方（IPC / 重放 / 将来新增的入口）
  // 都不可能把带控制字符的 UA 写进状态。抛在改状态之前：tab.applyEmulation 里 mergeEmulation 先于 `this.emulation = next`。
  if (p.userAgent !== undefined && p.userAgent !== null) {
    const v = validateUserAgent(p.userAgent);
    if (!v.ok) throw new BrowserError("BAD_ARGS", v.reason);
  }
  let next = p.reset === true ? {} : { ...(prev && typeof prev === "object" ? prev : {}) };

  if (p.device !== undefined && p.device !== null) {
    const key = findDevicePreset(p.device);
    if (key) {
      const preset = DEVICE_PRESETS[key];
      // 换设备 = 视口相关各项整体换掉（含「预设没有 UA」时要去掉上一个设备留下的 UA）
      for (const k of VIEWPORT_KEYS) delete next[k];
      next = { ...next, ...preset, device: key };
    }
  }
  for (const k of VIEWPORT_KEYS) {
    if (p[k] === undefined) continue;
    if (p[k] === null) delete next[k];
    else next[k] = p[k];
  }
  if (p.device === null) delete next.device;

  for (const k of ["colorScheme", "cpuThrottle", "geolocation", "timezone", "locale", "reducedMotion"]) {
    if (p[k] === undefined) continue;
    if (p[k] === null) delete next[k];
    else next[k] = p[k];
  }
  if (p.offline !== undefined) {
    if (p.offline === true) next.offline = true;
    else delete next.offline;
  }
  if (p.network !== undefined) {
    if (p.network === null || p.network === "none") delete next.network;
    else next.network = p.network;
  }
  // E2·P5b：新增项。null 清掉；开关类 false 等价于清掉；visionDeficiency:"none" 同理
  for (const k of ["forcedColors", "prefersContrast", "media", "touch", "orientation", "safeArea"]) {
    if (p[k] === undefined) continue;
    if (p[k] === null) delete next[k];
    else next[k] = p[k];
  }
  if (p.visionDeficiency !== undefined) {
    if (p.visionDeficiency === null || p.visionDeficiency === "none") delete next.visionDeficiency;
    else next.visionDeficiency = p.visionDeficiency;
  }
  for (const k of ["disableCache", "disableJavascript"]) {
    if (p[k] === undefined) continue;
    if (p[k] === true) next[k] = true;
    else delete next[k];
  }
  // 没有任何有效项就返回空对象（让「无模拟」只有一种表示）
  for (const [k, v] of Object.entries(next)) if (!isActive(k, v)) delete next[k];
  return next;
};

const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

/** 视口那一段的人话：`iPhone 15` / `iPhone 15（500×852）` / `390×844` / `移动端`；没有返回 null */
const describeViewport = (s) => {
  const preset = s.device ? DEVICE_PRESETS[s.device] : null;
  const size = s.width || s.height ? `${s.width || "自适应"}×${s.height || "自适应"}` : null;
  if (preset) {
    const same = (s.width ?? preset.width) === preset.width && (s.height ?? preset.height) === preset.height;
    return same ? s.device : `${s.device}（${size}）`;
  }
  if (size) return s.mobile ? `${size} 移动端` : size;
  return s.mobile === true ? "移动端" : null;
};

/** 状态 → 一行人话摘要；没有任何模拟返回 null（TabInfo.emulation 直接用它）。 */
export const describeEmulation = (state) => {
  const s = state && typeof state === "object" ? state : {};
  const parts = [];
  const vp = describeViewport(s);
  if (vp) parts.push(vp);
  if (s.deviceScaleFactor && !s.device) parts.push(`${fmtNum(s.deviceScaleFactor)}x 像素比`);
  if (s.userAgent && !(s.device && DEVICE_PRESETS[s.device]?.userAgent === s.userAgent)) parts.push("自定义 UA");
  if (s.colorScheme === "dark") parts.push("暗色");
  else if (s.colorScheme === "light") parts.push("亮色");
  if (s.reducedMotion === true) parts.push("减少动态效果");
  if (s.offline === true) parts.push("离线");
  else if (s.network && NETWORK_LABEL[s.network]) parts.push(NETWORK_LABEL[s.network]);
  if (typeof s.cpuThrottle === "number" && s.cpuThrottle > 1) parts.push(`CPU ${fmtNum(s.cpuThrottle)}× 降速`);
  if (s.geolocation) parts.push(`定位 ${fmtNum(s.geolocation.latitude)},${fmtNum(s.geolocation.longitude)}`);
  if (s.timezone) parts.push(`时区 ${s.timezone}`);
  if (s.locale) parts.push(`语言 ${s.locale}`);
  // E2·P5b：新增项。disableJavascript 是「页面脚本全停」的高后果开关：放在摘要最前面——面板标签会截断，别的项再多也不能把它挤出可见区
  if (s.disableJavascript === true) parts.unshift("禁用 JS");
  if (s.media === "print") parts.push("打印媒体");
  else if (s.media === "screen") parts.push("屏幕媒体");
  if (s.visionDeficiency && VISION_LABEL[s.visionDeficiency]) parts.push(VISION_LABEL[s.visionDeficiency]);
  if (s.forcedColors === "active") parts.push("强制颜色");
  else if (s.forcedColors === "none") parts.push("不强制颜色");
  if (s.prefersContrast) parts.push(`对比度偏好 ${s.prefersContrast}`);
  if (s.disableCache === true) parts.push("禁用缓存");
  if (s.touch === true && s.mobile !== true) parts.push("触屏");
  else if (s.touch === false && s.mobile === true) parts.push("禁用触屏");
  if (s.orientation) parts.push(`方向 α${fmtNum(s.orientation.alpha)}/β${fmtNum(s.orientation.beta)}/γ${fmtNum(s.orientation.gamma)}`);
  if (s.safeArea) parts.push(`安全区 ${SAFE_AREA_SIDES.map((k) => fmtNum(s.safeArea[k] ?? 0)).join("/")}`);
  return parts.length > 0 ? parts.join(" · ") : null;
};

/** 本次 patch 的人话清单（emulate op 的 `applied`）；reset 单独一句。 */
export const describePatch = (patch) => {
  const p = patch && typeof patch === "object" ? patch : {};
  const out = [];
  if (p.reset === true) out.push("已重置全部模拟");
  if (p.device) {
    const key = findDevicePreset(p.device);
    const d = key ? DEVICE_PRESETS[key] : null;
    out.push(d ? `设备 ${key}（${d.width}×${d.height}，${fmtNum(d.deviceScaleFactor)}x，${d.mobile ? "移动端" : "桌面"}）` : `设备 ${p.device}`);
  }
  if (p.width !== undefined || p.height !== undefined) out.push(`视口 ${p.width ?? "不变"}×${p.height ?? "不变"}`);
  if (p.deviceScaleFactor !== undefined) out.push(`像素比 ${fmtNum(p.deviceScaleFactor)}x`);
  if (p.mobile !== undefined) out.push(p.mobile ? "移动端模式（触摸）" : "桌面模式");
  if (p.userAgent !== undefined) out.push("自定义 User-Agent");
  if (p.colorScheme) out.push(p.colorScheme === "dark" ? "暗色模式" : "亮色模式");
  if (p.reducedMotion !== undefined) out.push(p.reducedMotion ? "减少动态效果" : "恢复动态效果");
  if (p.offline !== undefined) out.push(p.offline ? "离线" : "恢复联网");
  if (p.network !== undefined) out.push(p.network === "none" ? "网络不限速" : `网络 ${NETWORK_LABEL[p.network] ?? p.network}`);
  if (p.cpuThrottle !== undefined) out.push(`CPU 降速 ${fmtNum(p.cpuThrottle)}×`);
  if (p.geolocation) out.push(`定位 ${fmtNum(p.geolocation.latitude)},${fmtNum(p.geolocation.longitude)}`);
  if (p.timezone) out.push(`时区 ${p.timezone}`);
  if (p.locale) out.push(`语言 ${p.locale}`);
  // E2·P5b
  if (p.disableJavascript !== undefined) out.push(p.disableJavascript ? "禁用 JavaScript（页面脚本全停，用完请 reset）" : "恢复 JavaScript");
  if (p.disableCache !== undefined) out.push(p.disableCache ? "禁用缓存" : "恢复缓存");
  if (p.media !== undefined) out.push(p.media === null ? "媒体类型恢复默认" : `媒体类型 ${p.media === "print" ? "打印" : "屏幕"}`);
  if (p.visionDeficiency !== undefined) {
    out.push(p.visionDeficiency === null || p.visionDeficiency === "none" ? "取消视觉缺陷模拟" : `视觉缺陷 ${VISION_LABEL[p.visionDeficiency] ?? p.visionDeficiency}`);
  }
  if (p.forcedColors !== undefined) out.push(p.forcedColors === null ? "取消强制颜色模拟" : `强制颜色 ${p.forcedColors}`);
  if (p.prefersContrast !== undefined) out.push(p.prefersContrast === null ? "取消对比度偏好模拟" : `对比度偏好 ${p.prefersContrast}`);
  if (p.touch !== undefined) out.push(p.touch === null ? "触屏恢复默认" : p.touch ? "触屏模拟开" : "触屏模拟关");
  if (p.orientation) out.push(`设备方向 α${fmtNum(p.orientation.alpha)} β${fmtNum(p.orientation.beta)} γ${fmtNum(p.orientation.gamma)}`);
  if (p.safeArea) out.push(`安全区 上${fmtNum(p.safeArea.top ?? 0)} 右${fmtNum(p.safeArea.right ?? 0)} 下${fmtNum(p.safeArea.bottom ?? 0)} 左${fmtNum(p.safeArea.left ?? 0)}`);
  return out;
};

// ───────────────────────── 状态 → CDP 命令 ─────────────────────────

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** 各「方面」的 set / clear 命令；方面之间互相独立，这样 diff 才能只发变化的 */
const ASPECTS = [
  {
    // 视口 + 触摸：触屏 = 显式 `touch` 优先，否则跟随 mobile（E2·P5b：`touch` 并进同一方面，
    // 因为 setTouchEmulationEnabled 只有一个全局开关，拆成两个方面会在「只改 touch / 只改视口」的 diff 里互相覆盖）。
    // 只有 touch、没有视口项时 metrics:false：只发触摸命令，不动视口。
    id: "viewport",
    pick: (s) => {
      const metrics = s.width !== undefined || s.height !== undefined || s.deviceScaleFactor !== undefined || s.mobile !== undefined;
      if (!metrics && typeof s.touch !== "boolean") return undefined;
      return {
        metrics,
        width: s.width ?? 0,
        height: s.height ?? 0,
        deviceScaleFactor: s.deviceScaleFactor ?? 0,
        mobile: s.mobile === true,
        touch: typeof s.touch === "boolean" ? s.touch : s.mobile === true,
      };
    },
    set: (v, prevV) => [
      ...(v.metrics
        ? [
            {
              method: "Emulation.setDeviceMetricsOverride",
              params: { width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor, mobile: v.mobile },
            },
          ]
        : prevV?.metrics
          ? [{ method: "Emulation.clearDeviceMetricsOverride", params: {} }]
          : []),
      { method: "Emulation.setTouchEmulationEnabled", params: { enabled: v.touch, maxTouchPoints: v.touch ? 5 : 1 } },
    ],
    clear: () => [
      { method: "Emulation.clearDeviceMetricsOverride", params: {} },
      { method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } },
    ],
  },
  {
    id: "userAgent",
    pick: (s) => s.userAgent,
    set: (v) => [{ method: "Emulation.setUserAgentOverride", params: { userAgent: v } }],
    clear: () => [{ method: "Emulation.setUserAgentOverride", params: { userAgent: "" } }],
  },
  {
    id: "media",
    pick: (s) => {
      if (
        s.colorScheme === undefined &&
        s.reducedMotion === undefined &&
        s.forcedColors === undefined &&
        s.prefersContrast === undefined &&
        s.media === undefined
      ) {
        return undefined;
      }
      return {
        colorScheme: s.colorScheme ?? "",
        reducedMotion: s.reducedMotion === undefined ? "" : s.reducedMotion ? "reduce" : "no-preference",
        forcedColors: s.forcedColors ?? "",
        prefersContrast: s.prefersContrast ?? "",
        media: s.media ?? "",
      };
    },
    // 空串 = 取消该项覆盖；所有项总是一起发，免得 setEmulatedMedia 的整体替换语义把另一项冲掉。
    // E2·P5b：forced-colors / prefers-contrast / media 只在用到时才进命令（没用到 = 不出现 = 被整体替换语义清掉），
    // 这样老的「只有颜色方案 / 减少动态」命令形状不变
    set: (v) => [
      {
        method: "Emulation.setEmulatedMedia",
        params: {
          ...(v.media ? { media: v.media } : {}),
          features: [
            { name: "prefers-color-scheme", value: v.colorScheme },
            { name: "prefers-reduced-motion", value: v.reducedMotion },
            ...(v.forcedColors ? [{ name: "forced-colors", value: v.forcedColors }] : []),
            ...(v.prefersContrast ? [{ name: "prefers-contrast", value: v.prefersContrast }] : []),
          ],
        },
      },
    ],
    clear: () => [
      {
        method: "Emulation.setEmulatedMedia",
        params: { media: "", features: [{ name: "prefers-color-scheme", value: "" }, { name: "prefers-reduced-motion", value: "" }, { name: "forced-colors", value: "" }, { name: "prefers-contrast", value: "" }] },
      },
    ],
  },
  {
    // offline 优先于 network 档位（离线时限速没有意义）
    id: "network",
    pick: (s) => (s.offline === true ? { offline: true } : s.network && NETWORK_PROFILES[s.network] ? { network: s.network } : undefined),
    set: (v) => [
      {
        method: "Network.emulateNetworkConditions",
        params: v.offline
          ? { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
          : { offline: false, ...NETWORK_PROFILES[v.network] },
      },
    ],
    clear: () => [
      { method: "Network.emulateNetworkConditions", params: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } },
    ],
  },
  {
    id: "cpu",
    pick: (s) => (typeof s.cpuThrottle === "number" && s.cpuThrottle >= 1 ? s.cpuThrottle : undefined),
    set: (v) => [{ method: "Emulation.setCPUThrottlingRate", params: { rate: v } }],
    clear: () => [{ method: "Emulation.setCPUThrottlingRate", params: { rate: 1 } }],
  },
  {
    id: "geolocation",
    pick: (s) => s.geolocation,
    set: (v) => [
      {
        method: "Emulation.setGeolocationOverride",
        params: { latitude: v.latitude, longitude: v.longitude, accuracy: typeof v.accuracy === "number" ? v.accuracy : 100 },
      },
    ],
    clear: () => [{ method: "Emulation.setGeolocationOverride", params: {} }],
  },
  {
    // 时区 / 语言：CDP 对「已有覆盖时再 set」会报 already in effect，所以值变化时先 clear 再 set
    id: "timezone",
    pick: (s) => s.timezone,
    set: (v, prevV) => [
      ...(prevV !== undefined ? [{ method: "Emulation.setTimezoneOverride", params: { timezoneId: "" } }] : []),
      { method: "Emulation.setTimezoneOverride", params: { timezoneId: v } },
    ],
    clear: () => [{ method: "Emulation.setTimezoneOverride", params: { timezoneId: "" } }],
  },
  {
    id: "locale",
    pick: (s) => s.locale,
    set: (v, prevV) => [
      ...(prevV !== undefined ? [{ method: "Emulation.setLocaleOverride", params: { locale: "" } }] : []),
      { method: "Emulation.setLocaleOverride", params: { locale: v } },
    ],
    clear: () => [{ method: "Emulation.setLocaleOverride", params: { locale: "" } }],
  },
  // ── E2·P5b（C1）──
  {
    id: "visionDeficiency",
    pick: (s) => (s.visionDeficiency && s.visionDeficiency !== "none" ? s.visionDeficiency : undefined),
    set: (v) => [{ method: "Emulation.setEmulatedVisionDeficiency", params: { type: v } }],
    clear: () => [{ method: "Emulation.setEmulatedVisionDeficiency", params: { type: "none" } }],
  },
  {
    id: "disableCache",
    pick: (s) => (s.disableCache === true ? true : undefined),
    set: () => [{ method: "Network.setCacheDisabled", params: { cacheDisabled: true } }],
    clear: () => [{ method: "Network.setCacheDisabled", params: { cacheDisabled: false } }],
  },
  {
    // 页面脚本全停：reset / 用户重置走同一条 clear，必须保证它能发出去（见 tab.resetEmulation）
    id: "disableJavascript",
    pick: (s) => (s.disableJavascript === true ? true : undefined),
    set: () => [{ method: "Emulation.setScriptExecutionDisabled", params: { value: true } }],
    clear: () => [{ method: "Emulation.setScriptExecutionDisabled", params: { value: false } }],
  },
  {
    id: "orientation",
    pick: (s) => (s.orientation && typeof s.orientation === "object" ? { alpha: s.orientation.alpha ?? 0, beta: s.orientation.beta ?? 0, gamma: s.orientation.gamma ?? 0 } : undefined),
    set: (v) => [{ method: "DeviceOrientation.setDeviceOrientationOverride", params: { alpha: v.alpha, beta: v.beta, gamma: v.gamma } }],
    clear: () => [{ method: "DeviceOrientation.clearDeviceOrientationOverride", params: {} }],
  },
  {
    // CDP：未给的边会让对应 env() 变量变成未定义，所以四边都显式给；clear 用空 insets
    id: "safeArea",
    pick: (s) =>
      s.safeArea && typeof s.safeArea === "object"
        ? { top: s.safeArea.top ?? 0, right: s.safeArea.right ?? 0, bottom: s.safeArea.bottom ?? 0, left: s.safeArea.left ?? 0 }
        : undefined,
    set: (v) => [{ method: "Emulation.setSafeAreaInsetsOverride", params: { insets: { top: v.top, right: v.right, bottom: v.bottom, left: v.left } } }],
    clear: () => [{ method: "Emulation.setSafeAreaInsetsOverride", params: { insets: {} } }],
  },
];

/**
 * 状态 → CDP 命令序列 `[{ method, params }]`。
 *  - 不给 prev：只发「状态里有的」set 命令（重放 / 新会话初始化用）；
 *  - 给 prev：只发变化的方面——新状态有就 set，新状态没有而 prev 有就发对应的 clear（reset / 取消某项）。
 * 全部作用于主会话（OOPIF 子会话不处理，见 tab.mjs）。
 */
export const toCdpCommands = (state, prev) => {
  const s = state && typeof state === "object" ? state : {};
  const hasPrev = prev !== undefined && prev !== null && typeof prev === "object";
  const out = [];
  for (const a of ASPECTS) {
    const v = a.pick(s);
    const pv = hasPrev ? a.pick(prev) : undefined;
    if (hasPrev && sameJson(v, pv)) continue;
    if (v !== undefined) out.push(...a.set(v, pv));
    else if (hasPrev && pv !== undefined) out.push(...a.clear());
  }
  return out;
};

/** reset：清掉 prev 里有的所有方面（= toCdpCommands({}, prev)） */
export const resetCommands = (prev) => toCdpCommands({}, prev ?? {});

// ───────────────────────── 视图适配（模拟视口 vs 占位 div） ─────────────────────────
//
// 设备模拟把页面视口固定成 `width × height`（DIP）。原生视图（占位 div 那么大）和它不一样大时：
//   - 视图比它大：多出来的是**白板**（A：视图收窄、水平居中、顶部对齐，DevTools 设备模式的摆法）；
//   - 视图比它小：页面被**裁切**（B：整体缩小适应——CDP `scale`，等价 DevTools 的「Fit to window」）。
//
// B 的实现与实测约束（真 Electron 探针，见 scripts/browser-e2e/r10-emulation-fit.cjs 与契约 §14.4）：
//   1. `scale` 必须和 `dontSetVisibleSize:true` 一起给——不给时 Chromium 会再按「视图/模拟尺寸」缩一次（0.6 变 0.36），
//      且结果取决于设置顺序；给了之后任何顺序下页面都恰好铺满「模拟尺寸 × scale」的视图；
//   2. 页面看到的一切不变：innerWidth / innerHeight、媒体查询、DOM 几何（getContentQuads / getBoxModel / 布局指标）、
//      CDP 截图（含 clip）、滚轮距离都仍是模拟尺寸下的 CSS 像素；
//   3. 用户真实点击：Chromium 自己按 scale 反向映射，不用处理；
//   4. **CDP 输入坐标是视图坐标、不是 CSS 坐标**：AI 的 `Input.dispatchMouseEvent` / `dispatchTouchEvent` / `dispatchDragEvent`
//      的 x / y 必须乘以 scale（滚轮 delta 不用）——见 {@link scaleInputParams}，由 `Tab.send` 统一补偿。

const positiveInt = (n) => (typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0);

/** 缩放适配的下限：模拟视口比槽位大 10 倍以上时不再缩（缩到看不清没意义），退回 A 的裁切 */
export const MIN_FIT_SCALE = 0.1;

/** scale 的精度：向下取整到 3 位小数，保证 `floor(模拟尺寸 × scale)` 一定放得进槽位，也让「拖面板每帧都改一点点」的 CDP 命令数可控 */
const SCALE_PRECISION = 1000;

/**
 * 能做缩放适配的视口尺寸：宽和高都明确才行。只给宽或高（另一维自适应）时没有「整页该缩成多大」的答案——
 * 另一维取多少取决于槽位，而它又随缩放变，所以这种模拟只走 A（收窄 + 居中），不缩放。
 * @returns {{ width: number, height: number } | null}
 */
export const fitViewportOf = (emulation) => {
  const s = emulation && typeof emulation === "object" ? emulation : {};
  const width = positiveInt(s.width);
  const height = positiveInt(s.height);
  return width && height ? { width, height } : null;
};

/**
 * 槽位里该用的缩放比例：`min(1, 槽位宽 / 模拟宽, 槽位高 / 模拟高)`，向下取 3 位小数；不放大。
 * 返回 1 = 不缩放（没有可适配的视口 / 槽位已够大 / 缩放比例低于 {@link MIN_FIT_SCALE}）。
 */
export const fitScaleFor = (slot, emulation) => {
  const vp = fitViewportOf(emulation);
  if (!vp || !slot || !(slot.width > 0) || !(slot.height > 0)) return 1;
  const raw = Math.min(1, slot.width / vp.width, slot.height / vp.height);
  if (raw >= 1) return 1;
  const s = Math.floor(raw * SCALE_PRECISION) / SCALE_PRECISION;
  return s >= MIN_FIT_SCALE ? s : 1;
};

/**
 * 把槽位按设备模拟（和当前缩放比例）收成原生视图该用的矩形：**水平居中、顶部对齐**，不放大。
 *
 * @param {{ x: number, y: number, width: number, height: number }} slot 占位 div 的矩形（已取整、已按宿主缩放换算成 DIP）
 * @param {object | null | undefined} emulation tab.emulation 状态（只读 width / height；0 / 缺省 = 自适应）
 * @param {number} [scale] 页面当前**已生效**的缩放比例（< 1 才有意义；缺省 / ≥ 1 = 不缩放）。视图尺寸 = floor(模拟尺寸 × scale)
 * @returns {{ bounds: { x: number, y: number, width: number, height: number },
 *             fit: { left: number, top: number, width: number, height: number } | null }}
 *   bounds = 原生视图实际该用的矩形；fit = 它占槽位的比例（0..1，与宿主缩放无关），没收窄时为 null——
 *   遮盖占位图要按它摆在同一个位置，否则会被拉伸成整个槽位
 */
export const fitBoundsToEmulation = (slot, emulation, scale = 1) => {
  const none = { bounds: slot, fit: null };
  if (!slot || !(slot.width > 0) || !(slot.height > 0)) return none;
  const s = emulation && typeof emulation === "object" ? emulation : {};
  const k = typeof scale === "number" && Number.isFinite(scale) && scale > 0 && scale < 1 ? scale : 1;
  const ew = positiveInt(s.width);
  const eh = positiveInt(s.height);
  if (!ew && !eh) return none;
  const shrink = (n) => (k < 1 ? Math.max(1, Math.floor(n * k)) : n);
  const width = ew ? Math.min(slot.width, shrink(ew)) : slot.width;
  const height = eh ? Math.min(slot.height, shrink(eh)) : slot.height;
  if (width === slot.width && height === slot.height) return none;
  const dx = Math.floor((slot.width - width) / 2);
  return {
    bounds: { x: slot.x + dx, y: slot.y, width, height },
    fit: { left: dx / slot.width, top: 0, width: width / slot.width, height: height / slot.height },
  };
};

/**
 * 两个 `viewFit`（{@link fitBoundsToEmulation} 的 `fit`）是否相同：null / undefined 等价（都是「视图没被模拟收窄」），否则逐字段严格相等。
 * 与渲染端 store 的 `sameViewFit`（`src/components/browser/browser-state-store.ts`）同一口径——主进程只在它「渲染端会判为变了」时才推状态，
 * 两边口径不同就会出现「主进程以为没变没推、渲染端其实旧了」或反过来白推。
 * @param {{ left: number, top: number, width: number, height: number } | null | undefined} a
 * @param {{ left: number, top: number, width: number, height: number } | null | undefined} b
 */
export const sameViewFit = (a, b) => {
  if (!a || !b) return !a && !b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
};

/**
 * 当前模拟状态的「视口覆盖」命令（带缩放比例）；没有视口项（只有 touch / 外观类）= null。
 * 与 `toCdpCommands` 里 viewport 方面发的 `Emulation.setDeviceMetricsOverride` 参数一致，只是多了 scale——
 * 缩放比例变了而状态没变（拖面板）时用它单独重发一条。
 */
export const viewportMetricsCommand = (state, scale = 1) => {
  const s = state && typeof state === "object" ? state : {};
  const metrics = s.width !== undefined || s.height !== undefined || s.deviceScaleFactor !== undefined || s.mobile !== undefined;
  if (!metrics) return null;
  return withFitScale(
    [
      {
        method: "Emulation.setDeviceMetricsOverride",
        params: { width: s.width ?? 0, height: s.height ?? 0, deviceScaleFactor: s.deviceScaleFactor ?? 0, mobile: s.mobile === true },
      },
    ],
    scale,
  )[0];
};

/**
 * 给命令序列里的 `Emulation.setDeviceMetricsOverride` 加上缩放参数（scale < 1 时才加；同时必须带 dontSetVisibleSize，原因见本节开头）。
 * 不改入参。
 */
export const withFitScale = (commands, scale) => {
  if (!(typeof scale === "number" && scale > 0 && scale < 1)) return commands;
  return commands.map((c) =>
    c.method === "Emulation.setDeviceMetricsOverride" ? { ...c, params: { ...c.params, scale, dontSetVisibleSize: true } } : c,
  );
};

/** 带「视口坐标」的 CDP 输入方法：缩放生效时 x / y 要乘 scale（滚轮的 deltaX / deltaY 不用） */
export const INPUT_COORD_METHODS = Object.freeze(["Input.dispatchMouseEvent", "Input.dispatchTouchEvent", "Input.dispatchDragEvent"]);

/** 仓库里用到、但不带坐标的 CDP 输入方法（不需要补偿）。新增任何 `Input.*` 都必须归到这两个清单之一，由测试钉死 */
export const INPUT_PLAIN_METHODS = Object.freeze(["Input.dispatchKeyEvent", "Input.insertText", "Input.setIgnoreInputEvents", "Input.setInterceptDrags"]);

/**
 * AI 的输入坐标是页面 CSS 像素，而 CDP 输入要的是**视图**坐标：缩放适配生效（scale < 1）时要乘以 scale，
 * 页面才会在 CSS 坐标 (x, y) 收到事件。scale ≥ 1 / 非输入方法原样返回同一个对象。不改入参。
 */
export const scaleInputParams = (method, params, scale) => {
  if (!(typeof scale === "number" && scale > 0 && scale < 1)) return params;
  if (!params || typeof params !== "object") return params;
  const k = (n) => (typeof n === "number" && Number.isFinite(n) ? n * scale : n);
  if (method === "Input.dispatchMouseEvent" || method === "Input.dispatchDragEvent") {
    return { ...params, x: k(params.x), y: k(params.y) };
  }
  if (method === "Input.dispatchTouchEvent") {
    if (!Array.isArray(params.touchPoints)) return params;
    return { ...params, touchPoints: params.touchPoints.map((p) => (p && typeof p === "object" ? { ...p, x: k(p.x), y: k(p.y) } : p)) };
  }
  return params;
};
