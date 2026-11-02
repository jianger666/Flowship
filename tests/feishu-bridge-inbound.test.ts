/**
 * inbound：consumer 生命周期（mock spawn）——
 * ready 解析 / NDJSON 分发 / 崩溃退避重启 / 开关同步启停 / 单实例冲突拒启
 */
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installBridgeTestHooks,
  tick,
  makeBridgeTmpDataDir,
} from "./helpers/feishu-bridge-harness";

// 数据目录隔离到 tmp（dataRoot 每次调用读 env、import 后再设也生效）
const TMP = makeBridgeTmpDataDir("feishu-bridge-inbound");

const {
  __resetBridgeRuntimeForTest,
  __runExitCleanupForTest,
  __setConsumerBackoffBaseForTest,
  __setInboundSpawnForTest,
  __setStopGraceForTest,
  checkEventKeyConflict,
  getBridgeRuntimeStatus,
  normalizeInboundEvent,
  syncBridgeRuntime,
} = await import("@/lib/server/feishu-bridge/inbound");
const { __setLarkExecForTest } = await import(
  "@/lib/server/feishu-bridge/lark-api"
);
const {
  forceKillAllManagedChildrenSync,
  registerManagedChild,
  stopAllManagedChildren,
  unregisterManagedChild,
} = await import("@/lib/server/kill-orphans");
const { registerCardActionHandler } = await import(
  "@/lib/server/feishu-bridge/router"
);
const { getLastP2pChatId, hasProcessedMessageId } = await import(
  "@/lib/server/feishu-bridge/bridge-state"
);

// 排空入向 / card.action 共享链 + 重建隔离数据目录（__resetBridgeRuntimeForTest
// 只停 consumer、不排链——遗留 handler 会在下一用例里对着已撤的 mock 跑）
installBridgeTestHooks({ tmpRoot: TMP });

// ----------------- fake child（模拟 lark-cli event consume 子进程） -----------------

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  /** spawn 失败（ENOENT / EACCES）的真实形态：pid 为 undefined */
  pid: number | undefined;
  /** 卡死的 child：stdin EOF / SIGTERM 都不理，只有测试手动 exit() 才退（模拟「迟迟不退」的 lark-cli） */
  stuck = false;
  // stdin.end = 优雅退出信号（inbound 停 consumer 靠它）——下一 tick 模拟进程退出
  stdin = {
    end: (): void => {
      if (this.stuck) return;
      setImmediate(() => this.exit(0, null));
    },
  };

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  kill = (signal?: string): boolean => {
    this.killed = true;
    if (!this.stuck) setImmediate(() => this.exit(null, signal ?? "SIGTERM"));
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

// 非空 = 模拟 spawn 失败（二进制不存在 ENOENT / 无权限 EACCES）。
// 真实 Node 语义：child.pid 为 undefined，只异步触发 error + close(code=-2)，**不触发 exit**
let spawnFailCode: "ENOENT" | "EACCES" | null = null;

// 每次 spawn 收到的 env（校验「只减不增」：不带宿主注入变量 / GitLab PAT）
let spawnEnvs: Array<NodeJS.ProcessEnv | undefined> = [];

const fakeSpawn = ((_cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
  spawnEnvs.push(opts?.env);
  if (spawnFailCode) {
    const code = spawnFailCode;
    const dead = new FakeChild(undefined);
    spawned.push({ args: args as string[], child: dead });
    setImmediate(() => {
      dead.emit(
        "error",
        Object.assign(new Error(`spawn lark-cli ${code}`), { code, errno: -2, syscall: "spawn lark-cli" }),
      );
      dead.emit("close", -2, null);
    });
    return dead as unknown as ChildProcess;
  }
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
  spawned = [];
  spawnEnvs = [];
  statusConsumers = [];
  spawnFailCode = null;
  __setInboundSpawnForTest(fakeSpawn);
  // 崩溃重启用例本来真等 1s 首轮退避——占掉大半个用例预算、全量并发下随机超时
  __setConsumerBackoffBaseForTest(20);
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
  __setConsumerBackoffBaseForTest(null);
  __setStopGraceForTest(null);
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

  it("consumer 的 env 只减不增：不带 GitLab PAT / 宿主注入变量，PATH / HOME / 代理保留，process.env 本身不被改", async () => {
    const injected: Record<string, string> = {
      FLOWSHIP_GITLAB_TOKEN: "fake-pat-for-test-only",
      ELECTRON_RUN_AS_NODE: "1",
      FLOWSHIP_PORT: "3456",
      PORT: "3456",
      HOSTNAME: "127.0.0.1",
      __NEXT_PRIVATE_ORIGIN: "http://127.0.0.1:3456",
      HTTPS_PROXY: "http://proxy.test:8080",
    };
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(injected)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const dataDirBefore = process.env.FLOWSHIP_DATA_DIR; // 测试夹具设的，也属于宿主注入变量
    try {
      await startBridge();
      expect(spawnEnvs).toHaveLength(2); // im + card 两个 consumer
      for (const env of spawnEnvs) {
        expect(env).toBeDefined();
        expect(env).not.toBe(process.env); // 是副本，不是 process.env 本体
        for (const k of [
          "FLOWSHIP_GITLAB_TOKEN",
          "ELECTRON_RUN_AS_NODE",
          "FLOWSHIP_PORT",
          "FLOWSHIP_DATA_DIR",
          "PORT",
          "HOSTNAME",
          "__NEXT_PRIVATE_ORIGIN",
        ]) {
          expect(env![k], k).toBeUndefined();
        }
        // 只减不增：这些必须原样保留（lark-cli 联网 / 找二进制 / 读 ~/.lark-cli 都靠它们）
        expect(env!.PATH).toBe(process.env.PATH);
        expect(env!.HOME).toBe(process.env.HOME);
        expect(env!.HTTPS_PROXY).toBe("http://proxy.test:8080");
      }
      // process.env 本体没被改
      expect(process.env.FLOWSHIP_GITLAB_TOKEN).toBe("fake-pat-for-test-only");
      expect(process.env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(process.env.FLOWSHIP_DATA_DIR).toBe(dataDirBefore);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
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

  // R3-3：card.action 挂独立串行链——双击答题卡两个选项不再并发过 pendingAsk 检查
  it("card.action 事件串行处理（第二次点击等第一次处理完）", async () => {
    const { card } = await startBridge();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    registerCardActionHandler(async (e) => {
      const tag = (e as { n?: string }).n ?? "?";
      order.push(`${tag}-start`);
      if (tag === "1") await gate;
      order.push(`${tag}-end`);
    });
    card.stdout.write(`${JSON.stringify({ n: "1" })}\n`);
    card.stdout.write(`${JSON.stringify({ n: "2" })}\n`);
    await vi.waitFor(() => expect(order).toContain("1-start"));
    // 第二个事件已入队但不得在第一个结束前跑（旧 fire-and-forget 会并发 2-start）——
    // 排空几轮事件循环即可，不靠墙钟 30ms
    await tick(3);
    expect(order).toEqual(["1-start"]);
    releaseFirst();
    await vi.waitFor(() =>
      expect(order).toEqual(["1-start", "1-end", "2-start", "2-end"]),
    );
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
    // 首轮退避已调到 20ms（见 beforeEach）——等它真的重启
    await vi.waitFor(() => {
      expect(findSpawned("im.message.receive_v1")).toHaveLength(2);
    });
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

// ----------------- spawn 失败自愈（P1：永久静默） -----------------

// 旧实现：重启只挂在 `exit` 上、`error` 只改状态，h.child 还指着死进程——
// 而 spawn 失败时 Node 只发 error + close、不发 exit → 永不重启，30s 轮询又因 `!h.child` 不成立不会补救，
// 入向永久静默到重启 App。
describe("spawn 失败（ENOENT / EACCES）→ 清引用 + 退避重启，不永久静默", () => {
  it.each(["ENOENT", "EACCES"] as const)(
    "%s：状态进 backoff（pid 清空、restartCount+1、lastError 带原因）→ 退避到期自动重 spawn → 二进制恢复后起得来",
    async (code) => {
      spawnFailCode = code;
      await setBridgeEnabled(true);
      await syncBridgeRuntime();

      await vi.waitFor(() => {
        const st = consumerStatus("im.message.receive_v1");
        expect(st?.status).toBe("backoff");
        expect(st?.restartCount).toBeGreaterThanOrEqual(1);
      });
      const st = consumerStatus("im.message.receive_v1");
      expect(st?.pid).toBeUndefined();
      expect(st?.lastError).toContain(code);

      // 不靠 30s 轮询、不靠重启 App：退避定时器到期自己再 spawn（旧实现这里永远停在 1 次）
      await vi.waitFor(() => {
        expect(findSpawned("im.message.receive_v1").length).toBeGreaterThanOrEqual(2);
      });

      // lark-cli 装回来 / 权限恢复：下一次重试就能起来并 ready
      spawnFailCode = null;
      await vi.waitFor(() => {
        expect(findSpawned("im.message.receive_v1").at(-1)!.child.pid).toBeDefined();
      });
      const healthy = findSpawned("im.message.receive_v1").at(-1)!.child;
      healthy.stderr.write("[event] ready event_key=im.message.receive_v1\n");
      await vi.waitFor(() => {
        expect(consumerStatus("im.message.receive_v1")?.status).toBe("ready");
      });
    },
  );

  // 同一个 child 的 error / close / exit 可能先后都触发：只能算一次崩溃（重复收尸会让退避翻倍两次、restartCount 重复计数）
  it.each([
    ["error → close（spawn 失败的真实序列）", ["error", "close"]],
    ["error → close → exit（几种事件都来）", ["error", "close", "exit"]],
    ["close（无 error / exit，只剩兜底）", ["close"]],
    ["exit → close（正常崩溃路径）", ["exit", "close"]],
    ["close → exit", ["close", "exit"]],
  ] as const)("幂等：%s → restartCount 只 +1、只排一次重启（只多 spawn 一次）", async (_label, events) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { im } = await startBridge();
      expect(findSpawned("im.message.receive_v1")).toHaveLength(1);
      if (events[0] === "error") im.pid = undefined; // 真实的 spawn 失败 pid 为空

      for (const ev of events) {
        if (ev === "error") {
          im.emit("error", Object.assign(new Error("spawn lark-cli ENOENT"), { code: "ENOENT" }));
        } else if (ev === "close") {
          im.emit("close", 1, null);
        } else {
          im.emit("exit", 1, null);
        }
      }

      expect(consumerStatus("im.message.receive_v1")).toMatchObject({
        status: "backoff",
        restartCount: 1,
        pid: undefined,
      });
      // 等重启定时器到期（20ms 首轮退避）真的 spawn 出第 2 个，再多等几轮确认没有第 3 个
      await vi.waitFor(() => {
        expect(findSpawned("im.message.receive_v1")).toHaveLength(2);
      });
      await tick(10);
      await new Promise((r) => setTimeout(r, 100));
      expect(findSpawned("im.message.receive_v1")).toHaveLength(2);
      expect(consumerStatus("im.message.receive_v1")?.restartCount).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("非 spawn 失败的 error（pid 仍在，如 kill 失败）：只记原因、不清 h.child、不重启——别把活进程漏掉", async () => {
    const { im } = await startBridge();
    im.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));

    expect(consumerStatus("im.message.receive_v1")).toMatchObject({
      status: "error",
      lastError: "kill EPERM",
      restartCount: 0,
    });
    await tick(10);
    await new Promise((r) => setTimeout(r, 100));
    expect(findSpawned("im.message.receive_v1")).toHaveLength(1);

    // 进程之后真退出了：照常收尸 + 退避重启
    im.exit(1, null);
    await vi.waitFor(() => {
      expect(findSpawned("im.message.receive_v1")).toHaveLength(2);
    });
    expect(consumerStatus("im.message.receive_v1")?.restartCount).toBe(1);
  });
});

// ----------------- 被「摘掉」的旧 child 迟到退出：不许影响现任 -----------------

// stopConsumer 等不到 child 退出（SIGTERM 后再等一档仍不退）就放弃、把 h.child 置空——旧 child 此后迟到的
// exit 仍会跑它自己那份 reap 闭包。旧实现里 `reaped` 只防「同一个 child 重复收尸」、不看 h.child 是不是自己：
// ① 桥接已关：旧 child 的 exit 走 onChildExited → scheduleRestart，把刚关掉的 consumer 又拉起来（flapping）；
// ② 新 child 已接班：旧 child 的 exit 把状态改成 backoff、restartCount+1、还 unregister 掉新 child 的托管登记
//    （同一个 managedId）——server 退出时新 child 不再被优雅停、漏退订。
describe("旧 child 迟到退出（stopConsumer 放弃等待后）→ 与现任无关", () => {
  beforeEach(() => {
    __setStopGraceForTest(20);
  });

  it("桥接已关闭后，卡死的旧 child 才退出：不重启 consumer、状态仍是 stopped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { im } = await startBridge();
      im.stuck = true;
      await setBridgeEnabled(false);
      await syncBridgeRuntime(); // 两档等待（各 20ms）后放弃
      expect(consumerStatus("im.message.receive_v1")?.status).toBe("stopped");
      expect(im.exitCode).toBeNull(); // 确实没退

      im.exit(1, null); // 迟到的退出

      // 退避基数 20ms：旧实现这里会在 ~20ms 后再 spawn 一个
      await new Promise((r) => setTimeout(r, 150));
      expect(findSpawned("im.message.receive_v1")).toHaveLength(1);
      expect(consumerStatus("im.message.receive_v1")).toMatchObject({
        status: "stopped",
        restartCount: 0,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("新 child 已接班：旧 child 迟到退出不改现任状态 / 不排重启 / 不摘掉现任的托管登记", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { im: oldChild } = await startBridge();
      oldChild.stuck = true;
      await setBridgeEnabled(false);
      await syncBridgeRuntime();
      // 重新打开：起新 child（第 2 个）并 ready
      await setBridgeEnabled(true);
      await syncBridgeRuntime();
      expect(findSpawned("im.message.receive_v1")).toHaveLength(2);
      const fresh = findSpawned("im.message.receive_v1")[1]!.child;
      fresh.stderr.write("[event] ready event_key=im.message.receive_v1\n");
      await vi.waitFor(() => {
        expect(consumerStatus("im.message.receive_v1")?.status).toBe("ready");
      });
      const freshPid = consumerStatus("im.message.receive_v1")?.pid;

      oldChild.exit(1, null); // 旧 child 迟到退出
      await new Promise((r) => setTimeout(r, 150));

      // 现任状态原样：ready、pid 不变、没记崩溃、没排重启
      expect(consumerStatus("im.message.receive_v1")).toMatchObject({
        status: "ready",
        pid: freshPid,
        restartCount: 0,
      });
      expect(findSpawned("im.message.receive_v1")).toHaveLength(2);

      // 现任的托管登记还在：server 退出统一停时它会被优雅停（stdin EOF → exit 0）
      await stopAllManagedChildren();
      expect(fresh.exitCode).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("旧 child 的 error 事件也不改现任状态", async () => {
    const { im: oldChild } = await startBridge();
    oldChild.stuck = true;
    await setBridgeEnabled(false);
    await syncBridgeRuntime();
    await setBridgeEnabled(true);
    await syncBridgeRuntime();
    const fresh = findSpawned("im.message.receive_v1")[1]!.child;
    fresh.stderr.write("[event] ready event_key=im.message.receive_v1\n");
    await vi.waitFor(() => {
      expect(consumerStatus("im.message.receive_v1")?.status).toBe("ready");
    });

    oldChild.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));

    expect(consumerStatus("im.message.receive_v1")).toMatchObject({
      status: "ready",
      lastError: undefined,
    });
  });
});

// ----------------- 退出清理接线（评审 R1-9） -----------------

describe("退出清理 runExitCleanup：优雅停之后同步强杀登记过的残留", () => {
  const ID = "test:exit-force-kill";
  afterEach(() => {
    unregisterManagedChild(ID);
  });

  it("优雅停（stop）与强杀（forceKill）都被调用，且强杀在 stop 之后（stop 把登记表清空后强杀仍在）", async () => {
    const order: string[] = [];
    registerManagedChild(ID, {
      label: "test",
      stop: () => {
        order.push("stop");
      },
      forceKill: () => {
        order.push("force");
      },
    });
    await __runExitCleanupForTest();
    expect(order).toEqual(["stop", "force"]);
  });

  it("优雅停卡死（永不 resolve）时：不拖过 1.5s 上限，之后仍照常强杀", async () => {
    let forced = false;
    registerManagedChild(ID, {
      label: "stuck",
      stop: () => new Promise<void>(() => {}),
      forceKill: () => {
        forced = true;
      },
    });
    const t0 = Date.now();
    await __runExitCleanupForTest();
    const elapsed = Date.now() - t0;
    expect(forced).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(1900);
  });

  it("某个强杀抛错不影响其它强杀、也不让退出清理抛", async () => {
    let otherForced = false;
    registerManagedChild(ID, {
      label: "boom",
      stop: () => undefined,
      forceKill: () => {
        throw new Error("boom");
      },
    });
    registerManagedChild(`${ID}-2`, {
      label: "ok",
      stop: () => undefined,
      forceKill: () => {
        otherForced = true;
      },
    });
    try {
      await expect(__runExitCleanupForTest()).resolves.toBeUndefined();
      expect(otherForced).toBe(true);
    } finally {
      unregisterManagedChild(`${ID}-2`);
    }
  });

  it("注销后不再强杀（子进程自行退出、登记已摘）", () => {
    let forced = false;
    registerManagedChild(ID, { label: "x", stop: () => undefined, forceKill: () => { forced = true; } });
    unregisterManagedChild(ID);
    forceKillAllManagedChildrenSync();
    expect(forced).toBe(false);
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
