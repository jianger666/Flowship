/**
 * 飞书桥接注入的 bootArgs 模型来源：必须跟「目标窗口所选」走，而不是设置页默认模型。
 *
 * 缺陷（review #8）：router 注入用 loadBridgeBootContext() 直接取设置页默认模型。窗口选的是 B、
 * 默认是 A 时，chat-inject 拿 bootArgs.model(A) 跟会话绑定的 runModel(B) 比，判成「换了模型」→
 * 懒重启（取消在跑回合 + 上下文压成 12 轮摘要）。
 *
 * 旧测试盲区：既有 router 用例里 task 没有 model、设置页只有一个默认模型，两边永远同值；
 * 注入断言又只 objectContaining({ text })，bootArgs 里的模型从没被断言过。
 * 本文件刻意让 task.model 与设置页默认 **不同值**，并直接断言 bootArgs.model。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __setRouterDepsForTest,
  bridgeTaskProviderDanglingReason,
  loadBridgeBootContext,
  onInjectResult,
  routeInboundMessage,
} from "@/lib/server/feishu-bridge/router";
import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

import {
  baseRouterDeps,
  installBridgeTestHooks,
  makeBridgeTmpDataDir,
  okInjectResponse,
} from "./helpers/feishu-bridge-harness";

const TMP = makeBridgeTmpDataDir("feishu-bridge-boot-args-model-source");
installBridgeTestHooks({ tmpRoot: TMP });

const DEFAULT_MODEL = { id: "default-model-A" };
const WINDOW_MODEL = {
  id: "window-model-B",
  params: [{ id: "reasoning", value: "high" }],
};

const baseMsg = (
  overrides: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: "om_boot_1",
  create_time: String(Date.now()),
  chat_id: "oc_test",
  chat_type: "p2p",
  message_type: "text",
  sender_id: "ou_owner",
  content: "继续聊",
  ...overrides,
});

const summary = (id: string): TaskSummary =>
  ({
    id,
    title: "窗口",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    updatedAt: Date.now(),
    createdAt: Date.now(),
    repoPaths: [],
    currentActionId: null,
    mrs: [],
    actionCount: 0,
  }) as TaskSummary;

/** 只带 bootArgsForTask 会读的字段（provider / sessionAgentId / model / actions） */
const metaOf = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "task-1",
    mode: "chat",
    actions: [],
    ...overrides,
  }) as unknown as Task;

const settingsOk = (extra: Record<string, unknown> = {}) => ({
  status: "ok" as const,
  settings: {
    apiKey: "sk-cursor",
    defaultModel: DEFAULT_MODEL,
    repos: [],
    ...extra,
  },
});

type BootArgsBody = { bootArgs?: { apiKey: string; model: unknown } };

describe("飞书注入 bootArgs 的模型来源（跟窗口走，不跟设置页默认）", () => {
  const handleChat = vi.fn<
    (taskId: string, body: BootArgsBody) => Promise<Response>
  >(async () => okInjectResponse());
  const injectAsk = vi.fn<
    (taskId: string, text: string, boot?: unknown) => Promise<{ ok: true }>
  >(async () => ({ ok: true as const }));
  const getTaskMeta = vi.fn<(id: string) => Promise<Task | null>>(
    async () => null,
  );
  const getPending = vi.fn<() => unknown>(() => null);

  const apply = (
    overrides: Parameters<typeof baseRouterDeps>[0] = {},
  ): void => {
    __setRouterDepsForTest(
      baseRouterDeps({
        listTasks: async () => [summary("task-1")],
        getTaskMeta: getTaskMeta as never,
        handleChatReplyInject: handleChat as never,
        injectPendingAskText: injectAsk as never,
        getPendingAsk: getPending as never,
        readSettingsFile: async () => settingsOk(),
        ...overrides,
      }),
    );
  };

  const injectedBootArgs = (): BootArgsBody["bootArgs"] =>
    handleChat.mock.calls[0]?.[1]?.bootArgs;

  beforeEach(() => {
    handleChat.mockClear();
    injectAsk.mockClear();
    getTaskMeta.mockReset();
    getTaskMeta.mockResolvedValue(null);
    getPending.mockReset();
    getPending.mockReturnValue(null);
    onInjectResult(null);
    apply();
  });

  afterEach(() => {
    onInjectResult(null);
  });

  it("窗口选 B、设置页默认 A → 注入 bootArgs.model 是 B（含 params），不是 A", async () => {
    getTaskMeta.mockResolvedValue(metaOf({ model: WINDOW_MODEL }));

    const r = await routeInboundMessage(baseMsg());

    expect(r.kind).toBe("sent");
    expect(getTaskMeta).toHaveBeenCalledWith("task-1");
    expect(injectedBootArgs()).toEqual({
      apiKey: "sk-cursor",
      model: WINDOW_MODEL,
    });
    expect(injectedBootArgs()?.model).not.toEqual(DEFAULT_MODEL);
  });

  it("窗口没选模型 → 回落设置页默认（兼容旧窗口 / 刚建的窗口）", async () => {
    getTaskMeta.mockResolvedValue(metaOf({ model: undefined }));

    await routeInboundMessage(baseMsg());

    expect(injectedBootArgs()).toEqual({
      apiKey: "sk-cursor",
      model: DEFAULT_MODEL,
    });
  });

  it("读不到窗口 meta（查无 / IO 抛错）→ 回落设置页默认、不炸", async () => {
    getTaskMeta.mockResolvedValueOnce(null);
    await routeInboundMessage(baseMsg({ message_id: "om_boot_null" }));
    expect(injectedBootArgs()?.model).toEqual(DEFAULT_MODEL);

    handleChat.mockClear();
    getTaskMeta.mockRejectedValueOnce(new Error("meta 读盘失败"));
    const r = await routeInboundMessage(baseMsg({ message_id: "om_boot_throw" }));
    expect(r.kind).toBe("sent");
    expect(injectedBootArgs()?.model).toEqual(DEFAULT_MODEL);
  });

  it("窗口绑在自定义 provider：apiKey / 模型都取窗口那家，不拿 Cursor 默认家的 key 与模型", async () => {
    apply({
      readSettingsFile: async () =>
        settingsOk({
          customProviders: [
            {
              id: "cp_deepseek",
              name: "DeepSeek",
              baseUrl: "https://api.example.com/v1",
              apiKey: "sk-custom",
              format: "openai",
              defaultModel: { id: "custom-default" },
            },
          ],
        }),
    });
    getTaskMeta.mockResolvedValue(
      metaOf({ provider: "cp_deepseek", model: { id: "custom-picked" } }),
    );

    await routeInboundMessage(baseMsg());

    expect(injectedBootArgs()).toEqual({
      apiKey: "sk-custom",
      model: { id: "custom-picked" },
    });
  });

  it("窗口绑的自定义 provider 已被删（悬空，第四轮 Q2-02）：不注入、不落回 Cursor 的 key；回执给属主真实原因而不是「缺 Key」", async () => {
    apply({
      readSettingsFile: async () =>
        settingsOk({
          customProviders: [
            {
              id: "cp_other",
              name: "other",
              baseUrl: "https://api.example.com/v1",
              apiKey: "sk-other",
              format: "openai",
            },
          ],
        }),
    });
    getTaskMeta.mockResolvedValue(metaOf({ provider: "cp_gone", model: { id: "m" } }));

    const r = await routeInboundMessage(baseMsg({ message_id: "om_boot_dangling" }));

    expect(handleChat).not.toHaveBeenCalled();
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.error).toContain("提供方已被删除");
    expect(r.kind === "failed" && r.error).not.toContain("API Key");
  });

  it("反例对：窗口绑的 provider 还在 → 照常注入（上面那条没拒绝过头）", async () => {
    apply({
      readSettingsFile: async () =>
        settingsOk({
          customProviders: [
            {
              id: "cp_other",
              name: "other",
              baseUrl: "https://api.example.com/v1",
              apiKey: "sk-other",
              format: "openai",
            },
          ],
        }),
    });
    getTaskMeta.mockResolvedValue(metaOf({ provider: "cp_other", model: { id: "m" } }));
    const r = await routeInboundMessage(baseMsg({ message_id: "om_boot_ok" }));
    expect(r.kind).toBe("sent");
    expect(injectedBootArgs()).toEqual({ apiKey: "sk-other", model: { id: "m" } });
  });

  it("loadBridgeBootContext(悬空窗口) = null、bridgeTaskProviderDanglingReason 给原因；配置读不出来不误判", async () => {
    apply({
      readSettingsFile: async () => settingsOk({ customProviders: [] }),
    });
    const dangling = metaOf({ provider: "cp_gone", model: { id: "m" } });
    expect(await loadBridgeBootContext(dangling)).toBeNull();
    expect(await bridgeTaskProviderDanglingReason(dangling)).toContain("提供方已被删除");
    // 无窗口（新建对话 / 命令）与 cursor 窗口不受影响
    expect(await loadBridgeBootContext()).not.toBeNull();
    expect(await bridgeTaskProviderDanglingReason(undefined)).toBeNull();
    expect(await bridgeTaskProviderDanglingReason(metaOf({ provider: "cursor" }))).toBeNull();
    // 配置读不出来：customProviders 只是默认空值，不据此判「已删除」
    apply({ readSettingsFile: async () => ({ status: "missing" }) as never });
    expect(await bridgeTaskProviderDanglingReason(dangling)).toBeNull();
  });

  it("有未答提问的分支（injectPendingAskText）同样带窗口模型", async () => {
    getTaskMeta.mockResolvedValue(metaOf({ model: WINDOW_MODEL }));
    getPending.mockReturnValue({
      askId: "ask-1",
      token: "tok",
      questions: [{ id: "q1", question: "选哪个", allowText: true }],
      createdAt: Date.now(),
    });

    await routeInboundMessage(baseMsg({ message_id: "om_boot_ask" }));

    expect(injectAsk).toHaveBeenCalledTimes(1);
    expect(injectAsk.mock.calls[0]?.[2]).toEqual({
      apiKey: "sk-cursor",
      model: WINDOW_MODEL,
    });
  });
});

describe("loadBridgeBootContext 的 task 参数", () => {
  beforeEach(() => {
    __setRouterDepsForTest(
      baseRouterDeps({
        readSettingsFile: async () =>
          settingsOk({ disabledMcpServers: ["mcp-a"] }),
      }),
    );
  });

  it("不传 task（新建对话 / 命令）= 设置页默认模型，行为不变", async () => {
    const boot = await loadBridgeBootContext();
    expect(boot?.model).toEqual(DEFAULT_MODEL);
    expect(boot?.provider).toBe("cursor");
    expect(boot?.disabledMcpServers).toEqual(["mcp-a"]);
  });

  it("传 task = 窗口所选模型；其余字段（MCP 黑名单等）不受影响", async () => {
    const boot = await loadBridgeBootContext(metaOf({ model: WINDOW_MODEL }));
    expect(boot?.model).toEqual(WINDOW_MODEL);
    expect(boot?.apiKey).toBe("sk-cursor");
    expect(boot?.disabledMcpServers).toEqual(["mcp-a"]);
  });
});

/**
 * 契约（第二轮 review F2-01）：「已有窗口」的路径一律带 task 取 boot，防止再次退回设置页默认模型。
 * 只允许无参的两处：新建对话（createChatTaskForBridge）与 `/new` 命令——那时还没有窗口，
 * 建出来的任务本身就用这份默认模型 / 提供方。
 */
describe("契约：已有窗口的飞书路径不得再无参调 loadBridgeBootContext", () => {
  const read = async (rel: string): Promise<string> => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    return readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf8");
  };

  it("card-action.ts：四处（私聊 ask / 重试 / 群 ask / 群推进选择卡）都带窗口任务", async () => {
    const src = await read("src/lib/server/feishu-bridge/card-action.ts");
    expect(src).not.toMatch(/loadBridgeBootContext\(\)/);
    expect(src.match(/loadBridgeBootContext\((?!\))/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("router.ts：无参调用只剩 createChatTaskForBridge 一处；群路由的 loadBootContext 透传 task", async () => {
    const src = await read("src/lib/server/feishu-bridge/router.ts");
    expect(src.match(/loadBridgeBootContext\(\)/g)?.length ?? 0).toBe(1);
    const at = src.indexOf("loadBridgeBootContext()");
    const fnStart = src.lastIndexOf("export const createChatTaskForBridge", at);
    expect(fnStart).toBeGreaterThanOrEqual(0);
    expect(src).toMatch(/loadBootContext:\s*async \(task\)\s*=>\s*\{\s*const boot = await loadBridgeBootContext\(task\)/);
  });

  it("group-route.ts：三处取 boot 都传 task", async () => {
    const src = await read("src/lib/server/feishu-bridge/group-route.ts");
    // 只看真实调用（`await args.loadBootContext(`），注释里提到的 `loadBootContext()` 不算
    expect(src).not.toMatch(/await args\.loadBootContext\(\)/);
    expect(src.match(/await args\.loadBootContext\(task\)/g)?.length ?? 0).toBe(3);
  });
});
