/**
 * 设置保存链（CR-08）+ repos dirty 完整比较（CR-09）
 *
 * 回归点（旧实现上失败）：
 * - saveSettings：服务端 500 时旧实现照样返 true（fire-and-forget）、修后返 false
 * - 并发保存：旧实现无队列、两个 PUT 同时在飞可能后发先至被旧对象覆盖；
 *   修后严格串行——前一个响应没回来、下一个请求不发出
 * - isFieldEqual("repos") 旧实现只比 path/name、分支 / 模板 / 预览命令改了 dirty 恒 false
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// ---- 模拟最小浏览器环境（local-store 的 isBrowser 闸门；settings 不再双写 localStorage）----
const localStorageStub = {
  store: new Map<string, string>(),
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  },
  removeItem(key: string): void {
    this.store.delete(key);
  },
};
(globalThis as unknown as { window: unknown }).window = {
  localStorage: localStorageStub,
};

import {
  DEFAULT_SETTINGS,
  getSettings,
  getSettingsUnreadable,
  initSettings,
  normalizeSettings,
  saveSettings,
} from "@/lib/local-store";
import { isFieldEqual, repoConfigEquals } from "@/hooks/use-settings";
import type { FeAiFlowSettings, RepoConfig } from "@/lib/types";

// 可控 fetch stub：记录调用、由测试手动放行响应
interface PendingCall {
  body: unknown;
  resolve: (res: Response) => void;
}
let pendingCalls: PendingCall[] = [];
/** GET /api/settings/full 返回的「磁盘真值」（对账用；默认就是默认配置） */
let diskSnapshot: unknown = DEFAULT_SETTINGS;
/** 非 null 时 GET /full 不立刻返回、把放行函数推进来（让测试卡在「对账 GET 在飞」这一刻） */
let heldGets: Array<() => void> | null = null;

const okResponse = (): Response =>
  new Response(JSON.stringify({ ok: true, settings: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const errResponse = (): Response =>
  new Response(JSON.stringify({ error: "磁盘只读" }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    (url: string, init?: RequestInit) => {
      // 单测里 GET /api/settings/full 自动放行成功，只把真正的 PUT 记进 pendingCalls
      const method = (init?.method ?? "GET").toUpperCase();
      if (String(url).includes("/api/settings/full") && method === "GET") {
        const body = JSON.stringify({ exists: true, settings: diskSnapshot });
        const make = () =>
          new Response(body, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        if (heldGets) {
          return new Promise<Response>((resolve) => {
            heldGets!.push(() => resolve(make()));
          });
        }
        return Promise.resolve(make());
      }
      return new Promise<Response>((resolve) => {
        pendingCalls.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          resolve,
        });
      });
    },
  );
  // review #16：saveSettings 在 init 成功之前一律拒写（旧实现会在保存时顺手 init 再写 next，
  // 而 next 是基于默认值构造的、会覆盖磁盘配置）。所以这里要像真实页面一样先完成加载
  await initSettings();
});

afterEach(() => {
  pendingCalls = [];
  diskSnapshot = DEFAULT_SETTINGS;
  heldGets = null;
});

describe("saveSettings（CR-08）", () => {
  it("服务端 500 → 返回 false（旧实现静默当成功返 true）", async () => {
    const p = saveSettings({ ...DEFAULT_SETTINGS, apiKey: "k1" });
    // 等 fetch 被发出
    await vi.waitFor(() => expect(pendingCalls.length).toBe(1));
    pendingCalls[0].resolve(errResponse());
    await expect(p).resolves.toBe(false);
  });

  it("连续两次保存严格串行：前一个响应未回、第二个请求不发出（防乱序覆盖）", async () => {
    const p1 = saveSettings({ ...DEFAULT_SETTINGS, apiKey: "第一次" });
    const p2 = saveSettings({ ...DEFAULT_SETTINGS, apiKey: "第二次" });

    // 只有第一个请求在飞（旧实现两个同时发出、此断言失败）
    await vi.waitFor(() => expect(pendingCalls.length).toBe(1));
    expect((pendingCalls[0].body as { apiKey: string }).apiKey).toBe("第一次");

    // 放行第一个 → 第二个才发出、且携带第二次的内容（顺序保住）
    pendingCalls[0].resolve(okResponse());
    await vi.waitFor(() => expect(pendingCalls.length).toBe(2));
    expect((pendingCalls[1].body as { apiKey: string }).apiKey).toBe("第二次");
    pendingCalls[1].resolve(okResponse());

    await expect(p1).resolves.toBe(true);
    await expect(p2).resolves.toBe(true);
  });

  it("第一个失败不传染第二个（队列断链保护）", async () => {
    const p1 = saveSettings({ ...DEFAULT_SETTINGS, apiKey: "会失败" });
    const p2 = saveSettings({ ...DEFAULT_SETTINGS, apiKey: "会成功" });
    await vi.waitFor(() => expect(pendingCalls.length).toBe(1));
    pendingCalls[0].resolve(errResponse());
    await vi.waitFor(() => expect(pendingCalls.length).toBe(2));
    pendingCalls[1].resolve(okResponse());
    await expect(p1).resolves.toBe(false);
    await expect(p2).resolves.toBe(true);
  });

  it("PUT 失败回滚 cache（内存不与磁盘分叉）", async () => {
    const ok = saveSettings({ ...DEFAULT_SETTINGS, apiKey: "已落盘" });
    await vi.waitFor(() => expect(pendingCalls.length).toBe(1));
    pendingCalls[0].resolve(okResponse());
    await expect(ok).resolves.toBe(true);
    expect(getSettings().apiKey).toBe("已落盘");

    const fail = saveSettings({ ...DEFAULT_SETTINGS, apiKey: "写失败" });
    await vi.waitFor(() => expect(pendingCalls.length).toBe(2));
    pendingCalls[1].resolve(errResponse());
    await expect(fail).resolves.toBe(false);
    expect(getSettings().apiKey).toBe("已落盘");
  });

  it("并发保存下先发的失败、后发的叠在它之上成功：内存不能留着磁盘上没有的值（评审 2026-11-01：失败回滚按引用判断、回滚不了就分叉）", async () => {
    const base = getSettings();
    // A：改 apiKey（会失败）；B：基于 A 的乐观 cache 改 gitToken（字段级 PATCH，只带 gitToken）
    const a = saveSettings({ ...base, apiKey: "A-失败值" }, ["apiKey"]);
    const b = saveSettings({ ...getSettings(), gitToken: "B-成功值" }, ["gitToken"]);
    await vi.waitFor(() => expect(pendingCalls.length).toBe(1));
    pendingCalls[0].resolve(errResponse());
    await vi.waitFor(() => expect(pendingCalls.length).toBe(2));
    // 磁盘真值：A 没落盘、B 落了
    diskSnapshot = { ...base, gitToken: "B-成功值" };
    pendingCalls[1].resolve(okResponse());
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(true);
    // 乐观 cache 此刻还带着 A 的值；对账是异步的、等它把 cache 拉回磁盘真值
    await vi.waitFor(() => expect(getSettings().apiKey).toBe(base.apiKey));
    expect(getSettings().gitToken).toBe("B-成功值");
  });

  it("对账期间又发起了新保存：放弃这次对账、不拿旧快照盖掉新的乐观值", async () => {
    const base = getSettings();
    const a = saveSettings({ ...base, apiKey: "A-失败值" }, ["apiKey"]);
    const b = saveSettings({ ...getSettings(), gitToken: "B" }, ["gitToken"]);
    await vi.waitFor(() => expect(pendingCalls.length).toBe(1));
    pendingCalls[0].resolve(errResponse());
    await vi.waitFor(() => expect(pendingCalls.length).toBe(2));
    diskSnapshot = { ...base };
    heldGets = []; // 对账 GET 先卡住
    pendingCalls[1].resolve(okResponse());
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(true);
    await vi.waitFor(() => expect(heldGets!.length).toBe(1));
    // 对账 GET 在飞时用户又改了一项：seq 变了 → 对账结果作废
    const c = saveSettings({ ...getSettings(), gitToken: "C-新值" }, ["gitToken"]);
    await vi.waitFor(() => expect(pendingCalls.length).toBe(3));
    heldGets[0]!(); // 放行旧快照（gitToken 还是 base 的）
    await new Promise((r) => setTimeout(r, 20));
    // 旧快照被作废：新的乐观值还在、A 的失败值也还没被对账掉（对账被放弃，标记保留）
    expect(getSettings().gitToken).toBe("C-新值");
    expect(getSettings().apiKey).toBe("A-失败值");
    // C 落盘后在途清零 → 标记还在 → 再对账一次、这次落地（R1-17：旧实现标记已在发 GET 前复位，之后没人重试）
    heldGets = null;
    diskSnapshot = { ...base, gitToken: "C-新值" };
    pendingCalls[2].resolve(okResponse());
    await expect(c).resolves.toBe(true);
    await vi.waitFor(() => expect(getSettings().apiKey).toBe(base.apiKey));
    expect(getSettings().gitToken).toBe("C-新值");
  });

  it("对账 GET 失败：标记保留，下一次保存结束时再对账（不永久分叉）", async () => {
    const base = getSettings();
    const a = saveSettings({ ...base, apiKey: "A-失败值" }, ["apiKey"]);
    const b = saveSettings({ ...getSettings(), gitToken: "B" }, ["gitToken"]);
    await vi.waitFor(() => expect(pendingCalls.length).toBe(1));
    pendingCalls[0].resolve(errResponse());
    await vi.waitFor(() => expect(pendingCalls.length).toBe(2));
    // 第一次对账的 GET 返回 500
    const realFetch = globalThis.fetch;
    let getFailed = 0;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (String(url).includes("/api/settings/full") && method === "GET" && getFailed === 0) {
        getFailed += 1;
        return Promise.resolve(new Response("{}", { status: 500 }));
      }
      return realFetch(url, init);
    });
    try {
      pendingCalls[1].resolve(okResponse());
      await expect(a).resolves.toBe(false);
      await expect(b).resolves.toBe(true);
      await vi.waitFor(() => expect(getFailed).toBe(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(getSettings().apiKey).toBe("A-失败值"); // 对账失败、仍分叉
      // 下一次保存结束 → 再对账（这次放行 GET）
      diskSnapshot = { ...base, gitToken: "C" };
      const c = saveSettings({ ...getSettings(), gitToken: "C" }, ["gitToken"]);
      await vi.waitFor(() => expect(pendingCalls.length).toBe(3));
      pendingCalls[2].resolve(okResponse());
      await expect(c).resolves.toBe(true);
      await vi.waitFor(() => expect(getSettings().apiKey).toBe(base.apiKey));
    } finally {
      vi.stubGlobal("fetch", realFetch);
    }
  });

  it("F6-03：运行中途某次 PUT 撞上 500 settings_unreadable → 仍只是普通保存失败（false + 回滚），不记粘性的「不可读」状态", async () => {
    // 有意的取舍：这可能是瞬时错误（Windows 杀软 / 同步盘短暂占住文件），粘性暂停会让设置页在文件恢复后
    // 还一直拒绝保存；「不可读」状态只在读取阶段（initSettings 的 GET /full）记录
    const ok = saveSettings({ ...DEFAULT_SETTINGS, apiKey: "中途前" });
    await vi.waitFor(() => expect(pendingCalls.length).toBe(1));
    pendingCalls[0].resolve(okResponse());
    await expect(ok).resolves.toBe(true);

    const fail = saveSettings({ ...DEFAULT_SETTINGS, apiKey: "中途写失败" });
    await vi.waitFor(() => expect(pendingCalls.length).toBe(2));
    pendingCalls[1].resolve(
      new Response(
        JSON.stringify({ error: "settings_unreadable", reason: "EBUSY: resource busy" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(fail).resolves.toBe(false);
    expect(getSettings().apiKey).toBe("中途前");
    expect(getSettingsUnreadable()).toBeNull();

    // 文件恢复后，下一次保存照常成功
    const again = saveSettings({ ...DEFAULT_SETTINGS, apiKey: "恢复后" });
    await vi.waitFor(() => expect(pendingCalls.length).toBe(3));
    pendingCalls[2].resolve(okResponse());
    await expect(again).resolves.toBe(true);
  });
});

describe("normalizeSettings 健壮性", () => {
  it("失败路径默认值是拷贝、mutate 不污染 DEFAULT_SETTINGS", () => {
    const a = normalizeSettings(null);
    a.apiKey = "污染";
    a.repos.push({ name: "x", path: "/x" });
    expect(DEFAULT_SETTINGS.apiKey).toBe("");
    expect(DEFAULT_SETTINGS.repos).toEqual([]);
  });

  it("apiKey 非 string → 空串；repos 非对象项过滤", () => {
    const s = normalizeSettings({
      apiKey: 123 as never,
      repos: [
        { name: "ok", path: "/ok" },
        "坏项" as never,
        null as never,
      ],
    });
    expect(s.apiKey).toBe("");
    expect(s.repos).toEqual([{ name: "ok", path: "/ok" }]);
  });

  it("repos[].path 不是非空字符串的项过滤掉（手改 config.json 的脏项会让侧栏按路径分组抛 TypeError、壳白屏）", () => {
    const s = normalizeSettings({
      repos: [
        { name: "ok", path: "/ok" },
        { name: "无路径" } as never,
        { name: "数字路径", path: 123 } as never,
        { name: "空路径", path: "" },
        { name: "空白路径", path: "   " },
        { name: "null 路径", path: null } as never,
        { name: "也ok", path: "D:\\\\work\\\\b", readonly: true },
      ],
    });
    expect(s.repos.map((r) => r.path)).toEqual(["/ok", "D:\\\\work\\\\b"]);
    expect(s.repos[1]?.readonly).toBe(true);
  });
});

describe("repoConfigEquals（CR-09）", () => {
  const base: RepoConfig = {
    name: "web",
    path: "/repo/web",
    onlineBranch: "master",
    testBranch: "test",
    devBranch: "develop",
    branchTemplate: "feature/{storyId}",
    previewCommand: "npm run dev",
    setupCommand: "pnpm install --frozen-lockfile",
  };

  it("全字段一致 → 相等；可选字段 undefined 与空串视同", () => {
    expect(repoConfigEquals(base, { ...base })).toBe(true);
    expect(
      repoConfigEquals(
        { name: "a", path: "/a" },
        { name: "a", path: "/a", onlineBranch: "", previewCommand: "", setupCommand: "" },
      ),
    ).toBe(true);
  });

  it.each([
    ["onlineBranch", { onlineBranch: "release" }],
    ["testBranch", { testBranch: "qa" }],
    ["devBranch", { devBranch: "dev" }],
    ["branchTemplate", { branchTemplate: "feat/{storyId}" }],
    ["previewCommand", { previewCommand: "pnpm dev" }],
    ["setupCommand", { setupCommand: "yarn install" }],
    ["name", { name: "web2" }],
    ["path", { path: "/repo/web2" }],
  ] as const)("%s 单独改动 → 不相等（旧实现漏比五个字段）", (_field, patch) => {
    expect(repoConfigEquals(base, { ...base, ...patch })).toBe(false);
  });
});

describe("isFieldEqual 桥接 boolean（R1-11）", () => {
  const base: FeAiFlowSettings = { ...DEFAULT_SETTINGS };

  it("feishuChatBridge 切换 → 不相等（旧实现 fall-through 到 defaultModel 恒相等）", () => {
    expect(
      isFieldEqual(
        "feishuChatBridge",
        { ...base, feishuChatBridge: false },
        { ...base, feishuChatBridge: false },
      ),
    ).toBe(true);
    expect(
      isFieldEqual(
        "feishuChatBridge",
        { ...base, feishuChatBridge: true },
        { ...base, feishuChatBridge: false },
      ),
    ).toBe(false);
    // undefined 与 false 视同（缺省关）
    expect(
      isFieldEqual(
        "feishuChatBridge",
        { ...base, feishuChatBridge: undefined },
        { ...base, feishuChatBridge: false },
      ),
    ).toBe(true);
  });

  it("feishuBridgeKeepAwake 切换 → 不相等（缺省 true）", () => {
    expect(
      isFieldEqual(
        "feishuBridgeKeepAwake",
        { ...base, feishuBridgeKeepAwake: true },
        { ...base, feishuBridgeKeepAwake: true },
      ),
    ).toBe(true);
    expect(
      isFieldEqual(
        "feishuBridgeKeepAwake",
        { ...base, feishuBridgeKeepAwake: false },
        { ...base, feishuBridgeKeepAwake: true },
      ),
    ).toBe(false);
    // undefined 与 true 视同（缺省开）
    expect(
      isFieldEqual(
        "feishuBridgeKeepAwake",
        { ...base, feishuBridgeKeepAwake: undefined },
        { ...base, feishuBridgeKeepAwake: true },
      ),
    ).toBe(true);
  });
});
