/**
 * 壳日志 main.log 的写入器（R14 B2-4b / Q15-03）：`electron-app/shell-log.mjs`
 *
 * 台账原句（Q15-03 P2 BUG）：`createWriteStream(main.log, { flags: "a" })` 无 error 监听 + 无轮转（旧 E1-05：83.9MB / 4.5 个月）；
 * 磁盘满时壳的第一反应是弹「A JavaScript error occurred」；`log()` 的 try/catch 挡不住异步 error 事件。
 * 这里测的是抽出来的写入器本身（fs / console / 时钟全部注入、不起 Electron）：
 *   A. 正常路径：格式与改前一致、只开一条流、console 回显坏了也不影响落盘
 *   B. 写流错误：error 有监听（不会变成未捕获异常）、坏流丢弃后自愈、连续失败降级（暂存内存、有上限）、到点恢复并补写
 *   C. 轮转：先 end() 等 close 再 rename（Windows 的 EBUSY）、期间新行不丢且顺序不变、保留份数、rename 失败后继续追加并退避、启动时也检查
 *   D. 真实文件系统：小阈值下真的会出 .1、大小有界、最新的行不丢；坏路径 → 降级 → 修好后自愈
 *   F. logSync：致命路径（uncaughtException）同步追加、不经队列 / 流，失败不抛
 *   E. main.js 接线（源码契约）：内联的无监听写流已删、log 仍是行首 const（切片测试脚手架依赖）、stdout / stderr 的 EPIPE 有监听
 * 「没有 error 监听」在这里的模型：EventEmitter 对没有监听器的 'error' 事件会直接抛——FakeStream 的 error 是在微任务里 emit 的，
 * 没人接就是一个未处理的异常（vitest 会把它报成 Unhandled Error、整个运行变红），与 Electron 里的 uncaughtException 同构。
 */
import { EventEmitter } from "node:events";
import fsReal from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createShellLogger,
  DEFAULT_DEGRADE_RETRY_MS,
  DEFAULT_ERRORS_BEFORE_DEGRADE,
  DEFAULT_KEEP,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_QUEUED_LINES,
  DEFAULT_ROTATE_RETRY_MS,
} from "../electron-app/shell-log.mjs";
import { mainSrc } from "./helpers/main-slice";

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
const errWithCode = (code: string, msg = code): Error => Object.assign(new Error(msg), { code });

/** 假的写流：行为只取我们关心的那部分（write 回调 / error / close / destroyed / closed） */
class FakeStream extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  closed = false;
  ended = false;
  private writes = 0;
  constructor(
    readonly file: string,
    private readonly failWrites: Set<number> = new Set(),
    private readonly code = "ENOSPC",
    private readonly onClose: () => void = () => undefined,
  ) {
    super();
  }
  write(data: string, cb?: (err?: Error | null) => void): boolean {
    if (this.destroyed) {
      cb?.(errWithCode("ERR_STREAM_DESTROYED"));
      return false;
    }
    this.writes += 1;
    if (this.failWrites.has(this.writes)) {
      const err = errWithCode(this.code, `${this.code}: write failed`);
      queueMicrotask(() => {
        this.destroyed = true;
        this.emit("error", err);
        cb?.(err);
        this.closed = true;
        this.emit("close");
      });
      return false;
    }
    this.written.push(data);
    queueMicrotask(() => cb?.(null));
    return true;
  }
  end(): void {
    this.ended = true;
    queueMicrotask(() => {
      this.onClose();
      this.closed = true;
      this.emit("finish");
      this.emit("close");
    });
  }
  destroy(): void {
    this.destroyed = true;
  }
}

interface FsOpts {
  /** 第 n 条流（从 0 数）的哪几次 write 失败 */
  failWrites?: (streamIndex: number) => number[];
  failCode?: string;
  mkdirError?: () => Error | null;
  createThrows?: () => Error | null;
  renameError?: (from: string, to: string) => Error | null;
  appendError?: () => Error | null;
}

const makeFs = (o: FsOpts = {}) => {
  const timeline: string[] = [];
  const streams: FakeStream[] = [];
  const sizes = new Map<string, number>();
  const appended: Array<[string, string]> = [];
  const fsx = {
    appendFileSync: vi.fn((f: string, data: string) => {
      const e = o.appendError?.();
      if (e) throw e;
      appended.push([f, data]);
    }),
    mkdirSync: vi.fn((d: string) => {
      const e = o.mkdirError?.();
      if (e) throw e;
      timeline.push(`mkdir:${d}`);
    }),
    createWriteStream: vi.fn((file: string) => {
      const e = o.createThrows?.();
      if (e) throw e;
      const idx = streams.length;
      const s = new FakeStream(file, new Set(o.failWrites?.(idx) ?? []), o.failCode, () => timeline.push(`close:${idx}`));
      streams.push(s);
      timeline.push(`create:${idx}`);
      return s;
    }),
    statSync: vi.fn((f: string) => {
      const size = sizes.get(f);
      if (size === undefined) throw errWithCode("ENOENT");
      return { size };
    }),
    renameSync: vi.fn((from: string, to: string) => {
      const e = o.renameError?.(from, to);
      if (e) throw e;
      const size = sizes.get(from);
      if (size === undefined) throw errWithCode("ENOENT");
      timeline.push(`rename:${path.basename(from)}->${path.basename(to)}`);
      sizes.set(to, size);
      sizes.delete(from);
    }),
    rmSync: vi.fn((f: string) => {
      timeline.push(`rm:${path.basename(f)}`);
      sizes.delete(f);
    }),
  };
  return { fsx, streams, sizes, timeline, appended };
};

const FILE = "/logs/main.log";

const makeLogger = (o: FsOpts = {}, over: Record<string, unknown> = {}) => {
  const f = makeFs(o);
  let t = 1_000_000;
  const consoleImpl = { log: vi.fn(), warn: vi.fn() };
  const logger = createShellLogger({
    getLogFile: () => FILE,
    fs: f.fsx as never,
    console: consoleImpl as never,
    nowMs: () => t,
    stamp: () => "T",
    ...over,
  });
  return {
    ...f,
    logger,
    consoleImpl,
    advance: (ms: number) => {
      t += ms;
    },
    lines: (i = 0) => f.streams[i]?.written ?? [],
    allLines: () => f.streams.flatMap((s) => s.written),
  };
};

describe("A. 正常路径", () => {
  it("格式与改前一致（`[时间] 参数用空格连接`）；先回显 console；多行共用同一条流；目录先建好", async () => {
    const h = makeLogger();
    h.logger.log("a", "b", 3);
    h.logger.log("second");
    await settle();
    expect(h.consoleImpl.log.mock.calls).toEqual([["[T] a b 3"], ["[T] second"]]);
    expect(h.fsx.createWriteStream).toHaveBeenCalledTimes(1);
    expect(h.fsx.createWriteStream).toHaveBeenCalledWith(FILE, { flags: "a" });
    expect(h.lines()).toEqual(["[T] a b 3\n", "[T] second\n"]);
    expect(h.timeline[0]).toBe("mkdir:/logs");
  });

  it("console 回显坏了（stdout 管道 EPIPE 同步抛）：log 不抛、照常落盘", async () => {
    const h = makeLogger();
    h.consoleImpl.log.mockImplementation(() => {
      throw errWithCode("EPIPE");
    });
    expect(() => h.logger.log("still written")).not.toThrow();
    await settle();
    expect(h.lines()).toEqual(["[T] still written\n"]);
  });

  it("流上挂了 error 监听（没有监听器的 error 事件会变成未捕获异常——台账说的 A JavaScript error）", () => {
    const h = makeLogger();
    h.logger.log("x");
    expect(h.streams[0]!.listenerCount("error")).toBeGreaterThanOrEqual(1);
  });
});

describe("B. 写流错误：不抛、自愈、降级、恢复", () => {
  it("写失败（ENOSPC 的 error 事件）：不抛、不变成未处理异常；下一行换一条新流写入", async () => {
    const h = makeLogger({ failWrites: (i) => (i === 0 ? [1] : []) });
    h.logger.log("lost-with-the-bad-stream");
    await settle(); // error 事件在这里发出：没有监听器的话这一步就是 Unhandled Error
    expect(h.logger.state()).toMatchObject({ consecutiveErrors: 1, degraded: false, lastErrorCode: "ENOSPC", hasStream: false });
    h.logger.log("next");
    await settle();
    expect(h.fsx.createWriteStream).toHaveBeenCalledTimes(2);
    expect(h.lines(1)).toEqual(["[T] next\n"]);
    expect(h.logger.state().consecutiveErrors).toBe(0); // 新流写成功 → 失败计数清零
  });

  it("同一条流的 error 事件与 write 回调的错误只记一次账", async () => {
    const h = makeLogger({ failWrites: (i) => (i === 0 ? [1] : []) });
    h.logger.log("x");
    await settle();
    expect(h.logger.state().consecutiveErrors).toBe(1);
  });

  it("write 同步抛错记一次账，同一条流随后迟到的 error 事件不再重复记账；那一行留在队列里、换新流写入", async () => {
    const h = makeLogger();
    h.logger.log("first");
    await settle();
    const bad = h.streams[0]!;
    bad.write = () => {
      throw errWithCode("EPIPE", "write threw");
    };
    h.logger.log("retry-me");
    expect(h.logger.state()).toMatchObject({ consecutiveErrors: 1, lastErrorCode: "EPIPE" });
    bad.emit("error", errWithCode("EPIPE")); // 同一条流的 error 事件：已记过账
    expect(h.logger.state().consecutiveErrors).toBe(1);
    h.logger.log("next"); // 触发队列里那一行 + 这一行写进新流
    await settle();
    expect(h.lines(1)).toEqual(["[T] retry-me\n", "[T] next\n"]);
  });

  it("连续 3 次失败 → 降级：不再重开流、一次 console.warn、行留在内存队列；到点（60s）才再试", async () => {
    const h = makeLogger({ failWrites: () => [1] }); // 每条新流的第一次写都失败
    for (let i = 0; i < 3; i += 1) {
      h.logger.log(`L${i}`);
      await settle();
    }
    expect(h.logger.state()).toMatchObject({ consecutiveErrors: 3, degraded: true });
    expect(h.fsx.createWriteStream).toHaveBeenCalledTimes(3);
    expect(h.consoleImpl.warn).toHaveBeenCalledTimes(1);
    h.logger.log("while-degraded-1");
    h.logger.log("while-degraded-2");
    await settle();
    expect(h.fsx.createWriteStream).toHaveBeenCalledTimes(3); // 降级期间不再碰磁盘
    expect(h.logger.state().queued).toBeGreaterThanOrEqual(2);
    h.advance(59_000);
    h.logger.log("still-degraded");
    await settle();
    expect(h.fsx.createWriteStream).toHaveBeenCalledTimes(3);
  });

  it("降级到点重试：磁盘恢复后按原顺序补写积压的行，并留下「降级 / 已恢复」说明行", async () => {
    let bad = true;
    const h = makeLogger({ failWrites: (i) => (bad && i < 3 ? [1] : []) });
    for (let i = 0; i < 3; i += 1) {
      h.logger.log(`pre${i}`);
      await settle();
    }
    expect(h.logger.state().degraded).toBe(true);
    h.logger.log("during-1");
    h.logger.log("during-2");
    bad = false;
    h.advance(60_001);
    h.logger.log("after");
    await settle();
    h.logger.log("tick"); // 恢复说明行在写成功的回调里入队，下一行日志时带出
    await settle();
    const text = h.allLines().join("");
    const order = ["during-1", "during-2", "after"].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order); // 顺序不变
    expect(text).toContain("连续 3 次写入失败");
    expect(text).toContain("main.log 已恢复写入");
    expect(h.logger.state()).toMatchObject({ degraded: false, consecutiveErrors: 0 });
  });

  it("降级期间的暂存有上限（maxQueuedLines）：丢最旧的、留最新的，恢复后写一行「丢了 N 行」", async () => {
    let bad = true;
    const h = makeLogger({ failWrites: (i) => (bad && i < 3 ? [1] : []) }, { maxQueuedLines: 50 });
    for (let i = 0; i < 3; i += 1) {
      h.logger.log(`pre${i}`);
      await settle();
    }
    for (let i = 0; i < 200; i += 1) h.logger.log(`flood-${i}`);
    expect(h.logger.state().queued).toBe(50);
    expect(h.logger.state().dropped).toBeGreaterThan(0);
    const droppedBefore = h.logger.state().dropped;
    bad = false;
    h.advance(60_001);
    h.logger.log("recovered"); // 队列已满：这一行入队时还会再挤掉最旧的 1 条
    await settle();
    const text = h.allLines().join("");
    const floods = [...text.matchAll(/flood-(\d+)\n/g)].map((m) => Number(m[1]));
    expect(floods.at(-1)).toBe(199); // 最新的在
    expect(floods[0]).toBeGreaterThan(0); // 最旧的被丢了
    expect(floods).toEqual(Array.from({ length: floods.length }, (_, i) => floods[0]! + i)); // 留下的是连续的最新一段
    const m = /降级期间有 (\d+) 行日志因超出暂存上限被丢弃/.exec(text);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(droppedBefore);
    expect(Number(m![1])).toBeGreaterThanOrEqual(floods[0]!); // 至少包含 flood-0 … flood-(first-1)
  });

  it("目录建不出来 / createWriteStream 同步抛（权限被收）：log 不抛、记失败、3 次后降级", async () => {
    const mk = makeLogger({ mkdirError: () => errWithCode("EACCES") });
    for (let i = 0; i < 3; i += 1) expect(() => mk.logger.log("x")).not.toThrow();
    expect(mk.logger.state()).toMatchObject({ consecutiveErrors: 3, degraded: true, lastErrorCode: "EACCES" });

    const cs = makeLogger({ createThrows: () => errWithCode("EMFILE") });
    for (let i = 0; i < 3; i += 1) expect(() => cs.logger.log("x")).not.toThrow();
    expect(cs.logger.state()).toMatchObject({ degraded: true, lastErrorCode: "EMFILE" });
  });

  it("流已被销毁、error 事件还在路上时：下一行不写进坏流（会被悄悄吞掉），而是换新流；迟到的 error 事件仍记一次账", async () => {
    const h = makeLogger();
    h.logger.log("first");
    await settle();
    h.streams[0]!.destroyed = true; // 模拟：写失败后流已销毁、error 事件尚未派发
    h.logger.log("must-not-be-swallowed");
    await settle();
    expect(h.fsx.createWriteStream).toHaveBeenCalledTimes(2);
    expect(h.lines(1)).toEqual(["[T] must-not-be-swallowed\n"]);
    h.streams[0]!.emit("error", errWithCode("EIO")); // 迟到的 error
    expect(h.logger.state().lastErrorCode).toBe("EIO");
    expect(h.logger.state().hasStream).toBe(true); // 当前流（新的）不受旧流 error 影响
  });
});

describe("C. 轮转", () => {
  // 一行 `[T] ` + 16 字符 + `\n` = 21 字节；maxBytes=400 → 第 20 行写完累计 420 ≥ 400 触发轮转
  const OPTS = { maxBytes: 400 };
  const MSG = "0123456789abcdef";
  const fill = (h: ReturnType<typeof makeLogger>, n: number): void => {
    for (let i = 0; i < n; i += 1) h.logger.log(MSG);
  };

  it("运行中累计写够上限：先 end() 等旧流 close，**之后**才 rm 最老备份 + rename；新流打开、第一行是轮转说明", async () => {
    const h = makeLogger({}, OPTS);
    h.sizes.set(FILE, 0);
    fill(h, 19); // 399 字节：差 1 字节
    await settle();
    expect(h.fsx.renameSync).not.toHaveBeenCalled();
    fill(h, 1); // 420 ≥ 400
    await settle();
    const t = h.timeline.filter((e) => !e.startsWith("mkdir"));
    expect(t).toEqual(["create:0", "close:0", "rm:main.log.1", "rename:main.log->main.log.1", "create:1"]);
    expect(h.lines(0)).toHaveLength(20); // 触发轮转的那一行也写进了旧流
    expect(h.lines(1)[0]).toContain("main.log 已轮转（单文件上限 0MB、保留 1 份）");
  });

  it("边界：累计恰好等于上限就轮转（≥，不是 >）", async () => {
    const h = makeLogger({}, { maxBytes: 420 }); // 20 行 × 21 字节 = 420，恰好等于上限
    h.sizes.set(FILE, 0);
    fill(h, 19);
    await settle();
    expect(h.fsx.renameSync).not.toHaveBeenCalled();
    fill(h, 1);
    await settle();
    expect(h.fsx.renameSync).toHaveBeenCalledTimes(1);
  });

  it("轮转期间同步来的新行：不丢、顺序不变，全部进新流", async () => {
    const h = makeLogger({}, OPTS);
    h.sizes.set(FILE, 0);
    fill(h, 20); // 触发轮转（旧流 end() 已调用、close 还没到）
    expect(h.logger.state().rotating).toBe(true);
    for (let i = 1; i <= 20; i += 1) h.logger.log(`x${i}`);
    expect(h.streams).toHaveLength(1); // 还没开新流
    await settle();
    const newLines = h.lines(1);
    expect(newLines[0]).toContain("已轮转");
    expect(newLines.slice(1)).toEqual(Array.from({ length: 20 }, (_, i) => `[T] x${i + 1}\n`));
    expect(h.logger.state()).toMatchObject({ rotating: false, queued: 0, dropped: 0 });
  });

  it("保留份数：keep=2 时 .1 → .2、主文件 → .1，最老的 .2 先删；不存在的备份（ENOENT）不算错", async () => {
    const h = makeLogger({}, { ...OPTS, keep: 2 });
    h.sizes.set(FILE, 0);
    h.sizes.set(`${FILE}.1`, 77); // 上一次轮转留下的
    fill(h, 20);
    await settle();
    const t = h.timeline.filter((e) => /^(rm|rename)/.test(e));
    expect(t).toEqual(["rm:main.log.2", "rename:main.log.1->main.log.2", "rename:main.log->main.log.1"]);
    expect(h.sizes.get(`${FILE}.2`)).toBe(77);
    expect(h.sizes.has(`${FILE}.1`)).toBe(true);

    // 首次轮转（没有 .1）：ENOENT 被忽略
    const h2 = makeLogger({}, { ...OPTS, keep: 2 });
    h2.sizes.set(FILE, 0);
    fill(h2, 20);
    await settle();
    expect(h2.timeline).toContain("rename:main.log->main.log.1");
    expect(h2.logger.state().rotateBackoffUntil).toBe(0);
  });

  it("rename 失败（Windows 上被杀软 / 编辑器占着 → EBUSY）：不丢日志、继续往原文件追加；10 分钟内不再重试，到点再试", async () => {
    const h = makeLogger({ renameError: () => errWithCode("EBUSY") }, OPTS);
    h.sizes.set(FILE, 0);
    fill(h, 20);
    await settle();
    expect(h.fsx.renameSync).toHaveBeenCalledTimes(1);
    expect(h.streams).toHaveLength(2); // 仍然打开了新流（同一路径、追加）
    expect(h.fsx.createWriteStream).toHaveBeenLastCalledWith(FILE, { flags: "a" });
    expect(h.lines(1)[0]).toContain("轮转失败（EBUSY）");
    expect(h.logger.state().rotating).toBe(false);

    fill(h, 25); // 文件仍然超限：退避期内不再尝试
    await settle();
    expect(h.fsx.renameSync).toHaveBeenCalledTimes(1);

    h.advance(10 * 60_000 + 1);
    fill(h, 1);
    await settle();
    expect(h.fsx.renameSync).toHaveBeenCalledTimes(2);
  });

  it("启动时（第一次打开前）就量一次：上次遗留的超限文件在这时轮转掉，之后才开流、第一行是轮转说明；没超限不动，以磁盘上的大小为起点累计", async () => {
    const h = makeLogger({}, OPTS);
    h.sizes.set(FILE, 5000);
    h.logger.log("boot");
    await settle();
    expect(h.timeline.filter((e) => !e.startsWith("mkdir"))).toEqual(["rm:main.log.1", "rename:main.log->main.log.1", "create:0"]);
    expect(h.lines(0)[0]).toContain("已轮转");
    expect(h.lines(0)[1]).toBe("[T] boot\n");
    expect(h.logger.state().fileBytes).toBeLessThan(400);

    const small = makeLogger({}, OPTS);
    small.sizes.set(FILE, 300);
    small.logger.log("boot");
    await settle();
    expect(small.fsx.renameSync).not.toHaveBeenCalled();
    expect(small.logger.state().fileBytes).toBe(300 + "[T] boot\n".length);
  });

  it("启动时轮转失败（rename 抛 EBUSY）同样退避：之后流自愈重开时 10 分钟内不再重试，到点再试", async () => {
    const h = makeLogger({ renameError: () => errWithCode("EBUSY"), failWrites: (i) => (i <= 1 ? [1] : []) }, OPTS);
    h.sizes.set(FILE, 5000); // 上次运行遗留的超限文件
    h.logger.log("boot");
    expect(h.fsx.renameSync).toHaveBeenCalledTimes(1); // 启动轮转：失败
    expect(h.logger.state().rotateBackoffUntil).toBeGreaterThan(0);
    await settle(); // 流 0 的第一次写入失败 → 坏流被丢弃
    h.logger.log("second"); // 换新流（流 1）：文件仍然超限，但在退避期内不再尝试轮转
    await settle();
    expect(h.streams).toHaveLength(2);
    expect(h.fsx.renameSync).toHaveBeenCalledTimes(1);
    h.advance(10 * 60_000 + 1); // 流 1 也在第一次写入时失败 → 下一行再换流；这回退避已过
    h.logger.log("third");
    await settle();
    expect(h.streams).toHaveLength(3);
    expect(h.fsx.renameSync).toHaveBeenCalledTimes(2);
  });

  it("量不到大小（statSync 抛）：按 0 起算、不抛、日志不丢", async () => {
    const h = makeLogger({}, OPTS); // sizes 里没有 FILE → statSync 抛 ENOENT
    for (let i = 0; i < 5; i += 1) expect(() => h.logger.log(MSG)).not.toThrow();
    await settle();
    expect(h.fsx.renameSync).not.toHaveBeenCalled();
    expect(h.allLines()).toHaveLength(5);
    expect(h.logger.state().fileBytes).toBe(5 * 21);
  });

  it("轮转窗口内旧流报错（磁盘满）：不抛、轮转仍走完、之后继续写", async () => {
    const h = makeLogger({}, OPTS);
    h.sizes.set(FILE, 380); // 起点 380 + 一行 21 = 401 ≥ 400 → 这一行就触发轮转
    h.logger.log(MSG);
    expect(h.logger.state().rotating).toBe(true);
    expect(() => h.streams[0]!.emit("error", errWithCode("ENOSPC"))).not.toThrow(); // 旧流在等 close 时报错
    await settle();
    h.logger.log("after");
    await settle();
    expect(h.logger.state().rotating).toBe(false);
    expect(h.allLines().join("")).toContain("after");
    expect(h.fsx.renameSync).toHaveBeenCalledTimes(1); // 轮转没有因为旧流报错而丢掉
  });
});

describe("F. logSync（致命路径：同步追加、不经队列 / 流）", () => {
  it("同步追加一行 `[时间] 参数` 到 main.log，并回显 console；不碰流、不起队列", () => {
    const h = makeLogger();
    h.logger.logSync("[fatal]", "uncaughtException:", "boom");
    expect(h.appended).toEqual([[FILE, "[T] [fatal] uncaughtException: boom\n"]]); // 调用返回时就已经写完（同步）
    expect(h.consoleImpl.log).toHaveBeenCalledWith("[T] [fatal] uncaughtException: boom");
    expect(h.fsx.createWriteStream).not.toHaveBeenCalled();
    expect(h.logger.state()).toMatchObject({ queued: 0, hasStream: false });
  });

  it("目录被删了也能写（先 mkdir -p）；磁盘满 / 权限被收时静默——致命路径里不能再抛", () => {
    const h = makeLogger();
    h.logger.logSync("x");
    expect(h.timeline).toContain("mkdir:/logs");
    const bad = makeLogger({ appendError: () => errWithCode("ENOSPC") });
    expect(() => bad.logger.logSync("x")).not.toThrow();
    const noDir = makeLogger({ mkdirError: () => errWithCode("EACCES") });
    expect(() => noDir.logger.logSync("x")).not.toThrow();
    const badConsole = makeLogger();
    badConsole.consoleImpl.log.mockImplementation(() => {
      throw errWithCode("EPIPE");
    });
    badConsole.logger.logSync("still written");
    expect(badConsole.appended).toHaveLength(1);
  });

  it("与普通 log 并存：流里的行和同步追加的行最终都在文件里（真实文件系统；顺序以时间戳为准、不保证）", async () => {
    const dir = fsReal.mkdtempSync(path.join(os.tmpdir(), "shell-log-sync-"));
    try {
      const file = path.join(dir, "logs", "main.log");
      const logger = createShellLogger({ getLogFile: () => file, console: { log: () => undefined, warn: () => undefined } });
      logger.log("via-stream-1");
      logger.logSync("via-sync");
      expect(fsReal.readFileSync(file, "utf8")).toContain("via-sync"); // 同步：这一刻就读得到
      logger.log("via-stream-2");
      for (let i = 0; i < 100; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
        if (logger.state().queued === 0 && fsReal.readFileSync(file, "utf8").includes("via-stream-2")) break;
      }
      const text = fsReal.readFileSync(file, "utf8");
      for (const needle of ["via-stream-1", "via-sync", "via-stream-2"]) expect(text).toContain(needle);
    } finally {
      fsReal.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("D. 真实文件系统", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fsReal.rmSync(d, { recursive: true, force: true });
  });
  const mkTmp = (): string => {
    const d = fsReal.mkdtempSync(path.join(os.tmpdir(), "shell-log-"));
    dirs.push(d);
    return d;
  };
  const quiet = { log: () => undefined, warn: () => undefined };
  const drained = async (logger: { state: () => { queued: number; rotating: boolean } }): Promise<void> => {
    for (let i = 0; i < 200; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      const s = logger.state();
      if (s.queued === 0 && !s.rotating) break;
    }
    await new Promise((r) => setTimeout(r, 30));
  };
  const readAll = (file: string): string => (fsReal.existsSync(file) ? fsReal.readFileSync(file, "utf8") : "");

  it("只发生一次轮转时：.1 + 主文件合起来一行不少、顺序不变", async () => {
    const dir = mkTmp();
    const file = path.join(dir, "logs", "main.log");
    const logger = createShellLogger({ getLogFile: () => file, console: quiet, maxBytes: 30_000 });
    for (let i = 0; i < 600; i += 1) {
      logger.log(`line-${i} ${"x".repeat(30)}`);
      if (i % 50 === 0) await new Promise((r) => setImmediate(r));
    }
    await drained(logger);
    expect(fsReal.existsSync(`${file}.1`)).toBe(true);
    const merged = (readAll(`${file}.1`) + readAll(file))
      .split("\n")
      .filter((l) => l.includes("line-"))
      .map((l) => Number(/line-(\d+) /.exec(l)![1]));
    expect(merged).toEqual(Array.from({ length: 600 }, (_, i) => i));
    expect(readAll(`${file}.1`) + readAll(file)).toContain("main.log 已轮转");
  });

  it("多次轮转：只留 keep 份（没有 .2）、每个文件大小有界、最新的一行一定在", async () => {
    const dir = mkTmp();
    const file = path.join(dir, "logs", "main.log");
    const maxBytes = 3000;
    const logger = createShellLogger({ getLogFile: () => file, console: quiet, maxBytes, keep: 1 });
    for (let i = 0; i < 1500; i += 1) {
      logger.log(`line-${i} ${"x".repeat(40)}`);
      if (i % 50 === 49) await drained(logger); // 每 50 行等一次落盘 / 轮转完成：积压有界
    }
    await drained(logger);
    expect(fsReal.existsSync(`${file}.1`)).toBe(true);
    expect(fsReal.existsSync(`${file}.2`)).toBe(false);
    // 要证明的是「有界」：不轮转的话这里会是 ~105KB；单文件 ≤ 上限 + 一批（50 行 ≈ 3.5KB），这里放宽到 3 倍上限
    const bound = maxBytes * 3;
    expect(fsReal.statSync(file).size).toBeLessThanOrEqual(bound);
    expect(fsReal.statSync(`${file}.1`).size).toBeLessThanOrEqual(bound);
    expect(readAll(file)).toContain("line-1499 ");
  });

  it("坏路径（main.log 是个目录 → EISDIR 的异步 error）→ 不抛、降级；路径修好、到点后自愈并补写积压的行", async () => {
    const dir = mkTmp();
    const file = path.join(dir, "logs", "main.log");
    fsReal.mkdirSync(file, { recursive: true }); // 把 main.log 占成目录
    let t = 5_000_000;
    const logger = createShellLogger({ getLogFile: () => file, console: quiet, nowMs: () => t });
    for (let i = 0; i < 3; i += 1) {
      logger.log(`pre-${i}`); // 这几行已交给坏流：流报错后不重发（不知道是否已落盘，重发会重复）
      await new Promise((r) => setTimeout(r, 30)); // 让真实的异步 error 事件派发
    }
    expect(logger.state()).toMatchObject({ degraded: true });
    expect(logger.state().lastErrorCode).toBe("EISDIR");
    logger.log("during-1"); // 降级期间的行进内存队列
    logger.log("during-2");
    fsReal.rmSync(file, { recursive: true });
    t += 61_000;
    logger.log("recovered");
    await drained(logger);
    const text = readAll(file);
    expect(text.indexOf("during-1")).toBeGreaterThanOrEqual(0); // 降级期间排队的行补写进来了
    expect(text.indexOf("during-1")).toBeLessThan(text.indexOf("during-2"));
    expect(text.indexOf("during-2")).toBeLessThan(text.indexOf("recovered"));
    expect(text).toContain("连续 3 次写入失败");
  });
});

describe("E. main.js 接线（源码契约）", () => {
  it("log 来自 createShellLogger；不再内联「无 error 监听」的 createWriteStream(main.log)；log 仍是行首 const（切片脚手架依赖）", () => {
    expect(mainSrc).toMatch(/^import \{[^}]*createShellLogger[^}]*\} from "\.\/shell-log\.mjs";$/m);
    expect(mainSrc).toMatch(/^const shellLogger = createShellLogger\(\{/m);
    expect(mainSrc).toMatch(/^const log = shellLogger\.log;$/m);
    expect(mainSrc).not.toMatch(/let logStream\b/);
    expect(mainSrc).not.toMatch(/createWriteStream\(file, \{ flags: "a" \}\)/);
    // main.log 的路径仍是 userData/logs/main.log（诊断包、installer.log 同目录）
    expect(mainSrc).toMatch(/path\.join\(app\.getPath\("userData"\), "logs", "main\.log"\)/);
  });

  it("stdout / stderr 的 error 监听（从终端 / 管道启动、对端关掉后的 EPIPE）：两条流都挂「error」，监听吞掉且不再 console.log；缺流不抛（真跑 main.js 里那一行）", () => {
    const line = mainSrc.split("\n").find((l) => l.startsWith("for (const stream of [process.stdout, process.stderr])"));
    expect(line).toBeDefined();
    const mkStream = () => {
      const handlers: Array<[string, () => void]> = [];
      const s = {
        handlers,
        on(ev: string, fn: () => void) {
          handlers.push([ev, fn]);
          return s;
        },
      };
      return s;
    };
    const stdout = mkStream();
    const stderr = mkStream();
    const consoleSpy = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    new Function("process", "console", line as string)({ stdout, stderr }, consoleSpy);
    for (const s of [stdout, stderr]) {
      expect(s.handlers.map(([ev]) => ev)).toEqual(["error"]);
      expect(() => s.handlers[0]?.[1]()).not.toThrow();
    }
    expect(consoleSpy.log).not.toHaveBeenCalled();
    expect(consoleSpy.error).not.toHaveBeenCalled();
    // 某些环境里 process.stdout 不存在、process.stderr 没有 .on：不抛
    expect(() => new Function("process", line as string)({ stdout: undefined, stderr: {} })).not.toThrow();
  });

  it("uncaughtExceptionMonitor：只记录（同步追加 logSync），监听里不抛、没有 stack 的值也能写（真跑 main.js 里那段语句）", () => {
    const start = mainSrc.indexOf('process.on("uncaughtExceptionMonitor"');
    expect(start).toBeGreaterThan(0);
    const end = mainSrc.indexOf("\n});", start);
    expect(end).toBeGreaterThan(start);
    const stmt = mainSrc.slice(start, end + 4);
    type Handler = (err: unknown, origin: string) => void;
    const box: { handler?: Handler } = {};
    const fakeProcess = {
      on: (ev: string, fn: Handler) => {
        if (ev === "uncaughtExceptionMonitor") box.handler = fn;
      },
    };
    const logSync = vi.fn();
    new Function("process", "shellLogger", stmt)(fakeProcess, { logSync });
    expect(box.handler).toBeTypeOf("function");
    const err = new Error("boom");
    box.handler?.(err, "uncaughtException");
    expect(logSync).toHaveBeenLastCalledWith(`[fatal] uncaughtException: ${err.stack}`);
    box.handler?.("just a string", "unhandledRejection");
    expect(logSync).toHaveBeenLastCalledWith("[fatal] unhandledRejection: just a string");
    expect(() => box.handler?.(undefined, "uncaughtException")).not.toThrow();
  });
});

describe("G. 终审补测（R14 B2-4b 审查 P3：只钉住已有行为，不改 src）", () => {
  it("默认值与 HANDOFF 决策依据对得上：单文件 20MB × 保留 1 份；连续 3 次失败降级、暂停 60s、暂存 1000 行；轮转失败退避 10 分钟", () => {
    expect(DEFAULT_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(DEFAULT_KEEP).toBe(1);
    expect(DEFAULT_ERRORS_BEFORE_DEGRADE).toBe(3);
    expect(DEFAULT_DEGRADE_RETRY_MS).toBe(60_000);
    expect(DEFAULT_ROTATE_RETRY_MS).toBe(10 * 60_000);
    expect(DEFAULT_MAX_QUEUED_LINES).toBe(1000);
  });

  it("累计字节按 UTF-8 字节数算（中文 3 字节 / 字），不是字符数：`[T] 中文日志` + 换行 = 17 字节（按字符数会是 9，中文多的日志要到 ~3 倍大才轮转）", async () => {
    const h = makeLogger();
    h.logger.log("中文日志");
    await settle();
    expect(h.logger.state().fileBytes).toBe(17);
  });

  it("write 同步抛错：坏流立即销毁（不留着泄漏文件句柄），当前流置空", async () => {
    const h = makeLogger();
    h.logger.log("first");
    await settle();
    const bad = h.streams[0]!;
    bad.write = () => {
      throw errWithCode("EPIPE", "write threw");
    };
    h.logger.log("boom");
    expect(bad.destroyed).toBe(true);
    expect(h.logger.state().hasStream).toBe(false);
  });

  it("没降级时不写「降级期间…」的丢弃说明：轮转窗口里队列溢出也一样（文案只对降级成立）", async () => {
    const h = makeLogger({}, { maxBytes: 400, maxQueuedLines: 5 });
    for (let i = 0; i < 20; i += 1) h.logger.log("0123456789abcdef"); // 累计 420 ≥ 400 → 开始轮转
    expect(h.logger.state().rotating).toBe(true);
    for (let i = 0; i < 12; i += 1) h.logger.log(`during-rotation-${i}`); // 轮转窗口里同步进来的行：超出 5 行暂存上限
    expect(h.logger.state().dropped).toBeGreaterThan(0);
    await settle();
    await settle();
    expect(h.logger.state().degraded).toBe(false);
    expect(h.allLines().join("")).not.toContain("降级期间");
  });

  it("丢弃说明里的计数只算本次降级：第二次降级丢的行数不会叠加上一次的", async () => {
    // 流 0/1/2 各自第一次写失败 → 第一次降级；恢复（流 3）后手动报一次错，流 4/5 再各失败一次 → 第二次降级
    const h = makeLogger({ failWrites: (i) => (i < 3 || i === 4 || i === 5 ? [1] : []) }, { maxQueuedLines: 10 });
    const counts = (): number[] =>
      [...h.allLines().join("").matchAll(/降级期间有 (\d+) 行日志因超出暂存上限被丢弃/g)].map((m) => Number(m[1]));
    for (let i = 0; i < 3; i += 1) {
      h.logger.log(`d${i}`);
      await settle();
    }
    expect(h.logger.state().degraded).toBe(true);
    for (let i = 0; i < 60; i += 1) h.logger.log(`a-${i}`); // 第一次降级：丢 ≥ 50 行
    h.advance(60_001);
    h.logger.log("recover-1");
    await settle();
    h.logger.log("tick-1"); // 「已恢复写入」说明行在写成功的回调里入队，下一行日志带出
    await settle();
    expect(h.logger.state()).toMatchObject({ degraded: false, consecutiveErrors: 0 });
    h.streams.at(-1)!.emit("error", errWithCode("ENOSPC")); // 第二轮失败 #1
    h.logger.log("e1");
    await settle(); // 流 4 第一次写失败 → #2
    h.logger.log("e2");
    await settle(); // 流 5 → #3 → 第二次降级
    expect(h.logger.state().degraded).toBe(true);
    for (let i = 0; i < 20; i += 1) h.logger.log(`b-${i}`); // 第二次降级：只丢 ~10 行
    h.advance(60_001);
    h.logger.log("recover-2");
    await settle();
    h.logger.log("tick-2");
    await settle();
    const c = counts();
    expect(c).toHaveLength(2);
    expect(c[1]!).toBeLessThan(c[0]!); // 不叠加：第二次丢得少，数字就该更小
  });

  it("从降级恢复后状态复位：之后偶发一次失败再成功，不会再写一次「已恢复写入」", async () => {
    const h = makeLogger({ failWrites: (i) => (i < 3 ? [1] : []) });
    for (let i = 0; i < 3; i += 1) {
      h.logger.log(`pre${i}`);
      await settle();
    }
    h.advance(60_001);
    h.logger.log("after");
    await settle();
    h.logger.log("tick-1");
    await settle();
    const recovered = (): number => (h.allLines().join("").match(/main\.log 已恢复写入/g) ?? []).length;
    expect(recovered()).toBe(1);
    h.streams.at(-1)!.emit("error", errWithCode("EIO")); // 偶发一次失败（没到降级阈值）
    h.logger.log("next");
    await settle(); // 新流写成功 → 失败计数清零
    h.logger.log("tick-2");
    await settle();
    expect(recovered()).toBe(1);
  });

  it("轮转时旧流已经 closed（close 事件早发过了）：不等它再发，直接改名——否则 rotating 卡死、日志从此停写", async () => {
    const h = makeLogger({}, { maxBytes: 400 });
    h.logger.log("warm-up");
    await settle();
    const old = h.streams[0]!;
    old.closed = true; // 已经关掉了
    old.end = () => undefined; // 再 end() 也不会有 close 事件
    for (let i = 0; i < 20; i += 1) h.logger.log("0123456789abcdef"); // 累计 ≥ 400 → 轮转
    await settle();
    expect(h.fsx.renameSync).toHaveBeenCalledTimes(1);
    expect(h.logger.state().rotating).toBe(false);
    h.logger.log("after-rotate");
    await settle();
    expect(h.allLines().join("")).toContain("after-rotate");
  });
});
