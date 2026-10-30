/**
 * 错误卡「按失败类型给中文说明 + 对应入口」（第二轮 review V3-03）
 *
 * 旧：限流 / 鉴权 / 模型不可用 / 上下文超长 / 额度这几类最常见的失败，错误卡只展示英文原串；
 * 按钮只有 查看详情 / 复制 / 重试，没有「去设置」「开新对话」；鉴权类「重试」同模型同 key 必然再败。
 *
 * 新：lib/error-classify.ts 纯函数
 *   classifyErrorText(text) → { kind, title, hint }（中文、业务口径、不含协议词 / 英文原串）
 *   planErrorActions(kind, { mode }) → 去设置 / 开新对话 / 重试主次
 *   buildErrorCardModel(text, detail, { mode }) → 卡片要画的几段（正文 / 建议 / 详情 / 复制串）
 * 原串仍在「查看详情」与「复制」里。
 *
 * 判定口径：「误判成本高」的类（鉴权 / 额度 / 模型 / 上下文——会引导去设置、降级重试）严格，
 * 「误判成本低」的类（限流 / 网络——都是「稍后重试」）宽松一点；拿不准一律 unknown、保持原样展示。
 * 数字状态码必须有上下文（status / HTTP / code / 「401 Unauthorized」），端口 / 行号 / 文件名不算。
 *
 * 纯函数测试 + 源码契约（UI 在 node 下跑不起来，见 vitest.config.ts）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildErrorCardModel,
  classifyErrorText,
  ERROR_DETAIL_HEADING,
  planErrorActions,
  type ErrorKind,
} from "@/lib/error-classify";
import { EMPTY_REPLY_MESSAGE } from "@/lib/pi-run-settle";

const readSrc = (...seg: string[]): string =>
  readFileSync(
    path.resolve(import.meta.dirname, "..", "src", ...seg),
    "utf-8",
  );

const kindOf = (text: string): ErrorKind => classifyErrorText(text).kind;

const SDK_FIELDS = (json: string): string =>
  `agent run failed\n--- SDK error fields ---\n${json}`;

describe("classifyErrorText：限流 rate_limit", () => {
  it.each([
    "429 Too Many Requests",
    "HTTP 429: Too many requests, slow down",
    "Request failed with status code 429",
    "Rate limit reached for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Used 29000, Requested 4000. Please try again in 6s.",
    "Request too large for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Requested 45000. The input or output tokens must be reduced in order to run successfully.",
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization"}}',
    "overloaded_error: Overloaded",
    '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "The model is overloaded. Please try again later.",
    "Quota exceeded for quota metric 'Generate Content API requests per minute' and limit 'GenerateContent request limit per minute'",
    "Resource has been exhausted (e.g. check quota). RESOURCE_EXHAUSTED",
    "[resource_exhausted] Error",
    SDK_FIELDS('{\n  "code": 8,\n  "isRetryable": false\n}'),
    SDK_FIELDS('{ "status": 429, "requestId": "abc" }'),
    "请求过于频繁，请稍后再试",
    "触发限流，请降低调用频率",
    "调用频率超限",
    "服务繁忙，请稍后重试",
    "您的请求太多了",
    "429：请求频率过高",
  ])("%s", (text) => {
    expect(kindOf(text)).toBe("rate_limit");
  });
});

describe("classifyErrorText：鉴权 auth", () => {
  it.each([
    "401 Incorrect API key provided: sk-abc***xyz. You can find your API key at https://platform.openai.com/account/api-keys.",
    "Invalid API key",
    "invalid_api_key",
    "invalid x-api-key",
    "HTTP 401 Unauthorized",
    "Request failed with status code 401",
    "Request failed with status code 403",
    "403 Forbidden",
    "Unauthorized",
    "Authentication error. Please try logging out and back in.",
    "authentication_error: invalid bearer token",
    "[unauthenticated] Error",
    "[permission_denied] Error",
    '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}',
    "Missing API key",
    "Country, region, or territory not supported",
    SDK_FIELDS('{\n  "code": 16,\n  "isRetryable": false\n}'),
    SDK_FIELDS('{ "code": 7 }'),
    SDK_FIELDS('{ "status": 401 }'),
    "API Key 无效",
    "令牌无效或已过期",
    "鉴权失败",
    "认证失败，请检查密钥",
    "未授权",
    "登录已过期，请重新登录",
  ])("%s", (text) => {
    expect(kindOf(text)).toBe("auth");
  });
});

describe("classifyErrorText：模型不可用 model_unavailable", () => {
  it.each([
    "The model `gpt-5-turbo` does not exist or you do not have access to it.",
    "404 The model `gpt-5-turbo` does not exist",
    "model_not_found",
    "Model not found: claude-x",
    "Unknown model: foo",
    "Invalid model name",
    "Unsupported model: bar",
    "You do not have access to the model claude-opus",
    "The requested model is not available for your account",
    "This model has been deprecated",
    "The model was decommissioned on 2025-01-01",
    '404 {"error":{"message":"models/gemini-9 is not found for API version v1beta, or is not supported for generateContent."}}',
    "模型不存在",
    "找不到该模型",
    "该模型已下线",
    "你没有权限访问该模型",
    "不支持该模型",
  ])("%s", (text) => {
    expect(kindOf(text)).toBe("model_unavailable");
  });

  it("优先于鉴权：「不存在或没有权限」是模型问题、不是 Key 问题", () => {
    expect(
      kindOf("403 The model `x` does not exist or you do not have access to it."),
    ).toBe("model_unavailable");
  });
});

describe("classifyErrorText：上下文超长 context_overflow", () => {
  it.each([
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 140000 tokens. Please reduce the length of the messages.",
    "context_length_exceeded",
    "prompt is too long: 213000 tokens > 200000 maximum",
    "Input is too long for requested model.",
    "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
    "Context window exceeded",
    "Your input exceeds the context window of this model",
    "413 Request Entity Too Large",
    "Request failed with status code 413",
    "Payload too large",
    "上下文长度超出限制",
    "超出模型最大上下文",
    "输入内容过长",
    "对话太长，请开启新对话",
  ])("%s", (text) => {
    expect(kindOf(text)).toBe("context_overflow");
  });

  it("按分钟 token 限速（TPM）是限流、不是上下文超长", () => {
    expect(
      kindOf(
        "Request too large for gpt-4: tokens per min (TPM) Limit 10000, Requested 12000. 413",
      ),
    ).toBe("rate_limit");
  });
});

describe("classifyErrorText：额度 quota", () => {
  it.each([
    "You exceeded your current quota, please check your plan and billing details.",
    "429 You exceeded your current quota, please check your plan and billing details.",
    "insufficient_quota",
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    "402 Payment Required",
    "Request failed with status code 402",
    "You've hit your usage limit",
    "Billing hard limit has been reached",
    "Insufficient balance",
    "Quota exceeded for this project",
    "账户余额不足",
    "余额不足，请充值",
    "额度已用完",
    "您的账号已欠费",
  ])("%s", (text) => {
    expect(kindOf(text)).toBe("quota");
  });

  it("OpenAI 的余额不足也返 429：额度优先于限流", () => {
    expect(kindOf('429 {"error":{"code":"insufficient_quota"}}')).toBe("quota");
  });
});

describe("classifyErrorText：网络 network", () => {
  it.each([
    "fetch failed",
    "ECONNRESET",
    "read ECONNRESET",
    "connect ETIMEDOUT 1.2.3.4:443",
    "connect ECONNREFUSED 127.0.0.1:7890",
    "getaddrinfo ENOTFOUND api.openai.com",
    "socket hang up",
    "Network request failed",
    "Connection error.",
    "Connection reset by peer",
    "other side closed",
    "UND_ERR_SOCKET: other side closed",
    "Request timed out.",
    "timeout of 60000ms exceeded",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "504 Gateway Timeout",
    "HTTP 502",
    "The service is temporarily unavailable",
    "unable to verify the first certificate",
    "self-signed certificate in certificate chain",
    "[unavailable] Error",
    "[deadline_exceeded] Error",
    "The server had an error while processing your request",
    SDK_FIELDS('{ "code": 14 }'),
    SDK_FIELDS('{\n  "causeMessage": "getaddrinfo ENOTFOUND api.x.com"\n}'),
    "网络连接失败",
    "网络异常，请检查网络",
    "请求超时",
    "无法连接到服务器",
    "连接被重置",
  ])("%s", (text) => {
    expect(kindOf(text)).toBe("network");
  });
});

describe("classifyErrorText：误判反例 → unknown（保持原样展示）", () => {
  it.each([
    "",
    "   \n  ",
    "TypeError: Cannot read properties of undefined (reading 'replace')",
    "ENOENT: no such file or directory, open '/tmp/401.txt'",
    "src/api/429.ts:401:12 - error TS2322: Type 'string' is not assignable to type 'number'.",
    "listen EADDRINUSE: address already in use :::4290",
    "worktree 创建失败：fatal: 'feat/x' is already checked out at '/repo'",
    "git@gitlab.com: Permission denied (publickey).",
    "fatal: Authentication failed for 'https://gitlab.example.com/a/b.git/'",
    "remote: HTTP Basic: Access denied",
    "Disk quota exceeded",
    "EACCES: permission denied, mkdir '/root/x'",
    "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
    "EMFILE: too many open files, open 'x'",
    "jest: Exceeded timeout of 5000 ms for a test",
    "构建失败：测试用例 timeout 未通过",
    "MCP 服务器 foo 启动失败",
    "Connection to MCP server 'x' failed",
    "Failed to build context for the task",
    "max_tokens must be at most 8192",
    "Cannot find module './billing'",
    'The file "quota.ts" was changed',
    "credit card form validation failed",
    "agent run status=error",
    "构建过程请求多个仓库失败",
    "Please try again later",
    "Error: 404 page not found",
    "Port 4290 is busy; line 4030 col 40",
    "iterate over the limit of items",
  ])("%j", (text) => {
    const c = classifyErrorText(text);
    expect(c.kind).toBe("unknown");
    expect(c.title).toBe("");
    expect(c.hint).toBe("");
  });

  it("服务端已改写成友好中文的整句（连接断 / SDK 放弃本轮）不再二次归类——保持原文案", () => {
    const bare =
      "本轮异常结束——可能是长连接断开（等待太久 / 网络·代理中断 / 电脑休眠），也可能是 Cursor 额度·用量已用完。请先确认账号额度；额度正常多为连接断开、重新发起本轮通常可恢复。";
    const giveUp1 =
      "SDK 在断线续接时连续多次都没能继续（没有存下新进度），已放弃本轮。已生成的内容保留在上方，其中若有同一问题的多遍回答，请别混着看、以最后一个完整的版本为准；发一条消息即可接着继续。";
    const giveUp2 =
      "SDK 连续多次连接失败，已放弃本轮（网络或服务端不稳）。已生成的内容保留在上方；稍后发一条消息即可接着继续。";
    for (const t of [bare, giveUp1, giveUp2]) expect(kindOf(t)).toBe("unknown");
  });

  it("豁免的整句文案必须仍在服务端 sdk-error.ts 里（改了文案这里要跟着改，别悄悄失效）", () => {
    const sdkError = readSrc("lib", "server", "sdk-error.ts");
    expect(sdkError).toContain("本轮异常结束——可能是长连接断开");
    expect(sdkError).toContain("SDK 在断线续接时连续多次都没能继续");
    expect(sdkError).toContain("SDK 连续多次连接失败，已放弃本轮");
  });

  it("非字符串（坏事件缺 text）不抛、返回 unknown", () => {
    expect(
      classifyErrorText(undefined as unknown as string).kind,
    ).toBe("unknown");
    expect(classifyErrorText(null as unknown as string).kind).toBe("unknown");
  });

  it("超长诊断串（几十万字符）只扫开头一段：不卡、且只看头部的关键字", () => {
    const filler = "x".repeat(200_000);
    const t0 = Date.now();
    expect(kindOf(`fetch failed\n${filler}`)).toBe("network");
    // 关键字在 6000 字符之后 → 不看
    expect(kindOf(`${filler}\n429 Too Many Requests`)).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("文案卫生：业务口径、中文、不泄露协议词 / 英文原串", () => {
  const kinds: ErrorKind[] = [
    "rate_limit",
    "auth",
    "model_unavailable",
    "context_overflow",
    "quota",
    "network",
    "endpoint",
  ];
  const sample: Record<string, string> = {
    rate_limit: "429 Too Many Requests",
    auth: "401 Unauthorized",
    model_unavailable: "model_not_found",
    context_overflow: "context_length_exceeded",
    quota: "insufficient_quota",
    network: "ECONNRESET",
    endpoint: EMPTY_REPLY_MESSAGE,
  };

  it("每类都有非空 title / hint，且以中文为主", () => {
    for (const kind of kinds) {
      const c = classifyErrorText(sample[kind]!);
      expect(c.kind, kind).toBe(kind);
      expect(c.title.length, kind).toBeGreaterThan(2);
      expect(c.hint.length, kind).toBeGreaterThan(8);
      expect(/[\u4e00-\u9fa5]/.test(c.title), kind).toBe(true);
      expect(/[\u4e00-\u9fa5]/.test(c.hint), kind).toBe(true);
    }
  });

  it("不含内部协议词 / 状态码 / 英文单词（API Key 是设置页里的业务词、放行）", () => {
    for (const kind of kinds) {
      for (const mode of ["chat", "task"] as const) {
        const c = classifyErrorText(sample[kind]!, { mode });
        const plain = `${c.title}${c.hint}`.replace(/API Key/g, "");
        expect(plain, `${kind}/${mode}`).not.toMatch(/[A-Za-z]{2,}/);
        expect(plain, `${kind}/${mode}`).not.toMatch(/\d{3}/);
        expect(plain, `${kind}/${mode}`).not.toMatch(/SDK|gRPC|token|HTTP/i);
      }
    }
  });

  it("上下文超长：chat 的建议是开新对话 / 换模型；task 没有「开新对话」、只说换模型", () => {
    const chat = classifyErrorText("context_length_exceeded", { mode: "chat" });
    const task = classifyErrorText("context_length_exceeded", { mode: "task" });
    expect(chat.hint).toContain("新对话");
    expect(chat.hint).toContain("换一个");
    expect(task.hint).not.toContain("新对话");
    expect(task.hint).toContain("换一个");
    // 默认 mode = chat
    expect(classifyErrorText("context_length_exceeded").hint).toBe(chat.hint);
  });

  it("鉴权类的建议明说「不改直接重试仍会失败」（解释为什么重试被降级）", () => {
    expect(classifyErrorText("401 Unauthorized").hint).toMatch(/重试/);
    expect(classifyErrorText("401 Unauthorized").hint).toContain("设置");
  });
});

describe("planErrorActions：按类给入口 + 重试主次", () => {
  it("限流 / 网络 / 未知：重试保持主按钮，没有去设置 / 开新对话", () => {
    for (const kind of ["rate_limit", "network", "unknown"] as const) {
      expect(planErrorActions(kind, { mode: "chat" }), kind).toEqual({
        settings: null,
        newChat: false,
        retry: "primary",
      });
    }
  });

  it("鉴权 / 额度 / 模型不可用：主入口是「去设置」(模型栏、凭据在那)，重试降为次要（同模型同 key 必然再败，但改完 Key 回来要能直接点）", () => {
    for (const kind of ["auth", "quota", "model_unavailable"] as const) {
      for (const mode of ["chat", "task"] as const) {
        expect(planErrorActions(kind, { mode }), `${kind}/${mode}`).toEqual({
          settings: { focus: "model" },
          newChat: false,
          retry: "secondary",
        });
      }
    }
  });

  it("上下文超长：chat 给「开新对话」、task 不给；两边重试都降级（同上下文重试必败）", () => {
    expect(planErrorActions("context_overflow", { mode: "chat" })).toEqual({
      settings: null,
      newChat: true,
      retry: "secondary",
    });
    expect(planErrorActions("context_overflow", { mode: "task" })).toEqual({
      settings: null,
      newChat: false,
      retry: "secondary",
    });
  });
});

describe("buildErrorCardModel：卡片要画的几段", () => {
  it("未命中分类（unknown）：口径与旧版一致——正文原样；detail 与正文相同不单开详情", () => {
    const m = buildErrorCardModel("炸了", "炸了", { mode: "chat" });
    expect(m.classification.kind).toBe("unknown");
    expect(m.headline).toBe("炸了");
    expect(m.hint).toBe("");
    expect(m.diagnostic).toBe("");
    expect(m.copyText).toBe("炸了");
  });

  it("未命中分类、detail 与正文不同（连接断那种友好文案 + 原始串）：详情 = detail、复制带分隔标题", () => {
    const m = buildErrorCardModel("本轮异常结束", "agent run status=error\n原始", {
      mode: "chat",
    });
    expect(m.classification.kind).toBe("unknown");
    expect(m.headline).toBe("本轮异常结束");
    expect(m.diagnostic).toBe("agent run status=error\n原始");
    expect(m.copyText).toBe(
      `本轮异常结束\n\n${ERROR_DETAIL_HEADING}\nagent run status=error\n原始`,
    );
  });

  it("命中分类：正文换成中文标题 + 一句建议；英文原串放进「查看详情」（不再丢）", () => {
    const raw = "401 Incorrect API key provided: sk-abc***xyz.";
    const m = buildErrorCardModel(raw, raw, { mode: "chat" });
    expect(m.classification.kind).toBe("auth");
    expect(m.headline).toBe(m.classification.title);
    expect(m.hint).toBe(m.classification.hint);
    expect(m.headline).not.toContain("401");
    expect(m.diagnostic).toBe(raw);
  });

  it("命中分类时复制出去的是「标题 + 建议 + 分隔标题 + 原串」——贴给别人一眼分得清", () => {
    const raw = "429 Too Many Requests";
    const m = buildErrorCardModel(raw, raw, { mode: "chat" });
    expect(m.copyText).toBe(
      `${m.headline}\n${m.hint}\n\n${ERROR_DETAIL_HEADING}\n${raw}`,
    );
    expect(m.copyText).toContain(raw);
  });

  it("命中分类、正文与 detail 不同：详情里两段都在，且不重复（detail 已包含正文时只留 detail）", () => {
    const m1 = buildErrorCardModel("Rate limit reached", "Rate limit reached\n--- SDK error fields ---\n{}", {
      mode: "chat",
    });
    expect(m1.classification.kind).toBe("rate_limit");
    expect(m1.diagnostic).toBe("Rate limit reached\n--- SDK error fields ---\n{}");

    const m2 = buildErrorCardModel("Rate limit reached", "上游返回：429", { mode: "chat" });
    expect(m2.diagnostic).toBe("Rate limit reached\n\n上游返回：429");
  });

  it("正文没有关键字、detail 里有（如连接断友好文案 + 原始串带状态码）→ 按 detail 分类", () => {
    const m = buildErrorCardModel("本轮没能完成", "agent run failed\n--- SDK error fields ---\n{ \"code\": 16 }", {
      mode: "chat",
    });
    expect(m.classification.kind).toBe("auth");
    // 正文换成标题后，原来的友好句子也要留在详情里
    expect(m.diagnostic).toContain("本轮没能完成");
    expect(m.diagnostic).toContain('"code": 16');
  });

  it("task 形态把 mode 带进分类（上下文超长的建议不同）", () => {
    const chat = buildErrorCardModel("context_length_exceeded", "", { mode: "chat" });
    const task = buildErrorCardModel("context_length_exceeded", "", { mode: "task" });
    expect(chat.hint).toContain("新对话");
    expect(task.hint).not.toContain("新对话");
  });
});

describe("接线源码契约", () => {
  const card = readSrc("components", "tasks", "event-stream", "error-card.tsx");
  const rows = readSrc("components", "tasks", "event-stream", "rows.tsx");
  const lib = readSrc("lib", "error-classify.ts");

  it("错误卡走 buildErrorCardModel；hasDetail 由模型的 diagnostic 决定（原串在「查看详情」里）", () => {
    expect(card).toContain("buildErrorCardModel(");
    expect(card).toMatch(/const hasDetail = model\.diagnostic !== ""/);
    expect(card).toContain("model.diagnostic");
    // 分隔标题只有一份（在 lib 里），卡片不再自己定义
    expect(card).not.toContain("const DETAIL_HEADING");
  });

  it("「去设置」走 settingsUrl（不手拼 /settings），focus 来自动作规划", () => {
    expect(card).toContain('from "@/lib/settings-link"');
    expect(card).toMatch(/settingsUrl\(plan\.settings\.focus\)/);
    expect(card).not.toMatch(/["'`]\/settings\?focus=/);
  });

  it("「开新对话」复用现成的 useNewChat（建空草稿 / 复用未用草稿），成功后同 /chats 落点页一样 push 到详情；只在 chat 且需要时渲染", () => {
    expect(card).toContain("useNewChat(");
    expect(card).toContain("createChat(");
    expect(card).toMatch(/router\.push\(`\/tasks\/\$\{task\.id\}`\)/);
    expect(card).toMatch(/plan\.newChat && isCurrent/);
    // hook 只在子组件里调用：所有错误卡不都去订阅任务列表
    const top = card.slice(0, card.indexOf("const NewChatButton"));
    expect(top).not.toContain("useNewChat(");
  });

  it("重试 / 重新推进的视觉权重由规划决定：次要 = outline、主要 = destructive；原有恢复回调不变", () => {
    expect(card).toMatch(/plan\.retry === "primary"/);
    expect(card).toContain('"destructive" : "outline"');
    expect(card).toContain("onRetryLastMessage?.(retrySource)");
    expect(card).toContain("onReadvance");
    expect(card).toContain("重新推进");
  });

  it("恢复类入口（去设置 / 开新对话 / 重试）只给「当轮失败」；历史错误卡不加", () => {
    expect(card).toMatch(/plan\.settings && isCurrent/);
    expect(card).toMatch(/plan\.newChat && isCurrent/);
    expect(card).toContain("canRetry");
  });

  it("命中分类时正文 = 中文标题 + 一行建议（12px muted，不靠透明度）；未命中保持原 pre-wrap 正文", () => {
    expect(card).toContain("model.headline");
    expect(card).toContain("model.hint");
    expect(card).toMatch(/text-xs[^"]*text-muted-foreground/);
    expect(card).toContain("whitespace-pre-wrap");
    expect(card).not.toMatch(/opacity-\d/);
    expect(card).not.toMatch(/text-muted-foreground\/\d/);
  });

  it("UI 规范：不用原生 title=、不加 role=alert / aria-live（虚拟列表重挂会反复播报）", () => {
    expect(card).not.toMatch(/\stitle=/);
    expect(card).not.toContain('role="alert"');
    expect(card).not.toContain("aria-live");
  });

  it("rows.tsx 把 chat / log 形态与仓库路径传给错误卡（开新对话要带上当前工作目录）", () => {
    const at = rows.slice(rows.indexOf("<ErrorCard"));
    const block = at.slice(0, at.indexOf("/>"));
    expect(block).toMatch(/mode=\{variant === "chat" \? "chat" : "task"\}/);
    expect(block).toContain("repoPaths={task.repoPaths}");
  });

  it("lib 是纯函数：不 import React / 不碰 DOM / 不 import settings-link.tsx（测试只能 import .ts）", () => {
    expect(lib).not.toMatch(/from "react"/);
    expect(lib).not.toMatch(/\bdocument\.|\bwindow\.|\bnavigator\./);
    expect(lib).not.toContain("settings-link");
  });
});

/**
 * R14 Q11-01（P1-3）：自定义端点「回了东西、但不是模型回复」两种症状归一个 endpoint 类——
 * 空响应（pi-run-settle.EMPTY_REPLY_MESSAGE，我们自己写的固定句）/ 回了网页（地址填成网页、网关登录页）。
 * 原先网页落 unknown，红卡只摆一段 HTML 原文，用户不知道该去设置里检查接口地址；空响应原本根本不报错。
 *
 * 口径：只增不改——空响应是自家固定句、最先判；网页排在所有既有类之后，只吃原本落 unknown 的，
 * 所以带状态码 / 网络特征词的网关页仍按原来的类走。
 * `terminated`（undici 的流被对端中途掐断）不在此列：它是瞬时网络问题，归 network（评审意见 F2，见下一个 describe）。
 */
/** chat-runner / task-runner 实际拼出来的整串：result 只留前 200 字符，后面接 SDK result dump */
const runnerWrapped = (result: string): string =>
  `agent run status=error: ${result.slice(0, 200)}\n--- SDK result dump ---\n{"status":"error"}`;

describe("classifyErrorText：端点 endpoint（空响应 / 回了网页）", () => {
  it("空回复文案：单独一句 / runner 拼过的整串 / 带各路径前缀 → endpoint（不带 ^ 锚点）", () => {
    expect(kindOf(EMPTY_REPLY_MESSAGE)).toBe("endpoint");
    expect(kindOf(runnerWrapped(EMPTY_REPLY_MESSAGE))).toBe("endpoint");
    for (const prefix of [
      "答疑失败：",
      "群答疑失败：",
      "Task agent 失败：",
      "Chat agent 异常：",
      "唤醒当前阶段失败：",
      "  答疑失败：",
    ]) {
      expect(kindOf(`${prefix}${EMPTY_REPLY_MESSAGE}`), prefix).toBe("endpoint");
    }
  });

  it.each([
    "<html><body>gateway login</body></html>",
    '<!DOCTYPE html>\n<html lang="en"><head><title>Login</title></head></html>',
    "404 <!DOCTYPE html><html><head><title>404 Not Found</title></head></html>",
    "500 <html>500 Internal Server Error</html>",
    "Unexpected response from provider: <HTML>\n<HEAD><TITLE>Error</TITLE></HEAD>",
    "<!doctype  HTML>",
    runnerWrapped("500 <html>500</html>"),
  ])("端点回了网页（地址填成网页 / 网关登录页 / 错误页）→ endpoint：%j", (text) => {
    expect(kindOf(text)).toBe("endpoint");
  });

  it("只增不改：带状态码 / 网络特征词的网关页仍按原来的类走，endpoint 只吃原本落 unknown 的", () => {
    const page = "<html><body>x</body></html>";
    expect(kindOf(`502 Bad Gateway\n${page}`)).toBe("network");
    expect(kindOf(`503 Service Unavailable\n${page}`)).toBe("network");
    expect(kindOf(`504 Gateway Timeout\n${page}`)).toBe("network");
    expect(kindOf(`401 Unauthorized\n${page}`)).toBe("auth");
    expect(kindOf(`403 Forbidden\n${page}`)).toBe("auth");
    expect(kindOf(`429 Too Many Requests\n${page}`)).toBe("rate_limit");
    expect(kindOf(`402 Payment Required\n${page}`)).toBe("quota");
    expect(kindOf(`413 Payload Too Large\n${page}`)).toBe("context_overflow");
  });

  it.each([
    "<htmlx>oops</htmlx>",
    "render <HtmlProps> failed",
    "see https://example.com/index.html for details",
    "<div>hello</div>",
    "<!DOCTYPE>",
  ])("不是端点异常、保持原样展示（unknown）：%j", (text) => {
    expect(kindOf(text)).toBe("unknown");
  });

  it("JSON 解析错误（Unexpected token '<'）仍 unknown：它没带出 HTML 文档标记，不能拿来断言「端点回了网页」", () => {
    expect(kindOf("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")).toBe("unknown");
  });

  it("只扫开头 6000 字符（与其它类同口径）：靠后的 HTML 不看；开头的 HTML 后面跟几十万字符也不卡", () => {
    const filler = "x".repeat(200_000);
    expect(kindOf(`${filler}\n<html>x</html>`)).toBe("unknown");
    const t0 = Date.now();
    expect(kindOf(`<html>x</html>\n${filler}`)).toBe("endpoint");
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("文案：标题 / 建议点名「接口地址」，提示去设置检查（原串在详情里）", () => {
    const c = classifyErrorText(EMPTY_REPLY_MESSAGE);
    expect(c.kind).toBe("endpoint");
    expect(c.title).toContain("没有返回正常内容");
    expect(c.hint).toContain("接口地址");
    expect(c.hint).toContain("设置");
  });

  it("planErrorActions：去设置（模型栏）+ 重试降为次要，chat / task 一样（同一个坏地址重试多半还是空）", () => {
    // 与 terminated（network 类、重试是主按钮）的对照见下一个 describe
    for (const mode of ["chat", "task"] as const) {
      expect(planErrorActions("endpoint", { mode }), mode).toEqual({
        settings: { focus: "model" },
        newChat: false,
        retry: "secondary",
      });
    }
  });

  it("buildErrorCardModel：命中 endpoint → 正文换成标题 + 建议；原串（含网页全文）进「查看详情」和复制串", () => {
    const raw = "500 <html>500 Internal Server Error</html>";
    const m = buildErrorCardModel(raw, "", { mode: "chat" });
    expect(m.classification.kind).toBe("endpoint");
    expect(m.headline).toBe(m.classification.title);
    expect(m.hint).toBe(m.classification.hint);
    expect(m.diagnostic).toBe(raw);
    expect(m.copyText).toBe(
      `${m.headline}\n${m.hint}\n\n${ERROR_DETAIL_HEADING}\n${raw}`,
    );
  });

  it("文案出处：EMPTY_REPLY_MESSAGE 以「模型没有返回任何内容」开头，error-classify.ts 认的是同一句（改一边要跟着改另一边）", () => {
    expect(EMPTY_REPLY_MESSAGE.startsWith("模型没有返回任何内容")).toBe(true);
    expect(readSrc("lib", "error-classify.ts")).toContain("模型没有返回任何内容");
    expect(readSrc("lib", "pi-run-settle.ts")).toContain("模型没有返回任何内容");
  });
});

/**
 * R14 Q11-01 评审意见 F2：undici 的 `TypeError: terminated`（响应体读到一半被对端关掉）归 network，不归 endpoint。
 * 它是瞬时网络问题（网关空闲超时 / 后端重启 / 代理不支持流式），「重试」该是主按钮；
 * 放进 endpoint 会把「去设置」顶成主按钮、还让人去查接口地址和模型名，对一次偶发断流是误导。
 * 同时消掉一个不自洽：同一次故障，带 `other side closed` 的 cause 时本来就是 network，
 * cause 没带出来时不能落成另一种卡。
 */
describe("classifyErrorText：terminated（流被对端中途掐断）→ network，重试是主按钮", () => {
  it.each([
    "terminated",
    "TypeError: terminated",
    "Error: terminated",
    "Provider error: terminated",
    "答疑失败：terminated",
    "  terminated  ",
    "agent run status=error: terminated",
    runnerWrapped("terminated"),
  ])("单独一个 terminated（cause 没带出来）→ network：%j", (text) => {
    expect(kindOf(text)).toBe("network");
  });

  it("同一次故障带不带 cause 归同一类：cause 里有 other side closed 时仍是 network", () => {
    expect(kindOf("TypeError: terminated\n  [cause]: Error: other side closed")).toBe("network");
    expect(kindOf("TypeError: terminated")).toBe("network");
  });

  it("只增不改：限流 / 鉴权 / 额度等排在前面的类先判，terminated 只吃它们没命中的", () => {
    expect(kindOf("401 Unauthorized\nTypeError: terminated")).toBe("auth");
    expect(kindOf("429 Too Many Requests\nTypeError: terminated")).toBe("rate_limit");
    expect(kindOf("insufficient_quota\nTypeError: terminated")).toBe("quota");
  });

  it.each([
    "process terminated by signal SIGKILL",
    "Task terminated by user",
    "The session was terminated",
    "Build terminated",
    "terminated: false",
    "子进程 terminated 了",
  ])("不是流被掐断（后面还有内容 / 前面不是行首或冒号）→ 保持原样展示（unknown）：%j", (text) => {
    expect(kindOf(text)).toBe("unknown");
  });

  it("只扫开头 6000 字符（与其它类同口径）：靠后的 terminated 不看", () => {
    expect(kindOf(`${"x".repeat(200_000)}\nTypeError: terminated`)).toBe("unknown");
  });

  it("对抗输入不卡（正则没有回溯爆炸）：大量冒号 / 空白 / 空行 / 重复词，全部 unknown 且合计 < 500ms", () => {
    const evil = [
      ":".repeat(6000),
      ": ".repeat(3000),
      `${" ".repeat(6000)}x`,
      "\n \t".repeat(2000),
      "terminated ".repeat(600),
      `:${" ".repeat(5900)}terminatedX`,
    ];
    const t0 = Date.now();
    for (const text of evil) expect(kindOf(text)).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("卡片：给的是网络类的说明、不把一次偶发断流说成地址 / 模型名填错；不给「去设置」、重试是主按钮（chat / task 一样）", () => {
    const c = classifyErrorText("TypeError: terminated");
    expect(c.kind).toBe("network");
    expect(c.hint).toContain("网络");
    expect(c.hint).not.toContain("接口地址");
    for (const mode of ["chat", "task"] as const) {
      expect(planErrorActions(c.kind, { mode }), mode).toEqual({
        settings: null,
        newChat: false,
        retry: "primary",
      });
    }
    const m = buildErrorCardModel(runnerWrapped("TypeError: terminated"), "", { mode: "task" });
    expect(m.classification.kind).toBe("network");
    expect(m.headline).toBe(m.classification.title);
  });

  it("endpoint 的说明里不再提「连接被掐断」：那种情况归 network", () => {
    expect(classifyErrorText(EMPTY_REPLY_MESSAGE).hint).not.toContain("掐断");
  });
});
