/**
 * startMcpOAuth：同名 server 改绑到新 URL 后，旧 URL 下的 client / discovery 必须作废
 *
 * 旧行为：`patchRecord` 读旧记录 merge 新字段，只覆盖 serverName / serverUrl——旧 URL 下 DCR 注册的 client
 * （client_id 属于旧授权服务器）与 discovery 缓存原样留在记录里，auth() 拿旧 client_id 去新授权服务器发起授权、
 * 或沿用旧 discovery 把授权流打回旧授权服务器。
 * 现在：URL（归一口径：去空白 + 尾斜杠）变了 → 整条旧记录作废（client / discovery / tokens / verifier / state 全清）；
 * URL 没变（重新授权）→ 保留 client + discovery（DCR 不必每次重来）、仍清旧 token / verifier。
 *
 * 网络层（SDK 的 auth()）用 mock 替掉：只观察它被调用那一刻 provider 看到的落盘状态。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-mcp-oauth-urlchange-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;
process.env.FLOWSHIP_BASE_URL = "http://localhost:18876";

type Seen = {
  client: unknown;
  discovery: unknown;
  tokens: unknown;
};
const seen: Seen[] = [];

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: vi.fn(
    async (
      provider: {
        clientInformation: () => Promise<unknown>;
        discoveryState: () => Promise<unknown>;
        tokens: () => Promise<unknown>;
        redirectToAuthorization: (url: URL) => Promise<void>;
      },
    ) => {
      seen.push({
        client: await provider.clientInformation(),
        discovery: await provider.discoveryState(),
        tokens: await provider.tokens(),
      });
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));
      return "REDIRECT";
    },
  ),
}));

const { startMcpOAuth } = await import("@/lib/server/mcp-oauth");

const OAUTH_DIR = path.join(TMP_ROOT, "mcp-oauth");
const recordFile = (serverName: string): string =>
  path.join(
    OAUTH_DIR,
    `${createHash("sha256").update(serverName, "utf8").digest("hex")}.json`,
  );

const seedRecord = async (serverName: string, serverUrl: string): Promise<void> => {
  await fs.mkdir(OAUTH_DIR, { recursive: true });
  await fs.writeFile(
    recordFile(serverName),
    JSON.stringify({
      serverName,
      serverUrl,
      client: { client_id: "old-client-id", redirect_uris: [] },
      discovery: { authorizationServerUrl: "https://old-auth.example.com" },
      tokens: { access_token: "old-access-0123456789", token_type: "Bearer" },
      codeVerifier: "old-verifier",
      state: "old-state",
    }),
    "utf-8",
  );
};

const readRec = async (serverName: string) =>
  JSON.parse(await fs.readFile(recordFile(serverName), "utf-8")) as Record<string, unknown>;

beforeEach(async () => {
  seen.length = 0;
  await fs.rm(OAUTH_DIR, { recursive: true, force: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("startMcpOAuth 换 URL", () => {
  it("URL 变了：auth() 看到的是干净记录（旧 client / discovery / token 全作废），落盘 serverUrl 为新值", async () => {
    await seedRecord("srv", "https://old.example.com/mcp");

    const url = await startMcpOAuth("srv", "https://new.example.com/mcp");

    expect(url).toContain("https://auth.example.com/authorize");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.client).toBeUndefined();
    expect(seen[0]!.discovery).toBeUndefined();
    expect(seen[0]!.tokens).toBeUndefined();
    const rec = await readRec("srv");
    expect(rec.serverUrl).toBe("https://new.example.com/mcp");
    expect(rec.client).toBeUndefined();
    expect(rec.discovery).toBeUndefined();
    expect(rec.tokens).toBeUndefined();
  });

  it("URL 没变（只差尾斜杠 / 空白，重新授权）：保留 client + discovery，仍清旧 token", async () => {
    await seedRecord("srv-same", "https://same.example.com/mcp");

    await startMcpOAuth("srv-same", " https://same.example.com/mcp/ ");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.client).toMatchObject({ client_id: "old-client-id" });
    expect(seen[0]!.discovery).toMatchObject({
      authorizationServerUrl: "https://old-auth.example.com",
    });
    expect(seen[0]!.tokens).toBeUndefined();
  });

  it("首次授权（没有旧记录）：照常发起，不抛", async () => {
    const url = await startMcpOAuth("srv-first", "https://first.example.com/mcp");
    expect(url).toContain("https://auth.example.com/authorize");
    expect(seen[0]!.client).toBeUndefined();
    expect((await readRec("srv-first")).serverUrl).toBe("https://first.example.com/mcp");
  });
});
