/**
 * 敏感输入字段的统一判定（R1-25）：密码 / 一次性验证码 / 银行卡类 / 被遮罩渲染的字段。
 *
 * 以前三处各写一份且口径漂移：ops/input.mjs 的 isSecretField 缺 cc-*；activity-log 的判定与页内 page-scripts 各一套；
 * ax-snapshot 的 refValue 只遮「全圆点」值，OTP / 卡号 / -webkit-text-security 字段原样输出。现在全部以本文件为唯一规则来源：
 *
 * - `isSecretInfo(info)`：纯函数，入参 `{ type, autocomplete, textSecurity }`（都是字符串，缺省当空）。**函数体自包含、不引用任何
 *   模块作用域变量**——主进程直接 import 用；页内脚本（page-scripts / page-read 的 inspect / picker 探针 / actions 的输入探针）
 *   把它的 `toString()` 源码嵌进去用，两边跑的是同一份代码，不可能漂移。
 * - `readSecretInfo(el)`：页内适配器，从 DOM 元素读出上面三个字段（type 属性、autocomplete 属性、computed 的
 *   `-webkit-text-security`）。同样自包含、只在页内执行。
 * - `SECRET_FIELD_FNS_SOURCE`：以上两个函数的声明源码（可直接拼进页内脚本）。
 *
 * 规则（任一命中即敏感）：
 * 1. type=password；
 * 2. autocomplete 的某个 token 是 current-password / new-password / one-time-code，或以 `cc-` 开头（信用卡全家：number / csc / exp …）；
 * 3. computed `-webkit-text-security` 为 disc / circle / square（页面用 CSS 把普通 text 框画成密码框）。
 */

/** 主进程对密码 / 验证码类字段的固定拒绝文案。server 侧 tools.ts 有一份同文案，测试钉死两份相等。 */
export const PASSWORD_REJECT_MESSAGE =
  "这是密码 / 验证码类输入框，AI 不会代填（避免口令进入对话上下文）。请调用 browser_ask_user_to_act 请用户自己输入，用户完成后再继续";

/** press_key 在焦点是敏感字段（或无法确认焦点是否敏感）时拒绝「会输入 / 粘贴 / 剪切 / 复制文本」的按键 */
export const SECRET_PRESS_KEY_MESSAGE =
  "当前焦点是密码 / 验证码 / 银行卡类输入框，AI 不会往里按字符键，也不会在里面粘贴 / 剪切 / 复制（避免口令进入对话上下文）。请调用 browser_ask_user_to_act 请用户自己输入；Enter / Tab / Escape 等功能键与其它 Ctrl/Cmd 组合键不受限制";

/** 焦点落在无法检查的跨域 iframe 里：确认不了是不是敏感字段，宁可拒绝 */
export const UNKNOWN_FOCUS_PRESS_KEY_MESSAGE =
  "焦点在无法检查的内嵌框架（iframe）里，无法确认是否是密码 / 银行卡类输入框，所以拒绝按字符键（含粘贴 / 剪切 / 复制）。请让用户操作（browser_ask_user_to_act），或先点击页面里 iframe 之外的位置再按键；iframe 内的输入框也可先 browser_snapshot 后对它传 ref";

/** type：探针本身没给出明确结论（既不是 secret:true 也不是 secret:false）——fail-closed，不输入（R2-03） */
export const UNKNOWN_FIELD_TYPE_MESSAGE =
  "无法确认这个输入框是不是密码 / 验证码 / 银行卡类字段（页面探针没有给出结论），所以拒绝输入。请重新 browser_snapshot 后再试；若确实是密码 / 验证码请改用 browser_ask_user_to_act";

/** type：聚焦之后真正拿到焦点的元素不是 ref 本身（ref 指向包着密码框的容器等），且焦点是敏感字段 / 确认不了（R2-03） */
export const UNKNOWN_FOCUS_TYPE_MESSAGE =
  "聚焦后焦点落在了无法检查的内嵌框架（iframe）里，无法确认是不是密码 / 银行卡类输入框，所以拒绝输入。请让用户操作（browser_ask_user_to_act），或先点击页面里 iframe 之外的位置；iframe 内的输入框也可先 browser_snapshot 后对它传 ref 再 browser_type";

/** drag：拖放目标（落点处的元素）是敏感字段——不允许 AI 往里拖入文字（与 type 同类，R2-03） */
export const SECRET_DROP_MESSAGE =
  "拖放 / 鼠标释放 / 中键点击（Linux 下是粘贴）的目标是密码 / 验证码 / 银行卡类输入框，AI 不会往里拖入或粘贴内容（避免口令进入对话上下文）。请调用 browser_ask_user_to_act 请用户自己操作";

/** drag：落点处在无法检查的跨域 iframe 里，确认不了是不是敏感字段，宁可拒绝 */
export const UNKNOWN_DROP_MESSAGE =
  "拖放 / 鼠标释放 / 中键点击的落点处在无法检查的内嵌框架（iframe）里，无法确认是否是密码 / 银行卡类输入框，所以拒绝。请让用户自己操作（browser_ask_user_to_act），或换一个不在 iframe 内的落点";

/**
 * 鼠标键仍处于按下状态（`browser_mouse action=down` 之后还没 up）时，其它会派发鼠标 / 触摸事件的工具（click / type 的点击兜底 / fill_form / drag / upload 点按钮 /
 * hover / touch）一律拒绝：click 类的 `mouseReleased` 会在**点击位置**结束之前按住的拖放（文字可能被拖进密码框），而落点没有经过探针（R6-30 三轮复审②）；
 * hover 的 `mouseMoved` 与触摸手势（可能合成兼容鼠标事件）会把指针挪到没检查过的位置（R6-30 四轮复审 P3①，推导、未实证，按 fail-closed 一并拒）。
 */
export const HELD_BUTTON_CLICK_MESSAGE =
  "鼠标键仍处于按下状态（browser_mouse action=down 之后还没 up）：此时再点击 / 拖动 / 悬停 / 触屏会在没检查过的位置移动或结束按住的拖放（文字可能被拖进密码 / 验证码输入框），所以拒绝。请先用 browser_mouse 在非敏感位置 action=up 释放（落点会先检查）再重试";

/**
 * 这个 tab 现在有没有 AI 按着没放的鼠标键（位掩码，0 = 没有）。
 * 读 `tab.heldButtonBits`（ops/input.mjs 在第一次 down 时挂上，直接读按下态，**不看过期**：空闲 120s / 导航之后的陈旧按下态在被补发 release 之前也算按着）。
 * 没挂过 = 从没按过 = 0；挂了但读取抛错 / 返回非数字 → 按「按着」（1，fail-closed）。纯函数，给 actions.mjs / ops/env.mjs 共用。
 */
export const heldButtonBitsOf = (tab) => {
  if (typeof tab?.heldButtonBits !== "function") return 0;
  try {
    const bits = tab.heldButtonBits();
    return typeof bits === "number" && Number.isFinite(bits) ? bits : 1;
  } catch {
    return 1;
  }
};

// 下面两个函数会被 toString() 嵌进页面主世界 / 隔离世界执行，刻意写成 ES5 朴素语法（var / 无箭头函数 / 无模块级引用）

/**
 * 统一判定。自包含：toString() 之后能原样在页面里跑。
 * @param {{ type?: string, autocomplete?: string, textSecurity?: string, uncertain?: boolean } | null | undefined} info
 * @returns {boolean}
 */
export function isSecretInfo(info) {
  if (!info || typeof info !== "object") return false;
  // 读取过程中有任何一项抛了错（页面覆盖了 getAttribute / getComputedStyle，或在实例上定义了会抛的 type 访问器）：判不出就按敏感（R2-03 复审①）
  if (info.uncertain === true) return true;
  var type = String(info.type == null ? "" : info.type).toLowerCase();
  if (type === "password") return true;
  var ts = String(info.textSecurity == null ? "" : info.textSecurity).toLowerCase();
  if (/(^|\s)(disc|circle|square)(\s|$)/.test(ts)) return true;
  var tokens = String(info.autocomplete == null ? "" : info.autocomplete)
    .toLowerCase()
    .split(/\s+/);
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (t === "current-password" || t === "new-password" || t === "one-time-code") return true;
    if (t.indexOf("cc-") === 0) return true;
  }
  return false;
}

/**
 * 页内适配器：DOM 元素 → isSecretInfo 的入参。只在页面里执行。
 * @param {any} el
 * @returns {{ type: string, autocomplete: string, textSecurity: string }}
 */
export function readSecretInfo(el) {
  var info = { type: "", autocomplete: "", textSecurity: "" };
  if (!el) return info;
  // 任何一项读取抛错都记 uncertain（isSecretInfo 对它返回 true）：此前每项都吞错并保留「非敏感」默认值，读取失败反而等于放行（R2-03 复审①）。
  // 注意这类探针跑在页面主世界（callOnNode），页面能把 getAttribute 等换成「不抛、直接说谎」的版本——那条路挡不住，已写进 §14.9 已知缺口；
  // 这里只保证「读不出来」不会被当成「读出来是安全」。
  try {
    // 非元素节点（document / window / 文本节点）不可能是输入框：不读样式（getComputedStyle(document) 会抛，不能因此判成不确定）
    var nodeType = el.nodeType;
    if (nodeType !== undefined && nodeType !== 1) return info;
  } catch {
    info.uncertain = true;
  }
  // type 同时看 DOM 属性与 type 属性（页面把元素上的 type 访问器改掉也骗不过；password 以任一为准）
  var propType = "";
  var attrType = "";
  try {
    propType = String(el.type == null ? "" : el.type).toLowerCase();
  } catch {
    info.uncertain = true;
  }
  try {
    attrType = String((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
  } catch {
    info.uncertain = true;
  }
  info.type = propType === "password" || attrType === "password" ? "password" : propType || attrType;
  try {
    info.autocomplete = String((el.getAttribute && el.getAttribute("autocomplete")) || "");
  } catch {
    info.uncertain = true;
  }
  try {
    var view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var cs = view && typeof view.getComputedStyle === "function" ? view.getComputedStyle(el) : getComputedStyle(el);
    var ts = cs.webkitTextSecurity;
    if (!ts && typeof cs.getPropertyValue === "function") ts = cs.getPropertyValue("-webkit-text-security");
    info.textSecurity = String(ts || "");
  } catch {
    info.uncertain = true;
  }
  return info;
}

/** 两个函数的声明源码：拼进页内脚本里即可用（先 isSecretInfo 后 readSecretInfo）。 */
export const SECRET_FIELD_FNS_SOURCE = `${isSecretInfo.toString()}\n${readSecretInfo.toString()}`;

/**
 * R6-36：「框架类元素」= 能承载另一份文档的元素：iframe / frame / object / embed / fencedframe。
 * 以前三个框架探针（本文件的焦点 / 落点探针、closed-shadow.mjs 的 CDP 复核、record-policy.mjs 的可见敏感框探针）都只认 iframe / frame，
 * `<object type="text/html">` / `<embed>` / `<fencedframe>` 被当普通元素判 safe——它们同样能装一份（跨域）文档，里面的密码 / 验证码框我们看不见。
 * 约定（三处一致）：框架类元素只有 `contentDocument` 读得进才下钻；读不进（跨域 / 沙箱 / `<embed>` 与 `<fencedframe>` 本来就没有 contentDocument）
 * 一律按「无法检查」——焦点 / 落点探针给 unknown，录制探针计 opaque（可见则丢帧）。
 */
export const FRAME_TAGS = Object.freeze(["iframe", "frame", "object", "embed", "fencedframe"]);

/**
 * 标签名是不是框架类元素（自包含：toString() 之后能原样嵌进页内探针，刻意写成 ES5 朴素语法，列表与 {@link FRAME_TAGS} 同步，测试钉死）。
 * R6-30 ④：调用方传 `el.localName || el.tagName`——XHTML 文档里带命名空间前缀的 `<h:iframe>`，`tagName` 是 `H:IFRAME`、只有 `localName` 是 `iframe`，
 * 只看 tagName 会把它当普通元素判 safe。
 * @param {unknown} tag
 * @returns {boolean}
 */
export function isFrameLikeTag(tag) {
  var t = String(tag == null ? "" : tag).toLowerCase();
  return t === "iframe" || t === "frame" || t === "object" || t === "embed" || t === "fencedframe";
}

/** isFrameLikeTag 的声明源码：拼进页内探针 / callFunctionOn 的函数体里即可用 */
export const FRAME_TAG_FN_SOURCE = isFrameLikeTag.toString();

/**
 * 页内「当前焦点是否敏感字段」探针（函数表达式源码，`this` 为某个元素时用其 ownerDocument，否则用 document）。
 * 逐层穿过 shadow root 与同源 iframe 找真正的焦点元素；跨域 iframe 看不进去 → 'unknown'（调用方按「拒绝」处理）。
 * 返回 'secret' | 'safe' | 'unknown'。
 */
export const ACTIVE_SECRET_PROBE_SOURCE = `function () {
  ${SECRET_FIELD_FNS_SOURCE}
  ${FRAME_TAG_FN_SOURCE}
  try {
    var doc = (this && this.ownerDocument) || document;
    var el = doc.activeElement;
    var guard = 0;
    while (el && guard++ < 20) {
      if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
      var tag = String(el.localName || el.tagName || '').toLowerCase();
      /* R6-36：iframe / frame / object / embed / fencedframe——contentDocument 读得进才下钻，读不进（含 embed / fencedframe 没有该属性）→ unknown */
      if (isFrameLikeTag(tag)) {
        var d = null;
        try { d = el.contentDocument; } catch (e) { d = null; }
        if (d && d.activeElement) { el = d.activeElement; continue; }
        return 'unknown';
      }
      break;
    }
    /* guard 耗尽（嵌套超过 20 层 shadow root / iframe）退出时 el 停在中间节点上，不能拿它当结果：与「探不出就拒」同口径（R4-02） */
    if (guard > 20) return 'unknown';
    if (!el) return 'safe';
    return isSecretInfo(readSecretInfo(el)) ? 'secret' : 'safe';
  } catch (e) { return 'unknown'; }
}`;

/**
 * 页内「拖放落点是不是敏感字段」探针（callFunctionOn 的函数源码，`this` 是 drag 的目标元素，(x, y) 是它所在 frame 内的落点坐标）。
 * 目标元素自己，或落点处真正会接收 drop 的元素（逐层穿过 shadow root 与同源 iframe）任一是敏感字段 → 'secret'；
 * 落点落在看不进去的跨域 iframe 里 / 探针异常 → 'unknown'（调用方按「拒绝」处理）。返回 'secret' | 'safe' | 'unknown'。
 * 标记词 DROP_TARGET_SECRET_PROBE 供测试夹具区分它与 OCCLUSION_FN（两者都含 elementFromPoint）。
 */
export const DROP_TARGET_SECRET_PROBE_SOURCE = `function (x, y) {
  /* DROP_TARGET_SECRET_PROBE */
  ${SECRET_FIELD_FNS_SOURCE}
  ${FRAME_TAG_FN_SOURCE}
  try {
    if (isSecretInfo(readSecretInfo(this))) return 'secret';
    var doc = (this && this.ownerDocument) || document;
    var el = doc.elementFromPoint(x, y);
    if (!el) return 'unknown'; /* 落点探不到元素（视口外 / 坐标系对不上）：与同文件「探不出按不确定拒」同口径（R2-03 复审②） */
    var guard = 0;
    while (el && guard++ < 20) {
      if (el.shadowRoot && typeof el.shadowRoot.elementFromPoint === 'function') {
        var inner = el.shadowRoot.elementFromPoint(x, y);
        if (inner && inner !== el) { el = inner; continue; }
      }
      var tag = String(el.localName || el.tagName || '').toLowerCase();
      /* R6-36：落点是框架类元素（含 object / embed / fencedframe）：contentDocument 读不进 → unknown */
      if (isFrameLikeTag(tag)) {
        var d = null;
        try { d = el.contentDocument; } catch (e) { d = null; }
        if (!d) return 'unknown';
        var r = el.getBoundingClientRect();
        var innerEl = d.elementFromPoint(x - r.left, y - r.top);
        if (innerEl) { el = innerEl; continue; }
        return 'unknown'; /* 同进程 iframe 里探不到元素（落点在边框 / 坐标系对不上）：按不确定拒，不拿 iframe 元素自己充数 */
      }
      break;
    }
    if (guard > 20) return 'unknown'; /* 同上：层数耗尽 = 没探到最深处（R4-02） */
    if (!el) return 'safe';
    return isSecretInfo(readSecretInfo(el)) ? 'secret' : 'safe';
  } catch (e) { return 'unknown'; }
}`;

/** 页内「this 元素是不是敏感字段」探针（callFunctionOn 的函数源码）；任何异常按敏感处理。snapshot 的值遮罩用它。 */
export const SECRET_ELEMENT_PROBE_SOURCE = `function () {
  ${SECRET_FIELD_FNS_SOURCE}
  try { return isSecretInfo(readSecretInfo(this)) === true; } catch (e) { return true; }
}`;
