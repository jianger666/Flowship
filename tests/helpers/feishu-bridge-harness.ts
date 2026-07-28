/**
 * feishu-bridge 测试族公共基线（2026-07-27 立规、同族 flaky 第二次复现后收敛）
 *
 * 背景：本族 flaky 连着两轮都是同一根因族——
 *  - 7-24：r1-inbound 两条用例漏 mock `larkApi` → 真打飞书网络；用例间共享链没排空串味
 *  - 7-27：commands 的「/compact 按普通文本处理」漏 mock `larkApi` → 走注入主路径时
 *    `resolveReplyAnchorIds` 真 spawn 三次 lark-cli，单跑侥幸过、全量并发下超 5s 判死
 * 按本仓铁律（同族两轮 → 停止逐条打补丁、收敛成统一机制），基线归到本文件一处：
 *  1. {@link baseRouterDeps}：router 依赖的**全量**假实现（含 larkApi），新用例只覆盖关心的那几个
 *  2. {@link installBridgeTestHooks}：统一 beforeEach/afterEach——排空共享链 + 重建隔离数据目录
 *  3. 兜底闸在 `lark-api.ts`：vitest 下真起 lark-cli 直接抛（漏 mock 立刻炸、不再退化成随机超时）
 *
 * 等待一律用确定性信号（deferred / setImmediate / vi.waitFor），不要靠墙钟 sleep 猜时序。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, vi } from "vitest";

import { __resetBridgeStateForTest } from "@/lib/server/feishu-bridge/bridge-state";
import { __setCardMapMaxForTest } from "@/lib/server/feishu-bridge/card-map";
import { __resetInboundChainForTest } from "@/lib/server/feishu-bridge/inbound";
import {
  __resetBotAppInfoCacheForTest,
  __resetLarkBinCacheForTest,
} from "@/lib/server/feishu-bridge/lark-api";
import {
  __clearBridgeCommandsForTest,
  __clearInjectResultListenersForTest,
  __setRouterDepsForTest,
} from "@/lib/server/feishu-bridge/router";

/** 假 bot 属主 open_id：族内统一，省得每个文件各编一个 */
export const TEST_OWNER_OPEN_ID = "ou_owner";

// ----------------- 隔离数据目录 -----------------

/**
 * 给本测试文件圈一个独占的 tmp 数据根并写进 `FLOWSHIP_DATA_DIR`。
 * 必须在**模块顶层**调（`dataRoot()` 每次调用才读 env、所以 import 顺序无所谓，
 * 但要早于任何真正读写落盘的代码）。返回 tmp 根，交给 {@link installBridgeTestHooks} 管生命周期。
 */
export const makeBridgeTmpDataDir = (label: string): string => {
  const root = path.join(
    os.tmpdir(),
    `${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  process.env.FLOWSHIP_DATA_DIR = path.join(root, "data");
  return root;
};

// ----------------- 共享状态排空 -----------------

/**
 * 排空 feishu-bridge 的进程级共享状态。
 *
 * 顺序有讲究：**先排空在途链、再清盘**——入向链上未 await 的 handler 还会写
 * bridge-state / card-map，先删目录的话它们会在下一用例把文件重新写回来（串味）。
 */
export const resetBridgeSharedState = async (): Promise<void> => {
  // 入向单链：上一用例遗留的 handler 排干净，避免跨用例注入串味
  await __resetInboundChainForTest();
  // bridge-state：内部会先 await 写队列再删状态文件
  await __resetBridgeStateForTest();
  __setRouterDepsForTest(null);
  __clearBridgeCommandsForTest();
  __clearInjectResultListenersForTest();
  __resetLarkBinCacheForTest();
  __resetBotAppInfoCacheForTest();
};

/**
 * 挂族内统一的 beforeEach / afterEach / afterAll。
 * 在测试文件模块顶层调一次即可；文件自己的 hooks 照常写、跑在本 hooks 之后。
 */
export const installBridgeTestHooks = (opts: {
  /** {@link makeBridgeTmpDataDir} 的返回值 */
  tmpRoot: string;
  /** card-map 条目上限（只在需要验 FIFO 淘汰时传） */
  cardMapMax?: number;
}): void => {
  const { tmpRoot, cardMapMax } = opts;

  const freshTmp = async (): Promise<void> => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(tmpRoot, "data"), { recursive: true });
  };

  beforeEach(async () => {
    // 上一用例若在 fake timers 状态下失败，这里不复位会让后续所有等待永不触发
    vi.useRealTimers();
    await resetBridgeSharedState();
    await freshTmp();
    __setCardMapMaxForTest(cardMapMax ?? null);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await resetBridgeSharedState();
    __setCardMapMaxForTest(null);
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });
};

// ----------------- router 依赖基线 -----------------

type RouterDepsOverride = NonNullable<
  Parameters<typeof __setRouterDepsForTest>[0]
>;

/** 注入成功的 200 响应（chat-inject 的常见返回） */
export const okInjectResponse = (): Response =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** 注入失败响应（status ≥ 500 = 可重试基础设施类；4xx = 内容终态） */
export const failInjectResponse = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * router 的**全量**假依赖：任何一项漏给都会退回真实现（真打网 / 真读设置盘），
 * 所以这里一次性铺满，调用方只 override 自己关心的那几个。
 *
 * 重点：`larkApi` 必须给——`resolveReplyAnchorIds` 在事件缺 root/parent 时会拿它
 * 反查 REST，漏了就是真 spawn lark-cli（本族两轮 flaky 的共同根因）。
 */
export const baseRouterDeps = (
  overrides: RouterDepsOverride = {},
): RouterDepsOverride => ({
  getBotAppInfo: async () => ({
    appId: "cli_test",
    ownerOpenId: TEST_OWNER_OPEN_ID,
  }),
  sendTextMessage: async () => ({ chat_id: "oc_test", message_id: "om_sent" }),
  downloadMessageResource: async () => "/tmp/feishu-bridge-test-resource",
  findTaskByMessageId: async () => null,
  rememberCardMessage: async () => undefined,
  // 反查被回复消息的 parent/root：空结果即走活跃 chat 兜底，绝不能打真飞书
  larkApi: async () => ({ data: { items: [] } }),
  listTasks: async () => [],
  createTask: async () => ({ id: "task-new", title: "新对话" }) as never,
  getPendingAsk: () => null,
  handleChatReplyInject: async () => okInjectResponse(),
  injectPendingAskText: async () => ({ ok: true as const }),
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
  ...overrides,
});

// ----------------- 确定性信号 -----------------

/** 手动放行的 Promise 闸——替代「sleep 一会儿等它跑到某步」的墙钟猜时序 */
export const deferred = (): {
  promise: Promise<void>;
  resolve: () => void;
} => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/**
 * 让出一轮宏任务 + microtask 队列。
 *
 * 用于「已入队但按设计不该在闸放行前跑」这类**否定断言**：
 * 高负载下墙钟 sleep 既拖慢又给不出更强保证，setImmediate 才是确定性的「排空当前轮」。
 */
export const tick = async (times = 1): Promise<void> => {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
};
