/**
 * 页内脚本（契约 §2.6 / §8）：录制器 + 覆盖层的合并脚本，在隔离世界里运行。
 *
 * 为什么用「函数源码字符串化」而不是手写模板字符串：函数体能被 Node / ESLint
 * 正常解析，语法错误在加载期就暴露；拼字符串则要到注入页面时才炸。
 * 代价是函数体不能引用模块作用域的任何变量——需要的常量全部走参数传入。
 *
 * 函数体内的关键取舍（为压体积不在体内写长注释，统一记在这里）：
 * - 监听全部挂 window 的 capture 阶段并缓存原生 addEventListener：页面
 *   stopPropagation / 事后废掉 addEventListener 都挡不住（探针 T2 实测）。
 * - 光标动画用 CSS transition、呼吸发光用 Element.animate，都不用 rAF：
 *   隐藏窗口里 rAF 不触发会把动画卡死（探针 T3 实测）。
 * - 覆盖层样式只走 element.style、不插 <style>：严格 CSP 的 style-src
 *   会挡样式标签；host 用 closed shadow root + 不常见属性，不用显眼 id。
 * - 脱敏在页内完成：密码 / 验证码 / 卡号 / 遮罩渲染类字段连 value 都不外发，只发长度；判定规则来自 secret-field.mjs（R1-25），
 *   以函数源码形式作为第 3 / 4 个参数传进来，和主进程用的是同一份代码。
 * - 只信真实用户输入（R1-04）：每个 listener 首行判 `e.isTrusted`，页面脚本 dispatchEvent / el.click() 造的事件一律忽略；
 *   emit 再过一道令牌桶（约 20 条 / 秒），页面循环派发（即使是 trusted 的也不可能超过人类速度）冲不掉 500 条环形日志。
 * - UA 替页面派发的 trusted 事件（R2-05 / R3-01 / R3-04）：checkbox.click() 的 change、form.requestSubmit() 的 submit、el.focus() 的 focusin、
 *   execCommand('insertText') 的 input 都是 isTrusted=true（真机实测，见 scripts/browser-e2e/page-scripts.cjs 的 INFO 行）。focusin 不录
 *   （主进程本来就丢，只会耗令牌）；click / dblclick / contextmenu / 选择类 change / submit / input 都要求「最近 1 秒内有过 trusted 的
 *   按下类输入」才外发（markGesture / recentGesture），丢弃发生在 emit 之前、不占令牌。「按下类输入」只认 pointerdown / mousedown /
 *   keydown / touchstart（UA 不会替页面派发它们）；抬起类（pointerup / mouseup / keyup / touchend）只在此前见过按下时才续期（长按再松开），
 *   click 本身不算手势——`label.click()` 转发给关联控件的 click 在当前 Chromium 里是 isTrusted=false（真机实测），但这个取值是引擎行为，
 *   不能当协议依赖，所以把「手势」收口到按下类输入上（R3-01 纵深防御）。代价：没有任何指针 / 按键输入的无障碍「激活」点击不被记录。
 * - 名字（accessibleName）：只有按钮 / 链接 / 标题等「内容即名字」的元素才取自身 innerText，generic 容器不取（只借最近的按钮 / 链接祖先的名字）；
 *   装着编辑区的容器（含 label / aria-labelledby 指向的容器）一律不取，免得用户正在写的正文经由名字进日志（R1-05 / R2-05）。
 * - 按键只外发 Enter / Escape / Tab 与 Ctrl|Meta+字母（R1-03）：普通字符、Alt / AltGr 组合的字符根本不会越过 binding；
 *   敏感目标上的按键整条不发。
 */

import { isSecretInfo, readSecretInfo } from "./secret-field.mjs";

// 隔离世界名：M 用 Page.addScriptToEvaluateOnNewDocument { worldName } 时与这里对齐
export const PAGE_WORLD_NAME = "flowship";
// Runtime.addBinding 的名字，executionContextName 同样是 PAGE_WORLD_NAME
export const RECORDER_BINDING = "__flowshipRec";

/**
 * 页内主体。签名即注入协议：(初始 recordValues, binding 名)。
 * 整体被 try/catch 包住：页内脚本出任何错都不能冒泡影响页面本身。
 */
function flowshipPageMain(initialRecordValues, bindingName, isSecretInfo, readSecretInfo) {
  try {
    var g = globalThis;
    if (g.__flowship && g.__flowship.__v === 1) {
      try {
        g.__flowship.configure({ recordValues: initialRecordValues });
      } catch {}
      return;
    }

    var state = { ai: false, recordValues: initialRecordValues === true };

    var nativeAdd = null;
    try {
      nativeAdd = EventTarget.prototype.addEventListener;
    } catch {}
    function listen(type, fn) {
      try {
        if (nativeAdd) {
          nativeAdd.call(window, type, fn, true);
          return;
        }
      } catch {}
      try {
        window.addEventListener(type, fn, true);
      } catch {}
    }

    function isFrame() {
      try {
        return window === window.top ? "main" : "child";
      } catch {
        return "child";
      }
    }

    // 令牌桶（R1-04）：容量 20、每秒补 20。真人操作远低于这个速率；页面脚本循环制造事件时只能占掉这点配额
    var RATE_CAP = 20;
    var RATE_PER_MS = 0.02;
    var rateTokens = RATE_CAP;
    var rateAt = Date.now();
    function takeToken() {
      var n = Date.now();
      var d = n - rateAt;
      if (d > 0) {
        rateTokens = Math.min(RATE_CAP, rateTokens + d * RATE_PER_MS);
        rateAt = n;
      } else if (d < 0) {
        rateAt = n;
      }
      if (rateTokens < 1) return false;
      rateTokens -= 1;
      return true;
    }

    function emit(obj) {
      try {
        var fn = g[bindingName];
        if (typeof fn !== "function") return;
        if (!takeToken()) return;
        obj.ts = Date.now();
        obj.ai = state.ai === true;
        try {
          obj.url = String(location.href || "");
        } catch {
          obj.url = "";
        }
        obj.frame = isFrame();
        fn(JSON.stringify(obj));
      } catch {}
    }

    function cleanText(s) {
      var t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
      return t.length > 60 ? t.slice(0, 60) : t;
    }
    function attr(el, name) {
      try {
        if (!el || !el.getAttribute) return "";
        var v = el.getAttribute(name);
        return v == null ? "" : String(v);
      } catch {
        return "";
      }
    }
    // 敏感字段判定：规则只有一份（secret-field.mjs），这里只是调用。出任何错都按「敏感」处理（宁可多遮）
    function isSensitive(el) {
      try {
        return isSecretInfo(readSecretInfo(el)) === true;
      } catch {
        return true;
      }
    }
    // 事件是不是真实用户产生的：页面脚本 dispatchEvent / el.click() 造的事件 isTrusted 为 false
    function trusted(e) {
      try {
        return !!e && e.isTrusted === true;
      } catch {
        return false;
      }
    }

    // 真实用户输入窗口（R2-05）：isTrusted 只能挡住页面「自己造」的事件，挡不住页面让 UA 替它派发的——checkbox.click() 产生的
    // input / change、form.requestSubmit() 产生的 submit 都是 UA 派发的 isTrusted=true。真人切换复选框 / 提交表单的前一刻必有
    // trusted 的 pointer / mouse / key / touch 输入，而这类输入 UA 不会替页面派发（el.click() 的 click 是 isTrusted=false），页面伪造不出来。
    // 所以选择类 change 与 submit 只在「最近 GESTURE_WINDOW_MS 内有过真实输入」时才外发，否则静默丢弃（丢弃发生在 emit 之前，不占令牌）。
    // 残余：页面可以在用户一次真实点击的当下（点击处理函数里）立刻 checkbox.click()，窗口内的时间归因分不开这种伪造。
    var GESTURE_WINDOW_MS = 1000;
    // 原生 <select> 的弹层停留很久（读选项 / 滚动再点）：用户在这个 select 上按下 / 按键之后的这段时间内，它的 change 都认。
    // select 的 change 只能由用户在弹层里选择产生（页面改 value / selectedIndex 不派发事件，dispatchEvent 的是 isTrusted=false），不存在伪造路径
    var SELECT_OPEN_MS = 60000;
    var lastGestureAt = 0;
    var hasGesture = false;
    var downSeen = false;
    var lastSelectGesture = null;
    function markGesture(e) {
      if (!trusted(e)) return;
      try {
        var et = String(e.type || "");
        var isDown = et === "pointerdown" || et === "mousedown" || et === "keydown" || et === "touchstart";
        var isUp = et === "pointerup" || et === "mouseup" || et === "keyup" || et === "touchend";
        // 抬起类只在此前见过按下时才续期；click / 其他类型不是手势（R3-01）
        if (isDown) downSeen = true;
        else if (isUp && downSeen) downSeen = false;
        else return;
        var n = Date.now();
        lastGestureAt = n;
        hasGesture = true;
        var t = eventTarget(e);
        if (t && String(t.tagName || "").toLowerCase() === "select") lastSelectGesture = { el: t, at: n };
      } catch {}
    }
    function recentGesture() {
      if (!hasGesture) return false;
      var d = Date.now() - lastGestureAt;
      return d >= 0 && d <= GESTURE_WINDOW_MS;
    }
    function selectGestureFor(el) {
      var g = lastSelectGesture;
      if (!g || g.el !== el) return false;
      var d = Date.now() - g.at;
      return d >= 0 && d <= SELECT_OPEN_MS;
    }
    function inferRole(el, tag, type) {
      var explicit = attr(el, "role").trim().toLowerCase();
      if (explicit) return explicit;
      if (tag === "a") {
        try {
          if (el.href || attr(el, "href")) return "link";
        } catch {}
        return "generic";
      }
      if (tag === "button") return "button";
      if (tag === "select") {
        try {
          return el.multiple ? "listbox" : "combobox";
        } catch {
          return "combobox";
        }
      }
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
        if (type === "search") return "searchbox";
        if (type === "number") return "spinbutton";
        if (type === "range") return "slider";
        return "textbox";
      }
      if (/^h[1-6]$/.test(tag)) return "heading";
      if (tag === "img") return "img";
      try {
        if (el.isContentEditable) return "textbox";
      } catch {}
      return "generic";
    }
    // 文本框类（含 contenteditable / role=textbox 的 div）：它的「内容」是用户输入，绝不能当成可访问名写进日志（R1-05）
    function isTextboxLike(el, role) {
      if (role === "textbox" || role === "searchbox") return true;
      try {
        return el.isContentEditable === true;
      } catch {
        return false;
      }
    }
    // 「文字内容就是名字」的角色 / 标签（ARIA name from content 的常见子集）；其余（div / span / li / p / svg 这类 generic）的
    // innerText 只是一大段不知道装了什么的正文，不当名字（R2-05）
    var NAME_FROM_CONTENT_ROLES = " button link menuitem menuitemcheckbox menuitemradio tab option treeitem heading checkbox radio switch cell gridcell columnheader rowheader ";
    var NAME_FROM_CONTENT_TAGS = " a button summary label legend option td th ";
    function nameFromContent(tag, role) {
      var r = String(role || "").split(/\s+/)[0];
      return (r !== "" && NAME_FROM_CONTENT_ROLES.indexOf(" " + r + " ") >= 0) || NAME_FROM_CONTENT_TAGS.indexOf(" " + tag + " ") >= 0;
    }
    // generic 元素（按钮里的图标 span / svg）往上找最近的「内容即名字」祖先借它的名字：点按钮里的 span 时仍说得清点的是哪个按钮
    var NAME_HOST_SELECTOR =
      'a,button,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="option"],[role="treeitem"],[role="checkbox"],[role="radio"],[role="switch"]';
    // 可编辑区：里面的文字是用户正在输入的内容，不能经由容器的 innerText / textContent 带进名字
    var EDITABLE_SELECTOR = '[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],textarea';
    function isEditableNode(n) {
      try {
        if (n.isContentEditable === true) return true;
        return typeof n.matches === "function" && n.matches(EDITABLE_SELECTOR);
      } catch {
        return true;
      }
    }
    // node 自己或它里面有（except 之外的）可编辑区；withInputs 时连 <input> 也算（容器里有输入框就不当名字）。查不了一律按「有」（宁可丢名字）
    function holdsEditable(node, except, withInputs) {
      try {
        if (!node) return false;
        if (node !== except && isEditableNode(node)) return true;
        if (typeof node.querySelectorAll !== "function") return true;
        var found = node.querySelectorAll(withInputs ? EDITABLE_SELECTOR + ",input" : EDITABLE_SELECTOR);
        for (var j = 0; j < found.length; j++) if (found[j] !== except) return true;
        return false;
      } catch {
        return true;
      }
    }
    function accessibleName(el, tag, type, role) {
      var textbox = isTextboxLike(el, role);
      var v = cleanText(attr(el, "aria-label"));
      if (v) return v;
      var labelledby = attr(el, "aria-labelledby").trim();
      if (labelledby) {
        var parts = [];
        var ids = labelledby.split(/\s+/);
        for (var i = 0; i < ids.length; i++) {
          try {
            var n = document.getElementById(ids[i]);
            // 文本框自己（或它里面的节点）被 aria-labelledby 指回去：那是输入内容，不是标签；指向装着编辑区的容器同理
            if (n && !(textbox && (n === el || (el.contains && el.contains(n)))) && !holdsEditable(n, el, false)) parts.push(n.textContent || "");
          } catch {}
        }
        v = cleanText(parts.join(" "));
        if (v) return v;
      }
      try {
        if (el.labels && el.labels.length && !holdsEditable(el.labels[0], el, false)) {
          v = cleanText(el.labels[0].textContent || "");
          if (v) return v;
        }
      } catch {}
      try {
        // contenteditable 包在 <label> 里时，label.textContent 含编辑区正文：只有原生 input / textarea 才读包裹它的 label；
        // label 里另装着别的编辑区时（<label><span>标题</span><div contenteditable>…）点 span 也不能取 label 全文
        var wrap = el.closest && (!textbox || tag === "input" || tag === "textarea") ? el.closest("label") : null;
        if (wrap && !holdsEditable(wrap, el, false)) {
          v = cleanText(wrap.textContent || "");
          if (v) return v;
        }
      } catch {}
      if (tag === "input" && (type === "submit" || type === "button" || type === "reset")) {
        v = cleanText(el.value || "");
        if (v) return v;
      }
      v = cleanText(attr(el, "placeholder"));
      if (v) return v;
      v = cleanText(attr(el, "alt"));
      if (v) return v;
      v = cleanText(attr(el, "title"));
      if (v) return v;
      if (tag === "input" || tag === "textarea" || tag === "select") return "";
      // 文本框类到此为止：只许 aria-label / aria-labelledby / label / placeholder / title / name，绝不回落到 innerText / textContent
      if (textbox) return cleanText(attr(el, "name"));
      if (!nameFromContent(tag, role)) {
        // generic：不取自己的文字，只借「内容即名字」祖先（按钮 / 链接 …）的名字
        var host = null;
        try {
          host = el.closest ? el.closest(NAME_HOST_SELECTOR) : null;
        } catch {}
        if (!host || host === el) return "";
        var hostTag = "";
        var hostType = "";
        try {
          hostTag = String(host.tagName || "").toLowerCase();
          if (hostTag === "input" || hostTag === "button") hostType = String(host.type || "").toLowerCase();
        } catch {}
        return accessibleName(host, hostTag, hostType, inferRole(host, hostTag, hostType));
      }
      // 按钮 / 链接也可能是个壳：里面装着编辑区（或输入框）时 innerText 含用户正在写的正文，不取
      if (holdsEditable(el, null, true)) return "";
      try {
        v = cleanText(el.innerText || el.textContent || "");
      } catch {
        v = "";
      }
      return v;
    }
    function describe(el) {
      if (!el || el.nodeType !== 1) return undefined;
      var tag = "";
      var type = "";
      try {
        tag = String(el.tagName || "").toLowerCase();
      } catch {}
      if (tag === "input" || tag === "button") {
        try {
          type = String(el.type || "").toLowerCase();
        } catch {}
      }
      var target = { tag: tag };
      var role = inferRole(el, tag, type);
      if (role && role !== "generic") target.role = role;
      var name = accessibleName(el, tag, type, role);
      if (name) target.name = name;
      if (type) target.inputType = type;
      var fieldName = attr(el, "name") || "";
      try {
        if (!fieldName && el.id) fieldName = String(el.id);
      } catch {}
      if (fieldName) target.fieldName = cleanText(fieldName);
      if (isSensitive(el)) target.isPassword = true;
      if (tag === "a") {
        var href = attr(el, "href");
        if (href) target.href = href.slice(0, 200);
      }
      return target;
    }
    function eventTarget(e) {
      var t = null;
      try {
        if (e.composedPath) {
          var p = e.composedPath();
          if (p && p.length) t = p[0];
        }
      } catch {}
      if (!t) {
        try {
          t = e.target;
        } catch {}
      }
      while (t && t.nodeType !== 1) t = t.parentElement;
      return t || null;
    }
    function pointOf(e) {
      try {
        if (typeof e.clientX === "number" && typeof e.clientY === "number") {
          return { x: Math.round(e.clientX), y: Math.round(e.clientY) };
        }
      } catch {}
      return undefined;
    }
    function fieldValue(el, tag) {
      try {
        if (el.isContentEditable) return String(el.textContent || "");
        if (tag === "input" || tag === "textarea" || tag === "select") return String(el.value == null ? "" : el.value);
      } catch {}
      return "";
    }

    function onMouse(type) {
      return function (e) {
        if (!trusted(e)) return;
        // UA 转发 / 派发的 click 不带按下类输入：不算用户操作、也不外发（R3-01）
        if (!recentGesture()) return;
        try {
          var evt = { type: type, target: describe(eventTarget(e)) };
          var p = pointOf(e);
          if (p) evt.point = p;
          emit(evt);
        } catch {}
      };
    }
    // 记录「最近一次真实输入」：必须先于下面所有会 emit 的 listener 注册（同一 capture 阶段按注册顺序触发，click / keydown 要先标记再判）
    var GESTURE_EVENTS = ["pointerdown", "mousedown", "pointerup", "mouseup", "keydown", "keyup", "touchstart", "touchend"];
    for (var gi = 0; gi < GESTURE_EVENTS.length; gi++) listen(GESTURE_EVENTS[gi], markGesture);

    listen("click", onMouse("click"));
    listen("dblclick", onMouse("dblclick"));
    listen("contextmenu", onMouse("contextmenu"));

    listen("input", function (e) {
      if (!trusted(e)) return;
      // execCommand('insertText') 让 UA 派发的 input 也是 trusted：要求紧跟按下类输入（正常打字每个键都有 keydown；R3-04）
      if (!recentGesture()) return;
      try {
        var el = eventTarget(e);
        if (!el) return;
        var tag = String(el.tagName || "").toLowerCase();
        var type = "";
        try {
          type = String(el.type || "").toLowerCase();
        } catch {}
        if (tag === "select") return;
        if (tag === "input" && type !== "text" && type !== "search" && type !== "email" && type !== "tel" && type !== "url" && type !== "password" && type !== "number" && type !== "") return;
        var sensitive = isSensitive(el);
        var value = fieldValue(el, tag);
        var evt = { type: "input", target: describe(el), valueLength: value.length };
        if (state.recordValues && !sensitive && value) evt.value = value.slice(0, 500);
        emit(evt);
      } catch {}
    });

    listen("change", function (e) {
      if (!trusted(e)) return;
      try {
        var el = eventTarget(e);
        if (!el) return;
        var tag = String(el.tagName || "").toLowerCase();
        var type = "";
        try {
          type = String(el.type || "").toLowerCase();
        } catch {}
        var isChoice =
          tag === "select" || (tag === "input" && (type === "checkbox" || type === "radio" || type === "file"));
        if (isChoice) {
          // checkbox / radio：页面 el.click() 能让 UA 派发 trusted 的 change → 必须紧跟一次真实输入才认（R2-05）。
          // select：认「用户刚在这个 select 上按下 / 按键」（弹层停留久，见 SELECT_OPEN_MS）。
          // file：只能由用户在系统文件对话框 / 拖放里产生，页面造不出来，对话框停留更久，不设门槛。
          var allowed = type === "file" ? true : tag === "select" ? recentGesture() || selectGestureFor(el) : recentGesture();
          if (!allowed) return;
          emit({ type: "select", target: describe(el) });
          return;
        }
        try {
          if (el.isContentEditable) {
            var v = String(el.textContent || "");
            var evt2 = { type: "input", target: describe(el), valueLength: v.length };
            if (state.recordValues && v && !isSensitive(el)) evt2.value = v.slice(0, 500);
            emit(evt2);
          }
        } catch {}
      } catch {}
    });

    listen("submit", function (e) {
      if (!trusted(e)) return;
      // 页面能 form.requestSubmit() / 提交按钮 .click() 让 UA 派发 trusted 的 submit：必须紧跟一次真实输入（点提交按钮 / 在输入框里回车）才认
      if (!recentGesture()) return;
      try {
        emit({ type: "submit", target: describe(eventTarget(e)) });
      } catch {}
    });

    // 按键只外发「功能键 + Ctrl/Meta+字母」白名单（与 activity-log.keyComboForLog 同口径）：
    // 普通字符、Alt / AltGr 组合出来的字符（德语 Mac 的 Option+L = @、Windows 的 AltGr = Ctrl+Alt）一个字都不越过 binding
    function keyWorthSending(key, ctrl, meta, alt) {
      if (key === "Enter" || key === "Escape" || key === "Tab") return true;
      if (alt) return false;
      return (ctrl || meta) && /^[a-zA-Z]$/.test(key);
    }
    listen("keydown", function (e) {
      if (!trusted(e)) return;
      try {
        var altGr = false;
        try {
          altGr = !!(e.getModifierState && e.getModifierState("AltGraph"));
        } catch {}
        var alt = !!e.altKey || altGr;
        var key = String(e.key || "");
        if (!keyWorthSending(key, !!e.ctrlKey, !!e.metaKey, alt)) return;
        var target = eventTarget(e);
        // 敏感目标（密码 / 验证码 / 卡号 / 遮罩字段）上的按键整条不发
        if (target && isSensitive(target)) return;
        var mods = [];
        if (e.ctrlKey) mods.push("Control");
        if (alt) mods.push(altGr ? "AltGraph" : "Alt");
        if (e.shiftKey) mods.push("Shift");
        if (e.metaKey) mods.push("Meta");
        var evt = { type: "key", key: key, target: describe(target) };
        if (mods.length) evt.modifiers = mods;
        emit(evt);
      } catch {}
    });

    // 不监听 focusin（R2-05）：活动日志没有 focus 类（主进程 RECORDER_KIND 里没有，ingest 直接丢），而页面循环 el.focus() 会让它
    // 产生一串 trusted 事件，白白耗掉页内 20/s 与主进程 #onBinding 两层令牌桶，把真实用户事件挤掉。

    var lastScrollAt = 0;
    function onScroll(e) {
      if (!trusted(e)) return;
      try {
        var nowMs = Date.now();
        if (nowMs - lastScrollAt < 150) return;
        lastScrollAt = nowMs;
        var t = null;
        try {
          t = e.target;
        } catch {}
        var x = 0;
        var y = 0;
        var ratio = 0;
        if (t && t.nodeType === 1 && t !== document.documentElement && t !== document.body) {
          x = Number(t.scrollLeft) || 0;
          y = Number(t.scrollTop) || 0;
          var denom = (Number(t.scrollHeight) || 0) - (Number(t.clientHeight) || 0);
          ratio = denom > 0 ? y / denom : 0;
        } else {
          x = Number(window.scrollX) || 0;
          y = Number(window.scrollY) || 0;
          var doc = document.documentElement;
          var denom2 = ((doc && Number(doc.scrollHeight)) || 0) - (Number(window.innerHeight) || 0);
          ratio = denom2 > 0 ? y / denom2 : 0;
        }
        if (ratio < 0) ratio = 0;
        if (ratio > 1) ratio = 1;
        emit({
          type: "scroll",
          scroll: { x: Math.round(x), y: Math.round(y), ratio: Math.round(ratio * 1000) / 1000 },
        });
      } catch {}
    }
    listen("scroll", onScroll);

    var ov = null;
    function styleEl(el, cssText) {
      try {
        el.style.cssText = cssText;
      } catch {}
      try {
        el.style.pointerEvents = "none";
      } catch {}
      return el;
    }
    function ensureOverlay() {
      if (ov) {
        try {
          if (ov.host.isConnected) return ov;
        } catch {}
        ov = null;
      }
      var rootEl = document.documentElement || document.body;
      if (!rootEl) return null;
      var host = document.createElement("div");
      try {
        host.setAttribute("data-flowship-overlay", "1");
      } catch {}
      styleEl(
        host,
        "position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;background:transparent;",
      );
      var shadow = null;
      try {
        shadow = host.attachShadow({ mode: "closed" });
      } catch {
        return null;
      }
      var cursor = styleEl(
        document.createElement("div"),
        "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;" +
          "border:2px solid rgba(255,255,255,.95);background:rgba(37,99,235,.55);" +
          "box-shadow:0 1px 6px rgba(15,23,42,.35),0 0 0 1px rgba(37,99,235,.35);opacity:0;pointer-events:none;",
      );
      var highlight = styleEl(
        document.createElement("div"),
        "position:fixed;border:2px solid rgba(37,99,235,.85);background:rgba(37,99,235,.08);" +
          "border-radius:6px;opacity:0;pointer-events:none;",
      );
      var label = styleEl(
        document.createElement("div"),
        "position:fixed;max-width:320px;padding:4px 8px;border-radius:6px;opacity:0;pointer-events:none;" +
          "background:rgba(15,23,42,.85);color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
          "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(15,23,42,.25);",
      );
      var border = styleEl(
        document.createElement("div"),
        "position:fixed;inset:0;opacity:0;pointer-events:none;" +
          "box-shadow:inset 0 0 0 2px rgba(37,99,235,.55),inset 0 0 28px rgba(37,99,235,.18);",
      );
      var badge = styleEl(
        document.createElement("div"),
        "position:fixed;top:10px;right:10px;padding:4px 10px;border-radius:999px;opacity:0;pointer-events:none;" +
          "background:rgba(15,23,42,.82);color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
      );
      try {
        badge.textContent = "AI 操作中";
        shadow.append(cursor, highlight, label, border, badge);
        rootEl.appendChild(host);
      } catch {
        return null;
      }
      ov = { host: host, cursor: cursor, highlight: highlight, label: label, border: border, badge: badge, hasPos: false, anim: null };
      return ov;
    }
    function fade(el, on) {
      try {
        el.style.transition = "opacity 180ms ease";
        el.style.opacity = on ? "1" : "0";
      } catch {}
    }
    var overlay = {
      showAction: function (opts) {
        try {
          var o = ensureOverlay();
          if (!o || !opts || !opts.point) return;
          var x = Number(opts.point.x);
          var y = Number(opts.point.y);
          if (!isFinite(x) || !isFinite(y)) return;
          try {
            o.cursor.style.transition = o.hasPos
              ? "transform 480ms cubic-bezier(.22,.8,.32,1),opacity 180ms ease"
              : "opacity 180ms ease";
            o.cursor.style.transform = "translate3d(" + x + "px," + y + "px,0)";
            o.cursor.style.opacity = "1";
          } catch {}
          o.hasPos = true;
          if (opts.rect && isFinite(Number(opts.rect.x)) && isFinite(Number(opts.rect.width))) {
            try {
              var r = opts.rect;
              o.highlight.style.left = Number(r.x) + "px";
              o.highlight.style.top = Number(r.y) + "px";
              o.highlight.style.width = Math.max(0, Number(r.width)) + "px";
              o.highlight.style.height = Math.max(0, Number(r.height) || 0) + "px";
              o.highlight.style.transition = "left 240ms ease,top 240ms ease,width 240ms ease,height 240ms ease,opacity 180ms ease";
              o.highlight.style.opacity = "1";
            } catch {}
          } else {
            fade(o.highlight, false);
          }
          if (opts.label) {
            try {
              o.label.textContent = String(opts.label).slice(0, 120);
              var lx = x + 14;
              var ly = y + 16;
              try {
                if (lx > window.innerWidth - 180) lx = Math.max(4, x - 160);
                if (ly > window.innerHeight - 48) ly = Math.max(4, y - 34);
              } catch {}
              o.label.style.left = lx + "px";
              o.label.style.top = ly + "px";
              o.label.style.opacity = "1";
            } catch {}
          } else {
            fade(o.label, false);
          }
        } catch {}
      },
      setActive: function (on, labelText) {
        try {
          var o = ensureOverlay();
          if (!o) return;
          if (on) {
            try {
              if (labelText) o.badge.textContent = String(labelText).slice(0, 60);
              else o.badge.textContent = "AI 操作中";
            } catch {}
            fade(o.border, true);
            fade(o.badge, true);
            try {
              if (!o.anim && o.border.animate) {
                o.anim = o.border.animate(
                  [{ opacity: "0.45" }, { opacity: "1" }, { opacity: "0.45" }],
                  { duration: 2200, iterations: Infinity },
                );
              }
            } catch {}
          } else {
            fade(o.border, false);
            fade(o.badge, false);
            try {
              if (o.anim) o.anim.cancel();
            } catch {}
            o.anim = null;
          }
        } catch {}
      },
      hide: function () {
        try {
          if (!ov) return;
          fade(ov.cursor, false);
          fade(ov.highlight, false);
          fade(ov.label, false);
          fade(ov.border, false);
          fade(ov.badge, false);
          try {
            if (ov.anim) ov.anim.cancel();
          } catch {}
          ov.anim = null;
        } catch {}
      },
    };

    g.__flowship = {
      __v: 1,
      setAI: function (on) {
        state.ai = on === true;
      },
      configure: function (cfg) {
        try {
          if (cfg && typeof cfg.recordValues === "boolean") state.recordValues = cfg.recordValues;
        } catch {}
      },
      overlay: overlay,
    };
  } catch {
  }
}

export function buildPageScript({ recordValues = false } = {}) {
  // 第 3 / 4 个参数：敏感字段判定的函数源码（secret-field.mjs 的 isSecretInfo / readSecretInfo），页内与主进程同一份规则
  return `(${flowshipPageMain.toString()})(${JSON.stringify(recordValues === true)},${JSON.stringify(RECORDER_BINDING)},${isSecretInfo.toString()},${readSecretInfo.toString()});`;
}
