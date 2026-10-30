/**
 * 壳的崩溃处置（R14 B2-4b / Q15-04，以及 Q15-03 里的渲染 / 子进程异常退出）：决策与文案都是纯函数，
 * 不依赖 electron——vitest 直接测。编排（弹窗 / 重启 server / reload 页面 / 打开目录）在 main.js 的
 * `onServerExit` / `onRenderProcessGone`，那里只做 I/O、不再自己判断。
 *
 * 旧行为（台账 Q15-04）：
 *   - server 退出只收 `code`：被信号杀掉（OOM killer / jetsam 的 SIGKILL、V8 堆耗尽的 SIGABRT）时 code 是 null，
 *     日志和弹窗里就是一个常量 `code=?`，看不出是怎么死的；
 *   - 弹窗只有一个「确定」，用户不知道日志在哪；server 已经生成了崩溃取证报告（`--report-on-fatalerror`，落在
 *     userData/data/diagnostics/node-reports）也不告诉用户；
 *   - 跑了几小时后一次偶发崩溃也让整个 App 直接退出。
 * 现在：
 *   - 日志与弹窗都带 `(code, signal)`；信号 / 退出码像是内存不足（SIGKILL / SIGABRT / 137 / 134）时多一句提示；
 *   - 弹窗带「打开日志目录」（以及本次崩溃之后确实生成了取证报告时的「打开崩溃报告目录」）；
 *   - 稳定运行 ≥ 60s 后崩溃，自动重启一次（整个 App 进程生命周期内只一次）；启动就崩（< 60s）不重启——那是配置 / 环境问题，重启只会循环。
 *
 * Windows 上 V8 堆耗尽的退出码形状（不是 SIGABRT，而是一个大整数）需要在真机上量，这里**不做推断**：
 * 判不出就当普通崩溃，只是少一句内存提示。
 */

/** server 至少稳定运行这么久，崩溃才值得自动重启一次 */
export const AUTO_RESTART_MIN_UPTIME_MS = 60_000;
/** 每个 App 进程生命周期内最多自动重启几次（字面的「只一次」；换成滑动窗口见 HANDOFF 备选） */
export const MAX_AUTO_RESTARTS = 1;
/** 渲染进程崩溃后自动 reload：窗口期内最多一次 */
export const RENDER_RELOAD_WINDOW_MS = 60_000;
/** 渲染进程自动 reload 累计上限（超过只提示、不再自动刷新） */
export const RENDER_RELOAD_MAX_TOTAL = 3;

export const BUTTON_OPEN_LOGS = "打开日志目录";
export const BUTTON_OPEN_REPORTS = "打开崩溃报告目录";
export const BUTTON_RELOAD = "重新加载页面";
export const BUTTON_QUIT = "退出";

/** exit 事件的 (code, signal) 变成日志里的一段文字：`code=137 signal=null` / `code=null signal=SIGKILL` */
export const describeExit = (code, signal) => `code=${code ?? "null"} signal=${signal ?? "null"}`;

/**
 * 退出方式像不像内存不足：SIGKILL（Linux OOM killer / macOS jetsam）、SIGABRT（V8 堆耗尽走 abort）、
 * 以及被 shell 包装后折成的 137 / 134（128 + 信号号）。判不出来返回 false——宁可少一句提示，也不乱说。
 */
export const looksLikeOutOfMemory = (code, signal) =>
  signal === "SIGKILL" || signal === "SIGABRT" || code === 137 || code === 134;

/**
 * server 退出后怎么办。
 * - `ignore`：旧进程迟来的 exit（serverProc 已被接管 / 替换），或用户主动退出（quitting）——不是崩溃
 * - `restart`：稳定运行 ≥ AUTO_RESTART_MIN_UPTIME_MS，且这个 App 进程里还没自动重启过
 * - `prompt`：其余——弹窗并退出
 */
export const decideServerExit = ({ stale, quitting, uptimeMs, autoRestarts }) => {
  if (stale || quitting) return "ignore";
  const up = Number.isFinite(uptimeMs) ? uptimeMs : 0;
  if (up >= AUTO_RESTART_MIN_UPTIME_MS && autoRestarts < MAX_AUTO_RESTARTS) return "restart";
  return "prompt";
};

/** 运行时长的人话：`42 秒` / `3 分钟` / `2 小时 5 分钟` */
export const formatUptime = (ms) => {
  const sec = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分钟`;
};

/** server 崩溃弹窗的标题 / 正文 / 按钮（按钮文案由 main.js 按字符串分派，所以导出常量） */
export const buildServerCrashNotice = ({ code, signal, uptimeMs, restartFailed = false, hasFreshReports = false }) => {
  const lines = [`内部服务意外退出（${describeExit(code, signal)}，已运行 ${formatUptime(uptimeMs)}）。`];
  if (looksLikeOutOfMemory(code, signal)) {
    lines.push("退出方式像是被系统结束或内存耗尽——可以先关掉一些任务和其它占内存的程序，再重新打开应用。");
  }
  if (restartFailed) lines.push("已自动重启过一次，但没能恢复。");
  if (hasFreshReports) {
    lines.push("这次崩溃生成了取证报告：点「打开崩溃报告目录」，把里面最新的文件连同日志一起发给维护者。");
  }
  lines.push("详细过程在 main.log 里（点「打开日志目录」）。请重新打开应用。");
  return {
    title: "服务异常退出",
    message: lines.join("\n"),
    buttons: [BUTTON_OPEN_LOGS, ...(hasFreshReports ? [BUTTON_OPEN_REPORTS] : []), BUTTON_QUIT],
  };
};

/**
 * 从「目录里的文件 + mtime」里挑出本次 server 启动之后才生成的取证报告（.json）。
 * 上一次崩溃留下的旧报告不算——否则这次崩溃的弹窗会指着一份与它无关的报告。slackMs 吸收文件系统时间戳的粒度。
 * @param {Array<{ name: string, mtimeMs: number }>} files
 * @param {number} sinceMs server 本次启动的时刻
 */
export const pickFreshReports = (files, sinceMs, slackMs = 2000) =>
  files.filter(
    (f) =>
      typeof f?.name === "string" &&
      f.name.endsWith(".json") &&
      Number.isFinite(f.mtimeMs) &&
      f.mtimeMs >= sinceMs - slackMs,
  );

// ---------- 渲染进程 / 子进程 ----------

/** 值得自动刷新页面的退出原因（clean-exit 是正常关窗；launch-failed / integrity-failure 刷新也没用） */
export const RELOADABLE_RENDER_REASONS = new Set(["crashed", "oom", "killed", "abnormal-exit"]);

/**
 * 渲染进程退出后怎么办（reloadTimes = 之前自动刷新过的时刻，不可变地传入 / 传出，方便测）。
 * - `log-only`：不是需要刷新的原因
 * - `reload`：窗口期（RENDER_RELOAD_WINDOW_MS）内还没刷新过、累计也没到上限
 * - `give-up`：刚刷新过又崩 / 累计到上限——停止自动刷新，由调用方提示用户
 */
export const decideRenderGone = ({ reason, nowMs, reloadTimes }) => {
  if (!RELOADABLE_RENDER_REASONS.has(reason)) return { action: "log-only", reloadTimes };
  const recent = reloadTimes.filter((t) => nowMs - t < RENDER_RELOAD_WINDOW_MS);
  if (reloadTimes.length >= RENDER_RELOAD_MAX_TOTAL || recent.length >= 1) {
    return { action: "give-up", reloadTimes };
  }
  return { action: "reload", reloadTimes: [...reloadTimes, nowMs] };
};

const RENDER_REASON_LABELS = {
  crashed: "崩溃",
  oom: "内存不足",
  killed: "被结束",
  "abnormal-exit": "异常退出",
};
export const renderReasonLabel = (reason) => RENDER_REASON_LABELS[reason] ?? String(reason ?? "未知原因");

/** 页面反复崩溃时的提示（自动刷新已停）。「重新加载页面」是用户明确点的那一次，不受自动刷新的上限约束 */
export const buildRenderGoneNotice = ({ reason }) => ({
  title: "页面反复崩溃",
  message:
    `页面进程多次异常退出（最近一次：${renderReasonLabel(reason)}），已停止自动刷新。` +
    "可以点「重新加载页面」再试一次；如果反复出现，请点「打开日志目录」、把 main.log 发给维护者。",
  buttons: [BUTTON_RELOAD, BUTTON_OPEN_LOGS, BUTTON_QUIT],
});

/** render-process-gone 的日志行（details 缺字段也不抛） */
export const describeRenderGone = (details) =>
  `[main] render-process-gone reason=${details?.reason ?? "unknown"} exitCode=${details?.exitCode ?? "null"}`;

/** child-process-gone 的日志行（GPU / Utility 等子进程；Electron 自己会重拉 GPU 进程，这里只留痕） */
export const describeChildGone = (details) =>
  `[main] child-process-gone type=${details?.type ?? "unknown"} reason=${details?.reason ?? "unknown"} exitCode=${details?.exitCode ?? "null"}` +
  (details?.name ? ` name=${details.name}` : "") +
  (details?.serviceName ? ` service=${details.serviceName}` : "");
