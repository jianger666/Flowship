/**
 * R8-01 / R8-02：收件箱「忽略 / 撤销忽略 / 已忽略列表」端到端行为（真实路由 handler + 真实 scanner，
 * 只 mock 外部 meegle / settings / gitlab）。
 *
 * R8-01：忽略会把 url 记进 scanner 的 recentMutations（10 分钟）；撤销若不清它，
 *        重扫结果仍被过滤、撤销 10 分钟内看起来无效。
 * R8-02：忽略存储向后兼容地带上条目简要信息；旧数据（纯时间戳）照常读、缺字段时只剩 url。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MR_URL = "https://gitlab.corp.com/g/r/-/merge_requests/9";
const OTHER_MR_URL = "https://gitlab.corp.com/g/r/-/merge_requests/10";

vi.mock("@/lib/server/meegle-cli", () => {
  class MeegleError extends Error {
    constructor(
      public readonly kind: "not_installed" | "not_authed" | "error",
      message: string,
    ) {
      super(message);
    }
  }
  return {
    MeegleError,
    fetchMyUserKey: vi.fn(async () => "u1"),
    meegleAuthStatus: vi.fn(async () => ({
      installed: true,
      authenticated: true,
      host: "meegle.example.com",
    })),
    fetchUserSchedule: vi.fn(async () => [{ id: "1001", name: "需求 A" }]),
    fetchWorkitemNodes: vi.fn(async () => [{ name: "测试", status: "doing" }]),
    fetchWorkitemComments: vi.fn(async () => [
      {
        id: "c1",
        content: `请测 ${MR_URL} 和 ${OTHER_MR_URL}`,
        createdAtMs: 1_700_000_000_000,
      },
    ]),
    queryWorkitemsByMql: vi.fn(async () => ({})),
  };
});

vi.mock("@/lib/server/settings-fs", () => ({
  // qa：扫待测 MR + 待回归；无 gitToken → 不调 getMR
  readSettingsFile: vi.fn(async () => ({
    status: "ok",
    settings: { userRole: "qa" },
  })),
}));

vi.mock("@/lib/server/gitlab-client", () => ({ getMR: vi.fn() }));
vi.mock("@/lib/server/submit-mr-guard", () => ({
  deriveHostFromRepo: vi.fn(async () => null),
}));

import * as ignoreRoute from "@/app/api/mr-inbox/ignore/route";
import * as inboxRoute from "@/app/api/mr-inbox/route";
import { dataRoot } from "@/lib/server/data-root";

const ignoredFile = (): string =>
  path.join(dataRoot(), "mr-inbox-ignored.json");

const jsonReq = (method: string, body: unknown): Request =>
  new Request("http://localhost/api/mr-inbox/ignore", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const scan = async (): Promise<string[]> => {
  const res = await inboxRoute.GET(
    new Request("http://localhost/api/mr-inbox?refresh=1"),
  );
  const body = (await res.json()) as {
    status: string;
    pendingMr: { mrUrl: string }[];
  };
  expect(body.status).toBe("ok");
  return body.pendingMr.map((m) => m.mrUrl).sort();
};

beforeEach(async () => {
  // scanner 的进程全局态（缓存 + recentMutations）每个用例清零
  delete (globalThis as Record<string, unknown>)["__flowshipMrInbox__"];
  await fs.rm(ignoredFile(), { force: true });
});

describe("R8-01 撤销忽略后立即重扫必须能拿回条目", () => {
  it("POST 忽略 → 扫描不含；DELETE 撤销 → 强制重扫又含（recentMutations 已清）", async () => {
    expect(await scan()).toEqual([MR_URL, OTHER_MR_URL].sort());

    const ign = await ignoreRoute.POST(jsonReq("POST", { url: MR_URL }));
    expect(ign.status).toBe(200);
    expect(await scan()).toEqual([OTHER_MR_URL]);

    const undo = await ignoreRoute.DELETE(jsonReq("DELETE", { url: MR_URL }));
    expect(undo.status).toBe(200);
    expect(await scan()).toEqual([MR_URL, OTHER_MR_URL].sort());
  });

  it("撤销只放行自己：另一条仍忽略的不受影响", async () => {
    await ignoreRoute.POST(jsonReq("POST", { url: MR_URL }));
    await ignoreRoute.POST(jsonReq("POST", { url: OTHER_MR_URL }));
    expect(await scan()).toEqual([]);

    await ignoreRoute.DELETE(jsonReq("DELETE", { url: MR_URL }));
    expect(await scan()).toEqual([MR_URL]);
  });
});

describe("R8-02 已忽略列表 + 向后兼容的 meta", () => {
  it("忽略时带的 meta 能从 GET 列表读回；撤销后从列表消失", async () => {
    await ignoreRoute.POST(
      jsonReq("POST", {
        url: MR_URL,
        meta: { title: "修复登录", group: "pendingMr", ref: "g/r!9" },
      }),
    );
    const list = (await (await ignoreRoute.GET()).json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      url: MR_URL,
      title: "修复登录",
      group: "pendingMr",
      ref: "g/r!9",
    });
    expect(typeof list.items[0]!.at).toBe("number");

    await ignoreRoute.DELETE(jsonReq("DELETE", { url: MR_URL }));
    const after = (await (await ignoreRoute.GET()).json()) as {
      items: unknown[];
    };
    expect(after.items).toEqual([]);
  });

  it("旧格式文件（url → 纯时间戳）照常生效：扫描被过滤、列表只有 url + at", async () => {
    const at = Date.now() - 1000;
    await fs.mkdir(path.dirname(ignoredFile()), { recursive: true });
    await fs.writeFile(ignoredFile(), JSON.stringify({ [MR_URL]: at }));

    expect(await scan()).toEqual([OTHER_MR_URL]);
    const list = (await (await ignoreRoute.GET()).json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(list.items).toEqual([{ url: MR_URL, at }]);
  });

  it("新旧混存：新增带 meta 的忽略不破坏旧条目", async () => {
    const at = Date.now() - 5000;
    await fs.mkdir(path.dirname(ignoredFile()), { recursive: true });
    await fs.writeFile(ignoredFile(), JSON.stringify({ [MR_URL]: at }));

    await ignoreRoute.POST(
      jsonReq("POST", { url: OTHER_MR_URL, meta: { title: "新条目" } }),
    );
    const list = (await (await ignoreRoute.GET()).json()) as {
      items: Array<{ url: string; at: number; title?: string }>;
    };
    // 最近忽略的在前
    expect(list.items.map((i) => i.url)).toEqual([OTHER_MR_URL, MR_URL]);
    expect(list.items[0]!.title).toBe("新条目");
    expect(list.items[1]).toEqual({ url: MR_URL, at });
    expect(await scan()).toEqual([]);
  });

  it("meta 被服务端清洗：未知字段 / 非法 group / 超长标题", async () => {
    await ignoreRoute.POST(
      jsonReq("POST", {
        url: MR_URL,
        meta: {
          title: "x".repeat(500),
          group: "evil",
          ref: 123,
          extra: "<script>",
        },
      }),
    );
    const list = (await (await ignoreRoute.GET()).json()) as {
      items: Array<Record<string, unknown>>;
    };
    const item = list.items[0]!;
    expect((item.title as string).length).toBe(200);
    expect(item).not.toHaveProperty("group");
    expect(item).not.toHaveProperty("ref");
    expect(item).not.toHaveProperty("extra");
  });

  it("重复忽略且未传 meta：沿用旧 meta", async () => {
    await ignoreRoute.POST(
      jsonReq("POST", { url: MR_URL, meta: { title: "旧标题" } }),
    );
    await ignoreRoute.POST(jsonReq("POST", { url: MR_URL }));
    const list = (await (await ignoreRoute.GET()).json()) as {
      items: Array<{ title?: string }>;
    };
    expect(list.items[0]!.title).toBe("旧标题");
  });
});
