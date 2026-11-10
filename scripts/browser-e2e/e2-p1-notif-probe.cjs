"use strict";
/**
 * E2·P1 探针（A8 通知权限）：Electron 42 里，通知权限被授予后，页面 `new Notification()` 会不会真的弹**系统通知**？
 *
 * 为什么要测：契约要求「通知权限授予后不出系统通知，只记活动日志」。如果引擎会替页面弹系统通知，
 * 任意网页就能往用户桌面发（可伪装成系统 / Flowship 的）通知；那就必须在授予时额外拦住，不能只靠「授予 = 页面拿到 granted」。
 *
 * 判据：页面 `Notification` 对象的 `onshow`（Electron 在把通知交给系统通知中心之后才触发）/ `onerror`（交付失败）。
 *   - `onshow` 触发 = 引擎真的把它交给了系统（用户桌面上会出现一条通知）；
 *   - 同时测三条路径：主世界 `new Notification()`、`ServiceWorkerRegistration.showNotification()`、同源 about:blank 子 iframe 里的 `Notification`。
 * 会在本机真的弹 1~3 条标题为「Flowship E2 探针（可忽略）」的通知（silent），仅此一次实测用。
 *
 * 只能经启动器运行：node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-p1-notif-probe.cjs --timeout 60
 */
const { app, BrowserWindow, session } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-e2-p1-notif-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SW = `self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));`;
const PAGE = `<!doctype html><meta charset="utf-8"><title>notif</title><body>probe</body>`;

const main = async () => {
  await app.whenReady();
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/sw.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(SW);
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ses = session.fromPartition("persist:e2-p1-notif-probe");
  const log = [];
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    log.push({ type: "request", permission, isMainFrame: details?.isMainFrame, url: String(details?.requestingUrl || "").slice(0, 60) });
    cb(permission === "notifications");
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    log.push({ type: "check", permission, wc: wc ? "wc" : "null", origin: String(origin).slice(0, 40), isMainFrame: details?.isMainFrame });
    return permission === "notifications";
  });

  const win = new BrowserWindow({ show: false, width: 600, height: 400, webPreferences: { partition: "persist:e2-p1-notif-probe", sandbox: true } });
  await win.loadURL(`${base}/`);
  const run = (expr) => win.webContents.executeJavaScript(expr, true);

  const perm = await run("Notification.requestPermission()");
  console.log("PROBE requestPermission ->", perm, "| Notification.permission =", await run("Notification.permission"));

  // 1) 主世界 new Notification
  const main1 = await run(`new Promise((resolve) => {
    const ev = [];
    let n;
    try { n = new Notification('Flowship E2 探针（可忽略）', { body: '主世界 new Notification', silent: true }); } catch (e) { return resolve({ threw: String(e) }); }
    n.onshow = () => ev.push('show'); n.onerror = () => ev.push('error'); n.onclick = () => ev.push('click'); n.onclose = () => ev.push('close');
    setTimeout(() => { try { n.close(); } catch {} resolve({ ev }); }, 2500);
  })`);
  console.log("PROBE main-world new Notification ->", JSON.stringify(main1));

  // 2) 同源 about:blank 子 iframe 里的 Notification（绕过「主世界注入桩」的路径）
  const ifr = await run(`new Promise((resolve) => {
    const f = document.createElement('iframe'); document.body.appendChild(f);
    const W = f.contentWindow;
    const ev = [];
    let n;
    try { n = new W.Notification('Flowship E2 探针（可忽略）', { body: 'iframe Notification', silent: true }); } catch (e) { return resolve({ threw: String(e), perm: W.Notification.permission }); }
    n.onshow = () => ev.push('show'); n.onerror = () => ev.push('error');
    setTimeout(() => { try { n.close(); } catch {} resolve({ ev, perm: W.Notification.permission }); }, 2500);
  })`);
  console.log("PROBE about:blank iframe Notification ->", JSON.stringify(ifr));

  // 3) Service Worker 的 showNotification（权限检查时 wc 可能是 null）
  const swr = await run(`(async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      await reg.showNotification('Flowship E2 探针（可忽略）', { body: 'SW showNotification', silent: true });
      const list = await reg.getNotifications();
      list.forEach((n) => n.close());
      return { ok: true, shown: list.length };
    } catch (e) { return { ok: false, err: String(e).slice(0, 120) }; }
  })()`);
  console.log("PROBE service worker showNotification ->", JSON.stringify(swr));

  await sleep(500);
  console.log("PROBE permission handler log ->", JSON.stringify(log));

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(0);
};

main().catch((err) => {
  console.error("PROBE FATAL", err && err.stack ? err.stack : err);
  app.exit(1);
});
