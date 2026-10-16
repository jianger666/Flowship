/**
 * GitLab PAT 不跟随重定向：逐个出站点验证（真 http server，A 302 → B，B 永远收不到 PAT）
 *
 * 出站点清单（带 PAT 的）：
 *   fetch 侧（统一走 fetchWithGitToken，`redirect: "error"`）：
 *     gitlab-client.ts：findOpenMR（经 closeOpenMR）/ createMR / closeMR（经 closeOpenMR）/ getMRMergeStatus / getMR / mergeMR
 *     team-library.ts：getGitLabUploadIdentity、probeCanMirror（经 getTeamLibraryStatus）
 *   git 子进程侧（team-library.ts 的 buildAuthedGitArgs）：clone / fetch / push / ls-remote
 *     → `-c http.followRedirects=false`（git 默认 initial 会跟首个 3xx、并按新 host 重新向 inline helper 要凭据）
 *
 * 为什么能在本机 http 上测：gitlab-client 写死 `https://`、host 校验又只认 allowlist / 固定文件。
 * 做法：host 校验走现有 seam（config.json 的 gitHostAllowlist 放行 127.0.0.1[:port]），
 * 再用 fetch spy 把 `https://127.0.0.1…` 改写成指向 A 的 `http://`，然后**调用真 fetch**（init 原样保留，
 * 包括 `redirect`）——生产代码不为测试加任何 seam，重定向行为由真 undici 决定。
 *
 * 回退自检：把 fetchWithGitToken 里的 `redirect: "error"` 去掉 → fetch 侧所有「B 收不到」用例变红；
 * 把 buildAuthedGitArgs 里的 `http.followRedirects=false` 去掉 → git 用例变红（B 会收到 Authorization）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fe-gitlab-redirect-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const {
  closeOpenMR,
  createMR,
  getMR,
  getMRMergeStatus,
  mergeMR,
} = await import("@/lib/server/gitlab-client");
const teamLibrary = await import("@/lib/server/team-library");

const FAKE_TOKEN = "glpat-FAKE-REDIRECT-CLIENT-0001";

type Recorded = { method: string; url: string; headers: http.IncomingHttpHeaders };
type Srv = { server: http.Server; port: number; requests: Recorded[] };

const listen = async (
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<Srv> => {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    req.resume();
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, requests };
};

let a: Srv;
let b: Srv;
/** A 的行为：默认全部 302 → B；个别用例改成「先 200 再重定向」 */
let aMode: "redirect" | "ok" | "list-ok-then-redirect" = "redirect";

beforeAll(async () => {
  // B：「别的 host」——对 GitLab 请求回 401（让 git 的 credential helper 有机会被触发），记录一切
  b = await listen((_req, res) => {
    res.writeHead(401, { "www-authenticate": 'Basic realm="other"', "content-type": "text/plain" });
    res.end("no");
  });
  a = await listen((req, res) => {
    const url = req.url ?? "";
    const isList = req.method === "GET" && /\/merge_requests\?/.test(url);
    if (aMode === "ok" || (aMode === "list-ok-then-redirect" && isList)) {
      res.writeHead(200, { "content-type": "application/json" });
      if (/\/api\/v4\/user$/.test(url)) {
        res.end(JSON.stringify({ id: 1, username: "u" }));
      } else if (isList) {
        res.end(JSON.stringify([{ web_url: "https://x/mr/7", iid: 7 }]));
      } else if (/\/merge_requests\/\d+$/.test(url) || /\/merge$/.test(url)) {
        res.end(
          JSON.stringify({
            iid: 9,
            web_url: "https://x/mr/9",
            title: "t",
            description: "",
            state: "opened",
            source_branch: "feat",
            target_branch: "test",
            detailed_merge_status: "mergeable",
          }),
        );
      } else {
        res.end("{}");
      }
      return;
    }
    // 保留原 path + query 重定向到 B：git 只接受「以原 info/refs?service=… 结尾」的重定向目标，
    // 指到别的路径它会自己报 unable to update url base 就放弃——那样回退（去掉 followRedirects=false）时
    // 测试也是绿的，什么都没证明
    res.writeHead(302, { location: `http://127.0.0.1:${b.port}${url}` });
    res.end();
  });
});

afterAll(async () => {
  for (const s of [a, b]) {
    s.server.closeAllConnections?.();
    await new Promise<void>((r) => s.server.close(() => r()));
  }
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

const writeConfig = (obj: Record<string, unknown>): void => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "config.json"), JSON.stringify(obj));
};

let realFetch: typeof fetch;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  aMode = "redirect";
  a.requests.length = 0;
  b.requests.length = 0;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  // 放行 loopback：gitlab-client 的 host 带端口（127.0.0.1:PORT），team-library / git 用 URL 的 hostname（127.0.0.1）
  writeConfig({ gitHostAllowlist: [`127.0.0.1:${a.port}`, "127.0.0.1"] });
  realFetch = globalThis.fetch;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    // 生产代码里写死 https://host[:port]/…；统一改写成本机 A 的 http 地址，init（含 redirect）原样交给真 fetch
    const rewritten = String(input).replace(
      /^https:\/\/127\.0\.0\.1(?::\d+)?\//,
      `http://127.0.0.1:${a.port}/`,
    );
    return realFetch(rewritten, init);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const config = (): { host: string; token: string } => ({
  host: `127.0.0.1:${a.port}`,
  token: FAKE_TOKEN,
});
const tokenSeenByB = (): boolean =>
  b.requests.some((r) => JSON.stringify(r.headers).includes(FAKE_TOKEN));

/** 每个入口共用的断言：失败、文案说明被重定向、B 没收到任何请求、所有出站 fetch 都是 redirect:"error" */
const expectRefused = (r: { ok: boolean; error?: string }): void => {
  expect(r.ok).toBe(false);
  expect(r.error).toContain("重定向");
  expect(r.error).toContain("GitLab Token");
  expect(r.error).not.toContain(FAKE_TOKEN);
  expect(b.requests).toHaveLength(0);
  expect(tokenSeenByB()).toBe(false);
  expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
  for (const call of fetchSpy.mock.calls) {
    expect((call[1] as RequestInit | undefined)?.redirect).toBe("error");
  }
};

describe("gitlab-client：6 个 REST 入口都不跟随重定向", () => {
  it("对照：A 正常响应时 getMR 成功（证明 spy 改写 + allowlist 接线有效，不是「连不上」造成的假通过）", async () => {
    aMode = "ok";
    const r = await getMR({ config: config(), projectPath: "g/r", iid: 9 });
    expect(r.ok).toBe(true);
    expect(a.requests).toHaveLength(1);
    expect(a.requests[0]!.headers["private-token"]).toBe(FAKE_TOKEN);
  });

  it("createMR（POST）", async () => {
    const r = await createMR({
      config: config(),
      projectPath: "g/r",
      sourceBranch: "feat",
      targetBranch: "test",
      title: "t",
      description: "",
      removeSourceBranch: false,
    });
    expectRefused(r);
  });

  it("getMR", async () => {
    expectRefused(await getMR({ config: config(), projectPath: "g/r", iid: 9 }));
  });

  it("mergeMR（PUT）", async () => {
    expectRefused(await mergeMR({ config: config(), projectPath: "g/r", iid: 9 }));
  });

  it("getMRMergeStatus", async () => {
    expectRefused(
      await getMRMergeStatus({ config: config(), projectPath: "g/r", iid: 9 }, { maxPolls: 1, intervalMs: 1 }),
    );
  });

  it("closeOpenMR → findOpenMR（GET 列表）", async () => {
    expectRefused(
      await closeOpenMR({
        config: config(),
        projectPath: "g/r",
        sourceBranch: "feat",
        targetBranch: "test",
      }),
    );
  });

  it("closeOpenMR → closeMR（PUT 关闭）：列表正常、关闭这一步被重定向", async () => {
    aMode = "list-ok-then-redirect";
    const r = await closeOpenMR({
      config: config(),
      projectPath: "g/r",
      sourceBranch: "feat",
      targetBranch: "test",
    });
    expectRefused(r);
    // 列表那一跳确实走通了（A 收到 GET 列表 + PUT 关闭两个请求）
    expect(a.requests.map((q) => q.method)).toEqual(["GET", "PUT"]);
  });
});

describe("team-library：fetch 出站点", () => {
  const writeTeamConfig = (cfg: Record<string, string>): void => {
    fs.writeFileSync(path.join(DATA_DIR, "team-library.json"), JSON.stringify(cfg));
  };

  it("canMirror 探测（getTeamLibraryStatus）：被重定向 → canMirror=false、B 收不到 PAT、留一行告警日志（不含 token）", async () => {
    const token = `${FAKE_TOKEN}-mirror-redirect`;
    writeConfig({ gitToken: token, gitHostAllowlist: ["127.0.0.1"] });
    writeTeamConfig({
      repoUrl: `https://127.0.0.1/lib/hub.git`,
      knowledgeSourceUrl: `https://127.0.0.1/g/kb.git`,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const status = await teamLibrary.getTeamLibraryStatus();

    expect(status.canMirror).toBe(false);
    expect(b.requests).toHaveLength(0);
    expect(JSON.stringify(b.requests)).not.toContain(token);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("被重定向"))).toBe(true);
    expect(warn.mock.calls.some((c) => c.some((x) => String(x).includes(token)))).toBe(false);
    for (const call of fetchSpy.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.redirect).toBe("error");
    }
  });

  it("对照：canMirror 探测 A 正常 200 → canMirror=true（接线有效）", async () => {
    const token = `${FAKE_TOKEN}-mirror-ok`;
    aMode = "ok";
    writeConfig({ gitToken: token, gitHostAllowlist: ["127.0.0.1"] });
    writeTeamConfig({
      repoUrl: `https://127.0.0.1/lib/hub.git`,
      knowledgeSourceUrl: `https://127.0.0.1/g/kb2.git`,
    });
    const status = await teamLibrary.getTeamLibraryStatus();
    expect(status.canMirror).toBe(true);
  });
});

describe("静态护栏：新增带 PAT 的出站点不能绕过统一出口", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const SRC = path.join(process.cwd(), "src");

  it("凡是以 `PRIVATE-TOKEN` 为请求头 key 的文件：只准用 fetchWithGitToken、不得出现裸 fetch(", () => {
    const offenders: string[] = [];
    const carriers: string[] = [];
    for (const f of walk(SRC)) {
      const code = stripComments(fs.readFileSync(f, "utf-8"));
      if (!/["']PRIVATE-TOKEN["']\s*:/.test(code)) continue;
      carriers.push(path.relative(SRC, f));
      // 裸 fetch( ：前面不是标识符 / 点 / $（排除 fetchWithGitToken(、globalThis.fetch( 另算）
      if (/(?<![\w$.])fetch\(/.test(code) || /globalThis\.fetch\(/.test(code)) {
        offenders.push(path.relative(SRC, f));
      }
      if (!/fetchWithGitToken/.test(code)) offenders.push(`${path.relative(SRC, f)}（未使用 fetchWithGitToken）`);
    }
    // 已知携带者必须被扫到，否则正则失效、护栏形同虚设
    expect(carriers).toEqual(
      expect.arrayContaining(["lib/server/gitlab-client.ts", "lib/server/team-library.ts"]),
    );
    expect(offenders).toEqual([]);
  });

  it("凡是配置 inline credential helper 的文件：必须同时关掉 git 的重定向跟随", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const f of walk(SRC)) {
      const code = stripComments(fs.readFileSync(f, "utf-8"));
      // 模板串里 `credential.helper=${INLINE_CREDENTIAL_HELPER}` 这种「真带凭据」的 helper；
      // 单独的 `credential.helper=`（清空全局 helper）不算
      if (!/credential\.helper=\$\{/.test(code)) continue;
      seen += 1;
      if (!code.includes("http.followRedirects=false")) offenders.push(path.relative(SRC, f));
    }
    expect(seen).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});

describe("team-library 的 git 子进程：http.followRedirects=false", () => {
  it("buildAuthedGitArgs 带 `-c http.followRedirects=false`，且 `-c` 在子命令之前", () => {
    const args = teamLibrary.buildAuthedGitArgs(["fetch", "origin", "main"]);
    const i = args.indexOf("http.followRedirects=false");
    expect(i).toBeGreaterThan(0);
    expect(args[i - 1]).toBe("-c");
    expect(i).toBeLessThan(args.indexOf("fetch"));
  });

  it("真 git：clone 可信 host（A）被 302 到 B → 失败带清晰提示，B 永远收不到 Authorization（PAT）", async () => {
    const origTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0"; // 万一回退到旧行为，别因为交互式输入凭据而挂住
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      const dir = path.join(TMP_ROOT, "clone-target");
      const r = await teamLibrary.ensureRepoAt({
        dir,
        cleanUrl: `http://127.0.0.1:${a.port}/g/r.git`,
        branch: "main",
        token: FAKE_TOKEN,
      });
      // 关键断言放最前：B 没收到带凭据的请求（Basic 的 Authorization 就是 oauth2:<PAT> 的 base64）
      const b64 = Buffer.from(`oauth2:${FAKE_TOKEN}`).toString("base64");
      expect(b.requests.filter((q) => q.headers.authorization)).toEqual([]);
      expect(JSON.stringify(b.requests)).not.toContain(b64);
      expect(tokenSeenByB()).toBe(false);
      // 然后才是失败形态：失败 + 清晰提示 + 不残留目录 + 文案不含 token
      expect(r.ok).toBe(false);
      const err = (r as { error: string }).error;
      expect(err).toContain("clone 失败");
      expect(err).toContain("重定向");
      expect(err).not.toContain(FAKE_TOKEN);
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      if (origTerminalPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
      else process.env.GIT_TERMINAL_PROMPT = origTerminalPrompt;
    }
  }, 60_000);
});
