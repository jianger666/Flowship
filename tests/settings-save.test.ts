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

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    (url: string, init?: RequestInit) => {
      // P1-03：saveSettings 在 init 未成功时会先 GET /api/settings/full——
      // 单测里自动放行成功，只把真正的 PUT 记进 pendingCalls
      const method = (init?.method ?? "GET").toUpperCase();
      if (String(url).includes("/api/settings/full") && method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ exists: true, settings: DEFAULT_SETTINGS }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      return new Promise<Response>((resolve) => {
        pendingCalls.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          resolve,
        });
      });
    },
  );
});

afterEach(() => {
  pendingCalls = [];
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
  };

  it("全字段一致 → 相等；可选字段 undefined 与空串视同", () => {
    expect(repoConfigEquals(base, { ...base })).toBe(true);
    expect(
      repoConfigEquals(
        { name: "a", path: "/a" },
        { name: "a", path: "/a", onlineBranch: "", previewCommand: "" },
      ),
    ).toBe(true);
  });

  it.each([
    ["onlineBranch", { onlineBranch: "release" }],
    ["testBranch", { testBranch: "qa" }],
    ["devBranch", { devBranch: "dev" }],
    ["branchTemplate", { branchTemplate: "feat/{storyId}" }],
    ["previewCommand", { previewCommand: "pnpm dev" }],
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

  it("feishuBridgeStreaming 切换 → 不相等（缺省 true）", () => {
    expect(
      isFieldEqual(
        "feishuBridgeStreaming",
        { ...base, feishuBridgeStreaming: true },
        { ...base, feishuBridgeStreaming: true },
      ),
    ).toBe(true);
    expect(
      isFieldEqual(
        "feishuBridgeStreaming",
        { ...base, feishuBridgeStreaming: false },
        { ...base, feishuBridgeStreaming: true },
      ),
    ).toBe(false);
    expect(
      isFieldEqual(
        "feishuBridgeStreaming",
        { ...base, feishuBridgeStreaming: undefined },
        { ...base, feishuBridgeStreaming: true },
      ),
    ).toBe(true);
  });
});
