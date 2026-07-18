/**
 * P0：评论可控 MR host 不得带 PAT 出站。
 * 验证 getMRWithHostAllowlist 对 evil host 直接跳过、不调 getMR。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMR = vi.fn();

vi.mock("@/lib/server/gitlab-client", () => ({
  getMR: (...args: unknown[]) => getMR(...args),
}));

vi.mock("@/lib/server/submit-mr-guard", () => ({
  deriveHostFromRepo: vi.fn(async () => "gitlab.corp.com"),
}));

import { getMRWithHostAllowlist } from "@/lib/server/mr-inbox-scanner";

describe("getMRWithHostAllowlist", () => {
  beforeEach(() => {
    getMR.mockReset();
    getMR.mockResolvedValue({
      ok: true,
      title: "t",
      sourceBranch: "a",
      targetBranch: "b",
      state: "opened",
      detailedMergeStatus: "mergeable",
      hasConflicts: false,
      mergeable: true,
    });
  });

  it("evil host 的 MR URL 不会触发带 token 的 getMR", async () => {
    const r = await getMRWithHostAllowlist({
      mrUrl: "https://evil.example/x/y/-/merge_requests/1",
      gitToken: "secret-pat-should-not-leak",
      allowedHosts: new Set(["gitlab.corp.com"]),
    });
    expect(r.ok).toBe(false);
    expect(getMR).not.toHaveBeenCalled();
  });

  it("allowlist 内 host 才会调用 getMR", async () => {
    const r = await getMRWithHostAllowlist({
      mrUrl: "https://gitlab.corp.com/g/r/-/merge_requests/9",
      gitToken: "pat",
      allowedHosts: new Set(["gitlab.corp.com"]),
    });
    expect(r.ok).toBe(true);
    expect(getMR).toHaveBeenCalledOnce();
    expect(getMR.mock.calls[0]![0]).toMatchObject({
      config: { host: "gitlab.corp.com", token: "pat" },
      projectPath: "g/r",
      iid: 9,
    });
  });
});
