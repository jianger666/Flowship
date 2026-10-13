/**
 * 子代理（pi 路径）端到端：真实 pi 父会话 → 真实 task 工具 → 真实子会话，
 * 对端是本机假的 OpenAI 兼容端点，只用来记录「子会话实际发了什么」。
 *
 * 要锁的不是内部函数，而是线上事实：
 *   - 指定的 model / effort 真的到了端点（之前 model 参数被忽略、徽标是假的）
 *   - explore 子代理只拿到只读工具
 *   - 填错 model / effort → 工具错误 + 可选项，且**没有**发出子会话请求
 *   - 父会话被取消时，子会话对端点的连接被断开（之前子会话会继续空转）
 *   - 子会话自己的模型失败 → 父会话看到原因，而不是「(子任务无输出)」
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCustomAgent } from "@/lib/server/custom-agent-backend";
import {
  resetModelsDevCatalogForTest,
  seedModelsDevCatalogForTest,
} from "@/lib/server/models-dev-catalog";

type ChatBody = {
  model: string;
  reasoning_effort?: string;
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
};

/** 父会话请求带 task 工具；子会话（不能再派子任务）没有——沿用父模型时 model 字段一样，只能靠这个区分 */
const isParentRequest = (b: ChatBody): boolean =>
  (b.tools ?? []).some((t) => t.function?.name === "task");

const PARENT = "fake-parent";
const CHILD = "fake-child";
const PLAIN = "fake-plain";
const BAD = "fake-bad";

let server: http.Server;
let baseUrl = "";
let cwd = "";
/** 本轮父会话要让假父模型发出的 task 调用参数 */
let taskArgs: Record<string, unknown> = {};
let requests: ChatBody[] = [];
/** 子会话请求的对端连接，用来观察取消 */
let childSockets: Array<{ closed: boolean }> = [];
/** true = 子会话请求收到后一直挂着不回（模拟子会话长时间运行） */
let hangChild = false;

const sse = (res: http.ServerResponse, chunks: unknown[]): void => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
};

const base = { id: "c1", object: "chat.completion.chunk", created: 1 };
const textChunks = (text: string) => [
  {
    ...base,
    model: "m",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  },
  { ...base, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  {
    ...base,
    model: "m",
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
];
const toolCallChunks = (args: Record<string, unknown>) => [
  {
    ...base,
    model: "m",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_task_1",
              type: "function",
              function: { name: "task", arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  { ...base, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  {
    ...base,
    model: "m",
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
];

beforeAll(async () => {
  cwd = mkdtempSync(path.join(os.tmpdir(), "subagent-e2e-"));
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [PARENT, CHILD, PLAIN, BAD].map((id) => ({ id })),
        }),
      );
      return;
    }
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw) as ChatBody;
      requests.push(body);
      if (isParentRequest(body)) {
        const hasToolResult = body.messages.some((m) => m.role === "tool");
        if (!hasToolResult) return sse(res, toolCallChunks(taskArgs));
        const tool = body.messages.filter((m) => m.role === "tool").pop();
        return sse(res, textChunks(`PARENT-SAW: ${JSON.stringify(tool?.content)}`));
      }
      // 子会话请求（沿用父模型时 model 与父会话相同，不能按 model 判断）
      const sock = { closed: false };
      childSockets.push(sock);
      res.on("close", () => {
        sock.closed = true;
      });
      if (body.model === BAD) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model fake-bad is not allowed" } }));
        return;
      }
      if (hangChild) return; // 不回、不关
      sse(res, textChunks("CHILD-REPLY"));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  server.closeAllConnections?.();
  rmSync(cwd, { recursive: true, force: true });
  resetModelsDevCatalogForTest();
});

beforeEach(() => {
  requests = [];
  childSockets = [];
  hangChild = false;
  seedModelsDevCatalogForTest({
    fake: {
      models: {
        [PARENT]: {
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        },
        [CHILD]: {
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        },
        [BAD]: { reasoning: false },
        [PLAIN]: { reasoning: false },
      },
    },
  });
});

type ToolResult = {
  status: string;
  text: string;
};

/** 起父会话、让假父模型发 task 调用，等整轮结束，返回 task 工具的最终结果 */
const runParent = async (
  args: Record<string, unknown>,
  opts?: { cancelWhen?: () => boolean; parentEffort?: string },
): Promise<{ result: ToolResult | null; status: string; cancelled: boolean }> => {
  taskArgs = args;
  const agent = await createCustomAgent({
    kind: "custom",
    apiKey: "k",
    baseUrl,
    format: "openai",
    model: {
      id: PARENT,
      params: [{ id: "thinking", value: opts?.parentEffort ?? "medium" }],
    },
    local: { cwd },
  });
  const run = await agent.send("go", {});
  let result: ToolResult | null = null;
  let cancelled = false;
  const consume = (async () => {
    for await (const msg of run.stream()) {
      const m = msg as unknown as {
        type?: string;
        name?: string;
        status?: string;
        result?: { content?: Array<{ text?: string }> };
      };
      if (m.type === "tool_call" && m.name === "task" && m.status !== "running") {
        result = {
          status: m.status ?? "",
          text: (m.result?.content ?? []).map((c) => c.text ?? "").join(""),
        };
      }
    }
  })();
  if (opts?.cancelWhen) {
    const started = Date.now();
    while (!opts.cancelWhen() && Date.now() - started < 15_000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    cancelled = true;
    await run.cancel();
  }
  const waited = await run.wait();
  await consume;
  agent.close();
  return { result, status: waited.status, cancelled };
};

const childRequests = (): ChatBody[] =>
  requests.filter((r) => !isParentRequest(r));
const toolNames = (b: ChatBody): string[] =>
  (b.tools ?? []).map((t) => t.function?.name ?? "").filter(Boolean);

describe("子代理 · pi 端到端（假端点记录实际请求）", () => {
  it("缺省：沿用父模型与父思考档（parent=medium）", async () => {
    const { result } = await runParent({ prompt: "do child", description: "t" });
    expect(result?.status).toBe("completed");
    expect(result?.text).toBe("CHILD-REPLY");
    const [child] = childRequests();
    expect(child.model).toBe(PARENT);
    expect(child.reasoning_effort).toBe("medium");
  });

  it("指定 model + effort：子会话实际用的就是它（模型 id 与 reasoning_effort 都到了端点）", async () => {
    const { result } = await runParent({
      prompt: "do child",
      model: CHILD,
      effort: "high",
    });
    expect(result?.status).toBe("completed");
    expect(result?.text).toBe("CHILD-REPLY");
    const [child] = childRequests();
    expect(child.model).toBe(CHILD);
    expect(child.reasoning_effort).toBe("high");
  });

  it("换模型但不写 effort：不把父档位硬套给新模型（走新模型自己的默认）", async () => {
    // 父档位取 low：pi 对「没指定」会用它自己的默认档（high），所以 low 只可能来自误套
    await runParent(
      { prompt: "do child", model: CHILD },
      { parentEffort: "low" },
    );
    const [child] = childRequests();
    expect(child.model).toBe(CHILD);
    expect(child.reasoning_effort).not.toBe("low");
  });

  it("只改 effort：沿用父模型、换思考档", async () => {
    await runParent({ prompt: "do child", effort: "low" });
    const [child] = childRequests();
    expect(child.model).toBe(PARENT);
    expect(child.reasoning_effort).toBe("low");
  });

  it("explore 只拿只读工具；general 才有 bash / edit / write", async () => {
    await runParent({ prompt: "look", subagentType: "explore" });
    const explore = toolNames(childRequests()[0]).sort();
    expect(explore).toEqual(["find", "grep", "ls", "read"]);

    requests = [];
    await runParent({ prompt: "work", subagentType: "generalPurpose" });
    const general = toolNames(childRequests()[0]);
    expect(general).toEqual(expect.arrayContaining(["bash", "edit", "write", "read"]));
    // 子 agent 不能再派子任务、也不带系统工具
    expect(general).not.toContain("task");
    expect(general).not.toContain("submit_work");
  });

  it("model 不在当前 provider → 工具错误 + 可选项，且没发出任何子会话请求", async () => {
    const { result } = await runParent({ prompt: "x", model: "ghost-model" });
    expect(result?.status).toBe("error");
    expect(result?.text).toContain("「ghost-model」");
    expect(result?.text).toContain(`- ${CHILD}`);
    expect(childRequests()).toHaveLength(0);
  });

  it("effort 目标模型不支持 → 工具错误并列出可选档，不发子会话请求", async () => {
    const bad = await runParent({ prompt: "x", model: CHILD, effort: "max" });
    expect(bad.result?.status).toBe("error");
    expect(bad.result?.text).toContain("low | high");
    expect(childRequests()).toHaveLength(0);

    const none = await runParent({ prompt: "x", model: PLAIN, effort: "high" });
    expect(none.result?.status).toBe("error");
    expect(none.result?.text).toContain("没有 effort");
    expect(childRequests()).toHaveLength(0);
  });

  it("model:list → 返回当前 provider 的可选模型与 effort 档（不是错误，也不起子会话）", async () => {
    const { result } = await runParent({ prompt: "x", model: "list" });
    expect(result?.status).toBe("completed");
    expect(result?.text).toContain(`当前模型：${PARENT}`);
    expect(result?.text).toContain(`- ${PARENT} · effort: low | medium | high`);
    expect(result?.text).toContain(`- ${CHILD} · effort: low | high`);
    expect(childRequests()).toHaveLength(0);
  });

  it("子会话自己的模型被端点拒了 → 父会话看到原因，不是「(子任务无输出)」", async () => {
    const { result } = await runParent({ prompt: "x", model: BAD });
    expect(result?.status).toBe("error");
    expect(result?.text).toContain("子任务失败");
    expect(result?.text).not.toContain("(子任务无输出)");
    expect(result?.text).toMatch(/fake-bad|400/);
  });

  it("父会话被取消 → 子会话对端点的连接被断开（不再空转）", async () => {
    hangChild = true;
    await runParent(
      { prompt: "long job", model: CHILD },
      { cancelWhen: () => childSockets.length > 0 },
    );
    // 取消后给 abort 一点传播时间，再看对端连接是否被关
    const deadline = Date.now() + 5_000;
    while (!childSockets[0]?.closed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(childSockets[0]?.closed).toBe(true);
  });
});
