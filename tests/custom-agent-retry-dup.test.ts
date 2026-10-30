/**
 * R14 Q11-02（P1-4）：pi 内层自动重试之后，「半截 + 全文」不能被焊成同一条回复
 *
 * 旧：流被掐断 / 网关 5xx 之后 pi 自己退避、把这一条回复整个重新生成一遍。出错的半截在重试之前已经推给 UI；
 * sdk-message-handler 只在遇到 tool_call / thinking 才 flush assistant buffer，于是半截和重新生成的全文被累加进
 * 同一个 buffer、落成**同一条** assistant_message（「半截 + 全文」，读起来是一段重复的话）。
 * 子代理返回值 / chat 标题生成是同一个根因：result += text_delta，不看重试。
 *
 * 新：PiRunAdapter 在 auto_retry_start 推一条合成边界消息（并把半截里悬挂的 running 工具卡补成 error）；
 * handleSdkMessage 在边界上把半截落成独立的一条、紧跟一行普通 info 说明，之后重新生成的全文才是新的一条；
 * 子代理 / 标题生成在边界清空已累加的文本。**不删已经流出去的字**——用户看到过的内容不能凭空消失。
 *
 * 本文件是真实链路：真 createCustomAgent（pi 会话）+ 本机回环假端点 + 真 handleSdkMessage / flushAssistantSegment
 * （只把落盘 sink 换成内存收集）+ 真的前端合并函数 mergeToolDisplayEvents（断言「UI 最终看到什么」）。
 *
 * 覆盖：
 *   ① OpenAI 兼容端点：一次成功（无说明行）/ 半截后断流 / 一字未吐就 503 / 连续两次断流；
 *   ② chat 标题生成（promptOnceCustom）只含最后一遍；
 *   ③ Anthropic 格式端点——**半截里的工具调用能真正亮起 running 的唯一路径**：
 *      旧卡补成 error + 重试后新卡 completed、没有残留 running；正常 tool_use 流程不被误补；
 *      同一个 call id 被网关复用时的真实表现（特征化，已知局限）。
 *
 * 为什么工具卡的用例用 Anthropic 格式：实测 pi-ai 对 OpenAI 兼容的流式响应是「整条流正常结束才吐出工具调用块」，
 * tool_call 吐到一半（含 finish_reason=tool_calls 之后）被掐断，都不会发 toolcall_end，半截里根本没有 running 卡
 * （下面有一条【特征化】用例钉住这个假设）；Anthropic 格式是 content_block_stop 就发 toolcall_end，
 * 之后再断流才会留下「亮着却永远等不到结果」的卡。
 *
 * 每次重试要等 pi 的退避（约 2 s，第二次 4 s），所以用例超时给得宽。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RETRY_INTERRUPTED_TOOL_RESULT } from "@/lib/pi-run-settle";
import {
  isToolBlock,
  isToolVerbGroup,
  mergeToolDisplayEvents,
  type ToolBlock,
} from "@/lib/tool-display";
import type { TaskEvent } from "@/lib/types";
import { createCustomAgent, promptOnceCustom } from "@/lib/server/custom-agent-backend";
import {
  resetModelsDevCatalogForTest,
  seedModelsDevCatalogForTest,
} from "@/lib/server/models-dev-catalog";
import {
  __resetToolCallRunningSeenForTest,
  flushAssistantSegment,
  handleSdkMessage,
  type AssistantBufferCtx,
} from "@/lib/server/sdk-message-handler";

type Written = {
  kind: string;
  text?: string;
  meta?: Record<string, unknown>;
  id?: string;
};

/** 落盘 sink 换成内存收集：handleSdkMessage / flushAssistantSegment 写的每个事件都经它（与 sdk-message-handler.test.ts 同款隔离） */
const sink = vi.hoisted(() => ({ written: [] as Written[] }));

vi.mock("@/lib/server/task-fs", () => ({
  getTask: vi.fn(),
  patchActionIfOwner: vi.fn(),
  appendEvent: vi.fn(async () => null),
}));
vi.mock("@/lib/server/failpoints", () => ({
  failpoint: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return {
    ...actual,
    writeOwnedEventAndPublish: async (
      _taskId: string,
      _lease: () => boolean,
      ev: Written,
    ) => {
      sink.written.push(ev);
    },
    publish: vi.fn(),
    publishIfCurrent: vi.fn(),
  };
});

const MODEL = "fake-retry-dup";
const TASK = "task-retry-dup";

type Responder = (req: { n: number }, res: http.ServerResponse) => void;

let server: http.Server;
let origin = "";
let cwd = "";
/** 本用例的假端点行为；n 从 1 起算，是本用例内第几次模型请求 */
let responder: Responder = () => {};
let requestN = 0;
const pending = new Set<http.ServerResponse>();

beforeAll(async () => {
  cwd = mkdtempSync(path.join(os.tmpdir(), "custom-agent-retry-dup-"));
  writeFileSync(path.join(cwd, "probe.txt"), "hello probe\n");
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      requestN++;
      pending.add(res);
      res.on("close", () => pending.delete(res));
      responder({ n: requestN }, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const res of pending) res.destroy();
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(cwd, { recursive: true, force: true });
  resetModelsDevCatalogForTest();
});

beforeEach(() => {
  requestN = 0;
  responder = () => {};
  sink.written.length = 0;
  __resetToolCallRunningSeenForTest();
  seedModelsDevCatalogForTest({ fake: { models: { [MODEL]: { reasoning: false } } } });
});

afterEach(() => {
  for (const res of pending) res.destroy();
});

// ───────────────────────── 假端点：OpenAI 兼容 ─────────────────────────

const base = { id: "c1", object: "chat.completion.chunk", created: 1 };
const sseHead = (res: http.ServerResponse): void => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
};
const send = (res: http.ServerResponse, chunk: unknown): void => {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
};
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  ...base,
  model: "m",
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const usage = {
  ...base,
  model: "m",
  choices: [],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
/** 正常文本回复 */
const replyText = (res: http.ServerResponse, text: string): void => {
  sseHead(res);
  send(res, delta({ role: "assistant", content: text }));
  send(res, delta({}, "stop"));
  send(res, usage);
  res.write("data: [DONE]\n\n");
  res.end();
};
/** 吐一段文字后把连接掐断（网关中途断流） */
const partialThenCut = (res: http.ServerResponse, text: string): void => {
  sseHead(res);
  send(res, delta({ role: "assistant", content: text }));
  setTimeout(() => res.destroy(), 50);
};
/** 一个字都没吐就 503（网关过载） */
const unavailable = (res: http.ServerResponse): void => {
  res.writeHead(503, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "service unavailable" } }));
};

// ───────────────────────── 假端点：Anthropic 格式 ─────────────────────────

const aEvent = (res: http.ServerResponse, type: string, data: Record<string, unknown>): void => {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
};
const aStart = (res: http.ServerResponse): void => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  aEvent(res, "message_start", {
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "fake",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
};
/** 一个完整的 tool_use 块（content_block_stop 为止） */
const aToolUseBlock = (res: http.ServerResponse, id: string): void => {
  aEvent(res, "content_block_start", {
    index: 0,
    content_block: { type: "tool_use", id, name: "read", input: {} },
  });
  aEvent(res, "content_block_delta", {
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: "probe.txt" }) },
  });
  aEvent(res, "content_block_stop", { index: 0 });
};
/** tool_use 块完整结束之后，连接被掐断（整条消息没有正常收尾） */
const aToolUseThenCut = (res: http.ServerResponse, id: string): void => {
  aStart(res);
  aToolUseBlock(res, id);
  setTimeout(() => res.destroy(), 60);
};
/** 正常的 tool_use 回合（stop_reason=tool_use，pi 会执行工具再发下一轮请求） */
const aToolUse = (res: http.ServerResponse, id: string): void => {
  aStart(res);
  aToolUseBlock(res, id);
  aEvent(res, "message_delta", {
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  aEvent(res, "message_stop", {});
  res.end();
};
const aText = (res: http.ServerResponse, text: string): void => {
  aStart(res);
  aEvent(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  aEvent(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  aEvent(res, "content_block_stop", { index: 0 });
  aEvent(res, "message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 2 },
  });
  aEvent(res, "message_stop", {});
  res.end();
};

// ───────────────────────── 驱动：真 agent → 真 handleSdkMessage ─────────────────────────

type Driven = { status: string; result: string; events: Written[] };

/** 与 runner 的 consume 同形：流里的每条消息交给 handleSdkMessage，run 结束时收尾 flush */
const drive = async (format: "openai" | "anthropic" = "openai"): Promise<Driven> => {
  const agent = await createCustomAgent({
    kind: "custom",
    apiKey: "k",
    baseUrl: format === "openai" ? `${origin}/v1` : origin,
    format,
    model: { id: MODEL },
    local: { cwd },
  });
  const run = await agent.send("go", {});
  const lease = () => true;
  const ctx: AssistantBufferCtx = {
    buffer: "",
    flush: () => flushAssistantSegment(TASK, ctx, lease),
  };
  for await (const msg of run.stream()) {
    await handleSdkMessage(TASK, msg, ctx, lease);
  }
  await ctx.flush();
  const waited = await run.wait();
  agent.close();
  return {
    status: waited.status,
    result: waited.result ?? "",
    events: sink.written.map((e) => ({ ...e })),
  };
};

const RETRY_LINE = (n: number): string => `info:连接中断，已自动重试（第 ${n}/3 次）`;

/** 落盘事件的紧凑形态：对话内容 / 说明行 / 工具卡，按落盘顺序 */
const shape = (events: Written[]): string[] =>
  events
    .filter((e) =>
      ["assistant_message", "thinking", "info", "tool_call", "tool_result"].includes(e.kind),
    )
    .map((e) => {
      const m = e.meta ?? {};
      if (e.kind === "tool_call") return `tool_call:${String(m.callId)}`;
      if (e.kind === "tool_result") return `tool_result:${String(m.callId)}:${String(m.status)}`;
      return `${e.kind}:${e.text ?? ""}`;
    });

/** 把落盘事件交给前端的合并函数，取 UI 最终渲染出来的工具块（verb 组展开成成员） */
const uiToolBlocks = (events: Written[]): ToolBlock[] =>
  mergeToolDisplayEvents(
    events.map((e, i) => ({ id: `ev${i}`, ts: 1_000 + i, ...e }) as unknown as TaskEvent),
  ).flatMap((it) => (isToolBlock(it) ? [it] : isToolVerbGroup(it) ? it.members : []));
const blockShape = (blocks: ToolBlock[]): string[] =>
  blocks.map((b) => `${b.callId}:${b.status}`);

describe("OpenAI 兼容端点：重试前后的回复是分开的几条（Q11-02）", () => {
  it("一次就成功 → 只有回复，没有说明行（既有行为不变）", async () => {
    responder = (_r, res) => replyText(res, "HELLO-REPLY");
    const out = await drive();
    expect(out.status).toBe("finished");
    expect(requestN).toBe(1);
    expect(shape(out.events)).toEqual(["assistant_message:HELLO-REPLY"]);
  }, 60_000);

  it("吐了半截就断流、pi 自动重试成功 → [半截, 说明, 全文] 三段，不再焊成一条「半截 + 全文」（旧：一条）", async () => {
    responder = ({ n }, res) => {
      if (n === 1) return partialThenCut(res, "PART-A ");
      replyText(res, "FULL-ANSWER");
    };
    const out = await drive();
    expect(requestN).toBe(2); // 要等 pi 的退避（约 2 秒）
    expect(out.status).toBe("finished");
    expect(shape(out.events)).toEqual([
      "assistant_message:PART-A",
      RETRY_LINE(1),
      "assistant_message:FULL-ANSWER",
    ]);
    // 说明行是普通 info：meta.kind=auto_retry 带次数，不带 pi 的错误原文
    const info = out.events.find((e) => e.kind === "info");
    expect(info?.meta).toEqual({ kind: "auto_retry", attempt: 1, max: 3 });
  }, 60_000);

  it("一个字都没吐就 503、重试成功 → [说明, 全文]，中间不出空消息", async () => {
    responder = ({ n }, res) => {
      if (n === 1) return unavailable(res);
      replyText(res, "FULL-ANSWER");
    };
    const out = await drive();
    expect(requestN).toBe(2);
    expect(out.status).toBe("finished");
    expect(shape(out.events)).toEqual([RETRY_LINE(1), "assistant_message:FULL-ANSWER"]);
  }, 60_000);

  it("连续两次断流（各吐一截）→ [A1, 说明 1/3, A2, 说明 2/3, 全文]", async () => {
    responder = ({ n }, res) => {
      if (n === 1) return partialThenCut(res, "PART-A ");
      if (n === 2) return partialThenCut(res, "PART-B ");
      replyText(res, "FULL-ANSWER");
    };
    const out = await drive();
    expect(requestN).toBe(3); // 退避 2 秒 + 4 秒
    expect(out.status).toBe("finished");
    expect(shape(out.events)).toEqual([
      "assistant_message:PART-A",
      RETRY_LINE(1),
      "assistant_message:PART-B",
      RETRY_LINE(2),
      "assistant_message:FULL-ANSWER",
    ]);
  }, 60_000);

  it("【特征化·pi-ai 行为】tool_call 吐了一半就断流 → 半截里没有 running 工具卡（pi-ai 不为未完成的流发 toolcall_end）", async () => {
    // 这是「工具卡补 error」在 OpenAI 兼容路径上基本不会触发的依据。pi-ai 升级后若开始发 toolcall_end，
    // 本条会变红——补 error 已经兜住那种情况，红了说明这条依据变了，到 HANDOFF 里更新说明即可
    responder = ({ n }, res) => {
      if (n === 1) {
        sseHead(res);
        send(
          res,
          delta({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                type: "function",
                function: { name: "read", arguments: '{"path":"probe.' },
              },
            ],
          }),
        );
        setTimeout(() => res.destroy(), 60);
        return;
      }
      replyText(res, "FULL-ANSWER");
    };
    const out = await drive();
    expect(out.status).toBe("finished");
    expect(shape(out.events)).toEqual([RETRY_LINE(1), "assistant_message:FULL-ANSWER"]);
    expect(uiToolBlocks(out.events)).toEqual([]);
  }, 60_000);
});

describe("chat 标题生成（promptOnceCustom）：只取最后一遍（Q11-02）", () => {
  it("第一次吐了半截就断流、重试成功 → 标题是完整的那一遍，不是「半截 + 完整」", async () => {
    responder = ({ n }, res) => {
      if (n === 1) return partialThenCut(res, "半截标");
      replyText(res, "完整标题");
    };
    const out = await promptOnceCustom("给这段对话起个标题", {
      kind: "custom",
      apiKey: "k",
      baseUrl: `${origin}/v1`,
      format: "openai",
      model: { id: MODEL },
      local: { cwd },
    });
    expect(requestN).toBe(2);
    expect(out.result).toBe("完整标题");
  }, 60_000);
});

describe("Anthropic 格式端点：半截里的工具调用（Q11-02）", () => {
  it("正常的 tool_use 流程不被误补：没有说明行、没有 error 卡，工具卡 success", async () => {
    responder = ({ n }, res) => {
      if (n === 1) return aToolUse(res, "toolu_1");
      aText(res, "READ-DONE");
    };
    const out = await drive("anthropic");
    expect(out.status).toBe("finished");
    expect(requestN).toBe(2);
    expect(shape(out.events)).toEqual([
      "tool_call:toolu_1",
      "tool_result:toolu_1:success",
      "assistant_message:READ-DONE",
    ]);
    expect(blockShape(uiToolBlocks(out.events))).toEqual(["toolu_1:success"]);
  }, 60_000);

  it("tool_use 块结束后断流、重试后模型重新发起（新 call id）→ 旧卡补成 error、新卡 success，UI 上没有残留的 running", async () => {
    responder = ({ n }, res) => {
      if (n === 1) return aToolUseThenCut(res, "toolu_1");
      if (n === 2) return aToolUse(res, "toolu_2");
      aText(res, "READ-DONE");
    };
    const out = await drive("anthropic");
    expect(out.status).toBe("finished");
    expect(requestN).toBe(3);
    expect(shape(out.events)).toEqual([
      "tool_call:toolu_1",
      "tool_result:toolu_1:error", // 补出来的：这次调用没有执行
      RETRY_LINE(1),
      "tool_call:toolu_2",
      "tool_result:toolu_2:success",
      "assistant_message:READ-DONE",
    ]);
    const blocks = uiToolBlocks(out.events);
    expect(blockShape(blocks)).toEqual(["toolu_1:error", "toolu_2:success"]);
    expect(blocks[0].result?.output).toContain(RETRY_INTERRUPTED_TOOL_RESULT);
    expect(blocks.some((b) => b.status === "running")).toBe(false);
  }, 60_000);

  it("【特征化·已知局限】网关重试时复用同一个 call id → 旧卡的 error 作为独立的一块留在边界处，最终结果归到第一张卡，没有残留 running", async () => {
    // 同 callId 的第二次 running 会被 handleSdkMessage 的「二次 running 去重」吞掉；前端按 callId 配对时取最后一条
    // tool_result（success）给第一张卡，前面那条补出来的 error 没人认领，就以一个独立的 error 块出现。
    // 信息没丢、也不会一直转圈，只是多一块。真实网关的 call id 通常每次重新生成（上一条用例），复用比较少见；
    // 不为这个改前端的配对逻辑（改动面大），这里钉住当前表现，以后有人动配对 / 去重逻辑时能看见影响
    responder = ({ n }, res) => {
      if (n === 1) return aToolUseThenCut(res, "toolu_1");
      if (n === 2) return aToolUse(res, "toolu_1");
      aText(res, "READ-DONE");
    };
    const out = await drive("anthropic");
    expect(out.status).toBe("finished");
    expect(shape(out.events)).toEqual([
      "tool_call:toolu_1",
      "tool_result:toolu_1:error",
      RETRY_LINE(1),
      // 第二次 running 被去重吞掉，只剩最终结果
      "tool_result:toolu_1:success",
      "assistant_message:READ-DONE",
    ]);
    const blocks = uiToolBlocks(out.events);
    expect(blockShape(blocks)).toEqual(["toolu_1:success", "toolu_1:error"]);
    expect(blocks.some((b) => b.status === "running")).toBe(false);
  }, 60_000);
});
