/**
 * review #16：设置页首次加载 /full 瞬时失败 → 空表单 → 改一项就以默认值整包 PUT 覆盖磁盘配置
 *
 * 旧实现的链路（本文件钉住它不再发生）：
 *   init 失败 → cache=默认值、无任何提示的空表单 → 用户改一项，use-settings 用 `{...getSettings()（默认值）, [key]: value}` 构造 next
 *   → saveSettingsDetailed 发现 init 未成功、重试加载成功 → 然后 `cache = next` 并 PUT next
 *   = 以默认值为底的整包覆盖：磁盘上的 apiKey / gitToken / 仓库 / 公司环境 / MCP / provider 全被顶掉
 *   （服务端只会在「收缩」时留一份 .bak.shrink、写本身不拦）。
 *
 * 现在：没成功加载过真实配置 → 任何保存都拒绝（零 PUT）；设置页显示加载失败 + 「重试加载」；重试成功后才允许编辑。
 *
 * 分三层（项目没有 jsdom，hook / 页面渲染没法跑，所以：纯函数 + 真实 local-store 配桩 fetch + 源码接线契约）：
 *   A. 纯函数 canPersistSettings / describeSettingsLoadFailure
 *   B. local-store 行为（每个用例 resetModules 隔离模块级状态；fetch 桩只返回假数据、不碰网络与真实配置）
 *   C. use-settings / 设置页接线契约（未在浏览器里看过实际渲染）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SETTINGS_NOT_LOADED_TOAST,
  canPersistSettings,
  describeSettingsLoadFailure,
} from "@/lib/settings-load-state";

const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8");

describe("A. 纯函数", () => {
  it("canPersistSettings：只有 init 成功过才允许写盘", () => {
    expect(canPersistSettings({ initSucceeded: true })).toBe(true);
    expect(canPersistSettings({ initSucceeded: false })).toBe(false);
  });

  it("canPersistSettings：对非严格 true 的脏值也按拒绝处理（防 undefined / 真值误放行）", () => {
    expect(canPersistSettings({} as never)).toBe(false);
    expect(canPersistSettings({ initSucceeded: undefined } as never)).toBe(false);
    expect(canPersistSettings({ initSucceeded: 1 } as never)).toBe(false);
  });

  it("describeSettingsLoadFailure：说清没加载成功、没覆盖原文件、怎么办；不再说「自动重试」", () => {
    const t = describeSettingsLoadFailure();
    expect(t.headline).toContain("暂停保存");
    expect(t.detail).toContain("没有被改动");
    expect(t.detail).toContain("重试加载");
    expect(t.headline + t.detail).not.toContain("自动重试");
    expect(SETTINGS_NOT_LOADED_TOAST).toContain("重试加载");
    expect(SETTINGS_NOT_LOADED_TOAST).not.toContain("自动重试");
  });
});

// ---- B. local-store：真实模块 + 桩 fetch ----

type Json = Record<string, unknown>;

const jsonRes = (status: number, body: unknown): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** 假的「磁盘上的真实配置」——全是占位值，不含任何真实凭据 */
const REAL: Json = {
  apiKey: "sk-fake-on-disk",
  gitToken: "glpat-fake-on-disk",
  repos: [{ name: "repo-a", path: "/fake/repo-a" }],
  mcpServers: { foo: { command: "fake-mcp" } },
  provider: "cursor",
  defaultModel: { id: "fake-model" },
};

describe("B. local-store：没成功加载过真实配置就不写", () => {
  let puts: Json[] = [];
  /** GET /full 的响应（用例里随时换，模拟服务先挂后好） */
  let getFull: () => Response | Promise<Response> = () =>
    jsonRes(200, { exists: true, settings: REAL });

  beforeEach(() => {
    puts = [];
    // 每个用例从「服务正常」起步，别吃上一个用例留下的桩
    getFull = () => jsonRes(200, { exists: true, settings: REAL });
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") return getFull();
      puts.push(JSON.parse(String(init?.body)) as Json);
      return jsonRes(200, { ok: true, settings: {} });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it.each([
    ["网络异常（fetch 抛错）", () => Promise.reject(new TypeError("fetch failed"))],
    ["服务没就绪（503）", () => jsonRes(503, { error: "starting" })],
    ["别的 500（非 settings_unreadable）", () => jsonRes(500, { error: "boom" })],
    ["响应形状异常（缺 exists）", () => jsonRes(200, { nope: 1 })],
  ])("瞬时加载失败：%s → 未加载、缓存仍是默认值、保存被拒且零 PUT", async (_name, make) => {
    getFull = make as typeof getFull;
    const store = await import("@/lib/local-store");
    expect(store.isSettingsLoaded()).toBe(false); // init 之前
    await store.initSettings();
    expect(store.isSettingsLoaded()).toBe(false);
    // 瞬时失败没有 unreadable 状态——这正是旧实现「空表单且无提示」的来源，UI 必须另有 loadFailed 判据
    expect(store.getSettingsUnreadable()).toBeNull();
    expect(store.getSettings().apiKey).toBe("");

    const ok = await store.saveSettings({ ...store.getSettings(), apiKey: "typed" });
    expect(ok).toBe(false);
    expect(puts).toEqual([]);
    // 拒绝时缓存一个字没动（不留乐观值）
    expect(store.getSettings().apiKey).toBe("");
  });

  it("【核心回归】init 先失败、服务随后恢复：基于默认值构造的保存被拒（零 PUT）；缓存换成真实配置后，下一次保存保住全部配置", async () => {
    getFull = () => Promise.reject(new TypeError("fetch failed"));
    const store = await import("@/lib/local-store");
    await store.initSettings();
    expect(store.isSettingsLoaded()).toBe(false);

    // use-settings.saveFieldValue 的写法：以 getSettings()（此刻是默认值）为底、只改一项
    const nextFromDefaults = { ...store.getSettings(), apiKey: "sk-user-typed" };

    // 服务恢复。旧实现：保存里顺手重试 init 成功 → `cache = next` → PUT 默认值 + apiKey，磁盘其余配置全丢
    getFull = () => jsonRes(200, { exists: true, settings: REAL });
    expect(await store.saveSettings(nextFromDefaults)).toBe(false);
    expect(puts).toEqual([]);

    // 被拒的这次保存顺手把真实配置加载进来了
    expect(store.isSettingsLoaded()).toBe(true);
    expect(store.getSettings().gitToken).toBe("glpat-fake-on-disk");
    expect(store.getSettings().apiKey).toBe("sk-fake-on-disk");

    // 用户下一次操作：基于真实配置构造 next → 全部配置都保住、只有这一项被改
    expect(
      await store.saveSettings({ ...store.getSettings(), apiKey: "sk-user-typed" }),
    ).toBe(true);
    expect(puts).toHaveLength(1);
    const body = puts[0];
    expect(body.apiKey).toBe("sk-user-typed");
    expect(body.gitToken).toBe("glpat-fake-on-disk");
    expect((body.repos as { path: string }[]).map((r) => r.path)).toEqual(["/fake/repo-a"]);
    expect(body.mcpServers).toEqual({ foo: { command: "fake-mcp" } });
    expect((body.defaultModel as { id: string }).id).toBe("fake-model");
  });

  it("「重试加载」（再调 initSettings）成功后：标记已加载、可保存", async () => {
    getFull = () => jsonRes(503, { error: "starting" });
    const store = await import("@/lib/local-store");
    await store.initSettings();
    expect(store.isSettingsLoaded()).toBe(false);

    getFull = () => jsonRes(200, { exists: true, settings: REAL });
    await store.initSettings();
    expect(store.isSettingsLoaded()).toBe(true);
    expect(store.getSettings().apiKey).toBe("sk-fake-on-disk");

    expect(await store.saveSettings({ ...store.getSettings(), jumpIde: "vscode" })).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0].apiKey).toBe("sk-fake-on-disk");
  });

  it("保存发生在 init 还没完成时（GET 在途）：同样拒绝、零 PUT；init 完成后缓存是真实配置", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    getFull = async () => {
      await gate;
      return jsonRes(200, { exists: true, settings: REAL });
    };
    const store = await import("@/lib/local-store");
    const initP = store.initSettings();
    // 页面刚打开、真实配置还没回来就触发了保存（典型：toggleStarredModel / 布局保存）——next 基于默认值
    const savedP = store.saveSettings({ ...store.getSettings(), apiKey: "early" });
    release();
    await initP;
    expect(await savedP).toBe(false);
    expect(puts).toEqual([]);
    expect(store.getSettings().apiKey).toBe("sk-fake-on-disk");
  });

  it("config.json 不可读（500 settings_unreadable）：未加载、保存被拒、零 PUT（行为同改前）", async () => {
    getFull = () => jsonRes(500, { error: "settings_unreadable", reason: "json_parse: at position 8" });
    const store = await import("@/lib/local-store");
    await store.initSettings();
    expect(store.isSettingsLoaded()).toBe(false);
    expect(store.getSettingsUnreadable()).toEqual({ reason: "json_parse: at position 8" });
    expect(await store.saveSettings({ ...store.getSettings(), apiKey: "k" })).toBe(false);
    expect(puts).toEqual([]);
  });

  it("加载成功后保存照常（回归：拒写只针对未加载）：一次 PUT、body = next，失败仍回滚", async () => {
    const store = await import("@/lib/local-store");
    await store.initSettings();
    expect(store.isSettingsLoaded()).toBe(true);
    expect(await store.saveSettings({ ...store.getSettings(), apiKey: "rotated" })).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0].apiKey).toBe("rotated");
    expect(store.getSettings().apiKey).toBe("rotated");
  });

  it("首次安装（/full 明确 exists:false）：写默认值起步后视为已加载、之后可保存", async () => {
    getFull = () => jsonRes(200, { exists: false, settings: null });
    const store = await import("@/lib/local-store");
    await store.initSettings();
    expect(store.isSettingsLoaded()).toBe(true);
    expect(puts).toHaveLength(1); // 起步写默认值（唯一一次、且只发生在「文件确实不存在」时）
    expect(await store.saveSettings({ ...store.getSettings(), apiKey: "first" })).toBe(true);
    expect(puts).toHaveLength(2);
  });
});

// ---- C. 接线契约 ----

describe("C. 接线契约：use-settings / 设置页（没有 DOM 环境，未在浏览器里看过实际渲染）", () => {
  const hook = read("src/hooks/use-settings.ts");
  const page = read("src/app/settings/page.tsx");
  const store = read("src/lib/local-store.ts");

  it("local-store：拒写闸在乐观更新 cache 之前，且不再有「init 成功后 cache = next 再写」", () => {
    const fn = store.slice(
      store.indexOf("export const saveSettingsDetailed"),
      store.indexOf("export const saveSettings = "),
    );
    const iGuard = fn.indexOf("canPersistSettings({ initSucceeded })");
    const iOptimistic = fn.indexOf("cache = next;");
    expect(iGuard).toBeGreaterThan(-1);
    expect(iOptimistic).toBeGreaterThan(iGuard);
    expect(fn).not.toMatch(/\n\s+cache = next;\n\s+\}\n/); // 旧的 init 成功后写回 next 的分支已删
    expect(fn.split("cache = next;").length - 1).toBe(1);
  });

  it("use-settings：saveFieldValue 在未加载时直接拒绝（不改草稿、不落盘、不排重试），且在 saveWithRetry 之前", () => {
    const save = hook.slice(
      hook.indexOf("const saveFieldValue = "),
      hook.indexOf("// 离页前拦截"),
    );
    const iGuard = save.indexOf("canPersistSettings({ initSucceeded: isSettingsLoaded() })");
    const iDraft = save.indexOf("setSettings((prev)");
    const iRetry = save.indexOf("saveWithRetry(");
    expect(iGuard).toBeGreaterThan(-1);
    expect(iDraft).toBeGreaterThan(iGuard);
    expect(iRetry).toBeGreaterThan(iGuard);
    expect(save.slice(iGuard, iDraft)).toContain("Promise.resolve(false)");
  });

  it("use-settings：init 后读 isSettingsLoaded 设 loadFailed；对外暴露 loadFailed / retrying / retryLoad；加载失败不算「有未保存修改」", () => {
    expect(hook).toMatch(/setLoadFailed\(!isSettingsLoaded\(\)\)/);
    expect(hook).toMatch(/\n\s+loadFailed,\n\s+retrying,\n\s+retryLoad,\n/);
    expect(hook).toMatch(/!unreadable && !loadFailed && Object\.values\(dirty\)\.some\(Boolean\)/);
  });

  it("use-settings：retryLoad 重新 initSettings、再把真实配置灌进草稿（applyInitResult 与首次加载共用）", () => {
    const retry = hook.slice(hook.indexOf("const retryLoad"), hook.indexOf("// dirty 状态按字段缓存"));
    expect(retry).toContain("await initSettings()");
    expect(retry).toContain("applyInitResult()");
    expect(hook).toMatch(/const applyInitResult = useCallback\(/);
    expect(hook.slice(hook.indexOf("const applyInitResult"), hook.indexOf("// 首次挂载"))).toContain(
      "setSettings(s)",
    );
  });

  it("设置页：加载失败时顶部 role=alert 横幅 + 「重试加载」按钮，卡片区不渲染；失败文案走 describeSettingsLoadFailure", () => {
    expect(page).toContain("describeSettingsLoadFailure(");
    expect(page).toContain("重试加载");
    expect(page).toMatch(/onClick=\{\(\) => void retryLoad\(\)\}/);
    expect(page).toMatch(/disabled=\{retrying\}/);
    expect(page.indexOf("重试加载")).toBeLessThan(page.indexOf('wrapCard(\n          "model"'));
    expect(page).toContain("{!loadFailed && (");
    // 加载失败时不拿默认值去拉模型；重试成功（loadFailed 翻 false）后才拉
    expect(page).toMatch(/if \(!loaded \|\| loadFailed \|\| didInitValidate\.current\) return;/);
  });
});
