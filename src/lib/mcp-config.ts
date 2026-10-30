/**
 * MCP 配置常量（client / server 共用）
 *
 * 合并 Cursor + 自管配置的 mergeMcpSources 已删——运行时只读 fe 自管、
 * Cursor mcp.json 仅作能力页「从 Cursor 导入」源、不再做隐式合并。
 */
/** runtime 不允许用户占用：旧 HTTP 注入名 + SDK 合成 customTools 服务器名 */
export const RESERVED_MCP_NAMES = new Set(["flowshipChat", "custom-user-tools"]);

/** 高级「整体 JSON」解析结果 */
export type BulkMcpJsonResult =
  | { ok: true; servers: Record<string, Record<string, unknown>> }
  | { ok: false; error: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/**
 * 单个 MCP server 条目的形状校验（R14 B6-2 · Q6-04）。返回 null = 合法，否则是一句**不带用户原值**的中文原因。
 *
 * 为什么要有：条目里 `url` 写成数字 / 对象（手改、粘贴错）时，起 agent 前的 OAuth 注入
 * （`enrichMcpServersWithOAuth` → `normalizeServerUrl(url)` 里的 `.trim()`）会抛 TypeError，
 * 新任务和新对话一起起不来——一条坏条目拖垮全部。保存入口与读取层都用它拦。
 *
 * 判据与运行时一致：含 `url` 键 = 远程（http / sse），否则 = stdio（须有 command）。
 * 只拦「会让运行时抛错、或必然连不上」的类型错误；可选字段写成 `null` 按「没设置」放行（原行为本来就放行）。
 * **刻意不校验**：
 * - url 的语法 / 协议：`${env:X}` 这类占位写法的导入配置不该被误伤；坏 url 也只是这一条连不上
 *   （OAuth 探测里对坏 url 有 try/catch，不会拖垮别的 server）；
 * - `type` 的取值：Cursor 导入的配置可能有别名，只要求有值时是字符串；
 * - headers / env 的值类型、args 的元素类型：SDK 声明是 string，但数字值在 Node 下会被转成字符串，没有实证前不拦。
 * 未知字段一律放行。
 */
export const validateMcpServerConfig = (cfg: unknown): string | null => {
  if (!isPlainObject(cfg)) return "配置必须是对象";
  if (cfg.type != null && typeof cfg.type !== "string") return "type 必须是字符串";
  if ("url" in cfg) {
    if (!isNonEmptyString(cfg.url)) return "url 必须是非空字符串";
    if (cfg.headers != null && !isPlainObject(cfg.headers)) return "headers 必须是对象";
    if (cfg.auth != null) {
      if (!isPlainObject(cfg.auth)) return "auth 必须是对象";
      if (typeof cfg.auth.CLIENT_ID !== "string") return "auth.CLIENT_ID 必须是字符串";
    }
    return null;
  }
  if (!isNonEmptyString(cfg.command)) return "缺少 url（远程）或 command（本地进程）";
  if (cfg.args != null && !Array.isArray(cfg.args)) return "args 必须是数组";
  if (cfg.env != null && !isPlainObject(cfg.env)) return "env 必须是对象";
  if (cfg.cwd != null && typeof cfg.cwd !== "string") return "cwd 必须是字符串";
  return null;
};

/**
 * 校验「高级：整体 JSON 编辑」的草稿（S13-09）。
 * 原实现每次击键只要 JSON.parse 成功就整包落盘——粘贴到一半的合法片段（比如只剩一个 server、
 * 或 `{"mcpServers":{}}`）会直接清空已配置的 MCP。现在只做校验、由用户点「保存」才落盘。
 * 规则与单条编辑 dialog 对齐：名称非空、不占内置保留名、每个 server 是对象且形状合法（validateMcpServerConfig）。
 */
export const parseBulkMcpJson = (raw: string): BulkMcpJsonResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
    return { ok: false, error: "顶层需要 { \"mcpServers\": { ... } }" };
  }
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
    if (!name.trim()) return { ok: false, error: "server 名称不能为空" };
    if (RESERVED_MCP_NAMES.has(name)) {
      return { ok: false, error: `「${name}」是内置保留名、换一个` };
    }
    if (!isPlainObject(cfg)) {
      return { ok: false, error: `「${name}」的配置必须是对象` };
    }
    const invalid = validateMcpServerConfig(cfg);
    if (invalid) return { ok: false, error: `「${name}」的配置无效：${invalid}` };
    servers[name] = cfg;
  }
  return { ok: true, servers };
};
