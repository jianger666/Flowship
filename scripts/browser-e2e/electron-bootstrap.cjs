"use strict";
/**
 * 无头 Electron e2e 的统一入口（由 run.mjs 作为 Electron 的 main 脚本启动，真正的 e2e 脚本经环境变量 FS_E2E_TARGET 传入）。
 *
 * 为什么要多这一层：Electron 对主进程未捕获异常的默认处理是弹原生模态框并挂住等人点「好」——
 * 事故见 launcher-lib.mjs 头注释。这里在加载目标脚本**之前**先做三件事：
 *   1) 把 dialog.showErrorBox / showMessageBox* 改成只往 stderr 打印；
 *   2) 注册 uncaughtException / unhandledRejection：打印堆栈 + 非零退出，不再弹窗；
 *   3) 起超时看门狗（FS_E2E_TIMEOUT_MS），脚本忘了退出 / 卡死时 124 退出。
 * 目标脚本自己的 `require` 放在 try/catch 里，所以即使它在加载阶段就抛错（语法错误已被启动器预检拦掉，这里兜运行期加载错误）
 * 也只会打印 + 退出。
 */
const path = require("node:path");
const { app, dialog } = require("electron");

const target = process.env.FS_E2E_TARGET;
const timeoutMs = Number(process.env.FS_E2E_TIMEOUT_MS) || 180_000;

const fail = (code, ...msg) => {
  try {
    console.error("[e2e]", ...msg);
  } catch {
    /* stdout 已关就算了 */
  }
  // app.exit 不触发 before-quit / window 的 close 拦截，是「无条件退」的正确口径
  app.exit(code);
};

// 不碰系统钥匙串（2026-11-07 事故：反复弹「找不到用于储存 “Electron Key” 的钥匙串」）：
// 内置浏览器的 partition 是 persist: 的，Chromium 启动时就要去系统钥匙串取 Cookie 加密密钥（服务名 Electron Safe Storage、
// 账户名 Electron Key）；钥匙串缺失 / 锁着时 macOS 弹模态框，e2e 一次次起 Electron 就一次次弹。
// use-mock-keychain 让 os_crypt 用内存里的假钥匙串（临时 userData 里的数据本来就是一次性的，不需要真加密）。
// 必须在 app ready 之前设；linux 对应的是 password-store=basic（不走 libsecret / kwallet）。
app.commandLine.appendSwitch("use-mock-keychain");
if (process.platform === "linux") app.commandLine.appendSwitch("password-store", "basic");

// 不要 Dock 图标、不抢焦点、不进 Cmd+Tab（darwin 才有；其它平台无此 API）
if (process.platform === "darwin") {
  try {
    app.setActivationPolicy("prohibited");
  } catch {
    /* 老版本没有就算了 */
  }
  try {
    app.dock?.hide();
  } catch {
    /* 同上 */
  }
}

// 任何走 dialog 的路径都不许真的弹出来（e2e 无人值守，弹了就是挂死）
dialog.showErrorBox = (title, content) => {
  console.error("[e2e] 拦截了 dialog.showErrorBox：", title, "\n", content);
};
dialog.showMessageBox = async (...args) => {
  console.error("[e2e] 拦截了 dialog.showMessageBox：", JSON.stringify(args[args.length - 1] ?? null).slice(0, 300));
  return { response: 0, checkboxChecked: false };
};
dialog.showMessageBoxSync = (...args) => {
  console.error("[e2e] 拦截了 dialog.showMessageBoxSync：", JSON.stringify(args[args.length - 1] ?? null).slice(0, 300));
  return 0;
};

process.on("uncaughtException", (e) => fail(1, "主进程未捕获异常：", (e && e.stack) || String(e)));
process.on("unhandledRejection", (e) => fail(1, "未处理的 Promise 拒绝：", (e && e.stack) || String(e)));

const watchdog = setTimeout(() => fail(124, `超时（${Math.round(timeoutMs / 1000)}s）仍未退出，已强制结束`), timeoutMs);
watchdog.unref();

if (!target) {
  fail(2, "缺少 FS_E2E_TARGET（请经 scripts/browser-e2e/run.mjs 启动，而不是直接起 Electron）");
} else {
  // 让目标脚本看到的 argv 和直接 `electron <script> …` 一致：argv[1] 是它自己
  process.argv.splice(1, 1, path.resolve(target));
  try {
    require(path.resolve(target));
  } catch (e) {
    fail(1, `加载 ${target} 失败：`, (e && e.stack) || String(e));
  }
}
