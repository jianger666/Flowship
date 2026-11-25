/**
 * inbound：设置页桥接开关写盘后即时对账 + sync 并发请求不丢
 *
 * 背景（真问题）：设置页「飞书消息桥接」总开关切换后不是即时生效——
 *  1. 打开：前端同时发 PATCH /api/settings（读盘 → 备份 → 写 tmp → 改名好几步）和 GET /api/feishu-bridge/status
 *     （路由里先 await syncBridgeRuntime()，只读一次盘）。GET 多半读到旧值 false，consumer 要等最多 30s 的轮询才起；
 *  2. 关闭：没有任何东西触发对账，consumer 继续跑最多 30s；
 *  3. syncBridgeRuntime 开头的 `if (rt.syncing) return` 把同步进行中又来的调用静默丢掉。
 * 修复：ensureBridgeRuntimePolling 订阅 settings-fs 的写盘事件，桥接开关取值一变就立刻 sync；
 *      sync 进行中又被请求时记下来，让在跑的那次收尾后补跑（最多 3 轮）；被并入的调用等在途那次真正收尾再返回。
 *
 * 写盘入口说明（哪些走哪条，别混）：
 * - **生产入口**：`putSettingsFile` / `patchSettingsFile`（src/app/api/settings/route.ts 的 PUT / PATCH 调的就是它们），
 *   两者共用 `putSettingsFileLocked` 里「rename 成功后 notifySettingsWritten」这一处通知点。
 *   只有「生产写盘入口 → 即时对账」describe 里的用例走它们，那里才是对生产路径的钉子（外加 settings-fs.ts 的源码结构钉子）。
 * - **仅测试用**：`writeSettingsFileAtomic`——src/ 里没有任何生产调用方、只有本文件这类测试在用；它带同一套
 *   写锁 + notify，但不做 validate / 掩码 / 备份，所以其余用例用它来「快速、精确地摆出某个开关取值」。
 *   这些用例验的是订阅 / 对账 / 并发合并本身的逻辑，不证明生产入口也通知——那由上面生产入口的用例负责。
 * 直接 fs.writeFile 两者都不触发写盘订阅，测不到本修复（个别用例用它故意造「读失败」）。
 */
import { EventEmitter } from "node:events";
import { promises as fsp } from "node:fs";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { awaitWithCap } from "@/lib/server/feishu-bridge/await-with-cap";

import {
  blockAfter,
  enclosingIfConditions,
  readSource,
} from "./helpers/source-text";
import {
  deferred,
  installBridgeTestHooks,
  makeBridgeTmpDataDir,
  tick,
} from "./helpers/feishu-bridge-harness";

// 数据目录隔离到 tmp（dataRoot 每次调用读 env、import 后再设也生效）
const TMP = makeBridgeTmpDataDir("feishu-bridge-settings-sync");

const {
  __resetBridgeRuntimeForTest,
  __setConsumerBackoffBaseForTest,
  __setInboundSpawnForTest,
  __setStopGraceForTest,
  ensureBridgeRuntimePolling,
  getBridgeRuntimeStatus,
  stopBridgeRuntime,
  syncBridgeRuntime,
} = await import("@/lib/server/feishu-bridge/inbound");
const { __setLarkExecForTest } = await import(
  "@/lib/server/feishu-bridge/lark-api"
);
const {
  patchSettingsFile,
  putSettingsFile,
  settingsFilePath,
  writeSettingsFileAtomic,
} = await import("@/lib/server/settings-fs");
const { resumeBinaryUsers, suspendBinaryUsers } = await import(
  "@/lib/server/kill-orphans"
);

// 排空入向 / card.action 共享链 + 重建隔离数据目录
installBridgeTestHooks({ tmpRoot: TMP });

const IM = "im.message.receive_v1";
const CARD = "card.action.trigger";

// ----------------- fake child（模拟 lark-cli event consume 子进程） -----------------
//
// 这个假 child 只会发 `exit`（不发 `close` / `error`）：本文件钉的是对账 / 并发合并 / 停的编排，不是 consumer 的收尸路径。
// 收尸路径由 tests/feishu-bridge-inbound.test.ts 覆盖，别在这里重复造（R20-16 复核）：
//  - 「spawn 失败（ENOENT / EACCES）→ 清引用 + 退避重启」：真实序列 error → close（不发 exit、pid 为空），以及 exit 缺席时 close 兜底；
//  - 「非 spawn 失败的 error（pid 仍在）」：只记原因、不清 h.child、不重启；
//  - 「旧 child 迟到退出（stopConsumer 放弃等待后）」：旧 child 的 exit / error 不改现任状态、不排重启。

/** 之后 spawn 出来的假 child 是否「收到 stdin EOF 也不退出」（beforeEach 复位） */
let holdNewChildExit = false;

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  pid: number;
  /** 收到过 stdin.end()（= inbound 优雅停 consumer 的信号） */
  stdinEnded = false;
  /**
   * true = 收到 stdin EOF 后不自动退出（用例手动 exit，把「停」钉在进行中，观察两个 consumer 是否并行停）。
   * 初值取自 holdNewChildExit：要在 spawn 之前就决定的用例（子进程一生出来就可能被停）改那个全局开关。
   */
  holdExit = holdNewChildExit;
  // stdin.end = 优雅退出信号——下一 tick 模拟进程退出
  stdin = {
    end: (): void => {
      this.stdinEnded = true;
      if (this.holdExit) return;
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

  exit = (code: number | null, signal: string | null): void => {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 0;
    this.emit("exit", code, signal);
  };
}

// ----------------- 共享 mock 状态 -----------------

// 每次 consumer spawn 记录（args[2] = eventKey）
let spawned: Array<{ args: string[]; child: FakeChild }> = [];
let nextPid = 20000;
// event status 返回的在线 consumer 列表（冲突态用例改它）
let statusConsumers: Array<{ pid: number; event_key: string }> = [];
// `event status` 被调用的次数：冲突态下每次对账各探一次，拿它当「有没有对账」的探针
let statusCalls = 0;
// 非空 = `event status` 卡住直到放开（把一次 sync 钉在「已读到开关、还没收尾」的中间状态）
let statusGate: { promise: Promise<void> } | null = null;
// 每次 `event status` 进来时的回调（用例借它在对账途中再请求 sync）
let onStatusProbe: (() => void) | null = null;

const fakeSpawn = ((_cmd: string, args: string[]) => {
  const child = new FakeChild(nextPid++);
  spawned.push({ args: args as string[], child });
  return child as unknown as ChildProcess;
}) as typeof nodeSpawn;

/** 防休眠用的假 spawn：打开防休眠时不能真起 caffeinate（它是真的系统进程） */
const fakeKeepAwakeSpawn = (() =>
  new FakeChild(nextPid++) as unknown as ChildProcess) as unknown as typeof nodeSpawn;

// runtime 是 globalThis 单例：测试要看 syncing（当栅栏）、要给 KeepAwake 换假 spawn（exit-hook-idempotent 测试同样这么摸它）
const RUNTIME_KEY = "__flowshipFeishuBridgeRuntimeV1__";
type RuntimeProbe = {
  syncing: boolean;
  keepAwake: {
    __setSpawnForTest: (fn: typeof nodeSpawn | null) => void;
    /** 用例里临时换成会抛错的实现，造「对账抛错」（实例字段、可赋值；用完必须还原） */
    start: () => void;
    /** 同上：用例里换成计数包装观察「有没有被叫」（用完必须还原） */
    stop: () => void;
    isActive: () => boolean;
  };
};
const runtimeOf = (): RuntimeProbe =>
  (globalThis as unknown as Record<string, RuntimeProbe | undefined>)[
    RUNTIME_KEY
  ]!;

/**
 * 写 config.json 控制桥接开关（防休眠默认关、避免真起 caffeinate；要改的字段走 extra 覆盖）。
 * 走 writeSettingsFileAtomic（**仅测试用**的写盘入口，生产没有调用方）：它在改名完成后通知订阅者，
 * 直接 fs.writeFile 不会。这个 helper 用来精确摆出开关取值；走生产入口的用例见
 * 「生产写盘入口 putSettingsFile / patchSettingsFile → 即时对账」那组。
 */
const writeBridgeSettings = async (
  on: boolean,
  extra: Record<string, unknown> = {},
): Promise<void> => {
  await writeSettingsFileAtomic({
    feishuChatBridge: on,
    feishuBridgeKeepAwake: false,
    ...extra,
  });
};

const findSpawned = (eventKey: string) =>
  spawned.filter((s) => s.args[2] === eventKey);

const consumerStatus = (eventKey: string) =>
  getBridgeRuntimeStatus().consumers.find((c) => c.eventKey === eventKey);

/** 有上限地让出事件循环等条件成立：不靠墙钟 sleep 猜时序，超时直接报错而不是无限挂住 */
const waitUntil = async (
  cond: () => boolean,
  what: string,
  timeoutMs = 4000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await tick();
  }
};

/**
 * 等在途 sync 跑完。写盘订阅回调是**同步**触发 sync 的，所以 writeSettingsFileAtomic 返回时
 * 「该不该有 sync」已经定了（syncing 已置位）——拿它当栅栏，「不该对账」这类否定断言才不会因为没等够而假绿。
 */
const waitSyncIdle = (): Promise<void> =>
  waitUntil(() => !runtimeOf().syncing, "在途 sync 结束");

/**
 * 两个 key 都被别的实例占着（冲突态）+ 总开关开：每次对账各探一次 `event status`、不 spawn。
 * 返回时订阅已生效、「已见过的开关取值」已落定：先 开 → 关 → 开 走一遍，
 * 不去赌「订阅后第一次写盘一律算变了」这个实现细节，也不让首次对账的探测混进后面的计数。
 */
const primeConflictBridge = async (): Promise<void> => {
  statusConsumers = [
    { pid: 99999, event_key: IM },
    { pid: 99998, event_key: CARD },
  ];
  await writeBridgeSettings(true); // 订阅之前写：不触发任何对账
  ensureBridgeRuntimePolling(); // 订阅 + 首次 sync：开 → 两个 key 各探到一次冲突
  await waitSyncIdle();
  const afterFirst = statusCalls;
  expect(afterFirst).toBeGreaterThan(0);

  await writeBridgeSettings(false); // 关 → 全停（不探测）
  await waitSyncIdle();
  expect(statusCalls).toBe(afterFirst);

  await writeBridgeSettings(true); // 开 → 冲突态各再探一次（订阅有效）；之后摘要就是「开」
  await waitSyncIdle();
  expect(statusCalls).toBeGreaterThan(afterFirst);
  expect(getBridgeRuntimeStatus().overall).toBe("conflict");
};

beforeEach(async () => {
  await __resetBridgeRuntimeForTest();
  spawned = [];
  statusConsumers = [];
  statusCalls = 0;
  statusGate = null;
  onStatusProbe = null;
  holdNewChildExit = false;
  __setInboundSpawnForTest(fakeSpawn);
  // 防休眠一律换成假 spawn：生产入口用例经 normalize 后若落成 keepAwake=true，也绝不能真起 caffeinate
  runtimeOf().keepAwake.__setSpawnForTest(fakeKeepAwakeSpawn);
  // mock lark-cli exec：event status 返回可控 consumer 列表（并可被卡住 / 被探针观察）、其余返回 ok
  __setLarkExecForTest(async (_bin, args) => {
    if (args[0] === "event" && args[1] === "status") {
      statusCalls += 1;
      onStatusProbe?.();
      // 先取到 gate 再 await：之后置空 / 放开 statusGate 都不影响已经在等的这一次
      const gate = statusGate;
      if (gate) await gate.promise;
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
  // KeepAwake 是 runtime 单例里的长寿命对象：用例里换上的假 spawn 要还原，别串到后面的用例
  runtimeOf().keepAwake.__setSpawnForTest(null);
  __setInboundSpawnForTest(null);
  __setLarkExecForTest(null);
  __setStopGraceForTest(null);
  __setConsumerBackoffBaseForTest(null);
});

// ----------------- 写盘订阅：开关一变立刻对账 -----------------

describe(
  "设置页桥接开关写盘 → 即时对账",
  // 慢机器（swap 吃紧）上真写盘 + fsync 可能偏慢：放宽单用例上限，等待本身另有超时报错
  { timeout: 15_000 },
  () => {
    it("总开关打开 / 关闭：不手动 sync，写盘后 consumer 即时起停（不等 30s 轮询）", async () => {
      // 防的回归：设置页保存是 PATCH（多步写盘），同时发的 GET /status 先 sync、只读一次盘、多半读到旧值，
      // 「打开」要等下一次 30s 轮询才起；「关闭」则没有任何东西触发对账，consumer 白跑最多 30s。
      // 修复：ensureBridgeRuntimePolling 订阅 config.json 写盘事件，开关取值一变就立刻 sync。
      ensureBridgeRuntimePolling(); // 订阅 + 首次 sync：config.json 还不存在 = 开关关，不 spawn
      await waitSyncIdle();
      expect(spawned).toHaveLength(0);

      // 打开：只写盘，不手动调 syncBridgeRuntime
      await writeBridgeSettings(true);
      await waitUntil(
        () => findSpawned(IM).length === 1 && findSpawned(CARD).length === 1,
        "两个 consumer 都被 spawn",
      );
      await waitSyncIdle();
      // 各只起一次（订阅回调与首次 sync 不会撞出重复 spawn）
      expect(findSpawned(IM)).toHaveLength(1);
      expect(findSpawned(CARD)).toHaveLength(1);

      // 关闭：同样只写盘
      await writeBridgeSettings(false);
      await waitUntil(
        () =>
          consumerStatus(IM)?.status === "stopped" &&
          consumerStatus(CARD)?.status === "stopped",
        "两个 consumer 都回到 stopped",
      );
      await waitSyncIdle();
      for (const { child } of spawned) {
        expect(child.stdinEnded).toBe(true); // 走的是优雅停（stdin EOF）
        expect(child.exitCode).toBe(0);
      }
      expect(getBridgeRuntimeStatus().overall).toBe("stopped");
    });

    it("只有桥接开关取值变了才对账：无关设置写盘不触发，翻转总开关才触发", async () => {
      // 防的回归：订阅回调改成「每次写盘都 sync」。每次 sync 都会把 conflict / stopped / error / unsupported
      // 且没有子进程的 consumer 重新 startConsumer（spawn 前先跑一次 `event status` 探冲突），
      // 设置页保存任何无关字段（API key、模型……）都会把已失败的 consumer 反复拉起。
      // 观测：两个 key 都被别的实例占着（冲突态），此时每次对账各探一次 `event status`，数调用次数就知道有没有对账。
      await primeConflictBridge();
      const before = statusCalls;

      // 无关字段写盘：开关取值没变 → 不对账
      await writeBridgeSettings(true, { apiKey: "sk-unrelated" });
      await waitSyncIdle();
      expect(statusCalls).toBe(before);

      // 翻转总开关（关 → 开）：对账，冲突态的 consumer 各再探一次
      await writeBridgeSettings(false);
      await waitSyncIdle();
      await writeBridgeSettings(true);
      await waitSyncIdle();
      expect(statusCalls).toBeGreaterThan(before);
    });

    it("防休眠子开关取值变了同样即时对账（取值摘要里两个开关都要算）", async () => {
      // 防的回归：取值摘要漏了 feishuBridgeKeepAwake——设置页切换「插电防休眠」要等下一次 30s 轮询才起 / 停 caffeinate。
      // 防休眠打开时 sync 会 keepAwake.start()，所以先把 KeepAwake 的 spawn 换成假的（不真起 caffeinate）。
      // 观测同上：总开关保持开、只翻防休眠，冲突态的 consumer 会被再探一次。
      runtimeOf().keepAwake.__setSpawnForTest(fakeKeepAwakeSpawn);
      await primeConflictBridge();
      const before = statusCalls;

      await writeBridgeSettings(true, { feishuBridgeKeepAwake: true });
      await waitSyncIdle();
      expect(statusCalls).toBeGreaterThan(before);
    });

    it("stopBridgeRuntime 之后写盘翻转开关：不会再把 consumer 拉起来（订阅已退订）", async () => {
      // 防的回归：stopBridgeRuntime 不退订写盘事件——退出序列里 / 桥接被停掉之后只要再有设置保存，
      // 订阅回调就会 sync、把刚停掉的 consumer 重新 spawn 出来（退出时还会留下漏杀的子进程）。
      ensureBridgeRuntimePolling();
      await waitSyncIdle();

      // 对照：停之前订阅确实有效（开关一开就被拉起），否则后面的「没拉起」可能只是订阅压根没在工作
      await writeBridgeSettings(true);
      await waitUntil(
        () => findSpawned(IM).length === 1 && findSpawned(CARD).length === 1,
        "停之前开关一开 consumer 就被拉起",
      );
      await waitSyncIdle();

      await stopBridgeRuntime();
      expect(getBridgeRuntimeStatus().overall).toBe("stopped");
      const spawnedBefore = spawned.length;

      // 停之后翻转开关（关 → 开）：订阅若还在，写「开」会 sync 把两个 consumer 重新拉起
      await writeBridgeSettings(false);
      await waitSyncIdle();
      await writeBridgeSettings(true);
      await waitSyncIdle();
      expect(spawned).toHaveLength(spawnedBefore);
      expect(getBridgeRuntimeStatus().overall).toBe("stopped");
    });
  },
);

// ----------------- sync 并发：进行中又来请求不能丢 -----------------

describe(
  "syncBridgeRuntime：进行中又来请求 → 补跑",
  { timeout: 15_000 },
  () => {
    it("sync 进行中又来一次不丢：在跑的那次收尾后补跑一轮，追上途中被切的开关", async () => {
      // 防的回归：旧实现 `if (rt.syncing) return;` 把同步进行中的请求静默丢掉——开关恰好在 30s 轮询 /
      // status 接口的 sync 进行中被切时，在跑的那次早已读完旧值，新值被丢，桥接停在「开」直到下一次轮询（最多 30s）。
      // 这条不依赖写盘订阅（没调 ensureBridgeRuntimePolling）：只验 syncBridgeRuntime 自己的并发合并。
      await writeBridgeSettings(true);
      const gate = deferred();
      statusGate = gate;
      try {
        // 第一次 sync：已读到开关=开，卡在 im 的 `event status` 探冲突
        const first = syncBridgeRuntime();
        await waitUntil(
          () => statusCalls >= 1,
          "第一次 sync 读到开关=开并卡在探冲突",
        );

        // 开关被切成关，再来一次 sync：只记补跑请求、不另起一轮对账（不会并发跑两份）；
        // 但它要**等在途那次（含补跑轮）收尾才返回**——status 接口 await 完立刻读 runtime 快照，不能读到旧的。
        // 旧断言「立即返回（tick(3) 后 secondDone 为 true）」在 I-2 之后不再成立：那正是 status 读到旧快照的根因。
        await writeBridgeSettings(false);
        let secondDone = false;
        const second = syncBridgeRuntime().then(() => {
          secondDone = true;
        });
        await tick(3);
        expect(secondDone).toBe(false);

        // 放开：在跑的那次先按旧值把 consumer 起完，收尾后补跑一轮、读到「关」、全停
        statusGate = null;
        gate.resolve();
        await first;
        await second;
        expect(secondDone).toBe(true);
        expect(runtimeOf().syncing).toBe(false);
        expect(getBridgeRuntimeStatus().overall).toBe("stopped");
        const alive = spawned
          .filter((s) => s.child.exitCode === null)
          .map((s) => s.args[2]);
        expect(alive).toEqual([]);
      } finally {
        // 断言失败也要放开：卡住的 `event status` 占着进程级 lark 单飞队列，不放会拖死后面的用例
        statusGate = null;
        gate.resolve();
      }
    });

    it("补跑最多 3 轮：对账途中请求不断时放弃、不空转", async () => {
      // 防的回归：补跑循环没有上限——对账期间只要又被请求就再跑一轮，请求不断时 sync 永不结束、
      // 一直占着 syncing（之后所有 sync 都只是置位、永远轮不到真正处理）。放弃的部分留给 30s 轮询兜底。
      statusConsumers = [
        { pid: 99999, event_key: IM },
        { pid: 99998, event_key: CARD },
      ];
      await writeBridgeSettings(true);
      // 每次探测里都再请求一次 sync：此时 syncing 为真，只会置位补跑标记 → 每一轮收尾时都有新请求。
      // 保险阈值：万一补跑真没上限，到阈值就不再请求，用例以「次数不对」红掉而不是死循环挂住
      onStatusProbe = () => {
        if (statusCalls < 60) void syncBridgeRuntime();
      };
      await syncBridgeRuntime();
      // 3 轮 × 2 个冲突 consumer，每个探一次
      expect(statusCalls).toBe(6);

      // 放弃后 syncing 已释放、补跑标记已清：下一次 sync 正常对账一轮就结束
      onStatusProbe = null;
      await syncBridgeRuntime();
      expect(statusCalls).toBe(8);
    });
  },
);

// ----------------- 生产写盘入口：putSettingsFile / patchSettingsFile -----------------

/** 满足 validateSettingsPayload 的最小完整配置（apiKey / defaultModel / repos 三必备项）；防休眠关，避免任何防休眠动作 */
const PROD_BASE = {
  apiKey: "sk-test-not-a-real-key",
  defaultModel: { id: "composer-2" },
  repos: [] as unknown[],
  feishuBridgeKeepAwake: false,
};

describe(
  "生产写盘入口 putSettingsFile / patchSettingsFile → 即时对账",
  { timeout: 15_000 },
  () => {
    const bothSpawned = () =>
      findSpawned(IM).length === 1 && findSpawned(CARD).length === 1;
    const bothStopped = () =>
      consumerStatus(IM)?.status === "stopped" &&
      consumerStatus(CARD)?.status === "stopped";

    it("patchSettingsFile 翻转总开关：consumer 即时起停（设置页 PATCH /api/settings 的真实路径）", async () => {
      // 防的回归：订阅 / 对账只被 writeSettingsFileAtomic（生产无调用方）验过——
      // 若 putSettingsFileLocked 落盘后漏了 notifySettingsWritten，设置页翻转开关就退回「等 30s 轮询」，而旧测试照样全绿。
      // 初始配置在订阅之前用测试 helper 摆好（patchSettingsFile 要求盘上已有 config.json）
      await writeSettingsFileAtomic({ ...PROD_BASE, feishuChatBridge: false });
      ensureBridgeRuntimePolling();
      await waitSyncIdle();
      expect(spawned).toHaveLength(0);

      const on = await patchSettingsFile({ patch: { feishuChatBridge: true } });
      expect(on.status).toBe("ok");
      await waitUntil(bothSpawned, "patch 打开后两个 consumer 被 spawn");
      await waitSyncIdle();
      expect(findSpawned(IM)).toHaveLength(1);
      expect(findSpawned(CARD)).toHaveLength(1);

      const off = await patchSettingsFile({
        patch: { feishuChatBridge: false },
      });
      expect(off.status).toBe("ok");
      await waitUntil(bothStopped, "patch 关闭后两个 consumer 回到 stopped");
      await waitSyncIdle();
      for (const { child } of spawned) expect(child.stdinEnded).toBe(true);
    });

    it("putSettingsFile 整包写翻转总开关：consumer 即时起停（PUT /api/settings 的真实路径）", async () => {
      ensureBridgeRuntimePolling();
      await waitSyncIdle();
      expect(spawned).toHaveLength(0);

      const on = await putSettingsFile({ ...PROD_BASE, feishuChatBridge: true });
      expect(on.status).toBe("ok");
      await waitUntil(bothSpawned, "put 打开后两个 consumer 被 spawn");
      await waitSyncIdle();

      const off = await putSettingsFile({
        ...PROD_BASE,
        feishuChatBridge: false,
      });
      expect(off.status).toBe("ok");
      await waitUntil(bothStopped, "put 关闭后两个 consumer 回到 stopped");
      await waitSyncIdle();
      for (const { child } of spawned) expect(child.stdinEnded).toBe(true);
    });

    it("源码结构钉子：putSettingsFileLocked 在 rename 落盘之后无条件调 notifySettingsWritten；put / patch 都经过它", () => {
      // 行为测试之外的第二道钉：通知点被挪进 if、挪到落盘之前、或 put / patch 绕开它，这里都会红
      const src = readSource("src/lib/server/settings-fs.ts");
      const locked = blockAfter(src, "const putSettingsFileLocked = async (");
      expect(locked).toMatch(
        /await writePrivateFileAtomic\(\s*settingsFilePath\(\),[\s\S]*?\);\s*notifySettingsWritten\(settings\);/,
      );
      // 不在任何块 if 里（enclosingIfConditions 找不到包着它的块 if 会抛错）
      expect(() =>
        enclosingIfConditions(locked, "notifySettingsWritten(settings)"),
      ).toThrow();
      // PUT：整段进写锁后调它；PATCH：同一把锁内合并后调它
      expect(src).toMatch(
        /export const putSettingsFile = async[\s\S]*?withSettingsWriteLock\(\(\) => putSettingsFileLocked\(incoming\)\)/,
      );
      expect(src).toMatch(
        /export const patchSettingsFile = async[\s\S]*?return putSettingsFileLocked\(/,
      );
    });
  },
);

// ----------------- 并入的调用等在途收尾（status 接口读到的不是旧快照） -----------------

describe(
  "syncBridgeRuntime：并入的调用等在途那次真正收尾再返回",
  { timeout: 15_000 },
  () => {
    it("并发两次：第二次只有在第一次完全收尾（syncing 释放、consumer 起完）后才 resolve", async () => {
      // 防的回归：并入的调用「只置补跑标志就立刻返回」——/status 的 `await syncBridgeRuntime()` 之后立刻读
      // getBridgeRuntimeStatus()，读到的 consumers 仍是 stopped / starting 的旧快照（设置页显示「未运行」）。
      await writeBridgeSettings(true);
      const gate = deferred();
      statusGate = gate;
      try {
        const first = syncBridgeRuntime();
        await waitUntil(() => statusCalls >= 1, "第一次 sync 卡在 im 的探冲突");

        let secondDone = false;
        const second = syncBridgeRuntime().then(() => {
          secondDone = true;
        });
        await tick(5);
        expect(secondDone).toBe(false); // 在途那次还没收尾，并入的调用必须还在等
        expect(runtimeOf().syncing).toBe(true);

        statusGate = null;
        gate.resolve();
        await second;
        // 第二次 resolve 的这一刻，在途那次必须已经完全收尾——这正是 status 接口要的「快照不旧」
        expect(runtimeOf().syncing).toBe(false);
        expect(findSpawned(IM)).toHaveLength(1);
        expect(findSpawned(CARD)).toHaveLength(1);
        expect(consumerStatus(IM)?.status).not.toBe("stopped");
        expect(consumerStatus(CARD)?.status).not.toBe("stopped");
        await first;
      } finally {
        statusGate = null;
        gate.resolve();
      }
    });

    it("在途那次的补跑轮抛错：发起方照旧收到错误，并入方不抛（错误归发起方消费）", async () => {
      // 防的回归：并入方直接 await 在途 promise，在途那次抛错时 status 接口里无辜的另一次调用也跟着抛 500。
      await writeBridgeSettings(true); // 防休眠关：第 1 轮不碰防休眠
      const ka = runtimeOf().keepAwake;
      const origStart = ka.start;
      const gate = deferred();
      statusGate = gate;
      try {
        const first = syncBridgeRuntime().then(
          () => "ok",
          (e: unknown) => `err:${(e as Error).message}`,
        );
        await waitUntil(() => statusCalls >= 1, "第一次 sync 卡在 im 的探冲突");

        let secondResult: string | null = null;
        const second = syncBridgeRuntime().then(
          () => {
            secondResult = "ok";
          },
          (e: unknown) => {
            secondResult = `err:${(e as Error).message}`;
          },
        );
        // 途中把防休眠打开并让 start 抛错：放开后第 1 轮正常收尾、补跑的第 2 轮在 syncKeepAwake 里抛
        await writeBridgeSettings(true, { feishuBridgeKeepAwake: true });
        ka.start = () => {
          throw new Error("boom-pass2");
        };
        statusGate = null;
        gate.resolve();

        expect(await first).toBe("err:boom-pass2");
        await second;
        expect(secondResult).toBe("ok");
      } finally {
        ka.start = origStart;
        statusGate = null;
        gate.resolve();
      }
    });

    it("status 接口的限时等待（R20-15）：并入卡住的在途对账时到点放手；放手后在途对账仍照常收尾", async () => {
      // 防的回归：并入方无限等在途对账——lark-cli 卡住（event status 默认 30 秒超时）时，status 接口跟着挂几十秒。
      // 这里用真实对账 + 卡住的 event status，只把上限缩到 40ms（路由里是 15 秒，数值另有源码钉子）。
      await writeBridgeSettings(true);
      const gate = deferred();
      statusGate = gate;
      try {
        const first = syncBridgeRuntime();
        await waitUntil(() => statusCalls >= 1, "第一次 sync 卡在 im 的探冲突");

        const t0 = Date.now();
        const waited = await awaitWithCap(syncBridgeRuntime(), 40); // 并入在途那次 → 一直卡着 → 到点放手
        expect(waited).toEqual({ capped: true });
        expect(Date.now() - t0).toBeLessThan(3000);
        // 放手 ≠ 取消：在途对账还在跑、consumer 还没起
        expect(runtimeOf().syncing).toBe(true);
        expect(findSpawned(IM)).toHaveLength(0);

        statusGate = null;
        gate.resolve();
        await first;
        await waitSyncIdle();
        // 对账照常收尾：两个 consumer 都起来了（放手只是 status 不再等，没有丢掉这次对账）
        expect(findSpawned(IM)).toHaveLength(1);
        expect(findSpawned(CARD)).toHaveLength(1);
      } finally {
        statusGate = null;
        gate.resolve();
      }
    });
  },
);

// ----------------- 关闭并行停 + 退避重启与停的竞态 -----------------

describe("停 consumer：并行停 + 退避重启不会在关后又 spawn", { timeout: 15_000 }, () => {
  it("关闭分支两个 consumer 并行停：任一个退出之前，两个都已收到 stdin EOF", async () => {
    // 防的回归：串行 stopConsumer——第一个要等满 stdin EOF(5s)+SIGTERM(5s) 才轮到第二个，最坏约 20 秒才算「关干净」。
    // 观测：把两个 child 钉成「收到 EOF 也不退出」；并行时两个都应在任何一个退出前收到 EOF，串行时第二个收不到。
    await writeBridgeSettings(true);
    await syncBridgeRuntime();
    expect(spawned).toHaveLength(2);
    for (const s of spawned) s.child.holdExit = true;
    __setStopGraceForTest(50); // 万一串行：别让红的用例再真等 5s

    await writeBridgeSettings(false);
    const closing = syncBridgeRuntime();
    try {
      await waitUntil(
        () => spawned.every((s) => s.child.stdinEnded),
        "两个 consumer 都在对方退出之前收到了 stdin EOF",
        1500,
      );
      expect(spawned.every((s) => s.child.exitCode === null)).toBe(true);
    } finally {
      // 无论断言成败都放行退出，别让后面的清理卡住
      for (const s of spawned) s.child.exit(0, null);
      await closing.catch(() => undefined);
    }
    expect(consumerStatus(IM)?.status).toBe("stopped");
    expect(consumerStatus(CARD)?.status).toBe("stopped");
    expect(runtimeOf().syncing).toBe(false);
  });

  it("EOF + SIGTERM 两档都等满、child 仍不退出：只发过 SIGTERM（不强杀）、放弃时 warn 带 pid、状态落到 stopped（R20-16）", async () => {
    // 取舍（inbound.ts stopChildGracefully，R20-16 复核后维持）：不 kill -9——强杀会漏退订；
    // 代价是卡死的 consumer 被放弃、可能仍占着事件订阅。放弃不能是静默的：必须有带 pid 的日志，
    // 之后「事件被某 pid 占用」的冲突提示出现时才能对上号。这里钉住两件事：只有 SIGTERM；放弃时有带 pid 的 warn。
    await writeBridgeSettings(true);
    await syncBridgeRuntime();
    expect(spawned).toHaveLength(2);
    const signals = new Map<number, string[]>();
    for (const s of spawned) {
      s.child.holdExit = true; // 收到 stdin EOF 不退出
      signals.set(s.child.pid, []);
      s.child.kill = (signal?: string): boolean => {
        // 收到信号也不退出：钉死的 child
        signals.get(s.child.pid)!.push(signal ?? "SIGTERM");
        s.child.killed = true;
        return true;
      };
    }
    __setStopGraceForTest(30); // 两档各 30ms，别真等 5s
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeBridgeSettings(false);
      await syncBridgeRuntime();
      for (const s of spawned) {
        expect(s.child.stdinEnded).toBe(true);
        expect(signals.get(s.child.pid), `pid=${s.child.pid} 收到的信号`).toEqual(["SIGTERM"]);
      }
      const abandoned = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("已放弃等待"));
      expect(abandoned).toHaveLength(2);
      for (const s of spawned) {
        expect(abandoned.some((m) => m.includes(`pid=${s.child.pid} `))).toBe(true);
      }
      expect(consumerStatus(IM)?.status).toBe("stopped");
      expect(consumerStatus(CARD)?.status).toBe("stopped");
    } finally {
      warn.mockRestore();
      for (const s of spawned) s.child.exit(0, null); // 放行，别让清理卡住
    }
  });

  it("pid 为空的 child（spawn 根本没成功、没有进程可言）不会被报成「已放弃等待」，真有 pid 的才报", async () => {
    await writeBridgeSettings(true);
    await syncBridgeRuntime();
    expect(spawned).toHaveLength(2);
    const [noPid, withPid] = spawned;
    (noPid!.child as unknown as { pid: number | undefined }).pid = undefined;
    for (const s of spawned) {
      s.child.holdExit = true;
      s.child.kill = (): boolean => {
        s.child.killed = true;
        return true;
      };
    }
    __setStopGraceForTest(30);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeBridgeSettings(false);
      await syncBridgeRuntime();
      const abandoned = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("已放弃等待"));
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0]).toContain(`pid=${withPid!.child.pid} `);
      expect(abandoned[0]).not.toContain("pid=undefined");
    } finally {
      warn.mockRestore();
      for (const s of spawned) s.child.exit(0, null);
    }
  });

  it("正常响应 EOF 的 child：停得干净，不记「已放弃等待」（warn 只在真放弃时出现）", async () => {
    await writeBridgeSettings(true);
    await syncBridgeRuntime();
    expect(spawned).toHaveLength(2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeBridgeSettings(false);
      await syncBridgeRuntime();
      expect(
        warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("已放弃等待")),
      ).toEqual([]);
      expect(consumerStatus(IM)?.status).toBe("stopped");
    } finally {
      warn.mockRestore();
    }
  });

  it("退避重启的 startConsumer 正卡在冲突探测时桥接被关：放行后不会再 spawn", async () => {
    // 防的回归（评审人推测、读码确认成立）：退避定时器已触发（restartTimer 已置空，stopConsumer 摘不到它），
    // startConsumer 卡在 `await checkEventKeyConflict`；此时 stopConsumer 对「无子进程」的 handle 同步跑完并把
    // stopping 复位成 false，探测返回后 startConsumer 看不出自己被停过、照常 spawn——桥接已关却又起了 consumer。
    __setConsumerBackoffBaseForTest(5);
    await writeBridgeSettings(true);
    await syncBridgeRuntime();
    expect(spawned).toHaveLength(2);

    const gate = deferred();
    statusGate = gate;
    const before = statusCalls;
    try {
      // im 崩溃 → 5ms 后退避定时器触发 startConsumer → 卡在 event status 探测
      findSpawned(IM)[0]!.child.exit(1, null);
      await waitUntil(() => statusCalls > before, "退避重启的 startConsumer 卡在探冲突");

      // 此时关桥接：sync 的关闭分支对 im（无子进程）同步跑完 stopConsumer
      await writeBridgeSettings(false);
      await syncBridgeRuntime();
      expect(consumerStatus(IM)?.status).toBe("stopped");

      statusGate = null;
      gate.resolve();
      await tick(10);
      expect(spawned).toHaveLength(2); // 没有第 3 次 spawn
      expect(consumerStatus(IM)?.status).toBe("stopped");
      expect(consumerStatus(IM)?.pid).toBeUndefined();
    } finally {
      statusGate = null;
      gate.resolve();
    }
  });
});

// ----------------- 对账状态机的边角 -----------------

describe("对账状态机边角", { timeout: 15_000 }, () => {
  it("对账抛错后 syncing 复位：错误照常抛给发起方，下一次对账能正常工作（不永久卡死）", async () => {
    // 防的回归：finally 里不复位 syncing——一次对账抛错后所有后续 sync 都被当成「并入」、永远轮不到真正处理，桥接直到重启都是死的。
    await writeBridgeSettings(true, { feishuBridgeKeepAwake: true });
    const ka = runtimeOf().keepAwake;
    const origStart = ka.start;
    ka.start = () => {
      throw new Error("boom-keepawake");
    };
    try {
      await expect(syncBridgeRuntime()).rejects.toThrow("boom-keepawake");
      expect(runtimeOf().syncing).toBe(false);

      ka.start = origStart; // 故障排除后下一次对账应当真的做事
      await syncBridgeRuntime();
      expect(findSpawned(IM)).toHaveLength(1);
      expect(findSpawned(CARD)).toHaveLength(1);
    } finally {
      ka.start = origStart;
    }
  });

  /**
   * 把「第 n 次读 config.json」换成 EBUSY 失败（其余读照旧）：精确造出「总开关读到了、紧接着的防休眠子开关那次读瞬时失败」
   * （Windows 杀软瞬时占文件之类）。一次对账里读 config.json 的顺序是：① 总开关 ② 防休眠子开关——所以 n=2 就是子开关那一读。
   * settings-fs 读盘走 `import { promises as fs } from "node:fs"` 的 `fs.readFile`，与本文件的 fsp 是同一个对象，spy 得到。
   */
  const failNthConfigRead = (n: number): { restore: () => void } => {
    const realReadFile = fsp.readFile.bind(fsp) as unknown as (...a: unknown[]) => Promise<unknown>;
    const configPath = settingsFilePath();
    let reads = 0;
    const spy = vi.spyOn(fsp, "readFile").mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (String(p) === configPath) {
        reads += 1;
        if (reads === n) {
          return Promise.reject(
            Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }),
          );
        }
      }
      return realReadFile(p, ...rest);
    }) as unknown as typeof fsp.readFile);
    return { restore: () => spy.mockRestore() };
  };

  /** 给防休眠的 start / stop 套上计数（用完 restore） */
  const countKeepAwakeCalls = () => {
    const ka = runtimeOf().keepAwake;
    const origStart = ka.start;
    const origStop = ka.stop;
    const counts = { start: 0, stop: 0 };
    ka.start = () => {
      counts.start += 1;
      origStart.call(ka);
    };
    ka.stop = () => {
      counts.stop += 1;
      origStop.call(ka);
    };
    return {
      ka,
      counts,
      restore: () => {
        ka.start = origStart;
        ka.stop = origStop;
      },
    };
  };

  it("防休眠子开关那次读瞬时失败（R20-16）：保持防休眠现状（不启不停）、consumer 照常起；下一轮读到才对齐", async () => {
    // 防的回归：读失败当「开」——用户明明关了防休眠，这一次瞬时读失败就会误起 caffeinate（旧口径）。
    await writeBridgeSettings(true, { feishuBridgeKeepAwake: false });
    const { ka, counts, restore } = countKeepAwakeCalls();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fail = failNthConfigRead(2);
    try {
      await syncBridgeRuntime();
      fail.restore();
      expect(counts.start, "子开关读失败不能当成「开」去起防休眠").toBe(0);
      expect(counts.stop, "读失败也不该去停（保持现状）").toBe(0);
      expect(ka.isActive()).toBe(false);
      // 本轮对账没被子开关读失败拖垮：consumer 照常起
      expect(findSpawned(IM)).toHaveLength(1);
      expect(findSpawned(CARD)).toHaveLength(1);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("读防休眠开关失败")),
        "读失败要记一条 warn",
      ).toBe(true);

      // 下一轮读到「关」：这时才对齐（停被叫、始终没有起）
      await syncBridgeRuntime();
      expect(counts.start).toBe(0);
      expect(counts.stop).toBeGreaterThan(0);
    } finally {
      fail.restore();
      restore();
      warn.mockRestore();
    }
  });

  it("子开关那次读瞬时失败、而用户当前其实开着防休眠：同样不启不停（读失败 ≠ 任何一个取值）；下一轮读到才起（R20-16 反方向）", async () => {
    // 与上一条对称：子开关实际是「开」，读失败时不能当成「关」去停（stop 次数必须是 0）。
    // 只数 start / stop 的调用次数、不看 isActive：Linux 等平台上 start() 本来就跳过，isActive 与平台有关。
    await writeBridgeSettings(true, { feishuBridgeKeepAwake: true });
    const { counts, restore } = countKeepAwakeCalls();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fail = failNthConfigRead(2);
    try {
      await syncBridgeRuntime();
      fail.restore();
      expect(counts.start, "读失败不该去起").toBe(0);
      expect(counts.stop, "读失败不该去停").toBe(0);
      await syncBridgeRuntime(); // 读到了「开」：这时才起
      expect(counts.start).toBeGreaterThan(0);
      expect(counts.stop).toBe(0);
    } finally {
      fail.restore();
      restore();
      warn.mockRestore();
    }
  });

  it("对照：子开关读得到 false → 停（不起）；读得到 true → 起（不停）", async () => {
    await writeBridgeSettings(true, { feishuBridgeKeepAwake: false });
    const off = countKeepAwakeCalls();
    try {
      await syncBridgeRuntime();
      expect(off.counts.start).toBe(0);
      expect(off.counts.stop).toBeGreaterThan(0);
    } finally {
      off.restore();
    }

    await writeBridgeSettings(true, { feishuBridgeKeepAwake: true });
    const on = countKeepAwakeCalls();
    try {
      await syncBridgeRuntime();
      expect(on.counts.start).toBeGreaterThan(0);
      expect(on.counts.stop).toBe(0);
    } finally {
      on.restore();
    }
  });

  it("写盘驱动的 开→关→开 快速连点：最终稳定在「开」，每个 consumer 恰好一个活进程", async () => {
    // 防的回归：补跑标志丢了 / 并发合并出错——「开→关→开」里中间的「关」把最后的「开」吞掉，桥接停在关。
    // 为了确定性，每一步都钉在可控的闸上：第 1 轮卡在探冲突（期间写「关」）、第 2 轮停 consumer 时 child 钉住不退
    //（期间写「开」）、放行退出后第 3 轮读到「开」重新起。总共正好 3 轮（= MAX_SYNC_PASSES）。
    ensureBridgeRuntimePolling();
    await waitSyncIdle();
    const gate = deferred();
    statusGate = gate;
    holdNewChildExit = true; // 第 1 轮起的 child 收到 EOF 先不退，等第 2 轮停它们时由用例放行
    try {
      await writeBridgeSettings(true); // 订阅回调 → sync1：读到「开」，卡在 im 探冲突
      await waitUntil(() => statusCalls >= 1, "sync1 读到「开」并卡在探冲突");

      await writeBridgeSettings(false); // 并入 sync1：补跑标志
      statusGate = null;
      gate.resolve();
      await waitUntil(
        // 用 some 而不是 every：本用例只钉「补跑 / 并入」，不依赖两个 consumer 是并行停还是串行停（那由专门的并行用例负责）
        () => spawned.length === 2 && spawned.some((s) => s.child.stdinEnded),
        "第 1 轮起完两个 consumer、补跑第 2 轮读到「关」并开始停（child 钉住不退）",
      );

      await writeBridgeSettings(true); // 第 2 轮停的途中又打开：并入补跑
      holdNewChildExit = false; // 第 3 轮新起的 child 照常响应 EOF（清理用）
      for (const s of [...spawned]) s.child.exit(0, null); // 放行退出，第 2 轮收尾

      await waitSyncIdle();
      expect(spawned).toHaveLength(4); // 第 3 轮读到「开」又各起了一个
      const alive = spawned.filter((s) => s.child.exitCode === null);
      expect(alive.map((s) => s.args[2]).sort()).toEqual([CARD, IM].sort());
      expect(consumerStatus(IM)?.status).not.toBe("stopped");
      expect(consumerStatus(CARD)?.status).not.toBe("stopped");
    } finally {
      statusGate = null;
      gate.resolve();
      holdNewChildExit = false;
      for (const s of spawned) s.child.holdExit = false;
    }
  });

  it("超过 MAX_SYNC_PASSES 放弃后：状态停在旧值，由轮询入口（再调一次 sync）补上", async () => {
    // 防的回归 / 文档口径：「最后一次写入必被对账」只在 3 轮内成立；超过 3 轮时对账放弃、清掉补跑请求，
    // 靠 30s 轮询兜底。这里钉住：放弃后确实停在旧值（conflict），轮询那一次调用能把它补到「关」。
    statusConsumers = [
      { pid: 99999, event_key: IM },
      { pid: 99998, event_key: CARD },
    ];
    await writeBridgeSettings(true);
    const writes: Promise<void>[] = [];
    onStatusProbe = () => {
      if (statusCalls < 60) void syncBridgeRuntime(); // 每次探测都再请求：把 3 轮用满
      // 第 3 轮的第一次探测（第 5 次 event status）：第 3 轮已读完「开」、之后没有第 4 轮——此时才关掉开关
      if (statusCalls === 5) writes.push(writeBridgeSettings(false));
    };
    await syncBridgeRuntime();
    expect(statusCalls).toBe(6); // 3 轮 × 2 个冲突 consumer
    await Promise.all(writes);
    expect(getBridgeRuntimeStatus().overall).toBe("conflict"); // 放弃后停在旧值，开关其实已是「关」
    expect(runtimeOf().syncing).toBe(false);

    onStatusProbe = null;
    await syncBridgeRuntime(); // 模拟 30s 轮询入口再调一次
    expect(statusCalls).toBe(6); // 关闭分支不探测
    expect(getBridgeRuntimeStatus().overall).toBe("stopped");
  });

  it("升级 hold 期间不启动 consumer；hold 解除（安装链 resume）后补一次对账", async () => {
    // 防的回归：hold 期间写盘 / 轮询触发的对账把正要覆盖的 lark-cli exe 重新拉起来锁住（Windows 盖不掉 EPERM）；
    // 或 hold 解除后没人补那一次对账，桥接停在关直到下一次轮询。
    ensureBridgeRuntimePolling();
    await waitSyncIdle();
    await suspendBinaryUsers("lark-cli"); // 真实安装链入口：置 hold + 停 consumer

    await writeBridgeSettings(true); // hold 期间打开开关：写盘订阅会触发对账
    await waitSyncIdle();
    await tick(5);
    expect(spawned).toHaveLength(0);

    await resumeBinaryUsers("lark-cli"); // 解除 hold + 补一次对账
    await waitSyncIdle();
    expect(findSpawned(IM)).toHaveLength(1);
    expect(findSpawned(CARD)).toHaveLength(1);
  });

  it("读开关失败（config.json 暂不可读）：对账保持现状，不把正在跑的 consumer 误停；恢复可读后正常对账", async () => {
    // 防的回归：读盘失败一律当「关」——刚 rename 完 Windows 杀软瞬时占文件等场景会把 consumer 误停。
    await writeBridgeSettings(true);
    await syncBridgeRuntime();
    expect(spawned).toHaveLength(2);

    await fsp.writeFile(settingsFilePath(), "{ not json", "utf-8"); // 读失败（JSON 损坏 → status:error）
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await syncBridgeRuntime();
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("读桥接开关失败")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
    for (const { child } of spawned) {
      expect(child.stdinEnded).toBe(false); // 没被停
      expect(child.exitCode).toBeNull();
    }
    expect(spawned).toHaveLength(2); // 也没被重复启动
    expect(consumerStatus(IM)?.status).not.toBe("stopped");
    expect(consumerStatus(CARD)?.status).not.toBe("stopped");

    // 恢复可读且开关为「关」：下一次对账正常停
    await writeBridgeSettings(false);
    await syncBridgeRuntime();
    expect(consumerStatus(IM)?.status).toBe("stopped");
    expect(consumerStatus(CARD)?.status).toBe("stopped");
  });
});

// ----------------- 轮询入口抛错不变成 unhandledRejection -----------------

describe("轮询入口的对账错误被 .catch 吞掉", { timeout: 15_000 }, () => {
  it("启动首次对账与 30s 轮询入口：对账抛错只记 warn，不产生 unhandledRejection", async () => {
    // 防的回归：入口处裸 `void syncBridgeRuntime()` 没有 .catch——对账抛错（停 consumer 失败等）
    // 变成 unhandledRejection（Node 默认让进程退出）。
    await writeBridgeSettings(true, { feishuBridgeKeepAwake: true });
    const ka = runtimeOf().keepAwake;
    const origStart = ka.start;
    ka.start = () => {
      throw new Error("boom-poll");
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      ensureBridgeRuntimePolling(); // 启动首次对账：抛错
      await waitSyncIdle();
      await vi.advanceTimersByTimeAsync(30_000); // 轮询 tick：再抛一次
      await waitSyncIdle();
      await tick(5);

      expect(unhandled).toEqual([]);
      const polled = warn.mock.calls.filter((c) =>
        String(c[0]).includes("对账失败"),
      );
      expect(polled.length).toBeGreaterThanOrEqual(2); // 启动首次 + 一次轮询，错误都被记了日志
    } finally {
      await stopBridgeRuntime(); // 趁还是 fake 定时器时清掉 interval
      vi.useRealTimers();
      ka.start = origStart;
      warn.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("源码结构钉子：启动首次与轮询入口都经过带 .catch 的 syncBridgeRuntimeQuiet，不再有裸 void syncBridgeRuntime()", () => {
    const src = readSource("src/lib/server/feishu-bridge/inbound.ts");
    const quiet = blockAfter(src, "const syncBridgeRuntimeQuiet = (");
    expect(quiet).toMatch(/void syncBridgeRuntime\(\)\.catch\(/);
    const polling = blockAfter(src, "export const ensureBridgeRuntimePolling = (");
    expect(polling).not.toMatch(/void syncBridgeRuntime\(\)/);
    expect(polling.match(/syncBridgeRuntimeQuiet\(/g)).toHaveLength(2);
  });
});

// ----------------- status 路由：自己发起的对账抛错只记日志（第十九轮按推荐定的口径） -----------------

describe("status 路由里的对账不拖垮 status 响应", () => {
  it("源码结构钉子：GET 里的对账（经 awaitWithCap 限时等）包在自己的 try / catch 里，catch 只 console.warn、不 return / throw（对账失败时 status 仍返回当前状态）", () => {
    const src = readSource("src/app/api/feishu-bridge/status/route.ts");
    const get = blockAfter(src, "export const GET = async () => {");
    // 对账那一句必须被它自己的 try 圈住（外层 try 不算：外层 catch 会 500）
    const at = get.indexOf("await awaitWithCap(");
    expect(at, "GET 里找不到限时等待的对账调用").toBeGreaterThan(-1);
    const before = get.slice(0, at);
    expect(before.replace(/\s+/g, " "), "对账调用前一刻必须是它自己的 try { + const synced =").toMatch(
      /try \{ try \{ const synced = $/,
    );
    const innerCatch = blockAfter(get.slice(at), "} catch (err) {");
    expect(innerCatch).toMatch(/console\.warn\(/);
    expect(innerCatch, "对账失败不能让 status 整个失败").not.toMatch(/\b(return|throw)\b/);
    // 对账之后照常往下走（回填 + 探测 + 合入 runtime）
    const rest = get.slice(at);
    expect(rest).toMatch(/await hydrateBridgeInboundAt\(\);/);
    expect(rest).toMatch(/probeBridgeStatus\(\)/);
    expect(rest).toMatch(/runtime: getBridgeRuntimeStatus\(\)/);
  });

  it("源码结构钉子（R20-15）：等对账有上限——等的是 syncBridgeRuntime() 本身、上限常量在 10~25 秒之间、超时分支只 warn 不 return / throw", () => {
    const src = readSource("src/app/api/feishu-bridge/status/route.ts");
    const get = blockAfter(src, "export const GET = async () => {");
    const at = get.indexOf("await awaitWithCap(");
    expect(at).toBeGreaterThan(-1);
    const call = get.slice(at, at + 400).replace(/\s+/g, " ");
    // 等的必须是对账本身（不是别的 promise）、用的是那个上限常量
    expect(call).toMatch(/^await awaitWithCap\( syncBridgeRuntime\(\), STATUS_SYNC_WAIT_CAP_MS,/);
    // 上限数值：太小会把正常的慢（起 consumer + event status）也砍掉，太大（≥ lark-cli 默认 30 秒）等于没限
    const cap = /const STATUS_SYNC_WAIT_CAP_MS = ([\d_]+);/.exec(src);
    expect(cap, "找不到 STATUS_SYNC_WAIT_CAP_MS 常量").not.toBeNull();
    const ms = Number(cap![1]!.replace(/_/g, ""));
    expect(ms).toBeGreaterThanOrEqual(10_000);
    expect(ms).toBeLessThanOrEqual(25_000);
    // 超时分支：只记日志，status 照常往下走
    const capped = blockAfter(get.slice(at), "if (synced.capped) {");
    expect(capped).toMatch(/console\.warn\(/);
    expect(capped).not.toMatch(/\b(return|throw)\b/);
    // route 模块只能导出 HTTP 方法 / 路由配置：常量不能 export（否则 Next 构建会拒绝这个 route）
    expect(src).not.toMatch(/export const STATUS_SYNC_WAIT_CAP_MS/);
  });
});
