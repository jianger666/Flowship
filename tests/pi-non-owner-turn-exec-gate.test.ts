/**
 * pi 后端：非属主并入同会话的那一轮，**execute 层**硬门（不依赖 setActiveToolsByName 收窄是否生效）。
 *
 * 假 pi `createAgentSession` 截获建会话时的 customTools，直接调它们的 execute：
 * - 标记在：shell / write / edit / delete / task / Flowship 系统工具 / MCP 桥接 → `[DENIED]`，副作用没发生（文件没写出来）
 * - 标记在：read / grep / glob 放行，但套了与只读旁路同一套守卫——数据目录里的 config.json 等凭据文件读不到、
 *   越出工作目录读不到；工作目录里的普通文件照常读
 * - 标记不在（属主的轮次 / 提示词开关关）：全部透传，shell 真的跑、read 真的读到 config.json 同名的项目文件
 * - 别的任务的标记不波及；无 taskId 的会话（oneshot）没有这套
 *
 * 局限：这里验证 Flowship 侧的包装；没有真跑 pi 会话。Cursor 后端的内置工具没有这个咽喉，不在此列。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { blockAfter, readSource } from "./helpers/source-text";

const TMP = mkdtempSync(path.join(os.tmpdir(), "fe-pi-non-owner-exec-"));
const DATA = path.join(TMP, "data");
const WORK = path.join(TMP, "work");
mkdirSync(DATA, { recursive: true });
mkdirSync(WORK, { recursive: true });
process.env.FLOWSHIP_DATA_DIR = DATA;

const hoisted = vi.hoisted(() => ({ createAgentSession: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: hoisted.createAgentSession };
});

const { createCustomAgent } = await import("@/lib/server/custom-agent-backend");
const { seedModelsDevCatalogForTest } = await import("@/lib/server/models-dev-catalog");
const { __resetNonOwnerTurnGuardForTest, beginNonOwnerTurn, endNonOwnerTurn } =
  await import("@/lib/server/non-owner-turn-guard");
const { CALLER_MISMATCH_ERROR, cleanupChatTaskState, setOneShotCallerToken } = await import("@/lib/server/chat-pending");

type Tool = {
  name: string;
  /** pi 在 execute 之前会先跑它把 Cursor 别名收成规范字段；直接调 execute 的测试要自己模拟这一步 */
  prepareArguments?: (args: unknown) => unknown;
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{
    content: Array<{ type: string; text?: string }>;
  }>;
};

const run = (
  tool: Tool,
  id: string,
  params: unknown,
  signal?: AbortSignal,
) => tool.execute(id, tool.prepareArguments ? tool.prepareArguments(params) : params, signal);

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? "").join("\n");

/**
 * 被拒的工具调用：pi 的 execute 没有 isError 字段，失败必须抛错（agent-loop 才会按失败的工具调用呈现、界面不亮绿勾），
 * 文案原样是错误信息。返回错误信息；没被拒（正常返回了结果）返回 null。
 */
const deniedMessage = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

const makeSession = () => ({
  sessionFile: "fake-session-file",
  sessionId: "fake-session",
  abort: vi.fn(async () => {}),
  dispose: vi.fn(),
  state: { messages: [] as unknown[], errorMessage: undefined as string | undefined },
  subscribe: vi.fn(() => () => {}),
  prompt: vi.fn(async () => {}),
  getActiveToolNames: vi.fn(() => []),
  setActiveToolsByName: vi.fn(),
});

const input = (extra: Record<string, unknown> = {}) =>
  ({
    kind: "custom",
    apiKey: "k",
    baseUrl: "http://127.0.0.1:1",
    format: "openai",
    model: { id: "m" },
    local: { cwd: WORK },
    taskId: "t1",
    callerToken: "tok-1",
    ...extra,
  }) as never;

/** 建一个会话并取出它挂的 customTools（按名字索引） */
const toolsOf = async (extra: Record<string, unknown> = {}): Promise<Record<string, Tool>> => {
  hoisted.createAgentSession.mockReset();
  hoisted.createAgentSession.mockResolvedValue({ session: makeSession() });
  await createCustomAgent(input(extra));
  const opts = hoisted.createAgentSession.mock.calls[0]![0] as { customTools: Tool[] };
  return Object.fromEntries(opts.customTools.map((t) => [t.name, t]));
};

beforeEach(() => {
  __resetNonOwnerTurnGuardForTest();
  seedModelsDevCatalogForTest({});
  writeFileSync(path.join(DATA, "config.json"), '{"gitToken":"glpat-SECRET"}');
  writeFileSync(path.join(WORK, "hello.txt"), "hello from workspace");
  writeFileSync(path.join(WORK, "config.json"), '{"name":"project config"}');
});
afterEach(() => __resetNonOwnerTurnGuardForTest());
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("非属主一轮：execute 层硬拒（标记在）", () => {
  it("shell：被拒、命令没执行（副作用文件不存在）", async () => {
    const tools = await toolsOf();
    beginNonOwnerTurn("t1");
    const marker = path.join(WORK, "shell-ran.txt");
    const msg = await deniedMessage(run(tools.shell!, "c1", { command: `echo hi > "${marker}"` }));
    expect(msg).toContain("[DENIED]");
    expect(msg).toContain("shell");
    expect(existsSync(marker)).toBe(false);
  });

  it("write / edit / delete / task：全部被拒、write 没落盘", async () => {
    const tools = await toolsOf();
    beginNonOwnerTurn("t1");
    const target = path.join(WORK, "written.txt");
    expect(await deniedMessage(run(tools.write!, "c2", { path: target, content: "x" }))).toContain("[DENIED]");
    expect(existsSync(target)).toBe(false);
    for (const name of ["edit", "delete", "task"]) {
      expect(tools[name], `${name} 应该在属主会话的工具集里`).toBeTruthy();
      expect(await deniedMessage(run(tools[name]!, "c3", {})), name).toContain("[DENIED]");
    }
  });

  it("Flowship 系统工具（submit_work / ask_user …）：被拒；wait 放行（不被包装拒绝）", async () => {
    const tools = await toolsOf();
    beginNonOwnerTurn("t1");
    for (const name of ["submit_work", "ask_user", "schedule", "share_to_group"]) {
      expect(tools[name], `${name} 应该在属主会话的工具集里`).toBeTruthy();
      expect(await deniedMessage(run(tools[name]!, "c4", {})), name).toContain("[DENIED]");
    }
    // wait 不在包装拒绝之列：它自己的 handler 决定（这里 1 秒且立刻 abort，不真等）
    const ac = new AbortController();
    ac.abort();
    const w = await run(tools.wait!, "c5", { seconds: 1 }, ac.signal);
    expect(textOf(w)).not.toContain("[DENIED]");
  });

  it("read：工作目录里的普通文件照常读", async () => {
    const tools = await toolsOf();
    beginNonOwnerTurn("t1");
    const r = await run(tools.read!, "c6", { path: path.join(WORK, "hello.txt") });
    expect(textOf(r)).toContain("hello from workspace");
  });

  it("read：数据目录的 config.json（令牌）读不到；越出工作目录读不到", async () => {
    const tools = await toolsOf();
    beginNonOwnerTurn("t1");
    const secret = await run(tools.read!, "c7", { path: path.join(DATA, "config.json") });
    expect(textOf(secret)).not.toContain("glpat-SECRET");
    expect(textOf(secret)).toMatch(/凭据文件|越界|只能/);
    const outside = await run(tools.read!, "c8", { path: "/etc/hosts" });
    expect(textOf(outside)).toMatch(/越界|只能/);
    const home = await run(tools.read!, "c9", { path: "~/.ssh/id_rsa" });
    expect(textOf(home)).toMatch(/只能|相对路径/);
  });

  it("grep / glob：基址越界被拒；工作目录内照常", async () => {
    const tools = await toolsOf();
    beginNonOwnerTurn("t1");
    const g1 = await run(tools.grep!, "c10", { pattern: "SECRET", path: DATA });
    expect(textOf(g1)).toMatch(/越界|只能/);
    const g2 = await run(tools.glob!, "c11", { globPattern: "*.txt", targetDirectory: DATA });
    expect(textOf(g2)).toMatch(/越界|只能/);
    const g3 = await run(tools.glob!, "c12", { globPattern: "*.txt" });
    expect(textOf(g3)).toContain("hello.txt");
  });
});

describe("标记不在 / 不相干：全部透传（属主的轮次、开关关、别的任务）", () => {
  it("无标记：shell 真的跑、write 真的写、read 不受目录钳制", async () => {
    const tools = await toolsOf();
    const marker = path.join(WORK, "shell-ran.txt");
    const r = await run(tools.shell!, "d1", { command: `echo hi > "${marker}"` });
    expect(textOf(r)).not.toContain("[DENIED]");
    expect(existsSync(marker)).toBe(true);
    const w = await run(tools.write!, "d2", {
      path: path.join(WORK, "written.txt"),
      fileText: "x",
    });
    expect(textOf(w)).not.toContain("[DENIED]");
    expect(existsSync(path.join(WORK, "written.txt"))).toBe(true);
    // 属主的 read 没有凭据文件守卫 / 目录钳制（既有行为、不动）：工作目录之外的文件也读得到——
    // 这条正是 M3 变异（守卫不看标记）的哨兵：守卫若对属主也生效，这里会被「越界」拦下
    writeFileSync(path.join(TMP, "outside.txt"), "outside workspace");
    const ro = await run(tools.read!, "d3", { path: path.join(TMP, "outside.txt") });
    expect(textOf(ro)).toContain("outside workspace");
    const rc = await run(tools.read!, "d3b", { path: path.join(WORK, "config.json") });
    expect(textOf(rc)).toContain("project config");
  });

  it("一轮结束（endNonOwnerTurn）后立刻恢复：同一份工具定义不需要重建", async () => {
    const tools = await toolsOf();
    const token = beginNonOwnerTurn("t1");
    expect(await deniedMessage(run(tools.shell!, "d4", { command: "echo no" }))).toContain("[DENIED]");
    endNonOwnerTurn("t1", token);
    const ok = await run(tools.shell!, "d5", { command: "echo yes" });
    expect(textOf(ok)).toContain("yes");
  });

  it("别的任务的标记不波及本会话", async () => {
    const tools = await toolsOf();
    beginNonOwnerTurn("t2");
    const r = await run(tools.shell!, "d6", { command: "echo yes" });
    expect(textOf(r)).toContain("yes");
  });

  it("无 taskId 的会话（oneshot）：没有这套包装，shell 照常", async () => {
    const tools = await toolsOf({ taskId: undefined });
    beginNonOwnerTurn("t1");
    const r = await run(tools.shell!, "d7", { command: "echo yes" });
    expect(textOf(r)).toContain("yes");
  });
});

describe("标记是滑动 TTL（第 20 轮评审 N1）：pi 工具咽喉命中即续期", () => {
  afterEach(() => vi.useRealTimers());
  // 只假 Date：fs / 子进程不受影响
  const at = (hhmm: string) => vi.setSystemTime(new Date(`2026-11-04T${hhmm}:00Z`));

  it("只读工具（read）在标记窗内被调用 → 续期；之后 shell 在原起点 + 45 分钟之后仍被拒", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00");
    const tools = await toolsOf();
    beginNonOwnerTurn("t1");
    at("10:40");
    const r = await run(tools.read!, "n1", { path: path.join(WORK, "hello.txt") });
    expect(textOf(r)).toContain("hello from workspace");
    // 距起点 80 分钟、距上次工具调用 40 分钟：续期了就还在，没续就已过期、shell 会真跑
    at("11:20");
    const marker = path.join(WORK, "ttl-shell-ran.txt");
    expect(await deniedMessage(run(tools.shell!, "n2", { command: `echo hi > "${marker}"` }))).toContain("[DENIED]");
    expect(existsSync(marker)).toBe(false);
  });

  it("被拒的 shell 试探本身也续期（反复试探不会把标记熬过期）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00");
    const tools = await toolsOf();
    beginNonOwnerTurn("t1");
    for (const hhmm of ["10:30", "11:00", "11:30", "12:00"]) {
      at(hhmm);
      expect(await deniedMessage(run(tools.shell!, `n-${hhmm}`, { command: "echo hi" })), hhmm).toContain("[DENIED]");
    }
  });

  it("真漏清 + 之后再没有工具调用：超过 TTL 恢复透传（兜底语义保留）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00");
    const tools = await toolsOf();
    beginNonOwnerTurn("t1");
    at("10:46");
    const r = await run(tools.shell!, "n3", { command: "echo yes" });
    expect(textOf(r)).toContain("yes");
  });
});

describe("闭包 token 接线（第二十轮评审 R20-5）：callerToken 入参 → pi 工具闭包", () => {
  const ID = "t_pi_closure_tok";
  afterEach(() => cleanupChatTaskState(ID));
  // set_owner_note：受限工具（过期会话闸核对 token）；content 传空串 = 只清备注、没有别的副作用。pi 的失败是抛错，被拒返回错误信息、放行返回 null
  const callNote = (tools: Record<string, Tool>) => run(tools.set_owner_note!, "w1", { task_id: ID, content: "" });

  it("createCustomAgent：闭包带的就是入参里的 callerToken——表里登记同一个才放行；没登记 / 换成别人的 / 摘掉都被拒（fail-closed）", async () => {
    const tools = await toolsOf({ taskId: ID, callerToken: "tok-pi-A" });
    expect(tools.set_owner_note, "会话里应挂有 set_owner_note").toBeTruthy();
    expect(await deniedMessage(callNote(tools)), "没登记：fail-closed").toContain(CALLER_MISMATCH_ERROR);
    setOneShotCallerToken(ID, "tok-pi-A");
    expect(await deniedMessage(callNote(tools)), "登记的就是闭包带的 token：不该被拒").toBeNull();
    setOneShotCallerToken(ID, "tok-pi-B");
    expect(await deniedMessage(callNote(tools)), "表里换成别人的：旧会话的闭包被拒").toContain(CALLER_MISMATCH_ERROR);
    cleanupChatTaskState(ID);
    expect(await deniedMessage(callNote(tools)), "摘掉之后被拒").toContain(CALLER_MISMATCH_ERROR);
  });

  it("没有 callerToken（受限答疑 / 标题生成）：不挂任何系统工具闭包——没有 token 可带，也就没有可被拿去冒用的入口", async () => {
    const tools = await toolsOf({ taskId: ID, callerToken: undefined });
    expect(tools.set_owner_note, "无 callerToken 的会话不该有 set_owner_note").toBeUndefined();
    expect(tools.schedule).toBeUndefined();
  });

  it("源码结构：create / resume 各自取 input.callerToken 并原样交给 buildCustomTools（resume 需要真会话文件，这里靠结构钉）；闭包里三类工具（系统 / 浏览器 / 电脑）都把同一个 callerToken 交给咽喉", () => {
    const src = readSource("src/lib/server/custom-agent-backend.ts");
    expect(src.match(/const callerToken = input\.callerToken;/g)?.length, "create / resume 各取一次").toBe(2);
    expect(
      src.match(
        /buildCustomTools\(\s*callerToken,\s*cwd,\s*\{ input, runtime, model, thinkingLevel \},\s*mcp\.toolDefs,\s*input\.taskId,\s*\)/g,
      )?.length,
      "create / resume 各把 callerToken + input.taskId 原样交给 buildCustomTools",
    ).toBe(2);
    const build = blockAfter(src, "const buildCustomTools = (");
    expect(
      build.match(/invokeFlowshipTool\(\s*t,\s*params as Record<string, unknown>,\s*callerToken,\s*\{/g)?.length,
      "系统 / 浏览器 / 电脑操作三段映射各有一处、都用 buildCustomTools 的 callerToken 参数",
    ).toBe(3);
  });
});
