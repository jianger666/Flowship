/**
 * 诊断包日志脱敏（评审 P2：main.log / installer.log 尾部原样带出，用户会发给别人排查）。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(path.join(os.tmpdir(), "flowship-diag-redact-"));
const dataDir = path.join(tmp, "userData", "data");
const logsDir = path.join(tmp, "userData", "logs");
const home = path.join(tmp, "home");

const GIT_TOKEN = "glpat-AbCdEf0123456789ZZ";
const API_KEY = "key_live_SuperSecretValue_123456";

beforeAll(() => {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(path.join(home, "Downloads"), { recursive: true });
  writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({ apiKey: API_KEY, gitToken: GIT_TOKEN, repos: [] }),
  );
  vi.stubEnv("FLOWSHIP_DATA_DIR", dataDir);
  vi.spyOn(os, "homedir").mockReturnValue(home);
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("redactDiagnosticText", () => {
  it("已知凭据精确值（config.json 里的 gitToken / apiKey）被替换", async () => {
    const { redactDiagnosticText } = await import("@/lib/server/diagnostics");
    const out = redactDiagnosticText(`curl -H "PRIVATE-TOKEN: ${GIT_TOKEN}" ... key=${API_KEY} done`);
    expect(out).not.toContain(GIT_TOKEN);
    expect(out).not.toContain(API_KEY);
  });

  it("通用形态兜底：GitLab 令牌 / sk- 密钥 / Bearer / Authorization / URL 口令 / key=value", async () => {
    const { redactDiagnosticText } = await import("@/lib/server/diagnostics");
    const cases: Array<[string, string]> = [
      ["clone failed glpat-OtherToken0123456789xx", "glpat-OtherToken0123456789xx"],
      ["using sk-abcdefghijklmnopqrstuvwxyz0123", "sk-abcdefghijklmnopqrstuvwxyz0123"],
      ["> Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig", "eyJhbGciOiJIUzI1NiJ9"],
      ["header bearer abcdefghijklmnop1234567890", "abcdefghijklmnop1234567890"],
      ["git clone https://deploy:hunter2hunter2@gitlab.example.com/a/b.git", "hunter2hunter2"],
      ['{"password":"correct-horse-battery"}', "correct-horse-battery"],
      ["access_token=abcDEF123456789xyz", "abcDEF123456789xyz"],
    ];
    for (const [input, secret] of cases) {
      const out = redactDiagnosticText(input);
      expect(out, input).not.toContain(secret);
      expect(out, input).toContain("[REDACTED]");
    }
  });

  it("不把普通日志改花：短状态词 / 无凭据文本 / 空串原样", async () => {
    const { redactDiagnosticText } = await import("@/lib/server/diagnostics");
    for (const line of [
      "[main] server 启动完成 port=8876 pid=4242",
      "token: expired",
      "password=****",
      "GET https://project.feishu.cn/open_api/x 200 in 120ms",
      "",
    ]) {
      expect(redactDiagnosticText(line)).toBe(line);
    }
  });
});

describe("exportDiagnostics 的整份输出", () => {
  it("main.log / installer.log 尾部里的凭据不进诊断包", async () => {
    writeFileSync(
      path.join(logsDir, "main.log"),
      [
        "[main] boot ok",
        `[server] git push https://oauth2:${GIT_TOKEN}@gitlab.example.com/x.git`,
        "[server] request header Authorization: Bearer abcdefghijklmnop1234567890",
        `[server] apiKey from env ${API_KEY}`,
      ].join("\n"),
    );
    writeFileSync(path.join(logsDir, "installer.log"), `init ok\nsecret=SuperLongInstallerSecret99\n`);
    const { exportDiagnostics } = await import("@/lib/server/diagnostics");
    const target = await exportDiagnostics("0.0.0-test");
    const text = readFileSync(target, "utf8");
    expect(text).toContain("[main] boot ok");
    for (const leaked of [GIT_TOKEN, API_KEY, "abcdefghijklmnop1234567890", "SuperLongInstallerSecret99"]) {
      expect(text, leaked).not.toContain(leaked);
    }
  });
});
