/**
 * GitLab PAT 只发往可信 host（S02-03 / S03-03）：trusted-git-host 的行为测试
 *
 * 威胁：PAT（settings.gitToken）被发往「从 git remote / 评论链接推导出的 host」，
 * 而 remote 在 agent 可写的 `.git/config` 里、评论链接任何人都能塞。修法是首次绑定固定（TOFU）+ 可选白名单。
 *
 * 分层：
 *   A. normalizeGitHost 规范化；
 *   B. pinTrustedGitHostIfAbsent / assertTrustedGitHost：固定、放行、拒绝、白名单、损坏、写失败；
 *   C. resolveGitHostForPrompt：提示词不能教 agent 向被篡改的 origin 发 token；
 *   D. gitlab-client 兜底层：真 client + `globalThis.fetch` spy——不可信 host 时一次网络请求都不许发；
 *   E. 从仓库 origin / settings 固定（gitlab-host.ts 的 pinTrustedGitHostFrom*，真 git 仓）。
 *
 * 调用点层（scanner / submit_mr / 收件箱合并 / bypass merge / 共享库 git）见
 * tests/trusted-git-host-callsites.test.ts。
 *
 * 每个用例一个全新的临时数据目录（dataRoot() 每次读 env）；只用假 token、绝不读真实配置。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  closeOpenMR,
  createMR,
  getMR,
  getMRMergeStatus,
  mergeMR,
} from "@/lib/server/gitlab-client";
import {
  pinTrustedGitHostFromRepoPaths,
  pinTrustedGitHostFromSettings,
} from "@/lib/server/gitlab-host";
import {
  assertTrustedGitHost,
  GIT_HOST_ALLOWLIST_KEY,
  hasTrustedGitHostRecord,
  normalizeGitHost,
  pinTrustedGitHostIfAbsent,
  readGitHostAllowlist,
  readTrustedGitHostPin,
  resolveGitHostForPrompt,
  TRUSTED_GIT_HOST_FILE_NAME,
  trustedGitHostFilePath,
  UntrustedGitHostError,
} from "@/lib/server/trusted-git-host";

const ORIGINAL_DATA_DIR = process.env.FLOWSHIP_DATA_DIR;
const FAKE_TOKEN = "glpat-FAKE-TRUSTED-HOST-TOKEN";

let dataDir = "";
const extraDirs: string[] = [];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fe-trusted-git-host-"));
  process.env.FLOWSHIP_DATA_DIR = dataDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of [dataDir, ...extraDirs.splice(0)]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.FLOWSHIP_DATA_DIR;
  else process.env.FLOWSHIP_DATA_DIR = ORIGINAL_DATA_DIR;
});

/** 写临时数据目录里的 config.json（只放假值） */
const writeConfig = (cfg: Record<string, unknown> | string): void => {
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    typeof cfg === "string" ? cfg : JSON.stringify(cfg),
    "utf-8",
  );
};

const writePinFile = (content: string): void => {
  fs.writeFileSync(trustedGitHostFilePath(), content, "utf-8");
};

/** 断言 fn 抛 UntrustedGitHostError 并返回它（便于继续断言 code / message） */
const expectUntrusted = (fn: () => unknown): UntrustedGitHostError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(UntrustedGitHostError);
    return err as UntrustedGitHostError;
  }
  throw new Error("预期 assertTrustedGitHost 抛 UntrustedGitHostError，但没抛");
};

// ---------------------------------------------------------------------------
// A. normalizeGitHost
// ---------------------------------------------------------------------------

describe("A · normalizeGitHost", () => {
  it.each([
    ["gitlab.example.com", "gitlab.example.com"],
    ["GitLab.Example.COM", "gitlab.example.com"],
    ["  gitlab.example.com  ", "gitlab.example.com"],
    ["https://gitlab.example.com", "gitlab.example.com"],
    ["http://gitlab.example.com", "gitlab.example.com"],
    ["gitlab.example.com:443", "gitlab.example.com"],
    ["gitlab.example.com.", "gitlab.example.com"],
    ["gitlab.example.com.:443", "gitlab.example.com"],
    // 非默认端口是另一个服务：保留、不与无端口的合并
    ["gitlab.example.com:8443", "gitlab.example.com:8443"],
  ])("%j → %j", (raw, expected) => {
    expect(normalizeGitHost(raw)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "a b",
    "user@evil.example",
    "gitlab.example.com@evil.example",
    "evil.example/path",
    "evil.example\\path",
    "evil.example?x=1",
    "evil.example#frag",
    ":443",
    ".evil.example",
    undefined,
    null,
    123,
  ])("畸形 / 非字符串 %j → null（当非法 host 拒绝）", (raw) => {
    expect(normalizeGitHost(raw)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B. 固定 / 放行 / 拒绝
// ---------------------------------------------------------------------------

describe("B · 首次固定（TOFU）", () => {
  it("首次固定放行并落盘（host 已规范化、带来源、0600）", () => {
    expect(hasTrustedGitHostRecord()).toBe(false);

    const r = pinTrustedGitHostIfAbsent("GitLab.Corp.com:443", "settings");
    expect(r).toEqual({ status: "pinned", host: "gitlab.corp.com" });

    const file = path.join(dataDir, TRUSTED_GIT_HOST_FILE_NAME);
    expect(trustedGitHostFilePath()).toBe(file);
    const saved = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(saved).toMatchObject({
      version: 1,
      host: "gitlab.corp.com",
      source: "settings",
    });
    expect(typeof saved.pinnedAt).toBe("string");
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(readTrustedGitHostPin()).toEqual({
      status: "pinned",
      host: "gitlab.corp.com",
    });
    // 原子写不留 tmp 残骸
    expect(
      fs.readdirSync(dataDir).filter((n) => n.includes(".tmp.")),
    ).toEqual([]);
  });

  it("已固定后再固定别的 host：不覆盖（exists-different），同 host 是 exists-same", () => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com", "boot");
    expect(pinTrustedGitHostIfAbsent("GITLAB.corp.com", "session")).toEqual({
      status: "exists-same",
      host: "gitlab.corp.com",
    });
    expect(pinTrustedGitHostIfAbsent("evil.example", "session")).toEqual({
      status: "exists-different",
      host: "evil.example",
      pinned: "gitlab.corp.com",
    });
    expect(readTrustedGitHostPin()).toEqual({
      status: "pinned",
      host: "gitlab.corp.com",
    });
  });

  it("非法 host 不固定、不落盘", () => {
    expect(pinTrustedGitHostIfAbsent("user@evil.example", "boot")).toEqual({
      status: "invalid",
    });
    expect(pinTrustedGitHostIfAbsent("", "boot")).toEqual({ status: "invalid" });
    expect(hasTrustedGitHostRecord()).toBe(false);
  });

  it("公共托管站（github.com 等）不作为固定候选，免得抢先固定后真 GitLab 被误杀", () => {
    for (const h of ["github.com", "GitHub.com", "gitee.com", "bitbucket.org"]) {
      expect(pinTrustedGitHostIfAbsent(h, "session").status).toBe(
        "not-candidate",
      );
    }
    expect(hasTrustedGitHostRecord()).toBe(false);
    // 之后真正的 GitLab 仍能正常首次固定
    expect(pinTrustedGitHostIfAbsent("gitlab.corp.com", "session").status).toBe(
      "pinned",
    );
  });

  it("写盘失败：本次放行（没有已固定值可违反）、不留 tmp、不抛", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" });
    });

    expect(pinTrustedGitHostIfAbsent("gitlab.corp.com", "boot")).toEqual({
      status: "write-failed",
      host: "gitlab.corp.com",
    });
    expect(assertTrustedGitHost("gitlab.corp.com")).toBe("gitlab.corp.com");
    expect(warn).toHaveBeenCalled();
    expect(
      fs.readdirSync(dataDir).filter((n) => n.includes("trusted-git-host")),
    ).toEqual([]);
  });
});

describe("B · assertTrustedGitHost", () => {
  it("同 host 放行：大小写 / :443 / 尾点 / https:// 前缀变体都等价", () => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com", "settings");
    for (const v of [
      "gitlab.corp.com",
      "GitLab.Corp.COM",
      "gitlab.corp.com:443",
      "gitlab.corp.com.",
      "https://gitlab.corp.com",
    ]) {
      expect(assertTrustedGitHost(v)).toBe("gitlab.corp.com");
    }
  });

  it("不同 host 拒绝：lookalike / 子域 / 异端口 / 后缀拼接都不放行，且文案可操作", () => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com", "settings");
    for (const evil of [
      "evil.example",
      "gitlab.corp.com.evil.example",
      "gitlab-corp.com",
      "xgitlab.corp.com",
      "sub.gitlab.corp.com",
      "gitlab.corp.com:8443",
    ]) {
      const err = expectUntrusted(() => assertTrustedGitHost(evil));
      expect(err.code, evil).toBe("pin-mismatch");
      // 文案：已固定的 host、被拒的 host、固定文件路径、白名单配置名都要有——用户据此自助恢复
      expect(err.message).toContain("gitlab.corp.com");
      expect(err.message).toContain(normalizeGitHost(evil)!);
      expect(err.message).toContain(trustedGitHostFilePath());
      expect(err.message).toContain(GIT_HOST_ALLOWLIST_KEY);
      expect(err.message).toContain("为防止 GitLab Token 外发已拒绝");
      // 恢复动作必须交给用户：文案不能鼓励 agent 自己改文件
      expect(err.message).toContain("agent 不要自行改动");
    }
    // userinfo 畸形直接判非法（@ 之后的才是真正的目的地）
    expect(
      expectUntrusted(() => assertTrustedGitHost("gitlab.corp.com@evil.example"))
        .code,
    ).toBe("invalid");
    // 拒绝不能改动已固定值
    expect(readTrustedGitHostPin()).toEqual({
      status: "pinned",
      host: "gitlab.corp.com",
    });
  });

  it("没有固定值时的出站兜底：就地固定（来源 egress），之后别的 host 被拒", () => {
    expect(assertTrustedGitHost("gitlab.corp.com")).toBe("gitlab.corp.com");
    expect(
      JSON.parse(fs.readFileSync(trustedGitHostFilePath(), "utf-8")),
    ).toMatchObject({ host: "gitlab.corp.com", source: "egress" });
    expect(expectUntrusted(() => assertTrustedGitHost("evil.example")).code).toBe(
      "pin-mismatch",
    );
  });

  it("pinIfAbsent:false（host 来自配置的出站点，如共享库）：放行但不固定", () => {
    expect(assertTrustedGitHost("lib.corp.com", { pinIfAbsent: false })).toBe(
      "lib.corp.com",
    );
    expect(hasTrustedGitHostRecord()).toBe(false);
    // 已固定后仍要一致
    pinTrustedGitHostIfAbsent("gitlab.corp.com", "settings");
    expect(
      expectUntrusted(() =>
        assertTrustedGitHost("lib.corp.com", { pinIfAbsent: false }),
      ).code,
    ).toBe("pin-mismatch");
  });

  it("没有固定值且目标是公共托管站：拒绝（GitLab PAT 本来就不该发给它）", () => {
    expect(
      expectUntrusted(() => assertTrustedGitHost("github.com")).code,
    ).toBe("not-candidate");
    expect(hasTrustedGitHostRecord()).toBe(false);
  });

  it("非法 / 空 host 拒绝（code=invalid）", () => {
    for (const bad of ["", "   ", undefined, "a b"]) {
      expect(expectUntrusted(() => assertTrustedGitHost(bad)).code).toBe(
        "invalid",
      );
    }
  });
});

describe("B · 白名单 gitHostAllowlist", () => {
  it("配了白名单：命中放行（含变体）、未命中拒绝并列出白名单；不写固定文件", () => {
    writeConfig({ gitToken: FAKE_TOKEN, [GIT_HOST_ALLOWLIST_KEY]: ["Git.Allow.com", "git2.allow.com:443"] });

    expect(readGitHostAllowlist()).toEqual(["git.allow.com", "git2.allow.com"]);
    expect(assertTrustedGitHost("git.allow.com")).toBe("git.allow.com");
    expect(assertTrustedGitHost("GIT2.allow.com.")).toBe("git2.allow.com");

    const err = expectUntrusted(() => assertTrustedGitHost("evil.example"));
    expect(err.code).toBe("allowlist-miss");
    expect(err.message).toContain("git.allow.com");
    expect(err.message).toContain(GIT_HOST_ALLOWLIST_KEY);
    expect(err.message).toContain("agent 不要自行改动");

    // 白名单独占：不固定、也不写文件
    expect(pinTrustedGitHostIfAbsent("git.allow.com", "boot")).toEqual({
      status: "skipped-allowlist",
    });
    expect(hasTrustedGitHostRecord()).toBe(false);
  });

  it("白名单优先于固定文件：固定文件里的 host 不在白名单内就拒、白名单里的即使与固定值不同也放", () => {
    pinTrustedGitHostIfAbsent("pinned.corp.com", "settings");
    writeConfig({ [GIT_HOST_ALLOWLIST_KEY]: ["listed.corp.com"] });

    expect(assertTrustedGitHost("listed.corp.com")).toBe("listed.corp.com");
    expect(
      expectUntrusted(() => assertTrustedGitHost("pinned.corp.com")).code,
    ).toBe("allowlist-miss");
  });

  it("空数组 / 非数组 / 全是非法条目 / config.json 损坏 → 视作没配、回退固定文件", () => {
    pinTrustedGitHostIfAbsent("pinned.corp.com", "settings");
    for (const cfg of [
      { [GIT_HOST_ALLOWLIST_KEY]: [] },
      { [GIT_HOST_ALLOWLIST_KEY]: "git.allow.com" },
      { [GIT_HOST_ALLOWLIST_KEY]: ["", "u@evil.example", 7] },
      "{ not json",
    ]) {
      writeConfig(cfg);
      expect(readGitHostAllowlist()).toEqual([]);
      expect(assertTrustedGitHost("pinned.corp.com")).toBe("pinned.corp.com");
      expect(
        expectUntrusted(() => assertTrustedGitHost("evil.example")).code,
      ).toBe("pin-mismatch");
    }
  });
});

describe("B · 固定文件损坏 → fail-closed", () => {
  // 取舍：损坏 / 读不出时选「拒发 PAT」而不是「当作未固定、放行并重新固定」——
  // 重新固定等于把「谁先写入」交给攻击者；代价是用户要手动删文件（错误文案给出路径）。
  it.each([
    ["不是合法 JSON", "{ nope"],
    ["JSON 但缺 host", JSON.stringify({ version: 1 })],
    ["host 非法（含 @）", JSON.stringify({ host: "u@evil.example" })],
    ["JSON 数组", JSON.stringify(["gitlab.corp.com"])],
    ["空文件", ""],
  ])("%s：拒绝所有 host（包括看起来一致的），且不会被覆盖", (_name, content) => {
    writePinFile(content);

    expect(readTrustedGitHostPin().status).toBe("corrupt");
    expect(hasTrustedGitHostRecord()).toBe(true);
    for (const h of ["gitlab.corp.com", "evil.example"]) {
      const err = expectUntrusted(() => assertTrustedGitHost(h));
      expect(err.code).toBe("pin-corrupt");
      expect(err.message).toContain(trustedGitHostFilePath());
      expect(err.message).toContain("fail-closed");
    }
    // 重新固定不得覆盖损坏的文件
    expect(pinTrustedGitHostIfAbsent("gitlab.corp.com", "boot").status).toBe(
      "corrupt",
    );
    expect(fs.readFileSync(trustedGitHostFilePath(), "utf-8")).toBe(content);
  });

  it("固定路径被占成目录（读 EISDIR）同样 fail-closed，不当作未固定", () => {
    fs.mkdirSync(trustedGitHostFilePath());
    expect(readTrustedGitHostPin().status).toBe("corrupt");
    expect(expectUntrusted(() => assertTrustedGitHost("gitlab.corp.com")).code).toBe(
      "pin-corrupt",
    );
  });

  it("白名单存在时不看固定文件：损坏的固定文件不影响白名单用户", () => {
    writePinFile("{ nope");
    writeConfig({ [GIT_HOST_ALLOWLIST_KEY]: ["git.allow.com"] });
    expect(assertTrustedGitHost("git.allow.com")).toBe("git.allow.com");
  });
});

// ---------------------------------------------------------------------------
// C. 提示词里展示的 host
// ---------------------------------------------------------------------------

describe("C · resolveGitHostForPrompt", () => {
  it("origin 为空 → 空对象", () => {
    expect(resolveGitHostForPrompt(null)).toEqual({});
    expect(resolveGitHostForPrompt("  ")).toEqual({});
  });

  it("未固定 / 与固定值一致 → 展示 origin host", () => {
    expect(resolveGitHostForPrompt("gitlab.corp.com")).toEqual({
      host: "gitlab.corp.com",
    });
    pinTrustedGitHostIfAbsent("gitlab.corp.com", "settings");
    expect(resolveGitHostForPrompt("GitLab.corp.com:443")).toEqual({
      host: "GitLab.corp.com:443",
    });
  });

  it("origin 被篡改 → 展示可信 host，并带上 untrustedOriginHost（不能让提示词教 agent 向 evil 发 token）", () => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com", "settings");
    expect(resolveGitHostForPrompt("evil.example")).toEqual({
      host: "gitlab.corp.com",
      untrustedOriginHost: "evil.example",
    });
  });

  it("白名单未命中 → 展示白名单；固定文件损坏 → 不展示任何 host", () => {
    writeConfig({ [GIT_HOST_ALLOWLIST_KEY]: ["a.corp.com", "b.corp.com"] });
    expect(resolveGitHostForPrompt("evil.example")).toEqual({
      host: "a.corp.com / b.corp.com",
      untrustedOriginHost: "evil.example",
    });

    writeConfig({});
    writePinFile("{ nope");
    expect(resolveGitHostForPrompt("gitlab.corp.com")).toEqual({
      untrustedOriginHost: "gitlab.corp.com",
    });
  });

  it("纯读：不写固定文件", () => {
    resolveGitHostForPrompt("gitlab.corp.com");
    expect(hasTrustedGitHostRecord()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D. gitlab-client 兜底层：真 client + fetch spy
// ---------------------------------------------------------------------------

describe("D · gitlab-client 兜底：不可信 host 不发任何网络请求", () => {
  const cfgFor = (host: string) => ({ host, token: FAKE_TOKEN });
  const base = { projectPath: "g/r", iid: 7 };

  /** 每个 REST 入口都要过：返回 [名字, 调用] */
  const entries: Array<[string, (host: string) => Promise<{ ok: boolean }>]> = [
    [
      "createMR",
      (host) =>
        createMR({
          config: cfgFor(host),
          projectPath: "g/r",
          sourceBranch: "feat",
          targetBranch: "test",
          title: "t",
          description: "",
          removeSourceBranch: false,
        }),
    ],
    ["getMR", (host) => getMR({ config: cfgFor(host), ...base })],
    ["mergeMR", (host) => mergeMR({ config: cfgFor(host), ...base })],
    [
      "getMRMergeStatus",
      (host) => getMRMergeStatus({ config: cfgFor(host), ...base }),
    ],
    [
      "closeOpenMR（经 findOpenMR）",
      (host) =>
        closeOpenMR({
          config: cfgFor(host),
          projectPath: "g/r",
          sourceBranch: "feat",
          targetBranch: "test",
        }),
    ],
  ];

  it.each(entries)("%s：已固定 A、请求发往 B → ok:false 且 fetch 零调用", async (_n, call) => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com", "settings");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("不该走到网络"));

    const r = (await call("evil.example")) as { ok: boolean; error?: string };

    expect(r.ok).toBe(false);
    expect(r.error).toContain("为防止 GitLab Token 外发已拒绝");
    expect(fetchSpy).not.toHaveBeenCalled();
    // 错误里不能带 token
    expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN);
  });

  it("白名单未命中 → 同样零网络请求", async () => {
    writeConfig({ [GIT_HOST_ALLOWLIST_KEY]: ["gitlab.corp.com"] });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("不该走到网络"));
    const r = await getMR({ config: cfgFor("evil.example"), ...base });
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("固定文件损坏 → 零网络请求（fail-closed）", async () => {
    writePinFile("{ nope");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("不该走到网络"));
    const r = await getMR({ config: cfgFor("gitlab.corp.com"), ...base });
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("同 host（大小写 / 端口变体）放行：请求发往已固定的 host 且带 PAT 头", async () => {
    pinTrustedGitHostIfAbsent("gitlab.corp.com", "settings");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ iid: 7, web_url: "https://gitlab.corp.com/g/r/-/merge_requests/7" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const r = await getMR({ config: cfgFor("GitLab.Corp.com:443"), ...base });

    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/gitlab\.corp\.com\/api\/v4\//);
    expect(JSON.stringify((init as RequestInit).headers)).toContain(FAKE_TOKEN);
  });

  it("没有固定值时首次请求放行并兜底固定；随后发往别的 host 的请求被拒", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ iid: 7 }), { status: 200 }),
    );
    expect((await getMR({ config: cfgFor("gitlab.corp.com"), ...base })).ok).toBe(
      true,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const r = await getMR({ config: cfgFor("evil.example"), ...base });
    expect(r.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// E. 从仓库 origin / settings 固定（真 git 仓）
// ---------------------------------------------------------------------------

describe("E · 从仓库 origin / settings 固定", () => {
  const makeRepo = (remoteUrl: string | null): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fe-trusted-host-repo-"));
    extraDirs.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    if (remoteUrl) {
      execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
    }
    return dir;
  };

  it("pinTrustedGitHostFromRepoPaths：按 origin 推 host 固定；已有记录后直接跳过（不再改）", async () => {
    const a = makeRepo("git@git.corp.com:group/proj.git");
    const b = makeRepo("https://other.example/group/proj.git");

    const first = await pinTrustedGitHostFromRepoPaths([a], "session");
    expect(first).toEqual({ status: "pinned", host: "git.corp.com" });

    // 已有记录：跳过推导，返回 null，固定值不变
    expect(await pinTrustedGitHostFromRepoPaths([b], "session")).toBeNull();
    expect(readTrustedGitHostPin()).toEqual({
      status: "pinned",
      host: "git.corp.com",
    });
  });

  it("多仓分属不同实例 / 没有 origin → 不固定、不抛（留给更具体的时机）", async () => {
    const a = makeRepo("git@a.corp.com:g/p.git");
    const b = makeRepo("git@b.corp.com:g/p.git");
    const none = makeRepo(null);

    expect(await pinTrustedGitHostFromRepoPaths([a, b], "boot")).toBeNull();
    expect(await pinTrustedGitHostFromRepoPaths([none], "boot")).toBeNull();
    expect(hasTrustedGitHostRecord()).toBe(false);
  });

  it("pinTrustedGitHostFromSettings：脚本仓（scriptRepo）不参与，避免它的 origin 抢先固定", async () => {
    const gitlabRepo = makeRepo("git@git.corp.com:g/p.git");
    const scriptRepo = makeRepo("git@scripts.other.example:g/s.git");

    const r = await pinTrustedGitHostFromSettings(
      {
        repos: [
          { path: gitlabRepo },
          { path: scriptRepo, scriptRepo: true },
          { path: "" },
          null,
        ],
      },
      "settings",
    );
    expect(r).toEqual({ status: "pinned", host: "git.corp.com" });
  });

  it("pinTrustedGitHostFromSettings：没有仓库 / repos 不是数组 → null", async () => {
    expect(await pinTrustedGitHostFromSettings({ repos: [] }, "boot")).toBeNull();
    expect(await pinTrustedGitHostFromSettings({ repos: "x" }, "boot")).toBeNull();
    expect(await pinTrustedGitHostFromSettings(null, "boot")).toBeNull();
    expect(hasTrustedGitHostRecord()).toBe(false);
  });

  it("origin 指向 github 的仓不会把 github 固定成可信 host", async () => {
    const gh = makeRepo("git@github.com:me/side-project.git");
    expect(await pinTrustedGitHostFromRepoPaths([gh], "session")).toMatchObject({
      status: "not-candidate",
    });
    expect(hasTrustedGitHostRecord()).toBe(false);
  });
});
