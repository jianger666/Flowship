/**
 * 增强包 E2 · A8 页面权限 op `permissions`（契约 §15）：list / grant / deny / reset。
 *
 * 决策本身在 ../permission-policy.mjs（纯函数）、请求 / 检查处理器与通知代理在 ../permission-gate.mjs；这里只做「AI 能对授予表做什么」：
 *  - `list` 总可用（只读）；`grant / deny / reset` 要设置开关 `pagePermissions`——**主进程独立校验**（不信 server 的工具注册），
 *    关着返回 ACCESS_DISABLED（server 把它翻成「去 设置 → 内置浏览器 → 允许 AI 授予页面权限 打开」）；
 *  - 用户接管期间 grant / deny / reset 一律 USER_CONTROL（与 dialog 一致：接管意味着用户要掌控，权限是用户的决定）；
 *  - Flowship 自己的 origin、永远拒绝的权限（屏幕共享 / USB / HID / 串口 / openExternal …）返回 DENIED，
 *    AI 即使开了开关也放不开——这与用户在提示条里的选择无关，是硬规则；
 *    摄像头 / 麦克风不在其中：和定位等一样归「询问」，开关打开时 AI 可以授予 / 拒绝（`camera` / `microphone` 各自独立，`media` = 两个一起）；
 *  - 授予只存会话内存（按 origin），AI 写入的条目标 source:"ai"，用户关掉开关后立刻失效（策略里读实时的 config）；
 *  - 三个改动类动作都写一条 actor:"ai" 的活动记录（用户在面板时间线上能看到 AI 改了什么权限）。
 *
 * 不走 runAction（那会把整个会话切成「AI 操作中」并锁住所有标签的输入，对一次内存表改动太重）；与 dialog 同样自己判控制权。
 */
import { getPermissionState, permissionLabel } from "../permission-gate.mjs";
import {
  ALLOWED_PERMISSIONS,
  ASKABLE_PERMISSIONS,
  canonicalPermission,
  isNeverPermission,
  MEDIA_ATOMS,
  MEDIA_PERMISSION,
  originOf,
  parseOriginArg,
} from "../permission-policy.mjs";

/** 报错里列给 AI 的可选权限名：询问类 + 合称 `media`（= 麦克风 + 摄像头） */
const PERMISSION_CHOICES = Object.freeze([...ASKABLE_PERMISSIONS, MEDIA_PERMISSION]);

/** 入参权限名 → 实际要读写的独立权限名：`media` 展开成麦克风 + 摄像头，其余就是它自己 */
const targetsOf = (perm) => (perm === MEDIA_PERMISSION ? [...MEDIA_ATOMS] : [perm]);
import { BrowserError } from "../server-channel.mjs";

export const OPS = Object.freeze(["permissions"]);

export const PERMISSION_ACTIONS = Object.freeze(["list", "grant", "deny", "reset"]);

export const ACCESS_DISABLED_MESSAGE =
  "页面权限操作未开启：请用户到 设置 → 内置浏览器 → 打开「允许 AI 授予页面权限」后再试（list 不受限制）。不要反复重试";

const hostOf = (origin) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export const normalize = (op, args, h) => {
  switch (op) {
    case "permissions": {
      const action = h.reqEnum(args, "action", PERMISSION_ACTIONS);
      const permission = h.optStr(args, "permission", 60);
      const origin = h.optStr(args, "origin", 300);
      if (action === "list") return h.withTab(args, { action });
      if ((action === "grant" || action === "deny") && permission === undefined) {
        throw h.bad(`${action} 需要 permission 参数（可选：${PERMISSION_CHOICES.join(" / ")}）`);
      }
      if (permission !== undefined && canonicalPermission(permission) === null) {
        throw h.bad(`参数 permission 不是合法的权限名（可选：${PERMISSION_CHOICES.join(" / ")}）`);
      }
      return h.withTab(args, {
        action,
        ...(permission !== undefined ? { permission: canonicalPermission(permission) } : {}),
        ...(origin !== undefined ? { origin } : {}),
      });
    }
    default:
      throw h.bad(`未实现的浏览器操作：${String(op).slice(0, 40)}`);
  }
};

const scheduleSafe = (deps, taskId) => {
  try {
    deps.scheduleState?.(taskId);
  } catch {
    /* 状态推送失败不影响结果 */
  }
};

/** 取目标 tab（找不到返回 null，不抛）：决定读写哪一份授予表（R6-22） */
const tryGetTab = (session, tabId) => {
  try {
    return session.getTab(tabId);
  } catch {
    return null;
  }
};

/** 入参 origin（缺省 = 目标 tab 当前所在的 origin）→ 规整 origin；不可用抛 BAD_ARGS */
const resolveOrigin = (session, a) => {
  if (a.origin !== undefined) {
    const o = parseOriginArg(a.origin);
    if (!o) throw new BrowserError("BAD_ARGS", "参数 origin 不是有效的 http(s) 站点（如 https://example.com 或 example.com）");
    return o;
  }
  const tab = session.getTab(a.tabId);
  const o = originOf(tab.url);
  if (!o) throw new BrowserError("BAD_ARGS", "当前页面没有可操作的站点（还没打开 http(s) 页面），请先导航，或显式给出 origin 参数");
  return o;
};

/**
 * @param {object} deps  index.mjs 的 createExtraHandlers 依赖；本模块额外用 `permissionGate`（prepareGrant）与 `electron.isAppUrl`
 */
export const createHandlers = (deps) => {
  const isAppOrigin = (origin) => {
    try {
      return deps.electron?.isAppUrl?.(origin) === true;
    } catch {
      return true; // 判断出错按「是 Flowship 自己」处理：宁可拒绝
    }
  };

  const assertWritable = (session) => {
    if (deps.getConfig?.()?.pagePermissions !== true) throw new BrowserError("ACCESS_DISABLED", ACCESS_DISABLED_MESSAGE);
    if (session.controller === "user") {
      throw new BrowserError(
        "USER_CONTROL",
        "用户正在接管浏览器，不能替用户修改页面权限（授权是用户的决定）。请调用 ask_user_to_act 请用户处理，或等用户点「交还给 AI」后再继续",
      );
    }
  };

  const logAi = (session, tab, summary) => {
    try {
      session.activityLog.addAI({ kind: "permission", tabId: tab?.id ?? session.activeTabId ?? "", url: tab?.url ?? "", summary });
    } catch (err) {
      deps.log?.(`[browser] 权限活动日志写入失败：${err?.message || err}`);
    }
  };

  const listResult = (session, a) => {
    const state = getPermissionState(session);
    const enabled = deps.getConfig?.()?.pagePermissions === true;
    // R6-22：授予表按 partition 分开——list 看的是目标 tab 所在那一份（无痕 / 普通互不可见）
    const grants = state.grantsFor(tryGetTab(session, a.tabId)).list().map((g) => ({
      origin: g.origin,
      permission: g.permission,
      decision: g.decision,
      source: g.source,
      // AI 写的授予在开关关闭时不生效；列出来但标 active:false，免得 AI 以为还有效
      active: g.decision === "deny" || g.source === "user" || enabled,
    }));
    const emulated = [];
    for (const tab of session.tabs ?? []) {
      for (const origin of deps.permissionGate?.emulatedGeolocationOrigins?.(tab) ?? []) emulated.push({ tabId: tab.id, origin });
    }
    let current = null;
    try {
      current = originOf(session.getTab(a.tabId).url);
    } catch {
      current = null;
    }
    return { enabled, currentOrigin: current, grants, emulatedGeolocation: emulated };
  };

  return {
    permissions: async (taskId, a) => {
      const session = deps.requireSession(taskId);
      if (a.action === "list") return listResult(session, a);

      assertWritable(session);
      const state = getPermissionState(session);

      if (a.action === "reset") {
        const perm = a.permission;
        const origin = a.origin !== undefined ? resolveOrigin(session, a) : undefined;
        // reset 是收紧动作：两份授予表（普通 / 无痕）都清，不让 AI 以为清了其实无痕那份还在
        // perm 是 `media`（合称）时，麦克风与摄像头两项都清
        let cleared = 0;
        for (const p of perm !== undefined ? targetsOf(perm) : [undefined]) {
          const resetArgs = { ...(origin !== undefined ? { origin } : {}), ...(p !== undefined ? { permission: p } : {}) };
          cleared += state.grants.reset(resetArgs) + (state.incognitoGrants?.reset(resetArgs) ?? 0);
        }
        state.cooldown.clear();
        const scope = `${origin !== undefined ? hostOf(origin) : "全部站点"}${perm !== undefined ? `的「${permissionLabel(perm)}」` : "的"}授予记录`;
        logAi(session, session.tabs?.find((t) => t.id === session.activeTabId), `重置了${scope}（清除 ${cleared} 条）`);
        scheduleSafe(deps, taskId);
        return { action: "reset", cleared, ...(origin !== undefined ? { origin } : {}), ...(perm !== undefined ? { permission: perm } : {}) };
      }

      // grant / deny：先过硬规则
      const perm = a.permission;
      // `media`（合称）= 麦克风 + 摄像头，两项本来就都是询问类，不用过下面三道名单
      if (perm !== MEDIA_PERMISSION) {
        if (isNeverPermission(perm)) {
          throw new BrowserError("DENIED", `「${permissionLabel(perm)}」（${perm}）是永久拒绝的权限，AI 与用户提示都无法放开`);
        }
        if (ALLOWED_PERMISSIONS.includes(perm)) {
          return { action: a.action, permission: perm, note: "该权限本来就默认允许，无需授予" };
        }
        if (!ASKABLE_PERMISSIONS.includes(perm)) {
          throw new BrowserError("BAD_ARGS", `不支持的权限名「${String(perm).slice(0, 40)}」（可选：${PERMISSION_CHOICES.join(" / ")}）`);
        }
      }
      const origin = resolveOrigin(session, a);
      if (isAppOrigin(origin)) throw new BrowserError("DENIED", "不能给 Flowship 自己的页面授予或拒绝权限");

      const tab = (() => {
        try {
          return session.getTab(a.tabId);
        } catch {
          return null;
        }
      })();
      // R6-22：只写目标 tab 所在 partition 的那一份——在普通标签上授予，不会让同源无痕标签也生效
      const grants = state.grantsFor(tab);
      for (const p of targetsOf(perm)) {
        const ok = a.action === "grant" ? grants.allow(origin, p, "ai") : grants.deny(origin, p, "ai");
        if (!ok) throw new BrowserError("DENIED", "本会话的权限记录已满，请先 permissions reset 清理后再试");
      }
      // 通知：把就在该 origin 上的标签的「通知代理」预先装好（页面常先读 Notification.permission 再决定要不要请求）；装不上不影响授予记录本身，
      // 页面之后真正请求通知权限时 request 处理器会再装一次、仍失败才拒绝
      if (a.action === "grant") await deps.permissionGate?.prepareGrant?.(session, origin, perm);
      const verb = a.action === "grant" ? "授予" : "拒绝";
      logAi(session, tab, `${verb}了 ${hostOf(origin)} 的「${permissionLabel(perm)}」权限（本会话内有效）`);
      scheduleSafe(deps, taskId);
      return { action: a.action, permission: perm, origin };
    },
  };
};
