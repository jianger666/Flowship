/**
 * R3-1 跨层集成：outbound（真实 finalizeTurn 顺序）→ 真 card-stream（真守卫/真链）
 *
 * 两轮 review 漏掉重试按钮死路的根因：outbound 测试 mock 卡片句柄（只断言
 * appendRetryButton 被调过）、card-stream 测试又是「先 append 后 finalize」——
 * 没有用例走 outbound 的真实调用顺序。本文件只 mock lark-api，其余全真。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `feishu-bridge-outbound-int-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const getTask = vi.hoisted(() =>
  vi.fn(async (id: string) => ({
    id,
    title: "集成测对话",
    mode: "chat" as const,
    model: { id: "grok-4" },
  })),
);

vi.mock("@/lib/server/task-fs", () => ({ getTask }));

vi.mock("@/lib/server/feishu-bridge/bridge-config", () => {
  const bridgeDir = path.join(
    process.env.FLOWSHIP_DATA_DIR ?? "/tmp",
    "feishu-bridge",
  );
  return {
    isFeishuChatBridgeEnabled: async () => true,
    isFeishuBridgeStreamingEnabled: async () => true,
    isFeishuBridgeKeepAwakeEnabled: async () => true,
    isBridgeTestInstance: () => true,
    getBridgeDataDir: async () => {
      const { promises: fsp } = await import("node:fs");
      await fsp.mkdir(bridgeDir, { recursive: true });
      return bridgeDir;
    },
  };
});

const larkMocks = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    createCardEntity: vi.fn<AnyFn>(async () => ({ card_id: "card_int" })),
    sendCardMessage: vi.fn<AnyFn>(async () => ({
      chat_id: "oc_int",
      message_id: "om_int",
    })),
    updateCardEntity: vi.fn<AnyFn>(async () => undefined),
    updateCardElementContent: vi.fn<AnyFn>(async () => undefined),
    patchCardSettings: vi.fn<AnyFn>(async () => undefined),
    batchUpdateCard: vi.fn<AnyFn>(async () => undefined),
    getBotAppInfo: vi.fn<AnyFn>(async () => ({
      appId: "cli_int",
      ownerOpenId: "ou_int",
    })),
    uploadImage: vi.fn<AnyFn>(async () => "img_key_int"),
  };
});

vi.mock("@/lib/server/feishu-bridge/lark-api", () => larkMocks);

const {
  ensureFeishuOutboundRegistered,
  __resetFeishuOutboundForTest,
  __setBridgeEnabledForTest,
  handleFeishuOutboundEvent,
} = await import("@/lib/server/feishu-bridge/outbound");
const { __setCardStreamTimersForTest } = await import(
  "@/lib/server/feishu-bridge/card-stream"
);
const { __resetCardSeqForTest } = await import(
  "@/lib/server/feishu-bridge/card-seq"
);

const makeEvent = (
  kind: string,
  text: string,
  meta?: Record<string, unknown>,
) => ({
  kind: "event" as const,
  event: {
    id: `ev_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    kind: kind as never,
    text,
    meta,
  },
});

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  await __resetCardSeqForTest();
  __resetFeishuOutboundForTest();
  for (const fn of Object.values(larkMocks)) fn.mockClear();
  __setBridgeEnabledForTest(true);
  // 节流 timer 立即执行，避免 250ms 真等待
  __setCardStreamTimersForTest((cb) => {
    cb();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  ensureFeishuOutboundRegistered();
});

afterEach(async () => {
  __setCardStreamTimersForTest(null);
  __resetFeishuOutboundForTest();
  await __resetCardSeqForTest();
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("outbound → 真 card-stream：失败轮重试按钮", () => {
  it("done ok=false：重试按钮真渲染（batch add_elements）且 finalize 全量 PUT 保留、footer 带错误摘要", async () => {
    const taskId = "t_int_retry";
    await handleFeishuOutboundEvent(taskId, makeEvent("user_reply", "会失败的一问"));
    await handleFeishuOutboundEvent(taskId, {
      kind: "assistant_delta",
      text: "答到一半",
    });
    // 等 start 链（建卡→发消息→card-map 落盘）与 pendingOps 排空
    await vi.waitFor(() => expect(larkMocks.sendCardMessage).toHaveBeenCalled());

    await handleFeishuOutboundEvent(
      taskId,
      makeEvent("error", "Chat agent 异常：网络断了"),
    );
    await handleFeishuOutboundEvent(taskId, {
      kind: "done",
      ok: false,
      task: { id: taskId, title: "集成测对话", mode: "chat" } as never,
    });

    // 1) 重试按钮的 batch add_elements 真发出去了（旧 bug：finalize 后守卫短路、永不发）
    const addCalls = (
      larkMocks.batchUpdateCard.mock.calls as unknown as Array<
        [
          string,
          Array<{
            action: string;
            params: { elements?: Array<{ element_id?: string }> };
          }>,
        ]
      >
    ).filter((c) => c[1]?.some((a) => a.action === "add_elements"));
    expect(
      addCalls.some((c) =>
        c[1].some((a) =>
          a.params.elements?.some((e) => e.element_id === "btn_retry"),
        ),
      ),
    ).toBe(true);

    // 2) finalize 的全量 PUT 带上按钮（appendedElements 快照）+ red + footer 错误摘要
    const entityCalls = larkMocks.updateCardEntity.mock.calls as unknown as Array<
      [
        string,
        {
          header: { template: string };
          body: {
            elements: Array<{
              tag?: string;
              element_id?: string;
              content?: string;
            }>;
          };
        },
        number,
      ]
    >;
    expect(entityCalls.length).toBeGreaterThan(0);
    const finalJson = entityCalls.at(-1)![1];
    expect(finalJson.header.template).toBe("red");
    expect(
      finalJson.body.elements.some((e) => e.element_id === "btn_retry"),
    ).toBe(true);
    const footer = finalJson.body.elements.find(
      (e) => e.element_id === "md_footer",
    );
    expect(footer?.content).toContain("处理失败：Chat agent 异常：网络断了");

    // 3) 正常关流收尾仍执行
    expect(larkMocks.patchCardSettings).toHaveBeenCalled();
  });

  it("done ok=true：不追加重试按钮（对照）", async () => {
    const taskId = "t_int_ok";
    await handleFeishuOutboundEvent(taskId, makeEvent("user_reply", "正常一问"));
    await handleFeishuOutboundEvent(taskId, {
      kind: "assistant_delta",
      text: "顺利答完",
    });
    await vi.waitFor(() => expect(larkMocks.sendCardMessage).toHaveBeenCalled());
    await handleFeishuOutboundEvent(taskId, {
      kind: "done",
      ok: true,
      task: {
        id: taskId,
        title: "集成测对话",
        mode: "chat",
        runStatus: "awaiting_user",
      } as never,
    });

    const allBatchEls = (
      larkMocks.batchUpdateCard.mock.calls as unknown as Array<
        [
          string,
          Array<{
            action: string;
            params: { elements?: Array<{ element_id?: string }> };
          }>,
        ]
      >
    ).flatMap((c) => c[1] ?? []);
    expect(
      allBatchEls.some((a) =>
        a.params.elements?.some((e) => e.element_id === "btn_retry"),
      ),
    ).toBe(false);
    const entityCalls = larkMocks.updateCardEntity.mock.calls as unknown as Array<
      [string, { header: { template: string } }]
    >;
    expect(entityCalls.at(-1)![1].header.template).toBe("green");
  });
});
