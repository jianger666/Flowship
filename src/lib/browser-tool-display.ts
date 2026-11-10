/**
 * 内置浏览器工具（`browser_*`）在事件流工具块里的一行摘要。
 *
 * 工具块折叠行形态是「工具名 + 一行摘要」（`schedule` / `wait` 同款）：工具名保持原样，
 * 这里只负责把入参翻成人话，避免折叠行退化成通用的 `调用 browser_click:{"ref":"e12"}`。
 * 纯函数、不依赖 DOM / bridge，网页版（没有内置浏览器）看历史事件时也能正常显示。
 */

export const BROWSER_TOOL_PREFIX = "browser_";

export const isBrowserToolName = (name: string): boolean =>
  name.toLowerCase().startsWith(BROWSER_TOOL_PREFIX);

const clip = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const parseArgs = (args: string | undefined): Record<string, unknown> | null => {
  if (!args) return null;
  try {
    const raw: unknown = JSON.parse(args);
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const str = (o: Record<string, unknown>, k: string): string =>
  typeof o[k] === "string" ? (o[k] as string) : "";

/**
 * 取参数：**snake_case 优先**（tools.ts 的 schema 与模型真实入参都是 snake_case：full_page / from_ref / time_ms …），
 * 其次 camelCase 回退（老事件、主进程 op 参数的写法）。R1-20：此前只读 camelCase，真实 args 下摘要退化成「截图 / 拖拽 / 等待」。
 */
const pick = (o: Record<string, unknown>, snake: string, camel: string): unknown =>
  o[snake] !== undefined ? o[snake] : o[camel];
const pickStr = (o: Record<string, unknown>, snake: string, camel: string): string => {
  const v = pick(o, snake, camel);
  return typeof v === "string" ? v : "";
};
/** 数字参数：模型常把数字写成字符串（tools.ts 的 argNum 同样宽松），数字与数字字符串都认 */
const pickNum = (o: Record<string, unknown>, snake: string, camel: string): number | undefined => {
  const v = pick(o, snake, camel);
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const pickBool = (o: Record<string, unknown>, snake: string, camel: string): boolean => {
  const v = pick(o, snake, camel);
  return v === true || v === "true";
};

/**
 * 落盘前脱敏（redact-args.ts）后的占位符 `[已隐藏 N 字符]`：还原成「N 个字符」。
 * 返回 null = 不是占位符，调用方自己数字符。
 */
const HIDDEN_CHARS_RE = /^\[已隐藏 (\d+) 字符\]$/;
const hiddenCount = (text: string): number | null => {
  const m = HIDDEN_CHARS_RE.exec(text);
  return m ? Number(m[1]) : null;
};

/** URL 折叠行里只留 host + path（去协议、query、hash：既省宽度、也不把可能带 token 的 query 摊在事件流里） */
const shortUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return clip(url, 60);
  }
};

const MODIFIER_LABEL: Record<string, string> = { Control: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Cmd" };

/** 修饰键前缀（固定顺序 Ctrl / Alt / Shift / Cmd）：`["Control"]` → `Ctrl+`；没有或不是数组 → 空串 */
const modifierPrefix = (raw: unknown): string => {
  if (!Array.isArray(raw)) return "";
  return ["Control", "Alt", "Shift", "Meta"]
    .filter((m) => raw.includes(m))
    .map((m) => `${MODIFIER_LABEL[m]}+`)
    .join("");
};

const NAV_ACTION: Record<string, string> = {
  back: "后退",
  forward: "前进",
  reload: "刷新",
};

const SCROLL_DIR: Record<string, string> = {
  up: "向上滚动",
  down: "向下滚动",
  left: "向左滚动",
  right: "向右滚动",
  top: "滚动到顶部",
  bottom: "滚动到底部",
};

const TAB_ACTION: Record<string, string> = {
  list: "列出标签页",
  new: "新建标签页",
  select: "切换标签页",
  close: "关闭标签页",
};

// ── E2·P7b（B4 检查增强）──
const INSPECT_EXTRA_LABEL: Record<string, string> = {
  matched_rules: "匹配的 CSS 规则",
  event_listeners: "事件监听器",
  a11y_audit: "无障碍审计",
};

/** browser_inspect 的 include 里有新项时，摘要后面补一句（只认白名单值，页面 / 模型给的其它字符串不进摘要） */
const inspectExtraSuffix = (o: Record<string, unknown>): string => {
  const raw = o.include;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const labels = [...new Set(list.filter((v): v is string => typeof v === "string" && Object.prototype.hasOwnProperty.call(INSPECT_EXTRA_LABEL, v)))].map((v) => INSPECT_EXTRA_LABEL[v]);
  return labels.length > 0 ? `（${labels.join(" / ")}）` : "";
};
// ── /E2·P7b ──

// ── E2·P5b（C1 模拟增强 / C2 触屏）──
const SWIPE_DIR_ZH: Record<string, string> = { up: "上", down: "下", left: "左", right: "右" };

/** browser_emulate 新增项的摘要尾巴（只认固定标签，不回显模型给的字符串；禁用 JS 排第一，用户必须一眼看见） */
const emulateExtraLabels = (o: Record<string, unknown>): string[] => {
  const labels: string[] = [];
  if (pickBool(o, "disable_javascript", "disableJavascript")) labels.push("禁用 JS");
  const media = pickStr(o, "media", "media");
  if (media === "print") labels.push("打印媒体");
  else if (media === "screen") labels.push("屏幕媒体");
  const vision = pickStr(o, "vision_deficiency", "visionDeficiency");
  if (vision && vision !== "none") labels.push("视觉缺陷");
  if (pickStr(o, "forced_colors", "forcedColors")) labels.push("强制颜色");
  if (pickStr(o, "prefers_contrast", "prefersContrast")) labels.push("对比度偏好");
  if (pickBool(o, "disable_cache", "disableCache")) labels.push("禁用缓存");
  if (pickBool(o, "touch", "touch")) labels.push("触屏");
  if (o.orientation && typeof o.orientation === "object") labels.push("设备方向");
  if (o.safe_area && typeof o.safe_area === "object") labels.push("安全区");
  return labels;
};
// ── /E2·P5b ──

/**
 * 返回一行中文摘要；不是浏览器工具、或解析不出入参且该工具没有「无参也有意义」的文案时返回空串
 * （调用方回落到通用摘要逻辑）。
 */
export const browserToolSummary = (
  name: string,
  args: string | undefined,
): string => {
  const n = name.toLowerCase();
  if (!isBrowserToolName(n)) return "";
  const o = parseArgs(args) ?? {};
  const ref = str(o, "ref");

  switch (n) {
    case "browser_navigate": {
      const action = str(o, "action");
      if (action && NAV_ACTION[action]) return NAV_ACTION[action];
      const url = str(o, "url");
      return url ? `打开 ${shortUrl(url)}` : "";
    }
    case "browser_snapshot": {
      const query = str(o, "query").trim();
      return query ? `读取页面结构（筛选 ${clip(query, 30)}）` : "读取页面结构";
    }
    case "browser_screenshot":
      // E2·S4：annotate = 在截图上叠 ref 编号框（只认布尔，不回显任何模型字符串）
      if (pickBool(o, "annotate", "annotate")) return "标注截图（ref 编号）";
      return pickBool(o, "full_page", "fullPage") ? "整页截图" : ref ? `元素截图 ${ref}` : "截图";
    case "browser_click":
      if (!ref) return "";
      // 修饰键前缀：Ctrl+点击 e12（V1）；工具入参是 snake_case（double_click），老代码读的是 doubleClick，两种都认
      return `${modifierPrefix(o.modifiers)}${pickBool(o, "double_click", "doubleClick") ? "双击" : str(o, "button") === "right" ? "右键点击" : "点击"} ${ref}`;
    case "browser_hover":
      return ref ? `悬停 ${ref}` : "";
    case "browser_type": {
      if (!ref) return "";
      const text = str(o, "text");
      // 输入内容可能是账号 / 口令：折叠行只给长度，不摊出原文。
      // 落盘的 args 已经被 redactBrowserArgs 换成 `[已隐藏 N 字符]`（R1-02）：从占位符里还原 N，别把占位符本身的长度当成输入长度
      const what = text ? `${hiddenCount(text) ?? [...text].length} 个字符` : "清空";
      return `在 ${ref} 输入 ${what}${pickBool(o, "submit", "submit") ? " 并回车" : ""}`;
    }
    case "browser_press_key": {
      const key = str(o, "key");
      return key ? `按键 ${key}` : "";
    }
    case "browser_select": {
      if (!ref) return "";
      const count = Array.isArray(o.values) ? o.values.length : 0;
      return count > 0 ? `在 ${ref} 选择 ${count} 项` : `在 ${ref} 选择`;
    }
    case "browser_scroll": {
      // E2·S4：滚到元素 / 滚到加载稳定（只认布尔与 ref，不回显字符串）
      // scroll_into_view 可能是布尔，也可能是模型写成的 `{ref}` 对象（见 screenshot-scroll-args.ts）
      const siv = o.scroll_into_view;
      if (siv === true || (typeof siv === "object" && siv !== null)) return ref ? `滚动到 ${ref}` : "滚动到元素";
      if (o.until_stable !== undefined && o.until_stable !== false) return "滚动到内容不再增加";
      const phrase = SCROLL_DIR[str(o, "direction")] ?? "滚动";
      return ref ? `在 ${ref} 内${phrase}` : phrase === "滚动" ? "滚动页面" : phrase;
    }
    case "browser_drag": {
      const from = pickStr(o, "from_ref", "fromRef");
      const to = pickStr(o, "to_ref", "toRef");
      return from && to ? `拖拽 ${from} → ${to}` : "";
    }
    case "browser_wait_for": {
      const text = str(o, "text");
      if (text) return `等待出现「${clip(text, 30)}」`;
      const gone = pickStr(o, "text_gone", "textGone");
      if (gone) return `等待消失「${clip(gone, 30)}」`;
      // 工具入参是 snake_case（schema：text_gone / time_ms / url_contains / network_idle / ref_visible），camelCase 作回退
      const urlHas = pickStr(o, "url_contains", "urlContains");
      if (urlHas) return `等待 URL 含「${clip(urlHas, 30)}」`;
      if (pickBool(o, "network_idle", "networkIdle")) return "等待网络空闲";
      const refVis = pickStr(o, "ref_visible", "refVisible");
      if (refVis) return `等待 ${refVis} 可见`;
      const timeMs = pickNum(o, "time_ms", "timeMs");
      return timeMs !== undefined ? `等待 ${Math.round(timeMs / 100) / 10} 秒` : "等待";
    }
    case "browser_tabs": {
      const action = str(o, "action");
      // E2·A6：新建无痕标签页要在摘要里看得出来（用户能一眼看到 AI 用了不共享登录态的身份）
      const base = action === "new" && pickBool(o, "incognito", "incognito") ? "新建无痕标签页" : (TAB_ACTION[action] ?? "标签页");
      const url = str(o, "url");
      return url ? `${base} ${shortUrl(url)}` : base;
    }
    case "browser_console":
      return pickBool(o, "sourcemap", "sourcemap") ? "读取控制台（还原 sourcemap 栈）" : "读取控制台";
    case "browser_network": {
      // V2：带 request_id 是查看单条请求详情（数字或数字字符串都认）
      const rid = typeof o.request_id === "number" ? o.request_id : Number(str(o, "request_id"));
      if (Number.isInteger(rid) && rid >= 1) return `查看请求 #${rid} 详情`;
      // E2·S3·B1：导出 HAR / 带过滤条件的读取
      if (str(o, "action") === "export_har") return "导出网络记录（HAR）";
      const type = clip(str(o, "type"), 20);
      if (type) return `读取网络请求 · ${type}`;
      return "读取网络请求";
    }
    case "browser_evaluate":
      return "执行页面脚本";
    case "browser_user_activity":
      return "查看你的操作";
    case "browser_ask_user_to_act": {
      const msg = str(o, "message");
      return msg ? `请你操作 · ${clip(msg, 50)}` : "请你操作";
    }
    // 增强包 E1（契约 §14）：各切片只往自己的区块里加 case
    // ── V1 ──
    case "browser_mouse": {
      const action = str(o, "action");
      if (action === "wheel") return "鼠标滚轮";
      const x = Number(o.x);
      const y = Number(o.y);
      const at = Number.isFinite(x) && Number.isFinite(y) ? ` (${Math.round(x)}, ${Math.round(y)})` : "";
      const verb =
        { click: "鼠标点击", double_click: "鼠标双击", move: "鼠标移动", down: "鼠标按下", up: "鼠标抬起" }[action] ?? "鼠标操作";
      return `${modifierPrefix(o.modifiers)}${verb}${at}`;
    }
    case "browser_fill_form": {
      // fields 可能是数组，也可能是（模型写成的）JSON 字符串——tools.ts 的 parseFillFields 两种都收
      let fields: unknown = o.fields;
      if (typeof fields === "string") {
        try {
          fields = JSON.parse(fields);
        } catch {
          fields = null;
        }
      }
      const n = Array.isArray(fields) ? fields.length : 0;
      return n > 0 ? `填写表单 ${n} 项` : "填写表单";
    }
    // ── /V1 ──
    // ── V2 ──
    case "browser_read":
      return ref ? `阅读 ${ref}` : "阅读页面";
    case "browser_inspect":
      return `${ref ? `检查 ${ref}` : "检查元素"}${inspectExtraSuffix(o)}`;
    case "browser_save": {
      const kind = str(o, "kind");
      return kind === "pdf" ? "保存页面为 PDF" : kind === "screenshot" ? "保存截图" : kind === "html" ? "保存 HTML" : "保存页面";
    }
    // ── /V2 ──
    // ── V3 ──
    case "browser_upload": {
      // 只显示文件名，不显示完整路径（路径里常有用户名 / 项目结构）
      // paths 可能是数组、单个路径字符串、或 JSON 数组字符串——tools.ts 的 parseUploadPaths 三种都收
      let rawPaths: unknown = o.paths;
      if (typeof rawPaths === "string") {
        const t = rawPaths.trim();
        if (t.startsWith("[")) {
          try {
            rawPaths = JSON.parse(t);
          } catch {
            rawPaths = [t];
          }
        } else rawPaths = t ? [t] : [];
      }
      const paths = Array.isArray(rawPaths) ? rawPaths.filter((p): p is string => typeof p === "string") : [];
      if (!ref || paths.length === 0) return ref ? `上传文件到 ${ref}` : "";
      const names = paths.map((p) => p.split(/[\\/]/).pop() ?? p).filter(Boolean);
      const shown = clip(names.slice(0, 2).join("、"), 40);
      return `上传 ${paths.length} 个文件到 ${ref}${shown ? `（${shown}${names.length > 2 ? " 等" : ""}）` : ""}`;
    }
    case "browser_downloads":
      return str(o, "action") === "wait" ? "等待下载完成" : "查看下载";
    // ── /V3 ──
    // ── V5 ──
    case "browser_dialog": {
      const action = str(o, "action");
      return action === "accept" ? "接受对话框" : action === "dismiss" ? "取消对话框" : "查看对话框";
    }
    case "browser_emulate": {
      if (pickBool(o, "reset", "reset")) return "重置模拟";
      const device = str(o, "device").trim();
      const extra = emulateExtraLabels(o); // E2·P5b
      const tail = extra.length > 0 ? ` · ${extra.join(" · ")}` : "";
      return device ? `模拟 ${clip(device, 30)}${tail}` : extra.length > 0 ? `设备模拟${tail}` : "设备模拟";
    }
    // ── /V5 ──
    // ── E2·S2（A1 登录态）──
    case "browser_storage": {
      // 只显示动作与名字：value 是登录凭据（落盘前已脱敏，这里也绝不展示）
      const action = str(o, "action");
      const named = clip(str(o, "name") || str(o, "key"), 30);
      const what = named ? `「${named}」` : "";
      const reveal = pickBool(o, "reveal", "reveal");
      const area = str(o, "area") === "session" ? "sessionStorage" : "localStorage";
      switch (action) {
        case "cookies_list":
          return reveal ? "读取 Cookie 明文" : "查看 Cookie 列表";
        case "cookies_get":
          return reveal ? `读取 Cookie${what} 明文` : `查看 Cookie${what}`;
        case "cookies_set":
          return `写入 Cookie${what}`;
        case "cookies_delete":
          return `删除 Cookie${what}`;
        case "cookies_clear":
          return "清空 Cookie";
        case "storage_list":
          return reveal ? `读取 ${area} 明文` : `查看 ${area}`;
        case "storage_get":
          return reveal ? `读取 ${area}${what} 明文` : `查看 ${area}${what}`;
        case "storage_set":
          return `写入 ${area}${what}`;
        case "storage_remove":
          return `删除 ${area}${what}`;
        case "storage_clear":
          return `清空 ${area}`;
        case "idb_list":
          return "查看 IndexedDB 库";
        case "export_state":
          return "导出登录状态";
        case "import_state":
          return "导入登录状态";
        case "clear_site":
          return "清空站点数据";
        default:
          return "登录态操作";
      }
    }
    // ── /E2·S2 ──
    // ── E2·P1 ──
    case "browser_permissions": {
      // 只显示动作 + 权限名（origin 是页面可控字符串，折叠行不展示）
      const action = str(o, "action");
      const perm = clip(str(o, "permission"), 24);
      const what = perm ? `「${perm}」` : "";
      switch (action) {
        case "grant":
          return `授予页面权限${what}`;
        case "deny":
          return `拒绝页面权限${what}`;
        case "reset":
          return `重置页面权限${what}`;
        default:
          return "查看页面权限";
      }
    }
    // ── /E2·P1 ──
    // ── E2·S3（A5 网络规则）──
    case "browser_network_rules": {
      // 只显示动作 + pattern 的 host/path 部分（headers 的值是凭据，折叠行绝不展示；pattern 里的 query 也去掉）
      const action = str(o, "action");
      const pattern = clip(str(o, "pattern").split(/[?#]/)[0] ?? "", 40);
      const at = pattern ? ` · ${pattern}` : "";
      switch (action) {
        case "block":
          return `屏蔽请求${at}`;
        case "set_headers":
          return `给请求加头${at}`;
        case "mock":
          return `模拟响应${at}`;
        case "fail":
          return `让请求失败${at}`;
        case "delay":
          return `延迟请求${at}`;
        case "clear":
          return "清除网络规则";
        default:
          return "查看网络规则";
      }
    }
    // ── /E2·S3 ──
    // ── E2·P6（B2 性能）──
    case "browser_perf": {
      switch (str(o, "action")) {
        case "start_trace":
          return "开始性能录制";
        case "stop_trace":
          return "结束性能录制";
        case "metrics":
          return "读取性能指标";
        case "heap_snapshot":
          return "保存堆快照";
        case "coverage_start":
          return "开始覆盖率统计";
        case "coverage_stop":
          return "结束覆盖率统计";
        default:
          return "性能分析";
      }
    }
    // ── /E2·P6 ──
    // ── E2·P9（B7 录制）──
    case "browser_record": {
      switch (str(o, "action")) {
        case "start":
          return "开始录制页面";
        case "stop":
          return "结束录制";
        case "status":
          return "查看录制状态";
        case "export":
          return "导出录制";
        case "export_activity":
          return "导出活动日志";
        default:
          return "页面录制";
      }
    }
    // ── /E2·P9 ──
    // ── E2·C4（剪贴板）──
    case "browser_clipboard": {
      // 写入的文字可能是口令，折叠行只显示字数（落盘前已被 redact-args 换成「[已隐藏 N 字符]」）
      const action = str(o, "action");
      switch (action) {
        case "write": {
          const text = str(o, "text");
          const n = hiddenCount(text) ?? [...text].length;
          return n > 0 ? `写入剪贴板 · ${n} 字符` : "写入剪贴板";
        }
        case "watch_start":
          return "开始观察剪贴板变化";
        case "read":
          return "读取剪贴板的变化";
        default:
          return "剪贴板";
      }
    }
    // ── /E2·C4 ──
    // ── E2·P7（B3 源码与问题）──
    case "browser_sources": {
      const action = str(o, "action");
      const target = pickStr(o, "url", "url") || pickStr(o, "script_id", "scriptId");
      switch (action) {
        case "list":
          return pickStr(o, "url", "url") ? `列出资源 · ${clip(pickStr(o, "url", "url"), 40)}` : "列出已加载的脚本 / 样式表";
        case "get":
          return `读取源码${target ? ` · ${shortUrl(target)}` : ""}${pickBool(o, "original", "original") ? "（含 sourcemap 还原）" : ""}`;
        case "sourcemap":
          return `查看 sourcemap${target ? ` · ${shortUrl(target)}` : ""}`;
        case "issues":
          return "查看浏览器报告的问题";
        default:
          return "源码与问题";
      }
    }
    // ── /E2·P7 ──
    // ── E2·P8（B5 调试器）──
    case "browser_debug": {
      // 只显示动作、脚本短名与行号；condition / 变量值不进摘要（condition 是页面里执行的代码）
      const action = str(o, "action");
      const target = pickStr(o, "url", "url") || pickStr(o, "url_regex", "urlRegex");
      const line = Number(o.line);
      switch (action) {
        case "set_breakpoint":
          return `设置断点${target ? ` · ${shortUrl(target)}` : ""}${Number.isFinite(line) ? `:${Math.round(line)}` : ""}${pickStr(o, "condition", "condition") ? "（带条件）" : ""}`;
        case "remove_breakpoint":
          return "删除断点";
        case "list_breakpoints":
          return "查看断点";
        case "pause_on_exception": {
          const state = pickStr(o, "state", "state");
          return state === "none" ? "关闭异常时暂停" : state === "all" ? "遇到所有异常时暂停" : "遇到未捕获异常时暂停";
        }
        case "status":
          return "查看调试状态";
        case "step_over":
          return "单步跳过";
        case "step_into":
          return "单步进入";
        case "step_out":
          return "单步跳出";
        case "resume":
          return "继续运行";
        case "scope":
          return "读取暂停帧的变量";
        default:
          return "调试器";
      }
    }
    // ── /E2·P8 ──
    // ── E2·P5b ──
    case "browser_touch": {
      // 只显示手势与坐标 / ref（都不含页面文字）
      const action = str(o, "action");
      const x = Number(o.x);
      const y = Number(o.y);
      const at = ref ? ref : Number.isFinite(x) && Number.isFinite(y) ? `(${Math.round(x)}, ${Math.round(y)})` : "";
      const suffix = at ? ` ${at}` : "";
      switch (action) {
        case "tap":
          return `触屏轻触${suffix}`;
        case "long_press":
          return `触屏长按${suffix}`;
        case "swipe": {
          const dir = SWIPE_DIR_ZH[pickStr(o, "direction", "direction")];
          return `触屏滑动${suffix}${dir ? ` 向${dir}` : ""}`;
        }
        case "pinch": {
          const scale = Number(o.scale);
          return `双指${Number.isFinite(scale) && scale < 1 ? "缩小" : "放大"}${suffix}`;
        }
        default:
          return "触屏手势";
      }
    }
    // ── /E2·P5b ──
    default:
      return "";
  }
};
