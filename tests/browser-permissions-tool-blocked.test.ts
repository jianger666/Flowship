/**
 * browser_permissions 的 list 渲染与写入闸（第二十一、二十二轮）：
 *  - 页面要麦克风却没弹提示时，AI 能从 list 里读到「最近被自动拒绝」的原因；清单被截断时带总数；系统层挡住麦克风 / 摄像头时 list 里有一句固定话术（R22-3）。
 *  - grant / deny / reset 的第一道闸：设置 `pagePermissions` 没开就地拒、不走 bridge（R22-5：此前删掉这道闸没有任何用例变红，主进程那头还有独立的一道，两层缺一不可）。
 * bridge 用真实实现 + 假传输层（tests/helpers/browser-bridge-fake.ts）；主进程的清单由 ops/permissions.mjs 产出（见 browser-e2-p1-ops.test.ts）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBrowserSettingsForTest } from "@/lib/server/browser/settings";
import { PERMISSIONS_DISABLED_TEXT, describeQueryStub, describeSystemMedia } from "@/lib/server/browser/tools-permissions";
import { getBrowserTools } from "@/lib/server/browser/tools";
import type { FlowshipToolResult } from "@/lib/server/flowship-tools";

import { installFakeBrowser, type FakeBrowser } from "./helpers/browser-bridge-fake";

const TASK = "task-perm-blocked";
let fake: FakeBrowser | null = null;

const call = (args: Record<string, unknown>) => {
  const t = getBrowserTools({ taskId: TASK }).find((x) => x.name === "browser_permissions");
  if (!t) throw new Error("browser_permissions 未注册");
  return t.handler(args, "caller-token", { taskId: TASK });
};
const textOf = (r: FlowshipToolResult): string => r.content.map((c) => (c.type === "text" ? c.text : `<img:${c.mimeType}>`)).join("\n");

beforeEach(() => {
  __resetBrowserSettingsForTest();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  fake?.cleanup();
  fake = null;
  vi.restoreAllMocks();
});

const listWith = (extra: Record<string, unknown>) => {
  fake = installFakeBrowser({
    status: () => ({ exists: true, pendingCount: 0 }),
    permissions: () => ({ action: "list", enabled: false, currentOrigin: "https://a.example.com", grants: [], emulatedGeolocation: [], ...extra }),
  });
};

describe("browser_permissions list：最近被自动拒绝", () => {
  it("有清单：可信话术点出条数；明细在不可信块里（来源 / 内嵌框架 / 权限 / 原因 / 次数 / 几秒前）", async () => {
    listWith({
      recentBlocked: [
        {
          origin: "https://a.example.com",
          frameOrigin: "https://cw.example.org",
          permission: "microphone",
          reason: "frame-not-delegated",
          reasonText: "顶层页面没有把这项权限委托给该嵌入框架",
          count: 3,
          ageSec: 12,
        },
        { origin: "https://a.example.com", permission: "camera", reason: "cooldown", reasonText: "刚刚被拒绝，30 秒内不再重复弹提示", count: 1, ageSec: 4 },
      ],
    });
    const text = textOf(await call({ action: "list" }));
    expect(text).toContain("最近有 2 类请求没弹提示就被自动拒绝（原因见下）");
    expect(text).toContain("自动拒绝：https://a.example.com（内嵌框架 https://cw.example.org） | microphone | 顶层页面没有把这项权限委托给该嵌入框架 ×3 | 12 秒前");
    expect(text).toContain("自动拒绝：https://a.example.com | camera | 刚刚被拒绝，30 秒内不再重复弹提示 | 4 秒前");
    // 明细来自页面（origin），必须在不可信块里
    expect(text).toMatch(/<untrusted_page_content[^>]*>[\s\S]*自动拒绝：[\s\S]*<\/untrusted_page_content>/);
  });

  it("没有清单 / 空清单：不提这件事；字段残缺不崩（origin 缺失写「非网页来源」、没有 reasonText 退回原因码）", async () => {
    listWith({});
    expect(textOf(await call({ action: "list" }))).not.toContain("自动拒绝");
    listWith({ recentBlocked: [] });
    expect(textOf(await call({ action: "list" }))).not.toContain("自动拒绝");
    listWith({ recentBlocked: [{ origin: null, permission: "microphone", reason: "opaque-origin" }, {}] });
    const text = textOf(await call({ action: "list" }));
    expect(text).toContain("自动拒绝：（非网页来源） | microphone | opaque-origin");
    expect(text).toContain("最近有 2 类请求");
  });

  it("页面可控的来源被截断（不会把超长 origin 原样塞进结果）", async () => {
    const long = `https://${"a".repeat(600)}.example.com`;
    listWith({ recentBlocked: [{ origin: long, permission: "microphone", reason: "cooldown", reasonText: "x", count: 1, ageSec: 1 }] });
    const text = textOf(await call({ action: "list" }));
    expect(text).not.toContain("a".repeat(400));
    expect(text).toContain("自动拒绝：");
  });
});

describe("browser_permissions list：清单被截断 / 系统层挡住麦克风（R22-3）", () => {
  it("主进程给了总数且大于列出的条数：可信话术里写明「共 N 类、下面只列最近 M 类」；总数不大于列出条数 / 老版本没有这个字段就不写", async () => {
    const entry = (i: number) => ({ origin: `https://h${i}.example.com`, permission: "geolocation", reason: "cooldown", reasonText: "x", count: 1, ageSec: i });
    listWith({ recentBlocked: [entry(1), entry(2), entry(3)], recentBlockedTotal: 8 });
    const text = textOf(await call({ action: "list" }));
    expect(text).toContain("最近有 8 类请求没弹提示就被自动拒绝（原因见下，共 8 类、下面只列最近 3 类）");
    listWith({ recentBlocked: [entry(1), entry(2)], recentBlockedTotal: 2 });
    expect(textOf(await call({ action: "list" }))).toContain("最近有 2 类请求没弹提示就被自动拒绝（原因见下）");
    listWith({ recentBlocked: [entry(1), entry(2)] });
    expect(textOf(await call({ action: "list" }))).not.toContain("共 ");
  });

  it("系统层：denied → 要请用户去系统隐私设置里打开；restricted → 用户自己改不了、要设备管理员；话术在可信部分、不在页面内容块里；认不出的权限名 / 状态整条忽略", async () => {
    listWith({ systemMedia: { platform: "darwin", problems: [{ permission: "microphone", status: "denied" }] } });
    const text = textOf(await call({ action: "list" }));
    expect(text).toContain("系统层：macOS 系统设置里没有允许 Flowship 使用麦克风（要请用户到系统的隐私设置里打开）");
    expect(text).toContain("此时页面即使在 Flowship 里点了「允许」也拿不到麦克风");
    expect(text).not.toMatch(/<untrusted_page_content[^>]*>[\s\S]*系统层[\s\S]*<\/untrusted_page_content>/);

    listWith({ systemMedia: { platform: "win32", problems: [{ permission: "camera", status: "restricted" }] } });
    const r = textOf(await call({ action: "list" }));
    // R23-6：Windows 的 restricted 触发场景没在真机验证过（全局「让桌面应用访问你的摄像头」开关也可能落到这里）——先请用户检查开关，灰着 / 打不开才找管理员；措辞不断言是「策略」
    expect(r).toContain("摄像头被系统限制（Windows 先请用户检查隐私设置里「让桌面应用访问你的麦克风 / 摄像头」是否被关了；开关是灰的或打不开才是设备管理策略，需要设备管理员）");
    expect(r).not.toContain("被系统策略限制");
    expect(r).not.toContain("要请用户到系统的隐私设置里打开");
    // macOS 的 restricted 是家长控制 / 屏幕使用时间 / 设备管理，用户自己改不了
    listWith({ systemMedia: { platform: "darwin", problems: [{ permission: "camera", status: "restricted" }] } });
    expect(textOf(await call({ action: "list" }))).toContain("摄像头被系统策略限制（macOS 家长控制 / 屏幕使用时间 / 设备管理 / 组织策略，用户自己改不了，需要设备管理员）");

    listWith({ systemMedia: { platform: "darwin", problems: [{ permission: "evil<tag>", status: "denied" }, { permission: "microphone", status: "weird" }] } });
    expect(textOf(await call({ action: "list" }))).not.toContain("系统层");
    listWith({});
    expect(textOf(await call({ action: "list" }))).not.toContain("系统层");
  });

  it("describeSystemMedia：denied 与 restricted 同时有就分写两段；平台名映射（darwin / win32 / 其它）；没有问题返回空串", () => {
    expect(describeSystemMedia(undefined)).toBe("");
    expect(describeSystemMedia({ platform: "darwin", problems: [] })).toBe("");
    const both = describeSystemMedia({
      platform: "linux",
      problems: [
        { permission: "microphone", status: "restricted" },
        { permission: "camera", status: "denied" },
      ],
    });
    expect(both).toContain("系统设置里没有允许 Flowship 使用摄像头");
    expect(both).not.toContain("macOS");
    expect(both).not.toContain("Windows");
    expect(both).toContain("麦克风被系统策略限制");
    expect(both).toContain("拿不到摄像头 / 麦克风");
  });

  it("工具描述告诉 AI：list 会列出「最近没弹提示就被自动拒绝的请求与原因」和系统层状态——不写的话 AI 不知道「为什么没弹提示」该去 list 里找（评审点名；预算里还有余量，所以并进第一句、不加句号）", () => {
    listWith({}); // 工具要在浏览器能力就绪时才注册（与上面各用例同一套假传输层）
    const t = getBrowserTools({ taskId: TASK }).find((x) => x.name === "browser_permissions");
    expect(t, "browser_permissions 未注册").toBeTruthy();
    expect(t?.description).toContain("自动拒绝");
    expect(t?.description).toContain("系统层");
    // R23-6：reset 的副作用要让 AI 知道（reset 会同时清冷却和自动拒绝清单——此前 AI 读完描述并不知道 reset 之后「被冷却静默拒绝」的记录也没了）
    expect(t?.description).toContain("reset 会同时清掉拒绝冷却和自动拒绝清单");
    // 描述仍是 ≤ 2 句（browser-tools.test.ts 的总守卫；这里只钉这个工具，别因为并进新话又悄悄拆成三句）
    expect((t?.description ?? "").split("。").filter((s) => s.trim()).length).toBeLessThanOrEqual(2);
  });
});

describe("browser_permissions list：「至少 N 类」与页内查询桩状态（R23-3 / R23-6）", () => {
  const entry = (i: number) => ({ origin: `https://h${i}.example.com`, permission: "geolocation", reason: "cooldown", reasonText: "x", count: 1, ageSec: i });

  it("recentBlockedAtLeast：该 partition 的清单到了上限（更早的记录已被挤掉）→ 总数写成下限「至少 N 类」；没带这个字段时措辞与以前完全一样", async () => {
    listWith({ recentBlocked: [entry(1), entry(2), entry(3)], recentBlockedTotal: 10, recentBlockedAtLeast: true });
    expect(textOf(await call({ action: "list" }))).toContain("最近至少有 10 类请求没弹提示就被自动拒绝（原因见下，共至少 10 类、下面只列最近 3 类）");
    listWith({ recentBlocked: [entry(1), entry(2), entry(3)], recentBlockedTotal: 3, recentBlockedAtLeast: true });
    expect(textOf(await call({ action: "list" }))).toContain("最近至少有 3 类请求没弹提示就被自动拒绝（原因见下）");
    // 对照（防空转）：没有 atLeast 字段、或值不是严格的 true，都按精确数写
    for (const flag of [undefined, false, "true", 1]) {
      listWith({ recentBlocked: [entry(1), entry(2), entry(3)], recentBlockedTotal: 10, ...(flag === undefined ? {} : { recentBlockedAtLeast: flag }) });
      const text = textOf(await call({ action: "list" }));
      expect(text, String(flag)).toContain("最近有 10 类请求没弹提示就被自动拒绝（原因见下，共 10 类、下面只列最近 3 类）");
      expect(text).not.toContain("至少");
    }
  });

  it("describeQueryStub：固定话术只带数字 / 位置；没有问题 / 字段残缺 → 空串；报错原文不进这一句", () => {
    expect(describeQueryStub(undefined)).toBe("");
    expect(describeQueryStub({})).toBe("");
    expect(describeQueryStub({ problems: [] })).toBe("");
    const main = describeQueryStub({ problems: [{ scope: "main", message: "SECRET-PAGE-TEXT" }] });
    expect(main).toContain("页内权限状态桩没装上（主页面）");
    expect(main).toContain("读到「已拒绝」");
    expect(main).toContain("这是 Flowship 这边的问题");
    expect(main).not.toContain("SECRET-PAGE-TEXT");
    expect(describeQueryStub({ problems: [{ scope: "frame" }, { scope: "frame" }] })).toContain("页内权限状态桩没装上（2 个嵌入框架）");
    expect(describeQueryStub({ problems: [{ scope: "main" }, { scope: "frame" }, {}] })).toContain("页内权限状态桩没装上（主页面、2 个嵌入框架）");
  });

  it("list 渲染 queryStub：可信话术一句 + 不可信块里逐条「桩状态」（最多 3 条）；没有问题 / 没这个字段 → 不提", async () => {
    listWith({ queryStub: { problems: [{ scope: "main", message: "cdp gone" }, { scope: "frame", message: "timeout" }] } });
    const text = textOf(await call({ action: "list" }));
    const trusted = text.split("<untrusted_page_content")[0];
    expect(trusted).toContain("页内权限状态桩没装上（主页面、1 个嵌入框架）");
    expect(trusted).not.toContain("cdp gone"); // 报错原文来自主进程的 CDP 错误（可能夹带页面内容），只在不可信块里
    expect(text).toMatch(/<untrusted_page_content[^>]*>[\s\S]*桩状态：主页面 \| cdp gone[\s\S]*<\/untrusted_page_content>/);
    expect(text).toContain("桩状态：嵌入框架 | timeout");
    listWith({ queryStub: { problems: [1, 2, 3, 4, 5].map((i) => ({ scope: "frame", message: `m${i}` })) } });
    const many = textOf(await call({ action: "list" }));
    expect(many).toContain("桩状态：嵌入框架 | m3");
    expect(many).not.toContain("m4");
    listWith({ queryStub: { problems: [] } });
    expect(textOf(await call({ action: "list" }))).not.toContain("桩没装上");
    listWith({});
    expect(textOf(await call({ action: "list" }))).not.toContain("桩没装上");
  });
});

describe("browser_permissions：grant / deny / reset 的第一道闸（设置 pagePermissions 没开就地拒，不走 bridge）", () => {
  const permissionCalls = () => (fake?.calls ?? []).filter((c) => c.op === "permissions");

  it("pagePermissions 关：三个写入动作都就地返回指向设置的文案（isError），一条 permissions 请求都没发给主进程；list 仍可用", async () => {
    __resetBrowserSettingsForTest({ pagePermissions: false });
    fake = installFakeBrowser({
      status: () => ({ exists: true, pendingCount: 0 }),
      permissions: (args) => ({ action: args.action, enabled: false, currentOrigin: null, grants: [], emulatedGeolocation: [] }),
    });
    for (const args of [
      { action: "grant", permission: "microphone" },
      { action: "deny", permission: "camera" },
      { action: "reset" },
    ]) {
      const r = await call(args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(r), JSON.stringify(args)).toContain(PERMISSIONS_DISABLED_TEXT);
    }
    expect(permissionCalls()).toHaveLength(0);
    const list = await call({ action: "list" });
    expect(list.isError).not.toBe(true);
    expect(permissionCalls()).toHaveLength(1);
  });

  it("pagePermissions 开：同样的写入动作原样发给主进程（主进程那头还有独立的一道开关校验）", async () => {
    __resetBrowserSettingsForTest({ pagePermissions: true });
    fake = installFakeBrowser({
      status: () => ({ exists: true, pendingCount: 0 }),
      permissions: (args) => ({ action: args.action, origin: "https://a.example.com", permission: args.permission }),
    });
    const r = await call({ action: "grant", permission: "microphone" });
    expect(r.isError).not.toBe(true);
    expect(permissionCalls()).toHaveLength(1);
    expect(permissionCalls()[0].args).toMatchObject({ action: "grant", permission: "microphone" });
  });
});
