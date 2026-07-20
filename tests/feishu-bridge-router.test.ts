/**
 * 飞书桥接 router：过滤 / content 形态 / 活跃 chat 分支 / pendingAsk / 命令扩展点
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetBridgeStateForTest,
  addEndedChatTaskId,
  getCurrentChatTaskId,
  getEndedChatTaskIds,
  setCurrentChatTaskId,
} from "@/lib/server/feishu-bridge/bridge-state";
import {
  __clearBridgeCommandsForTest,
  __setRouterDepsForTest,
  isActiveChatTask,
  onInjectResult,
  parseInboundContent,
  parseTextContent,
  registerBridgeCommand,
  routeInboundMessage,
} from "@/lib/server/feishu-bridge/router";
import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { TaskSummary } from "@/lib/types";

// 指针路由读写真实 bridge-state 文件——隔离到独立 tmp、避免污染 cwd/data。
// bridge-state 的数据目录在每次调用时才解析 env、import 后再设也生效。
process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `feishu-bridge-router-${Date.now()}`,
  "data",
);

const baseMsg = (
  overrides: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: "om_test_1",
  create_time: String(Date.now()),
  chat_id: "oc_test",
  chat_type: "p2p",
  message_type: "text",
  sender_id: "ou_owner",
  content: "hello",
  ...overrides,
});

const mockTask = (overrides: Partial<TaskSummary> = {}): TaskSummary =>
  ({
    id: "task-1",
    title: "测试对话",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    updatedAt: Date.now(),
    createdAt: Date.now(),
    repoPaths: [],
    currentActionId: null,
    mrs: [],
    actionCount: 0,
    ...overrides,
  }) as TaskSummary;

describe("parseTextContent", () => {
  it("兼容裸字符串与 {text} JSON", () => {
    expect(parseTextContent("hello")).toBe("hello");
    expect(parseTextContent('{"text":"world"}')).toBe("world");
  });
});

describe("parseInboundContent markdown 图提取", () => {
  const tmpFiles: string[] = [];

  afterEach(async () => {
    __setRouterDepsForTest(null);
    for (const p of tmpFiles.splice(0)) {
      await fs.unlink(p).catch(() => undefined);
    }
  });

  const makePng = async (bytes = 64): Promise<string> => {
    const p = path.join(
      os.tmpdir(),
      `feishu-md-img-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
    );
    // 最小可辨 PNG 头 + 填充（不必真解码）
    const buf = Buffer.alloc(bytes, 1);
    buf.write("\x89PNG\r\n\x1a\n", 0);
    await fs.writeFile(p, buf);
    tmpFiles.push(p);
    return p;
  };

  it("post markdown 图文混排 → images 提取 + 文本剥离", async () => {
    const png = await makePng();
    const downloaded: string[] = [];
    __setRouterDepsForTest({
      downloadMessageResource: async (_mid, key) => {
        downloaded.push(key);
        return png;
      },
    });
    const content =
      "![Image](img_v3_0213o_2b0d4c5b-4df7-4440-9058-a784d363914g)\n我再试试";
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "post",
        message_id: "om_md_mix",
        content,
      }),
    );
    expect(parsed.text).toBe("我再试试");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(downloaded).toEqual([
      "img_v3_0213o_2b0d4c5b-4df7-4440-9058-a784d363914g",
    ]);
  });

  it("纯 markdown 图无文字 → text 空 + 1 张图", async () => {
    const png = await makePng();
    __setRouterDepsForTest({
      downloadMessageResource: async () => png,
    });
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "post",
        content: "![Image](img_v2_abc123_xyz)",
      }),
    );
    expect(parsed.text).toBe("");
    expect(parsed.images).toHaveLength(1);
  });

  it("text 类型带 markdown 图同样提取", async () => {
    const png = await makePng();
    __setRouterDepsForTest({
      downloadMessageResource: async () => png,
    });
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "text",
        content: "看这张 ![图](img_v3_hello_world) 谢谢",
      }),
    );
    expect(parsed.text).toBe("看这张 谢谢");
    expect(parsed.images).toHaveLength(1);
  });

  it("超过 6 张图只下载前 6 张（超限降级）", async () => {
    const png = await makePng();
    const keys: string[] = [];
    __setRouterDepsForTest({
      downloadMessageResource: async (_mid, key) => {
        keys.push(key);
        return png;
      },
    });
    const parts = Array.from(
      { length: 8 },
      (_, i) => `![Image](img_v3_key_${i}_abcdef)`,
    );
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "post",
        content: `${parts.join("\n")}\n说明`,
      }),
    );
    expect(parsed.images).toHaveLength(6);
    expect(keys).toHaveLength(6);
    expect(parsed.text).toBe("说明");
  });

  it("post JSON 节点树路径仍可用（兼容官方形态）", async () => {
    const png = await makePng();
    __setRouterDepsForTest({
      downloadMessageResource: async () => png,
    });
    const content = JSON.stringify({
      title: "",
      content: [
        [{ tag: "img", image_key: "img_v3_json_tree_key" }],
        [{ tag: "text", text: "节点树正文" }],
      ],
    });
    const parsed = await parseInboundContent(
      baseMsg({ message_type: "post", content }),
    );
    expect(parsed.text).toBe("节点树正文");
    expect(parsed.images).toHaveLength(1);
  });
});

// T4：飞书文件消息——consumer enrichment 渲染 `<file .../>` 而非 JSON content
describe("parseInboundContent 文件消息双形态", () => {
  const tmpFiles: string[] = [];

  afterEach(async () => {
    __setRouterDepsForTest(null);
    for (const p of tmpFiles.splice(0)) {
      await fs.unlink(p).catch(() => undefined);
    }
  });

  const makeTmpFile = async (): Promise<string> => {
    const p = path.join(
      os.tmpdir(),
      `feishu-file-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`,
    );
    await fs.writeFile(p, "file-content");
    tmpFiles.push(p);
    return p;
  };

  it("enrichment `<file key name/>` 形态 → 提取 file_key + 保留原文件名", async () => {
    const tmp = await makeTmpFile();
    const downloaded: Array<{ key: string; type: string }> = [];
    __setRouterDepsForTest({
      downloadMessageResource: async (_mid, key, type) => {
        downloaded.push({ key, type });
        return tmp;
      },
    });
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "file",
        content:
          '<file key="file_v3_0013o_63f1ec89-ded1-48d8-869a-8f9d24204b3g" name="报告 v2.pdf"/>',
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    expect(downloaded).toEqual([
      { key: "file_v3_0013o_63f1ec89-ded1-48d8-869a-8f9d24204b3g", type: "file" },
    ]);
    expect(parsed.attachments).toHaveLength(1);
    expect(path.basename(parsed.attachments[0]!)).toBe("报告 v2.pdf");
    tmpFiles.push(parsed.attachments[0]!);
  });

  it("markdown `[名称](file_key)` 链接形态同样提取", async () => {
    const tmp = await makeTmpFile();
    __setRouterDepsForTest({
      downloadMessageResource: async () => tmp,
    });
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "file",
        content: "[notes.txt](file_v3_abc_def123)",
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    expect(parsed.attachments).toHaveLength(1);
    expect(path.basename(parsed.attachments[0]!)).toBe("notes.txt");
    tmpFiles.push(parsed.attachments[0]!);
  });

  it("JSON content 形态（补拉路径）不回归", async () => {
    const tmp = await makeTmpFile();
    __setRouterDepsForTest({
      downloadMessageResource: async () => tmp,
    });
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "file",
        content: JSON.stringify({
          file_key: "file_v3_json_key",
          file_name: "data.csv",
        }),
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    expect(parsed.attachments).toHaveLength(1);
    expect(path.basename(parsed.attachments[0]!)).toBe("data.csv");
    tmpFiles.push(parsed.attachments[0]!);
  });

  it("content 无 file_key（任意文本）→ unsupported", async () => {
    const parsed = await parseInboundContent(
      baseMsg({ message_type: "file", content: "什么都不是" }),
    );
    expect(parsed.unsupported).toBe("文件消息缺少 file_key");
  });

  it("image 消息 enrichment `![Image](img_xxx)` 形态兜底提取", async () => {
    // 复用 markdown 图 fixture 的最小 PNG
    const p = path.join(
      os.tmpdir(),
      `feishu-img-fallback-${Date.now()}.png`,
    );
    const buf = Buffer.alloc(64, 1);
    buf.write("\x89PNG\r\n\x1a\n", 0);
    await fs.writeFile(p, buf);
    tmpFiles.push(p);
    __setRouterDepsForTest({
      downloadMessageResource: async () => p,
    });
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "image",
        content: "![Image](img_v3_fallback_key)",
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    expect(parsed.images).toHaveLength(1);
  });
});

describe("isActiveChatTask", () => {
  it("mode=chat + developing + 2h 内 = 活跃", () => {
    const t = mockTask();
    expect(isActiveChatTask(t)).toBe(true);
  });
  it("终态 / 过期 / 非 chat 不活跃", () => {
    expect(isActiveChatTask(mockTask({ repoStatus: "abandoned" }))).toBe(false);
    expect(isActiveChatTask(mockTask({ mode: "task" }))).toBe(false);
    // 活跃窗已缩到 2h：3h 前更新不再算「进行中」（指针路由仍可进）
    expect(
      isActiveChatTask(
        mockTask({ updatedAt: Date.now() - 3 * 60 * 60 * 1000 }),
      ),
    ).toBe(false);
  });
});

describe("routeInboundMessage", () => {
  const sendText = vi.fn(async () => ({ chat_id: "c", message_id: "m" }));
  const handleChat = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const injectAsk = vi.fn<
    (
      taskId: string,
      text: string,
      boot?: unknown,
      images?: Array<{ data: string; mimeType: string; filename?: string }>,
    ) => Promise<{ ok: true }>
  >(async () => ({ ok: true as const }));
  const findByRoot = vi.fn<
    (id: string) => Promise<{
      messageId: string;
      cardId: string;
      taskId: string;
      createdAt: number;
    } | null>
  >(async () => null);
  // bot 提示消息记 card-map（「已开新对话」记 / 多对话列表不记）
  const remember = vi.fn(async () => undefined);
  // REST 反查消息详情（事件缺 root_id/parent_id 时补齐锚定）；默认查无此消息
  const larkApiMock = vi.fn(
    async (): Promise<Record<string, unknown>> => ({ data: { items: [] } }),
  );
  const listTasks = vi.fn(async () => [mockTask()]);
  const getPending = vi.fn(
    (): {
      askId: string;
      token: string;
      questions: Array<{ id: string; question: string; allowText: boolean }>;
      createdAt: number;
    } | null => null,
  );
  const results: Array<{ kind: string }> = [];

  beforeEach(async () => {
    await __resetBridgeStateForTest();
    sendText.mockClear();
    handleChat.mockClear();
    injectAsk.mockClear();
    findByRoot.mockClear();
    remember.mockClear();
    larkApiMock.mockClear();
    larkApiMock.mockResolvedValue({ data: { items: [] } });
    listTasks.mockClear();
    listTasks.mockResolvedValue([mockTask()]);
    getPending.mockClear();
    getPending.mockReturnValue(null);
    results.length = 0;
    __clearBridgeCommandsForTest();
    onInjectResult((p) => {
      results.push(p);
    });
    __setRouterDepsForTest({
      getBotAppInfo: async () => ({
        appId: "cli_x",
        ownerOpenId: "ou_owner",
      }),
      sendTextMessage: sendText,
      downloadMessageResource: async () => "/tmp/x",
      findTaskByMessageId: findByRoot,
      rememberCardMessage: remember,
      larkApi: larkApiMock as never,
      listTasks,
      createTask: async (input) =>
        ({
          id: "task-new",
          title: input.title,
          mode: "chat",
        }) as never,
      getPendingAsk: getPending as never,
      handleChatReplyInject: handleChat as never,
      injectPendingAskText: injectAsk as never,
      readSettingsFile: async () => ({
        status: "ok" as const,
        settings: {
          apiKey: "sk-test",
          defaultModel: { id: "gpt-5" },
          repos: [{ path: "/tmp/repo" }],
        },
      }),
      listSkillsWithSource: async () => [],
      prewarmTaskWorkspace: () => undefined,
    });
  });

  afterEach(async () => {
    __setRouterDepsForTest(null);
    onInjectResult(null);
    __clearBridgeCommandsForTest();
    await __resetBridgeStateForTest();
  });

  it("非 p2p / 非本人 → skipped", async () => {
    const r1 = await routeInboundMessage(
      baseMsg({ chat_type: "group" }),
    );
    expect(r1.kind).toBe("skipped");
    const r2 = await routeInboundMessage(
      baseMsg({ sender_id: "ou_other" }),
    );
    expect(r2.kind).toBe("skipped");
    expect(handleChat).not.toHaveBeenCalled();
  });

  it("root_id 精确路由", async () => {
    findByRoot.mockResolvedValueOnce({
      messageId: "om_card",
      cardId: "c1",
      taskId: "task-anchored",
      createdAt: Date.now(),
    });
    await routeInboundMessage(baseMsg({ root_id: "om_card", content: "续" }));
    expect(handleChat).toHaveBeenCalledWith(
      "task-anchored",
      expect.objectContaining({ text: "续" }),
      expect.objectContaining({
        userReplyMetaExtra: {
          source: "feishu",
          feishuMessageId: "om_test_1",
        },
      }),
    );
    // 事件自带锚定 id 时不反查 REST
    expect(larkApiMock).not.toHaveBeenCalled();
  });

  it("回复锚定命中 → 刷新当前对话指针", async () => {
    findByRoot.mockResolvedValueOnce({
      messageId: "om_card",
      cardId: "c1",
      taskId: "task-anchored",
      createdAt: Date.now(),
    });
    await routeInboundMessage(baseMsg({ root_id: "om_card", content: "续" }));
    expect(await getCurrentChatTaskId()).toBe("task-anchored");
  });

  it("直发走当前对话指针 → 多活跃也不提示", async () => {
    // 指针指向超过 2h 的对话仍可直进（不看活跃窗）
    await setCurrentChatTaskId("task-stale");
    listTasks.mockResolvedValue([
      mockTask({ id: "task-other", title: "另一个" }),
      mockTask({
        id: "task-stale",
        title: "过期但仍可指针",
        updatedAt: Date.now() - 3 * 60 * 60 * 1000,
      }),
      mockTask({ id: "task-third", title: "第三个" }),
    ]);
    const r = await routeInboundMessage(baseMsg({ content: "下午继续" }));
    expect(r.kind).toBe("sent");
    expect(handleChat).toHaveBeenCalledWith(
      "task-stale",
      expect.objectContaining({ text: "下午继续" }),
      expect.anything(),
    );
    expect(sendText).not.toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("进行中的对话"),
    );
    expect(await getCurrentChatTaskId()).toBe("task-stale");
  });

  it("指针失效（删了/终态）→ 清指针后走活跃数兜底", async () => {
    await setCurrentChatTaskId("task-gone");
    listTasks.mockResolvedValue([
      mockTask({ id: "a", title: "A" }),
      mockTask({ id: "b", title: "B" }),
    ]);
    const r = await routeInboundMessage(baseMsg({ content: "哪一个" }));
    expect(r.kind).toBe("skipped");
    expect(handleChat).not.toHaveBeenCalled();
    expect(await getCurrentChatTaskId()).toBe("");
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("进行中的对话"),
    );
  });

  it("指针指向终态 task → 清指针后走兜底", async () => {
    await setCurrentChatTaskId("task-dead");
    listTasks.mockResolvedValue([
      mockTask({
        id: "task-dead",
        title: "已弃",
        repoStatus: "abandoned",
      }),
      mockTask({ id: "task-only", title: "唯一活跃" }),
    ]);
    await routeInboundMessage(baseMsg({ content: "继续" }));
    expect(handleChat).toHaveBeenCalledWith(
      "task-only",
      expect.objectContaining({ text: "继续" }),
      expect.anything(),
    );
    expect(await getCurrentChatTaskId()).toBe("task-only");
  });

  it("0 活跃自动新建 → 指针指向新对话", async () => {
    listTasks.mockResolvedValueOnce([]);
    await routeInboundMessage(baseMsg({ content: "全新话题" }));
    expect(await getCurrentChatTaskId()).toBe("task-new");
  });

  it("ended 对话不算进行中：直发走剩余唯一活跃、不提示多对话", async () => {
    // 清理卡「结束」过 task-ended → 活跃口径出局，剩 task-live 唯一
    await addEndedChatTaskId("task-ended");
    listTasks.mockResolvedValue([
      mockTask({ id: "task-ended", title: "已结束的" }),
      mockTask({ id: "task-live", title: "还活着的" }),
    ]);
    const r = await routeInboundMessage(baseMsg({ content: "继续聊" }));
    expect(r.kind).toBe("sent");
    expect(handleChat).toHaveBeenCalledWith(
      "task-live",
      expect.objectContaining({ text: "继续聊" }),
      expect.anything(),
    );
  });

  it("ended 对话复活：回复旧卡片锚定命中 → 出 ended 集合 + 指针切换", async () => {
    await addEndedChatTaskId("task-revive");
    findByRoot.mockResolvedValueOnce({
      messageId: "om_old_card",
      cardId: "c9",
      taskId: "task-revive",
      createdAt: Date.now(),
    });
    const r = await routeInboundMessage(
      baseMsg({ root_id: "om_old_card", content: "再聊聊这个" }),
    );
    expect(r.kind).toBe("sent");
    expect(handleChat).toHaveBeenCalledWith(
      "task-revive",
      expect.objectContaining({ text: "再聊聊这个" }),
      expect.anything(),
    );
    // 复活：移出 ended + 指针切过去
    expect(await getEndedChatTaskIds()).not.toContain("task-revive");
    expect(await getCurrentChatTaskId()).toBe("task-revive");
  });

  it("回复清理卡（card-map taskId 空串）→ 不当锚定、走兜底", async () => {
    findByRoot.mockResolvedValueOnce({
      messageId: "om_cleanup_card",
      cardId: "card_cleanup",
      taskId: "",
      createdAt: Date.now(),
    });
    // 唯一活跃 task-1 → 兜底直进
    await routeInboundMessage(
      baseMsg({ root_id: "om_cleanup_card", content: "回在清理卡上" }),
    );
    expect(handleChat).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ text: "回在清理卡上" }),
      expect.anything(),
    );
  });

  it("只有 parent_id 也能锚定（root_id 缺失）", async () => {
    findByRoot.mockImplementation(async (id: string) =>
      id === "om_parent"
        ? {
            messageId: "om_parent",
            cardId: "c2",
            taskId: "task-parent",
            createdAt: Date.now(),
          }
        : null,
    );
    await routeInboundMessage(
      baseMsg({ parent_id: "om_parent", content: "回父" }),
    );
    expect(handleChat).toHaveBeenCalledWith(
      "task-parent",
      expect.objectContaining({ text: "回父" }),
      expect.anything(),
    );
    findByRoot.mockReset();
    findByRoot.mockResolvedValue(null);
  });

  // 实证：event consume 的 NDJSON 不含 root_id/parent_id——缺字段时按 message_id 反查 REST 补齐
  it("事件缺 root_id/parent_id → REST 反查补齐后锚定", async () => {
    larkApiMock.mockResolvedValueOnce({
      data: {
        items: [
          {
            message_id: "om_test_1",
            root_id: "om_card_rest",
            parent_id: "om_card_rest",
          },
        ],
      },
    });
    findByRoot.mockImplementation(async (id: string) =>
      id === "om_card_rest"
        ? {
            messageId: "om_card_rest",
            cardId: "c3",
            taskId: "task-rest",
            createdAt: Date.now(),
          }
        : null,
    );
    await routeInboundMessage(baseMsg({ content: "我回复" }));
    expect(larkApiMock).toHaveBeenCalledWith(
      "GET",
      "/open-apis/im/v1/messages/om_test_1",
    );
    expect(handleChat).toHaveBeenCalledWith(
      "task-rest",
      expect.objectContaining({ text: "我回复" }),
      expect.anything(),
    );
    // root_id === parent_id 去重、card-map 只查一次
    expect(findByRoot).toHaveBeenCalledTimes(1);
    findByRoot.mockReset();
    findByRoot.mockResolvedValue(null);
  });

  it("REST 反查失败 → 静默走活跃兜底、不炸", async () => {
    larkApiMock.mockRejectedValueOnce(new Error("boom"));
    await routeInboundMessage(baseMsg({ content: "普通消息" }));
    // 唯一活跃 → 正常注入
    expect(handleChat).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ text: "普通消息" }),
      expect.anything(),
    );
  });

  it("0 个活跃 → 自动新建（对齐 useNewChat：repoPaths 空 + 带 MCP 黑名单）+「已开新对话」记 card-map", async () => {
    const createTaskSpy = vi.fn(
      async (input: {
        title: string;
        repoPaths?: string[];
        disabledMcpServers?: string[];
      }) =>
        ({
          id: "task-new",
          title: input.title,
          mode: "chat",
        }) as never,
    );
    sendText.mockResolvedValueOnce({ chat_id: "c", message_id: "om_bot_tip" });
    __setRouterDepsForTest({
      createTask: createTaskSpy as never,
      readSettingsFile: async () => ({
        status: "ok" as const,
        settings: {
          apiKey: "sk-test",
          defaultModel: { id: "gpt-5" },
          repos: [{ path: "/tmp/repo" }],
          disabledMcpServers: ["mcp-a", "mcp-b"],
        },
      }),
    });
    listTasks.mockResolvedValueOnce([]);
    await routeInboundMessage(baseMsg({ content: "开个新话题吧朋友们" }));
    expect(handleChat).toHaveBeenCalledWith(
      "task-new",
      expect.anything(),
      expect.anything(),
    );
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("已开新对话"),
    );
    // 对齐 app 内一键新建：不绑工作目录、MCP 黑名单来自 settings
    expect(createTaskSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPaths: [],
        disabledMcpServers: ["mcp-a", "mcp-b"],
      }),
    );
    // task 绑定类提示 → 回复它可锚定
    expect(remember).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "om_bot_tip",
        cardId: "",
        taskId: "task-new",
      }),
    );
  });

  it("settings 无 MCP 黑名单 → 不传 disabledMcpServers（不显式传空数组）", async () => {
    const createTaskSpy = vi.fn(
      async (input: { title: string }) =>
        ({
          id: "task-new",
          title: input.title,
          mode: "chat",
        }) as never,
    );
    __setRouterDepsForTest({ createTask: createTaskSpy as never });
    listTasks.mockResolvedValueOnce([]);
    await routeInboundMessage(baseMsg({ content: "新话题" }));
    expect(createTaskSpy).toHaveBeenCalledWith(
      expect.objectContaining({ repoPaths: [], disabledMcpServers: undefined }),
    );
  });

  it("≥2 个活跃 → 提示并丢弃、提示消息不记 card-map", async () => {
    listTasks.mockResolvedValueOnce([
      mockTask({ id: "a", title: "A" }),
      mockTask({ id: "b", title: "B" }),
    ]);
    const r = await routeInboundMessage(baseMsg({ content: "哪一个" }));
    expect(r.kind).toBe("skipped");
    expect(handleChat).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("进行中的对话"),
    );
    // 多对话列表不绑定 task → 不记 card-map
    expect(remember).not.toHaveBeenCalled();
  });

  it("pendingAsk → ask 分流", async () => {
    getPending.mockReturnValue({
      askId: "ask-1",
      token: "t",
      questions: [{ id: "q1", question: "Q?", allowText: true }],
      createdAt: Date.now(),
    });
    await routeInboundMessage(baseMsg({ content: "答案是 42" }));
    expect(injectAsk).toHaveBeenCalled();
    expect(handleChat).not.toHaveBeenCalled();
    expect(results.at(-1)?.kind).toBe("sent");
  });

  // R1-5：带图答 ask → images 穿透到 injectPendingAskText
  it("pendingAsk 带图 → images 穿透给 injectPendingAskText", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-ask-img-"));
    const imgPath = path.join(tmpDir, "a.png");
    // 最小合法 PNG 头 + 几字节（fileToBase64Image 只看体积与扩展名）
    await fs.writeFile(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    getPending.mockReturnValue({
      askId: "ask-img",
      token: "t",
      questions: [{ id: "q1", question: "看图？", allowText: true }],
      createdAt: Date.now(),
    });
    __setRouterDepsForTest({
      downloadMessageResource: async () => imgPath,
    });

    await routeInboundMessage(
      baseMsg({
        message_id: "om_ask_img",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_k1" }),
      }),
    );
    expect(injectAsk).toHaveBeenCalled();
    const args = injectAsk.mock.calls.at(-1)!;
    expect(args[0]).toBe("task-1");
    // 纯图无正文 → router 垫 "(附图/附件)"
    expect(args[1]).toBe("(附图/附件)");
    expect(Array.isArray(args[3])).toBe(true);
    expect(args[3]!.length).toBe(1);
    expect(args[3]![0]).toMatchObject({
      mimeType: expect.stringMatching(/image\//),
      data: expect.any(String),
    });
    expect(handleChat).not.toHaveBeenCalled();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("命令 handled_failed → emit failed（不 retryable）", async () => {
    registerBridgeCommand("boom", async () => "handled_failed");
    const r = await routeInboundMessage(baseMsg({ content: "/boom" }));
    expect(r.kind).toBe("failed");
    expect(r.retryable).toBeFalsy();
    expect(handleChat).not.toHaveBeenCalled();
    expect(results.at(-1)?.kind).toBe("failed");
  });

  it("命令 handler 注册后可 handled 短路", async () => {
    const fn = vi.fn(async () => "handled" as const);
    registerBridgeCommand("ping", fn);
    await routeInboundMessage(baseMsg({ content: "/ping" }));
    expect(fn).toHaveBeenCalled();
    expect(handleChat).not.toHaveBeenCalled();
  });

  it("未注册的 /xxx 命中本机 skill → 当 skill 消息（带 skills 字段）", async () => {
    __setRouterDepsForTest({
      listSkillsWithSource: async () =>
        [
          {
            name: "写代码",
            description: "d",
            absPath: "/skills/写代码/SKILL.md",
            source: "app",
            editable: true,
          },
        ] as never,
    });
    await routeInboundMessage(baseMsg({ content: "/写代码帮我改下" }));
    expect(handleChat).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        text: "帮我改下",
        skills: [{ name: "写代码", absPath: "/skills/写代码/SKILL.md" }],
      }),
      expect.anything(),
    );
  });

  it("未命中命令也未命中 skill 的 /xxx → 当普通文本放行", async () => {
    await routeInboundMessage(baseMsg({ content: "/notacmd 你好" }));
    expect(handleChat).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ text: "/notacmd 你好", skills: undefined }),
      expect.anything(),
    );
  });

  it("202 入队响应 → kind=queued", async () => {
    handleChat.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, queued: true, queuedCount: 1 }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await routeInboundMessage(baseMsg({ content: "排队吧" }));
    expect(r.kind).toBe("queued");
  });

  it("注入失败 → 文本回执", async () => {
    handleChat.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "排队已满" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await routeInboundMessage(baseMsg({ content: "忙吗" }));
    expect(r.kind).toBe("failed");
    expect(sendText).toHaveBeenCalledWith("ou_owner", "排队已满");
  });

  // review P1#2：入向文件 >50MB 拒注入
  it("文件超过 50MB → unsupported + 删临时文件 + 不注入", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-file-"));
    const bigPath = path.join(tmpDir, "big.bin");
    await fs.writeFile(bigPath, "");
    await fs.truncate(bigPath, 50 * 1024 * 1024 + 1);

    __setRouterDepsForTest({
      downloadMessageResource: async () => bigPath,
    });

    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "file",
        content: JSON.stringify({ file_key: "fk", file_name: "big.bin" }),
      }),
    );
    expect(parsed.unsupported).toBe("文件超过 50MB 上限");
    expect(parsed.attachments).toEqual([]);
    await expect(fs.stat(bigPath)).rejects.toThrow();

    // 再走完整 route：下载另一个超限文件 → 失败回执、不注入
    const big2 = path.join(tmpDir, "big2.bin");
    await fs.writeFile(big2, "");
    await fs.truncate(big2, 50 * 1024 * 1024 + 1);
    __setRouterDepsForTest({
      downloadMessageResource: async () => big2,
      getBotAppInfo: async () => ({
        appId: "cli_x",
        ownerOpenId: "ou_owner",
      }),
      sendTextMessage: sendText,
      findTaskByMessageId: findByRoot,
      listTasks,
      createTask: async (input) =>
        ({
          id: "task-new",
          title: input.title,
          mode: "chat",
        }) as never,
      getPendingAsk: getPending as never,
      handleChatReplyInject: handleChat as never,
      injectPendingAskText: injectAsk as never,
      readSettingsFile: async () => ({
        status: "ok" as const,
        settings: {
          apiKey: "sk-test",
          defaultModel: { id: "gpt-5" },
          repos: [{ path: "/tmp/repo" }],
        },
      }),
      listSkillsWithSource: async () => [],
      prewarmTaskWorkspace: () => undefined,
    });
    const r = await routeInboundMessage(
      baseMsg({
        message_type: "file",
        content: JSON.stringify({ file_key: "fk2", file_name: "x.bin" }),
        message_id: "om_big2",
      }),
    );
    expect(r.kind).toBe("failed");
    expect(sendText).toHaveBeenCalledWith("ou_owner", "文件超过 50MB 上限");
    expect(handleChat).not.toHaveBeenCalled();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
