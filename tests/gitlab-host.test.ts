/**
 * GitLab host 统一推导：单实例口径、多仓不一致 fail-fast、脚本仓排除。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MULTI_GITLAB_HOST_ERROR,
  pickUnifiedGitHost,
  resolveEffectiveGitHost,
} from "@/lib/server/gitlab-host";

const { deriveHostFromRepo } = vi.hoisted(() => ({
  deriveHostFromRepo: vi.fn(),
}));

vi.mock("@/lib/server/submit-mr-guard", () => ({
  deriveHostFromRepo,
}));

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

describe("resolveEffectiveGitHost", () => {
  beforeEach(() => {
    deriveHostFromRepo.mockReset();
  });

  it("不传排除集：多仓不同 host → throw（保持原 fail-fast）", async () => {
    deriveHostFromRepo.mockImplementation(async (p: string) =>
      p === "/a" ? "gitlab.a.com" : "gitlab.b.com",
    );
    await expect(
      resolveEffectiveGitHost(["/a", "/b"]),
    ).rejects.toThrow(MULTI_GITLAB_HOST_ERROR);
  });

  it("脚本仓在排除集 → 不参与推导、不误报多实例", async () => {
    deriveHostFromRepo.mockImplementation(async (p: string) =>
      p === "/a" ? "gitlab.a.com" : "gitlab.script.com",
    );
    await expect(
      resolveEffectiveGitHost(["/a", "/script"], ["/script"]),
    ).resolves.toBe("gitlab.a.com");
    expect(deriveHostFromRepo).toHaveBeenCalledWith("/a");
    expect(deriveHostFromRepo).not.toHaveBeenCalledWith("/script");
  });

  it("全部仓都被排除 → null（无仓可推、跟全空同语义）", async () => {
    deriveHostFromRepo.mockResolvedValue("gitlab.a.com");
    await expect(
      resolveEffectiveGitHost(["/script"], ["/script"]),
    ).resolves.toBeNull();
  });
});
