/**
 * R21-02：再次提测复用已有 MR 时，MR 的标题 / 描述要真的更新（否则测试人员点开永远是第一版）。
 *
 * 行为级：stub 全局 fetch（真 fetchWithGitToken、真 gitlab-client），按 method + url 路由响应；
 * 只放行可信 host 校验（与 gitlab-client-errors 同做法）。
 *
 * 覆盖：
 * - 默认（不传 updateExistingOnReuse）：只复用、一个 PUT 都不发——team-library 等调用方行为不变
 * - 打开后：409 → 列表查到旧 MR → PUT `/merge_requests/:iid`，body **只含 title / description**（不带 state_event 等别的字段）
 * - 只发真正变了的字段；实质相同（CRLF / 首尾空白不同）不发请求；空串不覆盖（不会把现有描述清空）
 * - 更新失败不当失败：MR 照样 ok，带回 updated:false + updateError（让 AI 如实写进 artifact）
 * - 新建成功（201）路径不受影响、结果里没有 updated 字段
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/trusted-git-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/trusted-git-host")>();
  return { ...actual, assertTrustedGitHost: (host: string) => host };
});

const { createMR } = await import("@/lib/server/gitlab-client");

const CFG = { host: "gitlab.example.com", token: "tok" };
const MR_WEB_URL = "https://gitlab.example.com/g/r/-/merge_requests/7";

type Req = { url: string; method: string; body: string | undefined };
type Route = (req: Req) => Response | Error | Promise<Response | Error>;

/** stub 全局 fetch：记录每次请求，按 route 回响应 */
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

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const isList = (r: Req): boolean => r.method === "GET" && r.url.includes("/merge_requests?");
const isPut = (r: Req): boolean => r.method === "PUT";

/** 路由：POST 建 MR 撞 409；GET 列表回一条现有 MR；PUT 更新回 putRes */
const reuseRoute =
  (existing: { title?: unknown; description?: unknown }, putRes: () => Response | Error): Route =>
  (req) => {
    if (req.method === "POST") {
      return json(409, { message: ["Another open merge request already exists for this source branch: !7"] });
    }
    if (isList(req)) return json(200, [{ iid: 7, web_url: MR_WEB_URL, ...existing }]);
    if (isPut(req)) return putRes();
    return new Error(`unexpected ${req.method} ${req.url}`);
  };

const input = (over: Partial<Parameters<typeof createMR>[0]> = {}): Parameters<typeof createMR>[0] => ({
  config: CFG,
  projectPath: "g/r",
  sourceBranch: "feat",
  targetBranch: "test",
  title: "[前端] 需求 v2",
  description: "旧描述\n\n## v2 更新（2026-11-14）\n- 改了 X",
  removeSourceBranch: false,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("复用已有 MR 时更新标题 / 描述（updateExistingOnReuse）", () => {
  it("默认关：只复用、不发任何 PUT；结果就是 { ok, url, iid }（team-library 等调用方行为不变）", async () => {
    const calls = stubFetch(reuseRoute({ title: "旧标题", description: "旧描述" }, () => json(200, {})));
    const r = await createMR(input());
    expect(r).toEqual({ ok: true, url: MR_WEB_URL, iid: 7 });
    expect(calls.filter(isPut)).toHaveLength(0);
  });

  it("打开：标题和描述都变了 → 一个 PUT /merge_requests/7，body 只含 title + description", async () => {
    const calls = stubFetch(reuseRoute({ title: "[前端] 需求 v1", description: "旧描述" }, () => json(200, {})));
    const r = await createMR(input({ updateExistingOnReuse: true }));

    expect(r).toEqual({ ok: true, url: MR_WEB_URL, iid: 7, updated: true });
    const puts = calls.filter(isPut);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toMatch(/\/projects\/g%2Fr\/merge_requests\/7$/);
    const body = JSON.parse(puts[0]!.body!) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["description", "title"]);
    expect(body.title).toBe("[前端] 需求 v2");
    expect(body.description).toBe("旧描述\n\n## v2 更新（2026-11-14）\n- 改了 X");
  });

  it("只发真正变了的字段：标题没变、描述变了 → body 里只有 description", async () => {
    const calls = stubFetch(reuseRoute({ title: "[前端] 需求 v2", description: "旧描述" }, () => json(200, {})));
    const r = await createMR(input({ updateExistingOnReuse: true }));

    expect(r).toMatchObject({ ok: true, updated: true });
    const body = JSON.parse(calls.find(isPut)!.body!) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["description"]);
  });

  it("实质相同（CRLF / 首尾空白不同）不发请求：updated:false，没有 updateError", async () => {
    const same = "旧描述\n\n## v2 更新（2026-11-14）\n- 改了 X";
    const calls = stubFetch(
      reuseRoute({ title: "  [前端] 需求 v2 ", description: `${same.replace(/\n/g, "\r\n")}\r\n` }, () => json(200, {})),
    );
    const r = await createMR(input({ updateExistingOnReuse: true }));

    expect(r).toEqual({ ok: true, url: MR_WEB_URL, iid: 7, updated: false });
    expect(calls.filter(isPut)).toHaveLength(0);
  });

  it("空串不覆盖：description 传空、标题变了 → 只更新标题，不会把现有描述清空", async () => {
    const calls = stubFetch(reuseRoute({ title: "旧标题", description: "旧描述" }, () => json(200, {})));
    const r = await createMR(input({ updateExistingOnReuse: true, description: "   " }));

    expect(r).toMatchObject({ ok: true, updated: true });
    const body = JSON.parse(calls.find(isPut)!.body!) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["title"]);
  });

  it("标题 / 描述都传空：不发 PUT", async () => {
    const calls = stubFetch(reuseRoute({ title: "旧标题", description: "旧描述" }, () => json(200, {})));
    const r = await createMR(input({ updateExistingOnReuse: true, title: "", description: "" }));

    expect(r).toEqual({ ok: true, url: MR_WEB_URL, iid: 7, updated: false });
    expect(calls.filter(isPut)).toHaveLength(0);
  });

  it("现有 MR 的 title / description 缺失或为 null：按空串比较，照常更新", async () => {
    const calls = stubFetch(reuseRoute({ title: null, description: null }, () => json(200, {})));
    const r = await createMR(input({ updateExistingOnReuse: true }));

    expect(r).toMatchObject({ ok: true, updated: true });
    expect(calls.filter(isPut)).toHaveLength(1);
  });

  it("更新被拒（403）：不当失败——MR 照样 ok，带回 updated:false + updateError（含原因）", async () => {
    stubFetch(
      reuseRoute({ title: "旧标题", description: "旧描述" }, () => json(403, { message: "403 Forbidden" })),
    );
    const r = await createMR(input({ updateExistingOnReuse: true }));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toBe(MR_WEB_URL);
    expect(r.iid).toBe(7);
    expect(r.updated).toBe(false);
    expect(r.updateError).toContain("403");
  });

  it("更新时网络错误：同样不抛、不当失败", async () => {
    stubFetch(reuseRoute({ title: "旧标题", description: "旧描述" }, () => new Error("socket hang up")));
    const r = await createMR(input({ updateExistingOnReuse: true }));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.updated).toBe(false);
    expect(r.updateError).toBeTruthy();
  });

  it("全新建 MR（201）不受影响：不查列表、不发 PUT，结果里没有 updated 字段", async () => {
    const calls = stubFetch((req) =>
      req.method === "POST" ? json(201, { iid: 8, web_url: MR_WEB_URL.replace("/7", "/8") }) : new Error("unexpected"),
    );
    const r = await createMR(input({ updateExistingOnReuse: true }));

    expect(r).toEqual({ ok: true, url: MR_WEB_URL.replace("/7", "/8"), iid: 8 });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("409 但查不到现有 MR（别的验证错误）：仍退回原始错误，不去更新任何东西", async () => {
    const calls = stubFetch((req) => {
      if (req.method === "POST") return json(409, { message: "source branch does not exist" });
      if (isList(req)) return json(200, []);
      return new Error("unexpected");
    });
    const r = await createMR(input({ updateExistingOnReuse: true }));

    expect(r.ok).toBe(false);
    expect(calls.filter(isPut)).toHaveLength(0);
  });
});
