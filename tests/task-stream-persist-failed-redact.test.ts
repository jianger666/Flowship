/**
 * F4（mock 版）：事件没落盘时推给订阅者的「副本」必须自己再脱敏
 * （R14 B2-2 / task-stream.ts 的 `handleEventPersistFailed` 里的 `redactCopyIfHit`）。
 *
 * 为什么必须在推送这一步自己脱敏：落盘前的脱敏是 appendFile 的**参数求值时**原地做的（serializeEventLineRedacted）——
 * 写盘链路在那之前就失败（序列化前抛错、`ensureEventSeqCounter` 读盘失败）时，事件根本没被脱敏过；
 * 而 `publish` 内部的 `redactStreamEvent` 对普通 event 帧默认「已在落盘时脱敏」、不再扫（只兜 `tool_output_delta` / `ephemeral_` 开头的）。
 * 所以没落盘的副本一旦不自己脱敏，gitToken / apiKey 就会明文进 SSE、飞书回流。
 *
 * 做法：
 *   - mock `@/lib/server/task-fs` 的 `appendEvent`：被调用时补 id / ts（和真实 appendEvent 一样、**无 seq**）→ 先
 *     `onPersistFailed(event, err)` 再 throw（= appendEventLine 写盘失败路径的契约）；其余导出保持真实；
 *   - 凭据走真实链路：往临时数据目录写 config.json（tmp+rename，换 inode → 缓存按 stat 指纹必失效），`redactCopyIfHit` 真读它；
 *   - `redactCopyIfHit` 包一层可控 mock（默认转发真实实现；(c) 里让它抛错，并断言它确实是在「推送前」被调用的）；
 *   - 事件 kind 一律取 `tool_result` / `assistant_message`、id 取普通 `e_…`：**不得**是 `tool_output_delta` / `ephemeral_` 开头，
 *     否则 publish 的兜底脱敏会替它遮住明文，删掉 `handleEventPersistFailed` 里的 `redactCopyIfHit` 也不会红。
 *
 * 断言要点：既要「帧里不含明文」，也要**正向**断言事件帧存在、文本恰等于脱敏后的值——
 * 否则「把脱敏那行整个删掉（safe 为 null → 不推帧）」这种改坏会让 not.toContain 空转通过。
 *
 * DATA_DIR 在 task-fs-core 加载时冻结：先钉 FLOWSHIP_DATA_DIR 再动态 import 被测模块。
 */
import { mkdtempSync, promises as fsp, rmSync } from "node:fs";
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

import { describeStorageDegraded } from "@/lib/storage-degraded";
import type { TaskStreamEvent } from "@/lib/server/task-stream";
import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-persist-failed-redact-"),
);
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockAppendEvent = vi.fn();
const mockRedactCopyIfHit = vi.fn();

vi.mock("@/lib/server/task-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-fs")>();
  return {
    ...actual,
    appendEvent: (...args: unknown[]) => mockAppendEvent(...args),
  };
});
vi.mock("@/lib/server/event-secret-redact", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/event-secret-redact")>();
  return {
    ...actual,
    redactCopyIfHit: (value: unknown) => mockRedactCopyIfHit(value) as unknown,
  };
});

const actualRedact = await vi.importActual<
  typeof import("@/lib/server/event-secret-redact")
>("@/lib/server/event-secret-redact");
const stream = await import("@/lib/server/task-stream");

const { REDACTED_GIT_TOKEN } = actualRedact;

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ───────────────────────── 夹具 ─────────────────────────

const FAKE_TOKEN = "glpat-FAKEFAKEFAKE1234567890";

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated`), { code });

/** 写（或覆盖）临时数据目录下的 config.json；tmp+rename 模拟生产的原子写（换 inode，脱敏缓存必失效） */
const writeConfig = async (cfg: Record<string, unknown>): Promise<void> => {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, "config.json");
  const tmp = `${file}.tmp-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, JSON.stringify(cfg), "utf-8");
  await fsp.rename(tmp, file);
};
const clearCredentialFiles = (): void => {
  for (const f of [
    "config.json",
    "config.json.bak",
    "config.json.bak.shrink",
    "company-env.json",
  ]) {
    rmSync(path.join(DATA_DIR, f), { force: true });
  }
};

let taskCounter = 0;
const newTaskId = (): string =>
  `t_redact_mock_${Date.now()}_${(taskCounter += 1)}`;

/**
 * 让 `appendEvent` 模拟「appendFile 写盘失败」：补 id / ts（无 seq——appendEventLine 失败路径已摘掉）→
 * 先 `onPersistFailed(event, err)` 再 throw err。
 */
let eventCounter = 0;
const failPersistWith = (err: unknown): void => {
  mockAppendEvent.mockImplementation(
    async (
      _taskId: string,
      ev: Record<string, unknown>,
      _lease?: unknown,
      _onCommitted?: unknown,
      onPersistFailed?: (event: TaskEvent, err: unknown) => void,
    ) => {
      eventCounter += 1;
      const event = {
        id: `e_mock_${eventCounter}`,
        ts: 1_700_000_000_000 + eventCounter,
        ...ev,
      } as unknown as TaskEvent;
      onPersistFailed?.(event, err);
      throw err;
    },
  );
};

const unsubs: Array<() => void> = [];
const subscribe = (taskId: string): TaskStreamEvent[] => {
  const frames: TaskStreamEvent[] = [];
  unsubs.push(stream.subscribeTaskStream(taskId, (f) => frames.push(f)));
  return frames;
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

const eventFramesOf = (frames: TaskStreamEvent[]) =>
  frames.flatMap((f) => (f.kind === "event" ? [f] : []));

type Writer = (taskId: string, text: string) => Promise<TaskEvent | null>;
const WRITERS: Array<[string, Writer]> = [
  [
    "writeEventAndPublish",
    (taskId, text) =>
      stream.writeEventAndPublish(taskId, { kind: "tool_result", text } as never),
  ],
  [
    "writeOwnedEventAndPublish",
    (taskId, text) =>
      stream.writeOwnedEventAndPublish(taskId, () => true, {
        kind: "tool_result",
        text,
      } as never),
  ],
];

beforeEach(() => {
  // 默认：脱敏转发真实实现（只在 (c) 里换成抛错）
  mockRedactCopyIfHit.mockImplementation((value: unknown) =>
    actualRedact.redactCopyIfHit(value),
  );
  // 写盘失败路径里 writeEventAndPublish / writeOwnedEventAndPublish 会 console.warn（吞错）；静音
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  mockAppendEvent.mockReset();
  mockRedactCopyIfHit.mockReset();
  stream.__resetStorageDegradedForTests();
  vi.useRealTimers();
  while (unsubs.length > 0) unsubs.pop()?.();
  clearCredentialFiles();
});

// ───────────────────────── 自检 / 对照 ─────────────────────────

describe("前提自检：下面的「不含明文」断言不是在空转", () => {
  it("自检：config.json 里配的 gitToken 确实被事件脱敏认得（命中后返回换了占位符的副本）", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    const ev = {
      id: "e_selfcheck",
      ts: 1,
      kind: "tool_result",
      text: `t=${FAKE_TOKEN}`,
    } as TaskEvent;
    const safe = actualRedact.redactCopyIfHit(ev);
    expect(safe).not.toBe(ev);
    expect(safe.text).toBe(`t=${REDACTED_GIT_TOKEN}`);
  });

  it("对照：publish 本身不替普通 event 帧脱敏（只兜 tool_output_delta / ephemeral_）——所以未落盘副本必须自己脱敏，下面各用例才真有牵制力", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    const taskId = newTaskId();
    const frames = subscribe(taskId);
    stream.publish(taskId, {
      kind: "event",
      event: {
        id: "e_plain_1",
        ts: 1,
        kind: "tool_result",
        text: `t=${FAKE_TOKEN}`,
      },
    });
    // 明文原样出去了——这正是 handleEventPersistFailed 不能省掉脱敏的原因
    expect(JSON.stringify(frames)).toContain(FAKE_TOKEN);
  });
});

// ───────────────────────── (a) writeEventAndPublish ─────────────────────────

describe("(a) writeEventAndPublish：未落盘事件的推送副本脱敏", () => {
  it("(a) 落盘失败（ENOSPC）：推给订阅者的事件副本不含明文 gitToken（text / 嵌套字段都换成占位符）、无 seq；并置降级标志、发 sd:true 与 toast", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    failPersistWith(errno("ENOSPC"));
    const taskId = newTaskId();
    const frames = subscribe(taskId);

    const result = await stream.writeEventAndPublish(taskId, {
      kind: "tool_result",
      text: `curl -H "PRIVATE-TOKEN: ${FAKE_TOKEN}" https://gitlab.example.com/api/v4/projects`,
      meta: { cmd: `echo ${FAKE_TOKEN}`, args: ["--token", FAKE_TOKEN, 42] },
    } as never);

    // best-effort：吞错返回 null
    expect(result).toBeNull();
    // 帧序列：先推事件副本、再置标志（sd:true + 一条 toast）
    expect(frames.map(brief)).toEqual([
      "event:tool_result(无seq)",
      "sd:true/ENOSPC",
      "toast",
    ]);
    const [eventFrame] = eventFramesOf(frames);
    expect(eventFrame!.event.text).toBe(
      `curl -H "PRIVATE-TOKEN: ${REDACTED_GIT_TOKEN}" https://gitlab.example.com/api/v4/projects`,
    );
    expect(eventFrame!.event.meta).toEqual({
      cmd: `echo ${REDACTED_GIT_TOKEN}`,
      args: ["--token", REDACTED_GIT_TOKEN, 42],
    });
    expect("seq" in eventFrame!.event).toBe(false);
    expect(eventFrame!.event.id).toMatch(/^e_mock_/);
    expect("origin" in eventFrame!).toBe(false);
    // toast 文案 = 降级标题（不含任何凭据）；并且带 advisory:true（F8：仅提示、不代表 run 失败，飞书私聊桥据此不收尾回复卡片）。
    // 必须严格 toEqual：放宽成 toMatchObject / objectContaining，「去掉 advisory」的变异就会存活
    expect(frames.find((f) => f.kind === "error")).toEqual({
      kind: "error",
      message: describeStorageDegraded("ENOSPC").title,
      advisory: true,
    });
    // 整个推流里都没有明文
    expect(JSON.stringify(frames)).not.toContain(FAKE_TOKEN);
    expect(stream.getStorageDegraded(taskId)).toEqual({ code: "ENOSPC" });
    // 接线：脱敏在推送前恰好跑了一次、吃的是这条未脱敏的事件；appendEvent 收到了 onCommitted + onPersistFailed 两个回调
    expect(mockRedactCopyIfHit).toHaveBeenCalledTimes(1);
    expect(mockRedactCopyIfHit.mock.calls[0]![0]).toMatchObject({
      kind: "tool_result",
      text: expect.stringContaining(FAKE_TOKEN),
    });
    const appendArgs = mockAppendEvent.mock.calls[0] as unknown[];
    expect(typeof appendArgs[3]).toBe("function");
    expect(typeof appendArgs[4]).toBe("function");
  });

  it.each(["ENOSPC", "EDQUOT", "EROFS", "EIO", "EACCES", "EPERM", "EBUSY"])(
    "(a) 磁盘类错误码 %s：同样推脱敏副本、以该码置标志并发 sd:true",
    async (code) => {
      await writeConfig({ gitToken: FAKE_TOKEN });
      failPersistWith(errno(code));
      const taskId = newTaskId();
      const frames = subscribe(taskId);

      const result = await stream.writeEventAndPublish(taskId, {
        kind: "tool_result",
        text: `token=${FAKE_TOKEN}`,
      } as never);

      expect(result).toBeNull();
      expect(frames.map(brief)).toEqual([
        "event:tool_result(无seq)",
        `sd:true/${code}`,
        "toast",
      ]);
      expect(eventFramesOf(frames)[0]!.event.text).toBe(
        `token=${REDACTED_GIT_TOKEN}`,
      );
      expect(JSON.stringify(frames)).not.toContain(FAKE_TOKEN);
      expect(stream.getStorageDegraded(taskId)).toEqual({ code });
    },
  );

  it("没配任何凭据：未落盘事件原样推给订阅者（脱敏不能把事件吞掉），仍置标志", async () => {
    failPersistWith(errno("ENOSPC"));
    const taskId = newTaskId();
    const frames = subscribe(taskId);

    await stream.writeEventAndPublish(taskId, {
      kind: "tool_result",
      text: `看起来像 token 但没配：${FAKE_TOKEN}`,
    } as never);

    expect(frames.map(brief)).toEqual([
      "event:tool_result(无seq)",
      "sd:true/ENOSPC",
      "toast",
    ]);
    expect(eventFramesOf(frames)[0]!.event.text).toBe(
      `看起来像 token 但没配：${FAKE_TOKEN}`,
    );
    expect(stream.getStorageDegraded(taskId)).toEqual({ code: "ENOSPC" });
  });
});

// ───────────────────────── (b) writeOwnedEventAndPublish ─────────────────────────

describe("(b) writeOwnedEventAndPublish：未落盘事件的推送副本脱敏", () => {
  it("(b) 带 origin：副本脱敏、origin 原样带在事件帧上、事件仍带 groupRun 标；并置标志发 sd:true", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    failPersistWith(errno("EIO"));
    const taskId = newTaskId();
    const frames = subscribe(taskId);

    const result = await stream.writeOwnedEventAndPublish(
      taskId,
      () => true,
      {
        kind: "assistant_message",
        text: `回复里夹着 token=${FAKE_TOKEN}`,
      } as never,
      "origin-group-1",
    );

    expect(result).toBeNull();
    expect(frames.map(brief)).toEqual([
      "event:assistant_message(无seq)",
      "sd:true/EIO",
      "toast",
    ]);
    const [eventFrame] = eventFramesOf(frames);
    expect(eventFrame!.origin).toBe("origin-group-1");
    expect(eventFrame!.event.text).toBe(`回复里夹着 token=${REDACTED_GIT_TOKEN}`);
    expect(eventFrame!.event.meta).toEqual({ groupRun: "origin-group-1" });
    expect("seq" in eventFrame!.event).toBe(false);
    expect(JSON.stringify(frames)).not.toContain(FAKE_TOKEN);
    expect(stream.getStorageDegraded(taskId)).toEqual({ code: "EIO" });
    expect(mockRedactCopyIfHit).toHaveBeenCalledTimes(1);
  });

  it("(b) 不带 origin：副本脱敏、事件帧上没有 origin 字段（属主主链）；并置标志发 sd:true", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    failPersistWith(errno("EROFS"));
    const taskId = newTaskId();
    const frames = subscribe(taskId);

    const result = await stream.writeOwnedEventAndPublish(taskId, () => true, {
      kind: "tool_call",
      text: `git clone https://oauth2:${FAKE_TOKEN}@gitlab.example.com/x.git`,
    } as never);

    expect(result).toBeNull();
    expect(frames.map(brief)).toEqual([
      "event:tool_call(无seq)",
      "sd:true/EROFS",
      "toast",
    ]);
    const [eventFrame] = eventFramesOf(frames);
    expect("origin" in eventFrame!).toBe(false);
    expect(eventFrame!.event.text).toBe(
      `git clone https://oauth2:${REDACTED_GIT_TOKEN}@gitlab.example.com/x.git`,
    );
    expect(JSON.stringify(frames)).not.toContain(FAKE_TOKEN);
    expect(stream.getStorageDegraded(taskId)).toEqual({ code: "EROFS" });
  });
});

// ───────────────────────── (c) 脱敏本身抛错 ─────────────────────────

describe("(c) 脱敏本身抛错：宁可这一条不推，也不让明文外流", () => {
  it.each(WRITERS)(
    "(c) %s：redactCopyIfHit 抛错 → 订阅者没有 event 帧、console.error 记一笔、明文不外流；但仍置降级标志、仍发 sd:true 与 toast",
    async (_name, write) => {
      await writeConfig({ gitToken: FAKE_TOKEN });
      const boom = new Error("脱敏炸了");
      mockRedactCopyIfHit.mockImplementation(() => {
        throw boom;
      });
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      failPersistWith(errno("ENOSPC"));
      const taskId = newTaskId();
      const frames = subscribe(taskId);

      const result = await write(taskId, `token=${FAKE_TOKEN}`);

      expect(result).toBeNull();
      // 一条事件帧都没有；状态帧与 toast 照发
      expect(eventFramesOf(frames)).toEqual([]);
      expect(frames.map(brief)).toEqual(["sd:true/ENOSPC", "toast"]);
      expect(frames.find((f) => f.kind === "error")).toEqual({
        kind: "error",
        message: describeStorageDegraded("ENOSPC").title,
        advisory: true,
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("未落盘事件脱敏失败"),
        boom,
      );
      expect(JSON.stringify(frames)).not.toContain(FAKE_TOKEN);
      expect(stream.getStorageDegraded(taskId)).toEqual({ code: "ENOSPC" });
      // 脱敏确实是在推送前被调用过的（不是根本没走到）
      expect(mockRedactCopyIfHit).toHaveBeenCalledTimes(1);
    },
  );
});

// ───────────────────────── (d) 非磁盘类错误 ─────────────────────────

describe.each(WRITERS)(
  "(d) %s：非磁盘类写盘错误保持旧行为——调用方 warn、不推事件、不置标志",
  (name, write) => {
    const NON_DISK_ERRORS: Array<[string, unknown]> = [
      ["EINVAL", errno("EINVAL")],
      ["ENOENT", errno("ENOENT")],
      ["ETIMEDOUT", errno("ETIMEDOUT")],
      ["没有 code 的 Error", new Error("plain failure")],
      ["非 Error 的字符串", "just a string"],
    ];

    it.each(NON_DISK_ERRORS)("错误：%s", async (_label, err) => {
      await writeConfig({ gitToken: FAKE_TOKEN });
      failPersistWith(err);
      const taskId = newTaskId();
      const frames = subscribe(taskId);

      const result = await write(taskId, `token=${FAKE_TOKEN}`);

      expect(result).toBeNull();
      // onPersistFailed 什么都没做：订阅者一帧都没收到、标志没置、连脱敏都没跑
      expect(frames).toEqual([]);
      expect(stream.getStorageDegraded(taskId)).toBeNull();
      expect(mockRedactCopyIfHit).not.toHaveBeenCalled();
      // 旧行为：调用方（write*）把错误 warn 掉
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(`${name} 失败`),
        err,
      );
    });
  },
);
