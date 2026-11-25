/**
 * 页面权限闸（增强包 E2 · A8，契约 §15.2）：把 {@link ./permission-policy.mjs} 的纯决策接到 Electron 的
 * `setPermissionRequestHandler` / `setPermissionCheckHandler` 上，并负责三件「有副作用」的事：
 *
 *  1. **询问用户**：决策为 `ask` 时走 `session.prompts.request({ kind: "permission" })`（默认拒绝、60 秒、detail 只有权限名 / origin）。
 *     同一 tab + origin + 权限的并发请求合并成一个提示；**用户明确点了拒绝**的 30 秒内不再重复弹（防页面反复请求刷提示条）。
 *     其余几种「不是用户决定」的结局都**不进** 30 秒冷却（第二十三轮 R23-1 / R23-4）：60 秒无人处理（超时：用户根本没看到提示，不能再让他干等 30 秒）、名额满（overflow）、
 *     提示被取消（页面导航 / 关标签 / 会话销毁，R22-2）。取消只有在同一 tab + origin + 权限**连续**取消 {@link CANCEL_STREAK_LIMIT} 次（中间没有任何用户回答）后才给一个很短的
 *     冷却（{@link CANCEL_COOLDOWN_MS}）——页面循环「请求 → 刷新」时压住闪烁的提示条与刷屏的日志，又不影响用户偶尔刷新一两次。
 *  2. **定位模拟自动授权**：CDP 的 `Emulation.setGeolocationOverride` 只有在定位权限已授予时才生效——此前权限一律拒绝，所以
 *     「`emulate` 设了位置，页面还是拿不到」。这里在 `emulate` 设置定位的那一刻记下 tab 当前的 origin，只对**这个 origin** 免提示放行；
 *     tab 导航到别的 origin 立即不再放行（策略读的是实时的 `emulatedGeolocationOrigins`）。
 *  3. **通知不弹系统通知**：通知权限一旦授予，页面的 `new Notification()` 会在用户桌面弹真正的系统通知。授予前先往页面主世界注入一个
 *     `Notification` 代理（只放过 `permission` / `requestPermission` 等静态成员，构造出来的是假实例，**不会**触发系统通知），
 *     同时通过 CDP binding 把标题 / 正文（剥格式字符、限长、≤10 条/分钟）作为一条系统活动记录交给用户 / AI。
 *     装不上代理就不授予通知（fail closed）。
 *
 * 麦克风 / 摄像头的三条「让提示真的能弹出来」的规则（第二十一轮，同事的真实场景：练习页报「答题需要有麦克风权限」、面板上没有任何提示；第二十二轮改了 A）：
 *  A. **页面的 `permissions.query` 在「会弹提示」时读到 prompt、不再是 denied**。Electron 的检查处理器只能回 boolean，页面的 `navigator.permissions.query()` 因此只有
 *     granted / denied 两态、永远不会是 prompt（实测 Electron 42 / Chromium 148）；「还没授予」回 false = 页面读到 denied，
 *     先查 `permissions.query` 再决定要不要 `getUserMedia` 的页面（常见写法）就直接报「没有权限」、根本不会发请求，所以永远弹不出提示。
 *     **不能靠让检查处理器回 true 来解决**（第二十一轮曾这么做，第二十二轮评审 R22-1 在真 Electron 里复现了严重副作用）：WebRTC 收集 ICE 候选时用的是
 *     **同一条**媒体检查（`details` 形状与 `permissions.query` 完全一样，分不开），回 true 等于页面不经任何授权就能 `new RTCPeerConnection()` 拿到本机真实的内网 / 公网 IP
 *     （回 false 时 Chromium 只给 mDNS 的 xxx.local）。所以检查处理器对「没授予」的 media **一律回 false**（见 {@link handleCheck}），
 *     改成往页面主世界注入一个 `Permissions.prototype.query` 的小桩（{@link MEDIA_QUERY_STUB_SOURCE}）：麦克风 / 摄像头读到 denied、且该文档的 Permissions-Policy 允许这项 feature 时，
 *     页面看到的 `state` 改成 prompt（页面接着去 getUserMedia，请求处理器照常弹提示条）。浏览器自己的检查结果不动，WebRTC 仍只暴露 mDNS 候选。
 *     局限（第二十三轮按实测重写；数字是作者机器 macOS / Electron 42.4.0 上测的，别的环境不保证）：
 *      · 桩只改页面主世界里 `query()` 返回的 PermissionStatus。Electron 没有权限变化通知（42.4.0 实测；没有桩的 geolocation 同样，不是桩造成的）：授予之后旧对象**不会自己更新**
 *        （3 秒内逐段读都不变，挂不挂 `onchange` / `addEventListener` 一样）、**change 事件不触发**；页面再对同一个权限 `query()` 一次之后，旧对象的 `state` 才跟着读到新值（仍然没有事件）。
 *        页面靠监听 change 等授权的写法在 Electron 里本来就不成立。
 *      · **跨站 iframe（OOPIF）里页面的第一批脚本可能比桩先跑**——窗口是缩小了、不是消除了：桩现在经 {@link ./tab.mjs} 的 `addEarlySessionHook` 在子会话的「早钩子」里装
 *        （与 Page / Runtime / DOM / Network / Log 五个域的 `enable` 及 `Emulation.setFocusEmulationEnabled` 一起并行发出、先于 `Target.setAutoAttach` 和页面脚本）。
 *        改前（8 次）桩比 iframe 的第一个脚本晚：跨站 OOPIF 4.5~27.5 毫秒、同站跨源 4.7~18.6 毫秒、顶层 0；
 *        改后连续 3 轮（每轮 8 次跨站 OOPIF + 8 次同站跨源 + 4 次顶层）共 24/24、24/24、12/12 次第一个脚本运行时桩已就位。这是样本量很小的实测，机器忙 / 页面更早执行时窗口仍可能出现；
 *        漏过窗口的页面读到 denied（这样的页面通常不会再去请求）。
 *      · **`window.open` 打开 / 被收养的弹窗**（第二十四轮 R24-1，真 Electron 实测）：弹窗的 `BrowserTab` 在构造函数里就同步跑完了主会话的初始化第一步（早钩子那一批），
 *        而 `bindTab` 要等构造返回之后才登记桩——桩因此**根本没装上**，弹窗里 `permissions.query` 读到 denied（修之前 r21 S10 实测失败：stub 缺席、mic / cam denied，getUserMedia 仍能弹提示）。
 *        现在 `addEarlySessionHook` 对「已经跑过早钩子这一批」的会话补调一次（不漏、不重），弹窗里桩装上、query 读到 prompt。弹窗文档第一个脚本运行时桩在不在：
 *        作者机器连续 4 遍运行、每遍 5 个弹窗，共 20/20 次已就位（前 3 遍 15/15、最后一遍 5/5；fixture 是本地 http、没有网络延迟，样本很小，别的环境不保证；窗口没有被「设计」消除）。
 *      · **桩读到 prompt ≠ 请求一定会弹提示**。桩只看得见浏览器自己的检查结果（没授予 = false → denied → 改成 prompt），看不见闸门里的这些状态，所以页面读到 prompt 后调 `getUserMedia`，
 *        仍可能被**静默拒绝**——每一种都会进活动记录和 `permissions list` 的「最近被自动拒绝」清单（`recentBlocked`，原因见 {@link BLOCK_REASON_TEXT}），没有一种是「黑盒」：
 *          冷却（用户明确拒绝后的 30 秒；以及连续取消 {@link CANCEL_STREAK_LIMIT} 次后的 {@link CANCEL_COOLDOWN_MS} 毫秒短冷却，reason `cancel-streak`）、
 *          用户 / AI 的显式拒绝记录（AI `deny` 之后新鲜 `query()` 读到的仍是 prompt——桩看不到显式拒绝；这条在 42.4.0 上实测过）、
 *          提示名额满（`prompt-overflow`，只静默记录）、
 *          顶层页面是 file: / about:blank 这类不透明来源而里面嵌的是 https 框架（`opaque-origin`：框架里桩可能读到 prompt，闸门却没有「顶层站点」可委托；按代码推断，没有实测）、
 *          同一站点另有框架没被委托（`frame-not-delegated`：本框架的 `allowsFeature` 是 true，但闸门对同 origin 的框架要求全部被委托）、
 *          核对嵌入框架委托期间页面导航走了（`navigated-during-check`）。
 *      · `enumerateDevices()` 取设备名的检查不受影响（授予之前设备名仍是空名）。
 *  B. **被顶层页面委托了的跨源 iframe 也能弹提示**：课件 / 会议 / 录音类页面常把真正的页面放进 `<iframe allow="microphone">`。
 *     此前跨源子框架一律静默拒绝（没有提示、没有日志）。现在：请求来自跨源子框架时，先在该框架的隔离世界里核对
 *     `document.permissionsPolicy.allowsFeature(...)`（= 顶层确实委托了），通过才按「顶层站点」的授予表 / 提示处理（提示里写明嵌入页面的来源），
 *     核对不出来 / 没委托一律拒绝（fail closed）；没有委托的 iframe 本来就拿不到流（Chromium 自己也拦），这里不替它弹提示。
 *  C. **自动拒绝不再是黑盒**：不弹提示就拒绝的请求（跨源未委托 / 显式拒绝记录 / 非网页来源…）写一条活动记录并进「最近被自动拒绝」清单
 *     （`permissions list` 给 AI 看），用户 / AI 能知道「为什么没弹」。
 *
 * 另：弹麦克风 / 摄像头提示时顺带读一次系统层授权（`getMediaAccessStatus`，macOS 的隐私设置 / Windows 的全局开关）：系统层已是「拒绝」（denied）时
 * 提示条里多写一行说明——点了「允许」页面也拿不到声音，要先去系统设置里打开；被系统策略「限制」（restricted：家长控制 / 设备管理 / 组织策略）时单独写一句（用户自己改不了）。
 * 同一份状态也经 {@link systemMediaProblems} 进 `permissions list`（可选依赖 `getMediaAccessStatus`，没传就不提示）。
 *
 * 状态都挂在会话 / tab 的扩展点上（`session.getExt` / `tab.getExt`）：会话销毁时 `dispose()` 清空，不落盘；
 * `onBrowsingDataCleared()` 由 `browser:clearBrowsingData` 调用：清持久档案的授予与（全部）冷却；调用方给的是无痕 partition 名时什么都不清（范围见该函数的注释）。
 *
 * 不依赖 electron：`findOwner` / `getConfig` / `isAppUrl` 由 index.mjs 注入，单测用假对象即可。
 */

import {
  canonicalPermission,
  createPermissionGrants,
  decidePermissionWithReason,
  FRAME_RESTRICTED_ALLOWED_PERMISSIONS,
  isAskablePermission,
  MEDIA_ATOMS,
  MEDIA_PERMISSION,
  mediaAtomsOf,
  originOf,
  PERMISSION_LABEL_ZH,
} from "./permission-policy.mjs";
import { cleanPromptText, createOverflowLogThrottle, overflowSuppressedNote } from "./prompts.mjs";
import { redactSensitiveText } from "./text-redact.mjs";

/** 权限提示的超时（契约：60 秒无人处理按拒绝） */
export const PERMISSION_PROMPT_TIMEOUT_MS = 60_000;
/** 用户**明确点了拒绝**之后，同 tab + origin + 权限多久内不再重复弹提示（超时 / 名额满 / 取消都不进这个冷却，见文件头 1） */
export const PERMISSION_COOLDOWN_MS = 30_000;
/**
 * 第二十三轮 R23-1：提示被取消（页面导航 / 关标签）不进 30 秒冷却（R22-2），于是页面循环「请求 → 刷新」时每一轮都会再弹一次提示、再写一条日志（提示条闪烁）。
 * 同一 tab + origin + 权限**连续**取消到 {@link CANCEL_STREAK_LIMIT} 次（两次取消的间隔不超过 {@link CANCEL_STREAK_WINDOW_MS}，中间没有用户回答 / 超时）就给 {@link CANCEL_COOLDOWN_MS} 的短冷却：
 * 比 30 秒短得多（用户只是连着刷新几次时不至于吃闭门羹），又足够压住循环。用户的任何一次回答（允许 / 拒绝）或超时都把连续计数清零。
 */
export const CANCEL_STREAK_LIMIT = 3;
export const CANCEL_STREAK_WINDOW_MS = 30_000;
export const CANCEL_COOLDOWN_MS = 10_000;
/** 页面通知的活动记录：每分钟最多这么多条 */
export const NOTIFY_RATE_PER_MIN = 10;
const NOTIFY_WINDOW_MS = 60_000;
/** 通知标题 / 正文进活动记录前的长度上限 */
const NOTIFY_TITLE_MAX = 80;
const NOTIFY_BODY_MAX = 120;
/** CDP binding 名：只在页面主世界里存在到 stub 取走它为止 */
export const NOTIFY_BINDING_NAME = "__flowshipNotify";
const STATE_KEY = "permissions";
const MAX_COOLDOWN_ENTRIES = 100;
/**
 * 跨源子框架（iframe）的委托核对：框架的隔离世界可能还没建好（OOPIF 子会话刚挂接，页面一加载就请求麦克风时会遇到），
 * 没找到该框架时隔 POLL 重试一次，总共最多等 TOTAL；单次页内取值最多 EVAL_TIMEOUT（页面卡死时不让权限回调悬挂太久）。
 */
export const FRAME_DELEGATION_POLL_MS = 150;
export const FRAME_DELEGATION_TOTAL_MS = 3000;
export const FRAME_DELEGATION_EVAL_TIMEOUT_MS = 1500;
/** 调试连接没就绪（`cdpReady` 为假）时权限闸触发的自愈重连，两次之间至少隔这么久（失败的重连不能被页面的权限请求循环触发成风暴） */
export const CDP_HEAL_MIN_INTERVAL_MS = 5000;
/** 页内查询桩装不上的会话最多记几个（子会话很多又都失败时不无限增长） */
const MAX_STUB_PROBLEMS = 8;
/**
 * 「最近被自动拒绝」清单的条数上限（只在会话内存里，`permissions list` 读它）。**每个 partition 各自一份上限**（第二十三轮 R23-6：此前普通 / 无痕共用 10 条，一边刷屏会把另一边的记录挤掉）。
 */
export const MAX_RECENT_BLOCKED = 10;

/**
 * 页内核对源码（在**隔离世界**里跑，页面改不到）：该文档是否被委托了这些 Permissions-Policy feature。
 * 返回 `{ href, ok }`，取不到 API / 抛错返回 null（调用方按「没核对出来」处理）。
 * @param {string[]} features
 */
export const delegationProbeSource = (features) => `(function () {
  try {
    var p = document.permissionsPolicy || document.featurePolicy;
    if (!p || typeof p.allowsFeature !== "function") return null;
    var names = ${JSON.stringify(features)};
    var ok = true;
    for (var i = 0; i < names.length; i++) if (p.allowsFeature(names[i]) !== true) ok = false;
    return { href: String(location.href), ok: ok };
  } catch (e) { return null; }
})()`;

/**
 * 页面主世界里的 `permissions.query()` 小桩源码（第二十二轮 R22-1，见文件头 A）：麦克风 / 摄像头的查询读到 denied、且下面两条都满足时，页面看到的 `state` 改成 prompt
 * （Electron 的检查处理器只有 boolean，没有 prompt 这一态；页面「先 query、denied 就不发请求」的写法因此永远弹不出提示）：
 *  · 文档是安全上下文（`isSecureContext`）且协议是 http(s)——第二十三轮 R23-2：非安全的 http 内网页里 `getUserMedia` 本来就不可用、`about:srcdoc` / `file:` 这类来源会被闸门判成不透明来源直接拒绝，
 *    那些文档里 denied 才是如实的（改成 prompt 页面会去调不存在的 `mediaDevices`，或者等一个永远不会弹的提示）；
 *  · 该文档的 Permissions-Policy 允许这项 feature（`permissionsPolicy` 没有就退到 `featurePolicy`——Chrome 148 只有后者）；没被顶层委托的 iframe 仍是 denied，
 *    这种框架里的请求本来就会被委托核对拒绝，不能让页面误以为能弹提示。
 * 约束：自包含、不依赖外部变量、出错一律静默回原结果（装不上 / 出错就退回原行为）；幂等（可重复注入，只包一层）；只处理 `microphone` / `camera` 两个名字，其余原样透传。
 * 形态：`query` 被换成一个同名（`query`）、同长度（1）的**普通函数**（不是 Proxy，也不伪装 `toString()`）；只有返回的 `PermissionStatus` 是 `Proxy(原对象)`：
 * `state` 每次现读原对象（不缓存、不改 granted）——Electron 没有实现权限变化通知，真 Electron 实测（42.4.0）：授予之后同一个 status 对象**不会自己更新**（3 秒内逐段读都不变）、`onchange` / change 事件不触发；
 * 页面再对同一个权限 `query()` 一次之后，旧对象的 `state` 才跟着读到新值（仍然没有事件）。定位等没被桩碰的权限也一样，所以这不是桩带来的，页面靠监听 change 等授权的写法在 Electron 里本来就不成立；
 * 其余成员落在原对象上：`addEventListener` / `removeEventListener` / `dispatchEvent` 绑定到原对象，赋值（`onchange = fn` 是最常见写法）用 `Reflect.set(…, target)` 穿透——
 * 真 `PermissionStatus` 的 setter / 方法都在原型上，`this` 是 Proxy 时会抛 Illegal invocation。
 * 只改**页面看到的值**：浏览器自己的检查结果不动（WebRTC 的 ICE 收集用同一条检查，见 {@link handleCheck}）。
 */
export const MEDIA_QUERY_STUB_SOURCE = `(function () {
  try {
    var proto = window.Permissions && window.Permissions.prototype;
    var orig = proto && proto.query;
    if (typeof orig !== "function" || orig.__fsMediaQueryStub === true) return;
    var FEATURES = { microphone: "microphone", camera: "camera" };
    var METHODS = { addEventListener: 1, removeEventListener: 1, dispatchEvent: 1 };
    var wrapped = {
      query: function query(descriptor) {
        var result = orig.apply(this, arguments);
        var name = "";
        try { name = String(descriptor && descriptor.name); } catch (e) { return result; }
        if (!Object.prototype.hasOwnProperty.call(FEATURES, name)) return result;
        return result.then(function (status) {
          try {
            if (!status || status.state !== "denied") return status;
            if (window.isSecureContext !== true || !/^https?:$/.test(String(window.location && window.location.protocol))) return status;
            var policy = document.permissionsPolicy || document.featurePolicy;
            if (!policy || typeof policy.allowsFeature !== "function" || policy.allowsFeature(FEATURES[name]) !== true) return status;
            return new Proxy(status, {
              get: function (target, key) {
                if (key === "state") { var s = target.state; return s === "denied" ? "prompt" : s; }
                var v = Reflect.get(target, key, target);
                return typeof key === "string" && METHODS[key] === 1 && typeof v === "function" ? v.bind(target) : v;
              },
              set: function (target, key, value) { return Reflect.set(target, key, value, target); }
            });
          } catch (e) { return status; }
        });
      }
    }.query;
    Object.defineProperty(wrapped, "__fsMediaQueryStub", { value: true });
    proto.query = wrapped;
  } catch (e) {}
})();`;

/**
 * 自动拒绝的原因 → 给用户 / AI 看的中文（固定文案，不含页面内容）。
 * 每条都要**短**：它会拼进活动记录的一行（`activity-log` 的摘要上限 160 字，前缀约 50 字），太长会被截断成「…」、读不到结尾。
 */
export const BLOCK_REASON_TEXT = Object.freeze({
  "cross-origin-frame": "请求来自页面里嵌入的其他站点：这类权限只给顶层页面自己（麦克风 / 摄像头要顶层用 iframe 的 allow 委托）",
  "frame-not-delegated": "顶层没把这项权限委托给该嵌入框架（iframe 缺 allow、被 Permissions-Policy 禁止，或嵌套链 / 同站点别的框架没委托）",
  "frame-check-failed": "没能确认嵌入框架是否被委托（框架没加载完 / 调试连接刚恢复 / 同站点另有框架无响应），已拒绝；稍后再试一次",
  "explicit-deny-ai": "该站点已有「拒绝」记录（AI 设置的），要放开请先 permissions reset",
  "explicit-deny-user": "该站点已有「拒绝」记录",
  "opaque-origin": "请求来源不是普通网页（about:blank / data: / file: 等），或顶层页面是这类来源、没法委托",
  "notifications-main-frame-only": "通知只允许顶层页面",
  cooldown: "刚被拒绝：30 秒内同一标签页上的该站点不再重复弹提示，刷新页面也不会重置；之后页面重新发起请求才会再弹",
  "cancel-streak": "提示连续被取消（页面反复刷新 / 离开）：暂停 10 秒不再弹，之后页面重新发起请求会再弹",
  "prompt-overflow": "同时挂起的权限提示太多（上限 4 个），这次按默认拒绝；处理掉已有提示后页面重新发起请求会再弹",
  "navigated-during-check": "核对嵌入框架委托期间页面已导航，这次请求属于旧页面、已丢弃；新页面重新发起请求会再核对",
});

// ───────────────────────── 通知代理（注入页面主世界） ─────────────────────────

/**
 * 页面主世界里的 `Notification` 代理源码。
 * 约束：自包含、不依赖外部变量、出错一律静默（装不上就不能让页面崩）；binding 函数被取走后立刻从 window 上删掉，页面拿不到。
 * 授予前页面读到的 `Notification` 引用（`const N = Notification`）绕得过代理——这是「用户已经明确允许该站发通知」之后的残余风险，写进报告。
 */
export const NOTIFICATION_STUB_SOURCE = `(() => {
  try {
    var g = globalThis;
    if (g.__fsNotifStub) return;
    var send = g.${NOTIFY_BINDING_NAME};
    var Orig = g.Notification;
    if (typeof send !== "function" || typeof Orig !== "function") return;
    try { delete g.${NOTIFY_BINDING_NAME}; } catch (e) {}
    var clip = function (v, n) { return String(v == null ? "" : v).slice(0, n); };
    var handler = {
      construct: function (target, args, newTarget) {
        var perm = "denied";
        try { perm = target.permission; } catch (e) {}
        if (perm !== "granted") return Reflect.construct(target, args, newTarget);
        var title = clip(args[0], 200);
        var opts = args[1] && typeof args[1] === "object" ? args[1] : {};
        try { send(JSON.stringify({ t: title, b: clip(opts.body, 300) })); } catch (e) {}
        var fake = new EventTarget();
        try { Object.setPrototypeOf(fake, target.prototype); } catch (e) {}
        var props = { title: title, body: clip(opts.body, 300), tag: clip(opts.tag, 100), icon: "", data: opts.data === undefined ? null : opts.data, lang: "", dir: "auto", silent: null, requireInteraction: false };
        Object.keys(props).forEach(function (k) {
          Object.defineProperty(fake, k, { value: props[k], enumerable: true, configurable: true, writable: false });
        });
        ["click", "show", "error", "close"].forEach(function (n) {
          var h = null;
          Object.defineProperty(fake, "on" + n, {
            get: function () { return h; },
            set: function (f) {
              if (h) fake.removeEventListener(n, h);
              h = typeof f === "function" ? f : null;
              if (h) fake.addEventListener(n, h);
            },
            enumerable: true,
            configurable: true
          });
        });
        Object.defineProperty(fake, "close", {
          value: function () { setTimeout(function () { try { fake.dispatchEvent(new Event("close")); } catch (e) {} }, 0); },
          enumerable: true,
          configurable: true,
          writable: true
        });
        setTimeout(function () { try { fake.dispatchEvent(new Event("show")); } catch (e) {} }, 0);
        return fake;
      }
    };
    Object.defineProperty(g, "Notification", { value: new Proxy(Orig, handler), writable: true, configurable: true, enumerable: false });
    Object.defineProperty(g, "__fsNotifStub", { value: true, enumerable: false, configurable: false, writable: false });
  } catch (e) {}
})();`;

// ───────────────────────── 状态 ─────────────────────────

/** 连续取消的日志限速器吞掉的次数 → 日志尾巴（0 次 = 空串）；与 overflow 的 {@link overflowSuppressedNote} 分开，因为这里被吞掉的是「取消」而不是「按默认处理」 */
const cancelSuppressedNote = (suppressed) =>
  Number.isFinite(suppressed) && suppressed > 0 ? `（上一条之后另有 ${Math.floor(suppressed)} 次同类取消，未逐条记录）` : "";

/** 冷却 / 连续取消计数的键：`${tabId}|${origin}|${permission}`（origin 里没有 `|`，所以按首尾两个 `|` 拆即可）；三张表都按**独立权限**（麦克风 / 摄像头各一项）记，不用合称 `media` */
const cooldownKeyOf = (tab, origin, p) => `${tab.id}|${origin}|${p}`;

/**
 * 往「键 → 值」的冷却类表里写一项，表有上限 {@link MAX_COOLDOWN_ENTRIES}（防页面制造海量键把内存撑大）。
 * 满了先剔掉**已过期**的；仍满再挤掉**最老**的一项（Map 的插入顺序；同键重写先删后加，会挪到末尾）。
 * 第二十四轮 P3-4：此前满了就整表 `clear()`，把还在生效的冷却（含用户刚点的拒绝）一起丢了。
 * @template V
 * @param {Map<string, V>} map
 * @param {string} key
 * @param {V} value
 * @param {(v: V) => boolean} isExpired 这一项现在是否已经过期（过期的可以安全剔掉）
 */
export const putBounded = (map, key, value, isExpired) => {
  map.delete(key);
  if (map.size >= MAX_COOLDOWN_ENTRIES) {
    for (const [k, v] of map) if (isExpired(v)) map.delete(k);
    while (map.size >= MAX_COOLDOWN_ENTRIES) map.delete(map.keys().next().value);
  }
  map.set(key, value);
};
const parseCooldownKey = (key) => {
  const first = key.indexOf("|");
  const last = key.lastIndexOf("|");
  if (first < 0 || last <= first) return { tabId: key, origin: "", permission: "" };
  return { tabId: key.slice(0, first), origin: key.slice(first + 1, last), permission: key.slice(last + 1) };
};

/** 会话级状态（授予表 / 冷却 / 提示合并 / 通知限速）；`dispose` 供 session.getExt 在会话销毁时调用 */
const createSessionState = (now) => {
  const state = {
    /** 持久 partition（普通标签）的授予表 */
    grants: createPermissionGrants({ now }),
    /**
     * R6-22：无痕标签（独立内存 partition）的授予表——与普通标签完全分开：普通标签上选的「本会话一直允许」不能让同源无痕标签免提示，反之亦然。
     * 冷却 / 提示合并的 key 本来就带 tabId（无痕与普通是不同的 tab），天然隔离，这里不用再拆。
     */
    incognitoGrants: createPermissionGrants({ now }),
    /** 按 tab 所在 partition 取授予表（没有 tab 的调用方 = 持久） */
    grantsFor(tab) {
      return tab?.incognito === true ? state.incognitoGrants : state.grants;
    },
    /** `${tabId}|${origin}|${permission}` → 冷却截止时间（只有用户明确点了拒绝才进这里，{@link PERMISSION_COOLDOWN_MS}） */
    cooldown: new Map(),
    /** R23-1：连续取消达到 {@link CANCEL_STREAK_LIMIT} 次之后的短冷却（同样的键，{@link CANCEL_COOLDOWN_MS}）；单独一张表，好让「被拒绝」与「被取消太多次」给出不同的话术 */
    cancelCooldown: new Map(),
    /** R23-1：同键的连续取消计数 `{ n, at }`（键按独立权限，P3-4；用户回答 / 超时 / reset / 清浏览数据都会清掉） */
    cancelStreak: new Map(),
    /** 同一键并发请求合并：key → 提示结果 Promise（只有创建者做副作用） */
    pendingAsk: new Map(),
    notifyTimes: [],
    notifyDroppedAt: 0,
    /** R6-19：权限提示名额满（overflow）时的活动日志限速（每个会话一份，只管日志、不影响决策；overflow 不进冷却） */
    overflowLog: createOverflowLogThrottle({ now }),
    /**
     * 第二十一轮：不弹提示就被拒绝的请求（最新在前、同 partition + 来源 + 框架 + 权限 + 原因合并计数）；`permissions list` 读它，让 AI 知道「为什么没弹」。
     * 第二十二轮 R22-3：每条带 `incognito`（来自无痕标签与否）——`list` 按目标标签的 partition 只给同一份看（与授予表一致），无痕 partition 被 wipe 时无痕那几条一并作废。
     */
    recentBlocked: [],
    dispose() {
      state.grants.clear();
      state.incognitoGrants.clear();
      state.cooldown.clear();
      state.cancelCooldown.clear();
      state.cancelStreak.clear();
      state.pendingAsk.clear();
      state.notifyTimes.length = 0;
      state.overflowLog.reset();
      state.recentBlocked.length = 0;
    },
    /**
     * `browser:clearBrowsingData`：授予与冷却都属于「浏览数据」，一并清掉。
     * R6-22：清除只作用于持久档案——给了 partition 且它是无痕名时不动（无痕的授予随 wipe 清）；不给 / 给持久名 → 清持久授予（旧行为 = 不给时两张都清）。
     * 第二十四轮 P3-8：此前「给了无痕名」时代码并没有照上面做（持久授予与全部冷却照清、「最近被拒」却只留无痕那几条，三份状态三种口径）；现在无痕名一律不动，与这段说明一致。
     * 下面这条只对**走到清除这一步的入口**（不给 partition / 给持久名）成立；给无痕名的入口在上面的 `return` 处就退出了、冷却也不动（第二十五轮 N-7 限定范围）：
     * 冷却（用户拒绝的 30 秒 + 取消的短冷却 + 取消计数）清的是**全部**——含无痕标签上的：它们只是「别反复打扰」的短期记忆、不含授予的意思，清掉的后果只是多问一次、不会少问；
     * 要按 partition 拆开，得在键里带无痕标记（键的形态被单测直接读写：gate 与 ops 的测试都按 `${tabId}|${origin}|${permission}` 造键；ops 层的生产代码只调 `dropCooldown(scope)`、不碰键本身），
     * 不值得为 30 秒的记忆做；真要拆时改成按 tab 的 `incognito` 过滤即可（第二十六轮订正：此前写成「被单测与 ops 层直接读写」，ops 生产代码并不读写键）。
     */
    onBrowsingDataCleared(partition) {
      const scoped = typeof partition === "string" && partition !== "";
      if (scoped && partition.startsWith("flowship-incognito-")) return;
      state.grants.clear();
      if (!scoped) state.incognitoGrants.clear();
      state.dropCooldown();
      // 「最近被自动拒绝」跟授予表同口径：持久档案那几条一定清；无痕那几条只在没给 partition（= 两份都清）时才清（无痕的随 wipe 清）
      state.dropBlocked((e) => e.incognito !== true || !scoped);
    },
    /** R6-10 / R6-22：无痕 partition 被 wipe（最后一个无痕 tab 关闭）——无痕授予表整体作废（同一会话里别的无痕 tab 也将重新询问，偏严） */
    onPartitionWiped(partition) {
      if (typeof partition === "string" && partition.startsWith("flowship-incognito-")) {
        state.incognitoGrants.clear();
        // 第二十二轮 R22-3：无痕标签上被拒的来源也属于「无痕数据」，关掉后 AI 不该再从 list 里看到
        state.dropBlocked((e) => e.incognito === true);
      }
    },
    /**
     * 清冷却（用户拒绝的 + 连续取消的短冷却 + 连续取消计数）：不带参数 = 全部清；带 `origin` 和 / 或 `permissions`（独立权限名数组）= 只清键里 origin / 权限匹配的那些
     * （R23-6：scoped `reset` 此前无条件清空整张冷却表，别的站点的冷却没了、对应的「最近被自动拒绝」记录却还留着，两边对不上）。
     * 契约（第二十六轮）：`permissions` 只收**独立权限名**（`microphone` / `camera` / `geolocation` …），不认合称 `media`——合称在入口处就展开成 {@link MEDIA_ATOMS}
     * （`ops/permissions.mjs` 的 `targetsOf`），表里也没有 `media` 的键；直接传 `["media"]` 会静默匹配不到任何键（不报错）。唯一的调用方已按这个约定展开；以后新增调用方要自己先展开。
     * @param {{ origin?: string, permissions?: string[] }} [scope]
     */
    dropCooldown(scope = {}) {
      for (const map of [state.cooldown, state.cancelCooldown, state.cancelStreak]) {
        if (scope.origin === undefined && scope.permissions === undefined) {
          map.clear();
          continue;
        }
        for (const key of [...map.keys()]) {
          const parsed = parseCooldownKey(key);
          if (scope.origin !== undefined && parsed.origin !== scope.origin) continue;
          // 三张表都按**独立权限**记（第二十四轮 P3-4），不产生合称 `media` 的键——所以这里只按原子名比（第二十五轮评审测试 G：此前留着一条「media 键与麦克风 / 摄像头相关」的兼容分支，没有任何生产路径会走到它）
          if (scope.permissions !== undefined && !scope.permissions.includes(parsed.permission)) continue;
          map.delete(key);
        }
      }
    },
    /** 从「最近被自动拒绝」里删掉满足 pred 的条目（原地改，保持数组引用不变） */
    dropBlocked(pred) {
      const keep = state.recentBlocked.filter((e) => !pred(e));
      state.recentBlocked.length = 0;
      state.recentBlocked.push(...keep);
    },
  };
  return state;
};

/** 取会话的权限状态（没有就建）。ops/permissions.mjs 与 index.mjs 也用它 */
export const getPermissionState = (session, now = Date.now) => session.getExt(STATE_KEY, () => createSessionState(now));

const createTabState = () => ({
  /** 定位模拟绑定的 origin（emulate 设置定位那一刻 tab 所在的 origin）；pending = 当时 tab 还没有 http(s) origin，等第一次导航补 */
  geoOrigin: null,
  geoPending: false,
  /** 通知代理：ready = 已装好；installing = 安装中的 Promise；hooked = 已注册 CDP 事件 / 会话钩子 */
  notifReady: false,
  notifInstalling: null,
  notifHooked: false,
  /** 页内 `permissions.query` 桩已注册的「新文档脚本」：会话键（主会话 "main" / 子会话 id）→ CDP 返回的 identifier；重装时先摘旧的，免得同一会话里重复注册 */
  queryStubScripts: new Map(),
  /** R23-3：页内查询桩没装上的会话：会话键 → `{ at, message }`（下一次装成功 / 子会话 detach 时清掉）；`permissions list` 读它 */
  queryStubProblems: new Map(),
  /** R23-5：主框架每发起一次跨文档导航就 +1——委托核对前后比较它，核对期间页面换过文档（哪怕 origin 没变）这次请求就属于旧文档 */
  navEpoch: 0,
  /** R23-5：同一框架 origin + 权限的委托核对合并（key → Promise<verdict>）：同一个 iframe 的并发请求共用一次轮询，不各自空转 3 秒 */
  delegationInflight: new Map(),
  /** R23-3：调试连接未就绪时权限闸触发的自愈重连（同一时刻只一次、两次之间至少隔 CDP_HEAL_MIN_INTERVAL_MS） */
  cdpHealing: null,
  /** 上一次触发自愈的时刻（毫秒时间戳）；`-Infinity` = 从没触发过（用 0 的话，时钟恰好在 0 附近——比如测试里的假时钟——首次触发会被误当成「刚触发过」） */
  cdpHealAt: Number.NEGATIVE_INFINITY,
  /** 本 tab 最近一次弹过权限提示所在的会话（tab 销毁 / 导航时取消用） */
  session: null,
});

const fallbackTabStates = new WeakMap();
const tabStateOf = (tab) => {
  if (typeof tab.getExt === "function") return tab.getExt(STATE_KEY, createTabState);
  let s = fallbackTabStates.get(tab);
  if (!s) fallbackTabStates.set(tab, (s = createTabState()));
  return s;
};

const hostOfOrigin = (origin) => {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
};

export const permissionLabel = (permission) => PERMISSION_LABEL_ZH[permission] ?? permission;

/** 一次 media 请求要问的权限的展示名：只问一项写它自己（microphone / camera），两项都问写合称 media */
const mediaPromptName = (mediaTypes) => {
  const atoms = mediaAtomsOf(mediaTypes);
  return atoms.length > 1 ? MEDIA_PERMISSION : atoms[0];
};

// ───────────────────────── 工厂 ─────────────────────────

/**
 * @param {{
 *   findOwner: (wc: any) => ({ session: any, tab: any } | null),
 *   getConfig: () => ({ pagePermissions?: boolean } | null),
 *   isAppUrl?: (url: string) => boolean,
 *   log?: (msg: string) => void,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   getMediaAccessStatus?: (kind: "microphone" | "camera") => string,
 *   platform?: string,
 * }} deps  getMediaAccessStatus：系统层授权状态（Electron 的 `systemPreferences.getMediaAccessStatus`），可选——没传就不做系统层提示
 */
export const createPermissionGate = (deps) => {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const platform = deps.platform ?? process.platform;
  const getConfig = () => deps.getConfig?.() ?? null;
  /** 系统层对这个媒体类型的授权状态；取不到 / 抛错 = "unknown"（不提示） */
  const systemMediaStatus = (kind) => {
    try {
      const s = deps.getMediaAccessStatus?.(kind);
      return typeof s === "string" ? s : "unknown";
    } catch {
      return "unknown";
    }
  };
  /** Flowship 自己的 origin；判断出错按「是」处理（fail closed） */
  const isAppOrigin = (origin) => {
    if (origin === null) return false;
    try {
      return deps.isAppUrl?.(origin) === true;
    } catch {
      return true;
    }
  };
  const alive = (owner) => !!owner && !owner.session?.destroyed && !owner.tab?.destroyed;

  const geoOriginsOf = (tab) => {
    if (!tab.emulation?.geolocation) return [];
    const ts = tabStateOf(tab);
    return ts.geoOrigin ? [ts.geoOrigin] : [];
  };

  /**
   * 一次权限判定（单个、独立的权限名）。`frame`：{ isMainFrame, top, forceCross? }——跨源子框架（origin ≠ 顶层 origin，或检查处理器报了 embeddingOrigin）一律拒绝，
   * 授予是按「顶层站点」给的，不能让嵌进来的第三方 iframe 蹭到；通知只给主框架（stub 只装在主框架主世界）。
   */
  const evaluateOne = (owner, perm, origin, frame) => {
    const base = decidePermissionWithReason({
      permission: perm,
      origin,
      grants: getPermissionState(owner.session, now).grantsFor(owner.tab),
      config: getConfig(),
      emulatedGeolocationOrigins: geoOriginsOf(owner.tab),
      isAppOrigin: isAppOrigin(origin) || isAppOrigin(frame.top),
    });
    // 「无隐私面的放行项」（剪贴板写）保持旧行为不分框架；其余（授予 / 模拟放行，以及要询问的，
    // 还有 FRAME_RESTRICTED_ALLOWED_PERMISSIONS 里的放行项如扬声器名）只给顶层站点自己的框架
    const frameFree = base.reason === "allowed" && !FRAME_RESTRICTED_ALLOWED_PERMISSIONS.includes(perm);
    if (base.decision === "allow" ? !frameFree : base.decision === "ask") {
      const cross = !frame.isMainFrame && (frame.forceCross === true || origin !== frame.top);
      if (cross) return { perm, decision: "deny", reason: "cross-origin-frame" };
      if (perm === "notifications" && !frame.isMainFrame) return { perm, decision: "deny", reason: "notifications-main-frame-only" };
    }
    return { perm, ...base };
  };

  /**
   * 判定入口。Electron 把麦克风和摄像头都报成 `media`（R9-02）：按请求的类型（`mediaTypes` / `mediaType`）拆成 `microphone` / `camera`
   * 各自独立判定，再合并——任何一项被拒 / 被显式拒绝 = 拒绝；其余还没授予的合起来问一次（`askPerms` 只含还没授予的那几项，已授予的不重复问）；
   * 全部已授予才放行。非 `media` 的权限原样走 {@link evaluateOne}。
   * @param {unknown} [mediaTypes] 请求的 `details.mediaTypes`（数组）或检查的 `details.mediaType`（字符串）；只对 `media` 有意义
   */
  const evaluate = (owner, permission, origin, frame, mediaTypes) => {
    const perm = canonicalPermission(permission) ?? String(permission);
    if (perm !== MEDIA_PERMISSION) return evaluateOne(owner, perm, origin, frame);
    const parts = mediaAtomsOf(mediaTypes).map((atom) => evaluateOne(owner, atom, origin, frame));
    const denied = parts.find((p) => p.decision === "deny");
    if (denied) return { perm: MEDIA_PERMISSION, decision: "deny", reason: denied.reason };
    const askPerms = parts.filter((p) => p.decision === "ask").map((p) => p.perm);
    if (askPerms.length > 0) return { perm: MEDIA_PERMISSION, decision: "ask", reason: "needs-user", askPerms };
    return { perm: MEDIA_PERMISSION, decision: "allow", reason: parts[0].reason };
  };

  // ── 通知代理 ──

  const handleBindingCalled = (owner, params) => {
    if (params?.name !== NOTIFY_BINDING_NAME) return;
    const state = getPermissionState(owner.session, now);
    const t = now();
    state.notifyTimes = state.notifyTimes.filter((x) => t - x < NOTIFY_WINDOW_MS);
    if (state.notifyTimes.length >= NOTIFY_RATE_PER_MIN) {
      // 每个窗口只记一条「太频繁」，不让页面借通知刷活动日志
      if (t - state.notifyDroppedAt >= NOTIFY_WINDOW_MS) {
        state.notifyDroppedAt = t;
        safeSystemLog(owner, "notification", `页面通知过于频繁，已丢弃后续通知（每分钟最多记录 ${NOTIFY_RATE_PER_MIN} 条）`);
      }
      return;
    }
    state.notifyTimes.push(t);
    let data = null;
    try {
      data = JSON.parse(String(params.payload ?? ""));
    } catch {
      data = null;
    }
    if (!data || typeof data !== "object") return;
    // R6-12：页面可控的通知文字先脱敏、再截断（先截断会把 JWT 劈成两半、残留段匹配不上）；活动日志写入口另有统一兜底（activity-log.mjs safeText，幂等）
    const title = cleanPromptText(redactSensitiveText(String(data.t ?? "").slice(0, 2048)), NOTIFY_TITLE_MAX);
    const body = cleanPromptText(redactSensitiveText(String(data.b ?? "").slice(0, 2048)), NOTIFY_BODY_MAX);
    safeSystemLog(owner, "notification", `页面发出通知（已拦截，未弹系统通知）：「${title || "（无标题）"}」${body ? `— ${body}` : ""}`);
  };

  const safeSystemLog = (owner, kind, summary) => {
    try {
      owner.session.activityLog.addSystem({ kind, tabId: owner.tab.id, url: owner.tab.url, summary });
    } catch (err) {
      log(`[browser] 权限活动日志写入失败：${err?.message || err}`);
    }
  };

  const installNotifOnSession = async (tab, sessionId) => {
    await tab.send("Runtime.addBinding", { name: NOTIFY_BINDING_NAME }, sessionId);
    // 之后的每个新文档都先装好代理（binding 在新文档里同样存在）；当前文档立刻装
    await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: NOTIFICATION_STUB_SOURCE }, sessionId);
    if (sessionId === null) {
      await tab.send("Runtime.evaluate", { expression: NOTIFICATION_STUB_SOURCE, returnByValue: true }, null);
    }
  };

  /**
   * 这个桩会话键现在还在不在：`main` 一直在；子会话看 tab 当前的会话表（`cdpSessionIds()`）。
   * 拿不到会话表（单测里的假 tab / 老接口）一律当作「在」——宁可多记，不能把真失败吞掉。
   */
  const stubSessionAlive = (tab, key) => {
    if (key === "main" || typeof tab.cdpSessionIds !== "function") return true;
    try {
      return tab.cdpSessionIds().includes(key);
    } catch {
      return true;
    }
  };

  /**
   * 清掉已经不存在的子会话在桩状态里留下的记录（第二十四轮 P3-1）：子会话 detach 事件会清自己的键，但**自愈重连**（`tab.ensureCdp`）是直接 `children.clear()`、不产生 detach 事件，
   * 旧会话的失败记录 / 新文档脚本编号就永远留着，`permissions list` 会把早已不存在的框架报成「桩装不上」。读 / 写这两张表之前先对一遍当前会话表。
   */
  const pruneStubSessions = (tab, ts) => {
    if (typeof tab.cdpSessionIds !== "function") return;
    let live;
    try {
      live = new Set(tab.cdpSessionIds().map((id) => id ?? "main"));
    } catch {
      return;
    }
    for (const table of [ts.queryStubProblems, ts.queryStubScripts]) {
      for (const key of [...table.keys()]) if (!live.has(key)) table.delete(key);
    }
  };

  /**
   * 第二十二轮 R22-1：往一个 CDP 会话（主会话 / OOPIF 子会话）装页内 `permissions.query` 桩：之后的每个新文档先装好，当前文档立刻补一遍（脚本自带幂等保护）。
   * 同一会话重复安装（自愈重连、`#setupSession` 重跑）先摘掉上一次注册的新文档脚本，免得叠出多份。
   */
  const installQueryStub = async (tab, sessionId) => {
    const ts = tabStateOf(tab);
    const key = sessionId ?? "main";
    const old = ts.queryStubScripts.get(key);
    if (old) {
      ts.queryStubScripts.delete(key);
      await tab.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: old }, sessionId).catch(() => {});
    }
    const added = await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: MEDIA_QUERY_STUB_SOURCE }, sessionId);
    // 安装期间子会话可能已经 detach（detach 的清理先于这里跑完）：会话没了就不再登记，免得往已清理过的表里写回一条永远清不掉的幽灵记录（第二十四轮 P3-1）
    if (added?.identifier && stubSessionAlive(tab, key)) ts.queryStubScripts.set(key, added.identifier);
    // 当前文档补一遍。早钩子（R23-3）可能赶在文档的主世界执行上下文建好之前：此时 `Runtime.evaluate` 会失败（没有默认执行上下文），但那说明文档还没跑过任何脚本——
    // 上面登记的「新文档脚本」会在上下文建好时先于页面脚本执行，所以这里失败只记日志、不算桩没装上（真正装不上的情形——会话没了 / 命令超时——登记那条就已经抛了）。
    try {
      await tab.send("Runtime.evaluate", { expression: MEDIA_QUERY_STUB_SOURCE, silent: true }, sessionId);
    } catch (err) {
      // tab 已销毁时这一步必然失败（第二十六轮 T-6），不写这行误导的日志
      if (tab.destroyed !== true) log(`[browser:${tab.id}] 页内权限查询桩补装到当前文档失败（已由新文档脚本兜底）：${err?.message || err}`);
    }
  };

  /**
   * 页内查询桩装不上（R23-3）：记进 tab 状态（`permissions list` 读）+ 日志 + 一条限速的活动记录。会话键 `main` = 主页面，其余 = 嵌入框架（OOPIF 子会话）。
   * 第二十四轮 P3-1：① 先确认会话还在——安装途中子会话 detach 了（命令随之失败）就只写日志、不进清单，免得 detach 的清理跑完之后又写回一条幽灵记录；
   * ② 最多记 {@link MAX_STUB_PROBLEMS} 个会话，但**主页面的失败永远准入**（满了就挤掉最老的子框架记录）——此前满了新失败一律丢弃，连主页面的真失败也记不上。
   */
  const noteStubProblem = (tab, key, err) => {
    const message = cleanPromptText(String(err?.message || err), 80);
    log(`[browser:${tab.id}] 页内权限查询桩装不上（${key === "main" ? "主页面" : "嵌入框架"}；页面可能读到 denied 而不发请求）：${message}`);
    try {
      const ts = tabStateOf(tab);
      if (!stubSessionAlive(tab, key)) return;
      pruneStubSessions(tab, ts);
      if (ts.queryStubProblems.size >= MAX_STUB_PROBLEMS && !ts.queryStubProblems.has(key)) {
        if (key !== "main") return;
        const oldestFrame = [...ts.queryStubProblems.keys()].find((k) => k !== "main");
        if (oldestFrame === undefined) return;
        ts.queryStubProblems.delete(oldestFrame);
      }
      ts.queryStubProblems.set(key, { at: now(), message });
      const owner = deps.findOwner?.(tab.wc);
      if (!alive(owner)) return;
      const slot = getPermissionState(owner.session, now).overflowLog.take("stub-failed");
      if (!slot.log) return;
      safeSystemLog(
        owner,
        "permission",
        `页内权限状态桩没装上（${key === "main" ? "主页面" : "嵌入框架"}）：页面读麦克风 / 摄像头权限状态时可能读到 denied、因此不发请求；原因：${message}${overflowSuppressedNote(slot.suppressed)}`,
      );
    } catch (err2) {
      log(`[browser] 记录页内权限查询桩失败状态出错（已忽略）：${err2?.message || err2}`);
    }
  };

  /**
   * 目标 tab 上页内查询桩没装上的会话（`[{ scope: "main" | "frame", message }]`，没有问题 = 空数组）——`permissions list` 读它（R23-3）：
   * 桩没装上时页面读麦克风 / 摄像头状态仍是 denied、先 query 再请求的页面就不会发请求，而请求处理器 / 活动记录里什么都不会出现。
   */
  const queryStubProblems = (tab) => {
    const ts = tabStateOf(tab);
    pruneStubSessions(tab, ts); // 自愈重连清过的子会话没有 detach 事件：读之前对一遍当前会话表（P3-1）
    return [...ts.queryStubProblems.entries()].map(([key, v]) => ({ scope: key === "main" ? "main" : "frame", message: v.message }));
  };

  /** 保证 tab 的通知代理已装好；失败返回 false（调用方据此拒绝授予） */
  const ensureNotifStub = (tab) => {
    const ts = tabStateOf(tab);
    if (ts.notifReady) return Promise.resolve(true);
    if (ts.notifInstalling) return ts.notifInstalling;
    ts.notifInstalling = (async () => {
      try {
        await installNotifOnSession(tab, null);
        if (!ts.notifHooked) {
          ts.notifHooked = true;
          // debugger 断线重连后 binding / 新文档脚本都没了：重放（只主会话；子框架不授予通知）
          tab.addSessionHook?.(async (sessionId) => {
            if (sessionId !== null || !ts.notifReady) return;
            await installNotifOnSession(tab, null);
          });
          tab.onCdpEvent?.((method, params, sessionId) => {
            if (method !== "Runtime.bindingCalled" || (sessionId ?? null) !== null) return;
            const owner = deps.findOwner?.(tab.wc);
            if (alive(owner)) handleBindingCalled(owner, params);
          });
        }
        ts.notifReady = true;
        return true;
      } catch (err) {
        log(`[browser:${tab.id}] 通知代理安装失败，不授予通知权限：${err?.message || err}`);
        return false;
      } finally {
        ts.notifInstalling = null;
      }
    })();
    return ts.notifInstalling;
  };

  // ── 自动拒绝的可见性 ──

  /**
   * 不弹提示就拒绝的请求：写一条活动记录 + 进「最近被自动拒绝」清单，让用户 / AI 知道「为什么没弹」。
   * 只记用户可能期待的权限（询问类 + media）；永远拒绝的硬规则（全屏 / USB / 未知名…）和 Flowship 自己的 origin 不记——那是常态噪声。
   * 同一（权限 + 原因）每个会话每 60 秒最多一条活动记录（页面循环请求不能把 500 条的环形缓冲刷掉），清单按「来源 + 框架 + 权限 + 原因」合并计数。
   * @param {string} perm 展示用的权限名（microphone / camera / media / geolocation …）
   * @param {string} reason 决策原因码
   * @param {string | null} frameOrigin 请求实际来自的嵌入框架 origin（顶层自己的请求为 null）
   * @param {{ quiet?: boolean }} [opts] quiet：只进清单、不写活动记录（调用方自己已经写了一条更具体的，如名额满）
   */
  const noteBlocked = (owner, perm, reason, origin, frameOrigin = null, { quiet = false } = {}) => {
    try {
      if (reason === "app-origin" || reason === "never" || reason === "unknown-permission") return;
      if (perm !== MEDIA_PERMISSION && !isAskablePermission(perm)) return;
      const state = getPermissionState(owner.session, now);
      // 无痕与普通标签分开记、分开合并（R22-3）：list 只给同一份看，无痕 partition 被 wipe 时无痕那几条作废
      const incognito = owner.tab?.incognito === true;
      const key = `${incognito ? "i" : "p"}|${origin ?? ""}|${frameOrigin ?? ""}|${perm}|${reason}`;
      const list = state.recentBlocked;
      const at = list.findIndex((e) => e.key === key);
      const count = (at >= 0 ? list[at].count : 0) + 1;
      if (at >= 0) list.splice(at, 1);
      list.unshift({ key, at: now(), origin, frameOrigin, permission: perm, reason, count, incognito });
      // 每个 partition 各自最多 MAX_RECENT_BLOCKED 条（R23-6）：超出的从同 partition 最老的开始挤掉，不挤对方 partition 的记录
      let sameSide = 0;
      for (let i = 0; i < list.length; i++) {
        if ((list[i].incognito === true) !== incognito) continue;
        sameSide += 1;
        if (sameSide > MAX_RECENT_BLOCKED) {
          list.splice(i, 1);
          i -= 1;
        }
      }
      if (quiet) return;
      const slot = state.overflowLog.take(`blocked:${perm}:${reason}`);
      if (!slot.log) return;
      const who = frameOrigin ? `页面内嵌的 ${hostOfOrigin(frameOrigin) || "（未知站点）"}（顶层 ${hostOfOrigin(origin ?? "") || "—"}）` : hostOfOrigin(origin ?? "") || "（非网页来源）";
      safeSystemLog(
        owner,
        "permission",
        `已自动拒绝${who}的「${permissionLabel(perm)}」权限请求（未弹提示）：${BLOCK_REASON_TEXT[reason] ?? reason}${overflowSuppressedNote(slot.suppressed)}`,
      );
    } catch (err) {
      log(`[browser] 记录被拒权限请求失败（已忽略）：${err?.message || err}`);
    }
  };

  // ── 询问用户 ──

  /**
   * 这几项里有任何一项还在冷却期内：返回原因（`"cooldown"` = 用户刚点了拒绝的 30 秒；`"cancel-streak"` = 连续取消太多次的短冷却；两者都在时报前者），都不在返回 `null`。
   * 「任何一项」的含义（第二十六轮 T-2）：同时问麦克风 + 摄像头的合称请求，只要其中一项在冷却，**整个请求**都被拒——同时要音视频的一次 `getUserMedia`，
   * 在 Electron 的请求处理器里只有一个布尔回答（`callback(true | false)`），没法只放行其中一项；而单独问另一项的请求不受影响（冷却键按独立权限记，一项的冷却不连坐另一项）。
   */
  const cooldownReason = (owner, origin, perms) => {
    const state = getPermissionState(owner.session, now);
    const t = now();
    const hit = (map) => perms.some((p) => (map.get(cooldownKeyOf(owner.tab, origin, p)) ?? 0) > t);
    if (hit(state.cooldown)) return "cooldown";
    if (hit(state.cancelCooldown)) return "cancel-streak";
    return null;
  };

  /**
   * 要问的这几项里，系统层挡住的麦克风 / 摄像头（macOS 隐私设置 / Windows 全局开关）；没传 getMediaAccessStatus 就是空。
   * `denied` = 用户（或默认）在系统设置里没放行，去设置里打开即可；`restricted` = 被系统策略限制（家长控制 / 设备管理 / 组织策略），用户自己改不了——话术不同（R22-3）。
   */
  const systemBlockedAtoms = (perms) => {
    // 每个原子只读一次系统状态（R23-6：此前 denied / restricted 各读一遍，两次之间状态变了会读出自相矛盾的两份）
    const statuses = perms.filter((p) => MEDIA_ATOMS.includes(p)).map((p) => [p, systemMediaStatus(p)]);
    return {
      denied: statuses.filter(([, s]) => s === "denied").map(([p]) => p),
      restricted: statuses.filter(([, s]) => s === "restricted").map(([p]) => p),
    };
  };

  /**
   * 系统层现在挡住的麦克风 / 摄像头：`{ platform, problems: [{ permission, status }] }`（status = `denied` / `restricted`）。
   * 给 `permissions list` 的「系统层」一行用（R22-3）：用户在 Flowship 里点了「允许」页面却仍拿不到流，往往是系统层没放行——AI 要能直接看到这一层，而不是只能猜。
   * 没传 `getMediaAccessStatus`（单测 / 不支持的平台）或读不到 = 没有问题可报（空数组）。
   */
  const systemMediaProblems = () => ({
    platform,
    problems: MEDIA_ATOMS.map((permission) => ({ permission, status: systemMediaStatus(permission) })).filter((x) => x.status === "denied" || x.status === "restricted"),
  });

  /**
   * @param {string[]} perms 这一次要问的独立权限名（通常 1 个；同时问麦克风和摄像头时是 2 个）。
   *   提示条 / 日志写的就是点「允许」之后授予的范围：1 个写它自己（麦克风 / 摄像头 / 定位…），2 个写合称 `media`（摄像头 + 麦克风）；
   *   「本会话一直允许」把这几项各记一条授予，没问到的那一项（如只问了麦克风时的摄像头）不受牵连。
   * @param {string} origin 提示 / 授予按这个 origin（被委托的嵌入框架请求时是**顶层**站点）
   * @param {{ frame?: string } | null} [extra] frame：请求实际来自的嵌入框架 origin（只用于提示条 / 日志的说明，不参与授予）
   */
  const askUser = (owner, perms, origin, extra = null) => {
    const { session, tab } = owner;
    const state = getPermissionState(session, now);
    const perm = perms.length > 1 ? MEDIA_PERMISSION : perms[0];
    const keyOf = (p) => cooldownKeyOf(tab, origin, p);
    // 冷却按每一项记：刚拒绝过「麦克风 + 摄像头」，30 秒内只要麦克风的请求也不重复弹
    const cooling = cooldownReason(owner, origin, perms);
    if (cooling !== null) {
      // 页面此时读到的是「被拒绝」，用户 / AI 却看不到任何提示——留一条（限速的）记录，说明是冷却而不是「提示弹不出来」
      noteBlocked(owner, perm, cooling, origin, extra?.frame ?? null);
      return Promise.resolve(false);
    }
    // 合并键（tab + origin + 权限）**不含框架**：被委托的嵌入框架按顶层 origin 授予，顶层与 iframe（或几个 iframe）同时要同一项权限，用户的一次回答对它们都一样——
    // 只弹一个提示（提示条上「由页面内嵌的 X 发起」写的是先到的那个框架；R22-3 评审点出，维持不拆：拆开会对同一项授予连弹几次）。
    const key = keyOf(perm);
    let pending = state.pendingAsk.get(key);
    if (!pending) {
      tabStateOf(tab).session = session;
      const sysBlocked = systemBlockedAtoms(perms);
      const via = extra?.frame ? `（由页面内嵌的 ${hostOfOrigin(extra.frame) || "未知站点"} 发起）` : "";
      pending = session.prompts
        .request({
          kind: "permission",
          tabId: tab.id,
          host: hostOfOrigin(origin),
          detail: {
            permission: perm,
            origin,
            ...(extra?.frame ? { frame: extra.frame } : {}),
            ...(sysBlocked.denied.length > 0 ? { systemDenied: sysBlocked.denied.join(",") } : {}),
            ...(sysBlocked.restricted.length > 0 ? { systemRestricted: sysBlocked.restricted.join(",") } : {}),
            ...(sysBlocked.denied.length > 0 || sysBlocked.restricted.length > 0 ? { platform } : {}),
          },
          timeoutMs: PERMISSION_PROMPT_TIMEOUT_MS,
        })
        .then((ans) => {
          state.pendingAsk.delete(key);
          const label = permissionLabel(perm);
          /** 用户回答了（允许 / 拒绝）或超时：这几项连续取消的计数到此为止（计数按独立权限记，与冷却同口径） */
          const endStreak = () => {
            for (const p of perms) state.cancelStreak.delete(keyOf(p));
          };
          if (ans?.action === "allow" || ans?.action === "allow-session") {
            endStreak();
            if (ans.action === "allow-session") for (const p of perms) state.grantsFor(tab).allow(origin, p, "user");
            safeSystemLog(owner, "permission", `用户${ans.action === "allow-session" ? "在本会话内一直允许" : "允许了一次"}${hostOfOrigin(origin)}的「${label}」权限${via}`);
            return true;
          }
          // R6-19：名额满（overflow）不是用户的决定：不进冷却（名额空出后同一来源仍要能被询问）、文案不写「无人处理」。
          // 但没有冷却就没有天然的去重——页面循环请求会让每次都走到这里，所以 overflow 的**日志**单独限速（每会话每 60 秒一条，其余只计数）：
          // 活动日志是 500 条的环形缓冲，逐次写会把真实的用户 / 系统条目挤掉。限速只管日志，决策（拒绝）不变。
          // R23-4：页面此时读到的是「被拒绝」（桩仍会让它读到 prompt），用户 / AI 要能在 `permissions list` 里查到原因——进「最近被自动拒绝」清单（日志上面已经写了，不重复写）。
          if (ans?.overflow) {
            noteBlocked(owner, perm, "prompt-overflow", origin, extra?.frame ?? null, { quiet: true });
            const slot = state.overflowLog.take("permission");
            if (slot.log) {
              safeSystemLog(owner, "permission", `提示太多，已按默认拒绝${hostOfOrigin(origin)}的「${label}」权限请求${overflowSuppressedNote(slot.suppressed)}`);
            }
            return false;
          }
          // 第二十二轮 R22-2：提示被**取消**（页面导航走了 / 标签页关闭 / 会话销毁）不是用户的决定：不进 30 秒冷却、不写「已拒绝」——
          // 否则用户没看清提示就刷新页面，同一 tab + origin + 权限的冷却键还在，刷新后页面再请求会被静默拒绝（还不留任何可见记录）。
          // 这一次请求本身照常拒绝（提示已经不在了）；页面之后重新发起请求会正常再弹。
          // 第二十三轮 R23-1：不进冷却也就没有天然的去重——页面循环 `getUserMedia(); location.reload()` 时每一轮都再弹一次、再写一条日志。两层处理：
          //  · 日志走限速（与 overflow 同一个限速器，每 60 秒一条、其余只计数）；
          //  · 同键**连续**取消 CANCEL_STREAK_LIMIT 次（间隔 ≤ CANCEL_STREAK_WINDOW_MS）后给 CANCEL_COOLDOWN_MS 的短冷却（单独一张表，话术是「连续被取消」而不是「被拒绝」）。
          // 第二十四轮 P3-4：计数与冷却同口径，**按独立权限各记一份**——同时问麦克风 + 摄像头的请求对两项各记一次，任何一项连续取消到上限就触发；
          // 此前计数按合称 `media` 记、冷却按原子记，页面轮换请求形态（只要麦克风 / 麦克风 + 摄像头…）时各数各的，要多轮才触发。
          // 第二十五轮 N-5：触发时**只给计数到了上限的那几项**进短冷却；同一次请求里问到、但自己没到上限的项（例如麦克风连续取消 3 次、摄像头只在这一次里被问到）
          // 计数照常累加、不进冷却——它自己没有连续被取消到上限，不该因为跟着别人一起被问就被静默拒绝 10 秒（此前第二十四轮写成「这次问到的各项一起进冷却」，评审指出摄像头会被连坐，已改）。
          // 限定（第二十六轮 T-2）：「不连坐」只对**单独问那一项**的请求成立；之后若再发「麦克风 + 摄像头」的合称请求，只要其中一项在冷却整个请求仍被拒（见 `cooldownReason`：
          // 一次合称请求在 Electron 里只有一个布尔回答、没法部分放行）。话术同口径（第二十六轮 T-1）：只列真正进了短冷却的那几项，不用合称 label 让人以为没到上限的那项也被暂停了。
          // 触发后的稳态仍是每 CANCEL_COOLDOWN_MS + 几秒弹 CANCEL_STREAK_LIMIT 次（短冷却过后页面重新发起请求照常再弹，这是有意的：用户可能真的想授权，不能永久静默），没有被压到 0。
          if (ans?.cancelled) {
            const t = now();
            const counts = perms.map((p) => {
              const prev = state.cancelStreak.get(keyOf(p));
              return { p, n: prev && t >= prev.at && t - prev.at <= CANCEL_STREAK_WINDOW_MS ? prev.n + 1 : 1 };
            });
            const trippedAtoms = counts.filter((c) => c.n >= CANCEL_STREAK_LIMIT).map((c) => c.p);
            const tripped = trippedAtoms.length > 0; // 只驱动日志话术与限速桶（「连续被取消」还是普通「已取消」）
            // 触发话术里的权限名：全部项都到了上限就用本次请求的名字（合称写「摄像头 + 麦克风」），只有部分项到了就只写那几项（例如只写「麦克风」）
            const trippedLabel = trippedAtoms.length === perms.length ? label : trippedAtoms.map((p) => permissionLabel(p)).join("、");
            for (const { p, n } of counts) {
              if (n >= CANCEL_STREAK_LIMIT) {
                state.cancelStreak.delete(keyOf(p));
                putBounded(state.cancelCooldown, keyOf(p), t + CANCEL_COOLDOWN_MS, (until) => until <= t);
              } else {
                putBounded(state.cancelStreak, keyOf(p), { n, at: t }, (v) => t < v.at || t - v.at > CANCEL_STREAK_WINDOW_MS);
              }
            }
            const slot = state.overflowLog.take(tripped ? "cancel-streak" : "cancel");
            if (slot.log) {
              const note = cancelSuppressedNote(slot.suppressed);
              safeSystemLog(
                owner,
                "permission",
                tripped
                  ? `${hostOfOrigin(origin)}的「${trippedLabel}」权限提示连续被取消 ${CANCEL_STREAK_LIMIT} 次（页面反复刷新或离开），暂停 ${CANCEL_COOLDOWN_MS / 1000} 秒不再弹提示${via}${note}`
                  : `${hostOfOrigin(origin)}的「${label}」权限提示已取消（页面离开或标签页关闭），不算拒绝${via}${note}`,
              );
            }
            return false;
          }
          endStreak();
          // 第二十三轮 R23-4：60 秒无人处理（超时）按拒绝，但**不进冷却**——用户根本没看到 / 没处理这个提示，再让他干等 30 秒才能被问第二次，就是原始痛点（页面要麦克风、却弹不出提示）的变种。
          // 页面之后重新发起请求会再弹。每个提示最多 60 秒才出一次这条日志，天然不会刷屏。
          if (ans?.timedOut) {
            safeSystemLog(owner, "permission", `无人处理，已自动拒绝${hostOfOrigin(origin)}的「${label}」权限请求${via}（超时不进冷却，页面重新发起请求会再弹提示）`);
            return false;
          }
          // 用户明确点了拒绝：30 秒内同一 tab + origin + 权限不再重复弹
          const deniedAt = now();
          for (const p of perms) putBounded(state.cooldown, keyOf(p), deniedAt + PERMISSION_COOLDOWN_MS, (until) => until <= deniedAt);
          safeSystemLog(owner, "permission", `已拒绝${hostOfOrigin(origin)}的「${label}」权限请求${via}`);
          return false;
        });
      state.pendingAsk.set(key, pending);
    }
    return pending;
  };

  // ── 跨源子框架的委托核对 ──

  /**
   * 跨源子框架（origin ≠ 顶层）里的麦克风 / 摄像头请求：顶层页面是否把这几项**委托**给了这个框架（`<iframe allow="microphone">` / Permissions-Policy 头）。
   * 在框架自己的隔离世界里问 `document.permissionsPolicy.allowsFeature(...)`（Chromium 算好的结果，含整条嵌套链；页面改不到隔离世界）。
   * 同一 origin 有多个框架时要求**全部**被委托（保守）：已经回应的框架里有一个没委托就是 `"no"`；全都委托了但页面里还有同 origin 的框架**存在却还没有可查的隔离世界**
   * （请求者可能恰好就是它——别的框架的答复代表不了它，R22-3），就继续等，等到 {@link FRAME_DELEGATION_TOTAL_MS} 仍没齐则 `"unknown"`（拒绝）。
   * 框架的上下文还没建好就隔 {@link FRAME_DELEGATION_POLL_MS} 重试，总共最多 {@link FRAME_DELEGATION_TOTAL_MS}。
   * **总时限是硬的**（R23-5）：每一次页内取值 / 清单读取的超时都不超过「剩余时间」，`evalInFrames` 还带总时限（框架很多又都卡死时不再按批累加）——此前 deadline 只在循环尾部检查，
   * 100 个卡死的框架会让权限回调悬挂约 19 秒。缺 `evalInFrames` 或缺 `frameInventory`（没法确认同 origin 的兄弟框架都回应了）都按核对不出来处理（fail closed，两者同口径）。
   * 同一 tab 上同一框架 origin + 权限的并发核对合并成一次（{@link frameDelegation}）。
   * 返回 `"yes"`（委托了）/ `"no"`（核对出来：没委托）/ `"unknown"`（核对不出来：取不到框架 / CDP 不可用 / 超时）——后两者都拒绝，区别只在给用户的话术。
   */
  const checkFrameDelegation = async (owner, frameOrigin, atoms) => {
    const tab = owner.tab;
    if (typeof tab.evalInFrames !== "function" || typeof tab.frameInventory !== "function") return "unknown";
    const source = delegationProbeSource(atoms);
    const deadline = now() + FRAME_DELEGATION_TOTAL_MS;
    /** 距离总时限还剩多少（至少 1ms，免得传 0 / 负数给下游的超时参数） */
    const left = () => Math.max(1, deadline - now());
    for (;;) {
      let rows = [];
      try {
        rows = await tab.evalInFrames(source, { timeoutMs: Math.min(FRAME_DELEGATION_EVAL_TIMEOUT_MS, left()), totalMs: left() });
      } catch {
        rows = [];
      }
      if (!alive(owner)) return "unknown";
      // null = 调试连接没就绪（`evalInFrames` 立刻放弃了）：没必要空转到期限；顺手触发一次自愈重连（不等它），稍后重试就能核对了（R23-3）
      if (rows === null) {
        kickCdpHeal(tab);
        return "unknown";
      }
      const answered = (Array.isArray(rows) ? rows : []).filter((r) => r?.value && typeof r.value === "object" && originOf(r.value.href) === frameOrigin);
      const mine = answered.map((r) => r.value);
      if (mine.length > 0) {
        if (mine.some((v) => v.ok !== true)) return "no";
        // 全都委托了：再确认页面里同 origin 的框架没有「存在却还没回应」的（清单取不到就按核对不出来处理）
        let inventory = null;
        try {
          inventory = await tab.frameInventory({ timeoutMs: Math.min(FRAME_DELEGATION_EVAL_TIMEOUT_MS, left()) });
        } catch {
          inventory = null;
        }
        if (!alive(owner)) return "unknown";
        if (!Array.isArray(inventory)) return "unknown";
        const answeredIds = new Set(answered.map((r) => String(r.key).slice(String(r.key).indexOf(":") + 1)));
        const missing = inventory.filter((f) => originOf(f?.url) === frameOrigin && !answeredIds.has(f.id));
        if (missing.length === 0) return "yes";
      }
      if (now() + FRAME_DELEGATION_POLL_MS > deadline) return "unknown";
      await sleep(FRAME_DELEGATION_POLL_MS);
    }
  };

  /**
   * 委托核对入口：同一 tab 上同一框架 origin + 权限的并发请求共用一次核对（R23-5：一个页面同时起好几个同源 iframe 都要麦克风时，此前每个请求各自轮询、各自占调试通道）。
   * 共用的是「这一轮核对的结论」；每个请求回来后仍各自检查页面有没有换过文档（navEpoch）。
   * 第二十四轮 P3-3：键里带 `navEpoch`——页面换过文档之后的新请求不并入旧文档那一轮（它拿到的会是旧文档框架的结论）。
   */
  const frameDelegation = (owner, frameOrigin, atoms) => {
    const ts = tabStateOf(owner.tab);
    const key = `${ts.navEpoch}|${frameOrigin}|${atoms.join(",")}`;
    const have = ts.delegationInflight.get(key);
    if (have) return have;
    const p = checkFrameDelegation(owner, frameOrigin, atoms).finally(() => {
      if (ts.delegationInflight.get(key) === p) ts.delegationInflight.delete(key);
    });
    ts.delegationInflight.set(key, p);
    return p;
  };

  /**
   * 调试连接没就绪（渲染进程崩溃重载 / debugger 掉线，`tab.cdpReady` 为假）时由权限闸触发一次自愈重连（`tab.ensureCdp()`），**不等它**：
   * 这一次请求仍按「核对不出来」拒绝，但之后（页面再请求 / 用户刷新重试）就能核对了——此前只有下一次 AI 操作的 `ensureCdp` 才会恢复，用户自己浏览时 iframe 的麦克风请求会一直 `frame-check-failed`（R23-3）。
   * 同一 tab 同一时刻只一次，两次之间至少隔 {@link CDP_HEAL_MIN_INTERVAL_MS}（重连失败也不能被页面的权限请求循环触发成风暴）。
   */
  const kickCdpHeal = (tab) => {
    if (typeof tab.ensureCdp !== "function") return;
    const ts = tabStateOf(tab);
    const t = now();
    if (ts.cdpHealing || (t >= ts.cdpHealAt && t - ts.cdpHealAt < CDP_HEAL_MIN_INTERVAL_MS)) return;
    ts.cdpHealAt = t;
    ts.cdpHealing = (async () => {
      try {
        await tab.ensureCdp();
        log(`[browser:${tab.id}] 嵌入框架权限核对发现调试连接未就绪，已触发重连`);
      } catch (err) {
        log(`[browser:${tab.id}] 嵌入框架权限核对触发的调试连接重连失败：${err?.message || err}`);
      } finally {
        ts.cdpHealing = null;
      }
    })();
  };

  // ── Electron 回调 ──

  /** `session.setPermissionRequestHandler` 的处理函数：callback 恰好调一次，任何异常都拒绝 */
  const handleRequest = (wc, permission, callback, details) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        callback(ok === true);
      } catch (err) {
        log(`[browser] 权限回调失败（已忽略）：${err?.message || err}`);
      }
    };
    /** 判定 → 放行 / 拒绝 / 询问。`origin` 是按谁的授予表判（被委托的嵌入框架请求时 = 顶层站点），`frameOrigin` 只用于说明 */
    const decideAndAnswer = (owner, origin, frame, frameOrigin) => {
      // `details.mediaTypes`：只对 media 有意义（["audio"] / ["video"] / 两者），决定问麦克风、摄像头还是两个
      const v = evaluate(owner, permission, origin, frame, details?.mediaTypes);
      if (v.decision === "deny") {
        // 没走委托通道的跨源子框架（非 media 权限）：请求来源是框架、顶层是 frame.top，记录里按这个口径写
        const crossFrame = frameOrigin === null && v.reason === "cross-origin-frame";
        // 顶层页面自己是不透明来源（file: / about:blank …）时根本没有「顶层站点」可委托——话术按「来源不是普通网页」说，别误导成「用 allow 委托」（R23-6）
        const reason = crossFrame && frame.top === null ? "opaque-origin" : v.reason;
        noteBlocked(
          owner,
          v.perm === MEDIA_PERMISSION ? mediaPromptName(details?.mediaTypes) : v.perm,
          reason,
          crossFrame ? frame.top : origin,
          crossFrame ? origin : frameOrigin,
        );
        return done(false);
      }
      const finish = (allowed) => {
        if (!allowed) return done(false);
        if (v.perm !== "notifications") return done(true);
        // 通知：代理装好才授予
        void ensureNotifStub(owner.tab).then(done, () => done(false));
      };
      if (v.decision === "allow") return finish(true);
      void askUser(owner, v.askPerms ?? [v.perm], origin, frameOrigin ? { frame: frameOrigin } : null).then(
        (allowed) => finish(allowed && alive(owner)),
        () => done(false),
      );
    };
    try {
      const owner = wc ? deps.findOwner?.(wc) : null;
      if (!alive(owner)) return done(false);
      const origin = originOf(details?.requestingUrl);
      const top = originOf(owner.tab.url);
      const frame = { isMainFrame: details?.isMainFrame !== false, top };
      // 跨源子框架里的麦克风 / 摄像头：委托了就按顶层站点处理（见文件头 B），没委托 / 核对不出来拒绝并留一条记录
      if (canonicalPermission(permission) === MEDIA_PERMISSION && !frame.isMainFrame && origin !== null && top !== null && origin !== top && !isAppOrigin(top) && !isAppOrigin(origin)) {
        const atoms = mediaAtomsOf(details?.mediaTypes);
        const epoch = tabStateOf(owner.tab).navEpoch;
        void frameDelegation(owner, origin, atoms).then(
          (verdict) => {
            try {
              if (!alive(owner)) return done(false);
              // 核对最长要等几秒：期间页面导航走了，这个请求属于已经不存在的旧页面——不再往下弹提示 / 授予（否则提示条上是旧站点、用户却已经在新站点；R22-3）。
              // 第二十三轮 R23-5：此前只比顶层 origin，**同 origin 重载**时比不出来（`cancelMine` 在导航那一刻就跑完了、当时还没有提示可取消），旧文档的请求会在新文档上弹提示——
              // 现在比导航计数（主框架每一次跨文档导航 +1）。R23-4：留一条（限速的）记录进清单，页面此刻读到的是被拒绝，AI 得能查到原因。
              if (tabStateOf(owner.tab).navEpoch !== epoch || originOf(owner.tab.url) !== top) {
                log(`[browser:${owner.tab.id}] 嵌入框架的权限请求在委托核对期间页面已导航，丢弃`);
                noteBlocked(owner, mediaPromptName(details?.mediaTypes), "navigated-during-check", top, origin);
                return done(false);
              }
              if (verdict !== "yes") {
                noteBlocked(owner, mediaPromptName(details?.mediaTypes), verdict === "no" ? "frame-not-delegated" : "frame-check-failed", top, origin);
                return done(false);
              }
              // 被委托：这一刻它就是「顶层站点自己在用」——按顶层的授予表 / 提示处理（isMainFrame 对 media 没有别的用途）
              decideAndAnswer(owner, top, { isMainFrame: true, top }, origin);
            } catch (err) {
              log(`[browser] 权限请求处理出错，已拒绝：${err?.message || err}`);
              done(false);
            }
          },
          () => done(false),
        );
        return;
      }
      decideAndAnswer(owner, origin, frame, null);
    } catch (err) {
      log(`[browser] 权限请求处理出错，已拒绝：${err?.message || err}`);
      done(false);
    }
  };

  /**
   * `session.setPermissionCheckHandler`：同步判断，不弹提示；只有决策是 `allow`（授予过 / 本来就放行）才回 true，`ask` / `deny` 一律当作「未授予」；wc 为 null（Service Worker 等）一律 false。
   *
   * **media 的检查绝不能因为「会弹提示」就回 true**（第二十二轮 R22-1，真 Electron 实测）：WebRTC 收集 ICE 候选时走的是**同一条**检查（`details` 形状与 `permissions.query()` 一样，没法区分），
   * 任一的 audio / video 回 true，`new RTCPeerConnection()` 就会把本机真实的内网 / 公网 IP 作为 host 候选交给页面——不经任何授权；回 false 时只有 mDNS 的 xxx.local。
   * 页面 `permissions.query()` 读到的 denied（页面「先 query 再发请求」写法因此永远弹不出提示）改由页内小桩改成 prompt，见 {@link MEDIA_QUERY_STUB_SOURCE}。
   */
  const handleCheck = (wc, permission, requestingOrigin, details) => {
    try {
      const owner = wc ? deps.findOwner?.(wc) : null;
      if (!alive(owner)) return false;
      const origin = originOf(requestingOrigin) ?? originOf(details?.requestingUrl);
      const top = originOf(owner.tab.url);
      // embeddingOrigin：`permissions.query` 形状的检查里都带（顶层页面自己的检查也带，值 = 顶层 origin）；
      // 它与请求来源不同 = 被别的站点嵌着，一律不当作顶层站点自己的框架
      const embedding = originOf(details?.embeddingOrigin);
      const forceCross = embedding !== null && embedding !== origin;
      const isMainFrame = details?.isMainFrame !== false && !forceCross;
      // `details.mediaType`（audio / video / unknown）：只对 media 有意义；该类型没授予就不报 granted（unknown = 两个都得授予过）
      const v = evaluate(owner, permission, origin, { isMainFrame, top, forceCross }, details?.mediaType);
      if (v.decision === "allow") {
        // 通知：代理没装好时不报告已授予（否则页面会读到 granted 然后直接弹真通知）
        if (v.perm === "notifications" && !tabStateOf(owner.tab).notifReady) return false;
        return true;
      }
      return false;
    } catch (err) {
      log(`[browser] 权限检查出错，已拒绝：${err?.message || err}`);
      return false;
    }
  };

  // ── tab 绑定 ──

  /** 每个 tab 创建后调一次：定位模拟的 origin 绑定、导航 / 销毁时作废本 tab 的权限提示 */
  const bindTab = (tab) => {
    const ts = tabStateOf(tab);
    tab.addEmulationHook?.(({ next, prev, patch }) => {
      if (!next?.geolocation) {
        ts.geoOrigin = null;
        ts.geoPending = false;
        return;
      }
      // 只有「这次设置动了定位」才重绑（模拟 UA / 视口时不改变定位绑定的 origin）
      if (patch?.geolocation === undefined && prev?.geolocation) return;
      const cur = originOf(tab.url);
      ts.geoOrigin = cur;
      ts.geoPending = cur === null;
    });
    const cancelMine = () => {
      const session = ts.session;
      if (!session || session.destroyed) return;
      try {
        session.prompts.cancelWhere((p) => p.kind === "permission" && p.tabId === tab.id);
      } catch {
        // 会话正在销毁：提示已由 dispose 结算
      }
    };
    tab.addDestroyHook?.(cancelMine);
    // 第二十二轮 R22-1：页内 `permissions.query` 桩（文件头 A）。每个 CDP 会话（主会话 + OOPIF 子会话）初始化时装一遍，调试连接自愈重连后会重放；
    // 装不上：页面退回读到 denied（= 第二十一轮之前的行为），不影响其它权限路径。
    // 第二十三轮 R23-3：注册成**早钩子**（`addEarlySessionHook`：与各域 enable 并行发、不等 setup 末尾，跨站 iframe 里桩比页面第一批脚本先到位的机会更大；没有早钩子的 tab 退回普通会话钩子），
    // 装不上除了日志，还记进 tab 状态（`permissions list` 的 queryStub）并写一条限速的活动记录——这是 Flowship 自己的盲区，用户 / AI 在别处看不到。
    const registerStubHook = typeof tab.addEarlySessionHook === "function" ? tab.addEarlySessionHook.bind(tab) : tab.addSessionHook?.bind(tab);
    registerStubHook?.(async (sessionId) => {
      // 每次桩钩子开头顺手对一遍当前会话表、修剪已经不存在的子会话记录（第二十五轮 N-6）：自愈重连直接清子会话表、不产生 detach 事件，
      // 此前这些旧记录要等到下一次 `permissions list` 或有失败被记时才被修剪；重连后主会话的这个钩子最先跑（量很小，只是不留到别处才清）
      pruneStubSessions(tab, ts);
      try {
        await installQueryStub(tab, sessionId);
        ts.queryStubProblems.delete(sessionId ?? "main");
      } catch (err) {
        // tab 已销毁（OAuth 之类的弹窗一出来就关）：已经在飞的安装失败是必然的，不是桩真的装不上——不写误导的「桩装不上」日志 / 状态 / 活动记录（第二十六轮 T-6；
        // tab 里的早钩子销毁守卫只挡「还没开始」的钩子，已经发出命令的这一个挡不住）
        if (tab.destroyed === true) return;
        noteStubProblem(tab, sessionId ?? "main", err);
      }
    });
    // 子会话（OOPIF）detach 后：它装过的新文档脚本记录 / 失败记录随会话作废（页面反复跨站导航时不让这两张表慢慢涨大，R23-4）
    tab.onCdpEvent?.((method, params) => {
      if (method !== "Target.detachedFromTarget") return;
      const sid = params?.sessionId;
      if (typeof sid !== "string" || sid === "") return;
      ts.queryStubScripts.delete(sid);
      ts.queryStubProblems.delete(sid);
    });
    const wc = tab.wc;
    // 与 tab.mjs 同一签名：Electron 42 的 did-start-navigation 第一个参数就是带 isMainFrame / isSameDocument 的 details
    wc?.on?.("did-start-navigation", (details) => {
      if (details?.isMainFrame === true && details.isSameDocument !== true) {
        ts.navEpoch += 1;
        cancelMine();
      }
    });
    // 第二十四轮 P3-3：导航**提交**时再加一次计数、再取消一次本 tab 的提示（开始导航时已经做过一次）。
    // 为什么：开始到提交之间，旧文档里的请求（含核对中的）拿到的是「开始时」加过的新计数，提交之后比不出它属于旧文档；
    // 在提交这一刻再加一，这些请求核对回来就会被判成旧文档的、不再弹提示 / 授予（提交之后新文档发起的请求拿到的是提交后的计数，不受影响）。
    wc?.on?.("did-navigate", (_e, url) => {
      ts.navEpoch += 1;
      cancelMine();
      if (!ts.geoPending) return;
      const o = originOf(url);
      if (!o) return;
      ts.geoOrigin = o;
      ts.geoPending = false;
    });
  };

  /**
   * AI 授予通知后：把当前就在该 origin 上的 tab 的通知代理预先装好
   * （页面常常先读 `Notification.permission` 再决定要不要请求；代理没装好时 check 处理器会如实报「未授予」）。
   * 返回实际装好的 tab 数。
   */
  const prepareGrant = async (session, origin, permission) => {
    if (permission !== "notifications") return 0;
    let n = 0;
    for (const tab of session.tabs ?? []) {
      if (tab.destroyed || originOf(tab.url) !== origin) continue;
      if (await ensureNotifStub(tab)) n += 1;
    }
    return n;
  };

  return {
    handleRequest,
    handleCheck,
    bindTab,
    prepareGrant,
    ensureNotifStub,
    systemMediaProblems,
    queryStubProblems,
    /** 单测 / 诊断：策略当前认为「定位模拟生效」的 origin 列表 */
    emulatedGeolocationOrigins: geoOriginsOf,
  };
};
