/**
 * F4（真实读盘失败版，不 mock）：`ensureEventSeqCounter` 读盘失败时，推给订阅者的未落盘副本也必须脱敏
 * （R14 B2-2 / task-stream.ts 的 `handleEventPersistFailed` 里的 `redactCopyIfHit`；
 *  task-fs-core.ts 的 `appendEventLine` 在读盘失败路径上同样会 `onPersistFailed`）。
 *
 * 这是 F4 最原始的场景，也是 mock 版（task-stream-persist-failed-redact.test.ts）之外必须有真链路守着的原因：
 * 落盘前的脱敏发生在 appendFile 的**参数求值时**；`ensureEventSeqCounter` 读 events.jsonl 失败 = 链路在序列化之前就抛了，
 * 事件对象从头到尾没被脱敏过——此时 `publish` 对普通 event 帧又不再兜底（见 redactStreamEvent），
 * 只有 `handleEventPersistFailed` 自己的 `redactCopyIfHit` 能拦住 gitToken 明文。
 * （若是 appendFile 本身抛错，事件在求值参数时已被原地脱敏，删掉这行脱敏也看不出差别——所以这里专挑「序列化之前」的读盘失败。）
 *
 * 全程真实：真 `createTask`、真 `writeEventAndPublish` / `writeOwnedEventAndPublish`、真 `appendEventLine`、真读 config.json 取凭据；
 * 不 mock `appendEvent` / `redactCopyIfHit`。造读盘失败的两种办法：
 *   - 真 `chmod 000` events.jsonl → `scanMaxSeqFullFile` 的 createReadStream 抛 EACCES（**非 root、非 win32 才跑**；root 不受权限位约束、
 *     win32 的 chmod 近似 no-op）；afterEach 一律把权限还原成可读写，免得临时目录清理失败；
 *   - 不依赖权限位：放一个 `.event-seq` sidecar（= 0）让 `ensureEventSeqCounter` 走「尾扫」分支，再让 `fsp.stat` **只对本任务 events.jsonl**
 *     抛 EIO（其它路径透传）——所有平台、含 root 都能跑。
 * 每个用例用全新 taskId：seq counter 是 Map miss，才会走到读盘恢复。
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
  path.join(os.tmpdir(), "fe-persist-failed-redact-real-"),
);
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const core = await import("@/lib/server/task-fs-core");
const { createTask } = await import("@/lib/server/task-fs");
const stream = await import("@/lib/server/task-stream");
const { REDACTED_GIT_TOKEN, redactSecretsInText } = await import(
  "@/lib/server/event-secret-redact"
);

if (!core.taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`DATA_DIR 未隔离到 TMP：${core.taskDir("probe")}`);
}

/** chmod 000 类用例只在非 root、非 win32 才跑 */
const CAN_CHMOD = process.platform !== "win32" && process.getuid?.() !== 0;

const FAKE_TOKEN = "glpat-FAKEFAKEFAKE1234567890";

// spyOn 之前先存真实实现：不相关路径的调用转发给它
const realStat = fsp.stat.bind(fsp);

// ───────────────────────── 夹具 ─────────────────────────

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

const eventsFile = (id: string): string =>
  path.join(core.taskDir(id), core.EVENTS_FILE);

/** 本用例建过的任务：afterEach 里等它们的后台 meta 触碰落地 */
const createdTaskIds: string[] = [];
const mkTask = async (title: string) => {
  const t = await createTask({ title, mode: "chat" } as never);
  createdTaskIds.push(t.id);
  return t;
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

/** chmod 000 过的文件：afterEach 一律还原成可读写 */
const chmodded: string[] = [];

/** 把 events.jsonl 写成 `content` 并 chmod 000（读 → EACCES） */
const lockEventsFile = async (id: string, content: string): Promise<string> => {
  const file = eventsFile(id);
  await fsp.writeFile(file, content);
  await fsp.chmod(file, 0o000);
  chmodded.push(file);
  return file;
};

/**
 * 造读盘失败的办法二（不依赖权限位，所有平台含 root 都能用）：放 `.event-seq` sidecar（= 0）→ `ensureEventSeqCounter` 走「尾扫」分支 →
 * `readMaxSeqFromDurableTail` 先 `fs.stat(events.jsonl)`；让 `fsp.stat` 只对本任务 events.jsonl 抛 EIO（非 ENOENT，被原样重抛），其它路径透传。
 * 返回「解除故障」的函数。
 */
const prepareStatFailure = async (id: string): Promise<() => void> => {
  const file = eventsFile(id);
  await fsp.writeFile(file, "");
  await fsp.writeFile(
    path.join(core.taskDir(id), core.EVENT_SEQ_SIDECAR_FILE),
    "0",
  );
  const spy = vi.spyOn(fsp, "stat").mockImplementation(((
    ...args: Parameters<typeof fsp.stat>
  ) => {
    if (String(args[0]) === file) return Promise.reject(errno("EIO"));
    return realStat(...args);
  }) as never);
  return () => spy.mockRestore();
};

type WriteFn = (
  id: string,
  ev: Record<string, unknown>,
) => Promise<TaskEvent | null>;

// 恢复闭环对两个写入入口都验：成功路径的恢复判定（publishCommittedEvent → clearStorageDegradedOnCommit）在两处各接了一遍，
// 只验一处的话，另一处把成功路径改成裸 publish（不再清降级标志）就看不出来。第三项 = 该入口预期的 origin
const RECOVER_WRITERS: Array<[string, WriteFn, string | undefined]> = [
  [
    "writeEventAndPublish",
    (id, ev) => stream.writeEventAndPublish(id, ev as never),
    undefined,
  ],
  [
    "writeOwnedEventAndPublish（带 origin）",
    (id, ev) =>
      stream.writeOwnedEventAndPublish(
        id,
        () => true,
        ev as never,
        "origin-recover",
      ),
    "origin-recover",
  ],
];

/**
 * 「读盘失败 → 降级 → 故障解除 → 越过粘滞窗口后下一条成功落盘 → 恢复」整条闭环，chmod / stat-EIO 两种造法共用同一套断言。
 * `breakStorage` 造故障（events.jsonl 此时为空）并返回「解除故障」的函数；`code` = 预期的降级 errno。
 */
const runRecoverScenario = async (
  write: WriteFn,
  origin: string | undefined,
  code: string,
  breakStorage: (id: string) => Promise<() => void | Promise<void>>,
): Promise<void> => {
  await writeConfig({ gitToken: FAKE_TOKEN });
  const t = await mkTask("real-redact-recover");
  const heal = await breakStorage(t.id);
  const frames = subscribe(t.id);

  await write(t.id, {
    kind: "tool_result",
    text: `第一条 token=${FAKE_TOKEN}`,
  });
  expect(frames.map(brief)).toEqual([
    "event:tool_result(无seq)",
    `sd:true/${code}`,
    "toast",
  ]);
  // 失败帧上的 origin：该入口带就原样带、不带就没有这个键
  expect(eventFramesOf(frames)[0]!.origin).toBe(origin);

  await heal();
  // 粘滞：距最近一次写失败不足 10s 的成功写不算恢复——把假时钟推过它。只 fake Date（不碰 setTimeout / fs），先 createTask、后启用
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 10_001);
  const mark = frames.length;

  const second = await write(t.id, {
    kind: "tool_result",
    text: `第二条 token=${FAKE_TOKEN}`,
  });

  // 读失败发生在发号之前：恢复后首条 seq = 1
  expect(second?.seq).toBe(1);
  expect(frames.slice(mark).map(brief)).toEqual([
    "event:tool_result#1",
    "sd:false",
  ]);
  expect(eventFramesOf(frames.slice(mark))[0]!.origin).toBe(origin);
  expect(stream.getStorageDegraded(t.id)).toBeNull();
  // 落盘前的脱敏照常：盘上恰这一行、不含明文
  const raw = await fsp.readFile(eventsFile(t.id), "utf-8");
  expect(raw).not.toContain(FAKE_TOKEN);
  const lines = raw.split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  const row = JSON.parse(lines[0]!) as TaskEvent;
  expect(row.seq).toBe(1);
  expect(row.text).toBe(`第二条 token=${REDACTED_GIT_TOKEN}`);
  expect(JSON.stringify(frames)).not.toContain(FAKE_TOKEN);
};

beforeEach(() => {
  // 失败路径里 writeEventAndPublish / writeOwnedEventAndPublish 会 console.warn（吞错）；静音
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  stream.__resetStorageDegradedForTests();
  vi.useRealTimers();
  while (unsubs.length > 0) unsubs.pop()?.();
  for (const f of chmodded.splice(0)) {
    await fsp.chmod(f, 0o644).catch(() => {});
  }
  // 事件成功落盘后 appendEvent 会在后台排一个 meta.updatedAt 触碰（withTaskLock 内、best-effort）；
  // 等它落地，免得和 afterAll 删临时目录赛跑、打出 ENOENT 噪声（同 tests/ask-reply-zombie-r22-6.test.ts 的做法）
  for (const id of createdTaskIds.splice(0)) {
    await core.withTaskLock(id, async () => undefined);
  }
  clearCredentialFiles();
});

afterAll(async () => {
  await fsp
    .rm(TMP_ROOT, { recursive: true, force: true, maxRetries: 3 })
    .catch(() => {});
});

// ───────────────────────── 前提自检 ─────────────────────────

describe("前提自检", () => {
  it("自检：config.json 里配的 gitToken 确实被事件脱敏认得（否则下面「不含明文」的断言会在空转）", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    expect(redactSecretsInText(`x=${FAKE_TOKEN}`)).toBe(
      `x=${REDACTED_GIT_TOKEN}`,
    );
  });
});

// ───────────────────────── 真 chmod 000：EACCES ─────────────────────────

describe.skipIf(!CAN_CHMOD)(
  "events.jsonl chmod 000（真实读盘失败 EACCES）：ensureEventSeqCounter 抛，推送副本脱敏且置标志",
  () => {
    it("writeEventAndPublish：事件副本不含明文 gitToken（text / 嵌套字段都换成占位符）、无 seq；置 EACCES 降级、发 sd:true 与 toast；盘上这条没落（文件原样）", async () => {
      await writeConfig({ gitToken: FAKE_TOKEN });
      const t = await mkTask("real-redact-1");
      const file = await lockEventsFile(t.id, "");
      const frames = subscribe(t.id);

      const result = await stream.writeEventAndPublish(t.id, {
        kind: "tool_result",
        text: `curl -H "PRIVATE-TOKEN: ${FAKE_TOKEN}" https://gitlab.example.com/api/v4/projects`,
        meta: { cmd: `echo ${FAKE_TOKEN}`, args: ["--token", FAKE_TOKEN, 42] },
      } as never);

      expect(result).toBeNull();
      expect(frames.map(brief)).toEqual([
        "event:tool_result(无seq)",
        "sd:true/EACCES",
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
      expect("origin" in eventFrame!).toBe(false);
      // toast：降级标题 + advisory:true（F8：仅提示、不代表 run 失败）。严格 toEqual，不放宽成 toMatchObject（否则「去掉 advisory」的变异会存活）
      expect(frames.find((f) => f.kind === "error")).toEqual({
        kind: "error",
        message: describeStorageDegraded("EACCES").title,
        advisory: true,
      });
      expect(JSON.stringify(frames)).not.toContain(FAKE_TOKEN);
      expect(stream.getStorageDegraded(t.id)).toEqual({ code: "EACCES" });

      // 盘上：这条没落盘（恢复权限后文件仍是空的），当然也不含明文
      await fsp.chmod(file, 0o644);
      expect(await fsp.readFile(file, "utf-8")).toBe("");
    });

    it("writeOwnedEventAndPublish（带 origin）：同样脱敏副本；origin 原样带在事件帧上；置 EACCES 降级", async () => {
      await writeConfig({ gitToken: FAKE_TOKEN });
      const t = await mkTask("real-redact-2");
      const file = await lockEventsFile(t.id, "");
      const frames = subscribe(t.id);

      const result = await stream.writeOwnedEventAndPublish(
        t.id,
        () => true,
        {
          kind: "assistant_message",
          text: `回复里夹着 token=${FAKE_TOKEN}`,
        } as never,
        "origin-group-real",
      );

      expect(result).toBeNull();
      expect(frames.map(brief)).toEqual([
        "event:assistant_message(无seq)",
        "sd:true/EACCES",
        "toast",
      ]);
      const [eventFrame] = eventFramesOf(frames);
      expect(eventFrame!.origin).toBe("origin-group-real");
      expect(eventFrame!.event.text).toBe(
        `回复里夹着 token=${REDACTED_GIT_TOKEN}`,
      );
      expect(eventFrame!.event.meta).toEqual({ groupRun: "origin-group-real" });
      expect(JSON.stringify(frames)).not.toContain(FAKE_TOKEN);
      expect(stream.getStorageDegraded(t.id)).toEqual({ code: "EACCES" });

      await fsp.chmod(file, 0o644);
      expect(await fsp.readFile(file, "utf-8")).toBe("");
    });

    it("events.jsonl 里已有旧事件（无 sidecar → 走全量扫描分支）：同样读盘失败、同样脱敏；旧内容原样不动", async () => {
      await writeConfig({ gitToken: FAKE_TOKEN });
      const t = await mkTask("real-redact-3");
      const old: TaskEvent = {
        id: core.newEventId(),
        ts: Date.now(),
        seq: 1,
        kind: "info",
        text: "旧事件",
      };
      const oldLine = `${JSON.stringify(old)}\n`;
      const file = await lockEventsFile(t.id, oldLine);
      const frames = subscribe(t.id);

      await stream.writeEventAndPublish(t.id, {
        kind: "tool_result",
        text: `printenv → ${FAKE_TOKEN}`,
      } as never);

      expect(frames.map(brief)).toEqual([
        "event:tool_result(无seq)",
        "sd:true/EACCES",
        "toast",
      ]);
      expect(eventFramesOf(frames)[0]!.event.text).toBe(
        `printenv → ${REDACTED_GIT_TOKEN}`,
      );
      expect(JSON.stringify(frames)).not.toContain(FAKE_TOKEN);
      expect(stream.getStorageDegraded(t.id)).toEqual({ code: "EACCES" });

      await fsp.chmod(file, 0o644);
      expect(await fsp.readFile(file, "utf-8")).toBe(oldLine);
    });

    it.each(RECOVER_WRITERS)(
      "读失败后恢复闭环（%s）：权限还原且越过粘滞窗口后，下一条成功落盘——盘上已脱敏、seq 从 1 起（读失败没烧号），订阅者收到 sd:false、降级标志清除，origin 失败帧与成功帧都透传",
      (_name, write, origin) =>
        runRecoverScenario(write, origin, "EACCES", async (id) => {
          const file = await lockEventsFile(id, "");
          return () => fsp.chmod(file, 0o644);
        }),
    );
  },
);

// ───────────────────────── 不依赖权限位：stat 抛 EIO ─────────────────────────

describe("不依赖权限位的读盘失败（所有平台、含 root）：尾扫时 events.jsonl 的 stat 抛 EIO", () => {
  // 造法见文件上方的 prepareStatFailure（sidecar = 0 + fsp.stat 对本任务 events.jsonl 抛 EIO）
  it("writeEventAndPublish：事件副本不含明文 gitToken、无 seq；置 EIO 降级、发 sd:true 与 toast", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    const t = await mkTask("real-redact-eio-1");
    await prepareStatFailure(t.id);
    const frames = subscribe(t.id);

    const result = await stream.writeEventAndPublish(t.id, {
      kind: "tool_result",
      text: `token=${FAKE_TOKEN}`,
      meta: { env: { GITLAB_TOKEN: FAKE_TOKEN } },
    } as never);

    expect(result).toBeNull();
    expect(frames.map(brief)).toEqual([
      "event:tool_result(无seq)",
      "sd:true/EIO",
      "toast",
    ]);
    const [eventFrame] = eventFramesOf(frames);
    expect(eventFrame!.event.text).toBe(`token=${REDACTED_GIT_TOKEN}`);
    expect(eventFrame!.event.meta).toEqual({
      env: { GITLAB_TOKEN: REDACTED_GIT_TOKEN },
    });
    expect("seq" in eventFrame!.event).toBe(false);
    expect(JSON.stringify(frames)).not.toContain(FAKE_TOKEN);
    expect(stream.getStorageDegraded(t.id)).toEqual({ code: "EIO" });
    // 盘上这条没落
    expect(await fsp.readFile(eventsFile(t.id), "utf-8")).toBe("");
  });

  it("writeOwnedEventAndPublish（不带 origin）：同样脱敏副本、事件帧上没有 origin 字段", async () => {
    await writeConfig({ gitToken: FAKE_TOKEN });
    const t = await mkTask("real-redact-eio-2");
    await prepareStatFailure(t.id);
    const frames = subscribe(t.id);

    const result = await stream.writeOwnedEventAndPublish(t.id, () => true, {
      kind: "tool_call",
      text: `git clone https://oauth2:${FAKE_TOKEN}@gitlab.example.com/x.git`,
    } as never);

    expect(result).toBeNull();
    expect(frames.map(brief)).toEqual([
      "event:tool_call(无seq)",
      "sd:true/EIO",
      "toast",
    ]);
    const [eventFrame] = eventFramesOf(frames);
    expect("origin" in eventFrame!).toBe(false);
    expect(eventFrame!.event.text).toBe(
      `git clone https://oauth2:${REDACTED_GIT_TOKEN}@gitlab.example.com/x.git`,
    );
    expect(JSON.stringify(frames)).not.toContain(FAKE_TOKEN);
    expect(stream.getStorageDegraded(t.id)).toEqual({ code: "EIO" });
  });

  it("没配任何凭据：读盘失败时事件仍原样推给订阅者（脱敏不能把事件吞掉），仍置降级标志", async () => {
    const t = await mkTask("real-redact-eio-3");
    await prepareStatFailure(t.id);
    const frames = subscribe(t.id);

    await stream.writeEventAndPublish(t.id, {
      kind: "tool_result",
      text: `没配凭据时的普通输出：${FAKE_TOKEN}`,
    } as never);

    expect(frames.map(brief)).toEqual([
      "event:tool_result(无seq)",
      "sd:true/EIO",
      "toast",
    ]);
    expect(eventFramesOf(frames)[0]!.event.text).toBe(
      `没配凭据时的普通输出：${FAKE_TOKEN}`,
    );
    expect(stream.getStorageDegraded(t.id)).toEqual({ code: "EIO" });
  });

  it.each(RECOVER_WRITERS)(
    "读失败后恢复闭环（%s）：故障解除且越过粘滞窗口后，下一条成功落盘——盘上已脱敏、seq 从 1 起（读失败没烧号），订阅者收到 sd:false、降级标志清除，origin 失败帧与成功帧都透传",
    (_name, write, origin) =>
      runRecoverScenario(write, origin, "EIO", prepareStatFailure),
  );
});
