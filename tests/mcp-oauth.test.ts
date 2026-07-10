/**
 * mcp-oauth 凭证文件命名 / 身份校验（CR-04）
 *
 * 回归点（都在旧实现上失败）：
 * - 旧「替换非法字符」命名不是一一映射：`foo/bar` 和 `foo?bar` 撞同一文件、
 *   B 会拿到 A 的 bearer token 发去 B 的（可能是攻击者的）URL
 * - 同名 server 改绑新 URL 后、旧 token 不能注入新地址
 * - 旧命名文件做一次性迁移：serverName 匹配才迁；碰撞受害方不猜归属、要求重新授权
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-mcp-oauth-${Date.now()}`);
process.env.FE_AI_FLOW_DATA_DIR = TMP_ROOT;

import { enrichMcpServersWithOAuth } from "@/lib/server/mcp-oauth";

const OAUTH_DIR = path.join(TMP_ROOT, "mcp-oauth");

// 造一份「已授权、永不过期」的落盘记录（无 expires_in → 视为 fresh、不走 refresh 网络路径）
const makeRecord = (serverName: string, serverUrl: string, token: string) => ({
  serverName,
  serverUrl,
  tokens: { access_token: token, token_type: "Bearer" },
  obtainedAt: Date.now(),
});

const hashedFile = (serverName: string): string =>
  path.join(
    OAUTH_DIR,
    `${createHash("sha256").update(serverName, "utf8").digest("hex")}.json`,
  );

const legacyFile = (serverName: string): string =>
  path.join(OAUTH_DIR, `${serverName.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);

const writeJson = async (file: string, data: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
};

const authHeaderOf = (
  cfg: Record<string, unknown> | undefined,
): string | undefined =>
  (cfg as { headers?: Record<string, string> } | undefined)?.headers?.Authorization;

beforeAll(async () => {
  await fs.mkdir(OAUTH_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("enrichMcpServersWithOAuth（CR-04）", () => {
  it("正常注入：哈希命名记录 + URL 一致 → Authorization 带 token", async () => {
    await writeJson(
      hashedFile("srv-ok"),
      makeRecord("srv-ok", "https://mcp.example.com/v1", "tok-ok"),
    );
    const out = await enrichMcpServersWithOAuth({
      "srv-ok": { url: "https://mcp.example.com/v1" },
    });
    expect(authHeaderOf(out["srv-ok"])).toBe("Bearer tok-ok");
  });

  it("碰撞名不共享记录：`foo/bar` 的 token 绝不注入 `foo?bar`", async () => {
    // 旧实现两个名字都映射 foo_bar.json——这里按旧命名落 A 的记录、
    // 旧实现会把它注给 B（本断言在旧实现上失败）
    await writeJson(
      legacyFile("foo/bar"),
      makeRecord("foo/bar", "https://a.example.com", "tok-A"),
    );
    const out = await enrichMcpServersWithOAuth({
      "foo?bar": { url: "https://b.example.com" },
    });
    expect(authHeaderOf(out["foo?bar"])).toBeUndefined();
  });

  it("旧命名文件一次性迁移：serverName 匹配 → 迁到哈希路径、token 照常注入、旧文件删除", async () => {
    await writeJson(
      legacyFile("legacy-srv"),
      makeRecord("legacy-srv", "https://legacy.example.com", "tok-legacy"),
    );
    const out = await enrichMcpServersWithOAuth({
      "legacy-srv": { url: "https://legacy.example.com" },
    });
    expect(authHeaderOf(out["legacy-srv"])).toBe("Bearer tok-legacy");
    // 已迁到哈希路径、旧文件清掉
    await expect(fs.access(hashedFile("legacy-srv"))).resolves.toBeUndefined();
    await expect(fs.access(legacyFile("legacy-srv"))).rejects.toThrow();
  });

  it("URL 改绑：记录 URL ≠ 当前配置 URL → 旧 token 不注入（要求重新授权）", async () => {
    await writeJson(
      hashedFile("srv-rebind"),
      makeRecord("srv-rebind", "https://old.example.com", "tok-old"),
    );
    const out = await enrichMcpServersWithOAuth({
      "srv-rebind": { url: "https://new-attacker.example.com" },
    });
    expect(authHeaderOf(out["srv-rebind"])).toBeUndefined();
  });

  it("记录身份校验：文件内 serverName 与请求名不符 → 拒用", async () => {
    // 模拟手动拷贝 / 错位的凭证文件：哈希路径是 srv-x、内容却属于 srv-y
    await writeJson(
      hashedFile("srv-x"),
      makeRecord("srv-y", "https://x.example.com", "tok-y"),
    );
    const out = await enrichMcpServersWithOAuth({
      "srv-x": { url: "https://x.example.com" },
    });
    expect(authHeaderOf(out["srv-x"])).toBeUndefined();
  });
});
