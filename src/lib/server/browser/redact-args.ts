/**
 * 浏览器工具入参的落盘前脱敏（R1-02 server 部分）。
 *
 * # 为什么需要
 * 模型调用 `browser_type` / `browser_fill_form` 时传的明文（账号、手机号、卡号、验证码、口令）会随 tool_call 事件
 * 写进 `events.jsonl`、并经 SSE 推给聊天流（摘要行 `调用 xxx:{…}` 的前 120 字、`meta.args` 的前 500 字）。
 * `browserToolSummary` 只遮折叠行，`event-secret-redact` 只做「配置里的密钥精确值替换」，都覆盖不到这里。
 *
 * # 约定
 * - 入口是纯函数 {@link redactBrowserArgs}：`browser_type.text`、`browser_fill_form.fields[].value`、
 *   `browser_dialog.prompt_text`、`browser_storage.value`（E2·A1：cookie / web storage 的值）、
 *   `browser_press_key` 的「会打出可见字符」的按键 → `[已隐藏 N 字符]`（N = 码点数）。
 *   不动 ref / submit / checked / values（下拉项）这类结构信息，所以摘要与工具块仍然可读。
 * - 空串不隐藏：`text:""` 是「清空输入框」，没有信息量，展示端要靠它显示「清空」。
 * - 幂等：已经是占位符的值不会被再包一层（`[已隐藏 5 字符]` 不会变成 `[已隐藏 11 字符]`）。
 * - 不改入参对象：有改动时返回浅拷贝，没改动返回原引用（工具真实执行用的 args 一个字不动）。
 * - 工具名两种形态都认：pi 路径是裸名 `browser_type`；Cursor SDK 路径是 MCP 外壳
 *   `name:"mcp", args:{ providerIdentifier, toolName:"browser_type", args:{…真入参} }`（也认归一化后的 `mcp:<server>:browser_type`）。
 * - 解析不了就**整体隐藏**（fail-closed）：`fields` 是 JSON 字符串但 JSON 不完整（SDK 流式补 args 时会出现）、
 *   或字段类型不对时，宁可多藏。
 *
 * 零依赖（不 import 任何 server 模块），sdk-message-handler 可以安全引用，不会成环。
 */

const BROWSER_PREFIX = "browser_";

/** 占位符：`[已隐藏 N 字符]` */
export const hiddenCharsText = (n: number): string => `[已隐藏 ${n} 字符]`;

/** 占位符的识别（展示端据此还原「N 个字符」；也用来保证幂等） */
export const HIDDEN_CHARS_RE = /^\[已隐藏 (\d+) 字符\]$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** 码点数（不分配数组：text 可能很长） */
const codePointCount = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    // 高低代理对算一个码点
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return n;
};

/** 入参里可能带明文的浏览器工具（解析不了入参时只对它们整体隐藏） */
const SECRET_BEARING_TOOLS: ReadonlySet<string> = new Set([
  "browser_type",
  "browser_fill_form",
  "browser_dialog",
  "browser_press_key",
  // E2·A1：cookies_set / storage_set 的 value 就是登录凭据（会话令牌 / JWT）
  "browser_storage",
  // E2·S3·A5：set_headers 的 headers 值常是 Authorization / API key
  "browser_network_rules",
  // E2·C4：write 的 text 是模型要放进用户剪贴板的内容（可能含口令 / 令牌），落盘前藏起来
  "browser_clipboard",
]);

const hide = (v: unknown): unknown => {
  if (v === undefined || v === null) return v;
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
  }
  if (s === "") return v; // 空串 = 清空，不泄露任何东西
  if (HIDDEN_CHARS_RE.test(s)) return v; // 已经隐藏过
  return hiddenCharsText(codePointCount(s));
};

// ----------------- press_key：只藏「会打出字符」的按键 -----------------

/** 单独按下不改变「打出字符」的修饰键之外，这些修饰键组合起来仍会产出可见字符（Shift+a、Alt+@、AltGr / Ctrl+Alt+键） */
const isPrintingCombo = (mods: string[]): boolean => {
  const set = new Set(mods.map((m) => m.trim().toLowerCase()).filter(Boolean));
  if (set.size === 0) return false;
  const printingOnly = [...set].every((m) => m === "shift" || m === "alt" || m === "option" || m === "altgr");
  if (printingOnly) return true;
  // AltGr 在 Windows 上 = Ctrl+Alt（德语布局的 @ \ | 等）
  const hasCtrl = set.has("control") || set.has("ctrl");
  const hasAlt = set.has("alt") || set.has("option") || set.has("altgr");
  return hasCtrl && hasAlt && [...set].every((m) => ["control", "ctrl", "alt", "option", "altgr", "shift"].includes(m));
};

/**
 * key 是否会往输入框里打出一个可见字符：单个码点，或「Shift / Alt / AltGr + 单个码点」。
 * 导出给 tools.ts 的 press_key 结果文案共用（R2-03 ①）：入参里隐藏了，回显也必须隐藏，两处判定不能各写一份。
 */
export const keyTypesCharacter = (rawKey: string): boolean => {
  // 与主进程 `parseKeyCombo`（electron-app/browser/actions.mjs）同一套切分规则（R2-03 复审③）：整串与每一段都先 trim——
  // `" a"` / `"a "` / `"Shift+ a"` / `"shift + a"` 在主进程都按成字符 `a` 执行，这里不能因为带空白就判成「不是单字符」而漏藏。
  // 两处在不同的构建边界里（本文件零依赖、不能 import 主进程模块），所以规则各写一份，由 tests/browser-r1-secret-input.test.ts（`describe("R2-03 复审③ …")`）的对照用例钉死一致。
  // 未 trim 的单码点先判（含单个空白 `" "`）：主进程对 `" "` 会拒绝（不能为空），但入参里的单个字符一律按「字符键」隐藏，宁可多藏不漏藏。
  if (codePointCount(rawKey) === 1) return true;
  const key = rawKey.trim();
  if (codePointCount(key) === 1) return true;
  let parts: string[];
  if (key.endsWith("++")) parts = [...key.slice(0, -2).split("+"), "+"]; // "Shift++"：最后一段是字面量 "+"
  else parts = key.split("+");
  parts = parts.map((p) => p.trim());
  const last = parts.pop() ?? "";
  const mods = parts.filter((p) => p !== "");
  if (mods.length === 0 || codePointCount(last) !== 1) return false;
  return isPrintingCombo(mods);
};

// ----------------- 各工具的入参脱敏 -----------------

/** fields 可能是数组，也可能是（模型写成的）JSON 字符串 */
const redactFields = (fields: unknown): unknown => {
  if (typeof fields === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fields);
    } catch {
      return hide(fields); // 不完整的 JSON：整体隐藏
    }
    const out = redactFields(parsed);
    return out === parsed ? fields : JSON.stringify(out);
  }
  if (!Array.isArray(fields)) return fields;
  let changed = false;
  const next = fields.map((f) => {
    if (!isRecord(f)) return f;
    if (!("value" in f)) return f;
    const v = hide(f.value);
    if (v === f.value) return f;
    changed = true;
    return { ...f, value: v };
  });
  return changed ? next : fields;
};

/**
 * E2·S3·A5 browser_network_rules 的 headers：只藏「值」、留头名（数组 [{name,value}] / 对象 {名:值} / 流式补全中的 JSON 字符串都认）。
 * 解析不了的字符串整体隐藏（fail-closed）。
 */
const redactHeadersArg = (headers: unknown): unknown => {
  if (typeof headers === "string") {
    if (headers === "") return headers;
    let parsed: unknown;
    try {
      parsed = JSON.parse(headers);
    } catch {
      return hide(headers);
    }
    const out = redactHeadersArg(parsed);
    return out === parsed ? headers : JSON.stringify(out);
  }
  if (Array.isArray(headers)) {
    let changed = false;
    const next = headers.map((h) => {
      if (!isRecord(h) || !("value" in h)) return h;
      const v = hide(h.value);
      if (v === h.value) return h;
      changed = true;
      return { ...h, value: v };
    });
    return changed ? next : headers;
  }
  if (isRecord(headers)) {
    // 单条 {name, value} 形态
    if (typeof headers.name === "string" && "value" in headers && Object.keys(headers).length <= 2) {
      const v = hide(headers.value);
      return v === headers.value ? headers : { ...headers, value: v };
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(headers)) {
      const v = hide(val);
      if (v !== val) changed = true;
      next[k] = v;
    }
    return changed ? next : headers;
  }
  return headers;
};

/** 对「扁平入参」按工具名脱敏；返回新对象或原引用 */
const redactFlatArgs = (tool: string, args: Record<string, unknown>): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  switch (tool) {
    case "browser_type": {
      if ("text" in args) patch.text = hide(args.text);
      break;
    }
    case "browser_fill_form": {
      if ("fields" in args) patch.fields = redactFields(args.fields);
      break;
    }
    case "browser_dialog": {
      // prompt 对话框的输入也是「往页面里打字」，页面完全可以问「请输入密码」
      if ("prompt_text" in args) patch.prompt_text = hide(args.prompt_text);
      break;
    }
    case "browser_press_key": {
      const key = args.key;
      if (typeof key === "string" && keyTypesCharacter(key)) patch.key = hiddenCharsText(1);
      break;
    }
    case "browser_storage": {
      // E2·A1：value 是 cookie / web storage 的值（登录凭据），落盘前一律藏起来；name / key / action 等是名字，保留以便回看
      if ("value" in args) patch.value = hide(args.value);
      break;
    }
    case "browser_network_rules": {
      // E2·S3·A5：头值（可能是 token）落盘前藏起来，头名保留；pattern / status / body 等不是凭据
      if ("headers" in args) patch.headers = redactHeadersArg(args.headers);
      break;
    }
    case "browser_clipboard": {
      if ("text" in args) patch.text = hide(args.text);
      break;
    }
    default:
      return args;
  }
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (v !== args[k]) changed = true;
  }
  return changed ? { ...args, ...patch } : args;
};

/** 入参本身是 JSON 字符串（SDK 流式补 args 的中间态）：能解析就脱敏后再序列化，解析不了整体隐藏 */
const redactArgsValue = (tool: string, args: unknown): unknown => {
  if (isRecord(args)) return redactFlatArgs(tool, args);
  if (typeof args === "string" && args !== "") {
    try {
      const parsed: unknown = JSON.parse(args);
      if (!isRecord(parsed)) return args;
      const out = redactFlatArgs(tool, parsed);
      return out === parsed ? args : JSON.stringify(out);
    } catch {
      // 不完整的 JSON：只有会带明文的工具才整体隐藏
      return SECRET_BEARING_TOOLS.has(tool) ? hide(args) : args;
    }
  }
  return args;
};

/** 从事件里的工具名 / args 外壳里认出浏览器工具；不是浏览器工具返回 null */
const resolveBrowserTool = (
  name: unknown,
  args: unknown,
): { tool: string; wrapped: boolean } | null => {
  const n = typeof name === "string" ? name : "";
  const lower = n.toLowerCase();
  if (lower.startsWith(BROWSER_PREFIX)) return { tool: lower, wrapped: false };
  const wrapperTool =
    isRecord(args) && typeof args.toolName === "string" && args.toolName.toLowerCase().startsWith(BROWSER_PREFIX)
      ? args.toolName.toLowerCase()
      : null;
  if (lower === "mcp") return wrapperTool ? { tool: wrapperTool, wrapped: true } : null;
  if (lower.startsWith("mcp:")) {
    // 归一化展示名 mcp:<server>:<tool>（tool 里的 : 被转义成 %3A，所以最后一个 : 之后就是工具名）
    const tail = lower.slice(lower.lastIndexOf(":") + 1);
    if (!tail.startsWith(BROWSER_PREFIX)) return null;
    return { tool: tail, wrapped: wrapperTool !== null && isRecord(args) && "args" in args };
  }
  return null;
};

/**
 * 浏览器工具入参脱敏（纯函数）。不是浏览器工具 / 没有需要藏的字段 → 返回原引用。
 *
 * @param name 事件里的工具名（`browser_type` / `mcp` / `mcp:custom-user-tools:browser_type`）
 * @param args 事件里的原始入参（对象；或 SDK 流式补全中的 JSON 字符串）
 */
export const redactBrowserArgs = (name: unknown, args: unknown): unknown => {
  const hit = resolveBrowserTool(name, args);
  if (!hit) return args;
  if (!hit.wrapped) return redactArgsValue(hit.tool, args);
  const outer = args as Record<string, unknown>;
  const inner = outer.args;
  if (inner === undefined || inner === null) return args;
  const redacted = redactArgsValue(hit.tool, inner);
  return redacted === inner ? args : { ...outer, args: redacted };
};

/**
 * 对一条 SDK tool_call 消息套 {@link redactBrowserArgs}：有改动返回浅拷贝（args 已脱敏），没改动返回原引用。
 * sdk-message-handler 在入口处调一次，之后各条落盘 / 广播路径用的都是脱敏后的 args。
 */
export const redactBrowserToolCallMessage = <M extends { name?: unknown; args?: unknown }>(msg: M): M => {
  const next = redactBrowserArgs(msg.name, msg.args);
  return next === msg.args ? msg : ({ ...msg, args: next } as M);
};
