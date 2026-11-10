/**
 * 内置浏览器的两个设置（evaluateEnabled / recordInputValues）：默认关、只认显式 true、
 * 写盘后同步缓存刷新并通知订阅者（bridge 据此推 config）、PATCH 字段级保存放行。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-browser-settings-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

vi.mock("@/lib/server/git-token-env", () => ({ syncGitTokenEnv: vi.fn() }));
vi.mock("@/lib/server/gitlab-host", () => ({
  pinTrustedGitHostFromSettings: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/mr-inbox-scanner", () => ({ invalidateMrInboxCache: vi.fn() }));
vi.mock("@/lib/server/agent-shell", () => ({ applyAgentShellPreference: vi.fn(async () => undefined) }));
vi.mock("@/lib/server/company-env-fs", () => ({ syncCompanyEnvFileFromObject: vi.fn(async () => undefined) }));

import { PATCH } from "@/app/api/settings/route";
import { isFieldEqual } from "@/hooks/use-settings";
import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/local-store";
import {
  BROWSER_SETTINGS_DEFAULTS,
  __resetBrowserSettingsForTest,
  getBrowserSettingsSync,
  normalizeBrowserMaxTabs,
  onBrowserSettingsChange,
  parseBrowserSettings,
  refreshBrowserSettings,
  toBrowserConfig,
  watchBrowserSettings,
} from "@/lib/server/browser/settings";
import { settingsFilePath, writeSettingsFileAtomic } from "@/lib/server/settings-fs";

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
  await fs.mkdir(TMP_ROOT, { recursive: true });
  __resetBrowserSettingsForTest();
  watchBrowserSettings();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("默认值与解析", () => {
  it("默认都关；只认显式 true（字符串 'true' / 1 / 缺省都算关）", () => {
    expect(BROWSER_SETTINGS_DEFAULTS).toEqual({
      evaluateEnabled: false,
      recordInputValues: false,
      // 增强包 E2（契约 §15）：放开型默认关、收紧型默认开、标签上限 20
      storageAccess: false,
      pagePermissions: false,
      trustLoopbackCerts: true,
      networkBodyRead: true,
      advancedTools: true,
      maxTabs: 20,
    });
    expect(parseBrowserSettings(undefined)).toEqual(BROWSER_SETTINGS_DEFAULTS);
    expect(parseBrowserSettings({ browserEvaluateEnabled: "true", browserRecordInputValues: 1 })).toEqual(BROWSER_SETTINGS_DEFAULTS);
    expect(parseBrowserSettings({ browserEvaluateEnabled: true })).toEqual({ ...BROWSER_SETTINGS_DEFAULTS, evaluateEnabled: true });
  });

  it("E2 放开型（storageAccess / pagePermissions）只认显式 true；脏值一律关", () => {
    for (const bad of ["true", 1, "yes", null, {}, [true]]) {
      const p = parseBrowserSettings({ browserStorageAccess: bad, browserPagePermissions: bad });
      expect(p.storageAccess).toBe(false);
      expect(p.pagePermissions).toBe(false);
    }
    const on = parseBrowserSettings({ browserStorageAccess: true, browserPagePermissions: true });
    expect(on.storageAccess).toBe(true);
    expect(on.pagePermissions).toBe(true);
  });

  it("E2 收紧型（trustLoopbackCerts / networkBodyRead / advancedTools）缺省与脏值都开，只有显式 false 才关", () => {
    for (const dirty of [undefined, "false", 0, null, "no"]) {
      const p = parseBrowserSettings({ browserTrustLoopbackCerts: dirty, browserNetworkBodyRead: dirty, browserAdvancedTools: dirty });
      expect(p.trustLoopbackCerts).toBe(true);
      expect(p.networkBodyRead).toBe(true);
      expect(p.advancedTools).toBe(true);
    }
    const off = parseBrowserSettings({ browserTrustLoopbackCerts: false, browserNetworkBodyRead: false, browserAdvancedTools: false });
    expect([off.trustLoopbackCerts, off.networkBodyRead, off.advancedTools]).toEqual([false, false, false]);
  });

  it("E2 maxTabs：5–60 的整数才认，边界含；其余回 20", () => {
    expect(normalizeBrowserMaxTabs(5)).toBe(5);
    expect(normalizeBrowserMaxTabs(60)).toBe(60);
    for (const bad of [4, 61, 0, -1, 10.5, "30", null, undefined, NaN, Infinity]) expect(normalizeBrowserMaxTabs(bad)).toBe(20);
    expect(parseBrowserSettings({ browserMaxTabs: 33 }).maxTabs).toBe(33);
    expect(parseBrowserSettings({ browserMaxTabs: 999 }).maxTabs).toBe(20);
  });

  it("E2 前端 normalizeSettings / DEFAULT_SETTINGS / isFieldEqual 口径与 server 一致", () => {
    expect(DEFAULT_SETTINGS.browserStorageAccess).toBe(false);
    expect(DEFAULT_SETTINGS.browserPagePermissions).toBe(false);
    expect(DEFAULT_SETTINGS.browserTrustLoopbackCerts).toBe(true);
    expect(DEFAULT_SETTINGS.browserNetworkBodyRead).toBe(true);
    expect(DEFAULT_SETTINGS.browserAdvancedTools).toBe(true);
    expect(DEFAULT_SETTINGS.browserMaxTabs).toBe(20);
    const n = normalizeSettings({ browserStorageAccess: "yes", browserTrustLoopbackCerts: "no", browserMaxTabs: 3 } as never);
    expect(n.browserStorageAccess).toBe(false);
    expect(n.browserTrustLoopbackCerts).toBe(true);
    expect(n.browserMaxTabs).toBe(20);
    expect(normalizeSettings({ browserMaxTabs: 45 } as never).browserMaxTabs).toBe(45);
    // 缺省与默认值视为相等（不会被误判成「有未保存修改」）
    expect(isFieldEqual("browserMaxTabs", { ...DEFAULT_SETTINGS, browserMaxTabs: undefined }, DEFAULT_SETTINGS)).toBe(true);
    expect(isFieldEqual("browserMaxTabs", { ...DEFAULT_SETTINGS, browserMaxTabs: 30 }, DEFAULT_SETTINGS)).toBe(false);
    expect(isFieldEqual("browserTrustLoopbackCerts", { ...DEFAULT_SETTINGS, browserTrustLoopbackCerts: undefined }, DEFAULT_SETTINGS)).toBe(true);
    expect(isFieldEqual("browserStorageAccess", { ...DEFAULT_SETTINGS, browserStorageAccess: undefined }, DEFAULT_SETTINGS)).toBe(true);
  });

  it("前端 normalizeSettings / DEFAULT_SETTINGS 口径一致，且脏检测用 boolFalse", () => {
    expect(DEFAULT_SETTINGS.browserEvaluateEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.browserRecordInputValues).toBe(false);
    const n = normalizeSettings({ browserEvaluateEnabled: "yes", browserRecordInputValues: true } as never);
    expect(n.browserEvaluateEnabled).toBe(false);
    expect(n.browserRecordInputValues).toBe(true);
    // 缺省与显式 false 视为相等（不会被误判成「有未保存修改」）
    expect(isFieldEqual("browserEvaluateEnabled", { ...DEFAULT_SETTINGS, browserEvaluateEnabled: undefined }, DEFAULT_SETTINGS)).toBe(true);
    expect(isFieldEqual("browserEvaluateEnabled", { ...DEFAULT_SETTINGS, browserEvaluateEnabled: true }, DEFAULT_SETTINGS)).toBe(false);
  });

  it("toBrowserConfig 映射成协议里的 config 载荷", () => {
    expect(toBrowserConfig({ ...BROWSER_SETTINGS_DEFAULTS, evaluateEnabled: true })).toEqual({
      evaluateEnabled: true,
      recordInputValues: false,
      storageAccess: false,
      pagePermissions: false,
      trustLoopbackCerts: true,
      networkBodyRead: true,
      maxTabs: 20,
    });
  });
});

describe("写盘后缓存刷新 + 通知", () => {
  it("writeSettingsFileAtomic 之后同步缓存即时更新；只有值真变化才通知订阅者", async () => {
    const changes: Array<{ evaluateEnabled: boolean; recordInputValues: boolean }> = [];
    onBrowserSettingsChange((s) => changes.push(s));
    expect(getBrowserSettingsSync().evaluateEnabled).toBe(false);

    await writeSettingsFileAtomic({ apiKey: "k", browserEvaluateEnabled: true } as never);
    expect(getBrowserSettingsSync()).toEqual({ ...BROWSER_SETTINGS_DEFAULTS, evaluateEnabled: true, recordInputValues: false });
    expect(changes).toHaveLength(1);

    // 再写一次同样的浏览器设置（比如改了别的字段）：不重复通知
    await writeSettingsFileAtomic({ apiKey: "k2", browserEvaluateEnabled: true } as never);
    expect(changes).toHaveLength(1);

    await writeSettingsFileAtomic({ apiKey: "k2", browserEvaluateEnabled: false, browserRecordInputValues: true } as never);
    expect(getBrowserSettingsSync()).toEqual({ ...BROWSER_SETTINGS_DEFAULTS, evaluateEnabled: false, recordInputValues: true });
    expect(changes).toHaveLength(2);
  });

  it("订阅回调抛错不影响保存与其它订阅者", async () => {
    const ok = vi.fn();
    onBrowserSettingsChange(() => {
      throw new Error("boom");
    });
    onBrowserSettingsChange(ok);
    await expect(writeSettingsFileAtomic({ browserRecordInputValues: true } as never)).resolves.not.toThrow();
    expect(ok).toHaveBeenCalled();
  });

  it("refreshBrowserSettings 读盘；文件缺失按默认；读不到不凭空打开", async () => {
    await fs.writeFile(settingsFilePath(), JSON.stringify({ browserEvaluateEnabled: true }), "utf-8");
    await expect(refreshBrowserSettings()).resolves.toEqual({ ...BROWSER_SETTINGS_DEFAULTS, evaluateEnabled: true, recordInputValues: false });
    await fs.rm(settingsFilePath());
    await expect(refreshBrowserSettings()).resolves.toEqual(BROWSER_SETTINGS_DEFAULTS);
    // 文件损坏：保持上一次已知值（这里先置 true，再写坏文件）
    __resetBrowserSettingsForTest({ evaluateEnabled: true });
    await fs.writeFile(settingsFilePath(), "{ not json", "utf-8");
    const after = await refreshBrowserSettings();
    expect(after.evaluateEnabled).toBe(true);
  });
});

describe("PATCH 字段级保存", () => {
  it("两个键在 KNOWN_SETTINGS_KEYS 里：放行并落盘，缓存随之刷新", async () => {
    await fs.writeFile(settingsFilePath(), JSON.stringify({ apiKey: "k" }), "utf-8");
    const res = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: { browserEvaluateEnabled: true, browserRecordInputValues: true } }),
      }),
    );
    expect(res.status).toBe(200);
    const disk = JSON.parse(await fs.readFile(settingsFilePath(), "utf-8")) as Record<string, unknown>;
    expect(disk.browserEvaluateEnabled).toBe(true);
    expect(disk.browserRecordInputValues).toBe(true);
    expect(getBrowserSettingsSync()).toEqual({ ...BROWSER_SETTINGS_DEFAULTS, evaluateEnabled: true, recordInputValues: true });
  });
});
