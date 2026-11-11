/**
 * E2·P1 · A8 页面权限的纯决策（electron-app/browser/permission-policy.mjs）：真值表 / 授予表 / origin 解析。
 * 与 electron 零耦合，直接测函数。
 */
import { describe, expect, it } from "vitest";

import {
  ALLOWED_PERMISSIONS,
  ASKABLE_PERMISSIONS,
  FRAME_RESTRICTED_ALLOWED_PERMISSIONS,
  MAX_GRANT_ENTRIES,
  MEDIA_ATOMS,
  MEDIA_PERMISSION,
  NEVER_PERMISSIONS,
  canonicalPermission,
  createPermissionGrants,
  decidePermission,
  decidePermissionWithReason,
  mediaAtomsOf,
  originOf,
  parseOriginArg,
} from "../electron-app/browser/permission-policy.mjs";

const A = "https://a.example.com";
const B = "https://b.example.com";

describe("decidePermission：永远拒绝 / 无隐私面放行", () => {
  it.each(["display-capture", "usb", "hid", "serial", "bluetooth", "openExternal", "fullscreen", "keyboardLock", "fileSystem", "window-management", "unknown"])(
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

  it("speaker-selection 放行（让页面看到扬声器名字并切换输出设备，否则声音检测页只能看到一个空名占位）", () => {
    expect(ALLOWED_PERMISSIONS).toContain("speaker-selection");
    expect(NEVER_PERMISSIONS).not.toContain("speaker-selection");
    expect(decidePermissionWithReason({ permission: "speaker-selection", origin: A })).toEqual({ decision: "allow", reason: "allowed" });
  });

  it.each(["microphone", "camera"])(
    "%s（麦克风 / 摄像头各是一个独立的授予）不再是红线：归「询问」——没授予 → ask；用户授予 → allow；其余沿用询问类的规则",
    (permission) => {
      expect(NEVER_PERMISSIONS).not.toContain(permission);
      expect(ALLOWED_PERMISSIONS).not.toContain(permission); // 也不是静默放行：陌生页面不能在用户不知情时开麦克风 / 摄像头
      expect(ASKABLE_PERMISSIONS).toContain(permission);
      expect(decidePermissionWithReason({ permission, origin: A, grants: createPermissionGrants() })).toEqual({ decision: "ask", reason: "needs-user" });
      // 用户在提示里点了「本会话一直允许」→ 放行；按 origin 隔离
      const grants = createPermissionGrants();
      grants.allow(A, permission, "user");
      expect(decidePermissionWithReason({ permission, origin: A, grants })).toEqual({ decision: "allow", reason: "grant-user" });
      expect(decidePermission({ permission, origin: B, grants })).toBe("ask");
      // AI 写的授予只在设置里打开「AI 管理页面权限」时才生效
      const ai = createPermissionGrants();
      ai.allow(A, permission, "ai");
      expect(decidePermission({ permission, origin: A, grants: ai, config: { pagePermissions: false } })).toBe("ask");
      expect(decidePermission({ permission, origin: A, grants: ai, config: { pagePermissions: true } })).toBe("allow");
      // 显式拒绝记录优先；不透明来源（about:blank / data:）不弹提示直接拒绝；Flowship 自己的 origin 什么都不给
      const denied = createPermissionGrants();
      denied.deny(A, permission, "ai");
      expect(decidePermissionWithReason({ permission, origin: A, grants: denied })).toEqual({ decision: "deny", reason: "explicit-deny-ai" });
      expect(decidePermissionWithReason({ permission, origin: null })).toEqual({ decision: "deny", reason: "opaque-origin" });
      expect(decidePermissionWithReason({ permission, origin: A, grants, isAppOrigin: true })).toEqual({ decision: "deny", reason: "app-origin" });
    },
  );

  it("R9-02：麦克风与摄像头互不连带——只授予麦克风时摄像头仍要问，反过来也一样；显式拒绝一个也不影响另一个", () => {
    const grants = createPermissionGrants();
    grants.allow(A, "microphone", "user");
    expect(decidePermission({ permission: "microphone", origin: A, grants })).toBe("allow");
    expect(decidePermission({ permission: "camera", origin: A, grants })).toBe("ask");
    const cam = createPermissionGrants();
    cam.allow(A, "camera", "user");
    expect(decidePermission({ permission: "camera", origin: A, grants: cam })).toBe("allow");
    expect(decidePermission({ permission: "microphone", origin: A, grants: cam })).toBe("ask");
    const deny = createPermissionGrants();
    deny.deny(A, "microphone", "ai");
    expect(decidePermission({ permission: "microphone", origin: A, grants: deny })).toBe("deny");
    expect(decidePermission({ permission: "camera", origin: A, grants: deny })).toBe("ask");
  });

  it("R9-02：`media`（Electron 的合称）不是可决策的权限名——直接问策略 = 未知权限 = 拒绝（只在 gate / AI 工具入口处展开成麦克风 + 摄像头）", () => {
    expect(MEDIA_PERMISSION).toBe("media");
    expect([...MEDIA_ATOMS]).toEqual(["microphone", "camera"]);
    for (const list of [ASKABLE_PERMISSIONS, ALLOWED_PERMISSIONS, NEVER_PERMISSIONS]) expect(list).not.toContain("media");
    const grants = createPermissionGrants();
    grants.allow(A, "media", "user");
    expect(decidePermissionWithReason({ permission: "media", origin: A, grants })).toEqual({ decision: "deny", reason: "unknown-permission" });
    // 别名：camera / video → camera；microphone / mic / audio → microphone；合称大小写不敏感地认出来
    for (const alias of ["camera", "video", "Video"]) expect(canonicalPermission(alias)).toBe("camera");
    for (const alias of ["microphone", "mic", "audio", "Audio"]) expect(canonicalPermission(alias)).toBe("microphone");
    for (const alias of ["media", "Media", "MEDIA"]) expect(canonicalPermission(alias)).toBe("media");
  });

  it("R9-02：mediaAtomsOf——请求写了 audio / video 就只问对应的；没给 / 空 / 认不出（含检查处理器的 unknown）= 两个都要", () => {
    expect(mediaAtomsOf(["audio"])).toEqual(["microphone"]);
    expect(mediaAtomsOf(["video"])).toEqual(["camera"]);
    expect(mediaAtomsOf(["video", "audio"])).toEqual(["microphone", "camera"]); // 顺序固定：麦克风在前
    expect(mediaAtomsOf(["audio", "audio"])).toEqual(["microphone"]); // 去重
    expect(mediaAtomsOf("audio")).toEqual(["microphone"]); // 检查处理器给的是字符串
    expect(mediaAtomsOf("video")).toEqual(["camera"]);
    for (const none of [undefined, null, [], "unknown", ["unknown"], ["screen"], 42, {}]) {
      expect(mediaAtomsOf(none), JSON.stringify(none)).toEqual(["microphone", "camera"]);
    }
    // 夹带未知类型：只认 audio / video，不因为多了个陌生项就退化成「两个都要」
    expect(mediaAtomsOf(["audio", "screen"])).toEqual(["microphone"]);
    // 返回的是新数组，改它不会污染常量
    const r = mediaAtomsOf(undefined);
    r.pop();
    expect([...MEDIA_ATOMS]).toEqual(["microphone", "camera"]);
  });

  it("屏幕共享（display-capture）等其余设备类仍永远拒绝，放开 media 没有连带放开它们", () => {
    const grants = createPermissionGrants();
    for (const permission of ["display-capture", "usb", "hid", "serial", "bluetooth", "openExternal"]) {
      grants.allow(A, permission, "user");
      expect(decidePermissionWithReason({ permission, origin: A, grants, config: { pagePermissions: true } }), permission).toEqual({ decision: "deny", reason: "never" });
    }
    for (const alias of ["screen", "screen-capture", "screen-share"]) expect(canonicalPermission(alias)).toBe("display-capture");
  });

  it("FRAME_RESTRICTED_ALLOWED_PERMISSIONS 必须是 ALLOWED 的子集，且只含 speaker-selection（剪贴板写保持旧行为不分框架）", () => {
    for (const p of FRAME_RESTRICTED_ALLOWED_PERMISSIONS) expect(ALLOWED_PERMISSIONS).toContain(p);
    expect([...FRAME_RESTRICTED_ALLOWED_PERMISSIONS]).toEqual(["speaker-selection"]);
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

  it("权限名别名在决策里也被规整（location → geolocation，mic → microphone，video → camera）", () => {
    expect(decidePermission({ permission: "location", origin: A, grants: createPermissionGrants(), emulatedGeolocationOrigins: [A] })).toBe("allow");
    expect(decidePermission({ permission: "mic", origin: A })).toBe("ask"); // mic → microphone：要问用户
    const grants = createPermissionGrants();
    grants.allow(A, "camera", "user");
    expect(decidePermission({ permission: "video", origin: A, grants })).toBe("allow"); // video → camera：命中摄像头的授予
  });
});

describe("canonicalPermission / originOf / parseOriginArg", () => {
  it("别名与大小写；非法格式返回 null；未知但合法的名字原样返回", () => {
    expect(canonicalPermission("Location")).toBe("geolocation");
    expect(canonicalPermission("notification")).toBe("notifications");
    expect(canonicalPermission("MIDISYSEX")).toBe("midiSysex");
    expect(canonicalPermission("pointer-lock")).toBe("pointerLock");
    expect(canonicalPermission("microphone")).toBe("microphone");
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
