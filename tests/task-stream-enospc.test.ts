/**
 * 存储降级 · 服务端状态机（R14 B2-2 / Q9-01 = Q15-02）
 *
 * 被测：`src/lib/server/task-stream.ts`「存储降级」一节 + `task-fs-core.appendEventLine` 的 seq 语义。
 *   - writeEventAndPublish / writeOwnedEventAndPublish（best-effort，吞错返回 null）：
 *       磁盘类写盘失败 → 把没落盘的事件（脱敏副本、不带 seq）仍 publish 给订阅者 + 置「存储降级」标志；
 *   - writeUserEventAndPublishStrict（用户输入）：失败照旧抛，只置标志，不推这条用户事件、不发 toast；
 *   - 标志状态机：
 *       · `storage_degraded` 帧只在「首次 / 恢复后又失败 / 错误码变了」才发，持续同码失败不刷帧；
 *       · `error` toast 每任务 60s 至多一条，节流时钟跨「失败 → 恢复 → 又失败」保留（恢复只翻标志、不删记录）；
 *         toast 帧带 `advisory: true`（仅给人看的提示、不代表 run 失败——飞书私聊桥据此不去收尾回复卡片，F8）；
 *       · 恢复带 10s 粘滞：距最近一次失败 < 10s 的成功写不算恢复（红条保持、不发 sd:false）；
 *       · task_deleted 整条清掉；任务之间互不影响；
 *   - appendEventLine 写盘抛错**不回滚 seq**（烧号留空洞）：appendFile 抛错 ≠ 一个字节都没写，回滚会写出重复 seq。
 *
 * 做法：
 *   - 真写盘：hermetic-env（vitest setupFiles）已把 FLOWSHIP_DATA_DIR 指到本 worker 独有的临时目录；
 *   - 注入失败：只拦 `fs.promises.appendFile` 里「某任务的 events.jsonl」，其余路径（seq sidecar / meta / 别的任务）
 *     一律透传；放行时转发给 spyOn 之前保存下来的真实实现；
 *   - 重试退避：`__setAppendRetrySleepForTests` 注入，只记录毫秒数、不真等；
 *   - 时间：只 fake Date（`vi.useFakeTimers({ toFake: ["Date"] })`，不碰 setTimeout / fs），且在 createTask 之后才开；
 *     60s / 10s 两个常量没导出，靠 `vi.setSystemTime` 推进，边界值（9_999 / 10_000、59_999 / 60_000 ms）逐个钉；
 *   - 帧序列一律用 `brief` 压成一行字符串后整体 toEqual——精确到每一帧的先后与 seq，不写「包含」式的松断言；
 *     toast 帧缺 `advisory:true` 时 `brief` 会在那一行多出「(缺advisory)」，所以每条含 toast 的序列断言都顺带钉住它。
 *
 * 「把对应源码改坏会不会红」的预期都写在各用例的注释里（【变异】前缀），供变异验证对照。
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTask } from "@/lib/server/task-fs";
import {
  EVENTS_FILE,
  __setAppendRetrySleepForTests,
  taskDir,
} from "@/lib/server/task-fs-core";
import {
  __resetStorageDegradedForTests,
  getStorageDegraded,
  publish,
  storageWriteErrorCode,
  subscribeTaskStream,
  writeEventAndPublish,
  writeOwnedEventAndPublish,
  writeUserEventAndPublishStrict,
  type TaskStreamEvent,
} from "@/lib/server/task-stream";
import { describeStorageDegraded } from "@/lib/storage-degraded";
import type { EventKind, TaskEvent } from "@/lib/types";

// 防呆：写盘用例只许落在临时目录（hermetic-env 已把 FLOWSHIP_DATA_DIR 指到本 worker 独有的临时目录）
if (!path.resolve(taskDir("probe")).startsWith(path.resolve(os.tmpdir()))) {
  throw new Error(`数据目录没有隔离到临时目录：${taskDir("probe")}`);
}

// ───────────────────────────── 夹具 ─────────────────────────────

/** 假时钟的起点（远大于 60_000，保证「lastNoticeAt = 0 → 视为从没发过 toast」的分支成立） */
const T0 = Date.UTC(2030, 0, 1);

/** spyOn 之前先保存真实实现：放行的写盘调用转发给它 */
const realAppendFile = fsp.appendFile.bind(fsp) as unknown as (
  ...args: unknown[]
) => Promise<void>;

const lease = (): boolean => true;

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated`), { code });

const title = (code: string): string => describeStorageDegraded(code).title;

/** 每个用例结束后统一取消的订阅 */
const offs: Array<() => void> = [];

/** 把一帧压成一行字符串，断言序列时一眼看出「先后 + seq + 有没有带 origin」 */
const brief = (f: TaskStreamEvent): string => {
  switch (f.kind) {
    case "event":
      return `event:${f.event.text}${
        f.event.seq === undefined ? "(无seq)" : `#${f.event.seq}`
      }${f.origin ? `@${f.origin}` : ""}`;
    case "storage_degraded":
      return `sd:${f.degraded}${f.code ? `/${f.code}` : ""}`;
    case "error":
      // 本文件里的 error 帧只可能是存储降级 toast，而它必须是「仅提示」帧（advisory:true，不代表 run 失败）：
      // 少了这个标记，飞书私聊桥会把它当「本轮 run 失败」去收尾进行中的回复卡片（F8）。
      // 把「缺 advisory」直接写进这一行——每条含 toast 的精确帧序列断言都顺带钉住它，缺了就对不上。
      return `error:${f.message}${f.advisory === true ? "" : "(缺advisory)"}`;
    default:
      return f.kind;
  }
};

interface Watcher {
  /** 订阅以来收到的全部帧（原始对象） */
  frames: TaskStreamEvent[];
  /** 自上次调用以来新收到的帧（压成 brief 字符串）；调用后游标前移 */
  next: () => string[];
}

const watch = (taskId: string): Watcher => {
  const frames: TaskStreamEvent[] = [];
  let cursor = 0;
  offs.push(
    subscribeTaskStream(taskId, (f) => {
      frames.push(f);
    }),
  );
  return {
    frames,
    next: () => {
      const fresh = frames.slice(cursor);
      cursor = frames.length;
      return fresh.map(brief);
    },
  };
};

type EventFrame = Extract<TaskStreamEvent, { kind: "event" }>;
const eventFramesOf = (w: Watcher): EventFrame[] =>
  w.frames.filter((f): f is EventFrame => f.kind === "event");

const newTask = async (name: string): Promise<string> =>
  (await createTask({ title: name, mode: "chat" } as never)).id;

/** 冻结假时钟到 T0（只 fake Date）。必须在 createTask 之后调用。 */
const freezeClock = (): void => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
};
const clockAt = (offsetMs: number): void => {
  vi.setSystemTime(T0 + offsetMs);
};

const muteWarn = () =>
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
type WarnSpy = ReturnType<typeof muteWarn>;

/** 取出「某个写入口吞错时打的那条 console.warn」（只认本任务，不被后台写盘的别的 warn 干扰） */
const writeFailWarns = (
  warn: WarnSpy,
  writer: string,
  taskId: string,
): unknown[][] =>
  warn.mock.calls.filter(
    ([msg]) =>
      typeof msg === "string" && msg.includes(`${writer} 失败 task=${taskId}`),
  );

const recordRetrySleeps = (): number[] => {
  const sleeps: number[] = [];
  __setAppendRetrySleepForTests(async (ms) => {
    sleeps.push(ms);
  });
  return sleeps;
};

/** 第 n 次（从 1 起）落到某任务 events.jsonl 的 appendFile 怎么处理；real() = 转发真实写盘 */
type AppendHandler = (
  call: number,
  real: () => Promise<void>,
) => Promise<void>;

interface DiskFault {
  /** 重试退避的等待毫秒数记录（注入的 sleep 只记不等） */
  sleeps: number[];
  /** 某任务 events.jsonl 的 appendFile 被调用的总次数（含重试） */
  calls: (taskId: string) => number;
  on: (taskId: string, handler: AppendHandler) => void;
  /** 之后该任务的 events.jsonl 追加一律抛 err */
  fail: (taskId: string, err: Error) => void;
  /** 之后该任务的 events.jsonl 追加放行（真写盘） */
  heal: (taskId: string) => void;
}

const taskIdOfEventsFile = (file: unknown): string | null =>
  typeof file === "string" && path.basename(file) === EVENTS_FILE
    ? path.basename(path.dirname(file))
    : null;

/**
 * 磁盘故障注入器：只拦「某任务的 events.jsonl」的 appendFile，其余一律透传
 * （seq sidecar / meta 走 writeFile + rename，别的任务、后台写盘都不受影响）；同时装上重试退避记录器。
 */
const installDiskFault = (): DiskFault => {
  const handlers = new Map<string, AppendHandler>();
  const counts = new Map<string, number>();
  const sleeps = recordRetrySleeps();
  vi.spyOn(fsp, "appendFile").mockImplementation(((...args: unknown[]) => {
    const real = (): Promise<void> => realAppendFile(...args);
    const id = taskIdOfEventsFile(args[0]);
    if (id === null) return real();
    const n = (counts.get(id) ?? 0) + 1;
    counts.set(id, n);
    const handler = handlers.get(id);
    return handler ? handler(n, real) : real();
  }) as never);
  return {
    sleeps,
    calls: (taskId) => counts.get(taskId) ?? 0,
    on: (taskId, handler) => {
      handlers.set(taskId, handler);
    },
    fail: (taskId, err) => {
      handlers.set(taskId, () => Promise.reject(err));
    },
    heal: (taskId) => {
      handlers.delete(taskId);
    },
  };
};

// 三个写入口（失败语义不同：前两个吞错返 null，Strict 抛错）
const owned = (
  id: string,
  text: string,
  kind: EventKind = "info",
  origin?: string,
): Promise<TaskEvent | null> =>
  writeOwnedEventAndPublish(id, lease, { kind, text }, origin);

const WRITERS = {
  writeEventAndPublish: (id: string, text: string) =>
    writeEventAndPublish(id, { kind: "info", text }),
  writeOwnedEventAndPublish: (id: string, text: string) =>
    writeOwnedEventAndPublish(id, lease, { kind: "info", text }),
  writeUserEventAndPublishStrict: (id: string, text: string) =>
    writeUserEventAndPublishStrict(id, { kind: "user_reply", text }, lease),
} as const;
type WriterName = keyof typeof WRITERS;
const WRITER_NAMES = Object.keys(WRITERS) as WriterName[];

interface DiskEvent {
  id: string;
  seq?: number;
  kind: string;
  text: string;
}

const eventsFile = (taskId: string): string =>
  path.join(taskDir(taskId), EVENTS_FILE);

/** 读盘上 events.jsonl 的全部行（文件不存在 = 没写过任何事件 = []） */
const readDisk = async (taskId: string): Promise<DiskEvent[]> => {
  let raw: string;
  try {
    raw = await fsp.readFile(eventsFile(taskId), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DiskEvent);
};

/**
 * 单任务场景：建任务 → 订阅 → 静音 warn → 冻结假时钟 → 装故障注入器。
 * fail / ok 先把假时钟推到「T0 + offsetMs」再写：fail 写一条会失败的 assistant_message，ok 写一条放行的 info。
 */
interface Scene {
  id: string;
  w: Watcher;
  fault: DiskFault;
  warn: WarnSpy;
  fail: (
    offsetMs: number,
    text: string,
    code?: string,
  ) => Promise<TaskEvent | null>;
  ok: (offsetMs: number, text: string) => Promise<TaskEvent | null>;
}

const scene = async (name: string): Promise<Scene> => {
  const id = await newTask(name);
  const w = watch(id);
  const warn = muteWarn();
  freezeClock();
  const fault = installDiskFault();
  return {
    id,
    w,
    fault,
    warn,
    fail: (offsetMs, text, code = "ENOSPC") => {
      clockAt(offsetMs);
      fault.fail(id, errno(code));
      return owned(id, text, "assistant_message");
    },
    ok: (offsetMs, text) => {
      clockAt(offsetMs);
      fault.heal(id);
      return owned(id, text, "info");
    },
  };
};

afterEach(() => {
  while (offs.length > 0) offs.pop()?.();
  vi.restoreAllMocks();
  __resetStorageDegradedForTests();
  __setAppendRetrySleepForTests();
  vi.useRealTimers();
  // 本文件不改 process.platform（平台相关的重试真值表在 append-event-retry.test.ts），无需还原
});

// ───────────────────────────── 用例 ─────────────────────────────

describe("存储降级 · 事件写盘失败：没落盘的事件仍推给在线订阅者", () => {
  // 守的是：Q15-02 原缺陷——磁盘写满时 writeEventAndPublish 吞错返回 null，而 publish 挂在「写成功」之后，
  // 这条输出既没落盘、界面上也看不到，agent 却照常往下跑。现在要 ① 仍推 ② 置标志 ③ 弹一条 toast。
  // 对应源码：task-stream.ts handleEventPersistFailed → markStorageDegraded；task-fs-core.appendEventLine 的 delete ev.seq。
  // 【变异】不再 publish 事件 / 不摘 seq / 不发 sd:true / 不发 toast / 返回值不再是 null → 红；
  //   toast 帧不再带 advisory:true（飞书桥会把它当 run 失败）→ 红（序列里多出「(缺advisory)」，且原始帧形状对不上）。
  it("磁盘满（ENOSPC）：writeEventAndPublish 返回 null，没落盘的事件仍推（无 seq、text 不变）+ sd:true + 恰一条 toast（Q15-02 转正）", async () => {
    const s = await scene("enospc");
    const err = errno("ENOSPC");
    s.fault.fail(s.id, err);
    expect(getStorageDegraded(s.id)).toBeNull();

    clockAt(0);
    const r = await writeEventAndPublish(s.id, {
      kind: "assistant_message",
      text: "模型的一整段回复",
    });

    expect(r).toBeNull();
    // 精确帧序列：先推事件，再发状态帧，最后一条 toast（恰 1 条）
    expect(s.w.next()).toEqual([
      "event:模型的一整段回复(无seq)",
      "sd:true/ENOSPC",
      `error:${title("ENOSPC")}`,
    ]);
    // toast 帧的完整原始形状：恰一条，仅提示（advisory:true）——不代表 run 失败，飞书私聊桥据此不收尾回复卡片
    expect(s.w.frames.filter((f) => f.kind === "error")).toStrictEqual([
      { kind: "error", message: title("ENOSPC"), advisory: true },
    ]);
    // toast 文案 = describeStorageDegraded(code).title，且非空、不带 errno 码
    expect(title("ENOSPC")).not.toBe("");
    expect(title("ENOSPC")).not.toContain("ENOSPC");

    const [pushed] = eventFramesOf(s.w);
    expect(pushed?.event.kind).toBe("assistant_message");
    expect(pushed?.event.text).toBe("模型的一整段回复");
    expect(typeof pushed?.event.id).toBe("string");
    // seq 是被「摘掉」的（属性都不存在），不是置成 undefined
    expect(Object.keys(pushed?.event ?? {})).not.toContain("seq");
    // best-effort 入口不带 origin
    expect(pushed?.origin).toBeUndefined();

    expect(getStorageDegraded(s.id)).toStrictEqual({ code: "ENOSPC" });
    // 前提自检：这条确实没落盘；ENOSPC 不重试（只调了 1 次 appendFile、没有退避等待）
    expect(await readDisk(s.id)).toEqual([]);
    expect(s.fault.calls(s.id)).toBe(1);
    expect(s.fault.sleeps).toEqual([]);
    // 错误码只进服务端日志：writeEventAndPublish 的 catch 仍打了一条 warn，带着原始错误
    const logged = writeFailWarns(s.warn, "writeEventAndPublish", s.id);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.[1]).toBe(err);
  });

  // 守的是：owned 入口（带 lease + origin）与 best-effort 入口同样接线，origin 透传到「没落盘的事件帧」和成功帧；
  // 以及 seq 语义——失败那次烧号留空洞（盘上 seq 1、3，没有 2），不回滚。
  // 对应源码：writeOwnedEventAndPublish 的 handleEventPersistFailed(…, origin) / publishCommittedEvent(…, origin)；
  //   appendEventLine 的「不回滚 seq」。
  // 【变异】失败帧丢 origin / 成功帧丢 origin → 红；回滚 seq（r2 拿到 2）→ 红；失败不摘 seq（帧里带 #2）→ 红。
  it("探针 A：owned 入口的 origin 透传到失败帧与成功帧；seq 留空洞——成功 1 → 失败烧掉 2 → 过粘滞窗口后的成功写拿 3", async () => {
    const s = await scene("probe-a");

    clockAt(0);
    const r0 = await owned(s.id, "正常1");
    expect(r0?.seq).toBe(1);
    expect(s.w.next()).toEqual(["event:正常1#1"]);
    expect(getStorageDegraded(s.id)).toBeNull();

    s.fault.fail(s.id, errno("ENOSPC"));
    const r1 = await owned(s.id, "整段回复", "assistant_message", "grp-A");
    expect(r1).toBeNull();
    expect(s.w.next()).toEqual([
      "event:整段回复(无seq)@grp-A",
      "sd:true/ENOSPC",
      `error:${title("ENOSPC")}`,
    ]);
    expect(getStorageDegraded(s.id)).toStrictEqual({ code: "ENOSPC" });

    // 过了粘滞窗口（距失败恰 10s）的成功写：拿 3（2 被失败那次烧掉），并确认恢复
    s.fault.heal(s.id);
    clockAt(10_000);
    const r2 = await owned(s.id, "恢复后", "info", "grp-A");
    expect(r2?.seq).toBe(3);
    expect(s.w.next()).toEqual(["event:恢复后#3@grp-A", "sd:false"]);
    expect(getStorageDegraded(s.id)).toBeNull();

    // 盘上：seq 1、3——烧掉的 2 是空洞，失败的那条没有落盘
    expect((await readDisk(s.id)).map((e) => [e.seq, e.text])).toEqual([
      [1, "正常1"],
      [3, "恢复后"],
    ]);
  });

  // 守的是：STORAGE_WRITE_ERROR_CODES 里每个码都算磁盘类（逐个钉，防「删掉某个码」/「只认 ENOSPC」）；
  // toast 文案按 describeStorageDegraded(code).title（ENOSPC/EDQUOT 磁盘空间、EROFS 只读、其余写入失败）。
  // EBUSY 走完重试用尽后才到这里；EPERM / EACCES 在 win32 上也会先重试，但注入的 sleep 不真等、结果一致。
  // 【变异】从集合里删掉任一个码 → 对应那条红。
  it.each(["ENOSPC", "EDQUOT", "EROFS", "EIO", "EACCES", "EPERM", "EBUSY"])(
    "磁盘类错误码 %s 算存储降级：事件照推、sd:true 带上该码、toast 用该码对应的标题",
    async (code) => {
      const s = await scene(`code-${code}`);
      s.fault.fail(s.id, errno(code));

      clockAt(0);
      const r = await owned(s.id, "x", "assistant_message");

      expect(r).toBeNull();
      expect(s.w.next()).toEqual([
        "event:x(无seq)",
        `sd:true/${code}`,
        `error:${title(code)}`,
      ]);
      expect(getStorageDegraded(s.id)).toStrictEqual({ code });
    },
  );

  // 守的是：EBUSY 是瞬时错误，先退避重试（3 次：50 / 100 / 200ms，共 4 次 appendFile），用尽才算失败、才降级——
  // 重试用尽后降级的整条链路（task-fs-core 重试 → onPersistFailed → task-stream 状态机）在这里接通。
  // 对应源码：appendEventLineUnlocked 的 APPEND_RETRY_DELAYS_MS + isTransientAppendError(EBUSY)；handleEventPersistFailed。
  // 【变异】改重试次数 / 退避时长 → calls / sleeps 对不上；EBUSY 不重试 → calls=1 红。
  it("EBUSY：退避重试 3 次（50/100/200ms、共 4 次 appendFile）用尽才算失败；用尽后同样降级", async () => {
    const s = await scene("ebusy");
    s.fault.fail(s.id, errno("EBUSY"));

    clockAt(0);
    const r = await owned(s.id, "被占用", "assistant_message");

    expect(r).toBeNull();
    expect(s.fault.calls(s.id)).toBe(4);
    expect(s.fault.sleeps).toEqual([50, 100, 200]);
    expect(s.w.next()).toEqual([
      "event:被占用(无seq)",
      "sd:true/EBUSY",
      `error:${title("EBUSY")}`,
    ]);
    expect(getStorageDegraded(s.id)).toStrictEqual({ code: "EBUSY" });
    expect(await readDisk(s.id)).toEqual([]);
  });

  // 守的是：ENOENT = 任务目录已被删（确定没写）——不是存储问题：不推幽灵事件、不置标志、不 warn，并把刚发的号退回。
  // 对应源码：appendEventLine 的 `!ok` 分支（回滚 seq、不调 onPersistFailed）。
  // 【变异】ENOENT 也调 onPersistFailed / 也置标志 → 出现帧，红；ENOENT 不回滚 seq → 下一条拿 2，红。
  it("ENOENT（任务目录已被删）不算存储降级：返回 null、不推任何帧、不置标志、不 warn，烧的号退回", async () => {
    const s = await scene("enoent");
    s.fault.fail(s.id, errno("ENOENT"));

    clockAt(0);
    const r = await owned(s.id, "迟到的事件", "assistant_message");

    expect(r).toBeNull();
    expect(s.w.frames).toEqual([]);
    expect(getStorageDegraded(s.id)).toBeNull();
    expect(writeFailWarns(s.warn, "writeOwnedEventAndPublish", s.id)).toEqual(
      [],
    );
    // ENOENT 路径回滚了 seq：放行后的第一条事件仍是 #1（不是 #2）
    s.fault.heal(s.id);
    const r2 = await owned(s.id, "之后正常");
    expect(r2?.seq).toBe(1);
    expect(s.w.next()).toEqual(["event:之后正常#1"]);
  });
});

describe("存储降级 · 非磁盘类写盘错误：保持旧行为（warn、不推、不置标志）", () => {
  // 守的是：只认「磁盘类」errno；EINVAL（有 code、但不在集合里；目录还在 → 也不是「任务已删」）和
  // 无 code 的普通 Error 保持旧行为：调用方 console.warn、返回 null、订阅者什么都收不到、标志不置。
  // 对应源码：storageWriteErrorCode（集合外 → null）+ handleEventPersistFailed 的 `if (!code) return`。
  // 【变异】「任何错误都算降级」/「任何字符串 code 都算」→ 出现帧或标志，红。
  const NON_DISK_ERRORS: Array<[label: string, make: () => Error]> = [
    ["EINVAL（有 errno 码、但不是磁盘类）", () => errno("EINVAL")],
    ["无 code 的普通 Error", () => new Error("boom")],
  ];

  for (const writer of [
    "writeEventAndPublish",
    "writeOwnedEventAndPublish",
  ] as const) {
    it.each(NON_DISK_ERRORS)(
      `${writer} · %s：返回 null、订阅者收不到任何帧、不置标志、console.warn 打一条（旧行为）`,
      async (_label, make) => {
        const s = await scene("non-disk");
        const err = make();
        s.fault.fail(s.id, err);

        clockAt(0);
        const r = await WRITERS[writer](s.id, "不该被推送的事件");

        expect(r).toBeNull();
        expect(s.w.frames).toEqual([]);
        expect(getStorageDegraded(s.id)).toBeNull();
        const logged = writeFailWarns(s.warn, writer, s.id);
        expect(logged).toHaveLength(1);
        expect(logged[0]?.[1]).toBe(err);
        // 非瞬时错误：不重试
        expect(s.fault.calls(s.id)).toBe(1);
        expect(s.fault.sleeps).toEqual([]);
      },
    );
  }

  it.each(NON_DISK_ERRORS)(
    "writeUserEventAndPublishStrict · %s：照旧抛原错误、订阅者收不到任何帧、不置标志",
    async (_label, make) => {
      const s = await scene("non-disk-strict");
      const err = make();
      s.fault.fail(s.id, err);

      clockAt(0);
      await expect(
        WRITERS.writeUserEventAndPublishStrict(s.id, "用户输入"),
      ).rejects.toBe(err);

      expect(s.w.frames).toEqual([]);
      expect(getStorageDegraded(s.id)).toBeNull();
    },
  );
});

describe("存储降级 · 恢复与粘滞", () => {
  // 守的是：没降级的任务，成功写只推事件帧——没有任何降级帧（热路径「无事发生」）。
  // 对应源码：clearStorageDegradedOnCommit 的 `!state` 早退。
  // 【变异】每次成功写都发 sd:false → 红。
  it("健康任务的成功写：只推事件帧、没有任何降级帧，标志保持 null", async () => {
    const s = await scene("healthy");

    await s.ok(0, "h1");
    await s.ok(30_000, "h2");

    expect(s.w.next()).toEqual(["event:h1#1", "event:h2#2"]);
    expect(getStorageDegraded(s.id)).toBeNull();
    // 夹具自检：放行 = 真写盘、每条恰一次 appendFile
    expect(s.fault.calls(s.id)).toBe(2);
    expect((await readDisk(s.id)).map((e) => [e.seq, e.text])).toEqual([
      [1, "h1"],
      [2, "h2"],
    ]);
  });

  // 守的是：恢复带 10s 粘滞——距最近一次失败 < 10s 的成功写不算恢复（红条保持、不发 sd:false），
  // 满 10s 的成功写才算恢复；恢复后不再重复发 sd:false。边界 9_999 / 10_000ms 都钉。
  // 对应源码：clearStorageDegradedOnCommit（STORAGE_RECOVER_STICKY_MS = 10_000，比较是严格小于）。
  // 【变异】去掉粘滞 → ok1 就发 sd:false，红；窗口改 5s / 20s → ok2 / ok3 红；`<` 改 `<=` → ok3 红；
  //   恢复不翻 degraded（只发帧）→ getStorageDegraded 仍非 null、ok4 重复发 sd:false，红；
  //   成功写顺延粘滞起点（lastFailAt = now）→ ok3 不恢复，红。
  it("恢复带 10s 粘滞：失败后立刻成功写不算恢复；距最近一次失败满 10s 的成功写才发 sd:false（边界 9_999 / 10_000ms）", async () => {
    const s = await scene("sticky");

    await s.fail(0, "f1");
    expect(s.w.next()).toEqual([
      "event:f1(无seq)",
      "sd:true/ENOSPC",
      `error:${title("ENOSPC")}`,
    ]);

    // 同一时刻的成功写：不算恢复，红条保持
    await s.ok(0, "ok1");
    expect(s.w.next()).toEqual(["event:ok1#2"]);
    expect(getStorageDegraded(s.id)).toStrictEqual({ code: "ENOSPC" });

    // 9_999ms：仍在粘滞窗口内
    await s.ok(9_999, "ok2");
    expect(s.w.next()).toEqual(["event:ok2#3"]);
    expect(getStorageDegraded(s.id)).toStrictEqual({ code: "ENOSPC" });

    // 恰 10_000ms：恢复（事件帧先、sd:false 后）
    await s.ok(10_000, "ok3");
    expect(s.w.next()).toEqual(["event:ok3#4", "sd:false"]);
    expect(getStorageDegraded(s.id)).toBeNull();

    // 恢复之后的成功写：不再重复发 sd:false
    await s.ok(10_001, "ok4");
    expect(s.w.next()).toEqual(["event:ok4#5"]);
    expect(getStorageDegraded(s.id)).toBeNull();
  });

  // 守的是：粘滞窗口从「最近一次失败」起算——持续失败会不断顺延恢复时间（lastFailAt 每次失败都刷新）。
  // 对应源码：markStorageDegraded 里 `lastFailAt: now`（每次失败都写）。
  // 【变异】lastFailAt 只在首次失败时记（持续失败不刷新）→ f2 之后 12s 的成功写就被当成恢复，红。
  it("粘滞窗口从「最近一次失败」起算：持续失败不断顺延恢复时间", async () => {
    const s = await scene("sticky-from-last-fail");

    await s.fail(0, "f1");
    s.w.next();
    // 8s 后同码再失败：不重发 sd:true，但粘滞起点顺延到 8s
    await s.fail(8_000, "f2");
    expect(s.w.next()).toEqual(["event:f2(无seq)"]);

    // 12s：距首次失败已 12s，但距最近一次失败才 4s → 仍不算恢复
    await s.ok(12_000, "ok1");
    expect(s.w.next()).toEqual(["event:ok1#3"]);
    expect(getStorageDegraded(s.id)).toStrictEqual({ code: "ENOSPC" });

    // 17_999：距最近失败 9_999 → 仍不算
    await s.ok(17_999, "ok2");
    expect(s.w.next()).toEqual(["event:ok2#4"]);

    // 18_000：距最近失败满 10_000 → 恢复
    await s.ok(18_000, "ok3");
    expect(s.w.next()).toEqual(["event:ok3#5", "sd:false"]);
    expect(getStorageDegraded(s.id)).toBeNull();
  });

  // 守的是：每个写入口的成功写都挂了「确认恢复」（onCommitted = publishCommittedEvent），不只是其中一个。
  // 对应源码：writeEventAndPublish / writeOwnedEventAndPublish / writeUserEventAndPublishStrict 的 onCommitted。
  // 【变异】任一入口的 onCommitted 退回裸 publish → 对应那条红。
  it.each(WRITER_NAMES)(
    "%s 的成功写会确认恢复：过了粘滞窗口后推事件帧再发 sd:false",
    async (writer) => {
      const s = await scene(`recover-via-${writer}`);
      await s.fail(0, "f1");
      s.w.next();
      expect(getStorageDegraded(s.id)).toStrictEqual({ code: "ENOSPC" });

      s.fault.heal(s.id);
      clockAt(10_000);
      const r = await WRITERS[writer](s.id, "恢复写");

      expect(r?.seq).toBe(2);
      expect(s.w.next()).toEqual(["event:恢复写#2", "sd:false"]);
      expect(getStorageDegraded(s.id)).toBeNull();
    },
  );
});

describe("存储降级 · 状态帧去重与 toast 节流", () => {
  // 守的是：F1 验收——磁盘临界、成败交替时，不刷帧、不刷屏：toast 恰 1 条、sd:true 恰 1 帧、sd:false 0 帧；
  // 同时钉死 seq：每次失败烧一个号，成功写的 seq 是 2、4、…、20（不回滚）。
  // 对应源码：markStorageDegraded 的 notice 节流 + `!prev?.degraded || prev.code !== code` 去重；clearStorageDegradedOnCommit 粘滞。
  // 【变异】去掉粘滞 → 出现 sd:false；每次失败都发 sd:true / toast → 计数对不上；回滚 seq → 成功写变 1、2、…、10，红。
  it("探针 B（F1 验收）：奇数次失败、偶数次成功的 20 次写（时间不推进）→ toast 恰 1 条、sd:true 恰 1 帧、sd:false 0 帧", async () => {
    const s = await scene("probe-b");
    // 第 n 次 appendFile：奇数抛 ENOSPC、偶数放行（磁盘类错误不重试 → 每次写恰好一次 appendFile）
    s.fault.on(s.id, (n, real) =>
      n % 2 === 1 ? Promise.reject(errno("ENOSPC")) : real(),
    );

    clockAt(0);
    for (let k = 1; k <= 20; k++) {
      await owned(s.id, `m${k}`, "assistant_message");
    }

    expect(s.fault.calls(s.id)).toBe(20);
    // 整体精确帧序列：失败的没有 seq（第 1 次附带 sd:true + toast）；成功写的 seq = 写入序号（失败那次烧号）
    const expected: string[] = [];
    for (let k = 1; k <= 20; k++) {
      if (k % 2 === 1) {
        expected.push(`event:m${k}(无seq)`);
        if (k === 1) expected.push("sd:true/ENOSPC", `error:${title("ENOSPC")}`);
      } else {
        expected.push(`event:m${k}#${k}`);
      }
    }
    const got = s.w.frames.map(brief);
    expect(got).toEqual(expected);
    // 验收口径单独再点名一遍
    expect(got.filter((f) => f.startsWith("error:"))).toHaveLength(1);
    expect(got.filter((f) => f === "sd:true/ENOSPC")).toHaveLength(1);
    expect(got.filter((f) => f === "sd:false")).toHaveLength(0);
    // 最后一次写（偶数、成功）仍在粘滞窗口内 → 仍在降级
    expect(getStorageDegraded(s.id)).toStrictEqual({ code: "ENOSPC" });
    // 盘上只有 10 条成功的，seq 为 2、4、…、20
    expect((await readDisk(s.id)).map((e) => e.seq)).toEqual(
      Array.from({ length: 10 }, (_, i) => (i + 1) * 2),
    );
  });

  // 守的是：F1 核心——toast 节流时钟跨「失败 → 恢复 → 又失败」保留（恢复只翻标志、不删记录）。
  // 恢复后又失败：重新发 sd:true（红条要重新亮），但距上条 toast 不足 60s 不再弹；满 60s 才弹第 2 条。
  // 边界 59_999 / 60_000ms 都钉；toast 间隔从「上次发 toast」起算（不是从最近一次失败）。
  // 对应源码：markStorageDegraded 的 `now - prev.lastNoticeAt >= STORAGE_NOTICE_INTERVAL_MS`、`lastNoticeAt: notice ? now : prev?.lastNoticeAt`。
  // 【变异】恢复时删记录 / 清零 lastNoticeAt → f2 又弹 toast，红；
  //   每次失败都刷新 lastNoticeAt → f3 不弹，红；节流改用 lastFailAt → f3 不弹，红；
  //   间隔改 30s → f2 弹，红；改 120s → f3 不弹，红；`>=` 改 `>` → f3（恰 60_000）不弹，红；
  //   恢复后又失败不重发 sd:true（只在无记录时发）→ f2 红。
  it("节流时钟跨恢复（F1 核心）：失败→恢复→又失败重发 sd:true 但 60s 内不再弹 toast；距上条 toast 满 60s 才弹第 2 条（边界 59_999 / 60_000ms）", async () => {
    const s = await scene("throttle-across-recovery");

    await s.fail(0, "f1"); // toast#1 @T0
    expect(s.w.next()).toEqual([
      "event:f1(无seq)",
      "sd:true/ENOSPC",
      `error:${title("ENOSPC")}`,
    ]);

    await s.ok(10_000, "ok1"); // 距失败 10s → 恢复
    expect(s.w.next()).toEqual(["event:ok1#2", "sd:false"]);

    await s.fail(30_000, "f2"); // 恢复后又失败：重发 sd:true；距 toast#1 才 30s → 不弹
    expect(s.w.next()).toEqual(["event:f2(无seq)", "sd:true/ENOSPC"]);

    await s.ok(40_000, "ok2");
    expect(s.w.next()).toEqual(["event:ok2#4", "sd:false"]);

    await s.fail(60_000, "f3"); // 距 toast#1 恰 60_000ms → 第 2 条 toast（toast#2 @T0+60s）
    expect(s.w.next()).toEqual([
      "event:f3(无seq)",
      "sd:true/ENOSPC",
      `error:${title("ENOSPC")}`,
    ]);

    await s.ok(70_000, "ok3");
    expect(s.w.next()).toEqual(["event:ok3#6", "sd:false"]);

    await s.fail(119_999, "f4"); // 距 toast#2 仅 59_999ms → 不弹
    expect(s.w.next()).toEqual(["event:f4(无seq)", "sd:true/ENOSPC"]);
  });

  // 守的是：错误码变化（磁盘满 → 只读 → IO 错误……）要让界面换文案：重发 sd:true（带新码），getStorageDegraded 的 code 跟着变；
  // 60s 内不因此再弹 toast；同码持续失败不重复发 sd:true；满 60s 的 toast 用「当前码」的标题。
  // 对应源码：markStorageDegraded 的 `prev.code !== code` 与 describeStorageDegraded(code)。
  // 【变异】只在首次发 sd:true（码变了不重发）→ f3 红；码变了也弹 toast → f3 红；同码也重发 → f2 / f4 红；
  //   toast 文案写死成首次的码 → f7 红；getStorageDegraded 不更新 code → 红。
  it("错误码变化：ENOSPC → EROFS 重发 sd:true（60s 内不弹 toast）、同码持续失败不重发；60s 后的 toast 用当前码的标题", async () => {
    const s = await scene("code-change");
    // 前提：两档文案不同，否则「toast 用的是哪个码」断言不出任何东西
    expect(title("EROFS")).not.toBe(title("ENOSPC"));

    await s.fail(0, "f1", "ENOSPC");
    expect(s.w.next()).toEqual([
      "event:f1(无seq)",
      "sd:true/ENOSPC",
      `error:${title("ENOSPC")}`,
    ]);

    await s.fail(1_000, "f2", "ENOSPC"); // 同码持续失败：只推事件
    expect(s.w.next()).toEqual(["event:f2(无seq)"]);

    await s.fail(2_000, "f3", "EROFS"); // 码变了：重发 sd:true；60s 内不弹 toast
    expect(s.w.next()).toEqual(["event:f3(无seq)", "sd:true/EROFS"]);
    expect(getStorageDegraded(s.id)).toStrictEqual({ code: "EROFS" });

    await s.fail(3_000, "f4", "EROFS"); // 同码
    expect(s.w.next()).toEqual(["event:f4(无seq)"]);

    await s.fail(4_000, "f5", "EIO"); // 再变
    expect(s.w.next()).toEqual(["event:f5(无seq)", "sd:true/EIO"]);
    expect(getStorageDegraded(s.id)).toStrictEqual({ code: "EIO" });

    await s.fail(5_000, "f6", "EROFS"); // 变回来也算变化
    expect(s.w.next()).toEqual(["event:f6(无seq)", "sd:true/EROFS"]);

    // 距 toast#1 满 60s：同码（不发 sd）、弹第 2 条 toast，文案是「当前码 EROFS」的标题
    await s.fail(60_000, "f7", "EROFS");
    expect(s.w.next()).toEqual([
      "event:f7(无seq)",
      `error:${title("EROFS")}`,
    ]);
    expect(getStorageDegraded(s.id)).toStrictEqual({ code: "EROFS" });
  });
});

describe("存储降级 · 用户输入（writeUserEventAndPublishStrict）", () => {
  // 守的是：用户输入落盘失败——错误照旧抛给调用方（route 给 5xx / persistWarning，语义不变）；
  // 这里只置标志（红条）：不推这条没落盘的用户消息（send 前失败要让用户重试，推了反而重复）、不发 toast（route 已在告诉用户）。
  // 对应源码：writeUserEventAndPublishStrict 的 onPersistFailed（markStorageDegraded(…, { notice: false })）。
  // 【变异】Strict 也推用户事件 / 也发 toast（notice:true）/ 吞错 → 红；不置标志 → 红；抛的不是原错误 → 红。
  it("探针 I（Strict）：ENOSPC 时 reject 原错误；订阅者只收到 sd:true/ENOSPC（无用户事件帧、无 toast），标志已置", async () => {
    const s = await scene("probe-i");
    const err = errno("ENOSPC");
    s.fault.fail(s.id, err);

    clockAt(0);
    const rejected = await WRITERS.writeUserEventAndPublishStrict(
      s.id,
      "用户说的话",
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(rejected).toBe(err);
    expect((rejected as NodeJS.ErrnoException).code).toBe("ENOSPC");
    expect(s.w.next()).toEqual(["sd:true/ENOSPC"]);
    expect(eventFramesOf(s.w)).toEqual([]);
    expect(getStorageDegraded(s.id)).toStrictEqual({ code: "ENOSPC" });
    expect(await readDisk(s.id)).toEqual([]);
  });

  // 守的是：Strict 的 notice:false 不消耗 toast 额度（lastNoticeAt 保持 0 = 从没弹过）——
  // 用户消息先失败（只亮红条），随后 agent 的 best-effort 输出也失败：这是用户第一次收到 toast，应该弹。
  // 对应源码：markStorageDegraded 的 `lastNoticeAt: notice ? now : (prev?.lastNoticeAt ?? 0)`。
  // 【变异】Strict 路径也记 lastNoticeAt（或 notice:true）→ 随后的 best-effort 失败被节流 / Strict 自己就弹了，红。
  it("Strict 失败不消耗 toast 额度：随后同任务的 best-effort 失败仍弹第一条 toast（且不重发 sd:true）", async () => {
    const s = await scene("strict-then-best-effort");

    clockAt(0);
    s.fault.fail(s.id, errno("ENOSPC"));
    await expect(
      WRITERS.writeUserEventAndPublishStrict(s.id, "用户说的话"),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(s.w.next()).toEqual(["sd:true/ENOSPC"]);

    await s.fail(1_000, "agent 回复");
    expect(s.w.next()).toEqual([
      "event:agent 回复(无seq)",
      `error:${title("ENOSPC")}`,
    ]);
  });

  // 守的是：best-effort 先降级（弹过 toast）之后，Strict 失败走同一份降级记录——同码不重发任何帧；
  // 码变了仍会发 sd:true（让红条换文案），但满 60s 之后 Strict 也绝不弹 toast（notice:false 不是被节流挡住的）。
  // 对应源码：writeUserEventAndPublishStrict 的 `{ notice: false }`；markStorageDegraded 的去重。
  // 【变异】Strict 改成 notice:true → 60s 后那次多出一条 toast，红；Strict 同码也重发 sd:true → 红。
  it("best-effort 先降级后 Strict 失败：同码不发任何帧；码变了只发 sd:true，满 60s 也不发 toast", async () => {
    const s = await scene("best-effort-then-strict");

    await s.fail(0, "f1");
    expect(s.w.next()).toEqual([
      "event:f1(无seq)",
      "sd:true/ENOSPC",
      `error:${title("ENOSPC")}`,
    ]);

    clockAt(1_000);
    s.fault.fail(s.id, errno("ENOSPC"));
    await expect(
      WRITERS.writeUserEventAndPublishStrict(s.id, "用户输入 1"),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(s.w.next()).toEqual([]); // 同码、已降级、Strict 不弹 toast → 什么都不发

    clockAt(60_000); // 距 toast#1 已满 60s：若 Strict 的 notice 是 true，这里就会弹
    s.fault.fail(s.id, errno("EROFS"));
    await expect(
      WRITERS.writeUserEventAndPublishStrict(s.id, "用户输入 2"),
    ).rejects.toMatchObject({ code: "EROFS" });
    expect(s.w.next()).toEqual(["sd:true/EROFS"]);
    expect(getStorageDegraded(s.id)).toStrictEqual({ code: "EROFS" });
  });
});

describe("存储降级 · seq 语义：写盘抛错不回滚", () => {
  // 守的是：N 场景（审查 F3）——appendFile 抛错 ≠ 一个字节都没写：整行已写进文件后才在 flush / close 阶段抛 EIO。
  // 若此时回滚 seq，下一条事件会复用同一个号，盘上出现两行同 seq，破坏「唯一单调」。
  // 所以 seq 计数器不回滚（烧号、留空洞）；推给订阅者的那份只摘掉 seq（盘上那行有 seq 2，推送的没有）。
  // 对应源码：appendEventLine 的 catch（不调 rollbackEventSeq，只 delete ev.seq）。
  // 【变异】throw 路径也回滚 seq → n2 拿到 2、盘上 seq 1/2/2，红；不摘 seq → n1 帧带 #2，红。
  it("探针 N（F3）：appendFile 先真写完整行、再抛 EIO——盘上 seq 为 1/2/3 不重复，n2.seq === 3", async () => {
    const s = await scene("probe-n");
    // 第 2 次 appendFile（n1）：整行真的写进去，随后才报 EIO
    s.fault.on(s.id, async (n, real) => {
      if (n === 2) {
        await real();
        throw errno("EIO");
      }
      return real();
    });

    clockAt(0);
    const r0 = await owned(s.id, "n0");
    expect(r0?.seq).toBe(1);
    expect(s.w.next()).toEqual(["event:n0#1"]);

    const r1 = await owned(s.id, "n1");
    expect(r1).toBeNull();
    expect(s.w.next()).toEqual([
      "event:n1(无seq)",
      "sd:true/EIO",
      `error:${title("EIO")}`,
    ]);

    const r2 = await owned(s.id, "n2");
    expect(r2?.seq).toBe(3);
    expect(s.w.next()).toEqual(["event:n2#3"]); // 仍在粘滞窗口内：没有 sd:false

    const disk = await readDisk(s.id);
    expect(disk.map((e) => [e.seq, e.text])).toEqual([
      [1, "n0"],
      [2, "n1"],
      [3, "n2"],
    ]);
    // seq 唯一
    expect(new Set(disk.map((e) => e.seq)).size).toBe(disk.length);
    // 推给订阅者的那份与盘上那行是同一条事件（同 id）：客户端重载后按 id 对得上、不会出现两条
    const pushedN1 = eventFramesOf(s.w).find((f) => f.event.text === "n1");
    expect(pushedN1?.event.id).toBe(disk[1]?.id);
  });
});

describe("存储降级 · 真实只读文件（chmod 444 → EACCES）", () => {
  // root 能无视 0o444 写入、win32 上 chmod 不生效：这两种环境跳过
  const canMakeReadOnly =
    process.platform !== "win32" && process.getuid?.() !== 0;

  // 守的是：C3 转正——events.jsonl 被设成只读（真实 EACCES，不是 mock）：agent 输出不再被静默吞掉；
  // EACCES 在 darwin / linux 上是永久权限问题，不重试（sleeps 为空，不让每个事件白等 350ms）；
  // 恢复权限、过 10s 后再写成功 → sd:false；seq 不回滚（两次失败各烧一个号 → 恢复后是 3）。
  // 对应源码：isTransientAppendError（EACCES 仅 win32 才算瞬时）；STORAGE_WRITE_ERROR_CODES 含 EACCES；appendEventLine 不回滚。
  // 【变异】EACCES 全平台重试 → sleeps=[50,100,200]，红；EACCES 不在磁盘类集合 → 没有帧，红；回滚 seq → 恢复后是 1，红。
  it.skipIf(!canMakeReadOnly)(
    "C3 转正：真 chmod 444 的 events.jsonl——事件照推（无 seq）+ sd:true/EACCES + toast；不重试；恢复权限并过 10s 后 sd:false、seq=3",
    async () => {
      const id = await newTask("c3-readonly");
      const file = eventsFile(id);
      await fsp.writeFile(file, "");
      await fsp.chmod(file, 0o444);
      try {
        const w = watch(id);
        muteWarn();
        freezeClock();
        const sleeps = recordRetrySleeps();

        const r1 = await owned(id, "重要回答", "assistant_message");
        expect(r1).toBeNull();
        expect(w.next()).toEqual([
          "event:重要回答(无seq)",
          "sd:true/EACCES",
          `error:${title("EACCES")}`,
        ]);
        expect(getStorageDegraded(id)).toStrictEqual({ code: "EACCES" });
        expect(sleeps).toEqual([]);

        // 第二条：同码持续失败，只推事件；仍不重试
        clockAt(1_000);
        const r2 = await owned(id, "第二条", "assistant_message");
        expect(r2).toBeNull();
        expect(w.next()).toEqual(["event:第二条(无seq)"]);
        expect(sleeps).toEqual([]);
        expect(await readDisk(id)).toEqual([]);

        // 恢复权限；距最近一次失败（T0+1s）满 10s 的成功写 → 恢复，seq = 3（前两次失败各烧一个号）
        await fsp.chmod(file, 0o644);
        clockAt(11_000);
        const r3 = await owned(id, "恢复后", "info");
        expect(r3?.seq).toBe(3);
        expect(w.next()).toEqual(["event:恢复后#3", "sd:false"]);
        expect(getStorageDegraded(id)).toBeNull();
        expect((await readDisk(id)).map((e) => [e.seq, e.text])).toEqual([
          [3, "恢复后"],
        ]);
      } finally {
        await fsp.chmod(file, 0o644).catch(() => undefined);
      }
    },
  );
});

describe("存储降级 · 记录的生命周期与任务隔离", () => {
  // 守的是：任务被删（publish task_deleted）→ 该任务的降级记录整条清掉（不只是翻标志）：
  // 否则 globalThis Map 只增不减，且「已删后复用 id / 残留写入」会被旧的节流时钟误伤。
  // 可观察的两个结果：getStorageDegraded 立刻为 null；之后再失败被当「首次」——60s 内也重新弹 toast。
  // 对应源码：publish() 开头的 `if (rawEv.kind === "task_deleted") getStorageDegradedMap().delete(taskId)`。
  // 【变异】不清 → 降级中变体 getStorageDegraded 非 null，红；只翻 degraded 不删记录 → 之后的失败不再弹 toast，红。
  it.each<[label: string, recoverFirst: boolean]>([
    ["降级中", false],
    ["已恢复（记录仍保留着节流时钟）", true],
  ])(
    "task_deleted 整条清掉降级记录（%s）：标志为 null，再失败被当「首次」重新弹 toast",
    async (_label, recoverFirst) => {
      const s = await scene("task-deleted");

      await s.fail(0, "f1");
      expect(s.w.next()).toEqual([
        "event:f1(无seq)",
        "sd:true/ENOSPC",
        `error:${title("ENOSPC")}`,
      ]);
      if (recoverFirst) {
        await s.ok(10_000, "ok1");
        expect(s.w.next()).toEqual(["event:ok1#2", "sd:false"]);
      } else {
        expect(getStorageDegraded(s.id)).toStrictEqual({ code: "ENOSPC" });
      }

      publish(s.id, { kind: "task_deleted", taskId: s.id });
      expect(s.w.next()).toEqual(["task_deleted"]);
      expect(getStorageDegraded(s.id)).toBeNull();

      // 距首次 toast 才 11s 以内：若记录没被整条清掉，这里要么被节流挡住 toast、要么不重发 sd:true
      await s.fail(11_000, "f2");
      expect(s.w.next()).toEqual([
        "event:f2(无seq)",
        "sd:true/ENOSPC",
        `error:${title("ENOSPC")}`,
      ]);
      expect(getStorageDegraded(s.id)).toStrictEqual({ code: "ENOSPC" });
    },
  );

  // 守的是：降级状态按 taskId 分开存——A 降级时：B 的成功写不会清 A 的标志（刻意放在 A 的粘滞窗口之后，
  // 排除「是粘滞在挡」）、A 的降级帧不会出现在 B 的订阅者里、B 自己首次失败照常弹 toast（不被 A 刚弹的 toast 节流）、
  // B 的错误码不覆盖 A 的；A 自己的成功写才能让 A 恢复，且不影响 B。
  // 对应源码：getStorageDegradedMap 按 taskId 存；publish 按 taskId 扇出。
  // 【变异】状态全局共用（不按 taskId）→ B 的成功写清掉 A / B 首次失败被节流 / 码被覆盖，红。
  it("task 隔离：A 降级、B 正常写——B 的成功写不清 A 的标志，A 的降级帧不出现在 B 的订阅者里，两边 toast / 错误码互不影响", async () => {
    const a = await newTask("iso-a");
    const b = await newTask("iso-b");
    const wa = watch(a);
    const wb = watch(b);
    muteWarn();
    freezeClock();
    const fault = installDiskFault();

    // A 降级
    clockAt(0);
    fault.fail(a, errno("ENOSPC"));
    await owned(a, "A失败", "assistant_message");
    expect(wa.next()).toEqual([
      "event:A失败(无seq)",
      "sd:true/ENOSPC",
      `error:${title("ENOSPC")}`,
    ]);
    expect(wb.next()).toEqual([]);

    // 过了 A 的粘滞窗口（10s）后 B 的成功写：B 从未降级 → 只有事件帧；A 的标志不被清，A 的订阅者什么都没收到
    clockAt(10_000);
    await owned(b, "B正常");
    expect(wb.next()).toEqual(["event:B正常#1"]);
    expect(wa.next()).toEqual([]);
    expect(getStorageDegraded(a)).toStrictEqual({ code: "ENOSPC" });
    expect(getStorageDegraded(b)).toBeNull();

    // B 首次失败（A 的 toast 才发了 10s）：B 自己的 sd:true + toast，且码是 B 自己的 EROFS，不覆盖 A 的 ENOSPC
    fault.fail(b, errno("EROFS"));
    await owned(b, "B失败", "assistant_message");
    expect(wb.next()).toEqual([
      "event:B失败(无seq)",
      "sd:true/EROFS",
      `error:${title("EROFS")}`,
    ]);
    expect(wa.next()).toEqual([]);
    expect(getStorageDegraded(a)).toStrictEqual({ code: "ENOSPC" });
    expect(getStorageDegraded(b)).toStrictEqual({ code: "EROFS" });

    // A 自己的成功写（距 A 最近一次失败恰 10s）才让 A 恢复；B 不受影响
    fault.heal(a);
    await owned(a, "A恢复");
    expect(wa.next()).toEqual(["event:A恢复#2", "sd:false"]);
    expect(wb.next()).toEqual([]);
    expect(getStorageDegraded(a)).toBeNull();
    expect(getStorageDegraded(b)).toStrictEqual({ code: "EROFS" });
  });

  // 守的是：测试专用 __resetStorageDegradedForTests 的契约（别的用例的清理都靠它）：清空全部任务的记录、不发任何帧；
  // 清空后的失败按「首次」处理（含 toast）。
  // 【变异】reset 只清一部分 / 发帧 / 不清节流时钟 → 红。
  it("__resetStorageDegradedForTests：清空全部任务的记录、不发任何帧；清空后的失败按「首次」处理", async () => {
    const a = await newTask("reset-a");
    const b = await newTask("reset-b");
    const wa = watch(a);
    const wb = watch(b);
    muteWarn();
    freezeClock();
    const fault = installDiskFault();
    fault.fail(a, errno("ENOSPC"));
    fault.fail(b, errno("EROFS"));

    clockAt(0);
    await owned(a, "A失败", "assistant_message");
    await owned(b, "B失败", "assistant_message");
    expect(getStorageDegraded(a)).toStrictEqual({ code: "ENOSPC" });
    expect(getStorageDegraded(b)).toStrictEqual({ code: "EROFS" });
    wa.next();
    wb.next();

    __resetStorageDegradedForTests();

    expect(getStorageDegraded(a)).toBeNull();
    expect(getStorageDegraded(b)).toBeNull();
    expect(wa.next()).toEqual([]);
    expect(wb.next()).toEqual([]);

    // 同一时刻再失败：没有记录 → 当首次，sd:true + toast 都重新发（节流时钟也被清了）
    await owned(a, "A又失败", "assistant_message");
    expect(wa.next()).toEqual([
      "event:A又失败(无seq)",
      "sd:true/ENOSPC",
      `error:${title("ENOSPC")}`,
    ]);
  });
});

describe("storageWriteErrorCode：哪些写盘错误算「磁盘类」", () => {
  // 守的是：集合恰好是 {ENOSPC, EDQUOT, EROFS, EIO, EACCES, EPERM, EBUSY}——命中返回该码，其余（含各种畸形入参）返回 null。
  // 对应源码：STORAGE_WRITE_ERROR_CODES + storageWriteErrorCode 的 `typeof code === "string"`。
  // 【变异】集合里多一个 / 少一个码 → 对应行红；去掉类型守卫后「code: 28」之类不会变，但「任意字符串都算」会让 EINVAL 行红。
  it.each(["ENOSPC", "EDQUOT", "EROFS", "EIO", "EACCES", "EPERM", "EBUSY"])(
    "磁盘类 %s → 返回该码",
    (code) => {
      expect(storageWriteErrorCode(errno(code))).toBe(code);
    },
  );

  it.each<[label: string, err: unknown]>([
    ["ENOENT（任务已删，走别的分支）", errno("ENOENT")],
    ["EINVAL", errno("EINVAL")],
    ["EEXIST", errno("EEXIST")],
    ["EMFILE", errno("EMFILE")],
    ["小写 enospc（大小写敏感）", { code: "enospc" }],
    ["空串 code", { code: "" }],
    ["数字 code（28）", { code: 28 }],
    ["无 code 的普通 Error", new Error("boom")],
    ["字符串 ENOSPC（不是错误对象）", "ENOSPC"],
    ["undefined", undefined],
    ["null", null],
  ])("非磁盘类 %s → null", (_label, err) => {
    expect(storageWriteErrorCode(err)).toBeNull();
  });
});
