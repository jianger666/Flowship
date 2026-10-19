/**
 * 后台 shell 追踪的端到端链路：真实 handleSdkMessage → emitToolResult → trackBackgroundShell →
 * 事件落盘 → 渲染管线（mergeToolDisplayEvents + markBackgroundRunningTools）。
 *
 * 现象：shell 超时 / 被要求后台跑时 SDK 照样回 success + exit 0，shell 块「已完成」亮绿色终端，
 * 可进程还在跑（AI 随后调 wait 等它）。终端文件头 status=running 是唯一可靠的「还在跑」信号。
 *
 * 终端文件按 SDK 真实格式造（CURSOR_DATA_DIR 指到临时目录）；真机核对见 shell-background-tracker.test.ts 头注释。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
import { collectRunningBackgroundCallIds } from "@/lib/shell-background";
import {
  isToolBlock,
  markBackgroundRunningTools,
  mergeToolDisplayEvents,
} from "@/lib/tool-display";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-shell-bg-handler-"));
const CURSOR_DIR = path.join(TMP_ROOT, "cursor");
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
process.env.CURSOR_DATA_DIR = CURSOR_DIR;

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
}));

const { readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { handleSdkMessage } = await import("@/lib/server/sdk-message-handler");
const { activeBackgroundShellTrackerCount, stopBackgroundShellTracking } =
  await import("@/lib/server/shell-background-tracker");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const sdkQuote = (e: string): string =>
  `"${e.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;

const terminalFile = (command: string, status: string, startedAtMs: number) =>
  `---\npid: ${process.pid}\ncwd: "/w"\ncommand: ${sdkQuote(command)}\nstatus: ${status.padEnd(9, " ")}\nstarted_at: ${new Date(startedAtMs).toISOString()}\nrunning_for_ms: 0        \n---\n`;

let terminalSeq = 1000;
const putTerminal = (command: string, status: string, startedAtMs: number) => {
  const dir = path.join(CURSOR_DIR, "projects", "ws", "terminals");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${++terminalSeq}.txt`);
  writeFileSync(file, terminalFile(command, status, startedAtMs), "utf8");
  return file;
};

const seed = async (): Promise<string> => {
  const id = `t_sbgh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await writeMeta({
    id,
    title: "shell-bg-handler",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as TaskMetaV06);
  return id;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const waitFor = async (
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 6000,
): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await sleep(20);
  }
};

/** 喂一次 shell 工具调用（running → completed）；result 形态与 SDK 公开的 ShellResult 一致 */
const runShell = async (
  id: string,
  callId: string,
  command: string,
  result: unknown,
  opts?: { name?: string; origin?: string },
) => {
  const ctx = { buffer: "", flush: async () => {} };
  const lease = () => true;
  const name = opts?.name ?? "shell";
  const args = { command };
  await handleSdkMessage(
    id,
    { type: "tool_call", call_id: callId, name, status: "running", args } as never,
    ctx,
    lease,
    opts?.origin,
  );
  await handleSdkMessage(
    id,
    { type: "tool_call", call_id: callId, name, status: "completed", args, result } as never,
    ctx,
    lease,
    opts?.origin,
  );
};

const success = (exitCode = 0, executionTime = 231) => ({
  status: "success",
  value: { exitCode, signal: "", stdout: "", stderr: "", executionTime },
});

const markers = (events: TaskEvent[]) =>
  events.filter((e) => e.kind === "info" && e.meta?.shellBackground);

const iconState = (events: TaskEvent[], callId: string, runActive: boolean) => {
  const visible = events.filter((e) => !isHiddenFromEventStream(e));
  const items = mergeToolDisplayEvents(visible);
  const marked = runActive
    ? markBackgroundRunningTools(items, collectRunningBackgroundCallIds(events))
    : items;
  const block = marked.find((it) => isToolBlock(it) && it.callId === callId);
  if (!block || !isToolBlock(block)) throw new Error("no block");
  return { status: block.status, backgroundRunning: block.backgroundRunning === true };
};

describe("handleSdkMessage → 后台 shell 标记", () => {
  it("shell 成功返回但进程还在跑：落 running 标记 → 渲染转圈；进程退出后落 ended → 转回完成态", async () => {
    const id = await seed();
    const command = "npm run dev -- --port 3999";
    const startedAt = Date.now();
    const file = putTerminal(command, "running", startedAt);

    await runShell(id, "call_bg_1", command, success());

    // tool_result 立刻就在（不被追踪拖慢），此刻还没标记 → 旧行为：已完成
    let events = await readEvents(id);
    expect(events.some((e) => e.kind === "tool_result")).toBe(true);
    expect(iconState(events, "call_bg_1", true)).toEqual({
      status: "success",
      backgroundRunning: false,
    });

    await waitFor(async () => markers(await readEvents(id)).length >= 1);
    events = await readEvents(id);
    expect(markers(events)[0].meta).toMatchObject({
      shellBackground: { callId: "call_bg_1", phase: "running", pid: process.pid },
    });
    // 修复点：会话 running 时转圈（status 仍是 success）；会话停了不转
    expect(iconState(events, "call_bg_1", true)).toEqual({
      status: "success",
      backgroundRunning: true,
    });
    expect(iconState(events, "call_bg_1", false).backgroundRunning).toBe(false);
    // 标记本身不渲染
    expect(events.filter((e) => isHiddenFromEventStream(e)).length).toBe(1);

    // 进程退出 → 终端文件头改 succeeded → 追踪落 ended
    writeFileSync(file, terminalFile(command, "succeeded", startedAt), "utf8");
    await waitFor(async () => markers(await readEvents(id)).length >= 2, 8000);
    events = await readEvents(id);
    expect(markers(events)[1].meta).toMatchObject({
      shellBackground: { callId: "call_bg_1", phase: "ended", reason: "exited" },
    });
    expect(iconState(events, "call_bg_1", true).backgroundRunning).toBe(false);
    expect(activeBackgroundShellTrackerCount()).toBe(0);
  }, 20_000);

  it("普通 shell（终端文件已是 succeeded）：不落任何标记，图标照旧是完成态", async () => {
    const id = await seed();
    const command = "git status --short";
    putTerminal(command, "succeeded", Date.now());

    await runShell(id, "call_plain", command, success(0, 40));
    await sleep(1500); // 越过 600ms 探测延迟再看

    const events = await readEvents(id);
    expect(markers(events)).toEqual([]);
    expect(iconState(events, "call_plain", true)).toEqual({
      status: "success",
      backgroundRunning: false,
    });
    expect(activeBackgroundShellTrackerCount()).toBe(0);
  });

  it("exit 非 0 的 shell 不追踪（转后台时 SDK 回的是 exit 0）", async () => {
    const id = await seed();
    const command = "sleep 600 && false";
    putTerminal(command, "running", Date.now());

    await runShell(id, "call_fail", command, success(1, 50));
    await sleep(1200);

    expect(markers(await readEvents(id))).toEqual([]);
    expect(activeBackgroundShellTrackerCount()).toBe(0);
  });

  it("非 shell 工具、或 shell 报 error 都不追踪", async () => {
    const id = await seed();
    const command = "sleep 601";
    putTerminal(command, "running", Date.now());

    await runShell(id, "call_read", command, success(), { name: "read" });
    await runShell(id, "call_err", command, { status: "error", error: { message: "boom" } });
    await sleep(1200);

    expect(markers(await readEvents(id))).toEqual([]);
    expect(activeBackgroundShellTrackerCount()).toBe(0);
  });

  it("没有对应终端文件（如 pi 后端的 bash）→ 静默放弃", async () => {
    const id = await seed();
    await runShell(id, "call_nofile", "echo never-logged", success());
    await sleep(1200);
    expect(markers(await readEvents(id))).toEqual([]);
    expect(activeBackgroundShellTrackerCount()).toBe(0);
  });

  it("旁路 run（origin）：标记同样带 groupRun、被属主主流藏起来", async () => {
    const id = await seed();
    const command = "node server.js --side";
    putTerminal(command, "running", Date.now());

    await runShell(id, "call_side", command, success(), { origin: "grp_side_1" });
    await waitFor(async () => markers(await readEvents(id)).length >= 1);

    const m = markers(await readEvents(id))[0];
    expect(m.meta?.groupRun).toBe("grp_side_1");
    expect(isHiddenFromEventStream(m)).toBe(true);
    stopBackgroundShellTracking(id);
    await waitFor(() => activeBackgroundShellTrackerCount() === 0);
  });
});
