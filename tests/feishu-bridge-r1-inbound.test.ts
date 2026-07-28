/**
 * R1 入向/基建族：串行链 / 去重 / RMW 写队列 / retryable / keep-awake 身份
 */
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  baseRouterDeps,
  deferred,
  failInjectResponse,
  installBridgeTestHooks,
  okInjectResponse,
  tick,
  makeBridgeTmpDataDir,
} from "./helpers/feishu-bridge-harness";

const TMP = makeBridgeTmpDataDir("feishu-bridge-r1-inbound");

const {
  defaultMessageHandler,
  enqueueInboundMessage,
} = await import("@/lib/server/feishu-bridge/inbound");
const {
  routeInboundMessage,
  __setRouterDepsForTest,
} = await import("@/lib/server/feishu-bridge/router");
type InjectResultPayload =
  import("@/lib/server/feishu-bridge/router").InjectResultPayload;
const {
  hasProcessedMessageId,
  markProcessedMessageId,
  rememberP2pChatId,
  getLastP2pChatId,
} = await import("@/lib/server/feishu-bridge/bridge-state");
const {
  rememberCardMessage,
  setLastProcessedTs,
  getLastProcessedTs,
  findTaskByMessageId,
} = await import("@/lib/server/feishu-bridge/card-map");
const { KeepAwake } = await import("@/lib/server/feishu-bridge/keep-awake");

// 排空共享链 + 重建隔离数据目录统一交给 harness（含 fake timers 复位——
// R1-8 中途失败会留下 fake timers、链重置里的 2s cap 会永不触发）
installBridgeTestHooks({ tmpRoot: TMP, cardMapMax: 50 });

/** 本族默认「唯一活跃 chat」，直发不触发多对话提示 */
const oneActiveChat = () =>
  [
    {
      id: "task-1",
      title: "t",
      mode: "chat",
      repoStatus: "developing",
      runStatus: "idle",
      updatedAt: Date.now(),
      createdAt: Date.now(),
    },
  ] as never;

/** 路由 deps 基线（larkApi 等外部 IO 已在 harness 里铺满） */
const routerDeps = (
  overrides: Parameters<typeof baseRouterDeps>[0] = {},
): void => {
  __setRouterDepsForTest(
    baseRouterDeps({
      listTasks: async () => oneActiveChat(),
      createTask: async () => ({ id: "task-1" }) as never,
      ...overrides,
    }),
  );
};

const baseRaw = (overrides: Record<string, unknown> = {}) => ({
  type: "im.message.receive_v1",
  message_id: "om_r1_1",
  create_time: String(Date.now()),
  chat_id: "oc_r1",
  chat_type: "p2p",
  message_type: "text",
  sender_id: "ou_owner",
  content: JSON.stringify({ text: "hello" }),
  ...overrides,
});

describe("R1-2a：入向单链按序注入", () => {
  it("并发两条消息按入队顺序注入（慢 A 不让快 B 抢先）", async () => {
    const order: string[] = [];
    const gateA = deferred();
    // 确定性信号：A 进入 inject 即 resolve，替代短 timeout waitFor（高负载下假红）
    const aStarted = deferred();

    routerDeps({
      handleChatReplyInject: async (_id, body) => {
        const text = (body as { text?: string }).text ?? "";
        if (text === "A") {
          order.push("A-start");
          aStarted.resolve();
          await gateA.promise;
          order.push("A-end");
        } else {
          order.push("B");
        }
        return okInjectResponse();
      },
    });

    const pA = defaultMessageHandler(
      baseRaw({
        message_id: "om_A",
        content: JSON.stringify({ text: "A" }),
      }),
    );
    await aStarted.promise;
    const pB = defaultMessageHandler(
      baseRaw({
        message_id: "om_B",
        content: JSON.stringify({ text: "B" }),
      }),
    );
    // B 已入队但不得在 A 结束前跑——排空当前几轮事件循环即可，不靠墙钟猜
    await tick(2);
    expect(order).toEqual(["A-start"]);
    gateA.resolve();
    await Promise.all([pA, pB]);
    expect(order).toEqual(["A-start", "A-end", "B"]);
  });
});

describe("R1-2b / R1-13e：live+catchup 同 message_id 只注入一次", () => {
  it("两条路径并发处理同 id → handleChat 只调一次", async () => {
    const inject = vi.fn(async () => okInjectResponse());
    routerDeps({ handleChatReplyInject: inject as never });

    // enqueueInboundMessage 是同步挂链——两条 handler 在同一 tick 就都已入队、
    // 重叠窗口由构造保证，不需要给第一条塞人为延时（旧写法睡 40ms）
    const raw = baseRaw({ message_id: "om_dup" });
    await Promise.all([
      defaultMessageHandler(raw),
      defaultMessageHandler(raw),
    ]);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(await hasProcessedMessageId("om_dup")).toBe(true);
  });
});

describe("R1-2c：card-map / bridge-state 写队列不互盖", () => {
  it("rememberCardMessage 与 setLastProcessedTs 并发后两者都在", async () => {
    await Promise.all([
      rememberCardMessage({
        messageId: "om_card",
        cardId: "card_1",
        taskId: "task_x",
        createdAt: 1,
      }),
      setLastProcessedTs("1784385499958"),
      rememberCardMessage({
        messageId: "om_card2",
        cardId: "card_2",
        taskId: "task_y",
        createdAt: 2,
      }),
    ]);
    expect((await findTaskByMessageId("om_card"))?.taskId).toBe("task_x");
    expect((await findTaskByMessageId("om_card2"))?.taskId).toBe("task_y");
    expect(await getLastProcessedTs()).toBe("1784385499958");
  });

  it("rememberP2pChatId 与 markProcessedMessageId 并发不丢", async () => {
    await Promise.all([
      rememberP2pChatId("oc_concurrent"),
      markProcessedMessageId("om_1"),
      markProcessedMessageId("om_2"),
      rememberP2pChatId("oc_concurrent"),
    ]);
    expect(await getLastP2pChatId()).toBe("oc_concurrent");
    expect(await hasProcessedMessageId("om_1")).toBe(true);
    expect(await hasProcessedMessageId("om_2")).toBe(true);
  });
});

describe("R1-6：retryable 失败不 mark、可补拉重投", () => {
  it("getBotAppInfo 失败 → retryable、不 mark；修复后可重投", async () => {
    let boom = true;
    const inject = vi.fn(async () => okInjectResponse());
    routerDeps({
      getBotAppInfo: async () => {
        if (boom) throw new Error("cli jitter");
        return { appId: "cli_x", ownerOpenId: "ou_owner" };
      },
      handleChatReplyInject: inject as never,
    });

    const raw = baseRaw({ message_id: "om_retry" });
    await defaultMessageHandler(raw);
    expect(await hasProcessedMessageId("om_retry")).toBe(false);
    expect(inject).not.toHaveBeenCalled();

    boom = false;
    await defaultMessageHandler(raw);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(await hasProcessedMessageId("om_retry")).toBe(true);
  });

  it("内容终态（队满 409）→ 非 retryable、照 mark", async () => {
    routerDeps({
      handleChatReplyInject: async () => failInjectResponse(409, "排队已满"),
    });

    const r409 = await routeInboundMessage({
      type: "im.message.receive_v1",
      message_id: "om_409",
      create_time: String(Date.now()),
      chat_id: "oc_r1",
      chat_type: "p2p",
      message_type: "text",
      sender_id: "ou_owner",
      content: JSON.stringify({ text: "满了" }),
    });
    expect(r409.kind).toBe("failed");
    expect(r409.retryable).toBeFalsy();

    await defaultMessageHandler(
      baseRaw({
        message_id: "om_409_h",
        content: JSON.stringify({ text: "满了" }),
      }),
    );
    expect(await hasProcessedMessageId("om_409_h")).toBe(true);
  });

  it("5xx inject → retryable、不 mark", async () => {
    routerDeps({
      handleChatReplyInject: async () => failInjectResponse(503, "upstream"),
    });

    const result: InjectResultPayload = await routeInboundMessage({
      type: "im.message.receive_v1",
      message_id: "om_5xx",
      create_time: String(Date.now()),
      chat_id: "oc_r1",
      chat_type: "p2p",
      message_type: "text",
      sender_id: "ou_owner",
      content: JSON.stringify({ text: "hi" }),
    });
    expect(result.kind).toBe("failed");
    expect(result.retryable).toBe(true);

    await defaultMessageHandler(
      baseRaw({
        message_id: "om_5xx_h",
        content: JSON.stringify({ text: "hi" }),
      }),
    );
    expect(await hasProcessedMessageId("om_5xx_h")).toBe(false);
  });
});

describe("R1-8：keep-awake exit 身份校验", () => {
  it("stop→start 快切后旧 exit 不清新 child、不排重启", async () => {
    vi.useFakeTimers();
    const children: Array<{
      child: EventEmitter & {
        pid: number;
        kill: () => boolean;
        killed: boolean;
      };
      exit: () => void;
    }> = [];
    let pid = 1;
    const spawnFn = ((_bin: string, ..._args: unknown[]) => {
      void _bin;
      void _args;
      const ee = new EventEmitter() as EventEmitter & {
        pid: number;
        kill: () => boolean;
        killed: boolean;
      };
      ee.pid = pid++;
      ee.killed = false;
      ee.kill = () => {
        ee.killed = true;
        return true;
      };
      const handle = {
        child: ee,
        exit: () => {
          ee.emit("exit", 0, null);
        },
      };
      children.push(handle);
      return ee as unknown as ChildProcess;
    }) as unknown as typeof nodeSpawn;

    const ka = new KeepAwake();
    ka.__setSpawnForTest(spawnFn);
    ka.start();
    expect(ka.isActive()).toBe(true);
    expect(children).toHaveLength(1);
    const old = children[0]!;

    ka.stop();
    expect(ka.isActive()).toBe(false);

    ka.start();
    expect(children).toHaveLength(2);
    const neu = children[1]!;
    expect(ka.isActive()).toBe(true);

    // 旧 child 迟到 exit——不得清新 child、不得排 10s 重启
    old.exit();
    expect(ka.isActive()).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(children).toHaveLength(2);

    // 新 child 真 exit + 非 stop → 会排重启
    ka.__setSpawnForTest(spawnFn);
    // 当前 stopped=false（上一次 start 后），neu exit 应清 + 排重启
    neu.exit();
    expect(ka.isActive()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(children).toHaveLength(3);

    ka.stop();
    vi.useRealTimers();
  });
});

describe("enqueueInboundMessage 导出", () => {
  it("串行链保证顺序", async () => {
    const seen: number[] = [];
    // 第一个任务卡在闸上直到第二个也入了队——串行若失效，2 会抢在 1 前面
    const gate = deferred();
    const first = enqueueInboundMessage(async () => {
      await gate.promise;
      seen.push(1);
    });
    const second = enqueueInboundMessage(async () => {
      seen.push(2);
    });
    gate.resolve();
    await Promise.all([first, second]);
    expect(seen).toEqual([1, 2]);
  });
});
