/**
 * 收件箱「合并 MR」带 sha 守卫（审查 GAP3-02）。
 *
 * 用户在收件箱看到「可合并」，那是几分钟前的扫描缓存；作者随后又推了新提交，点合并会把没看过的改动一并合进目标分支。
 * GitLab 合并 API 支持 `sha`：带上则只在源分支 HEAD 仍是它时才合并，否则 409。这里钉死整条链：
 *   getMR 取回 headSha → 扫描结果 mr.headSha → 前端 mergeMr(url, sha) → 路由校验 → mergeMR 请求体带 sha；
 *   被拒（HEAD 不匹配）时给人话 409；不带 sha 时行为不变。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// 只测请求体：可信 host 校验（首次绑定 / 白名单，落盘）放行，fetch 用 stub 接住
vi.mock("@/lib/server/trusted-git-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/trusted-git-host")>();
  return { ...actual, assertTrustedGitHost: (host: string) => host };
});

const { mergeMR } = await import("@/lib/server/gitlab-client");

const read = (rel: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

describe("mergeMR 请求体", () => {
  const run = async (sha?: string) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ iid: 7, web_url: "https://gitlab.example.com/g/r/-/merge_requests/7" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    try {
      return {
        result: await mergeMR({
          config: { host: "gitlab.example.com", token: "tok" },
          projectPath: "g/r",
          iid: 7,
          ...(sha ? { sha } : {}),
        }),
        calls,
      };
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("带 sha：PUT 请求体含 sha", async () => {
    const { calls } = await run("abc1234def5678");
    const put = calls.find((c) => c.init.method === "PUT");
    expect(put).toBeDefined();
    expect(put!.url).toMatch(/\/merge_requests\/7\/merge$/);
    expect(JSON.parse(String(put!.init.body))).toEqual({ sha: "abc1234def5678" });
  });

  it("不带 sha：请求体仍是 {}（旧行为不变）", async () => {
    const { calls } = await run();
    const put = calls.find((c) => c.init.method === "PUT");
    expect(put).toBeDefined();
    expect(JSON.parse(String(put!.init.body))).toEqual({});
  });
});

describe("链路接线（源码契约）", () => {
  it("gitlab-client：getMR 回 headSha（body.sha）；mergeMR 把 sha 放进请求体、缺省仍 {}", () => {
    const src = read("src/lib/server/gitlab-client.ts");
    expect(src).toContain("headSha?: string;");
    expect(src).toMatch(/\.\.\.\(typeof body\?\.sha === "string" && body\.sha \? \{ headSha: body\.sha \} : \{\}\)/);
    expect(src).toContain("body: JSON.stringify(input.sha ? { sha: input.sha } : {}),");
  });

  it("扫描：两处构造 mr 详情都带 headSha（有才带，不污染没有 sha 的旧数据）", () => {
    const src = read("src/lib/server/mr-inbox-scanner.ts");
    expect(src).toContain("...(mr.headSha ? { headSha: mr.headSha } : {}),");
    expect(src).toContain("...(r.headSha ? { headSha: r.headSha } : {}),");
    expect(read("src/lib/mr-inbox.ts")).toContain("headSha?: string;");
  });

  it("前端：hook 把 sha 放进请求体；共享合并 hook 把 headSha 传给 mergeMr；两个合并按钮都把 entry.mr 的 headSha 交给它", () => {
    expect(read("src/hooks/use-mr-inbox.tsx")).toContain(
      "body: JSON.stringify(sha ? { mrUrl, sha } : { mrUrl }),",
    );
    // B5-3 去重：两个合并按钮共用 hooks/use-merge-mr.ts，mergeMr 只在这一处被调、必须带 headSha
    const action = read("src/hooks/use-merge-mr.ts");
    expect(action).toContain("await mergeMr(target.mrUrl, target.headSha);");
    expect(action).not.toMatch(/await mergeMr\(target\.mrUrl\);/);
    const panel = read("src/components/mr-inbox/mr-inbox-panel.tsx");
    // 面板不再直接调 mergeMr（那样就绕过了共享 hook 的 sha / 防重入 / 提示）
    expect(panel).not.toMatch(/\bmergeMr\(/);
    // 两处都把 entry.mr 的 headSha 交出去（待测 MR 行 mr 可能为 null → ?.；待回归行已判空 → .）
    expect(panel).toContain("headSha: entry.mr?.headSha,");
    expect(panel).toContain("headSha: entry.mr.headSha,");
  });

  it("路由：sha 只接受 7–64 位十六进制；传给 mergeMR；HEAD 不匹配回 409 人话，其余失败仍 502", () => {
    const src = read("src/app/api/mr-inbox/merge/route.ts");
    expect(src).toContain("/^[0-9a-f]{7,64}$/i");
    expect(src).toContain("...(sha ? { sha } : {}),");
    expect(src).toMatch(/if \(sha && isMergeShaMismatch\(result\.error\)\)/);
    expect(src).toContain("409,");
    expect(src).toContain("return errorResponse(result.error, 502);");
  });
});

describe("isMergeShaMismatch：文案 + 状态码两路识别（不依赖 GitLab 文案）", () => {
  it("GitLab 文案（各种措辞）命中", async () => {
    const { isMergeShaMismatch } = await import("@/lib/mr-merge-error");
    expect(isMergeShaMismatch("409 Conflict: SHA does not match HEAD of source branch")).toBe(true);
    expect(isMergeShaMismatch("Conflict: sha mismatch")).toBe(true);
    expect(isMergeShaMismatch("HEAD of source branch changed")).toBe(true);
  });

  it("文案变了、但状态码是 409 → 照样命中（兜底）", async () => {
    const { isMergeShaMismatch } = await import("@/lib/mr-merge-error");
    expect(isMergeShaMismatch("409 Conflict: 源分支已经变化")).toBe(true);
    expect(isMergeShaMismatch("409 Conflict")).toBe(true);
    expect(isMergeShaMismatch("  409 Conflict: x")).toBe(true);
  });

  it("其它失败不误判：405 / 406 / 422 / 网络错误 / 中途出现 409 字样", async () => {
    const { isMergeShaMismatch } = await import("@/lib/mr-merge-error");
    expect(isMergeShaMismatch("405 Method Not Allowed: Branch cannot be merged")).toBe(false);
    expect(isMergeShaMismatch("406 Not Acceptable: Branch cannot be merged")).toBe(false);
    expect(isMergeShaMismatch("422 Unprocessable Entity: x")).toBe(false);
    expect(isMergeShaMismatch("fetch failed")).toBe(false);
    expect(isMergeShaMismatch("500 Internal Server Error: request id 4091")).toBe(false);
    expect(isMergeShaMismatch("4090 something")).toBe(false);
  });
});
