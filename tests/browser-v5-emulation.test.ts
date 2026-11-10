/**
 * V5 设备模拟：emulation.mjs 纯函数（预设 / 叠加 / 摘要 / CDP 命令序列）+ ops/page-env.mjs 的参数校验。
 */
import { describe, expect, it } from "vitest";

import {
  DEVICE_NAMES,
  DEVICE_PRESETS,
  NETWORK_PROFILES,
  describeEmulation,
  describePatch,
  findDevicePreset,
  mergeEmulation,
  resetCommands,
  toCdpCommands,
  validateUserAgent,
} from "../electron-app/browser/emulation.mjs";
import { ALL_OPS, OP_HELPERS, normalizeOpArgs } from "../electron-app/browser/index.mjs";
import { createHandlers } from "../electron-app/browser/ops/page-env.mjs";

const methods = (cmds: Array<{ method: string }>) => cmds.map((c) => c.method);
const find = (cmds: Array<{ method: string; params: Record<string, unknown> }>, method: string) =>
  cmds.filter((c) => c.method === method);

describe("预设表", () => {
  it("七个预设齐全、字段完整；手机 / 平板带 UA，桌面不带", () => {
    expect(DEVICE_NAMES).toEqual(["iPhone 15", "iPhone SE", "Pixel 8", "iPad", "Galaxy S23", "Desktop 1440", "Desktop 1920"]);
    for (const name of DEVICE_NAMES) {
      const p = DEVICE_PRESETS[name as keyof typeof DEVICE_PRESETS] as Record<string, unknown>;
      expect(typeof p.width).toBe("number");
      expect(typeof p.height).toBe("number");
      expect(typeof p.deviceScaleFactor).toBe("number");
      expect(typeof p.mobile).toBe("boolean");
      if (p.mobile) expect(String(p.userAgent)).toMatch(/Mozilla\/5\.0/);
      else expect(p.userAgent).toBeUndefined();
    }
    expect(DEVICE_PRESETS["iPhone 15"].mobile).toBe(true);
    expect(DEVICE_PRESETS["Desktop 1440"].width).toBe(1440);
  });

  it("findDevicePreset 忽略大小写 / 空格 / 连字符；未知返回 null", () => {
    expect(findDevicePreset("iphone15")).toBe("iPhone 15");
    expect(findDevicePreset("IPHONE-SE")).toBe("iPhone SE");
    expect(findDevicePreset("pixel_8")).toBe("Pixel 8");
    expect(findDevicePreset("desktop 1920")).toBe("Desktop 1920");
    expect(findDevicePreset("Nokia 3310")).toBeNull();
    expect(findDevicePreset("")).toBeNull();
    expect(findDevicePreset(undefined as never)).toBeNull();
  });

  it("网络档位：slow3g ≈400kbps / 400ms，fast3g ≈1.6Mbps、4g ≈9Mbps（单位 bytes/s）", () => {
    expect(NETWORK_PROFILES.slow3g).toEqual({ latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 });
    expect(NETWORK_PROFILES.fast3g.downloadThroughput).toBe(200_000);
    expect(NETWORK_PROFILES["4g"].downloadThroughput).toBe(1_125_000);
    expect(NETWORK_PROFILES.slow3g.downloadThroughput).toBeLessThan(NETWORK_PROFILES.fast3g.downloadThroughput);
    expect(NETWORK_PROFILES.fast3g.downloadThroughput).toBeLessThan(NETWORK_PROFILES["4g"].downloadThroughput);
  });
});

describe("mergeEmulation：增量叠加", () => {
  it("device 铺预设；再叠加别的项不丢设备", () => {
    const a = mergeEmulation({}, { device: "iPhone 15" });
    expect(a).toMatchObject({ device: "iPhone 15", width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
    const b = mergeEmulation(a, { colorScheme: "dark" });
    expect(b).toMatchObject({ device: "iPhone 15", colorScheme: "dark", width: 393 });
    expect(a).not.toHaveProperty("colorScheme"); // 不改入参
  });

  it("显式的 width / height 覆盖预设", () => {
    const s = mergeEmulation({}, { device: "iPhone 15", width: 500 });
    expect(s.width).toBe(500);
    expect(s.height).toBe(852);
    expect(s.device).toBe("iPhone 15");
  });

  it("换设备：视口相关项整体换掉，上一个设备的 UA 不残留（桌面预设没有 UA）", () => {
    const phone = mergeEmulation({}, { device: "iPhone 15" });
    const desk = mergeEmulation(phone, { device: "Desktop 1440" });
    expect(desk).toMatchObject({ device: "Desktop 1440", width: 1440, mobile: false });
    expect(desk.userAgent).toBeUndefined();
  });

  it("没有 device 时单独给 width：保留其余项", () => {
    const s = mergeEmulation({ width: 300, height: 600, colorScheme: "dark" }, { width: 320 });
    expect(s).toEqual({ width: 320, height: 600, colorScheme: "dark" });
  });

  it("reset 清空全部；reset + 其它项 = 先清再叠加", () => {
    const base = mergeEmulation({}, { device: "Pixel 8", offline: true, network: "4g", colorScheme: "dark" });
    expect(mergeEmulation(base, { reset: true })).toEqual({});
    const again = mergeEmulation(base, { reset: true, colorScheme: "light" });
    expect(again).toEqual({ colorScheme: "light" });
  });

  it("offline:false / network:'none' / null 都表示取消该项", () => {
    const base = mergeEmulation({}, { offline: true, network: "slow3g", cpuThrottle: 4, geolocation: { latitude: 1, longitude: 2 } });
    expect(mergeEmulation(base, { offline: false })).not.toHaveProperty("offline");
    expect(mergeEmulation(base, { network: "none" })).not.toHaveProperty("network");
    expect(mergeEmulation(base, { cpuThrottle: null })).not.toHaveProperty("cpuThrottle");
    expect(mergeEmulation(base, { geolocation: null })).not.toHaveProperty("geolocation");
  });

  it("prev / patch 非对象时容错", () => {
    expect(mergeEmulation(null, undefined)).toEqual({});
    expect(mergeEmulation(undefined, { timezone: "Asia/Tokyo" })).toEqual({ timezone: "Asia/Tokyo" });
  });
});

describe("describeEmulation：人话摘要", () => {
  it("无模拟返回 null", () => {
    expect(describeEmulation({})).toBeNull();
    expect(describeEmulation(null)).toBeNull();
    expect(describeEmulation(mergeEmulation({}, { offline: false, network: "none" }))).toBeNull();
  });

  it("设备 · 暗色 · 弱网 3G", () => {
    const s = mergeEmulation({}, { device: "iPhone 15", colorScheme: "dark", network: "slow3g" });
    expect(describeEmulation(s)).toBe("iPhone 15 · 暗色 · 弱网 3G");
  });

  it("离线优先于网络档位；CPU / 定位 / 时区 / 语言", () => {
    const s = mergeEmulation({}, {
      offline: true,
      network: "4g",
      cpuThrottle: 4,
      geolocation: { latitude: 31.23, longitude: 121.47 },
      timezone: "Asia/Tokyo",
      locale: "ja-JP",
      reducedMotion: true,
    });
    const text = describeEmulation(s)!;
    expect(text).toContain("离线");
    expect(text).not.toContain("4G");
    expect(text).toContain("CPU 4× 降速");
    expect(text).toContain("定位 31.23,121.47");
    expect(text).toContain("时区 Asia/Tokyo");
    expect(text).toContain("语言 ja-JP");
    expect(text).toContain("减少动态效果");
  });

  it("预设被改尺寸时带上实际尺寸；纯尺寸 / 移动端", () => {
    expect(describeEmulation(mergeEmulation({}, { device: "iPad", width: 700 }))).toBe("iPad（700×1180）");
    expect(describeEmulation({ width: 390, height: 844 })).toBe("390×844");
    expect(describeEmulation({ width: 390, height: 844, mobile: true })).toBe("390×844 移动端");
    expect(describeEmulation({ mobile: true })).toBe("移动端");
  });

  it("自定义 UA 标出来；预设自带的 UA 不重复标", () => {
    expect(describeEmulation({ userAgent: "X/1" })).toBe("自定义 UA");
    expect(describeEmulation(mergeEmulation({}, { device: "Pixel 8" }))).toBe("Pixel 8");
  });

  it("describePatch：本次动作的人话清单", () => {
    const list = describePatch({ device: "iPhone 15", colorScheme: "dark", offline: true, cpuThrottle: 4 });
    expect(list[0]).toContain("设备 iPhone 15（393×852，3x，移动端）");
    expect(list).toContain("暗色模式");
    expect(list).toContain("离线");
    expect(list).toContain("CPU 降速 4×");
    expect(describePatch({ reset: true })).toEqual(["已重置全部模拟"]);
    expect(describePatch({ network: "none" })).toEqual(["网络不限速"]);
  });
});

describe("toCdpCommands：状态 → CDP 命令序列", () => {
  it("空状态没有命令", () => {
    expect(toCdpCommands({})).toEqual([]);
    expect(resetCommands({})).toEqual([]);
  });

  it("iPhone 15：设备指标 + 触摸 + UA", () => {
    const cmds = toCdpCommands(mergeEmulation({}, { device: "iPhone 15" }));
    expect(methods(cmds)).toEqual(["Emulation.setDeviceMetricsOverride", "Emulation.setTouchEmulationEnabled", "Emulation.setUserAgentOverride"]);
    expect(cmds[0].params).toEqual({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
    expect(cmds[1].params).toMatchObject({ enabled: true, maxTouchPoints: 5 });
    expect(String(cmds[2].params.userAgent)).toContain("iPhone");
  });

  it("桌面预设：mobile:false，触摸关，不发 UA", () => {
    const cmds = toCdpCommands(mergeEmulation({}, { device: "Desktop 1440" }));
    expect(find(cmds, "Emulation.setDeviceMetricsOverride")[0].params).toMatchObject({ width: 1440, mobile: false });
    expect(find(cmds, "Emulation.setTouchEmulationEnabled")[0].params).toMatchObject({ enabled: false });
    expect(find(cmds, "Emulation.setUserAgentOverride")).toHaveLength(0);
  });

  it("只给宽度：高度 / 像素比用 0（= 不覆盖）", () => {
    const cmds = toCdpCommands({ width: 500 });
    expect(cmds[0].params).toEqual({ width: 500, height: 0, deviceScaleFactor: 0, mobile: false });
  });

  it("媒体特征：prefers-color-scheme / prefers-reduced-motion 总是一起发，未设的用空串", () => {
    const dark = toCdpCommands({ colorScheme: "dark" });
    expect(dark).toEqual([
      {
        method: "Emulation.setEmulatedMedia",
        params: { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "" }] },
      },
    ]);
    const both = toCdpCommands({ colorScheme: "light", reducedMotion: true });
    expect((both[0].params.features as Array<{ value: string }>).map((f) => f.value)).toEqual(["light", "reduce"]);
    const noPref = toCdpCommands({ reducedMotion: false });
    expect((noPref[0].params.features as Array<{ value: string }>)[1].value).toBe("no-preference");
  });

  it("网络：none 不发；档位发对应吞吐；offline 优先且 -1 表示不限", () => {
    expect(toCdpCommands({ network: "none" as never })).toEqual([]);
    const slow = toCdpCommands({ network: "slow3g" });
    expect(slow[0]).toEqual({ method: "Network.emulateNetworkConditions", params: { offline: false, ...NETWORK_PROFILES.slow3g } });
    const off = toCdpCommands({ offline: true, network: "4g" });
    expect(off).toHaveLength(1);
    expect(off[0].params).toEqual({ offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  });

  it("CPU / 定位 / 时区 / 语言", () => {
    const cmds = toCdpCommands({ cpuThrottle: 6, geolocation: { latitude: 1.5, longitude: 2.5 }, timezone: "Asia/Tokyo", locale: "ja-JP" });
    expect(find(cmds, "Emulation.setCPUThrottlingRate")[0].params).toEqual({ rate: 6 });
    expect(find(cmds, "Emulation.setGeolocationOverride")[0].params).toEqual({ latitude: 1.5, longitude: 2.5, accuracy: 100 });
    expect(find(cmds, "Emulation.setTimezoneOverride")[0].params).toEqual({ timezoneId: "Asia/Tokyo" });
    expect(find(cmds, "Emulation.setLocaleOverride")[0].params).toEqual({ locale: "ja-JP" });
  });

  it("给 prev：只发变化的方面；没变的不重发", () => {
    const prev = mergeEmulation({}, { device: "iPhone 15" });
    const next = mergeEmulation(prev, { colorScheme: "dark" });
    expect(methods(toCdpCommands(next, prev))).toEqual(["Emulation.setEmulatedMedia"]);
    expect(toCdpCommands(next, next)).toEqual([]);
  });

  it("reset：对 prev 里有的每个方面发 clear", () => {
    const prev = mergeEmulation({}, {
      device: "iPhone 15",
      colorScheme: "dark",
      offline: true,
      cpuThrottle: 4,
      geolocation: { latitude: 1, longitude: 2 },
      timezone: "Asia/Tokyo",
      locale: "ja-JP",
    });
    const clears = resetCommands(prev);
    expect(methods(clears)).toEqual(
      expect.arrayContaining([
        "Emulation.clearDeviceMetricsOverride",
        "Emulation.setTouchEmulationEnabled",
        "Emulation.setUserAgentOverride",
        "Emulation.setEmulatedMedia",
        "Network.emulateNetworkConditions",
        "Emulation.setCPUThrottlingRate",
        "Emulation.setGeolocationOverride",
        "Emulation.setTimezoneOverride",
        "Emulation.setLocaleOverride",
      ]),
    );
    expect(find(clears, "Emulation.setUserAgentOverride")[0].params).toEqual({ userAgent: "" });
    expect(find(clears, "Emulation.setCPUThrottlingRate")[0].params).toEqual({ rate: 1 });
    expect(find(clears, "Network.emulateNetworkConditions")[0].params).toMatchObject({ offline: false, downloadThroughput: -1 });
    expect(find(clears, "Emulation.setGeolocationOverride")[0].params).toEqual({});
    // prev 没有的方面不会多发 clear
    expect(methods(resetCommands({ colorScheme: "dark" }))).toEqual(["Emulation.setEmulatedMedia"]);
  });

  it("时区 / 语言值变化：先 clear 再 set（CDP 对已有覆盖会报 already in effect）；首次只 set", () => {
    const first = toCdpCommands({ timezone: "Asia/Tokyo" }, {});
    expect(find(first, "Emulation.setTimezoneOverride").map((c) => c.params)).toEqual([{ timezoneId: "Asia/Tokyo" }]);
    const changed = toCdpCommands({ timezone: "Europe/Paris" }, { timezone: "Asia/Tokyo" });
    expect(find(changed, "Emulation.setTimezoneOverride").map((c) => c.params)).toEqual([{ timezoneId: "" }, { timezoneId: "Europe/Paris" }]);
    const loc = toCdpCommands({ locale: "fr-FR" }, { locale: "ja-JP" });
    expect(find(loc, "Emulation.setLocaleOverride").map((c) => c.params)).toEqual([{ locale: "" }, { locale: "fr-FR" }]);
  });

  it("取消某一项（prev 有、新状态没有）发对应 clear", () => {
    const prev = { colorScheme: "dark" as const, cpuThrottle: 4 };
    const next = { colorScheme: "dark" as const };
    expect(toCdpCommands(next, prev)).toEqual([{ method: "Emulation.setCPUThrottlingRate", params: { rate: 1 } }]);
  });
});

describe("ops/page-env：参数校验（经 normalizeOpArgs）", () => {
  it("dialog / emulate 已登记为 op", () => {
    expect(ALL_OPS).toEqual(expect.arrayContaining(["dialog", "emulate"]));
    expect(OP_HELPERS.withTab({ tabId: "t2" }, { a: 1 })).toEqual({ a: 1, tabId: "t2" });
  });

  it("dialog：action 缺省 status；promptText 透传；非法 action BAD_ARGS", () => {
    expect(normalizeOpArgs("dialog", {})).toEqual({ action: "status" });
    expect(normalizeOpArgs("dialog", { action: "accept", promptText: "hi", tabId: "t3" })).toEqual({ action: "accept", promptText: "hi", tabId: "t3" });
    expect(normalizeOpArgs("dialog", { action: "accept", promptText: "" })).toEqual({ action: "accept", promptText: "" });
    expect(() => normalizeOpArgs("dialog", { action: "explode" })).toThrowError(/action/);
    expect(() => normalizeOpArgs("dialog", { action: "accept", promptText: 5 })).toThrowError(/promptText/);
  });

  it("emulate：规整并只保留给了的项", () => {
    const a = normalizeOpArgs("emulate", { device: "iphone15", colorScheme: "dark", width: 500.4, deviceScaleFactor: 2.5, offline: true, network: "slow3g", cpuThrottle: 4 });
    expect(a).toEqual({ device: "iPhone 15", colorScheme: "dark", width: 500, deviceScaleFactor: 2.5, offline: true, network: "slow3g", cpuThrottle: 4 });
    expect(normalizeOpArgs("emulate", { reset: true })).toEqual({ reset: true });
    expect(normalizeOpArgs("emulate", { geolocation: { latitude: 31, longitude: 121 }, timezone: "Asia/Shanghai", locale: "zh-CN" })).toEqual({
      geolocation: { latitude: 31, longitude: 121 },
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
    });
  });

  it("emulate：未知预设 BAD_ARGS 并列出全部可选项", () => {
    try {
      normalizeOpArgs("emulate", { device: "Nokia 3310" });
      throw new Error("应当抛错");
    } catch (e) {
      const err = e as { code?: string; message: string };
      expect(err.code).toBe("BAD_ARGS");
      for (const name of DEVICE_NAMES) expect(err.message).toContain(name);
    }
  });

  it("emulate：userAgent 含控制字符在参数校验阶段就拒绝（R1-24，CRLF = 请求头注入），正常 UA 放行", () => {
    for (const ua of ["a\r\nX-Evil: 1", "a\nb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "a\u2028b"]) {
      try {
        normalizeOpArgs("emulate", { userAgent: ua });
        throw new Error(`应当拒绝：${JSON.stringify(ua)}`);
      } catch (e) {
        const err = e as { code?: string; message: string };
        expect(err.code).toBe("BAD_ARGS");
        expect(err.message).toMatch(/U\+[0-9A-F]{4}/);
      }
    }
    const ok = "Mozilla/5.0 (Linux; 中文; ☃) AppleWebKit/537.36 \u00a0";
    expect(normalizeOpArgs("emulate", { userAgent: ok })).toEqual({ userAgent: ok });
  });

  it("emulate：范围 / 类型 / 空参数校验", () => {
    expect(() => normalizeOpArgs("emulate", {})).toThrowError(/至少/);
    expect(() => normalizeOpArgs("emulate", { reset: false })).toThrowError(/至少/);
    expect(() => normalizeOpArgs("emulate", { width: 100 })).toThrowError(/200/);
    expect(() => normalizeOpArgs("emulate", { height: 5000 })).toThrowError(/4000/);
    expect(() => normalizeOpArgs("emulate", { deviceScaleFactor: 0.5 })).toThrowError(/1–4/);
    expect(() => normalizeOpArgs("emulate", { cpuThrottle: 50 })).toThrowError(/1–20/);
    expect(() => normalizeOpArgs("emulate", { colorScheme: "sepia" })).toThrowError(/light \/ dark/);
    expect(() => normalizeOpArgs("emulate", { network: "5g" })).toThrowError(/none \/ slow3g/);
    expect(() => normalizeOpArgs("emulate", { geolocation: { latitude: 100, longitude: 0 } })).toThrowError(/latitude/);
    expect(() => normalizeOpArgs("emulate", { geolocation: { latitude: 1 } })).toThrowError(/longitude/);
    expect(() => normalizeOpArgs("emulate", { timezone: "Mars/Olympus" })).toThrowError(/时区/);
    expect(() => normalizeOpArgs("emulate", { locale: "not a locale!!" })).toThrowError(/语言/);
    expect(() => normalizeOpArgs("emulate", { userAgent: "x".repeat(501) })).toThrowError(/过长/);
    expect(() => normalizeOpArgs("emulate", { offline: "yes" })).toThrowError(/布尔/);
  });
});

// ───────────────────────── R1-24：userAgent 里的控制字符 ─────────────────────────
// 评审：UA 含 CR / LF 会被 CDP 拒；而 tab.applyEmulation 先改状态再发命令，失败后 AI 原样重试 diff 为空会静默「成功」。
// 回滚在 tab.mjs（主 agent）；这里钉「根本不让这种 UA 进入状态」的入口校验。
describe("validateUserAgent / mergeEmulation：拒绝控制字符（R1-24）", () => {
  const bad: Array<[string, string]> = [
    ["CRLF 注入", "Mozilla/5.0\r\nX-Injected: 1"],
    ["单个 LF", "Mozilla/5.0\nfoo"],
    ["单个 CR", "Mozilla/5.0\rfoo"],
    ["TAB", "Mozilla/5.0\tfoo"],
    ["NUL", "Mozilla/5.0\u0000foo"],
    ["ESC", "Mozilla/5.0\u001bfoo"],
    ["DEL", "Mozilla/5.0\u007ffoo"],
    ["C1 控制符 NEL", "Mozilla/5.0\u0085foo"],
    ["C1 上界 U+009F", "Mozilla/5.0\u009ffoo"],
    ["行分隔符 U+2028", "Mozilla/5.0\u2028foo"],
    ["段分隔符 U+2029", "Mozilla/5.0\u2029foo"],
    ["开头的控制符", "\nMozilla/5.0"],
    ["结尾的控制符", "Mozilla/5.0\n"],
  ];
  const good: Array<[string, string]> = [
    ["真实 Chrome UA", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"],
    ["含中文 / emoji / 全角空格（可见字符，不是控制符）", "我的浏览器 🚀 1.0\u3000测试"],
    ["U+00A0 不换行空格（> U+009F，不算控制符）", "Mozilla/5.0\u00a0(x)"],
    ["普通空格 / 引号 / 括号 / 分号", "Mozilla/5.0 (X11; Linux x86_64) \"q\" 'a'"],
    ["单个字符", "x"],
  ];

  it.each(bad)("validateUserAgent 拒绝：%s", (_n, ua) => {
    const r = validateUserAgent(ua);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/控制字符/);
    expect((r as { reason: string }).reason).toMatch(/U\+[0-9A-F]{4}/);
  });

  it.each(good)("validateUserAgent 放行：%s", (_n, ua) => {
    expect(validateUserAgent(ua)).toEqual({ ok: true });
  });

  it("validateUserAgent：非字符串 → 拒绝；原因里的位置是第几个字符（从 1 起）", () => {
    for (const v of [undefined, null, 5, {}, ["a"], true]) {
      expect(validateUserAgent(v as never).ok, String(v)).toBe(false);
    }
    expect((validateUserAgent("ab\ncd") as { reason: string }).reason).toContain("第 3 个字符是 U+000A");
    expect((validateUserAgent("\u0000") as { reason: string }).reason).toContain("U+0000");
  });

  it("全部预设设备自带的 UA 都能通过校验（不能把自己的预设挡了）", () => {
    for (const name of DEVICE_NAMES) {
      const ua = (DEVICE_PRESETS[name as keyof typeof DEVICE_PRESETS] as { userAgent?: string }).userAgent;
      if (ua !== undefined) expect(validateUserAgent(ua), name).toEqual({ ok: true });
    }
  });

  it.each(bad)("mergeEmulation 兜底抛 BAD_ARGS 且不改入参：%s", (_n, ua) => {
    const prev = mergeEmulation({}, { device: "iPhone 15" });
    const snapshot = JSON.stringify(prev);
    let err: { name?: string; code?: string; message?: string } | undefined;
    try {
      mergeEmulation(prev, { userAgent: ua, colorScheme: "dark" });
    } catch (e) {
      err = e as typeof err;
    }
    expect(err).toMatchObject({ name: "BrowserError", code: "BAD_ARGS" });
    expect(err?.message).toMatch(/控制字符/);
    expect(JSON.stringify(prev)).toBe(snapshot); // prev 原样，也没有「colorScheme 已经叠上」这种半截状态
  });

  it("mergeEmulation：正常 UA 照常叠加；null 仍是「清掉 UA」；没给 userAgent 的 patch 不受影响", () => {
    const withUa = mergeEmulation({}, { userAgent: "MyBot/1.0 (+https://example.com)" });
    expect(withUa).toEqual({ userAgent: "MyBot/1.0 (+https://example.com)" });
    expect(mergeEmulation(withUa, { userAgent: null })).toEqual({});
    expect(mergeEmulation(withUa, { colorScheme: "dark" })).toEqual({ userAgent: "MyBot/1.0 (+https://example.com)", colorScheme: "dark" });
    // 预设里的 UA 经 device 铺入，不走 p.userAgent 校验，也不会被误拒
    expect(mergeEmulation({}, { device: "Pixel 8" }).userAgent).toMatch(/Pixel 8/);
  });

  it("mergeEmulation 的校验在 reset 之前：reset:true + 坏 UA 也是整体拒绝，不会「清空了但没叠上」", () => {
    const prev = mergeEmulation({}, { colorScheme: "dark" });
    expect(() => mergeEmulation(prev, { reset: true, userAgent: "a\r\nb" })).toThrowError(/控制字符/);
    expect(prev).toEqual({ colorScheme: "dark" });
  });

  it("emulate 处理器：带控制字符的 UA → BAD_ARGS，不调 applyEmulation、不动 tab.emulation（经 mergeEmulation 兜底）", async () => {
    const tab = {
      id: "t1",
      url: "https://example.com/",
      emulation: { colorScheme: "dark" } as Record<string, unknown>,
      applyEmulation: async () => {
        throw new Error("不应走到这里：状态不能在校验之前改动");
      },
    };
    const described: unknown[] = [];
    const session = {
      runAction: async (_o: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
        fn({ tab, describe: (d: unknown) => described.push(d), check: () => {} }),
    };
    const handlers = createHandlers({ requireSession: () => session, scheduleState: () => {} } as never);
    await expect(handlers.emulate("task1", { userAgent: "Mozilla/5.0\r\nX-Evil: 1" })).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(tab.emulation).toEqual({ colorScheme: "dark" });
    expect(described).toHaveLength(0); // 没来得及写活动日志（不会记一条「设置了设备模拟」却没生效）
  });
});
