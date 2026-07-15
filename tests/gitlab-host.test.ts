/**
 * GitLab host 统一推导：单实例口径、多仓不一致 fail-fast。
 */
import { describe, expect, it } from "vitest";

import {
  MULTI_GITLAB_HOST_ERROR,
  pickUnifiedGitHost,
} from "@/lib/server/gitlab-host";

describe("pickUnifiedGitHost", () => {
  it("全空 → null", () => {
    expect(pickUnifiedGitHost([])).toBeNull();
    expect(pickUnifiedGitHost([null, undefined, ""])).toBeNull();
  });

  it("单一 host（含重复）→ 该 host", () => {
    expect(pickUnifiedGitHost(["gitlab.example.com"])).toBe(
      "gitlab.example.com",
    );
    expect(
      pickUnifiedGitHost([
        "gitlab.example.com",
        null,
        "gitlab.example.com",
        "  gitlab.example.com  ",
      ]),
    ).toBe("gitlab.example.com");
  });

  it("多仓不同 host → throw 统一文案", () => {
    expect(() =>
      pickUnifiedGitHost(["gitlab.a.com", "gitlab.b.com"]),
    ).toThrow(MULTI_GITLAB_HOST_ERROR);
  });
});
