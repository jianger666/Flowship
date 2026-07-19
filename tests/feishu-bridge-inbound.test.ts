/**
 * inbound：consumer 生命周期（mock spawn）——
 * ready 解析 / NDJSON 分发 / 崩溃退避重启 / 开关同步启停 / 单实例冲突拒启
 */
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 数据目录隔离到 tmp（必须在 import 被测模块之前设好——dataRoot 每次调用读 env）
const TMP = path.join(os.tmpdir(), `feishu-bridge-inbound-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const {
  __resetBridgeRuntimeForTest,
  __setInboundSpawnForTest,
  checkEventKeyConflict,
  getBridgeRuntimeStatus,
  normalizeInboundEvent,
  syncBridgeRuntime,
} = await import("@/lib/server/feishu-bridge/inbound");
const { __resetLarkBinCacheForTest, __setLarkExecForTest } = await import(
  "@/lib/server/feishu-bridge/lark-api"
);
const { registerCardActionHandler } = await import(
  "@/lib/server/feishu-bridge/router"
);
const {
  __resetBridgeStateForTest,
  getLastP2pChatId,
  hasProcessedMessageId,
} = await import("@/lib/server/feishu-bridge/bridge-state");

// ----------------- fake child（模拟 lark-cli event consume 子进程） -----------------

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  pid: number;
  // stdin.end = 优雅退出信号（inbound 停 consumer 靠它）——下一 tick 模拟进程退出
  stdin = {
    end: (): void => {
      setImmediate(() => this.exit(0, null));
    },
  };

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill = (signal?: string): boolean => {
    this.killed = true;
    setImmediate(() => this.exit(null, signal ?? "SIGTERM"));
    return true;
  };

  /** 模拟进程退出（崩溃传非 0 code） */
  exit = (code: number | null, signal: string | null): void => {
    if (this.exitCode !== null || this.killed) {
      if (this.exitCode !== null) return;
    }
    this.exitCode = code ?? 0;
    this.emit("exit", code, signal);
  };
}

// ----------------- 共享 mock 状态 -----------------

// 每次 spawn 记录（args[2] = eventKey）
let spawned: Array<{ args: string[]; child: FakeChild }> = [];
let nextPid = 10000;
// event status 返回的在线 consumer 列表（单实例冲突测试改它）
let statusConsumers: Array<{ pid: number; event_key: string }> = [];

const fakeSpawn = ((_cmd: string, args: string[]) => {
  const child = new FakeChild(nextPid++);
  spawned.push({ args: args as string[], child });
  return child as unknown as ChildProcess;
}) as typeof nodeSpawn;

/** 写 config.json 控制桥接开关（keepAwake 永远关、避免真 spawn caffeinate） */
const setBridgeEnabled = async (on: boolean): Promise<void> => {
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  await fs.writeFile(
    path.join(TMP, "data", "config.json"),
    JSON.stringify({ feishuChatBridge: on, feishuBridgeKeepAwake: false }),
    "utf-8",
  );
};

const findSpawned = (eventKey: string) =>
  spawned.filter((s) => s.args[2] === eventKey);

const consumerStatus = (eventKey: string) =>
  getBridgeRuntimeStatus().consumers.find((c) => c.eventKey === eventKey);

/** 开桥接 + sync、返回两个 consumer 的 fake child */
const startBridge = async (): Promise<{ im: FakeChild; card: FakeChild }> => {
  await setBridgeEnabled(true);
  await syncBridgeRuntime();
  const im = findSpawned("im.message.receive_v1")[0]?.child;
  const card = findSpawned("card.action.trigger")[0]?.child;
  expect(im).toBeDefined();
  expect(card).toBeDefined();
  return { im: im!, card: card! };
};

beforeEach(async () => {
  await __resetBridgeRuntimeForTest();
  await __resetBridgeStateForTest();
  spawned = [];
  statusConsumers = [];
  __setInboundSpawnForTest(fakeSpawn);
  // mock lark-cli exec：event status 返回可控 consumer 列表、其余返回 ok
  __setLarkExecForTest(async (_bin, args) => {
    if (args[0] === "event" && args[1] === "status") {
      return {
        stdout: JSON.stringify({
          ok: true,
          apps: [
            {
              app_id: "cli_test",
              status: "running",
              running: true,
              consumers: statusConsumers,
            },
          ],
        }),
        stderr: "",
      };
    }
    return { stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
  });
});

afterEach(async () => {
  await __resetBridgeRuntimeForTest();
  registerCardActionHandler(null);
  __setInboundSpawnForTest(null);
  __setLarkExecForTest(null);
  __resetLarkBinCacheForTest();
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

// ----------------- normalizeInboundEvent -----------------

describe("normalizeInboundEvent", () => {
  it("顶层扁平样本（docs/feishu-event-sample）解析", () => {
    const msg = normalizeInboundEvent({
      type: "im.message.receive_v1",
      event_id: "e1",
      message_id: "om_1",
      create_time: "1784385499958",
      chat_id: "oc_1",
      chat_type: "p2p",
      message_type: "text",
      sender_id: "ou_1",
      content: "111",
    });
    expect(msg).toMatchObject({
      message_id: "om_1",
      chat_type: "p2p",
      message_type: "text",
      sender_id: "ou_1",
      content: "111",
    });
  });

  it("缺 message_id → null；嵌套 event.message 形态也能解析", () => {
    expect(normalizeInboundEvent({ type: "x" })).toBeNull();
    const msg = normalizeInboundEvent({
      event: {
        message: {
          message_id: "om_2",
          chat_id: "oc_2",
          chat_type: "p2p",
          message_type: "text",
          content: '{"text":"hi"}',
        },
        sender: { sender_id: { open_id: "ou_2" } },
      },
    });
    // 嵌套形态 sender 在 event.sender（不在 message 下）——normalize 拿不到时给空串、
    // router 会按「非本人」skip、不误注入（fail-closed）
    expect(msg?.message_id).toBe("om_2");
    expect(msg?.content).toBe('{"text":"hi"}');
  });
});

// ----------------- 生命周期 -----------------

describe("bridge runtime 生命周期（mock spawn）", () => {
  it("开关关 → sync 不 spawn、overall=stopped", async () => {
    await setBridgeEnabled(false);
    await syncBridgeRuntime();
    expect(spawned).toHaveLength(0);
    expect(getBridgeRuntimeStatus().overall).toBe("stopped");
  });

  it("开关开 → 按声明式列表 spawn 两个 consumer（撤回已下线）", async () => {
    await startBridge();
    const keys = spawned.map((s) => s.args[2]).sort();
    expect(keys).toEqual([
      "card.action.trigger",
      "im.message.receive_v1",
    ]);
    // 参数形状：event consume <key> --as bot
    expect(spawned[0]!.args.slice(0, 2)).toEqual(["event", "consume"]);
    expect(spawned[0]!.args).toContain("--as");
    expect(spawned[0]!.args).toContain("bot");
  });

  it("stderr ready 标记 → 状态 ready", async () => {
    const { im } = await startBridge();
    expect(consumerStatus("im.message.receive_v1")?.status).toBe("starting");
    im.stderr.write("[event] ready event_key=im.message.receive_v1\n");
    await vi.waitFor(() => {
      expect(consumerStatus("im.message.receive_v1")?.status).toBe("ready");
    });
    // 另一个 consumer 的 ready 不会误标（event_key 必须匹配）
    expect(consumerStatus("card.action.trigger")?.status).toBe("starting");
  });

  it("stdout NDJSON 分发：card.action → 注册 handler；坏 JSON 不炸", async () => {
    const { card } = await startBridge();
    const got: unknown[] = [];
    registerCardActionHandler(async (e) => {
      got.push(e);
    });
    card.stdout.write("not-json-line\n");
    card.stdout.write(`${JSON.stringify({ action: { tag: "button" } })}\n`);
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]).toEqual({ action: { tag: "button" } });
  });

  it("stdout NDJSON 分发：im.message 走完整链（normalize → route → 去重标记）；群聊不污染 p2p chatId", async () => {
    const { im } = await startBridge();
    // 群聊消息：router 过滤（不需要 bot 身份）、但 inbound 仍记 processed 去重
    im.stdout.write(
      `${JSON.stringify({
        type: "im.message.receive_v1",
        message_id: "om_group_1",
        create_time: "1784385499958",
        chat_id: "oc_group",
        chat_type: "group",
        message_type: "text",
        sender_id: "ou_someone",
        content: "hi",
      })}\n`,
    );
    await vi.waitFor(async () => {
      expect(await hasProcessedMessageId("om_group_1")).toBe(true);
    });
    // 群聊 chat_id 不得写进补拉状态（否则补拉窗口指向错误会话）
    expect(await getLastP2pChatId()).toBe("");
  });

  it("崩溃 → 指数退避重启（计数 +1、backoff 后再 spawn）", async () => {
    const { im } = await startBridge();
    im.stderr.write("[event] ready event_key=im.message.receive_v1\n");
    await vi.waitFor(() => {
      expect(consumerStatus("im.message.receive_v1")?.status).toBe("ready");
    });

    expect(findSpawned("im.message.receive_v1")).toHaveLength(1);
    im.exit(1, null); // 模拟崩溃
    await vi.waitFor(() => {
      const st = consumerStatus("im.message.receive_v1");
      expect(st?.status).toBe("backoff");
      expect(st?.restartCount).toBe(1);
    });
    // 首轮退避 1s、之后翻倍——等它真的重启（真实计时、上限 3s 足够）
    await vi.waitFor(
      () => {
        expect(findSpawned("im.message.receive_v1")).toHaveLength(2);
      },
      { timeout: 3000 },
    );
  });

  it("开关关 → sync 优雅停（stdin EOF、状态 stopped、不重启）", async () => {
    const { im, card } = await startBridge();
    await setBridgeEnabled(false);
    await syncBridgeRuntime();
    expect(getBridgeRuntimeStatus().overall).toBe("stopped");
    // 两个子进程都被优雅停（fake stdin.end → exit 0）
    expect(im.exitCode).toBe(0);
    expect(card.exitCode).toBe(0);
    // 主动停不触发退避重启
    expect(findSpawned("im.message.receive_v1")).toHaveLength(1);
    expect(consumerStatus("im.message.receive_v1")?.restartCount).toBe(0);
  });
});

// ----------------- 单实例守卫（坑 #4） -----------------

describe("单实例冲突", () => {
  it("同 event key 已被别的 consumer 占用 → 拒启 + conflict 状态", async () => {
    statusConsumers = [{ pid: 99999, event_key: "im.message.receive_v1" }];
    await setBridgeEnabled(true);
    await syncBridgeRuntime();

    const st = consumerStatus("im.message.receive_v1");
    expect(st?.status).toBe("conflict");
    expect(st?.conflictDetail).toContain("99999");
    // 冲突的 key 不 spawn；无冲突的 card.action 正常起
    expect(findSpawned("im.message.receive_v1")).toHaveLength(0);
    expect(findSpawned("card.action.trigger")).toHaveLength(1);
    expect(getBridgeRuntimeStatus().overall).toBe("conflict");
  });

  it("checkEventKeyConflict：自己的 pid 不算冲突", async () => {
    statusConsumers = [{ pid: 4242, event_key: "im.message.receive_v1" }];
    expect(
      (await checkEventKeyConflict("im.message.receive_v1", 4242)).conflict,
    ).toBe(false);
    expect(
      (await checkEventKeyConflict("im.message.receive_v1", null)).conflict,
    ).toBe(true);
    // 不同 key 不冲突
    expect(
      (await checkEventKeyConflict("card.action.trigger", null)).conflict,
    ).toBe(false);
  });
});
