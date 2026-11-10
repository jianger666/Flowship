/**
 * 活动日志（契约 §4.4）：把页内录制器回传的 RecorderEvent 压缩、脱敏成 ActivityEntry。
 *
 * 纯逻辑、无 Electron 依赖，主进程直接用、单测可直接 import。
 * 脱敏是纵深防御：页内脚本已经不发密码值，这里再按 target 特征拦一道，
 * 这样即使将来某个调用方误把 value 塞进来，也不会落进日志 / 摘要。
 */

import { isSecretInfo } from "./secret-field.mjs";
import { REDACTED_TEXT, redactSensitiveText } from "./text-redact.mjs";

// summary 单条上限（契约钉死 160 字符）
const SUMMARY_MAX = 160;
// 同一目标连续输入的合并窗口
const MERGE_WINDOW_MS = 1500;

// RecorderEvent.type → ActivityEntry.kind；不在表里的（focus / mousemove 等）直接丢弃
const RECORDER_KIND = {
  click: "click",
  dblclick: "click",
  contextmenu: "click",
  input: "type",
  change: "type",
  submit: "submit",
  key: "key",
  scroll: "scroll",
  select: "select",
};

// role → 中文控件名（摘要用）。没有映射的 role 在调用处兜底为「元素」
const ROLE_LABEL = {
  button: "按钮",
  link: "链接",
  textbox: "文本框",
  searchbox: "搜索框",
  checkbox: "复选框",
  radio: "单选框",
  combobox: "下拉框",
  listbox: "列表框",
  menuitem: "菜单项",
  menuitemcheckbox: "菜单项",
  menuitemradio: "菜单项",
  tab: "标签",
  switch: "开关",
  slider: "滑块",
  spinbutton: "数字框",
  option: "选项",
  heading: "标题",
  img: "图片",
  image: "图片",
};

// R6-12：自由文本进日志前的统一脱敏窗口——日志会以 untrusted 文本进模型上下文并持久化（红线 2：先脱敏、后截断）。
// 摘要最终 ≤160，窗口取远大于它的 2048：截断点附近的凭据仍能在窗口内被完整匹配；窗口外的部分最终也不会被保留。
const REDACT_WINDOW = 2048;
// 邮箱是 PII 不是凭据：只在「活动日志」这个会持久化、会进模型上下文的出口打码，不进 text-redact 的两端共用规则（网络 / console 文本里的邮箱对排查有用，
// 不能一刀切）。本地部分 / 域名都有界，线性；`[已隐藏]@host` 里的占位符不含 ASCII 字符，不会被二次匹配（幂等）。
// R6-41 ①：必须是「完整域名」——至少一个点、每个标签以字母数字起止、**末级标签是 2–24 个字母**（或 punycode `xn--…`）。所以版本号 `lodash@4.17.21` / `react@18.2.0`
// （末级是数字）不再被打码；`163.com` / `126.com` 这类数字开头的真实邮箱域名仍然命中。再在回调里排除「文件名」：`logo@2x.png` / `icon@3x.webp` 这类 retina 资源名
// （域名首标签是 `2x` / `1.5x`）与末级是常见资源 / 源码扩展名的（{@link FILE_LIKE_TLDS}；刻意只收不是 ccTLD / 常见 gTLD 的扩展名，`.md` / `.py` / `.sh` / `.rs` 这类同时是 ccTLD 的不排除）。其余一律打码——宁可多藏。
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8}(?:xn--[A-Za-z0-9-]{2,59}|[A-Za-z]{2,24})(?![A-Za-z0-9])/g;
const FILE_LIKE_TLDS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp", "tiff", "css", "scss", "less", "js", "mjs", "cjs", "jsx", "tsx", "json", "map", "html", "htm", "xml",
  "txt", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "webm", "wasm", "lock", "yml", "yaml", "csv", "tar", "tgz", "gz",
]);
const RETINA_DOMAIN_RE = /^\d{1,2}(?:\.\d{1,2})?x\./i;

/** 邮箱打码（回调里排除文件名形态）；导出供单测直接测 */
export function maskEmails(text) {
  return String(text ?? "").replace(EMAIL_RE, (m) => {
    const domain = m.slice(m.indexOf("@") + 1);
    if (RETINA_DOMAIN_RE.test(domain) || FILE_LIKE_TLDS.has(domain.slice(domain.lastIndexOf(".") + 1).toLowerCase())) return m;
    return REDACTED_TEXT;
  });
}

/**
 * 先脱敏后截断的自由文本清洗：所有写入口（makeEntry / 合并更新 / name / url / summarize）都经它，调用点不必（也不该）各自脱敏；redactSensitiveText 幂等，重复调用无副作用。
 * R6-41 ②：迭代 2 遍——前一遍替换出的占位符会让后一遍的词边界成立（旧版卡号紧贴 JWT 时，第一遍漏掉 JWT、第二遍才掉），所以一遍 `safeText` 就是完备的；
 * 第一遍没改动任何东西就不跑第二遍（同一输入同一输出）。
 */
function safeText(text) {
  const raw = String(text ?? "");
  const win = raw.length > REDACT_WINDOW * 4 ? raw.slice(0, REDACT_WINDOW * 4) : raw;
  const collapsed = win.replace(/\s+/g, " ").trim();
  let out = collapsed.length > REDACT_WINDOW ? collapsed.slice(0, REDACT_WINDOW) : collapsed;
  for (let pass = 0; pass < 2; pass++) {
    const next = maskEmails(redactSensitiveText(out));
    if (next === out) break;
    out = next;
  }
  return out;
}

function truncateSummary(text) {
  const s = safeText(text);
  if (s.length <= SUMMARY_MAX) return s;
  // 留 1 个字符给省略号，保证截完仍 ≤160
  return `${s.slice(0, SUMMARY_MAX - 1)}…`;
}

function truncateName(text) {
  const s = safeText(text); // 控件名是页面可控文本（aria-label / 按钮文字），同样先脱敏
  return s.length > 60 ? s.slice(0, 60) : s;
}

/** URL 只留 origin + pathname：query / hash 可能带 token，绝不进日志（契约 §4.4） */
function cleanUrl(rawUrl) {
  const raw = String(rawUrl ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.origin && u.origin !== "null") return truncateSummary(`${u.origin}${u.pathname}`);
    // about:blank 等 origin 为 null 的协议：去掉 query/hash 后原样保留（如 about:blank）
    u.search = "";
    u.hash = "";
    return truncateSummary(u.href);
  } catch {
    // 解析不了就粗暴切掉 ? 与 # 后面的部分，宁可少记也不能把 query 带出去
    return truncateSummary(raw.split(/[?#]/)[0]);
  }
}

/**
 * 敏感目标：页内录制器标了 isPassword，或 target 自带的 inputType / autocomplete / textSecurity 命中统一规则
 * （R1-25：与 ops/input.mjs、页内脚本、snapshot、inspect、picker 共用 secret-field.mjs，不再各写一份）。
 */
function isSensitiveTarget(target) {
  if (!target || typeof target !== "object") return false;
  if (target.isPassword === true) return true;
  return isSecretInfo({ type: target.inputType, autocomplete: target.autocomplete, textSecurity: target.textSecurity });
}

/** 按键白名单里的功能键：不带任何字符，可以原样记 */
const SPECIAL_KEYS = new Set(["Enter", "Escape", "Tab"]);

/**
 * 按键事件 → 摘要里的组合名；不在白名单就返回 null（丢弃）。R1-03：
 * - 只留 Enter / Escape / Tab（可带修饰键），以及 Ctrl / Meta + 单个字母（复制 / 粘贴 / 全选一类快捷键）；
 * - Alt（Mac 的 Option）与 AltGr（Windows 上 = Ctrl+Alt，页内标成 AltGraph）组合一律不记：德语键盘的 @ | { } 等就是这么输入的，
 *   记下来等于把口令里的字符一个个告诉 AI；
 * - 单个字符键 / Shift+字符一律不记（普通打字由 type 条目按长度覆盖）。
 * 命中敏感目标的按键由调用方在这之前就整条丢弃。
 */
function keyComboForLog(key, mods) {
  if (!key) return null;
  const hasAlt = mods.some((m) => /alt|option/i.test(m));
  const hasCtrlMeta = mods.some((m) => /^(control|ctrl|meta|cmd|command)$/i.test(m));
  const special = SPECIAL_KEYS.has(key);
  const ctrlLetter = hasCtrlMeta && !hasAlt && /^[a-z]$/i.test(key);
  if (!special && !ctrlLetter) return null;
  return mods.length ? `${mods.join("+")}+${key}` : key;
}

/** 摘要里引用目标：有可访问名称才带「」，没有就只说控件类型 */
function describeTarget(target, fallbackLabel) {
  const role = target && typeof target === "object" ? String(target.role ?? "") : "";
  const label = ROLE_LABEL[role] || fallbackLabel || "元素";
  const name = truncateName(target?.name || target?.fieldName || "");
  return name ? `${label}「${name}」` : label;
}

/** 条目对外只暴露契约里的 target 形状，多余的页内字段（inputType 等）不外泄 */
function slimTarget(target) {
  if (!target || typeof target !== "object") return undefined;
  const out = {};
  if (target.role) out.role = String(target.role);
  const name = truncateName(target.name || "");
  if (name) out.name = name;
  if (target.ref) out.ref = String(target.ref);
  return Object.keys(out).length ? out : undefined;
}

/** 目标签名：判断「同一目标」用，字段名也算进去（同名不同字段不合并） */
function targetSignature(target) {
  if (!target || typeof target !== "object") return "";
  return [
    target.tag ?? "",
    target.role ?? "",
    target.name ?? "",
    target.fieldName ?? "",
    target.inputType ?? "",
    target.href ?? "",
  ].join("|");
}

export function createActivityLog({
  max = 500,
  now = Date.now,
  recordInputValues = false,
} = {}) {
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 500;
  /** @type {Array<any>} */
  let entries = [];
  let nextId = 1;
  // AI 已看到的用户/系统条目的游标：id ≤ seenCursor 的算已送达
  let seenCursor = 0;
  let recordValues = recordInputValues === true;
  // 合并所需的内部状态按 entry.id 存，不挂在条目上（条目形状要严格等于契约）
  const mergeState = new Map();

  function push(entry) {
    entries.push(entry);
    while (entries.length > cap) {
      const dropped = entries.shift();
      if (dropped) mergeState.delete(dropped.id);
    }
    return entry;
  }

  function makeEntry({ actor, kind, tabId, url, summary, target, ts }) {
    return push({
      id: nextId++,
      ts: typeof ts === "number" && Number.isFinite(ts) ? ts : now(),
      actor,
      kind,
      tabId: String(tabId ?? ""),
      url: cleanUrl(url),
      summary: truncateSummary(summary),
      ...(target ? { target } : {}),
    });
  }

  function typeSummary(target, sensitive, length, value) {
    if (sensitive) {
      // 契约原文句式；敏感字段永不带值，哪怕 recordValues 开着、哪怕 raw 里有 value
      const name = truncateName(target?.name || target?.fieldName || "");
      return name
        ? `在密码框「${name}」中输入（内容已隐藏）`
        : "在密码框中输入（内容已隐藏）";
    }
    const what = describeTarget(target, "文本框");
    if (recordValues && typeof value === "string" && value.length > 0) {
      return `在${what}输入了「${value.replace(/\s+/g, " ")}」`;
    }
    const n = Number.isFinite(length) && length > 0 ? Math.floor(length) : 0;
    return `在${what}输入了 ${n} 个字符`;
  }

  function ingest(raw) {
    try {
      if (!raw || typeof raw !== "object") return null;

      // 系统事件：M 补的导航 / 标签 / 接管等，走 addSystem 同一条路
      if (raw.type === "system") {
        return addSystem({
          kind: raw.kind,
          tabId: raw.tabId,
          url: raw.url,
          summary: raw.summary,
          target: raw.target,
        });
      }

      // AI 动作由 M 经 addAI 记录，录制器标了 ai 的再记一遍会让用户看到重复条目
      if (raw.ai === true) return null;

      const kind0 = RECORDER_KIND[String(raw.type ?? "")];
      if (!kind0) return null; // focus / mousemove / mouseover / 未知类型一律丢弃

      const tabId = String(raw.tabId ?? "");
      const ts =
        typeof raw.ts === "number" && Number.isFinite(raw.ts) ? raw.ts : now();
      const target = raw.target && typeof raw.target === "object" ? raw.target : undefined;
      const slim = slimTarget(target);
      const url = raw.url ?? "";

      // ── 按键：只记 Enter/Escape/Tab 与 Ctrl|Meta+字母 白名单；敏感目标（密码 / 验证码 / 卡号 / 遮罩字段）整条丢弃 ──
      if (raw.type === "key") {
        // 敏感目标上的任何按键都不留痕：不管 recordInputValues 开没开（R1-03）
        if (isSensitiveTarget(target)) return null;
        const key = String(raw.key ?? "");
        const mods = Array.isArray(raw.modifiers)
          ? raw.modifiers.map((m) => String(m)).filter(Boolean)
          : [];
        const combo = keyComboForLog(key, mods);
        if (!combo) return null;
        const entry = makeEntry({
          actor: "user",
          kind: "key",
          tabId,
          url,
          summary: `按下了 ${combo}`,
          target: slim,
          ts,
        });
        entry.count = 1;
        return entry;
      }

      // ── 滚动：同一 tab 连续滚动（上一条就是该 tab 的滚动）折叠成一条 ──
      if (raw.type === "scroll") {
        const ratioRaw =
          raw.scroll && typeof raw.scroll === "object" ? raw.scroll.ratio : undefined;
        const ratio = Number.isFinite(ratioRaw)
          ? Math.min(1, Math.max(0, ratioRaw))
          : 0;
        const summary = `滚动页面到约 ${Math.round(ratio * 100)}%`;
        const last = entries[entries.length - 1];
        if (last && last.kind === "scroll" && last.actor === "user" && last.tabId === tabId) {
          last.ts = ts;
          last.summary = truncateSummary(summary);
          last.url = cleanUrl(url);
          last.count = (last.count ?? 1) + 1;
          return last;
        }
        const entry = makeEntry({ actor: "user", kind: "scroll", tabId, url, summary, ts });
        entry.count = 1;
        return entry;
      }

      // ── 输入（input/change/select 的文本类都归到 type 合并逻辑） ──
      const isSelectLike =
        raw.type === "select" ||
        (raw.type === "change" &&
          (String(target?.tag ?? "").toLowerCase() === "select" ||
            String(target?.role ?? "") === "combobox" ||
            ["checkbox", "radio"].includes(String(target?.inputType ?? "").toLowerCase())));
      if (raw.type === "input" || raw.type === "change" || (raw.type === "select" && isSelectLike)) {
        if (isSelectLike && raw.type !== "input") {
          // 下拉 / 勾选类不做「输入合并」，每次选择单独一条
          const inputType = String(target?.inputType ?? "").toLowerCase();
          let summary;
          if (inputType === "checkbox") summary = `切换了${describeTarget(target, "复选框")}`;
          else if (inputType === "radio") summary = `选择了${describeTarget(target, "单选框")}`;
          else summary = `选择了${describeTarget(target, "下拉框")}`;
          const entry = makeEntry({
            actor: "user",
            kind: "select",
            tabId,
            url,
            summary,
            target: slim,
            ts,
          });
          entry.count = 1;
          return entry;
        }

        const sensitive = isSensitiveTarget(target);
        // 当前字段长度：优先 valueLength，其次 value 的长度，都没有就按在上一长度上 +1 估
        let length = null;
        if (Number.isFinite(raw.valueLength)) length = Math.max(0, Math.floor(raw.valueLength));
        else if (typeof raw.value === "string") length = raw.value.length;
        const value =
          !sensitive && recordValues && typeof raw.value === "string" ? raw.value : undefined;
        const sig = targetSignature(target);

        const last = entries[entries.length - 1];
        const st = last ? mergeState.get(last.id) : undefined;
        if (
          last &&
          st &&
          last.kind === "type" &&
          last.actor === "user" &&
          last.tabId === tabId &&
          sig !== "" &&
          st.sig === sig &&
          Math.abs(ts - st.lastTs) <= MERGE_WINDOW_MS
        ) {
          // 合并更新：id 不变、count 递增、summary 按最新长度/值重算
          if (length === null) length = st.length + 1;
          st.lastTs = ts;
          st.length = length;
          if (value !== undefined) st.value = value;
          last.ts = ts;
          last.url = cleanUrl(url);
          last.count = (last.count ?? 1) + 1;
          last.summary = truncateSummary(
            typeSummary(target, sensitive, st.length, st.value),
          );
          return last;
        }

        if (length === null) length = 1;
        const entry = makeEntry({
          actor: "user",
          kind: "type",
          tabId,
          url,
          summary: typeSummary(target, sensitive, length, value),
          target: slim,
          ts,
        });
        entry.count = 1;
        mergeState.set(entry.id, { sig, lastTs: ts, length, value });
        return entry;
      }

      // type:'select' 但不是控件选择（如文本选区）：没有对应 kind，丢弃
      if (raw.type === "select") return null;

      // ── 其余：click / submit ──
      let kind = kind0;
      let summary;
      if (raw.type === "click") summary = `点击了${describeTarget(target, "元素")}`;
      else if (raw.type === "dblclick") summary = `双击了${describeTarget(target, "元素")}`;
      else if (raw.type === "contextmenu") summary = `右键点击了${describeTarget(target, "元素")}`;
      else if (raw.type === "submit") {
        const name = truncateName(target?.name || target?.fieldName || "");
        summary = name ? `提交了表单「${name}」` : "提交了表单";
        kind = "submit";
      } else {
        summary = `进行了${kind}操作`;
      }
      const entry = makeEntry({ actor: "user", kind, tabId, url, summary, target: slim, ts });
      entry.count = 1;
      return entry;
    } catch {
      // 日志是旁路：任何坏数据都不能把主流程带崩
      return null;
    }
  }

  function addAI({ kind, tabId, url, summary, target } = {}) {
    const entry = makeEntry({
      actor: "ai",
      kind: String(kind ?? "click"),
      tabId,
      url,
      summary: summary ? String(summary) : "AI 进行了操作",
      target: slimTarget(target),
    });
    return entry;
  }

  function addSystem({ kind, tabId, url, summary, target } = {}) {
    const k = String(kind ?? "load");
    const fallback = {
      navigate: "打开了页面",
      load: "页面加载完成",
      tab_open: "打开了新标签页",
      tab_close: "关闭了标签页",
      download: "开始下载文件",
      dialog: "页面弹出了对话框",
      takeover: "用户接管了浏览器",
      handback: "用户把浏览器交还给 AI",
      pick: "用户拾取了页面元素",
    }[k];
    const entry = makeEntry({
      actor: "system",
      kind: k,
      tabId,
      url,
      summary: summary ? String(summary) : fallback || "浏览器状态变化",
      target: slimTarget(target),
    });
    return entry;
  }

  function list({ sinceId, actors, limit } = {}) {
    let out = entries;
    if (Number.isFinite(sinceId)) out = out.filter((e) => e.id > sinceId);
    if (Array.isArray(actors) && actors.length) {
      const set = new Set(actors.map(String));
      out = out.filter((e) => set.has(e.actor));
    }
    if (Number.isFinite(limit)) {
      const n = Math.max(0, Math.floor(limit));
      // limit 取最近的 n 条（仍按时间正序返回），与 recent 的语义一致
      out = n === 0 ? [] : out.slice(-n);
    }
    return [...out];
  }

  function recent(n = 20) {
    const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 20;
    return count === 0 ? [] : entries.slice(-count);
  }

  function unseenUserEntries() {
    return entries.filter(
      (e) => (e.actor === "user" || e.actor === "system") && e.id > seenCursor,
    );
  }

  function pendingCount() {
    return unseenUserEntries().length;
  }

  function markSeen() {
    // 游标只前进不后退；环形缓冲丢掉的旧条目本来就不会再出现
    const maxId = entries.length ? entries[entries.length - 1].id : seenCursor;
    if (maxId > seenCursor) seenCursor = maxId;
    return seenCursor;
  }

  function summarize(listInput) {
    const arr = Array.isArray(listInput) ? listInput : [];
    return arr
      .filter((e) => e && typeof e.summary === "string" && e.summary)
      .map((e) => `· ${truncateSummary(e.summary)}`)
      .join("\n");
  }

  function setRecordInputValues(on) {
    recordValues = on === true;
  }

  function clear() {
    entries = [];
    mergeState.clear();
    nextId = 1;
    seenCursor = 0;
  }

  return {
    ingest,
    addAI,
    addSystem,
    list,
    recent,
    unseenUserEntries,
    pendingCount,
    markSeen,
    summarize,
    setRecordInputValues,
    clear,
  };
}
