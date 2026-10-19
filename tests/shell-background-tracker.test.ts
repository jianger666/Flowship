/**
 * 后台 shell 追踪（src/lib/server/shell-background-tracker.ts）
 *
 * 判定依据是 Cursor SDK 自己写的终端文件（`<CURSOR_DATA_DIR>/projects/<ws>/terminals/<id>.txt`）：
 * 文件头 `status: running` = 进程还活着。这里用 CURSOR_DATA_DIR 指到临时目录，按 SDK 的真实文件格式
 * （Sa()/ba() 的输出形态）造终端文件，验证：怎么认人、什么时候落 running / ended、怎么收手。
 *
 * 真机核对（一次性，已做）：用真实 ~/.cursor 里 SDK 写的终端文件跑过 locateShellTerminal / trackBackgroundShell——
 * 一个 `sleep 75` 的后台 shell 先认出 status=running 并落 running，进程退出后落 ended。
 */
import { mkdirSync, mkdtempSync, promises as fsp, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
import {
  collectRunningBackgroundShells,
  type ShellBackgroundMeta,
} from "@/lib/shell-background";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-shell-bg-tracker-"));
const CURSOR_DIR = path.join(TMP_ROOT, "cursor");
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
process.env.CURSOR_DATA_DIR = CURSOR_DIR;

const { clearEventSeqCounter, readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { listTasks } = await import("@/lib/server/task-fs");
const trackerModule = await import("@/lib/server/shell-background-tracker");
const {
  activeBackgroundShellTrackerCount,
  CLAIM_TTL_MS,
  cursorProjectsRoot,
  encodeTerminalCommand,
  isPidAlive,
  locateShellTerminal,
  parseTerminalHeader,
  resetShellBackgroundTrackerStateForTest,
  shellTerminalClaimCount,
  shellTerminalClaimTableSize,
  STOP_WAIT_MS,
  stopBackgroundShellTracking,
  trackBackgroundShell,
} = trackerModule;

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}
await listTasks();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

// ---- 按 SDK 源码（ba / Sa）复刻的终端文件格式 ----
const sdkQuote = (e: string): string =>
  `"${e.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;

const terminalFile = (o: {
  pid?: number;
  cwd?: string;
  command: string;
  title?: string;
  status: string;
  startedAt: string;
  runningForMs?: number;
  body?: string;
}): string => {
  let h = "---\n";
  if (o.pid !== undefined && o.pid !== 0) h += `pid: ${o.pid}\n`;
  h += `cwd: ${sdkQuote(o.cwd ?? "/work")}\n`;
  h += `command: ${sdkQuote(o.command)}\n`;
  if (o.title) h += `title: ${sdkQuote(o.title)}\n`;
  h += `status: ${o.status.padEnd(9, " ")}\n`;
  h += `started_at: ${o.startedAt}\n`;
  h += `running_for_ms: ${String(o.runningForMs ?? 0).padEnd(9, " ")}\n`;
  h += "---\n";
  return h + (o.body ?? "");
};

const WS = "Users-me-work";
const terminalsDir = (ws = WS): string =>
  path.join(CURSOR_DIR, "projects", ws, "terminals");

const putTerminal = (
  id: number,
  o: Parameters<typeof terminalFile>[0],
  ws = WS,
): string => {
  const dir = terminalsDir(ws);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.txt`);
  writeFileSync(file, terminalFile(o), "utf8");
  return file;
};

const iso = (ms: number): string => new Date(ms).toISOString();

describe("encodeTerminalCommand / parseTerminalHeader", () => {
  it("与 SDK 的命令转义逐字一致（引号 / 反斜杠 / 换行 / 回车 / 制表符 / 中文）", () => {
    const samples = [
      "ls -la",
      'echo "hi"',
      "echo a\\b",
      "a\nb\r\nc\td",
      'cat <<EOF\n{"k":"v\\n"}\nEOF',
      "echo 你好 && sleep 60",
      "",
    ];
    for (const s of samples) expect(encodeTerminalCommand(s)).toBe(sdkQuote(s));
  });

  it("解析：status 去掉填充空格、pid / started_at 取出、command 保留编码原样", () => {
    const text = terminalFile({
      pid: 6568,
      command: 'node "a b".js',
      title: "t",
      status: "running",
      startedAt: "2026-10-18T02:35:31.772Z",
      runningForMs: 5,
      body: "正文输出\n",
    });
    expect(parseTerminalHeader(text)).toEqual({
      pid: 6568,
      commandEncoded: sdkQuote('node "a b".js'),
      status: "running",
      startedAtMs: Date.parse("2026-10-18T02:35:31.772Z"),
    });
  });

  it("没有 pid 行（pid=0 不写）也能解析", () => {
    const h = parseTerminalHeader(
      terminalFile({ command: "x", status: "succeeded", startedAt: iso(1) }),
    );
    expect(h?.pid).toBeUndefined();
    expect(h?.status).toBe("succeeded");
  });

  it("形态不对 → null：无 front matter / 头没读全 / 缺 status / 缺 command", () => {
    expect(parseTerminalHeader("just output\n")).toBeNull();
    expect(parseTerminalHeader("---\ncommand: \"x\"\nstatus: running")).toBeNull();
    expect(parseTerminalHeader('---\ncommand: "x"\n---\n')).toBeNull();
    expect(parseTerminalHeader("---\nstatus: running\n---\n")).toBeNull();
  });

  it("projects 根目录：CURSOR_DATA_DIR 优先", () => {
    expect(cursorProjectsRoot()).toBe(path.join(CURSOR_DIR, "projects"));
  });
});

describe("locateShellTerminal：用命令 + 开始时刻认人", () => {
  beforeEach(() => {
    rmSync(path.join(CURSOR_DIR, "projects"), { recursive: true, force: true });
    resetShellBackgroundTrackerStateForTest();
  });

  it("命令一致、开始时刻吻合 → 认出，带 status / pid", async () => {
    const t = Date.now();
    putTerminal(11, {
      pid: 99,
      command: "sleep 60",
      status: "running",
      startedAt: iso(t - 1000),
    });
    const found = await locateShellTerminal({
      taskId: "t_a",
      command: "sleep 60",
      startedAtMs: t - 800,
    });
    expect(found?.header.status).toBe("running");
    expect(found?.header.pid).toBe(99);
  });

  it("命令不一致 → 认不出", async () => {
    const t = Date.now();
    putTerminal(12, { command: "sleep 61", status: "running", startedAt: iso(t) });
    expect(
      await locateShellTerminal({ taskId: "t_b", command: "sleep 60", startedAtMs: t }),
    ).toBeNull();
  });

  it("开始时刻差太远（别的时候跑过同一条命令）→ 认不出", async () => {
    const t = Date.now();
    putTerminal(13, {
      command: "sleep 60",
      status: "running",
      startedAt: iso(t - 5 * 60_000),
    });
    expect(
      await locateShellTerminal({ taskId: "t_c", command: "sleep 60", startedAtMs: t }),
    ).toBeNull();
  });

  it("同命令多份：取开始时刻最接近的那份", async () => {
    const t = Date.now();
    putTerminal(21, { command: "make dev", status: "succeeded", startedAt: iso(t - 15_000) });
    putTerminal(22, { command: "make dev", status: "running", startedAt: iso(t - 500), pid: 7 });
    const found = await locateShellTerminal({
      taskId: "t_d",
      command: "make dev",
      startedAtMs: t,
    });
    expect(found?.header.pid).toBe(7);
    expect(found?.header.status).toBe("running");
  });

  it("文件太旧（mtime 早于开始时刻很多）不看——运行中的文件每 5s 被刷新，不会这么旧", async () => {
    const t = Date.now();
    const file = putTerminal(31, {
      command: "sleep 60",
      status: "running",
      startedAt: iso(t - 500),
    });
    const old = new Date(t - 10 * 60_000);
    utimesSync(file, old, old);
    expect(
      await locateShellTerminal({ taskId: "t_e", command: "sleep 60", startedAtMs: t }),
    ).toBeNull();
  });

  it("多个 workspace 目录里都能找（不依赖 cwd → 目录的映射）", async () => {
    const t = Date.now();
    putTerminal(41, { command: "echo other", status: "succeeded", startedAt: iso(t) }, "ws-one");
    putTerminal(42, { command: "sleep 60", status: "running", startedAt: iso(t), pid: 5 }, "ws-two");
    const found = await locateShellTerminal({
      taskId: "t_f",
      command: "sleep 60",
      startedAtMs: t,
    });
    expect(found?.header.pid).toBe(5);
    expect(found?.dir).toBe(terminalsDir("ws-two"));
  });

  it("projects 目录不存在 → null（不抛）", async () => {
    expect(
      await locateShellTerminal({ taskId: "t_g", command: "x", startedAtMs: Date.now() }),
    ).toBeNull();
  });

  it("含引号 / 换行的命令也能认出（编码口径与 SDK 一致）", async () => {
    const t = Date.now();
    const command = 'echo "a"\nsleep 30\t# tab';
    putTerminal(51, { command, status: "running", startedAt: iso(t), pid: 3 });
    const found = await locateShellTerminal({ taskId: "t_h", command, startedAtMs: t });
    expect(found?.header.pid).toBe(3);
  });
});

describe("trackBackgroundShell：落 running / ended 标记", () => {
  // 终端文件里的 pid 都是编的——探活一律注入「活着」，专门的探活用例自己覆盖
  const FAST = { probeDelayMs: 5, pollIntervalMs: 10, isPidAlive: () => true };
  const lease = () => true;

  beforeEach(() => {
    rmSync(path.join(CURSOR_DIR, "projects"), { recursive: true, force: true });
    resetShellBackgroundTrackerStateForTest();
  });

  afterEach(() => {
    expect(activeBackgroundShellTrackerCount()).toBe(0);
  });

  const collect = () => {
    const writes: ShellBackgroundMeta[] = [];
    return {
      writes,
      write: async (m: ShellBackgroundMeta) => {
        writes.push(m);
      },
    };
  };

  it("转后台的 shell：先落 running（带 pid），进程退出（文件头改 succeeded）后落 ended(exited)", async () => {
    const t = Date.now();
    const file = putTerminal(101, {
      pid: 321,
      command: "sleep 600",
      status: "running",
      startedAt: iso(t),
    });
    const c = collect();
    const done = trackBackgroundShell({
      taskId: "t_1",
      callId: "call_1",
      command: "sleep 600",
      startedAtMs: t,
      lease,
      write: c.write,
      ...FAST,
    });
    // 等 running 标记出现，再让进程「退出」
    await waitFor(() => c.writes.length >= 1);
    expect(c.writes[0]).toEqual({ callId: "call_1", phase: "running", pid: 321 });
    // 还在跑期间不应有 ended
    await sleep(40);
    expect(c.writes).toHaveLength(1);
    writeFileSync(
      file,
      terminalFile({ pid: 321, command: "sleep 600", status: "succeeded", startedAt: iso(t) }),
      "utf8",
    );
    await done;
    expect(c.writes).toEqual([
      { callId: "call_1", phase: "running", pid: 321 },
      { callId: "call_1", phase: "ended", reason: "exited", pid: 321 },
    ]);
  });

  it("failed / aborted 同样算结束", async () => {
    for (const status of ["failed", "aborted"]) {
      const t = Date.now();
      // 每个 status 一份自己的文件（认领是排他的：前一个追踪认过的文件，30s 内不会再被认走）
      const file = putTerminal(status === "failed" ? 102 : 1021, { pid: 1, command: `c-${status}`, status: "running", startedAt: iso(t) });
      const c = collect();
      const done = trackBackgroundShell({
        taskId: `t_${status}`,
        callId: `call_${status}`,
        command: `c-${status}`,
        startedAtMs: t,
        lease,
        write: c.write,
        ...FAST,
      });
      await waitFor(() => c.writes.length >= 1);
      writeFileSync(
        file,
        terminalFile({ pid: 1, command: `c-${status}`, status, startedAt: iso(t) }),
        "utf8",
      );
      await done;
      expect(c.writes.map((w) => w.phase)).toEqual(["running", "ended"]);
    }
  });

  it("普通 shell（探测时文件已是 succeeded）→ 什么都不写", async () => {
    const t = Date.now();
    putTerminal(103, { pid: 2, command: "ls", status: "succeeded", startedAt: iso(t) });
    const c = collect();
    await trackBackgroundShell({
      taskId: "t_2",
      callId: "call_2",
      command: "ls",
      startedAtMs: t,
      lease,
      write: c.write,
      ...FAST,
    });
    expect(c.writes).toEqual([]);
  });

  it("找不到终端文件（如 pi 后端的 bash）→ 什么都不写", async () => {
    const c = collect();
    await trackBackgroundShell({
      taskId: "t_3",
      callId: "call_3",
      command: "no-such",
      startedAtMs: Date.now(),
      lease,
      write: c.write,
      ...FAST,
    });
    expect(c.writes).toEqual([]);
  });

  it("探测前就失主 → 不去读盘、不写", async () => {
    const t = Date.now();
    putTerminal(104, { pid: 2, command: "sleep 9", status: "running", startedAt: iso(t) });
    const c = collect();
    await trackBackgroundShell({
      taskId: "t_4",
      callId: "call_4",
      command: "sleep 9",
      startedAtMs: t,
      lease: () => false,
      write: c.write,
      ...FAST,
    });
    expect(c.writes).toEqual([]);
  });

  it("running 落了之后失主 → 停轮询、不再写 ended（由收尾补）", async () => {
    const t = Date.now();
    const file = putTerminal(105, { pid: 2, command: "sleep 9", status: "running", startedAt: iso(t) });
    const c = collect();
    let owned = true;
    const done = trackBackgroundShell({
      taskId: "t_5",
      callId: "call_5",
      command: "sleep 9",
      startedAtMs: t,
      lease: () => owned,
      write: c.write,
      ...FAST,
    });
    await waitFor(() => c.writes.length >= 1);
    owned = false;
    writeFileSync(
      file,
      terminalFile({ pid: 2, command: "sleep 9", status: "succeeded", startedAt: iso(t) }),
      "utf8",
    );
    await done;
    expect(c.writes.map((w) => w.phase)).toEqual(["running"]);
  });

  it("stopBackgroundShellTracking：立刻收手、不写 ended、不留挂着的追踪", async () => {
    const t = Date.now();
    putTerminal(106, { pid: 2, command: "sleep 9", status: "running", startedAt: iso(t) });
    const c = collect();
    const done = trackBackgroundShell({
      taskId: "t_6",
      callId: "call_6",
      command: "sleep 9",
      startedAtMs: t,
      lease,
      write: c.write,
      probeDelayMs: 5,
      pollIntervalMs: 60_000, // 不停就要睡一分钟
      isPidAlive: () => true,
    });
    await waitFor(() => c.writes.length >= 1);
    expect(activeBackgroundShellTrackerCount()).toBe(1);
    const t0 = Date.now();
    stopBackgroundShellTracking("t_6");
    await done;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(c.writes.map((w) => w.phase)).toEqual(["running"]);
  });

  it("stop 只停指定任务，别的任务的追踪不受影响", async () => {
    const t = Date.now();
    putTerminal(107, { pid: 2, command: "job-a", status: "running", startedAt: iso(t) });
    putTerminal(108, { pid: 3, command: "job-b", status: "running", startedAt: iso(t) });
    const a = collect();
    const b = collect();
    const doneA = trackBackgroundShell({
      taskId: "t_a2",
      callId: "ca",
      command: "job-a",
      startedAtMs: t,
      lease,
      write: a.write,
      probeDelayMs: 5,
      pollIntervalMs: 60_000,
      isPidAlive: () => true,
    });
    const doneB = trackBackgroundShell({
      taskId: "t_b2",
      callId: "cb",
      command: "job-b",
      startedAtMs: t,
      lease,
      write: b.write,
      probeDelayMs: 5,
      pollIntervalMs: 60_000,
      isPidAlive: () => true,
    });
    await waitFor(() => a.writes.length >= 1 && b.writes.length >= 1);
    stopBackgroundShellTracking("t_a2");
    await doneA;
    expect(activeBackgroundShellTrackerCount()).toBe(1);
    stopBackgroundShellTracking("t_b2");
    await doneB;
  });

  it("文件被清掉：连续读不出来才按已结束收（偶发一次读不到不算）", async () => {
    const t = Date.now();
    const file = putTerminal(109, { pid: 2, command: "sleep 9", status: "running", startedAt: iso(t) });
    const c = collect();
    const done = trackBackgroundShell({
      taskId: "t_7",
      callId: "call_7",
      command: "sleep 9",
      startedAtMs: t,
      lease,
      write: c.write,
      ...FAST,
    });
    await waitFor(() => c.writes.length >= 1);
    rmSync(file);
    await done;
    expect(c.writes.map((w) => w.phase)).toEqual(["running", "ended"]);
    expect(c.writes[1]).toMatchObject({ reason: "exited" });
  });

  it("偶发读不出文件头（SDK 原地改写时读到半截）不算结束：连续 3 次读不出才收，中间读到 running 就清零", async () => {
    const t = Date.now();
    putTerminal(112, { pid: 2, command: "sleep 9", status: "running", startedAt: iso(t) });
    const running = parseTerminalHeader(
      terminalFile({ pid: 2, command: "sleep 9", status: "running", startedAt: iso(t) }),
    );
    const finished = parseTerminalHeader(
      terminalFile({ pid: 2, command: "sleep 9", status: "succeeded", startedAt: iso(t) }),
    );
    // null,null,running(清零),null,null,running(清零),succeeded → 只在最后才结束
    const script = [null, null, running, null, null, running, finished];
    let polls = 0;
    const c = collect();
    await trackBackgroundShell({
      taskId: "t_flaky",
      callId: "call_flaky",
      command: "sleep 9",
      startedAtMs: t,
      lease,
      write: c.write,
      readHeader: async () => (polls < script.length ? script[polls++] : finished),
      ...FAST,
    });
    expect(polls).toBe(script.length);
    expect(c.writes.map((w) => w.phase)).toEqual(["running", "ended"]);

    // 连续 3 次读不出 → 收（不让转圈挂死）
    resetShellBackgroundTrackerStateForTest(); // 同一份文件刚被上一个追踪认领过
    polls = 0;
    const c2 = collect();
    await trackBackgroundShell({
      taskId: "t_gone",
      callId: "call_gone",
      command: "sleep 9",
      startedAtMs: t,
      lease,
      write: c2.write,
      readHeader: async () => {
        polls += 1;
        return null;
      },
      ...FAST,
    });
    expect(polls).toBe(3);
    expect(c2.writes.map((w) => w.phase)).toEqual(["running", "ended"]);
  });

  it("没有 pid 行也能追（pid 只是排查信息）", async () => {
    const t = Date.now();
    const file = putTerminal(110, { command: "sleep 9", status: "running", startedAt: iso(t) });
    const c = collect();
    const done = trackBackgroundShell({
      taskId: "t_8",
      callId: "call_8",
      command: "sleep 9",
      startedAtMs: t,
      lease,
      write: c.write,
      ...FAST,
    });
    await waitFor(() => c.writes.length >= 1);
    expect(c.writes[0]).toEqual({ callId: "call_8", phase: "running" });
    writeFileSync(file, terminalFile({ command: "sleep 9", status: "succeeded", startedAt: iso(t) }), "utf8");
    await done;
    expect(c.writes[1]).toEqual({ callId: "call_8", phase: "ended", reason: "exited" });
  });

  it("写盘抛错不外泄（追踪是 best-effort，不能拖垮主流程）", async () => {
    const t = Date.now();
    putTerminal(111, { pid: 2, command: "sleep 9", status: "running", startedAt: iso(t) });
    await expect(
      trackBackgroundShell({
        taskId: "t_9",
        callId: "call_9",
        command: "sleep 9",
        startedAtMs: t,
        lease,
        write: async () => {
          throw new Error("disk full");
        },
        ...FAST,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("trackBackgroundShell：排他认领 / 探活 / 收尾落定", () => {
  const lease = () => true;
  const ALIVE = { probeDelayMs: 5, pollIntervalMs: 10, isPidAlive: () => true };

  beforeEach(() => {
    rmSync(path.join(CURSOR_DIR, "projects"), { recursive: true, force: true });
    resetShellBackgroundTrackerStateForTest();
  });

  afterEach(() => {
    expect(activeBackgroundShellTrackerCount()).toBe(0);
  });

  const collect = () => {
    const writes: ShellBackgroundMeta[] = [];
    return {
      writes,
      write: async (m: ShellBackgroundMeta) => {
        writes.push(m);
      },
    };
  };
  const pidOf = (m: ShellBackgroundMeta | undefined): number | undefined =>
    (m as { pid?: number } | undefined)?.pid;

  it("两个并发的同命令调用各认各的终端文件，不会绑到同一份（排他认领）", async () => {
    const t = Date.now();
    // 两份都吻合：A 的开始时刻更近。没有认领的话，两个追踪都会挑中 A
    const fileA = putTerminal(301, { pid: 11, command: "pnpm build", status: "running", startedAt: iso(t) });
    const fileB = putTerminal(302, { pid: 12, command: "pnpm build", status: "running", startedAt: iso(t + 1000) });
    const a = collect();
    const b = collect();
    const mk = (taskId: string, c: ReturnType<typeof collect>) =>
      trackBackgroundShell({
        taskId,
        callId: `call_${taskId}`,
        command: "pnpm build",
        startedAtMs: t,
        lease,
        write: c.write,
        ...ALIVE,
      });
    const doneA = mk("t_claim_1", a);
    const doneB = mk("t_claim_2", b);
    await waitFor(() => a.writes.length >= 1 && b.writes.length >= 1);
    expect([pidOf(a.writes[0]), pidOf(b.writes[0])].sort()).toEqual([11, 12]);

    // 各自跟各自的文件走：只结束 A，B 仍在跑
    writeFileSync(
      fileA,
      terminalFile({ pid: 11, command: "pnpm build", status: "succeeded", startedAt: iso(t) }),
      "utf8",
    );
    await waitFor(() => a.writes.length + b.writes.length >= 3);
    await sleep(40);
    expect(a.writes.length + b.writes.length).toBe(3);
    writeFileSync(
      fileB,
      terminalFile({ pid: 12, command: "pnpm build", status: "succeeded", startedAt: iso(t + 1000) }),
      "utf8",
    );
    await Promise.all([doneA, doneB]);
    expect(a.writes.map((w) => w.phase)).toEqual(["running", "ended"]);
    expect(b.writes.map((w) => w.phase)).toEqual(["running", "ended"]);

    // 追踪结束后认领只留一小段时间（TTL）就释放——存活期间的「永久占用」不能泄漏
    expect(shellTerminalClaimCount()).toBe(2);
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + CLAIM_TTL_MS + 1000);
    try {
      expect(shellTerminalClaimCount()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("只有一份吻合的文件时：先到先得，后来的同命令调用认不到（宁可漏标也不串）", async () => {
    const t = Date.now();
    const file = putTerminal(305, { pid: 15, command: "make dev", status: "running", startedAt: iso(t) });
    const a = collect();
    const b = collect();
    const mk = (taskId: string, c: ReturnType<typeof collect>) =>
      trackBackgroundShell({
        taskId,
        callId: `call_${taskId}`,
        command: "make dev",
        startedAtMs: t,
        lease,
        write: c.write,
        ...ALIVE,
      });
    const doneA = mk("t_one_1", a);
    await waitFor(() => a.writes.length >= 1);
    await mk("t_one_2", b); // 文件被认领着：认不到 → 直接结束、不写
    expect(b.writes).toEqual([]);
    writeFileSync(
      file,
      terminalFile({ pid: 15, command: "make dev", status: "failed", startedAt: iso(t) }),
      "utf8",
    );
    await doneA;
    expect(a.writes.map((w) => w.phase)).toEqual(["running", "ended"]);
  });

  it("已正常结束的匹配也被短暂认领，过期（CLAIM_TTL_MS）后释放", async () => {
    const t = Date.now();
    putTerminal(310, { pid: 2, command: "ls -la", status: "succeeded", startedAt: iso(t) });
    const c = collect();
    await trackBackgroundShell({
      taskId: "t_ttl",
      callId: "call_ttl",
      command: "ls -la",
      startedAtMs: t,
      lease,
      write: c.write,
      ...ALIVE,
    });
    expect(c.writes).toEqual([]);
    expect(shellTerminalClaimCount()).toBe(1);

    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + CLAIM_TTL_MS + 1000);
    try {
      expect(shellTerminalClaimCount()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("探活：开头就发现 pid 不在 → 不落 running（头残留 running 不亮转圈）", async () => {
    const t = Date.now();
    putTerminal(320, { pid: 9, command: "sleep 300", status: "running", startedAt: iso(t) });
    const c = collect();
    await trackBackgroundShell({
      taskId: "t_dead0",
      callId: "call_dead0",
      command: "sleep 300",
      startedAtMs: t,
      lease,
      write: c.write,
      probeDelayMs: 5,
      pollIntervalMs: 10,
      isPidAlive: () => false,
    });
    expect(c.writes).toEqual([]);
  });

  it("探活：文件头一直写 running、进程却没了 → 连续 2 次发现才收尾（一次偶发不算，中间活着就清零）", async () => {
    const t = Date.now();
    putTerminal(321, { pid: 9, command: "sleep 301", status: "running", startedAt: iso(t) });
    // 开头探一次（活）；之后轮询：死、活（清零）、死、死 → 第 4 次轮询才收
    const seq = [true, false, true, false, false];
    let calls = 0;
    const c = collect();
    await trackBackgroundShell({
      taskId: "t_dead1",
      callId: "call_dead1",
      command: "sleep 301",
      startedAtMs: t,
      lease,
      write: c.write,
      probeDelayMs: 5,
      pollIntervalMs: 10,
      isPidAlive: () => seq[Math.min(calls++, seq.length - 1)]!,
    });
    expect(calls).toBe(seq.length);
    expect(c.writes.map((w) => w.phase)).toEqual(["running", "ended"]);
    expect(c.writes[1]).toMatchObject({ reason: "exited", pid: 9 });
  });

  it("没有 pid 行就不探活（没法判断，按文件头为准）", async () => {
    const t = Date.now();
    const file = putTerminal(322, { command: "sleep 302", status: "running", startedAt: iso(t) });
    let probed = 0;
    const c = collect();
    const done = trackBackgroundShell({
      taskId: "t_nopid",
      callId: "call_nopid",
      command: "sleep 302",
      startedAtMs: t,
      lease,
      write: c.write,
      probeDelayMs: 5,
      pollIntervalMs: 10,
      isPidAlive: () => {
        probed += 1;
        return false;
      },
    });
    await waitFor(() => c.writes.length >= 1);
    await sleep(50);
    expect(c.writes.map((w) => w.phase)).toEqual(["running"]);
    writeFileSync(
      file,
      terminalFile({ command: "sleep 302", status: "succeeded", startedAt: iso(t) }),
      "utf8",
    );
    await done;
    expect(probed).toBe(0);
  });

  it("isPidAlive：自己的进程在、不存在的 pid 不在；EPERM（进程在、只是不归我们管）算在，ESRCH 算不在", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(999_999_999)).toBe(false);
    const failWith = (code: string) =>
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });
    let spy = failWith("EPERM");
    try {
      expect(isPidAlive(4242)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    spy = failWith("ESRCH");
    try {
      expect(isPidAlive(4242)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("shellId 不随时间递增：新 shell 的编号比一大堆旧文件都小，照样认得到（不能按编号挑「最新的」）", async () => {
    // 真机实测：同一个会话里，新起的 shell 是 497399.txt，比一周前的 622313.txt / 991871.txt 都小
    const t = Date.now();
    const old = new Date(t - 24 * 3600_000);
    for (let n = 0; n < 500; n += 1) {
      const f = putTerminal(900_000 + n, {
        pid: 2,
        command: `old-${n}`,
        status: "succeeded",
        startedAt: iso(t - 24 * 3600_000),
      });
      utimesSync(f, old, old); // 都是老文件：编号大、mtime 旧
    }
    const needle = putTerminal(497_399, { pid: 3, command: "needle", status: "running", startedAt: iso(t) });
    const found = await locateShellTerminal({ taskId: "t_nonmono", command: "needle", startedAtMs: t });
    expect(found?.file).toBe(needle);
    expect(found?.header.status).toBe("running");
  });

  it("命令相同、时间差也相同的两份文件：结果确定（与 stat 的完成先后无关）", async () => {
    const t = Date.now();
    const files = [1, 2, 3, 4, 5].map((n) =>
      putTerminal(n, { pid: n, command: "twin", status: "running", startedAt: iso(t) }),
    );
    const realStat = fsp.stat.bind(fsp);
    // 编号越大 stat 越早完成：不排序的话，recent 的顺序就是倒的
    const spy = vi.spyOn(fsp, "stat").mockImplementation((async (...args: Parameters<typeof fsp.stat>) => {
      const n = Number.parseInt(path.basename(String(args[0])), 10);
      if (Number.isFinite(n)) await sleep((6 - n) * 8);
      return realStat(...args);
    }) as typeof fsp.stat);
    try {
      const found = await locateShellTerminal({ taskId: "t_twin", command: "twin", startedAtMs: t });
      expect(found?.file).toBe(files[0]);
    } finally {
      spy.mockRestore();
    }
  });

  it("CRLF 的文件头（Windows）也能解析", () => {
    const lf = terminalFile({ pid: 6568, command: "sleep 9", status: "running", startedAt: "2026-10-18T02:35:31.772Z" });
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(crlf).toContain("\r\n");
    expect(parseTerminalHeader(crlf)).toEqual(parseTerminalHeader(lf));
    expect(parseTerminalHeader(crlf)).toMatchObject({ pid: 6568, status: "running" });
  });

  it("认领表会顺手清掉过期项（没人再碰的文件不会让它缓慢增长）", async () => {
    const t = Date.now();
    const fileA = putTerminal(350, { pid: 2, command: "claim-a", status: "succeeded", startedAt: iso(t) });
    putTerminal(351, { pid: 2, command: "claim-b", status: "succeeded", startedAt: iso(t) });
    const run = (command: string) =>
      trackBackgroundShell({
        taskId: `t_${command}`,
        callId: `call_${command}`,
        command,
        startedAtMs: t,
        lease,
        write: async () => {},
        ...ALIVE,
      });
    await run("claim-a");
    expect(shellTerminalClaimTableSize()).toBe(1);
    // claim-a 那份之后没人再碰：mtime 变老、掉出候选集，认人时不会再「顺带查到它」把它删掉——只能靠 pruneClaims 清
    const old = new Date(t - 24 * 3600_000);
    utimesSync(fileA, old, old);
    // 过了 TTL 之后，认领另一个文件时把 claim-a 那份一并清掉
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + CLAIM_TTL_MS + 1000);
    try {
      await run("claim-b");
      expect(shellTerminalClaimTableSize()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("认人时的 stat 是有界并发（目录里上百份终端文件也不会一次性全发出去）", async () => {
    const t = Date.now();
    for (let n = 1; n <= 120; n += 1) {
      putTerminal(n, { pid: 2, command: `other-${n}`, status: "succeeded", startedAt: iso(t) });
    }
    const realStat = fsp.stat.bind(fsp);
    let inflight = 0;
    let peak = 0;
    const spy = vi.spyOn(fsp, "stat").mockImplementation((async (...args: Parameters<typeof fsp.stat>) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      try {
        await sleep(3); // 让并发窗口真的重叠起来
        return await realStat(...args);
      } finally {
        inflight -= 1;
      }
    }) as typeof fsp.stat);
    try {
      expect(
        await locateShellTerminal({ taskId: "t_bounded", command: "nothing-like-this", startedAtMs: t }),
      ).toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(peak).toBeGreaterThan(1); // 前提：确实在并发（不是退化成串行）
    expect(peak).toBeLessThanOrEqual(16);
  });

  it("locateShellTerminal 的 isClaimed：跳过已被认领的文件，换下一份吻合的", async () => {
    const t = Date.now();
    const f1 = putTerminal(340, { pid: 1, command: "dup", status: "running", startedAt: iso(t) });
    putTerminal(341, { pid: 2, command: "dup", status: "running", startedAt: iso(t + 500) });
    const first = await locateShellTerminal({ taskId: "t_ic", command: "dup", startedAtMs: t });
    expect(first?.file).toBe(f1);
    const second = await locateShellTerminal({
      taskId: "t_ic",
      command: "dup",
      startedAtMs: t,
      isClaimed: (f) => f === f1,
    });
    expect(second?.header.pid).toBe(2);
    expect(
      await locateShellTerminal({
        taskId: "t_ic",
        command: "dup",
        startedAtMs: t,
        isClaimed: () => true,
      }),
    ).toBeNull();
  });

  it("stopBackgroundShellTracking 会等在途的写盘落定（finalize 读事件尾巴前必须已看得到这条标记）", async () => {
    const t = Date.now();
    putTerminal(330, { pid: 2, command: "sleep 310", status: "running", startedAt: iso(t) });
    let started = false;
    let landed = false;
    const done = trackBackgroundShell({
      taskId: "t_await",
      callId: "call_await",
      command: "sleep 310",
      startedAtMs: t,
      lease,
      write: async () => {
        started = true;
        await sleep(80);
        landed = true;
      },
      probeDelayMs: 5,
      pollIntervalMs: 60_000,
      isPidAlive: () => true,
    });
    await waitFor(() => started);
    expect(landed).toBe(false);
    await stopBackgroundShellTracking("t_await");
    expect(landed).toBe(true);
    await done;
  });

  it("stop 的等待有上限（STOP_WAIT_MS）：写盘卡死也不拖住收尾", async () => {
    const t = Date.now();
    putTerminal(331, { pid: 2, command: "sleep 311", status: "running", startedAt: iso(t) });
    let release: () => void = () => {};
    const hung = new Promise<void>((r) => {
      release = r;
    });
    let started = false;
    const done = trackBackgroundShell({
      taskId: "t_hung",
      callId: "call_hung",
      command: "sleep 311",
      startedAtMs: t,
      lease,
      write: async () => {
        started = true;
        await hung;
      },
      probeDelayMs: 5,
      pollIntervalMs: 60_000,
      isPidAlive: () => true,
    });
    await waitFor(() => started);
    const t0 = Date.now();
    await stopBackgroundShellTracking("t_hung");
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(STOP_WAIT_MS - 100);
    expect(waited).toBeLessThan(STOP_WAIT_MS + 1500);
    release();
    await done;
  });

  it("stop 传 origin 只停该旁路 run 自己的追踪；不传 = 全停", async () => {
    const t = Date.now();
    putTerminal(332, { pid: 2, command: "job-a", status: "running", startedAt: iso(t) });
    putTerminal(333, { pid: 3, command: "job-b", status: "running", startedAt: iso(t) });
    const a = collect();
    const b = collect();
    const mk = (command: string, origin: string, c: ReturnType<typeof collect>) =>
      trackBackgroundShell({
        taskId: "t_origin",
        callId: `call_${command}`,
        command,
        startedAtMs: t,
        lease,
        origin,
        write: c.write,
        probeDelayMs: 5,
        pollIntervalMs: 60_000,
        isPidAlive: () => true,
      });
    const doneA = mk("job-a", "grp_a", a);
    const doneB = mk("job-b", "grp_b", b);
    await waitFor(() => a.writes.length >= 1 && b.writes.length >= 1);
    await stopBackgroundShellTracking("t_origin", "grp_a");
    await doneA;
    expect(activeBackgroundShellTrackerCount()).toBe(1);
    await stopBackgroundShellTracking("t_origin");
    await doneB;
    expect(activeBackgroundShellTrackerCount()).toBe(0);
    // 停掉之后都没有再写 ended
    expect(a.writes.map((w) => w.phase)).toEqual(["running"]);
    expect(b.writes.map((w) => w.phase)).toEqual(["running"]);
  });

  it("进程级状态在 globalThis 上：另一份模块实例（Next dev 的另一个 chunk）也能停掉这边的追踪", async () => {
    const t = Date.now();
    putTerminal(334, { pid: 2, command: "sleep 312", status: "running", startedAt: iso(t) });
    const c = collect();
    const done = trackBackgroundShell({
      taskId: "t_chunk",
      callId: "call_chunk",
      command: "sleep 312",
      startedAtMs: t,
      lease,
      write: c.write,
      probeDelayMs: 5,
      pollIntervalMs: 60_000,
      isPidAlive: () => true,
    });
    await waitFor(() => c.writes.length >= 1);

    vi.resetModules();
    const other = await import("@/lib/server/shell-background-tracker");
    expect(other).not.toBe(trackerModule); // 前提：确实是另一份模块实例
    expect(other.activeBackgroundShellTrackerCount()).toBe(1);
    await other.stopBackgroundShellTracking("t_chunk");
    await done;
    expect(activeBackgroundShellTrackerCount()).toBe(0);
    expect(c.writes.map((w) => w.phase)).toEqual(["running"]);
  });
});

describe("默认写盘路径：落成 info 标记事件、被事件流藏起来、收尾能识别", () => {
  beforeEach(() => {
    rmSync(path.join(CURSOR_DIR, "projects"), { recursive: true, force: true });
    resetShellBackgroundTrackerStateForTest();
  });

  const makeMeta = (id: string): TaskMetaV06 =>
    ({
      id,
      title: `shell-bg ${id}`,
      mode: "chat",
      repoStatus: "developing",
      runStatus: "running",
      currentActionId: null,
      actions: [],
      mrs: [],
      repoPaths: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }) as unknown as TaskMetaV06;

  it("running → ended 两条标记真的进 events.jsonl；origin 透传成 groupRun", async () => {
    const id = `t_sbg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await writeMeta(makeMeta(id));
    const t = Date.now();
    const file = putTerminal(201, { pid: 77, command: "npm run dev", status: "running", startedAt: iso(t) });
    const done = trackBackgroundShell({
      taskId: id,
      callId: "call_real",
      command: "npm run dev",
      startedAtMs: t,
      lease: () => true,
      origin: "grp_run_1",
      probeDelayMs: 5,
      pollIntervalMs: 10,
      isPidAlive: () => true,
    });
    await waitFor(async () => (await readEvents(id)).length >= 1);
    expect(collectRunningBackgroundShells(await readEvents(id))).toEqual([
      { callId: "call_real", groupRun: "grp_run_1" },
    ]);
    writeFileSync(
      file,
      terminalFile({ pid: 77, command: "npm run dev", status: "failed", startedAt: iso(t) }),
      "utf8",
    );
    await done;

    const events = await readEvents(id);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === "info")).toBe(true);
    expect(events.every((e) => isHiddenFromEventStream(e))).toBe(true);
    expect(events[0].meta).toMatchObject({
      groupRun: "grp_run_1",
      shellBackground: { callId: "call_real", phase: "running", pid: 77 },
    });
    expect(events[1].meta).toMatchObject({
      shellBackground: { callId: "call_real", phase: "ended", reason: "exited" },
    });
    expect(collectRunningBackgroundShells(events)).toEqual([]);
    clearEventSeqCounter(id);
  });
});

// ---- 小工具 ----
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await sleep(5);
  }
}
