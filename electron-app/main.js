/**
 * fe-ai-flow Electron 壳（V0.7.0）
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
import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8876;
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

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

// execFile 的 promise 包装、出错返空串（探测类调用都 fail-open）
const execFileP = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) =>
      resolve(err ? "" : String(stdout)),
    );
  });

// ---------- 端口冲突处理 ----------

// 探 8876 是否被占（能建立 TCP 连接 = 有进程在听）
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

// 找出监听 8876 的进程 PID（win 解析 netstat、mac/linux 用 lsof）
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
 * 确保 8876 可用。被占说明旧绿色包服务（或上次未退干净的实例）还在跑——
 * 弹 dialog 让用户确认后自动杀掉、拒绝则退出 app。
 */
const ensurePortFree = async () => {
  if (!(await isPortBusy())) return true;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "端口被占用",
    message: "检测到旧版 fe-ai-flow 服务占用了 8876 端口",
    detail: "点「确定」自动关闭旧服务并继续启动；点「退出」放弃本次启动。",
    buttons: ["确定", "退出"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;

  await killPids(await findPortPids());
  // 等端口释放（最多 10s、TIME_WAIT 一般秒级）
  for (let i = 0; i < 20; i++) {
    if (!(await isPortBusy())) return true;
    await sleep(500);
  }
  dialog.showErrorBox(
    "端口仍被占用",
    "8876 端口没能释放、请手动关闭占用它的程序后重新打开应用。",
  );
  return false;
};

// ---------- server 子进程 ----------

const startServer = () => {
  const serverJs = path.join(serverDir, "server.js");
  serverProc = spawn(process.execPath, [serverJs], {
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
  serverProc.stdout.on("data", (d) => console.log(`[server] ${d}`.trimEnd()));
  serverProc.stderr.on("data", (d) => console.error(`[server] ${d}`.trimEnd()));
  serverProc.on("exit", (code) => {
    serverProc = null;
    // 不是用户主动退出、说明 server 崩了——提示后整个 app 退出（窗口留着也没意义）
    if (!quitting) {
      dialog.showErrorBox(
        "服务异常退出",
        `fe-ai-flow 内部服务意外退出（code=${code ?? "?"}）、请重新打开应用。`,
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

// 等 server 期间先显示的极简 loading 页（避免白屏 / 无反馈）
const LOADING_URL = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><html><body style="margin:0;display:grid;place-items:center;height:100vh;background:#0a0a0a;color:#a1a1aa;font:14px system-ui">fe-ai-flow 启动中…</body></html>`,
)}`;

const createWindow = async () => {
  const st = await loadWindowState();
  mainWindow = new BrowserWindow({
    width: st?.width ?? 1280,
    height: st?.height ?? 800,
    x: st?.x,
    y: st?.y,
    show: false,
    autoHideMenuBar: true,
    // 接近应用 dark 背景、加载期不白闪
    backgroundColor: "#0a0a0a",
  });
  if (st?.maximized) mainWindow.maximize();
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", () => void saveWindowState());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 浏览器 tab 行为对齐：
  // - MCP OAuth 弹窗（about:blank 起手再跳授权页）→ 允许开 Electron 子窗、
  //   保住 window.opener.postMessage 回传链路（callback 页靠它通知主窗刷新）
  // - 其它 target=_blank 外链（飞书 story / MR / GitHub…）→ 系统默认浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === "about:blank" || url.startsWith(BASE_URL)) {
      return { action: "allow" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });
  // 同 frame 导航离开本应用（cursor:// deep link 跳 IDE、或意外的外部 http 链接）
  // → 拦下来交系统处理、窗口永远停在 fe-ai-flow 页面上
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(BASE_URL) || url.startsWith("data:")) return;
    e.preventDefault();
    void shell.openExternal(url);
  });

  await mainWindow.loadURL(LOADING_URL);
};

// ---------- 自动更新（仅 win、mac 未签名跑不了） ----------

const setupAutoUpdate = async () => {
  if (!app.isPackaged || process.platform !== "win32") return;
  try {
    // electron-updater 是 CJS、ESM 下走 default 再解构最稳
    const { default: updater } = await import("electron-updater");
    // 查更新 + 后台下载 + 下载完系统通知、用户重启 app 时装新版
    await updater.autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    // 更新失败不影响正常使用（如离线 / GitHub 不可达）
    console.error("[updater] 检查更新失败（忽略）", err);
  }
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
