/**
 * 共享市场的加载顺序（R14 B6-2 / Q13-05）：先读本地缓存把列表秒出来，再后台同步，同步成功才再读一次。
 *
 * 台账原症状：打开「共享」市场先 `await POST /api/team-library/sync`（git 拉取，断 VPN 时最长 120 秒）才读列表——
 * 这段时间页面没有列表也没有转圈，还会闪出「共享库暂无可安装 action」的错误空态。
 *
 * 分层：
 *   · runTeamLibraryActivation 是纯异步函数，直接测顺序 / 取消 / 失败；
 *   · useTeamLibrary 的 effect 在服务端渲染探针里不执行，所以用 tests/helpers/react-hook-stub.ts 的 dispatcher 桩真跑 hook
 *     （stub 全局 fetch、由测试手动放行每个请求）：测「真 hook 里先发哪个请求」「同步悬挂时列表在不在」
 *     「卸载 / 手动刷新对同步的影响」；
 *   · install-team-actions 的渲染分支没有 DOM 环境，只有源码契约。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deferred, stillPending, type Deferred } from "./helpers/deferred";
import { createHookHarness } from "./helpers/react-hook-stub";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { useTeamLibrary } from "@/hooks/use-team-library";
import {
  runTeamLibraryActivation,
  type TeamLibraryActivationDeps,
} from "@/lib/team-library-activation";

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

describe("runTeamLibraryActivation（加载顺序）", () => {
  const make = (over: Partial<TeamLibraryActivationDeps> = {}) => {
    const log: string[] = [];
    const deps: TeamLibraryActivationDeps = {
      autoSync: true,
      refresh: async () => {
        log.push("refresh");
      },
      sync: async () => {
        log.push("sync");
        return true;
      },
      isCancelled: () => false,
      ...over,
    };
    return { log, deps };
  };

  it("顺序：读缓存 → 后台同步 → 同步成功再读一次", async () => {
    const { log, deps } = make();
    await runTeamLibraryActivation(deps);
    expect(log).toEqual(["refresh", "sync", "refresh"]);
  });

  it("同步一直不返回：第一次读取早已完成（列表不用等同步），整体仍在等；同步放行后补上第二次读取", async () => {
    const log: string[] = [];
    const gate = deferred<boolean>();
    const run = runTeamLibraryActivation({
      autoSync: true,
      refresh: async () => {
        log.push("refresh");
      },
      sync: () => {
        log.push("sync");
        return gate.promise;
      },
      isCancelled: () => false,
    });
    expect(await stillPending(run)).toBe(true);
    expect(log).toEqual(["refresh", "sync"]);
    gate.resolve(true);
    await run;
    expect(log).toEqual(["refresh", "sync", "refresh"]);
  });

  it("同步没成功（返回 false）= 没有新数据，不再读", async () => {
    const { log, deps } = make({
      sync: async () => {
        log.push("sync");
        return false;
      },
    });
    await runTeamLibraryActivation(deps);
    expect(log).toEqual(["refresh", "sync"]);
  });

  it("同步抛错：不往外抛、不再读", async () => {
    const log: string[] = [];
    await expect(
      runTeamLibraryActivation({
        autoSync: true,
        refresh: async () => {
          log.push("refresh");
        },
        sync: async () => {
          log.push("sync");
          throw new Error("git 超时");
        },
        isCancelled: () => false,
      }),
    ).resolves.toBeUndefined();
    expect(log).toEqual(["refresh", "sync"]);
  });

  it("同步期间页面被卸载：同步成功回来也不再读", async () => {
    let cancelled = false;
    const log: string[] = [];
    await runTeamLibraryActivation({
      autoSync: true,
      refresh: async () => {
        log.push("refresh");
      },
      sync: async () => {
        log.push("sync");
        cancelled = true; // 同步在途时页面被卸载 / 切走
        return true;
      },
      isCancelled: () => cancelled,
    });
    expect(log).toEqual(["refresh", "sync"]);
  });

  it("读完缓存时页面已经被卸载：不发起同步", async () => {
    let cancelled = false;
    const log: string[] = [];
    await runTeamLibraryActivation({
      autoSync: true,
      refresh: async () => {
        log.push("refresh");
        cancelled = true;
      },
      sync: async () => {
        log.push("sync");
        return true;
      },
      isCancelled: () => cancelled,
    });
    expect(log).toEqual(["refresh"]);
  });

  it("autoSync=false（Skills 卡）：只读一次，同步从不调用", async () => {
    const { log, deps } = make({ autoSync: false });
    await runTeamLibraryActivation(deps);
    expect(log).toEqual(["refresh"]);
  });
});

type Call = {
  url: string;
  method: string;
  signal: AbortSignal | undefined;
  res: Deferred<Response>;
};
let calls: Call[] = [];

/** 到目前为止发出的请求（按顺序），形如 ["GET /api/team-library", "POST /api/team-library/sync"] */
const sent = (): string[] => calls.map((c) => `${c.method} ${c.url}`);
const call = (i: number): Call => {
  const c = calls[i];
  if (!c) {
    throw new Error(
      `没有第 ${i + 1} 个请求，实际发出：${sent().join(" | ") || "（没有请求）"}`,
    );
  }
  return c;
};
/** 让出一轮宏任务：已就绪的微任务（await fetch → res.json() → setState）都会先跑完 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const STATUS = {
  configured: true,
  cloned: true,
  syncedAt: 1_700_000_000_000,
  needsToken: false,
  canMirror: false,
};
const action = (name: string) => ({
  dirPath: `skills/common/${name}`,
  skillName: name,
  label: name,
  installed: false,
});
const listing = (...names: string[]): Response =>
  new Response(
    JSON.stringify({ ok: true, status: STATUS, actions: names.map(action) }),
    { status: 200 },
  );
const syncOk = (): Response => new Response(JSON.stringify({ ok: true }), { status: 200 });
const failing = (status: number): Response =>
  new Response(JSON.stringify({ error: "boom" }), { status });

beforeEach(() => {
  calls = [];
  toastError.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      const res = deferred<Response>();
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        signal: init?.signal ?? undefined,
        res,
      });
      return res.promise;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 真跑一次 hook：render → 跑 effect；view() 读 useState 槽位的最新值（status / actions / loading） */
const mount = (opts?: { autoSyncOnActive?: boolean }, active = true) => {
  const h = createHookHarness();
  const api = h.render(() => useTeamLibrary(active, opts));
  h.flushEffects();
  const view = () => {
    const [status, actions, loading] = h.states() as [unknown, unknown[], boolean];
    return { status, actions, loading };
  };
  return { h, api, view };
};

describe("useTeamLibrary：真 hook 的加载顺序", () => {
  it("共享市场（autoSyncOnActive）：挂载那一刻先发出的是读缓存的 GET，同步还没发", () => {
    mount({ autoSyncOnActive: true });
    expect(sent()).toEqual(["GET /api/team-library"]);
  });

  it("缓存读完就有列表；同步悬挂期间列表仍在，页面不空白", async () => {
    const { view } = mount({ autoSyncOnActive: true });
    call(0).res.resolve(listing("alpha", "beta"));
    await tick();
    expect(sent()).toEqual(["GET /api/team-library", "POST /api/team-library/sync"]);
    const v = view();
    expect(v.status).not.toBeNull();
    expect(v.actions).toHaveLength(2);
    expect(v.loading).toBe(false);
  });

  it("同步成功：再读一次，换上同步下来的新列表", async () => {
    const { view } = mount({ autoSyncOnActive: true });
    call(0).res.resolve(listing("alpha"));
    await tick();
    call(1).res.resolve(syncOk());
    await tick();
    expect(sent()).toEqual([
      "GET /api/team-library",
      "POST /api/team-library/sync",
      "GET /api/team-library",
    ]);
    call(2).res.resolve(listing("alpha", "gamma"));
    await tick();
    expect(view().actions).toHaveLength(2);
  });

  it.each([
    ["服务端 500", () => call(1).res.resolve(failing(500))],
    ["服务端 409（冲突 / 已有同步在跑）", () => call(1).res.resolve(failing(409))],
    ["网络错误", () => call(1).res.reject(new TypeError("Failed to fetch"))],
  ])("同步失败（%s）：静默，不再读、不弹错，缓存列表照常", async (_title, fail) => {
    const { view } = mount({ autoSyncOnActive: true });
    call(0).res.resolve(listing("alpha"));
    await tick();
    fail();
    await tick();
    expect(sent()).toEqual(["GET /api/team-library", "POST /api/team-library/sync"]);
    expect(toastError).not.toHaveBeenCalled();
    expect(view().actions).toHaveLength(1);
  });

  it("同步在途时卸载：同步被取消；就算同步的响应已经回来了，也不再发第二次读取", async () => {
    const { h } = mount({ autoSyncOnActive: true });
    call(0).res.resolve(listing("alpha"));
    await tick();
    const sync = call(1);
    expect(sync.signal?.aborted).toBe(false);
    h.unmount();
    expect(sync.signal?.aborted).toBe(true);
    sync.res.resolve(syncOk()); // 模拟「取消前响应已经到了」的竞态
    await tick();
    expect(sent()).toEqual(["GET /api/team-library", "POST /api/team-library/sync"]);
  });

  it("读缓存在途时卸载：读取被取消，也不会再发起同步", async () => {
    const { h } = mount({ autoSyncOnActive: true });
    const first = call(0);
    h.unmount();
    expect(first.signal?.aborted).toBe(true);
    first.res.resolve(listing("alpha"));
    await tick();
    expect(sent()).toEqual(["GET /api/team-library"]);
  });

  it("同步在途时手动刷新（比如点了刷新按钮）：同步不会被误取消，同步成功后照样再读一次", async () => {
    const { api } = mount({ autoSyncOnActive: true });
    call(0).res.resolve(listing("alpha"));
    await tick();
    const sync = call(1);
    void api.refresh(); // 手动刷新：refresh 开头会 abort 掉 abortRef 上的旧请求
    expect(sent()).toEqual([
      "GET /api/team-library",
      "POST /api/team-library/sync",
      "GET /api/team-library",
    ]);
    expect(
      sync.signal?.aborted,
      "同步的 signal 不该跟 refresh 共用 abortRef，否则手动刷新会把它取消",
    ).toBe(false);
    call(2).res.resolve(listing("alpha"));
    await tick();
    sync.res.resolve(syncOk());
    await tick();
    expect(sent()).toHaveLength(4);
  });

  it("对照：不带 autoSyncOnActive（Skills 卡）只读一次缓存，从不同步", async () => {
    mount();
    expect(sent()).toEqual(["GET /api/team-library"]);
    call(0).res.resolve(listing("alpha"));
    await tick();
    expect(sent()).toEqual(["GET /api/team-library"]);
  });

  it("对照：active=false（所在 tab 没展示）什么请求都不发", () => {
    mount({ autoSyncOnActive: true }, false);
    expect(sent()).toEqual([]);
  });

  it("对照：读缓存失败时 status 兜底成「未配置」骨架（所以页面用 !status 判转圈不会一直转）", async () => {
    const { view } = mount();
    call(0).res.resolve(failing(500));
    await tick();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(view().status).toEqual({
      configured: false,
      cloned: false,
      syncedAt: null,
      needsToken: true,
      canMirror: false,
    });
  });
});

describe("共享市场页的渲染分支（源码契约：没有 DOM 测试环境）", () => {
  const src = read("src/components/custom-actions/install-team-actions.tsx");

  it("没拿到状态就转圈，不再依赖 loading（读取前那一帧 loading 仍是 false，旧条件会闪出「共享库暂无可安装 action」）", () => {
    expect(src).not.toContain("loading && !status");
    expect(src).toMatch(/\{!status \? \(\s*<LoadingState variant="inline" \/>/);
    expect(src).not.toMatch(/const \{[^}]*\bloading\b[^}]*\} = useTeamLibrary/);
  });
});

describe("useTeamLibrary 激活 effect 的依赖（源码契约：hook 桩不比较依赖，只能钉文本）", () => {
  it("依赖含 autoSyncOnActive：Skills 卡（只读）与共享市场（自动同步）要按各自的值重跑", () => {
    const src = read("src/hooks/use-team-library.ts");
    expect(src).toContain("}, [active, refresh, opts?.autoSyncOnActive]);");
  });
});
