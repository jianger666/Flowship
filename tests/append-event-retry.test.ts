/**
 * 事件追加的瞬时错误退避重试 + 写盘失败回调（R14 B2-2 / Q9-01）。
 *
 * 被测（src/lib/server/task-fs-core.ts）：
 *   - `isTransientAppendError(err, platform)`：EBUSY 全平台瞬时；EPERM / EACCES 仅 win32 瞬时；其余（ENOSPC / EIO / EROFS / EDQUOT /
 *     无 code / 非对象）都不是；
 *   - `appendEventLineUnlocked` 的重试环：瞬时错误按 [50, 100, 200]ms 退避、最多 3 次重试（= 最多 4 次 appendFile），穿透后原样抛；
 *     每次失败都清「末字节已核对」标记，所以重试前会重新核对、把上一次留下的半行隔离开；目录已删 → 返回 false、不重试；
 *   - `appendEventLine` 的 `onPersistFailed`：写盘失败（含 `ensureEventSeqCounter` 读盘失败）时**先摘 `ev.seq` 再回调一次**，
 *     回调自己抛错被吞（console.error）、原始错误照抛；seq 计数器在 throw 路径**不回滚**（烧号留空洞——appendFile 抛错 ≠ 没写，
 *     整行已落盘后才抛 EIO 时回滚会写出重复 seq），ENOENT 路径回滚、且不调回调。
 *
 * 做法：
 *   - 退避等待用 `__setAppendRetrySleepForTests` 注入（只记录毫秒数，绝不真等）；
 *   - 写盘失败用 `vi.spyOn(fsp, "appendFile")` 注入，且**只拦「本任务 events.jsonl」的调用**——fs 是进程共享的，
 *     后台写盘（seq sidecar / meta touch）不能吃掉注入的失败、也不能算进次数（同 tests/fs-gone.test.ts 的做法）；
 *   - `ensureEventSeqCounter` 读盘失败有两种造法：真 `chmod 000`（非 root、非 win32 才跑）；以及不依赖权限位的
 *     「放 `.event-seq` sidecar → 尾扫时 `fsp.stat` 对本任务 events.jsonl 抛 EIO」（所有平台含 root 都跑）；
 *   - 平台判断靠临时改写 `process.platform`（`withPlatform` 的 finally 还原，afterEach 再兜底一次）；
 *   - DATA_DIR 在 task-fs-core 加载时冻结：先把 FLOWSHIP_DATA_DIR 钉到临时目录再动态 import。
 */
import { mkdtempSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskStreamEvent } from "@/lib/server/task-stream";
import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-append-retry-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const core = await import("@/lib/server/task-fs-core");
const { createTask } = await import("@/lib/server/task-fs");
const stream = await import("@/lib/server/task-stream");

if (!core.taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`DATA_DIR 未隔离到 TMP：${core.taskDir("probe")}`);
}

// ───────────────────────── 夹具 ─────────────────────────

// spyOn 之前先存真实实现：需要真写盘 / 真 stat 的调用转发给它
const realAppend = fsp.appendFile.bind(fsp);
const realStat = fsp.stat.bind(fsp);
type AppendFileArgs = Parameters<typeof fsp.appendFile>;

const ORIGINAL_PLATFORM = process.platform;
/** chmod 000 类用例只在非 root、非 win32 才跑（root 不受权限位约束；win32 的 chmod 近似 no-op） */
const CAN_CHMOD = process.platform !== "win32" && process.getuid?.() !== 0;

const PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux", "win32"];

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated`), { code });

let idCounter = 0;
const newTaskIdFor = (tag: string): string =>
  `t_${Date.now()}_${tag}_${(idCounter += 1)}`;

/** 走真实 createTask（端到端用例用）：记下 id，afterEach 里等它们的后台 meta 触碰落地 */
const createdTaskIds: string[] = [];
const mkRealTask = async (title: string) => {
  const t = await createTask({ title, mode: "chat" } as never);
  createdTaskIds.push(t.id);
  return t;
};

/** 只建任务目录（appendEventLine 直测不查 meta；appendEvent 才查） */
const mkTaskDir = async (tag: string): Promise<string> => {
  const id = newTaskIdFor(tag);
  await fsp.mkdir(core.taskDir(id), { recursive: true });
  return id;
};

const eventsFile = (id: string): string =>
  path.join(core.taskDir(id), core.EVENTS_FILE);

const mkEvent = (text: string): TaskEvent => ({
  id: core.newEventId(),
  ts: Date.now(),
  kind: "info",
  text,
});

const readRawOrEmpty = async (id: string): Promise<string> => {
  try {
    return await fsp.readFile(eventsFile(id), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
};
const readLines = async (id: string): Promise<string[]> =>
  (await readRawOrEmpty(id)).split("\n").filter(Boolean);
const diskSeqs = async (id: string): Promise<Array<number | undefined>> =>
  (await readLines(id)).map((l) => (JSON.parse(l) as { seq?: number }).seq);

/**
 * 拦截 appendFile，只管「写本任务 events.jsonl」的调用（n 从 1 起计）；别处的调用原样透传、不计数。
 * handler 里需要真写盘就调 `realAppend`。
 */
const interceptAppend = (
  id: string,
  handler: (n: number, args: AppendFileArgs) => Promise<void>,
): { calls: () => number } => {
  const file = eventsFile(id);
  let n = 0;
  vi.spyOn(fsp, "appendFile").mockImplementation((async (
    ...args: AppendFileArgs
  ) => {
    if (String(args[0]) !== file) return realAppend(...args);
    n += 1;
    return handler(n, args);
  }) as never);
  return { calls: () => n };
};

/** 注入退避等待：只记录毫秒数，不真等 */
const recordSleeps = (): number[] => {
  const sleeps: number[] = [];
  core.__setAppendRetrySleepForTests(async (ms) => {
    sleeps.push(ms);
  });
  return sleeps;
};

const setPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, "platform", { value: platform });
};
/** 临时把 process.platform 改成 `platform` 跑 fn；finally 必还原 */
const withPlatform = async <T>(
  platform: NodeJS.Platform,
  fn: () => Promise<T> | T,
): Promise<T> => {
  setPlatform(platform);
  try {
    return await fn();
  } finally {
    setPlatform(ORIGINAL_PLATFORM);
  }
};

/** 记录 onPersistFailed 的每次调用（含「调用那一刻」的 ev.seq——回调之后再看就晚了） */
const makeFailureRecorder = () => {
  const calls: Array<{
    event: TaskEvent;
    err: unknown;
    seqAtCall: number | undefined;
  }> = [];
  const callback = (event: TaskEvent, err: unknown): void => {
    calls.push({ event, err, seqAtCall: event.seq });
  };
  return { calls, callback };
};

/** 删目录；后台 seq sidecar 的写入可能和 rm 并发（ENOTEMPTY），重试到删净（同 tests/fs-gone.test.ts） */
const rmDirRetrying = async (dir: string): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw err;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
};

const brief = (f: TaskStreamEvent): string => {
  switch (f.kind) {
    case "event":
      return `event:${f.event.kind}${f.event.seq === undefined ? "(无seq)" : `#${f.event.seq}`}`;
    case "storage_degraded":
      return `sd:${f.degraded}${f.code ? `/${f.code}` : ""}`;
    case "error":
      return "toast";
    default:
      return f.kind;
  }
};

const unsubs: Array<() => void> = [];
const subscribe = (taskId: string) => {
  const frames: TaskStreamEvent[] = [];
  unsubs.push(stream.subscribeTaskStream(taskId, (f) => frames.push(f)));
  return frames;
};

/** chmod 000 过的文件：afterEach 一律还原成可读写，免得临时目录清理失败 */
const chmodded: string[] = [];

beforeEach(() => {
  // 写失败路径会打 console.warn（writeOwnedEventAndPublish 吞错 / sidecar 写失败）；静音，不影响断言
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  core.__setAppendRetrySleepForTests();
  stream.__resetStorageDegradedForTests();
  vi.useRealTimers();
  setPlatform(ORIGINAL_PLATFORM);
  while (unsubs.length > 0) unsubs.pop()?.();
  for (const f of chmodded.splice(0)) {
    await fsp.chmod(f, 0o644).catch(() => {});
  }
  // 事件成功落盘后 appendEvent 会在后台排一个 meta.updatedAt 触碰（withTaskLock 内、best-effort）；
  // 等它落地，免得和 afterAll 删临时目录赛跑、打出 ENOENT 噪声（同 tests/ask-reply-zombie-r22-6.test.ts 的做法）
  for (const id of createdTaskIds.splice(0)) {
    await core.withTaskLock(id, async () => undefined);
  }
});

afterAll(async () => {
  await fsp
    .rm(TMP_ROOT, { recursive: true, force: true, maxRetries: 3 })
    .catch(() => {});
});

// ───────────────────────── 1. isTransientAppendError（纯函数真值表） ─────────────────────────

describe("isTransientAppendError：平台 × 错误码真值表", () => {
  const ERRNO_CODES = [
    "EBUSY",
    "EPERM",
    "EACCES",
    "ENOSPC",
    "EIO",
    "EROFS",
    "EDQUOT",
  ];
  // 显式列出「算瞬时」的组合：EBUSY 全平台；EPERM / EACCES 只有 win32。其余一律不是
  const TRANSIENT: ReadonlySet<string> = new Set([
    "darwin:EBUSY",
    "linux:EBUSY",
    "win32:EBUSY",
    "win32:EPERM",
    "win32:EACCES",
  ]);
  const TRUTH_TABLE: Array<[NodeJS.Platform, string, boolean]> =
    PLATFORMS.flatMap((platform) =>
      ERRNO_CODES.map((code): [NodeJS.Platform, string, boolean] => [
        platform,
        code,
        TRANSIENT.has(`${platform}:${code}`),
      ]),
    );

  it.each(TRUTH_TABLE)(
    "平台 %s × 错误码 %s → 瞬时=%s",
    (platform, code, expected) => {
      expect(core.isTransientAppendError(errno(code), platform)).toBe(expected);
    },
  );

  const NON_ERRNO: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["没有 code 的 Error", new Error("plain failure")],
    ["字符串 'EBUSY'（不是 errno 对象）", "EBUSY"],
    ["code 是数字 16", { code: 16 }],
    ["code 小写 'ebusy'", { code: "ebusy" }],
    ["code 是空串", { code: "" }],
  ];
  it.each(NON_ERRNO)("非 errno 形态的值（%s）在任何平台都不算瞬时", (_name, value) => {
    for (const platform of PLATFORMS) {
      expect(core.isTransientAppendError(value, platform), platform).toBe(false);
    }
  });

  it("不传平台时按「当前」process.platform 判断（默认参数不是写死的某个平台）", async () => {
    await withPlatform("win32", () => {
      expect(core.isTransientAppendError(errno("EPERM"))).toBe(true);
      expect(core.isTransientAppendError(errno("EACCES"))).toBe(true);
    });
    await withPlatform("linux", () => {
      expect(core.isTransientAppendError(errno("EPERM"))).toBe(false);
      expect(core.isTransientAppendError(errno("EACCES"))).toBe(false);
    });
    await withPlatform("darwin", () => {
      expect(core.isTransientAppendError(errno("EPERM"))).toBe(false);
      expect(core.isTransientAppendError(errno("EBUSY"))).toBe(true);
    });
    // finally 已还原
    expect(process.platform).toBe(ORIGINAL_PLATFORM);
  });
});

// ───────────────────────── 2. appendEventLine 的退避重试 ─────────────────────────

describe("appendEventLine：瞬时错误退避重试（真实 task-fs-core + 注入 appendFile 失败）", () => {
  it.each(PLATFORMS)(
    "平台 %s：EBUSY 两次后成功——appendFile 3 次、退避 [50,100]、盘上恰 1 行、不通知写盘失败",
    async (platform) => {
      const id = await mkTaskDir("busy-then-ok");
      const sleeps = recordSleeps();
      const spy = interceptAppend(id, async (n, args) => {
        if (n <= 2) throw errno("EBUSY");
        return realAppend(...args);
      });
      const recorder = makeFailureRecorder();
      const committed: number[] = [];
      const sleepsAtCommit: number[] = [];
      const ev = mkEvent("busy-then-ok");

      const ok = await withPlatform(platform, () =>
        core.appendEventLine(
          id,
          ev,
          undefined,
          () => {
            committed.push(1);
            sleepsAtCommit.push(sleeps.length);
          },
          recorder.callback,
        ),
      );

      expect(ok).toBe(true);
      expect(spy.calls()).toBe(3);
      expect(sleeps).toEqual([50, 100]);
      // 重试成功 = 没有失败：不得通知写盘失败；onCommitted 恰 1 次，且在两次退避都走完之后
      expect(recorder.calls).toEqual([]);
      expect(committed).toHaveLength(1);
      expect(sleepsAtCommit).toEqual([2]);
      // 盘上恰 1 行、可解析、seq 即发的那个号（重试不重新发号、不重复写）
      const lines = await readLines(id);
      expect(lines).toHaveLength(1);
      const row = JSON.parse(lines[0]!) as TaskEvent;
      expect(row.text).toBe("busy-then-ok");
      expect(row.seq).toBe(1);
      expect(ev.seq).toBe(1);
    },
  );

  it.each(["EPERM", "EACCES"])(
    "win32：%s 两次后成功（Windows 上 EPERM / EACCES 也是瞬时占用）——退避 [50,100]、盘上恰 1 行",
    async (code) => {
      const id = await mkTaskDir(`win-${code.toLowerCase()}-then-ok`);
      const sleeps = recordSleeps();
      const spy = interceptAppend(id, async (n, args) => {
        if (n <= 2) throw errno(code);
        return realAppend(...args);
      });
      const ok = await withPlatform("win32", () =>
        core.appendEventLine(id, mkEvent(`win-${code}`)),
      );
      expect(ok).toBe(true);
      expect(spy.calls()).toBe(3);
      expect(sleeps).toEqual([50, 100]);
      expect(await readLines(id)).toHaveLength(1);
    },
  );

  // 平台 × 码 的重试矩阵（持续失败）：true = 应重试 3 次后穿透（4 次 appendFile、退避 [50,100,200]）；false = 一次就抛（不白等）
  const PERSISTENT_MATRIX: Array<[NodeJS.Platform, string, boolean]> = [
    ["darwin", "EBUSY", true],
    ["linux", "EBUSY", true],
    ["win32", "EBUSY", true],
    ["darwin", "EPERM", false],
    ["linux", "EPERM", false],
    ["win32", "EPERM", true],
    ["darwin", "EACCES", false],
    ["linux", "EACCES", false],
    ["win32", "EACCES", true],
    // 永久性的磁盘类错误：连 win32（最宽松的平台）也不重试
    ["win32", "ENOSPC", false],
    ["win32", "EIO", false],
    ["win32", "EROFS", false],
    ["win32", "EDQUOT", false],
    ["darwin", "ENOSPC", false],
    ["darwin", "EIO", false],
    ["darwin", "EROFS", false],
  ];

  /** 在 `platform` 下写一条事件，该任务 events.jsonl 的 appendFile 一律抛 `code`；返回观察到的一切 */
  const runPersistentFailure = async (
    platform: NodeJS.Platform,
    code: string,
  ) => {
    const id = await mkTaskDir(`persist-${code.toLowerCase()}`);
    const sleeps = recordSleeps();
    const spy = interceptAppend(id, async () => {
      throw errno(code);
    });
    const recorder = makeFailureRecorder();
    const ev = mkEvent(`persistent-${code}`);
    const error = await withPlatform(platform, () =>
      core
        .appendEventLine(id, ev, undefined, undefined, recorder.callback)
        .then(
          () => undefined,
          (err: unknown) => err,
        ),
    );
    return {
      id,
      ev,
      error,
      sleeps,
      appendCalls: spy.calls(),
      failed: recorder.calls,
    };
  };

  it.each(PERSISTENT_MATRIX)(
    "持续失败：平台 %s 上 %s → 重试=%s",
    async (platform, code, shouldRetry) => {
      const run = await runPersistentFailure(platform, code);
      expect(run.error).toMatchObject({ code });
      if (shouldRetry) {
        expect(run.sleeps).toEqual([50, 100, 200]);
        expect(run.appendCalls).toBe(4);
      } else {
        expect(run.sleeps).toEqual([]);
        expect(run.appendCalls).toBe(1);
      }
      // 无论重不重试，最终失败只通知一次；盘上没有这条
      expect(run.failed).toHaveLength(1);
      expect(await readRawOrEmpty(run.id)).not.toContain(`persistent-${code}`);
    },
  );

  it("重试穿透（4 次都 EBUSY）：最后一次的错误原样抛出；onPersistFailed 恰 1 次（重试期间不通知）、调用时 ev.seq 已摘除；onCommitted 不调；盘上没有这条", async () => {
    const id = await mkTaskDir("exhaust");
    const failuresSeenDuringSleep: number[] = [];
    const recorder = makeFailureRecorder();
    const sleeps: number[] = [];
    core.__setAppendRetrySleepForTests(async (ms) => {
      sleeps.push(ms);
      // 退避等待期间还没「最终失败」：此刻不能已经通知过
      failuresSeenDuringSleep.push(recorder.calls.length);
    });
    const errors: NodeJS.ErrnoException[] = [];
    const spy = interceptAppend(id, async () => {
      const e = errno("EBUSY");
      errors.push(e);
      throw e;
    });
    const committed: TaskEvent[] = [];
    const ev = mkEvent("exhaust-me");

    // 先等 rejection 落定再和 errors[3] 比（toBe 的参数在 promise 结算之前就求值了，errors 此时还是空的）
    const rejection = await core
      .appendEventLine(
        id,
        ev,
        undefined,
        (e) => committed.push(e),
        recorder.callback,
      )
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(spy.calls()).toBe(4);
    expect(errors).toHaveLength(4);
    // 抛出的是穿透那一次（第 4 次）的错误对象本身，没被包装 / 替换
    expect(rejection).toBe(errors[3]);
    expect(sleeps).toEqual([50, 100, 200]);
    expect(failuresSeenDuringSleep).toEqual([0, 0, 0]);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.event).toBe(ev);
    expect(recorder.calls[0]!.err).toBe(errors[3]);
    expect(recorder.calls[0]!.seqAtCall).toBeUndefined();
    expect(ev.seq).toBeUndefined();
    expect(committed).toEqual([]);
    expect(await readRawOrEmpty(id)).not.toContain("exhaust-me");
  });

  it("端到端（探针 C）：EBUSY 两次后成功，经 writeOwnedEventAndPublish——盘上 3 行 seq 连续 [1,2,3]、订阅者只收到 3 个事件帧，没有降级帧 / toast", async () => {
    const t = await mkRealTask("retry-probe-c");
    const frames = subscribe(t.id);
    const lease = () => true;
    const first = await stream.writeOwnedEventAndPublish(t.id, lease, {
      kind: "info",
      text: "先正常写一条",
    } as never);
    expect(first?.seq).toBe(1);

    const sleeps = recordSleeps();
    const spy = interceptAppend(t.id, async (n, args) => {
      if (n <= 2) throw errno("EBUSY");
      return realAppend(...args);
    });
    const retried = await stream.writeOwnedEventAndPublish(t.id, lease, {
      kind: "info",
      text: "被占用两次后成功",
    } as never);
    expect(spy.calls()).toBe(3);
    expect(sleeps).toEqual([50, 100]);
    expect(retried?.seq).toBe(2);

    const after = await stream.writeOwnedEventAndPublish(t.id, lease, {
      kind: "info",
      text: "恢复后再写一条",
    } as never);
    expect(after?.seq).toBe(3);

    // 盘上：每行可解析、seq 连续；重试那条恰出现一次
    const lines = await readLines(t.id);
    expect(lines).toHaveLength(3);
    const rows = lines.map((l) => JSON.parse(l) as TaskEvent);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.text)).toEqual([
      "先正常写一条",
      "被占用两次后成功",
      "恢复后再写一条",
    ]);
    // 瞬时占用重试成功 ≠ 存储降级：没有 sd 帧、没有 toast、标志没置
    expect(frames.map(brief)).toEqual([
      "event:info#1",
      "event:info#2",
      "event:info#3",
    ]);
    expect(stream.getStorageDegraded(t.id)).toBeNull();
  });

  it("端到端：重试穿透（EBUSY ×4）——退避期间订阅者什么都没收到、也没降级；穿透后才推无 seq 副本并以 EBUSY 置降级；盘上没有这条", async () => {
    const t = await mkRealTask("retry-exhaust-e2e");
    const frames = subscribe(t.id);
    const sleeps: number[] = [];
    const framesDuringSleeps: number[] = [];
    const degradedDuringSleeps: unknown[] = [];
    core.__setAppendRetrySleepForTests(async (ms) => {
      sleeps.push(ms);
      framesDuringSleeps.push(frames.length);
      degradedDuringSleeps.push(stream.getStorageDegraded(t.id));
    });
    const spy = interceptAppend(t.id, async () => {
      throw errno("EBUSY");
    });

    const result = await stream.writeOwnedEventAndPublish(t.id, () => true, {
      kind: "info",
      text: "一直被占用",
    } as never);

    expect(result).toBeNull();
    expect(spy.calls()).toBe(4);
    expect(sleeps).toEqual([50, 100, 200]);
    expect(framesDuringSleeps).toEqual([0, 0, 0]);
    expect(degradedDuringSleeps).toEqual([null, null, null]);
    expect(frames.map(brief)).toEqual([
      "event:info(无seq)",
      "sd:true/EBUSY",
      "toast",
    ]);
    expect(stream.getStorageDegraded(t.id)).toEqual({ code: "EBUSY" });
    expect(await readRawOrEmpty(t.id)).not.toContain("一直被占用");
  });
});

// ───────────────────────── 3. 半行隔离 ─────────────────────────

describe("重试前重新核对末字节：上次留下的半行被隔离，不和新事件粘成一行", () => {
  const TORN_FRAGMENT = '{"id":"half","ts":1,"kind":"info","text":"没写完';

  it("已核对过末字节的任务：第一次 appendFile 先真写入半行再抛 EBUSY → 重试成功后新事件独占一行、半行原样隔离", async () => {
    const id = await mkTaskDir("torn-retry");
    const sleeps = recordSleeps();
    // 先成功写一条：此后本任务「末字节已核对」，不清掉这个标记的话重试时就不会再看末字节——这正是要守的
    await core.appendEventLine(id, mkEvent("e0"));
    const spy = interceptAppend(id, async (n, args) => {
      if (n === 1) {
        // 杀软占用 / 磁盘抖动：只写进去半行（不带换行）就失败了
        await realAppend(args[0], TORN_FRAGMENT, "utf-8");
        throw errno("EBUSY");
      }
      return realAppend(...args);
    });

    expect(await core.appendEventLine(id, mkEvent("e1"))).toBe(true);
    expect(spy.calls()).toBe(2);
    expect(sleeps).toEqual([50]);

    const lines = await readLines(id);
    expect(lines).toHaveLength(3);
    expect((JSON.parse(lines[0]!) as TaskEvent).text).toBe("e0");
    // 半行独占一行、内容原样（没被新事件接在后面）
    expect(lines[1]).toBe(TORN_FRAGMENT);
    // 新事件整行可被 JSON.parse
    const last = JSON.parse(lines[2]!) as TaskEvent;
    expect(last.text).toBe("e1");
    expect(last.seq).toBe(2);
    // 读侧跳过坏行，只读回两条好事件
    expect((await core.readEvents(id)).map((e) => e.text)).toEqual(["e0", "e1"]);
  });

  it("半行被隔离之后恢复正常：再追加一条不会多补空行（重试成功后「末字节已核对」恢复）", async () => {
    const id = await mkTaskDir("torn-retry-then-normal");
    recordSleeps();
    await core.appendEventLine(id, mkEvent("e0"));
    interceptAppend(id, async (n, args) => {
      if (n === 1) {
        await realAppend(args[0], TORN_FRAGMENT, "utf-8");
        throw errno("EBUSY");
      }
      return realAppend(...args);
    });
    await core.appendEventLine(id, mkEvent("e1"));
    await core.appendEventLine(id, mkEvent("e2"));

    const raw = await readRawOrEmpty(id);
    expect(raw.includes("\n\n")).toBe(false);
    expect((await readLines(id)).map((l) => l.slice(0, 7))).toEqual([
      '{"id":"',
      '{"id":"',
      '{"id":"',
      '{"id":"',
    ]);
    expect((await core.readEvents(id)).map((e) => e.text)).toEqual(["e0", "e1", "e2"]);
  });
});

// ───────────────────────── 4. onPersistFailed 语义 ─────────────────────────

describe("appendEventLine 的 onPersistFailed 语义", () => {
  it("写盘失败：恰调一次、err 即 appendFile 抛的那个错误、调用时 ev.seq 已摘除；appendEventLine reject 同一个错误；ENOSPC 不重试", async () => {
    const id = await mkTaskDir("cb-once");
    const sleeps = recordSleeps();
    // 先成功写一条：失败那条会占到 seq=2——回调里若还带着 seq 就是 2
    await core.appendEventLine(id, mkEvent("ok-1"));
    const boom = errno("ENOSPC");
    interceptAppend(id, async () => {
      throw boom;
    });
    const recorder = makeFailureRecorder();
    const ev = mkEvent("will-fail");

    await expect(
      core.appendEventLine(id, ev, undefined, undefined, recorder.callback),
    ).rejects.toBe(boom);

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.event).toBe(ev);
    expect(recorder.calls[0]!.err).toBe(boom);
    expect(recorder.calls[0]!.seqAtCall).toBeUndefined();
    expect(ev.seq).toBeUndefined();
    expect(sleeps).toEqual([]);
  });

  it("回调自己抛错：被吞（console.error 记一笔），appendEventLine 仍 reject 原始写盘错误（不是回调抛的），且之后的写入照常（链不断）", async () => {
    const id = await mkTaskDir("cb-throws");
    recordSleeps();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeErr = errno("EIO");
    const cbErr = new Error("回调炸了");
    interceptAppend(id, async (n, args) => {
      if (n === 1) throw writeErr;
      return realAppend(...args);
    });

    await expect(
      core.appendEventLine(id, mkEvent("fail"), undefined, undefined, () => {
        throw cbErr;
      }),
    ).rejects.toBe(writeErr);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("onPersistFailed 抛错"),
      cbErr,
    );

    // 回调抛错没有断链、也没有污染后续写入
    const next = mkEvent("next");
    await expect(core.appendEventLine(id, next)).resolves.toBe(true);
    expect((await readLines(id)).map((l) => (JSON.parse(l) as TaskEvent).text)).toEqual(["next"]);
  });

  it("任务目录真被删了（不 mock）：返回 false、不抛、不重试、不调 onPersistFailed、ev.seq 被摘、目录不复活", async () => {
    const id = await mkTaskDir("dir-gone");
    await fsp.rm(core.taskDir(id), { recursive: true, force: true });
    const sleeps = recordSleeps();
    const recorder = makeFailureRecorder();
    const ev = mkEvent("late-event");

    await expect(
      core.appendEventLine(id, ev, undefined, undefined, recorder.callback),
    ).resolves.toBe(false);

    expect(recorder.calls).toEqual([]);
    expect(sleeps).toEqual([]);
    expect(ev.seq).toBeUndefined();
    expect(
      await fsp.stat(core.taskDir(id)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("appendFile 抛 ENOENT：返回 false、不调 onPersistFailed、不重试，且回滚刚发的号（下一条拿到同一个 seq）", async () => {
    const id = await mkTaskDir("enoent-rollback");
    const sleeps = recordSleeps();
    const first = mkEvent("first");
    await core.appendEventLine(id, first);
    expect(first.seq).toBe(1);
    interceptAppend(id, async (n, args) => {
      if (n === 1) throw errno("ENOENT");
      return realAppend(...args);
    });
    const recorder = makeFailureRecorder();
    const lost = mkEvent("lost");

    await expect(
      core.appendEventLine(id, lost, undefined, undefined, recorder.callback),
    ).resolves.toBe(false);
    expect(recorder.calls).toEqual([]);
    expect(sleeps).toEqual([]);
    expect(lost.seq).toBeUndefined();

    const next = mkEvent("next");
    await expect(core.appendEventLine(id, next)).resolves.toBe(true);
    // ENOENT 是「确定没写」：回滚 lost 占的 2，next 复用它——盘上 seq 无空洞
    expect(next.seq).toBe(2);
    expect(await diskSeqs(id)).toEqual([1, 2]);
  });

  it("重试等待期间任务目录被删：下一次 appendFile 抛 ENOENT → 返回 false、不抛、不调 onPersistFailed（重试环里目录已删判断仍生效）", async () => {
    const id = await mkTaskDir("gone-during-retry");
    const sleeps: number[] = [];
    core.__setAppendRetrySleepForTests(async (ms) => {
      sleeps.push(ms);
      await rmDirRetrying(core.taskDir(id)); // 退避的这一会儿，任务被删了
    });
    interceptAppend(id, async (n, args) => {
      if (n === 1) throw errno("EBUSY");
      return realAppend(...args);
    });
    const recorder = makeFailureRecorder();
    const ev = mkEvent("busy-then-gone");

    await expect(
      core.appendEventLine(id, ev, undefined, undefined, recorder.callback),
    ).resolves.toBe(false);

    expect(sleeps).toEqual([50]);
    expect(recorder.calls).toEqual([]);
    expect(ev.seq).toBeUndefined();
    expect(
      await fsp.stat(core.taskDir(id)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("ensureEventSeqCounter 读盘失败（不依赖权限位：有 sidecar → 尾扫时 events.jsonl 的 stat 抛 EIO，所有平台含 root 都跑）：先调 onPersistFailed（还没发号、ev.seq 为空）再 reject 同一个错误；不进重试；盘上没写；故障解除后首条 seq 仍是 1（没烧号）", async () => {
    const id = await mkTaskDir("ensure-read-fail-eio");
    const file = eventsFile(id);
    await fsp.writeFile(file, "");
    // sidecar = 0 → ensureEventSeqCounter 走「读 sidecar + 尾扫」分支，尾扫先 stat(events.jsonl)
    await fsp.writeFile(
      path.join(core.taskDir(id), core.EVENT_SEQ_SIDECAR_FILE),
      "0",
    );
    const statSpy = vi.spyOn(fsp, "stat").mockImplementation(((
      ...args: Parameters<typeof fsp.stat>
    ) => {
      if (String(args[0]) === file) return Promise.reject(errno("EIO"));
      return realStat(...args);
    }) as never);
    const sleeps = recordSleeps();
    const recorder = makeFailureRecorder();
    const ev = mkEvent("never-numbered");

    const rejection = await core
      .appendEventLine(id, ev, undefined, undefined, recorder.callback)
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    // 必须 rethrow（不是吞错返回 false）；回调收到的就是抛给调用方的同一个错误
    expect(rejection).toMatchObject({ code: "EIO" });
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.event).toBe(ev);
    expect(recorder.calls[0]!.err).toBe(rejection);
    expect(recorder.calls[0]!.seqAtCall).toBeUndefined();
    expect(ev.seq).toBeUndefined();
    expect(sleeps).toEqual([]);
    expect(await fsp.readFile(file, "utf-8")).toBe("");

    // 读失败发生在发号之前：故障解除后同一任务的首条事件拿到 seq=1
    statSpy.mockRestore();
    const next = mkEvent("after-restore");
    await expect(core.appendEventLine(id, next)).resolves.toBe(true);
    expect(next.seq).toBe(1);
  });

  it.skipIf(!CAN_CHMOD)(
    "ensureEventSeqCounter 读盘失败（events.jsonl chmod 000 → EACCES）：先调 onPersistFailed（此时还没发号、ev.seq 为空）再抛；不进重试；恢复权限后首条 seq 仍是 1（没烧号）",
    async () => {
      const id = await mkTaskDir("ensure-read-fail");
      const file = eventsFile(id);
      await fsp.writeFile(file, "");
      await fsp.chmod(file, 0o000);
      chmodded.push(file);
      const sleeps = recordSleeps();
      const recorder = makeFailureRecorder();
      const ev = mkEvent("never-numbered");

      await expect(
        core.appendEventLine(id, ev, undefined, undefined, recorder.callback),
      ).rejects.toMatchObject({ code: "EACCES" });

      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]!.event).toBe(ev);
      expect(recorder.calls[0]!.seqAtCall).toBeUndefined();
      expect((recorder.calls[0]!.err as NodeJS.ErrnoException).code).toBe("EACCES");
      expect(ev.seq).toBeUndefined();
      expect(sleeps).toEqual([]);

      // 读失败发生在发号之前：恢复权限后同一任务的首条事件拿到 seq=1
      await fsp.chmod(file, 0o644);
      const next = mkEvent("after-restore");
      await expect(core.appendEventLine(id, next)).resolves.toBe(true);
      expect(next.seq).toBe(1);
    },
  );
});

// ───────────────────────── 5. seq 在失败路径上的账 ─────────────────────────

describe("seq：throw 路径不回滚（烧号留空洞），避免写出重复 seq", () => {
  it("第 1 条成功(seq=1)、第 2 条 ENOSPC（占了 2、抛错）、第 3 条成功 → seq=3，盘上 [1,3]（空洞，而不是 [1,2]）", async () => {
    const id = await mkTaskDir("seq-hole");
    recordSleeps();
    const e1 = mkEvent("e1");
    await core.appendEventLine(id, e1);
    expect(e1.seq).toBe(1);

    interceptAppend(id, async (n, args) => {
      if (n === 1) throw errno("ENOSPC");
      return realAppend(...args);
    });
    await expect(core.appendEventLine(id, mkEvent("e2"))).rejects.toMatchObject({
      code: "ENOSPC",
    });
    const e3 = mkEvent("e3");
    await expect(core.appendEventLine(id, e3)).resolves.toBe(true);

    expect(e3.seq).toBe(3);
    expect(await diskSeqs(id)).toEqual([1, 3]);
  });

  it("appendFile 把整行写完才抛 EIO（flush / close 阶段失败）：不回滚，盘上 seq 唯一单调 [1,2,3]、没有重复", async () => {
    const id = await mkTaskDir("seq-eio-after-write");
    recordSleeps();
    const n0 = mkEvent("n0");
    await core.appendEventLine(id, n0);
    expect(n0.seq).toBe(1);

    interceptAppend(id, async (n, args) => {
      if (n === 1) {
        await realAppend(...args); // 先真写完整行（seq=2 已在行里）
        throw errno("EIO"); // 再抛错
      }
      return realAppend(...args);
    });
    await expect(core.appendEventLine(id, mkEvent("n1"))).rejects.toMatchObject({
      code: "EIO",
    });
    const n2 = mkEvent("n2");
    await expect(core.appendEventLine(id, n2)).resolves.toBe(true);

    // 回滚的话 n2 会复用 2，盘上出现两行 seq=2
    expect(n2.seq).toBe(3);
    expect(await diskSeqs(id)).toEqual([1, 2, 3]);
  });
});
