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
import { normalizeGitHost } from "@/lib/server/trusted-git-host";

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

/**
 * R14 Q21-03：有 `scheme://` 的一律按 URL 解析，只有不带 scheme 的才可能是 scp 写法。
 * 旧实现把 scp 正则放在 URL 解析之前，`[^@]+` 能吞掉 `/`，host 被读成路径 / fragment 里 `@` 后面那段，
 * 与 `new URL` 的真实 host 相反；大小写 / 尾点不同的同一个 host 还会被当成两个 GitLab 实例。
 */
describe("R14 Q21-03：scheme 优先于 scp，host 与 new URL 的真实 host 一致", () => {
  it("路径 / fragment / 凭据里的 @ 不影响 host", () => {
    for (const url of [
      "https://gitlab.corp.com/group/a@b/repo.git",
      "https://gitlab.corp.com#@evil.com/g/r.git",
      "https://oauth2:fake%40secret@gitlab.corp.com/g/r.git",
      "ssh://git@gitlab.corp.com/g/a@b.git",
    ]) {
      expect(parseHostFromRemoteUrl(url), url).toBe("gitlab.corp.com");
    }
  });

  it("host 一律小写、去尾点；项目路径保持原大小写", () => {
    const cases: Array<[url: string, host: string, project: string]> = [
      ["https://GitLab.Corp.COM/Group/Repo.git", "gitlab.corp.com", "Group/Repo"],
      ["ssh://git@GitLab.Corp.com:2222/Group/Repo.git", "gitlab.corp.com", "Group/Repo"],
      ["git@GitLab.Corp.com:Group/Repo.git", "gitlab.corp.com", "Group/Repo"],
      ["https://gitlab.corp.com./g/r.git", "gitlab.corp.com", "g/r"],
      ["git@gitlab.corp.com.:g/r.git", "gitlab.corp.com", "g/r"],
      ["git@gitlab.corp.com..:g/r.git", "gitlab.corp.com", "g/r"],
    ];
    for (const [url, host, project] of cases) {
      expect(parseHostFromRemoteUrl(url), url).toBe(host);
      expect(parseProjectPathFromRemoteUrl(url), url).toBe(project);
    }
  });

  it("scheme 大小写不敏感：HTTPS:// 的项目路径不再把整串 URL 原样返回", () => {
    expect(parseProjectPathFromRemoteUrl("HTTPS://gitlab.corp.com/g/r.git")).toBe("g/r");
    expect(parseProjectPathFromRemoteUrl("SSH://git@gitlab.corp.com/g/r.git")).toBe("g/r");
    expect(parseHostFromRemoteUrl("HTTPS://GitLab.corp.com/g/r.git")).toBe("gitlab.corp.com");
  });

  it("git:// 认得 host、项目路径不认（保守返回 null）；file:// 两者都没有", () => {
    expect(parseHostFromRemoteUrl("git://gitlab.corp.com/g/r.git")).toBe("gitlab.corp.com");
    expect(parseProjectPathFromRemoteUrl("git://gitlab.corp.com/g/r.git")).toBeNull();
    expect(parseHostFromRemoteUrl("file:///srv/git/r.git")).toBeNull();
    expect(parseProjectPathFromRemoteUrl("file:///srv/git/r.git")).toBeNull();
  });

  it("scheme 字符集含 `+`：git+ssh:// / ssh+git://（git 认的 ssh 别名）按 URL 解析 host；项目路径不认（保守 null，与改前一致）", () => {
    for (const url of [
      "git+ssh://git@GitLab.Corp.com:2222/g/r.git",
      "ssh+git://git@gitlab.corp.com./g/r.git",
    ]) {
      expect(parseHostFromRemoteUrl(url), url).toBe("gitlab.corp.com");
      expect(parseProjectPathFromRemoteUrl(url), url).toBeNull();
    }
  });

  it("只去掉结尾的 .git：项目名中间带 `.git…`（GitLab Pages 仓库 docs.gitlab.io）不被截断", () => {
    expect(parseProjectPathFromRemoteUrl("git@gitlab.corp.com:team/docs.gitlab.io.git")).toBe("team/docs.gitlab.io");
    expect(parseProjectPathFromRemoteUrl("https://gitlab.corp.com/team/site.github.io.git")).toBe("team/site.github.io");
    expect(parseProjectPathFromRemoteUrl("https://gitlab.corp.com/team/docs.gitlab.io")).toBe("team/docs.gitlab.io");
  });

  it("Windows 盘符 `C:\\repo` / `C:/repo` 不是 scp 写法：项目路径为 null（scp 的 user 改成可选之后，靠「单个字母不算 host」挡住这一类；新旧结果一致）", () => {
    expect(parseProjectPathFromRemoteUrl("C:\\work\\repo")).toBeNull();
    expect(parseProjectPathFromRemoteUrl("C:/work/repo")).toBeNull();
  });

  it("scp 写法的 user 可以省略：`host:path`（git 自己认；旧实现要求必须有 `user@`，这类写法拿不到 host 也拿不到项目路径）", () => {
    expect(parseHostFromRemoteUrl("GitLab.Corp.com:group/repo.git")).toBe("gitlab.corp.com");
    expect(parseProjectPathFromRemoteUrl("gitlab.corp.com:group/sub/repo.git")).toBe("group/sub/repo");
    // 对照：user 不是 git 也行
    expect(parseProjectPathFromRemoteUrl("deploy@gitlab.corp.com:group/repo.git")).toBe("group/repo");
  });

  it("IPv6：方括号 host 的 scp 与 ssh:// 写法", () => {
    expect(parseHostFromRemoteUrl("git@[::1]:g/r.git")).toBe("[::1]");
    expect(parseProjectPathFromRemoteUrl("git@[::1]:g/r.git")).toBe("g/r");
    expect(parseHostFromRemoteUrl("ssh://git@[::1]:2222/g/r.git")).toBe("[::1]");
  });

  it("既没有 scheme 也没有 scp 冒号的写法（host/path、user@host/path）：按 https 兜底解析 host", () => {
    expect(parseHostFromRemoteUrl("gitlab.corp.com/group/repo.git")).toBe("gitlab.corp.com");
    expect(parseHostFromRemoteUrl("git@GitLab.Corp.com/group/repo.git")).toBe("gitlab.corp.com");
    // 兜底分支也要规整（大小写 / 尾点）
    expect(parseHostFromRemoteUrl("GitLab.Corp.com./group/repo.git")).toBe("gitlab.corp.com");
  });

  it("冒号前面带斜杠的不是 scp 写法（git 把它当本地路径）、scheme 字符不合法的 `x://` 也不当 scp：项目路径都不解析", () => {
    expect(parseProjectPathFromRemoteUrl("some/dir@host:group/repo.git")).toBeNull();
    expect(parseProjectPathFromRemoteUrl("a_b://host/group/repo.git")).toBeNull();
  });

  it("空白 / 垃圾输入 → null，不抛", () => {
    for (const v of ["", "   ", "\n", "not a url", "://", "git@"]) {
      expect(parseProjectPathFromRemoteUrl(v), JSON.stringify(v)).toBeNull();
    }
    expect(parseHostFromRemoteUrl("   ")).toBeNull();
    expect(parseHostFromRemoteUrl("not a url")).toBeNull();
  });

  it("解析出的 host 已是规范形态：再过 normalizeGitHost 不变（与 pickUnifiedGitHost / 受信 host 校验同一口径）", () => {
    for (const url of [
      "https://GitLab.Corp.COM/g/r.git",
      "git@GitLab.Corp.com:g/r.git",
      "ssh://git@gitlab.corp.com:2222/g/r.git",
      "https://gitlab.corp.com./g/r.git",
    ]) {
      const host = parseHostFromRemoteUrl(url);
      expect(host, url).not.toBeNull();
      expect(normalizeGitHost(host!), url).toBe(host);
    }
  });
});
