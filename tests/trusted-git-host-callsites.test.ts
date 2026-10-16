/**
 * GitLab PAT 只发往可信 host：各 PAT 出站「调用点」的真实入口测试（S02-03 / S03-03）
 *
 * tests/trusted-git-host.test.ts 钉了校验逻辑本身与 gitlab-client 兜底层；本文件钉的是
 * 「每个调用点都真的在构造请求之前先校验」——
 *
 * 攻击场景统一成：可信 host 已固定为 gitlab.corp.com，但 origin 被改 / 评论里塞了链接，
 * 于是「本地 allowlist（来自 origin 推导）」被带偏、已经放行了 evil.example。
 * 此时只有可信 host 校验能挡住 PAT 外发。
 *
 * gitlab-client 在这里是「包装真实现的 spy」：
 *   - `spy not called`  → 证明**调用点自己**拦住了（撤掉调用点校验这条会变红）；
 *   - `fetch spy 零调用` → 证明最终一个请求都没发出（含兜底层）。
 *
 * 入口：mr-inbox-scanner.getMRWithHostAllowlist / bypass-merge-mr.mergeTestMrForBypass /
 *      POST /api/mr-inbox/merge / team-library（getTeamLibraryStatus 的 canMirror 探测、
 *      ensureRepoAt 的 git 网络操作、checkGitEgressTrusted）。
 *      submit_mr 在 tests/session-git-trust.test.ts（要整套会话 harness）。
 * 全程只用假 token，数据目录是临时目录。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fe-trusted-callsites-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

/** deriveHostFromRepo 的返回值（= 仓库 origin 推导出的 host）：测试里想让它被「篡改」就改这个 */
const origin = vi.hoisted(() => ({ host: "gitlab.corp.com" as string | null }));

vi.mock("@/lib/server/submit-mr-guard", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deriveHostFromRepo: vi.fn(async () => origin.host),
}));

vi.mock("@/lib/server/gitlab-client", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/lib/server/gitlab-client");
  return {
    ...actual,
    getMR: vi.fn(actual.getMR),
    mergeMR: vi.fn(actual.mergeMR),
    createMR: vi.fn(actual.createMR),
  };
});

const gitlabClient = await import("@/lib/server/gitlab-client");
const { getMRWithHostAllowlist } = await import("@/lib/server/mr-inbox-scanner");
const { mergeTestMrForBypass } = await import("@/lib/server/bypass-merge-mr");
const { POST: mergeRoutePost } = await import("@/app/api/mr-inbox/merge/route");
const teamLibrary = await import("@/lib/server/team-library");
const trusted = await import("@/lib/server/trusted-git-host");

const getMRSpy = gitlabClient.getMR as unknown as ReturnType<typeof vi.fn>;
const mergeMRSpy = gitlabClient.mergeMR as unknown as ReturnType<typeof vi.fn>;

const FAKE_TOKEN = "glpat-FAKE-CALLSITE-TOKEN";
const PINNED = "gitlab.corp.com";
const EVIL = "evil.example";
const EVIL_MR = `https://${EVIL}/g/r/-/merge_requests/9`;
const GOOD_MR = `https://${PINNED}/g/r/-/merge_requests/9`;
const SETTINGS = {
  gitToken: FAKE_TOKEN,
  repos: [{ path: "/repo/shop", testBranch: "test", onlineBranch: "master" }],
};

const writeConfig = (obj: unknown): void => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "config.json"), JSON.stringify(obj));
};

/** 一个看起来正常的 GitLab MR JSON（getMR / mergeMR 都够用） */
const okMrResponse = (): Response =>
  new Response(
    JSON.stringify({
      iid: 9,
      web_url: GOOD_MR,
      title: "t",
      description: "",
      state: "opened",
      source_branch: "feat",
      target_branch: "test",
      detailed_merge_status: "mergeable",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  origin.host = PINNED;
  // 可信 host 已固定
  trusted.pinTrustedGitHostIfAbsent(PINNED, "settings");
  // 任何真实网络请求都会让用例直接失败——「零调用」断言才有意义
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => okMrResponse());
});

afterAll(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

// ---------------------------------------------------------------------------
// 1. MR 收件箱扫描：getMRWithHostAllowlist
// ---------------------------------------------------------------------------

describe("mr-inbox-scanner.getMRWithHostAllowlist", () => {
  it("评论里的 MR 链接指向 evil host、且 allowlist 被带偏放行了它 → 调用点自己拦住，getMR / fetch 零调用", async () => {
    const r = await getMRWithHostAllowlist({
      mrUrl: EVIL_MR,
      gitToken: FAKE_TOKEN,
      allowedHosts: new Set([EVIL]), // origin 被改后推导出的名单
    });

    expect(r.ok).toBe(false);
    const err = (r as { error: string }).error;
    expect(err).toContain(PINNED);
    expect(err).toContain("为防止 GitLab Token 外发已拒绝");
    // 不带 skipped：让收件箱行上能看见原因，而不是静默跳过
    expect(r).not.toHaveProperty("skipped");
    expect(getMRSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN);
  });

  it("白名单配置（gitHostAllowlist）不含该 host 同样拦住", async () => {
    trusted.pinTrustedGitHostIfAbsent(PINNED, "settings");
    writeConfig({ gitHostAllowlist: ["other.corp.com"] });
    const r = await getMRWithHostAllowlist({
      mrUrl: GOOD_MR,
      gitToken: FAKE_TOKEN,
      allowedHosts: new Set([PINNED]),
    });
    expect(r.ok).toBe(false);
    expect(getMRSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("可信 host 的 MR（大小写变体）正常放行：发一次带 PAT 的请求、发往规范化后的 host", async () => {
    const r = await getMRWithHostAllowlist({
      mrUrl: `https://GitLab.Corp.COM/g/r/-/merge_requests/9`,
      gitToken: FAKE_TOKEN,
      allowedHosts: new Set([PINNED]),
    });

    expect(r.ok).toBe(true);
    expect(getMRSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/gitlab\.corp\.com\/api\/v4\//);
    expect(JSON.stringify((init as RequestInit).headers)).toContain(FAKE_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// 2. 旁路合 test MR：mergeTestMrForBypass
// ---------------------------------------------------------------------------

describe("bypass-merge-mr.mergeTestMrForBypass", () => {
  it("origin 被改成 evil → allowlist 放行了 evil 链接，仍被可信 host 校验拦住；getMR / mergeMR / fetch 零调用", async () => {
    writeConfig(SETTINGS);
    origin.host = EVIL; // 仓库 origin 被改 → allowlist = {evil}

    const r = await mergeTestMrForBypass(EVIL_MR);

    expect(r.ok).toBe(false);
    expect(r.text).toContain("合 test MR 失败");
    expect(r.text).toContain(PINNED);
    expect(r.text).toContain("为防止 GitLab Token 外发已拒绝");
    expect(getMRSpy).not.toHaveBeenCalled();
    expect(mergeMRSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.text).not.toContain(FAKE_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// 3. 收件箱合并 route：POST /api/mr-inbox/merge
// ---------------------------------------------------------------------------

describe("POST /api/mr-inbox/merge", () => {
  const post = (mrUrl: string): Promise<Response> =>
    mergeRoutePost(
      new Request("http://localhost/api/mr-inbox/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mrUrl }),
      }),
    );

  it("origin 被改 + 评论链接指向 evil → 400、mergeMR / fetch 零调用", async () => {
    writeConfig(SETTINGS);
    origin.host = EVIL;

    const res = await post(EVIL_MR);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(PINNED);
    expect(body.error).toContain("为防止 GitLab Token 外发已拒绝");
    expect(mergeMRSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(FAKE_TOKEN);
  });

  it("可信 host 的 MR 正常合并（证明校验没有误杀）", async () => {
    writeConfig(SETTINGS);
    origin.host = PINNED;

    const res = await post(GOOD_MR);

    expect(res.status).toBe(200);
    expect(mergeMRSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(
      /^https:\/\/gitlab\.corp\.com\/api\/v4\/.*\/merge$/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. 共享库（team-library）：host 来自配置、只校验不固定
// ---------------------------------------------------------------------------

describe("team-library：PAT 出站点", () => {
  const writeTeamConfig = (cfg: Record<string, string>): void => {
    fs.writeFileSync(path.join(DATA_DIR, "team-library.json"), JSON.stringify(cfg));
  };

  it("canMirror 探测（getTeamLibraryStatus）：知识库源仓不在可信 host → 不发探测请求、canMirror=false", async () => {
    writeConfig({ gitToken: `${FAKE_TOKEN}-probe-evil` });
    writeTeamConfig({
      repoUrl: `https://${PINNED}/lib/hub.git`,
      knowledgeSourceUrl: `https://${EVIL}/g/kb.git`,
    });

    const status = await teamLibrary.getTeamLibraryStatus();

    expect(status.canMirror).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("canMirror 探测：源仓在可信 host → 正常探测（证明没误杀）", async () => {
    writeConfig({ gitToken: `${FAKE_TOKEN}-probe-good` });
    writeTeamConfig({
      repoUrl: `https://${PINNED}/lib/hub.git`,
      knowledgeSourceUrl: `https://${PINNED}/g/kb.git`,
    });

    const status = await teamLibrary.getTeamLibraryStatus();

    expect(status.canMirror).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain(
      `https://${PINNED}/api/v4/projects/`,
    );
  });

  it("共享库不决定可信 host：没有固定值时放行但不写固定文件（它的 host 来自配置、不是可信时机）", async () => {
    fs.rmSync(trusted.trustedGitHostFilePath(), { force: true });
    writeConfig({ gitToken: `${FAKE_TOKEN}-probe-unpinned` });
    writeTeamConfig({
      repoUrl: `https://lib.example.org/lib/hub.git`,
      knowledgeSourceUrl: `https://lib.example.org/g/kb.git`,
    });

    const status = await teamLibrary.getTeamLibraryStatus();

    expect(status.canMirror).toBe(true);
    expect(trusted.hasTrustedGitHostRecord()).toBe(false);
  });

  describe("git 网络操作（runGit 闸口）", () => {
    // NodeJS.ProcessEnv 在 Next 类型补丁下 NODE_ENV 必填，普通对象要先过 unknown
    const GIT_ENV = {
      [teamLibrary.GIT_TOKEN_ENV]: FAKE_TOKEN,
    } as unknown as NodeJS.ProcessEnv;

    const makeRepo = (originUrl: string | null): string => {
      const dir = fs.mkdtempSync(path.join(TMP_ROOT, "repo-"));
      execFileSync("git", ["init", "-q"], { cwd: dir });
      if (originUrl) {
        execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: dir });
      }
      return dir;
    };

    it("clone 目标 URL 不在可信 host → ensureRepoAt 拒绝、不建目录、不起 git", async () => {
      const dir = path.join(TMP_ROOT, "never-cloned");

      const r = await teamLibrary.ensureRepoAt({
        dir,
        cleanUrl: `https://${EVIL}/g/hub.git`,
        branch: "main",
        token: FAKE_TOKEN,
      });

      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toContain(
        "为防止 GitLab Token 外发已拒绝",
      );
      expect((r as { error: string }).error).toContain(PINNED);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("已有本地仓、cleanUrl 指向 evil → fetch 前被拒（错误是我们的拒绝文案、不是网络错误）", async () => {
      const dir = makeRepo(`https://${PINNED}/g/hub.git`);

      const r = await teamLibrary.ensureRepoAt({
        dir,
        cleanUrl: `https://${EVIL}/g/hub.git`,
        branch: "main",
        token: FAKE_TOKEN,
      });

      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toContain(
        "为防止 GitLab Token 外发已拒绝",
      );
    });

    it("checkGitEgressTrusted：没显式 URL 时读 cwd 仓的 origin——origin 被改成 evil 会被拦", async () => {
      const dir = makeRepo(`https://${EVIL}/g/hub.git`);
      const msg = await teamLibrary.checkGitEgressTrusted(
        ["fetch", "--no-tags", "origin", "+refs/heads/members:refs/remotes/origin/members"],
        dir,
        GIT_ENV,
      );
      expect(msg).toContain("为防止 GitLab Token 外发已拒绝");
      expect(msg).toContain(PINNED);
    });

    it("checkGitEgressTrusted：可信 origin / 本地路径 origin / 没带 PAT 的本地操作 / 无 origin 都放行", async () => {
      const good = makeRepo(`https://${PINNED}/g/hub.git`);
      const local = makeRepo(path.join(TMP_ROOT, "some-bare.git"));
      const none = makeRepo(null);
      const evil = makeRepo(`https://${EVIL}/g/hub.git`);
      const fetchArgs = ["fetch", "origin", "main"];

      expect(await teamLibrary.checkGitEgressTrusted(fetchArgs, good, GIT_ENV)).toBeNull();
      expect(await teamLibrary.checkGitEgressTrusted(fetchArgs, local, GIT_ENV)).toBeNull();
      expect(await teamLibrary.checkGitEgressTrusted(fetchArgs, none, GIT_ENV)).toBeNull();
      // 没带 PAT env 的操作（rev-parse / set-url / reset …）不管、不起额外子进程
      expect(await teamLibrary.checkGitEgressTrusted(["rev-parse", "HEAD"], evil, undefined)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// 5. 共享库：端口也是可信 host 的一部分（P3）
//    从 URL 取 host 曾用 URL.hostname 把端口丢了：`https://gitlab.corp.com:8443/…` 被当成已固定的
//    `gitlab.corp.com` 放行——同机另一个端口上的服务就能拿到 PAT。这里钉的是三个出站点
//    （canMirror 探测 / ensureRepoAt / checkGitEgressTrusted）真的按「主机名 + 端口」判断。
// ---------------------------------------------------------------------------

describe("team-library：端口是可信 host 的一部分（P3）", () => {
  const writeTeamConfig = (cfg: Record<string, string>): void => {
    fs.writeFileSync(path.join(DATA_DIR, "team-library.json"), JSON.stringify(cfg));
  };
  const GIT_ENV = {
    [teamLibrary.GIT_TOKEN_ENV]: FAKE_TOKEN,
  } as unknown as NodeJS.ProcessEnv;
  const REFUSED = "为防止 GitLab Token 外发已拒绝";
  const PORT_HINT = "白名单要写带端口的 host";

  let tokenSeq = 0;
  /** 每次用新 token：canMirror 探测结果有 TTL 缓存（key 含 token 摘要），共用 token 会串用例 */
  const probeStatus = async (
    knowledgeSourceUrl: string,
    extraConfig: Record<string, unknown> = {},
  ) => {
    writeConfig({ gitToken: `${FAKE_TOKEN}-port-${++tokenSeq}`, ...extraConfig });
    writeTeamConfig({ repoUrl: `https://${PINNED}/lib/hub.git`, knowledgeSourceUrl });
    return teamLibrary.getTeamLibraryStatus();
  };

  const makeRepo = (originUrl: string): string => {
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, "port-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: dir });
    return dir;
  };

  describe("canMirror 探测（REST 出站）", () => {
    it("已固定 gitlab.corp.com（443）：同主机 :8443 的源仓 → 不探测、canMirror=false（以前会被放行）", async () => {
      const status = await probeStatus(`https://${PINNED}:8443/g/kb.git`);

      expect(status.canMirror).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("已固定 gitlab.corp.com（443）：显式 :443 与省略等价 → 正常探测，请求 URL 不带 :443", async () => {
      const status = await probeStatus(`https://${PINNED}:443/g/kb.git`);

      expect(status.canMirror).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]![0])).toMatch(
        new RegExp(`^https://${PINNED.replace(/\./g, "\\.")}/api/v4/projects/`),
      );
    });

    it("白名单写带端口的 host：探测请求真的发往该端口；默认端口的源仓不在白名单内 → 不探测", async () => {
      const allowlist = { gitHostAllowlist: [`${PINNED}:8443`] };

      const ok = await probeStatus(`https://${PINNED}:8443/g/kb.git`, allowlist);
      expect(ok.canMirror).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // 请求目的地 = 校验通过的那个 host:port（不能验 :8443 却发往 443）
      expect(String(fetchSpy.mock.calls[0]![0])).toContain(`https://${PINNED}:8443/api/v4/projects/`);

      fetchSpy.mockClear();
      const bad = await probeStatus(`https://${PINNED}/g/kb.git`, allowlist);
      expect(bad.canMirror).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("白名单写纯 hostname：带非默认端口的源仓被严格拒绝（不探测）", async () => {
      const status = await probeStatus(`https://${PINNED}:8443/g/kb.git`, {
        gitHostAllowlist: [PINNED],
      });

      expect(status.canMirror).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("git 网络操作（runGit 闸口）", () => {
    it("ensureRepoAt：同主机不同端口 → 拒绝、不建目录；白名单写纯 hostname 时文案提示「白名单要写带端口的 host」", async () => {
      const dir = path.join(TMP_ROOT, "never-cloned-port");

      // 已固定模式：pin-mismatch 文案点破同主机名不同端口
      const pinned = await teamLibrary.ensureRepoAt({
        dir,
        cleanUrl: `https://${PINNED}:8443/g/hub.git`,
        branch: "main",
        token: FAKE_TOKEN,
      });
      expect(pinned.ok).toBe(false);
      expect((pinned as { error: string }).error).toContain(REFUSED);
      expect((pinned as { error: string }).error).toContain("同一主机名但端口不同");
      expect(fs.existsSync(dir)).toBe(false);

      // 白名单模式：纯 hostname 只表示 443
      writeConfig({ gitHostAllowlist: [PINNED] });
      const listed = await teamLibrary.ensureRepoAt({
        dir,
        cleanUrl: `https://${PINNED}:8443/g/hub.git`,
        branch: "main",
        token: FAKE_TOKEN,
      });
      expect(listed.ok).toBe(false);
      expect((listed as { error: string }).error).toContain(REFUSED);
      expect((listed as { error: string }).error).toContain(PORT_HINT);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it.each([
      // 已固定 gitlab.corp.com（https 443）：默认端口写法放行，其余（含 http 默认的 80）拒绝
      ["https://gitlab.corp.com/g/hub.git", true],
      ["https://gitlab.corp.com:443/g/hub.git", true],
      ["http://gitlab.corp.com:443/g/hub.git", true], // http 里写 443 = 连 443 那个服务
      ["https://gitlab.corp.com:8443/g/hub.git", false],
      ["https://gitlab.corp.com:80/g/hub.git", false],
      ["http://gitlab.corp.com/g/hub.git", false], // http 默认 80 ≠ 已固定的 443
      ["http://gitlab.corp.com:80/g/hub.git", false],
    ])("checkGitEgressTrusted（已固定 443）：%s → %s", async (url, allowed) => {
      const msg = await teamLibrary.checkGitEgressTrusted(["clone", url, "/tmp/x"], undefined, GIT_ENV);

      if (allowed) expect(msg).toBeNull();
      else expect(msg).toContain(REFUSED);
    });

    it("checkGitEgressTrusted：origin 被改成同主机另一个端口 → 被拦（读 origin 路径也比端口）", async () => {
      const dir = makeRepo(`https://${PINNED}:8443/g/hub.git`);
      const msg = await teamLibrary.checkGitEgressTrusted(
        ["fetch", "--no-tags", "origin", "main"],
        dir,
        GIT_ENV,
      );
      expect(msg).toContain(REFUSED);
      expect(msg).toContain("同一主机名但端口不同");
    });

    it.each([
      // 白名单 gitlab.corp.com:80：http 默认端口各自正确——http 的 80 命中，https 的 443 不命中
      [["gitlab.corp.com:80"], "http://gitlab.corp.com/g/hub.git", true],
      [["gitlab.corp.com:80"], "https://gitlab.corp.com/g/hub.git", false],
      [["gitlab.corp.com:80"], "https://gitlab.corp.com:80/g/hub.git", true],
      // 白名单 gitlab.corp.com:8443：scheme 无关，只看端口
      [["gitlab.corp.com:8443"], "https://gitlab.corp.com:8443/g/hub.git", true],
      [["gitlab.corp.com:8443"], "http://gitlab.corp.com:8443/g/hub.git", true],
      [["gitlab.corp.com:8443"], "https://gitlab.corp.com/g/hub.git", false],
      // 白名单纯 hostname = 443：带非默认端口严格拒
      [["gitlab.corp.com"], "https://gitlab.corp.com:8443/g/hub.git", false],
      [["gitlab.corp.com"], "https://GitLab.Corp.com:443/g/hub.git", true],
      // IPv6 字面量
      [["[::1]:8443"], "https://[::1]:8443/g/hub.git", true],
      [["[::1]:8443"], "http://[::1]:8443/g/hub.git", true],
      [["[::1]:8443"], "https://[::1]/g/hub.git", false],
      [["[::1]:8443"], "https://[::1]:9443/g/hub.git", false],
    ] as Array<[string[], string, boolean]>)(
      "checkGitEgressTrusted（白名单 %j）：%s → %s",
      async (allowlist, url, allowed) => {
        writeConfig({ gitHostAllowlist: allowlist });
        const msg = await teamLibrary.checkGitEgressTrusted(["clone", url, "/tmp/x"], undefined, GIT_ENV);

        if (allowed) expect(msg).toBeNull();
        else {
          expect(msg).toContain(REFUSED);
          // 被拒地址带端口时，文案必须告诉用户白名单怎么写
          if (/:\d+\//.test(url) && !/:443\//.test(url)) expect(msg).toContain(PORT_HINT);
        }
      },
    );

    it("ssh:// 的端口是 ssh 自己的端口：不参与 https 端口比较（只比主机名）", async () => {
      // args 里的 ssh:// 不会被 runGit 当 http(s) 目的地；这里直接验 origin 为 ssh 时按主机名放行
      const dir = makeRepo(`ssh://git@${PINNED}:2222/g/hub.git`);
      expect(
        await teamLibrary.checkGitEgressTrusted(["fetch", "origin", "main"], dir, GIT_ENV),
      ).toBeNull();
    });
  });
});
