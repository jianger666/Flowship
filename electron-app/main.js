/**
 * ai-flow Electron 壳（V0.7.0）
 *
 * 职责（保持薄壳、业务全在 Next server 里）：
 * 1. 起内置 Next standalone server（spawn 自带 node 运行时、ELECTRON_RUN_AS_NODE）
 * 2. 等 server 就绪后开 BrowserWindow 指向 http://127.0.0.1:8876
 * 3. 关窗口 → 杀 server 子进程 → 退出（不留后台常驻）
 * 4. win 自动更新（electron-updater + GitHub Releases 的 latest.yml）
 *
 * 关键链路（V0.7-ELECTRON-PLAN §3.2）：
 * - ELECTRON_RUN_AS_NODE=1 让 process.execPath 表现为 node、且被孙进程继承——
 *   server 里 stop-hook-inject 用 execPath 拼 hook command、hooks 触发时
 *   同样以 node 模式跑、不会弹出新的 app 窗口
 * - FE_AI_FLOW_DATA_DIR 指向系统 userData——数据不落只读的 resources 目录、
 *   更新 / 卸载重装都不丢
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { spawn, execFile } from "node:child_process";
import { promises as fs, mkdirSync, createWriteStream, readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 测试实例（v0.7.9 用户拍板）：本地验证打包 app 时用 `pnpm electron:dist:test`
// 产出「AI工作流test」、自动走独立端口 + 独立数据目录、跟用户日常在用的正式实例
// （8876 + fe-ai-flow）互不干扰、也不会被单实例锁互踢（锁按 userData 算）
// ⚠️ 探测不能用 app.getName()：-c.productName 只改包名 / Info.plist、不改 asar 内
// package.json、getName() 拿到的还是正式名（实测踩坑）——看可执行文件名最可靠
const IS_TEST =
  process.env.FE_AI_FLOW_TEST === "1" ||
  path.basename(process.execPath).toLowerCase().includes("test");

const PORT = Number(process.env.FE_AI_FLOW_PORT) || (IS_TEST ? 8776 : 8876);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

// userData 钉死在 fe-ai-flow（默认跟 productName 走）——显示名改成中文「AI工作流」
// 或以后再改名、数据目录都不漂移、用户任务数据不丢；测试实例独立目录防污染
app.setPath(
  "userData",
  path.join(app.getPath("appData"), IS_TEST ? "fe-ai-flow-test" : "fe-ai-flow"),
);

// 不碰 mac 钥匙串（v0.7.14、用户同事实测痛点「一直弹钥匙串密码框」）：
// Chromium 启动时要拿 Safe Storage 加密 key（加密 cookies / localStorage 用）、
// ad-hoc 签名每个版本 cdhash 都变、钥匙串把每个新版当陌生 app → 每次装新版都弹
// 「想要使用钥匙串中的机密信息」。本应用是本机工具、页面数据本来就明文落 userData、
// 磁盘加密无意义——用 mock keychain 彻底绕开（Chromium 标准开关、内部工具常规做法）。
app.commandLine.appendSwitch("use-mock-keychain");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// server 布局目录：打包后在 resources/app-server（electron-builder extraResources）、
// 本地 dev 验证用仓库根 dist/app-server（scripts/assemble-electron-server.mjs 组出来）
const serverDir = app.isPackaged
  ? path.join(process.resourcesPath, "app-server")
  : path.join(__dirname, "..", "dist", "app-server");

// server 子进程句柄（null = 没起 / 已退）
let serverProc = null;
// 主窗口（关窗后置 null）
let mainWindow = null;
// 主动退出标记——区分「用户关窗杀 server」和「server 自己崩了」
let quitting = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 落盘日志 ----------
// 打包后的 app 没有终端、server stdout / 生命周期事件全落 userData/logs/main.log、
// 出问题（启动失败 / server 崩 / 数据目录异常）有据可查
let logStream = null;
const log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  try {
    if (!logStream) {
      const file = path.join(app.getPath("userData"), "logs", "main.log");
      mkdirSync(path.dirname(file), { recursive: true });
      logStream = createWriteStream(file, { flags: "a" });
    }
    logStream.write(`${line}\n`);
  } catch {
    // 日志写不进去不影响主流程
  }
};

// execFile 的 promise 包装、出错返空串（探测类调用都 fail-open）
const execFileP = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) =>
      resolve(err ? "" : String(stdout)),
    );
  });

// ---------- 端口冲突处理 ----------

// 探端口（PORT、test=8776 / 正式=8876）是否被占（能建立 TCP 连接 = 有进程在听）
const isPortBusy = () =>
  new Promise((resolve) => {
    const socket = net.connect({ port: PORT, host: HOST });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
  });

// 找出监听该端口（PORT）的进程 PID（win 解析 netstat、mac/linux 用 lsof）
const findPortPids = async () => {
  if (process.platform === "win32") {
    const out = await execFileP("netstat", ["-ano", "-p", "tcp"]);
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      // 形如 "  TCP    127.0.0.1:8876    0.0.0.0:0    LISTENING    12345"
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[1]) === PORT) pids.add(Number(m[2]));
    }
    return [...pids];
  }
  const out = await execFileP("lsof", ["-ti", `tcp:${PORT}`, "-sTCP:LISTEN"]);
  return out
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
};

const killPids = async (pids) => {
  for (const pid of pids) {
    if (process.platform === "win32") {
      await execFileP("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } else {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 进程已不在、忽略
      }
    }
  }
};

/**
 * 确保端口（PORT）可用。被占说明上次未退干净的服务实例还在跑——
 * 弹 dialog 让用户确认后自动杀掉、拒绝则退出 app。
 */
const ensurePortFree = async () => {
  if (!(await isPortBusy())) return true;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "端口被占用",
    message: `检测到旧版服务占用了 ${PORT} 端口`,
    detail: "点「确定」自动关闭旧服务并继续启动；点「退出」放弃本次启动。",
    buttons: ["确定", "退出"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;

  const pids = await findPortPids();
  log(`[main] 端口 ${PORT} 被占、用户确认清理 pids=${pids.join(",")}`);
  await killPids(pids);
  // 等端口释放（最多 10s、TIME_WAIT 一般秒级）
  for (let i = 0; i < 20; i++) {
    if (!(await isPortBusy())) return true;
    await sleep(500);
  }
  dialog.showErrorBox(
    "端口仍被占用",
    `${PORT} 端口没能释放、请手动关闭占用它的程序后重新打开应用。`,
  );
  return false;
};

// ---------- server 子进程 ----------

// server 用哪个二进制跑（as node）：
// - mac 打包后用 bundle 内 Helper（Info.plist 带 LSUIElement=1）——主二进制 as node
//   会被 LaunchServices 当成前台 GUI 应用、Dock 多一个绿色 exec 通用图标（v0.7.5 修）
// - 其它平台 / dev 直接用主二进制、行为不变
// ⚠️ Helper 名不能用 app.getName() 拼（test 包 productName 被 CLI 覆盖、getName 对不上、
//   v0.7.9 实测 spawn ENOENT pid=undefined）——直接扫 Frameworks 目录找「* Helper.app」
const serverNodeBin = () => {
  if (!app.isPackaged || process.platform !== "darwin") return process.execPath;
  const frameworksDir = path.join(path.dirname(process.execPath), "..", "Frameworks");
  try {
    // 主 Helper 形如「<productName> Helper.app」；GPU / Plugin / Renderer 变体
    // 结尾是「Helper (GPU).app」等、endsWith 天然排除
    const helperApp = readdirSync(frameworksDir).find((n) =>
      n.endsWith(" Helper.app"),
    );
    if (helperApp) {
      const helperName = helperApp.replace(/\.app$/, "");
      return path.join(frameworksDir, helperApp, "Contents", "MacOS", helperName);
    }
  } catch {
    // 读不到 Frameworks（异常布局）走主二进制兜底
  }
  log("[main] 没找到 Helper.app、回落主二进制跑 server（Dock 会多 exec 图标）");
  return process.execPath;
};

const startServer = () => {
  const serverJs = path.join(serverDir, "server.js");
  serverProc = spawn(serverNodeBin(), [serverJs], {
    env: {
      ...process.env,
      // 三件套：execPath 当 node 用（含孙进程继承、hooks 依赖）+ 端口 + 数据目录
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(PORT),
      HOSTNAME: HOST,
      FE_AI_FLOW_DATA_DIR: path.join(app.getPath("userData"), "data"),
    },
    // cwd 不用管：standalone server.js 启动时自己 process.chdir(__dirname)
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  log(`[main] server 启动 pid=${serverProc.pid} dataDir=${path.join(app.getPath("userData"), "data")}`);
  // spawn 本身失败（如二进制路径不存在 ENOENT）不会触发 exit、必须挂 error——
  // v0.7.9 实测 Helper 路径拼错时 pid=undefined 静默挂死、靠这里明错
  serverProc.on("error", (err) => {
    serverProc = null;
    log(`[main] server spawn 失败：${err?.message || err}`);
    if (!quitting) {
      dialog.showErrorBox("服务启动失败", `内部服务进程拉不起来：${err?.message || err}`);
      app.quit();
    }
  });
  serverProc.stdout.on("data", (d) => log(`[server] ${d}`.trimEnd()));
  serverProc.stderr.on("data", (d) => log(`[server:err] ${d}`.trimEnd()));
  serverProc.on("exit", (code) => {
    serverProc = null;
    log(`[main] server 退出 code=${code ?? "?"} quitting=${quitting}`);
    // 不是用户主动退出、说明 server 崩了——提示后整个 app 退出（窗口留着也没意义）
    if (!quitting) {
      dialog.showErrorBox(
        "服务异常退出",
        `内部服务意外退出（code=${code ?? "?"}）、请重新打开应用。`,
      );
      app.quit();
    }
  });
};

const stopServer = async () => {
  if (!serverProc) return;
  const proc = serverProc;
  serverProc = null;
  if (process.platform === "win32") {
    // win 下连进程树一起杀——server 可能挂着 SDK agent / hook 子进程
    await execFileP("taskkill", ["/PID", String(proc.pid), "/T", "/F"]);
    return;
  }
  // unix：先 SIGTERM 给 2s 优雅退出（server 自己有孤儿清理）、没退再 SIGKILL
  proc.kill("SIGTERM");
  const dead = await Promise.race([
    new Promise((r) => proc.once("exit", () => r(true))),
    sleep(2000).then(() => false),
  ]);
  if (!dead) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // 已退、忽略
    }
  }
};

// 轮询 server 直到 HTTP 200（上限默认 30s）
const waitForReady = async (timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // 还没起来、继续等
    }
    await sleep(400);
  }
  return false;
};

// ---------- 窗口（含尺寸记忆） ----------

const windowStateFile = () =>
  path.join(app.getPath("userData"), "window-state.json");

const loadWindowState = async () => {
  try {
    return JSON.parse(await fs.readFile(windowStateFile(), "utf8"));
  } catch {
    return null;
  }
};

const saveWindowState = async () => {
  if (!mainWindow) return;
  try {
    const bounds = mainWindow.getNormalBounds();
    await fs.writeFile(
      windowStateFile(),
      JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() }),
      "utf8",
    );
  } catch {
    // 记忆失败无所谓、下次用默认尺寸
  }
};

// 等 server 期间先显示的极简 loading 页（避免白屏 / 无反馈）；跟随系统深浅色、
// 避免浅色系统启动闪一下黑底。深浅背景跟应用 globals.css 的 --background 对齐。
const LOADING_BG_DARK = "#0a0a0a";
const LOADING_BG_LIGHT = "#f5f6f8";
// 自定义标题栏底色：跟应用 --background 同色。
// Windows titleBarOverlay 控制按钮条的初始底色用它、之后由页面按主题 IPC 精确同步；
// mac 走 hiddenInset、overlay 配置被忽略、这里只兜初始。
const HEADER_BG_DARK = "#17181c";
const HEADER_BG_LIGHT = "#f3f4f6";
const IS_MAC = process.platform === "darwin";
const loadingUrl = (dark) => {
  const bg = dark ? LOADING_BG_DARK : LOADING_BG_LIGHT;
  const fg = dark ? "#a1a1aa" : "#6b7280";
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><html><body style="margin:0;display:grid;place-items:center;height:100vh;background:${bg};color:${fg};font:14px system-ui">AI工作流 启动中…</body></html>`,
  )}`;
};

const createWindow = async () => {
  const st = await loadWindowState();
  // 加载期窗口底色跟随系统深浅、避免浅色系统启动闪黑（app 内主题由 next-themes 接管）
  const dark = nativeTheme.shouldUseDarkColors;
  mainWindow = new BrowserWindow({
    width: st?.width ?? 1280,
    height: st?.height ?? 800,
    x: st?.x,
    y: st?.y,
    show: false,
    autoHideMenuBar: true,
    // 接近应用背景、加载期不闪色
    backgroundColor: dark ? LOADING_BG_DARK : LOADING_BG_LIGHT,
    // 自定义标题栏（用户要 Cursor 式同色一体顶栏、消除原生灰标题栏那条异色横条）：
    // - mac：hiddenInset 隐藏原生标题栏、红黄绿浮左上、内容顶到顶；trafficLightPosition
    //   把红黄绿垂直对齐到 h-14(56px) header 中央
    // - win：hidden + titleBarOverlay 由系统画右上角窗口控制按钮、底色/图标色跟 header、
    //   高度对齐 56；运行时主题切换由页面 IPC（set-titlebar-overlay）精确同步底色
    titleBarStyle: IS_MAC ? "hiddenInset" : "hidden",
    ...(IS_MAC
      ? { trafficLightPosition: { x: 19, y: 20 } }
      : {
          titleBarOverlay: {
            color: dark ? HEADER_BG_DARK : HEADER_BG_LIGHT,
            symbolColor: dark ? "#e5e5e5" : "#404040",
            height: 56,
          },
        }),
    webPreferences: {
      // 原生文件选择器 IPC 通道（v0.7.14）——页面附文件 / 附目录走主进程
      // dialog.showOpenDialog、秒弹 + 自动聚焦、替代 osascript ~1s 冷启动
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  if (st?.maximized) mainWindow.maximize();
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", () => void saveWindowState());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // window.open 一律转系统默认浏览器、零白名单（v0.7.8 用户实测拍板）：
  // - 外链（飞书 story / MR / GitHub…）、OAuth 授权页 → 系统浏览器（v0.7.4 起）
  // - 站内 URL（AI 给的 127.0.0.1:8876/... 绝对链接、图片预览）原来 allow 开
  //   Electron 子窗——用户实测「应用内闪一下」体验差、同样转系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  // 同 frame 导航离开本应用（cursor:// deep link 跳 IDE、或意外的外部 http 链接）
  // → 拦下来交系统处理、窗口永远停在 ai-flow 页面上
  // 特例：app-update://install 是页面「新版本」标识发起的装更新指令、壳自己消费
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("app-update://")) {
      e.preventDefault();
      void installUpdateNow();
      return;
    }
    if (url.startsWith(BASE_URL) || url.startsWith("data:")) return;
    e.preventDefault();
    void shell.openExternal(url);
  });

  // 禁用浏览器默认「刷新页面」快捷键（cmd/ctrl+R、cmd+shift+R 强刷、F5）——
  // 桌面 app 不该暴露整页刷新（v0.7.21 用户拍板、dev 也禁）：误触丢输入草稿 / UI 临时态、
  // 持久化状态（task/action/chat）走 server + SSE replay 本就不受影响。精准拦这几个键、
  // 不碰 cmd+C/V/A 编辑键 / cmd+W 关窗 / cmd+Q 退出 / devtools。
  mainWindow.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key?.toLowerCase();
    const isReload = key === "f5" || ((input.meta || input.control) && key === "r");
    if (isReload) e.preventDefault();
  });

  // 页面每次加载完成（loading 页换正式页 / 首次加载）重注入版本号 + 更新标识、不丢状态
  mainWindow.webContents.on("did-finish-load", () => {
    // 版本号给设置页显示（用户要能确认「装的是不是最新版」）；web 版没壳、不显示
    mainWindow?.webContents
      .executeJavaScript(`window.__appVersion=${JSON.stringify(app.getVersion())};`)
      .catch(() => {});
    notifyPageUpdateReady();
  });

  await mainWindow.loadURL(loadingUrl(nativeTheme.shouldUseDarkColors));
};

// ---------- 原生文件选择器 IPC（v0.7.14） ----------
//
// 页面（preload 暴露的 window.__nativePicker.pick）→ 这里 → dialog.showOpenDialog。
// 大方针（用户拍板）：桌面端文件 / 目录选择全部走原生 dialog.showOpenDialog；
// 原 HTTP + osascript 兜底链路（浏览器 dev 用）已随网页版遗留一并删除。
ipcMain.handle("native-pick", async (_e, opts) => {
  const mode = opts?.mode === "folder" ? "folder" : "file";
  const multiple = opts?.multiple === true;
  const properties = [
    mode === "folder" ? "openDirectory" : "openFile",
    ...(multiple ? ["multiSelections"] : []),
  ];
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: typeof opts?.prompt === "string" ? opts.prompt.slice(0, 100) : undefined,
    properties,
  });
  if (canceled || filePaths.length === 0) return { canceled: true };
  return { paths: filePaths };
});

// ---------- 自定义标题栏：Windows 控制按钮 overlay 底色跟随主题 ----------
//
// 页面（next-themes）切换深浅色时、读应用真实 bg/fg 计算后的 rgb、IPC 过来更新
// 右上角窗口控制按钮条的底色 / 图标色。mac 走 hiddenInset、无 overlay、直接忽略。
ipcMain.on("set-titlebar-overlay", (_e, opts) => {
  if (IS_MAC || !mainWindow || !opts) return;
  try {
    mainWindow.setTitleBarOverlay({
      color: opts.color,
      symbolColor: opts.symbolColor,
      height: 56,
    });
  } catch {
    // 窗口已关 / 平台不支持时静默
  }
});

// ---------- 自动更新（win electron-updater 重启即装、mac v0.7.12 起壳内自更新） ----------

// 已就绪的新版本号（null = 无更新待装）
let updateReadyVersion = null;

// 更新动作模式：win 用 electron-updater 下载完「重启即装」；
// mac 未签名跑不了 Squirrel.Mac——v0.7.7 曾退化为「开系统浏览器下载页」、
// v0.7.12 起改壳内自更新（fetch dmg 无 quarantine + ditto 替换自身、见 macSelfUpdate）、
// 故此处 "download" 现指「壳内下载替换自身」、不再是「跳下载页」
const UPDATE_MODE = process.platform === "win32" ? "install" : "download";
const RELEASE_LATEST_URL = "https://github.com/jianger666/fe-ai-flow/releases/latest";

// 「该版本是否已弹过对话框」持久化——同一个新版本只弹一次原生弹窗、
// 之后（含重启 app 再查到同版本）只靠页面右上角「新版本」标识安静提醒
const promptedFile = () => path.join(app.getPath("userData"), "update-prompted.json");

const wasPrompted = async (version) => {
  try {
    return JSON.parse(await fs.readFile(promptedFile(), "utf8")).version === version;
  } catch {
    return false;
  }
};

const markPrompted = async (version) => {
  try {
    await fs.writeFile(promptedFile(), JSON.stringify({ version }), "utf8");
  } catch {
    // 写不进去顶多多弹一次、不影响主流程
  }
};

// 通知页面「新版本就绪」：全局变量 + CustomEvent 双通道
// （变量给 mount 晚于注入的组件读、事件给已 mount 的组件实时响应；
//  did-finish-load 时重注入、页面刷新也不丢标识）
const notifyPageUpdateReady = () => {
  if (!mainWindow || !updateReadyVersion) return;
  const js = `window.__appUpdateVersion=${JSON.stringify(updateReadyVersion)};window.__appUpdateMode=${JSON.stringify(UPDATE_MODE)};window.dispatchEvent(new Event("app-update-ready"));`;
  mainWindow.webContents.executeJavaScript(js).catch(() => {});
};

// execFile 的「失败要 throw」版（自更新链路用、跟 fail-open 的 execFileP 区分）
const execFileStrict = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });

// mac 应用内自更新（v0.7.12）：壳自己下载 dmg → 替换 /Applications 里的自己 → 重启生效。
// 关键原理：quarantine 隔离标记只有浏览器等下载器会打、壳进程 fetch 落盘的文件没有
// → Gatekeeper 不评估 → 免开发者证书实现「类自动更新」、解决用户实测痛点
// 「每版都要去 系统设置→隐私与安全性 放行 + 输密码」。
const macSelfUpdate = async (version) => {
  const dmgUrl = `https://github.com/jianger666/fe-ai-flow/releases/download/v${version}/fe-ai-flow-${version}-mac-arm64.dmg`;
  // 当前 .app 包路径：execPath = <app>.app/Contents/MacOS/<bin>、往上三层
  const appPath = path.resolve(process.execPath, "..", "..", "..");
  if (!appPath.endsWith(".app") || appPath.startsWith("/Volumes/")) {
    // 非常规安装位置（如直接在 dmg 里跑）、替换无意义 → 降级开下载页
    void shell.openExternal(RELEASE_LATEST_URL);
    return;
  }
  const updatesDir = path.join(app.getPath("userData"), "updates");
  const dmgPath = path.join(updatesDir, `v${version}.dmg`);
  const mountPoint = path.join(updatesDir, `mnt-${Date.now()}`);
  try {
    mkdirSync(updatesDir, { recursive: true });
    log(`[updater] 下载 ${dmgUrl}`);
    const res = await fetch(dmgUrl);
    if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
    // 流式落盘 + Dock 图标进度条（dialog 没法动态刷、原生进度条够用）
    const total = Number(res.headers.get("content-length")) || 0;
    const ws = createWriteStream(dmgPath);
    let got = 0;
    for await (const chunk of res.body) {
      if (!ws.write(chunk)) await new Promise((r) => ws.once("drain", r));
      got += chunk.length;
      if (total && mainWindow) mainWindow.setProgressBar(got / total);
    }
    await new Promise((resolve, reject) =>
      ws.end((err) => (err ? reject(err) : resolve(undefined))),
    );
    mainWindow?.setProgressBar(-1);

    await execFileStrict("hdiutil", [
      "attach", dmgPath, "-nobrowse", "-quiet", "-mountpoint", mountPoint,
    ]);
    const newApp = readdirSync(mountPoint).find((n) => n.endsWith(".app"));
    if (!newApp) throw new Error("dmg 里没找到 .app");

    // 替换：旧 app 先挪到暂存（userData 跟 /Applications 同卷、rename 原子）、
    // ditto 新 app 就位（保留签名 / 权限 / xattr）、失败回滚旧的
    const stagedOld = path.join(updatesDir, `old-${Date.now()}.app`);
    log(`[updater] 替换 ${appPath}`);
    await fs.rename(appPath, stagedOld);
    try {
      await execFileStrict("ditto", [path.join(mountPoint, newApp), appPath]);
    } catch (err) {
      await fs.rename(stagedOld, appPath).catch(() => {});
      throw err;
    }
    await fs.rm(stagedOld, { recursive: true, force: true }).catch(() => {});

    log(`[updater] v${version} 已就位、等用户重启`);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "更新完成",
      message: `已更新到 v${version}`,
      detail: "重启应用后生效。",
      buttons: ["立即重启", "稍后"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      quitting = true;
      app.relaunch();
      app.quit();
    }
  } catch (err) {
    log(`[updater] 自更新失败：${err?.message || err}、降级开下载页`);
    dialog.showErrorBox(
      "自动更新失败",
      `${err?.message || err}\n\n将打开下载页、请手动下载安装。`,
    );
    void shell.openExternal(RELEASE_LATEST_URL);
  } finally {
    mainWindow?.setProgressBar(-1);
    // detach / 清 dmg 都 fail-open（没挂上 / 已弹出都无所谓）
    await execFileP("hdiutil", ["detach", mountPoint, "-quiet"]);
    await fs.rm(dmgPath, { force: true }).catch(() => {});
  }
};

// 应用更新（页面点「新版本」标识、或对话框确认走到这）：
// win 重启即装（before-quit 兜底杀 server、不留孤儿）；mac 壳内下载替换自身
const installUpdateNow = async () => {
  if (!updateReadyVersion) return;
  if (UPDATE_MODE === "download") {
    log(`[updater] mac 自更新开始（v${updateReadyVersion}）`);
    await macSelfUpdate(updateReadyVersion);
    return;
  }
  log(`[updater] 用户确认、重启安装 v${updateReadyVersion}`);
  const { default: updater } = await import("electron-updater");
  updater.autoUpdater.quitAndInstall();
};

// 「发现新版本」对话框（win / mac 文案、按钮行为不同、弹一次的记账共用）
const promptUpdateOnce = async (version, { message, detail, confirmLabel }) => {
  if (await wasPrompted(version)) return;
  await markPrompted(version);
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "发现新版本",
    message,
    detail,
    buttons: [confirmLabel, "稍后"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await installUpdateNow();
};

// mac：查 GitHub latest release 的版本号——请求 /releases/latest 拿 302 的
// location（…/releases/tag/vX.Y.Z）抠版本、不走 API 不吃 rate limit
const fetchLatestVersion = async () => {
  const res = await fetch(RELEASE_LATEST_URL, { redirect: "manual" });
  const loc = res.headers.get("location") || "";
  const m = loc.match(/\/tag\/v(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
};

// 三段式版本比较：a 比 b 新返回 true
const isNewer = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
};

// 每 2 小时轮询一次更新——app 长期开着不关（同事习惯）也能收到新版提醒、
// 不止在启动时查一次（v0.7.22）。同版本只弹一次靠 promptUpdateOnce 的 wasPrompted 去重。
const UPDATE_POLL_MS = 2 * 60 * 60 * 1000;

// win electron-updater 单例：首次 setup 时初始化 + 注册事件、轮询复用、不重复注册监听器
let winAutoUpdater = null;

// 查一次更新（启动 + 每 2h 轮询都走这）。win 触发后台下载、下载完走 update-downloaded 事件；
// mac 查版本号比对、有新版直接提醒。同版本重复查只刷新页面标识、不重复弹窗（wasPrompted 去重）。
const runUpdateCheck = async () => {
  try {
    if (process.platform === "win32") {
      // 查更新 + 自动后台下载（autoDownload 默认 true）、下载完走 update-downloaded 事件
      if (winAutoUpdater) await winAutoUpdater.checkForUpdates();
      return;
    }
    // mac：查版本号、有新版提醒「应用内自更新」（壳下载 dmg 替换自身、v0.7.12）
    const latest = await fetchLatestVersion();
    const current = app.getVersion();
    if (!latest || !isNewer(latest, current)) return;
    updateReadyVersion = latest;
    log(`[updater] 发现新版本 v${latest}（当前 v${current}）`);
    notifyPageUpdateReady();
    await promptUpdateOnce(latest, {
      message: `新版本 v${latest} 已发布`,
      detail: "点「立即更新」自动下载安装（Dock 图标显示进度）、完成后重启生效、数据不丢。点「稍后」的话、随时点页面右上角「新版本」标识。",
      confirmLabel: "立即更新",
    });
  } catch (err) {
    // 更新失败不影响正常使用（如离线 / GitHub 不可达）
    log(`[updater] 检查更新失败（忽略）${err?.message || err}`);
  }
};

const setupAutoUpdate = async () => {
  // 测试实例版本号永远是 0.0.0-dev、查更新必弹「发现新版本」、纯骚扰——跳过
  if (!app.isPackaged || IS_TEST) return;
  // win：初始化 electron-updater + 注册「下载就绪 / 出错」事件（仅一次、轮询不重注册、防监听器泄漏）
  if (process.platform === "win32") {
    try {
      // electron-updater 是 CJS、ESM 下走 default 再解构最稳
      const { default: updater } = await import("electron-updater");
      winAutoUpdater = updater.autoUpdater;
      winAutoUpdater.on("update-downloaded", async (info) => {
        updateReadyVersion = info?.version || "";
        log(`[updater] 新版本 v${updateReadyVersion} 已下载就绪`);
        notifyPageUpdateReady();
        await promptUpdateOnce(updateReadyVersion, {
          message: `新版本 v${updateReadyVersion} 已下载完成`,
          detail: "可以立即重启更新；点「稍后」的话、随时点页面右上角「新版本」标识更新。",
          confirmLabel: "立即重启更新",
        });
      });
      winAutoUpdater.on("error", (err) => log(`[updater] ${err?.message || err}`));
    } catch (err) {
      log(`[updater] electron-updater 初始化失败（忽略）${err?.message || err}`);
    }
  }
  // 启动先查一次、之后每 2h 轮询一次（app 长期不关也能收到新版提醒）
  await runUpdateCheck();
  setInterval(() => void runUpdateCheck(), UPDATE_POLL_MS);
};

// ---------- 生命周期 ----------

// 单实例锁：二开时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    log(`[main] app 启动 version=${app.getVersion()} packaged=${app.isPackaged} userData=${app.getPath("userData")}`);
    // server 布局缺失（dev 没组包 / 打包配置坏了）直接明错、不静默
    try {
      await fs.access(path.join(serverDir, "server.js"));
    } catch {
      dialog.showErrorBox(
        "缺少内置服务文件",
        `没找到 ${path.join(serverDir, "server.js")}\n\n本地验证请先跑：\nBUILD_STANDALONE=1 pnpm build && node scripts/assemble-electron-server.mjs`,
      );
      app.quit();
      return;
    }

    if (!(await ensurePortFree())) {
      app.quit();
      return;
    }

    await createWindow();
    startServer();
    void setupAutoUpdate();

    if (await waitForReady()) {
      // 等待期间用户可能已手动关窗
      if (mainWindow) await mainWindow.loadURL(BASE_URL);
    } else {
      dialog.showErrorBox(
        "启动超时",
        "内部服务 30 秒内没有就绪、请关闭应用重试。",
      );
      quitting = true;
      await stopServer();
      app.quit();
    }
  });

  // 关窗即退（mac 也不留 dock 常驻——服务跟窗口同生共死、行为跨平台一致）
  app.on("window-all-closed", async () => {
    log("[main] 所有窗口关闭、停 server 并退出");
    quitting = true;
    await stopServer();
    app.quit();
  });

  // 兜底：任何退出路径（含 autoUpdater quitAndInstall）都别留 server 孤儿
  app.on("before-quit", () => {
    quitting = true;
    if (serverProc) {
      try {
        serverProc.kill("SIGKILL");
      } catch {
        // 已退、忽略
      }
    }
  });
}
