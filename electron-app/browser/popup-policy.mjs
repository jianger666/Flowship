/**
 * 页面弹窗（`window.open`）保留 `window.opener` 的放行策略（契约 §15.2 A2）：纯函数、不 import electron。
 *
 * 背景：E1 里 `setWindowOpenHandler` 一律 deny 并经 session 开成同会话的新 tab，代价是页面失去 `window.opener`——
 * OAuth / 支付类弹窗靠 `opener.postMessage` / `window.close()` 回传结果，一律失效。A2 把它改成**受控放开**：
 * 只有同时满足下面全部条件才返回 `{action:"allow", createWindow}`，由 Electron 把 Chromium 建好的、与 opener 同一
 * browsing context group 的 webContents 交给我们收养成同会话同 partition 的 tab；任何一条不满足都走老路径（deny + 新 tab，无 opener）。
 *
 * 判定顺序即失败原因的优先级（便于日志 / 测试对账）：
 *   1. URL 必须过 checkUrl（含 Flowship origin 阻断）——调用方已判，这里只收结果；
 *   2. 会话还活着、opener 还是会话里的 tab；
 *   3. opener 最近有真实手势（`PAGE_TAB_GESTURE_MS`）：脚本自己 `setInterval(window.open)` 拿不到 opener；
 *   4. 标签页数（已有 + 已预留的弹窗）没超 `session.maxTabs()`；
 *   5. 页面开 tab 限流（每 opener 10 秒 ≤ 3 个）——**最后判且只在放行时才消耗配额**，被前面的条件挡下不吃配额。
 */

/** 弹窗不放行（回退成普通新 tab）的原因码 */
export const POPUP_DENY = Object.freeze({
  URL_BLOCKED: "url-blocked",
  NO_SESSION: "no-session",
  NO_OPENER: "no-opener",
  NO_GESTURE: "no-gesture",
  TAB_LIMIT: "tab-limit",
  THROTTLED: "throttled",
});

/**
 * @param {{
 *   urlOk: boolean,                 // checkUrl 的结论
 *   sessionAlive: boolean,
 *   openerKnown: boolean,           // opener 还在会话的 tab 表里且没销毁
 *   gesture: boolean,               // opener 最近有真实手势
 *   tabCount: number,               // 已有 tab 数 + 已预留（还没建成）的弹窗数
 *   maxTabs: number,
 *   consumeQuota: () => boolean,    // 页面开 tab 限流：放行返回 true 并记一笔（有副作用，只在前面都通过时才调）
 * }} input
 * @returns {{ allow: true } | { allow: false, reason: string }}
 */
export const decidePopup = (input) => {
  if (input.urlOk !== true) return { allow: false, reason: POPUP_DENY.URL_BLOCKED };
  if (input.sessionAlive !== true) return { allow: false, reason: POPUP_DENY.NO_SESSION };
  if (input.openerKnown !== true) return { allow: false, reason: POPUP_DENY.NO_OPENER };
  if (input.gesture !== true) return { allow: false, reason: POPUP_DENY.NO_GESTURE };
  // NaN / 缺省都按「已满」处理（fail-closed）：`tabCount >= maxTabs` 对 NaN 恒为 false，不能直接比
  if (!(Number.isFinite(input.tabCount) && Number.isFinite(input.maxTabs) && input.tabCount < input.maxTabs)) {
    return { allow: false, reason: POPUP_DENY.TAB_LIMIT };
  }
  let quotaOk = false;
  try {
    quotaOk = input.consumeQuota() === true;
  } catch {
    quotaOk = false;
  }
  if (!quotaOk) return { allow: false, reason: POPUP_DENY.THROTTLED };
  return { allow: true };
};

/**
 * 弹窗 wc 的 webPreferences 覆盖项：与普通 tab 一致（sandbox / contextIsolation / 无 nodeIntegration / webSecurity / 不后台节流）。
 * 经 `overrideBrowserWindowOptions.webPreferences` 交给 Electron——它会与「opener 的安全默认值」「window.open features 里解析出的偏好」合并，
 * 我们这份优先级最高（Electron 的 makeWebPreferences：features < 继承的安全值 < 这里的覆盖）。
 * 刻意没有 preload / partition：页面碰不到任何壳 API；session 由 Chromium 按 opener 的 browsing context 决定，收养时再核对。
 */
export const POPUP_WEB_PREFERENCES = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  backgroundThrottling: false,
});

/**
 * 收养前核对弹窗 wc 的实际 webPreferences（`wc.getLastWebPreferences()`）：任何一项比普通 tab 更宽松就拒收。
 * 取值缺省按 Electron 默认（contextIsolation / webSecurity 默认 true）判；sandbox 必须**显式** true（默认值随版本变，不能靠默认）。
 * @param {Record<string, unknown> | null | undefined} prefs
 */
export const isSafePopupPrefs = (prefs) => {
  if (!prefs || typeof prefs !== "object") return false;
  if (prefs.sandbox !== true) return false;
  if (prefs.contextIsolation === false) return false;
  if (prefs.nodeIntegration === true) return false;
  if (prefs.nodeIntegrationInSubFrames === true) return false;
  if (prefs.nodeIntegrationInWorker === true) return false;
  if (prefs.webSecurity === false) return false;
  if (prefs.webviewTag === true) return false;
  if (prefs.allowRunningInsecureContent === true) return false;
  if (typeof prefs.preload === "string" && prefs.preload !== "") return false;
  if (Array.isArray(prefs.preloads) && prefs.preloads.length > 0) return false;
  return true;
};

/**
 * 浏览器进程输入管线（`webContents` 的 `input-event`）里哪些算「用户手势」：按下类输入——
 * 鼠标按下 / 触摸开始 / 按键按下（Escape 不算：Chrome 的瞬态激活同样排除它）。
 * `input-event` 是浏览器进程在把输入送进渲染进程**之前**同步触发的，真实用户输入、`sendInputEvent`、CDP `Input.dispatch*`（AI 的点击）都会经过；
 * 页面脚本的 `dispatchEvent` / `el.click()` 根本不走这条管线，所以它伪造不了。比页内录制器的 binding 事件更可靠的地方：
 * 它与随后的 `window.open` 不会乱序（binding 走 CDP 通道，实测同毫秒到达，负载高时顺序无保证）。
 * @param {unknown} inputEvent
 */
export const isGestureInput = (inputEvent) => {
  if (!inputEvent || typeof inputEvent !== "object") return false;
  const { type, keyCode } = /** @type {{ type?: unknown, keyCode?: unknown }} */ (inputEvent);
  if (type === "mouseDown" || type === "touchStart") return true;
  if (type === "keyDown" || type === "rawKeyDown") return !(typeof keyCode === "string" && /^(escape|esc)$/i.test(keyCode));
  return false;
};
