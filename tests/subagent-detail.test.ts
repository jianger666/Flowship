/**
 * 子代理详情（事件流里的子代理卡 + 聊天框上方「后台工作」条，点开看「任务书 + 子代理自己的工作过程」）：
 *   A. 共享类型 / 解析 / 目标构造（纯函数）
 *   B. 客户端取数（fetch 分派、重试口径）
 *   C. `GET /api/tasks/[id]/subagent-runs` 路由
 *   D. UI / 接线的源码契约（两个入口、宿主位置、不嵌套 button、动效与颜色规范）
 *
 * 服务端记录器本身见 subagent-transcript.test.ts；Cursor 接线见 cursor-subagent-transcript.test.ts；
 * pi 接线见 pi-subagent-transcript.test.ts。DATA_DIR 须在动态 import 前钉死。
 */
import { mkdtempSync, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-subagent-detail-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const run = await import("../src/lib/subagent-run");
const client = await import("../src/lib/subagent-run-client");
const display = await import("../src/lib/subagent-run-display");
const subDisplay = await import("../src/lib/cursor-subagent-display");
const transcript = await import("../src/lib/server/subagent-transcript");
const route = await import("../src/app/api/tasks/[id]/subagent-runs/route");
const { taskDir } = await import("../src/lib/server/task-fs-core");

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const readSrc = (...seg: string[]): string =>
  readFileSync(path.join(srcDir, ...seg), "utf-8");
/** 去掉注释再查（文件头的说明文字不该触发 not.toContain） */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sliceFrom = (s: string, from: string, to?: string): string => {
  const a = s.indexOf(from);
  expect(a, `找不到 ${from}`).toBeGreaterThanOrEqual(0);
  const b = to ? s.indexOf(to, a + from.length) : -1;
  return b < 0 ? s.slice(a) : s.slice(a, b);
};

const validMeta = (over: Record<string, unknown> = {}) => ({
  key: "sa_abc123",
  provider: "cursor",
  description: "查资料",
  prompt: "完整任务书",
  explore: false,
  resumed: false,
  background: false,
  detached: false,
  status: "running",
  startedAt: 1_000,
  callIds: [],
  ...over,
});

beforeEach(() => {
  transcript.__resetSubagentRunsForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================ A. 纯函数

describe("parseSubagentRunSnapshot：接口 / 落盘文件按不可信输入校验", () => {
  it("meta 不合法 → 整份丢弃（宁可显示「没有记录」也别拿脏数据喂渲染管线）", () => {
    expect(run.parseSubagentRunSnapshot(null)).toBeNull();
    expect(run.parseSubagentRunSnapshot({})).toBeNull();
    expect(run.parseSubagentRunSnapshot({ meta: validMeta({ key: "" }), events: [] })).toBeNull();
    expect(run.parseSubagentRunSnapshot({ meta: validMeta({ prompt: 1 }), events: [] })).toBeNull();
    expect(run.parseSubagentRunSnapshot({ meta: validMeta({ status: "weird" }), events: [] })).toBeNull();
    expect(run.parseSubagentRunSnapshot({ meta: validMeta({ startedAt: "x" }), events: [] })).toBeNull();
  });

  it("events 逐条校验：只留 thinking / assistant_message / tool_call / tool_result，坏条目丢、同 id 去重", () => {
    const snap = run.parseSubagentRunSnapshot({
      meta: validMeta(),
      rev: 7,
      droppedEvents: 3.9,
      events: [
        { id: "a", ts: 1, kind: "thinking", text: "想" },
        { id: "a", ts: 2, kind: "thinking", text: "重复 id" },
        { id: "b", ts: 3, kind: "assistant_message", text: "话" },
        { id: "c", ts: 4, kind: "tool_call", text: "调用", meta: { callId: "x" } },
        { id: "d", ts: 5, kind: "info", text: "不该出现的种类" },
        { id: "e", ts: 6, kind: "thinking" },
        { ts: 7, kind: "thinking", text: "没 id" },
        null,
        "str",
      ],
    });
    expect(snap?.events.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(snap?.events[0]!.text).toBe("想");
    expect(snap?.events[2]!.meta).toEqual({ callId: "x" });
    expect(snap?.rev).toBe(7);
    expect(snap?.droppedEvents).toBe(3);
  });

  it("缺省值：描述空 → 「子任务」；provider 只认 pi、其余 cursor；rev / dropped 缺省为 0", () => {
    const snap = run.parseSubagentRunSnapshot({
      meta: validMeta({ description: "  ", provider: "???" }),
    });
    expect(snap?.meta.description).toBe("子任务");
    expect(snap?.meta.provider).toBe("cursor");
    expect(snap?.rev).toBe(0);
    expect(snap?.droppedEvents).toBe(0);
    expect(snap?.events).toEqual([]);
  });
});

describe("parseSubagentRunResponse", () => {
  it("404 → missing；unchanged；snapshot；其它畸形 → null", () => {
    expect(run.parseSubagentRunResponse(404, null)).toEqual({ kind: "missing" });
    expect(run.parseSubagentRunResponse(200, { ok: true, unchanged: true, rev: 5 })).toEqual({
      kind: "unchanged",
      rev: 5,
    });
    const snap = run.parseSubagentRunResponse(200, {
      ok: true,
      run: { meta: validMeta(), events: [], rev: 2, droppedEvents: 0 },
    });
    expect(snap?.kind).toBe("snapshot");
    expect(run.parseSubagentRunResponse(200, { ok: true })).toBeNull();
    expect(run.parseSubagentRunResponse(500, { error: "x" })).toBeNull();
    expect(run.parseSubagentRunResponse(200, null)).toBeNull();
    // unchanged 必须带数字 rev
    expect(run.parseSubagentRunResponse(200, { unchanged: true })).toBeNull();
  });
});

describe("状态 / 计时 / 目标 id", () => {
  it("终态判定与中文标签", () => {
    expect(run.isSubagentRunTerminal("running")).toBe(false);
    for (const s of ["done", "failed", "cancelled", "interrupted"] as const) {
      expect(run.isSubagentRunTerminal(s)).toBe(true);
    }
    expect(run.subagentRunStatusLabel("running")).toBe("运行中");
    expect(run.subagentRunStatusLabel("done")).toBe("已完成");
    expect(run.subagentRunStatusLabel("failed")).toBe("失败");
    expect(run.subagentRunStatusLabel("cancelled")).toBe("已取消");
    expect(run.subagentRunStatusLabel("interrupted")).toBe("已中断");
  });

  it("已用时：运行中用 now、终态用 endedAt、时钟回拨钳 0", () => {
    expect(run.subagentRunElapsedMs({ status: "running", startedAt: 1_000 }, 4_000)).toBe(3_000);
    expect(
      run.subagentRunElapsedMs({ status: "done", startedAt: 1_000, endedAt: 2_500 }, 99_999),
    ).toBe(1_500);
    expect(run.subagentRunElapsedMs({ status: "running", startedAt: 5_000 }, 1_000)).toBe(0);
  });

  it("目标 id：同一个目标稳定、不同目标不同（面板据此判断「又点开了同一个」）", () => {
    const a = { ref: { by: "key", key: "sa_1" } } as const;
    const b = { ref: { by: "callId", callId: "sa_1" } } as const;
    expect(run.subagentDetailTargetId(a)).toBe(run.subagentDetailTargetId({ ...a }));
    expect(run.subagentDetailTargetId(a)).not.toBe(run.subagentDetailTargetId(b));
  });
});

describe("目标构造：卡片 / 条 → 详情面板的打开目标", () => {
  it("事件流卡片：按 callId 找；卡片自带的任务书 / 产出 / 模型作兜底，运行中标 running", () => {
    const t = display.subagentTargetFromToolBlock({
      callId: "call-1",
      args: JSON.stringify({ description: "查资料", prompt: "任务书", model: "m1", effort: "high" }),
      status: "running",
      result: undefined,
    });
    expect(t.ref).toEqual({ by: "callId", callId: "call-1" });
    expect(t.title).toBe("查资料");
    expect(t.fallback).toMatchObject({
      description: "查资料",
      prompt: "任务书",
      model: "m1",
      effort: "high",
      running: true,
    });
    const done = display.subagentTargetFromToolBlock({
      callId: "call-2",
      args: undefined,
      status: "success",
      result: { callId: "call-2", name: "task", status: "success", output: "产出文本" },
    });
    expect(done.fallback?.running).toBe(false);
    expect(done.fallback?.output).toBe("产出文本");
    expect(done.title).toBeUndefined();
  });

  it("后台条的一行：有 runKey 才可点（按 key 找）；没有 → null（只展示、不画可点样式）", () => {
    expect(display.subagentTargetFromJob({ description: "x", runKey: undefined })).toBeNull();
    const t = display.subagentTargetFromJob({ description: "查资料", runKey: "sa_9" });
    expect(t?.ref).toEqual({ by: "key", key: "sa_9" });
    expect(t?.fallback?.running).toBe(true);
  });
});

describe("extractSubagentCallArgs：从 MCP 外壳里取模型传的原始入参（配对用，必须是完整任务书）", () => {
  const mcp = (inner: unknown) => ({
    name: "mcp",
    args: {
      providerIdentifier: subDisplay.CURSOR_CUSTOM_TOOLS_SERVER,
      toolName: subDisplay.CURSOR_SUBAGENT_TOOL_NAME,
      args: inner,
    },
  });
  it("subagent 调用 → 完整 prompt / description；不是 subagent → null；入参缺失 → 字段缺省", () => {
    const long = "长".repeat(5000);
    expect(subDisplay.extractSubagentCallArgs(mcp({ prompt: long, description: "d" }) as never)).toEqual({
      prompt: long,
      description: "d",
    });
    expect(subDisplay.extractSubagentCallArgs({ name: "read", args: {} } as never)).toBeNull();
    expect(
      subDisplay.extractSubagentCallArgs({
        name: "mcp",
        args: { providerIdentifier: "other", toolName: "x", args: { prompt: "p" } },
      } as never),
    ).toBeNull();
    expect(subDisplay.extractSubagentCallArgs(mcp(undefined) as never)).toEqual({});
    expect(subDisplay.extractSubagentCallArgs(mcp({ prompt: 1 }) as never)).toEqual({});
  });
});

// ============================================================ B. 客户端取数

describe("subagentRunUrl / fetchSubagentRun", () => {
  it("url：key 与 callId 二选一、callId 要 URL 编码、rev 可选", () => {
    expect(client.subagentRunUrl("t1", { by: "key", key: "sa_1" })).toBe(
      "/api/tasks/t1/subagent-runs?key=sa_1",
    );
    const u = client.subagentRunUrl("t 1", { by: "callId", callId: "call-1\nfc_2" }, 7);
    expect(u).toContain("/api/tasks/t%201/subagent-runs?");
    expect(u).toContain("callId=call-1%0Afc_2");
    expect(u).toContain("rev=7");
    expect(client.subagentRunUrl("t", { by: "key", key: "sa_1" }, Number.NaN)).not.toContain("rev=");
  });

  const mockFetch = (status: number, body: unknown) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status }),
    );

  it("200 快照 / 200 unchanged / 404 missing；非预期响应（500 / 非 JSON）抛错让调用方决定重试", async () => {
    mockFetch(200, { ok: true, run: { meta: validMeta(), events: [], rev: 3, droppedEvents: 0 } });
    expect((await client.fetchSubagentRun("t", { by: "key", key: "sa_1" })).kind).toBe("snapshot");
    mockFetch(200, { ok: true, unchanged: true, rev: 3 });
    expect(await client.fetchSubagentRun("t", { by: "key", key: "sa_1" }, { rev: 3 })).toEqual({
      kind: "unchanged",
      rev: 3,
    });
    mockFetch(404, { error: "not_found" });
    expect(await client.fetchSubagentRun("t", { by: "key", key: "sa_1" })).toEqual({ kind: "missing" });
    mockFetch(500, { error: "boom" });
    await expect(client.fetchSubagentRun("t", { by: "key", key: "sa_1" })).rejects.toThrow("HTTP 500");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>", { status: 200 }));
    await expect(client.fetchSubagentRun("t", { by: "key", key: "sa_1" })).rejects.toThrow();
  });

  it("请求带 no-store（运行中的内容每秒在变）", async () => {
    const spy = mockFetch(404, {});
    await client.fetchSubagentRun("t", { by: "key", key: "sa_1" });
    expect(spy.mock.calls[0]![1]).toMatchObject({ cache: "no-store" });
  });

  it("404 后再等几轮：还在跑的卡片 / 条等记录建好，已跑完的（含功能上线前的历史卡片）不等", () => {
    expect(client.missingRetryRounds({ running: true })).toBeGreaterThan(5);
    expect(client.missingRetryRounds({ running: false })).toBe(0);
    expect(client.missingRetryRounds(undefined)).toBe(0);
  });
});

describe("buildSubagentRunItems：走主流同一条管线", () => {
  const ev = (id: string, kind: string, text: string, meta?: Record<string, unknown>) =>
    ({ id, ts: 1, kind, text, ...(meta ? { meta } : {}) }) as never;

  it("思考 + 工具成一个工作过程组；回复独立；已结束时没等到结果的工具改判已中断", () => {
    const events = [
      ev("1", "thinking", "想"),
      ev("2", "tool_call", "调用", { callId: "c1", name: "read", args: "{}" }),
      ev("3", "tool_result", "完成", { callId: "c1", name: "read", status: "success", output: "ok" }),
      ev("4", "tool_call", "调用", { callId: "c2", name: "grep", args: "{}" }),
      ev("5", "assistant_message", "结论"),
    ];
    const live = display.buildSubagentRunItems(events, true);
    expect(live.map((i) => i.kind)).toEqual(["__work_group__", "assistant_message"]);
    expect((live[0] as { hasRunning: boolean }).hasRunning).toBe(true);
    const done = display.buildSubagentRunItems(events, false);
    expect((done[0] as { hasRunning: boolean }).hasRunning).toBe(false);
    expect(display.buildSubagentRunItems([], true)).toEqual([]);
  });
});

describe("shouldStickToBottom：详情面板内容更新后要不要贴底", () => {
  const f = display.shouldStickToBottom;

  it("运行中且没往上翻：贴；往上翻了（不再 following）：不贴", () => {
    expect(f({ following: true, running: true, wasRunning: true })).toBe(true);
    expect(f({ following: false, running: true, wasRunning: true })).toBe(false);
  });

  it("刚跑完的那一帧（上一次还在跑、现在终态）也要贴一次：终态会追加产出 / 失败原因 / 取消说明", () => {
    expect(f({ following: true, running: false, wasRunning: true })).toBe(true);
    // 但用户已经往上翻了就不拽他
    expect(f({ following: false, running: false, wasRunning: true })).toBe(false);
  });

  it("一打开就是终态（历史记录）：不贴，从任务书开始读", () => {
    expect(f({ following: true, running: false, wasRunning: false })).toBe(false);
  });
});

// 复审（第三批）：换成通用跟随控制器后，控制器初值 following=true，且它有一条不经过 shouldStickToBottom 的
// 「滚动区高度一变就贴底」路径——一打开就是终态的历史记录，缩窗口 / 头部徽标长出来都会把人拽到最底
describe("releaseFollowOnOpen：面板一打开要不要放掉控制器的 following", () => {
  const f = display.releaseFollowOnOpen;

  it("首个快照就是终态（历史记录）：放掉，从任务书读起", () => {
    for (const status of ["done", "failed", "cancelled", "interrupted"] as const) {
      expect(f({ status, phase: "ready" })).toBe(true);
    }
  });

  it("首个快照是运行中：保持跟随（新内容要贴底）", () => {
    expect(f({ status: "running", phase: "ready" })).toBe(false);
  });

  it("没有过程记录（只有卡片自带的任务书 / 产出）：放掉——那里没有在长的内容", () => {
    expect(f({ status: undefined, phase: "missing" })).toBe(true);
  });

  it("判据还没到（加载中 / 在等记录建好 / 请求失败待重试）：先别动", () => {
    expect(f({ status: undefined, phase: "loading" })).toBeUndefined();
    expect(f({ status: undefined, phase: "error" })).toBeUndefined();
  });

  it("有快照时以快照状态为准，与 phase 无关（重试成功后的首个快照照样判）", () => {
    expect(f({ status: "done", phase: "error" })).toBe(true);
    expect(f({ status: "running", phase: "loading" })).toBe(false);
  });
});

// ============================================================ C. 路由

describe("GET /api/tasks/[id]/subagent-runs", () => {
  const get = (id: string, query: string) =>
    route.GET(new Request(`http://localhost/api/tasks/${id}/subagent-runs?${query}`), {
      params: Promise.resolve({ id }),
    });

  const mkTask = async (id: string) => {
    await fs.mkdir(taskDir(id), { recursive: true });
    return id;
  };

  const startOne = (taskId: string, toolCallId?: string) => {
    const h = transcript.startSubagentRun({
      taskId,
      provider: "cursor",
      description: "查资料",
      prompt: "完整任务书",
      explore: true,
      toolCallId,
    });
    h.onMessage({ type: "assistant", message: { content: [{ type: "text", text: "你好" }] } });
    return h;
  };

  it("按 key 取到快照；no-store；带 rev 且一致 → unchanged（不回整份过程）", async () => {
    const taskId = await mkTask("t_route_1");
    const h = startOne(taskId);
    const res = await get(taskId, `key=${h.key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.run.meta.prompt).toBe("完整任务书");
    expect(body.run.events).toHaveLength(1);

    const same = await (await get(taskId, `key=${h.key}&rev=${body.run.rev}`)).json();
    expect(same).toEqual({ ok: true, unchanged: true, rev: body.run.rev });

    // 有变化（rev 落后）→ 整份
    h.onMessage({ type: "thinking", text: "新内容" });
    const next = await (await get(taskId, `key=${h.key}&rev=${body.run.rev}`)).json();
    expect(next.run.events).toHaveLength(2);
    expect(next.run.rev).toBeGreaterThan(body.run.rev);
  });

  it("按 callId 取（事件流卡片）；key 与 callId 都给时 key 优先", async () => {
    const taskId = await mkTask("t_route_2");
    const a = startOne(taskId, "card-A");
    const b = startOne(taskId, "card-B");
    const byCall = await (await get(taskId, "callId=card-A")).json();
    expect(byCall.run.meta.key).toBe(a.key);
    const both = await (await get(taskId, `key=${b.key}&callId=card-A`)).json();
    expect(both.run.meta.key).toBe(b.key);
  });

  it("404：查不到（历史卡片 / 被清理）；400：缺参数 / id 或 key 形状不对 / callId 过长", async () => {
    const taskId = await mkTask("t_route_3");
    expect((await get(taskId, "key=sa_00000000")).status).toBe(404);
    expect((await get(taskId, "callId=nope")).status).toBe(404);
    expect((await get(taskId, "")).status).toBe(400);
    expect((await get(taskId, "key=../etc")).status).toBe(400);
    expect((await get(taskId, `callId=${"x".repeat(301)}`)).status).toBe(400);
    expect((await get("../evil", "key=sa_00000000")).status).toBe(400);
  });

  it("重启后（内存清空）仍能从磁盘取到；写着运行中的变成 interrupted", async () => {
    const taskId = await mkTask("t_route_4");
    const h = startOne(taskId, "card-D");
    h.finish({ status: "done", result: "好了" });
    await transcript.__flushSubagentRunWritesForTests();
    transcript.__resetSubagentRunsForTests();
    const body = await (await get(taskId, `key=${h.key}`)).json();
    expect(body.run.meta.status).toBe("done");
    expect(body.run.meta.result).toBe("好了");
  });

  it("重启后磁盘上写着 running、且 rev 恰好等于客户端手上那份：不能回 unchanged 把 interrupted 吞掉（面板会一直显示运行中）", async () => {
    const taskId = await mkTask("t_route_5");
    const key = "sa_abc123";
    const dir = path.join(taskDir(taskId), "subagent-runs");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${key}.json`),
      JSON.stringify({
        meta: validMeta({ key, status: "running" }),
        events: [{ id: "sr_1", ts: 1, kind: "assistant_message", text: "做到一半" }],
        rev: 5,
        droppedEvents: 0,
      }),
    );
    // 客户端手上是重启前拿到的运行中快照（rev=5，与磁盘上最后一次落盘的 rev 相同）
    const res = await get(taskId, `key=${key}&rev=5`);
    const body = await res.json();
    expect(body.unchanged).toBeUndefined();
    expect(body.run.meta.status).toBe("interrupted");
    expect(body.run.rev).toBe(5);
    // 客户端据此认出终态、停止轮询
    expect(run.isSubagentRunTerminal(body.run.meta.status)).toBe(true);
  });

  it("终态一律回整份（不论 rev 是否相同）；运行中且 rev 相同才 unchanged", async () => {
    const taskId = await mkTask("t_route_6");
    const h = startOne(taskId);
    const live = await (await get(taskId, `key=${h.key}`)).json();
    expect(
      await (await get(taskId, `key=${h.key}&rev=${live.run.rev}`)).json(),
    ).toEqual({ ok: true, unchanged: true, rev: live.run.rev });

    h.finish({ status: "done", result: "好了" });
    const done = await (await get(taskId, `key=${h.key}`)).json();
    const again = await (await get(taskId, `key=${h.key}&rev=${done.run.rev}`)).json();
    expect(again.unchanged).toBeUndefined();
    expect(again.run.meta.status).toBe("done");
  });

  it("DELETE /api/tasks/[id] 删任务时清子代理记录的内存表：排在 discardStashed… 之后、写逻辑删除标记之前（源码契约）", () => {
    const code = stripComments(readSrc("app", "api", "tasks", "[id]", "route.ts"));
    const discardAt = code.indexOf("discardStashedBackgroundResultsForDeletedTask(id);");
    const forgetAt = code.indexOf("forgetSubagentRunsForDeletedTask(id);");
    const tombstoneAt = code.indexOf("await writeDeleteTombstone(id);");
    expect(discardAt).toBeGreaterThan(0);
    expect(forgetAt).toBeGreaterThan(discardAt);
    expect(tombstoneAt).toBeGreaterThan(forgetAt);
  });

  it("路由文件：nodejs runtime、不读 task.json（轮询每秒一次、别每次都读盘）", () => {
    const code = readSrc("app", "api", "tasks", "[id]", "subagent-runs", "route.ts");
    expect(code).toContain('export const runtime = "nodejs"');
    expect(stripComments(code)).not.toContain("getTask");
  });
});

// ============================================================ D. 源码契约

describe("契约：事件流里的子代理卡片", () => {
  const code = readSrc("components", "tasks", "event-stream", "tool-block.tsx");
  const card = sliceFrom(code, "const TaskSubagentBlock = (", "const RegularToolBlockRow = (");

  it("卡片头有「详情」入口：按 callId 开面板，任务书 / 产出作兜底；不在宿主里（单独复用）就不画", () => {
    expect(card).toContain("useOpenSubagentDetail()");
    expect(card).toContain("subagentTargetFromToolBlock(block)");
    expect(card).toContain('aria-label="查看子代理详情"');
    expect(card).toContain("{openDetail ? (");
    // 用 context 叶子模块、不直接 import 面板（面板要 import 工具块，直接依赖就是循环依赖）
    expect(code).toContain('@/components/tasks/subagent-detail-context"');
    expect(code).not.toContain('@/components/tasks/subagent-detail"');
  });

  it("详情按钮与折叠按钮并排、不嵌套（button 套 button 不合法）", () => {
    const toggleAt = card.indexOf("onClick={() => setCollapsed((c) => !c)}");
    const detailAt = card.indexOf('aria-label="查看子代理详情"');
    expect(toggleAt).toBeGreaterThan(0);
    expect(detailAt).toBeGreaterThan(toggleAt);
    // 折叠按钮先闭合、详情按钮才开始
    const between = card.slice(toggleAt, detailAt);
    expect(between).toContain("</button>");
    // 详情按钮用 Tooltip、不用原生 title
    expect(stripComments(card)).not.toMatch(/\btitle=/);
  });
});

describe("契约：面板宿主挂在 EventStream 根上（卡片和条都在它里面）", () => {
  const code = readSrc("components", "tasks", "event-stream.tsx");

  it("SubagentDetailHost 包住整棵树：Virtuoso 里卡片滚出视口卸载时抽屉不丢", () => {
    const open = code.indexOf("<SubagentDetailHost task={task}>");
    const follow = code.indexOf("<StreamFollowContext.Provider");
    const close = code.indexOf("</SubagentDetailHost>");
    const followClose = code.indexOf("</StreamFollowContext.Provider>");
    expect(open).toBeGreaterThan(0);
    expect(open).toBeLessThan(follow);
    expect(close).toBeGreaterThan(followClose);
    // 后台条在 EventStream 里面——也就在宿主里面
    expect(code.indexOf("<BackgroundSubagentsBar")).toBeGreaterThan(open);
    expect(code.indexOf("<BackgroundSubagentsBar")).toBeLessThan(close);
  });

  it("抽屉开着时不抢键盘：自动聚焦输入框、Cmd/Ctrl+End 回到最新都让行（焦点 / 按键目标在抽屉里）", () => {
    const src = stripComments(code);
    // 自动聚焦：在 timer 回调里判焦点（真正 focus 的那一刻），在抽屉里就不抢
    const focusEffect = sliceFrom(src, "if (isAwaitingUser) {", "}, [isAwaitingUser, inputRef]);");
    expect(focusEffect).toContain("isInsideSheet(document.activeElement)");
    expect(focusEffect.indexOf("isInsideSheet(document.activeElement)")).toBeLessThan(
      focusEffect.indexOf("inputRef.current?.focus()"),
    );
    expect(focusEffect.indexOf("setTimeout(")).toBeLessThan(
      focusEffect.indexOf("isInsideSheet(document.activeElement)"),
    );
    // Cmd/Ctrl+End：目标在抽屉里就 return、且在 preventDefault 之前（别吞掉抽屉自己的滚动）
    const endHandler = sliceFrom(src, 'if (!isModCombo(e, "End")) return;', "backToBottom();");
    expect(endHandler).toContain("if (isInsideSheet(e.target)) return;");
    expect(endHandler.indexOf("isInsideSheet(e.target)")).toBeLessThan(
      endHandler.indexOf("e.preventDefault()"),
    );
  });
});

describe("契约：聊天框上方「后台工作」条", () => {
  const code = stripComments(readSrc("components", "tasks", "background-subagents-bar.tsx"));

  it("只有一个且有记录 key：整条直接开详情；多个：Popover 列表、点一行开详情（先收起列表）", () => {
    expect(code).toContain("useOpenSubagentDetail()");
    expect(code).toContain("subagentTargetFromJob(");
    expect(code).toContain("openDetail(singleTarget)");
    expect(code).toContain("setListOpen(false)");
    expect(code).toContain("openDetail(target)");
    // 没有记录 key 的行不可点（目标为 null → 走非 button 的展示行）
    expect(code).toContain("target && openDetail");
  });

  it("列表展开状态放在 Popover 子组件里、不放 BarBody：条切到「单个直接开详情」/ 收起时随分支卸载，不会粘住", () => {
    const popover = sliceFrom(code, "const JobsListPopover = (", "const BarBody = (");
    expect(popover).toContain("const [listOpen, setListOpen] = useState(false);");
    expect(popover).toContain("<Popover open={listOpen} onOpenChange={setListOpen}>");
    const body = sliceFrom(code, "const BarBody = (", "export const BackgroundSubagentsBar");
    // BarBody 自己不再持有 listOpen（持有的话列表开着时收尾到只剩一个、再派第二个，列表会自己弹开）
    expect(body).not.toContain("listOpen");
    expect(body).not.toContain("useState");
    expect(body).toContain("<JobsListPopover");
  });

  it("没有宿主（不在 EventStream 里）时退回原来的只读 Popover，不画可点的假按钮", () => {
    expect(code).toContain("!multiple && openDetail ? subagentTargetFromJob");
    expect(code).toMatch(/openDetail \? "点某一行/);
  });
});

describe("契约：详情面板本体", () => {
  const raw = readSrc("components", "tasks", "subagent-detail.tsx");
  const code = stripComments(raw);

  it("过程走主流同一条渲染管线：工作过程组默认展开、工具块 / 动词组 / 事件行复用主流组件", () => {
    expect(code).toContain("buildSubagentRunItems(");
    expect(code).toContain("<WorkGroupRow");
    expect(code).toContain("defaultExpanded");
    expect(code).toContain("<ToolBlockRow");
    expect(code).toContain("<ToolVerbGroupRow");
    expect(code).toContain("<EventRow");
  });

  it("内容分区：任务书全文（可复制）/ 工作过程 / 失败原因 / 产出；找不到记录时退回卡片自带的并说明原因", () => {
    for (const t of ['title="任务书"', 'title="工作过程"', 'title="失败原因"', 'title="产出"']) {
      expect(code).toContain(t);
    }
    expect(code).toContain("复制任务书");
    expect(code).toContain("没有找到这次子代理的过程记录");
    expect(code).toContain("fallback?.prompt");
    expect(code).toContain("fallback.output");
  });

  it("不重复画产出：已有流式回复时产出就在过程里，只有没有回复 / 过程被截断时才单独画", () => {
    expect(code).toContain("!hasAssistantReply || (snapshot?.droppedEvents ?? 0) > 0");
  });

  it("宿主：Sheet 只开关抽屉；目标连同所属 task 一起存（换 task 不残留）；面板按目标 key 重置", () => {
    expect(code).toContain("<Sheet open={visible} onOpenChange={setOpen}>");
    expect(code).toContain("opened?.taskId === task.id");
    expect(code).toContain("key={subagentDetailTargetId(opened.target)}");
    expect(code).toContain("SubagentDetailContext.Provider");
  });

  it("终态那一帧也贴底：effect 用 wasRunningRef 认出「刚跑完」、判定走 shouldStickToBottom（不再只看 running）", () => {
    const effect = sliceFrom(code, "const wasRunningRef = useRef(false);", "}, [running, rev, follow]);");
    expect(effect).toContain("const wasRunning = wasRunningRef.current;");
    expect(effect).toContain("wasRunningRef.current = running;");
    expect(effect).toContain("shouldStickToBottom({ following: follow.isFollowing(), running, wasRunning })");
    // 旧判定（`!running` 就返回）会把终态帧漏掉
    expect(effect).not.toContain("if (!running ||");
  });

  it("一打开就是终态：layout effect 里按 releaseFollowOnOpen 放掉 following（只判一次、判据没到不动）", () => {
    const effect = sliceFrom(code, "const openDecidedRef = useRef(false);", "}, [openStatus, openPhase, follow]);");
    expect(effect).toContain("useLayoutEffect(");
    expect(effect).toContain("releaseFollowOnOpen({ status: openStatus, phase: openPhase })");
    expect(effect).toContain("if (release === undefined) return;");
    expect(effect).toContain("openDecidedRef.current = true;");
    expect(effect).toContain("if (release) follow.setFollowing(false);");
    // 只判一次：已经判过就直接返回（不然跑着的子代理后来变终态时会被误放掉）
    expect(effect).toContain("if (openDecidedRef.current) return;");
  });

  it("贴底只走跟随控制器（ui-conventions「贴底只走控制器」）：不自己写 scrollTop / 不自己算离底距离 / 不自己挂 onScroll", () => {
    expect(code).toContain('from "@/hooks/use-stream-follow"');
    expect(code).toContain("useStreamFollow(");
    expect(code).toContain("ref={follow.attachScroller}");
    expect(code).toContain("follow.requestScrollToBottom()");
    // 面板里不能再有第二套自动滚动：一旦有，两套贴底会互相打架（用户上滚后被另一套拉回）
    expect(code).not.toMatch(/\.scrollTop\s*=/);
    expect(code).not.toContain("scrollHeight");
    expect(code).not.toContain("onScroll");
    expect(code).not.toContain("FOLLOW_THRESHOLD_PX");
  });

  it("计时只在运行中走字", () => {
    expect(code).toContain("useNow(running)");
    expect(code).toContain("if (!active) return;");
  });

  it("守 ui-conventions：语义 token、白卡 + 边、无新动效、不用原生 title / 10px / 裸色号", () => {
    // 原生 title（hover 提示要走 Tooltip）：Section 自己的 title 属性是组件 prop，不算
    expect(code).not.toMatch(/<(?:button|span|div|svg|p|pre|a)\b[^>]*\btitle=/);
    expect(code).not.toContain("text-[10px]");
    // 文字颜色不加透明度（`text-foreground/90` 之类：层级靠语义 token 区分，不靠透明度）
    expect(code).not.toMatch(/\btext-[a-z][a-z-]*\/\d+/);
    expect(code).not.toMatch(/animate-(ping|pulse|spin|bounce)/);
    expect(code).not.toMatch(
      /\b(?:bg|text|border|ring)-(?:red|orange|amber|yellow|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}/,
    );
    expect(code).toContain("bg-card");
    expect(code).toContain("border-border");
    expect(code).toContain("bg-info"); // 运行中静态 info 点
    // 状态徽标走 Badge 的语义变体
    expect(code).toContain('"success"');
    expect(code).toContain('"destructive"');
  });

  it("子代理回复行比主流的 AI 回复行轻：不挂「分享到需求群」等主流才有的操作", () => {
    const reply = sliceFrom(code, "const SubagentReplyRow = (", "// ---------- 头部");
    expect(reply).not.toContain("share");
    expect(reply).not.toContain("onQuote");
  });
});

describe("契约：取数 hook（状态机本体的行为测试见 subagent-run-polling.test.ts）", () => {
  const code = stripComments(readSrc("hooks", "use-subagent-run.ts"));

  it("hook 只做接线：把状态机的 stop 作为 effect 清理返回（关闭 / 换目标掐掉在飞请求和定时器）；状态带上 forKey", () => {
    expect(code).toContain("return startSubagentRunPolling({");
    expect(code).toContain("onState: (s) => setState({ forKey: openKey, ...s })");
    // 状态机别又长回 hook 里（那样就只剩源码字符串能测了）
    expect(code).not.toContain("fetchSubagentRun");
    expect(code).not.toContain("setTimeout");
    expect(code).not.toContain("AbortController");
  });
});

describe("契约：服务端接线", () => {
  it("主流消息处理在改写 / 截断之前通知记录器（要拿完整任务书）", () => {
    const code = readSrc("lib", "server", "sdk-message-handler.ts");
    const note = code.indexOf("noteSubagentToolCall(taskId");
    const rewrite = code.indexOf("toSubagentDisplayCall(");
    expect(note).toBeGreaterThan(0);
    expect(rewrite).toBeGreaterThan(note);
    expect(code).toContain("extractSubagentCallArgs(rawMsg)");
  });

  it("agent-backend 把记录器接到 Cursor 子代理链接上（task / chat 都记，按 taskId 落盘）", () => {
    const code = stripComments(readSrc("lib", "server", "agent-backend.ts"));
    expect(code).toContain("startSubagentRun({");
    expect(code).toContain('provider: "cursor"');
    expect(code).toContain("transcripts:");
  });

  it("pi 路径：task 工具把 toolCallId 交给子代理运行器；运行器在 prompt 前起记录、收尾记 done / failed / cancelled", () => {
    const tools = readSrc("lib", "server", "pi-coding-tools.ts");
    expect(tools).toContain("runSubagent(parsed.request, signal, { toolCallId })");
    const backend = stripComments(readSrc("lib", "server", "custom-agent-backend.ts"));
    expect(backend).toContain("toolCallId: c?.toolCallId");
    expect(backend).toContain("startPiSubagentRecord({");
    expect(backend).toContain('safeFinishRecord(rec, { status: "done"');
    expect(backend).toContain('{ status: "cancelled" }');
    expect(backend).toContain('{ status: "failed", error: msg }');
  });

  it("记录器不反向依赖运行时（避免循环）：只依赖 data-root / task-fs-core / tool-result-persist / 脱敏", () => {
    const code = stripComments(readSrc("lib", "server", "subagent-transcript.ts"));
    for (const banned of ["chat-runner", "task-runner", "cursor-subagent", "agent-backend", "custom-agent-backend"]) {
      expect(code, banned).not.toMatch(new RegExp(`from "[^"]*${banned}"`));
    }
  });

  it("子代理工具里记录器的每次调用都包了 try/catch（recSafe）", () => {
    const code = stripComments(readSrc("lib", "server", "cursor-subagent.ts"));
    expect(code).toContain("const recSafe = (fn: () => void): void => {");
    // 把所有 recSafe( … ) 整段（配平括号）抠掉，剩下的代码里不许再有对记录句柄的裸调
    let rest = code;
    for (let at = rest.indexOf("recSafe(", rest.indexOf("const recSafe")); at >= 0; at = rest.indexOf("recSafe(")) {
      // 跳过 recSafe 自己的定义
      if (rest.slice(Math.max(0, at - 6), at) === "const ") break;
      let depth = 0;
      let end = at + "recSafe".length;
      for (let i = end; i < rest.length; i += 1) {
        if (rest[i] === "(") depth += 1;
        else if (rest[i] === ")") {
          depth -= 1;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      rest = rest.slice(0, at) + rest.slice(end);
    }
    expect(rest).not.toMatch(/\brec\??\.(onMessage|finish|setBackground|setAgentId)\(/);
  });
});
