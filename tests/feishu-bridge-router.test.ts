/**
 * 飞书桥接 router：过滤 / content 形态 / 活跃 chat 分支 / pendingAsk / 命令扩展点
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getBridgeDataDir } from "@/lib/server/feishu-bridge/bridge-config";
import {
  addEndedChatTaskId,
  getCurrentChatTaskId,
  getEndedChatTaskIds,
  setCurrentChatTaskId,
} from "@/lib/server/feishu-bridge/bridge-state";
import {
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

import {
  baseRouterDeps,
  installBridgeTestHooks,
  makeBridgeTmpDataDir,
} from "./helpers/feishu-bridge-harness";

// 指针路由读写真实 bridge-state 文件——隔离到独立 tmp、避免污染 cwd/data
const TMP = makeBridgeTmpDataDir("feishu-bridge-router");
installBridgeTestHooks({ tmpRoot: TMP });

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

/**
 * 附件落点断言：`<bridge>/attachments/<messageId>/<6 位 hex 前缀>-<净化后的原文件名>`。
 * 文件名由发件人决定，不能再直接落在 bridge 顶层（会覆盖 bridge-state.json 等状态文件，见 attachment-store）。
 */
const expectPlacedAttachment = (
  abs: string,
  expectedName: string,
  messageId = "om_test_1",
): void => {
  expect(path.basename(abs)).toMatch(/^[0-9a-f]{6}-/);
  expect(path.basename(abs).slice(7)).toBe(expectedName);
  expect(path.basename(path.dirname(abs))).toBe(messageId);
  expect(path.basename(path.dirname(path.dirname(abs)))).toBe("attachments");
};

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
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, key) => {
          downloaded.push(key);
          return png;
        },
      }),
    );
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
    __setRouterDepsForTest(baseRouterDeps({ downloadMessageResource: async () => png }));
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "post",
        content: "![Image](img_v2_abc123_xyz)",
      }),
    );
    expect(parsed.text).toBe("");
    expect(parsed.images).toHaveLength(1);
  });

  it("超过 10MB 的图：先 stat 判定、不把整个文件读进内存（旧实现 readFile 完才判大小）；图被跳过、临时文件照删", async () => {
    const big = await makePng();
    await fs.truncate(big, 11 * 1024 * 1024); // 稀疏文件：stat 为 11MB、几乎不占盘
    __setRouterDepsForTest(baseRouterDeps({ downloadMessageResource: async () => big }));
    const readSpy = vi.spyOn(fs, "readFile");
    try {
      const parsed = await parseInboundContent(
        baseMsg({ message_type: "text", content: "看 ![图](img_v3_big_one)" }),
      );
      expect(parsed.images).toHaveLength(0);
      expect(readSpy.mock.calls.some((c) => c[0] === big)).toBe(false);
      await expect(fs.stat(big)).rejects.toThrow(); // 转完即删：超限的也不留
    } finally {
      readSpy.mockRestore();
    }
  });

  it("text 类型带 markdown 图同样提取", async () => {
    const png = await makePng();
    __setRouterDepsForTest(baseRouterDeps({ downloadMessageResource: async () => png }));
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
    const keys: string[] = [];
    __setRouterDepsForTest(
      baseRouterDeps({
        // 生产每个 key 独立下载成不同文件（代码转完即删）——mock 也按 key 建独立文件
        downloadMessageResource: async (_mid, key) => {
          keys.push(key);
          return makePng();
        },
      }),
    );
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
    __setRouterDepsForTest(baseRouterDeps({ downloadMessageResource: async () => png }));
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

  // 夹具文件放进 bridge 目录（与生产 downloadMessageResource 的落点一致）：
  // 附件会被挪进 `<bridge>/attachments/<messageId>/`，不污染系统 tmp
  const makeTmpFile = async (): Promise<string> => {
    const p = path.join(
      await getBridgeDataDir(),
      `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.writeFile(p, "file-content");
    tmpFiles.push(p);
    return p;
  };

  it("enrichment `<file key name/>` 形态 → 提取 file_key + 保留原文件名", async () => {
    const tmp = await makeTmpFile();
    const downloaded: Array<{ key: string; type: string }> = [];
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, key, type) => {
          downloaded.push({ key, type });
          return tmp;
        },
      }),
    );
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
    expectPlacedAttachment(parsed.attachments[0]!, "报告 v2.pdf");
    tmpFiles.push(parsed.attachments[0]!);
  });

  it("markdown `[名称](file_key)` 链接形态同样提取", async () => {
    const tmp = await makeTmpFile();
    __setRouterDepsForTest(baseRouterDeps({ downloadMessageResource: async () => tmp }));
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "file",
        content: "[notes.txt](file_v3_abc_def123)",
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    expect(parsed.attachments).toHaveLength(1);
    expectPlacedAttachment(parsed.attachments[0]!, "notes.txt");
    tmpFiles.push(parsed.attachments[0]!);
  });

  it("JSON content 形态（补拉路径）不回归", async () => {
    const tmp = await makeTmpFile();
    __setRouterDepsForTest(baseRouterDeps({ downloadMessageResource: async () => tmp }));
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
    expectPlacedAttachment(parsed.attachments[0]!, "data.csv");
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
    __setRouterDepsForTest(baseRouterDeps({ downloadMessageResource: async () => p }));
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "image",
        content: "![Image](img_v3_fallback_key)",
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    expect(parsed.images).toHaveLength(1);
    // 原图转完即删，不堆积
    await expect(fs.access(p)).rejects.toThrow();
  });
});

describe("parseInboundContent 视频消息 media", () => {
  const tmpFiles: string[] = [];

  afterEach(async () => {
    __setRouterDepsForTest(null);
    for (const p of tmpFiles.splice(0)) {
      await fs.unlink(p).catch(() => undefined);
    }
  });

  const makeTmpPng = async (): Promise<string> => {
    const p = path.join(os.tmpdir(), `feishu-cover-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    const buf = Buffer.alloc(64, 1);
    buf.write("\x89PNG\r\n\x1a\n", 0);
    await fs.writeFile(p, buf);
    tmpFiles.push(p);
    return p;
  };

  const makeTmpVideo = async (): Promise<string> => {
    // 同上：放进 bridge 目录，视频本体会被挪进 attachments/<messageId>/
    const p = path.join(await getBridgeDataDir(), `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.writeFile(p, "video-content");
    tmpFiles.push(p);
    return p;
  };

  it("JSON 双 key → 封面进 images、视频本体进 attachments", async () => {
    const cover = await makeTmpPng();
    const video = await makeTmpVideo();
    const downloaded: Array<{ key: string; type: string }> = [];
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, key, type) => {
          downloaded.push({ key, type });
          return type === "image" ? cover : video;
        },
      }),
    );
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "media",
        content: JSON.stringify({
          file_key: "file_v3_video_key",
          image_key: "img_v3_cover_key",
        }),
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    expect(downloaded).toEqual([
      { key: "img_v3_cover_key", type: "image" },
      { key: "file_v3_video_key", type: "file" },
    ]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.attachments).toHaveLength(1);
    expectPlacedAttachment(parsed.attachments[0]!, "video.mp4");
    tmpFiles.push(parsed.attachments[0]!);
  });

  it("无封面 image_key → 只有视频附件、照样可收", async () => {
    const video = await makeTmpVideo();
    __setRouterDepsForTest(baseRouterDeps({ downloadMessageResource: async () => video }));
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "media",
        content: JSON.stringify({ file_key: "file_v3_video_only" }),
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    expect(parsed.images).toHaveLength(0);
    expect(parsed.attachments).toHaveLength(1);
    tmpFiles.push(parsed.attachments[0]!);
  });

  it("封面下载失败 → 视频照收、不整单报错", async () => {
    const video = await makeTmpVideo();
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, _key, type) => {
          if (type === "image") throw new Error("cover 404");
          return video;
        },
      }),
    );
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "media",
        content: JSON.stringify({
          file_key: "file_v3_video_key",
          image_key: "img_v3_cover_key",
        }),
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    expect(parsed.images).toHaveLength(0);
    expect(parsed.attachments).toHaveLength(1);
    tmpFiles.push(parsed.attachments[0]!);
  });

  it("封面转完即删：bridge 目录无 TTL，不堆积 dl-* 小图", async () => {
    const cover = await makeTmpPng();
    const video = await makeTmpVideo();
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, _key, type) =>
          type === "image" ? cover : video,
      }),
    );
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "media",
        content: JSON.stringify({
          file_key: "file_v3_video_key",
          image_key: "img_v3_cover_key",
        }),
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    expect(parsed.images).toHaveLength(1);
    await expect(fs.access(cover)).rejects.toThrow();
    tmpFiles.push(parsed.attachments[0]!);
  });

  it("enrichment `<file key/>` 形态兜底 file_key（file 分支 T4 同款）", async () => {
    const video = await makeTmpVideo();
    const downloaded: Array<{ key: string; type: string }> = [];
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, key, type) => {
          downloaded.push({ key, type });
          return video;
        },
      }),
    );
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "media",
        content: '<file key="file_v3_enrich_key" name="现场.mp4"/>',
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    expect(downloaded).toEqual([{ key: "file_v3_enrich_key", type: "file" }]);
    expect(parsed.attachments).toHaveLength(1);
    tmpFiles.push(parsed.attachments[0]!);
  });

  it("无 file_key → unsupported（保持诚实报错）", async () => {
    const parsed = await parseInboundContent(
      baseMsg({ message_type: "media", content: "什么都不是" }),
    );
    expect(parsed.unsupported).toBe("视频消息缺少 file_key");
  });

  it("抽帧一张没推进去 → 文案不写画面见附图", async () => {
    const cover = await makeTmpPng();
    const big = path.join(os.tmpdir(), `feishu-bigvideo3-${Date.now()}.bin`);
    const fh = await fs.open(big, "w");
    await fh.truncate(60 * 1024 * 1024);
    await fh.close();
    tmpFiles.push(big);
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, _key, type) =>
          type === "image" ? cover : big,
        // 模拟帧全被预算闸拦：返回空帧列表但有时长
        extractVideoPreview: async () => ({ framePaths: [], durationSec: 61 }),
      }),
    );
    // 封面也删掉，逼出 images 为空
    await fs.unlink(cover).catch(() => undefined);
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "media",
        content: JSON.stringify({
          file_key: "file_v3_big_video",
          image_key: "img_v3_cover_key",
        }),
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    expect(parsed.images).toHaveLength(0);
    expect(parsed.text).toContain("1分01秒");
    expect(parsed.text).not.toContain("画面见附图");
  });

  it("大视频（>50MB 稀疏文件）→ 抽帧进 images、原文件删除、不 unsupported", async () => {
    const cover = await makeTmpPng();
    // 稀疏文件：stat 报 60MB、实际不占盘
    const big = path.join(os.tmpdir(), `feishu-bigvideo-${Date.now()}.bin`);
    const fh = await fs.open(big, "w");
    await fh.truncate(60 * 1024 * 1024);
    await fh.close();
    tmpFiles.push(big);
    const frame = await makeTmpPng();
    const previews: Array<{ abs: string }> = [];
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, _key, type) =>
          type === "image" ? cover : big,
        extractVideoPreview: async (abs: string) => {
          previews.push({ abs });
          return { framePaths: [frame], durationSec: 125 };
        },
      }),
    );
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "media",
        content: JSON.stringify({
          file_key: "file_v3_big_video",
          image_key: "img_v3_cover_key",
        }),
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    // 封面 + 1 抽帧
    expect(parsed.images).toHaveLength(2);
    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.text).toContain("2分05秒");
    expect(parsed.text).toContain("60MB");
    expect(parsed.text).toContain("过大");
    // 抽帧拿到的是下载到的原文件、且原文件已被删除
    expect(previews).toHaveLength(1);
    await expect(fs.access(big)).rejects.toThrow();
    tmpFiles.push(frame);
  });

  it("大视频 + 无 ffmpeg（preview null）→ 封面 + 文字交代、照样收下", async () => {
    const cover = await makeTmpPng();
    const big = path.join(os.tmpdir(), `feishu-bigvideo2-${Date.now()}.bin`);
    const fh = await fs.open(big, "w");
    await fh.truncate(2 * 1024 * 1024 * 1024);
    await fh.close();
    tmpFiles.push(big);
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, _key, type) =>
          type === "image" ? cover : big,
        extractVideoPreview: async () => null,
      }),
    );
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "media",
        content: JSON.stringify({
          file_key: "file_v3_huge_video",
          image_key: "img_v3_cover_key",
        }),
      }),
    );
    expect(parsed.unsupported).toBeUndefined();
    expect(parsed.images).toHaveLength(1);
    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.text).toContain("2.0GB");
    expect(parsed.text).toContain("过大");
    await expect(fs.access(big)).rejects.toThrow();
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

  /** 本 describe 的 deps 基线（外部 IO 由 harness 铺满、这里只挂本文件的 spy） */
  const applyDeps = (
    overrides: Parameters<typeof baseRouterDeps>[0] = {},
  ): void => {
    __setRouterDepsForTest(
      baseRouterDeps({
        sendTextMessage: sendText,
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
        ...overrides,
      }),
    );
  };

  beforeEach(() => {
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
    onInjectResult((p) => {
      results.push(p);
    });
    applyDeps();
  });

  afterEach(() => {
    onInjectResult(null);
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
    applyDeps({ downloadMessageResource: async () => big2 });
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

// P1：群里非属主的附件不能在鉴权 / 限流之前就下载，落盘文件名也不能由发件人决定。
// router 侧提供「预解析 + 延后下载」（deferDownloads）与「净化 + 子目录 + 唯一前缀」的落点；
// 闸门顺序（先过 owner / chat 型 / 忙线 / 限流、再 resolve）在 tests/group-route-attachment-gate.test.ts 钉。
describe("parseInboundContent deferDownloads（非属主预解析：先不下载）", () => {
  /** 在 bridge 目录顶层造一个「刚下载好」的产物（与 downloadMessageResource 的落点一致） */
  const makeDownload = async (content = "file-content"): Promise<string> => {
    const p = path.join(
      await getBridgeDataDir(),
      `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.writeFile(p, content);
    return p;
  };
  const makePng = async (): Promise<string> => {
    const p = await makeDownload();
    const buf = Buffer.alloc(64, 1);
    buf.write("\x89PNG\r\n\x1a\n", 0);
    await fs.writeFile(p, buf);
    return p;
  };
  const fileMsg = (over: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage =>
    baseMsg({
      message_type: "file",
      content: JSON.stringify({ file_key: "file_v3_defer", file_name: "报告.pdf" }),
      ...over,
    });

  it("文件消息：预解析不下载、带 deferred；resolve 才下载，落进 attachments/<messageId>/，再 resolve 命中缓存不重复下载", async () => {
    const downloaded: string[] = [];
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, key) => {
          downloaded.push(key);
          return makeDownload();
        },
      }),
    );

    const pre = await parseInboundContent(fileMsg(), { deferDownloads: true });
    expect(downloaded).toEqual([]); // 门外零下载
    expect(pre.unsupported).toBeUndefined();
    expect(pre.attachments).toEqual([]);
    expect(pre.deferred).toBeDefined();
    expect(pre.deferred!.hasImages).toBe(false);

    const full = await pre.deferred!.resolve();
    expect(downloaded).toEqual(["file_v3_defer"]);
    expect(full.attachments).toHaveLength(1);
    expectPlacedAttachment(full.attachments[0]!, "报告.pdf");
    expect(full.deferred).toBeUndefined();

    const again = await pre.deferred!.resolve();
    expect(downloaded).toEqual(["file_v3_defer"]); // 缓存：不重复下载
    expect(again).toBe(full);
  });

  it("图片消息：预解析 hasImages=true、不下载；resolve 后 images 才有", async () => {
    const downloaded: string[] = [];
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, key) => {
          downloaded.push(key);
          return makePng();
        },
      }),
    );
    const pre = await parseInboundContent(
      baseMsg({ message_type: "image", content: "![Image](img_v3_defer_key)" }),
      { deferDownloads: true },
    );
    expect(downloaded).toEqual([]);
    expect(pre.images).toEqual([]);
    expect(pre.deferred?.hasImages).toBe(true);

    const full = await pre.deferred!.resolve();
    expect(downloaded).toEqual(["img_v3_defer_key"]);
    expect(full.images).toHaveLength(1);
  });

  it("视频消息（封面 + 本体）：预解析既算图又算文件、不下载", async () => {
    const downloaded: string[] = [];
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, key) => {
          downloaded.push(key);
          return makeDownload();
        },
      }),
    );
    const pre = await parseInboundContent(
      baseMsg({
        message_type: "media",
        content: JSON.stringify({ file_key: "file_v3_video", image_key: "img_v3_cover" }),
      }),
      { deferDownloads: true },
    );
    expect(downloaded).toEqual([]);
    expect(pre.deferred?.hasImages).toBe(true);
  });

  it("文本里的 markdown 图 / 文件链接：预解析的正文与完整解析一致（占位已剥）、不下载", async () => {
    const downloaded: string[] = [];
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, key, type) => {
          downloaded.push(key);
          return type === "image" ? makePng() : makeDownload();
        },
      }),
    );
    const msg = baseMsg({
      message_type: "text",
      content: "看这张 ![图](img_v3_md_img) 和 [说明.txt](file_v3_md_file) 结束",
    });
    const pre = await parseInboundContent(msg, { deferDownloads: true });
    expect(downloaded).toEqual([]);
    expect(pre.deferred?.hasImages).toBe(true);

    const full = await pre.deferred!.resolve();
    expect(downloaded.sort()).toEqual(["file_v3_md_file", "img_v3_md_img"]);
    expect(pre.text).toBe(full.text);
    expect(pre.text).not.toContain("img_v3_md_img");
    expect(pre.text).not.toContain("file_v3_md_file");
  });

  it("没有资源（纯文本）/ unsupported：不带 deferred，预解析结果即最终结果", async () => {
    const text = await parseInboundContent(baseMsg({ content: "hello" }), { deferDownloads: true });
    expect(text.text).toBe("hello");
    expect(text.deferred).toBeUndefined();

    const bad = await parseInboundContent(
      baseMsg({ message_type: "file", content: "什么都不是" }),
      { deferDownloads: true },
    );
    expect(bad.unsupported).toBe("文件消息缺少 file_key");
    expect(bad.deferred).toBeUndefined();
  });

  it("不传 deferDownloads（属主 / p2p / 补拉）：立即下载、不带 deferred（与旧行为一致）", async () => {
    const downloaded: string[] = [];
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async (_mid, key) => {
          downloaded.push(key);
          return makeDownload();
        },
      }),
    );
    const parsed = await parseInboundContent(fileMsg());
    expect(downloaded).toEqual(["file_v3_defer"]);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.deferred).toBeUndefined();
  });

  it("resolve 失败不缓存：下载抛错 → resolve 拒绝；再 resolve 会重新下载（排队回放要能重试）", async () => {
    let calls = 0;
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async () => {
          calls += 1;
          if (calls === 1) throw new Error("lark 超时");
          return makeDownload();
        },
      }),
    );
    const pre = await parseInboundContent(fileMsg(), { deferDownloads: true });
    await expect(pre.deferred!.resolve()).rejects.toThrow("lark 超时");
    const full = await pre.deferred!.resolve();
    expect(calls).toBe(2);
    expect(full.attachments).toHaveLength(1);
  });

  it("resolve 后文件超 50MB：给 unsupported（调用方回执 + 退还限流名额），临时文件已删", async () => {
    const big = await makeDownload();
    const fh = await fs.open(big, "w");
    await fh.truncate(60 * 1024 * 1024); // 稀疏文件：stat 报 60MB、实际不占盘
    await fh.close();
    __setRouterDepsForTest(baseRouterDeps({ downloadMessageResource: async () => big }));

    const pre = await parseInboundContent(fileMsg(), { deferDownloads: true });
    const full = await pre.deferred!.resolve();
    expect(full.unsupported).toBe("文件超过 50MB 上限");
    expect(full.attachments).toEqual([]);
    const placed = path.join(await getBridgeDataDir(), "attachments", "om_test_1");
    const left = await fs.readdir(placed).catch(() => [] as string[]);
    expect(left).toEqual([]);
  });
});

describe("入向附件落盘：发件人文件名不能覆盖 bridge 状态文件 / 同名附件互不覆盖", () => {
  const makeDownload = async (content: string): Promise<string> => {
    const p = path.join(
      await getBridgeDataDir(),
      `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.writeFile(p, content);
    return p;
  };

  it.each(["bridge-state.json", "card-map.json", "card-seq.json", "config.json"])(
    "附件文件名 %s：同级状态文件原封不动、附件落进 attachments/<messageId>/ 且内容是发件人发的那份",
    async (evilName) => {
      const bridge = await getBridgeDataDir();
      const statePath = path.join(bridge, evilName);
      await fs.writeFile(statePath, "REAL-STATE");
      __setRouterDepsForTest(
        baseRouterDeps({ downloadMessageResource: async () => makeDownload("EVIL") }),
      );

      const parsed = await parseInboundContent(
        baseMsg({
          message_type: "file",
          content: JSON.stringify({ file_key: "file_v3_evil", file_name: evilName }),
        }),
      );

      expect(parsed.unsupported).toBeUndefined();
      expect(await fs.readFile(statePath, "utf-8")).toBe("REAL-STATE"); // 旧实现这里变成 EVIL
      expectPlacedAttachment(parsed.attachments[0]!, evilName);
      expect(await fs.readFile(parsed.attachments[0]!, "utf-8")).toBe("EVIL");
    },
  );

  it("文件名带路径穿越（../../）：落点仍在 attachments/<messageId>/ 之内", async () => {
    const bridge = await getBridgeDataDir();
    __setRouterDepsForTest(
      baseRouterDeps({ downloadMessageResource: async () => makeDownload("x") }),
    );
    const parsed = await parseInboundContent(
      baseMsg({
        message_type: "file",
        content: JSON.stringify({ file_key: "file_v3_trav", file_name: "../../../escape.txt" }),
      }),
    );
    const dest = parsed.attachments[0]!;
    const rel = path.relative(path.join(bridge, "attachments", "om_test_1"), dest);
    expect(rel.startsWith("..")).toBe(false);
    expect(rel).toBe(path.basename(dest));
  });

  it("同一条消息、同名附件解析两次：两份都在、互不覆盖", async () => {
    let n = 0;
    __setRouterDepsForTest(
      baseRouterDeps({
        downloadMessageResource: async () => makeDownload(`内容${(n += 1)}`),
      }),
    );
    const msg = baseMsg({
      message_type: "file",
      content: JSON.stringify({ file_key: "file_v3_same", file_name: "同名.pdf" }),
    });
    const a = (await parseInboundContent(msg)).attachments[0]!;
    const b = (await parseInboundContent(msg)).attachments[0]!;
    expect(a).not.toBe(b);
    expect(await fs.readFile(a, "utf-8")).toBe("内容1");
    expect(await fs.readFile(b, "utf-8")).toBe("内容2");
  });
});
