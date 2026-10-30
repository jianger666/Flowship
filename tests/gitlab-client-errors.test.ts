/**
 * Q10-05 / Q10-06：gitlab-client 的错误文案、非 JSON 响应、合并被 405 拒绝时的补查。
 *
 * 行为级：stub 全局 fetch（真 fetchWithGitToken、真 gitlab-client），按 method + url 路由响应；
 * 只放行可信 host 校验（与 mr-merge-sha-guard 同做法）。
 *
 * Q10-05：「合并」失败文案 `405 Method Not Allowed: 405 Method Not Allowed`（状态行 + GitLab 的 message 重复）；
 *         已合并（双击 / 两个窗口 / 别人先合了）也报失败。
 * Q10-06：getMRMergeStatus 的 `res.json()` 在 try 外（200+HTML 直接抛 SyntaxError）；createMR 把 200 非 JSON
 *         说成「网络错误」；message 是数组时显示成 `0: …`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { isMergeShaMismatch } from "@/lib/mr-merge-error";

vi.mock("@/lib/server/trusted-git-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/trusted-git-host")>();
  return { ...actual, assertTrustedGitHost: (host: string) => host };
});

const { closeOpenMR, createMR, getMR, getMRMergeStatus, mergeMR } = await import("@/lib/server/gitlab-client");

const CFG = { host: "gitlab.example.com", token: "tok" };
const MR_WEB_URL = "https://gitlab.example.com/g/r/-/merge_requests/7";

type Req = { url: string; method: string; body: string | undefined };
type Route = (req: Req) => Response | Error | Promise<Response | Error>;

/** stub 全局 fetch：记录每次请求，按 route 回响应（回 Error 就当 fetch 抛） */
const stubFetch = (route: Route): Req[] => {
  const calls: Req[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const req: Req = {
        url,
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? init.body : undefined,
      };
      calls.push(req);
      const r = await route(req);
      if (r instanceof Error) throw r;
      return r;
    }),
  );
  return calls;
};

const json = (status: number, body: unknown, statusText = ""): Response =>
  new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
const html = (status = 200, statusText = ""): Response =>
  new Response("<html><body>请先登录</body></html>", {
    status,
    statusText,
    headers: { "Content-Type": "text/html" },
  });
const mrBody = (state: string, detailed = "mergeable") => ({
  iid: 7,
  web_url: MR_WEB_URL,
  title: "t",
  description: "",
  state,
  source_branch: "feat",
  target_branch: "test",
  detailed_merge_status: detailed,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const getMrError = async (res: Response): Promise<string> => {
  stubFetch(() => res);
  const r = await getMR({ config: CFG, projectPath: "g/r", iid: 7 });
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.error;
};

describe("Q10-05：错误文案不重复状态行", () => {
  it("GitLab 的 405：message 就是状态行 → 只留一份（带 statusText）", async () => {
    expect(
      await getMrError(json(405, { message: "405 Method Not Allowed" }, "Method Not Allowed")),
    ).toBe("405 Method Not Allowed");
  });

  it("HTTP/2 下 statusText 为空：不出现「405 : …」", async () => {
    expect(await getMrError(json(405, { message: "405 Method Not Allowed" }, ""))).toBe(
      "405 Method Not Allowed",
    );
  });

  it("message 恰好就是 statusText → 只留状态行", async () => {
    expect(
      await getMrError(json(405, { message: "Method Not Allowed" }, "Method Not Allowed")),
    ).toBe("405 Method Not Allowed");
  });

  it("message 自己以状态码打头（404 Project Not Found）→ 不叠一层「404 Not Found:」", async () => {
    expect(
      await getMrError(json(404, { message: "404 Project Not Found" }, "Not Found")),
    ).toBe("404 Project Not Found");
  });

  it("普通文案照常拼：状态行 + 冒号 + message（不误删有用信息）", async () => {
    expect(
      await getMrError(json(406, { message: "Branch cannot be merged" }, "Not Acceptable")),
    ).toBe("406 Not Acceptable: Branch cannot be merged");
  });

  it("409 的 sha 守卫文案：仍以 409 开头、isMergeShaMismatch 照样认得（路由靠它给人话）", async () => {
    const msg = await getMrError(
      json(409, { message: "SHA does not match HEAD of source branch" }, "Conflict"),
    );
    expect(msg).toBe("409 Conflict: SHA does not match HEAD of source branch");
    expect(isMergeShaMismatch(msg)).toBe(true);
  });
});

describe("Q10-06：message 是数组 / 对象 / 别的形状", () => {
  it("数组：逐条用「；」拼，不显示成 `0: …`", async () => {
    const msg = await getMrError(json(422, { message: ["标题太长", "源分支不存在"] }, "Unprocessable Entity"));
    expect(msg).toBe("422 Unprocessable Entity: 标题太长；源分支不存在");
    expect(msg).not.toContain("0:");
  });

  it("数组里有对象：序列化而不是 [object Object]", async () => {
    const msg = await getMrError(json(422, { message: ["a", { x: 1 }] }, "Unprocessable Entity"));
    expect(msg).toBe('422 Unprocessable Entity: a；{"x":1}');
  });

  it("数组里的对象最多序列化 200 个字符（超长错误体不会撑爆文案）", async () => {
    const big = { x: "y".repeat(500) };
    const msg = await getMrError(json(422, { message: [big] }, "Unprocessable Entity"));
    expect(msg).toBe(`422 Unprocessable Entity: ${JSON.stringify(big).slice(0, 200)}`);
  });

  it("空数组 / 全是空串：只剩状态行", async () => {
    expect(await getMrError(json(422, { message: [] }, "Unprocessable Entity"))).toBe(
      "422 Unprocessable Entity",
    );
    expect(await getMrError(json(422, { message: ["", null] }, "Unprocessable Entity"))).toBe(
      "422 Unprocessable Entity",
    );
  });

  it("对象（字段级错误）：行为不变", async () => {
    expect(
      await getMrError(
        json(400, { message: { base: ["x", "y"], source_branch: ["z"] } }, "Bad Request"),
      ),
    ).toBe("400 Bad Request: base: x; y | source_branch: z");
  });

  it("error / error_description 与非 JSON 体：行为不变", async () => {
    expect(
      await getMrError(
        json(401, { error: "invalid_token", error_description: "expired" }, "Unauthorized"),
      ),
    ).toBe("401 Unauthorized: invalid_token (expired)");
    expect(await getMrError(html(500, "Internal Server Error"))).toBe(
      "500 Internal Server Error: <non-JSON body>",
    );
    // statusText 为空时状态行不留尾随空格（以前是「500 : …」）
    expect(await getMrError(html(500))).toBe("500: <non-JSON body>");
  });
});

describe("Q10-06：200 + 非 JSON（网关 / 登录页）→ 结构化错误，不抛、不说成「网络错误」", () => {
  const expectUnparsable = (r: { ok: boolean; error?: string }) => {
    expect(r.ok).toBe(false);
    expect(r.error).toContain("无法解析");
    expect(r.error).toContain("HTTP 200");
    expect(r.error).not.toContain("网络错误");
  };

  it("getMRMergeStatus：以前直接抛 SyntaxError（res.json() 在 try 外）", async () => {
    stubFetch(() => html());
    const r = await getMRMergeStatus(
      { config: CFG, projectPath: "g/r", iid: 7 },
      { maxPolls: 1, intervalMs: 0 },
    );
    expectUnparsable(r as { ok: boolean; error?: string });
  });

  it("createMR：以前说「网络错误：Unexpected token <」", async () => {
    stubFetch(() => html());
    const r = await createMR({
      config: CFG,
      projectPath: "g/r",
      sourceBranch: "feat",
      targetBranch: "test",
      title: "t",
      description: "",
      removeSourceBranch: false,
    });
    expectUnparsable(r as { ok: boolean; error?: string });
  });

  it("getMR / mergeMR 同", async () => {
    stubFetch(() => html());
    expectUnparsable(
      (await getMR({ config: CFG, projectPath: "g/r", iid: 7 })) as { ok: boolean; error?: string },
    );
    expectUnparsable(
      (await mergeMR({ config: CFG, projectPath: "g/r", iid: 7 })) as { ok: boolean; error?: string },
    );
  });

  it("createMR 撞 409 后复用现有 MR，复用查询回 200+HTML：退回原始 409 文案（不拿复用失败掩盖真因）", async () => {
    stubFetch((req) =>
      req.method === "POST"
        ? json(409, { message: "Another open merge request already exists for this source branch" }, "Conflict")
        : html(),
    );
    const r = await createMR({
      config: CFG,
      projectPath: "g/r",
      sourceBranch: "feat",
      targetBranch: "test",
      title: "t",
      description: "",
      removeSourceBranch: false,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/^409 Conflict: Another open merge request/);
  });

  it("closeOpenMR（经 findOpenMR 查旧 MR）：查询回 200+HTML → 向上返错、不当成「本来没开」，也不去关任何 MR", async () => {
    const calls = stubFetch(() => html());
    const r = await closeOpenMR({
      config: CFG,
      projectPath: "g/r",
      sourceBranch: "feat",
      targetBranch: "test",
    });
    expectUnparsable(r as { ok: boolean; error?: string });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("读 body 读到一半连接断了（不是 JSON 坏了）：这才是「网络错误」", async () => {
    stubFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200 },
        ),
    );
    const r = await getMR({ config: CFG, projectPath: "g/r", iid: 7 });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toBe("网络错误：terminated");
  });
});

describe("Q10-05：合并被 405 拒绝 → 补查 MR 状态", () => {
  const REFUSED = () => json(405, { message: "405 Method Not Allowed" }, "Method Not Allowed");
  const merge = (sha?: string) =>
    mergeMR({ config: CFG, projectPath: "g/r", iid: 7, ...(sha ? { sha } : {}) });

  /** PUT …/merge → 405；GET …/merge_requests/7 → probe */
  const refusedThenProbe = (probe: () => Response | Error) =>
    stubFetch((req) => (req.method === "PUT" ? REFUSED() : probe()));

  it("已合并（双击 / 两个窗口 / 别人先合了）→ 幂等成功，带 alreadyMerged；url / iid 取自补查结果", async () => {
    const calls = refusedThenProbe(() => json(200, mrBody("merged", "not_open")));
    const r = await merge("abc1234def");
    expect(r).toEqual({ ok: true, url: MR_WEB_URL, iid: 7, alreadyMerged: true });
    // 恰好两次：合并请求 + 补查（带 sha 的合并体照常发出）
    expect(calls.map((c) => c.method)).toEqual(["PUT", "GET"]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ sha: "abc1234def" });
  });

  it("已关闭 → 保留 405 文案并明说「已关闭」", async () => {
    refusedThenProbe(() => json(200, mrBody("closed", "not_open")));
    expect(await merge()).toEqual({
      ok: false,
      error: "405 Method Not Allowed（该 MR 已关闭，无法合并）",
    });
  });

  it.each([
    ["conflict", "有冲突，先解决冲突"],
    ["cannot_be_merged", "有冲突，先解决冲突"],
    ["ci_must_pass", "流水线没通过"],
    ["ci_still_running", "流水线还在跑"],
    ["draft_status", "还是草稿（Draft）"],
    ["discussions_not_resolved", "还有未解决的讨论"],
    ["not_approved", "还没批准"],
    ["blocked_status", "被别的 MR 阻塞"],
    ["need_rebase", "需要先 rebase"],
    ["checking", "GitLab 还在检查可合性，稍后再试"],
    ["unchecked", "GitLab 还在检查可合性，稍后再试"],
    ["preparing", "GitLab 还在检查可合性，稍后再试"],
  ])("仍打开、detailed_merge_status=%s → 追加原因「%s」", async (detailed, why) => {
    refusedThenProbe(() => json(200, mrBody("opened", detailed)));
    expect(await merge()).toEqual({
      ok: false,
      error: `405 Method Not Allowed（${why}）`,
    });
  });

  it("认不出的状态（含看似可合并的 mergeable）：不猜，原样 405 文案", async () => {
    refusedThenProbe(() => json(200, mrBody("opened", "mergeable")));
    expect(await merge()).toEqual({ ok: false, error: "405 Method Not Allowed" });
    refusedThenProbe(() => json(200, mrBody("opened", "constructor")));
    expect(await merge()).toEqual({ ok: false, error: "405 Method Not Allowed" });
  });

  it("补查本身失败（500 / 网络异常 / 200+HTML）：原样返回 GitLab 的 405 文案，不被补查的失败文案顶掉", async () => {
    refusedThenProbe(() => json(500, { message: "boom" }, "Internal Server Error"));
    expect(await merge()).toEqual({ ok: false, error: "405 Method Not Allowed" });
    refusedThenProbe(() => new TypeError("fetch failed"));
    expect(await merge()).toEqual({ ok: false, error: "405 Method Not Allowed" });
    refusedThenProbe(() => html());
    expect(await merge()).toEqual({ ok: false, error: "405 Method Not Allowed" });
  });

  it("只对 405 补查：409（sha 守卫）/ 404 / 500 都不发第二次请求，文案原样", async () => {
    for (const [status, text, message] of [
      [409, "Conflict", "SHA does not match HEAD of source branch"],
      [404, "Not Found", "404 Merge Request Not Found"],
      [500, "Internal Server Error", "boom"],
    ] as const) {
      const calls = stubFetch(() => json(status, { message }, text));
      const r = await merge("abc1234def");
      expect(calls).toHaveLength(1);
      expect(r.ok).toBe(false);
    }
    stubFetch(() => json(409, { message: "SHA does not match HEAD of source branch" }, "Conflict"));
    const r = await merge("abc1234def");
    expect(r).toEqual({ ok: false, error: "409 Conflict: SHA does not match HEAD of source branch" });
    expect(isMergeShaMismatch(r.ok ? "" : r.error)).toBe(true);
  });

  it("合并成功：不带 alreadyMerged（那是「没真的合」的标记）", async () => {
    const calls = stubFetch(() => json(200, { iid: 7, web_url: MR_WEB_URL }));
    const r = await merge();
    expect(r).toEqual({ ok: true, url: MR_WEB_URL, iid: 7 });
    expect(r).not.toHaveProperty("alreadyMerged");
    expect(calls).toHaveLength(1);
  });
});
