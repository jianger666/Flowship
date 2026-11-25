/**
 * 遮罩：自动解锁之后盖住整个屏幕（每块显示器一个窗口），旁人看不到 AI 在干什么。
 *
 * 硬要求（单测钉死，改动前先看 tests/desktop-overlay.test.ts）：
 * - 不抢焦点：focusable:false + showInactive()，绝不 show() / focus()。AI 要往下面的应用注入键盘事件，遮罩一旦成为 key window，
 *   事件就全落到遮罩上了。
 * - 鼠标穿透：setIgnoreMouseEvents(true)。AI 的点击要落到下面的应用；用户碰鼠标也要能穿透——
 *   「用户动了键鼠就让位」靠的是系统层的 idle 检测，不是遮罩上的事件。
 * - 尽量不进屏幕截图：setContentProtection(true)（macOS 的 sharingType=none / Windows 的 WDA_EXCLUDEFROMCAPTURE）。
 *   否则 AI 截图只能看到一张遮罩页。⚠️ **不能假设它让遮罩「消失」**：Electron 文档说 macOS 上用 ScreenCaptureKit 的捕获方会无视它；
 *   macOS 27.2 + Electron 42 上实测更糟——整个屏幕被截成一片黑（只剩 Dock 的图标），不是遮罩色也不是真实屏幕。
 *   所以不靠它兜底：capture-guard.mjs 在运行时对照「带遮罩 / 撤了遮罩」两张图，发现遮罩影响了截图，
 *   就用下面的 suspend() / resume() 在截图的一瞬间把遮罩变透明（generation() 让它知道「这是新一轮遮罩，要重新对照」；
 *   shownAt() 让它知道遮罩出现多久了——刚出现的一秒内画面还没稳定，那时对照出的「没影响」不能算数，实测第一张截图会抢在遮罩合成之前）。
 * - 最高层级：alwaysOnTop 'screen-saver'，所有空间 / 全屏应用之上；macOS 用 panel 类型（不激活应用）。
 * - 页面是静态内联 HTML：不加载任何外部资源、没有 preload / node 能力。
 * - 显示器热插拔：新增的屏幕补一个窗口，拔掉的销毁对应窗口。
 * - 显示设置变了（display-metrics-changed：会话中途改分辨率 / 缩放 / 旋转 / 重新排列屏幕）：对应窗口跟着调到新的 bounds，
 *   调不动就销毁重建——窗口尺寸跟不上新分辨率，新旧之间那一块屏幕就露出来了，旁人照样看得见。
 *
 * 遮罩永远不是「用户回来也进不去」的原因：hide() 无条件销毁全部窗口，且不依赖任何异步。
 * suspend() 同理不能让屏幕一直裸着：有超时兜底（截图卡住也会自己恢复），hide() 也会把它清干净。
 */

/** 遮罩底色：页面 CSS、窗口 backgroundColor、截图里「像不像遮罩」的判断都用它，改一处全跟着变 */
export const OVERLAY_BACKGROUND = "#0b1020";
export const OVERLAY_RGB = Object.freeze([11, 16, 32]);

/** suspend() 的兜底上限：到点不管截图有没有结束都把遮罩恢复（隐私：屏幕不能一直裸着） */
export const MAX_SUSPEND_MS = 5000;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** 遮罩页面：纯静态，计时器是页面内自己的 setInterval */
export const buildOverlayHtml = (message) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Flowship</title>
<style>
  html,body{margin:0;height:100%;background:${OVERLAY_BACKGROUND};color:#e8ecf5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden;cursor:none;user-select:none}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
  .dot{width:14px;height:14px;border-radius:50%;background:#6ea8ff;animation:p 1.6s ease-in-out infinite}
  h1{margin:0;font-size:28px;font-weight:600;letter-spacing:.5px}
  p{margin:0;font-size:15px;opacity:.7}
  .t{font-variant-numeric:tabular-nums;opacity:.55;font-size:13px}
  @keyframes p{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}
</style></head>
<body><div class="wrap"><div class="dot"></div>
<h1>${escapeHtml(message)}</h1>
<p>动一下键盘或鼠标，AI 会立刻停手、把电脑还给你</p>
<div class="t" id="t">已运行 0:00</div></div>
<script>
  const s=Date.now();const el=document.getElementById('t');
  setInterval(()=>{const n=Math.floor((Date.now()-s)/1000);el.textContent='已运行 '+Math.floor(n/60)+':'+String(n%60).padStart(2,'0');},1000);
</script></body></html>`;

const DEFAULT_MESSAGE = "Flowship 正在替你操作电脑";

/**
 * @param {{
 *   BrowserWindow: any,
 *   screen: any,
 *   platform?: string,
 *   log?: (msg: string) => void,
 *   maxSuspendMs?: number,
 *   now?: () => number,
 * }} deps electron 的 BrowserWindow / screen 注入，单测用假对象
 * @returns {import("./types.mjs").DesktopOverlay}
 */
export const createOverlay = ({
  BrowserWindow,
  screen,
  platform = process.platform,
  log = () => {},
  maxSuspendMs = MAX_SUSPEND_MS,
  now = Date.now,
}) => {
  /** displayId → BrowserWindow */
  const wins = new Map();
  let message = DEFAULT_MESSAGE;
  let listening = false;
  /** suspend() 的嵌套深度（>0 = 遮罩此刻是透明的）与兜底定时器 */
  let suspendDepth = 0;
  let suspendTimer = null;
  /** 第几轮遮罩：每次 show() 成功 +1。capture-guard 靠它在新一轮遮罩（新会话）开始时丢掉上一轮对「遮罩会不会影响截图」的判断 */
  let generation = 0;
  /** 最近一次 show() 成功的时间（ms，没显示过是 0）：截图守卫据此判断遮罩出现多久了、画面稳定了没有 */
  let shownAt = 0;
  /**
   * 「这块显示器的窗口没建成 / 重建失败、至今没补上」的显示器 id。show() 成功之后才可能出现（show() 本身盖不全是直接抛错的）：
   * 会话中途接入的副屏、改分辨率之后的重建，窗口建不出来只记一行日志的话，那块屏幕就裸着、旁人看得见 AI 在干什么，而上层毫不知情
   * （第三轮评审「overlay 补建失败」）。isComplete() 把这个状态交出去，会话看门狗据此结束并锁回去。
   */
  const uncovered = new Set();

  const makeWindow = (display) => {
    const { x, y, width, height } = display.bounds;
    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: OVERLAY_BACKGROUND,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      ...(platform === "darwin" ? { type: "panel", roundedCorners: false } : {}),
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: false,
      },
    });
    try {
      win.setAlwaysOnTop(true, "screen-saver");
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      win.setIgnoreMouseEvents(true);
      win.setContentProtection(true);
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildOverlayHtml(message))}`);
      win.showInactive();
    } catch (err) {
      // 半成品窗口不能留着：盖不住 / 抢焦点 / 进截图，都比没有遮罩更糟
      try {
        win.destroy();
      } catch {
        /* ignore */
      }
      throw err;
    }
    return win;
  };

  const setOpacityAll = (value) => {
    for (const win of wins.values()) {
      try {
        if (!win.isDestroyed?.()) win.setOpacity(value);
      } catch (err) {
        log(`[desktop-overlay] 调整遮罩透明度失败：${err?.message || err}`);
      }
    }
  };

  const addDisplay = (display) => {
    if (wins.has(display.id)) return;
    try {
      const win = makeWindow(display);
      wins.set(display.id, win);
      uncovered.delete(display.id);
      // 正在为截图撤遮罩的时候插进来的新显示器：跟着一起透明，恢复时一并恢复（否则这一块屏幕会多出一张被截进画面的遮罩）
      if (suspendDepth > 0) {
        try {
          win.setOpacity(0);
        } catch (err) {
          log(`[desktop-overlay] 调整遮罩透明度失败：${err?.message || err}`);
        }
      }
    } catch (err) {
      uncovered.add(display.id);
      log(`[desktop-overlay] 显示器 ${display.id} 的遮罩创建失败：${err?.message || err}`);
    }
  };

  const destroyWindow = (win) => {
    try {
      if (!win.isDestroyed?.()) win.destroy();
    } catch (err) {
      log(`[desktop-overlay] 销毁遮罩窗口失败：${err?.message || err}`);
    }
  };

  const clearSuspend = () => {
    suspendDepth = 0;
    if (suspendTimer) {
      clearTimeout(suspendTimer);
      suspendTimer = null;
    }
  };

  const onDisplayAdded = (_event, display) => addDisplay(display);
  const onDisplayRemoved = (_event, display) => {
    // 拔掉的显示器不再有「没盖住」可言（本来就没窗口的也要清：先清再看窗口在不在）
    uncovered.delete(display.id);
    const win = wins.get(display.id);
    if (!win) return;
    wins.delete(display.id);
    destroyWindow(win);
  };
  // 分辨率 / 缩放 / 旋转 / 摆放位置变了：窗口是按创建时那一刻的 bounds 定死的，不跟着调就会露出缺口。
  // 每次都直接 setBounds（和现有 bounds 一样时是空操作；Dock 自动隐藏这类只改 workArea 的事件也走这里，无副作用），不依赖 changedMetrics 的说法。
  // 调不动 / 窗口已经没了就重建；这块显示器上本来就没窗口（上次没建成）也趁机补建——但只补还存在的显示器，
  // 免得拔掉之后才到的迟到事件给一块不存在的屏幕建出一个永远没人销毁的窗口
  const onDisplayMetricsChanged = (_event, display) => {
    const win = wins.get(display.id);
    if (win && !win.isDestroyed?.()) {
      try {
        win.setBounds(display.bounds);
        return;
      } catch (err) {
        log(`[desktop-overlay] 显示器 ${display.id} 的遮罩调整尺寸失败，重建：${err?.message || err}`);
        wins.delete(display.id);
        destroyWindow(win);
      }
    } else {
      wins.delete(display.id);
    }
    if (screen.getAllDisplays().some((d) => d.id === display.id)) addDisplay(display);
  };

  const destroyAll = () => {
    // 先清透明状态：窗口没了，下一次 show() 出来的遮罩必须是不透明的、不能继承上一轮没配平的深度
    clearSuspend();
    for (const win of wins.values()) destroyWindow(win);
    wins.clear();
    uncovered.clear();
  };

  const show = (opts = {}) => {
    if (wins.size > 0) return; // 幂等
    message = typeof opts.message === "string" && opts.message.trim() !== "" ? opts.message.trim().slice(0, 80) : DEFAULT_MESSAGE;
    const displays = screen.getAllDisplays();
    for (const display of displays) addDisplay(display);
    // 一块都没盖上、或只盖上一部分，都算失败：没盖到的显示器上旁人照样看得见屏幕。
    // 已经建出来的窗口全部撤掉（不留半成品），让上层决定怎么办（解锁过的电脑要锁回去）
    if (wins.size === 0 || wins.size < displays.length) {
      const made = wins.size;
      destroyAll();
      throw new Error(made === 0 ? "没能创建出任何遮罩窗口" : `遮罩只盖住了 ${made}/${displays.length} 块显示器`);
    }
    generation += 1;
    shownAt = now();
    if (!listening) {
      screen.on("display-added", onDisplayAdded);
      screen.on("display-removed", onDisplayRemoved);
      screen.on("display-metrics-changed", onDisplayMetricsChanged);
      listening = true;
    }
  };

  const hide = () => {
    if (listening) {
      screen.removeListener("display-added", onDisplayAdded);
      screen.removeListener("display-removed", onDisplayRemoved);
      screen.removeListener("display-metrics-changed", onDisplayMetricsChanged);
      listening = false;
    }
    destroyAll();
  };

  const isShown = () => wins.size > 0;

  /**
   * 遮罩有没有盖全：没有「建不出来的显示器」，且已有的窗口都还活着（渲染进程崩了 / 被系统销毁的窗口不算盖着）。
   * 只认「明确的缺口」——热插拔事件到达的瞬间显示器列表和事件对不上之类的过渡态不算（那种情况下一次事件会补上，不该为它结束会话）。
   * 没显示遮罩时恒为 true（没有「盖不全」可说；那是 isShown 的事）。永不抛。
   */
  const isComplete = () => {
    if (uncovered.size > 0) return false;
    for (const win of wins.values()) {
      try {
        if (win.isDestroyed?.()) return false;
      } catch {
        return false;
      }
    }
    return true;
  };

  /**
   * 截图前把遮罩变透明（窗口不销毁、不抢焦点、鼠标照样穿透）。可嵌套：每次 suspend() 配一次 resume()，最后一个 resume() 才恢复。
   * 兜底：maxSuspendMs 到点强制恢复（截图卡住也不能让屏幕一直裸着）；hide() 也会把状态清干净。没有遮罩时什么都不做。
   */
  const suspend = () => {
    if (wins.size === 0) return;
    suspendDepth += 1;
    if (suspendDepth > 1) return;
    setOpacityAll(0);
    suspendTimer = setTimeout(() => {
      suspendTimer = null;
      suspendDepth = 0;
      setOpacityAll(1);
      log(`[desktop-overlay] 遮罩透明超过 ${maxSuspendMs}ms，已强制恢复`);
    }, maxSuspendMs);
    suspendTimer.unref?.();
  };

  const resume = () => {
    if (suspendDepth === 0) return;
    suspendDepth -= 1;
    if (suspendDepth > 0) return;
    if (suspendTimer) {
      clearTimeout(suspendTimer);
      suspendTimer = null;
    }
    setOpacityAll(1);
  };

  const isSuspended = () => suspendDepth > 0;

  return { show, hide, isShown, isComplete, suspend, resume, isSuspended, generation: () => generation, shownAt: () => shownAt };
};
