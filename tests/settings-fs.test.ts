/**
 * settings-fs（CR-01 + P1-04）：settings 脱敏 + 预览命令 + 读三态分流。
 *
 * 回归点：
 * - /api/settings 默认口径不再泄漏 apiKey / gitToken 明文
 * - /api/preview 的命令只来自 config.json 的 per-repo previewCommand
 * - readSettingsFile：ok / missing / error；坏 JSON 备份一次 config.json.corrupt-<ts>
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
  settingsFilePath,
} from "@/lib/server/settings-fs";

const VALID_CONFIG = {
  apiKey: "sk-super-secret-key-1234567890",
  gitToken: "glpat-secret-token",
  repos: [
    { name: "web", path: "/repo/web", previewCommand: "npm run dev" },
    { name: "api", path: "/repo/api" },
  ],
  mcpServers: { feishu: { url: "https://x" } },
};

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  await fs.writeFile(
    path.join(TMP_ROOT, "config.json"),
    JSON.stringify(VALID_CONFIG),
    "utf-8",
  );
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("maskSettingsSecrets", () => {
  it("apiKey / gitToken 掩码、不含明文；其它字段原样", async () => {
    const result = await readSettingsFile();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const masked = maskSettingsSecrets(result.settings);
    expect(masked.apiKey).not.toContain("super-secret");
    expect(String(masked.apiKey)).toContain("脱敏");
    expect(masked.gitToken).not.toContain("secret-token");
    // 非敏感字段不动（client 回填 mcpServers 依赖）
    expect(masked.mcpServers).toEqual({ feishu: { url: "https://x" } });
    expect(masked.repos).toEqual(result.settings.repos);
  });

  it("未配置的密钥掩码为空串（不显示假掩码）", () => {
    expect(maskSettingsSecrets({ apiKey: "", gitToken: undefined }).apiKey).toBe("");
    expect(maskSettingsSecrets({}).gitToken).toBe("");
  });
});

describe("preserveSecretsOnPut（掩码兜底、清空放行）", () => {
  const disk = { apiKey: "sk-real-key", gitToken: "glpat-real", repos: [1] };

  it("PUT 带脱敏掩码（client 误把展示值回写）→ 保留盘上真值", () => {
    const { settings, preserved } = preserveSecretsOnPut(
      { apiKey: "sk-r…（已脱敏、长度 11）", gitToken: "glpat…（已脱敏、长度 10）", repos: [1, 2] },
      disk,
    );
    expect(settings.apiKey).toBe("sk-real-key");
    expect(settings.gitToken).toBe("glpat-real");
    expect(settings.repos).toEqual([1, 2]); // 非密钥字段照常用进来的
    expect(preserved).toEqual(["apiKey", "gitToken"]);
  });

  it("PUT 带空密钥 → 放行（用户主动清 key 是合法操作、不拦）", () => {
    const { settings, preserved } = preserveSecretsOnPut(
      { apiKey: "", gitToken: "" },
      disk,
    );
    expect(settings.apiKey).toBe("");
    expect(settings.gitToken).toBe("");
    expect(preserved).toEqual([]);
  });

  it("PUT 带新真值 → 正常覆盖", () => {
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
      preserveSecretsOnPut(
        { apiKey: "x…（已脱敏、长度 1）" },
        { apiKey: "" },
      ).preserved,
    ).toEqual([]);
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

describe("readSettingsFile 三态（P1-04）", () => {
  it("文件存在且合法 → status:ok", async () => {
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify(VALID_CONFIG),
      "utf-8",
    );
    const result = await readSettingsFile();
    expect(result).toEqual({
      status: "ok",
      settings: VALID_CONFIG,
    });
  });

  it("文件不存在（ENOENT）→ status:missing", async () => {
    await fs.rm(settingsFilePath(), { force: true });
    const result = await readSettingsFile();
    expect(result).toEqual({ status: "missing" });
    // 还原合法文件、避免影响后续用例
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify(VALID_CONFIG),
      "utf-8",
    );
  });

  it("JSON 损坏 → status:error + 备份 config.json.corrupt-<ts>（只备一次）", async () => {
    const corruptRaw = "{ not-valid-json ;;;";
    await fs.writeFile(settingsFilePath(), corruptRaw, "utf-8");
    // 清掉可能残留的旧 backup（本 describe 内首次）
    const dir = path.dirname(settingsFilePath());
    for (const name of await fs.readdir(dir)) {
      if (name.startsWith("config.json.corrupt-")) {
        await fs.rm(path.join(dir, name), { force: true });
      }
    }

    const first = await readSettingsFile();
    expect(first.status).toBe("error");
    if (first.status !== "error") return;
    expect(first.reason).toMatch(/json_parse/);

    const backups = (await fs.readdir(dir)).filter((n) =>
      n.startsWith("config.json.corrupt-"),
    );
    expect(backups).toHaveLength(1);
    const backupContent = await fs.readFile(
      path.join(dir, backups[0]),
      "utf-8",
    );
    expect(backupContent).toBe(corruptRaw);

    // 再读一次：仍 error、不追加第二份 backup
    const second = await readSettingsFile();
    expect(second.status).toBe("error");
    const backupsAfter = (await fs.readdir(dir)).filter((n) =>
      n.startsWith("config.json.corrupt-"),
    );
    expect(backupsAfter).toHaveLength(1);

    // 还原
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify(VALID_CONFIG),
      "utf-8",
    );
  });

  it("根节点非对象 → status:error 并备份", async () => {
    const dir = path.dirname(settingsFilePath());
    for (const name of await fs.readdir(dir)) {
      if (name.startsWith("config.json.corrupt-")) {
        await fs.rm(path.join(dir, name), { force: true });
      }
    }
    await fs.writeFile(settingsFilePath(), JSON.stringify([1, 2, 3]), "utf-8");
    const result = await readSettingsFile();
    expect(result).toEqual({
      status: "error",
      reason: "settings_json_invalid",
    });
    const backups = (await fs.readdir(dir)).filter((n) =>
      n.startsWith("config.json.corrupt-"),
    );
    expect(backups.length).toBeGreaterThanOrEqual(1);
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify(VALID_CONFIG),
      "utf-8",
    );
  });
});
