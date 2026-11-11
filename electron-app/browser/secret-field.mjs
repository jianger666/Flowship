/**
 * 敏感输入字段的统一判定（R1-25）：密码 / 一次性验证码 / 银行卡类 / 被遮罩渲染的字段。
 *
 * 用途：**只用于「读」这一侧**——snapshot / inspect / read / picker 的值遮罩、活动日志与录屏的脱敏 / 丢帧，
 * 避免页面里已有的口令被读回对话上下文。**不限制 AI 往这类字段里输入**（type / fill_form / press_key / drag 都不检查它）。
 *
 * 以前三处各写一份且口径漂移：activity-log 的判定与页内 page-scripts 各一套；ax-snapshot 的 refValue 只遮「全圆点」值，
 * OTP / 卡号 / -webkit-text-security 字段原样输出。现在全部以本文件为唯一规则来源：
 *
 * - `isSecretInfo(info)`：纯函数，入参 `{ type, autocomplete, textSecurity }`（都是字符串，缺省当空）。**函数体自包含、不引用任何
 *   模块作用域变量**——主进程直接 import 用；页内脚本（page-scripts / page-read 的 inspect / picker 探针）
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
 * 读取侧的框架探针（closed-shadow.mjs 的 CDP 复核、record-policy.mjs 的可见敏感框探针）都要认它们：
 * `<object type="text/html">` / `<embed>` / `<fencedframe>` 同样能装一份（跨域）文档，里面的密码 / 验证码框我们看不见。
 * 约定：框架类元素只有 `contentDocument` 读得进才下钻；读不进（跨域 / 沙箱 / `<embed>` 与 `<fencedframe>` 本来就没有 contentDocument）
 * 一律按「无法检查」——录制探针计 opaque（可见则丢帧）。
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

/** 页内「this 元素是不是敏感字段」探针（callFunctionOn 的函数源码）；任何异常按敏感处理。snapshot 的值遮罩用它。 */
export const SECRET_ELEMENT_PROBE_SOURCE = `function () {
  ${SECRET_FIELD_FNS_SOURCE}
  try { return isSecretInfo(readSecretInfo(this)) === true; } catch (e) { return true; }
}`;
