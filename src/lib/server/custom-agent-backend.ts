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
 *   - assistant stopReason=error → wait 返回 error（pi 不抛，写在会话消息里；
 *     缺 finish_reason 的残缺收尾除外，当 finished）
 *
 * MCP 已桥成 customTools（`mcp-tool-bridge.ts`）；子 agent 用进程内嵌套会话。
 */

import path from "node:path";
import type {
  ConversationStep,
  InteractionUpdate,
  McpServerConfig,
  SDKMessage,
} from "@cursor/sdk";
import {
  ModelRuntime,
  DefaultResourceLoader,
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import {
  OPENAI_STREAM_COMPAT,
  fatalAssistantError,
} from "@/lib/custom-openai-compat";
import {
  settleErrorFromTranscript,
  stickyErrorAfterMessageEnd,
} from "@/lib/pi-run-settle";
import {
  reasoningFieldsFromCatalog,
  thinkingLevelFromParams,
  type ThinkingLevelMap,
} from "@/lib/custom-effort";
import { customSdkBaseUrlForFace } from "@/lib/custom-provider-url";
import type { CustomProviderFormat } from "@/lib/types";
import { resolveModelFace, type CustomFace } from "@/lib/server/custom-route";
import {
  getModelsDevIndex,
  lookupCatalogReasoning,
} from "@/lib/server/models-dev-catalog";
import { mcpDisplayName } from "@/lib/mcp-tool-name";

import { dataRoot } from "./data-root";
import { flowShipTools } from "./flowship-tools";
import { connectMcpServer, type BridgedMcpServer } from "./mcp-tool-bridge";
import { buildCodingToolDefs, buildNativeToolAliasWrappers } from "./pi-coding-tools";
import { loadSkillsForTask } from "./skills-loader";
import { injectSdkRgPath } from "./sdk-platform-bin";

const PROVIDER_ID = "flowship-custom";
// pi 原生里名字跟规范面一致的内置工具（read/grep/edit/write）；
// bash→shell、find→glob、delete/task 由 buildCodingToolDefs 补成 customTools。
// write/edit/read 另有同名 custom 包装（认 Cursor 字段别名、盖掉 builtin）。
const NATIVE_TOOLS = ["read", "edit", "write", "grep"];
// 子 agent 用 pi 原生全套（读/写/跑命令），不带 task / flowshipChat 工具——防递归与副作用
const SUBAGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
// 自定义端点元数据缺省（用户 endpoint 不提供时给合理兜底）
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

// pi 的 agent 配置 / 会话文件都收进 app 数据目录、不污染 ~/.pi、也不和用户装的 pi 撞车
const piAgentDir = (): string => path.join(dataRoot(), "pi-agent");

/**
 * 统一 skill 注入管道：fe 自管 loader（skills-loader.ts，含 agentskills 标准目录）
 * 是唯一来源；pi 自带发现只作兜底——与 loader 同名的滤掉，防 pi 的
 * <available_skills> 块和 fe 的「## Skills」段双渲染 / 版本漂移。
 */
const buildResourceLoader = async (cwd: string) => {
  const owned = new Set(
    (await loadSkillsForTask([cwd]).catch(() => [])).map((s) => s.name),
  );
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: piAgentDir(),
    skillsOverride: (base) => ({
      skills: base.skills.filter((s) => !owned.has(s.name)),
      diagnostics: base.diagnostics,
    }),
  });
  await loader.reload();
  return loader;
};
const piSessionDir = (): string => path.join(dataRoot(), "pi-sessions");

// 协议来源：显式 override（openai / anthropic）或 auto（models.dev 目录按模型路由，
// 见 custom-route.ts）。会话启动时统一收敛成 pi 的请求面（CustomFace）。
type Format = CustomProviderFormat;

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
  api: CustomFace;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: {
    supportsUsageInStreaming: boolean;
    supportsFinishReason: boolean;
    maxTokensField: "max_tokens" | "max_completion_tokens";
  };
}

type SendOptions = {
  onDelta?: (args: { update: InteractionUpdate }) => void;
  onStep?: (args: { step: ConversationStep }) => void;
};

// ----------------- Model / runtime 构造 -----------------

type CatalogFields = ReturnType<typeof reasoningFieldsFromCatalog>;

/** 把用户选/填的 model id 构造成 pi 的 ProviderConfigInput.models 条目 */
const buildModelConfig = (
  modelId: string,
  face: CustomFace,
  fields: CatalogFields,
): ModelConfigEntry => {
  const entry: ModelConfigEntry = {
    id: modelId,
    name: modelId,
    api: face,
    reasoning: fields.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
  if (fields.thinkingLevelMap) entry.thinkingLevelMap = fields.thinkingLevelMap;
  if (face === "openai-completions") {
    // 自建 OpenAI 兼容端点：不要按官方 OpenAI 严卡 finish_reason / usage 流字段
    entry.compat = { ...OPENAI_STREAM_COMPAT };
  }
  return entry;
};

/** 直接构造 Model 实例（provider/baseUrl/api 齐、runtime 里也注册同款 provider） */
const buildModel = (
  modelId: string,
  input: CustomAgentInput,
  face: CustomFace,
  fields: CatalogFields,
): Model<never> => {
  const model = {
    id: modelId,
    name: modelId,
    api: face,
    provider: PROVIDER_ID,
    baseUrl: customSdkBaseUrlForFace(input.baseUrl, face),
    reasoning: fields.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  } as unknown as Model<never>;
  if (fields.thinkingLevelMap) {
    (model as unknown as { thinkingLevelMap?: ThinkingLevelMap }).thinkingLevelMap =
      fields.thinkingLevelMap;
  }
  if (face === "openai-completions") {
    (model as unknown as { compat?: unknown }).compat = {
      ...OPENAI_STREAM_COMPAT,
    };
  }
  return model;
};

/** 每次会话起一个独立 runtime + 注册 provider + 构造 Model */
const buildRuntime = async (
  input: CustomAgentInput,
): Promise<{
  runtime: Awaited<ReturnType<typeof ModelRuntime.create>>;
  model: Model<never>;
  thinkingLevel: ReturnType<typeof thinkingLevelFromParams>;
}> => {
  const modelId = input.model?.id?.trim() || "default";
  const index = await getModelsDevIndex();
  // auto 档在这里做目录路由；显式 openai / anthropic 直接收敛成对应面
  const face = await resolveModelFace(input.baseUrl, modelId, input.format);
  const hit = lookupCatalogReasoning(index, modelId);
  const fields = reasoningFieldsFromCatalog(hit);
  const thinkingLevel = thinkingLevelFromParams(
    input.model?.params,
    hit?.effortValues,
  );
  const runtime = await ModelRuntime.create({ modelsPath: null });
  const sdkBase = customSdkBaseUrlForFace(input.baseUrl, face);
  // 注册 provider 让 runtime 能解析 apiKey + api 流实现；model 直接构造引用同 provider
  runtime.registerProvider(PROVIDER_ID, {
    name: "Custom",
    baseUrl: sdkBase,
    apiKey: input.apiKey,
    api: face,
    models: [buildModelConfig(modelId, face, fields)],
  });
  return { runtime, model: buildModel(modelId, input, face, fields), thinkingLevel };
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

/** 从 mcpServers 里抽用户 MCP（排除我们自己的 flowshipChat、它走 flowship-tools 直连） */
const extractUserMcpServers = (
  mcpServers: unknown,
): Record<string, McpServerConfig> => {
  if (!mcpServers || typeof mcpServers !== "object") return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (name === "flowshipChat") continue;
    if (cfg && typeof cfg === "object") out[name] = cfg as McpServerConfig;
  }
  return out;
};

/** 用户 MCP → pi customTools（每个 server 起 MCP client 枚举工具）；单个失败只 warn、跳过 */
const bridgeUserMcpServers = async (
  mcpServers: unknown,
): Promise<{ toolDefs: ToolDefinition[]; closeAll: () => void }> => {
  const servers = extractUserMcpServers(mcpServers);
  const entries = await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      try {
        return await connectMcpServer(name, cfg);
      } catch (err) {
        console.warn(
          `[custom-agent-backend] MCP「${name}」桥接失败、跳过：`,
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    }),
  );
  const bridges = entries.filter((b): b is BridgedMcpServer => b !== null);
  const toolDefs: ToolDefinition[] = bridges.flatMap((b) =>
    b.tools.map(
      (t) =>
        ({
          name: t.name,
          label: t.name,
          description: t.description || `MCP 工具 ${t.name}`,
          // MCP 返回 JSON Schema、直接透传（pi 侧不再二次校验、交给 MCP server 自己验）
          parameters: t.inputSchema,
          execute: async (_toolCallId: string, params: unknown) => {
            const r = await t.call(params as Record<string, unknown>);
            return {
              content: r.content,
              details: r.isError ? { isError: true } : undefined,
            };
          },
        }) as unknown as ToolDefinition,
    ),
  );
  return {
    toolDefs,
    closeAll: () => {
      for (const b of bridges) void b.close().catch(() => {});
    },
  };
};

/** 进程内嵌套子会话：给 task 工具用——起一个只带编码工具的子 agent、跑完返最终文本 */
const runSubagent = async (
  prompt: string,
  opts: {
    runtime: Awaited<ReturnType<typeof ModelRuntime.create>>;
    model: Model<never>;
    cwd: string;
    thinkingLevel: ReturnType<typeof thinkingLevelFromParams>;
  },
): Promise<string> => {
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: piAgentDir(),
    resourceLoader: await buildResourceLoader(opts.cwd),
    modelRuntime: opts.runtime,
    model: opts.model,
    tools: [...SUBAGENT_TOOLS],
    customTools: buildNativeToolAliasWrappers(opts.cwd),
    thinkingLevel: opts.thinkingLevel,
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
        } else if (ev.type === "agent_end" && !ev.willRetry) {
          unsub();
          resolve();
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
  mcpToolDefs: ToolDefinition[],
  thinkingLevel: ReturnType<typeof thinkingLevelFromParams>,
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
    runSubagent(prompt, {
      runtime: subagentRuntime,
      model: subagentModel,
      cwd,
      thinkingLevel,
    }),
  ),
  ...mcpToolDefs,
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
  /** pi 把 API 失败写在 assistant 消息里，先记下、settle 时带出去 */
  private lastAssistantError: string | null = null;
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
            const displayName = mcpDisplayName(tc.name);
            this.toolArgs.set(tc.id, { name: displayName, args: tc.arguments });
            // 工具开始：SDKMessage running + onDelta tool-call-started
            this.push({
              type: "tool_call",
              call_id: tc.id,
              name: displayName,
              args: tc.arguments,
              status: "running",
            } as unknown as SDKMessage);
            this.fireDelta({
              type: "tool-call-started",
              callId: tc.id,
              toolCall: {
                type: displayName === "bash" ? "shell" : displayName,
                args: { toolName: displayName },
              },
            } as unknown as InteractionUpdate);
          }
          break;
        }
        case "message_end": {
          // 后续成功 stop/toolUse 必须清掉中途 503，否则 agent_settled 会拿粘性错误去重连
          this.lastAssistantError = stickyErrorAfterMessageEnd(
            this.lastAssistantError,
            ev.message,
          );
          break;
        }
        case "agent_end": {
          if (ev.willRetry) break;
          const err = settleErrorFromTranscript(
            ev.messages,
            this.lastAssistantError,
          );
          if (err) {
            this.lastAssistantError = err;
            // pi 的 HTTP 400 写在 assistant 消息里、prompt() 不抛；不在这里 settle
            // 的话可能永远等不到 agent_settled，UI 卡在「正在发送首包…」
            this.settle({ status: "error", result: err });
          }
          break;
        }
        case "auto_retry_end": {
          if (ev.success) {
            // 内部重试已恢复：清粘性错误，等后续 assistant / agent_settled 按最后一条收尾
            this.lastAssistantError = null;
            break;
          }
          const err = fatalAssistantError(
            ev.finalError || this.lastAssistantError || "模型请求失败",
          );
          // 缺 finish_reason：正文已在，按成功收尾，避免再等 agent_settled
          this.settle(
            err
              ? { status: "error", result: err }
              : { status: this.cancelled ? "cancelled" : "finished" },
          );
          break;
        }
        case "tool_execution_end": {
          const displayName = mcpDisplayName(ev.toolName);
          const cached = this.toolArgs.get(ev.toolCallId) ?? {
            name: displayName,
            args: {},
          };
          this.push({
            type: "tool_call",
            call_id: ev.toolCallId,
            name: cached.name,
            args: cached.args,
            status: ev.isError ? "error" : "completed",
            result: ev.result,
          } as unknown as SDKMessage);
          this.fireDelta({
            type: "tool-call-completed",
            callId: ev.toolCallId,
            toolCall: {
              type: cached.name === "bash" ? "shell" : cached.name,
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
          // 只认最后一条 assistant：中途 503 已被后续成功回复覆盖则 finished，不触发自动重连
          const err = settleErrorFromTranscript(
            this.session.state.messages,
            this.lastAssistantError ??
              this.session.state.errorMessage?.trim() ??
              null,
          );
          if (err && !this.cancelled) {
            this.settle({ status: "error", result: err });
          } else {
            this.settle({
              status: this.cancelled ? "cancelled" : "finished",
            });
          }
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
  onClose?: () => void,
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
      try {
        onClose?.();
      } catch {
        /* noop */
      }
    },
  };
};

export const createCustomAgent = async (
  input: CustomAgentInput,
): Promise<PiAgentAdapter> => {
  // pi grep 找 PATH 上的 rg；instrumentation 已注入，这里再幂等一次防 HMR / 测试没走启动钩子
  injectSdkRgPath();
  const cwd = input.local?.cwd || process.cwd();
  const { runtime, model, thinkingLevel } = await buildRuntime(input);
  const callerToken = extractCallerToken(input.mcpServers);
  const mcp = await bridgeUserMcpServers(input.mcpServers);
  // pi 的 `tools` 选项是「允许工具白名单」，必须把 customTools（含 MCP 桥接工具）
  // 的名字也列进去；否则只传 NATIVE_TOOLS 会把 flowShipTools / 编码工具 / MCP 工具
  // 全部过滤掉，模型只看到 read/edit/write/grep。
  const customTools = buildCustomTools(
    callerToken,
    cwd,
    runtime,
    model,
    mcp.toolDefs,
    thinkingLevel,
  );
  const { session } = await createAgentSession({
    cwd,
    agentDir: piAgentDir(),
    resourceLoader: await buildResourceLoader(cwd),
    modelRuntime: runtime,
    model,
    thinkingLevel,
    tools: [...NATIVE_TOOLS, ...customTools.map((t) => t.name)],
    customTools,
    sessionManager: SessionManager.create(cwd, piSessionDir()),
  });
  const agentId = session.sessionFile ?? session.sessionId;
  return buildAdapter(session, agentId, mcp.closeAll);
};

export const resumeCustomAgent = async (
  agentId: string,
  input: CustomAgentInput,
): Promise<PiAgentAdapter> => {
  injectSdkRgPath();
  const cwd = input.local?.cwd || process.cwd();
  const { runtime, model, thinkingLevel } = await buildRuntime(input);
  const callerToken = extractCallerToken(input.mcpServers);
  const mcp = await bridgeUserMcpServers(input.mcpServers);
  // 同 createCustomAgent：白名单必须包含全部 customTools，否则续会话同样丢掉 MCP/编码工具。
  const customTools = buildCustomTools(
    callerToken,
    cwd,
    runtime,
    model,
    mcp.toolDefs,
    thinkingLevel,
  );
  // agentId 存的是上次的 sessionFile 路径 → SessionManager.open 续接；
  // 打开失败（文件被清 / 不兼容）会抛、由调用方按 cursor 的 resume 失败口径降级新会话。
  const sessionManager = SessionManager.open(agentId, piSessionDir(), cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir: piAgentDir(),
    resourceLoader: await buildResourceLoader(cwd),
    modelRuntime: runtime,
    model,
    thinkingLevel,
    tools: [...NATIVE_TOOLS, ...customTools.map((t) => t.name)],
    customTools,
    sessionManager,
  });
  return buildAdapter(session, agentId, mcp.closeAll);
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
    resourceLoader: await buildResourceLoader(cwd),
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
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
        } else if (ev.type === "agent_end" && !ev.willRetry) {
          unsub();
          resolve();
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
