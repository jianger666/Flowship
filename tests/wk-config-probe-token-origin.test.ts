/**
 * wk-config/probe：已落盘的 Hub Token 只发给「配置里那个 Hub」（评审 P2：
 * 原来没传草稿 Token 时一律读落盘值、连同请求体里任意 baseUrl 一起发出去）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  hubBaseUrl: "https://hub.corp/harness",
  savedToken: "saved-secret-token",
  readConfigFails: false,
  probeCalls: [] as Array<{ baseUrl: string; token: string | undefined }>,
}));

vi.mock("@/lib/server/wk-config", () => ({
  readWkConfig: vi.fn(async () => {
    if (h.readConfigFails) throw new Error("EBUSY");
    return { docRepoPath: "", hubBaseUrl: h.hubBaseUrl, hubToken: "", requireBaseline: true, requireSync: true };
  }),
  readWkHubToken: vi.fn(async () => h.savedToken),
}));
vi.mock("@/lib/server/wk-hub-probe", () => ({
  probeWkHub: vi.fn(async (baseUrl: string, _fetch: unknown, token?: string) => {
    h.probeCalls.push({ baseUrl, token });
    return { ok: true };
  }),
}));

import { POST } from "@/app/api/system/wk-config/probe/route";
import { isSameHubOrigin } from "@/lib/wk-hub";

const post = (body: unknown) =>
  POST(
    new Request("http://127.0.0.1/api/system/wk-config/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  h.probeCalls.length = 0;
  h.readConfigFails = false;
});

describe("isSameHubOrigin", () => {
  it("同源（忽略路径前缀与末尾斜杠）→ true；协议 / 主机 / 端口任一不同 → false；空 / 非法 → false", () => {
    expect(isSameHubOrigin("https://hub.corp/harness/", "https://hub.corp")).toBe(true);
    expect(isSameHubOrigin("https://hub.corp", "http://hub.corp")).toBe(false);
    expect(isSameHubOrigin("https://hub.corp", "https://hub.corp.evil.example")).toBe(false);
    expect(isSameHubOrigin("https://hub.corp:8443", "https://hub.corp")).toBe(false);
    expect(isSameHubOrigin("", "https://hub.corp")).toBe(false);
    expect(isSameHubOrigin("https://hub.corp", "")).toBe(false);
    expect(isSameHubOrigin("not a url", "also not")).toBe(false);
  });
});

describe("POST /api/system/wk-config/probe 的 Token 去向", () => {
  it("探配置里的那个 Hub（同源）：没传草稿 → 用落盘 Token", async () => {
    await post({ baseUrl: "https://hub.corp/harness" });
    expect(h.probeCalls).toEqual([{ baseUrl: "https://hub.corp/harness", token: "saved-secret-token" }]);
  });

  it("探别的地址：不带落盘 Token（空串），请求仍照常发出", async () => {
    const res = await post({ baseUrl: "https://attacker.example" });
    expect(res.status).toBe(200);
    expect(h.probeCalls).toEqual([{ baseUrl: "https://attacker.example", token: "" }]);
  });

  it("调用方自己带了草稿 Token：照用（它是调用方自己的、不受限）", async () => {
    await post({ baseUrl: "https://attacker.example", token: "  draft-token  " });
    expect(h.probeCalls).toEqual([{ baseUrl: "https://attacker.example", token: "draft-token" }]);
  });

  it("配置读不出来：当没有已配置 Hub、不带 Token（不抛 500）", async () => {
    h.readConfigFails = true;
    const res = await post({ baseUrl: "https://hub.corp/harness" });
    expect(res.status).toBe(200);
    expect(h.probeCalls).toEqual([{ baseUrl: "https://hub.corp/harness", token: "" }]);
  });
});
