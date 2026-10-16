/**
 * F6-03（服务端半边）：config.json 不可读时，GET /api/settings/full 与 PUT /api/settings 的 500 响应
 * 要带上「不含文件内容」的 reason，设置页才能告诉用户到底是哪类问题。
 *
 * 为什么 reason 要净化：V8 对 `Unexpected token` 类 JSON 报错会把出错位置附近的原文拼进 message
 * （实测形如 `...""apiKey": sk-SECRET-"... is not valid JSON`），而手改 config.json 漏引号恰恰最容易触发它——
 * 不净化的话，密钥片段会进 500 响应、服务端日志（main.log → 诊断包）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-settings-unreadable-${Date.now()}`);
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

import { GET as getFull } from "@/app/api/settings/full/route";
import { PUT } from "@/app/api/settings/route";
import { readSettingsFile, settingsFilePath } from "@/lib/server/settings-fs";

// 漏引号的手改残留：V8 会把 `"apiKey": sk-SECRET-` 这一段原文拼进报错
const LEAKY_RAW = '{"apiKey": sk-SECRET-1234567890abcdef, "gitToken": "glpat-LEAK"}';

const putOnce = (): Promise<Response> =>
  PUT(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // 完整配置对象（PUT 必须带 apiKey / defaultModel / repos，否则 400 先于「不可读」判定）
      body: JSON.stringify({ apiKey: "sk-new", defaultModel: { id: "" }, repos: [] }),
    }),
  );

beforeEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("F6-03 readSettingsFile 的 reason 不夹带文件内容", () => {
  it("漏引号导致 `Unexpected token` 类报错 → reason 里没有原文片段，仍带 json_parse 前缀", async () => {
    await fs.writeFile(settingsFilePath(), LEAKY_RAW, "utf-8");
    const result = await readSettingsFile();
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toMatch(/^json_parse/);
    expect(result.reason).not.toContain("sk-SECRET");
    expect(result.reason).not.toContain("apiKey");
    expect(result.reason).not.toContain("glpat");
  });

  it("带位置的报错只保留位置数字（便于用户定位）", async () => {
    // 属性值之后缺逗号：V8 给的是 `... at position N` 形式
    await fs.writeFile(settingsFilePath(), '{"a": 1 "b": 2}', "utf-8");
    const result = await readSettingsFile();
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toMatch(/^json_parse: at position \d+$/);
  });
});

describe("F6-03 GET /api/settings/full：损坏 → 500 settings_unreadable + reason", () => {
  it("JSON 损坏：error 仍是 settings_unreadable（client 据此分流），带 reason，响应里没有文件内容", async () => {
    await fs.writeFile(settingsFilePath(), LEAKY_RAW, "utf-8");
    const res = await getFull();
    expect(res.status).toBe(500);
    const text = await res.text();
    const body = JSON.parse(text) as { error?: string; reason?: string };
    expect(body.error).toBe("settings_unreadable");
    expect(body.reason).toEqual(expect.stringMatching(/^json_parse/));
    expect(text).not.toContain("sk-SECRET");
    expect(text).not.toContain("glpat");
  });

  it("根节点是数组 → reason = settings_json_invalid", async () => {
    await fs.writeFile(settingsFilePath(), "[]", "utf-8");
    const res = await getFull();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "settings_unreadable",
      reason: "settings_json_invalid",
    });
  });

  it("文件缺失 / 正常 → 不受影响（missing → exists:false；ok → 原样）", async () => {
    const missing = await getFull();
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ exists: false, settings: null });
    await fs.writeFile(settingsFilePath(), JSON.stringify({ apiKey: "k" }), "utf-8");
    const ok = await getFull();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ exists: true, settings: { apiKey: "k" } });
  });
});

describe("F6-03 PUT /api/settings：损坏 → 500 settings_unreadable + reason，原文件不动", () => {
  it("响应带 reason、不含内容；磁盘上的损坏文件逐字节保留", async () => {
    await fs.writeFile(settingsFilePath(), LEAKY_RAW, "utf-8");
    const res = await putOnce();
    expect(res.status).toBe(500);
    const text = await res.text();
    const body = JSON.parse(text) as { error?: string; reason?: string };
    expect(body.error).toBe("settings_unreadable");
    expect(body.reason).toEqual(expect.stringMatching(/^json_parse/));
    expect(text).not.toContain("sk-SECRET");
    expect(await fs.readFile(settingsFilePath(), "utf-8")).toBe(LEAKY_RAW);
  });
});
