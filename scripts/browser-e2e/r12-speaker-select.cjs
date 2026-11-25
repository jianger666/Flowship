"use strict";
/**
 * R12 真 Electron：内置浏览器里的扬声器 / 麦克风 / 摄像头权限。
 *
 * 复现的用户现象：声音检测 / 会议类页面里「选择扬声器」下拉只有一项「音频输出设备1」——
 * 页面拿到的 `enumerateDevices()` 只有一个空名、空 deviceId 的占位；外部 Chrome 里是真实的扬声器名；
 * 麦克风 / 摄像头检测更是直接用不了（`media` 曾经是「永远拒绝」的红线，用户明确要求放开）。
 *
 * 现在的口径（permission-policy.mjs）：
 *  - `speaker-selection` 放行（只给顶层站点自己的框架）：输出设备带真实名字，`setSinkId(具体设备)` 成功；
 *  - 摄像头 / 麦克风归「询问」（两个**独立**的授予：只允许麦克风不会连带摄像头，提示按页面实际要的那个写）：页面 `getUserMedia` → 面板弹 permission 提示 → 用户拒绝 = `NotAllowedError`，
 *    用户「本会话一直允许」= 拿到流、`permissions.query` 为 granted、麦克风 / 摄像头的设备名也随之可见；授予按 origin 隔离；
 *  - 跨源 iframe（被别的站点嵌着）始终看不到设备名；`display-capture`（屏幕共享）等仍永远拒绝。
 *
 * 安全措施：用 Chromium 的假设备开关（`use-fake-device-for-media-stream`），不碰真麦克风 / 摄像头；
 * 「允许」路径只对麦克风验证，且只在系统授权状态已是 granted 时才跑（摄像头在系统层是 not-determined 时调 getUserMedia 会弹真机授权框，
 * 摄像头的放行路径由单测覆盖）。
 *
 * 退出码：0 = 全部跑了且全过；1 = 有断言失败；2 = 脚本抛错；4 = 断言都过但有跳过（环境不满足三种：没有任何音频输出设备——扬声器名的两项没跑 /
 * 除默认设备外没有可选的具体扬声器——setSinkId 一项没跑 / 系统层麦克风授权不是 granted——「允许」路径没跑）。
 * 不用 3：本目录里 r8 / r9 / r14 / r17 的 3 是「脚本抛错」，r12 / r21 的 INCOMPLETE 特意避开这个已有明确含义的数字（各脚本的退出码本来各有约定、写在各自文件头，
 * `run.mjs` 头注释也这么说；这里只是不让新增的用法与已有的撞车。第二十四轮 P3-8，第二十五轮评审文档 5；r21 同一套约定）。
 * 跳过的项明说 SKIP、不计入通过（第二十三轮 R23-7）。
 *
 * 只能经启动器运行：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/r12-speaker-select.cjs --timeout 120
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, dialog, Menu, clipboard, shell, systemPreferences } = require("electron");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-r12-")));
app.setPath("userData", path.join(TMP, "userData"));
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
/** 环境不满足而没跑的项：不计入通过，有任何一项就以退出码 4 结束（第二十三轮 R23-7：以前这两处直接记一条写死 true 的 PASS，没跑完整的一次被当成 22/22 全绿） */
const skipped = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const skip = (id, name, reason) => {
  skipped.push({ id, name, reason });
  console.log(`SMOKE SKIP ${id} ${name} ${JSON.stringify(reason)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
};

/** 页面里跑的探测（顶层与 iframe 共用）。只枚举设备，不触碰麦克风 / 摄像头 */
const PROBE = `(async () => {
  const out = { secure: isSecureContext };
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const pick = (k) => list.filter((d) => d.kind === k);
    out.outputs = pick('audiooutput').map((d) => ({ label: d.label, hasId: d.deviceId !== '' }));
    out.inputs = pick('audioinput').map((d) => ({ label: d.label, hasId: d.deviceId !== '' }));
    out.cameras = pick('videoinput').map((d) => ({ label: d.label, hasId: d.deviceId !== '' }));
    const spk = pick('audiooutput').find((d) => d.deviceId && d.deviceId !== 'default');
    out.specificId = spk ? spk.deviceId : null;
  } catch (e) { out.err = e.name + ': ' + e.message; }
  return out;
})()`;

const GUM = (media) => `(window.__gum = 'pending', navigator.mediaDevices.getUserMedia(${media}).then((s) => { window.__gum = { ok: true, audio: s.getAudioTracks().length, video: s.getVideoTracks().length }; s.getTracks().forEach((t) => t.stop()); }, (e) => { window.__gum = { ok: false, name: e.name }; }), 1)`;

const main = async () => {
  await app.whenReady();

  // B = 跨源 iframe 的站点（localhost:portB）；A = 顶层站点（127.0.0.1:portA，之后再用 localhost:portA 当「另一个 origin」）
  const srvB = http.createServer((q, r) => {
    r.setHeader("content-type", "text/html; charset=utf-8");
    r.end(`<!doctype html><title>b</title><script>
      window.addEventListener('message', async () => { const out = await ${PROBE}; parent.postMessage({ out }, '*'); });
    </script>`);
  });
  await new Promise((r) => srvB.listen(0, "127.0.0.1", r));
  const portB = srvB.address().port;
  const srvA = http.createServer((q, r) => {
    r.setHeader("content-type", "text/html; charset=utf-8");
    r.end(`<!doctype html><title>r12</title><body>r12
      <iframe id="x" allow="speaker-selection; microphone; camera" src="http://localhost:${portB}/"></iframe></body>`);
  });
  await new Promise((r) => srvA.listen(0, "127.0.0.1", r));
  const portA = srvA.address().port;
  const urlA = `http://127.0.0.1:${portA}/`;
  const urlA2 = `http://localhost:${portA}/`; // 同一台服务，另一个 origin

  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);
  const appOrigin = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/app-origin.mjs")).href);
  const mainWin = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
  await mainWin.loadURL("about:blank");
  const handlers = new Map();
  const ipc = { handle: (n, f) => void handlers.set(n, f), on: () => {}, removeHandler: (n) => void handlers.delete(n), removeListener: () => {} };
  const manager = mod.createBrowserManager({
    app,
    BrowserWindow,
    WebContentsView,
    session,
    ipcMain: ipc,
    nativeImage,
    Menu,
    clipboard,
    shell,
    getMainWindow: () => (mainWin.isDestroyed() ? null : mainWin),
    isAppUrl: appOrigin.createIsAppUrl(() => 1),
    isTrustedIpcSender: () => true,
    log: () => {},
  });
  manager.registerIpc();
  manager.onConfig({ evaluateEnabled: true });
  const T = "r12-task";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
  const ev = async (expr) => (await call("evaluate", { expression: expr })).value;
  const sess = () => manager.getSession(T);
  const waitPermPrompt = () => waitFor(() => sess().prompts.list().find((p) => p.kind === "permission"));
  const gumResult = async () => waitFor(async () => {
    const v = await ev("window.__gum");
    return v !== "pending" ? v : null;
  }, 10000);

  await handlers.get("browser:newTab")({}, T, urlA);
  await sleep(1500);

  // ───────── 扬声器（放行）─────────
  const top = await ev(PROBE);
  check("r12-secure", "页面是安全上下文（navigator.mediaDevices 可用）", top.secure === true, top);
  check("r12-no-error", "enumerateDevices 没有报错", top.err === undefined, top.err);
  const outs = top.outputs ?? [];
  if (outs.length === 0) {
    // 没有任何音频输出设备是环境限制（与下面 r12-setsinkid 同类），不是 Flowship 的失败：显式 SKIP（不计入通过、退出码 4），不记成一条 FAIL（第二十四轮 P3-8：以前这里写 false，没设备的机器上整个脚本退出码 1）
    skip("r12-outputs-named", "顶层页面：所有输出设备都带真实名字和 deviceId（不是「一个空名占位」）", "本机没有任何音频输出设备（环境限制，无法验证扬声器名）");
    skip("r12-outputs-not-single-placeholder", "输出设备不是『单个空名占位』这一旧症状", "本机没有任何音频输出设备（环境限制）");
  } else {
    check("r12-outputs-named", "顶层页面：所有输出设备都带真实名字和 deviceId（不是「一个空名占位」）", outs.every((d) => d.label !== "" && d.hasId), outs);
    check("r12-outputs-not-single-placeholder", "输出设备不是『单个空名占位』这一旧症状", !(outs.length === 1 && outs[0].label === ""), outs);
  }
  if (top.specificId) {
    const sink = await ev(`(async () => {
      const r = {};
      try { await new Audio().setSinkId(${JSON.stringify(top.specificId)}); r.specific = 'ok'; } catch (e) { r.specific = e.name; }
      try { await new Audio().setSinkId('not-a-real-device-id'); r.fake = 'ok'; } catch (e) { r.fake = e.name; }
      return r;
    })()`);
    check("r12-setsinkid", "setSinkId(具体扬声器) 成功；乱写的 id 是 NotFoundError", sink.specific === "ok" && sink.fake === "NotFoundError", sink);
  } else {
    skip("r12-setsinkid", "setSinkId(具体扬声器) 成功；乱写的 id 是 NotFoundError", "本机除默认设备外没有可选的具体扬声器（环境限制）");
  }

  // 跨源 iframe（B 站点嵌在 A 里，即使写了 allow 属性）：看不到设备名
  const frame = await ev(`new Promise((res) => {
    window.addEventListener('message', (e) => res(e.data && e.data.out));
    document.getElementById('x').contentWindow.postMessage('go', '*');
    setTimeout(() => res('timeout'), 8000);
  })`);
  const fouts = frame && frame.outputs ? frame.outputs : null;
  check("r12-cross-origin-frame-hidden", "跨源 iframe（被别的站点嵌着）里设备名仍是空名占位", Array.isArray(fouts) && fouts.every((d) => d.label === ""), frame);

  // ───────── 麦克风 / 摄像头（询问）─────────
  // 授予之前：设备名是空名占位（检查处理器不弹提示）
  check("r12-inputs-hidden-before-grant", "用户还没允许时，麦克风 / 摄像头名字仍是空名", (top.inputs ?? []).every((d) => d.label === "") && (top.cameras ?? []).every((d) => d.label === ""), { inputs: top.inputs, cameras: top.cameras });
  const perms0 = await ev(`(async () => ({
    mic: (await navigator.permissions.query({ name: 'microphone' })).state,
    cam: (await navigator.permissions.query({ name: 'camera' })).state,
  }))()`);
  // 第二十一轮：Electron 的权限检查处理器只能回 boolean、没有 prompt 这一态——「还没授予」回 false 会让页面读到 denied，先 query 的页面就不会去请求、永远没有提示（同事的真实场景）。
  // 第二十二轮：第二十一轮的第一版让检查处理器在待询问时回 true（页面读到 granted），实测会让 WebRTC 暴露真实内网 / 公网 IP（ICE 候选走同一个检查）——撤销了。
  // 现在检查处理器只在已授予时回 true；页面读到的 denied 由页内小桩改成 prompt（见 r21-mic-prompt.cjs）：待询问 = prompt，不是 granted 也不是 denied，
  // 所以这里能真正区分「还没授予」（prompt）与「已授予」（下面 r12-perm-granted-after 的 granted）。
  check("r12-perm-state-before-grant", "用户还没允许时，permissions.query 对麦克风 / 摄像头读到 prompt（先 query 的页面会去请求并弹提示；不是 granted——还没授予，也不是 denied）", perms0.mic === "prompt" && perms0.cam === "prompt", perms0);
  check("r12-no-prompt-from-enumerate", "只枚举设备 / 查权限状态不会弹提示", sess().prompts.list().length === 0, sess().prompts.list());

  // 用户拒绝：不碰系统层，页面拿到 NotAllowedError
  await ev(GUM("{ audio: true }"));
  const p1 = await waitPermPrompt();
  check("r12-gum-prompt", "getUserMedia({audio}) → 面板弹 permission 提示（detail=microphone：只问麦克风，不是「摄像头 + 麦克风」；host 是 127.0.0.1）", !!p1 && p1.detail.permission === "microphone" && /127\.0\.0\.1/.test(p1.host), p1 && { detail: p1.detail, host: p1.host, actions: p1.actions });
  check("r12-gum-prompt-default-deny", "提示的默认动作是 deny", !!p1 && p1.actions[0] === "deny", p1 && p1.actions);
  if (p1) sess().prompts.answer(p1.id, { action: "deny" });
  const g1 = await gumResult();
  check("r12-gum-denied", "用户拒绝 → getUserMedia 被拒（NotAllowedError）", !!g1 && g1.ok === false && g1.name === "NotAllowedError", g1);

  // 用户允许（换一个 origin，避开刚才拒绝后的冷却）：只有系统层麦克风已授权才跑，用假设备
  const micOs = systemPreferences.getMediaAccessStatus("microphone");
  await call("navigate", { url: urlA2 });
  await sleep(800);
  if (micOs !== "granted") {
    // 整条「允许」路径都没跑：把依赖它的 9 项逐个登记为 SKIP（以前只记一条写死 true 的 r12-gum-allowed，其余 8 项连名字都不出现）
    for (const [id, name] of [
      ["r12-gum-prompt-2", "另一个 origin（localhost）重新弹提示"],
      ["r12-gum-allowed", "用户「本会话一直允许」→ getUserMedia 成功"],
      ["r12-perm-granted-after", "允许后 permissions.query(microphone) = granted"],
      ["r12-input-names-after-grant", "允许后麦克风设备名可见"],
      ["r12-camera-not-carried", "只允许麦克风：摄像头没被连带放开"],
      ["r12-gum-no-reprompt", "已允许后同 origin 再请求不再弹提示"],
      ["r12-camera-asked-separately", "麦克风已授予后只为摄像头弹提示"],
      ["r12-camera-denied", "拒绝摄像头 → getUserMedia 被拒"],
      ["r12-mic-unaffected-by-camera-deny", "拒绝摄像头不影响已授予的麦克风"],
    ]) {
      skip(id, name, `系统层麦克风授权状态是 ${micOs}（不是 granted），为免在本机弹系统授权框跳过「允许」路径（由单测覆盖）`);
    }
  } else {
    await ev(GUM("{ audio: true }"));
    const p2 = await waitPermPrompt();
    check("r12-gum-prompt-2", "另一个 origin（localhost）重新弹提示——授予与拒绝都按 origin 隔离", !!p2 && p2.detail.permission === "microphone" && /localhost/.test(p2.host), p2 && { detail: p2.detail, host: p2.host });
    if (p2) sess().prompts.answer(p2.id, { action: "allow-session" });
    const g2 = await gumResult();
    check("r12-gum-allowed", "用户「本会话一直允许」→ getUserMedia 成功拿到音频流（假设备）", !!g2 && g2.ok === true && g2.audio === 1, g2);

    const perms1 = await ev("(async () => (await navigator.permissions.query({ name: 'microphone' })).state)()");
    check("r12-perm-granted-after", "允许后 permissions.query(microphone) = granted", perms1 === "granted", perms1);
    const after = await ev(PROBE);
    check("r12-input-names-after-grant", "只允许了麦克风：麦克风设备名可见（声音检测页的下拉不再是空名）", (after.inputs ?? []).length > 0 && after.inputs.every((d) => d.label !== "" && d.hasId), { inputs: after.inputs });
    // R9-02：麦克风与摄像头是两个独立的授予——只允许了麦克风，摄像头的名字不能被连带放开、permissions.query(camera) 也不能是 granted
    // （以前是「共用一条 media」，这里会看到 fake_device_0 / granted）。第二十二轮起「待询问」读到 prompt、已授予才是 granted，所以这条判据恢复了判别力：
    // 摄像头没授予 → prompt（不是 granted）；摄像头是否还要单独问另由下面的 r12-camera-asked-separately 钉住
    const camState = await ev("(async () => (await navigator.permissions.query({ name: 'camera' })).state)()");
    check("r12-camera-not-carried", "只允许了麦克风：摄像头名字仍是空名、permissions.query(camera) 仍是 prompt（没被连带放开成 granted）", (after.cameras ?? []).every((d) => d.label === "") && camState === "prompt", { cameras: after.cameras, camState });

    // 同 origin 再次请求：不再弹提示，直接成功
    await ev(GUM("{ audio: true }"));
    const g3 = await gumResult();
    check("r12-gum-no-reprompt", "本会话已允许后，同 origin 再次 getUserMedia 不再弹提示、直接成功", !!g3 && g3.ok === true && sess().prompts.list().length === 0, { g3, prompts: sess().prompts.list().length });

    // R9-02：页面再要「麦克风 + 摄像头」→ 只问还没授予的摄像头（提示写「摄像头」）；这里只走「拒绝」路径，不碰系统层摄像头授权框
    await ev(GUM("{ audio: true, video: true }"));
    const p3 = await waitPermPrompt();
    check("r12-camera-asked-separately", "麦克风已授予后，getUserMedia({audio, video}) 只为摄像头弹提示（detail=camera，不再问麦克风）", !!p3 && p3.detail.permission === "camera" && /localhost/.test(p3.host), p3 && { detail: p3.detail, host: p3.host });
    if (p3) sess().prompts.answer(p3.id, { action: "deny" });
    const g4 = await gumResult();
    check("r12-camera-denied", "拒绝摄像头 → getUserMedia({audio, video}) 被拒（NotAllowedError）", !!g4 && g4.ok === false && g4.name === "NotAllowedError", g4);
    await ev(GUM("{ audio: true }"));
    const g5 = await gumResult();
    check("r12-mic-unaffected-by-camera-deny", "拒绝摄像头不影响已授予的麦克风：只要音频仍直接成功、不弹提示", !!g5 && g5.ok === true && g5.audio === 1 && sess().prompts.list().length === 0, { g5, prompts: sess().prompts.list().length });
  }

  // 红线收窄后仍然拒绝的：屏幕共享
  await call("navigate", { url: urlA });
  await sleep(800);
  const dc = await ev(`(async () => { try { await navigator.mediaDevices.getDisplayMedia({ video: true }); return 'GRANTED'; } catch (e) { return e.name; } })()`);
  check("r12-display-capture-still-denied", "屏幕共享（getDisplayMedia）仍被拒绝——只放开了摄像头 / 麦克风", dc !== "GRANTED", dc);

  manager.destroy();
  srvA.close();
  srvB.close();
};

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(
      `SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed${skipped.length ? `, ${skipped.length} skipped（${skipped.map((x) => x.id).join(",")}）` : ""}${failed.length ? ` FAILED: ${failed.map((f) => f.id).join(",")}` : ""}`,
    );
    if (!failed.length && skipped.length) console.log("SMOKE INCOMPLETE 有跳过的项（环境不满足）：这一次不能当成全绿，退出码 4");
    try {
      fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      console.warn("SMOKE WARN 临时目录没清掉（不影响结果）：", err && err.message ? err.message : err);
    }
    app.exit(failed.length ? 1 : skipped.length ? 4 : 0);
  })
  .catch((e) => {
    console.error("SMOKE ERROR", e);
    app.exit(2);
  });
