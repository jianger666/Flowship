/**
 * Q10-05：收件箱合并路由 —— 已合并幂等成功、sha 守卫 409 不受影响、失败文案原样 502。
 *
 * 真路由 handler + 真 route-helpers / mr-inbox 解析；mock 的只有外部：GitLab、settings、scanner 缓存、可信 host。
 * 文案怎么变（405 补查 / 去重前缀）由 gitlab-client-errors.test.ts 管，这里只管「路由拿到 mergeMR 的结果后怎么回」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const MR_URL = "https://gitlab.example.com/g/r/-/merge_requests/7";

vi.mock("@/lib/server/gitlab-client", () => ({ mergeMR: vi.fn() }));
vi.mock("@/lib/server/mr-inbox-scanner", () => ({
  collectGitlabHostAllowlist: vi.fn(async () => new Set(["gitlab.example.com"])),
  markBugMrMergedInCache: vi.fn(),
  removeMrFromInboxCache: vi.fn(),
}));
vi.mock("@/lib/server/settings-fs", () => ({
  readSettingsFile: vi.fn(async () => ({
    status: "ok",
    settings: { gitToken: "tok", repos: [{ path: "/x" }] },
  })),
}));
vi.mock("@/lib/server/trusted-git-host", () => ({
  assertTrustedGitHost: vi.fn(),
}));

import { POST } from "@/app/api/mr-inbox/merge/route";
import { parseGitlabMrUrl } from "@/lib/mr-inbox";
import { mergeMR } from "@/lib/server/gitlab-client";
import {
  markBugMrMergedInCache,
  removeMrFromInboxCache,
} from "@/lib/server/mr-inbox-scanner";

const canonical = parseGitlabMrUrl(MR_URL)!.canonicalUrl;

const post = (body: unknown): Promise<Response> =>
  POST(
    new Request("http://localhost/api/mr-inbox/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const mergeOnce = (result: Awaited<ReturnType<typeof mergeMR>>) =>
  vi.mocked(mergeMR).mockResolvedValueOnce(result);

const cacheUntouched = () => {
  expect(removeMrFromInboxCache).not.toHaveBeenCalled();
  expect(markBugMrMergedInCache).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("合并成功", () => {
  it("200 {ok, mrUrl}，缓存两处都剔除；响应里没有 alreadyMerged 键", async () => {
    mergeOnce({ ok: true, url: MR_URL, iid: 7 });
    const res = await post({ mrUrl: MR_URL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mrUrl: canonical });
    expect(removeMrFromInboxCache).toHaveBeenCalledWith(canonical);
    expect(markBugMrMergedInCache).toHaveBeenCalledWith(canonical);
  });

  it("已合并（alreadyMerged）：同样 200 + 缓存照样剔除，响应带 alreadyMerged:true", async () => {
    mergeOnce({ ok: true, url: MR_URL, iid: 7, alreadyMerged: true });
    const res = await post({ mrUrl: MR_URL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      mrUrl: canonical,
      alreadyMerged: true,
    });
    expect(removeMrFromInboxCache).toHaveBeenCalledWith(canonical);
    expect(markBugMrMergedInCache).toHaveBeenCalledWith(canonical);
  });

  it("host / projectPath / iid 从链接解析、token 来自设置、sha 原样传给 mergeMR", async () => {
    mergeOnce({ ok: true, url: MR_URL, iid: 7 });
    await post({ mrUrl: MR_URL, sha: "abc1234def" });
    expect(mergeMR).toHaveBeenCalledWith({
      config: { host: "gitlab.example.com", token: "tok" },
      projectPath: "g/r",
      iid: 7,
      sha: "abc1234def",
    });
  });
});

describe("合并被拒", () => {
  it("带 sha 且文案指向 HEAD 不匹配：409 人话，缓存不动", async () => {
    mergeOnce({
      ok: false,
      error: "409 Conflict: SHA does not match HEAD of source branch",
    });
    const res = await post({ mrUrl: MR_URL, sha: "abc1234def" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("新提交");
    cacheUntouched();
  });

  it("不带 sha 的 409：照旧 502、文案原样（人话只给带 sha 的请求）", async () => {
    mergeOnce({ ok: false, error: "409 Conflict: something else" });
    const res = await post({ mrUrl: MR_URL });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("409 Conflict: something else");
    cacheUntouched();
  });

  it("405 补查后的带原因文案：502 原样透传，缓存不动（没合成就不能把它从收件箱剔掉）", async () => {
    mergeOnce({
      ok: false,
      error: "405 Method Not Allowed（流水线没通过）",
    });
    const res = await post({ mrUrl: MR_URL, sha: "abc1234def" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      "405 Method Not Allowed（流水线没通过）",
    );
    cacheUntouched();
  });
});
