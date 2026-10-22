/**
 * 第三轮 D1-01：设置保存改成「字段级补丁」——陈旧客户端只改一个开关，不能把别处刚改的 key / 仓库整体还原。
 * 真实 route handler + 真实 settings-fs（临时数据目录）+ 真实 local-store（桩 fetch 转发到 route）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-settings-field-patch-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

vi.mock("@/lib/server/git-token-env", () => ({ syncGitTokenEnv: vi.fn() }));
vi.mock("@/lib/server/gitlab-host", () => ({
  pinTrustedGitHostFromSettings: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/mr-inbox-scanner", () => ({
  invalidateMrInboxCache: vi.fn(),
}));
vi.mock("@/lib/server/agent-shell", () => ({
  applyAgentShellPreference: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/company-env-fs", () => ({
  syncCompanyEnvFileFromObject: vi.fn(async () => undefined),
}));

import { PATCH, PUT } from "@/app/api/settings/route";
import { settingsFilePath, validateSettingsPatch } from "@/lib/server/settings-fs";
import { maskSettingsSecrets } from "@/lib/server/settings-fs";

const BASE = {
  apiKey: "sk-new-rotated-key-0002",
  gitToken: "glpat-xyz",
  defaultModel: { id: "composer-2" },
  repos: [
    { name: "web", path: "/repo/web" },
    { name: "api", path: "/repo/api" },
  ],
};

const readDisk = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(settingsFilePath(), "utf-8")) as Record<string, unknown>;

const patch = (body: unknown): Promise<Response> =>
  PATCH(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
  await fs.mkdir(TMP_ROOT, { recursive: true });
  await fs.writeFile(settingsFilePath(), JSON.stringify(BASE), "utf-8");
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("PATCH /api/settings：只替换补丁里的键", () => {
  it("陈旧客户端改一个开关：盘上别处刚改的 apiKey 轮换 / 仓库 2 条原样保留（整包 PUT 会还原成旧值）", async () => {
    const res = await patch({ patch: { reuseAgentDefault: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const disk = await readDisk();
    expect(disk.reuseAgentDefault).toBe(true);
    expect(disk.apiKey).toBe(BASE.apiKey);
    expect(disk.repos).toEqual(BASE.repos);
    expect(disk.gitToken).toBe(BASE.gitToken);
  });

  it("对照：同一个陈旧客户端走整包 PUT 会把盘上的新 key / 仓库覆盖回旧值（这就是 D1-01）", async () => {
    const stale = {
      apiKey: "sk-old-revoked-key-0001",
      defaultModel: { id: "composer-2" },
      repos: [{ name: "web", path: "/repo/web" }],
      reuseAgentDefault: true,
    };
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stale),
      }),
    );
    expect(res.status).toBe(200);
    expect((await readDisk()).apiKey).toBe("sk-old-revoked-key-0001");
  });

  it("补丁里的 apiKey 是掩码展示串 → 沿用盘上真值（与 PUT 同一套掩码兜底）", async () => {
    const masked = maskSettingsSecrets({ ...BASE }).apiKey as string;
    expect(masked).not.toBe(BASE.apiKey);
    const res = await patch({ patch: { apiKey: masked, reuseAgentDefault: false } });
    expect(res.status).toBe(200);
    const disk = await readDisk();
    expect(disk.apiKey).toBe(BASE.apiKey);
    expect(disk.reuseAgentDefault).toBe(false);
  });

  it("remove：删掉可选键；但不能删必备三项", async () => {
    await patch({ patch: { reuseAgentDefault: true } });
    const ok = await patch({ remove: ["reuseAgentDefault"] });
    expect(ok.status).toBe(200);
    expect("reuseAgentDefault" in (await readDisk())).toBe(false);
    for (const k of ["apiKey", "defaultModel", "repos"]) {
      const res = await patch({ remove: [k] });
      expect(res.status).toBe(400);
    }
    expect((await readDisk()).apiKey).toBe(BASE.apiKey);
  });

  it("补丁把必备字段改成错误类型 → 合并后校验不过，400，盘上不动", async () => {
    const before = await fs.readFile(settingsFilePath(), "utf-8");
    const res = await patch({ patch: { repos: "not-an-array" } });
    expect(res.status).toBe(400);
    expect(await fs.readFile(settingsFilePath(), "utf-8")).toBe(before);
  });

  it("空补丁 / 非对象 / 危险键名 → 400", async () => {
    for (const body of [
      {},
      { patch: {} },
      { patch: [] },
      { patch: "x" },
      { remove: "x" },
      { remove: [1] },
      { patch: { constructor: 1 } },
      JSON.parse('{"patch":{"__proto__":{"x":1}}}'),
      [],
      null,
    ]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(validateSettingsPatch({ patch: { a: 1 } })).toBeNull();
  });

  it("盘上没有 config.json → 409（补丁没有基线）", async () => {
    await fs.rm(settingsFilePath(), { force: true });
    const res = await patch({ patch: { reuseAgentDefault: true } });
    expect(res.status).toBe(409);
    await expect(fs.stat(settingsFilePath())).rejects.toThrow();
  });

  it("盘上 config.json 损坏 → 500 settings_unreadable，坏文件原样不动", async () => {
    await fs.writeFile(settingsFilePath(), "{ not json", "utf-8");
    const res = await patch({ patch: { reuseAgentDefault: true } });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error?: string }).error).toBe("settings_unreadable");
    expect(await fs.readFile(settingsFilePath(), "utf-8")).toBe("{ not json");
  });

  it("并发两个补丁（不同字段）都落地：写锁内读改写，不丢更新", async () => {
    const [a, b] = await Promise.all([
      patch({ patch: { reuseAgentDefault: true } }),
      patch({ patch: { teamKnowledgeEnabled: false } }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const disk = await readDisk();
    expect(disk.reuseAgentDefault).toBe(true);
    expect(disk.teamKnowledgeEnabled).toBe(false);
  });
});

describe("PATCH 合并后补全必备三项（第四轮 Q2-03）：盘上缺项 / 格式旧不再恒 400", () => {
  const writeDisk = (obj: Record<string, unknown>) =>
    fs.writeFile(settingsFilePath(), JSON.stringify(obj), "utf-8");

  it("盘上只有 apiKey（缺 defaultModel / repos）：PATCH 单字段成功，补默认、不改别的字段", async () => {
    await writeDisk({ apiKey: "sk-only", gitToken: "glpat-keep", jumpIde: "vscode" });
    const res = await patch({ patch: { reuseAgentDefault: true } });
    expect(res.status).toBe(200);
    const disk = await readDisk();
    expect(disk).toMatchObject({
      apiKey: "sk-only",
      gitToken: "glpat-keep",
      jumpIde: "vscode",
      reuseAgentDefault: true,
      defaultModel: { id: "" },
      repos: [],
    });
  });

  it("盘上 defaultModel 是旧字符串 / 缺 apiKey：同样自愈（旧整包 PUT 靠客户端 normalizeSettings 自愈，PATCH 现在服务端补）", async () => {
    await writeDisk({ defaultModel: "composer-2", repos: [{ name: "web", path: "/repo/web" }] });
    const res = await patch({ patch: { teamKnowledgeEnabled: false } });
    expect(res.status).toBe(200);
    const disk = await readDisk();
    expect(disk.defaultModel).toEqual({ id: "" });
    expect(disk.apiKey).toBe("");
    expect(disk.repos).toEqual([{ name: "web", path: "/repo/web" }]); // 好的字段原样
    expect(disk.teamKnowledgeEnabled).toBe(false);
  });

  it("反例对：配置完整时不凭空加键（没配过提供方的盘不会多出 provider / customProviders），也不动任何已有字段", async () => {
    await writeDisk({ ...BASE, jumpIde: "vscode" });
    const res = await patch({ patch: { reuseAgentDefault: true } });
    expect(res.status).toBe(200);
    expect(await readDisk()).toEqual({ ...BASE, jumpIde: "vscode", reuseAgentDefault: true });
  });

  it("反例对：补丁自己把必备字段写成坏值仍是 400（不被悄悄补成默认把仓库清空）", async () => {
    await writeDisk({ ...BASE });
    for (const bad of [{ repos: "x" }, { apiKey: 1 }, { defaultModel: "composer-2" }]) {
      const res = await patch({ patch: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await readDisk()).repos).toEqual(BASE.repos);
  });

  it("400 带服务端原因（前端 toast 展示它）：不再只剩通用「请检查输入」", async () => {
    const res = await patch({ patch: { repos: "x" } });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error?: string };
    expect(error).toBeTruthy();
    expect(error).toContain("repos");
    const { rejectedToast } = await import("@/hooks/use-settings");
    expect(rejectedToast(400, error)).toContain(error!);
    // 没有服务端原因时退回通用文案
    expect(rejectedToast(400, null)).toContain("请检查输入");
    expect(rejectedToast(400, "  ")).toContain("请检查输入");
  });
});

describe("PATCH 与 PUT 同口径归一（第四轮 Q2-05）：遗留键清掉、旧单槽升级、删光提供方不复活", () => {
  const legacyDisk = {
    ...BASE,
    username: "old-user",
    gitHost: "gitlab.example.com",
    groupCollab: { a: true },
    provider: "custom",
    customProvider: {
      name: "旧网关",
      baseUrl: "https://gw.example.com/v1",
      apiKey: "sk-legacy-plaintext",
      format: "openai",
    },
  };
  const writeDisk = (obj: Record<string, unknown>) =>
    fs.writeFile(settingsFilePath(), JSON.stringify(obj), "utf-8");

  it("PATCH 一个无关开关：退役键与旧单槽 customProvider 升级进 customProviders[]、旧键清掉（旧 PUT 会清）", async () => {
    await writeDisk(legacyDisk);
    const res = await patch({ patch: { reuseAgentDefault: true } });
    expect(res.status).toBe(200);
    const disk = await readDisk();
    for (const k of ["username", "gitHost", "groupCollab", "customProvider"]) {
      expect(k in disk, k).toBe(false);
    }
    expect(disk.customProviders).toEqual([
      expect.objectContaining({
        id: "cp_legacy",
        baseUrl: "https://gw.example.com/v1",
        apiKey: "sk-legacy-plaintext",
      }),
    ]);
    expect(disk.provider).toBe("cp_legacy"); // provider: "custom" 解析成迁后那条 id
    expect(disk.reuseAgentDefault).toBe(true);
    expect(disk.apiKey).toBe(BASE.apiKey);
  });

  it("PATCH customProviders: []（删光提供方）后旧单槽不复活：盘上无 customProvider、重读迁移仍是空", async () => {
    await writeDisk(legacyDisk);
    const res = await patch({ patch: { customProviders: [], provider: "cursor" } });
    expect(res.status).toBe(200);
    const disk = await readDisk();
    expect("customProvider" in disk).toBe(false);
    expect(disk.customProviders).toEqual([]);
    const { migrateProviderSettings } = await import("@/lib/agent-provider");
    expect(migrateProviderSettings(disk).customProviders).toEqual([]);
    expect(migrateProviderSettings(disk).provider).toBe("cursor");
  });

  it("remove customProviders 同样不让旧单槽复活", async () => {
    await writeDisk(legacyDisk);
    const res = await patch({ remove: ["customProviders"], patch: { reuseAgentDefault: true } });
    expect(res.status).toBe(200);
    const disk = await readDisk();
    expect("customProvider" in disk).toBe(false);
    const { migrateProviderSettings } = await import("@/lib/agent-provider");
    expect(migrateProviderSettings(disk).customProviders).toEqual([]);
  });

  it("反例对：PATCH 写入新的 customProviders 列表照常落盘（含 key），provider 指向它也保留", async () => {
    await writeDisk({ ...BASE });
    const cps = [
      { id: "cp_new", name: "新网关", baseUrl: "https://new.example.com/v1", apiKey: "sk-new", format: "openai" },
    ];
    const res = await patch({ patch: { customProviders: cps, provider: "cp_new" } });
    expect(res.status).toBe(200);
    const disk = await readDisk();
    expect(disk.customProviders).toEqual([expect.objectContaining(cps[0]!)]);
    expect(disk.provider).toBe("cp_new");
  });

  it("反例对：现代盘（无旧键）PATCH 后遗留键表里的键一个也不存在、其余原样", async () => {
    await writeDisk({ ...BASE, provider: "cursor", customProviders: [] });
    await patch({ patch: { reuseAgentDefault: true } });
    expect(await readDisk()).toEqual({
      ...BASE,
      provider: "cursor",
      customProviders: [],
      reuseAgentDefault: true,
    });
  });
});

describe("服务端也拒绝地址带用户名 / 密码的提供方（第四轮 Q2-06）", () => {
  const cp = (baseUrl: string, name = "内网网关") => ({
    id: "cp_ui",
    name,
    baseUrl,
    apiKey: "sk-x",
    format: "openai",
  });
  const put = (body: unknown): Promise<Response> =>
    PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("PATCH customProviders 含 userinfo 地址 → 400 + 原因（点名提供方、不回显地址里的凭据）、盘上不动", async () => {
    const before = await fs.readFile(settingsFilePath(), "utf-8");
    const res = await patch({ patch: { customProviders: [cp("https://user:TOK123@api.example.com/v1")] } });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error?: string };
    expect(error).toContain("用户名 / 密码");
    expect(error).toContain("内网网关");
    expect(error).not.toContain("TOK123");
    expect(await fs.readFile(settingsFilePath(), "utf-8")).toBe(before);
  });

  it("PUT 整包含 userinfo 地址 → 400，盘上不动", async () => {
    const before = await fs.readFile(settingsFilePath(), "utf-8");
    const res = await put({ ...BASE, customProviders: [cp("https://TOK123@api.example.com/v1")] });
    expect(res.status).toBe(400);
    expect(await fs.readFile(settingsFilePath(), "utf-8")).toBe(before);
  });

  it("反例对：正常地址 / 路径里的 @scope / 空地址草稿 / 其它不合法但无 userinfo 的写法（UI 红字管）照常保存", async () => {
    for (const baseUrl of [
      "https://api.example.com/v1",
      "https://api.example.com/v1/@scope/x",
      "",
      "localhost:11434/v1",
    ]) {
      const res = await patch({ patch: { customProviders: [cp(baseUrl)] } });
      expect(res.status, baseUrl).toBe(200);
    }
  });

  it("反例对：盘上已有旧的 userinfo 条目时，改无关开关不被挡（只校验这次写入的值）", async () => {
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify({ ...BASE, customProviders: [cp("https://u:old@api.example.com/v1")] }),
      "utf-8",
    );
    const res = await patch({ patch: { reuseAgentDefault: true } });
    expect(res.status).toBe(200);
  });
});

describe("local-store：带 changedKeys 的保存走 PATCH、只发改动的键", () => {
  it("saveSettingsDetailed(next, [key]) → 一次 PATCH，body 只含该键；不带 keys 仍是整包 PUT", async () => {
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    const calls: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (String(url).includes("/api/settings/full")) {
        return new Response(JSON.stringify({ exists: true, settings: BASE }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    try {
      vi.resetModules();
      const store = await import("@/lib/local-store");
      await store.initSettings();
      calls.length = 0;
      const base = store.getSettings();

      const r1 = await store.saveSettingsDetailed({ ...base, reuseAgentDefault: true }, [
        "reuseAgentDefault",
      ]);
      expect(r1.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        method: "PATCH",
        body: { patch: { reuseAgentDefault: true } },
      });

      // undefined 值走 remove（JSON 会吞掉 undefined，不能当 patch 值）
      calls.length = 0;
      await store.saveSettingsDetailed({ ...store.getSettings(), reuseAgentDefault: undefined }, [
        "reuseAgentDefault",
      ]);
      expect(calls[0]).toEqual({
        method: "PATCH",
        body: { patch: {}, remove: ["reuseAgentDefault"] },
      });

      calls.length = 0;
      await store.saveSettingsDetailed({ ...store.getSettings(), reuseAgentDefault: false });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("PUT");
    } finally {
      vi.unstubAllGlobals();
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });

  it("use-settings 的首次保存与重试都带上 [key]（接线）", async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), "src/hooks/use-settings.ts"),
      "utf-8",
    );
    expect(src).toMatch(/first: \(\) => saveSettingsDetailed\(next, \[key\]\)/);
    expect(src).toMatch(/\{ \.\.\.getSettings\(\), \[key\]: value \},\s*\[key\],/);
  });
});
