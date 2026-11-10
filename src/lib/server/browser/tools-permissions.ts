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
  cleared?: number;
  origin?: string;
  permission?: string;
  note?: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const createPermissionsTools = (kit: BrowserToolKit): FlowshipToolDef[] => {
  const { run, guarded, errorOut, BadArgs, argStr, argEnum, clipEntry, wrapUntrustedInline } = kit;

  const inline = (s: unknown, n = 120): string => wrapUntrustedInline(clipEntry(s, n));

  const render = (r: PermissionsResult, b: ToolResultBuilder): void => {
    switch (r?.action) {
      case "list": {
        const grants = Array.isArray(r.grants) ? r.grants : [];
        const emulated = Array.isArray(r.emulatedGeolocation) ? r.emulatedGeolocation : [];
        b.trusted(
          `页面权限现状：AI 授权开关${r.enabled ? "已开启" : "未开启（grant / deny / reset 不可用）"}；本会话授予 / 拒绝记录 ${grants.length} 条${emulated.length ? `；有 ${emulated.length} 个标签页的定位模拟生效（对应站点自动允许定位）` : ""}。` +
            "默认页面请求权限会弹提示由用户决定；摄像头 / 麦克风 / 屏幕共享 / USB 等永远拒绝。",
        );
        const lines: string[] = [];
        if (r.currentOrigin) lines.push(`当前页面：${clipEntry(r.currentOrigin, 200)}`);
        for (const g of grants) {
          lines.push(
            `${clipEntry(g.origin, 200)} | ${clipEntry(g.permission, 40)} | ${g.decision === "deny" ? "拒绝" : "允许"}（${g.source === "ai" ? "AI" : "用户"}）${g.active === false ? " | 当前不生效（AI 授权开关已关）" : ""}`,
          );
        }
        for (const e of emulated) lines.push(`定位模拟：标签页 ${clipEntry(e.tabId, 20)} @ ${clipEntry(e.origin, 200)}`);
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
      "查看 / 管理页面权限（定位、通知、剪贴板读取等）：list 总可用，grant / deny / reset 要用户在设置里开启「允许 AI 授予页面权限」；默认页面请求权限由用户在提示里决定，用 browser_emulate 设了位置后当前站点的定位自动允许。" +
      "摄像头 / 麦克风 / 屏幕共享 / USB 永远拒绝，授予只在本会话内存里按站点（origin）生效。",
    parameters: TBObject({
      action: TBEnum([...PERMISSION_TOOL_ACTIONS]),
      permission: TBOptional(TBString({ description: "权限名：geolocation / notifications / clipboard-read / midi / sensors … （grant / deny 必填；reset 不给 = 该站点全部）" })),
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
