/**
 * 增强包 E2 · A1 browser_storage（server 工具定义）：登录态——cookie / localStorage / sessionStorage / IndexedDB 库名，
 * 以及 export_state / import_state / clear_site。主进程实现在 electron-app/browser/ops/storage.mjs，纯逻辑在 storage-policy.mjs。
 *
 * # 闸门（两层，缺一不可）
 * 1. **本文件**先查 `storageAccess` 设置：写 / 删 / 清 / 导入导出，以及读类动作带 `reveal:true`（要明文）一律要它为 true，
 *    没开就地返回指向设置的文案（不走 bridge、不打扰主进程）；
 * 2. 主进程在 op 里**独立再判一次**（`ACCESS_DISABLED`）——工具表在会话创建时一次性建好，设置之后被关掉、或模型绕过本层，都靠主进程兜住。
 *
 * # 结果与不可信包装
 * 返回里的 cookie 名 / 域名 / storage 键值 / origin 全是**页面数据**：统一进 `ToolResultBuilder.untrusted`（带「不可信」标记与结尾固定提醒）；
 * 可信文本里只有固定话术与数字，页面来的字符串一律 `wrapUntrustedInline`。值默认只有「长度 + 前 4 位」，明文只在 reveal 时才会出现，
 * 且**不再过 redactSensitiveText**（用户明确开了开关并要求明文，脱敏会让 reveal 失去意义）。
 *
 * # 入参落盘脱敏
 * `value`（cookie / storage 的值）落盘前由 redact-args.ts 的 `browser_storage` 登记藏成 `[已隐藏 N 字符]`。
 *
 * 积木从 `kit` 取（见 tools.ts 的 buildToolKit）；不要 import "./tools"（成环），类型用 `import type`。
 */
import {
  Boolean as TBBoolean,
  Enum as TBEnum,
  Number as TBNumber,
  Object as TBObject,
  Optional as TBOptional,
  String as TBString,
} from "typebox/type";
import type { FlowshipToolDef } from "../flowship-tools";
import type { ToolResultBuilder } from "./content";
import type { BrowserToolKit } from "./tools";

export const STORAGE_TOOL_ACTIONS = [
  "cookies_list",
  "cookies_get",
  "cookies_set",
  "cookies_delete",
  "cookies_clear",
  "storage_list",
  "storage_get",
  "storage_set",
  "storage_remove",
  "storage_clear",
  "idb_list",
  "export_state",
  "import_state",
  "clear_site",
] as const;
export type StorageToolAction = (typeof STORAGE_TOOL_ACTIONS)[number];

/** 无论如何都要 storageAccess 的动作（与 electron-app/browser/storage-policy.mjs 的 STORAGE_WRITE_ACTIONS 同表，tests/browser-e2-p3-storage-tool.test.ts 钉死一致） */
export const STORAGE_WRITE_TOOL_ACTIONS: readonly StorageToolAction[] = [
  "cookies_set",
  "cookies_delete",
  "cookies_clear",
  "storage_set",
  "storage_remove",
  "storage_clear",
  "export_state",
  "import_state",
  "clear_site",
];
/** 带 reveal 才出明文的读动作 */
export const STORAGE_REVEAL_TOOL_ACTIONS: readonly StorageToolAction[] = ["cookies_list", "cookies_get", "storage_list", "storage_get"];

const SAME_SITE = ["lax", "strict", "none", "unspecified"] as const;
const AREAS = ["local", "session"] as const;

/** 这次调用要不要 storageAccess（与主进程 actionNeedsAccess 同口径） */
export const storageNeedsAccess = (action: StorageToolAction, reveal: boolean): boolean =>
  STORAGE_WRITE_TOOL_ACTIONS.includes(action) || (reveal && STORAGE_REVEAL_TOOL_ACTIONS.includes(action));

export const STORAGE_ACCESS_DISABLED_TEXT =
  "这项操作需要用户在 设置 → 内置浏览器 里打开「允许 AI 读写登录态」（Cookie / 本地存储里可能有登录凭据，默认关闭）。" +
  "没开时只能用 browser_storage 查看名称与属性（值已脱敏、不带 reveal）。请不要重试，也不要绕路读取（比如用 browser_evaluate 读 document.cookie）；" +
  "确有必要请 ask_user 请用户开启，或用 browser_ask_user_to_act 请用户自己登录。";

/** 主进程返回的 cookie 条目（名字 / 属性 + 脱敏提示或明文；全部来自页面，渲染时不可信） */
interface CookieOut {
  name?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  session?: boolean;
  expires?: number;
  size?: number;
  valueHint?: string;
  value?: string;
  valueTruncated?: boolean;
}
interface StorageItemOut {
  key?: string;
  size?: number;
  valueHint?: string;
  value?: string;
  valueTruncated?: boolean;
}
interface StorageResult {
  action?: string;
  scope?: string;
  origin?: string;
  area?: string;
  total?: number;
  truncated?: boolean;
  revealed?: boolean;
  cookies?: CookieOut[];
  set?: CookieOut;
  items?: StorageItemOut[];
  item?: StorageItemOut;
  exists?: boolean;
  existed?: boolean;
  key?: string;
  size?: number;
  removed?: number;
  remaining?: number;
  cleared?: number;
  databases?: Array<{ name?: string; version?: number; objectStores?: Array<{ name?: string; autoIncrement?: boolean; indexes?: number }>; objectStoresTotal?: number }>;
  file?: string;
  dir?: string;
  bytes?: number;
  origins?: Array<{ origin?: string; items?: number }>;
  note?: string;
  cookiesSet?: number;
  cookiesExpired?: number;
  failed?: number;
  localStorageSet?: number;
  skippedOrigins?: string[];
  cookiesRemoved?: number;
  cookiesRemaining?: number;
  webStorageCleared?: boolean;
  /** runAction 因页面有未处理对话框而没执行时带的字段 */
  notExecuted?: boolean;
  dialog?: unknown;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const createStorageTools = (kit: BrowserToolKit): FlowshipToolDef[] => {
  const { run, guarded, errorOut, BadArgs, argStr, argBool, argNum, argEnum, clipEntry, wrapUntrustedInline, truncateWithNote } = kit;

  const inline = (s: unknown, n = 120): string => wrapUntrustedInline(clipEntry(s, n));
  const maskNote = "值已脱敏（只给长度与前 4 位）；要明文需带 reveal=true 且用户开启了「允许 AI 读写登录态」";
  const MAX_TEXT = 20_000;

  const cookieLine = (c: CookieOut): string => {
    const flags = [c.secure ? "Secure" : "", c.httpOnly ? "HttpOnly" : "", c.sameSite && c.sameSite !== "unspecified" ? `SameSite=${c.sameSite}` : ""].filter(Boolean).join(" ");
    const exp = c.session || c.expires === undefined ? "会话" : `过期 ${new Date(c.expires * 1000).toISOString().slice(0, 16).replace("T", " ")}Z`;
    const val = c.value !== undefined ? `值=${JSON.stringify(c.value)}${c.valueTruncated ? "（已截断）" : ""}` : `值${c.valueHint ?? "[?]"}`;
    return `${clipEntry(c.name, 200)} | ${clipEntry(c.domain, 120)}${clipEntry(c.path, 120)} | ${flags || "-"} | ${exp} | ${num(c.size)}B | ${val}`;
  };

  const itemLine = (i: StorageItemOut): string => {
    const val = i.value !== undefined ? `值=${JSON.stringify(i.value)}${i.valueTruncated ? "（已截断）" : ""}` : `值${i.valueHint ?? "[?]"}`;
    return `${clipEntry(i.key, 200)} | ${num(i.size)} 字符 | ${val}`;
  };

  const render = (r: StorageResult, b: ToolResultBuilder): void => {
    if (r?.notExecuted) {
      b.trusted("没有执行：页面上有一个未处理的对话框（alert / confirm 等），请先用 browser_dialog 处理，再重新调用。");
      return;
    }
    const clipText = (s: string) => truncateWithNote(s, MAX_TEXT).text;
    switch (r?.action) {
      case "cookies_list":
      case "cookies_get": {
        const list = Array.isArray(r.cookies) ? r.cookies : [];
        if (list.length === 0) {
          b.trusted(`没有匹配的 cookie（范围：${inline(r.scope)}）。`).markUntrusted();
          return;
        }
        b.trusted(
          `Cookie ${num(r.total)} 个${r.truncated ? `（只显示前 ${list.length} 个）` : ""}。${r.revealed ? "已按要求显示明文值。" : maskNote + "。"}列：名称 | 域名+路径 | 属性 | 过期 | 大小 | 值。`,
        );
        b.untrusted(clipText(`范围：${clipEntry(r.scope, 120)}\n${list.map(cookieLine).join("\n")}`));
        return;
      }
      case "cookies_set": {
        const c = r.set;
        b.trusted(`已写入 cookie ${inline(c?.name, 80)}（域 ${inline(c?.domain, 80)}，路径 ${inline(c?.path, 80)}）。页面通常要刷新（browser_navigate action:"reload"）才会按新登录态工作。`).markUntrusted();
        return;
      }
      case "cookies_delete":
      case "cookies_clear": {
        b.trusted(`已删除 ${num(r.removed)} 个 cookie（范围：${inline(r.scope)}）${num(r.remaining) > 0 ? `，该范围内还剩 ${num(r.remaining)} 个（可能是其它路径的同名 cookie）` : ""}。`).markUntrusted();
        return;
      }
      case "storage_list": {
        const items = Array.isArray(r.items) ? r.items : [];
        const area = r.area === "session" ? "sessionStorage" : "localStorage";
        if (items.length === 0) {
          b.trusted(`${area} 是空的（${inline(r.origin)}）。`).markUntrusted();
          return;
        }
        b.trusted(`${area} ${num(r.total)} 项${r.truncated ? `（只显示前 ${items.length} 项）` : ""}。${r.revealed ? "已按要求显示明文值。" : maskNote + "。"}列：键 | 长度 | 值。`);
        b.untrusted(clipText(`来源：${clipEntry(r.origin, 120)}\n${items.map(itemLine).join("\n")}`));
        return;
      }
      case "storage_get": {
        const area = r.area === "session" ? "sessionStorage" : "localStorage";
        if (!r.exists || !r.item) {
          b.trusted(`${area} 里没有这个键（${inline(r.origin)}）。`).markUntrusted();
          return;
        }
        b.trusted(`${area} 的一项。${r.revealed ? "已按要求显示明文值。" : maskNote + "。"}`);
        b.untrusted(clipText(`来源：${clipEntry(r.origin, 120)}\n${itemLine(r.item)}`));
        return;
      }
      case "storage_set":
      case "storage_remove": {
        const area = r.area === "session" ? "sessionStorage" : "localStorage";
        const verb = r.action === "storage_set" ? "已写入" : r.existed === false ? "没有这个键，无需删除：" : "已删除";
        b.trusted(`${verb} ${area} 的键 ${inline(r.key, 80)}（${inline(r.origin)}）。页面脚本若已缓存旧值，可能要刷新页面才生效。`).markUntrusted();
        return;
      }
      case "storage_clear": {
        const area = r.area === "session" ? "sessionStorage" : "localStorage";
        b.trusted(`已清空 ${area}（${num(r.cleared)} 项，${inline(r.origin)}）。`).markUntrusted();
        return;
      }
      case "idb_list": {
        const dbs = Array.isArray(r.databases) ? r.databases : [];
        if (dbs.length === 0) {
          b.trusted(`这个站点没有 IndexedDB 数据库（${inline(r.origin)}）。`).markUntrusted();
          return;
        }
        b.trusted(`IndexedDB 数据库 ${num(r.total)} 个${r.truncated ? `（只显示前 ${dbs.length} 个）` : ""}（只列库名与对象仓库名，不读数据）：`);
        b.untrusted(
          clipText(
            `来源：${clipEntry(r.origin, 120)}\n` +
              dbs
                .map((d) => {
                  const stores = (d.objectStores ?? []).map((s) => `${clipEntry(s.name, 80)}${s.autoIncrement ? "(自增)" : ""}[索引 ${num(s.indexes)}]`).join("，");
                  return `${clipEntry(d.name, 120)} v${num(d.version)} | 对象仓库 ${num(d.objectStoresTotal)}：${stores || "无"}`;
                })
                .join("\n"),
          ),
        );
        return;
      }
      case "export_state": {
        const origins = (r.origins ?? []).map((o) => `${clipEntry(o.origin, 100)} ${num(o.items)} 项`).join("；");
        b.trusted(
          `已导出登录状态到任务目录 ${r.dir ?? "browser-state"}/${inline(r.file, 80)}（${num(r.cookies)} 个 cookie${origins ? `；localStorage：${wrapUntrustedInline(origins)}` : ""}，${num(r.bytes)} 字节）。` +
            "文件含明文凭据（0600 权限），只能用 import_state 导回，不要把内容读出来复述或发给别人；超过 14 天 / 30 个的旧文件会自动清理。" +
            (r.note ? `注意：${inline(r.note, 120)}。` : ""),
        ).markUntrusted();
        return;
      }
      case "import_state": {
        const skipped = r.skippedOrigins ?? [];
        b.trusted(
          `已导入登录状态 ${inline(r.file, 80)}：写入 ${num(r.cookiesSet)} 个 cookie${num(r.localStorageSet) ? `、${num(r.localStorageSet)} 项 localStorage` : ""}` +
            `${num(r.cookiesExpired) ? `，跳过 ${num(r.cookiesExpired)} 个已过期的 cookie` : ""}${num(r.failed) ? `，${num(r.failed)} 项写入失败` : ""}。` +
            (skipped.length ? `其它站点（${wrapUntrustedInline(skipped.map((s) => clipEntry(s, 80)).join("、"))}）的 localStorage 没写入：先 browser_navigate 到那个站点再 import_state 一次即可补写。` : "") +
            "需要 browser_navigate action:\"reload\" 刷新页面才会按新登录态工作。",
        ).markUntrusted();
        return;
      }
      case "clear_site": {
        b.trusted(
          `已清空站点数据（${inline(r.origin)}）：删除 ${num(r.cookiesRemoved)} 个 cookie，并清掉本地存储 / IndexedDB / 缓存等${r.webStorageCleared === false ? "（当前页面的 web storage 通过 CDP 清除失败，已用整站清理兜底）" : ""}。${num(r.cookiesRemaining) > 0 ? `仍剩 ${num(r.cookiesRemaining)} 个 cookie（可能属于其它路径）。` : ""}页面需要刷新才会回到未登录状态。`,
        ).markUntrusted();
        return;
      }
      default:
        b.trusted("操作完成。");
    }
  };

  const storageTool: FlowshipToolDef = {
    name: "browser_storage",
    label: "浏览器·登录态",
    description:
      "读写登录态：cookie、localStorage / sessionStorage（storage_* 须带 area）、IndexedDB 库名，export_state / import_state 存取登录态文件（file），clear_site 清当前站点；cookie 范围用 url / domain / all，缺省当前站点。" +
      "默认只返回名称与属性（值脱敏为「长度+前4位」），看明文（reveal=true）与一切写 / 删 / 清 / 导入导出，要用户在设置开启「允许 AI 读写登录态」；能让用户自己登录就别动 cookie。",
    // 体量预算（单工具 ≤1100）：参数描述一律省掉，名字自解释；细节（范围、必填项、导出须知）放在结果文案与错误提示里
    parameters: TBObject({
      action: TBEnum([...STORAGE_TOOL_ACTIONS]),
      url: TBOptional(TBString()),
      domain: TBOptional(TBString()),
      all: TBOptional(TBBoolean()),
      name: TBOptional(TBString()),
      value: TBOptional(TBString()),
      path: TBOptional(TBString()),
      secure: TBOptional(TBBoolean()),
      http_only: TBOptional(TBBoolean()),
      same_site: TBOptional(TBEnum([...SAME_SITE])),
      expires: TBOptional(TBNumber({ description: "unix 秒；缺省=会话 cookie" })),
      area: TBOptional(TBEnum([...AREAS])),
      key: TBOptional(TBString()),
      reveal: TBOptional(TBBoolean()),
      file: TBOptional(TBString()),
      include_storage: TBOptional(TBBoolean()),
      tab_id: TBOptional(TBString()),
    }),
    handler: guarded(async (args, ctx) => {
      const action = argEnum(args, "action", STORAGE_TOOL_ACTIONS);
      if (!action) throw new BadArgs(`缺少必填参数 action（${STORAGE_TOOL_ACTIONS.join(" / ")}）`);
      const reveal = argBool(args, "reveal") === true && STORAGE_REVEAL_TOOL_ACTIONS.includes(action);

      // 文本值要保留空串 / 空白（argStr 把空串当没给）：cookie / storage 的值允许是空的
      const rawValue = typeof args.value === "string" ? args.value : undefined;
      const name = argStr(args, "name");
      const key = argStr(args, "key");
      const area = argEnum(args, "area", AREAS);

      // 必填项：先在这里给出清楚的参数错误（主进程也会校验，这里省一次往返）
      if ((action === "cookies_get" || action === "cookies_set" || action === "cookies_delete") && !name) throw new BadArgs(`${action} 需要 name`);
      if (action === "cookies_set" && rawValue === undefined) throw new BadArgs("cookies_set 需要 value");
      if (action.startsWith("storage_") && !area) throw new BadArgs(`${action} 需要 area（local / session）`);
      if ((action === "storage_get" || action === "storage_set" || action === "storage_remove") && !key) throw new BadArgs(`${action} 需要 key`);
      if (action === "storage_set" && rawValue === undefined) throw new BadArgs("storage_set 需要 value");
      if (action === "import_state" && !argStr(args, "file")) throw new BadArgs("import_state 需要 file（export_state 返回的文件名）");

      // 第一道闸：设置没开就地拒（主进程那头还有独立的一道）
      if (storageNeedsAccess(action, reveal) && !kit.getSettings().storageAccess) return errorOut(STORAGE_ACCESS_DISABLED_TEXT);

      const url = argStr(args, "url");
      const domain = argStr(args, "domain");
      const all = argBool(args, "all");
      const path = argStr(args, "path");
      const sameSite = argEnum(args, "same_site", SAME_SITE);
      const secure = argBool(args, "secure");
      const httpOnly = argBool(args, "http_only");
      const expires = argNum(args, "expires");
      const file = argStr(args, "file");
      const includeStorage = argBool(args, "include_storage");
      const tabId = argStr(args, "tab_id");

      const opArgs: Record<string, unknown> = {
        action,
        ...(reveal ? { reveal: true } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(domain !== undefined ? { domain } : {}),
        ...(all === true ? { all: true } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(rawValue !== undefined && (action === "cookies_set" || action === "storage_set") ? { value: rawValue } : {}),
        ...(path !== undefined ? { path } : {}),
        ...(secure !== undefined ? { secure } : {}),
        ...(httpOnly !== undefined ? { httpOnly } : {}),
        ...(sameSite !== undefined ? { sameSite } : {}),
        ...(expires !== undefined ? { expires } : {}),
        ...(area !== undefined ? { area } : {}),
        ...(key !== undefined ? { key } : {}),
        ...(file !== undefined ? { file } : {}),
        ...(includeStorage !== undefined ? { includeStorage } : {}),
        ...(tabId !== undefined ? { tabId } : {}),
      };
      return run<StorageResult>(ctx, { op: "storage", args: opArgs, render });
    }),
  };
  return [storageTool];
};
