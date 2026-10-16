/**
 * GitLab PAT 可信 host 的「端口」口径（P3）：同一台机器的另一个端口是另一个服务
 *
 * 背景：可信 host 的比较单位是「主机名 + 端口」（形同 URL.host）。曾经有一环用 URL.hostname 取 host，
 * 端口被丢掉后 `https://gitlab.corp.com:8443/…` 会被当成 `gitlab.corp.com`，从而通过同主机校验——
 * 同机另一个端口上跑的服务（别人起的、被劫持的）就拿到了 PAT。
 *
 * 本文件钉住：
 *   A. normalizeGitHost：`:443` 显式 / 省略等价、非默认端口保留、端口越界 / 裸 IPv6 等畸形拒绝、IPv6 字面量、幂等；
 *   B. gitHostFromUrl：从 URL 提取 host 时 http / https 的默认端口各自正确（http 的 80 不能与 https 的 443 撞 key）；
 *   C. 固定值 / 白名单 / 出站闸三处的端口语义（同主机不同端口双向被拒）与错误文案里的「白名单要写带端口的 host」提示；
 *   D. 兜底层 gitlab-client：请求真的发往带端口的地址、不带端口的不可信 host 零网络请求。
 *
 * 团队库 URL 解析与出站闸的端口用例见 tests/team-library.test.ts（parseGitLabRepoUrl）与
 * tests/trusted-git-host-callsites.test.ts（canMirror 探测 / runGit 闸口）。
 * 全程只用假 token，每个用例一个全新的临时数据目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMR } from "@/lib/server/gitlab-client";
import {
  assertTrustedGitHost,
  GIT_HOST_ALLOWLIST_KEY,
  gitHostFromUrl,
  normalizeGitHost,
  pinTrustedGitHostIfAbsent,
  readGitHostAllowlist,
  readTrustedGitHostPin,
  resolveGitHostForPrompt,
  trustedGitHostFilePath,
  UntrustedGitHostError,
} from "@/lib/server/trusted-git-host";

const ORIGINAL_DATA_DIR = process.env.FLOWSHIP_DATA_DIR;
const FAKE_TOKEN = "glpat-FAKE-PORT-TOKEN";
/** 提示文案里必须出现的固定片段：用户靠它知道「白名单该怎么写」 */
const ALLOWLIST_PORT_HINT = "白名单要写带端口的 host";

let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fe-trusted-git-host-port-"));
  process.env.FLOWSHIP_DATA_DIR = dataDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.FLOWSHIP_DATA_DIR;
  else process.env.FLOWSHIP_DATA_DIR = ORIGINAL_DATA_DIR;
});

const writeConfig = (cfg: Record<string, unknown>): void => {
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg), "utf-8");
};

const expectUntrusted = (fn: () => unknown): UntrustedGitHostError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(UntrustedGitHostError);
    return err as UntrustedGitHostError;
  }
  throw new Error("预期抛 UntrustedGitHostError，但没抛");
};

// ---------------------------------------------------------------------------
// A. normalizeGitHost 的端口口径
// ---------------------------------------------------------------------------

describe("A · normalizeGitHost：端口", () => {
  it.each([
    // 「无端口」恒指 443：显式 :443 与省略等价（含协议前缀、大小写、尾点、前导零写法）
    ["gitlab.corp.com", "gitlab.corp.com"],
    ["gitlab.corp.com:443", "gitlab.corp.com"],
    ["https://gitlab.corp.com:443", "gitlab.corp.com"],
    ["GitLab.Corp.com.:443", "gitlab.corp.com"],
    ["gitlab.corp.com:0443", "gitlab.corp.com"],
    // 非默认端口保留（含 80：在 https 口径下 80 不是默认端口）
    ["gitlab.corp.com:8443", "gitlab.corp.com:8443"],
    ["gitlab.corp.com:80", "gitlab.corp.com:80"],
    ["GitLab.Corp.com.:8443", "gitlab.corp.com:8443"],
    ["127.0.0.1:8080", "127.0.0.1:8080"],
    ["gitlab.corp.com:65535", "gitlab.corp.com:65535"],
    // IPv6 字面量保留方括号；:443 同样省略；写法不同的同一地址收敛成同一个 key
    ["[::1]", "[::1]"],
    ["[::1]:443", "[::1]"],
    ["[::1]:8443", "[::1]:8443"],
    ["[0:0:0:0:0:0:0:1]:8443", "[::1]:8443"],
    ["[FE80::1]:8443", "[fe80::1]:8443"],
  ])("%j → %j", (raw, expected) => {
    expect(normalizeGitHost(raw)).toBe(expected);
  });

  it.each([
    "gitlab.corp.com:65536", // 端口越界
    "gitlab.corp.com:99999",
    "gitlab.corp.com:abc",
    "gitlab.corp.com:-1",
    "gitlab.corp.com:8443:8443",
    "gitlab.corp.com:",
    "::1", // 裸 IPv6（没有方括号，无法区分端口）
    "[::1",
    "[::1]x",
    "[::1]:",
    "[]",
  ])("端口 / IPv6 畸形 %j → null（当非法 host 拒绝）", (raw) => {
    expect(normalizeGitHost(raw)).toBeNull();
  });

  it("输出幂等：再规范化一次不变（固定文件读回来再比较不会漂移）", () => {
    for (const raw of [
      "GitLab.Corp.com.:443",
      "gitlab.corp.com:0443",
      "gitlab.corp.com:8443",
      "[0:0:0:0:0:0:0:1]:8443",
      "[::1]:443",
      "https://127.0.0.1:8080",
    ]) {
      const once = normalizeGitHost(raw);
      expect(once).not.toBeNull();
      expect(normalizeGitHost(once)).toBe(once);
    }
  });
});

// ---------------------------------------------------------------------------
// B. gitHostFromUrl：URL → 目的地 host（scheme 感知）
// ---------------------------------------------------------------------------

describe("B · gitHostFromUrl", () => {
  it.each([
    // https：默认 443（省略 / 显式等价），其它端口保留，80 在 https 下不是默认
    ["https://gitlab.corp.com/g/r.git", "gitlab.corp.com"],
    ["https://gitlab.corp.com:443/g/r.git", "gitlab.corp.com"],
    ["https://gitlab.corp.com:8443/g/r.git", "gitlab.corp.com:8443"],
    ["https://gitlab.corp.com:80/g/r.git", "gitlab.corp.com:80"],
    // http：默认是 80、必须显式写出，不然会与 https 的 443 撞成同一个 key
    ["http://gitlab.corp.com/g/r.git", "gitlab.corp.com:80"],
    ["http://gitlab.corp.com:80/g/r.git", "gitlab.corp.com:80"],
    ["http://gitlab.corp.com:8080/g/r.git", "gitlab.corp.com:8080"],
    // http 里写 443 就是连 443 那个服务
    ["http://gitlab.corp.com:443/g/r.git", "gitlab.corp.com"],
    // 大小写 / 尾点 / userinfo 不进 key（凭据不能泄进 host，更不能影响比较）
    ["HTTPS://GitLab.Corp.com.:8443/g/r.git", "gitlab.corp.com:8443"],
    ["https://oauth2:glpat-SECRET@gitlab.corp.com:8443/g/r.git", "gitlab.corp.com:8443"],
    // IPv6 字面量
    ["https://[::1]/g/r.git", "[::1]"],
    ["https://[::1]:8443/g/r.git", "[::1]:8443"],
    ["http://[::1]/g/r.git", "[::1]:80"],
    // 非 http(s)：端口是该协议自己的（ssh 的 22 / 2222），与 HTTPS 端口不可比，只比主机名
    ["ssh://git@gitlab.corp.com:2222/g/r.git", "gitlab.corp.com"],
    ["ssh://git@gitlab.corp.com/g/r.git", "gitlab.corp.com"],
  ])("%j → %j", (url, expected) => {
    expect(gitHostFromUrl(url)).toBe(expected);
  });

  it.each(["", "   ", "not-a-url", "/local/path/repo.git", "file:///tmp/repo.git", undefined, null, 42])(
    "解析不了 / 没有主机 %j → null（调用方按非法 host 拒绝）",
    (raw) => {
      expect(gitHostFromUrl(raw)).toBeNull();
    },
  );

  it("http 默认端口与 https 默认端口是两个不同的 key（互不放行）", () => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com", "settings"); // = https 443
    expect(assertTrustedGitHost(gitHostFromUrl("https://gitlab.corp.com/g/r"))).toBe(
      "gitlab.corp.com",
    );
    expect(
      expectUntrusted(() => assertTrustedGitHost(gitHostFromUrl("http://gitlab.corp.com/g/r"))).code,
    ).toBe("pin-mismatch");
  });
});

// ---------------------------------------------------------------------------
// C. 固定 / 白名单 / 出站闸：端口是身份的一部分
// ---------------------------------------------------------------------------

describe("C · 固定值（pin）带端口比较", () => {
  it("固定值保存端口：落盘的是 `host:port`，读回来原样", () => {
    expect(pinTrustedGitHostIfAbsent("GitLab.Corp.com:8443", "settings")).toEqual({
      status: "pinned",
      host: "gitlab.corp.com:8443",
    });
    const saved = JSON.parse(fs.readFileSync(trustedGitHostFilePath(), "utf-8")) as {
      host: string;
    };
    expect(saved.host).toBe("gitlab.corp.com:8443");
    expect(readTrustedGitHostPin()).toEqual({ status: "pinned", host: "gitlab.corp.com:8443" });
  });

  it("固定 `gitlab.corp.com`（443）：同主机另一个端口被拒（pin-mismatch），错误文案点破「同主机不同端口」", () => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com", "settings");

    for (const evil of ["gitlab.corp.com:8443", "gitlab.corp.com:80", "https://gitlab.corp.com:9443"]) {
      const err = expectUntrusted(() => assertTrustedGitHost(evil));
      expect(err.code).toBe("pin-mismatch");
      expect(err.message).toContain("同一主机名但端口不同");
    }
  });

  it("固定 `gitlab.corp.com:8443`：无端口（443）与别的端口都被拒，同端口放行（反向同样严格）", () => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com:8443", "settings");

    expect(assertTrustedGitHost("GitLab.Corp.com:8443")).toBe("gitlab.corp.com:8443");
    for (const evil of ["gitlab.corp.com", "gitlab.corp.com:443", "gitlab.corp.com:9443"]) {
      expect(expectUntrusted(() => assertTrustedGitHost(evil)).code).toBe("pin-mismatch");
    }
  });

  it("`:443` 显式与省略等价：两种写法固定出同一个值，互相放行", () => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com:443", "settings");
    expect(readTrustedGitHostPin()).toEqual({ status: "pinned", host: "gitlab.corp.com" });
    for (const ok of ["gitlab.corp.com", "gitlab.corp.com:443", "https://GitLab.corp.com:443/"]) {
      expect(assertTrustedGitHost(ok.replace(/\/$/, ""))).toBe("gitlab.corp.com");
    }
  });

  it("已固定后再固定同主机不同端口：不覆盖（exists-different），不会被「同主机」蒙混", () => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com", "boot");
    expect(pinTrustedGitHostIfAbsent("gitlab.corp.com:8443", "session")).toEqual({
      status: "exists-different",
      host: "gitlab.corp.com:8443",
      pinned: "gitlab.corp.com",
    });
    expect(readTrustedGitHostPin()).toEqual({ status: "pinned", host: "gitlab.corp.com" });
  });

  it("公共托管站点按主机名判：github.com:8443 也不会被固定成可信 GitLab", () => {
    expect(pinTrustedGitHostIfAbsent("github.com:8443", "egress")).toMatchObject({
      status: "not-candidate",
    });
    expect(readTrustedGitHostPin()).toEqual({ status: "absent" });
  });

  it("IPv6 字面量：固定 `[::1]:8443` 只放行该端口，其它端口被拒且文案能识别同主机名", () => {
    pinTrustedGitHostIfAbsent("[::1]:8443", "settings");

    expect(assertTrustedGitHost("[0:0:0:0:0:0:0:1]:8443")).toBe("[::1]:8443");
    for (const evil of ["[::1]", "[::1]:9443"]) {
      const err = expectUntrusted(() => assertTrustedGitHost(evil));
      expect(err.code).toBe("pin-mismatch");
      expect(err.message).toContain("同一主机名但端口不同");
    }
    // 另一个 IPv6 地址：普通 pin-mismatch，不带「同一主机名」误导
    const other = expectUntrusted(() => assertTrustedGitHost("[::2]:8443"));
    expect(other.code).toBe("pin-mismatch");
    expect(other.message).not.toContain("同一主机名但端口不同");
  });
});

describe("C · 白名单（gitHostAllowlist）带端口匹配", () => {
  it("白名单写纯 hostname、实际地址带非默认端口 → 严格拒绝，并提示「白名单要写带端口的 host」", () => {
    writeConfig({ [GIT_HOST_ALLOWLIST_KEY]: ["gitlab.corp.com"] });

    const err = expectUntrusted(() => assertTrustedGitHost("gitlab.corp.com:8443"));
    expect(err.code).toBe("allowlist-miss");
    expect(err.message).toContain(ALLOWLIST_PORT_HINT);
    // 给出可直接抄的写法
    expect(err.message).toContain('"gitlab.corp.com:8443"');
    expect(err.message).toContain("同一主机名但端口不同");
    // 仍保留原有的处理指引（让用户在本机改、agent 不要自行改）
    expect(err.message).toContain("agent 不要自行改动");
  });

  it("反过来：白名单写带端口、实际地址是默认端口（无端口）→ 同样拒绝，提示不带端口只表示默认端口 443", () => {
    writeConfig({ [GIT_HOST_ALLOWLIST_KEY]: ["gitlab.corp.com:8443"] });

    const err = expectUntrusted(() => assertTrustedGitHost("gitlab.corp.com"));
    expect(err.code).toBe("allowlist-miss");
    expect(err.message).toContain(ALLOWLIST_PORT_HINT);
    expect(err.message).toContain("默认端口 443");
    expect(err.message).toContain("同一主机名但端口不同");
  });

  it("同主机不同端口各写一条：逐个精确命中，第三个端口仍被拒", () => {
    writeConfig({ [GIT_HOST_ALLOWLIST_KEY]: ["gitlab.corp.com", "gitlab.corp.com:8443"] });

    expect(readGitHostAllowlist()).toEqual(["gitlab.corp.com", "gitlab.corp.com:8443"]);
    expect(assertTrustedGitHost("gitlab.corp.com:443")).toBe("gitlab.corp.com");
    expect(assertTrustedGitHost("gitlab.corp.com:8443")).toBe("gitlab.corp.com:8443");
    expect(expectUntrusted(() => assertTrustedGitHost("gitlab.corp.com:9443")).code).toBe(
      "allowlist-miss",
    );
  });

  it("白名单里 `:443` 显式写法与省略等价（读出来就是规范化后的无端口形式）", () => {
    writeConfig({ [GIT_HOST_ALLOWLIST_KEY]: ["GitLab.Corp.com:443"] });
    expect(readGitHostAllowlist()).toEqual(["gitlab.corp.com"]);
    expect(assertTrustedGitHost("gitlab.corp.com")).toBe("gitlab.corp.com");
    expect(assertTrustedGitHost("https://gitlab.corp.com:443")).toBe("gitlab.corp.com");
  });

  it("白名单里的 IPv6 字面量带端口：精确匹配", () => {
    writeConfig({ [GIT_HOST_ALLOWLIST_KEY]: ["[::1]:8443"] });
    expect(assertTrustedGitHost("[::1]:8443")).toBe("[::1]:8443");
    expect(expectUntrusted(() => assertTrustedGitHost("[::1]")).code).toBe("allowlist-miss");
    expect(expectUntrusted(() => assertTrustedGitHost("[::1]:9443")).code).toBe("allowlist-miss");
  });

  it("没有端口因素的未命中不带端口提示（别用无关文案误导）", () => {
    writeConfig({ [GIT_HOST_ALLOWLIST_KEY]: ["gitlab.corp.com"] });
    const err = expectUntrusted(() => assertTrustedGitHost("evil.example"));
    expect(err.code).toBe("allowlist-miss");
    expect(err.message).not.toContain(ALLOWLIST_PORT_HINT);
  });

  it("被拒地址带端口、白名单里没有任何同主机名条目 → 仍给出写法提示", () => {
    writeConfig({ [GIT_HOST_ALLOWLIST_KEY]: ["gitlab.corp.com"] });
    const err = expectUntrusted(() => assertTrustedGitHost("evil.example:8443"));
    expect(err.code).toBe("allowlist-miss");
    expect(err.message).toContain(ALLOWLIST_PORT_HINT);
    expect(err.message).not.toContain("同一主机名但端口不同");
  });
});

describe("C · 提示词 / 非法端口", () => {
  it("origin 同主机不同端口 → 视作被篡改：展示可信 host（带端口），并带 untrustedOriginHost", () => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com", "settings");
    expect(resolveGitHostForPrompt("gitlab.corp.com:8443")).toEqual({
      host: "gitlab.corp.com",
      untrustedOriginHost: "gitlab.corp.com:8443",
    });
  });

  it("端口越界 / 非数字 → invalid（不当成别的 host、也不放行）", () => {
    for (const bad of ["gitlab.corp.com:99999", "gitlab.corp.com:abc", "::1"]) {
      expect(expectUntrusted(() => assertTrustedGitHost(bad)).code).toBe("invalid");
    }
  });
});

// ---------------------------------------------------------------------------
// D. gitlab-client 兜底层：真实请求目的地
// ---------------------------------------------------------------------------

describe("D · gitlab-client：请求发往带端口的目的地，不带端口的不可信 host 零网络请求", () => {
  const okMr = (): Response =>
    new Response(JSON.stringify({ iid: 7, web_url: "https://gitlab.corp.com:8443/g/r/-/merge_requests/7" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("固定了 `gitlab.corp.com:8443`：同端口放行且请求 URL 带端口、带 PAT；无端口 / 别的端口零请求", async () => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com:8443", "settings");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => okMr());

    const ok = await getMR({
      config: { host: "GitLab.Corp.com:8443", token: FAKE_TOKEN },
      projectPath: "g/r",
      iid: 7,
    });
    expect(ok.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/gitlab\.corp\.com:8443\/api\/v4\//);
    expect(JSON.stringify((init as RequestInit).headers)).toContain(FAKE_TOKEN);

    for (const host of ["gitlab.corp.com", "gitlab.corp.com:443", "gitlab.corp.com:9443"]) {
      const r = (await getMR({
        config: { host, token: FAKE_TOKEN },
        projectPath: "g/r",
        iid: 7,
      })) as { ok: boolean; error?: string };
      expect(r.ok).toBe(false);
      expect(r.error).toContain("为防止 GitLab Token 外发已拒绝");
      expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN);
    }
    // 三次被拒都没有新增请求
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("固定了 `gitlab.corp.com`（443）：`:8443` 零请求；显式 `:443` 放行且 URL 里不带 :443", async () => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com", "settings");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => okMr());

    const bad = await getMR({
      config: { host: "gitlab.corp.com:8443", token: FAKE_TOKEN },
      projectPath: "g/r",
      iid: 7,
    });
    expect(bad.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    const ok = await getMR({
      config: { host: "gitlab.corp.com:443", token: FAKE_TOKEN },
      projectPath: "g/r",
      iid: 7,
    });
    expect(ok.ok).toBe(true);
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/^https:\/\/gitlab\.corp\.com\/api\/v4\//);
  });
});
