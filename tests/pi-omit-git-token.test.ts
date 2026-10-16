/**
 * N3-01（pi 路径）：旁路会话的 shell / 子代理 bash 拿不到 GitLab PAT，属主会话照常拿得到
 *
 * 背景：GitLab PAT 放在 server 的 `process.env.FLOWSHIP_GITLAB_TOKEN`（git-token-env.ts），pi 的 shell 工具
 * 继承它。需求群「非属主答疑旁路」是工具全开的 honor-system agent，群里任何人让它 `printenv` 就能拿到。
 * 修法：旁路显式传 `omitGitToken: true`（agent-backend → custom-agent-backend → pi-coding-tools），
 * shell 工具、以及 `task` general 子代理的原生 bash 都用摘掉该变量的 env。
 *
 * 本文件是**真实链路**：真 createCustomAgent（pi 会话）+ 本机假的 OpenAI 兼容端点，
 * 假模型照剧本发 `shell` / `task→bash` 工具调用，我们读真实工具回包——
 * 不是单测某个内部函数，所以任何一环断了（标记没透传 / 子代理 bash 没覆盖）都会红。
 * 子代理那条是回退自检里最关键的一条：只摘父会话 shell、不摘子代理 bash 时，它会变红。
 *
 * 只用假 token（FAKE_TOKEN），用完还原 process.env；不碰真实数据目录。
 * Cursor provider 不在这里：SDK 继承 server env、本来就摘不掉（见 git-token-env.ts 头部与 agent-backend 注释）。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCustomAgent } from "@/lib/server/custom-agent-backend";
import { GITLAB_TOKEN_ENV_NAME } from "@/lib/server/git-token-env";
import {
  resetModelsDevCatalogForTest,
  seedModelsDevCatalogForTest,
} from "@/lib/server/models-dev-catalog";

const FAKE_TOKEN = "glpat-FAKE-OMIT-GIT-TOKEN-0001";
const MODEL = "fake-plain";
/** 先 printenv（变量不存在时无输出）再回显：两种读法都覆盖；值只可能是上面的假 token */
const PROBE_COMMAND = `printenv ${GITLAB_TOKEN_ENV_NAME}; echo "val=[$${GITLAB_TOKEN_ENV_NAME}]"; echo "path=[\${PATH:+set}]"`;

type ChatBody = {
  model: string;
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
};

const SKIP = process.platform === "win32"; // 用 bash 语法，Windows 靠 Git Bash 另测

let server: http.Server;
let baseUrl = "";
let cwd = "";
/** 父会话第一轮要发的工具调用 */
let parentCall: { name: string; args: Record<string, unknown> } = {
  name: "shell",
  args: {},
};
const ORIGINAL_TOKEN = process.env[GITLAB_TOKEN_ENV_NAME];

const sse = (res: http.ServerResponse, chunks: unknown[]): void => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
};
const base = { id: "c1", object: "chat.completion.chunk", created: 1 };
const usage = {
  ...base,
  model: "m",
  choices: [],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const textChunks = (text: string) => [
  {
    ...base,
    model: "m",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  },
  { ...base, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  usage,
];
const toolCallChunks = (name: string, args: Record<string, unknown>) => [
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
              id: `call_${name}_1`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  { ...base, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  usage,
];

const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c as { text?: string }).text ?? "").join("")
      : JSON.stringify(content);

beforeAll(async () => {
  cwd = mkdtempSync(path.join(os.tmpdir(), "pi-omit-git-token-"));
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw) as ChatBody;
      const names = (body.tools ?? []).map((t) => t.function?.name ?? "");
      const isParent = names.includes("task"); // 子会话不能再派子任务
      const lastTool = body.messages.filter((m) => m.role === "tool").pop();
      if (isParent) {
        if (!lastTool) return sse(res, toolCallChunks(parentCall.name, parentCall.args));
        return sse(res, textChunks("PARENT-DONE"));
      }
      // 子代理：先跑一次 bash 探针，拿到回包后把它原样作为最终文本交回给父会话
      if (!lastTool) return sse(res, toolCallChunks("bash", { command: PROBE_COMMAND }));
      return sse(res, textChunks(`CHILD-SAW:${contentText(lastTool.content)}`));
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
  process.env[GITLAB_TOKEN_ENV_NAME] = FAKE_TOKEN;
  seedModelsDevCatalogForTest({ fake: { models: { [MODEL]: { reasoning: false } } } });
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env[GITLAB_TOKEN_ENV_NAME];
  else process.env[GITLAB_TOKEN_ENV_NAME] = ORIGINAL_TOKEN;
});

/** 起一个 pi 会话、让假模型发 parentCall，返回那次工具调用的真实回包文本 */
const runSession = async (opts: {
  omitGitToken?: boolean;
  call: { name: string; args: Record<string, unknown> };
}): Promise<{ toolText: string; status: string }> => {
  parentCall = opts.call;
  const agent = await createCustomAgent({
    kind: "custom",
    apiKey: "k",
    baseUrl,
    format: "openai",
    model: { id: MODEL },
    local: { cwd },
    // 对照「属主 / 旁路」唯一的差别：显式标记（两者都没有 callerToken，和线上一致）
    ...(opts.omitGitToken ? { omitGitToken: true } : {}),
  });
  const run = await agent.send("go", {});
  let toolText = "";
  const consume = (async () => {
    for await (const msg of run.stream()) {
      const m = msg as unknown as {
        type?: string;
        name?: string;
        status?: string;
        result?: { content?: Array<{ text?: string }> };
      };
      if (m.type === "tool_call" && m.name === opts.call.name && m.status !== "running") {
        toolText = (m.result?.content ?? []).map((c) => c.text ?? "").join("");
      }
    }
  })();
  const waited = await run.wait();
  await consume;
  agent.close();
  return { toolText, status: waited.status };
};

const SHELL_CALL = { name: "shell", args: { command: PROBE_COMMAND } };
const TASK_CALL = {
  name: "task",
  args: { prompt: "probe env", description: "probe", subagentType: "generalPurpose" },
};

describe.skipIf(SKIP)("pi 会话的 GitLab token 环境变量（真实 createCustomAgent + shell / 子代理 bash）", () => {
  it("属主会话（不传 omitGitToken）：shell 里拿得到 token（对照：证明探针有效、没误伤）", async () => {
    const { toolText } = await runSession({ call: SHELL_CALL });
    expect(toolText).toContain(`val=[${FAKE_TOKEN}]`);
    expect(toolText).toContain("path=[set]");
  }, 60_000);

  it("旁路会话（omitGitToken:true）：shell 里 printenv / echo 都拿不到 token，其它环境变量不受影响", async () => {
    const { toolText } = await runSession({ omitGitToken: true, call: SHELL_CALL });
    expect(toolText).not.toContain(FAKE_TOKEN);
    expect(toolText).toContain("val=[]");
    // 只摘这一个变量：PATH 还在（否则「摘」成了「把 env 清空」，旁路连 git / node 都跑不了）
    expect(toolText).toContain("path=[set]");
  }, 60_000);

  it("属主会话 → task 子代理的 bash：拿得到 token（对照）", async () => {
    const { toolText } = await runSession({ call: TASK_CALL });
    expect(toolText).toContain("CHILD-SAW:");
    expect(toolText).toContain(`val=[${FAKE_TOKEN}]`);
  }, 60_000);

  it("旁路会话 → 派 general 子代理 → 子代理的 bash 同样拿不到 token（否则一条 task 就绕过了）", async () => {
    const { toolText } = await runSession({ omitGitToken: true, call: TASK_CALL });
    expect(toolText).toContain("CHILD-SAW:");
    expect(toolText).not.toContain(FAKE_TOKEN);
    expect(toolText).toContain("val=[]");
    expect(toolText).toContain("path=[set]");
  }, 60_000);

  it("摘除只作用于该会话的子进程 env：server 自己的 process.env 与并行的属主会话不受影响", async () => {
    await runSession({ omitGitToken: true, call: SHELL_CALL });
    // 进程全局 env 没被动过（动了会把属主并行会话也弄坏）
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(FAKE_TOKEN);
    const owner = await runSession({ call: SHELL_CALL });
    expect(owner.toolText).toContain(`val=[${FAKE_TOKEN}]`);
  }, 60_000);
});
