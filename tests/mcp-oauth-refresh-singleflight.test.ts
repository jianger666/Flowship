/**
 * mcp-oauth：同一 server 并发续期合并（single-flight）
 *
 * 为什么钉：access token 过期后，每个并发调用各自走 auth() 就会各打一次 refresh 请求。
 * 在 refresh-token 轮换的服务端上，后到的那次 invalid_grant、本次拿不到 token（MCP 被当成未授权剔除），
 * 严重时刚落盘的新 token 被覆盖、用户得重新授权。两个 run 同时发送本来就会撞上，
 * 「聚焦输入框就预热探活」会让并发更常见——所以合并是预热上线的前提。
 *
 * 钉死的语义：
 * - 同 server 同 URL 并发 → 只 refresh 一次、所有调用方拿到同一个新 token
 * - 不同 server / 同名不同 URL → 互不合并
 * - 合并只管「正在进行的」：完成后不缓存，再次过期可再次刷新
 * - 失败也只失败一次、不永久卡住：下一次调用能重试
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-mcp-oauth-sf-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

// mock 掉 SDK 的 auth()：模拟「慢刷新」，并把新 token 经 provider.saveTokens 写盘（和真实路径一致）
const authMock = vi.fn();
vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, auth: (...args: unknown[]) => authMock(...args) };
});

import { enrichMcpServersWithOAuth } from "@/lib/server/mcp-oauth";

const OAUTH_DIR = path.join(TMP_ROOT, "mcp-oauth");
const fileOf = (serverName: string): string =>
  path.join(OAUTH_DIR, `${createHash("sha256").update(serverName, "utf8").digest("hex")}.json`);

/** 已授权但 access token 早已过期、带 refresh_token 的记录 → 必走 refresh 路径 */
const writeExpired = async (serverName: string, serverUrl: string): Promise<void> => {
  await fs.mkdir(OAUTH_DIR, { recursive: true });
  await fs.writeFile(
    fileOf(serverName),
    JSON.stringify({
      serverName,
      serverUrl,
      tokens: { access_token: "old", token_type: "Bearer", expires_in: 60, refresh_token: "r1" },
      obtainedAt: Date.now() - 3_600_000,
    }),
    "utf-8",
  );
};

let refreshSeq = 0;
/** 默认的 auth() 行为：延迟 40ms（制造并发窗口）后落新 token、返回 AUTHORIZED */
const slowRefresh = async (provider: { saveTokens: (t: unknown) => Promise<void> }): Promise<string> => {
  await new Promise((r) => setTimeout(r, 40));
  refreshSeq += 1;
  await provider.saveTokens({
    access_token: `new-${refreshSeq}`,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: `r${refreshSeq + 1}`,
  });
  return "AUTHORIZED";
};

const authHeader = (cfg: unknown): string | undefined =>
  (cfg as { headers?: Record<string, string> } | undefined)?.headers?.Authorization;

beforeAll(async () => {
  await fs.mkdir(OAUTH_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});
beforeEach(() => {
  authMock.mockReset();
  refreshSeq = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("并发续期合并", () => {
  it("同 server 同 URL 并发 5 次 → auth() 只调 1 次，所有调用方拿到同一个新 token", async () => {
    await writeExpired("srv-a", "https://a.example.com/mcp");
    authMock.mockImplementation((provider) => slowRefresh(provider));

    const outs = await Promise.all(
      Array.from({ length: 5 }, () =>
        enrichMcpServersWithOAuth({ "srv-a": { url: "https://a.example.com/mcp" } }),
      ),
    );

    expect(authMock).toHaveBeenCalledTimes(1);
    for (const out of outs) expect(authHeader(out["srv-a"])).toBe("Bearer new-1");
  });

  it("不同 server 并发 → 各刷新一次、互不合并", async () => {
    await writeExpired("srv-b1", "https://b1.example.com");
    await writeExpired("srv-b2", "https://b2.example.com");
    authMock.mockImplementation((provider) => slowRefresh(provider));

    const [o1, o2] = await Promise.all([
      enrichMcpServersWithOAuth({ "srv-b1": { url: "https://b1.example.com" } }),
      enrichMcpServersWithOAuth({ "srv-b2": { url: "https://b2.example.com" } }),
    ]);

    expect(authMock).toHaveBeenCalledTimes(2);
    expect(authHeader(o1["srv-b1"])).toMatch(/^Bearer new-/);
    expect(authHeader(o2["srv-b2"])).toMatch(/^Bearer new-/);
  });

  it("同名但 URL 不同（改绑）→ 不合并：URL 不符的那个拿不到 token（强校验不被合并绕过）", async () => {
    await writeExpired("srv-c", "https://c.example.com");
    authMock.mockImplementation((provider) => slowRefresh(provider));

    const [okOut, rebindOut] = await Promise.all([
      enrichMcpServersWithOAuth({ "srv-c": { url: "https://c.example.com" } }),
      enrichMcpServersWithOAuth({ "srv-c": { url: "https://attacker.example.com" } }),
    ]);

    expect(authHeader(okOut["srv-c"])).toMatch(/^Bearer new-/);
    expect(authHeader(rebindOut["srv-c"])).toBeUndefined();
  });

  it("尾斜杠差异视为同一 URL（与 URL 强校验同一归一口径）→ 仍合并", async () => {
    await writeExpired("srv-d", "https://d.example.com/mcp");
    authMock.mockImplementation((provider) => slowRefresh(provider));

    await Promise.all([
      enrichMcpServersWithOAuth({ "srv-d": { url: "https://d.example.com/mcp" } }),
      enrichMcpServersWithOAuth({ "srv-d": { url: "https://d.example.com/mcp/" } }),
    ]);

    expect(authMock).toHaveBeenCalledTimes(1);
  });
});

describe("合并只管「正在进行的」", () => {
  it("完成后不缓存：再次过期可以再次刷新", async () => {
    await writeExpired("srv-e", "https://e.example.com");
    authMock.mockImplementation((provider) => slowRefresh(provider));

    const first = await enrichMcpServersWithOAuth({ "srv-e": { url: "https://e.example.com" } });
    expect(authHeader(first["srv-e"])).toBe("Bearer new-1");
    expect(authMock).toHaveBeenCalledTimes(1);

    // 模拟又过了很久：新 token 也过期了
    await writeExpired("srv-e", "https://e.example.com");
    const second = await enrichMcpServersWithOAuth({ "srv-e": { url: "https://e.example.com" } });
    expect(authMock).toHaveBeenCalledTimes(2);
    expect(authHeader(second["srv-e"])).toBe("Bearer new-2");
  });

  it("token 没过期：不触发 auth()，并发也都直接拿到", async () => {
    await fs.mkdir(OAUTH_DIR, { recursive: true });
    await fs.writeFile(
      fileOf("srv-f"),
      JSON.stringify({
        serverName: "srv-f",
        serverUrl: "https://f.example.com",
        tokens: { access_token: "still-good", token_type: "Bearer", expires_in: 3600, refresh_token: "r" },
        obtainedAt: Date.now(),
      }),
      "utf-8",
    );
    const outs = await Promise.all([
      enrichMcpServersWithOAuth({ "srv-f": { url: "https://f.example.com" } }),
      enrichMcpServersWithOAuth({ "srv-f": { url: "https://f.example.com" } }),
    ]);
    expect(authMock).not.toHaveBeenCalled();
    for (const out of outs) expect(authHeader(out["srv-f"])).toBe("Bearer still-good");
  });
});

describe("失败语义", () => {
  it("刷新抛错：所有等待者都拿不到 token（不注入），且下一次调用能重试成功（不永久卡住）", async () => {
    await writeExpired("srv-g", "https://g.example.com");
    authMock.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 30));
      throw new Error("invalid_grant");
    });

    const outs = await Promise.all([
      enrichMcpServersWithOAuth({ "srv-g": { url: "https://g.example.com" } }),
      enrichMcpServersWithOAuth({ "srv-g": { url: "https://g.example.com" } }),
      enrichMcpServersWithOAuth({ "srv-g": { url: "https://g.example.com" } }),
    ]);
    expect(authMock).toHaveBeenCalledTimes(1);
    for (const out of outs) expect(authHeader(out["srv-g"])).toBeUndefined();

    // 失败后合并登记已清：下一次调用重新发起、这次成功
    authMock.mockImplementation((provider) => slowRefresh(provider));
    const retry = await enrichMcpServersWithOAuth({ "srv-g": { url: "https://g.example.com" } });
    expect(authMock).toHaveBeenCalledTimes(2);
    expect(authHeader(retry["srv-g"])).toMatch(/^Bearer new-/);
  });

  it("刷新返回非 AUTHORIZED（需要重新授权）：不注入 token，合并登记同样被清", async () => {
    await writeExpired("srv-h", "https://h.example.com");
    authMock.mockResolvedValueOnce("REDIRECT");
    const out = await enrichMcpServersWithOAuth({ "srv-h": { url: "https://h.example.com" } });
    expect(authHeader(out["srv-h"])).toBeUndefined();

    authMock.mockImplementation((provider) => slowRefresh(provider));
    const retry = await enrichMcpServersWithOAuth({ "srv-h": { url: "https://h.example.com" } });
    expect(authHeader(retry["srv-h"])).toMatch(/^Bearer new-/);
  });
});
