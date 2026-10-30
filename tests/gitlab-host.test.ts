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

  // R14 Q21-03：同一个实例的不同写法不该被当成「多仓属于不同实例」
  it("同一个 host 的大小写 / 尾点 / 协议前缀 / 默认端口写法算同一个，返回规范写法", () => {
    expect(pickUnifiedGitHost(["GitLab.Example.com", "gitlab.example.com"])).toBe(
      "gitlab.example.com",
    );
    expect(pickUnifiedGitHost(["gitlab.example.com.", "gitlab.example.com"])).toBe(
      "gitlab.example.com",
    );
    expect(
      pickUnifiedGitHost(["https://gitlab.example.com", "gitlab.example.com:443"]),
    ).toBe("gitlab.example.com");
  });

  it("单个 host 也返回规范写法（下游拿它拼 URL / 比对受信 host）", () => {
    expect(pickUnifiedGitHost(["GitLab.Example.COM"])).toBe("gitlab.example.com");
  });

  it("规范化之后仍不同 → 照样 throw", () => {
    expect(() =>
      pickUnifiedGitHost(["GitLab.A.com", "gitlab.b.com."]),
    ).toThrow(MULTI_GITLAB_HOST_ERROR);
  });

  it("纯空白的 host 当没有（不被当成一个畸形 host 参与比较）；前后的空白不影响同一性", () => {
    expect(pickUnifiedGitHost(["   ", "gitlab.example.com"])).toBe("gitlab.example.com");
    expect(pickUnifiedGitHost(["  gitlab.example.com  ", "gitlab.example.com"])).toBe(
      "gitlab.example.com",
    );
  });

  it("规整不了的畸形值不会被静默吞掉：与合法 host 并存仍算不一致", () => {
    expect(() =>
      pickUnifiedGitHost(["gitlab.example.com", "evil host"]),
    ).toThrow(MULTI_GITLAB_HOST_ERROR);
  });

  it("单个规整不了的畸形值原样返回（不凭空变成 null、也不变成别的 host）", () => {
    expect(pickUnifiedGitHost(["Not A Host!"])).toBe("Not A Host!");
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
