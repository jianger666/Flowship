/**
 * 用户侧能力（契约 §14.3，V4）：右键菜单 / 缩放 / 页内查找 / 开发者工具 / 下载「显示 + 打开」/ 对话框与模拟的 IPC 转调。
 *
 * 本文件刻意不 import electron：Menu / clipboard / shell / ipcMain 等全部由 index.mjs 注入，
 * 纯逻辑（缩放步进、快捷键判定、右键菜单模板、「打开」扩展名白名单、IPC 参数校验）因此可以直接在 vitest 里单测，
 * 真实行为由 scripts/browser-e2e/v4-smoke.cjs 在真 Electron 里验证。
 *
 * 安全口径：
 * - 每个 browser:* 入口第一件事过 isTrustedIpcSender（只认本应用 origin；浏览器 view 没有 preload，页面碰不到）；
 * - 渲染进程只能传 taskId / 下载 id / 查找词，**从不接受任意文件路径**：下载文件路径只取自该会话登记表里的 DownloadInfo；
 * - 右键菜单里的链接 URL 先过 checkUrl，被拦的地址不给「在新标签页打开」。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { checkUrl } from "./url-policy.mjs";

// ───────────────────────── 缩放（纯函数） ─────────────────────────

/** Chromium zoomLevel 范围与步进（契约 §14.3：−3…+5，步进 0.5）；factor = 1.2 ** level */
export const ZOOM_MIN_LEVEL = -3;
export const ZOOM_MAX_LEVEL = 5;
export const ZOOM_STEP = 0.5;
export const ZOOM_ACTIONS = ["in", "out", "reset"];

/** 夹到合法范围并吸附到 0.5 网格（避免浮点累加误差，也防止外部 setZoomLevel 留下奇怪的值） */
export const clampZoomLevel = (level) => {
  const n = typeof level === "number" && Number.isFinite(level) ? level : 0;
  const snapped = Math.round(n / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX_LEVEL, Math.max(ZOOM_MIN_LEVEL, snapped));
};

/** 一次缩放操作后的新 level：in / out 各一步（到头不动），reset 回 0 */
export const stepZoomLevel = (level, action) => {
  if (action === "reset") return 0;
  if (action === "in") return clampZoomLevel(clampZoomLevel(level) + ZOOM_STEP);
  if (action === "out") return clampZoomLevel(clampZoomLevel(level) - ZOOM_STEP);
  return clampZoomLevel(level);
};

/** level → 百分比整数（TabInfo.zoom）：1.2 ** level * 100 */
export const zoomLevelToPercent = (level) => Math.round(1.2 ** clampZoomLevel(level) * 100);

// ───────────────────────── 快捷键（纯函数） ─────────────────────────

/**
 * before-input-event 的 input → 用户侧快捷键意图。只认 keyDown、不认自动重复之外的组合键：
 * - Cmd（mac）/ Ctrl（其它）+ `=` / `+` 放大、`-` / `_` 缩小、`0` 重置
 * - Cmd/Ctrl+F → 打开查找条
 * - Cmd/Ctrl+R → 刷新当前页；Cmd/Ctrl+Shift+R → 忽略缓存强刷
 *   （必须在这里接住：页面持有焦点时按键只会进这个原生视图的 before-input-event，
 *   放行就会被应用菜单的「重新加载」截走、刷新的是整个 Flowship 主窗口而不是这个页面）
 * 带 Alt 的组合一律不认（给页面自己的快捷键让路）。
 * @returns {{ kind: "zoom", action: "in"|"out"|"reset" } | { kind: "find" } | { kind: "reload", force: boolean } | null}
 */
export const classifyShortcut = (input, platform) => {
  if (!input || input.type !== "keyDown" || input.alt) return null;
  const mod = platform === "darwin" ? input.meta === true : input.control === true;
  if (!mod) return null;
  // mac 上 Cmd 与 Ctrl 同时按是另一回事（如 Ctrl+Cmd+F 全屏），不拦
  if (platform === "darwin" ? input.control === true : input.meta === true) return null;
  const key = typeof input.key === "string" ? input.key : "";
  if (key === "=" || key === "+") return { kind: "zoom", action: "in" };
  if (key === "-" || key === "_") return { kind: "zoom", action: "out" };
  if (key === "0") return { kind: "zoom", action: "reset" };
  if ((key === "f" || key === "F") && !input.shift) return { kind: "find" };
  // Shift 按下时 key 是大写 "R"，两种写法都认；Shift = 强刷（忽略缓存）
  if (key === "r" || key === "R") return { kind: "reload", force: input.shift === true };
  return null;
};

// ───────────────────────── 下载：「打开」扩展名白名单（纯函数） ─────────────────────────

/**
 * 能「打开」（shell.openPath）的扩展名**白名单**（R1-23；原先是黑名单，开放式、总会漏：application / msix / appx / chm / scf /
 * library-ms / settingcontent-ms / rdp / iso / img / vhd(x) / jnlp / mobileconfig / desktop / deb / rpm / py / pl / rb /
 * docm / xlsm / xll / html / svg / webloc / diagcab / 带冒号的 NTFS 备用数据流名 …）。
 * 不在名单里的一律只给「在文件夹中显示」（showItemInFolder），让用户自己决定怎么处理——这是更安全的失败方向。
 *
 * 选择标准：系统默认应用只是「看」，不会执行文件里的代码。
 * - 刻意不放 svg / html / htm / xhtml / xml（可含脚本，默认会被浏览器打开）、docm / xlsm / pptm（带宏）、zip 等压缩包（解压即落地一堆文件）；
 * - R2-11：csv（以及 tsv 等同类表格文本）**不在**名单里——页面决定的内容经 Excel 打开会把 `=cmd|…` / `=HYPERLINK(…)` 当公式执行
 *   （公式注入），而「只看不执行」的选择标准恰恰排除它；用户要看数据仍可「在文件夹中显示」后自己选打开方式。
 *   docx / xlsx / pptx 是否会因下载来源标记（Windows 的 MOTW / macOS 的 quarantine）进入受保护视图，Electron 的下载是否打上该标记
 *   **没有真机核实**，名单暂时保留它们（见 docs 的待核实项）；若核实发现没有标记，应一并移出；
 * - 文档：pdf、docx、xlsx、pptx；图片：png、jpg、jpeg、gif、webp；文本：txt、json、md、log；音视频：mp3、wav、m4a、mp4、webm、mov（共 19 项）。
 *
 * 渲染端 src/components/browser/browser-user-logic.ts 的 OPENABLE_EXTENSIONS 抄同一份，tests/browser-v4-ui.test.ts 钉两边逐项一致。
 */
export const OPENABLE_EXTENSIONS = Object.freeze(
  new Set([
    "pdf",
    "png", "jpg", "jpeg", "gif", "webp",
    "txt", "json", "md", "log",
    "mp3", "wav", "m4a", "mp4", "webm", "mov",
    "docx", "xlsx", "pptx",
  ]),
);

/**
 * 文件名 → 小写扩展名（不含点）；没有扩展名返回 ""。
 * Windows 会忽略文件名末尾的点与空格（`a.exe.` / `a.exe ` 照样是 exe），所以先剥掉再取扩展名。
 */
export const extensionOf = (fileName) => {
  const base = path.basename(String(fileName ?? "")).replace(/[. ]+$/, "");
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
};

/**
 * 能不能「打开」（shell.openPath）：扩展名必须在 {@link OPENABLE_EXTENSIONS} 白名单里。
 * **没有扩展名也不给打开**（mac 上无扩展名的 Unix 可执行文件会被系统拉进终端执行）；
 * 双扩展名只看最后一段（`a.pdf.exe` → exe，不在白名单）；`a.pdf:evil.exe` 这类 NTFS 备用数据流写法取到的扩展名带冒号，同样不在白名单。
 */
export const canOpenFile = (fileName) => {
  const ext = extensionOf(fileName);
  if (ext === "") return false;
  return OPENABLE_EXTENSIONS.has(ext);
};

// ───────────────────────── 右键菜单（纯函数：params → 模板） ─────────────────────────

/**
 * 由 context-menu 的 params 构造菜单模板（Electron MenuItemConstructorOptions 的子集）。
 * 每个可点项都带 `id`，click 经 `actions[id]` 转发——单测不需要 electron 也能验菜单项与参数。
 *
 * @param {object | null | undefined} params `webContents` 的 context-menu params（x / y / linkURL / srcURL / mediaType / selectionText / isEditable / editFlags）
 * @param {{
 *   canGoBack: boolean, canGoForward: boolean,
 *   linkVerdict?: { ok: boolean } | null,   // checkUrl(params.linkURL) 的结果；没链接时不传
 *   inspectEnabled?: boolean,               // 是否提供「检查元素」（DevTools 与 debugger 并存才开）
 *   actions: Record<string, (...args: any[]) => void>,
 * }} ctx
 */
export const buildContextMenuTemplate = (params, ctx) => {
  const p = params ?? {};
  const flags = p.editFlags ?? {};
  const act = (id, ...args) => () => ctx.actions[id]?.(...args);
  const item = (id, label, enabled, ...args) => ({ id, label, enabled: enabled !== false, click: act(id, ...args) });
  const sep = () => ({ type: "separator" });
  /** @type {Array<any>} */
  const groups = [];

  const linkURL = typeof p.linkURL === "string" ? p.linkURL : "";
  if (linkURL) {
    const g = [];
    // 被 URL 策略拦下的地址（本应用 origin / file: / javascript: …）不给「在新标签页打开」
    if (ctx.linkVerdict?.ok === true) g.push(item("openLink", "在新标签页打开链接", true, linkURL));
    g.push(item("copyLink", "复制链接地址", true, linkURL));
    groups.push(g);
  }

  const srcURL = typeof p.srcURL === "string" ? p.srcURL : "";
  if (p.mediaType === "image") {
    const g = [item("copyImage", "复制图片", true, p.x, p.y)];
    // data: 图片地址动辄几百 KB，复制出来没有意义；只给 http(s)
    if (/^https?:\/\//i.test(srcURL)) g.push(item("copyImageUrl", "复制图片地址", true, srcURL));
    groups.push(g);
  }

  if (p.isEditable) {
    groups.push([
      item("cut", "剪切", flags.canCut),
      item("copy", "复制", flags.canCopy),
      item("paste", "粘贴", flags.canPaste),
      item("selectAll", "全选", flags.canSelectAll),
    ]);
  } else {
    const hasSelection = typeof p.selectionText === "string" && p.selectionText.trim() !== "";
    const g = [];
    if (hasSelection) g.push(item("copy", "复制", flags.canCopy !== false));
    g.push(item("selectAll", "全选", flags.canSelectAll !== false));
    groups.push(g);
    // 导航项只在非输入框里出：输入框里的右键菜单以编辑为主
    groups.push([
      item("back", "后退", ctx.canGoBack),
      item("forward", "前进", ctx.canGoForward),
      item("reload", "刷新", true),
    ]);
  }

  if (ctx.inspectEnabled !== false) groups.push([item("inspect", "检查元素", true, p.x, p.y)]);

  const out = [];
  for (const g of groups) {
    if (g.length === 0) continue;
    if (out.length > 0) out.push(sep());
    out.push(...g);
  }
  return out;
};

// ───────────────────────── IPC 参数校验（纯函数） ─────────────────────────

const MAX_TASK_ID = 200;
const MAX_FIND_TEXT = 500;
/** 0 命中结果的延迟推送（ms）：盖过 Chromium 每次查找先回的 0 占位结果 */
const FOUND_ZERO_DELAY_MS = 150;

export const validTaskId = (taskId) => typeof taskId === "string" && taskId !== "" && taskId.length <= MAX_TASK_ID;
export const validZoomAction = (action) => typeof action === "string" && ZOOM_ACTIONS.includes(action);
export const validDownloadId = (id) => typeof id === "number" && Number.isSafeInteger(id) && id >= 0;

/** 查找参数规整：text 必须是字符串（截到 500）；opts 只认三个布尔字段，其余丢弃。非法返回 null */
export const normalizeFindArgs = (text, opts) => {
  if (typeof text !== "string") return null;
  const o = opts && typeof opts === "object" ? opts : {};
  return {
    text: text.slice(0, MAX_FIND_TEXT),
    forward: o.forward !== false,
    findNext: o.findNext === true,
    matchCase: o.matchCase === true,
  };
};

// ───────────────────────── 主体 ─────────────────────────

/**
 * @param {{
 *   ipcMain: any,
 *   isTrustedIpcSender: (event: any) => boolean,
 *   getSession: (taskId: string) => any,                  // 已存在的会话（不懒创建）
 *   findOwner: (wc: any) => { session: any, tab: any } | null,   // webContents → 所属会话 / tab
 *   isAppUrl: (url: string) => boolean,
 *   sendToRenderer: (channel: string, ...payload: any[]) => void,
 *   scheduleState: (taskId: string) => void,
 *   Menu?: any, clipboard?: any, shell?: any,
 *   platform?: string,
 *   devToolsEnabled?: boolean,                            // 与 debugger 并存已验证才开（默认开）
 *   log?: (msg: string) => void,
 * }} deps
 */
export const registerUserFeatures = (deps) => {
  const { ipcMain, isTrustedIpcSender, getSession, findOwner, isAppUrl, sendToRenderer, scheduleState } = deps;
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? (() => {});
  const devToolsEnabled = deps.devToolsEnabled !== false;
  const off = [];
  const bound = new WeakSet();

  /** 有返回值的通道（invoke）：非可信发送者直接 throw，渲染侧能看到被拒 */
  const handle = (name, fn) => {
    ipcMain.handle(name, async (event, ...args) => {
      if (!isTrustedIpcSender(event)) throw new Error("untrusted sender");
      return fn(...args);
    });
    off.push(() => ipcMain.removeHandler?.(name));
  };
  /** 无返回值的通道（send）：非可信直接丢弃，出错只记日志（高频操作不能刷屏） */
  const on = (name, fn) => {
    const listener = (event, ...args) => {
      if (!isTrustedIpcSender(event)) return;
      try {
        const r = fn(...args);
        if (r && typeof r.catch === "function") r.catch((err) => log(`[browser] ${name} 失败：${err?.message || err}`));
      } catch (err) {
        log(`[browser] ${name} 失败：${err?.message || err}`);
      }
    };
    ipcMain.on(name, listener);
    off.push(() => ipcMain.removeListener?.(name, listener));
  };

  const activeTabOf = (taskId) => {
    if (!validTaskId(taskId)) return null;
    const s = getSession(taskId);
    return s && !s.destroyed ? (s.activeTab ?? null) : null;
  };

  // ── 缩放 ──

  /**
   * 把 tab 的缩放设到 level，并让面板刷新。
   * 实测（v4-smoke）：Electron 的 setZoomLevel 与 Chrome 一样**按 host 共享**（同一 host 的另一个 tab 会一起变），
   * 不同 host 互不影响；契约写的「每 tab 独立」做不到，这里不硬造重放逻辑，TabInfo.zoom 读 wc 的实时值（偏差已写进报告）。
   */
  const applyZoom = (tab, level) => {
    const next = clampZoomLevel(level);
    try {
      tab.wc.setZoomLevel(next);
    } catch {
      /* wc 已销毁 */
    }
    const owner = findOwner(tab.wc);
    if (owner) scheduleState(owner.session.taskId);
  };
  const zoomTab = (tab, action) => {
    let current = 0;
    try {
      current = tab.wc.getZoomLevel?.() ?? 0;
    } catch {
      /* wc 已销毁 */
    }
    applyZoom(tab, stepZoomLevel(current, action));
  };

  // ── 查找 ──

  const startFind = (tab, a) => {
    if (a.text === "") {
      tab.wc.stopFindInPage("clearSelection");
      return;
    }
    tab.wc.findInPage(a.text, { forward: a.forward, findNext: a.findNext, matchCase: a.matchCase });
  };

  // ── 下载：只按会话登记表里的 id 取，永不接受渲染进程传来的路径 ──

  /**
   * 取 DownloadInfo：优先 V3 的登记表（session.getDownload / session.downloads），
   * 拿不到就用 getState().downloads（与面板展示同源）对账。
   */
  const lookupDownload = (taskId, id) => {
    const s = validTaskId(taskId) ? getSession(taskId) : null;
    if (!s || s.destroyed || !validDownloadId(id)) return null;
    let info = null;
    try {
      info = s.getDownload?.(id) ?? s.downloads?.get?.(id) ?? null;
    } catch {
      info = null;
    }
    if (!info) {
      try {
        const list = s.getState?.().downloads;
        if (Array.isArray(list)) info = list.find((d) => d && d.id === id) ?? null;
      } catch {
        info = null;
      }
    }
    if (!info || typeof info.path !== "string" || !path.isAbsolute(info.path)) return null;
    return info;
  };

  // ── 右键菜单 / 快捷键 / 查找事件：挂到每个 tab 的 webContents ──

  const buildActions = (tab, taskIdOf) => {
    const wc = tab.wc;
    return {
      back: () => {
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      },
      forward: () => {
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      },
      reload: () => wc.reload(),
      cut: () => wc.cut(),
      copy: () => wc.copy(),
      paste: () => wc.paste(),
      selectAll: () => wc.selectAll(),
      openLink: (url) => {
        // 点击时再过一次策略（菜单弹出到点击之间不会变，但这是 URL 进入新 tab 的唯一入口，不省）
        const verdict = checkUrl(url, { isAppUrl });
        if (!verdict.ok) return;
        tab.hooks.onNewTab?.({ url: verdict.url, disposition: "foreground-tab", openerTabId: tab.id, byUser: true });
      },
      copyLink: (url) => deps.clipboard?.writeText(String(url)),
      copyImage: (x, y) => wc.copyImageAt(Math.round(Number(x) || 0), Math.round(Number(y) || 0)),
      copyImageUrl: (url) => deps.clipboard?.writeText(String(url)),
      inspect: (x, y) => {
        void taskIdOf;
        // inspectElement 默认沿用上次的停靠状态（可能是 docked）；WebContentsView 里没有地方 dock，先固定成独立窗口再检查
        if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: "detach" });
        wc.inspectElement(Math.round(Number(x) || 0), Math.round(Number(y) || 0));
      },
    };
  };

  const bindTab = (tab) => {
    if (!tab?.wc || bound.has(tab)) return;
    bound.add(tab);
    const wc = tab.wc;
    const taskIdOf = () => findOwner(wc)?.session.taskId ?? null;

    wc.on("context-menu", (_event, params) => {
      try {
        if (!deps.Menu) return;
        const nav = wc.navigationHistory;
        const linkURL = typeof params?.linkURL === "string" ? params.linkURL : "";
        const template = buildContextMenuTemplate(params, {
          canGoBack: nav.canGoBack(),
          canGoForward: nav.canGoForward(),
          linkVerdict: linkURL ? checkUrl(linkURL, { isAppUrl }) : null,
          inspectEnabled: devToolsEnabled,
          actions: buildActions(tab, taskIdOf),
        });
        const menu = deps.Menu.buildFromTemplate(template);
        const win = tab.parentWindow && !tab.parentWindow.isDestroyed?.() ? tab.parentWindow : undefined;
        menu.popup(win ? { window: win } : undefined);
      } catch (err) {
        log(`[browser] 右键菜单失败：${err?.message || err}`);
      }
    });

    // 页面持有焦点时 Cmd/Ctrl+/-/0/F/R 到不了渲染进程（原生视图吃了键盘），只能在主进程 before-input-event 里接
    wc.on("before-input-event", (event, input) => {
      const hit = classifyShortcut(input, platform);
      if (!hit) return;
      event.preventDefault();
      if (hit.kind === "zoom") {
        zoomTab(tab, hit.action);
      } else if (hit.kind === "reload") {
        // 只刷这个页面；整页刷新 Flowship 本身一律禁用（主窗口见 main.js 的 before-input-event、菜单里也已去掉「重新加载」）
        if (hit.force) wc.reloadIgnoringCache();
        else wc.reload();
      } else {
        const taskId = taskIdOf();
        if (taskId) sendToRenderer("browser:findRequested", taskId);
      }
    });

    // 每次 findInPage，Chromium 会先回一个 matches:0 的「占位」结果、紧接着才是真结果（真 Electron 实测）：
    // 0 命中延后一小会儿再推，期间来了新结果就取消——否则查找条每次都会闪一下「无结果」
    let zeroTimer = null;
    wc.on("found-in-page", (_event, result) => {
      const taskId = taskIdOf();
      if (!taskId) return;
      // 只推当前激活 tab 的结果（后台 tab 的残留查找不该改面板计数）
      const owner = findOwner(wc);
      if (owner && owner.session.activeTab !== tab) return;
      if (zeroTimer) {
        clearTimeout(zeroTimer);
        zeroTimer = null;
      }
      const payload = {
        taskId,
        activeMatchOrdinal: Number(result?.activeMatchOrdinal) || 0,
        matches: Number(result?.matches) || 0,
      };
      if (payload.matches > 0) {
        sendToRenderer("browser:found", payload);
        return;
      }
      zeroTimer = setTimeout(() => {
        zeroTimer = null;
        sendToRenderer("browser:found", payload);
      }, FOUND_ZERO_DELAY_MS);
    });
  };

  // ── IPC ──

  on("browser:zoom", (taskId, action) => {
    if (!validZoomAction(action)) return;
    const tab = activeTabOf(taskId);
    if (tab) zoomTab(tab, action);
  });

  on("browser:find", (taskId, text, opts) => {
    const a = normalizeFindArgs(text, opts);
    const tab = activeTabOf(taskId);
    if (a && tab) startFind(tab, a);
  });

  on("browser:stopFind", (taskId) => {
    activeTabOf(taskId)?.wc.stopFindInPage("clearSelection");
  });

  on("browser:openDevTools", (taskId) => {
    if (!devToolsEnabled) return;
    const tab = activeTabOf(taskId);
    // detach：独立窗口，不抢面板的版面，也不占 attach 的原生视图
    if (tab && !tab.wc.isDevToolsOpened()) tab.wc.openDevTools({ mode: "detach" });
  });

  handle("browser:revealDownload", (taskId, id) => {
    const info = lookupDownload(taskId, id);
    if (!info) return { ok: false, error: "找不到这个下载" };
    if (!existsSync(info.path)) return { ok: false, error: "文件已不在原位置" };
    deps.shell?.showItemInFolder(info.path);
    return { ok: true };
  });

  handle("browser:openDownload", async (taskId, id) => {
    const info = lookupDownload(taskId, id);
    if (!info) return { ok: false, error: "找不到这个下载" };
    // 主进程再校验一次（渲染端按钮已按同一份白名单隐藏，这里防它被绕过）：只开已完成、存在、扩展名在白名单里的文件
    if (info.state !== "completed") return { ok: false, error: "下载还没有完成" };
    if (!canOpenFile(info.path)) return { ok: false, error: "出于安全考虑，只能直接打开常见的文档 / 图片 / 文本 / 音视频文件；这类文件请在文件夹中显示后自行处理" };
    if (!existsSync(info.path)) return { ok: false, error: "文件已不在原位置" };
    const err = await deps.shell?.openPath(info.path);
    return err ? { ok: false, error: String(err) } : { ok: true };
  });

  // V5 实现这两个 tab 方法，可能比本切片晚落地：用可选调用，没有就当没事发生
  on("browser:answerDialog", (taskId, accept, promptText) => {
    if (!validTaskId(taskId)) return;
    const s = getSession(taskId);
    if (!s || s.destroyed) return;
    // 对话框可能挂在非激活 tab 上：优先找有挂起对话框的 tab
    const tab = s.tabs?.find((t) => t.pendingDialog) ?? s.activeTab ?? null;
    tab?.answerDialog?.(accept === true, typeof promptText === "string" ? promptText.slice(0, 2000) : undefined);
  });

  on("browser:resetEmulation", (taskId) => {
    activeTabOf(taskId)?.resetEmulation?.();
  });

  return {
    bindTab,
    /** index.mjs destroy() 时调：撤掉本文件注册的全部 IPC */
    dispose: () => {
      for (const fn of off.splice(0)) {
        try {
          fn();
        } catch {
          /* 已移除 */
        }
      }
    },
    // 仅供单测 / e2e 直接驱动
    zoomTab,
    applyZoom,
    lookupDownload,
  };
};
