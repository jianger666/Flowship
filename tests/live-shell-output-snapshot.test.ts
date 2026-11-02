/**
 * shell 直播输出的服务端实时快照（shell-output-bridge 的 getLiveShellOutputSnapshot）。
 *
 * 背景：agent 在跑长 shell（编译 / 测试）时用户切到别的窗口再切回（ChatView 重挂、挂载时清空直播缓冲）或 SSE 重连，
 * `tool_output_delta` 是纯内存 ephemeral 帧、从不回放，工具块实时输出是空的、之后只有「切回那一刻起的增量」。
 * 服务端按 task 记住「已发出的 callId → 尾部窗口」，新订阅者 bootstrap 时补一帧 tool_output_snapshot（路由行为见
 * tests/watch-task-tool-output-snapshot.test.ts）。本文件只钉服务端存储本身：
 *   1. 记账口径：只记 publish 出去的、对外窗口 ≤20 行 / ≤8KB；还在 500ms / 2KB 合帧缓冲里没发的不算；
 *   2. trailing flush（R1-3）：没到阈值的尾巴不会因为之后一直静默而卡在缓冲里，最迟 500ms 补发；
 *      定时器在 flush / completed / 失主 / discard / done 时都清掉、unref、回调不抛；
 *   3. 清理：tool-call-completed（收尾 flush 之后）/ lease 失主（读取时、记账时、新一路 run 起来时）/ discard /
 *      任务流上的 done（属主主链）与 task_deleted（全局 tap）；
 *   4. 封顶：每 task ≤8 个 callId、全进程合计 ≤64，淘汰最久没更新的；每个 callId 的原文窗口也有硬上限；
 *   5. 隔离：不同 task 互不串；
 *   6. 脱敏发生在截断之前（R1-4）：快照文本 / 超窗口大块的发帧，被窗口边界切开的凭据不能留下半截。
 */
import type { InteractionUpdate } from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIVE_OUTPUT_MAX_CHARS, LIVE_OUTPUT_MAX_LINES } from "@/lib/live-output-cap";
import type { TaskEvent } from "@/lib/types";

type StreamEv = { kind: string; event?: TaskEvent; origin?: string };
type Tap = (taskId: string, ev: StreamEv) => void;

const hoisted = vi.hoisted(() => ({
  published: [] as Array<{ taskId: string; ev: { kind: string; event?: TaskEvent } }>,
  /** 全局 tap（subscribeAllTaskStreams）订阅者——测试里用 emitStream 把任务流事件喂给它们 */
  taps: [] as Array<(taskId: string, ev: { kind: string; origin?: string }) => void>,
  /** 让 publish 抛错（验证 trailing 定时器回调不外溢） */
  publishBoom: false,
}));

vi.mock("@/lib/server/task-stream", () => ({
  publish: (taskId: string, ev: { kind: string; event?: TaskEvent }) => {
    if (hoisted.publishBoom) throw new Error("publish 炸了");
    hoisted.published.push({ taskId, ev });
  },
  writeOwnedEventAndPublish: vi.fn(),
  subscribeAllTaskStreams: (listener: Tap) => {
    hoisted.taps.push(listener);
    return () => {
      const i = hoisted.taps.indexOf(listener);
      if (i >= 0) hoisted.taps.splice(i, 1);
    };
  },
}));

const {
  createShellOutputDeltaPublisher,
  getLiveShellOutputSnapshot,
  discardAllLiveShellOutputOfTask,
  discardLiveShellOutput,
  LIVE_SHELL_MAX_CALLS_PER_TASK,
  LIVE_SHELL_MAX_CALLS_TOTAL,
  LIVE_SHELL_RAW_MAX_CHARS,
} = await import("@/lib/server/shell-output-bridge");

/** 把一个任务流事件喂给全局 tap（真实 publish 里全局 tap 就是这么被调的） */
const emitStream = (taskId: string, ev: StreamEv): void => {
  for (const tap of [...hoisted.taps]) tap(taskId, ev);
};

type Delta = { update: InteractionUpdate };
const started = (callId: string): Delta => ({
  update: { type: "tool-call-started", callId, toolCall: { type: "shell" } } as InteractionUpdate,
});
const stdout = (data: string): Delta => ({
  update: {
    type: "shell-output-delta",
    event: { case: "stdout", value: { data } },
  } as InteractionUpdate,
});
const completed = (callId: string): Delta => ({
  update: { type: "tool-call-completed", callId } as InteractionUpdate,
});

/** ≥2KB（FLUSH_BYTES）→ 一进来就立刻 flush 发出；末尾带换行 */
const big = (tag: string): string => `${tag}${"x".repeat(2100)}\n`;

/** 已 publish 出去的 chunk（按发出顺序，指定 callId） */
const publishedChunks = (callId: string): string[] =>
  hoisted.published
    .filter((p) => p.ev.event?.meta?.callId === callId)
    .map((p) => p.ev.event!.meta!.chunk as string);

const usedTasks = new Set<string>();
const tid = (name: string): string => {
  const id = `t_lso_${name}`;
  usedTasks.add(id);
  return id;
};

beforeEach(() => {
  hoisted.published.length = 0;
  hoisted.publishBoom = false;
  vi.useFakeTimers();
  vi.setSystemTime(1_760_000_000_000);
});
afterEach(() => {
  // 先 discard 再切回真时钟：discard 会取消还在等的 trailing 定时器（假时钟下清才干净）
  for (const id of usedTasks) discardAllLiveShellOutputOfTask(id);
  usedTasks.clear();
  vi.useRealTimers();
});

describe("记账口径：只记已发出的、窗口封顶", () => {
  it("没有 shell / 没发过任何输出 → 空数组", () => {
    expect(getLiveShellOutputSnapshot(tid("none"))).toEqual([]);
    const onDelta = createShellOutputDeltaPublisher(tid("started-only"));
    onDelta(started("c1"));
    expect(getLiveShellOutputSnapshot(tid("started-only"))).toEqual([]);
  });

  it("已发出的输出按 callId 累积成尾部窗口，与实际 publish 的 chunk 一一对应", () => {
    const task = tid("accum");
    const onDelta = createShellOutputDeltaPublisher(task);
    onDelta(started("c1"));
    const a = big("A");
    const b = big("B");
    onDelta(stdout(a));
    onDelta(stdout(b));
    expect(publishedChunks("c1")).toEqual([a, b]);
    expect(getLiveShellOutputSnapshot(task)).toEqual([{ callId: "c1", text: `${a}${b}` }]);
  });

  it("还在 500ms / 2KB 合帧缓冲里没发出去的字不进快照；它发出时才进来（作为增量排在快照之后，不重复）", () => {
    const task = tid("pending");
    const onDelta = createShellOutputDeltaPublisher(task);
    onDelta(started("c1"));
    onDelta(stdout("还没发\n"));
    expect(publishedChunks("c1")).toEqual([]);
    expect(getLiveShellOutputSnapshot(task)).toEqual([]);

    // 节流窗口过了、下一块进来：攒的一起发（同一帧、同一次记账），挂着的 trailing 定时器随这次 flush 一并清掉
    vi.setSystemTime(Date.now() + 600);
    onDelta(stdout("现在发\n"));
    expect(publishedChunks("c1")).toEqual(["还没发\n现在发\n"]);
    expect(getLiveShellOutputSnapshot(task)).toEqual([{ callId: "c1", text: "还没发\n现在发\n" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it(`窗口封顶：只留最后 ${LIVE_OUTPUT_MAX_LINES} 行`, () => {
    const task = tid("lines");
    const onDelta = createShellOutputDeltaPublisher(task);
    onDelta(started("c1"));
    const rows = Array.from({ length: 60 }, (_, i) => `row ${i} ${"-".repeat(60)}`).join("\n");
    onDelta(stdout(`${rows}\n`));
    const [item] = getLiveShellOutputSnapshot(task);
    const lines = item!.text.split("\n");
    // 末尾换行算一个空元素（与前端直播缓冲同口径）
    expect(lines).toHaveLength(LIVE_OUTPUT_MAX_LINES);
    expect(lines[lines.length - 2]).toMatch(/^row 59 /);
    expect(item!.text).not.toContain("row 39 ");
  });

  it(`窗口封顶：无换行的超长输出（进度条 / minify 文件）只留最后 ${LIVE_OUTPUT_MAX_CHARS} 字符，多块累积也不涨`, () => {
    const task = tid("chars");
    const onDelta = createShellOutputDeltaPublisher(task);
    onDelta(started("c1"));
    // 一次吐 20KB 无换行：发帧时已按尾部 8KB 截；之后再来几块，窗口仍是有界的
    onDelta(stdout(`${"a".repeat(10_000)}${"b".repeat(10_000)}`));
    for (let i = 0; i < 5; i += 1) onDelta(stdout("c".repeat(3000)));
    const [item] = getLiveShellOutputSnapshot(task);
    expect(item!.text.length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
    expect(item!.text.endsWith("c".repeat(100))).toBe(true);
  });

  it("不同 callId 各自一份；不同 task 互不串", () => {
    const t1 = tid("iso1");
    const t2 = tid("iso2");
    const d1 = createShellOutputDeltaPublisher(t1);
    const d2 = createShellOutputDeltaPublisher(t2);
    d1(started("a"));
    d1(stdout(big("1a")));
    d1(started("b"));
    d1(stdout(big("1b")));
    d2(started("a")); // 与 t1 的 callId 撞名也不串
    d2(stdout(big("2a")));
    const s1 = getLiveShellOutputSnapshot(t1);
    expect(s1.map((x) => x.callId)).toEqual(["a", "b"]);
    expect(s1[0]!.text.startsWith("1a")).toBe(true);
    expect(s1[1]!.text.startsWith("1b")).toBe(true);
    expect(getLiveShellOutputSnapshot(t2)).toEqual([{ callId: "a", text: big("2a") }]);
  });
});

describe("清理", () => {
  it("tool-call-completed：收尾 flush 先发出去、再清快照（最终输出走 tool_result 事件）", () => {
    const task = tid("completed");
    const onDelta = createShellOutputDeltaPublisher(task);
    onDelta(started("c1"));
    onDelta(stdout(big("A")));
    onDelta(started("c2"));
    onDelta(stdout(big("B")));
    onDelta(stdout("尾巴\n")); // 还在缓冲里，completed 时收尾 flush
    onDelta(completed("c2"));
    expect(publishedChunks("c2").at(-1)).toBe("尾巴\n"); // 收尾 flush 照常发出
    // c2 清了、c1 还在跑
    expect(getLiveShellOutputSnapshot(task).map((x) => x.callId)).toEqual(["c1"]);
    onDelta(completed("c1"));
    expect(getLiveShellOutputSnapshot(task)).toEqual([]);
  });

  it("discardLiveShellOutput：指定 callId 只清那个；不传 callId 清整个 task；幂等", () => {
    const t1 = tid("disc1");
    const t2 = tid("disc2");
    const d1 = createShellOutputDeltaPublisher(t1);
    const d2 = createShellOutputDeltaPublisher(t2);
    for (const c of ["a", "b"]) {
      d1(started(c));
      d1(stdout(big(c)));
    }
    d2(started("a"));
    d2(stdout(big("a")));
    discardLiveShellOutput(t1, "a");
    expect(getLiveShellOutputSnapshot(t1).map((x) => x.callId)).toEqual(["b"]);
    // 无效 callId（空串 / undefined）什么都不清——不能再退化成「清整个任务」误伤并行 shell
    discardLiveShellOutput(t1, "");
    discardLiveShellOutput(t1, undefined as unknown as string);
    expect(getLiveShellOutputSnapshot(t1).map((x) => x.callId)).toEqual(["b"]);
    discardAllLiveShellOutputOfTask(t1);
    discardAllLiveShellOutputOfTask(t1);
    expect(getLiveShellOutputSnapshot(t1)).toEqual([]);
    expect(getLiveShellOutputSnapshot(t2)).toHaveLength(1);
  });

  it("run 失主（lease=false）：读取时不当作进行中告诉新订阅者，并顺手清掉（之后即使 lease 回 true 也不复活）", () => {
    const task = tid("lease-read");
    let alive = true;
    const onDelta = createShellOutputDeltaPublisher(task, () => alive);
    onDelta(started("c1"));
    onDelta(stdout(big("A")));
    expect(getLiveShellOutputSnapshot(task)).toHaveLength(1);
    alive = false;
    expect(getLiveShellOutputSnapshot(task)).toEqual([]);
    alive = true;
    expect(getLiveShellOutputSnapshot(task)).toEqual([]);
  });

  it("缓冲期间失主：flush 不发帧、不记账，且该 callId 已有的快照一并清掉", () => {
    const task = tid("lease-flush");
    let alive = true;
    const onDelta = createShellOutputDeltaPublisher(task, () => alive);
    onDelta(started("c1"));
    onDelta(stdout(big("A")));
    const before = hoisted.published.length;
    alive = false;
    onDelta(stdout(big("B"))); // 失主：丢弃
    expect(hoisted.published.length).toBe(before);
    alive = true; // 若快照没清、这里就会读到旧的 A
    expect(getLiveShellOutputSnapshot(task)).toEqual([]);
  });

  it("新一路 run 起来（新建发布器）：同 task 上一路没收尾、已失主的残留顺手清；仍存活的另一路（旁路答疑）不受影响", () => {
    const task = tid("sweep-create");
    let ownerAlive = true;
    const owner = createShellOutputDeltaPublisher(task, () => ownerAlive);
    const side = createShellOutputDeltaPublisher(task, () => true);
    owner(started("owner-call"));
    owner(stdout(big("O")));
    side(started("side-call"));
    side(stdout(big("S")));
    ownerAlive = false; // 属主 run 异常退出、没走到 tool-call-completed
    createShellOutputDeltaPublisher(task, () => true); // 新一路 run
    ownerAlive = true; // 若创建时没扫掉、这里读到的就会含 owner-call
    expect(getLiveShellOutputSnapshot(task).map((x) => x.callId)).toEqual(["side-call"]);
  });

  it("记账时顺手扫同 task 已失主的残留", () => {
    const task = tid("sweep-record");
    let oldAlive = true;
    const old = createShellOutputDeltaPublisher(task, () => oldAlive);
    // 两路都在飞时新一路已经建好（创建时那次扫描看到旧的还活着、不会清它），只能靠后面的记账扫
    const next = createShellOutputDeltaPublisher(task, () => true);
    old(started("old-call"));
    old(stdout(big("O")));
    oldAlive = false; // 旧的一路异常退出
    next(started("new-call"));
    next(stdout(big("N"))); // 这次记账顺手把已失主的 old-call 扫掉
    oldAlive = true; // 若没扫掉、这里读到的就会含 old-call
    expect(getLiveShellOutputSnapshot(task).map((x) => x.callId)).toEqual(["new-call"]);
  });
});

describe("容量封顶", () => {
  it(`每个 task 最多保留 ${LIVE_SHELL_MAX_CALLS_PER_TASK} 个 callId，超了淘汰最久没更新的（更新会续命）`, () => {
    const task = tid("cap-task");
    const onDelta = createShellOutputDeltaPublisher(task);
    const n = LIVE_SHELL_MAX_CALLS_PER_TASK;
    for (let i = 0; i < n; i += 1) {
      onDelta(started(`c${i}`));
      onDelta(stdout(big(`c${i}`)));
    }
    expect(getLiveShellOutputSnapshot(task)).toHaveLength(n);

    // c0 又来了一块 → 它变成最近更新的；再来一个新 callId 应该淘汰的是 c1。
    // （SDK 的 shell delta 无 callId、归给「最近启动的」，所以显式再启动 c0）
    onDelta(started("c0"));
    onDelta(stdout(big("c0-more")));
    onDelta(started("extra"));
    onDelta(stdout(big("extra")));

    const ids = getLiveShellOutputSnapshot(task).map((x) => x.callId);
    expect(ids).toHaveLength(n);
    expect(ids).toContain("c0");
    expect(ids).toContain("extra");
    expect(ids).not.toContain("c1");
    // 最近更新的在队尾
    expect(ids.at(-1)).toBe("extra");
  });

  it(`全进程合计最多 ${LIVE_SHELL_MAX_CALLS_TOTAL} 个 callId，超了淘汰全局最久没更新的（总内存有硬顶）`, () => {
    const perTask = LIVE_SHELL_MAX_CALLS_PER_TASK;
    const taskCount = Math.ceil(LIVE_SHELL_MAX_CALLS_TOTAL / perTask) + 3;
    const tasks = Array.from({ length: taskCount }, (_, i) => tid(`cap-total-${i}`));
    for (const task of tasks) {
      const onDelta = createShellOutputDeltaPublisher(task);
      for (let i = 0; i < perTask; i += 1) {
        onDelta(started(`c${i}`));
        onDelta(stdout(big(`${i}`)));
      }
    }
    const sizes = tasks.map((t) => getLiveShellOutputSnapshot(t).length);
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(total).toBe(LIVE_SHELL_MAX_CALLS_TOTAL);
    // 淘汰的是最早写入的那几个 task，最后写入的 task 完整保留
    expect(sizes.at(-1)).toBe(perTask);
    expect(sizes[0]!).toBeLessThan(perTask);
    // 每条窗口自身有界 → 总字符数有硬顶
    for (const t of tasks) {
      for (const item of getLiveShellOutputSnapshot(t)) {
        expect(item.text.length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
      }
    }
  });
});

describe("快照文本脱敏（快照不经 publish、由路由直接 send）", () => {
  it("凭据被切在相邻两帧时，单帧里看不出来、累积后的快照也不能原样漏给新订阅者", () => {
    const task = tid("redact");
    const fake = "glpat-fakefakefake1234567890";
    const prev = process.env.FLOWSHIP_GITLAB_TOKEN;
    process.env.FLOWSHIP_GITLAB_TOKEN = fake;
    try {
      const onDelta = createShellOutputDeltaPublisher(task);
      onDelta(started("c1"));
      onDelta(stdout(`${"x".repeat(2100)} token=${fake.slice(0, 12)}`));
      onDelta(stdout(`${fake.slice(12)} 完\n${"y".repeat(2100)}`));
      const [item] = getLiveShellOutputSnapshot(task);
      expect(item).toBeTruthy();
      expect(item!.text).not.toContain(fake);
      expect(item!.text).toContain("REDACTED");
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_GITLAB_TOKEN;
      else process.env.FLOWSHIP_GITLAB_TOKEN = prev;
    }
  });
});

// ---------------------------------------------------------------- trailing flush（R1-3）

describe("trailing flush：没到阈值的尾巴不会因为之后一直静默而卡在缓冲里（R1-3）", () => {
  it("不足 2KB、又在 500ms 节流窗口内的输出，之后一直没有新输出：最迟 500ms 补发，并进快照", () => {
    const task = tid("tf-silent");
    const onDelta = createShellOutputDeltaPublisher(task);
    onDelta(started("c1")); // lastFlushAt = 此刻
    vi.advanceTimersByTime(100);
    onDelta(stdout("编译到 87%\n"));
    // 合帧缓冲里、还没发：快照里没有（这是 K3 之前的状态）
    expect(publishedChunks("c1")).toEqual([]);
    expect(getLiveShellOutputSnapshot(task)).toEqual([]);

    vi.advanceTimersByTime(399); // 距上次 flush 499ms：还没到点
    expect(publishedChunks("c1")).toEqual([]);
    vi.advanceTimersByTime(1); // 满 500ms：trailing flush 触发
    expect(publishedChunks("c1")).toEqual(["编译到 87%\n"]);
    // 此后无论静默多久，新订阅者都拿得到这一截（K3 症状）
    vi.advanceTimersByTime(60_000);
    expect(getLiveShellOutputSnapshot(task)).toEqual([{ callId: "c1", text: "编译到 87%\n" }]);
    expect(publishedChunks("c1")).toHaveLength(1); // 只补发一次，不重复
    expect(vi.getTimerCount()).toBe(0); // 补发后没有残留定时器
  });

  it("距上次 flush 已经超过 500ms 才来的小块：当场就发，不挂定时器", () => {
    const task = tid("tf-due");
    const onDelta = createShellOutputDeltaPublisher(task);
    onDelta(started("c1"));
    vi.advanceTimersByTime(10_000);
    onDelta(stdout("一行\n"));
    expect(publishedChunks("c1")).toEqual(["一行\n"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("等的是「距上次 flush 满 500ms」，不是再等满 500ms；窗口内连续来的小块合成一帧、只挂一个定时器", () => {
    const task = tid("tf-merge");
    const onDelta = createShellOutputDeltaPublisher(task);
    onDelta(started("c1"));
    onDelta(stdout(big("A"))); // ≥2KB：当场 flush，lastFlushAt = t0
    expect(publishedChunks("c1")).toHaveLength(1);

    vi.advanceTimersByTime(200);
    onDelta(stdout("b1\n"));
    vi.advanceTimersByTime(50);
    onDelta(stdout("b2\n")); // 同一个窗口里的第二块：合进同一帧
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(249); // t0 + 499
    expect(publishedChunks("c1")).toHaveLength(1);
    vi.advanceTimersByTime(1); // t0 + 500
    expect(publishedChunks("c1")).toEqual([big("A"), "b1\nb2\n"]);
    expect(getLiveShellOutputSnapshot(task)).toEqual([{ callId: "c1", text: `${big("A")}b1\nb2\n` }]);
  });

  it("大块进来把缓冲冲走（≥2KB 到阈值）：定时器随这次 flush 清掉，之后不会再补发一次", () => {
    const task = tid("tf-due-flush");
    const onDelta = createShellOutputDeltaPublisher(task);
    onDelta(started("c1"));
    vi.advanceTimersByTime(100);
    onDelta(stdout("小块\n"));
    expect(vi.getTimerCount()).toBe(1);
    onDelta(stdout(big("B"))); // 累计 ≥2KB：小块 + 大块一起发
    expect(publishedChunks("c1")).toEqual([`小块\n${big("B")}`]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(publishedChunks("c1")).toHaveLength(1);
  });

  it("tool-call-completed：收尾 flush 发出尾巴、定时器清掉、快照清掉", () => {
    const task = tid("tf-completed");
    const onDelta = createShellOutputDeltaPublisher(task);
    onDelta(started("c1"));
    vi.advanceTimersByTime(100);
    onDelta(stdout("收尾前的尾巴\n"));
    expect(vi.getTimerCount()).toBe(1);
    onDelta(completed("c1"));
    expect(publishedChunks("c1")).toEqual(["收尾前的尾巴\n"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(getLiveShellOutputSnapshot(task)).toEqual([]);
    vi.advanceTimersByTime(5_000);
    expect(publishedChunks("c1")).toHaveLength(1);
    expect(getLiveShellOutputSnapshot(task)).toEqual([]);
  });

  it("等待期间 run 失主：定时器到点不 publish、清缓冲与快照，之后不留任何定时器", () => {
    const task = tid("tf-lease");
    let alive = true;
    const onDelta = createShellOutputDeltaPublisher(task, () => alive);
    onDelta(started("c1"));
    onDelta(stdout(big("A"))); // 已发出：快照里有 A
    vi.advanceTimersByTime(100);
    onDelta(stdout("失主前攒的\n"));
    expect(vi.getTimerCount()).toBe(1);

    alive = false;
    const before = hoisted.published.length;
    vi.advanceTimersByTime(500);
    expect(hoisted.published.length).toBe(before); // 失主：丢弃、不发
    expect(vi.getTimerCount()).toBe(0);
    alive = true; // 若快照 / 缓冲没清，这里会读到旧输出
    expect(getLiveShellOutputSnapshot(task)).toEqual([]);
  });

  it("discardLiveShellOutput(task, callId)：取消还在等的补发，未发的字被丢掉、也不会再记回快照", () => {
    const task = tid("tf-discard-call");
    const onDelta = createShellOutputDeltaPublisher(task);
    onDelta(started("c1"));
    onDelta(started("c2"));
    onDelta(stdout(big("A")));
    // 上面的输出归给最近启动的 c2；再让 c1 攒一点
    onDelta(started("c1"));
    vi.advanceTimersByTime(100);
    onDelta(stdout("c1 的尾巴\n"));
    expect(vi.getTimerCount()).toBe(1);

    discardLiveShellOutput(task, "c1"); // tool_result 落地
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(publishedChunks("c1")).toEqual([]);
    expect(getLiveShellOutputSnapshot(task).map((x) => x.callId)).toEqual(["c2"]); // c2 不受影响
  });

  it("discardAllLiveShellOutputOfTask(task)：整任务取消所有等待中的补发；别的 task 的定时器不受影响", () => {
    const t1 = tid("tf-discard-task1");
    const t2 = tid("tf-discard-task2");
    const d1 = createShellOutputDeltaPublisher(t1);
    const d2 = createShellOutputDeltaPublisher(t2);
    for (const [d, id] of [
      [d1, "a"],
      [d1, "b"],
      [d2, "x"],
    ] as const) {
      d(started(id));
    }
    vi.advanceTimersByTime(100);
    d1(stdout("给 b 的\n")); // 归给最近启动的 b
    d2(stdout("给 x 的\n"));
    expect(vi.getTimerCount()).toBe(2);

    discardAllLiveShellOutputOfTask(t1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(500);
    expect(publishedChunks("b")).toEqual([]);
    expect(publishedChunks("x")).toEqual(["给 x 的\n"]);
    expect(getLiveShellOutputSnapshot(t1)).toEqual([]);
    expect(getLiveShellOutputSnapshot(t2)).toEqual([{ callId: "x", text: "给 x 的\n" }]);
  });

  it("同 callId 重新启动：旧缓冲先发掉，不留指向被替换缓冲的定时器", () => {
    const task = tid("tf-restart");
    const onDelta = createShellOutputDeltaPublisher(task);
    onDelta(started("c1"));
    vi.advanceTimersByTime(100);
    onDelta(stdout("重启前\n"));
    expect(vi.getTimerCount()).toBe(1);
    onDelta(started("c1"));
    expect(publishedChunks("c1")).toEqual(["重启前\n"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("定时器 unref：进程退出不被它拖住", () => {
    const task = tid("tf-unref");
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const onDelta = createShellOutputDeltaPublisher(task);
      onDelta(started("c1"));
      vi.advanceTimersByTime(100);
      onDelta(stdout("x\n"));
      const timers = spy.mock.results.map((r) => r.value as { hasRef?: () => boolean });
      expect(timers).toHaveLength(1);
      // 假时钟的 Timeout 实现了 hasRef；unref 过 = false
      expect(typeof timers[0]!.hasRef).toBe("function");
      expect(timers[0]!.hasRef!()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("定时器回调里 flush 抛错（publish 炸了）不外溢成未捕获异常，只记日志", () => {
    const task = tid("tf-boom");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const onDelta = createShellOutputDeltaPublisher(task);
      onDelta(started("c1"));
      vi.advanceTimersByTime(100);
      onDelta(stdout("x\n"));
      hoisted.publishBoom = true;
      expect(() => vi.advanceTimersByTime(500)).not.toThrow();
      expect(warn.mock.calls.some((c) => String(c[0]).includes("trailing flush 失败"))).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------- 任务结束 tap

describe("任务结束 tap：属主主链的 done / task_deleted → 整任务丢弃（run 结束 / 任务删除的收尾）", () => {
  it("进程内只挂一份 tap（多个发布器 / 多次创建都幂等）", () => {
    createShellOutputDeltaPublisher(tid("tap-once-1"));
    createShellOutputDeltaPublisher(tid("tap-once-2"));
    createShellOutputDeltaPublisher(tid("tap-once-1"));
    expect(hoisted.taps).toHaveLength(1);
  });

  it("done（无 origin = 属主主链收尾，含 SDK 出错 / 中断、没等到 tool-call-completed）：整任务清；别的 task 不受影响", () => {
    const t1 = tid("tap-done1");
    const t2 = tid("tap-done2");
    // 注意 lease 恒真：模拟 observer 类 run——run 结束后 lease 仍判存活，只能靠 done 清
    const d1 = createShellOutputDeltaPublisher(t1, () => true);
    const d2 = createShellOutputDeltaPublisher(t2, () => true);
    d1(started("a"));
    d1(stdout(big("1a")));
    d1(started("b"));
    d1(stdout(big("1b")));
    d2(started("a"));
    d2(stdout(big("2a")));
    expect(getLiveShellOutputSnapshot(t1)).toHaveLength(2);

    emitStream(t1, { kind: "done" });
    expect(getLiveShellOutputSnapshot(t1)).toEqual([]);
    expect(getLiveShellOutputSnapshot(t2)).toHaveLength(1);
  });

  it("旁路群答疑 run 的 done（带 origin）不清：它不是属主主链的收尾，别误伤主链正在跑的 shell", () => {
    const task = tid("tap-origin");
    const onDelta = createShellOutputDeltaPublisher(task, () => true);
    onDelta(started("c1"));
    onDelta(stdout(big("A")));
    emitStream(task, { kind: "done", origin: "group-run-1" });
    expect(getLiveShellOutputSnapshot(task)).toHaveLength(1);
  });

  it("task_deleted：整任务清", () => {
    const task = tid("tap-deleted");
    const onDelta = createShellOutputDeltaPublisher(task, () => true);
    onDelta(started("c1"));
    onDelta(stdout(big("A")));
    emitStream(task, { kind: "task_deleted" });
    expect(getLiveShellOutputSnapshot(task)).toEqual([]);
  });

  it("其它流事件（task / assistant_delta / 落盘 event …）不动快照", () => {
    const task = tid("tap-other");
    const onDelta = createShellOutputDeltaPublisher(task, () => true);
    onDelta(started("c1"));
    onDelta(stdout(big("A")));
    for (const kind of ["task", "event", "assistant_delta", "thinking_delta", "action", "error"]) {
      emitStream(task, { kind });
    }
    expect(getLiveShellOutputSnapshot(task)).toHaveLength(1);
  });

  it("done 时还在等 trailing flush 的未发输出一并取消：done 之后迟到的定时器不会把它记回快照（幽灵）", () => {
    const task = tid("tap-done-pending");
    const onDelta = createShellOutputDeltaPublisher(task, () => true);
    onDelta(started("c1"));
    vi.advanceTimersByTime(100);
    onDelta(stdout("run 收尾前最后一点\n"));
    expect(vi.getTimerCount()).toBe(1);

    emitStream(task, { kind: "done" });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(publishedChunks("c1")).toEqual([]);
    expect(getLiveShellOutputSnapshot(task)).toEqual([]);
  });

  it("done 之后新一轮 run 的 shell 照常记账（只清旧的，不影响后来的）", () => {
    const task = tid("tap-next-run");
    const run1 = createShellOutputDeltaPublisher(task, () => true);
    run1(started("old"));
    run1(stdout(big("O")));
    emitStream(task, { kind: "done" });
    const run2 = createShellOutputDeltaPublisher(task, () => true);
    run2(started("new"));
    run2(stdout(big("N")));
    expect(getLiveShellOutputSnapshot(task).map((x) => x.callId)).toEqual(["new"]);
  });
});

// ---------------------------------------------------------------- 脱敏先于截断（R1-4）

describe("凭据被窗口边界切开：先脱敏、再截断（R1-4）", () => {
  /**
   * 脱敏是「当前凭据的精确值」替换（event-secret-redact），不是按前缀猜——
   * 所以这里把不同前缀形态的假凭据配成 FLOWSHIP_GITLAB_TOKEN（它的当前值会被脱敏），验证每种形态都被整段替换。
   */
  const FAKE_TOKENS = {
    "glpat-": "glpat-FAKEFAKE0123456789abcdefXYZ",
    "ghp_": "ghp_FAKEFAKE0123456789abcdefghijklmnop",
    "sk-": "sk-FAKEFAKE0123456789abcdefghijklmnopqrst",
  } as const;

  const withToken = <T,>(token: string, fn: () => T): T => {
    const prev = process.env.FLOWSHIP_GITLAB_TOKEN;
    process.env.FLOWSHIP_GITLAB_TOKEN = token;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_GITLAB_TOKEN;
      else process.env.FLOWSHIP_GITLAB_TOKEN = prev;
    }
  };

  /** 每块都「到期」：先让节流窗口过去再喂，保证一块一帧（不依赖 2KB 阈值，块大小可以随意） */
  const feed = (onDelta: ReturnType<typeof createShellOutputDeltaPublisher>, text: string): void => {
    vi.advanceTimersByTime(600);
    onDelta(stdout(text));
  };

  describe.each(Object.entries(FAKE_TOKENS))("%s 形态", (prefix, token) => {
    it(`对外窗口（${LIVE_OUTPUT_MAX_CHARS} 字符）的边界正好切在凭据中间：尾部那一截也不能漏出来`, () => {
      withToken(token, () => {
        const task = tid(`redact-cut-${prefix}`);
        const onDelta = createShellOutputDeltaPublisher(task);
        onDelta(started("c1"));
        const keepTail = 15; // 旧实现：窗口起点落在凭据倒数第 15 个字符上，留下 15 个字符的凭据尾巴
        const after = ".".repeat(LIVE_OUTPUT_MAX_CHARS - keepTail);
        feed(onDelta, `${"a".repeat(3000)} Authorization: Bearer ${token}`);
        feed(onDelta, after.slice(0, 3000));
        feed(onDelta, after.slice(3000, 6000));
        feed(onDelta, after.slice(6000));

        const [item] = getLiveShellOutputSnapshot(task);
        expect(item).toBeTruthy();
        const text = item!.text;
        expect(text.length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
        expect(text).not.toContain(token);
        // 凭据的任何一段尾巴（≥6 个字符）都不能出现；这里取 15 和 8 两个长度
        expect(text).not.toContain(token.slice(-keepTail));
        expect(text).not.toContain(token.slice(-8));
        // 窗口确实是被填满、切到的（不是因为内容太短才「没漏」）
        expect(text.endsWith("....")).toBe(true);
      });
    });
  });

  it("20 行窗口同样先脱敏再截（跨行的凭据整段在原文里就能认出来）", () => {
    withToken(FAKE_TOKENS["glpat-"], () => {
      const task = tid("redact-lines");
      const onDelta = createShellOutputDeltaPublisher(task);
      onDelta(started("c1"));
      const rows = Array.from({ length: 40 }, (_, i) => `row ${i}`);
      rows[10] = `token=${FAKE_TOKENS["glpat-"]}`; // 在窗口之外的行里
      rows[35] = `again ${FAKE_TOKENS["glpat-"]}`; // 在窗口之内的行里
      feed(onDelta, `${rows.join("\n")}\n`);
      const [item] = getLiveShellOutputSnapshot(task);
      expect(item!.text).not.toContain(FAKE_TOKENS["glpat-"]);
      expect(item!.text).toContain("again [REDACTED:gitToken]");
      expect(item!.text.split("\n")).toHaveLength(LIVE_OUTPUT_MAX_LINES);
    });
  });

  it(`原文窗口（${LIVE_SHELL_RAW_MAX_CHARS} 字符）起点切在凭据中间、而脱敏又把凭据缩成短占位符：起点那半截也不会重新漏进对外窗口`, () => {
    withToken(FAKE_TOKENS["sk-"], () => {
      const task = tid("redact-raw-head");
      const onDelta = createShellOutputDeltaPublisher(task);
      onDelta(started("c1"));
      // 一行里塞满「凭据 + 空格」（`yes $TOKEN` 之类）：原文窗口被切开时起点必在某个凭据中间；
      // 凭据全被缩成 19 字符的占位符后总长 < 8192，对外窗口会把整段（含起点）都包进来
      const stream = `${FAKE_TOKENS["sk-"]} `.repeat(1200);
      for (let i = 0; i < stream.length; i += 4000) feed(onDelta, stream.slice(i, i + 4000));

      const [item] = getLiveShellOutputSnapshot(task);
      const words = item!.text.trim().split(" ");
      expect(words.length).toBeGreaterThan(300);
      // 每个词都是完整的占位符：没有半截凭据，也没有凭据本身
      expect(new Set(words)).toEqual(new Set(["[REDACTED:gitToken]"]));
    });
  });

  it("超过窗口的大块发帧：先脱敏、再截尾——发出去的那一帧里，被这一刀切开的凭据也不留下半截", () => {
    withToken(FAKE_TOKENS["ghp_"], () => {
      const task = tid("redact-flush-cut");
      const onDelta = createShellOutputDeltaPublisher(task);
      onDelta(started("c1"));
      const token = FAKE_TOKENS["ghp_"];
      const keepTail = 15;
      // 一次性吐出的大块（> 8192）：flush 只发尾部 8192 字符，这一刀正好落在凭据倒数第 15 个字符上
      feed(
        onDelta,
        `${"a".repeat(5000)} ${token}${".".repeat(LIVE_OUTPUT_MAX_CHARS - keepTail)}`,
      );
      const [frame] = publishedChunks("c1");
      expect(frame).toBeTruthy();
      expect(frame!.length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
      expect(frame).not.toContain(token.slice(-keepTail));
      expect(frame).not.toContain(token.slice(-8));
      expect(frame!.endsWith("....")).toBe(true);
    });
  });

  it("没有凭据 / 没截断时发帧内容不变（不引入额外改写）：小块原样、大块仍是尾部窗口", () => {
    const task = tid("redact-passthrough");
    const onDelta = createShellOutputDeltaPublisher(task);
    onDelta(started("c1"));
    const small = "普通输出 line\n";
    feed(onDelta, small);
    const huge = `${"x".repeat(9000)}END`;
    feed(onDelta, huge);
    expect(publishedChunks("c1")).toEqual([small, huge.slice(-LIVE_OUTPUT_MAX_CHARS)]);
  });

  it("内存硬上限：每个 callId 的原文窗口 ≤ LIVE_SHELL_RAW_MAX_CHARS，所有任务合计有界（不因为保留更长原文而失控）", () => {
    const perTask = LIVE_SHELL_MAX_CALLS_PER_TASK;
    const taskCount = Math.ceil(LIVE_SHELL_MAX_CALLS_TOTAL / perTask) + 2;
    const tasks = Array.from({ length: taskCount }, (_, i) => tid(`raw-cap-${i}`));
    for (const task of tasks) {
      const onDelta = createShellOutputDeltaPublisher(task);
      for (let c = 0; c < perTask + 2; c += 1) {
        onDelta(started(`c${c}`));
        // 每个 callId 喂 ~60KB 无换行输出
        for (let i = 0; i < 8; i += 1) feed(onDelta, "z".repeat(7500));
      }
    }
    const store = (globalThis as unknown as Record<string, Map<string, { text: string }> | undefined>)
      .__flowshipLiveShellOutputs__;
    expect(store).toBeTruthy();
    let totalChars = 0;
    for (const e of store!.values()) {
      expect(e.text.length).toBeLessThanOrEqual(LIVE_SHELL_RAW_MAX_CHARS);
      totalChars += e.text.length;
    }
    expect(store!.size).toBeLessThanOrEqual(LIVE_SHELL_MAX_CALLS_TOTAL);
    expect(totalChars).toBeLessThanOrEqual(LIVE_SHELL_MAX_CALLS_TOTAL * LIVE_SHELL_RAW_MAX_CHARS);
    // 对外窗口不变：快照仍是 ≤8KB
    for (const task of tasks) {
      for (const item of getLiveShellOutputSnapshot(task)) {
        expect(item.text.length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
      }
    }
  });
});
