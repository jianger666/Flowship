/**
 * Flowship Electron 壳（V0.7.0）
 *
 * 职责（保持薄壳、业务全在 Next server 里）：
 * 1. 起内置 Next standalone server（spawn 自带 node 运行时、ELECTRON_RUN_AS_NODE）
 * 2. 等 server 就绪后开 BrowserWindow 指向 http://127.0.0.1:8876
 * 3. 关窗不退出（hide）；有菜单栏/托盘图标时可点回来，真退出走 Tray 菜单 / Cmd+Q → 杀 server
 * 4. win 自动更新（electron-updater + GitHub Releases 的 latest.yml）
 * 5. 自定义协议深链 flowship://（test 实例 flowship-test://）路由到任务页
 *
 * 关键链路（V0.7-ELECTRON-PLAN §3.2）：
 * - ELECTRON_RUN_AS_NODE=1 让 process.execPath 表现为 node、且被孙进程继承——
 *   打包后的 server / 子进程以 node 模式跑、不会弹出新的 app 窗口
 * - FLOWSHIP_DATA_DIR 指向系统 userData——数据不落只读的 resources 目录、
 *   更新 / 卸载重装都不丢（目录名仍是 fe-ai-flow、只是 env 改名、用户数据不动）
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerSaveBlocker,
  shell,
  Tray,
} from "electron";
import { spawn, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  promises as fs,
  mkdirSync,
  createReadStream,
  createWriteStream,
  readdirSync,
  existsSync,
  readFileSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Windows 静默更新门禁：不再传 /D=（注册表 InstallLocation 为准，含空格路径引号
// bug 整个类别消失）；Temp 兜底见 ./win-install-dir.mjs，标记门禁 + 墓碑见 ./win-update-guard.mjs
import { isUnsafeWinInstallDir } from "./win-install-dir.mjs";
import {
  WIN_UPDATE_ATTEMPT_FILE,
  buildSpaceBlockedMessage,
  buildUpdateFailedMessage,
  buildWinUpdateAttempt,
  classifyWinUpdateAttempt,
  findInstallerAbort,
  hasSilentUpdateMarker,
} from "./win-update-guard.mjs";
// 更新 manifest 验签的纯函数部分（mac dmg / Windows exe 共用、可用真实密钥对单测）：./update-manifest-verify.mjs。
// IO（读公钥 / 取 manifest / 实测 size 与 SHA-256）仍在本文件的 verifyDownloadedUpdate。
import {
  UpdateVerifyUnavailableError,
  buildGenericUpdateFailureNotice,
  buildVerifyRejectionNotice,
  fetchUpdateManifest,
  findSignedManifestEntry,
  isVerifyFailure,
  pickWinInstallerAssetName,
  verifyManifestEntry,
} from "./update-manifest-verify.mjs";
// Windows 待装 exe 的安装前验签门禁（依赖注入的纯函数、可真调用单测）：./win-pending-verify.mjs
import { verifyWinPendingInstallerWith } from "./win-pending-verify.mjs";
// mac 自动暂存失败后的重试策略（确定性失败永久跳过、其余一律按时间退避、连续 3 次提示一次、同版本「会白下 dmg 的失败」累计 3 次后轮询放弃自动暂存（累计 ≠ 严格连续：成功暂存 / 换版本才清零）；
// 纯函数、有单测）：./update-verify-retry.mjs
import {
  buildRepeatedFailureNotice,
  isPermanentVerifyFailure,
  isVerifyRetryBlocked,
  nextCostlyFailureRecord,
  nextVerifyRetry,
  shouldGiveUpAutoStage,
  shouldPromptRepeatedFailure,
} from "./update-verify-retry.mjs";
// 外链 / 导航协议白名单（纯函数、可单测）：./external-url.mjs
import {
  isCanonicalAppOrigin,
  isIdeDeepLink,
  isSafeExternalUrl,
  isSafeMailtoUrl,
  isSameAppOrigin,
} from "./external-url.mjs";
// 磁盘剩余空间换算 + 静默更新预检（statfs 注入以便在 Mac 上单测）：纯函数在 ./disk-space.mjs。
// 预检阈值 MIN_TEMP_FREE_MB 是唯一的 JS 侧来源（弹框文案也读它），与 installer.nsh 的 define 由测试对账。
import {
  MIN_TEMP_FREE_MB,
  assertMacStageSpace,
  bytesToMB,
  checkUpdateTempSpace,
  formatFreeGB,
  freeBytes,
} from "./disk-space.mjs";
// 数据目录所在盘的低空间监视（< 2GB 系统通知、每 30 分钟一次；R14 B2-4b / Q15-10 壳部分）：判定 / 文案 / 阈值在 ./disk-watch.mjs
import {
  DISK_CHECK_INTERVAL_MS,
  buildLowDiskNotice,
  classifyDiskLevel,
  decideDiskNotice,
  emptyDiskNoticeState,
} from "./disk-watch.mjs";
// mac dmg 流式落盘（stream.pipeline：写盘失败 = reject 并销毁整条链，不再挂住 stagingPromise；R14 B2-4 / Q15-01）：./dmg-download.mjs
import { streamResponseToFile } from "./dmg-download.mjs";
// 壳日志 main.log 的写入器（写流 error 有监听、失败自愈 / 降级、按大小轮转；R14 B2-4b / Q15-03）：./shell-log.mjs
import { createShellLogger } from "./shell-log.mjs";
// 崩溃处置的决策与文案（server 退出：(code, signal)、自动重启一次、弹窗按钮；渲染 / 子进程退出）：纯函数、有单测：./shell-crash.mjs
import {
  BUTTON_OPEN_LOGS,
  BUTTON_OPEN_REPORTS,
  BUTTON_RELOAD,
  buildRenderGoneNotice,
  buildServerCrashNotice,
  decideRenderGone,
  decideServerExit,
  describeChildGone,
  describeExit,
  describeRenderGone,
  pickFreshReports,
} from "./shell-crash.mjs";
// 首次启动判定（标记按版本记、更新后的第一次启动同样按「首次」给宽限）：纯函数在 ./first-boot.mjs
import {
  REGULAR_BOOT_TIMEOUT_MS,
  buildFirstBootMarker,
  pickBootTimeoutMs,
  shouldTreatAsFirstBoot,
} from "./first-boot.mjs";
// 首次启动并行预读（把 server 串行冷读的「N×L」摊成并发，清单由构建期录好）：纯函数在 ./boot-prefetch.mjs
import {
  BOOT_MANIFEST_FILENAME,
  formatPrefetchSummary,
  formatReadProbe,
  parseBootManifest,
  runPrefetch,
  runReadProbe,
  shouldPrefetch,
} from "./boot-prefetch.mjs";
// 启动诊断（时间线 / 主线程卡顿 / 首页请求明细）与 Windows 机器环境取证（盘介质 / Defender / 电源）：
// 都只观察不改行为，结果在首页亮出后一次性写进 main.log；纯函数在 ./boot-diag.mjs、./env-probe.mjs
import {
  createBootTimeline,
  createLagMonitor,
  createRequestRecorder,
  formatLagSummary,
  formatRequestSummary,
} from "./boot-diag.mjs";
import {
  ENV_PROBE_TIMEOUT_MS,
  buildEnvProbeScript,
  decideEnvProbe,
  describeEnvProbe,
  driveLetterOf,
  parseEnvProbe,
} from "./env-probe.mjs";
// 杀软清单探测（脚本 + 解析，PowerShell 输出 Base64 避开 OEM 代码页乱码）：纯函数在 ./security-products.mjs
import {
  SECURITY_PROBE_SCRIPT,
  SECURITY_PROBE_TIMEOUT_MS,
  describeSecurityProbe,
  parseSecurityProbe,
} from "./security-products.mjs";
// 防后台节流实验开关（v1.9.28、默认关）：纯函数在 ./app-nap.mjs（单测直接 import）
import { APP_NAP_MARKER, resolveAppNapMode } from "./app-nap.mjs";
// server 子进程的 Node 启动旗标（堆上限 + 崩溃取证，走 argv 而不是 NODE_OPTIONS）：./node-options.mjs
import { buildServerNodeArgs } from "./node-options.mjs";
// 系统通知 payload 解析（taskId / target:"inbox" 点击去向，N1-12）：./notify-target.mjs
import { parseNotifyPayload } from "./notify-target.mjs";

// 测试实例（v0.7.9 用户拍板）：本地验证打包 app 时用 `pnpm electron:dist:test`
// 产出「FlowshipTest」、自动走独立端口 + 独立数据目录、跟用户日常在用的正式实例
// （8876 + fe-ai-flow）互不干扰、也不会被单实例锁互踢（锁按 userData 算）
// ⚠️ 探测不能用 app.getName()：-c.productName 只改包名 / Info.plist、不改 asar 内
// package.json、getName() 拿到的还是正式名（实测踩坑）——看可执行文件名最可靠
const IS_TEST =
  process.env.FLOWSHIP_TEST === "1" ||
  path.basename(process.execPath).toLowerCase().includes("test");

// 自定义协议：正式 flowship / test flowship-test——两套 scheme 避免同机正式+test
// 抢注册（决策 #18）；URL 形如 flowship://tasks/<taskId>
const PROTOCOL_SCHEME = IS_TEST ? "flowship-test" : "flowship";

const PORT = Number(process.env.FLOWSHIP_PORT) || (IS_TEST ? 8776 : 8876);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

// ── 防后台节流实验开关（v1.9.28、默认关）──────────────────────────────
// 假设：窗口被遮挡 / 最小化 / 系统判定空闲时，macOS App Nap 与 Chromium 后台节流会拖慢
// 渲染进程的定时器 / rAF（流式渲染追赶）和主进程定时器、造成「切回来第一条消息」偏慢。
// 没有数据证明——所以只做实验开关：开启 = 渲染进程 backgroundThrottling=false +
// powerSaveBlocker('prevent-app-suspension')；代价是后台耗电略增（不阻止显示器休眠）。
// 是否有收益由 run-perf.jsonl 的 appNap 字段做 A/B 对比。
// 开启（重启生效）：userData 下建空文件 PREVENT_APP_NAP，或环境变量 FLOWSHIP_PREVENT_APP_NAP=1。
let appNapModeCache = null;
const getAppNapMode = () => {
  if (!appNapModeCache) {
    appNapModeCache = resolveAppNapMode(
      process.env,
      existsSync(path.join(app.getPath("userData"), APP_NAP_MARKER)),
    );
  }
  return appNapModeCache;
};

let appNapBlockerId = null;
const applyAppNapGuard = () => {
  const mode = getAppNapMode();
  if (!mode.enabled) {
    log(
      `[main] 防后台节流实验=关（默认）；开启：在 userData 下建空文件 ${APP_NAP_MARKER} 或设 FLOWSHIP_PREVENT_APP_NAP=1，重启生效`,
    );
    return;
  }
  try {
    appNapBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    log(
      `[main] 防后台节流实验=开（来源=${mode.source}） powerSaveBlocker id=${appNapBlockerId} ` +
        `started=${powerSaveBlocker.isStarted(appNapBlockerId)} 渲染进程 backgroundThrottling=false`,
    );
  } catch (err) {
    log(`[main] 防后台节流启动失败（不影响使用）：${err?.message || err}`);
  }
};

// 站内 URL 必须按 origin 精确比对——`url.startsWith(BASE_URL)` 会被
// `http://127.0.0.1:8876@evil/` / `:88760/` / `.attacker.tld/` 前缀绕过（审查发现）
// （判定本身在 ./external-url.mjs、有单测；这里只绑定本实例的 host / port）
const isAppUrl = (url) => isSameAppOrigin(url, { host: HOST, port: PORT });
// 本应用 origin 的「精确」判定（will-navigate 用）：isAppUrl 还认 localhost / [::1] 等回环别名，
// 别名要拦、不能放行同 frame 导航（见 external-url.mjs 的 isSameAppOrigin 注释）
const isCanonicalAppUrl = (url) => isCanonicalAppOrigin(url, { host: HOST, port: PORT });

// 外链白名单（isSafeExternalUrl、定义见 ./external-url.mjs）：http(s) + 系统设置深链，
// setWindowOpenHandler 与 IPC open-external 共用，避免 window.open / IPC 成任意协议跳板。
// IDE deep link（cursor:// / vscode://）只走同 frame 导航、由 will-navigate 单独放行 isIdeDeepLink，
// 不进这份通用白名单（grep 确认 src/ 里没有 window.open / IPC 去开 IDE 协议）；
// mailto 同理：只由 will-navigate 按 isSafeMailtoUrl 的严格形态放行。

// userData 钉死在 fe-ai-flow（默认跟 productName 走）——显示名从「AI工作流」改成
// 「Flowship」（v1.1.0）或以后再改名、数据目录都不漂移、用户任务数据不丢；测试实例独立目录防污染
app.setPath(
  "userData",
  path.join(app.getPath("appData"), IS_TEST ? "fe-ai-flow-test" : "fe-ai-flow"),
);

// Windows 系统通知要求进程有 AppUserModelID 才能归属到本 app（图标 / 名字正确显示）、
// 跟 electron-builder 的 appId 保持一致；mac 不需要、API 本身也是 win-only
if (process.platform === "win32") {
  app.setAppUserModelId("com.jianger.fe-ai-flow");
}

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
// 主窗口（真销毁后置 null；关窗 hide 时仍保留引用）
let mainWindow = null;
// 系统托盘（决策 #19：关窗不退出、驻留菜单栏 / 托盘）
let appTray = null;
// 主动退出标记——区分「真退出」和「server 自己崩了」；关窗 hide 不置位
let quitting = false;
// 冷启动深链暂存（坑 #15：open-url / argv 可能早于窗口 ready）
let pendingDeepLinkTaskId = null;
// 主窗目标页是否已 load 完（R1-10：mainWindow 非 null 但 loadURL 前/中 send 会丢）
let pageLoaded = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 落盘日志 ----------
// 打包后的 app 没有终端、server stdout / 生命周期事件全落 userData/logs/main.log、
// 出问题（启动失败 / server 崩 / 数据目录异常）有据可查。
// R14 B2-4b / Q15-03：写入器在 shell-log.mjs——写流的 error 有监听（磁盘满 / 权限被收不再变成「A JavaScript error」）、
// 失败后丢弃坏流并自愈、连续失败降级（暂存内存、到点重试）、按大小轮转（旧版一份文件长了 4.5 个月、84MB）。
// log(...args) 的签名与行格式与改前一致。
const shellLogger = createShellLogger({
  getLogFile: () => path.join(app.getPath("userData"), "logs", "main.log"),
});
const log = shellLogger.log;
// stdout / stderr 的 EPIPE：从终端 / 管道启动、对端关掉后 console.log 会异步 emit 'error'，没有监听就是 uncaughtException。
// 日志已经落盘，这里吞掉即可；监听里不能再 console.log（会递归）。
for (const stream of [process.stdout, process.stderr]) stream?.on?.("error", () => {});
// 主进程未捕获异常：这里只**记录**，不改变默认处置——Electron 仍会弹「A JavaScript error occurred in the main process」，致命错误不被吞。
// 未处理的 Promise rejection **不在**这条的覆盖范围内：Electron 主进程对它是 warn、不转成 uncaughtException
// （electron#36829，Electron 22 时代的结论；Electron 42 上没有验证），所以 Monitor 多半看不到、main.log 里也不会有。
// 也故意没有补一个 'unhandledRejection' 的「只记录」监听：一挂上，默认处置（warn 还是转 uncaught）就被换成静默，
// 这个行为变化没法在真机上验证，不值得换（B2-4b 终审 P3-2，拍板见 HANDOFF）。
// 故意用 Monitor、不装 'uncaughtException' / 'unhandledRejection' 处理器：后者一挂上，默认处置就被换掉，得自己决定退不退、弹不弹。
// 用同步追加（logSync）：进程可能下一刻就没了，异步流写不一定来得及。
process.on("uncaughtExceptionMonitor", (err, origin) => {
  shellLogger.logSync(`[fatal] ${origin}: ${err?.stack || err}`);
});

// execFile 的 promise 包装、出错返空串（探测类调用都 fail-open）
const execFileP = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) =>
      resolve(err ? "" : String(stdout)),
    );
  });

// 目录所在盘的剩余空间（GB、一位小数）；取不到记 "?"。
// Windows「装不上 / 更新后 App 没了 / 启动慢」常和系统盘快满有关（安装峰值要在 %TEMP% 所在盘
// 落约 565MB），日志里留个底，事后才能证实或排除这条线索。
// 单位换算在 ./disk-space.mjs（纯函数 + 单测）：这里不再内联——差 1024 倍的写错没人看得出来。
const diskFreeGB = (dir) => formatFreeGB(dir, statfsSync);

// 启动慢到什么程度才去查杀软清单（常规机器 server 就绪 <2s，超过 30s 基本只能是 IO / 杀软在拦）
const SLOW_BOOT_PROBE_MS = 30_000;

// Windows 安全中心登记的杀软清单（WMI SecurityCenter2）。
// 只在「启动偏慢」时跑一次、后台、10s 超时；纯取证、结果只进日志、不影响任何行为。
// 脚本与解析在 ./security-products.mjs：PowerShell 输出 Base64（stdout 走 OEM 代码页、中文杀软名会乱码），
// 并把「没登记 / 查询失败（如 Server 版没有该命名空间）/ 超时 / 拉不起 PowerShell」分开记，日志才能回答「为什么没清单」。
// 幂等：「启动偏慢」和「首次启动的启动报告」两条路径都会调，同一次运行只查一次。
let securityProbeStarted = false;
const logSecurityProducts = async (why = "slow-boot") => {
  if (process.platform !== "win32") return;
  if (securityProbeStarted) return;
  securityProbeStarted = true;
  const probe = await new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SECURITY_PROBE_SCRIPT],
      { windowsHide: true, timeout: SECURITY_PROBE_TIMEOUT_MS },
      (err, stdout) => resolve(parseSecurityProbe(err, stdout)),
    );
  });
  log(`[main] 杀软清单（trigger=${why}、慢启动阈值 ${SLOW_BOOT_PROBE_MS / 1000}s）：${describeSecurityProbe(probe)}`);
};

// ---------- 启动诊断（只观察、不改行为） ----------
// 为什么：Windows 慢机器的「启动慢 / 首页慢」要分清慢在 Electron 自己起来、server 冷启动、还是首页冷读，
// 光靠几条零散日志做不到。这里统一用「距主进程启动的秒数」打里程碑，首页亮出后 6s 一次性出报告。
// 报告写 main.log（[boot] 前缀；诊断包带 main.log 尾部）。纯函数与单测在 ./boot-diag.mjs、./env-probe.mjs。
const bootTimeline = createBootTimeline();
const lagMonitor = createLagMonitor();
const requestRecorder = createRequestRecorder();
// 首页亮出后多久出报告：留一小段让亮窗后的首批数据请求也进统计
const BOOT_REPORT_DELAY_MS = 6_000;
let bootReportScheduled = false;
let bootReported = false;
// 本次是否「首次启动」（whenReady 里赋值；报告里带上，区分冷 / 热启动的数据）
let bootIsFirst = false;

// 只挂「被动通知」类事件（onSendHeaders / onResponseStarted / onCompleted / onErrorOccurred 都没有回调、
// 不会拦截或延迟任何请求）；刻意不用 onBeforeRequest（它要主进程回调放行，会给每个请求加一次往返）。
const installRequestRecorder = () => {
  try {
    const ses = mainWindow?.webContents?.session;
    if (!ses) return;
    const filter = { urls: [`${BASE_URL}/*`] };
    ses.webRequest.onSendHeaders(filter, (d) => requestRecorder.start(d.id, d.url, d.resourceType));
    ses.webRequest.onResponseStarted(filter, (d) =>
      requestRecorder.responseStarted(d.id, d.statusCode, d.fromCache),
    );
    ses.webRequest.onCompleted(filter, (d) => requestRecorder.finish(d.id));
    ses.webRequest.onErrorOccurred(filter, (d) => requestRecorder.finish(d.id, { error: d.error }));
  } catch (err) {
    log(`[boot] 请求记录器安装失败（忽略）：${err?.message || err}`);
  }
};

// Windows 机器环境（盘是 SSD 还是机械盘 / Defender 实时防护 / 电源计划 / CPU 频率 / 电池）。
// 后台、10~20s 超时自杀、只读。非 Windows 直接返回。
const logEnvProbe = async () => {
  if (process.platform !== "win32") return;
  const drives = [
    ...new Set(
      [process.execPath, app.getPath("userData"), os.tmpdir()].map(driveLetterOf).filter(Boolean),
    ),
  ];
  const result = await new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", buildEnvProbeScript({ drives })],
      { windowsHide: true, timeout: ENV_PROBE_TIMEOUT_MS },
      (err, stdout) => resolve(parseEnvProbe(err, stdout)),
    );
  });
  for (const line of describeEnvProbe(result)) log(`[boot] env ${line}`);
};

// 一次性启动报告（首页亮出后 BOOT_REPORT_DELAY_MS 触发）。每一块各自 try/catch：任何一块出错不影响其它块。
const emitBootReport = async (revealSource) => {
  if (bootReported) return;
  bootReported = true;
  lagMonitor.stop();
  log(`[boot] timeline firstBoot=${bootIsFirst} revealSource=${revealSource ?? "?"} ${bootTimeline.summary()}`);
  try {
    log(`[boot] ${formatLagSummary(lagMonitor.snapshot())}`);
  } catch {
    /* 取证失败不挡任何事 */
  }
  try {
    for (const line of formatRequestSummary(requestRecorder.snapshot())) log(`[boot] ${line}`);
  } catch {
    /* 同上 */
  }
  try {
    const gpu = app.getGPUFeatureStatus();
    log(
      `[boot] gpu ${Object.entries(gpu)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`,
    );
  } catch {
    /* 同上 */
  }
  try {
    const procs = app
      .getAppMetrics()
      .map(
        (m) =>
          `${m.type}:cpu=${(m.cpu?.percentCPUUsage ?? 0).toFixed(1)}%/mem=${Math.round((m.memory?.workingSetSize ?? 0) / 1024)}MB`,
      )
      .join(" ");
    log(`[boot] procs ${procs}`);
  } catch {
    /* 同上 */
  }
  // 以下是 PowerShell 取证：放在页面亮出之后、串行跑，不跟首页渲染抢 CPU / 磁盘。
  // 杀软清单：启动没超过慢阈值时原来不查，但「首次启动」要有它才能把杀软和慢对上号。
  try {
    if (bootIsFirst) await logSecurityProducts("first-boot");
    // 机器环境取证只在「首次启动 / 这次启动偏慢」时跑（判定见 env-probe.mjs 的 decideEnvProbe）：
    // 应用没签名，正常启动每次都拉起 PowerShell 容易被公司电脑的杀软 / EDR 报警，而且那时拿到数据也没用。
    // 跳过时留一行，日志里才分得清「没跑」和「没查到」。
    const envProbe = decideEnvProbe({
      firstBoot: bootIsFirst,
      revealSeconds: bootTimeline.get("reveal"),
      slowMs: SLOW_BOOT_PROBE_MS,
    });
    if (process.platform === "win32") {
      const revealS = bootTimeline.get("reveal");
      log(
        envProbe.run
          ? `[boot] env 探测 trigger=${envProbe.why}`
          : `[boot] env 探测跳过（非首次启动、亮窗 ${Number.isFinite(revealS) ? revealS.toFixed(1) : "?"}s 未超过慢阈值 ${SLOW_BOOT_PROBE_MS / 1000}s）`,
      );
    }
    if (envProbe.run) await logEnvProbe();
  } catch (err) {
    log(`[boot] 环境取证异常（忽略）：${err?.message || err}`);
  }
};

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
  // OOM 止血（2026-09-03 实测：长会话 + 子代理巨型回包常驻内存，默认堆 ~2G 跑 1 小时必爆
  // `heap out of memory` → server 退出 code=? → 壳弹「服务异常退出」）。server 是独立子进程，
  // mem-governance③ [设计决策]：恒带堆上限 + 崩溃取证。漏带旧路径实测 2.5GB 即崩。
  // ③只抬天花板、不改变增长曲线形状；取证 report 含 transcript 级数据，落盘到数据目录并只留最近 5 份。
  // P3-2：report-directory 落地 + 启动时轮转（默认落 cwd、无界累积）。
  //
  // ⛔ 这些旗标走 **argv**（`spawn(bin, [...serverNodeArgs, serverJs])`），不要再写进 NODE_OPTIONS
  // （第三轮 review N3-01 P1）：NODE_OPTIONS 会被 server 的所有子孙进程继承，用户 PATH 上较旧的 Node
  // （< 22.13 不认 `--report-exclude-env`）会直接 exit 9，agent shell 里的 pnpm / npm / tsc / vitest / hooks
  // 全部起不来；取证旗标还会让每个子孙进程异常退出都落一份报告。argv 不被继承，只对 server 自己生效，
  // 含空格的路径也不用加引号。宿主自己的 NODE_OPTIONS（用户手设）原样透传、不改写。
  // 实现与单测见 ./node-options.mjs 的 buildServerNodeArgs。
  // report 落盘目录指到数据目录 + 只留最近 5 份（best-effort，失败不挡启动）
  const nodeReportDir = nodeReportsDir();
  try {
    mkdirSync(nodeReportDir, { recursive: true });
    const keepReports = 5;
    const allReports = readdirSync(nodeReportDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const victim of allReports.slice(
      0,
      Math.max(0, allReports.length - keepReports),
    )) {
      void fs.unlink(path.join(nodeReportDir, victim)).catch(() => {});
    }
  } catch {
    /* 轮转失败不挡启动 */
  }
  const serverNodeArgs = buildServerNodeArgs({
    userNodeOptions: process.env.NODE_OPTIONS,
    nodeVersion: process.versions.node,
    reportDir: nodeReportDir,
  });
  const startedAt = Date.now();
  const proc = spawn(serverNodeBin(), [...serverNodeArgs, serverJs], {
    env: {
      ...process.env,
      // 三件套：execPath 当 node 用（含孙进程继承、hooks 依赖）+ 端口 + 数据目录
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(PORT),
      HOSTNAME: HOST,
      FLOWSHIP_DATA_DIR: path.join(app.getPath("userData"), "data"),
      // 观测用：run 汇总记录（run-perf.jsonl）带上版本与防节流实验开关状态，
      // 用于 A/B 对比「空闲后首发 / TTFT」是否因此改善
      FLOWSHIP_APP_VERSION: app.getVersion(),
      FLOWSHIP_PREVENT_APP_NAP: getAppNapMode().enabled ? "1" : "0",
    },
    // cwd 不用管：standalone server.js 启动时自己 process.chdir(__dirname)
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProc = proc;
  bootTimeline.mark("serverSpawn");
  log(`[main] server 启动 pid=${proc.pid} dataDir=${path.join(app.getPath("userData"), "data")} nodeArgs=${serverNodeArgs.join(" ") || "（空）"}`);
  // ⚠️ 世代守卫（自更新失败恢复竞态）：stopServer 会先把 serverProc 置 null 再杀、
  // SIGKILL 后不等回收就可能 startServer 拉新的——旧进程迟来的 exit 若无脑
  // serverProc=null / 弹「服务异常退出」、会误杀刚拉起的新 server（serverProc !== proc
  // = 该进程已被主动接管或替换、只记日志不动状态）
  // spawn 本身失败（如二进制路径不存在 ENOENT）不会触发 exit、必须挂 error——
  // v0.7.9 实测 Helper 路径拼错时 pid=undefined 静默挂死、靠这里明错
  proc.on("error", (err) => {
    const stale = serverProc !== proc;
    if (!stale) serverProc = null;
    log(`[main] server spawn 失败：${err?.message || err} stale=${stale}`);
    if (!stale && !quitting) {
      dialog.showErrorBox("服务启动失败", `内部服务进程拉不起来：${err?.message || err}`);
      app.quit();
    }
  });
  proc.stdout.on("data", (d) => log(`[server] ${d}`.trimEnd()));
  proc.stderr.on("data", (d) => log(`[server:err] ${d}`.trimEnd()));
  // 退出处置在 onServerExit（决策 / 文案在 shell-crash.mjs，弹窗与自动重启在那里编排）。
  // (code, signal) 都要收：被信号杀掉（OOM killer 的 SIGKILL、V8 堆耗尽的 SIGABRT）时 code 是 null——旧实现只收 code、日志里是常量 `code=?`。
  proc.on("exit", (code, signal) => {
    onServerExit({ proc, startedAt, code, signal }).catch((err) => {
      log(`[main] server 退出处置本身出错：${err?.message || err}`);
    });
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
    // SIGKILL 后短等回收（最多 1s）：自更新失败恢复路径随后可能立刻 startServer、
    // 不等的话新 server 有短暂 EADDRINUSE 撞旧监听 socket 的风险
    await Promise.race([
      new Promise((r) => proc.once("exit", () => r(true))),
      sleep(1000),
    ]);
  }
};

// 轮询 server 直到 HTTP 200（上限默认 = 常规启动超时 REGULAR_BOOT_TIMEOUT_MS：冷盘 + Defender 下 30s 会误杀慢机器；
// 取值只在 first-boot.mjs 定义一处，这里不再另写一个 60_000）
// 轮询 /api/readyz（零业务静态探针）：只证明 HTTP 栈起来，不跑首页渲染——
// 之前轮 `/` 把"监听起来"和"首页渲完"混在一起，首页稍慢就被误判成 server 没起。
const waitForReady = async (timeoutMs = REGULAR_BOOT_TIMEOUT_MS) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/readyz`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      // 还没起来、继续等
    }
    await sleep(400);
  }
  return false;
};

// ---------- server / 渲染进程异常退出的处置（R14 B2-4b / Q15-04、Q15-03） ----------
// 决策与文案在 shell-crash.mjs 的纯函数里（有单测）；这里只做 I/O 编排。
// serverAutoRestarts：整个 App 进程生命周期内自动重启 server 的次数（只一次，见 MAX_AUTO_RESTARTS）；
// serverCrashPrompted：崩溃弹窗只弹一次——自动重启期间「新 server 又崩」与「第一次重启的 waitForReady 超时」会撞车；
// renderReloadTimes / renderGiveUpPrompted：渲染进程崩溃后自动刷新的节流记录与「反复崩溃」提示是否正在显示。
let serverAutoRestarts = 0;
let serverCrashPrompted = false;
let renderReloadTimes = [];
let renderGiveUpPrompted = false;

// server 的崩溃取证报告目录（--report-on-fatalerror 落这里；startServer 也用这一个，别两处各写一遍路径）
const nodeReportsDir = () => {
  return path.join(app.getPath("userData"), "data", "diagnostics", "node-reports");
};
// 壳日志目录（main.log / installer.log 同目录；与 server 侧 diagnostics.ts 的 shellLogsDir 是同一个位置）
const shellLogsDir = () => {
  return path.join(app.getPath("userData"), "logs");
};

// 本次 server 启动之后才生成的取证报告（旧崩溃留下的不算）；目录不存在 / 读不了 = 没有
const listFreshNodeReports = (sinceMs) => {
  try {
    const dir = nodeReportsDir();
    const files = [];
    for (const name of readdirSync(dir)) {
      try {
        files.push({ name, mtimeMs: statSync(path.join(dir, name)).mtimeMs });
      } catch {
        // 刚被轮转删掉
      }
    }
    return pickFreshReports(files, sinceMs);
  } catch {
    return [];
  }
};

// 弹一个带按钮的错误框，返回被点中的按钮文案（关掉对话框 = 最后一个按钮「退出」）。
// 不传父窗：崩溃后主窗没有意义，也避免 macOS 的 sheet 挂在已死的页面上。
const askCrashChoice = async (notice) => {
  const last = notice.buttons.length - 1;
  const { response } = await dialog.showMessageBox({
    type: "error",
    title: notice.title,
    message: notice.title,
    detail: notice.message,
    buttons: notice.buttons,
    defaultId: last,
    cancelId: last,
    noLink: true,
  });
  return notice.buttons[response] ?? notice.buttons[last];
};

// 在系统文件管理器里打开目录；失败只记日志（openPath 返回错误文案而不是抛）
const openDirLogged = async (dir) => {
  try {
    const err = await shell.openPath(dir);
    if (err) log(`[main] 打开目录失败 ${dir}：${err}`);
  } catch (err) {
    log(`[main] 打开目录失败 ${dir}：${err?.message || err}`);
  }
};

// server 退出后的处置：旧进程迟来的 exit / 用户主动退出 → 忽略；稳定运行 ≥ 60s 后崩溃 → 自动重启一次并刷新页面；
// 其余（启动就崩 / 已重启过 / 重启没恢复）→ 弹窗（日志目录 / 崩溃报告目录 / 退出）并退出。
const onServerExit = async ({ proc, startedAt, code, signal }) => {
  const stale = serverProc !== proc;
  if (!stale) serverProc = null;
  const uptimeMs = Date.now() - startedAt;
  log(`[main] server 退出 ${describeExit(code, signal)} uptime=${Math.round(uptimeMs / 1000)}s quitting=${quitting} stale=${stale}`);
  const action = decideServerExit({ stale, quitting, uptimeMs, autoRestarts: serverAutoRestarts });
  if (action === "ignore") return;
  let restartFailed = false;
  if (action === "restart") {
    serverAutoRestarts += 1;
    log(`[main] server 稳定运行 ${Math.round(uptimeMs / 1000)}s 后意外退出、自动重启一次（本次运行内仅此一次）`);
    try {
      startServer();
      const ready = await waitForReady();
      if (quitting) return; // 重启期间用户退出了
      if (ready) {
        log("[main] server 自动重启成功、刷新页面");
        try {
          mainWindow?.webContents.reload();
        } catch (err) {
          // 窗口已销毁等：server 已经恢复，页面刷不刷得成不该被算成「重启失败」而弹崩溃窗（B2-4b 终审 P3-7）
          log(`[main] 自动重启后刷新页面失败（忽略）：${err?.message || err}`);
        }
        return;
      }
      restartFailed = true;
      log("[main] server 自动重启后一直没就绪");
    } catch (err) {
      restartFailed = true;
      log(`[main] server 自动重启失败：${err?.message || err}`);
    }
  }
  if (serverCrashPrompted || quitting) return;
  serverCrashPrompted = true;
  // 弹窗本身出错（窗口已销毁 / Electron 内部错误 / 文案构造抛错）也照样退出：这里是崩溃处置的末端、没有别人兜底——
  // 调用方（startServer 的 exit 回调）的 .catch 只记日志；而启动期崩溃时 whenReady 里不再叠一个「启动超时」弹窗（B2-4b 终审 P3-4），
  // 不退出就会留下一个没窗口、没提示的悬着进程（B2-4b 终审 P3-8）。
  try {
    const choice = await askCrashChoice(
      buildServerCrashNotice({
        code,
        signal,
        uptimeMs,
        // 自动重启过（这次是重启没起来，或重启成功后又崩）→ 提示里说明「已自动重启过一次、没能恢复」（B2-4b 终审 P3-5）
        restartFailed: restartFailed || serverAutoRestarts > 0,
        hasFreshReports: listFreshNodeReports(startedAt).length > 0,
      }),
    );
    if (choice === BUTTON_OPEN_LOGS) await openDirLogged(shellLogsDir());
    else if (choice === BUTTON_OPEN_REPORTS) await openDirLogged(nodeReportsDir());
  } catch (err) {
    log(`[main] server 崩溃提示出错、直接退出：${err?.message || err}`);
  } finally {
    app.quit();
  }
};

// 渲染进程异常退出（白屏 / 崩溃页）：只处置主窗；崩溃 / 内存不足 / 被结束 → 刷新页面（60s 内最多一次、累计最多 3 次），
// 刷新救不回来就停止自动刷新、弹一次「页面反复崩溃」（重新加载 / 打开日志目录 / 退出）。clean-exit（正常关窗）等只记日志。
const onRenderProcessGone = async (webContents, details) => {
  log(describeRenderGone(details));
  // 只处置主窗：splash 等小窗崩了不该消耗主窗的刷新配额、也不值得弹窗
  if (!mainWindow || mainWindow.isDestroyed() || webContents !== mainWindow.webContents) return;
  const decision = decideRenderGone({ reason: details?.reason, nowMs: Date.now(), reloadTimes: renderReloadTimes });
  renderReloadTimes = decision.reloadTimes;
  if (decision.action === "reload") {
    log("[main] 主窗页面进程异常退出、刷新页面");
    webContents.reload();
    return;
  }
  if (decision.action !== "give-up" || renderGiveUpPrompted) return;
  renderGiveUpPrompted = true;
  try {
    for (;;) {
      const choice = await askCrashChoice(buildRenderGoneNotice({ reason: details?.reason }));
      if (choice === BUTTON_OPEN_LOGS) {
        await openDirLogged(shellLogsDir());
        continue; // 看完日志后页面还是白的：再问一次，直到选「重新加载」或「退出」
      }
      if (choice === BUTTON_RELOAD) webContents.reload();
      else app.quit();
      return;
    }
  } finally {
    renderGiveUpPrompted = false;
  }
};

// ---------- 数据目录所在盘的低空间监视（R14 B2-4b / Q15-10 壳部分） ----------
// 判定 / 文案 / 阈值在 disk-watch.mjs 的纯函数里（有单测）；这里只做量盘 + 发系统通知 + 定时。
// diskNoticeState：各级别上次通知的时刻。只在内存里记——App 重启后再通知一次可以接受（取舍见 disk-watch.mjs 头注释）。
let diskNoticeState = emptyDiskNoticeState();

// 量一次、需要就发一条系统通知。任何异常只记日志：它跑在定时器里，抛出去会变成 uncaughtException（Electron 默认弹错误框）。
const checkDiskOnce = () => {
  try {
    const dataDir = path.join(app.getPath("userData"), "data");
    // 全新安装的首次启动 data 目录可能还没建：回退量 userData（同一个盘）
    const bytes = freeBytes(dataDir, statfsSync) ?? freeBytes(app.getPath("userData"), statfsSync);
    const freeMB = bytes === null ? null : bytesToMB(bytes);
    const level = classifyDiskLevel(freeMB);
    const decision = decideDiskNotice({ level, nowMs: Date.now(), state: diskNoticeState });
    diskNoticeState = decision.state;
    log(`[disk] 数据目录所在盘剩余 ${freeMB === null ? "?" : `${freeMB}MB`} level=${level}${decision.notify ? " → 通知用户" : ""}`);
    if (!decision.notify) return;
    if (!Notification.isSupported()) {
      log("[disk] 系统通知不可用，没发出去");
      return;
    }
    const { title, body } = buildLowDiskNotice({ level, freeMB });
    new Notification({ title, body }).show();
  } catch (err) {
    log(`[disk] 低空间检查出错（忽略）：${err?.message || err}`);
  }
};

// 启动时量一次，之后每 30 分钟一次；unref 让这个定时器不拖住进程退出
const startDiskWatch = () => {
  checkDiskOnce();
  setInterval(checkDiskOnce, DISK_CHECK_INTERVAL_MS).unref();
};

// 首次启动标记：Windows 下冷盘 + Defender 首扫 + 未签名 SmartScreen，server 首次起床
// 经常超过常规超时。标记落 userData，server 就绪后写，之后走常规超时。
// v1.9.30：标记里记版本号——更新后的第一次启动也是「冷」的（全新的未签名 exe + 9.6k 个刚写盘的
// 新文件，杀软眼里和全新安装没区别），之前全局一次性标记会让它只拿到常规 60s。判定见 ./first-boot.mjs。
const firstBootDoneFile = () =>
  path.join(app.getPath("userData"), "first-boot-done");
const isFirstBoot = () => {
  let raw = null;
  try {
    raw = readFileSync(firstBootDoneFile(), "utf8");
  } catch {
    raw = null; // 文件不存在 = 全新安装
  }
  return shouldTreatAsFirstBoot(raw, app.getVersion());
};
const markFirstBootDone = () => {
  try {
    writeFileSync(
      firstBootDoneFile(),
      JSON.stringify(buildFirstBootMarker(app.getVersion())),
    );
  } catch {
    // 写不进下次还按首次对待，无害
  }
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
const LOADING_BG_DARK = "#0e0f12";
const LOADING_BG_LIGHT = "#f3f4f5";
// 自定义标题栏底色：跟应用 --background 同色（globals.css oklch 精确换算 hex、
// 深 oklch(0.17 0.005 264)=#0e0f12、浅 oklch(0.967 0.002 247)=#f3f4f5——
// 同事实测 win 右上角控制按钮条偏亮、就是旧写死值 #17181c 跟真实背景对不上）。
// Windows titleBarOverlay 控制按钮条的初始底色用它、之后由页面按主题 IPC 精确同步；
// mac 走 hiddenInset、overlay 配置被忽略、这里只兜初始。
const HEADER_BG_DARK = "#0e0f12";
const HEADER_BG_LIGHT = "#f3f4f5";
const IS_MAC = process.platform === "darwin";
// 启动 splash：品牌 logo「雷芯」+ 电流环流动效（跟站内 BrandMark / hero loading 同一套
// 几何和节奏、v1.0.x logo 重设计）——server 就绪前的第一屏就是品牌。
// v1.0.x 改独立小窗（用户拍板「开屏 loading 直接到底」）：主窗备好才亮、
// 不再在可见窗口里做文档切换、衔接闪烁彻底消失。
const splashUrl = (dark) => {
  const bg = dark ? LOADING_BG_DARK : LOADING_BG_LIGHT;
  const fg = dark ? "#a1a1aa" : "#6b7280";
  const slit = bg; // 裂隙镂空 = 背景色
  const current = dark ? "#fff7e0" : "#8a5a12"; // 电流：深色近白暖光 / 浅色深琥珀
  const html = `<!doctype html><html><head><style>
    body{margin:0;display:grid;place-items:center;height:100vh;background:${bg};color:${fg};font:13px system-ui;user-select:none;-webkit-app-region:drag}
    .wrap{display:flex;flex-direction:column;align-items:center;gap:14px}
    @keyframes flow{to{stroke-dashoffset:-100}}
    @keyframes glow{0%,100%{opacity:.15}50%{opacity:.9}}
    .cur{stroke-dasharray:16 84;animation:flow 1.5s linear infinite}
    .gl{animation:glow 1.8s ease-in-out infinite}
  </style></head><body><div class="wrap">
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fcd34d"/><stop offset="1" stop-color="#f59e0b"/>
      </linearGradient></defs>
      <circle class="gl" cx="24" cy="24" r="20" fill="#f59e0b26"/>
      <path d="M27 4 L10 27 H21 L18 44 L38 19 H26 Z" fill="url(#g)" stroke="url(#g)" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M13 33 L34 12" stroke="${slit}" stroke-width="3.4" stroke-linecap="round"/>
      <circle cx="13" cy="33" r="2.2" fill="${slit}"/><circle cx="34" cy="12" r="2.2" fill="${slit}"/>
      <path class="cur" d="M27 4 L10 27 H21 L18 44 L38 19 H26 Z" pathLength="100" stroke="${current}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" fill="none"/>
    </svg>
    <div>启动中…</div>
  </div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

// 独立 splash 窗（frameless、可拖动）：boot 期间唯一可见窗口；
// 主窗 ready-to-show（页面真渲出来）后 show 主窗 → 关它（先开后关、不触发 window-all-closed）。
// v1.1.x 用户拍板「首屏就和打开后一样大」：尺寸 / 位置 / 最大化都取主窗记忆值——
// splash → 主窗在同一位置同一大小接力、视觉上只是窗内内容替换、没有窗口跳变
let splashWindow = null;
const createSplashWindow = (dark, st) => {
  splashWindow = new BrowserWindow({
    width: st?.width ?? 1280,
    height: st?.height ?? 800,
    x: st?.x,
    y: st?.y,
    frame: false,
    resizable: false,
    // 不给关闭手段（frameless 本来没按钮）；alwaysOnTop 不设、别挡用户干别的
    backgroundColor: dark ? LOADING_BG_DARK : LOADING_BG_LIGHT,
    show: true,
  });
  if (st?.maximized) splashWindow.maximize();
  splashWindow.on("closed", () => {
    log("[main] splash 窗已关");
    splashWindow = null;
  });
  void splashWindow.loadURL(splashUrl(dark));
  log("[main] splash 窗已建");
};
const closeSplashWindow = () => {
  if (!splashWindow) return;
  try {
    splashWindow.destroy();
  } catch {
    // 已关、忽略
  }
  splashWindow = null;
};

// 亮主窗 + 收 splash（幂等）：页面 `app-content-ready` IPC / 兜底 timer 都走这
let mainRevealed = false;
const revealMainWindow = (source) => {
  if (mainRevealed) return;
  mainRevealed = true;
  // 距主进程启动的秒数：把「点图标 → 窗口能用」拆成日志里可读的一段（server 就绪那行只覆盖其中一部分，
  // 就绪后首页首次渲染同样在读冷文件、实测可再占十几秒）
  log(`[main] reveal 主窗（source=${source ?? "?"}、距主进程启动 ${process.uptime().toFixed(1)}s）`);
  bootTimeline.mark("reveal");
  if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  closeSplashWindow();
  // 首页亮出后一段时间出启动报告（时间线 / 主线程卡顿 / 首页请求明细 / GPU / 环境取证）
  if (!bootReportScheduled) {
    bootReportScheduled = true;
    setTimeout(() => void emitBootReport(source), BOOT_REPORT_DELAY_MS);
  }
};

// 页面首页真实内容渲出来（看板 / 就绪清单）→ 此刻切换、启动全程一屏 splash 到底
ipcMain.on("app-content-ready", () => revealMainWindow("page-ipc"));

// ---------- mac 改名自迁移（v1.1.x「Flowship」改名收尾） ----------
//
// 老版本（<v1.1.0）的更新器只换 .app 内容不换文件名——不管从哪个老版本升上来、
// 磁盘上可能还叫「AI工作流.app」。updater 侧的 rename 只覆盖「从 v1.1.0 起跳」的
// 更新，这里在**新版第一次启动时**兜底：文件名 ≠ 产品名 → 原子 rename → open 新
// 路径重启接力（运行中不带病续跑：Chromium 之后按旧路径 lazy-load 资源会失败）。
// 一次性动作、改完后续启动名字匹配直接跳过。
const renameNoticeFile = () =>
  path.join(app.getPath("userData"), "rename-notice.json");

const maybeSelfRenameOnMac = async () => {
  if (!IS_MAC || !app.isPackaged || IS_TEST) return false;
  const appPath = path.resolve(process.execPath, "..", "..", "..");
  // 非常规位置（dmg 里直接跑等）不折腾
  if (!appPath.endsWith(".app") || appPath.startsWith("/Volumes/")) return false;
  const desired = `${app.getName()}.app`;
  if (path.basename(appPath) === desired) return false;
  const target = path.join(path.dirname(appPath), desired);
  try {
    await fs.rename(appPath, target);
  } catch (err) {
    // 目标已存在 / 没权限：保持原名照常启动、不挡用户
    log(`[main] 应用文件名迁移失败（保持原名）${err?.message || err}`);
    return false;
  }
  log(`[main] 应用文件名 ${path.basename(appPath)} → ${desired}、重启接力`);
  // 留 marker：新路径进程启动后据此发「重新固定 Dock」通知（本进程要立刻退、弹不了）
  try {
    await fs.writeFile(renameNoticeFile(), JSON.stringify({ at: Date.now() }));
  } catch {
    // 通知丢了无妨、改名本体已完成
  }
  quitting = true;
  app.relaunch({ execPath: "/usr/bin/open", args: [target] });
  app.quit();
  return true;
};

// 系统通知图标路径（v1.0.x 雷芯 logo）：
// - 打包后：extraResources 拷的 resources/notify-icon.png（= packaging/icon.png）
// - 开发态：直接读仓库 packaging/icon.png（权威源）
// mac 通知左侧仍强制用 app icon.icns（Electron 文档：icon 选项仅 win/linux 生效）；
// win 不显式传会吃 AppUserModelId 关联的 exe 图标、升级后易被系统图标缓存拖成旧图。
const resolveNotifyIcon = () => {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "notify-icon.png")]
    : process.platform === "win32"
      ? [
          path.join(__dirname, "..", "packaging", "icon-win.png"),
          path.join(__dirname, "..", "packaging", "icon.png"),
        ]
      : [path.join(__dirname, "..", "packaging", "icon.png")];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
};

// 改名接力后的一次性提示（Dock 固定的旧路径图标会失效、得让用户知道去重新固定）
const notifyRenameOnce = async () => {
  try {
    await fs.access(renameNoticeFile());
  } catch {
    return; // 没 marker、不是改名后的首次启动
  }
  await fs.rm(renameNoticeFile(), { force: true }).catch(() => {});
  if (!Notification.isSupported()) return;
  new Notification({
    title: `应用已更名为 ${app.getName()}`,
    body: "Dock 固定过旧图标的话、请重新固定一次。",
    // 同 task-notify：mac 传 icon 会变成横幅右侧内容图、只给 win/linux
    ...(IS_MAC ? {} : { icon: resolveNotifyIcon() }),
  }).show();
};

// ---------- 深链 + Tray + 开机自启（决策 #18 / #19 / #22） ----------

/** 从 argv 里抠自定义协议 URL（Windows 深链走 second-instance argv，见 4.6） */
const findProtocolUrlInArgv = (argv) => {
  const prefix = `${PROTOCOL_SCHEME}://`;
  return (argv || []).find((a) => typeof a === "string" && a.startsWith(prefix)) || null;
};

/**
 * 解析 flowship://tasks/<taskId>（hostname=tasks、pathname=/<id>）。
 * 只认本实例 scheme、只带 taskId、不带敏感信息（坑 #15）。
 */
const parseDeepLinkTaskId = (url) => {
  if (typeof url !== "string" || !url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== `${PROTOCOL_SCHEME}:`) return null;
    // flowship://tasks/abc → hostname=tasks、pathname=/abc
    if (u.hostname === "tasks") {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      return id || null;
    }
    // 兼容 flowship:///tasks/abc（空 host）
    const parts = `${u.hostname}${u.pathname}`.split("/").filter(Boolean);
    if (parts[0] === "tasks" && parts[1]) return parts[1];
    return null;
  } catch {
    return null;
  }
};

/** 显示并聚焦主窗（Tray 打开 / 深链 / second-instance / dock activate 共用） */
const showMainWindow = () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

/**
 * 收进托盘（Cmd/Ctrl+W 专用；2026-07-20 用户拍板与「点 X」分家）。
 * 全屏窗直接 hide 会被系统收掉它的 Space、再 show 变回非全屏——
 * 用户确认这是 mac 前台调度的系统级行为（飞书同样如此）、不做补偿逻辑。
 */
const hideMainWindowToTray = () => {
  if (!mainWindow) return;
  void saveWindowState();
  mainWindow.hide();
  log("[main] Cmd/Ctrl+W → hide（Tray 常驻）");
};

/**
 * 投递深链给 renderer。
 * 窗口未建、或目标页尚未 did-finish-load → 只写 pending（不清），等 flush。
 * 否则会 send 进即将被 loadURL 换掉的空白上下文、pending 又已清 → 丢链（R1-10）。
 */
const deliverDeepLink = (taskId) => {
  if (!taskId) return;
  if (!mainWindow || !pageLoaded) {
    pendingDeepLinkTaskId = taskId;
    log(
      `[deep-link] ${!mainWindow ? "窗口" : "页面"}未就绪、暂存 taskId=${taskId}`,
    );
    return;
  }
  pendingDeepLinkTaskId = null;
  showMainWindow();
  mainWindow.webContents.send("deep-link", { taskId });
  log(`[deep-link] 已投递 taskId=${taskId}`);
};

const handleDeepLinkUrl = (url) => {
  const taskId = parseDeepLinkTaskId(url);
  if (!taskId) {
    log(`[deep-link] 无法解析 URL：${String(url).slice(0, 120)}`);
    return;
  }
  deliverDeepLink(taskId);
};

/**
 * 页面就绪后冲刷暂存。
 * 仍未 pageLoaded 时不抢清 pending——留给下一次 did-finish-load。
 */
const flushPendingDeepLink = () => {
  if (!pendingDeepLinkTaskId) return;
  if (!mainWindow || !pageLoaded) return;
  deliverDeepLink(pendingDeepLinkTaskId);
};

/**
 * 注册为默认协议客户端。
 * Windows / mac 非打包（process.defaultApp）必须带 execPath + 入口脚本，
 * 否则系统调起时找不到 electron 入口（Electron 官方文档模式）。
 */
const registerProtocolClient = () => {
  try {
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
          path.resolve(process.argv[1]),
        ]);
      }
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
    }
    log(`[deep-link] 已注册协议 ${PROTOCOL_SCHEME}://`);
  } catch (err) {
    log(`[deep-link] 注册协议失败（忽略）${err?.message || err}`);
  }
};

/** Tray 图标：mac 用 Template（适配菜单栏深浅色）；win 用彩色 png */
const resolveTrayIcon = () => {
  const assetsDir = path.join(__dirname, "assets");
  if (IS_MAC) {
    // Electron 会按 DPI 自动选 trayTemplate.png / trayTemplate@2x.png
    const p = path.join(assetsDir, "trayTemplate.png");
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) img.setTemplateImage(true);
    return img;
  }
  const winPath = path.join(assetsDir, "tray-win.png");
  if (existsSync(winPath)) return nativeImage.createFromPath(winPath);
  // 兜底：通知图标 / packaging
  const fallback = resolveNotifyIcon();
  return fallback ? nativeImage.createFromPath(fallback) : nativeImage.createEmpty();
};

/**
 * 真退出入口（Tray「退出」）：先置 quitting，避免 close 拦截成 hide，
 * 再走 app.quit → before-quit（含 mac 暂存更新套用）→ 杀 server。
 * ⚠️ 自更新 quitAndInstall / applyStagedUpdate 也会先置 quitting=true，同一套门控。
 */
const quitAppForReal = () => {
  quitting = true;
  app.quit();
};

const createTray = () => {
  if (appTray) return;
  const icon = resolveTrayIcon();
  if (icon.isEmpty()) {
    log("[tray] 图标为空、跳过创建 Tray（关窗 hide 仍生效）");
    return;
  }
  appTray = new Tray(icon);
  const label = IS_TEST ? "FlowshipTest" : "Flowship";
  appTray.setToolTip(label);
  const menu = Menu.buildFromTemplate([
    {
      label: `打开 ${label}`,
      click: () => showMainWindow(),
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => quitAppForReal(),
    },
  ]);
  // 左键单击 = 直接打开主窗（2026-07-20 用户拍板「点击就打开、不要下拉」）；
  // 菜单挂右键：mac 不能 setContextMenu（设了左键也弹菜单）、手动 popUpContextMenu
  if (IS_MAC) {
    appTray.on("click", () => showMainWindow());
    appTray.on("right-click", () => appTray?.popUpContextMenu(menu));
  } else {
    // Windows：setContextMenu 只响应右键、左键 click 事件独立可用
    appTray.setContextMenu(menu);
    appTray.on("click", () => showMainWindow());
  }
  log(`[tray] 已创建（${label}）`);
};

const destroyTray = () => {
  if (!appTray) return;
  appTray.destroy();
  appTray = null;
  log("[tray] 已销毁");
};

/** mac 菜单栏闪电：缺文件当显示。Windows 不读、永远建托盘。 */
const menuBarIconFile = () =>
  path.join(app.getPath("userData"), "menu-bar-icon.json");

const readMenuBarIconVisible = () => {
  try {
    const raw = JSON.parse(readFileSync(menuBarIconFile(), "utf8"));
    return raw?.visible !== false;
  } catch {
    return true;
  }
};

const writeMenuBarIconVisible = (visible) => {
  writeFileSync(
    menuBarIconFile(),
    `${JSON.stringify({ visible: visible === true })}\n`,
    "utf8",
  );
};

const applyMenuBarIconVisible = (visible) => {
  if (visible) createTray();
  else destroyTray();
};

// 开机自启读写（设置页 UI 另代理；API 名 auto-launch-get / set 一字不差）
ipcMain.handle("auto-launch-get", () => {
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch (err) {
    log(`[auto-launch] get 失败 ${err?.message || err}`);
    return false;
  }
});
ipcMain.handle("auto-launch-set", (_e, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled === true });
    log(`[auto-launch] set openAtLogin=${enabled === true}`);
  } catch (err) {
    log(`[auto-launch] set 失败 ${err?.message || err}`);
    throw err;
  }
});

// mac 菜单栏图标显隐（设置页仅 darwin 展示；Windows 不注册也没用，主进程直接忽略）
ipcMain.handle("menu-bar-icon-get", () => {
  if (!IS_MAC) return null;
  return readMenuBarIconVisible();
});
ipcMain.handle("menu-bar-icon-set", (_e, visible) => {
  if (!IS_MAC) return;
  const next = visible === true;
  try {
    writeMenuBarIconVisible(next);
    applyMenuBarIconVisible(next);
    log(`[tray] 菜单栏图标 visible=${next}`);
  } catch (err) {
    log(`[tray] 写显隐失败 ${err?.message || err}`);
    throw err;
  }
});

const createWindow = async () => {
  const st = await loadWindowState();
  // 加载期窗口底色跟随系统深浅、避免浅色系统启动闪黑（app 内主题由 next-themes 接管）
  const dark = nativeTheme.shouldUseDarkColors;
  mainWindow = new BrowserWindow({
    width: st?.width ?? 1280,
    height: st?.height ?? 800,
    // 窗口最小尺寸（第二轮 review 窄栏三件套）：原先无下限，侧栏 257px + 事件流栏默认 30%
    // ⇒ task 事件流栏在默认窗口只有约 307px，缩小窗口后答题卡 / 工具块 / 子代理卡都会溢出。
    // 960×600 是 review 建议值；上次保存的更小窗口状态会被 Electron 自动抬到下限。
    minWidth: 960,
    minHeight: 600,
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
      // 防后台节流实验（默认关 = Electron 默认的 true）：开启后窗口被遮挡 / 最小化时
      // 渲染进程不降频、流式渲染与 SSE 读取不被节流
      backgroundThrottling: !getAppNapMode().enabled,
    },
  });
  if (st?.maximized) mainWindow.maximize();
  // v1.1.x「开屏一屏到底」（用户拍板）：ready-to-show（首帧、可能还是页内 loading）
  // 不亮窗——等页面 IPC `app-content-ready`（首页真实内容渲出来：看板 / 就绪清单）
  // 才亮主窗 + 收 splash；见 revealMainWindow / whenReady 里的兜底 timer
  //
  // 关窗行为（2026-07-20 用户拍板改版、mac/win 同款）：
  // - Cmd/Ctrl+W → 收进托盘（mac 走自定义菜单加速键、win 走 before-input-event）
  // - 点 X / Alt+F4（close 事件）→ 二次确认、确认后真退出
  // - 真退出（Tray「退出」/ Cmd+Q / 自更新，quitting 已置位）→ 放行 close
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (process.platform === "darwin") return; // mac 由应用菜单接管 Cmd+W
    if (input.type !== "keyDown") return;
    if ((input.key || "").toLowerCase() !== "w") return;
    if (!input.control || input.alt || input.shift || input.meta) return;
    event.preventDefault();
    hideMainWindowToTray();
  });
  // 确认弹窗走 renderer 的 useDialog（app 内风格、红色确认键——原生 dialog 做不了红按钮）；
  // 页面没就绪（白屏/崩溃）时没 UI 可确认 → 直接放行退出
  let closeConfirmShowing = false;
  mainWindow.on("close", (event) => {
    log(`[close] close 事件 quitting=${quitting} pageLoaded=${pageLoaded} showing=${closeConfirmShowing}`);
    void saveWindowState();
    if (quitting) return;
    event.preventDefault();
    if (closeConfirmShowing) return;
    closeConfirmShowing = true;
    // 30s 无响应自动解锁（renderer 卡死时允许再点 X 重试）
    const unlockTimer = setTimeout(() => {
      closeConfirmShowing = false;
    }, 30_000);
    ipcMain.once("app-close-confirm-result", (_e, confirmed) => {
      log(`[close] renderer 回复 confirmed=${confirmed}`);
      clearTimeout(unlockTimer);
      closeConfirmShowing = false;
      if (confirmed === true) quitAppForReal();
    });
    // 页面没就绪（白屏/崩溃）时 renderer 弹不了——原生弹窗兜底（不再直接退出）
    if (!pageLoaded) {
      log("[close] 页面未就绪 → 原生确认兜底");
      void dialog
        .showMessageBox(mainWindow, {
          type: "question",
          buttons: ["关闭", "取消"],
          defaultId: 1,
          cancelId: 1,
          message: `确定关闭 ${IS_TEST ? "FlowshipTest" : "Flowship"} 吗？`,
          detail: "后台任务与飞书桥接会一并退出",
        })
        .then(({ response }) => {
          clearTimeout(unlockTimer);
          closeConfirmShowing = false;
          if (response === 0) quitAppForReal();
        })
        .catch(() => {
          closeConfirmShowing = false;
        });
      return;
    }
    mainWindow.webContents.send("app-close-confirm", {
      appName: IS_TEST ? "FlowshipTest" : "Flowship",
    });
  });
  // 真退出（quitting 已置位：Cmd+Q / Tray 退出 / 自更新 quitAndInstall）时无视页面的 beforeunload 拦截。
  // Electron 里页面 beforeunload 返回/设置了 returnValue 会**静默取消** window.close()/app.quit()——
  // 不会像浏览器那样弹确认框，没有 will-prevent-unload 处理就表现为「点退出 / 重启更新没反应」。
  // 设置页有未保存草稿时会注册 beforeunload（见 use-settings），此处保证它拦不住真退出。
  // 非退出场景（普通导航）保持默认行为、不在这里放行。
  mainWindow.webContents.on("will-prevent-unload", (event) => {
    if (quitting) event.preventDefault();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    pageLoaded = false;
  });

  // window.open 一律 deny + 白名单内转系统浏览器（v0.7.8 拍板转系统浏览器；
  // 审查后补协议白名单，与 IPC open-external 同源，防任意协议跳板）：
  // - 外链（飞书 story / MR / GitHub…）、OAuth 授权页 → https、在白名单内
  // - 站内 URL 也 deny（用户实测「应用内闪一下」差）——若要开外链走 markdown/IPC
  //   （第四轮 Q4-02：以前注释这么写、实现却把 `http://127.0.0.1:<本应用端口>/api/…` 当普通 http 链接
  //   openExternal 了——系统浏览器打开时 `Sec-Fetch-Site: none`，Fetch Metadata 闸拦不住，
  //   AI 输出里的一条恶意链接就能让用户一点触发本机 GET 副作用；现在站内 URL 显式 deny）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      console.warn(`[setWindowOpenHandler] 拒绝站内 URL：${String(url).slice(0, 80)}`);
      return { action: "deny" };
    }
    if (!isSafeExternalUrl(url)) {
      console.warn(`[setWindowOpenHandler] 拒绝非白名单 URL：${String(url).slice(0, 80)}`);
      return { action: "deny" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });
  // 同 frame 导航离开本应用（cursor:// deep link 跳 IDE、或意外的外部 http 链接）
  // → 拦下来交系统处理、窗口永远停在 Flowship 页面上
  // 特例：app-update://install 是页面「新版本」标识发起的装更新指令、壳自己消费
  // 主窗不放行 data:——splash 是独立 BrowserWindow 自己 loadURL(data:)，不经此 handler
  //
  // ⚠️ 交给系统（shell.openExternal）前必须过白名单：这里承载 IDE deep link（页面里裸
  // `<a href="cursor://file/...">` 同 frame 导航），所以不能一刀切拒绝；但 file: / smb: /
  // javascript: / 任意自定义协议绝不能被页面（或被注入的内容）借这条路拉起系统处理器。
  // 放行 = 通用外链（isSafeExternalUrl）、前端真实生成的 IDE deep link（isIdeDeepLink，
  // 仅 cursor / vscode 的 `://file/<绝对路径>` 形态）、或严格形态的 mailto（isSafeMailtoUrl：
  // 页面里裸 `<a href="mailto:…">` 同 frame 导航，白名单化之后它曾被静默拦下、点了没反应；
  // 只放这里、不进 setWindowOpenHandler / IPC——前端没有走那两条路开 mailto 的调用方）；
  // 其余一律拦下、不打开、只记一行日志。
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("app-update://")) {
      e.preventDefault();
      void installUpdateNow();
      return;
    }
    if (isAppUrl(url)) {
      // 本应用 origin → 放行；localhost / [::1] 等回环别名也是「站内」、但与主窗不同源：放行会把主窗带去别的 origin
      // （跨站、被中间件 403），交系统浏览器又是 Sec-Fetch-Site: none 绕过 Fetch Metadata 闸——两头都不要，拦下
      if (!isCanonicalAppUrl(url)) {
        e.preventDefault();
        log(`[will-navigate] 拒绝回环别名站内 URL：${String(url).slice(0, 80)}`);
      }
      return;
    }
    // 站外一律先拦导航：不论后面放行与否，主窗都不能被带走
    e.preventDefault();
    if (isSafeExternalUrl(url) || isIdeDeepLink(url) || isSafeMailtoUrl(url)) {
      void shell.openExternal(url).catch((err) => {
        log(`[will-navigate] 打开外部链接失败 ${err?.message || err}`);
      });
      return;
    }
    // 只记前 80 字符：URL 里可能带 token / 本地路径，别把整串写进日志
    log(`[will-navigate] 拒绝非白名单 URL：${String(url).slice(0, 80)}`);
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

  // pageLoaded 复位：仅「主框架真导航」（loadURL / 跨文档跳转）才作废页面上下文。
  // ⚠️ 不能用 did-start-loading——它是「tab 转圈」信号、页面任何子资源/fetch 都会触发，
  // 把 pageLoaded 永久打回 false（2026-07-20 实测：点 X 走了「页面未就绪」兜底、
  // 深链 pending 也永远不投）。
  // Electron 42：事件对象自带 isMainFrame / isSameDocument（结构化 details 形态）
  mainWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      log(`[close] 主框架导航（pageLoaded ${pageLoaded} → false）`);
      pageLoaded = false;
    }
  });
  // 页面每次加载完成（首次加载 / 更新后重载）重注入版本号 + 重推更新状态、不丢徽标
  mainWindow.webContents.on("did-finish-load", () => {
    log("[close] did-finish-load（pageLoaded → true）");
    pageLoaded = true;
    // 版本号给设置页显示（用户要能确认「装的是不是最新版」）；web 版没壳、不显示
    mainWindow?.webContents
      .executeJavaScript(`window.__appVersion=${JSON.stringify(app.getVersion())};`)
      .catch(() => {});
    // 更新状态重推一次（页面刷新 / 更新后重载不丢徽标；组件 mount 时也会主动拉）
    setUpdateState({});
    // 冷启动 / boot 窗口深链：文档就绪后再投递（坑 #15 + R1-10）
    flushPendingDeepLink();
  });
  // v1.0.x：主窗创建后不再加载 splash 文档（splash 是独立小窗）——
  // 等 server 就绪后由启动流程直接 loadURL(BASE_URL)、ready-to-show 才亮窗
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

// ---------- 收件箱角标（三期注意力） ----------
//
// 页面 use-mr-inbox 未读数变化 → preload setInboxBadge → 这里：
// - mac：app.setBadgeCount（Dock 数字；0 清除）
// - win：setOverlayIcon（renderer canvas 画的红圆白字 PNG dataUrl；无图则清）
// linux：无统一角标 API、忽略（仍可发系统通知）
ipcMain.on("inbox:set-badge", (_e, payload) => {
  const count = Math.max(0, Math.floor(Number(payload?.count) || 0));
  try {
    if (IS_MAC) {
      app.setBadgeCount(count);
    }
  } catch (err) {
    log(`[inbox-badge] setBadgeCount 失败（忽略）${err?.message || err}`);
  }
  if (process.platform !== "win32" || !mainWindow) return;
  try {
    if (count <= 0) {
      mainWindow.setOverlayIcon(null, "");
      return;
    }
    const dataUrl =
      typeof payload?.dataUrl === "string" && payload.dataUrl.startsWith("data:image/")
        ? payload.dataUrl
        : null;
    if (!dataUrl) {
      // 无图时不强行 overlay（避免空白/坏图）、直接清
      mainWindow.setOverlayIcon(null, "");
      return;
    }
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) {
      mainWindow.setOverlayIcon(null, "");
      return;
    }
    const desc = count > 9 ? "9+ 条未读" : `${count} 条未读`;
    mainWindow.setOverlayIcon(img, desc);
  } catch (err) {
    log(`[inbox-badge] setOverlayIcon 失败（忽略）${err?.message || err}`);
  }
});

// ---------- 任务注意力通知（v0.9.5） ----------
//
// 页面（TaskAttentionWatcher）发现某 task 转入「等你回复 / 提问 / 失败」，且「没有聚焦、
// 或聚焦但正看着的不是这个任务」（V7-03 起；只有聚焦 + 正看着它才静音）时、
// IPC 过来发系统通知；点通知 → 聚焦窗口 + 回传 taskId 给页面路由跳转。
// 通知只是「叫人回来」的信使、判断「什么时候该叫」全在页面侧（那边有完整任务状态）。
// 收件箱增量通知也走同一通道（无 taskId、带 target:"inbox"：点通知聚焦窗口并让页面打开收件箱，N1-12）。
ipcMain.on("task-notify", (_e, payload) => {
  if (!Notification.isSupported()) return;
  const { title, body, taskId, target } = parseNotifyPayload(payload);
  try {
    const n = new Notification({
      title,
      body,
      silent: false,
      // win/linux：显式传新 logo（win toast 不传会用默认应用图标）。
      // ⚠️ mac 不能传：mac 的 icon 字段渲染成横幅**右侧内容图**（左侧永远是 app icon、
      // 由系统按 bundle 缓存）——传了会凭空多一个图标（用户实测点名去掉）。
      ...(IS_MAC ? {} : { icon: resolveNotifyIcon() }),
    });
    n.on("click", () => {
      // 聚焦窗口 + 告诉页面「用户点了哪个任务的通知」（页面自己 router.push）
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        if (taskId) {
          mainWindow.webContents.send("task-notify-click", taskId);
        } else if (target) {
          mainWindow.webContents.send("notify-target-click", target);
        }
      }
    });
    n.show();
  } catch (err) {
    log(`[notify] 系统通知失败（忽略）${err?.message || err}`);
  }
});

// ---------- 打开系统外链（设置页「系统设置里开启」通知权限等） ----------
//
// 白名单见顶部 isSafeExternalUrl——别让页面 IPC 成任意协议跳板。
ipcMain.on("open-external", (_e, url) => {
  // 站内 URL 不交给系统浏览器（同 setWindowOpenHandler，第四轮 Q4-02）
  if (isAppUrl(url)) {
    log(`[open-external] 拒绝站内 URL：${String(url).slice(0, 80)}`);
    return;
  }
  if (!isSafeExternalUrl(url)) {
    log(`[open-external] 拒绝非法 URL：${String(url).slice(0, 80)}`);
    return;
  }
  void shell.openExternal(url).catch((err) => {
    log(`[open-external] 失败 ${err?.message || err}`);
  });
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

// 更新动作模式（installUpdateNow 据此分平台路径）：
// - win="install"：electron-updater、autoDownload=false → 点按钮才 downloadUpdate、下载完 quitAndInstall
// - mac="download"：未签名跑不了 Squirrel.Mac，走壳内延迟自更新（下载暂存 → 立即替换重启 / 稍后退出时替换，见 downloadAndStageMacUpdate）
const UPDATE_MODE = process.platform === "win32" ? "install" : "download";
// 退出时正在套用暂存包——before-quit preventDefault 防重入
let applyingStagedOnQuit = false;
const RELEASE_LATEST_URL = "https://github.com/jianger666/Flowship/releases/latest";

// 「该版本是否已弹过错误框」持久化——仅用于 mac 自动暂存失败的 showErrorBox 去重
// （发现新版本本身 2026-07-15 起不再弹窗、只静默点亮右上角徽标）。
// 只有真的弹了框（确定不符 / 没带 manifest）才记；暂时性失败不弹框、也就不消耗这个名额（R6-5，见 buildVerifyRejectionNotice）
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
    // 写不进去顶多多弹一次错误框、不影响主流程
  }
};

// ---------- 更新状态机（主进程唯一数据源、页面 UpdateBadge 全量订阅） ----------
//
// phase 流转（win/mac 统一语义）：
//   idle        无更新
//   available   发现新版（win=等用户点下载；mac=即将/正在后台暂存前的瞬间、或下载失败可重试）
//   downloading 下载中（percent 0-100；mac=后台暂存 dmg、win=electron-updater 下载 NSIS）
//   ready       已就绪（mac=已暂存 staged-*.app、win=安装包已下载完）、点徽标即重启完成更新
//   installing  安装中（mac=apply+relaunch 前、win=quitAndInstall 前）——UI disabled + 主进程互斥双保险
// error 是附加字段：失败时 phase 回退到 available/ready、error 带原因（UI 可提示重试）。
//
// 推送通道：webContents.send("update-state") 实时推 + IPC get-update-state 供页面
// mount / 刷新时拉全量（替代旧 executeJavaScript 注入 __appUpdateVersion 方案——
// 注入有时序竞态、且没法带进度）。
let updateState = { phase: "idle", version: null, percent: 0, error: null };
const setUpdateState = (patch) => {
  updateState = { ...updateState, ...patch };
  try {
    mainWindow?.webContents.send("update-state", updateState);
  } catch {
    // 窗口销毁中、忽略
  }
};

// execFile 的「失败要 throw」版（自更新链路用、跟 fail-open 的 execFileP 区分）
const execFileStrict = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });

// 三段式版本比较：a 比 b 新返回 true（清扫 / 暂存套用 / 查更新共用，须放在调用方之前）
const isNewer = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
};

// updates/ 目录 + 暂存元信息路径（mac 延迟替换：dmg 验完 ditto 到 staged-*.app，不碰 /Applications）
const updatesDirPath = () => path.join(app.getPath("userData"), "updates");
const stagedMetaFile = () => path.join(updatesDirPath(), "staged.json");
const pendingRestartMarker = () =>
  path.join(app.getPath("userData"), "data", "update-pending-restart.json");

// 读暂存元信息；损坏 / 缺文件返 null
const readStagedMeta = async () => {
  try {
    const meta = JSON.parse(await fs.readFile(stagedMetaFile(), "utf8"));
    if (!meta?.version || !meta?.appPath) return null;
    return meta;
  } catch {
    return null;
  }
};

const writeStagedMeta = async (meta) => {
  mkdirSync(updatesDirPath(), { recursive: true });
  await fs.writeFile(stagedMetaFile(), JSON.stringify(meta), "utf8");
};

// 清 staged.json + 可选清 staged-*.app（meta 缺失时仍尽量扫掉过期 staged 包）
const clearStagedUpdate = async (meta) => {
  if (meta?.appPath) {
    await fs.rm(meta.appPath, { recursive: true, force: true }).catch(() => {});
  }
  await fs.rm(stagedMetaFile(), { force: true }).catch(() => {});
};

// 当前运行中的 .app 包路径（execPath = <app>.app/Contents/MacOS/<bin>）
const runningAppPath = () => path.resolve(process.execPath, "..", "..", "..");

// 启动清扫（V0.10.1 + 延迟替换）：
// 1. 删「更新就位、等重启」marker——能跑到这说明已经在新 bundle 上、server 不用再拦
// 2. 清 updates/ 残留（old-*.app / mnt-* / *.dmg）；staged-*.app / staged.json 仅当版本 ≤ 当前才清
//    （有效暂存要留给退出替换 / 徽标「立即更新」、绝不能启动一把清掉）
const cleanupUpdateLeftovers = async () => {
  await fs.rm(pendingRestartMarker(), { force: true }).catch(() => {});
  const updatesDir = updatesDirPath();
  let entries = [];
  try {
    entries = readdirSync(updatesDir);
  } catch {
    return; // 没 updates 目录、没得清
  }
  const current = app.getVersion();
  const stagedMeta = await readStagedMeta();
  // 有效暂存（版本比当前新且 .app 还在）→ 保留，其余 staged 过期清掉
  const keepStagedPath =
    stagedMeta &&
    isNewer(stagedMeta.version, current) &&
    existsSync(stagedMeta.appPath)
      ? path.resolve(stagedMeta.appPath)
      : null;
  if (stagedMeta && !keepStagedPath) {
    log(
      `[updater] 启动清扫过期暂存 v${stagedMeta.version}（当前 v${current} 或包已丢）`,
    );
    await clearStagedUpdate(stagedMeta);
  }
  for (const name of entries) {
    const p = path.join(updatesDir, name);
    // 保留有效暂存包 + 其元信息
    if (name === "staged.json" && keepStagedPath) continue;
    if (name.startsWith("staged-") && name.endsWith(".app")) {
      if (keepStagedPath && path.resolve(p) === keepStagedPath) continue;
      // 孤儿 / 过期 staged-*.app
    }
    // 历史挂载点可能还挂着 dmg、先卸再删（fail-open）
    if (name.startsWith("mnt-")) await execFileP("hdiutil", ["detach", p, "-quiet"]);
    try {
      await fs.rm(p, { recursive: true, force: true });
      log(`[updater] 启动清扫 updates/${name}`);
    } catch (err) {
      log(`[updater] 启动清扫 updates/${name} 失败（忽略）${err?.message || err}`);
    }
  }
};

// ---------- 更新 manifest 验签（CR-02） ----------
//
// mac 包无 Apple 签名、Gatekeeper 又被绕开（fetch 下载无 quarantine）——dmg 的真实性
// 必须自证：CI 用 Ed25519 私钥对「版本 + asset SHA-256 清单」签名产 update-manifest.json
// （scripts/generate-update-manifest.mjs）、壳内置公钥先验签再验哈希、验不过保留旧应用。
// Windows 同理（R9-01）：exe 同样没有代码签名证书，而 electron-updater 只信 latest.yml 里的 sha512——
// 能改 GitHub release 的人就能推恶意 exe。所以 exe 也签进**同一份** manifest，
// Windows 下载完成后（update-downloaded）与 quitAndInstall 之前都走本函数，见下方「Windows 更新包验签」。
//
// 公钥单一来源：同目录 update-manifest-public-key.pem（CI verify-update-manifest.mjs 共用、
// 防双源漂移）。私钥只在 GitHub secret `UPDATE_MANIFEST_PRIVATE_KEY`。
// **fail-closed**：公钥缺失 / manifest 下载失败 / 签名不匹配 / hash 不匹配 → 一律 throw、拒绝自动安装。
// 失败按**类型**分三类（N2-02 + M3-03，定义见 ./update-manifest-verify.mjs）：
//  - UpdateVerifyMismatchError：确定不符 → 调用方删缓存包 + 降级开 RELEASE_LATEST_URL 让用户手动下；
//  - UpdateVerifyUnavailableError：暂时无法校验（5xx / 超时 / 网络 / 公钥读不了 / 本地读文件失败）→ 同样拒绝安装，
//    但**保留**缓存包、不开发布页，下次点徽标重新验（见 rejectUnverifiedWinUpdate / resumeRetainedWinInstaller）；
//  - UpdateVerifyManifestMissingError（Unavailable 的子类，HTTP 404 / 410）：这个 release 没带 manifest——
//    保留缓存、仍拒绝安装，但重试不会好，所以弹「该版本暂不支持自动校验」并开发布页（降级手动下载）。
// 判定逻辑（验签 → version → 条目 → size → sha256）在 ./update-manifest-verify.mjs（纯函数、有单测）。
const UPDATE_MANIFEST_PUBLIC_KEY_PATH = path.join(
  __dirname,
  "update-manifest-public-key.pem",
);

// 流式算文件 SHA-256（安装包 100MB+、不整读进内存）
const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });

// 读内置公钥 + 取 manifest + 过「签名 / version / 条目」三道廉价检查，返回 { manifest, publicKeyPem }。
// 从 verifyDownloadedUpdate 拆出来（F1-01）：mac 暂存要在**下载 dmg 之前**先做这一步——清单只有几百字节，
// 取不到 / 验不过时根本不用白下 112MB 的 dmg（M3-04 的根因就是先下 dmg、后取清单）。
// 这里只是 fail-fast 的前置检查、不做最终裁决：最终裁决仍是 verifyDownloadedUpdate 里的 verifyManifestEntry
// （它拿实测 size / SHA-256 重走全部检查）。任一步不过 → throw 带类型的错。无「公钥空跳过」分支。
const loadSignedManifest = async (version, assetName) => {
  let publicKeyPem = "";
  try {
    publicKeyPem = readFileSync(UPDATE_MANIFEST_PUBLIC_KEY_PATH, "utf8").trim();
  } catch (err) {
    // 公钥是壳自带的：读不出来是我们这边的问题、不是安装包的问题 → 暂时无法校验（不删缓存包）
    throw new UpdateVerifyUnavailableError(
      `更新验签公钥缺失（${UPDATE_MANIFEST_PUBLIC_KEY_PATH}）：${err?.message || err}、已中止替换`,
      "public-key",
      { cause: err },
    );
  }
  if (!publicKeyPem) {
    throw new UpdateVerifyUnavailableError("更新验签公钥为空、已中止替换（fail-closed）", "public-key");
  }

  const manifestUrl = `https://github.com/jianger666/Flowship/releases/download/v${version}/update-manifest.json`;
  // 取清单（含 30s 超时、网络 / HTTP / 解析失败的分类）在纯模块里：
  // 超时必须有——Windows 链路里验签挂在「下载完成」之后、徽标处于 downloading 态，
  // 网络挂起会让 promise 永不收敛 → 徽标永远点不动、只能重启应用；mac 暂存链路共用本函数、同样受益。
  // 这些失败都只说明「这次没拿到清单」（GitHub 抖动 / 强制门户），不证明安装包有问题：
  // 仍然拒绝安装（fail-closed），但保留已下载的包、让用户稍后重试，而不是白白再下 112MB。
  const manifest = await fetchUpdateManifest({ url: manifestUrl });
  // 顺序与改造前一致：先过「签名 / version / 条目」三道廉价检查，manifest 有问题就别白算
  // 100MB+ 的 SHA-256（也不会在 manifest 已坏时去读一个可能根本不存在的文件）；
  // 算出实测 size / sha256 后，再交给 verifyManifestEntry 做**最终裁决**（它自己重走全部检查，
  // 通过与否只看它，这里的前置调用只是 fail-fast、不是第二套判定）。
  findSignedManifestEntry({ manifest, publicKeyPem, version, assetName });
  return { manifest, publicKeyPem };
};

// 下载完的安装包（mac dmg / Windows exe）验 manifest 签名 + SHA-256 + 大小。任一步不过 → throw
// （调用方 catch 降级开下载页；此时还没动旧应用）。
// preloaded：调用方已用 loadSignedManifest 取好的清单上下文（mac 在下载 dmg 之前先取了）；
// 不传则在这里现取（Windows 路径：electron-updater 下完才进来，行为与拆分前完全一致）。
const verifyDownloadedUpdate = async (version, filePath, assetName, preloaded) => {
  const { manifest, publicKeyPem } = preloaded ?? (await loadSignedManifest(version, assetName));
  let stat;
  let digest;
  try {
    stat = await fs.stat(filePath);
    digest = await sha256File(filePath);
  } catch (err) {
    // 本地读不了文件（杀软占用 / 权限 / 文件被清理）：没法证明内容不符 → 暂时无法校验。
    // 文件真被清理了的话，保留缓存无副作用（electron-updater 发现缓存失效会重新下载）
    throw new UpdateVerifyUnavailableError(
      `读取已下载的安装包失败：${err?.message || err}、已中止替换`,
      "local-io",
      { cause: err },
    );
  }
  verifyManifestEntry({
    manifest,
    publicKeyPem,
    version,
    assetName,
    size: stat.size,
    sha256: digest,
  });
  log(`[updater] manifest 验签 + 安装包摘要校验通过（${assetName}）`);
};

// ---------- mac 延迟自更新（下载暂存 ≠ 立刻替换） ----------
//
// 历史（为什么不再立刻替换 /Applications）：
// 旧链路（V0.7.12~V0.10.x）下载验签完立刻 ditto 覆盖 /Applications 里的 .app，
// 再弹「立即重启 / 稍后」。用户点「稍后」= 老进程继续跑 + 磁盘已是新包 →
// SDK agent 的 shell（cursorsandbox / zsh state-dump helper）按旧路径 lazy-load
// 资源与新 bundle 失配，永久挂死（v0.9.10→14 / 正式包「稍后重启」线上确诊）。
// V0.10.1 加了 update-pending-restart.json 硬闸（server 拒起新任务），体验仍差：
// 点「稍后」就废了、必须重启。
//
// 现策略：下载 + 验签 + 挂载后只 ditto 到 userData/updates/staged-<ver>.app，
// **全程不碰 /Applications**。替换只发生在三个时机：
//   1) 用户点「立即更新」→ apply + relaunch
//   2) 用户点「稍后」后正常退出 → before-quit 里 apply（不 relaunch）
//   3) 退出替换失败 → 下次启动早期 apply + relaunch（窗口未开、无感知）
// 老进程始终跑在没被动过的老包上，「稍后」完全可用。
//
// 原理旁注：quarantine 只有浏览器等下载器会打、壳 fetch 落盘无 quarantine →
// Gatekeeper 不评估 → 免开发者证书。CR-02：attach 前过 verifyDownloadedUpdate。

// 阶段 1：下载 dmg → 验签 → attach → ditto 到暂存目录；不碰 /Applications。
// 已有同版本有效暂存则跳过（轮询 / 徽标重入友好）。
// 并发互斥（蓝军 P1）：轮询 runUpdateCheck 与徽标 installUpdateNow 可能同时触发、
// staged.json 落盘前双方都会走下载分支抢写同一 dmg / staged 目录——single-flight、
// 重入方 await 同一个 promise 拿同一份暂存结果。
let stagingPromise = null;
// 本进程内「验签失败过」的版本（M3-04）：自动路径（2h 轮询 / 设置页检查更新）据此不再重下同一版本。
// 为什么需要：dmg 有 100MB+、验签失败后在 downloadAndStageMacUpdateInner 的 finally 里一定会删，
// 清单持续取不到 / 验不过时，没有这条记录就会「每 2 小时重下一遍 dmg → 验签失败 → 又删」。
// 只记**确定性**的验签失败（isPermanentVerifyFailure：确定不符 Mismatch、该 release 没带 manifest 404 / 410）——
// 这两类重试不会好，才永久跳过。其余失败（Unavailable：5xx / 限流 / 超时 / 网络…；以及 dmg 下载 502 / 不完整、
// hdiutil / ditto 失败这类未归类错误）不记在这里：一次瞬时失败就让该版本在本进程内永久不再自动暂存，
// 会废掉 2h 轮询「网络恢复后自愈」的价值（F1-01），它们走下面的 macVerifyRetry 按时间退避。
// 只在内存里（进程内），重启应用即重置——重启本身就是一次显式重试。
// 重试由用户点徽标触发（macSelfUpdate → downloadAndStageMacUpdate，不看这条记录）；成功暂存后清掉。
// 登记发生在 downloadAndStageMacUpdate 的 catch 里：对任何触发方式（轮询 / 设置页检查更新 / 点徽标）、
// 不管这次有没有弹框一律登记——「谁弹框」与「谁登记」是两件事（K3-05，弹框见 handleMacStageFailure）。
let macVerifyFailedVersion = null;
// **非永久**失败的退避记录 { version, failures, notBefore }（策略与数值见 ./update-verify-retry.mjs）：
// 退避期内自动路径跳过暂存，到点放行；用户点徽标的显式重试不受约束、失败照样累计；成功暂存清掉，换版本从头算。
// 第七轮 P2-2：以前只有 Unavailable 才登记，未归类错误（dmg 502 / hdiutil / ditto 失败……）既不登记也不弹框，
// 每次轮询都重走一遍「清单 → 下载 100MB+ → 失败 → 删除」；现在凡是非永久失败都登记。failures 同时就是「连续失败次数」。
// 如实说明它管得到谁（R6-5 实证、第八轮 L2-04 订正）：退避（5/10/20/40/80/120/120… 分钟）主要挡非轮询触发的自动暂存（设置页「检查更新」）；
// 对 2 小时轮询**不是保护**：放不放行只看「最近一次失败的时刻 + 退避」是否 ≤ 下一次轮询到点——常见情形（失败紧跟触发、耗时秒~分钟级）
// 前 5 次都放行，但失败发生得晚（k=5 时 delta > 40 分钟，或点徽标 / 手动检查在两次轮询之间失败）就会被挡一轮；
// 封顶后（连续失败 ≥ 6 次）失败只要晚于触发就隔一轮跳过一次——详见 update-verify-retry.mjs 文件头与 tests/update-verify-retry.test.ts。
// 轮询靠的是下面的 macStageGiveUpVersion 闸；暂时性失败对用户的打扰靠 buildVerifyRejectionNotice（后台触发不弹框）兜住；连续 3 次再提示一次（见下）。
let macVerifyRetry = null;
// 「会白下 dmg 的失败」连续计数 { version, count }（第八轮 L2-01；口径与哪些失败计入见 ./update-verify-retry.mjs 的 isCostlyStageFailure）：
// **不分触发方式**（后台 / 设置页检查更新 / 点徽标的失败都计）；Unavailable（清单阶段、下载之前就败）既不计数也不清零；
// 永久失败不进这里（有 macVerifyFailedVersion）。成功暂存清掉；换版本从 1 重算。
let macCostlyFailures = null;
// 「放弃自动暂存」闸（第八轮 L2-01）：登记的版本 = 该版本的 macCostlyFailures 已达 STAGE_GIVE_UP_AFTER（3）。
// 为什么需要：退避不读 failures、对 2h 轮询基本不设防，未归类失败（dmg 502 / 不完整 / hdiutil / ditto / 找不到 .app）
// 会在每一轮轮询里整包重下 100MB+。**只有后台轮询（runUpdateCheck）读它**：遇到就跳过自动暂存、只记一行日志；
// 设置页「检查更新」（manualCheckForUpdate）与点徽标（macSelfUpdate）不看它、照常发起尝试——成功暂存则解除，失败则
// 计数继续涨、闸保持登记（不会借一次手动尝试多放后台 3 次）。换版本（只按版本相等判断）/ 成功暂存 / 重启（内存变量）解除。
// 与 macVerifyFailedVersion 的区别：那个是「重试不会好」的永久跳过（确定不符 / 没带清单）；这个只是「别再替用户反复烧流量」，
// 用户一点就能重试。这里不弹框：「多次失败」提示框（handleMacStageFailure）说的「点徽标重试或手动下载」正是此后唯一的重试入口。
let macStageGiveUpVersion = null;
// 「自动更新多次失败」说明框已弹过的版本（进程内、按版本）。**刻意独立于 wasPrompted**：wasPrompted 是「每版本一次」的持久名额，
// 确定不符 / 没带清单的安全告警也用它（alreadyPrompted 为真时后台全部静默）；若「多次失败」提示占用它，
// 同一版本 3 次暂时性失败后真出现「确定不符」就会因名额已用而静默——完整性告警丢失。成功暂存时清掉（连续失败从头算）。
let repeatedFailurePromptedVersion = null;
const downloadAndStageMacUpdate = (version) => {
  if (stagingPromise) return stagingPromise;
  stagingPromise = downloadAndStageMacUpdateInner(version)
    .then((meta) => {
      macVerifyFailedVersion = null;
      macVerifyRetry = null;
      macCostlyFailures = null;
      macStageGiveUpVersion = null;
      repeatedFailurePromptedVersion = null;
      // 已暂存跳过下载 / 下载暂存完成——统一在这置 ready、页面徽标变「重启更新」。
      // 用户点徽标触发的链路（installInFlight 持锁中）跳过：macSelfUpdate 马上置
      // installing、中间闪一帧可点的 ready 没意义（蓝军 P1）
      if (!installInFlight) {
        setUpdateState({ phase: "ready", version, percent: 100, error: null });
      }
      return meta;
    })
    .catch((err) => {
      // 记录失败（见上方 macVerifyFailedVersion / macVerifyRetry / macCostlyFailures 注释）：
      // 确定性失败永久跳过、**其余一律**按时间退避（P2-2：含未归类错误）；按类型判、不匹配文案。
      // 一律登记、不分触发方式（后台 / 设置页检查更新 / 点徽标）——「谁弹框」另见 handleMacStageFailure。
      if (isPermanentVerifyFailure(err)) {
        macVerifyFailedVersion = version;
      } else {
        macVerifyRetry = nextVerifyRetry(macVerifyRetry, version, Date.now());
        // 第八轮 L2-01：再数一遍「会白下 dmg 的失败」（Unavailable 不计、也不清零）；够 3 次就让后台轮询别再替用户反复烧流量
        macCostlyFailures = nextCostlyFailureRecord(macCostlyFailures, version, err);
        if (shouldGiveUpAutoStage(macCostlyFailures, version)) {
          macStageGiveUpVersion = version;
        }
      }
      // 失败回 available（徽标仍亮、点击可重试）；弹不弹框由调用方决定。
      // error 文案取 buildVerifyRejectionNotice 的 stateError（与 Windows rejectUnverifiedWinUpdate 同一个来源）；
      // 它与触发方式无关，所以这里不传 trigger
      setUpdateState({
        phase: "available",
        version,
        error: buildVerifyRejectionNotice(err).stateError,
      });
      throw err;
    })
    .finally(() => {
      stagingPromise = null;
    });
  return stagingPromise;
};

const downloadAndStageMacUpdateInner = async (version) => {
  const existing = await readStagedMeta();
  if (existing?.version === version && existsSync(existing.appPath)) {
    log(`[updater] v${version} 已暂存于 ${existing.appPath}、跳过下载`);
    return existing;
  }
  // 换版本 / 暂存损坏：清掉旧暂存再下
  if (existing) await clearStagedUpdate(existing);

  // Intel 包 v1.1.5 起提供、老版本 x64 用户不存在所以不用考虑兼容
  const dmgArch = process.arch === "arm64" ? "arm64" : "x64";
  const assetName = `fe-ai-flow-${version}-mac-${dmgArch}.dmg`;
  const dmgUrl = `https://github.com/jianger666/Flowship/releases/download/v${version}/${assetName}`;
  const appPath = runningAppPath();
  if (!appPath.endsWith(".app") || appPath.startsWith("/Volumes/")) {
    // 非常规安装位置（如直接在 dmg 里跑）——抛给调用方降级开下载页
    throw new Error("非常规安装位置、无法自更新");
  }
  // F1-01：先取清单、再下 dmg。清单只有几百字节、dmg 有 100MB+——清单取不到 / 验不过（签名、version、
  // 条目）就别白下一遍（M3-04 的根因）。放在 try 之外：这时还没碰磁盘 / 挂载点，抛出即可。
  // 取到的清单上下文传给下面的 verifyDownloadedUpdate 复用、不重复请求；它仍会用下载后实测的
  // size / SHA-256 做最终裁决（verifyManifestEntry），这里只是 fail-fast 的前置检查。
  const manifestCtx = await loadSignedManifest(version, assetName);
  const updatesDir = updatesDirPath();
  const dmgPath = path.join(updatesDir, `v${version}.dmg`);
  const mountPoint = path.join(updatesDir, `mnt-${Date.now()}`);
  const stagedAppPath = path.join(updatesDir, `staged-${version}.app`);
  try {
    mkdirSync(updatesDir, { recursive: true });
    // 磁盘预检（R14 B2-4 / Q15-01）：dmg（~120MB）和展开的 .app（~410MB）会同时在盘上，不够就别开始下——
    // 否则下到一半 ENOSPC，用户白等一趟还只看到一句 errno。阈值 MIN_MAC_STAGE_FREE_MB 见 disk-space.mjs；量不到放行。
    // 不够时抛 StageNoSpaceError：点徽标 / 设置页检查更新弹专门文案（不开发布页）、后台触发静默，不计入「会白下 dmg」的闸。
    const stageSpace = assertMacStageSpace(updatesDir, statfsSync);
    log(`[updater] 暂存预检 free=${stageSpace.freeMB ?? "?"}MB min=${stageSpace.minMB}MB`);
    log(`[updater] 下载 ${dmgUrl}`);
    setUpdateState({ phase: "downloading", version, percent: 0, error: null });
    const res = await fetch(dmgUrl);
    if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
    // 流式落盘 + Dock 图标进度条 + 页面徽标进度（整数百分点变化才推、别刷爆 IPC）
    const total = Number(res.headers.get("content-length")) || 0;
    let lastPct = -1;
    // R14 B2-4 / Q15-01：落盘走 stream.pipeline（见 dmg-download.mjs）。写盘失败（磁盘满 / 权限 / 目录被删）= reject 并销毁整条链，
    // 落到下面既有的 finally 清理 + downloadAndStageMacUpdate 的 catch 登记；改前手写 for-await + drain：目的流没有 error 监听、
    // 流销毁后 drain 永不触发 → 这个函数永不 settle、stagingPromise（单飞锁）永不释放、徽标停在「下载中」直到重启。
    const got = await streamResponseToFile({
      body: res.body,
      dest: dmgPath,
      createWriteStream,
      onProgress: (received) => {
        if (!total) return;
        mainWindow?.setProgressBar(received / total);
        const pct = Math.floor((received / total) * 100);
        if (pct > lastPct) {
          lastPct = pct;
          setUpdateState({ percent: pct });
        }
      },
    });
    mainWindow?.setProgressBar(-1);

    // 完整性校验：下到残缺包就直接中止（v0.8.0 踩过残缺 dmg → ditto 半新半旧）
    if (total && got !== total) {
      throw new Error(`dmg 下载不完整（${got}/${total} 字节）、已中止暂存`);
    }

    // CR-02：签名 manifest 校验——在 attach 之前拦掉被篡改的包
    await verifyDownloadedUpdate(version, dmgPath, assetName, manifestCtx);

    await execFileStrict("hdiutil", [
      "attach", dmgPath, "-nobrowse", "-quiet", "-mountpoint", mountPoint,
    ]);
    const newApp = readdirSync(mountPoint).find((n) => n.endsWith(".app"));
    if (!newApp) throw new Error("dmg 里没找到 .app");

    // 拷到暂存（保留签名 / 权限 / xattr）；失败则清半成品、/Applications 未动
    await fs.rm(stagedAppPath, { recursive: true, force: true }).catch(() => {});
    log(`[updater] 暂存 ${stagedAppPath}`);
    await execFileStrict("ditto", [path.join(mountPoint, newApp), stagedAppPath]);
    const meta = { version, appPath: stagedAppPath };
    await writeStagedMeta(meta);
    log(`[updater] v${version} 已暂存、等待立即更新或退出时替换`);
    return meta;
  } finally {
    mainWindow?.setProgressBar(-1);
    await execFileP("hdiutil", ["detach", mountPoint, "-quiet"]);
    await fs.rm(dmgPath, { force: true }).catch(() => {});
  }
};

// 阶段 2：把暂存 .app 替换到当前 appPath。
// relaunch=true → 写 pending marker（立即更新防御窗）+ relaunch；
// pendingMarker=false → 启动兜底路径用（替换后清 marker，马上 relaunch 进新包）。
// 失败 throw、调用方决定是否挡退出 / 降级开下载页；回滚旧 app。
const applyStagedUpdate = async ({ relaunch, pendingMarker = relaunch } = {}) => {
  const meta = await readStagedMeta();
  if (!meta?.version || !meta?.appPath) {
    throw new Error("没有有效的暂存更新");
  }
  if (!existsSync(meta.appPath)) {
    await clearStagedUpdate(meta);
    throw new Error(`暂存包丢失（${meta.appPath}）`);
  }
  const appPath = runningAppPath();
  if (!appPath.endsWith(".app") || appPath.startsWith("/Volumes/")) {
    throw new Error("非常规安装位置、无法套用暂存更新");
  }
  // 「立即更新」失败恢复用：改盘前 server 是否在跑（启动兜底路径 serverProc=null、失败不能误拉）
  const hadRunningServer = !!serverProc;
  if (relaunch) {
    // ⚠️ 「立即更新」必须在改盘**之前**停 server（二轮复审 P1）：
    // 1) app.exit() 不触发 before-quit、唯一杀 server 的钩子会被绕过 → 旧 server
    //    孤儿占端口、新实例必弹「端口被占用」（2026-07-23 用户线上确诊回归）；
    // 2) 先停再替换、避免旧 server 在「磁盘已是新包」上多跑最长 2s（SIGTERM 优雅期）
    //    触发 lazy-load 半新半旧（延迟替换方案要解决的原始问题域）。
    // 退出路径（relaunch=false）server 已在 before-quit 被杀；启动兜底 serverProc=null 秒过。
    quitting = true;
    await stopServer();
  }
  const updatesDir = updatesDirPath();
  mkdirSync(updatesDir, { recursive: true });
  // 旧 app 先挪到暂存（同卷 rename 原子）；新包同卷 rename 优先、跨卷再 ditto
  const stagedOld = path.join(updatesDir, `old-${Date.now()}.app`);
  log(`[updater] 套用暂存 v${meta.version} → ${appPath}`);
  try {
    await fs.rename(appPath, stagedOld);
    try {
      try {
        await fs.rename(meta.appPath, appPath);
      } catch {
        // EXDEV 等跨卷：ditto 拷过去再删源
        await execFileStrict("ditto", [meta.appPath, appPath]);
        await fs.rm(meta.appPath, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      await fs.rename(stagedOld, appPath).catch(() => {});
      throw err;
    }
  } catch (err) {
    // relaunch 路径 server 已停：替换失败（旧 app 已回滚 / 未动）必须把 server 拉回来、
    // 否则 app 变成没后端的僵尸且 quitting=true 连「服务异常退出」提示都被吞。
    // 启动兜底路径（改盘前 server 本就没起）不拉——whenReady 后续流程自己会 startServer。
    if (relaunch) {
      quitting = false;
      if (hadRunningServer && !serverProc) startServer();
    }
    throw err;
  }
  await fs.rm(stagedOld, { recursive: true, force: true }).catch((err) => {
    log(`[updater] 清理暂存旧包失败（启动时兜底再清）${err?.message || err}`);
  });
  // 元信息消费掉（包已 rename 走或已删）
  await fs.rm(stagedMetaFile(), { force: true }).catch(() => {});

  // ⚠️ 故意不改磁盘文件名（蓝军 P0）：改名后若进程继续跑必坏；交给 maybeSelfRenameOnMac。

  if (pendingMarker) {
    // 「立即更新」路径：替换完到 relaunch 之间的极短窗口仍写硬闸（V0.10.1 防御保留）
    try {
      const marker = pendingRestartMarker();
      mkdirSync(path.dirname(marker), { recursive: true });
      await fs.writeFile(
        marker,
        JSON.stringify({ version: meta.version, at: Date.now() }),
      );
    } catch (err) {
      log(`[updater] 写待重启 marker 失败（忽略）${err?.message || err}`);
    }
  } else {
    // 启动兜底 / 退出替换：清掉 marker，避免新进程误拦
    await fs.rm(pendingRestartMarker(), { force: true }).catch(() => {});
  }

  log(`[updater] v${meta.version} 已就位${relaunch ? "、即将重启" : "（退出路径、下次打开即新版）"}`);
  if (relaunch) {
    // server 已在替换前停掉（见函数开头）、这里直接重启进新包
    app.relaunch();
    app.exit(0);
  }
};

// 启动早期兜底：有比当前新的暂存 → 立刻套用并 relaunch（窗还没开、用户无感知）；
// 暂存版本 ≤ 当前（已手动升过 / 退出时已装上）→ 清暂存。返 true = 本进程要退。
const tryApplyStagedUpdateOnLaunch = async () => {
  if (!IS_MAC || !app.isPackaged || IS_TEST) return false;
  const meta = await readStagedMeta();
  if (!meta) return false;
  const current = app.getVersion();
  if (!isNewer(meta.version, current)) {
    log(`[updater] 启动清过期暂存 v${meta.version}（当前 v${current}）`);
    await clearStagedUpdate(meta);
    return false;
  }
  if (!existsSync(meta.appPath)) {
    log(`[updater] 启动发现暂存元信息但包丢失、清 meta`);
    await clearStagedUpdate(meta);
    return false;
  }
  try {
    log(`[updater] 启动兜底套用暂存 v${meta.version}`);
    // pendingMarker=false：替换后清硬闸，马上 relaunch 进新包
    await applyStagedUpdate({ relaunch: true, pendingMarker: false });
    return true; // relaunch 后通常走不到这；防守返回
  } catch (err) {
    // 替换失败不挡启动——保留暂存下次再试、老包继续跑
    log(`[updater] 启动兜底套用失败（保留暂存、继续启动）${err?.message || err}`);
    return false;
  }
};

// 退出时套用暂存（不 relaunch）。失败不阻塞退出——下次启动 tryApplyStagedUpdateOnLaunch 再试。
const applyStagedUpdateOnQuit = async () => {
  if (!IS_MAC || !app.isPackaged || IS_TEST) return;
  const meta = await readStagedMeta();
  if (!meta || !isNewer(meta.version, app.getVersion())) return;
  if (!existsSync(meta.appPath)) {
    await clearStagedUpdate(meta);
    return;
  }
  try {
    log(`[updater] 退出时套用暂存 v${meta.version}`);
    await applyStagedUpdate({ relaunch: false, pendingMarker: false });
  } catch (err) {
    log(`[updater] 退出时套用失败（不挡退出、下次启动再试）${err?.message || err}`);
  }
};

// mac 发现新版后的入口（保留函数名、供 installUpdateNow 调用）：
// 下载暂存（已暂存则跳过）→ 立刻套用并 relaunch。
// 「稍后」不走这里——用户不点徽标时由退出钩子套用已暂存包。
const macSelfUpdate = async (version) => {
  try {
    await downloadAndStageMacUpdate(version);
    // 暂存就绪 → 替换 + 重启（applyStagedUpdate 内部会先停 server 再 relaunch）
    setUpdateState({ phase: "installing", version, error: null });
    await applyStagedUpdate({ relaunch: true });
  } catch (err) {
    // 弹框内容按失败类型分（K3-04，与 Windows 的 rejectUnverifiedWinUpdate 读同一个纯函数、trigger="user"——用户点了徽标在等结果）：
    //  - 验签类（确定不符 / 暂时无法校验 / 没带清单）：标题、正文、是否开发布页都取 notice。
    //    暂时性失败只弹说明、**不开发布页**（网络好了再点徽标就能成），以前这里一律开页、比 Windows 激进；
    //  - 其余（dmg 下载 502 / 不完整、hdiutil / ditto 失败、套用失败……）说的不是「校验」，套用「暂时无法校验更新包」会误导，
    //    用通用的「自动更新失败」+ 开发布页（降级手动下载）——文案取 buildGenericUpdateFailureNotice，与设置页「检查更新」触发的
    //    暂存失败（handleMacStageFailure, trigger="user"）共用同一个函数（第八轮 L2-02：以前这里内联一份、那边套了验签文案）。
    const verifyType = isVerifyFailure(err);
    const notice = verifyType
      ? buildVerifyRejectionNotice(err, { trigger: "user" })
      : buildGenericUpdateFailureNotice(err);
    log(
      `[updater] 自更新失败：${err?.message || err}、${verifyType ? "按验签失败处置" : "按通用失败处置（降级开下载页）"}（开发布页=${notice.openReleasePage}）`,
    );
    // 状态回退：暂存还有效回 ready（点徽标重试秒装）、否则回 available（重试重下）
    const staged = await readStagedMeta().catch(() => null);
    const stillStaged =
      staged?.version === version && staged?.appPath && existsSync(staged.appPath);
    setUpdateState({
      phase: stillStaged ? "ready" : "available",
      version,
      error: String(err?.message || err),
    });
    if (notice.showDialog) dialog.showErrorBox(notice.title, notice.body);
    if (notice.openReleasePage) void shell.openExternal(RELEASE_LATEST_URL);
  } finally {
    mainWindow?.setProgressBar(-1);
  }
};

// 应用更新（页面点右上角「新版本」徽标走到这；发现新版本身不弹窗，2026-07-15 用户拍板）：
// mac：确保已暂存 → apply + relaunch（轮询已后台暂存的包在此套用；未暂存则先下）
// win：此刻才开始下载（autoDownload=false）、下完直接 quitAndInstall（用户已在页面确认过，
//      不再弹第二次系统框；退出时也不再静默装——Windows NSIS 卸装路径翻车过多次）
// 安装互斥锁：徽标连点 / will-navigate 重入时第二次直接忽略——
// 第一次点击已把暂存包 rename 消费掉、重入 apply 必吃「没有有效的暂存更新」
// 并误弹「自动更新失败」（2026-07-23 用户线上确诊）。UI disabled 是第一道防线、这里兜底。
let installInFlight = false;
const installUpdateNow = async () => {
  if (!updateReadyVersion || installInFlight) return;
  installInFlight = true;
  try {
    if (UPDATE_MODE === "download") {
      log(`[updater] mac 套用更新（v${updateReadyVersion}）`);
      await macSelfUpdate(updateReadyVersion);
      return;
    }
    // win：按状态分流——下载中 / 安装中忽略（installing 不短路会落到重新 downloadUpdate、
    // 二轮复审 P1）；已下载完（上次 quitAndInstall 失败回 ready）直接装，不重复下载；
    // 其余此刻才开始下载（autoDownload=false）
    if (updateState.phase === "downloading" || updateState.phase === "installing") return;
    // M3-05：上一次验签没过但保留了缓存（暂时无法校验 / 没带 manifest）→ 先直接对那份文件重验，
    // 不去赌 electron-updater 会不会重发 update-downloaded。通过 → phase=ready、落进下面既有的
    // 「已下载、直接安装」分支；仍失败 → 已按类型处置过（弹框 / 开发布页）、这里直接返回；
    // 没有可复用的缓存（"fallback"）→ 往下照旧 downloadUpdate()。
    if (updateState.phase === "available" && winRetainedInstaller) {
      const resumed = await resumeRetainedWinInstaller(updateReadyVersion);
      if (resumed === "rejected") return;
    }
    if (updateState.phase === "ready") {
      log(`[updater] win 已下载、直接安装重启 v${updateReadyVersion}`);
      // await（持锁）：installWinUpdate 开头多了异步验签（R9-01）、验签期间 phase 还是 ready——
      // 不持锁的话这段窗口里再点一次徽标会并发进来第二个 installWinUpdate（双验签、双通知、双墓碑）
      await runInstallWinUpdate(updateReadyVersion);
      return;
    }
    try {
      log(`[updater] win 开始下载 v${updateReadyVersion}`);
      const updater = await ensureWinAutoUpdater();
      setUpdateState({ phase: "downloading", version: updateReadyVersion, percent: 0, error: null });
      // 清掉上一轮的验签任务引用：下面等的必须是「这一次」下载完成事件里启动的那个
      winDownloadedVerifyTask = null;
      await updater.downloadUpdate();
      // update-downloaded 事件里的验签是异步的（取 manifest + 算 SHA-256）、downloadUpdate() 返回时
      // 它可能还没跑完：等它出结果再往下走。验签失败时事件处理里已经弹框 / 删缓存包 / 回 available，
      // 这里只静默返回、不再弹第二次框
      await winDownloadedVerifyTask;
      if (updateState.phase === "installing" || quitting) return;
      if (updateState.phase !== "ready") {
        if (updateState.phase === "downloading") {
          // downloadUpdate 已 resolve 却没收到完成事件（理论不会发生）：别把徽标永远卡在「下载中」
          log("[updater] win downloadUpdate 已返回但未收到 update-downloaded、回到可重试态");
          mainWindow?.setProgressBar(-1);
          setUpdateState({
            phase: "available",
            error: "下载已结束但未收到完成通知、已取消本次自动更新，请重试",
          });
        }
        return;
      }
      // 下完直接装：用户点徽标时已经确认过，对齐 mac「确认一次就干」
      await runInstallWinUpdate(updateReadyVersion);
    } catch (err) {
      // quitAndInstall 过程中 downloadUpdate 可能被中断，别误报下载失败
      if (quitting || updateState.phase === "installing") return;
      mainWindow?.setProgressBar(-1);
      log(`[updater] win 下载失败 ${err?.message || err}`);
      setUpdateState({
        phase: "available",
        version: updateReadyVersion,
        error: String(err?.message || err),
      });
      dialog.showErrorBox(
        "下载更新失败",
        `${err?.message || err}\n\n可稍后重试、或去发布页手动下载安装。`,
      );
      void shell.openExternal(RELEASE_LATEST_URL);
    }
  } finally {
    installInFlight = false;
  }
};

// mac：查 GitHub latest release 的版本号——请求 /releases/latest 拿 302 的
// location（…/releases/tag/vX.Y.Z）抠版本、不走 API 不吃 rate limit
// ⚠️ 必须重定向安全（2026-07-15 事故）：旧实现 redirect:"manual" 只读第一跳 Location 抠 tag——
// 仓库改名后第一跳变成「改名重定向」（不含 /tag/）、全体存量客户端「拿不到最新版本号」、更新链断。
// 现实现：跟随重定向到底、从最终 URL 抠 tag（改名/多级跳都不怕）。
// 改名 Flowship 的计划：等全员升到本版本之后再改仓库名、届时零影响。
const fetchLatestVersion = async () => {
  // 超时必须有：2h 轮询下网络挂起会让 promise 永不收敛、请求堆积（同文件其它网络调用同款）
  const res = await fetch(RELEASE_LATEST_URL, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const m = (res.url || "").match(/\/tag\/v(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
};

// 每 2 小时轮询一次更新——app 长期开着不关（同事习惯）也能收到新版提醒、
// 不止在启动时查一次（v0.7.22）。发现新版只静默点亮徽标、不弹窗（2026-07-15）。
const UPDATE_POLL_MS = 2 * 60 * 60 * 1000;

// win electron-updater 单例：首次用到时初始化、轮询 / 手动检查 / 下载复用同一个、不重复注册监听器
let winAutoUpdater = null;

// ---------- Windows 更新包验签（R9-01、fail-closed） ----------
//
// 威胁：electron-updater 只信 latest.yml 里的 sha512，而 latest.yml 和 exe 都在 GitHub release 上——
// 谁能改 release 谁就能推恶意 exe，壳会静默 quitAndInstall 把它跑起来。exe 目前没有代码签名证书，
// 所以复用 mac 的方案：CI 把 exe 的 SHA-256 / size 也签进同一份 update-manifest.json（Ed25519），
// 壳用内置公钥验签、再比对本地 exe 的实测 size / sha256（verifyDownloadedUpdate）。
// 验两次：① update-downloaded 时（失败不进 ready、用户看不到「重启更新」再失败）；
//        ② installWinUpdate 里 quitAndInstall 之前（验的是此刻磁盘上、即将被拉起的那个文件）。
//
// manifest 里的查找键 assetName 取自 latest.yml 的 files[].url（见 pickWinInstallerAssetName 的注释），
// 不是 downloadedFile 的本地文件名——它是 electron-updater 的缓存路径（可能来自上次启动留下的
// update-info.json），属于本地状态、不是 release 上的事实。
//
// 兼容性：
// - 已经装在用户机器上的旧壳没有这段代码、行为不变（仍只信 latest.yml 的 sha512）——
//   本修复只对「已装上含本逻辑的版本」之后的更新生效；
// - 新壳对「没有 manifest / manifest 里没有 exe 条目 / 签名不对」的 release 一律拒绝自动安装、
//   降级为弹框 + 开发布页手动下载（没有「manifest 缺失就放行」的兼容分支，否则攻击者删掉 manifest 即可降级绕过）。
//   发版链由 release.yml finalize 保证每个 release 的 manifest 同时含 2 枚 dmg + 1 枚 exe。
//
// 已知取舍：验签通过到 quitAndInstall 之间（通知 + 墓碑 + 1.5s 等待）文件仍躺在用户可写的缓存目录，
// 理论上同用户权限的本地进程可在这个窗口里调包；但同权限进程本来就能直接改已安装的应用文件，
// 不在「篡改 release」这个威胁模型内，所以不为此再引入拷贝 / 锁文件的复杂度。

// 已通过验签、等待安装的 exe：{ version, file, assetName }；验过之前、验失败后都是 null
let winPendingInstaller = null;
// 验签没过、但**保留了缓存包**的那一份：{ version, file, assetName } 或 null（M3-05）。
// 由 rejectUnverifiedWinUpdate 在「保留缓存」（暂时无法校验 / 没带 manifest）时登记、
// resumeRetainedWinInstaller 在用户点徽标时消费。为什么要自己记：原先「保留缓存、点徽标重新验」
// 全靠 electron-updater 缓存命中时重发 update-downloaded——源码确实会重发（AppUpdater.executeDownload
// 命中缓存走 done(false) → dispatchUpdateDownloaded），但那是库的内部行为、不是公开契约，
// 万一哪个版本不再重发，用户就卡在「缓存在、却永远进不了 ready」。自己记下路径，点徽标时直接重验，
// 不论库怎么表现都不会卡死。只在内存里：重启应用后 electron-updater 的缓存校验（sha512）会重新接管。
let winRetainedInstaller = null;
// 最近一次 update-downloaded 事件启动的验签任务（永不 reject、结果体现在 updateState.phase 上）。
// installUpdateNow 在 downloadUpdate() 返回后等它、避免与事件里的验签并发处置
let winDownloadedVerifyTask = null;

// Windows 路径大小写不敏感；只用于「同一个文件」判定
const sameWinPath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// 对待装 exe 做完整验签；失败 throw（由调用方决定怎么处置）。
// 门禁本体（file / assetName → 版本号三段数字 → 库登记的待装文件交叉校验 → 验签）已抽到
// ./win-pending-verify.mjs 做成依赖注入的纯函数（F1-02：以前全仓没有测试真调用过它、只靠源码顺序 grep）；
// 这里只负责把运行时依赖接进去。winAutoUpdater 必须在调用时才读（getRunFile 是惰性的）：
// 它在应用启动后才初始化、之后还会被换。
const verifyWinPendingInstaller = async (pending) => {
  await verifyWinPendingInstallerWith(pending, {
    getRunFile: () => winAutoUpdater?.downloadedUpdateHelper?.file,
    sameWinPath,
    verifyDownloadedUpdate,
  });
};

// 验签失败的统一处置（事件里验签 / installWinUpdate 里验签 / 点徽标重验共用）：一律拒绝自动安装，
// 再按**错误类型**分三路（N2-02 + M3-03；buildVerifyRejectionNotice 只看 instanceof、不匹配 message 文案）：
//  - 确定不符（UpdateVerifyMismatchError）：删缓存包 + 回 available + 弹框 + 开发布页让用户手动下；
//  - 暂时无法校验（UpdateVerifyUnavailableError / 未归类错误）：**保留**缓存包、回 available 带错误、弹框说明，
//    不开发布页——下次点徽标时直接对保留的文件重验（resumeRetainedWinInstaller）；
//  - 该版本没带 manifest（UpdateVerifyManifestMissingError，404 / 410）：同样保留缓存、仍拒绝安装，
//    但重试不会好，所以弹「暂不支持自动校验」并开发布页（新壳对没有 manifest 的 release 的既定策略 = 降级手动下载）。
// 「类型 → 弹不弹框 / 开不开发布页 / 写什么错误文案」由纯函数 buildVerifyRejectionNotice 一处决定（R6-5），
// mac 自动暂存失败（runUpdateCheck）读的是同一个函数、只是 trigger 不同：这里的验签全程由用户点徽标触发
// （autoDownload=false），用户在等结果，所以 trigger="user"——三类都弹框（暂时性失败也要告诉他没成、可重试）。
// 同一时刻只会有一条路径走到这里（事件里失败 → phase 已回 available、installUpdateNow 不会再进安装；
// ready 后再失败 → 只有 installWinUpdate 这一处），所以只弹一次框。绝不置 quitting：app 必须继续活着。
const rejectUnverifiedWinUpdate = async ({ version, file, assetName, err, stage }) => {
  const notice = buildVerifyRejectionNotice(err, { trigger: "user" });
  const reason = notice.reason;
  const kind = notice.definitive
    ? "确定不符"
    : notice.manifestMissing
      ? "该版本没带 manifest、保留已下载的安装包"
      : "暂时无法校验、保留已下载的安装包";
  log(`[updater] win ${stage}验签未通过、拒绝自动安装（${kind}）：${reason}`);
  winPendingInstaller = null;
  // 保留缓存时登记「可重验」记录，供点徽标时直接重验（见 winRetainedInstaller 注释）；
  // 确定不符 = 包即将被删、记录必须清掉；缺 file / assetName 就没法重验（assetName 缺失时重验必然复现
  // 「找不到文件名」），不登记、让点徽标走 downloadUpdate 由 latest.yml 重新给一次
  winRetainedInstaller = file && assetName && !notice.definitive ? { version, file, assetName } : null;
  mainWindow?.setProgressBar(-1);
  // 缓存包此刻的真实去留（K3-06）：弹框正文里「已清除 / 已保留」必须对得上——
  // 有 file 默认是留在磁盘上（kept）；确定不符且 rm 成功才是 cleared；没有 file 就是 none。
  // Windows 与 mac 不同：这里 exe 早已下载，所以清单级确定不符（签名 / version / 条目缺失）也会走到下面的删除
  let fileState = file ? "kept" : "none";
  if (file && notice.definitive) {
    // 删掉缓存里的 exe：electron-updater 对「缓存里已有」的包会直接复用、不重新下载，
    // 不删的话下次点徽标会拿同一份坏包再验一遍；也不该把疑似被调包的安装包留在磁盘上。
    // 只在「确定不符」时删——网络抖动 / 读文件失败这类暂时性失败不该让用户白下 112MB。
    // 删不掉（被杀软占用等）不影响拒绝——下次仍会被验签挡住
    try {
      await fs.rm(file, { force: true });
      fileState = "cleared";
      log(`[updater] win 已删除未通过验签的安装包 ${file}`);
    } catch (rmErr) {
      log(`[updater] win 删除未通过验签的安装包失败（忽略）${rmErr?.message || rmErr}`);
    }
  }
  // 第八轮 L2-06：「kept」不能只凭有 file 参数——验签失败到弹框之间杀软可能已把缓存 exe 删了（或它早被清理），
  // 这时弹框再写「已下载的安装包已保留」就是假话。弹框前 stat 一次：只有「不存在」（ENOENT / ENOTDIR）才改按「无文件」口径（none：
  // 既不说保留、也不说清除——不是我们删的）；权限 / 占用类错误（EPERM / EBUSY / EACCES）文件多半还在，保守仍按 kept。
  // 只在要说「保留」的情形下 stat（有 file 且没被我们删掉）：确定不符 + rm 失败（占用）时文件仍在磁盘上，同样走这里核实一次。
  if (fileState === "kept") {
    try {
      await fs.stat(file);
    } catch (statErr) {
      if (statErr?.code === "ENOENT" || statErr?.code === "ENOTDIR") {
        fileState = "none";
        log(`[updater] win 缓存的安装包此刻已不在磁盘上（可能被杀软清理）、按「无文件」处理：${file}`);
      }
    }
  }
  setUpdateState({ phase: "available", version, percent: 0, error: notice.stateError });
  // 同一个 err / trigger 再取一次，只为让正文带上真实的 fileState（删除前还不知道 rm 会不会成功）；处置标志位与上面的 notice 一致
  const shown = buildVerifyRejectionNotice(err, { trigger: "user", fileState });
  // trigger="user" 下 showDialog 恒为 true（行为与改造前一致）；仍读标志位而不是写死，保证两个平台同一套处置语义
  if (shown.showDialog) dialog.showErrorBox(shown.title, shown.body);
  // 开发布页只给「确定不符」与「没带 manifest」：暂时性失败网络好了点徽标就能成、没必要把人往外赶
  if (shown.openReleasePage) void shell.openExternal(RELEASE_LATEST_URL);
};

// 「验签 → 通过则登记待装并置 ready」的**唯一实现**（M3-05）：
// update-downloaded 事件（刚下完 / electron-updater 缓存命中时重发）与点徽标时对「已保留缓存」的直接重验
// 都走它，两条路径的 fail-closed 语义因此不可能漂移（不复制粘贴）。
// 返回 true = 通过；false = 未通过（已按分流处置：弹框 / 删或留缓存 / 回 available）。验签失败不会 reject。
// 调用前调用方须已把 phase 置为 downloading（验签期间的「忙」态，见 update-downloaded 注释）。
const verifyAndMarkWinReady = async ({ version, file, assetName, stage }) => {
  const pending = { version, file, assetName };
  try {
    await verifyWinPendingInstaller(pending);
  } catch (err) {
    await rejectUnverifiedWinUpdate({ version, file, assetName, err, stage });
    return false;
  }
  winPendingInstaller = pending;
  winRetainedInstaller = null; // 用完即清：此刻起由 winPendingInstaller 接管
  // 只在没被别处改动时置 ready：验签期间若有 error 事件把 phase 打回了 available，
  // 就让用户再点一次（走 downloadUpdate / 缓存命中再验一遍），别在 error 之后又凭空冒出 ready
  if (updateState.phase === "downloading") {
    setUpdateState({ phase: "ready", version, percent: 100, error: null });
  }
  return true;
};

// 点徽标时处理「已保留缓存、状态 available」的情形（M3-05）：能复用就直接对该文件重跑验签，
// 不依赖 electron-updater 重发 update-downloaded。
// 返回：
//  - "ready"    重验通过、phase 已是 ready（调用方接着走既有的「已下载、直接安装」分支）；
//  - "rejected" 重验仍失败，已由 rejectUnverifiedWinUpdate 按类型处置（弹框 / 删或留缓存），调用方直接返回；
//  - "fallback" 没有可复用的保留缓存（没记录 / 版本变了 / 文件没了 / 库登记的待装文件已不是它），
//               调用方照旧走 downloadUpdate()（electron-updater 自己决定复用缓存还是重下）。
const resumeRetainedWinInstaller = async (version) => {
  const retained = winRetainedInstaller;
  if (!retained) return "fallback";
  const discard = (why) => {
    log(`[updater] win 保留的安装包不可直接复用（${why}）、改走 downloadUpdate`);
    winRetainedInstaller = null;
    return "fallback";
  };
  // 保留的是旧版本的包、之后轮询又发现了更新的版本：它跟这次要装的不是一个东西
  if (retained.version !== version) return discard(`版本已变 v${retained.version} → v${version}`);
  // quitAndInstall 装的是 electron-updater 内部登记的待装文件（downloadedUpdateHelper.file）：
  // 它已不是我们保留的这个（或已被库清空）时，重验这个文件没意义——通过了也装不上，会变成「ready → 点了又报错」的死循环。
  // helper 本身取不到（库内部改名）就不拦，与 verifyWinPendingInstaller 里的同款交叉校验口径一致。
  // 【同一个条件、两处处置不同——有意的（第八轮 L2-05，保持现状只补说明）】
  //  - 这里（点徽标、对「此前被拒后保留」的文件重验之前）：静默回落 downloadUpdate，不弹框、不删文件。此刻还没有任何「已验签、等着装」
  //    的东西，helper.file 变了只说明库自己往前走了（读 electron-updater 6.8.9 源码，未实跑）：后续一次下载失败 / 取消时 helper.clear()
  //    会置空 file 并清空 pending 目录，新一次 downloadUpdate 会用新路径覆盖 file——这是库的正常状态变化、不是篡改证据，
  //    而且保留的文件此刻可能已经不在了；回落后由 electron-updater 自己按 sha512 决定复用缓存还是重下。
  //  - win-pending-verify.mjs 的 K3-11（update-downloaded 事件 / installWinUpdate 的 quitAndInstall 之前）：同样的不一致抛「确定不符」
  //    （删缓存 + 开发布页）。那里已经走到「验过、马上要装」，quitAndInstall 装的是 BaseUpdater.installerPath = helper.file；
  //    它 ≠ 我们验过的文件意味着库要拉起一个没验过的包，没有安全的回落路径，只能 fail-closed。
  //  helper.file 与事件里的 downloadedFile：库在 AppUpdater.executeDownload 的 done() 里先 setDownloadedFile(updateFile) 再用同一个
  //  updateFile 派发事件（新下载、命中缓存两条分支都是），所以事件那一刻二者是同一个字符串；之后才可能分叉（上面两种情形）。
  const helper = winAutoUpdater?.downloadedUpdateHelper;
  if (helper && (typeof helper.file !== "string" || !sameWinPath(helper.file, retained.file))) {
    return discard("electron-updater 登记的待装文件已不是它");
  }
  try {
    await fs.stat(retained.file);
  } catch {
    return discard("文件已不在");
  }
  log(`[updater] win 对已保留的安装包直接重新验签（不依赖 update-downloaded 重发）v${version}`);
  winPendingInstaller = null;
  // 验签是异步的（取 manifest + 算 SHA-256）：与 update-downloaded 同口径、phase 保持 downloading 当「忙」态，
  // UI 不可点、轮询也不会打断
  setUpdateState({ phase: "downloading", version, percent: 100, error: null });
  const ok = await verifyAndMarkWinReady({ ...retained, stage: "重新校验已保留的安装包" });
  return ok ? "ready" : "rejected";
};

// installWinUpdate 的「不抛异常」包装：installUpdateNow 要 await 它来持锁，
// 但它里面任何意外异常都不该被当成「下载失败」报给用户（原先是 fire-and-forget、异常只会变 unhandledRejection）
const runInstallWinUpdate = (version) =>
  installWinUpdate(version).catch((err) => {
    log(`[updater] win 安装流程异常 ${err?.stack || err?.message || err}`);
  });

// win electron-updater 懒加载初始化（只做一次）：
// - autoDownload=false 是本方案核心——检查更新只查版本号、不自动下载、把下载推迟到用户点按钮后（对齐 mac）
// - autoInstallOnAppQuit=false：点了页面「取消」或关应用，不要在退出时静默走 NSIS 卸装
//   （Windows 同事「关了就打不开 / 快捷方式找不到应用」多次翻车）
// - 注册下载进度（任务栏进度条）/ 下载完成（置 ready）/ 出错事件、只注册一次防监听器泄漏
// 确认后 quitAndInstall(true, true)：isSilent=true 走 NSIS /S 静默装（oneClick:false
// 时不传会弹完整安装向导、与「点了立即更新」预期不符）、isForceRunAfter=true 装完自动拉起。
// server 清理不在这做：quitAndInstall 内部走 app.quit() → before-quit 已同步 taskkill /T
// 连树杀（蓝军 P0：若在这提前杀、quitAndInstall 失败不退出时 app 就成了没后端的僵尸）。
const installWinUpdate = async (version) => {
  if (!winAutoUpdater) return;
  if (updateState.phase === "installing") return;
  // 不传 /D=：NSIS 用注册表 InstallLocation（electron-updater 默认行为）。
  // 曾手动钉 /D= 保"卸装同目录"，但 Node 给含空格路径自动加引号、旧 NSIS 取参不去引号
  // → $INSTDIR 非法 → 旧目录已删、新文件写不进（更新完 App 没了）。注册表路径原样可用；
  // 挪过目录的极少数用户顶多装出第二份（快捷方式重写兜底），不丢 App。
  const exeDir = path.dirname(process.execPath);
  log(
    `[updater] win 安装目录 dir=${exeDir} exe=${path.basename(process.execPath)}`,
  );
  // Temp 兜底（v1.9.13）：当前进程在 NSIS 备份里跑（上次失败残留、Temp 里直接点的 exe）
  // 时静默更新会往 Temp 里装、Temp 一清人就没了——此时绝不 quitAndInstall，
  // 让用户手动重装（注意：quitting 必须在放行后才置位，否则拒绝后 app 成僵尸）。
  // 同理：目录里连当前 exe 都没有（上次失败已被清空），也拒绝，避免叠加破坏。
  const unsafeReason = isUnsafeWinInstallDir(exeDir);
  const exeExists = (() => {
    try {
      return existsSync(path.join(exeDir, path.basename(process.execPath)));
    } catch {
      return false;
    }
  })();
  if (unsafeReason || !exeExists) {
    const reason = unsafeReason || "安装目录里找不到当前程序（可能上次更新已清空目录）";
    log(`[updater] win 拒绝静默更新：${reason} dir=${exeDir}`);
    setUpdateState({ phase: "available", version, error: reason });
    dialog.showErrorBox(
      "自动更新失败",
      `${reason}。\n\n已取消本次自动更新，避免损坏你的安装。今晚去发布页手动下载安装包、重装到原目录即可（数据不受影响）。`,
    );
    void shell.openExternal(RELEASE_LATEST_URL);
    return;
  }
  // 新安装器标记门禁：没标记 = 当前文件是旧版本装的，旧卸载器可能有 /T 误杀安装器
  // 或 /D= 引号 bug → 这次必须手动过渡（去发布页装一次），装完标记落地、之后恢复静默。
  // 这是自愈的：与具体版本号无关，标记在就放行、不在就手动一次。
  if (!hasSilentUpdateMarker(exeDir, existsSync)) {
    const reason = "当前安装是旧版本装的，不支持本次静默更新（旧卸载器有已知缺陷）";
    log(`[updater] win 拒绝静默更新：${reason} dir=${exeDir}`);
    setUpdateState({ phase: "available", version, error: reason });
    dialog.showErrorBox(
      "需要手动更新一次",
      `${reason}。\n\n去发布页手动下载安装包、装到原目录即可（数据不受影响）。装完这一次，之后的自动更新恢复正常。`,
    );
    void shell.openExternal(RELEASE_LATEST_URL);
    return;
  }
  // 安装包验签门禁（R9-01、fail-closed）：quitAndInstall 之前再验一次 manifest 签名 + 实测 size / SHA-256。
  // 位置有讲究：
  // - 必须在 quitting 置位 / 墓碑 / 通知之前：失败只是「拒绝」、app 必须继续活着（与上面几道门禁一致）；
  // - update-downloaded 时已验过一次，这里仍要再验：ready 之后用户可能过了很久才点、或点了失败回 ready 再点，
  //   要验的是「此刻磁盘上、即将被拉起的那个文件」，而不是事件那一刻的快照。
  // 失败统一走 rejectUnverifiedWinUpdate（删缓存包 / 回 available / 弹一次框 + 开发布页），不置 quitting。
  const pendingInstaller = winPendingInstaller;
  try {
    await verifyWinPendingInstaller(pendingInstaller);
  } catch (err) {
    await rejectUnverifiedWinUpdate({
      version,
      file: pendingInstaller?.file,
      assetName: pendingInstaller?.assetName,
      err,
      stage: "安装前",
    });
    return;
  }
  // 磁盘空间预检（与安装器 .onInit 同口径同阈值，见 disk-space.mjs）：安装器那道预检只在「主进程已退出、
  // 静默安装没有界面」之后才生效——用户只会看到 App 消失。所以在 quitting = true 之前先量：不够就当场
  // 弹框、什么都不动（App 继续开着、版本不变）。不开发布页：手动装同样要这些空间，送过去只会重蹈覆辙。
  // 量不到（UNC 等）放行；这一道是补充不是替代——还没有这道门禁的旧客户端仍全靠安装器那一道。
  const tmpSpace = checkUpdateTempSpace(os.tmpdir(), statfsSync);
  if (!tmpSpace.enough) {
    const blocked = buildSpaceBlockedMessage(tmpSpace);
    log(`[updater] win 拒绝静默更新：${blocked.reason} tmp=${os.tmpdir()}`);
    setUpdateState({ phase: "available", version, error: blocked.reason });
    dialog.showErrorBox(blocked.title, blocked.body);
    return;
  }
  // 静默装要黑屏好几分钟（1.5 万散文件逐个落盘），先给个系统通知打预防针、
  // 否则用户以为卡死去杀进程，正好杀在“旧的已搬走、新的没写完”中间（D 盘用户翻车实录）。
  // 发完等 1.5s 再 quit：Windows Toast 是系统托管、quit 后还在 Action Center，
  // 但发完立刻退、快机器上 Toast 可能根本来不及渲染出来。
  try {
    new Notification({
      title: `正在安装更新 v${version}`,
      body: "后台静默安装约需几分钟（文件较多），请勿手动结束进程，装完会自动重启。",
      ...(process.platform === "win32" ? { icon: resolveNotifyIcon() } : {}),
    }).show();
  } catch {
    // 通知发不出不挡更新
  }
  quitting = true;
  setUpdateState({ phase: "installing", version, error: null });
  // 更新墓碑：quitAndInstall 前写，启动时核销。静默装黑盒无回调，下次启动版本没变
  // = 死半路了 → 弹框请手动装（不再无声消失）。写不进顶多少一次失败提示，不挡更新。
  try {
    await fs.writeFile(
      path.join(app.getPath("userData"), WIN_UPDATE_ATTEMPT_FILE),
      JSON.stringify(buildWinUpdateAttempt(version)),
    );
  } catch {
    /* 忽略 */
  }
  await sleep(1500);
  // 拉起安装器前的现场（v1.9.30）：安装目录 / %TEMP% 所在盘剩余空间。安装器自己的预检
  // 看的是同一个盘，两边对得上才能判断「预检拦下」还是「别的原因」。
  log(
    `[updater] win quitAndInstall(silent) 目标 v${version} 当前 v${app.getVersion()} ` +
      `installFree=${diskFreeGB(exeDir)}G tmpFree=${diskFreeGB(os.tmpdir())}G`,
  );
  winAutoUpdater.quitAndInstall(true, true);
};

const ensureWinAutoUpdater = async () => {
  if (winAutoUpdater) return winAutoUpdater;
  // electron-updater 是 CJS、ESM 下走 default 再解构最稳
  const { default: updater } = await import("electron-updater");
  winAutoUpdater = updater.autoUpdater;
  // 把 electron-updater 自己的日志接进 main.log（v1.9.30）。它默认只写 console，打包后没终端、
  // 全部丢失——「查到哪个版本 / 从哪下载 / 装包路径 / 以什么参数拉起安装器」这些更新排障最关键的
  // 事实，之前一条都留不下。只接 info/warn/error（debug 太吵，且它对 debug 是可选调用）。
  const fmtUpdaterLog = (m) => (m instanceof Error ? m.stack || m.message : String(m));
  winAutoUpdater.logger = {
    info: (m) => log(`[electron-updater] ${fmtUpdaterLog(m)}`),
    warn: (m) => log(`[electron-updater] WARN ${fmtUpdaterLog(m)}`),
    error: (m) => log(`[electron-updater] ERROR ${fmtUpdaterLog(m)}`),
  };
  winAutoUpdater.autoDownload = false; // 关键：检查时不下载、点按钮才 downloadUpdate（对齐 mac）
  winAutoUpdater.autoInstallOnAppQuit = false; // 退出不偷偷装，只在用户点徽标确认后装
  // 不设 installDirectory：用注册表 InstallLocation（见 installWinUpdate 注释）。
  // 下载进度 → 任务栏进度条 + 页面徽标进度（对齐 mac 的 Dock + 页面双通道）
  winAutoUpdater.on("download-progress", (p) => {
    if (typeof p?.percent !== "number") return;
    mainWindow?.setProgressBar(p.percent / 100);
    setUpdateState({ phase: "downloading", percent: Math.floor(p.percent) });
  });
  // 下载完成（autoDownload=false 下只会被用户点按钮后的 downloadUpdate 触发）。
  // R9-01：先验 manifest 签名、通过才置 ready——失败则回 available + 带错误、绝不进 ready，
  // 这样用户不会先看到「重启更新」、点了才失败。
  // 验签是异步的（取 manifest + 流式算 SHA-256），这段时间 phase 刻意保持 downloading（percent 100）：
  // installUpdateNow 对 downloading 直接忽略点击、runUpdateCheck / manualCheckForUpdate 也不会打断它，
  // 现有的「下载中 / 安装中忽略」状态机原样复用、不引入新 phase。
  winAutoUpdater.on("update-downloaded", (info) => {
    mainWindow?.setProgressBar(-1);
    const v = info?.version || updateReadyVersion;
    log(`[updater] 新版本 v${v} 已下载完成、先验签再置 ready`);
    winPendingInstaller = null; // 验过之前不算「待装」
    setUpdateState({ phase: "downloading", version: v, percent: 100, error: null });
    // 「验签 → 通过则登记待装并置 ready、失败按类型处置」与点徽标重验共用 verifyAndMarkWinReady，
    // 事件里不再自己写一份（两份会漂移）。ready 只会出现在验签成功之后
    winDownloadedVerifyTask = verifyAndMarkWinReady({
      version: v,
      file: info?.downloadedFile,
      assetName: pickWinInstallerAssetName(info),
      stage: "下载完成后",
    }).catch((err) => {
      // 兜底：reject 处置自身出意外也别变成 unhandledRejection、更别让 installUpdateNow 的 await 抛出去
      log(`[updater] win 下载后验签流程异常 ${err?.stack || err?.message || err}`);
    });
  });
  winAutoUpdater.on("error", (err) => {
    mainWindow?.setProgressBar(-1);
    log(`[updater] ${err?.message || err}`);
    // 下载中出错 → 回 available 可重试；安装中出错（quitAndInstall 的 install() 失败、
    // 进程不会退）→ 回 ready（包还在、可再点重试）+ 撤销 quitting、别让 app 带着
    // 「正在退出」标记继续跑（server 崩溃提示 / 关窗拦截都靠它）。
    // ⚠️ 回滚必须带 serverProc 守卫（二轮复审 P1）：install() 失败发生在 app.quit() 之前、
    // server 此刻还活着；若 error 与真退出竞态（before-quit 已杀 server → serverProc=null）、
    // 无条件 quitting=false 会让关窗拦截复活、app 变成没后端的僵尸。
    // checkForUpdates 的网络错不动徽标。
    if (updateState.phase === "downloading") {
      setUpdateState({
        phase: "available",
        error: String(err?.message || err),
      });
    } else if (updateState.phase === "installing" && serverProc) {
      quitting = false;
      setUpdateState({
        phase: "ready",
        error: String(err?.message || err),
      });
    }
  });
  return winAutoUpdater;
};

// mac「自动暂存」（轮询 / 启动检查 / 设置页「检查更新」触发，不是用户点徽标）失败后的统一处置——
// 「谁弹框、弹什么」的唯一入口（第七轮 K3-05：以前设置页那条路 `.catch(() => {})` 把失败整个吞了）。
// 点徽标（macSelfUpdate）不走这里：它自己按 trigger="user" 弹框。
//
// 登记与弹框是两件事：macVerifyFailedVersion / macVerifyRetry 由 downloadAndStageMacUpdate 的 catch 对所有触发方式一律登记
// （不管弹没弹框），所以这里只管「要不要告诉用户」，进来时记录已经是最新的。
//  - trigger="background"（2h 轮询 / 启动检查，没人在等）：
//      · 确定不符 / 没带清单：弹框 + 开发布页 + 记 wasPrompted（每版本一次、持久）；
//      · 暂时性 / 未归类：不弹框、不开发布页、不消耗 wasPrompted（一次 503 不该吓人，更不能把唯一一次安全提示用掉）；
//      · 同一版本连续失败 ≥ 3 次（非永久失败）：再弹**一次**「自动更新多次失败」说明框——只提示、不开发布页，
//        用独立的进程内标记 repeatedFailurePromptedVersion 去重、**不**碰 wasPrompted（见该变量注释的反例）；
//  - trigger="user"（设置页「检查更新」后台暂存，用户刚点了按钮）：三类都弹框（暂时性也要说「没成、可重试」），
//    不看也不消耗 wasPrompted；不叠「多次失败」框（每次失败本来就有自己的反馈）。
//    验签类（确定不符 / 暂时无法校验 / 没带清单）取 buildVerifyRejectionNotice；非验签类（dmg 502 / 磁盘满 / hdiutil / ditto……）
//    取 buildGenericUpdateFailureNotice（第八轮 L2-02：与点徽标的 macSelfUpdate 通用分支同一个函数——以前这里一律走验签文案，
//    「ditto ENOSPC」会被说成「暂时无法校验更新包 / 请检查网络后重试」）。后台触发的非验签类失败仍静默（R6-5 / P2-2）。
// 用户点徽标的 macSelfUpdate 持有 installInFlight 锁、并合流到同一次暂存时，失败由它统一反馈，这里不再弹（避免同一次失败两个框）。
//
// 第八轮 L2-03：downloadAndStageMacUpdate 是单飞的——轮询暂存在途时用户点「检查更新」，两边合流到同一个 promise，失败时拿到
// **同一个 Error 对象**、各跑一遍本函数（一个 background、一个 user）。用 dialoguedStageErrors（WeakSet<Error>）记「这个错误对象已经
// 弹过框」，后到的一方跳过弹框 / 开发布页 / 「多次失败」框，同一次失败不会弹两个框、开两次发布页。
// 只在**真的要弹框**时占位：后台对暂时性 / 未归类失败本来就静默、不占位，用户那次手动检查的反馈因此不会丢。
// 占位与弹框之间不能有 await（见 claimStageErrorDialog），所以放在每个 showErrorBox 的紧前面、并且在 await wasPrompted / markPrompted 之后。
// 抛出的若是字符串等非对象（WeakSet 放不进去）就不去重、照常弹。
const dialoguedStageErrors = new WeakSet();
const claimStageErrorDialog = (err) => {
  if ((typeof err !== "object" && typeof err !== "function") || err === null) return true;
  if (dialoguedStageErrors.has(err)) return false;
  dialoguedStageErrors.add(err);
  return true;
};
const handleMacStageFailure = async (err, version, trigger) => {
  if (installInFlight) {
    log(`[updater] mac 暂存失败（点徽标流程已接管反馈、此处不再弹框）${err?.message || err}`);
    return;
  }
  const notice =
    trigger === "user" && !isVerifyFailure(err)
      ? buildGenericUpdateFailureNotice(err)
      : buildVerifyRejectionNotice(err, {
          trigger,
          alreadyPrompted: trigger === "background" ? await wasPrompted(version) : false,
        });
  log(
    `[updater] mac 暂存失败（拒绝自动安装；触发=${trigger} 弹框=${notice.showDialog} 开发布页=${notice.openReleasePage}）${notice.reason}`,
  );
  // 先记「已提示」再弹（showErrorBox 在 mac 上同步阻塞到用户点掉；弹框期间退出也不会下次再弹一遍）。
  // markPrompted 不受去重影响：「这个版本的完整性告警已经让用户看到过」不论是哪一方弹的都成立
  if (notice.markPrompted) await markPrompted(version);
  // 以下到 showErrorBox / openExternal 之间不能再 await：占位（claim）与弹框必须在同一个同步段里、否则两方可能同时通过检查
  if (notice.showDialog && claimStageErrorDialog(err)) {
    dialog.showErrorBox(notice.title, notice.body);
    if (notice.openReleasePage) void shell.openExternal(RELEASE_LATEST_URL);
  } else if (notice.showDialog) {
    log(`[updater] mac 暂存失败：同一个错误已由另一路触发弹过框、此处跳过弹框与开发布页（触发=${trigger}）`);
  } else if (notice.openReleasePage) {
    // 防御：现有纯函数里「开发布页」恒伴随「弹框」；万一以后拆开，仍照原语义开页（不占弹框名额）
    void shell.openExternal(RELEASE_LATEST_URL);
  }
  if (
    trigger === "background" &&
    !isPermanentVerifyFailure(err) &&
    shouldPromptRepeatedFailure(macVerifyRetry, version, repeatedFailurePromptedVersion)
  ) {
    // 同一个错误对象已被另一路弹过框就不再叠一个「多次失败」框，也**不**置标记（这次没真弹，下一次后台失败仍可提示）
    if (claimStageErrorDialog(err)) {
      // 同样先置标记再弹
      repeatedFailurePromptedVersion = version;
      const repeated = buildRepeatedFailureNotice({
        version,
        failures: macVerifyRetry.failures,
        reason: notice.reason,
      });
      log(`[updater] mac v${version} 连续失败 ${macVerifyRetry.failures} 次、提示用户（不开发布页、不占 wasPrompted 名额）`);
      dialog.showErrorBox(repeated.title, repeated.body);
    } else {
      log(`[updater] mac v${version} 连续失败已达阈值、但同一个错误已弹过框、本次不再叠「多次失败」框`);
    }
  }
};

// 查一次更新（启动 + 每 2h 轮询都走这）。
// 发现新版一律不弹窗、只静默点亮右上角「新版本」徽标（2026-07-15 用户拍板）。
// win：只查版本号、用户点徽标才下载（electron-updater autoDownload=false）。
// mac：查到新版后立刻后台下载暂存（不碰 /Applications）；点徽标 = apply+relaunch，
//       不点则退出时自动套用。暂存失败的处置见 handleMacStageFailure（R6-5、同 Windows）：确定不符 / 没带清单 = 弹框 + 开发布页
//       （每版本一次、降级手动下载）；暂时性 / 未归类 = 不弹框、错误留在 updateState.error、按时间退避；连续 3 次提示一次；
//       会白下 dmg 的失败（未归类 / local-io）同版本累计 3 次后轮询放弃自动暂存（macStageGiveUpVersion，第八轮 L2-01；
//       「累计」不是严格连续——期间的 503 等清单阶段失败既不累计也不重置，成功暂存 / 换版本才清零）。
const runUpdateCheck = async () => {
  try {
    const current = app.getVersion();
    // 查最新版本号：win 走 electron-updater（autoDownload=false、只查不下）、mac 查 GitHub release tag
    let latest = null;
    if (process.platform === "win32") {
      const r = await (await ensureWinAutoUpdater()).checkForUpdates();
      latest = r?.updateInfo?.version || null;
    } else {
      latest = await fetchLatestVersion();
    }
    if (!latest || !isNewer(latest, current)) return;
    updateReadyVersion = latest;
    log(`[updater] 发现新版本 v${latest}（当前 v${current}）`);
    // 点亮徽标（mac 随后立刻转 downloading → ready；win 停在 available 等用户点）。
    // downloading/installing 中不打断（极端：下载 A 时轮询到 B——让当前流程跑完、
    // 下轮轮询 phase 已收敛再切新版自愈、别把进行中的状态机踩乱）
    if (
      updateState.phase !== "downloading" &&
      updateState.phase !== "installing" &&
      (updateState.version !== latest || updateState.phase === "idle")
    ) {
      setUpdateState({ phase: "available", version: latest, percent: 0, error: null });
    }

    // mac：后台下载暂存（已暂存同版本则跳过）——不弹窗；点徽标秒装 / 退出时自动套用。
    // 安装中跳过（二轮复审 P1）：apply 已消费 meta、此刻再触发 staging 会重新下 dmg、
    // 与替换 / relaunch / 启动清扫竞态
    if (UPDATE_MODE === "download" && !installInFlight && updateState.phase !== "installing") {
      if (macVerifyFailedVersion === latest) {
        // M3-04：同一版本本进程内已验签失败过——不再自动重下 100MB+ 的 dmg 白算一遍。
        // 徽标仍亮（上一次失败时已置 available + 带错误）、用户点它就是显式重试；重启应用同样会重置
        log(`[updater] mac v${latest} 本进程内验签失败过、跳过自动暂存（点更新徽标或重启应用可重试）`);
      } else if (macStageGiveUpVersion === latest) {
        // 第八轮 L2-01：同版本「会白下 dmg 的失败」（未归类错误 / local-io）已累计 ≥ 3 次（期间的 503 等清单阶段失败既不累计也不重置）——后台轮询不再替用户整包重下 100MB+。
        // 退避救不了这个（它不读 failures、对 2h 轮询基本不设防，见 macVerifyRetry 注释）。只记一行日志、不弹框；
        // 徽标仍亮（失败时已置 available + 带错误）、点徽标 / 设置页「检查更新」是显式重试（成功暂存即解除）；换版本 / 重启同样解除。
        log(`[updater] mac v${latest} 自动暂存累计失败 ${macCostlyFailures?.count ?? "多"} 次、放弃自动暂存（点更新徽标或「检查更新」可重试）`);
      } else if (isVerifyRetryBlocked(macVerifyRetry, latest, Date.now())) {
        // F1-01：非永久失败（5xx / 限流 / 超时 / dmg 下载失败……）只按时间退避、不永久跳过——退避期内不重下，到点自动放行。
        // 如实说明（第八轮 L2-04 订正）：退避对 2h 轮询**不是保护**——放不放行只看「最近一次失败时刻 + 退避」是否 ≤ 本次轮询时刻：
        // 常见情形前 5 次失败都放行、走不到这个分支，但失败发生得晚（点徽标 / 手动检查在两次轮询之间失败）会被挡一轮；
        // 封顶后（连续失败 ≥ 6 次）失败只要晚于触发就隔一轮跳过一次（见 update-verify-retry.mjs 文件头）。
        // 所以会白下 dmg 的未归类失败靠上面的 macStageGiveUpVersion 闸止损，不靠这里
        log(
          `[updater] mac v${latest} 自动暂存暂时失败、退避中，跳过自动暂存` +
            `（约 ${Math.ceil((macVerifyRetry.notBefore - Date.now()) / 60_000)} 分钟后自动重试；点更新徽标可立即重试）`,
        );
      } else {
        try {
          await downloadAndStageMacUpdate(latest);
        } catch (err) {
          // 暂存失败 = 拒绝自动安装；徽标已亮、错误文案已由 downloadAndStageMacUpdate 写进 updateState.error
          // （点徽标仍可重试）。弹不弹框 / 开不开发布页 / 记不记「已提示」按失败**类型**由
          // handleMacStageFailure 一处决定（读 buildVerifyRejectionNotice：与 Windows rejectUnverifiedWinUpdate 同一个纯函数，
          // 只是 trigger 不同；连续失败 3 次的「多次失败」提示也在那里）
          await handleMacStageFailure(err, latest, "background");
        }
      }
    }
  } catch (err) {
    // 更新失败不影响正常使用（如离线 / GitHub 不可达）
    log(`[updater] 检查更新失败（忽略）${err?.message || err}`);
  }
};

const setupAutoUpdate = async () => {
  // 测试实例版本号永远是 0.0.0-dev、查更新必点亮「新版本」徽标、纯骚扰——跳过
  if (!app.isPackaged || IS_TEST) return;
  // win：预初始化 electron-updater（autoDownload=false + 注册事件、仅一次、见 ensureWinAutoUpdater）
  if (process.platform === "win32") {
    try {
      await ensureWinAutoUpdater();
    } catch (err) {
      log(`[updater] electron-updater 初始化失败（忽略）${err?.message || err}`);
    }
  }
  // 启动先查一次、之后每 2h 轮询一次（app 长期不关也能收到新版提醒）
  await runUpdateCheck();
  setInterval(() => void runUpdateCheck(), UPDATE_POLL_MS);
};

// 手动「检查更新」（设置页按钮触发）——按需查一次、返回结构化结果给页面 toast。
// 跟自动轮询 runUpdateCheck 同款查版本号（win checkForUpdates / mac fetchLatestVersion）+ 点亮逻辑，
// 区别：自动轮询「没更新就静默」、这里把「已是最新」也明确返回（用户主动点要个确定反馈）。
const manualCheckForUpdate = async () => {
  const current = app.getVersion();
  try {
    // 查最新版本号（同 runUpdateCheck）：win 走 electron-updater（autoDownload=false、只查不下）、
    // mac 查 GitHub release tag。test / 非打包下 ensureWinAutoUpdater 也会懒加载初始化。
    let latest = null;
    if (process.platform === "win32") {
      const r = await (await ensureWinAutoUpdater()).checkForUpdates();
      latest = r?.updateInfo?.version || null;
    } else {
      latest = await fetchLatestVersion();
    }
    if (!latest) return { status: "error", current, message: "拿不到最新版本号" };
    if (isNewer(latest, current)) {
      // 立即点亮右上角「新版本」标识（win/mac 一致、不再等下载完）
      updateReadyVersion = latest;
      log(`[updater] 手动检查发现新版本 v${latest}（当前 v${current}）`);
      // 同 runUpdateCheck：downloading/installing 中不打断进行中的状态机
      if (
        updateState.phase !== "downloading" &&
        updateState.phase !== "installing" &&
        (updateState.version !== latest || updateState.phase === "idle")
      ) {
        setUpdateState({ phase: "available", version: latest, percent: 0, error: null });
      }
      // mac：手动检查发现新版也立刻后台暂存（对齐轮询、含 installing 门闩）、
      // 徽标随进度走、点徽标秒装。
      // 失败：状态回 available（downloadAndStageMacUpdate 的 catch 管）+ 走 handleMacStageFailure 以 trigger="user" 反馈
      // （K3-05：这是用户点了「检查更新」触发的，三类失败都该有反馈；以前 `.catch(() => {})` 把第一次确定不符整个吞了，
      // 而它已被登记为永久失败、之后后台轮询永远跳过它——这个版本的完整性告警就再也弹不出来了）
      if (
        UPDATE_MODE === "download" &&
        app.isPackaged &&
        !IS_TEST &&
        !installInFlight &&
        updateState.phase !== "installing"
      ) {
        // M3-04：同版本验签失败过就不再自动重下（反复点「检查更新」= 反复下 dmg 再静默失败）；
        // 结果里仍照常告诉用户有新版、点徽标才是显式重试
        if (macVerifyFailedVersion === latest) {
          log(`[updater] mac v${latest} 本进程内验签失败过、手动检查也跳过自动暂存`);
        } else if (isVerifyRetryBlocked(macVerifyRetry, latest, Date.now())) {
          // F1-01：非永久失败的退避期内同样不重下（到点后手动检查会放行）
          log(`[updater] mac v${latest} 自动暂存暂时失败、退避中，手动检查也跳过自动暂存`);
        } else {
          // 第八轮 L2-01：这里**刻意不读** macStageGiveUpVersion——「放弃自动暂存」只约束没人在等的后台轮询；
          // 用户点了「检查更新」就是显式重试，照常发起（成功暂存会解除闸，失败则计数继续涨、闸保持登记）。
          void downloadAndStageMacUpdate(latest)
            .catch((err) => handleMacStageFailure(err, latest, "user"))
            // 反馈本身（弹框 / 写 wasPrompted）出错不能变成未处理的 rejection；不会影响已返回的手动检查结果
            .catch((e) => log(`[updater] mac 手动检查的暂存失败反馈出错（忽略）${e?.message || e}`));
        }
      }
      return { status: "available", current, latest };
    }
    return { status: "latest", current };
  } catch (err) {
    log(`[updater] 手动检查更新失败 ${err?.message || err}`);
    return { status: "error", current, message: err?.message || String(err) };
  }
};

// 设置页「检查更新」按钮 → preload window.__appUpdater.check() → 这里
ipcMain.handle("check-for-update", () => manualCheckForUpdate());

// 页面 UpdateBadge mount / 刷新时拉全量更新状态（实时变化走 update-state 推送）
ipcMain.handle("get-update-state", () => updateState);

// 页面点「新版本」徽标 → preload window.__appUpdater.install()（正规 IPC、
// 替代 app-update:// 伪协议导航；will-navigate 拦截仍保留兜底旧缓存页面）
ipcMain.on("install-update", () => void installUpdateNow());

// ---------- 生命周期 ----------

// 单实例锁：二开时聚焦已有窗口；Windows 深链会拉起第二实例、URL 在 argv 里（4.6）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // 先解析深链再聚焦——用户点 flowship:// 时既要亮窗也要跳任务
    const url = findProtocolUrlInArgv(argv);
    if (url) handleDeepLinkUrl(url);
    showMainWindow();
  });

  // macOS：深链走 open-url；必须在 ready 前注册，否则冷启动首个 URL 会丢（坑 #15）
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLinkUrl(url);
  });

  app.whenReady().then(async () => {
    // 里程碑基准 = 主进程启动；appReady 的数值本身 = 点图标到我们第一行代码跑起来（含 exe 被扫描 / Chromium 初始化）
    bootTimeline.mark("appReady");
    lagMonitor.start();
    log(`[main] app 启动 version=${app.getVersion()} packaged=${app.isPackaged} userData=${app.getPath("userData")} protocol=${PROTOCOL_SCHEME}`);
    applyAppNapGuard();
    // 机器快照（启动慢定位用：内存/CPU 不够的机器冷启动天然慢，先排除硬件因素）
    try {
      const cpus = os.cpus();
      log(
        `[main] machine platform=${os.platform()} arch=${os.arch()} release=${os.release()} ` +
          `cpu=${cpus.length}x${cpus[0]?.model?.trim() || "?"} ` +
          `memTotal=${Math.round(os.totalmem() / 1073741824)}G memFree=${Math.round(os.freemem() / 1073741824)}G`,
      );
      // 磁盘 + 启动参数（v1.9.30）：安装器拉起的首启带 --updated / --force-run；
      // 盘剩余空间用来排除「系统盘快满」这条线索。
      log(
        `[main] disk install=${path.dirname(process.execPath)} free=${diskFreeGB(path.dirname(process.execPath))}G ` +
          `tmp=${os.tmpdir()} free=${diskFreeGB(os.tmpdir())}G ` +
          `userData free=${diskFreeGB(app.getPath("userData"))}G ` +
          `argv=${process.argv.slice(1).join(" ") || "（无）"}`,
      );
    } catch {
      /* 快照失败不挡启动 */
    }
    // 数据目录所在盘 < 2GB 发系统通知、之后每 30 分钟再量一次（R14 B2-4b / Q15-10）；同步、不会抛、不挡启动
    startDiskWatch();
    // 首次启动并行预读：越早越好（后面还有更新清扫 / 端口检查 / 开窗要走），fire-and-forget、
    // 失败只记日志、绝不挡启动。只在 Windows + 首次启动（全新安装 / 刚更新）才跑，见 ./boot-prefetch.mjs。
    // firstBoot 在这里就算好、后面的超时选择复用同一个值（标记要等 server 就绪才写，中途不会变）。
    const firstBoot = isFirstBoot();
    bootIsFirst = firstBoot;
    if (
      shouldPrefetch({
        platform: process.platform,
        firstBoot,
        env: process.env,
      })
    ) {
      void (async () => {
        try {
          const raw = await fs
            .readFile(path.join(serverDir, BOOT_MANIFEST_FILENAME), "utf8")
            .catch(() => null);
          const manifest = parseBootManifest(raw);
          if (!manifest) {
            log("[main] prefetch 跳过：没有可用的启动清单");
            return;
          }
          // 先串行量一把冷读 / 热读的单文件延迟（最多 1.5s）：预读统计里的 avgPerFile 含并发排队、只是上界，
          // 这组数据才是「这台机器首次读一个文件到底要多久」。探针失败不影响后面的预读。
          try {
            const probe = await runReadProbe({ serverDir, files: manifest.files });
            log(`[boot] readProbe ${formatReadProbe(probe)}`);
          } catch (err) {
            log(`[boot] readProbe 异常（忽略）${err?.message || err}`);
          }
          const stats = await runPrefetch({ serverDir, files: manifest.files });
          log(`[main] prefetch ${formatPrefetchSummary(stats)}`);
        } catch (err) {
          log(`[main] prefetch 异常（忽略）${err?.message || err}`);
        } finally {
          bootTimeline.mark("prefetchDone");
        }
      })();
    } else {
      log(
        `[main] prefetch 未启用（platform=${process.platform} firstBoot=${firstBoot} disabled=${process.env.FLOWSHIP_NO_PREFETCH === "1"}）`,
      );
    }
    // mac 自定义应用菜单：默认菜单的 File→Close（Cmd+W）走 close 事件、会撞上
    // 「点 X = 二次确认退出」——把 Cmd+W 改绑「收进托盘」；其余菜单保留系统 role
    //（editMenu 必须保留、否则 Cmd+C/V 全失效）
    if (process.platform === "darwin") {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { role: "appMenu" },
          {
            label: "文件",
            submenu: [
              {
                label: "关闭窗口",
                accelerator: "Cmd+W",
                click: () => hideMainWindowToTray(),
              },
            ],
          },
          // role 菜单默认英文、覆盖中文 label（子项仍是系统行为）
          { role: "editMenu", label: "编辑" },
          { role: "viewMenu", label: "显示" },
          { role: "windowMenu", label: "窗口" },
        ]),
      );
    }
    // 注册自定义协议（正式 flowship / test flowship-test）
    registerProtocolClient();
    // Windows 冷启动：深链在首实例 process.argv（不是 open-url）
    const startupUrl = findProtocolUrlInArgv(process.argv);
    if (startupUrl) handleDeepLinkUrl(startupUrl);
    // mac 改名自迁移：文件名还是老产品名 → rename + 重启接力、本进程到此为止
    if (await maybeSelfRenameOnMac()) return;
    // 改名接力后的首次启动：提示重新固定 Dock（一次性）
    void notifyRenameOnce();
    // mac 延迟更新：启动早期若有比当前新的暂存 → 立刻套用并 relaunch（窗未开、无感知）
    // 必须在 cleanup 之前——cleanup 会保留有效暂存，但套用失败时也别先误清
    if (await tryApplyStagedUpdateOnLaunch()) return;
    // 删待重启 marker + 清 updates/ 残留（保留版本仍新于当前的 staged）
    // 审查发现：void 不 await 时与 server 读 update-pending-restart.json 有竞态，
    // 残留 marker 短窗内会误拦新任务——必须先清完再起 server（内部错误已吞、外再包一层）
    try {
      await cleanupUpdateLeftovers();
    } catch (err) {
      log(`[updater] 启动清扫异常（忽略）${err?.message || err}`);
    }
    // Windows 更新墓碑核销（静默装无回调、靠它把"无声消失"变"可见失败"）
    if (process.platform === "win32" && app.isPackaged) {
      try {
        const attemptFile = path.join(app.getPath("userData"), WIN_UPDATE_ATTEMPT_FILE);
        let attempt = null;
        try {
          attempt = JSON.parse(await fs.readFile(attemptFile, "utf8"));
        } catch {
          attempt = null;
        }
        const outcome = classifyWinUpdateAttempt(attempt, app.getVersion(), isNewer);
        // 成败都销墓碑（失败已弹框告知，不每启动 nag 一次）
        if (outcome !== "none") {
          await fs.rm(attemptFile, { force: true }).catch(() => {});
        }
        if (outcome === "success") {
          log(`[updater] 上次更新已生效 v${app.getVersion()}（墓碑已销）`);
        } else if (outcome === "failed") {
          const want = attempt?.version || "新版本";
          log(`[updater] 上次更新死半路：目标 v${want}、当前 v${app.getVersion()}`);
          setUpdateState({ phase: "available", version: want, error: "上次静默安装未完成" });
          // 读安装器日志找「预检拦截」记录（安装器只写 ASCII，latin1 解码不丢字节；只扫尾部 64KB）：
          // 有 → 空间不足的针对性文案、先让用户清理；没有 → 通用文案（空间与杀软并列、清理在前）。
          const installerLogPath = path.join(app.getPath("userData"), "logs", "installer.log");
          let installerLogText = "";
          try {
            installerLogText = (await fs.readFile(installerLogPath, "latin1")).slice(-65536);
          } catch {
            // 日志不存在 / 读不了 → 当通用失败处理
          }
          const failedMsg = buildUpdateFailedMessage({
            wantVersion: want,
            currentVersion: app.getVersion(),
            abort: findInstallerAbort(installerLogText, want),
            tempFreeMB: checkUpdateTempSpace(os.tmpdir(), statfsSync).freeMB,
            minTempFreeMB: MIN_TEMP_FREE_MB,
            installerLogPath,
          });
          dialog.showErrorBox(failedMsg.title, failedMsg.body);
          if (failedMsg.offerReleasePage) void shell.openExternal(RELEASE_LATEST_URL);
        }
      } catch (err) {
        log(`[updater] 墓碑核销异常（忽略）${err?.message || err}`);
      }
    }
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

    // splash 先亮（boot 期间唯一可见窗口、跟主窗同尺寸同位置）、主窗 hidden 待页面就绪
    createSplashWindow(nativeTheme.shouldUseDarkColors, await loadWindowState());
    bootTimeline.mark("splash");
    await createWindow();
    bootTimeline.mark("winCreated");
    installRequestRecorder();
    if (!IS_MAC || readMenuBarIconVisible()) {
      createTray();
    }
    startServer();
    void setupAutoUpdate();

    // 首次启动给足时间（150s），常规 60s；超时后 server 还活着 = 只是慢（不是挂了），
    // 给"继续等待"而不是直接判死刑——之前一次性 30s 是 Windows 首次必现启动超时的根因。
    const bootTimeoutMs = pickBootTimeoutMs(firstBoot);
    log(`[main] 等 server 就绪（timeout=${bootTimeoutMs} firstBoot=${firstBoot})`);
    const bootWaitStart = Date.now();
    const bootElapsedS = () =>
      ((Date.now() - bootWaitStart) / 1000).toFixed(1);
    let serverReady = await waitForReady(bootTimeoutMs);
    log(`[main] 首轮等待${serverReady ? "命中" : "超时"}、累计 ${bootElapsedS()}s`);
    while (
      !serverReady &&
      serverProc &&
      serverProc.exitCode === null &&
      !serverProc.killed
    ) {
      log("[main] server 还活着但没就绪，问用户继续等还是退出");
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: "正在启动",
        message: "内部服务还在启动中（首次启动或安全软件扫描时会比较慢）",
        detail: "点「继续等待」再等 2 分钟；点「退出」放弃本次启动。",
        buttons: ["继续等待", "退出"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) break;
      const roundStart = Date.now();
      serverReady = await waitForReady(120_000);
      log(
        `[main] 续等一轮${serverReady ? "命中" : "超时"}、本轮 ${((Date.now() - roundStart) / 1000).toFixed(1)}s、累计 ${bootElapsedS()}s`,
      );
    }
    if (serverReady) {
      bootTimeline.mark("serverReady");
      markFirstBootDone();
      const bootElapsedMs = Date.now() - bootWaitStart;
      log(`[main] server 就绪、轮询耗时 ${(bootElapsedMs / 1000).toFixed(1)}s`);
      // 启动偏慢（>30s）时顺手记下机器上的杀软清单：冷启动只读 ~430 个文件、服务端 CPU 不到 1s，
      // 慢几乎只可能慢在「首次读文件被拦下来扫」，有清单才能把「某某杀软」和「慢」对上号。
      // 就绪之后才查（不跟启动抢 CPU / 磁盘）、后台跑、超时 10s 自杀。
      if (bootElapsedMs > SLOW_BOOT_PROBE_MS) void logSecurityProducts();
      // 就绪后预热（fire-and-forget，5s 超时防半死 server 挂住 socket）：登录 shell 合并 / 迁移 / 组库 sync / 目录预热
      // 本来全挤在启动窗口抢冷盘，已搬到这里（见 boot-warmup.ts + /api/boot-warmup）。
      void fetch(`${BASE_URL}/api/boot-warmup`, {
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
      // R1-14：兜底触发飞书桥接 bootstrap（依赖 route 模块加载副作用）。
      // 壳 ready 后主动 GET 一次 status；首页未请求 /api/tasks 的 headless/Tray
      // 静默场景也能起 consumer。失败静默——桥接探测失败不影响开窗。
      void fetch(`${BASE_URL}/api/feishu-bridge/status`).catch(() => {});
      // 等待期间用户可能已手动关窗（关 splash = 全窗关闭 = 走退出流程）
      if (mainWindow) {
        // loadURL 前显式复位；did-start-loading 也会再置 false（双保险）
        pageLoaded = false;
        mainWindow.webContents.once("dom-ready", () => bootTimeline.mark("domReady"));
        await mainWindow.loadURL(BASE_URL);
        bootTimeline.mark("loadDone");
        // 兜底：页面没调 app-content-ready（老缓存页 / 页面异常 / 直落非首页路由）
        // 也不能永远黑着——加载完成 8s 内没收到信号就强制亮
        log("[main] loadURL 完成、等页面 content-ready（8s 兜底）");
        setTimeout(() => revealMainWindow("timeout"), 8_000);
      }
    } else {
      const serverState = !serverProc
        ? "gone"
        : serverProc.killed
          ? "killed"
          : serverProc.exitCode === null
            ? `alive pid=${serverProc.pid}`
            : `exited code=${serverProc.exitCode}`;
      log(`[main] server 未就绪、放弃启动（累计等待 ${bootElapsedS()}s, server=${serverState})`);
      closeSplashWindow();
      if (serverCrashPrompted) {
        // server 在启动期间就崩了：崩溃弹窗（onServerExit）已经弹出、在等用户选（选完它自己 app.quit）。
        // 这里不再叠一个「启动超时」——旧的 showErrorBox 同步阻塞、不会有这个交错，新的 showMessageBox 不阻塞才出现；
        // 也不抢先 app.quit()：用户还没来得及点「打开日志目录」应用就没了（B2-4b 终审 P3-4）。
        log("[main] server 启动期间已崩溃并弹出崩溃提示、不再弹「启动超时」");
        return;
      }
      dialog.showErrorBox(
        "启动超时",
        process.platform === "win32"
          ? `内部服务多次等待仍没有就绪。\n\n首次启动时安全软件全盘扫描会很慢，可重开再试；仍不行请检查是否有残留进程占用端口后重试。\n\n反馈问题时请把这个文件夹整个发给开发者（里面有启动日志和安装日志）：\n${path.join(app.getPath("userData"), "logs")}`
          : "内部服务多次等待仍没有就绪、请关闭应用重试。",
      );
      quitting = true;
      await stopServer();
      app.quit();
    }
  });

  // mac：点 Dock 图标时若窗口被 hide，重新 show（决策 #19）
  app.on("activate", () => {
    if (mainWindow) {
      showMainWindow();
      return;
    }
    // 极端：主窗已销毁但仍在跑——不应发生（关窗只 hide）；防守不重建，等用户从 Tray 退
  });

  // 渲染进程 / 子进程异常退出：以前只留在 Chromium 自己的 stderr 里、main.log 一无所获；渲染进程崩溃后窗口是一片空白、用户只能杀 App。
  // GPU / Utility 子进程 Electron 会自己重拉，这里只留痕。
  app.on("render-process-gone", (_event, webContents, details) => {
    onRenderProcessGone(webContents, details).catch((err) => {
      log(`[main] render-process-gone 处置本身出错：${err?.message || err}`);
    });
  });
  app.on("child-process-gone", (_event, details) => {
    log(describeChildGone(details));
  });

  // 真退出时所有窗口销毁才走到这（关窗 hide 不会触发）。
  // 保留：停 server + quit，与 Tray / Cmd+Q / 自更新重启路径一致。
  app.on("window-all-closed", async () => {
    log("[main] 所有窗口关闭、停 server 并退出");
    quitting = true;
    await stopServer();
    app.quit();
  });

  // 退出路径：杀 server 孤儿 + mac 套用暂存更新（不 relaunch）。
  // ditto 跨卷可能慢 → preventDefault 等替换完再 exit；失败不挡退出（启动兜底再试）。
  // ⚠️ 必须在此置 quitting=true：Cmd+Q 走 before-quit → 再关窗；close 拦截靠这个 flag
  // 放行，否则 Cmd+Q 会被 hide 吃掉、退不出去。自更新 quitAndInstall / applyStagedUpdate
  // 也先置 quitting，同一门控不会误拦。
  app.on("before-quit", (event) => {
    quitting = true;
    if (appNapBlockerId !== null) {
      try {
        powerSaveBlocker.stop(appNapBlockerId);
      } catch {
        /* 退出路径不挡 */
      }
      appNapBlockerId = null;
    }
    if (serverProc) {
      try {
        if (process.platform === "win32") {
          // win 必须连进程树杀（server 可能挂着 SDK agent / hook 子进程）——
          // kill("SIGKILL") 只杀单进程、孤儿子进程会占着端口导致下次启动弹
          // 「端口被占用」。before-quit 是同步钩子、用 execFileSync（毫秒级）；
          // timeout 兜底：taskkill 万一挂起也不能卡死退出流程
          execFileSync("taskkill", ["/PID", String(serverProc.pid), "/T", "/F"], {
            windowsHide: true,
            timeout: 5000,
          });
        } else {
          serverProc.kill("SIGKILL");
        }
      } catch {
        // 已退、忽略
      }
      serverProc = null;
    }
    if (applyingStagedOnQuit) return; // 套用完二次 exit、不再进
    // 仅 packaged mac 正式包；有有效暂存才拦截
    if (IS_MAC && app.isPackaged && !IS_TEST) {
      // 同步探一下有没有值得套用的暂存（避免无意义 preventDefault）
      const metaPath = stagedMetaFile();
      let shouldApply = false;
      try {
        if (existsSync(metaPath)) {
          const meta = JSON.parse(readFileSync(metaPath, "utf8"));
          shouldApply =
            meta?.version &&
            isNewer(meta.version, app.getVersion()) &&
            existsSync(meta.appPath);
        }
      } catch {
        shouldApply = false;
      }
      if (shouldApply) {
        event.preventDefault();
        applyingStagedOnQuit = true;
        void applyStagedUpdateOnQuit().finally(() => {
          app.exit(0);
        });
      }
    }
  });
}
