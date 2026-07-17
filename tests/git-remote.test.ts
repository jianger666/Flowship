/**
 * git remote URL 解析单测（ssh:// / scp / https）
 *
 * 背景：旧 parseProjectPathFromRemoteUrl 不认 ssh://，
 *   ssh://git@h:22/g/r.git → 错解为 22/g/r；ssh://git@h/g/r.git → 残留协议前缀。
 */
import { describe, expect, it } from "vitest";

import {
  parseHostFromRemoteUrl,
  parseProjectPathFromRemoteUrl,
} from "@/lib/git-remote";

describe("parseProjectPathFromRemoteUrl", () => {
  it("scp 形态 git@host:path", () => {
    expect(
      parseProjectPathFromRemoteUrl("git@git.corp.com:wkid/crm-web.git"),
    ).toBe("wkid/crm-web");
  });

  it("https 形态", () => {
    expect(
      parseProjectPathFromRemoteUrl("https://git.corp.com/group/sub/proj.git"),
    ).toBe("group/sub/proj");
  });

  it("ssh:// 带端口", () => {
    expect(
      parseProjectPathFromRemoteUrl("ssh://git@git.corp.com:22/g/r.git"),
    ).toBe("g/r");
  });

  it("ssh:// 不带端口", () => {
    expect(
      parseProjectPathFromRemoteUrl("ssh://git@git.corp.com/g/r.git"),
    ).toBe("g/r");
  });

  it("空 / 解析不出 → null", () => {
    expect(parseProjectPathFromRemoteUrl("")).toBe(null);
  });
});

describe("parseHostFromRemoteUrl", () => {
  it("scp 形态", () => {
    expect(parseHostFromRemoteUrl("git@git.corp.com:wkid/crm-web.git")).toBe(
      "git.corp.com",
    );
  });

  it("ssh:// 带端口 → host 不含端口", () => {
    expect(parseHostFromRemoteUrl("ssh://git@git.corp.com:22/g/r.git")).toBe(
      "git.corp.com",
    );
  });

  it("ssh:// 不带端口", () => {
    expect(parseHostFromRemoteUrl("ssh://git@git.corp.com/g/r.git")).toBe(
      "git.corp.com",
    );
  });

  it("https", () => {
    expect(parseHostFromRemoteUrl("https://git.corp.com/g/r.git")).toBe(
      "git.corp.com",
    );
  });
});
