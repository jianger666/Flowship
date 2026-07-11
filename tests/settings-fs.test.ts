/**
 * settings-fs（CR-01）：settings 脱敏 + 预览命令服务端权威读取。
 *
 * 回归点：
 * - /api/settings 默认口径不再泄漏 apiKey / gitToken 明文
 * - /api/preview 的命令只来自 config.json 的 per-repo previewCommand、
 *   没配的仓拿不到命令（客户端注入面已在类型层删除）
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-settings-fs-${Date.now()}`);
process.env.FE_AI_FLOW_DATA_DIR = TMP_ROOT;

import {
  getRepoPreviewCommand,
  maskSettingsSecrets,
  preserveSecretsOnPut,
  readSettingsFile,
} from "@/lib/server/settings-fs";

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  await fs.writeFile(
    path.join(TMP_ROOT, "config.json"),
    JSON.stringify({
      apiKey: "sk-super-secret-key-1234567890",
      gitToken: "glpat-secret-token",
      repos: [
        { name: "web", path: "/repo/web", previewCommand: "npm run dev" },
        { name: "api", path: "/repo/api" },
      ],
      mcpServers: { feishu: { url: "https://x" } },
    }),
    "utf-8",
  );
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("maskSettingsSecrets", () => {
  it("apiKey / gitToken 掩码、不含明文；其它字段原样", async () => {
    const settings = await readSettingsFile();
    expect(settings).not.toBeNull();
    const masked = maskSettingsSecrets(settings!);
    expect(masked.apiKey).not.toContain("super-secret");
    expect(String(masked.apiKey)).toContain("脱敏");
    expect(masked.gitToken).not.toContain("secret-token");
    // 非敏感字段不动（client 回填 mcpServers 依赖）
    expect(masked.mcpServers).toEqual({ feishu: { url: "https://x" } });
    expect(masked.repos).toEqual(settings!.repos);
  });

  it("未配置的密钥掩码为空串（不显示假掩码）", () => {
    expect(maskSettingsSecrets({ apiKey: "", gitToken: undefined }).apiKey).toBe("");
    expect(maskSettingsSecrets({}).gitToken).toBe("");
  });
});

describe("preserveSecretsOnPut（密钥只升不降、v1.0.x 真实事故回归）", () => {
  const disk = { apiKey: "sk-real-key", gitToken: "glpat-real", repos: [1] };

  it("PUT 带空密钥 + 盘上有真值 → 保留盘上值（stale cache 整对象覆盖不丢密钥）", () => {
    const { settings, preserved } = preserveSecretsOnPut(
      { apiKey: "", gitToken: "glpat-real", repos: [1, 2] },
      disk,
    );
    expect(settings.apiKey).toBe("sk-real-key");
    expect(settings.repos).toEqual([1, 2]); // 非密钥字段照常用进来的
    expect(preserved).toEqual(["apiKey"]);
  });

  it("PUT 带脱敏掩码（client 误把展示值回写）→ 保留盘上值", () => {
    const { settings, preserved } = preserveSecretsOnPut(
      { apiKey: "sk-r…（已脱敏、长度 11）", gitToken: "" },
      disk,
    );
    expect(settings.apiKey).toBe("sk-real-key");
    expect(settings.gitToken).toBe("glpat-real");
    expect(preserved).toEqual(["apiKey", "gitToken"]);
  });

  it("PUT 带新真值 → 正常覆盖（改密钥不受守卫影响）", () => {
    const { settings, preserved } = preserveSecretsOnPut(
      { apiKey: "sk-new-key", gitToken: "glpat-new" },
      disk,
    );
    expect(settings.apiKey).toBe("sk-new-key");
    expect(settings.gitToken).toBe("glpat-new");
    expect(preserved).toEqual([]);
  });

  it("盘上本来就空 / 首次落盘（current=null）→ 不干预", () => {
    expect(
      preserveSecretsOnPut({ apiKey: "" }, { apiKey: "" }).settings.apiKey,
    ).toBe("");
    expect(preserveSecretsOnPut({ apiKey: "" }, null).preserved).toEqual([]);
  });
});

describe("getRepoPreviewCommand", () => {
  it("配了 previewCommand 的仓返回命令", async () => {
    expect(await getRepoPreviewCommand("/repo/web")).toBe("npm run dev");
  });

  it("没配命令的仓 / 不在配置里的仓 → null（preview 拒绝启动、防命令注入）", async () => {
    expect(await getRepoPreviewCommand("/repo/api")).toBeNull();
    expect(await getRepoPreviewCommand("/tmp/evil")).toBeNull();
  });
});
