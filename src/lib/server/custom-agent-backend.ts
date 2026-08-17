/**
 * custom provider 的 pi 后端适配器（把 pi 的 AgentSession 适配成 @cursor/sdk 的形状）
 *
 * 契约（被 agent-backend.ts 调用）：`createCustomAgent` / `resumeCustomAgent` /
 * `promptOnceCustom` 返回的对象按 cursor SDK 的 Agent / Run 形状（agentId / send /
 * close；run.cancel / stream / wait / id / requestId）暴露。下游
 * sdk-message-handler / run-perf / shell-output-bridge 只认这些形状、无需改动。
 *
 * 事件适配（pi AgentSessionEvent → cursor SDKMessage + InteractionUpdate）：
 *   - text_delta          → SDKMessage assistant（text 块）+ onDelta text-delta
 *   - thinking_delta      → SDKMessage thinking
 *   - toolcall_end        → SDKMessage tool_call running + onDelta tool-call-started
 *   - tool_execution_end  → SDKMessage tool_call completed/error + onDelta tool-call-completed
 *   - bash_execution_update → onDelta shell-output-delta（归到最近 bash callId）
 *   - agent_settled       → run 结束（wait 返回 finished/cancelled）
 *
 * 已知能力差（vs cursor SDK，见 docs/pi-api-spec.md）：
 *   - pi 无 MCP：用户 MCP（飞书/context7）与 flowshipChat（ask_user/submit_work 等）
 *     暂未桥接进来——后续作为 pi 的 customTools 直连（见 AGENTS/交付说明）。
 *   - pi 无 task 子 agent 工具、无 delete 工具（内置 read/bash/edit/write/grep/find/ls）。
 */

import path from "node:path";
import type {
  ConversationStep,
  InteractionUpdate,
  SDKMessage,
} from "@cursor/sdk";
import {
  ModelRuntime,
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import { dataRoot } from "./data-root";
import { flowShipTools } from "./flowship-tools";
import { buildCodingToolDefs } from "./pi-coding-tools";

const PROVIDER_ID = "flowship-custom";
// pi 原生里名字跟规范面一致的内置工具（read/grep/edit/write）；
// bash→shell、find→glob、delete/task 由 buildCodingToolDefs 补成 customTools
const NATIVE_TOOLS = ["read", "edit", "write", "grep"];
// 子 agent 用 pi 原生全套（读/写/跑命令），不带 task / flowshipChat 工具——防递归与副作用
const SUBAGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
// 自定义端点元数据缺省（用户 endpoint 不提供时给合理兜底）
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

// pi 的 agent 配置 / 会话文件都收进 app 数据目录、不污染 ~/.pi、也不和用户装的 pi 撞车
const piAgentDir = (): string => path.join(dataRoot(), "pi-agent");
const piSessionDir = (): string => path.join(dataRoot(), "pi-sessions");

type Format = "openai" | "anthropic";
const apiOf = (format: Format): "openai-completions" | "anthropic-messages" =>
  format === "anthropic" ? "anthropic-messages" : "openai-completions";

export interface CustomAgentInput {
  kind: "custom";
  apiKey: string;
  baseUrl: string;
  format: Format;
  model?: { id: string; params?: Array<{ id: string; value: string }> };
  local?: { cwd?: string; settingSources?: unknown };
  // cursor 形状里带 mcpServers；pi 无 MCP、这里接收但忽略
  mcpServers?: unknown;
}

/** ProviderConfigInput.models 条目的最小结构（registerProvider 会做结构校验） */
interface ModelConfigEntry {
  id: string;
  name: string;
  api: "openai-completions" | "anthropic-messages";
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: {
    supportsUsageInStreaming: boolean;
    maxTokensField: "max_tokens" | "max_completion_tokens";
  };
}

type SendOptions = {
  onDelta?: (args: { update: InteractionUpdate }) => void;
  onStep?: (args: { step: ConversationStep }) => void;
};

// ----------------- Model / runtime 构造 -----------------

/** 把用户选/填的 model id 构造成 pi 的 ProviderConfigInput.models 条目 */
const buildModelConfig = (modelId: string, format: Format): ModelConfigEntry => {
  const entry: ModelConfigEntry = {
    id: modelId,
    name: modelId,
    api: apiOf(format),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
  if (format === "openai") {
    // 自建 OpenAI 兼容端点建议显式 compat、避免按 baseUrl 探测失败
    entry.compat = {
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    };
  }
  return entry;
};

/** 直接构造 Model 实例（provider/baseUrl/api 齐、runtime 里也注册同款 provider） */
const buildModel = (modelId: string, input: CustomAgentInput): Model<never> => {
  const model = {
    id: modelId,
    name: modelId,
    api: apiOf(input.format),
    provider: PROVIDER_ID,
    baseUrl: input.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  } as unknown as Model<never>;
  if (input.format === "openai") {
    (model as unknown as { compat?: unknown }).compat = {
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    };
  }
  return model;
};

/** 每次会话起一个独立 runtime + 注册 provider + 构造 Model */
const buildRuntime = async (
  input: CustomAgentInput,
): Promise<{ runtime: Awaited<ReturnType<typeof ModelRuntime.create>>; model: Model<never> }> => {
  const modelId = input.model?.id?.trim() || "default";
  const runtime = await ModelRuntime.create({ modelsPath: null });
  // 注册 provider 让 runtime 能解析 apiKey + api 流实现；model 直接构造引用同 provider
  runtime.registerProvider(PROVIDER_ID, {
    name: "Custom",
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    api: apiOf(input.format),
    models: [buildModelConfig(modelId, input.format)],
  });
  return { runtime, model: buildModel(modelId, input) };
};

// ----------------- Flowship 自有工具桥接（pi customTools） -----------------

/**
 * 从 cursor 形状的 mcpServers 里解 flowshipChat 的 caller token。
 * runner（chat-runner / task-runner）总是把 flowshipChat MCP 塞进 mcpServers、
 * pi 不用 MCP、但借它 URL 里的 `?caller=` 身份给工具 handler 核对（同 MCP 路径口径）。
 */
const extractCallerToken = (mcpServers: unknown): string | undefined => {
  if (!mcpServers || typeof mcpServers !== "object") return undefined;
  const flowshipChat = (mcpServers as Record<string, unknown>).flowshipChat;
  if (!flowshipChat || typeof flowshipChat !== "object") return undefined;
  const url = (flowshipChat as { url?: unknown }).url;
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).searchParams.get("caller") ?? undefined;
  } catch {
    return undefined;
  }
};

/** 进程内嵌套子会话：给 task 工具用——起一个只带编码工具的子 agent、跑完返最终文本 */
const runSubagent = async (
  prompt: string,
  opts: {
    runtime: Awaited<ReturnType<typeof ModelRuntime.create>>;
    model: Model<never>;
    cwd: string;
  },
): Promise<string> => {
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: piAgentDir(),
    modelRuntime: opts.runtime,
    model: opts.model,
    tools: [...SUBAGENT_TOOLS],
    // 子 agent 不落会话文件（一次性）
    sessionManager: SessionManager.inMemory(opts.cwd),
  });
  try {
    let result = "";
    await new Promise<void>((resolve) => {
      const unsub = session.subscribe((ev) => {
        if (ev.type === "message_update") {
          const inner = ev.assistantMessageEvent;
          if (inner?.type === "text_delta" && inner.delta) result += inner.delta;
        } else if (ev.type === "agent_settled") {
          unsub();
          resolve();
        }
      });
      void session.prompt(prompt).catch(() => {
        unsub();
        resolve();
      });
    });
    return result.trim();
  } finally {
    try {
      session.dispose();
    } catch {
      /* noop */
    }
  }
};

/**
 * Flowship 自有工具 + 规范编码工具 → pi ToolDefinition[]。
 * 编码工具（shell/glob/delete/task）由 buildCodingToolDefs 提供、task 的 runSubagent 闭包绑好 runtime/model/cwd。
 */
const buildCustomTools = (
  callerToken: string | undefined,
  cwd: string,
  subagentRuntime: Awaited<ReturnType<typeof ModelRuntime.create>>,
  subagentModel: Model<never>,
): ToolDefinition[] => [
  ...flowShipTools.map(
    (t) =>
      ({
        name: t.name,
        label: t.label,
        description: t.description,
        parameters: t.parameters,
        execute: async (_toolCallId: string, params: unknown) => {
          const r = await t.handler(params as Record<string, unknown>, callerToken);
          return { content: r.content, details: undefined };
        },
      }) as unknown as ToolDefinition,
  ),
  ...buildCodingToolDefs(cwd, (prompt) =>
    runSubagent(prompt, { runtime: subagentRuntime, model: subagentModel, cwd }),
  ),
];

// ----------------- run 适配器 -----------------

type RunWaitResult = { status: "finished" | "cancelled" | "error"; result?: string };

class PiRunAdapter {
  id: string;
  requestId: string;
  private buffer: SDKMessage[] = [];
  private toolArgs = new Map<string, { name: string; args: unknown }>();
  private ended = false;
  private cancelled = false;
  private endResolve: ((r: RunWaitResult) => void) | null = null;
  private endPromise: Promise<RunWaitResult>;
  private unsub: (() => void) | null = null;
  private onDelta?: SendOptions["onDelta"];
  private onStep?: SendOptions["onStep"];

  constructor(
    private session: AgentSession,
    opts: SendOptions,
  ) {
    this.id = `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.requestId = this.id;
    this.onDelta = opts.onDelta;
    this.onStep = opts.onStep;
    this.endPromise = new Promise<RunWaitResult>((resolve) => {
      this.endResolve = resolve;
    });
  }

  /** subscribe 后由 createCustomAgent 绑定 */
  bindUnsubscribe(fn: () => void): void {
    this.unsub = fn;
  }

  private push(msg: SDKMessage): void {
    if (this.ended) return;
    this.buffer.push(msg);
  }

  private fireDelta(update: InteractionUpdate): void {
    try {
      this.onDelta?.({ update });
    } catch {
      /* 埋点/桥接不能拖垮主流程 */
    }
  }

  private fireStep(step: ConversationStep): void {
    try {
      this.onStep?.({ step });
    } catch {
      /* noop */
    }
  }

  private settle(result: RunWaitResult): void {
    if (this.ended) return;
    this.ended = true;
    this.endResolve?.(result);
  }

  onEvent(ev: AgentSessionEvent): void {
    try {
      switch (ev.type) {
        case "message_update": {
          const inner = ev.assistantMessageEvent;
          if (!inner) break;
          if (inner.type === "text_delta" && inner.delta) {
            this.push({
              type: "assistant",
              message: { content: [{ type: "text", text: inner.delta }] },
            } as unknown as SDKMessage);
          } else if (inner.type === "thinking_delta" && inner.delta) {
            this.push({ type: "thinking", text: inner.delta } as unknown as SDKMessage);
          } else if (inner.type === "toolcall_end" && inner.toolCall) {
            const tc = inner.toolCall;
            this.toolArgs.set(tc.id, { name: tc.name, args: tc.arguments });
            // 工具开始：SDKMessage running + onDelta tool-call-started
            this.push({
              type: "tool_call",
              call_id: tc.id,
              name: tc.name,
              args: tc.arguments,
              status: "running",
            } as unknown as SDKMessage);
            this.fireDelta({
              type: "tool-call-started",
              callId: tc.id,
              toolCall: {
                type: tc.name === "bash" ? "shell" : tc.name,
                args: { toolName: tc.name },
              },
            } as unknown as InteractionUpdate);
          }
          break;
        }
        case "tool_execution_end": {
          const cached = this.toolArgs.get(ev.toolCallId) ?? {
            name: ev.toolName,
            args: {},
          };
          this.push({
            type: "tool_call",
            call_id: ev.toolCallId,
            name: ev.toolName,
            args: cached.args,
            status: ev.isError ? "error" : "completed",
            result: ev.result,
          } as unknown as SDKMessage);
          this.fireDelta({
            type: "tool-call-completed",
            callId: ev.toolCallId,
            toolCall: {
              type: ev.toolName === "bash" ? "shell" : ev.toolName,
              result: {
                status: ev.isError ? "error" : "success",
                value: typeof ev.result === "object" ? ev.result : { output: ev.result },
              },
            },
          } as unknown as InteractionUpdate);
          break;
        }
        case "bash_execution_update": {
          if (typeof ev.delta === "string" && ev.delta.length > 0) {
            this.fireDelta({
              type: "shell-output-delta",
              event: { case: "stdout", value: { data: ev.delta } },
            } as unknown as InteractionUpdate);
          }
          break;
        }
        case "agent_settled": {
          this.settle({
            status: this.cancelled ? "cancelled" : "finished",
          });
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.warn("[custom-agent-backend] onEvent 翻译失败", err);
    }
  }

  onPromptError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.settle({ status: "error", result: message });
  }

  cancel(): Promise<void> {
    this.cancelled = true;
    return Promise.resolve(this.session.abort()).catch(() => {});
  }

  async *stream(): AsyncIterable<SDKMessage> {
    let i = 0;
    for (;;) {
      if (i < this.buffer.length) {
        yield this.buffer[i++];
        continue;
      }
      if (this.ended) return;
      // 等新消息或结束（低频轮询——cursor SDK 侧用真正的流、这里用微轮询兜底，
      // 16ms 一 tick 对事件吞吐足够且实现简单可靠）
      await new Promise((r) => setTimeout(r, 16));
    }
  }

  wait(): Promise<RunWaitResult> {
    return this.endPromise;
  }
}

// ----------------- Agent 适配器 -----------------

interface PiAgentAdapter {
  agentId: string;
  send(prompt: string, opts: SendOptions): Promise<PiRunAdapter>;
  close(): void;
}

/** create / resume 共用：起 AgentSession + 包成 adapter */
const buildAdapter = async (
  session: AgentSession,
  agentId: string,
): Promise<PiAgentAdapter> => {
  return {
    agentId,
    send(prompt: string, opts: SendOptions): Promise<PiRunAdapter> {
      const run = new PiRunAdapter(session, opts);
      const unsub = session.subscribe((ev) => run.onEvent(ev));
      run.bindUnsubscribe(unsub);
      // fire-and-forget 触发回合；错误走 onPromptError → wait 返回 error
      void session.prompt(prompt).catch((err) => run.onPromptError(err));
      return Promise.resolve(run);
    },
    close(): void {
      try {
        session.dispose();
      } catch {
        /* noop */
      }
    },
  };
};

export const createCustomAgent = async (
  input: CustomAgentInput,
): Promise<PiAgentAdapter> => {
  const cwd = input.local?.cwd || process.cwd();
  const { runtime, model } = await buildRuntime(input);
  const callerToken = extractCallerToken(input.mcpServers);
  const { session } = await createAgentSession({
    cwd,
    agentDir: piAgentDir(),
    modelRuntime: runtime,
    model,
    tools: [...NATIVE_TOOLS],
    customTools: buildCustomTools(callerToken, cwd, runtime, model),
    sessionManager: SessionManager.create(cwd, piSessionDir()),
  });
  const agentId = session.sessionFile ?? session.sessionId;
  return buildAdapter(session, agentId);
};

export const resumeCustomAgent = async (
  agentId: string,
  input: CustomAgentInput,
): Promise<PiAgentAdapter> => {
  const cwd = input.local?.cwd || process.cwd();
  const { runtime, model } = await buildRuntime(input);
  const callerToken = extractCallerToken(input.mcpServers);
  // agentId 存的是上次的 sessionFile 路径 → SessionManager.open 续接；
  // 打开失败（文件被清 / 不兼容）会抛、由调用方按 cursor 的 resume 失败口径降级新会话。
  const sessionManager = SessionManager.open(agentId, piSessionDir(), cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir: piAgentDir(),
    modelRuntime: runtime,
    model,
    tools: [...NATIVE_TOOLS],
    customTools: buildCustomTools(callerToken, cwd, runtime, model),
    sessionManager,
  });
  return buildAdapter(session, agentId);
};

/** chat 标题生成用的一次性 prompt（对应 cursor Agent.prompt） */
export const promptOnceCustom = async (
  prompt: string,
  input: CustomAgentInput,
): Promise<{ result: string }> => {
  const cwd = input.local?.cwd || process.cwd();
  const { runtime, model } = await buildRuntime(input);
  const { session } = await createAgentSession({
    cwd,
    agentDir: piAgentDir(),
    modelRuntime: runtime,
    model,
    noTools: "all",
    // 一次性标题生成：不落会话文件
    sessionManager: SessionManager.inMemory(cwd),
  });
  try {
    let result = "";
    await new Promise<void>((resolve) => {
      const unsub = session.subscribe((ev) => {
        if (ev.type === "message_update") {
          const inner = ev.assistantMessageEvent;
          if (inner?.type === "text_delta" && inner.delta) result += inner.delta;
        } else if (ev.type === "agent_settled") {
          unsub();
          resolve();
        }
      });
      void session.prompt(prompt).catch(() => {
        unsub();
        resolve();
      });
    });
    return { result };
  } finally {
    try {
      session.dispose();
    } catch {
      /* noop */
    }
  }
};
