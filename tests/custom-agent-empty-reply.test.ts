/**
 * R14 Q11-01（P1-3）：自定义端点回了 200 却没给任何内容，run 不能静默「已完成」
 *
 * 旧：端点地址填成网页（200 + HTML）、网关吞了正文、模型直接空 stop——pi 都当「正常结束」。
 * Flowship 为了兼容缺 finish_reason 的网关把 supportsFinishReason 关了（custom-openai-compat.ts），
 * 流里没有 finish_reason 时 pi 自己补成 stop；于是 wait() 返回 finished、回复为空、没有任何错误，
 * 用户看到「已完成」却什么都没有。
 *
 * 新：PiRunAdapter 按整个 run 记「有没有出现过用户看得见的产出」（非空白正文 / 工具调用，思考不算），
 * agent_settled 时没有错误、没取消、一路没产出 → 以 error 收尾，文案 = EMPTY_REPLY_MESSAGE。
 *
 * 本文件是**真实链路**：真 createCustomAgent（pi 会话）+ 本机回环假的 OpenAI 兼容端点（与
 * pi-omit-git-token.test.ts 同款脚手架），不 mock pi 内部；所以「误报」（把正常回复判成空）也会红。
 * 覆盖：
 *   ① 必须报错：200+HTML / 空 stop / 只有思考没有回复 / 只有空白正文；
 *   ② 绝不能误报：正常文本回复 / 只有工具调用（之后模型空 stop）/ 先吐字后断流再重试成功 /
 *      用户取消（取消不是空回复）；
 *   ③ 文案：不含会触发自动重连的词（否则对着同一个坏地址重复请求）、够短（runner 只留前 200 字符）。
 * 不测 429 / 500 的两层重试（要等十几秒，且是另一个问题：Q11-07）。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCustomAgent } from "@/lib/server/custom-agent-backend";
import {
  resetModelsDevCatalogForTest,
  seedModelsDevCatalogForTest,
} from "@/lib/server/models-dev-catalog";
import { EMPTY_REPLY_MESSAGE } from "@/lib/pi-run-settle";
import { isRetryableRunError, summarizeRunFailure } from "@/lib/server/sdk-error";

const MODEL = "fake-plain";

type ChatBody = {
  messages: Array<{ role: string; content?: unknown }>;
};
type Responder = (
  req: { n: number; body: ChatBody },
  res: http.ServerResponse,
) => void;

let server: http.Server;
let baseUrl = "";
let cwd = "";
/** 本用例的假端点行为；n 从 1 起算，是本用例内第几次 chat 请求 */
let responder: Responder = () => {};
let requestN = 0;
/** 取消用例里要把挂起的响应放掉，否则 server.close 等不到 */
const pending = new Set<http.ServerResponse>();

const base = { id: "c1", object: "chat.completion.chunk", created: 1 };
const sseHead = (res: http.ServerResponse): void => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
};
const send = (res: http.ServerResponse, chunk: unknown): void => {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
};
const done = (res: http.ServerResponse): void => {
  res.write("data: [DONE]\n\n");
  res.end();
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
  done(res);
};
/** 200 + 流式、正常 stop，但没有任何正文 / 工具调用 */
const replyEmptyStop = (res: http.ServerResponse): void => {
  sseHead(res);
  send(res, delta({ role: "assistant" }, "stop"));
  done(res);
};
/** 一次工具调用（read 一个 cwd 里的文件） */
const replyToolCall = (res: http.ServerResponse, file: string): void => {
  sseHead(res);
  send(
    res,
    delta({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_read_1",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: file }) },
        },
      ],
    }),
  );
  send(res, delta({}, "tool_calls"));
  send(res, usage);
  done(res);
};

beforeAll(async () => {
  cwd = mkdtempSync(path.join(os.tmpdir(), "custom-agent-empty-reply-"));
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
      responder({ n: requestN, body: JSON.parse(raw) as ChatBody }, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
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
  seedModelsDevCatalogForTest({ fake: { models: { [MODEL]: { reasoning: false } } } });
});

afterEach(() => {
  for (const res of pending) res.destroy();
});

type Outcome = {
  status: string;
  result: string;
  text: string;
  toolCalls: string[];
};

/** 起一个 pi 会话发一条消息，收齐流里的正文 / 工具调用与 wait() 结果 */
const runOnce = async (opts?: { cancelAfterMs?: number }): Promise<Outcome> => {
  const agent = await createCustomAgent({
    kind: "custom",
    apiKey: "k",
    baseUrl,
    format: "openai",
    model: { id: MODEL },
    local: { cwd },
  });
  const run = await agent.send("go", {});
  let text = "";
  const toolCalls: string[] = [];
  const consume = (async () => {
    for await (const msg of run.stream()) {
      const m = msg as unknown as {
        type?: string;
        name?: string;
        status?: string;
        message?: { content?: Array<{ text?: string }> };
      };
      if (m.type === "assistant") {
        text += (m.message?.content ?? []).map((c) => c.text ?? "").join("");
      } else if (m.type === "tool_call" && m.status === "running") {
        toolCalls.push(m.name ?? "");
      }
    }
  })();
  if (opts?.cancelAfterMs !== undefined) {
    setTimeout(() => void run.cancel(), opts.cancelAfterMs);
  }
  const waited = await run.wait();
  await consume;
  agent.close();
  return { status: waited.status, result: waited.result ?? "", text, toolCalls };
};

describe("空回复必须报错，不能静默「已完成」（Q11-01）", () => {
  it("端点地址填成网页：200 + text/html、没有任何 SSE 数据 → error（旧：finished、回复为空）", async () => {
    responder = (_r, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>gateway login</body></html>");
    };
    const out = await runOnce();
    expect(out.status).toBe("error");
    expect(out.result).toBe(EMPTY_REPLY_MESSAGE);
    expect(out.text).toBe("");
    expect(requestN).toBe(1); // 不重试、不重放同一个坏请求
  }, 60_000);

  it("200 + 流式、正常 stop，但没有任何正文 → error（旧：finished）", async () => {
    responder = (_r, res) => replyEmptyStop(res);
    const out = await runOnce();
    expect(out.status).toBe("error");
    expect(out.result).toBe(EMPTY_REPLY_MESSAGE);
    expect(requestN).toBe(1);
  }, 60_000);

  it("只有思考、没有正文也没有工具调用 → error（用户这边仍是一条空回复；思考不算产出）", async () => {
    responder = (_r, res) => {
      sseHead(res);
      send(res, delta({ role: "assistant", reasoning_content: "让我想想……" }));
      send(res, delta({}, "stop"));
      send(res, usage);
      done(res);
    };
    const out = await runOnce();
    expect(out.status).toBe("error");
    expect(out.result).toBe(EMPTY_REPLY_MESSAGE);
  }, 60_000);

  it("正文只有空白（换行 / 空格）→ error（屏幕上是一个空气泡）", async () => {
    responder = (_r, res) => replyText(res, " \n\n  ");
    const out = await runOnce();
    expect(out.status).toBe("error");
    expect(out.result).toBe(EMPTY_REPLY_MESSAGE);
  }, 60_000);
});

describe("正常回复绝不能被误判成空回复", () => {
  it("正常文本回复 → finished，正文原样送达", async () => {
    responder = (_r, res) => replyText(res, "HELLO-REPLY");
    const out = await runOnce();
    expect(out.status).toBe("finished");
    expect(out.text).toBe("HELLO-REPLY");
    expect(out.result).toBe("");
  }, 60_000);

  it("前面有空白、后面有正文 → finished（只要出现过非空白正文就算有产出）", async () => {
    responder = (_r, res) => {
      sseHead(res);
      send(res, delta({ role: "assistant", content: "\n\n" }));
      send(res, delta({ content: "REAL" }));
      send(res, delta({}, "stop"));
      send(res, usage);
      done(res);
    };
    const out = await runOnce();
    expect(out.status).toBe("finished");
    expect(out.text).toBe("\n\nREAL");
  }, 60_000);

  it("只调用工具、工具跑完后模型空 stop → finished（整个 run 出现过工具调用就算有产出，不是只看最后一条）", async () => {
    responder = ({ n }, res) => {
      if (n === 1) return replyToolCall(res, "probe.txt");
      replyEmptyStop(res); // 工具回包之后模型一句话没说
    };
    const out = await runOnce();
    expect(requestN).toBe(2);
    expect(out.toolCalls).toEqual(["read"]);
    expect(out.status).toBe("finished");
    expect(out.result).toBe("");
  }, 60_000);

  it("工具调用 + 之后正常文本 → finished", async () => {
    responder = ({ n }, res) => {
      if (n === 1) return replyToolCall(res, "probe.txt");
      replyText(res, "READ-DONE");
    };
    const out = await runOnce();
    expect(out.status).toBe("finished");
    expect(out.text).toBe("READ-DONE");
  }, 60_000);

  it("先吐字后断流、pi 自动重试后第二次正常 → finished（重试过程不是空回复）", async () => {
    responder = ({ n }, res) => {
      if (n === 1) {
        // 第 1 次：吐半截就把连接掐断（网关中途断流）
        sseHead(res);
        send(res, delta({ role: "assistant", content: "PART-A " }));
        setTimeout(() => res.destroy(), 50);
        return;
      }
      replyText(res, "FULL-ANSWER");
    };
    const out = await runOnce();
    expect(requestN).toBe(2); // pi 在同一个 run 里自动重试了一次（要等它的退避间隔，约 2 秒）
    expect(out.status).toBe("finished");
    expect(out.result).toBe("");
    // 这里只钉「重试过程不是空回复」；半截和全文怎么分成几条落盘，见 tests/custom-agent-retry-dup.test.ts（Q11-02）
    expect(out.text).toContain("FULL-ANSWER");
  }, 60_000);

  it("用户取消不会被说成空回复：端点一直不回、点停止 → 不是 finished，结果里也没有空回复文案", async () => {
    responder = () => {
      /* 故意不回：模拟模型还在想 */
    };
    const out = await runOnce({ cancelAfterMs: 300 });
    // 注意：飞行中中止时 pi 先发 agent_end（assistant stopReason=aborted），适配器据此以 error 收尾
    // （既有行为，宿主 runner 靠自己的 cancelled 标志兜底成「已取消」），所以这里不断言 cancelled；
    // 「取消 + 一路没产出 → cancelled」这条精确守卫在 pi-run-adapter.test.ts 里用合成事件钉
    expect(out.status).not.toBe("finished");
    expect(out.result).not.toContain("没有返回任何内容");
  }, 60_000);
});

describe("空回复文案", () => {
  it("关键句在最前、整句够短：runner 只把 result 前 200 字符拼进 `agent run status=error: …`", () => {
    expect(EMPTY_REPLY_MESSAGE.startsWith("模型没有返回任何内容")).toBe(true);
    expect(EMPTY_REPLY_MESSAGE.length).toBeLessThan(120);
  });

  it("不会被当成断线自动重连（否则对着同一个坏地址反复请求）：run 以 status=error + 这句收尾 → isRetryableRunError 为 false", () => {
    // 与 chat-runner / task-runner 拼 message 的口径一致：result 内联在 status 后
    const raw = `agent run status=error: ${EMPTY_REPLY_MESSAGE.slice(0, 200)}\n--- SDK result dump ---\n{"status":"error"}`;
    const err = new Error(raw);
    expect(isRetryableRunError(raw, err)).toBe(false);
    expect(isRetryableRunError(raw, err, 1)).toBe(false);
    const summary = summarizeRunFailure(raw, err);
    expect(summary.isConnectionDrop).toBe(false);
    expect(summary.isSdkGiveUp).toBe(false);
    expect(summary.text).toContain("模型没有返回任何内容");
    // 单独一句也不重连
    expect(isRetryableRunError(EMPTY_REPLY_MESSAGE, new Error(EMPTY_REPLY_MESSAGE))).toBe(false);
  });
});
