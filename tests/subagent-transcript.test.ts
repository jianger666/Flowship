/**
 * 子代理过程记录（服务端 `subagent-transcript`）：记 / 存 / 查 / 绑 callId。
 *
 * 契约（对应用户 2026-10-17「事件流里的子代理和聊天框上方的子代理都能点开看详情：给子代理的提示词 + 子代理干活的事件流」）：
 *  - 记：thinking / 回复 / 工具调用 / 工具结果记成和主事件流同形的 TaskEvent，能直接喂主流同一条渲染管线
 *  - 存：运行中节流落盘、收尾立刻落盘；脱敏；0600；任务被删后绝不把目录又建出来；超限只留最近 N 份
 *  - 查：先内存再磁盘；磁盘里写着 running 的 = 进程已不是写它的那个 → interrupted
 *  - 绑：事件流卡片按 callId 找——精确（toolCallId）+ 兜底（任务书一致，两种先后顺序都认）
 *  - 记录器绝不抛、不影响子代理本身
 *
 * DATA_DIR 须在动态 import 前钉死（与 tool-result-persist.test 同构）。
 */
import { mkdtempSync, promises as fs, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-subagent-transcript-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const transcript = await import("../src/lib/server/subagent-transcript");
const { taskDir, DELETED_TOMBSTONE_FILE, withTaskLock } = await import(
  "../src/lib/server/task-fs-core"
);
const { SUBAGENT_RUN_LIMITS } = await import("../src/lib/subagent-run");
const { buildSubagentRunItems } = await import("../src/lib/subagent-run-display");

const {
  startSubagentRun,
  noteSubagentToolCall,
  getSubagentRunSnapshot,
  __resetSubagentRunsForTests,
  __flushSubagentRunWritesForTests,
} = transcript;

let seq = 0;
/** 每个用例一个独立任务目录（真实存在：落盘要求任务目录还在） */
const freshTask = async (): Promise<string> => {
  seq += 1;
  const id = `t_sa_${seq}`;
  await fs.mkdir(taskDir(id), { recursive: true });
  return id;
};

const baseInit = (taskId: string, over: Partial<Parameters<typeof startSubagentRun>[0]> = {}) => ({
  taskId,
  provider: "cursor" as const,
  description: "查一下登录流程",
  prompt: "请阅读 src/auth 下的登录实现，列出入口函数和调用链。",
  explore: true,
  ...over,
});

const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

const toolCall = (
  callId: string,
  status: "running" | "completed" | "error",
  extra: Record<string, unknown> = {},
) => ({
  type: "tool_call",
  call_id: callId,
  name: "read",
  args: { path: "src/auth/login.ts" },
  status,
  ...extra,
});

beforeEach(() => {
  __resetSubagentRunsForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.FLOWSHIP_GITLAB_TOKEN;
});

describe("记：消息 → 和主事件流同形的 TaskEvent", () => {
  it("thinking / 回复按段累积：同一段的 chunk 合成一条，换了一种消息就封口另起一条", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    h.onMessage({ type: "thinking", text: "先看", thinking_duration_ms: 100 });
    h.onMessage({ type: "thinking", text: "目录结构", thinking_duration_ms: 250 });
    h.onMessage(assistant("我会"));
    h.onMessage(assistant("先读文件。"));
    h.onMessage({ type: "thinking", text: "第二段思考" });

    const snap = await getSubagentRunSnapshot(taskId, { key: h.key });
    expect(snap).not.toBeNull();
    expect(snap!.events.map((e) => [e.kind, e.text])).toEqual([
      ["thinking", "先看目录结构"],
      ["assistant_message", "我会先读文件。"],
      ["thinking", "第二段思考"],
    ]);
    // 思考耗时累加（折叠行显示「思考了 Ns」用）
    expect(snap!.events[0]!.meta?.durationMs).toBe(350);
    // id 唯一、有时间戳
    expect(new Set(snap!.events.map((e) => e.id)).size).toBe(3);
    expect(snap!.events.every((e) => e.ts > 0)).toBe(true);
  });

  it("工具调用：running 记 tool_call、completed 补 tool_result（同 callId 配对）；后续 running 只把 args 升级得更长", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    h.onMessage(toolCall("c1", "running", { args: { path: "a" } }));
    // SDK 对长 args 流式补全：同 callId 再来一帧更长的
    h.onMessage(toolCall("c1", "running", { args: { path: "a/b/c.ts", offset: 1 } }));
    h.onMessage(toolCall("c1", "completed", { result: { content: "文件内容" } }));
    // 同 callId 的重复 completed 不再记第二个 tool_result
    h.onMessage(toolCall("c1", "completed", { result: { content: "文件内容" } }));

    const snap = (await getSubagentRunSnapshot(taskId, { key: h.key }))!;
    expect(snap.events.map((e) => e.kind)).toEqual(["tool_call", "tool_result"]);
    const call = snap.events[0]!;
    expect(call.meta).toMatchObject({ callId: "c1", name: "read" });
    expect(String(call.meta?.args)).toContain("a/b/c.ts");
    const result = snap.events[1]!;
    expect(result.meta).toMatchObject({ callId: "c1", name: "read", status: "success" });
  });

  it("工具报错 → tool_result.status=error", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    h.onMessage(toolCall("c9", "running"));
    h.onMessage(toolCall("c9", "error", { result: "ENOENT: no such file" }));
    const snap = (await getSubagentRunSnapshot(taskId, { key: h.key }))!;
    expect(snap.events[1]!.meta?.status).toBe("error");
  });

  it("记下来的事件直接走主流同一条管线：思考 + 工具成一个工作过程组、回复独立成行；非运行态未闭合的工具改判已中断", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    h.onMessage({ type: "thinking", text: "想想" });
    h.onMessage(toolCall("c1", "running"));
    h.onMessage(toolCall("c1", "completed", { result: "ok" }));
    h.onMessage(toolCall("c2", "running")); // 没等到结果
    h.onMessage(assistant("结论如下"));
    const snap = (await getSubagentRunSnapshot(taskId, { key: h.key }))!;

    const live = buildSubagentRunItems(snap.events, true);
    expect(live.map((i) => i.kind)).toEqual(["__work_group__", "assistant_message"]);
    const liveGroup = live[0] as { hasRunning: boolean; members: Array<{ kind: string }> };
    expect(liveGroup.hasRunning).toBe(true);

    const done = buildSubagentRunItems(snap.events, false);
    const doneGroup = done[0] as { hasRunning: boolean };
    // 子代理已经不在跑了：c2 不能一直转圈
    expect(doneGroup.hasRunning).toBe(false);
  });

  it("条目数上限：超出后不再记新条目，同一段被丢的 chunk 只算一笔 dropped", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    const max = SUBAGENT_RUN_LIMITS.maxEvents;
    for (let i = 0; i < max; i += 1) h.onMessage(toolCall(`c${i}`, "running"));
    // 上限之后：一段回复分 5 个 chunk 来 = 1 笔；再来一个新工具 = 1 笔
    for (let i = 0; i < 5; i += 1) h.onMessage(assistant(`块${i}`));
    h.onMessage(toolCall("overflow", "running"));
    const snap = (await getSubagentRunSnapshot(taskId, { key: h.key }))!;
    expect(snap.events.filter((e) => e.kind === "tool_call")).toHaveLength(max);
    expect(snap.events.some((e) => e.kind === "assistant_message")).toBe(false);
    expect(snap.droppedEvents).toBe(2);
  });

  it("单段文本上限：超出截断并带省略标记，之后的 chunk 忽略", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    const max = SUBAGENT_RUN_LIMITS.assistantTextMax;
    h.onMessage(assistant("x".repeat(max - 10)));
    h.onMessage(assistant("y".repeat(100)));
    h.onMessage(assistant("z".repeat(100)));
    const snap = (await getSubagentRunSnapshot(taskId, { key: h.key }))!;
    const text = snap.events[0]!.text;
    expect(text.startsWith("x".repeat(max - 10) + "y".repeat(10))).toBe(true);
    expect(text).toContain("后面的内容已省略");
    expect(text).not.toContain("z");
  });

  it("不认识 / 畸形的消息一律忽略、不抛", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    for (const bad of [null, undefined, 42, "str", [], {}, { type: "nope" }, { type: "assistant" }]) {
      expect(() => h.onMessage(bad)).not.toThrow();
    }
    const snap = (await getSubagentRunSnapshot(taskId, { key: h.key }))!;
    expect(snap.events).toEqual([]);
  });
});

describe("收尾", () => {
  it("done：记结果、状态、结束时间；之后的消息和再次 finish 都被忽略", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    h.onMessage(assistant("结论"));
    h.finish({ status: "done", result: "最终产出" });
    h.finish({ status: "failed", error: "不该生效" });
    h.onMessage(assistant("收尾后的杂音"));
    const snap = (await getSubagentRunSnapshot(taskId, { key: h.key }))!;
    expect(snap.meta.status).toBe("done");
    expect(snap.meta.result).toBe("最终产出");
    expect(snap.meta.error).toBeUndefined();
    expect(snap.meta.endedAt).toBeGreaterThanOrEqual(snap.meta.startedAt);
    expect(snap.events).toHaveLength(1);
  });

  it("failed 记原因；cancelled 无结果", async () => {
    const taskId = await freshTask();
    const a = startSubagentRun(baseInit(taskId));
    a.finish({ status: "failed", error: "模型 503" });
    const b = startSubagentRun(baseInit(taskId));
    b.finish({ status: "cancelled" });
    const sa = (await getSubagentRunSnapshot(taskId, { key: a.key }))!;
    const sb = (await getSubagentRunSnapshot(taskId, { key: b.key }))!;
    expect(sa.meta).toMatchObject({ status: "failed", error: "模型 503" });
    expect(sb.meta.status).toBe("cancelled");
    expect(sb.meta.result).toBeUndefined();
  });

  it("元信息：模型 / effort / 只读 / 续做 / 后台 / 插话转后台", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(
      baseInit(taskId, {
        model: "claude-sonnet-5-5",
        effort: "high",
        resumed: true,
        agentId: "child-1",
        background: false,
      }),
    );
    h.setBackground(true);
    const snap = (await getSubagentRunSnapshot(taskId, { key: h.key }))!;
    expect(snap.meta).toMatchObject({
      provider: "cursor",
      model: "claude-sonnet-5-5",
      effort: "high",
      explore: true,
      resumed: true,
      agentId: "child-1",
      background: true,
      detached: true,
      status: "running",
      prompt: "请阅读 src/auth 下的登录实现，列出入口函数和调用链。",
    });
  });

  it("记录器的任何方法都不抛（内部出错只告警）", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    // 把 args 弄成会让 JSON.stringify 抛的循环引用
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => h.onMessage(toolCall("c1", "running", { args: cyclic }))).not.toThrow();
    expect(() => h.setAgentId(undefined)).not.toThrow();
    expect(() => h.finish({ status: "done", result: "ok" })).not.toThrow();
  });
});

describe("存：落盘 / 脱敏 / 权限 / 任务被删", () => {
  it("收尾立刻落盘，内容可被解析；文件 0600", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    h.onMessage(assistant("hi"));
    h.finish({ status: "done", result: "好了" });
    await __flushSubagentRunWritesForTests();
    const file = path.join(taskDir(taskId), "subagent-runs", `${h.key}.json`);
    const parsed = JSON.parse(await fs.readFile(file, "utf-8"));
    expect(parsed.meta.status).toBe("done");
    expect(parsed.events).toHaveLength(1);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("运行中节流落盘（~2s 一次）：到点才写、不是每个 chunk 写一次", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    const file = path.join(taskDir(taskId), "subagent-runs", `${h.key}.json`);
    for (let i = 0; i < 20; i += 1) h.onMessage(assistant(`chunk${i}`));
    await expect(fs.stat(file)).rejects.toThrow(); // 还没到点
    await vi.advanceTimersByTimeAsync(2100);
    await __flushSubagentRunWritesForTests();
    const parsed = JSON.parse(await fs.readFile(file, "utf-8"));
    expect(parsed.meta.status).toBe("running");
    expect(parsed.events[0].text).toContain("chunk19");
  });

  it("凭据脱敏：落盘文件和接口快照里都不出现 token 明文", async () => {
    const token = "glpat-SubagentTranscript0123456789";
    process.env.FLOWSHIP_GITLAB_TOKEN = token;
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId, { prompt: `用 ${token} 去拉代码` }));
    h.onMessage(assistant(`我看到了 ${token}`));
    h.onMessage(toolCall("c1", "running", { args: { command: `echo ${token}` } }));
    h.onMessage(toolCall("c1", "completed", { result: `out ${token}` }));
    h.finish({ status: "done", result: `最终 ${token}` });
    await __flushSubagentRunWritesForTests();

    const file = path.join(taskDir(taskId), "subagent-runs", `${h.key}.json`);
    expect(await fs.readFile(file, "utf-8")).not.toContain(token);
    const api = await getSubagentRunSnapshot(taskId, { key: h.key });
    expect(JSON.stringify(api)).not.toContain(token);
    expect(JSON.stringify(api)).toContain("[REDACTED");
  });

  it("任务目录不存在（任务被删）→ 不落盘、更不把目录建出来", async () => {
    const taskId = "t_sa_deleted_ghost";
    const h = startSubagentRun(baseInit(taskId));
    h.onMessage(assistant("hi"));
    h.finish({ status: "done", result: "ok" });
    await __flushSubagentRunWritesForTests();
    await expect(fs.stat(taskDir(taskId))).rejects.toThrow();
  });

  it("「检查通过」之后、真正写之前任务被删（deleteTask 持任务锁 rm）→ 锁内复查发现目录没了、不写、不把目录建回来", async () => {
    const taskId = await freshTask();
    const dir = taskDir(taskId);
    const realStat = fs.stat.bind(fs);
    let deletedAfterCheck = false;
    // 模拟时序：写前的快速检查（stat 任务目录）刚通过，deleteTask 就持锁把整个目录删了，然后才轮到写
    vi.spyOn(fs, "stat").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      const st = await (realStat as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      if (!deletedAfterCheck && String(p) === dir) {
        deletedAfterCheck = true;
        await withTaskLock(taskId, () => fs.rm(dir, { recursive: true, force: true }));
      }
      return st;
    }) as never);

    const h = startSubagentRun(baseInit(taskId));
    h.onMessage(assistant("hi"));
    h.finish({ status: "done", result: "ok" });
    await __flushSubagentRunWritesForTests();

    expect(deletedAfterCheck).toBe(true);
    // 没有锁内复查的话，这里 mkdir -p 会把 tasks/<id>/subagent-runs/ 又建出来
    await expect(realStat(dir)).rejects.toThrow();
  });

  it("写盘整段持任务锁（源码契约）：落盘与 callId 标记都走 writeIfTaskAlive，不直接 writePrivateFileAtomic", async () => {
    const src = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "src", "lib", "server", "subagent-transcript.ts"),
      "utf-8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // writePrivateFileAtomic 只在 writeIfTaskAlive 里出现（import 行除外）
    const uses = code.split("\n").filter(
      (l) => l.includes("writePrivateFileAtomic") && !l.includes("import") && !l.trim().startsWith("}"),
    );
    expect(uses).toHaveLength(1);
    expect(code).toContain("withTaskLock(taskId, async () => {");
    expect(code).toMatch(/writeIfTaskAlive\(\s*rec\.taskId,\s*runFilePath\(/);
    expect(code).toMatch(/writeIfTaskAlive\(\s*rec\.taskId,\s*markerPath\(/);
  });

  it("任务被删时 forgetSubagentRunsForDeletedTask：内存记录和待配对项一并丢掉、落盘定时器停掉，之后读不到、也不会再写", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId, { toolCallId: "card-1" }));
    h.onMessage(assistant("任务书里可能有敏感内容"));
    noteSubagentToolCall(taskId, { callId: "stream-9", prompt: "还没配上的另一条任务书" });

    transcript.forgetSubagentRunsForDeletedTask(taskId);

    expect(transcript.__runKeysForTests(taskId)).toEqual([]);
    expect(await getSubagentRunSnapshot(taskId, { key: h.key })).toBeNull();
    expect(await getSubagentRunSnapshot(taskId, { callId: "card-1" })).toBeNull();
    // 待配对项也清了：之后同任务书的记录出现，不会被已删任务遗留的调用认领
    const h2 = startSubagentRun(baseInit(taskId, { prompt: "还没配上的另一条任务书" }));
    expect(
      (await getSubagentRunSnapshot(taskId, { key: h2.key }))?.meta.callIds ?? [],
    ).not.toContain("stream-9");

    // 被清掉的那条的 2s 落盘定时器已停：时间走过去也不会写盘
    await vi.advanceTimersByTimeAsync(2100);
    await __flushSubagentRunWritesForTests();
    const file = path.join(taskDir(taskId), "subagent-runs", `${h.key}.json`);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("延迟删除分支（目录还在、只有逻辑删除标记）：已落盘的记录也读不到；标记没有时照常读", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId, { toolCallId: "card-gone" }));
    h.onMessage(assistant("hi"));
    h.finish({ status: "done", result: "好了" });
    await __flushSubagentRunWritesForTests();
    __resetSubagentRunsForTests(); // 内存清空，走磁盘

    expect((await getSubagentRunSnapshot(taskId, { key: h.key }))?.meta.status).toBe("done");
    const tomb = path.join(taskDir(taskId), DELETED_TOMBSTONE_FILE);
    await fs.writeFile(tomb, "");
    expect(await getSubagentRunSnapshot(taskId, { key: h.key })).toBeNull();
    expect(await getSubagentRunSnapshot(taskId, { callId: "card-gone" })).toBeNull();
    await fs.rm(tomb);
    expect((await getSubagentRunSnapshot(taskId, { key: h.key }))?.meta.status).toBe("done");
  });

  it("任务目录里有逻辑删除标记 → 同样不落盘", async () => {
    const taskId = await freshTask();
    await fs.writeFile(path.join(taskDir(taskId), DELETED_TOMBSTONE_FILE), "");
    const h = startSubagentRun(baseInit(taskId));
    h.finish({ status: "done", result: "ok" });
    await __flushSubagentRunWritesForTests();
    await expect(
      fs.stat(path.join(taskDir(taskId), "subagent-runs")),
    ).rejects.toThrow();
  });

  it("保留策略：一个任务只留最近 maxRunsPerTask 份落盘记录", async () => {
    const taskId = await freshTask();
    const total = SUBAGENT_RUN_LIMITS.maxRunsPerTask + 5;
    for (let i = 0; i < total; i += 1) {
      const h = startSubagentRun(baseInit(taskId, { prompt: `任务书 ${i}` }));
      h.finish({ status: "done", result: `r${i}` });
      await __flushSubagentRunWritesForTests();
      // 让 mtime 有先后（淘汰按 mtime 排）
      await new Promise((r) => setTimeout(r, 2));
    }
    // 收尾里的 prune 是 fire-and-forget：再等一小会
    await new Promise((r) => setTimeout(r, 300));
    const names = (await fs.readdir(path.join(taskDir(taskId), "subagent-runs"))).filter(
      (n) => /^sa_.*\.json$/.test(n),
    );
    expect(names.length).toBeLessThanOrEqual(SUBAGENT_RUN_LIMITS.maxRunsPerTask);
  }, 30_000);
});

describe("查：内存 → 磁盘；重启后写着 running 的改判 interrupted", () => {
  it("应用重启（内存清空）后仍能按 key 从磁盘读到收尾的记录", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    h.onMessage(assistant("hi"));
    h.finish({ status: "done", result: "好了" });
    await __flushSubagentRunWritesForTests();
    __resetSubagentRunsForTests();
    const snap = await getSubagentRunSnapshot(taskId, { key: h.key });
    expect(snap?.meta.status).toBe("done");
    expect(snap?.meta.result).toBe("好了");
    expect(snap?.events).toHaveLength(1);
  });

  it("重启时磁盘上还写着 running 的 → interrupted（不能再显示成运行中、面板也就不会无限轮询）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    h.onMessage(assistant("做到一半"));
    await vi.advanceTimersByTimeAsync(2100);
    await __flushSubagentRunWritesForTests();
    __resetSubagentRunsForTests();
    vi.useRealTimers();

    const snap = await getSubagentRunSnapshot(taskId, { key: h.key });
    expect(snap?.meta.status).toBe("interrupted");
    expect(snap?.meta.endedAt).toBeGreaterThan(0);
    expect(snap?.events[0]?.text).toBe("做到一半");
  });

  it("key / callId 形状不对、查不到 → null；路径穿越的 key 拿不到文件", async () => {
    const taskId = await freshTask();
    expect(await getSubagentRunSnapshot(taskId, {})).toBeNull();
    expect(await getSubagentRunSnapshot(taskId, { key: "sa_nope" })).toBeNull();
    expect(await getSubagentRunSnapshot(taskId, { key: "../../etc/passwd" })).toBeNull();
    expect(await getSubagentRunSnapshot(taskId, { callId: "nope" })).toBeNull();
  });
});

describe("绑 callId（事件流卡片按 callId 找记录）", () => {
  it("精确：回调给的 toolCallId 就是卡片的 callId", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId, { toolCallId: "call-A" }));
    const snap = await getSubagentRunSnapshot(taskId, { callId: "call-A" });
    expect(snap?.meta.key).toBe(h.key);
  });

  it("兜底（记录先到、主流消息后到）：任务书一致就绑上", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId, { toolCallId: "sdk-side-id" }));
    expect(await getSubagentRunSnapshot(taskId, { callId: "stream-side-id" })).toBeNull();
    noteSubagentToolCall(taskId, {
      callId: "stream-side-id",
      prompt: `  ${baseInit(taskId).prompt}\n`, // 首尾空白不影响
    });
    const snap = await getSubagentRunSnapshot(taskId, { callId: "stream-side-id" });
    expect(snap?.meta.key).toBe(h.key);
    // 重复通知幂等：不会重复绑
    noteSubagentToolCall(taskId, { callId: "stream-side-id", prompt: baseInit(taskId).prompt });
    const again = await getSubagentRunSnapshot(taskId, { callId: "stream-side-id" });
    expect(again?.meta.callIds.filter((c) => c === "stream-side-id")).toHaveLength(1);
  });

  it("兜底（主流消息先到、记录后到）：先登记待配对，记录起来时认领", async () => {
    const taskId = await freshTask();
    noteSubagentToolCall(taskId, { callId: "early-call", prompt: baseInit(taskId).prompt });
    expect(await getSubagentRunSnapshot(taskId, { callId: "early-call" })).toBeNull();
    const h = startSubagentRun(baseInit(taskId));
    const snap = await getSubagentRunSnapshot(taskId, { callId: "early-call" });
    expect(snap?.meta.key).toBe(h.key);
  });

  it("待配对里 args 还在流式补全（任务书是残缺前缀）：后来更长的任务书替换它、仍能配上", async () => {
    const taskId = await freshTask();
    const full = baseInit(taskId).prompt;
    noteSubagentToolCall(taskId, { callId: "stream-call", prompt: full.slice(0, 5) });
    noteSubagentToolCall(taskId, { callId: "stream-call", prompt: full });
    const h = startSubagentRun(baseInit(taskId));
    const snap = await getSubagentRunSnapshot(taskId, { callId: "stream-call" });
    expect(snap?.meta.key).toBe(h.key);
  });

  it("两个任务书相同的子代理并行：按启动顺序一一对应、不串", async () => {
    const taskId = await freshTask();
    const a = startSubagentRun(baseInit(taskId));
    const b = startSubagentRun(baseInit(taskId));
    noteSubagentToolCall(taskId, { callId: "card-1", prompt: baseInit(taskId).prompt });
    noteSubagentToolCall(taskId, { callId: "card-2", prompt: baseInit(taskId).prompt });
    expect((await getSubagentRunSnapshot(taskId, { callId: "card-1" }))?.meta.key).toBe(a.key);
    expect((await getSubagentRunSnapshot(taskId, { callId: "card-2" }))?.meta.key).toBe(b.key);
  });

  it("任务书对不上、也没有精确匹配 → 不乱绑（卡片退回只展示自己手上的）", async () => {
    const taskId = await freshTask();
    startSubagentRun(baseInit(taskId, { toolCallId: "x" }));
    noteSubagentToolCall(taskId, { callId: "other", prompt: "完全不同的任务书" });
    expect(await getSubagentRunSnapshot(taskId, { callId: "other" })).toBeNull();
  });

  it("不跨任务绑定", async () => {
    const t1 = await freshTask();
    const t2 = await freshTask();
    startSubagentRun(baseInit(t1));
    noteSubagentToolCall(t2, { callId: "c", prompt: baseInit(t1).prompt });
    expect(await getSubagentRunSnapshot(t1, { callId: "c" })).toBeNull();
    expect(await getSubagentRunSnapshot(t2, { callId: "c" })).toBeNull();
  });

  it("重启后按 callId 从磁盘标记找回；callId 带换行等特殊字符也行", async () => {
    const taskId = await freshTask();
    const weird = "call-123\nfc_abc:def";
    const h = startSubagentRun(baseInit(taskId, { toolCallId: weird }));
    h.finish({ status: "done", result: "ok" });
    await __flushSubagentRunWritesForTests();
    // 标记是 fire-and-forget 写的：等它落地
    await new Promise((r) => setTimeout(r, 50));
    __resetSubagentRunsForTests();
    const snap = await getSubagentRunSnapshot(taskId, { callId: weird });
    expect(snap?.meta.key).toBe(h.key);
    // 标记文件名撞名但记录里没绑这个 callId → 当没有
    expect(await getSubagentRunSnapshot(taskId, { callId: "call-123_fc_abc_def" })).toBeNull();
  });

  it("陈旧登记不误绑（待配对先到）：主流调用登记后过了 60s 才有同任务书的记录起跑 → 不认；窗口内照常认", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const taskId = await freshTask();
    const t0 = Date.now();
    // 上一次调用留下的陈旧登记（比如那次建子 agent 失败、没有记录来认领）
    noteSubagentToolCall(taskId, { callId: "stale-call", prompt: baseInit(taskId).prompt });
    vi.setSystemTime(t0 + 61_000);
    const later = startSubagentRun(baseInit(taskId));
    expect(await getSubagentRunSnapshot(taskId, { callId: "stale-call" })).toBeNull();
    expect(
      (await getSubagentRunSnapshot(taskId, { key: later.key }))?.meta.callIds,
    ).toEqual([]);

    // 对照：窗口内（30s）同样的流程照常配上
    const taskId2 = await freshTask();
    const t1 = Date.now();
    noteSubagentToolCall(taskId2, { callId: "fresh-call", prompt: baseInit(taskId2).prompt });
    vi.setSystemTime(t1 + 30_000);
    const ok = startSubagentRun(baseInit(taskId2));
    expect((await getSubagentRunSnapshot(taskId2, { callId: "fresh-call" }))?.meta.key).toBe(ok.key);
  });

  it("陈旧记录不误绑（记录先到）：记录起跑 60s 之后才来的同任务书调用 → 不认；窗口内照常认", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const taskId = await freshTask();
    const t0 = Date.now();
    const h = startSubagentRun(baseInit(taskId));
    vi.setSystemTime(t0 + 61_000);
    noteSubagentToolCall(taskId, { callId: "much-later", prompt: baseInit(taskId).prompt });
    expect(await getSubagentRunSnapshot(taskId, { callId: "much-later" })).toBeNull();

    vi.setSystemTime(t0 + 30_000);
    noteSubagentToolCall(taskId, { callId: "in-window", prompt: baseInit(taskId).prompt });
    expect((await getSubagentRunSnapshot(taskId, { callId: "in-window" }))?.meta.key).toBe(h.key);
  });

  it("待配对表有上限（32 条）：超出丢最旧的，认领从最早还活着的那条开始", async () => {
    const taskId = await freshTask();
    const prompt = baseInit(taskId).prompt;
    for (let i = 0; i < 40; i += 1) {
      noteSubagentToolCall(taskId, { callId: `pend-${i}`, prompt });
    }
    const h = startSubagentRun(baseInit(taskId));
    // 40 条里最旧的 8 条（0..7）已被挤掉；这条记录认领的是最早还在的 pend-8
    expect((await getSubagentRunSnapshot(taskId, { callId: "pend-8" }))?.meta.key).toBe(h.key);
    for (const gone of ["pend-0", "pend-7"]) {
      expect(await getSubagentRunSnapshot(taskId, { callId: gone })).toBeNull();
    }
    // 没被这条记录认领的仍在表里、没有串绑
    expect(await getSubagentRunSnapshot(taskId, { callId: "pend-9" })).toBeNull();
    // 再起 31 条同任务书的记录把表里剩下的 31 条（pend-9..pend-39）一一认完、按启动顺序对应；
    // 之后再起的第 33 条没有登记可认了
    const more = Array.from({ length: 31 }, () => startSubagentRun(baseInit(taskId)));
    expect((await getSubagentRunSnapshot(taskId, { callId: "pend-39" }))?.meta.key).toBe(
      more[30]!.key,
    );
    const extra = startSubagentRun(baseInit(taskId));
    expect((await getSubagentRunSnapshot(taskId, { key: extra.key }))?.meta.callIds).toEqual([]);
  });
});

describe("记录器健壮性：不抛 / 路径穿越 / 节流 / 重复丢弃计数", () => {
  it("同一个被丢弃的工具调用，后续 running / completed 不重复计 dropped；没有 call_id 的各算各的", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    const max = SUBAGENT_RUN_LIMITS.maxEvents;
    for (let i = 0; i < max; i += 1) h.onMessage(toolCall(`c${i}`, "running"));
    // 同一个溢出调用：running ×2 + completed ×1 = 1 笔
    h.onMessage(toolCall("ov1", "running"));
    h.onMessage(toolCall("ov1", "running", { args: { path: "更长的 args" } }));
    h.onMessage(toolCall("ov1", "completed", { result: "ok" }));
    // 另一个溢出调用 = 再 1 笔
    h.onMessage(toolCall("ov2", "running"));
    h.onMessage(toolCall("ov2", "completed", { result: "ok" }));
    // 没有 call_id 的两条：无法判定是不是同一个 → 各 1 笔
    h.onMessage({ type: "tool_call", name: "read", status: "running" });
    h.onMessage({ type: "tool_call", name: "read", status: "running" });
    const snap = (await getSubagentRunSnapshot(taskId, { key: h.key }))!;
    expect(snap.droppedEvents).toBe(4);
    // 溢出的调用没有留下任何事件（不会有孤零零的 tool_result）
    expect(snap.events.filter((e) => e.kind === "tool_result")).toHaveLength(0);
    expect(snap.events).toHaveLength(max);
  });

  it("喂消息时内部真抛了（getter 抛）：onMessage 不抛、只告警，之后的正常消息照常记", async () => {
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    const boom = {
      type: "tool_call",
      get call_id(): string {
        throw new Error("boom");
      },
    };
    expect(() => h.onMessage(boom)).not.toThrow();
    expect(console.warn).toHaveBeenCalled();
    h.onMessage(assistant("还能继续记"));
    const snap = (await getSubagentRunSnapshot(taskId, { key: h.key }))!;
    expect(snap.events.map((e) => e.text)).toEqual(["还能继续记"]);
  });

  it("落盘真失败了（runs 目录位置被一个文件占了）：finish 不抛、只告警，内存里的记录照常可查", async () => {
    const taskId = await freshTask();
    await fs.writeFile(path.join(taskDir(taskId), "subagent-runs"), "我是个文件、不是目录");
    const h = startSubagentRun(baseInit(taskId));
    h.onMessage(assistant("结论"));
    expect(() => h.finish({ status: "done", result: "好了" })).not.toThrow();
    await expect(__flushSubagentRunWritesForTests()).resolves.toBeUndefined();
    const warned = vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes("落盘失败"));
    expect(warned).toBe(true);
    const snap = await getSubagentRunSnapshot(taskId, { key: h.key });
    expect(snap?.meta.status).toBe("done");
    expect(snap?.events).toHaveLength(1);
  });

  it("路径穿越：key 不能借 `../` 读到别的任务（或别处）的记录文件", async () => {
    // 别的任务里有一份真实、可解析的记录
    const victim = await freshTask();
    const v = startSubagentRun(baseInit(victim));
    v.onMessage(assistant("别人的机密过程"));
    v.finish({ status: "done", result: "别人的产出" });
    await __flushSubagentRunWritesForTests();
    __resetSubagentRunsForTests(); // 清内存：只剩磁盘

    const attacker = await freshTask();
    // 从 attacker 的 subagent-runs/ 往上两级再进 victim 的 subagent-runs/（runFilePath 会补 .json）
    const evilKeys = [
      `../../${victim}/subagent-runs/${v.key}`,
      `..\\..\\${victim}\\subagent-runs\\${v.key}`,
      `sa_x/../../../${victim}/subagent-runs/${v.key}`,
      `${v.key}.json`,
      `${v.key.toUpperCase()}`,
    ];
    for (const key of evilKeys) {
      expect(await getSubagentRunSnapshot(attacker, { key }), key).toBeNull();
    }
    // 对照：正路读 victim 自己的是通的（证明上面的 null 来自校验而不是文件没写成）
    expect((await getSubagentRunSnapshot(victim, { key: v.key }))?.meta.result).toBe("别人的产出");
  });

  it("路径穿越：toolCallId / callId 带 `../` 只会被消毒成文件名，标记不会写到 subagent-runs/ 之外；按它查也读不到别处", async () => {
    const taskId = await freshTask();
    const evil = "../../../../etc/passwd";
    const h = startSubagentRun(baseInit(taskId, { toolCallId: evil }));
    h.finish({ status: "done", result: "ok" });
    await __flushSubagentRunWritesForTests();
    await new Promise((r) => setTimeout(r, 50)); // 标记 fire-and-forget

    const runsDir = path.join(taskDir(taskId), "subagent-runs");
    const names = await fs.readdir(runsDir);
    const markers = names.filter((n) => n.startsWith("by-call-"));
    expect(markers).toHaveLength(1);
    expect(markers[0]).not.toMatch(/[\\/]|\.\./);
    // 任务目录之外没有多出东西（TMP_ROOT 下只该有 tasks 之类的正常目录）
    expect(await fs.readdir(taskDir(taskId))).toEqual(["subagent-runs"]);
    // 清内存走磁盘标记那条路：按这个 callId 查得到自己的（核对 callIds 通过），按没绑过的相似 callId 查不到
    __resetSubagentRunsForTests();
    expect((await getSubagentRunSnapshot(taskId, { callId: evil }))?.meta.key).toBe(h.key);
    expect(await getSubagentRunSnapshot(taskId, { callId: "../../x" })).toBeNull();
  });

  it("节流：运行中一批消息只在 ~2s 到点写一次；到点之后的新变化再等 ~2s 写下一次；收尾立刻写、不等节流", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const taskId = await freshTask();
    const h = startSubagentRun(baseInit(taskId));
    const writeSpy = vi.spyOn(fs, "writeFile");
    const runFileWrites = (): number =>
      writeSpy.mock.calls.filter((c) => String(c[0]).includes(`${h.key}.json.tmp`)).length;

    for (let i = 0; i < 30; i += 1) h.onMessage(assistant(`chunk${i}`));
    await vi.advanceTimersByTimeAsync(1900);
    // 先排空已触发的写再数（写盘是真 I/O、假定时器推进时不会等它）：否则「提前写了」会因计数滞后而漏判
    await __flushSubagentRunWritesForTests();
    expect(runFileWrites()).toBe(0); // 没到点：一次都没写
    await vi.advanceTimersByTimeAsync(200);
    await __flushSubagentRunWritesForTests();
    expect(runFileWrites()).toBe(1); // 30 条消息 = 1 次写

    for (let i = 0; i < 5; i += 1) h.onMessage({ type: "thinking", text: `t${i}` });
    await vi.advanceTimersByTimeAsync(1900);
    await __flushSubagentRunWritesForTests();
    expect(runFileWrites()).toBe(1); // 新一轮节流还没到点
    await vi.advanceTimersByTimeAsync(200);
    await __flushSubagentRunWritesForTests();
    expect(runFileWrites()).toBe(2);

    // 收尾：不推进时间也立刻写，且停掉待执行的节流定时器
    h.onMessage(assistant("最后一段"));
    h.finish({ status: "done", result: "好了" });
    await __flushSubagentRunWritesForTests();
    expect(runFileWrites()).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(runFileWrites()).toBe(3);
  });
});

describe("内存淘汰：条数 / 任务数 / 字符数三道上限", () => {
  it("单任务超过 maxRunsPerTask：淘汰最旧的已收尾记录，运行中的永不淘汰；被淘汰的仍能从磁盘读到", async () => {
    const taskId = await freshTask();
    const max = SUBAGENT_RUN_LIMITS.maxRunsPerTask;
    const running = startSubagentRun(baseInit(taskId, { prompt: "一直在跑的" }));
    const finished: string[] = [];
    // 1 条运行中 + max 条已收尾 = max+1 > 上限 → 挤掉最旧的那条已收尾（磁盘上正好 max 份、不触发落盘保留策略的 prune）
    for (let i = 0; i < max; i += 1) {
      const h = startSubagentRun(baseInit(taskId, { prompt: `任务书 ${i}` }));
      h.finish({ status: "done", result: `r${i}` });
      finished.push(h.key);
      await __flushSubagentRunWritesForTests();
    }
    const keys = transcript.__runKeysForTests(taskId);
    expect(keys).toHaveLength(max);
    expect(keys).toContain(running.key); // 运行中的还在（它是 Map 里最老的一条，没被当成最旧淘汰）
    expect(keys).not.toContain(finished[0]); // 最旧的已收尾被挤出内存
    expect(keys).toContain(finished[max - 1]);
    // 挤出内存的回落磁盘
    const evictedOnDisk = await getSubagentRunSnapshot(taskId, { key: finished[0]! });
    expect(evictedOnDisk?.meta.result).toBe("r0");
  }, 30_000);

  it("任务数超限：遇到「还有运行中记录」的最旧任务要跳过、继续淘汰后面已收尾的任务（不是整体放弃）", async () => {
    transcript.__setMemoryLimitsForTests({ tasksMax: 3 });
    const a = await freshTask();
    const b = await freshTask();
    const c = await freshTask();
    const d = await freshTask();
    startSubagentRun(baseInit(a)); // 最旧、一直在跑
    const hb = startSubagentRun(baseInit(b));
    hb.finish({ status: "done", result: "b" });
    const hc = startSubagentRun(baseInit(c));
    hc.finish({ status: "done", result: "c" });
    await __flushSubagentRunWritesForTests();
    startSubagentRun(baseInit(d)); // 第 4 个任务 → 触发淘汰

    expect(transcript.__runKeysForTests(a)).toHaveLength(1); // 运行中的任务不动
    expect(transcript.__runKeysForTests(b)).toHaveLength(0); // 最旧的已收尾任务被淘汰
    expect(transcript.__runKeysForTests(c)).toHaveLength(1);
    expect(transcript.__runKeysForTests(d)).toHaveLength(1);
    // 被淘汰任务的记录回落磁盘仍能读
    expect((await getSubagentRunSnapshot(b, { key: hb.key }))?.meta.result).toBe("b");
  });

  it("任务数超限但全都在跑：一个都不淘汰（宁可超限也不丢运行中的记录）", async () => {
    transcript.__setMemoryLimitsForTests({ tasksMax: 2 });
    const ids = [await freshTask(), await freshTask(), await freshTask()];
    for (const id of ids) startSubagentRun(baseInit(id));
    for (const id of ids) expect(transcript.__runKeysForTests(id)).toHaveLength(1);
  });

  it("已收尾记录的字符数合计超限：按先后淘汰最旧的，直到回到上限内；当前任务的不动", async () => {
    transcript.__setMemoryLimitsForTests({ charsMax: 5000 });
    const old = await freshTask();
    const big = (text: string) => {
      const h = startSubagentRun(baseInit(old, { prompt: `任务书-${text}` }));
      h.onMessage(assistant(text.repeat(3000)));
      h.finish({ status: "done", result: "ok" });
      return h;
    };
    const first = big("a");
    const second = big("b");
    await __flushSubagentRunWritesForTests();
    expect(transcript.__runKeysForTests(old)).toEqual([first.key, second.key]);

    const other = await freshTask();
    startSubagentRun(baseInit(other)); // 别的任务起跑 → 触发淘汰：两份 ~3000 字合计超 5000
    // 当前任务是 other；old 里最旧的一份被淘汰、第二份留着（3000 ≤ 5000）
    expect(transcript.__runKeysForTests(old)).toEqual([second.key]);
    // 被淘汰的回落磁盘
    expect((await getSubagentRunSnapshot(old, { key: first.key }))?.meta.status).toBe("done");

    // 当前任务自己的不被字符上限淘汰：上限压到 100（远小于 second 的 ~3000）、在 old 里再起一条 run
    transcript.__setMemoryLimitsForTests({ charsMax: 100 });
    const h = startSubagentRun(baseInit(old, { prompt: "新的" }));
    expect(transcript.__runKeysForTests(old)).toEqual([second.key, h.key]);
  });
});
