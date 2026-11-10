/**
 * E2·P2 / A2 弹窗放行策略的纯函数（popup-policy.mjs）：
 *   - decidePopup 的真值表（手势 / 无手势 / URL 被拦 / 超上限 / 被限流 / Flowship origin 经 URL 判定传入 / 会话与 opener 状态）
 *   - 限流配额只在其它条件都通过时才消耗
 *   - isSafePopupPrefs：收养前核对弹窗 wc 的偏好不能比普通 tab 宽松
 *   - isGestureInput：哪些浏览器进程输入算「真实手势」
 */
import { describe, expect, it, vi } from "vitest";

import {
  decidePopup,
  isGestureInput,
  isSafePopupPrefs,
  POPUP_DENY,
  POPUP_WEB_PREFERENCES,
} from "../electron-app/browser/popup-policy.mjs";
import { checkUrl } from "../electron-app/browser/url-policy.mjs";

type Input = Parameters<typeof decidePopup>[0];
const base = (over: Partial<Input> = {}): Input => ({
  urlOk: true,
  sessionAlive: true,
  openerKnown: true,
  gesture: true,
  tabCount: 1,
  maxTabs: 20,
  consumeQuota: () => true,
  ...over,
});

describe("decidePopup 真值表", () => {
  it("全部满足 → 放行", () => {
    expect(decidePopup(base())).toEqual({ allow: true });
  });

  it("有手势 / 无手势", () => {
    expect(decidePopup(base({ gesture: true }))).toEqual({ allow: true });
    expect(decidePopup(base({ gesture: false }))).toEqual({ allow: false, reason: POPUP_DENY.NO_GESTURE });
  });

  it("URL 被拦（含 Flowship origin：checkUrl 的结论原样传入）→ URL_BLOCKED，且优先于其它原因", () => {
    const isAppUrl = (u: string) => /^https?:\/\/127\.0\.0\.1:8876(\/|$)/.test(u);
    for (const url of ["http://127.0.0.1:8876/settings", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", ""]) {
      const verdict = checkUrl(url, { isAppUrl });
      expect(verdict.ok, url).toBe(false);
      expect(decidePopup(base({ urlOk: verdict.ok, gesture: false, tabCount: 99 }))).toEqual({ allow: false, reason: POPUP_DENY.URL_BLOCKED });
    }
    expect(checkUrl("https://accounts.example.com/oauth", { isAppUrl }).ok).toBe(true);
  });

  it("超 tab 上限：恰好满 = 拒；差一个 = 放", () => {
    expect(decidePopup(base({ tabCount: 19, maxTabs: 20 }))).toEqual({ allow: true });
    expect(decidePopup(base({ tabCount: 20, maxTabs: 20 }))).toEqual({ allow: false, reason: POPUP_DENY.TAB_LIMIT });
    expect(decidePopup(base({ tabCount: 21, maxTabs: 20 }))).toEqual({ allow: false, reason: POPUP_DENY.TAB_LIMIT });
  });

  it("被限流 → THROTTLED", () => {
    expect(decidePopup(base({ consumeQuota: () => false }))).toEqual({ allow: false, reason: POPUP_DENY.THROTTLED });
  });

  it("会话已销毁 / opener 不在 → 拒", () => {
    expect(decidePopup(base({ sessionAlive: false }))).toEqual({ allow: false, reason: POPUP_DENY.NO_SESSION });
    expect(decidePopup(base({ openerKnown: false }))).toEqual({ allow: false, reason: POPUP_DENY.NO_OPENER });
  });

  it("fail-closed：非严格 true 的「真值」、NaN / 缺省的数字、抛错的限流都按拒绝处理", () => {
    expect(decidePopup(base({ gesture: 1 as never })).allow).toBe(false);
    expect(decidePopup(base({ gesture: "yes" as never })).allow).toBe(false);
    expect(decidePopup(base({ urlOk: "true" as never })).allow).toBe(false);
    expect(decidePopup(base({ sessionAlive: undefined as never })).allow).toBe(false);
    expect(decidePopup(base({ openerKnown: 1 as never })).allow).toBe(false);
    expect(decidePopup(base({ tabCount: Number.NaN }))).toEqual({ allow: false, reason: POPUP_DENY.TAB_LIMIT });
    expect(decidePopup(base({ maxTabs: Number.NaN }))).toEqual({ allow: false, reason: POPUP_DENY.TAB_LIMIT });
    expect(decidePopup(base({ maxTabs: undefined as never }))).toEqual({ allow: false, reason: POPUP_DENY.TAB_LIMIT });
    expect(decidePopup(base({ consumeQuota: () => 1 as never }))).toEqual({ allow: false, reason: POPUP_DENY.THROTTLED });
    expect(
      decidePopup(
        base({
          consumeQuota: () => {
            throw new Error("boom");
          },
        }),
      ),
    ).toEqual({ allow: false, reason: POPUP_DENY.THROTTLED });
  });

  it("限流配额只在其它条件都通过时才消耗：被前面条件挡下的请求不吃配额（页面不能靠被拒的请求耗光合法弹窗的配额）", () => {
    const quota = vi.fn(() => true);
    decidePopup(base({ urlOk: false, consumeQuota: quota }));
    decidePopup(base({ sessionAlive: false, consumeQuota: quota }));
    decidePopup(base({ openerKnown: false, consumeQuota: quota }));
    decidePopup(base({ gesture: false, consumeQuota: quota }));
    decidePopup(base({ tabCount: 20, consumeQuota: quota }));
    expect(quota).not.toHaveBeenCalled();
    expect(decidePopup(base({ consumeQuota: quota }))).toEqual({ allow: true });
    expect(quota).toHaveBeenCalledTimes(1);
  });

  it("原因码互不相同（日志 / 测试对账用）", () => {
    const values = Object.values(POPUP_DENY);
    expect(new Set(values).size).toBe(values.length);
    expect(Object.isFrozen(POPUP_DENY)).toBe(true);
  });
});

describe("isSafePopupPrefs：收养前核对弹窗 wc 的偏好", () => {
  const safe = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true };

  it("与普通 tab 一致的偏好 → 通过；覆盖项常量自身也必须是安全的", () => {
    expect(isSafePopupPrefs(safe)).toBe(true);
    expect(isSafePopupPrefs({ ...safe, preload: undefined, preloads: [] })).toBe(true);
    expect(isSafePopupPrefs({ ...POPUP_WEB_PREFERENCES })).toBe(true);
    expect(Object.isFrozen(POPUP_WEB_PREFERENCES)).toBe(true);
  });

  it("任何一项比普通 tab 宽松就拒收", () => {
    const loosened: Array<[string, Record<string, unknown>]> = [
      ["sandbox 关", { sandbox: false }],
      ["sandbox 缺省（默认值随版本变，必须显式 true）", { sandbox: undefined }],
      ["contextIsolation 关", { contextIsolation: false }],
      ["nodeIntegration 开", { nodeIntegration: true }],
      ["子 frame nodeIntegration", { nodeIntegrationInSubFrames: true }],
      ["worker nodeIntegration", { nodeIntegrationInWorker: true }],
      ["webSecurity 关", { webSecurity: false }],
      ["webviewTag 开", { webviewTag: true }],
      ["允许运行不安全内容", { allowRunningInsecureContent: true }],
      ["带 preload", { preload: "/tmp/evil.js" }],
      ["带 preloads", { preloads: ["/tmp/evil.js"] }],
    ];
    for (const [name, patch] of loosened) expect(isSafePopupPrefs({ ...safe, ...patch }), name).toBe(false);
  });

  it("拿不到偏好（null / undefined / 非对象）→ 拒收", () => {
    expect(isSafePopupPrefs(null)).toBe(false);
    expect(isSafePopupPrefs(undefined)).toBe(false);
    expect(isSafePopupPrefs("sandbox" as never)).toBe(false);
  });
});

describe("isGestureInput：浏览器进程输入管线里的「按下类」才算手势", () => {
  it("鼠标按下 / 触摸开始 / 按键按下 = 手势", () => {
    for (const type of ["mouseDown", "touchStart", "keyDown", "rawKeyDown"]) expect(isGestureInput({ type }), type).toBe(true);
    expect(isGestureInput({ type: "keyDown", keyCode: "Enter" })).toBe(true);
  });

  it("移动 / 抬起 / 滚轮 / 手势滚动 / char / keyUp 不算（页面脚本能触发的、或不代表用户意图的）", () => {
    for (const type of ["mouseMove", "mouseUp", "mouseEnter", "mouseLeave", "mouseWheel", "keyUp", "char", "touchMove", "touchEnd", "gestureScrollBegin", "contextMenu"]) {
      expect(isGestureInput({ type }), type).toBe(false);
    }
  });

  it("Escape 不算（与 Chrome 瞬态激活的口径一致）", () => {
    expect(isGestureInput({ type: "keyDown", keyCode: "Escape" })).toBe(false);
    expect(isGestureInput({ type: "rawKeyDown", keyCode: "esc" })).toBe(false);
  });

  it("垃圾输入不抛、不算", () => {
    for (const v of [null, undefined, 0, "mouseDown", [], {}, { type: 1 }, { type: null }]) expect(isGestureInput(v), String(v)).toBe(false);
  });
});
