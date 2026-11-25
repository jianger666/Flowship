"use strict";
/**
 * 锁屏必黑屏（真 Electron + 真 macOS 电源断言）：electron-app/lock-display-off.mjs。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/lock-display-off.cjs --timeout 120
 *
 * 要证实的事（单测里的假 pmset 证明不了的）：
 *   A 真视频在播 → Chromium 真的为本进程持有「Video Wake Lock」，真 `pmset -g assertions` 的输出里
 *     属主 pid = 本进程，parseHoldsDisplayLock 能认出来；
 *   B 此时「锁屏」→ 触发熄屏命令，而且**页面不受影响**：视频仍在播放（没被暂停）、页面计时器照常走
 *     ——这是「黑屏后 AI 仍能操作内置浏览器」的前提（用户明确要求：不能解决了黑屏、丢了 AI 能操作）；
 *   B3 本进程持锁、但别的程序也在阻止熄屏 → 不介入（影响范围只限 Flowship，不替其他程序做主）；
 *   C 视频停掉、亮屏锁真的释放后再锁屏 → 不熄屏（Flowship 没持有就交给系统）；
 *   D powerMonitor 的 getSystemIdleTime / lock-screen / unlock-screen 在真 Electron 里可用；
 *     毫秒级键鼠空闲读数（ioreg HIDIdleTime）在真机上可用，且与整秒值一致（巡检靠它分清熄屏后很短时间内的触碰）。
 *
 * 安全：`pmset displaysleepnow` 在这里只做记录、**不会真的执行**（否则会把开发机熄屏并锁定）；
 * 只读 `pmset -g assertions` 走真命令。真锁屏 + 真熄屏的人工实测另行进行。
 *
 * 只在 macOS 运行（其它平台直接 SKIP 退出 0）。临时 userData、窗口 1% 透明 + 点击穿透（Chromium 判定被遮挡的窗口
 * 不持视频亮屏锁，所以窗口必须「真的可见」；用 1% 透明避免晃用户的眼），不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, powerMonitor, dialog } = require("electron");
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-lock-display-off-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`E2E ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = (code) => {
  const failed = results.filter((r) => !r.ok);
  console.log(`E2E DONE ${results.length - failed.length}/${results.length} passed`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn("SMOKE WARN 临时目录没清掉（不影响结果）：", err && err.message ? err.message : err);
  }
  app.exit(code ?? (failed.length ? 1 : 0));
};

const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => fs.existsSync(p));

const PAGE = `<!doctype html><meta charset="utf-8"><title>lock-display-off</title>
<video id="v" src="clip.mp4" width="320" height="240" muted loop autoplay playsinline></video>
<script>
  window.__ticks = 0;
  setInterval(() => { window.__ticks++; }, 200);
  window.__state = () => {
    const v = document.getElementById('v');
    return { paused: v.paused, t: v.currentTime, ticks: window.__ticks, vis: document.visibilityState };
  };
</script>`;

const pmsetAssertions = () =>
  new Promise((resolve) => {
    execFile("/usr/bin/pmset", ["-g", "assertions"], { timeout: 5000 }, (err, stdout) =>
      resolve({ ok: !err, stdout: String(stdout ?? "") }),
    );
  });

/**
 * 去掉「别的进程」的亮屏锁行：开发机上通常还跑着真 Flowship / Chrome（它们自己也会持亮屏锁），
 * 而模块现在「别的程序也在阻止熄屏就不介入」——不隔离的话，B1 的结果会随开发机当时在跑什么而变。
 * 本进程自己的行原样保留（真数据）。
 */
const isolateOwn = (stdout) =>
  String(stdout ?? "")
    .split("\n")
    .filter((l) => {
      const m = /^\s*pid\s+(\d+)\(.*?\):\s*\[0x[0-9a-fA-F]+\]\s+\S+\s+(\w+)\b/.exec(l);
      if (!m) return true;
      const isDisplayLock = /^(?:NoDisplaySleepAssertion|PreventUserIdleDisplaySleep|PreventDisplaySleep)$/.test(m[2]);
      return !isDisplayLock || m[1] === String(process.pid);
    })
    .join("\n");

const waitFor = async (fn, timeoutMs, stepMs = 300) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(stepMs);
  }
};

const makeWindow = async (file) => {
  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: 360,
    height: 300,
    show: false,
    frame: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: { autoplayPolicy: "no-user-gesture-required", backgroundThrottling: false },
  });
  win.setOpacity(0.01);
  win.setIgnoreMouseEvents(true);
  await win.loadFile(file);
  win.showInactive();
  return win;
};

app.whenReady().then(async () => {
  if (process.platform !== "darwin") {
    console.log("E2E SKIP 非 macOS：亮屏锁 / pmset 只在 macOS 有意义");
    return app.exit(0);
  }
  if (!FFMPEG) {
    console.log("E2E SKIP 没有 ffmpeg，无法生成测试视频");
    return app.exit(0);
  }

  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/lock-display-off.mjs")).href);
  const { createLockDisplayOff, parseHoldsDisplayLock, readIdle } = mod;

  // 测试视频 + 页面
  const clip = path.join(TMP, "clip.mp4");
  execFileSync(
    FFMPEG,
    ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15", "-t", "20", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip],
    { timeout: 30000 },
  );
  const pageFile = path.join(TMP, "page.html");
  fs.writeFileSync(pageFile, PAGE);

  // 预热：进程里第一个被显示的窗口会被判成「被遮挡」（实测），先开关一个
  const warm = await makeWindow(pageFile);
  await sleep(600);
  warm.webContents.close();
  warm.destroy();
  await sleep(300);

  const win = await makeWindow(pageFile);
  const wc = win.webContents;
  const state = () => wc.executeJavaScript("window.__state()");

  // ── A：真视频 → 真亮屏锁，属主 = 本进程 ──
  const playing = await waitFor(async () => {
    const s = await state().catch(() => null);
    return s && !s.paused && s.t > 0.2 ? s : null;
  }, 15000);
  check("A1", "测试视频确实在播放（页面可见）", !!playing, playing);

  const holding = await waitFor(async () => {
    const r = await pmsetAssertions();
    return r.ok && parseHoldsDisplayLock(r.stdout, process.pid) ? r : null;
  }, 15000);
  const mine = holding ? holding.stdout.split("\n").filter((l) => new RegExp(`^\\s*pid\\s+${process.pid}\\(`).test(l)) : [];
  check("A2", "真 pmset 输出里本进程持有亮屏锁，parseHoldsDisplayLock 认得出来", !!holding, mine.map((l) => l.trim().slice(0, 120)));

  // ── B：锁屏 → 触发熄屏命令，页面不受影响 ──
  const sleepCalls = [];
  const logs = [];
  const makeCtl = (extraStdout = "") =>
    createLockDisplayOff({
      pid: process.pid,
      execPmset: async (args) => {
        if (args[0] === "displaysleepnow") {
          sleepCalls.push(Date.now()); // 只记录，不真的熄屏
          return { ok: true, stdout: "" };
        }
        const r = await pmsetAssertions();
        return { ok: r.ok, stdout: isolateOwn(r.stdout) + extraStdout };
      },
      readIdle: () => readIdle(execFile, () => powerMonitor.getSystemIdleTime()),
      log: (m) => {
        logs.push(m);
        console.log(`  [log] ${m}`);
      },
      graceMs: 100,
    });

  const before = await state();
  const ctl = makeCtl();
  ctl.onLock();
  await waitFor(() => sleepCalls.length > 0, 5000, 100);
  check("B1", "锁屏且 Flowship 持有亮屏锁：触发了一次熄屏命令", sleepCalls.length === 1, { calls: sleepCalls.length });
  await sleep(1200);
  const after = await state();
  check(
    "B2",
    "熄屏流程之后页面完全不受影响：视频仍在播放（没被暂停）、位置前进、页面计时器照常走",
    after.paused === false && after.t !== before.t && after.ticks > before.ticks,
    { before, after },
  );
  ctl.onUnlock();

  // ── B3：本进程仍持有真亮屏锁，但「别的程序」也在阻止熄屏 → 不介入（影响范围只限 Flowship）──
  sleepCalls.length = 0;
  logs.length = 0;
  const FAKE_OTHER =
    '   pid 99999(FakeOtherApp): [0x0000000100000001] 00:00:03 PreventUserIdleDisplaySleep named: "Video Wake Lock"  \n';
  const ctl3 = makeCtl(FAKE_OTHER);
  ctl3.onLock();
  await sleep(1500);
  check(
    "B3",
    "本进程持有真亮屏锁、同时别的程序也在阻止熄屏（真输出 + 假的 FakeOtherApp）：不熄屏，日志点名",
    sleepCalls.length === 0 && logs.some((l) => /FakeOtherApp/.test(l)),
    { calls: sleepCalls.length, logs },
  );
  ctl3.onUnlock();

  // ── C：视频停掉、亮屏锁真释放后再锁屏 → 不熄屏 ──
  wc.close();
  win.destroy();
  const released = await waitFor(async () => {
    const r = await pmsetAssertions();
    return r.ok && !parseHoldsDisplayLock(r.stdout, process.pid) ? r : null;
  }, 20000, 500);
  check("C1", "窗口销毁后真 pmset 里本进程不再持有亮屏锁", !!released);

  sleepCalls.length = 0;
  logs.length = 0;
  const ctl2 = makeCtl();
  ctl2.onLock();
  await sleep(1500);
  check("C2", "没持有亮屏锁时锁屏：不熄屏（交给系统），只记一条日志", sleepCalls.length === 0 && logs.some((l) => /没有持有亮屏锁/.test(l)), {
    calls: sleepCalls.length,
    logs,
  });
  ctl2.onUnlock();

  // ── D：powerMonitor 接口在真 Electron 里可用 ──
  const idle = powerMonitor.getSystemIdleTime();
  check("D1", "powerMonitor.getSystemIdleTime() 返回非负数字", typeof idle === "number" && idle >= 0, { idle });
  let registered = false;
  try {
    const noop = () => {};
    powerMonitor.on("lock-screen", noop);
    powerMonitor.on("unlock-screen", noop);
    registered = powerMonitor.listenerCount("lock-screen") >= 1 && powerMonitor.listenerCount("unlock-screen") >= 1;
    powerMonitor.removeListener("lock-screen", noop);
    powerMonitor.removeListener("unlock-screen", noop);
  } catch (err) {
    console.log(`  注册失败：${err?.message || err}`);
  }
  check("D2", "lock-screen / unlock-screen 监听在真 Electron 里能注册", registered);

  // 毫秒级读数：真 ioreg；与 Electron 整秒值对照（两次读之间用户可能碰键鼠，所以只在两者都「很近」或差值合理时判过）
  const a = await readIdle(execFile, () => powerMonitor.getSystemIdleTime());
  const secs = powerMonitor.getSystemIdleTime();
  check(
    "D3",
    "readIdle 在真机上走毫秒级（precise），数值与 Electron 整秒值相差 < 2 秒",
    !!a && a.precise === true && Math.abs(a.idleMs / 1000 - secs) < 2,
    { ioreg: a, powerMonitorSeconds: secs },
  );

  finish();
}).catch((err) => {
  console.log(`E2E FAIL 脚本异常 ${err?.stack || err}`);
  finish(1);
});
