/**
 * 增强包 E2 · A8 browser_permissions（server 工具定义）：查看 / 管理页面权限（定位、通知、剪贴板读取等）。
 * 主进程实现在 electron-app/browser/ops/permissions.mjs，纯决策在 permission-policy.mjs，请求 / 检查处理器在 permission-gate.mjs。
 *
 * # 闸门（两层，缺一不可）
 * 1. **本文件**先查 `pagePermissions` 设置：`grant / deny / reset` 要它为 true，没开就地返回指向设置的文案（不走 bridge）；`list` 总可用；
 * 2. 主进程在 op 里**独立再判一次**（`ACCESS_DISABLED`），另外用户接管期间 `USER_CONTROL`、Flowship 自己的 origin 与永远拒绝的权限 `DENIED`。
 *
 * # 结果与不可信包装
 * 返回里的 origin 来自页面 URL：一律 `wrapUntrustedInline` / `untrusted` 块；可信文本里只有固定话术与数字。
 *
 * 积木从 `kit` 取（见 tools.ts 的 buildToolKit）；不要 import "./tools"（成环），类型用 `import type`。
 */
import { Enum as TBEnum, Object as TBObject, Optional as TBOptional, String as TBString } from "typebox/type";
import type { FlowshipToolDef } from "../flowship-tools";
import type { ToolResultBuilder } from "./content";
import type { BrowserToolKit } from "./tools";

export const PERMISSION_TOOL_ACTIONS = ["list", "grant", "deny", "reset"] as const;
export type PermissionToolAction = (typeof PERMISSION_TOOL_ACTIONS)[number];

/** 要 pagePermissions 开关的动作（与主进程 ops/permissions.mjs 同口径；list 不受限） */
export const PERMISSION_WRITE_TOOL_ACTIONS: readonly PermissionToolAction[] = ["grant", "deny", "reset"];

/** 设置没开时给 AI 的文案：指向设置路径、不让它反复重试或绕路 */
export const PERMISSIONS_DISABLED_TEXT =
  "页面权限的授予 / 拒绝 / 重置当前被设置关闭：需要用户在 设置 → 内置浏览器 → 打开「允许 AI 授予页面权限」。" +
  "没开时页面请求权限会弹提示由用户自己决定，list 仍可查看现状。请不要重试，也不要绕路；确有必要请 ask_user 请用户开启，或请用户在面板提示条里直接点允许。";

interface PermissionsResult {
  action?: string;
  enabled?: boolean;
  currentOrigin?: string | null;
  grants?: Array<{ origin?: string; permission?: string; decision?: string; source?: string; active?: boolean }>;
  emulatedGeolocation?: Array<{ tabId?: string; origin?: string }>;
  /** 最近没弹提示就被自动拒绝的请求（最新在前；reasonText 是主进程的固定文案，origin / frameOrigin 来自页面） */
  recentBlocked?: Array<{ origin?: string | null; frameOrigin?: string; permission?: string; reason?: string; reasonText?: string; count?: number; ageSec?: number }>;
  /** 同一 partition 里「最近被自动拒绝」的总条数（`recentBlocked` 只列最近几条，超出的靠它告知） */
  recentBlockedTotal?: number;
  /** 为真 = 该 partition 的清单到了上限、更早的记录已被挤掉，`recentBlockedTotal` 只是下限（写「至少 N 类」） */
  recentBlockedAtLeast?: boolean;
  /** 系统层（macOS 隐私设置 / Windows 全局开关）挡住的麦克风 / 摄像头；没有问题时不出现 */
  systemMedia?: { platform?: string; problems?: Array<{ permission?: string; status?: string }> };
  /** 页内 permissions.query 桩没装上的会话（scope：main = 主页面 / frame = 嵌入框架；message 是主进程截断过的 CDP 报错）；没有问题时不出现 */
  queryStub?: { problems?: Array<{ scope?: string; message?: string }> };
  cleared?: number;
  origin?: string;
  permission?: string;
  note?: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * 系统层挡住麦克风 / 摄像头的一句话（固定话术，只用主进程给的枚举值；认不出的值整条忽略）：
 * `denied` = 用户没在系统设置里放行（去打开即可）；`restricted` = 被系统策略限制（家长控制 / 设备管理 / 组织策略，用户自己改不了）。
 * 没有可报的问题返回空串。
 */
export const describeSystemMedia = (m: PermissionsResult["systemMedia"]): string => {
  if (!m || !Array.isArray(m.problems)) return "";
  const nameOf = (p?: string): string | null => (p === "microphone" ? "麦克风" : p === "camera" ? "摄像头" : null);
  const pick = (status: string): string[] =>
    m.problems!.filter((x) => x?.status === status).map((x) => nameOf(x?.permission)).filter((x): x is string => x !== null);
  const denied = pick("denied");
  const restricted = pick("restricted");
  if (denied.length === 0 && restricted.length === 0) return "";
  const os = m.platform === "darwin" ? "macOS " : m.platform === "win32" ? "Windows " : "";
  const parts: string[] = [];
  if (denied.length > 0) parts.push(`${os}系统设置里没有允许 Flowship 使用${denied.join(" / ")}（要请用户到系统的隐私设置里打开）`);
  if (restricted.length > 0) {
    // 第二十三轮 R23-6：Windows 上 `restricted` 的具体触发场景没有在真机验证过，全局「让桌面应用访问你的麦克风 / 摄像头」开关也可能落到这里——先请用户检查开关，灰着 / 打不开才找管理员；
    // macOS 的 restricted 是家长控制 / 设备管理 / 组织策略，用户自己改不了
    const how =
      m.platform === "win32"
        ? "Windows 先请用户检查隐私设置里「让桌面应用访问你的麦克风 / 摄像头」是否被关了；开关是灰的或打不开才是设备管理策略，需要设备管理员"
        : m.platform === "darwin"
          ? "macOS 家长控制 / 屏幕使用时间 / 设备管理 / 组织策略，用户自己改不了，需要设备管理员"
          : "家长控制 / 设备管理 / 组织策略，先请用户检查系统隐私设置，改不了再找设备管理员";
    // Windows 上没法断定是「策略」（可能只是全局开关被关），措辞只说「被系统限制」；macOS / 其它平台的 restricted 就是策略类
    parts.push(`${restricted.join(" / ")}${m.platform === "win32" ? "被系统限制" : "被系统策略限制"}（${how}）`);
  }
  return `系统层：${parts.join("；")}——此时页面即使在 Flowship 里点了「允许」也拿不到${[...denied, ...restricted].join(" / ")}。`;
};

/**
 * 页内 `permissions.query` 桩没装上的一句话（固定话术 + 数字；主进程给的报错原文放在 untrusted 行里，不进这句）。没有问题返回空串。
 * 桩没装上时页面读麦克风 / 摄像头状态仍是 denied：「先 query、denied 就不发请求」的页面根本不会发请求，请求处理器和活动记录里什么都不会出现——
 * 这是 Flowship 自己的盲区，不在这里说出来的话，排查路径上就只剩「页面自己没走到发请求」这一个（错误的）结论（第二十三轮 R23-3）。
 */
export const describeQueryStub = (q: PermissionsResult["queryStub"]): string => {
  const problems = Array.isArray(q?.problems) ? q.problems : [];
  if (problems.length === 0) return "";
  const main = problems.filter((p) => p?.scope === "main").length;
  const frames = problems.length - main;
  const where = [main > 0 ? "主页面" : "", frames > 0 ? `${frames} 个嵌入框架` : ""].filter(Boolean).join("、");
  return `页内权限状态桩没装上（${where}）：页面读麦克风 / 摄像头权限状态时可能读到「已拒绝」、因此根本不发请求，请求处理器和活动记录里都不会有任何东西——这是 Flowship 这边的问题，不是页面或用户的操作；关掉这个标签页、新开一个再试通常能恢复。`;
};

export const createPermissionsTools = (kit: BrowserToolKit): FlowshipToolDef[] => {
  const { run, guarded, errorOut, BadArgs, argStr, argEnum, clipEntry, wrapUntrustedInline } = kit;

  const inline = (s: unknown, n = 120): string => wrapUntrustedInline(clipEntry(s, n));

  const render = (r: PermissionsResult, b: ToolResultBuilder): void => {
    switch (r?.action) {
      case "list": {
        const grants = Array.isArray(r.grants) ? r.grants : [];
        const emulated = Array.isArray(r.emulatedGeolocation) ? r.emulatedGeolocation : [];
        const blocked = Array.isArray(r.recentBlocked) ? r.recentBlocked : [];
        // 总数大于列出的条数时说清楚（主进程只回最近几条）；老版本主进程没有这个字段就按列出的条数
        const blockedTotal = Math.max(blocked.length, num(r.recentBlockedTotal));
        // 清单到了每个 partition 的上限时更早的记录已被挤掉，总数只是下限（R23-6）：写「至少 N 类」
        const atLeast = r.recentBlockedAtLeast === true ? "至少" : "";
        const truncated = blockedTotal > blocked.length ? `，共${atLeast} ${blockedTotal} 类、下面只列最近 ${blocked.length} 类` : "";
        const system = describeSystemMedia(r.systemMedia);
        const stub = describeQueryStub(r.queryStub);
        const stubProblems = Array.isArray(r.queryStub?.problems) ? r.queryStub.problems : [];
        b.trusted(
          `页面权限现状：AI 授权开关${r.enabled ? "已开启" : "未开启（grant / deny / reset 不可用）"}；本会话授予 / 拒绝记录 ${grants.length} 条${emulated.length ? `；有 ${emulated.length} 个标签页的定位模拟生效（对应站点自动允许定位）` : ""}${blocked.length ? `；最近${atLeast}有 ${blockedTotal} 类请求没弹提示就被自动拒绝（原因见下${truncated}）` : ""}。` +
            "默认页面请求权限（含摄像头 / 麦克风）会弹提示由用户决定；屏幕共享 / USB 等永远拒绝。" +
            (system ? ` ${system}` : "") +
            (stub ? ` ${stub}` : ""),
        );
        const lines: string[] = [];
        if (r.currentOrigin) lines.push(`当前页面：${clipEntry(r.currentOrigin, 200)}`);
        for (const g of grants) {
          lines.push(
            `${clipEntry(g.origin, 200)} | ${clipEntry(g.permission, 40)} | ${g.decision === "deny" ? "拒绝" : "允许"}（${g.source === "ai" ? "AI" : "用户"}）${g.active === false ? " | 当前不生效（AI 授权开关已关）" : ""}`,
          );
        }
        for (const e of emulated) lines.push(`定位模拟：标签页 ${clipEntry(e.tabId, 20)} @ ${clipEntry(e.origin, 200)}`);
        for (const e of blocked) {
          const who = `${clipEntry(e.origin ?? "（非网页来源）", 200)}${e.frameOrigin ? `（内嵌框架 ${clipEntry(e.frameOrigin, 200)}）` : ""}`;
          const times = typeof e.count === "number" && e.count > 1 ? ` ×${Math.round(e.count)}` : "";
          const ago = typeof e.ageSec === "number" ? ` | ${Math.round(e.ageSec)} 秒前` : "";
          lines.push(`自动拒绝：${who} | ${clipEntry(e.permission, 40)} | ${clipEntry(e.reasonText || e.reason, 200)}${times}${ago}`);
        }
        for (const p of stubProblems.slice(0, 3)) lines.push(`桩状态：${p?.scope === "main" ? "主页面" : "嵌入框架"} | ${clipEntry(p?.message, 120)}`);
        if (lines.length > 0) b.untrusted(lines.join("\n"));
        return;
      }
      case "grant":
        b.trusted(
          `已授予 ${inline(r.origin)} 的「${clipEntry(r.permission, 40)}」权限（只在本会话内有效，不落盘；页面可能需要重新发起请求或刷新）。` +
            (r.permission === "notifications" ? "通知不会弹系统通知，页面发出的通知只会记入活动记录。" : ""),
        ).markUntrusted();
        return;
      case "deny":
        b.trusted(`已记录：拒绝 ${inline(r.origin)} 的「${clipEntry(r.permission, 40)}」权限（本会话内有效，之后不再弹提示）。`).markUntrusted();
        return;
      case "reset":
        b.trusted(`已重置权限记录：清除 ${num(r.cleared)} 条${r.origin ? `（站点 ${inline(r.origin)}）` : "（全部站点）"}。之后页面再请求权限会重新弹提示。`).markUntrusted();
        return;
      default:
        b.trusted(r?.note ? clipEntry(r.note, 200) : "操作完成。");
    }
  };

  const permissionsTool: FlowshipToolDef = {
    name: "browser_permissions",
    label: "浏览器·页面权限",
    description:
      "查看 / 管理页面权限（定位、通知、剪贴板读取等）：list 总可用（也会列出最近没弹提示就被自动拒绝的请求与原因、系统层是否挡住了麦克风 / 摄像头），grant / deny / reset 要用户在设置里开启「允许 AI 授予页面权限」（reset 会同时清掉拒绝冷却和自动拒绝清单）；默认页面请求权限由用户在提示里决定，用 browser_emulate 设了位置后当前站点的定位自动允许。" +
      "屏幕共享 / USB 永远拒绝；摄像头 / 麦克风和其它权限一样可授予、但涉及隐私只在用户明确要求时才授予（microphone 与 camera 是两个独立授予，只授予用户要求的那个；写 media = 两个一起），授予只在本会话内存里按站点（origin）生效。",
    parameters: TBObject({
      action: TBEnum([...PERMISSION_TOOL_ACTIONS]),
      permission: TBOptional(TBString({ description: "权限名：geolocation / notifications / clipboard-read / microphone / camera / midi / sensors … （grant / deny 必填；reset 不给 = 该站点全部）" })),
      origin: TBOptional(TBString({ description: "站点，如 https://example.com；缺省 = 当前页面所在站点（reset 缺省 = 全部站点）" })),
      tab_id: TBOptional(TBString()),
    }),
    handler: guarded(async (args, ctx) => {
      const action = argEnum(args, "action", PERMISSION_TOOL_ACTIONS);
      if (!action) throw new BadArgs(`缺少必填参数 action（${PERMISSION_TOOL_ACTIONS.join(" / ")}）`);
      const permission = argStr(args, "permission");
      const origin = argStr(args, "origin");
      const tabId = argStr(args, "tab_id");
      if ((action === "grant" || action === "deny") && !permission) throw new BadArgs(`${action} 需要 permission（如 geolocation / notifications）`);

      // 第一道闸：设置没开就地拒（主进程那头还有独立的一道）
      if (PERMISSION_WRITE_TOOL_ACTIONS.includes(action) && !kit.getSettings().pagePermissions) return errorOut(PERMISSIONS_DISABLED_TEXT);

      const opArgs: Record<string, unknown> = {
        action,
        ...(permission !== undefined ? { permission } : {}),
        ...(origin !== undefined ? { origin } : {}),
        ...(tabId !== undefined ? { tabId } : {}),
      };
      return run<PermissionsResult>(ctx, { op: "permissions", args: opArgs, render });
    }),
  };
  return [permissionsTool];
};
