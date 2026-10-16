/**
 * fetchWithGitToken：带 GitLab PAT 的出站请求不跟随重定向（真 undici + 两个本机 http server）
 *
 * 威胁：`assertTrustedGitHost` 只校验「第一跳」。可信 host（或其前面的反向代理 / 被劫持的 DNS）
 * 回一个 302 → 别的 host，Node fetch（undici）跨源重定向只剔 Authorization / Cookie，
 * **自定义头 `PRIVATE-TOKEN` 会原样带过去**——PAT 就发给了没校验过的 host。
 *
 * 这里不 mock fetch：用两个真 http server（A 302 → B），B 记录收到的所有请求头，
 * 钉住 B 永远收不到 PAT。第 1 条「对照」证明漏洞前提在当前运行时成立（裸 fetch 默认会带过去），
 * 没有它，后面的「收不到」可能只是因为本来就不会泄漏、测试什么也没证明。
 *
 * 各 REST 入口（gitlab-client / team-library / git 子进程）逐个验证见 tests/gitlab-client-redirect.test.ts。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  fetchWithGitToken,
  GitHostRedirectError,
} from "@/lib/server/trusted-git-host";

const FAKE_TOKEN = "glpat-FAKE-REDIRECT-TOKEN-0001";

type Recorded = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

const listen = async (
  handler: (req: http.IncomingMessage, res: http.ServerResponse, rec: Recorded) => void,
): Promise<{ server: http.Server; port: number; requests: Recorded[] }> => {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const rec: Recorded = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      requests.push(rec);
      handler(req, res, rec);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, requests };
};

let a: Awaited<ReturnType<typeof listen>>;
let b: Awaited<ReturnType<typeof listen>>;
/** A 的重定向状态码：每个用例可改 */
let redirectStatus = 302;

beforeAll(async () => {
  // B：「别的 host」。只记录、回 200
  b = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  // A：「可信 host」。/ok 正常回 200，其它一律重定向到 B
  a = await listen((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, echo: req.headers["private-token"] ?? null }));
      return;
    }
    res.writeHead(redirectStatus, { location: `http://127.0.0.1:${b.port}/stolen` });
    res.end();
  });
});

afterAll(async () => {
  for (const s of [a, b]) {
    s.server.closeAllConnections?.();
    await new Promise<void>((r) => s.server.close(() => r()));
  }
});

beforeEach(() => {
  a.requests.length = 0;
  b.requests.length = 0;
  redirectStatus = 302;
});

const urlA = (p: string): string => `http://127.0.0.1:${a.port}${p}`;
const tokenInHeaders = (reqs: Recorded[]): boolean =>
  reqs.some((r) => JSON.stringify(r.headers).includes(FAKE_TOKEN));

describe("fetchWithGitToken：跨源重定向不带走 PAT", () => {
  it("对照：裸 fetch（默认 follow）会把自定义头 PRIVATE-TOKEN 带给重定向目标——这就是要堵的洞", async () => {
    const res = await fetch(urlA("/redir"), { headers: { "PRIVATE-TOKEN": FAKE_TOKEN } });
    expect(res.status).toBe(200);
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.headers["private-token"]).toBe(FAKE_TOKEN);
  });

  it("A 302 → B：抛 GitHostRedirectError，B 一个请求都没收到（更不会有 PAT）", async () => {
    const err = await fetchWithGitToken(urlA("/redir"), {
      headers: { "PRIVATE-TOKEN": FAKE_TOKEN },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitHostRedirectError);
    expect(b.requests).toHaveLength(0);
    expect(tokenInHeaders(b.requests)).toBe(false);
    // A 收到了第一跳（这一跳本来就是校验过的可信 host，PAT 发给它是预期的）
    expect(a.requests).toHaveLength(1);
  });

  it.each([301, 302, 303, 307, 308])("状态码 %i 同样拒绝跟随", async (code) => {
    redirectStatus = code;
    await expect(
      fetchWithGitToken(urlA("/redir"), { headers: { "PRIVATE-TOKEN": FAKE_TOKEN } }),
    ).rejects.toBeInstanceOf(GitHostRedirectError);
    expect(b.requests).toHaveLength(0);
  });

  it("POST / PUT 带 body 的写请求（建 MR / 合并）同样不跟随——307/308 会重放 body", async () => {
    for (const code of [307, 308]) {
      redirectStatus = code;
      await expect(
        fetchWithGitToken(urlA("/redir"), {
          method: "POST",
          headers: { "PRIVATE-TOKEN": FAKE_TOKEN, "content-type": "application/json" },
          body: JSON.stringify({ title: "x" }),
        }),
      ).rejects.toBeInstanceOf(GitHostRedirectError);
    }
    expect(b.requests).toHaveLength(0);
  });

  it("调用方在 init 里写 redirect:'follow' 也不能绕过（统一在 helper 里覆盖）", async () => {
    await expect(
      fetchWithGitToken(urlA("/redir"), {
        headers: { "PRIVATE-TOKEN": FAKE_TOKEN },
        redirect: "follow",
      }),
    ).rejects.toBeInstanceOf(GitHostRedirectError);
    expect(b.requests).toHaveLength(0);
  });

  it("错误文案清晰：说明被重定向、不跟随是为了保护 Token、给出排查方向；不含 token", async () => {
    const err = (await fetchWithGitToken(urlA("/redir"), {
      headers: { "PRIVATE-TOKEN": FAKE_TOKEN },
    }).catch((e: unknown) => e)) as GitHostRedirectError;
    expect(err.name).toBe("GitHostRedirectError");
    expect(err.message).toContain("重定向");
    expect(err.message).toContain("GitLab Token");
    expect(err.message).toMatch(/http→https|域名迁移|反向代理/);
    expect(err.message).not.toContain(FAKE_TOKEN);
    expect(err.message).not.toContain(`127.0.0.1:${b.port}`);
  });

  it("没有重定向时行为不变：状态、响应体、请求头原样（证明没误伤正常请求）", async () => {
    const res = await fetchWithGitToken(urlA("/ok"), {
      method: "GET",
      headers: { "PRIVATE-TOKEN": FAKE_TOKEN },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, echo: FAKE_TOKEN });
  });

  it("不是重定向的失败（连不上）原样抛出，不被误包装成 GitHostRedirectError", async () => {
    // 先占一个端口再关掉，保证 ECONNREFUSED
    const tmp = await listen(() => {});
    const dead = tmp.port;
    await new Promise<void>((r) => tmp.server.close(() => r()));
    const err = await fetchWithGitToken(`http://127.0.0.1:${dead}/x`, {
      headers: { "PRIVATE-TOKEN": FAKE_TOKEN },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GitHostRedirectError);
  });
});
