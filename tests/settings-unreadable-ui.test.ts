/**
 * F6-03（客户端半边）：config.json 不可读时，设置页要能识别并明确提示，而不是「空表单 + 将自动重试」。
 *
 * 分三层：
 * 1. 纯函数（settings-unreadable.ts）：识别服务端错误体、生成中文说明；
 * 2. local-store 行为：init 的 GET /api/settings/full 返回 500 settings_unreadable →
 *    暴露状态、不发 PUT、文件修好后重新 init 能恢复（真实 local-store + 桩 fetch）；
 * 3. 接线契约：use-settings / settings 页源码里的关键写法（没有 DOM 测试环境，未在浏览器里看过实际渲染）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SETTINGS_UNREADABLE_CODE,
  SettingsUnreadableError,
  describeSettingsUnreadable,
  parseSettingsUnreadable,
} from "@/lib/settings-unreadable";

const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8");

describe("parseSettingsUnreadable：只认 error === settings_unreadable", () => {
  it("带 reason → 取出；缺 reason / 非字符串 → 空串", () => {
    expect(
      parseSettingsUnreadable({ error: "settings_unreadable", reason: "json_parse" }),
    ).toEqual({ reason: "json_parse" });
    expect(parseSettingsUnreadable({ error: "settings_unreadable" })).toEqual({
      reason: "",
    });
    expect(
      parseSettingsUnreadable({ error: "settings_unreadable", reason: 42 }),
    ).toEqual({ reason: "" });
  });

  it("其它错误 / 形状不对 → null（不误报）", () => {
    expect(parseSettingsUnreadable({ error: "磁盘只读" })).toBeNull();
    expect(parseSettingsUnreadable({ error: "settings_unreadable_x" })).toBeNull();
    expect(parseSettingsUnreadable({})).toBeNull();
    expect(parseSettingsUnreadable(null)).toBeNull();
    expect(parseSettingsUnreadable("settings_unreadable")).toBeNull();
    expect(parseSettingsUnreadable(undefined)).toBeNull();
  });

  it("reason 超长截断（防撑坏布局）", () => {
    const got = parseSettingsUnreadable({
      error: SETTINGS_UNREADABLE_CODE,
      reason: "x".repeat(5000),
    });
    expect(got?.reason.length).toBe(200);
  });

  it("SettingsUnreadableError 带 reason 且 message 以 settings_unreadable 开头", () => {
    const e = new SettingsUnreadableError("json_parse");
    expect(e).toBeInstanceOf(Error);
    expect(e.reason).toBe("json_parse");
    expect(e.message.startsWith("settings_unreadable")).toBe(true);
  });
});

describe("describeSettingsUnreadable：按类别给明确的中文说明", () => {
  const all = [
    "json_parse",
    "json_parse: at position 12",
    "settings_json_invalid",
    "EACCES: permission denied, open '/x/config.json'",
    "EPERM: operation not permitted",
    "EISDIR: illegal operation on a directory, read",
    "EIO: i/o error",
    "",
    "某个没见过的东西",
  ];

  it.each(all)("reason=%j：有标题和说明，且不再说「将自动重试」", (reason) => {
    const t = describeSettingsUnreadable(reason);
    expect(t.headline).toContain("config.json");
    expect(t.headline).toContain("暂停保存");
    expect(t.detail.length).toBeGreaterThan(20);
    expect(t.detail).not.toContain("自动重试");
    // 告诉用户原文件没动、怎么恢复
    expect(t.detail).toContain("没有被改动");
    expect(t.detail).toContain("config.json.bak");
  });

  it.each(all)(
    "reason=%j：恢复指引点名 config.json.bak.shrink——误清配置后能从那里找回 API key 和仓库配置（第七轮 K3-09）",
    (reason) => {
      const { detail } = describeSettingsUnreadable(reason);
      expect(detail).toContain("config.json.bak.shrink");
      // 说清它能找回什么：不是一句孤零零的文件名
      const sentence = detail.split("。").find((s) => s.includes("config.json.bak.shrink")) ?? "";
      expect(sentence).toContain("API key");
      expect(sentence).toContain("仓库");
    },
  );

  it("不同类别的原因描述不同", () => {
    const json = describeSettingsUnreadable("json_parse: at position 3").detail;
    const root = describeSettingsUnreadable("settings_json_invalid").detail;
    const perm = describeSettingsUnreadable("EACCES: x").detail;
    const dir = describeSettingsUnreadable("EISDIR: x").detail;
    const other = describeSettingsUnreadable("EIO: x").detail;
    expect(new Set([json, root, perm, dir, other]).size).toBe(5);
    expect(json).toContain("JSON");
    expect(root).toContain("对象");
    expect(perm).toContain("权限");
    expect(dir).toContain("目录");
  });
});

// ---- local-store：真实模块 + 桩 fetch（每个用例 resetModules，隔离模块级状态）----

type Json = Record<string, unknown>;

const jsonRes = (status: number, body: unknown): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("local-store：init 遇 settings_unreadable", () => {
  let calls: string[] = [];
  let getFull: () => Response = () => jsonRes(200, { exists: true, settings: {} });

  beforeEach(() => {
    calls = [];
    vi.resetModules();
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
    };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${url}`);
      if (method === "GET") return getFull();
      return jsonRes(200, { ok: true, settings: {} });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("GET /full 返回 500 settings_unreadable → 状态带 reason；缓存是默认值；不会发任何 PUT", async () => {
    getFull = () =>
      jsonRes(500, { error: "settings_unreadable", reason: "json_parse: at position 8" });
    const store = await import("@/lib/local-store");
    expect(store.getSettingsUnreadable()).toBeNull(); // init 之前没有状态
    await store.initSettings();
    expect(store.getSettingsUnreadable()).toEqual({
      reason: "json_parse: at position 8",
    });
    expect(store.getSettings().apiKey).toBe("");
    // 保存被拒（拒绝用默认值覆盖磁盘），且全程没有 PUT
    const ok = await store.saveSettings({ ...store.getSettings(), apiKey: "k" });
    expect(ok).toBe(false);
    expect(calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
  });

  it("文件修好后重新 init（等价于重新进入设置页）→ 状态清空、读到文件内容、可以保存", async () => {
    getFull = () => jsonRes(500, { error: "settings_unreadable", reason: "json_parse" });
    const store = await import("@/lib/local-store");
    await store.initSettings();
    expect(store.getSettingsUnreadable()).not.toBeNull();

    getFull = () =>
      jsonRes(200, { exists: true, settings: { apiKey: "sk-from-fixed-file" } as Json });
    await store.initSettings();
    expect(store.getSettingsUnreadable()).toBeNull();
    expect(store.getSettings().apiKey).toBe("sk-from-fixed-file");
    const ok = await store.saveSettings({ ...store.getSettings(), apiKey: "k2" });
    expect(ok).toBe(true);
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
  });

  it.each([
    ["别的 500 错误", () => jsonRes(500, { error: "boom" })],
    ["500 非 JSON 响应体", () => jsonRes(500, "<html>oops</html>")],
    ["响应形状异常（缺 exists）", () => jsonRes(200, { nope: 1 })],
  ])("%s → 不误报成 unreadable", async (_name, make) => {
    getFull = make;
    const store = await import("@/lib/local-store");
    await store.initSettings();
    expect(store.getSettingsUnreadable()).toBeNull();
  });

  it("网络异常（fetch 抛错）→ 不误报成 unreadable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const store = await import("@/lib/local-store");
    await store.initSettings();
    expect(store.getSettingsUnreadable()).toBeNull();
  });

  it("先 unreadable、后来别的失败 → 状态不残留（不拿旧状态顶着）", async () => {
    getFull = () => jsonRes(500, { error: "settings_unreadable", reason: "json_parse" });
    const store = await import("@/lib/local-store");
    await store.initSettings();
    expect(store.getSettingsUnreadable()).not.toBeNull();
    getFull = () => jsonRes(500, { error: "boom" });
    await store.initSettings();
    expect(store.getSettingsUnreadable()).toBeNull();
  });
});

describe("接线契约：use-settings / 设置页（未在浏览器里看过实际渲染）", () => {
  const hook = read("src/hooks/use-settings.ts");
  const page = read("src/app/settings/page.tsx");

  it("use-settings：init 后读 getSettingsUnreadable、对外暴露 unreadable", () => {
    expect(hook).toContain("getSettingsUnreadable");
    expect(hook).toMatch(/setUnreadable\(getSettingsUnreadable\(\)\)/);
    expect(hook).toMatch(/\n\s+unreadable,\n/);
  });

  it("use-settings：不可读时 saveFieldValue 直接拒绝（不落盘、不排自动重试）、不再算「有未保存修改」", () => {
    const save = hook.slice(
      hook.indexOf("const saveFieldValue = "),
      hook.indexOf("// 离页前拦截"),
    );
    // 早返回在 saveWithRetry 之前
    const iGuard = save.indexOf("unreadableRef.current");
    const iRetry = save.indexOf("saveWithRetry(");
    expect(iGuard).toBeGreaterThan(-1);
    expect(iRetry).toBeGreaterThan(iGuard);
    expect(save.slice(iGuard, iRetry)).toContain("Promise.resolve(false)");
    expect(hook).toMatch(/!unreadable && Object\.values\(dirty\)\.some\(Boolean\)/);
  });

  it("设置页：不可读时在顶部给 role=alert 提示（标题 + 说明 + reason），并且不渲染表单卡片", () => {
    expect(page).toContain("unreadable");
    expect(page).toContain("describeSettingsUnreadable(");
    expect(page).toContain('role="alert"');
    expect(page).toMatch(/\{unreadable\.reason\}/);
    // 提示在第一张卡之前；卡片区被 `!unreadable` 守着
    expect(page.indexOf('role="alert"')).toBeLessThan(page.indexOf("wrapCard(\n          \"model\""));
    expect(page).toContain("{!unreadable && (");
  });
});
