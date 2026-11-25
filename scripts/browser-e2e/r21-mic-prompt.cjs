"use strict";
/**
 * R21 / R22 真 Electron：页面要麦克风时，面板的权限提示条能不能弹出来；以及「让页面读到 prompt」不能顺带把本机真实 IP 泄露给页面
 * （第二十一轮同事的真实场景 + 第二十二轮评审发现的泄露回归）。
 *
 * 现象：Flowship 内置浏览器里打开儿童口语练习页（https://wuxue-student-test.wukongedu.net/），页面弹自己的「答题需要有麦克风权限哦」，
 * 面板上没有任何 Flowship 的权限提示条；让 AI 帮忙操作也不行。
 *
 * 两个已用真 Electron 复现的根因：
 *  ① `navigator.permissions.query({name:'microphone'})`：Electron 的检查处理器只能回 boolean，没有 prompt 这一态，「还没授予」回 false 就是页面读到 denied。
 *     先 query、denied 就报「没有权限」的页面（常见写法）根本不会去 getUserMedia，请求处理器永远没机会弹提示。
 *  ② 页面常把真正的练习页放在 `<iframe allow="microphone">` 里：此前跨源子框架一律静默拒绝（没提示、没日志）。
 *
 * 修法（第二十二轮的最终设计）：
 *  ① 检查处理器**只在授予记录是 allow 时回 true**（待询问 / 冷却 / 显式拒绝都回 false）；页面读到的 denied 由页内的 `Permissions.prototype.query` 小桩
 *     改成 prompt（只改麦克风 / 摄像头；且该文档是安全上下文、http(s) 协议、Permissions-Policy 允许这项 feature 时——策略对象取 `permissionsPolicy || featurePolicy`，
 *     Chrome 148 上只有后者），经 CDP 会话钩子装进每个文档（子会话走「早钩子」，先于页面脚本，缩小而不是消除 OOPIF 的时序窗口）。
 *     桩只替换返回的 PermissionStatus（Proxy：state 的 denied 改成 prompt，方法绑回原对象，赋值走 Reflect.set(target, key, value, target)）。
 *     第二十一轮的第一版是「query 形状的检查在待询问时回 true」——**实测会泄露**：WebRTC 的 ICE 候选收集走同一个 media 权限检查（形状一模一样），
 *     回 true 就让 Chromium 放弃 mDNS 隐藏、把真实内网 / 公网 IP 交给页面（修前探针：待询问状态下 host 候选 = 4 个内网 IPv4 + 2 个公网 IPv4；基线只有 `.local` 名）。
 *     本脚本的 ICE 断言（带「授予后真实地址会出现」的对照）就是防这个回归的哨兵。
 *  ② 被顶层委托了的跨源 iframe：先在该框架的隔离世界里核对 `document.permissionsPolicy.allowsFeature('microphone')`，通过才按「顶层站点」弹提示 / 放行，
 *     提示条里写明实际发起的嵌入页面；没委托 / 核对不出来拒绝，并留一条活动记录 + 进 `permissions list` 的「最近被自动拒绝」清单。
 *
 * 覆盖：
 *   S1 顶层页面：桩已装且不改变 PermissionStatus 的形状 → query = prompt → ICE 只有 mDNS 名 → getUserMedia 弹提示（只问麦克风）→ 拒绝 → NotAllowedError；
 *      冷却期内 query = prompt（已知限制：桩看不到冷却态）、ICE 仍无真实地址、不重复弹、清单里记 cooldown；设备名授予前仍隐藏；
 *   S2 跨站 iframe（localhost 嵌在 127.0.0.1 里，OOPIF）+ allow：iframe 里 query = prompt → 提示（detail.frame / origin = 顶层）→ 允许 / 拒绝；
 *   S3 同站跨源 iframe（cw.a.localhost 嵌在 app.a.localhost 里，同进程）+ allow：同上；
 *   S4 跨站 iframe 没有 allow：query 仍是 denied（桩不能把「政策不允许」改成 prompt）、不弹提示、被拒、清单与活动记录里是 frame-not-delegated；
 *   S5 AI 授予（pagePermissions 开）：授予前 prompt → 授予后麦克风 granted（摄像头仍 prompt）→ ICE 出现真实地址（对照：探针有判别力）→ 免提示取流、设备名可见；
 *      reset 之后设备名又隐藏、query 回 prompt、ICE 又只有 mDNS 名；
 *   S6 `allow="microphone http://other.invalid:1"`（origin 列表不含该 iframe）：没委托——query denied、不弹提示、frame-not-delegated；
 *   S7 `allow="microphone *"`：委托了——query prompt、弹提示（来源 = 顶层）；
 *   S8 提示还挂着时页面导航走：提示被取消、**不进冷却**——页面再请求会重新弹提示；
 *   S9 顶层文档带 `Permissions-Policy: microphone=()`：麦克风 query 保持 denied（桩尊重政策）、摄像头 prompt；
 *   S10 AI 点击 → `window.open` 弹窗（被收养成同会话的 tab：主会话的早钩子在 BrowserTab 构造期间就同步跑完了，桩要靠 tab 的「迟到登记补课」）：桩已装、query = prompt、
 *       getUserMedia 弹提示（提示属于弹窗这个 tab、只问麦克风）、拒绝 → NotAllowedError；另采样「弹窗文档的第一个脚本运行时桩在不在」（INFO，不断言，样本量小）；
 *       （第二十四轮 R24-1：修之前这一段在真 Electron 里实测失败——弹窗里桩根本没装、query 读到 denied；63/65）
 *   S11 非安全上下文（`http://insecure.test:PORT`，经 host-resolver-rules 映射到回环）：isSecureContext = false，桩已装、但麦克风 query 仍读到 denied（桩不改非安全上下文里的读数）；
 *       导航没落在 `insecure.test` 或 isSecureContext 不是 false（映射没生效）时 SKIP；页面当时有没有 `navigator.mediaDevices` 只记 INFO（不断言）。
 *   S12 文档解析期（`<head>` 里的内联脚本）就请求麦克风（第二十五轮 N-1）：两种页面（直接 getUserMedia / 先 permissions.query 再 getUserMedia）× 两种导航（从别的站点进入——localhost 跨站导航到 127.0.0.1 / 同源普通页导航到请求页），
 *       每格 S12_TRIALS 轮、每轮一个全新的 origin：提示照常弹出、400 毫秒后仍挂着（没有被 `did-navigate` 里的 `cancelMine()` 误取消——**这是主信号**）、拒绝后页面拿到 NotAllowedError；
 *       取消类活动记录 / 被拒记录只是辅助信号：取消日志与 overflow 共用限速器（每 60 秒只写一条，S8 之后一分钟内的取消不再写日志），所以只靠它抓不到取消。
 *       判别力的实测：把 did-navigate 里的 cancelMine() 临时改成延迟 120 毫秒再取消，四格全红（stillPending=false，cancelLogs 仍是 0——正是被限速吞掉的情形）。
 *       只拒绝、不授予（不触发系统授权框）。此前 S1–S11 都是页面加载完成之后才请求。
 *
 * 安全措施：Chromium 的假设备开关（`use-fake-device-for-media-stream`），不碰真麦克风 / 摄像头；「允许」路径只在系统层麦克风授权已是 granted 时才跑
 * （not-determined 时调 getUserMedia 会在本机弹真的系统授权框）。**跳过的项明说 SKIP、不计入通过，而且只要有跳过就以退出码 4（INCOMPLETE）结束**——
 * 没跑完整的一次不能被当成全绿（第二十二轮评审 R22-4：以前跳过路径写死 `true`，打的是 PASS）。
 * ICE 断言需要本机至少有一个非回环、非链路本地（169.254 / fe80::）的网卡地址（否则探针没有判别力，同样 SKIP + 退出码 4；macOS 的 awdl0 / utun 常驻着链路本地地址，不算）。
 *
 * 退出码：0 = 全部跑了且全过；1 = 有断言失败；2 = 脚本抛错；4 = 断言都过但有跳过（环境不满足三种：系统层麦克风授权不是 granted——各「允许」路径的断言没跑 /
 * 本机没有非回环、非链路本地的网卡地址，或 S5 的 ICE 对照不成立——ICE 相关断言没跑 / 没造出非安全上下文（导航没落在 `insecure.test` 或 isSecureContext 不是 false）——S11 没跑）。
 * 不用 3：本目录里 r8 / r9 / r14 / r17 的 3 是「脚本抛错」，r12 / r21 的 INCOMPLETE 特意避开这个已有明确含义的数字（各脚本的退出码本来各有约定、写在各自文件头，
 * `run.mjs` 头注释也这么说；这里只是不让新增的用法与已有的撞车。第二十四轮 P3-8，第二十五轮评审文档 5；r12 同一套约定）。
 *
 * 证据范围：证据只在 macOS、Electron 42.4.0 / Chrome 148 上取得；脚本不加平台硬守卫，但对不上这组版本就别把结果当成证据（脚本启动时打一行 SMOKE INFO）。
 * Electron 升级后必须重跑它：检查处理器的细节形状、`embeddingOrigin`、ICE 对 media 检查的依赖都是 Chromium 的未文档化行为，这是唯一的哨兵（没有 CI 自动跑它）。
 * 版本钉子：tests/browser-mic-prompt-gate.test.ts 末尾的 VERIFIED_ELECTRON_VERSION——以锁文件（pnpm-lock.yaml）里 electron 解析到的版本为准、无论本机装没装都判（另有一条在本机装了 electron 时核对安装版本）；
 * 与它不一致时单测变红，提醒先重跑本脚本再改常量。
 * ICE 断言的判别力（judgeIce 的判定顺序）：① 在待询问 / 冷却态看到了任何真实地址 = FAIL（泄露），无论对照如何；② 对照（S5：授予后真有真实地址出现）不成立 = 这台机器上探针看不见真实地址，
 * 相关断言全部 SKIP（退出码 4；含断网时一个候选都没收集到的情形）；③ 对照成立才判通过：没有真实地址且收集到了候选 = PASS，对照成立而这一次一个候选都没有 = FAIL（探针没跑起来）。
 * 对照本身是前提、只打一行 INFO，不计入通过数（它的 ok 恒为真，计入只会虚增）。ICE 候选的具体个数是作者机器的数值，脚本只断言 real 是否大于 0、不钉个数。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」；启动器 `run.mjs` 自己已清洗宿主注入的环境变量——`launcher-lib.mjs` 的 `cleanEnv`——不必再手写 `env -u …`；第二十五轮评审文档 3：此前三处写了三种写法）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/r21-mic-prompt.cjs --timeout 180
 *
 * 临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 * 三条退出路径（通过 / 断言失败 / 抛错）共用同一个 cleanupAll。
 */
const { app, BrowserWindow, WebContentsView, session, nativeImage, dialog, Menu, clipboard, shell, systemPreferences } = require("electron");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
// S11 要一个「非安全上下文」：http 且主机名不是 localhost / 127.0.0.1 / *.localhost（这些在 Chromium 里都算安全上下文）。
// `.test` 是保留的顶级域，这里只把它映射到本机回环，不碰外网
app.commandLine.appendSwitch("host-resolver-rules", "MAP insecure.test 127.0.0.1");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-r21-")));
app.setPath("userData", path.join(TMP, "userData"));
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
/** 环境不满足而没跑的项：不计入通过，有任何一项就以退出码 4 结束 */
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
/** 轮询直到 fn 返回真值（返回它）或超时（返回 null）；fn 抛错按「还没好」算 */
const waitFor = async (fn, ms = 8000, stepMs = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
};
/** 给一个 promise 加总超时：超时抛错（脚本进 SMOKE ERROR 路径，仍清理） */
const withTimeout = (p, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms} 毫秒）`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};
/** 设备名数组：非空且每项都是空名。空数组不算「名字被隐藏」——那只是没枚举到设备，会让断言空转（R22-4） */
const allEmpty = (a) => Array.isArray(a) && a.length > 0 && a.every((l) => l === "");
/** 设备名数组：非空且每项都有名字 */
const allNamed = (a) => Array.isArray(a) && a.length > 0 && a.every((l) => typeof l === "string" && l !== "");

/** 收尾登记表：main 里一建好就登记，三条退出路径共用 cleanupAll 释放 */
const live = { servers: [], manager: null };

const html = (body) => `<!doctype html><meta charset="utf-8"><title>r21</title><body>${body}</body>`;
/** 起一个返回固定页面的本地 http 服务；headers 可给整站加响应头（S9 的 Permissions-Policy） */
const serve = async (handler, headers = {}) => {
  const server = http.createServer((q, r) => {
    r.setHeader("content-type", "text/html; charset=utf-8");
    for (const [k, v] of Object.entries(headers)) r.setHeader(k, v);
    r.end(handler(q));
  });
  live.servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server.address().port;
};

/**
 * iframe 里的页面：载入后告诉父页「我好了」（顺带报告第一个脚本运行那一刻页内桩在不在）；收到 'stub?' 回报桩现在在不在；
 * 收到 'go' 后 query → getUserMedia → 取设备名，把结果 postMessage 回父页。
 */
const FRAME_PAGE = html(`frame<script>
  const hasStub = () => !!(window.Permissions && Permissions.prototype.query.__fsMediaQueryStub);
  parent.postMessage({ ready: true, stubAtStart: hasStub() }, '*');
  window.addEventListener('message', async (e) => {
    if (e.data === 'stub?') { parent.postMessage({ stub: hasStub() }, '*'); return; }
    if (e.data !== 'go') return;
    const out = {};
    try { out.q = (await navigator.permissions.query({ name: 'microphone' })).state; } catch (e) { out.q = 'ERR ' + e.name; }
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); out.gum = 'ok'; out.audio = s.getAudioTracks().length; s.getTracks().forEach((t) => t.stop()); } catch (e) { out.gum = e.name; }
    try { out.labels = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').map((d) => d.label); } catch (e) { out.labels = 'ERR ' + e.name; }
    parent.postMessage({ out }, '*');
  });
</script>`);

/** 顶层页面里的探测：只读权限状态 / 设备名，不触碰麦克风 */
const QUERY = `(async () => ({
  mic: (await navigator.permissions.query({ name: 'microphone' })).state,
  cam: (await navigator.permissions.query({ name: 'camera' })).state,
}))()`;
const LABELS = `(async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').map((d) => d.label))()`;
const GUM = (media) =>
  `(window.__gum = 'pending', navigator.mediaDevices.getUserMedia(${media}).then((s) => { window.__gum = { ok: true, audio: s.getAudioTracks().length }; s.getTracks().forEach((t) => t.stop()); }, (e) => { window.__gum = { ok: false, name: e.name }; }), 1)`;
/** 页内桩的「形状」体检：标记在、PermissionStatus 的原型 / 属性 / 方法没被破坏、别的权限名与非法名的行为不变 */
const STUB_SHAPE = `(async () => {
  const s = await navigator.permissions.query({ name: 'microphone' });
  const g = await navigator.permissions.query({ name: 'geolocation' });
  let listener = 'no';
  try { s.addEventListener('change', () => {}); s.removeEventListener('change', () => {}); listener = 'ok'; } catch (e) { listener = e.name; }
  const onchangeNull = s.onchange === null;
  // 属性赋值也得走到原生 setter：页面最常见的写法是 status.onchange = fn。代理缺 set 陷阱时 setter 会以「this = 代理」被调用，抛 TypeError（Illegal invocation）
  let onchangeSet = 'no';
  try { const f = () => {}; s.onchange = f; onchangeSet = s.onchange === f ? 'ok' : 'mismatch'; s.onchange = null; } catch (e) { onchangeSet = e.name; }
  return {
    marker: Permissions.prototype.query.__fsMediaQueryStub === true,
    inst: s instanceof PermissionStatus,
    name: s.name,
    listener,
    onchangeNull,
    onchangeSet,
    geoInst: g instanceof PermissionStatus,
    geoState: g.state,
    badName: await navigator.permissions.query({ name: 'no-such-permission' }).then(() => 'resolved', (e) => e.name),
  };
})()`;

/**
 * WebRTC ICE 候选收集（不需要任何媒体权限）。Chromium 对 host 候选的处理：没有 media 权限 → 只给 mDNS 混淆名（xxxx.local）；有 → 给真实地址。
 * 页面主世界里跑，把候选串返回给脚本；脚本只统计类别、**不打印任何原始地址**。
 */
const ICE = `new Promise((resolve) => {
  const cands = [];
  let finished = false;
  const pc = new RTCPeerConnection({ iceServers: [] });
  const done = () => { if (finished) return; finished = true; try { pc.close(); } catch (e) {} resolve(cands); };
  pc.createDataChannel('x');
  pc.onicecandidate = (e) => { if (e.candidate) cands.push(e.candidate.candidate); else done(); };
  pc.createOffer().then((o) => pc.setLocalDescription(o));
  setTimeout(done, 6000);
})`;
const classifyAddress = (addr) => {
  if (/\.local$/i.test(addr)) return "mdns";
  if (/^10\./.test(addr) || /^192\.168\./.test(addr) || /^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return "private-ipv4";
  if (/^169\.254\./.test(addr)) return "link-local-v4";
  if (/^127\./.test(addr)) return "loopback-v4";
  if (/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(addr)) return "public-ipv4";
  if (/^fe80/i.test(addr)) return "link-local-v6";
  if (/^f[cd]/i.test(addr)) return "ula-v6";
  if (/:/.test(addr)) return "ipv6-other";
  return "other";
};
/** 候选串列表 → { total, real, counts }；real = 不是 mDNS 混淆名的候选数（任何真实地址都算泄露）。只返回类别与个数 */
const iceSummary = (cands) => {
  const counts = {};
  let real = 0;
  const list = Array.isArray(cands) ? cands : [];
  for (const c of list) {
    const parts = String(c).split(" ");
    const typ = parts[parts.indexOf("typ") + 1] || "?";
    const kind = classifyAddress(parts[4] || "");
    if (kind !== "mdns") real++;
    counts[`${typ}:${kind}`] = (counts[`${typ}:${kind}`] || 0) + 1;
  }
  return { total: list.length, real, counts };
};
/**
 * 链路本地地址（IPv4 169.254.0.0/16、IPv6 fe80::/10）：macOS 上的 awdl0 / llw0 / utun* 等常驻网卡几乎总带这类地址。这里**假定**它们通常不会出现在 WebRTC 的 host 候选里、因此不算「有真实地址可泄露」
 * ——这是假设，不是在仓库里验证过的结论（第二十五轮评审文档 8）：作者机器上 S5 对照出现的候选只有私网 / 公网 IPv4 两类、没有链路本地类别（见 iceSummary 的类别计数），所以按此处理；
 * 要是别的环境的候选里出现了链路本地类别，类别计数会如实打出来，届时这个假设需要改。计入的后果是：没网的机器也被误判成探针有判别力（第二十四轮 P3-6）
 */
const isLinkLocalAddress = (address) => /^169\.254\./.test(String(address)) || /^fe[89ab][0-9a-f]:/i.test(String(address));
/** 本机有没有可能出现在 ICE 候选里的非回环地址：没有就没有真实地址可泄露，ICE 断言没有判别力（跳过并以退出码 4 结束） */
const nicInfo = () => {
  let v4 = 0;
  let v6 = 0;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (!a || a.internal || isLinkLocalAddress(a.address)) continue;
      if (a.family === "IPv4" || a.family === 4) v4++;
      else v6++;
    }
  }
  return { v4, v6, any: v4 + v6 > 0 };
};

const main = async () => {
  await app.whenReady();
  console.log(`SMOKE INFO platform=${process.platform} arch=${process.arch} electron=${process.versions.electron} chrome=${process.versions.chrome}（证据仅取自 macOS / Electron 42.4.0 / Chrome 148）`);
  const nic = nicInfo();
  console.log(`SMOKE INFO 本机非回环网卡地址：IPv4 ${nic.v4} 个、IPv6 ${nic.v6} 个（${nic.any ? "ICE 断言有判别力" : "没有——ICE 断言会被跳过"}；不打印地址）`);

  // ── fixture ──
  const framePort = await serve(() => FRAME_PAGE);
  const topPage = (frameHost, allow) =>
    html(`top<iframe id="x" ${allow ? `allow="${allow}"` : ""} src="http://${frameHost}:${framePort}/"></iframe>
      <script>window.addEventListener('message', (e) => {
        if (!e.data) return;
        if (e.data.ready) { window.__frameReady = true; window.__frameStubAtStart = e.data.stubAtStart; }
        if (e.data.stub !== undefined) window.__frameStub = e.data.stub;
        if (e.data.out) window.__frameRes = e.data.out;
      });</script>`);
  const p1 = await serve(() => html("s1 top-level<script>window.__stubAtStart = !!(window.Permissions && Permissions.prototype.query.__fsMediaQueryStub);</script>"));
  const p2 = await serve(() => topPage("localhost", "microphone; camera")); // 127.0.0.1 → localhost：跨站（OOPIF）+ 委托
  const p3 = await serve(() => topPage("cw.a.localhost", "microphone; camera")); // app.a.localhost → cw.a.localhost：同站跨源（同进程）+ 委托
  const p4 = await serve(() => topPage("localhost", "")); // 跨站、没有 allow
  const p5 = await serve(() => html("s5 ai grant"));
  const p6 = await serve(() => topPage("localhost", "microphone http://other.invalid:1")); // allow 的 origin 列表不含该 iframe
  const p7 = await serve(() => topPage("localhost", "microphone *")); // allow 通配：委托了
  const p8 = await serve(() => html("s8 cancel on navigation"));
  const p9 = await serve(() => html("s9 policy blocked"), { "Permissions-Policy": "microphone=()" });
  // S10：opener 页面里一个按钮（AI 点击 = 真实手势）→ window.open 开出弹窗，弹窗被收养成同会话的 tab；弹窗页自己记第一个脚本运行时桩在不在
  const pPopup = await serve(() => html("s10 popup<script>window.__stubAtStart = !!(window.Permissions && Permissions.prototype.query.__fsMediaQueryStub);</script>"));
  const p10 = await serve(() => html(`s10 opener<button id="open" aria-label="打开弹窗" onclick="window.__pop = window.open('http://127.0.0.1:${pPopup}/', 'pop'); window.__popRet = window.__pop ? 'win' : 'null'">打开弹窗</button>`));
  const p11 = await serve(() => html("s11 insecure context"));
  const urlS1 = `http://127.0.0.1:${p1}/`;
  const urlS2 = `http://127.0.0.1:${p2}/`;
  const urlS3 = `http://app.a.localhost:${p3}/`;
  const urlS4 = `http://127.0.0.1:${p4}/`;
  const urlS5 = `http://127.0.0.1:${p5}/`;
  const urlS6 = `http://127.0.0.1:${p6}/`;
  const urlS7 = `http://127.0.0.1:${p7}/`;
  const urlS8 = `http://127.0.0.1:${p8}/`;
  const urlS9 = `http://127.0.0.1:${p9}/`;
  const urlS10 = `http://127.0.0.1:${p10}/`;
  const urlS11 = `http://insecure.test:${p11}/`;

  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);
  const appOrigin = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/app-origin.mjs")).href);
  const mainWin = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
  await withTimeout(mainWin.loadURL("about:blank"), 15000, "mainWin.loadURL(about:blank)");
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
    // 系统层授权状态：与 main.js 的接线一致（弹提示时读一次；本机已是 granted 时提示里不会多出「系统层已拒绝」那一行）
    systemPreferences,
    getMainWindow: () => (mainWin.isDestroyed() ? null : mainWin),
    isAppUrl: appOrigin.createIsAppUrl(() => 1),
    isTrustedIpcSender: () => true,
    log: () => {},
  });
  live.manager = manager;
  manager.registerIpc();
  manager.onConfig({ evaluateEnabled: true, pagePermissions: false });
  const T = "r21-task";
  const call = (op, args = {}) => withTimeout(manager.dispatch(op, args, { taskId: T }), 30000, `dispatch(${op})`);
  const ev = async (expr) => (await call("evaluate", { expression: expr })).value;
  const sess = () => manager.getSession(T);
  const prompts = () => sess().prompts.list().filter((p) => p.kind === "permission");
  const waitPrompt = (ms = 6000) => waitFor(() => prompts()[0], ms);
  const gumResult = () => waitFor(async () => {
    const v = await ev("window.__gum");
    return v !== "pending" ? v : null;
  }, 10000);
  const list = () => call("permissions", { action: "list" });
  const permLog = () => sess().activityLog.list().filter((e) => e.kind === "permission").map((e) => e.summary);
  const open = async (url) => {
    await call("navigate", { url });
    await waitFor(async () => (await ev("document.readyState")) === "complete", 8000);
  };
  const iceProbe = async () => iceSummary(await ev(ICE));
  /**
   * 载入 iframe 页面并等它里面的页内桩就位，返回 { ready, stub, stubAtStart }。
   * 桩的装法：同进程的 iframe 靠主会话的「新文档脚本」，文档一开始就在；跨站 iframe（OOPIF）走子会话钩子——
   * 第二十三轮起这个钩子是「早钩子」：与 5 个域的 enable（Page / Runtime / DOM / Network / Log）和 Emulation.setFocusEmulationEnabled 并行发出、先于 setAutoAttach 与页面脚本（此前排在子会话初始化的最后几步里，
   * 比 iframe 文档的第一个脚本晚 4.5~27.5 毫秒；改后在作者机器上连续 3 轮、每轮 8 次跨站 OOPIF，共 24/24 次第一个脚本运行时桩已就位——样本很小，是缩小窗口、不是保证，见 stubAtStart 的 INFO 行）。
   * 所以仍要先等桩就位再让页面 query，否则「桩还没装上」会被当成「桩判了 denied」（S4 / S6 的 denied 就失去意义）。
   */
  const loadFrame = async (tag, url) => {
    await open(url);
    const ready = await waitFor(() => ev("window.__frameReady === true"), 8000);
    const stubAtStart = await ev("window.__frameStubAtStart");
    const stub = await waitFor(async () => {
      await ev(`(window.__frameStub = undefined, document.getElementById('x').contentWindow.postMessage('stub?', '*'), 1)`);
      await sleep(60);
      return (await ev("window.__frameStub")) === true;
    }, 4000, 20);
    console.log(`SMOKE INFO ${tag} iframe 文档的第一个脚本运行时页内桩${stubAtStart === true ? "已就位" : "还没就位"}；之后${stub ? "装上了" : "一直没装上"}`);
    check(`r21-${tag}-frame-ready`, `${tag} iframe 载入完成（环境前提）`, !!ready, ready);
    check(`r21-${tag}-stub-installed`, `${tag} 页内桩已装进该 iframe 的主世界（同进程靠新文档脚本，OOPIF 靠子会话钩子）`, !!stub, { stub: !!stub, stubAtStart });
    return { ready: !!ready, stub: !!stub, stubAtStart };
  };
  const go = () => ev(`(window.__frameRes = undefined, document.getElementById('x').contentWindow.postMessage('go', '*'), 1)`);

  const micOs = systemPreferences.getMediaAccessStatus("microphone");
  const canAllow = micOs === "granted";
  console.log(`SMOKE INFO 系统层麦克风授权状态=${micOs}（${canAllow ? "跑「允许」路径（假设备）" : "不是 granted：为免在本机弹系统授权框，「允许」路径跳过（SKIP，结果记为 INCOMPLETE、退出码 4）、走拒绝路径"}）`);

  // ───────── S1 顶层页面 ─────────
  await handlers.get("browser:newTab")({}, T, urlS1);
  await waitFor(async () => (await ev("document.readyState")) === "complete", 8000);
  const stubAtStartTop = await ev("window.__stubAtStart");
  check("r21-stub-at-start-top", "S1 顶层文档（含新标签的第一个文档）自己的第一个脚本运行时，页内桩已经就位（顶层没有「桩晚于页面脚本」的竞态）", stubAtStartTop === true, stubAtStartTop);
  const shape = await ev(STUB_SHAPE);
  check("r21-stub-installed", "S1 页内 permissions.query 桩已装进页面主世界（Permissions.prototype.query 带标记）", !!shape && shape.marker === true, shape);
  check(
    "r21-stub-shape",
    "S1 桩没破坏 API 形状：query 结果仍是 PermissionStatus（instanceof / name 非空——Chromium 对麦克风报的是 audio_capture，不钉字面）、addEventListener 可用、onchange 初值 null 且赋值能读回（status.onchange = fn，缺 set 陷阱会 Illegal invocation），别的权限名照常，非法名仍抛 TypeError",
    !!shape && shape.inst === true && typeof shape.name === "string" && shape.name !== "" && shape.listener === "ok" && shape.onchangeNull === true && shape.onchangeSet === "ok" && shape.geoInst === true && ["granted", "denied", "prompt"].includes(shape.geoState) && shape.badName === "TypeError",
    shape,
  );
  const q0 = await ev(QUERY);
  check("r21-query-prompt", "S1 用户还没决定时，permissions.query 对麦克风 / 摄像头读到 prompt（不是 denied：先 query 的页面会去请求；也不是 granted）", q0.mic === "prompt" && q0.cam === "prompt", q0);
  const labels0 = await ev(LABELS);
  check("r21-labels-hidden-before", "S1 授予之前设备名仍是空名（enumerateDevices 形状的检查不放宽；设备列表非空，不是空转）", allEmpty(labels0), labels0);
  /**
   * ICE 的「没有真实地址」要等 S5 的对照出来才能判：对照里授予后也没出现真实地址 = 这台机器上探针根本看不见真实地址，
   * 「只有 mDNS 名 / 没有候选」说明不了什么（R23-7：以前先判、对照失败时这两条已经是 PASS 了）。这里只采样，S5 之后统一判（judgeIce）。
   */
  const iceNoLeak = [];
  if (nic.any) {
    iceNoLeak.push({
      id: "r21-ice-no-leak-ask",
      name: "S1 待询问状态下 WebRTC 的 ICE 候选只有 mDNS 名、没有任何真实地址（第二十一轮第一版在这里泄露：4 个内网 + 2 个公网 IPv4）",
      sum: await iceProbe(),
    });
  } else {
    skip("r21-ice-no-leak-ask", "S1 ICE 候选泄露检查", "本机没有非回环网卡，没有真实地址可泄露，探针无判别力");
  }
  check("r21-no-prompt-from-query", "S1 查权限状态 / 枚举设备 / 收集 ICE 候选不会弹提示", prompts().length === 0, prompts());

  await ev(GUM("{ audio: true }"));
  const pr1 = await waitPrompt();
  check(
    "r21-gum-prompt",
    "S1 读到 prompt 之后 getUserMedia({audio}) → 面板弹 permission 提示（只问麦克风；host 是 127.0.0.1）",
    !!pr1 && pr1.detail.permission === "microphone" && /127\.0\.0\.1/.test(pr1.host) && pr1.actions[0] === "deny",
    pr1 && { detail: pr1.detail, host: pr1.host, actions: pr1.actions },
  );
  if (pr1) sess().prompts.answer(pr1.id, { action: "deny" });
  const g1 = await gumResult();
  check("r21-gum-denied", "S1 用户拒绝 → getUserMedia 被拒（NotAllowedError）", !!g1 && g1.ok === false && g1.name === "NotAllowedError", g1);
  const q1 = await ev(QUERY);
  // 已知限制：浏览器自己的检查回 false → 页面读到 denied → 桩把它改成 prompt；桩看不到「刚被拒绝（冷却）」这个态，所以冷却期读到的仍是 prompt，
  // 页面再 getUserMedia 会被直接拒绝（不弹提示，见下面 r21-cooldown-no-reprompt）。关键是不能读到 granted。
  check("r21-query-in-cooldown", "S1 刚被拒绝（冷却期）：query 读到 prompt（已知限制：桩看不到冷却态；绝不能是 granted）", q1.mic === "prompt" && q1.cam === "prompt", q1);
  if (nic.any) {
    iceNoLeak.push({ id: "r21-ice-no-leak-cooldown", name: "S1 冷却期（被拒绝之后）ICE 候选仍然只有 mDNS 名", sum: await iceProbe() });
  } else {
    skip("r21-ice-no-leak-cooldown", "S1 冷却期 ICE 候选泄露检查", "本机没有非回环网卡");
  }
  await ev(GUM("{ audio: true }"));
  const g1b = await gumResult();
  check("r21-cooldown-no-reprompt", "S1 冷却期内页面再请求：不重复弹提示，直接 NotAllowedError", !!g1b && g1b.ok === false && g1b.name === "NotAllowedError" && prompts().length === 0, { g1b, prompts: prompts().length });
  const l1 = await list();
  check(
    "r21-cooldown-recorded",
    "S1 冷却里的拒绝可见：permissions list 的 recentBlocked 里有 cooldown，活动记录里有说明",
    Array.isArray(l1.recentBlocked) && l1.recentBlocked.some((e) => e.reason === "cooldown" && e.permission === "microphone") && permLog().some((s) => /30 秒内同一标签页上的该站点不再重复弹提示/.test(s)),
    { recentBlocked: l1.recentBlocked, log: permLog().slice(-3) },
  );

  // ───────── S2 / S3 / S7：被顶层委托的跨源 iframe ─────────
  /**
   * 跨源 iframe 要麦克风：提示 → 回答。allow = true 且系统层麦克风已授权时走「本会话一直允许」，否则走拒绝。
   * @param {string} tag
   * @param {string} url 顶层页面
   * @param {string} topHost 顶层 host（含端口）
   * @param {string} frameOrigin 嵌入框架的 origin
   * @param {boolean} allowPath 是否尝试「允许」路径（S7 只走拒绝）
   */
  const frameScenario = async (tag, url, topHost, frameOrigin, allowPath = true) => {
    await loadFrame(tag, url);
    await go();
    const pr = await waitPrompt();
    const topOrigin = new URL(url).origin;
    check(
      `r21-${tag}-prompt`,
      `${tag} 被委托的跨源 iframe 要麦克风 → 面板弹提示：detail.origin = 顶层站点、detail.frame = 实际发起的嵌入页面、host = 顶层 host（此前静默拒绝、没有提示）`,
      !!pr && pr.detail.permission === "microphone" && pr.detail.origin === topOrigin && pr.detail.frame === frameOrigin && pr.host === topHost,
      pr && { detail: pr.detail, host: pr.host },
    );
    if (!pr) return;
    const doAllow = allowPath && canAllow;
    sess().prompts.answer(pr.id, { action: doAllow ? "allow-session" : "deny" });
    const res = await waitFor(() => ev("window.__frameRes"), 10000);
    // 页面在用户决定之前读到的状态（FRAME_PAGE 先 query 再 getUserMedia）：prompt = 页内桩在该框架里生效了（OOPIF 走子会话钩子，同进程跨源靠主会话的新文档脚本）
    check(`r21-${tag}-query-prompt`, `${tag} iframe 里 permissions.query 在用户决定之前读到 prompt（页内桩在该框架里生效）`, !!res && res.q === "prompt", res);
    if (doAllow) {
      check(`r21-${tag}-allowed`, `${tag} 用户「本会话一直允许」→ iframe 里 getUserMedia 成功（假设备）`, !!res && res.gum === "ok" && res.audio === 1, res);
      check(`r21-${tag}-labels-hidden`, `${tag} 即使已允许，嵌入框架里设备名仍是空名（设备名只给顶层自己的框架）`, !!res && allEmpty(res.labels), res && res.labels);
      const l = await list();
      const mine = (l.grants ?? []).filter((g) => g.permission === "microphone");
      check(
        `r21-${tag}-grant-on-top`,
        `${tag} 授予记在顶层站点上（不是嵌入框架的 origin）`,
        mine.some((g) => g.origin === topOrigin && g.decision === "allow" && g.source === "user") && !mine.some((g) => g.origin === frameOrigin),
        mine,
      );
      await go();
      const again = await waitFor(() => ev("window.__frameRes"), 10000);
      check(`r21-${tag}-no-reprompt`, `${tag} 之后 iframe 再要麦克风：不再弹提示、直接成功`, !!again && again.gum === "ok" && prompts().length === 0, { again, prompts: prompts().length });
    } else {
      check(`r21-${tag}-denied`, `${tag} 用户拒绝 → iframe 里 getUserMedia 被拒（NotAllowedError）`, !!res && res.gum === "NotAllowedError", res);
      if (allowPath) {
        // 本该走「允许」路径、因为系统层麦克风授权不是 granted 而退回拒绝——这些项没跑，明说
        for (const suffix of ["allowed", "labels-hidden", "grant-on-top", "no-reprompt"]) {
          skip(`r21-${tag}-${suffix}`, `${tag}「允许」路径的断言（${suffix}）`, `系统层麦克风授权是 ${micOs}，不是 granted`);
        }
      }
    }
  };
  await frameScenario("s2", urlS2, `127.0.0.1:${p2}`, `http://localhost:${framePort}`);
  await frameScenario("s3", urlS3, `app.a.localhost:${p3}`, `http://cw.a.localhost:${framePort}`);

  // ───────── S4 没有 allow 的跨站 iframe ─────────
  await loadFrame("s4", urlS4);
  await go();
  const res4 = await waitFor(() => ev("window.__frameRes"), 10000);
  check("r21-s4-no-prompt", "S4 没有 allow 属性的跨站 iframe：不弹提示", prompts().length === 0, prompts());
  check("r21-s4-query-denied", "S4 没有委托的 iframe 里 query 仍读到 denied（政策不允许就不能被桩改成 prompt）", !!res4 && res4.q === "denied", res4);
  check("r21-s4-denied", "S4 没有委托的 iframe 拿不到流（NotAllowedError）", !!res4 && res4.gum === "NotAllowedError", res4);
  const l4 = await list();
  const blocked4 = (l4.recentBlocked ?? []).find((e) => e.reason === "frame-not-delegated");
  check(
    "r21-s4-recorded",
    "S4 被拒原因可见：recentBlocked 里是 frame-not-delegated（来源 = 顶层、frameOrigin = 嵌入页面），活动记录里有「未弹提示」说明",
    !!blocked4 && blocked4.origin === new URL(urlS4).origin && blocked4.frameOrigin === `http://localhost:${framePort}` && permLog().some((s) => /未弹提示/.test(s) && /委托/.test(s)),
    { blocked4, log: permLog().slice(-2) },
  );

  // ───────── S5 AI 授予 ─────────
  manager.onConfig({ pagePermissions: true });
  await open(urlS5);
  const qb = await ev(QUERY);
  check("r21-s5-query-before", "S5 AI 授予之前 query 读到 prompt（对照：授予后变 granted，证明 granted 不是「待询问」时的默认读数）", qb.mic === "prompt" && qb.cam === "prompt", qb);
  // 授予前先拿一个 PermissionStatus 对象留着：授予之后看它的 state 变不变（只记录、不断言——这是 Chromium / Electron 的行为，不是 Flowship 的契约）
  await ev(`(async () => { window.__oldStatus = await navigator.permissions.query({ name: 'microphone' }); return 1; })()`);
  const gr = await call("permissions", { action: "grant", permission: "microphone" });
  check("r21-s5-grant", "S5 AI grant microphone 生效（授予记在当前页面 origin 上）", gr.action === "grant" && gr.origin === new URL(urlS5).origin, gr);
  const oldRightAfterGrant = await ev("window.__oldStatus ? window.__oldStatus.state : 'none'");
  const qa = await ev(QUERY);
  check("r21-s5-query", "S5 AI 授予麦克风之后 query(microphone) = granted（此前是 prompt）、摄像头仍是 prompt（授予只覆盖麦克风）", qa.mic === "granted" && qa.cam === "prompt", qa);
  // 授予之后旧对象会不会变（只记录、不断言——这是 Chromium / Electron 的行为，不是 Flowship 的契约）：
  // 42.4.0 实测没有权限变化通知——授予之后旧对象不会自己更新、change 事件不触发，但页面再 query() 一次之后旧对象也读到新值（没有事件）；没有桩的 geolocation 同样，不是桩造成的。
  // 上面的 oldRightAfterGrant 是授予后、再 query 之前读的；这里是一次新 query（上一行 QUERY）之后读的，两者不同并不矛盾。
  const oldAfterQuery = await ev("window.__oldStatus ? window.__oldStatus.state : 'none'");
  console.log(`SMOKE INFO S5 授予前拿到的 PermissionStatus 对象：授予后、再 query 之前 state=${JSON.stringify(oldRightAfterGrant)}；一次新 query 之后 state=${JSON.stringify(oldAfterQuery)}（只记录、不断言；42.4.0 实测前者不更新、后者更新，都没有 change 事件）`);
  /**
   * 对照（前提，不是断言）：麦克风已授予时 ICE 候选里要出现真实地址，探针才有判别力。没出现 = 记 SKIP（不是失败：这是本机网络 / Chromium 的事，泄露本身由各「不泄露」断言判）；
   * 出现了 = 只打一行 INFO，**不再记一条 check**——它的 ok 参数恒为真，计进「N/N 通过」只会虚增通过数（第二十四轮 P3-6）。
   */
  let iceControlOk = false;
  if (nic.any) {
    const iceG = await iceProbe();
    iceControlOk = iceG.real > 0;
    if (!iceControlOk) {
      skip("r21-s5-ice-control", "S5 ICE 对照", { reason: "授予后 ICE 候选里也没出现真实地址：这台机器上探针看不见真实地址（网卡不可路由 / Chromium 行为变了），所有 ICE「不泄露」断言一并跳过", iceG });
    } else {
      console.log(`SMOKE INFO S5 ICE 对照成立（前提、不计入通过数）：麦克风已授予时 ICE 候选里出现了真实地址——Chromium 有 media 权限就不再用 mDNS 隐藏本机 IP，ICE「不泄露」断言因此有判别力 ${JSON.stringify(iceG)}`);
    }
  } else {
    skip("r21-s5-ice-control", "S5 ICE 对照", "本机没有（链路本地以外的）非回环网卡地址");
  }
  /**
   * 一条「ICE 没有泄露」断言的判定（顺序有讲究）：
   *  ① 已经看见真实地址 = 泄露，无论对照如何都是失败；
   *  ② 对照没有判别力 = 跳过（含这次一个候选都没收集到——断网时探针什么也看不见，不能判失败；「只有 mDNS 名 / 没有候选」也说明不了什么）；
   *  ③ 对照成立：干净（没有真实地址）**且**收集到了候选才算通过；对照成立却一个候选都没有 = 探针这一次没跑起来，不能当「没泄露」。
   */
  const judgeIce = (id, name, sum) => {
    if (sum.real > 0) {
      check(id, name, false, sum);
      return;
    }
    if (!iceControlOk) {
      skip(id, name, "对照（授予后）也没出现真实地址：探针在这台机器上没有判别力，「只有 mDNS 名 / 没有候选」说明不了什么");
      return;
    }
    check(id, name, sum.total > 0, sum);
  };
  for (const e of iceNoLeak) judgeIce(e.id, e.name, e.sum);
  if (canAllow) {
    await ev(GUM("{ audio: true }"));
    const ga = await gumResult();
    check("r21-s5-gum-no-prompt", "S5 AI 授予之后页面 getUserMedia 免提示、直接成功（让 AI 帮忙操作的路径）", !!ga && ga.ok === true && ga.audio === 1 && prompts().length === 0, { ga, prompts: prompts().length });
    const la = await ev(LABELS);
    check("r21-s5-labels", "S5 AI 授予之后麦克风设备名可见", allNamed(la), la);
  } else {
    skip("r21-s5-gum-no-prompt", "S5 AI 授予之后 getUserMedia 免提示取流", `系统层麦克风授权是 ${micOs}，不是 granted（避免弹系统授权框）`);
    skip("r21-s5-labels", "S5 AI 授予之后麦克风设备名可见", `系统层麦克风授权是 ${micOs}，不是 granted`);
  }
  await call("permissions", { action: "reset", permission: "microphone" });
  const lr = await ev(LABELS);
  check("r21-s5-reset", "S5 reset 之后设备名又隐藏（授予被清掉；设备列表非空，不是空转）", allEmpty(lr), lr);
  const qr = await ev(QUERY);
  check("r21-s5-query-after-reset", "S5 reset 之后 query 回到 prompt", qr.mic === "prompt" && qr.cam === "prompt", qr);
  if (nic.any) {
    judgeIce("r21-s5-ice-after-reset", "S5 reset 之后 ICE 候选又只有 mDNS 名（撤销授权会重新隐藏本机 IP）", await iceProbe());
  } else {
    skip("r21-s5-ice-after-reset", "S5 reset 之后 ICE 候选", "本机没有非回环网卡");
  }
  manager.onConfig({ pagePermissions: false });

  // ───────── S6 allow 的 origin 列表不含该 iframe ─────────
  await loadFrame("s6", urlS6);
  await go();
  const res6 = await waitFor(() => ev("window.__frameRes"), 10000);
  check("r21-s6-no-prompt", "S6 allow=\"microphone http://other.invalid:1\"（列表里没有该 iframe）：不弹提示", prompts().length === 0, prompts());
  check("r21-s6-query-denied", "S6 没被委托：iframe 里 query 读到 denied", !!res6 && res6.q === "denied", res6);
  check("r21-s6-denied", "S6 iframe 里 getUserMedia 被拒（NotAllowedError）", !!res6 && res6.gum === "NotAllowedError", res6);
  const l6 = await list();
  const blocked6 = (l6.recentBlocked ?? []).find((e) => e.reason === "frame-not-delegated" && e.origin === new URL(urlS6).origin);
  check("r21-s6-recorded", "S6 被拒原因可见：recentBlocked 里有这个顶层来源的 frame-not-delegated", !!blocked6 && blocked6.frameOrigin === `http://localhost:${framePort}`, blocked6);

  // ───────── S7 allow="microphone *" ─────────
  await frameScenario("s7", urlS7, `127.0.0.1:${p7}`, `http://localhost:${framePort}`, false);

  // ───────── S8 提示还挂着时页面导航走 ─────────
  await open(urlS8);
  await ev(GUM("{ audio: true }"));
  const pc1 = await waitPrompt();
  check("r21-s8-prompt", "S8 getUserMedia → 弹提示", !!pc1 && pc1.detail.permission === "microphone", pc1 && pc1.detail);
  await open(`${urlS8}?second`); // 主框架非同文档导航：挂着的提示应被取消
  const gone = await waitFor(() => prompts().length === 0, 4000);
  check("r21-s8-cancelled", "S8 页面导航走之后，挂着的提示被取消（提示条不会留着一条对不上页面的提示）", !!gone && !prompts().some((p) => pc1 && p.id === pc1.id), prompts());
  await ev(GUM("{ audio: true }"));
  const pc2 = await waitPrompt();
  const l8 = await list();
  check(
    "r21-s8-no-cooldown",
    "S8 提示是被「取消」的、不是被「拒绝」的：不进 30 秒冷却——页面再请求会重新弹提示，清单里没有 cooldown，活动记录写「已取消…不算拒绝」",
    !!pc2 && (!pc1 || pc2.id !== pc1.id) && !(l8.recentBlocked ?? []).some((e) => e.reason === "cooldown" && e.origin === new URL(urlS8).origin) && permLog().some((s) => /权限提示已取消/.test(s) && /不算拒绝/.test(s)),
    { prompt: pc2 && pc2.detail, recentBlocked: l8.recentBlocked, log: permLog().slice(-2) },
  );
  if (pc2) sess().prompts.answer(pc2.id, { action: "deny" });
  await gumResult();

  // ───────── S9 顶层文档的 Permissions-Policy 禁了麦克风 ─────────
  await open(urlS9);
  const q9 = await ev(QUERY);
  check("r21-s9-policy-blocked", "S9 响应头 Permissions-Policy: microphone=()：麦克风 query 保持 denied（桩尊重政策、不改成 prompt），摄像头不受影响（prompt）", q9.mic === "denied" && q9.cam === "prompt", q9);

  // ───────── S10 window.open 开出的弹窗（被收养成同会话的 tab）：弹窗的主页面也要有桩（第二十四轮 R24-1）─────────
  // 收养的弹窗不用先 loadURL，BrowserTab 的构造函数里就同步跑完了会话初始化的第一步（早钩子那一批）；而权限闸登记钩子在 `new BrowserTab()` 返回之后——
  // 第二十三轮把桩只注册成早钩子，弹窗主页面因此装不上桩：页面读到 denied、不发请求，权限闸里也没有任何记录。
  await open(urlS10);
  const tabsOf = async () => (await call("tabs", { action: "list" })).tabs;
  const openerTabId = (await call("tabs", { action: "list" })).activeTabId;
  /** AI 点击 opener 页面里的按钮（真实手势）→ 等新的弹窗 tab 出现；没点成 / 没开出来返回 null */
  const openPopup = async () => {
    sess().pageTabTimes.clear(); // 页面开 tab 的限流（每个 opener 10 秒内 ≤ 3 个）别误伤连开几个；不用可选链：字段改名时让脚本抛错（SMOKE ERROR），而不是静默变成不清
    const before = new Set((await tabsOf()).map((t) => t.id));
    const snap = await call("snapshot", { tabId: openerTabId });
    const ref = (/\[ref=(e\d+)\]/.exec(String(snap.text).split("\n").find((l) => l.includes("打开弹窗")) ?? "") ?? [])[1];
    if (!ref) return null;
    await call("click", { ref, tabId: openerTabId });
    return (await waitFor(async () => (await tabsOf()).find((t) => !before.has(t.id)), 6000)) ?? null;
  };
  const pop10 = await openPopup();
  const popObj = pop10 ? sess().getTab(pop10.id) : null;
  check("r21-s10-popup-adopted", "S10 AI 点击 → window.open 开出的弹窗被收养成同会话的 tab（popup = true、opener 是点击的那个 tab）", !!popObj && popObj.popup === true && popObj.opener === openerTabId, { pop: popObj && { popup: popObj.popup, opener: popObj.opener } });
  if (pop10) {
    const evP = async (expr) => (await call("evaluate", { expression: expr, tabId: pop10.id })).value;
    await waitFor(async () => (await evP("document.readyState")) === "complete", 8000);
    const popStub = await waitFor(async () => (await evP("!!(window.Permissions && Permissions.prototype.query.__fsMediaQueryStub)")) === true, 4000, 50);
    const stubAtStart10 = await evP("window.__stubAtStart");
    check("r21-s10-stub-installed", "S10 弹窗的主页面里页内桩已装上（弹窗是 BrowserTab 构造期间就初始化的，早钩子赶在权限闸登记之前就跑完了——钩子要能补上）", !!popStub, { popStub: !!popStub, stubAtStart: stubAtStart10 });
    const q10 = await evP(QUERY);
    check("r21-s10-query-prompt", "S10 弹窗里 permissions.query 读到 prompt（桩没装上就是 denied、页面不发请求，还没有任何记录）", q10.mic === "prompt" && q10.cam === "prompt", q10);
    await evP(GUM("{ audio: true }"));
    const pr10 = await waitFor(() => prompts().find((p) => p.tabId === pop10.id), 6000);
    check("r21-s10-gum-prompt", "S10 弹窗里 getUserMedia({audio}) → 面板弹 permission 提示（提示属于弹窗这个 tab，只问麦克风）", !!pr10 && pr10.detail.permission === "microphone", pr10 && { tabId: pr10.tabId, detail: pr10.detail });
    if (pr10) sess().prompts.answer(pr10.id, { action: "deny" });
    const g10 = await waitFor(async () => {
      const v = await evP("window.__gum");
      return v !== "pending" ? v : null;
    }, 10000);
    check("r21-s10-denied", "S10 弹窗里用户拒绝 → getUserMedia 被拒（NotAllowedError）", !!g10 && g10.ok === false && g10.name === "NotAllowedError", g10);
    await call("tabs", { action: "close", tabId: pop10.id });
    await call("tabs", { action: "select", tabId: openerTabId });
    // 只记录、不断言：弹窗文档的第一个脚本运行时桩在不在（每次采样一个新弹窗）。收养的弹窗里 Chromium 先发起初始导航，桩要等 tab 构造返回、钩子补课发出命令，窗口大小没有保证；
    // 作者机器（macOS / Electron 42.4.0，本地 http fixture）连续 4 遍运行、每遍 5 个弹窗共 20/20 次桩先于第一个脚本就位（前 3 遍 15/15、最后一遍 5/5）——样本量很小、fixture 没有网络延迟，别的环境不保证，页面更早读 permissions.query 仍可能读到 denied
    const samples = [stubAtStart10 === true];
    for (let i = 0; i < 4; i++) {
      const p = await openPopup();
      if (!p) break;
      await waitFor(async () => (await call("evaluate", { expression: "document.readyState", tabId: p.id })).value === "complete", 8000);
      samples.push((await call("evaluate", { expression: "window.__stubAtStart", tabId: p.id })).value === true);
      await call("tabs", { action: "close", tabId: p.id });
      await call("tabs", { action: "select", tabId: openerTabId });
    }
    console.log(`SMOKE INFO S10 弹窗文档的第一个脚本运行时页内桩已就位：${samples.filter(Boolean).length}/${samples.length} 次（只记录、不断言：窗口大小没有保证，样本量很小）`);
  } else {
    // 弹窗没开出来（点击没生效 / 被拦）：后面四项没法判，按失败记（环境前提不是「可以跳过」的那种）
    for (const id of ["r21-s10-stub-installed", "r21-s10-query-prompt", "r21-s10-gum-prompt", "r21-s10-denied"]) check(id, `S10 ${id}（弹窗没开出来，没法判）`, false, { pop: null });
  }

  // ───────── S11 非安全上下文（http、主机名不是 localhost / 127.0.0.1）：桩不改 denied（R23-2 的 isSecureContext 判断，此前只在单测里验过）─────────
  // 按规范（Secure Contexts）与 Chromium 的行为，非安全上下文里 `navigator.mediaDevices` 是 undefined、getUserMedia 无从调起；让页面读到 prompt 只会让它去调不存在的 API 抛 TypeError，比读到 denied 更难排查。
  // 这一点本脚本不据此断言（第二十五轮评审文档 7：仓库里原先没有证据）：只把页面里实际观察到的 `typeof navigator.mediaDevices` 打成 INFO、放进断言的 detail。
  // 前提也核实：导航真的落在 insecure.test、isSecureContext 真的是 false——否则 SKIP（映射没生效 / 导航没落在那里）
  await open(urlS11);
  const where11 = await ev("({ host: location.hostname, secure: window.isSecureContext, mediaDevices: typeof navigator.mediaDevices })");
  const secure11 = where11.secure;
  if (where11.host !== "insecure.test" || secure11 !== false) {
    skip("r21-s11-insecure-denied", "S11 非安全上下文里桩不改 denied", `这台机器上没造出非安全上下文（落在 ${JSON.stringify(where11.host)}、isSecureContext=${JSON.stringify(secure11)}）`);
  } else {
    const stub11 = await ev("!!(window.Permissions && Permissions.prototype.query.__fsMediaQueryStub)");
    const q11 = await ev(`(async () => { try { return (await navigator.permissions.query({ name: 'microphone' })).state; } catch (e) { return 'ERR ' + e.name; } })()`);
    console.log(`SMOKE INFO S11 非安全上下文里 typeof navigator.mediaDevices = ${JSON.stringify(where11.mediaDevices)}（只记录、不断言）`);
    check("r21-s11-insecure-denied", "S11 非安全上下文（落在 insecure.test、isSecureContext = false）：桩已装、但麦克风 query 仍读到 denied（不改成 prompt）", stub11 === true && q11 === "denied", { where11, stub11, q11 });
  }

  // ───────── S12 文档解析期就请求麦克风（第二十五轮 N-1）─────────
  // S1–S11 都是页面加载完成之后才请求。`did-navigate`（第二十四轮 P3-3）里新加了 `cancelMine()`：导航提交时取消本 tab 上挂着的提示——
  // 而「`<head>` 里的内联脚本一解析就请求」的页面，请求可能恰好发生在提交前后。这里确认：提示照常弹出、不被这次提交取消（主信号 = 400 毫秒后提示仍挂着；没有取消类活动记录 / 被拒记录只是辅助：
  // 取消日志与 overflow 共用限速器、每 60 秒只写一条，S8 之后一分钟内的取消不会再写日志，所以不能只靠日志）。
  // 两种页面 × 两种导航；每格 S12_TRIALS 轮，**每轮一个全新的 origin**：每轮结束时点的「拒绝」会让该 origin 进 30 秒冷却（冷却 / 连续取消计数的键都带 origin），同一个 origin 的下一轮会被冷却挡掉、提示不再弹；
  // 换新 origin 就不依赖任何清理动作或开关。不用 `permissions reset` 清冷却的原因（第二十六轮订正）：本脚本在 S5 收尾处（`manager.onConfig({ pagePermissions: false })`）把 `pagePermissions` 关回了 false，
  // 而 grant / deny / reset 都是写类操作（`ops/permissions.mjs` 的 `assertWritable`），开关关着一律返回 ACCESS_DISABLED、什么也不清（单测 `browser-e2-p1-ops.test.ts` 钉着）；
  // 开关打开时带 origin / permission 的 reset 会清匹配的冷却。换新 origin 完全不受这个开关影响。
  // 只拒绝、不授予（不触发系统授权框）。样本量很小（每格 3 轮）：这里是回归哨兵，不是概率证明。
  const S12_TRIALS = 3;
  const S12_HEAD_SYNC = `<script>window.__gum='pending';navigator.mediaDevices.getUserMedia({audio:true}).then((s)=>{window.__gum='ok';s.getTracks().forEach((t)=>t.stop())},(e)=>{window.__gum=e.name});</script>`;
  const S12_HEAD_QUERY = `<script>window.__gum='pending';(async()=>{let q='?';try{q=(await navigator.permissions.query({name:'microphone'})).state}catch(e){q='ERR'}window.__q=q;if(q==='denied'){window.__gum='skipped-denied';return}try{const s=await navigator.mediaDevices.getUserMedia({audio:true});window.__gum='ok';s.getTracks().forEach((t)=>t.stop())}catch(e){window.__gum=e.name}})();</script>`;
  const s12Page = (head, body) => `<!doctype html><meta charset="utf-8"><title>r21-s12</title><head>${head}</head><body>${body}</body>`;
  const s12Other = await serve(() => s12Page("", "other"));
  // 「别的源」用 localhost（服务仍只监听 127.0.0.1，S2 同样靠 Chromium 把 localhost 解析到回环）：localhost → 127.0.0.1 是**跨站**导航（第二十六轮 S-1），
  // 能走到换渲染进程的那条路；此前用 127.0.0.1 的另一个端口，只是同站不同源，没覆盖到它
  const urlS12Other = `http://localhost:${s12Other}/`;
  const s12Trial = async (head, mode) => {
    // 每轮一个新端口 = 一个全新的 origin：普通页（不带 ?go=1）空白、请求页（?go=1）带 head 脚本
    const port = await serve((q) => (String(q.url).includes("go=1") ? s12Page(head, "go") : s12Page("", "plain")));
    const origin = `http://127.0.0.1:${port}`;
    const logBefore = permLog().length;
    await open(mode === "same-origin" ? `${origin}/` : urlS12Other); // 先落在哪：同源普通页 / 别的站点（localhost）
    // 起点要真落在预期的站点上（第二十六轮 S-1）：localhost 没加载出来（错误页之类）时，「跨站」这一格测的就不是它声称的路径
    const fromHost = await ev("location.hostname");
    const fromOk = fromHost === (mode === "same-origin" ? "127.0.0.1" : "localhost");
    await call("navigate", { url: `${origin}/?go=1` });
    const t0 = Date.now();
    // 只认「本轮这个 origin 的麦克风提示」（第二十六轮 S-3）：此前取队列里的第一个，别处残留的提示会被当成本轮的
    const pr = await waitFor(() => prompts().find((p) => p.detail?.permission === "microphone" && p.detail?.origin === origin), 4000, 25);
    const appearedMs = pr ? Date.now() - t0 : null;
    await sleep(400); // 提示出现后再观察一小会儿：看它会不会被后续的导航事件取消
    const stillPending = !!pr && prompts().some((p) => p.id === pr.id);
    const cancelLogs = permLog().slice(logBefore).filter((s) => /已取消|连续被取消/.test(s)).length;
    if (stillPending) sess().prompts.answer(pr.id, { action: "deny" });
    const gumEnd = await waitFor(async () => {
      const v = await ev("window.__gum");
      return v !== "pending" ? v : null;
    }, 5000, 50);
    const blockedHere = ((await list()).recentBlocked ?? []).filter((e) => e.origin === origin).length;
    return { fromHost, fromOk, appeared: !!pr, appearedMs, stillPending, cancelLogs, gumEnd, blockedHere };
  };
  const s12Cells = [
    ["r21-s12-sync-gum-cross-origin", "S12 解析期直接 getUserMedia（从别的站点——localhost 跨站导航到 127.0.0.1——进来）", S12_HEAD_SYNC, "cross-origin"],
    ["r21-s12-sync-gum-same-origin", "S12 解析期直接 getUserMedia（同源普通页导航到请求页）", S12_HEAD_SYNC, "same-origin"],
    ["r21-s12-query-gum-cross-origin", "S12 解析期先 permissions.query 再 getUserMedia（从别的站点——localhost 跨站导航到 127.0.0.1——进来）", S12_HEAD_QUERY, "cross-origin"],
    ["r21-s12-query-gum-same-origin", "S12 解析期先 permissions.query 再 getUserMedia（同源普通页导航到请求页）", S12_HEAD_QUERY, "same-origin"],
  ];
  for (const [id, name, head, mode] of s12Cells) {
    const rows = [];
    for (let i = 0; i < S12_TRIALS; i++) rows.push(await s12Trial(head, mode));
    const bad = rows.filter((r) => !r.fromOk || !r.appeared || !r.stillPending || r.cancelLogs > 0 || r.blockedHere > 0 || r.gumEnd !== "NotAllowedError");
    const times = rows.map((r) => r.appearedMs).filter((v) => v !== null);
    // 25 毫秒一步的轮询：这个数被步长量化（第一、二次轮询就看见 = 25 毫秒上下），只能读成「不超过约一个轮询步长」的上界，不是提示出现用时的精确值（第二十六轮 S-2）
    console.log(`SMOKE INFO ${id} 提示被观察到的用时（navigate 返回后开始计、25 毫秒一步轮询，被步长量化、只是上界）${times.length ? `${Math.min(...times)}~${Math.max(...times)} 毫秒` : "—"}（只记录、不断言）`);
    check(id, `${name}：提示照常弹出、400 毫秒后仍挂着（没被导航提交误取消；辅助：没有取消 / 被拒记录）、拒绝后拿到 NotAllowedError（${S12_TRIALS} 轮，每轮新 origin；起点站点已核对：跨站格从 localhost 出发、同源格从本轮自己的 origin 出发）`, bad.length === 0, bad.length ? { bad: bad.slice(0, 2), trials: rows.length } : { trials: rows.length });
  }
};

/**
 * 退出前统一收尾；成功 / 断言失败 / 脚本抛错三条路径都走这里。
 * 每一步独立 try、互不拖累，且幂等。
 */
const cleanupAll = () => {
  for (const s of live.servers) {
    try {
      s.close();
    } catch {
      /* 已关 */
    }
  }
  try {
    live.manager?.destroy();
  } catch {
    /* 已销毁 */
  }
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.destroy();
    } catch {
      /* 已销毁 */
    }
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn("SMOKE WARN 临时目录没清掉（不影响结果）：", TMP, err && err.message ? err.message : err);
  }
};

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(
      `SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed${skipped.length ? `, ${skipped.length} skipped（${skipped.map((s) => s.id).join(",")}）` : ""}${failed.length ? ` FAILED: ${failed.map((f) => f.id).join(",")}` : ""}`,
    );
    if (!failed.length && skipped.length) console.log("SMOKE INCOMPLETE 有跳过的项（环境不满足）：这一次不能当成全绿，退出码 4");
    cleanupAll();
    app.exit(failed.length ? 1 : skipped.length ? 4 : 0);
  })
  .catch((e) => {
    console.error("SMOKE ERROR", e);
    cleanupAll();
    app.exit(2);
  });
