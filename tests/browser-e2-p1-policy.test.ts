/**
 * E2·P1 · A8 页面权限的纯决策（electron-app/browser/permission-policy.mjs）：真值表 / 授予表 / origin 解析。
 * 与 electron 零耦合，直接测函数。
 */
import { describe, expect, it } from "vitest";

import {
  ALLOWED_PERMISSIONS,
  ASKABLE_PERMISSIONS,
  MAX_GRANT_ENTRIES,
  NEVER_PERMISSIONS,
  canonicalPermission,
  createPermissionGrants,
  decidePermission,
  decidePermissionWithReason,
  originOf,
  parseOriginArg,
} from "../electron-app/browser/permission-policy.mjs";

const A = "https://a.example.com";
const B = "https://b.example.com";

describe("decidePermission：永远拒绝 / 无隐私面放行", () => {
  it.each(["media", "display-capture", "usb", "hid", "serial", "bluetooth", "openExternal", "fullscreen", "keyboardLock", "fileSystem", "window-management", "unknown"])(
    "永远拒绝：%s（即使有授予记录、AI 开关开着、模拟生效）",
    (permission) => {
      const grants = createPermissionGrants();
      grants.allow(A, permission, "user");
      grants.allow(A, permission, "ai");
      const r = decidePermissionWithReason({ permission, origin: A, grants, config: { pagePermissions: true }, emulatedGeolocationOrigins: [A] });
      expect(r).toEqual({ decision: "deny", reason: "never" });
    },
  );

  it("clipboard-sanitized-write 直接放行（含 origin 为 null 的不透明来源）", () => {
    expect(decidePermission({ permission: "clipboard-sanitized-write", origin: A })).toBe("allow");
    expect(decidePermission({ permission: "clipboard-sanitized-write", origin: null })).toBe("allow");
  });

  it("Flowship 自己的 origin：什么都不给，连无隐私面的放行项也拒绝", () => {
    for (const permission of [...ALLOWED_PERMISSIONS, ...ASKABLE_PERMISSIONS, ...NEVER_PERMISSIONS]) {
      const grants = createPermissionGrants();
      grants.allow(A, permission, "user");
      expect(decidePermissionWithReason({ permission, origin: A, grants, isAppOrigin: true, config: { pagePermissions: true } })).toEqual({ decision: "deny", reason: "app-origin" });
    }
  });

  it("不在三张表里的权限名（Electron 以后新增的）一律拒绝，授予记录也救不了它", () => {
    const grants = createPermissionGrants();
    grants.allow(A, "brand-new-permission", "user");
    expect(decidePermissionWithReason({ permission: "brand-new-permission", origin: A, grants })).toEqual({ decision: "deny", reason: "unknown-permission" });
  });
});

describe("decidePermission：询问 / 授予 / 定位模拟", () => {
  it.each(ASKABLE_PERMISSIONS)("%s：没有任何授予 → ask", (permission) => {
    expect(decidePermission({ permission, origin: A, grants: createPermissionGrants() })).toBe("ask");
  });

  it("origin 为 null（about:blank / data: / 不透明来源）→ deny，不弹提示（提示条说不清是谁在请求）", () => {
    expect(decidePermissionWithReason({ permission: "geolocation", origin: null })).toEqual({ decision: "deny", reason: "opaque-origin" });
  });

  it("用户的授予（allow-session）永远有效；按 origin 隔离", () => {
    const grants = createPermissionGrants();
    grants.allow(A, "notifications", "user");
    expect(decidePermission({ permission: "notifications", origin: A, grants })).toBe("allow");
    expect(decidePermission({ permission: "notifications", origin: B, grants })).toBe("ask");
    expect(decidePermission({ permission: "geolocation", origin: A, grants })).toBe("ask"); // 别的权限不受影响
    // 端口 / 协议不同 = 不同 origin
    expect(decidePermission({ permission: "notifications", origin: "http://a.example.com", grants })).toBe("ask");
    expect(decidePermission({ permission: "notifications", origin: "https://a.example.com:8443", grants })).toBe("ask");
  });

  it("AI 写的授予只在 pagePermissions 开着时生效；开关关掉后立即失效（回到 ask）", () => {
    const grants = createPermissionGrants();
    grants.allow(A, "geolocation", "ai");
    expect(decidePermission({ permission: "geolocation", origin: A, grants, config: { pagePermissions: true } })).toBe("allow");
    expect(decidePermission({ permission: "geolocation", origin: A, grants, config: { pagePermissions: false } })).toBe("ask");
    expect(decidePermission({ permission: "geolocation", origin: A, grants, config: null })).toBe("ask");
  });

  it("显式拒绝记录（AI deny）命中后直接 deny，且优先于定位模拟", () => {
    const grants = createPermissionGrants();
    grants.deny(A, "geolocation", "ai");
    expect(decidePermissionWithReason({ permission: "geolocation", origin: A, grants, emulatedGeolocationOrigins: [A] })).toEqual({ decision: "deny", reason: "explicit-deny-ai" });
  });

  it("定位模拟：只对被模拟的 origin 放行；换 origin 立即回到 ask；只管 geolocation", () => {
    const base = { grants: createPermissionGrants(), emulatedGeolocationOrigins: [A] };
    expect(decidePermissionWithReason({ permission: "geolocation", origin: A, ...base })).toEqual({ decision: "allow", reason: "emulated-geolocation" });
    expect(decidePermission({ permission: "geolocation", origin: B, ...base })).toBe("ask");
    expect(decidePermission({ permission: "notifications", origin: A, ...base })).toBe("ask");
    expect(decidePermission({ permission: "geolocation", origin: A, grants: base.grants, emulatedGeolocationOrigins: [] })).toBe("ask");
  });

  it("权限名别名在决策里也被规整（location → geolocation，camera → media）", () => {
    expect(decidePermission({ permission: "location", origin: A, grants: createPermissionGrants(), emulatedGeolocationOrigins: [A] })).toBe("allow");
    expect(decidePermission({ permission: "camera", origin: A })).toBe("deny");
  });
});

describe("canonicalPermission / originOf / parseOriginArg", () => {
  it("别名与大小写；非法格式返回 null；未知但合法的名字原样返回", () => {
    expect(canonicalPermission("Location")).toBe("geolocation");
    expect(canonicalPermission("notification")).toBe("notifications");
    expect(canonicalPermission("MIDISYSEX")).toBe("midiSysex");
    expect(canonicalPermission("pointer-lock")).toBe("pointerLock");
    expect(canonicalPermission("microphone")).toBe("media");
    expect(canonicalPermission("something-new")).toBe("something-new");
    expect(canonicalPermission("bad name!")).toBeNull();
    expect(canonicalPermission("")).toBeNull();
    expect(canonicalPermission(123 as never)).toBeNull();
    expect(canonicalPermission("x".repeat(60))).toBeNull();
  });

  it("originOf：只认 http(s)；userinfo 欺骗按真实主机算；其余 null", () => {
    expect(originOf("https://a.example.com/path?q=1#h")).toBe(A);
    expect(originOf("http://a.example.com:8080/x")).toBe("http://a.example.com:8080");
    expect(originOf("http://localhost@evil.com/")).toBe("http://evil.com");
    expect(originOf("about:blank")).toBeNull();
    expect(originOf("file:///etc/passwd")).toBeNull();
    expect(originOf("data:text/html,hi")).toBeNull();
    expect(originOf("null")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("")).toBeNull();
    expect(originOf(undefined as never)).toBeNull();
    expect(originOf(`https://a.com/${"x".repeat(3000)}`)).toBeNull();
  });

  it("parseOriginArg：裸域名补 https；host:port 补 https；明确写了别的协议不补", () => {
    expect(parseOriginArg("example.com")).toBe("https://example.com");
    expect(parseOriginArg("localhost:3000")).toBe("https://localhost:3000");
    expect(parseOriginArg("http://localhost:3000/a")).toBe("http://localhost:3000");
    expect(parseOriginArg("  https://a.example.com/x ")).toBe(A);
    expect(parseOriginArg("file:///etc/passwd")).toBeNull();
    expect(parseOriginArg("javascript:alert(1)")).toBeNull();
    expect(parseOriginArg("")).toBeNull();
    expect(parseOriginArg(5 as never)).toBeNull();
  });
});

describe("createPermissionGrants", () => {
  it("allow / deny / get / list；同一键覆盖（不重复计数）；source 只认 user / ai", () => {
    let t = 100;
    const g = createPermissionGrants({ now: () => ++t });
    expect(g.allow(A, "geolocation", "ai")).toBe(true);
    expect(g.allow(A, "geolocation", "weird" as never)).toBe(true);
    expect(g.size).toBe(1);
    expect(g.get(A, "geolocation")).toMatchObject({ decision: "allow", source: "user" });
    g.deny(A, "geolocation", "ai");
    expect(g.get(A, "geolocation")).toMatchObject({ decision: "deny", source: "ai" });
    expect(g.list()).toEqual([{ origin: A, permission: "geolocation", decision: "deny", source: "ai", at: expect.any(Number) }]);
  });

  it("reset：按 origin / permission / 全部；返回清掉的条数", () => {
    const g = createPermissionGrants();
    g.allow(A, "geolocation", "user");
    g.allow(A, "notifications", "user");
    g.allow(B, "geolocation", "user");
    expect(g.reset({ origin: A, permission: "geolocation" })).toBe(1);
    expect(g.reset({ permission: "geolocation" })).toBe(1); // 只剩 B 的
    expect(g.size).toBe(1);
    expect(g.reset({ origin: A })).toBe(1);
    g.allow(B, "midi", "ai");
    g.allow(A, "midi", "user");
    expect(g.reset()).toBe(2);
    expect(g.size).toBe(0);
  });

  it("容量封顶：满了拒绝新键，但已有键仍可覆盖；clear 清空", () => {
    const g = createPermissionGrants({ max: 3 });
    expect(g.allow("https://1.com", "geolocation", "ai")).toBe(true);
    expect(g.allow("https://2.com", "geolocation", "ai")).toBe(true);
    expect(g.allow("https://3.com", "geolocation", "ai")).toBe(true);
    expect(g.allow("https://4.com", "geolocation", "ai")).toBe(false);
    expect(g.deny("https://1.com", "geolocation", "ai")).toBe(true);
    g.clear();
    expect(g.size).toBe(0);
    expect(g.allow("https://4.com", "geolocation", "ai")).toBe(true);
    expect(MAX_GRANT_ENTRIES).toBeGreaterThanOrEqual(100);
  });

  it("三张表互不相交（任何权限名只属于一类）", () => {
    const all = [...ALLOWED_PERMISSIONS, ...ASKABLE_PERMISSIONS, ...NEVER_PERMISSIONS];
    expect(new Set(all).size).toBe(all.length);
  });
});
