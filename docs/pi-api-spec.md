# pi coding agent 库 API 参考（可直接照着实现的集成规格）

> 目标：在 **Node.js ≥ 22.19** 的 **Next.js + Electron** 应用里，把 `@earendil-works/pi-coding-agent`（pi, author Mario Zechner / earendil-works）集成进来。
>
> **版本：全部锁定 `0.84.2`。**
>
> **取材方式说明**：本文档所有 `.d.ts` 片段都来自从 `https://registry.npmjs.org/@earendil-works/<pkg>/-/<pkg>-0.84.2.tgz` 解包后读取的 **实际编译产物 `dist/*.d.ts`**（而非 jsdelivr/unpkg 路径猜测；本轮未需访问 GitHub raw，未遇到限流）。片段中出现的 `.ts` 后缀（如 `./models.ts`）是该构建（tsgo emit）的 sourceMapping 写法，**不影响 import**；请一律用下文给出的 **public subpath export**。
>
> 涉及包：
> - `@earendil-works/pi-coding-agent`
> - `@earendil-works/pi-agent-core`（`./node` export）
> - `@earendil-works/pi-ai`（`./api/*`、`./providers/*` export）
> - `@earendil-works/pi-client`（可选，CBOR 远程客户端）
> - `@earendil-works/pi-protocol`（可选，CBOR 协议）

---

## 0. 先厘清架构：三个包各管什么

| 包 | 职责 | 关键导出 |
|---|---|---|
| `pi-ai` | LLM 层：`Model<TApi>` 承载 `provider/api/baseUrl/headers/compat`；`Provider` 拥有 auth/模型列表/stream；`Models` 集合持有 providers | `createModels`、`createProvider`、`lazyApi`、`envApiKeyAuth`、`Models`、`Provider`、`Model` |
| `pi-agent-core` | 进程内 agent：`Agent`、`AgentTool`、`AgentEvent`；以及带 JSONL 持久化/压缩/分支的 `AgentHarness` | `./node`（`NodeExecutionEnv` + 全量 index）、`Agent`、`AgentHarness` |
| `pi-coding-agent` | 完整 coding agent（TUI + headless）：模型/auth 运行时、会话、内置工具、bash | `createAgentSession`、`AgentSession`、`ModelRuntime`、`createCodingTools`、`SessionManager` |
| `pi-client` + `pi-protocol` | 与**独立 `pi` 进程**通信的 framed-CBOR 客户端 / 协议 | `PiClient`、`RemoteSession`、`ProtocolErrorCode` 等 |

**两点关键事实（务必先记住）**：
1. `pi-ai` **没有**一个 `configureProvider({baseUrl, apiKey, model})` 式一次性助手；内置工厂 `openaiProvider()` / `anthropicProvider()` **零参数**，只读环境变量/凭据存储。自定义 baseUrl+apiKey 一律走 `ProviderConfigInput`（或 `Model.baseUrl` + 自定义 `ProviderAuth.apiKey.resolve()`）。
2. 内置编码 agent 的**内置工具**固定为 `read | bash | edit | write | grep | find | ls`，**没有任何 subagent/task-spawn 工具**，**没有 MCP 支持**（详见 §6/§8）。

---

## 1. 自定义 Provider（baseUrl + apiKey）

### 1.1 三种等价途径

| 途径 | 位置 | 适用 |
|---|---|---|
| (A) `ModelRuntime.registerProvider(name, config)` + `setRuntimeApiKey()` | `pi-coding-agent` | **推荐**：要用 `createAgentSession` 时 |
| (B) `ModelRegistry.registerProvider(name, config)` | `pi-coding-agent`（`core/model-registry.ts` 的同步 facade） | 扩展/UI 层 |
| (C) `createProvider()` + 自定义 `ProviderAuth` + `createModels()` | `pi-ai` | 只用 LLM 层、不引入 coding-agent 时 |

### 1.2 核心配置对象 `ProviderConfigInput`（复制自 `pi-coding-agent/dist/core/provider-composer.d.ts`）

```ts
export interface ProviderConfigInput {
  name?: string;
  baseUrl?: string;                 // 用户提供的端点，例如 https://api.example.com/v1
  apiKey?: string;                  // 也可稍后通过 setRuntimeApiKey 设置
  api?: Api;                        // 见下方 Api 取值
  streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
  headers?: Record<string, string>; // 额外 HTTP 头
  authHeader?: boolean;             // 是否发送 Authorization: Bearer <apiKey>
  oauth?: ExtensionOAuthConfig;
  models?: Array<{
    id: string;
    name: string;
    api?: Api;
    baseUrl?: string;
    reasoning: boolean;
    thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
    input: ("text" | "image")[];
    cost: Model<Api>["cost"];       // { input, output, cacheRead, cacheWrite } 每百万 token 美元
    contextWindow: number;
    maxTokens: number;
    samplingParams?: Record<string, unknown>;
    headers?: Record<string, string>;
    compat?: Model<Api>["compat"];  // 见 §1.5
  }>;
  refreshModels?(context: RefreshModelsContext): Promise<NonNullable<ProviderConfigInput["models"]>>;
}
```

### 1.3 `api` 取值（复制自 `pi-ai/dist/types.d.ts`）

```ts
export type KnownApi =
  | "openai-completions" | "mistral-conversations" | "openai-responses"
  | "azure-openai-responses" | "openai-codex-responses" | "anthropic-messages"
  | "bedrock-converse-stream" | "google-generative-ai" | "google-vertex" | "pi-messages";
export type Api = KnownApi | (string & {});
```

- **(a) OpenAI 兼容端点** → `api: "openai-completions"`（chat/completions 协议，兼容 vLLM / llama.cpp / SGLang / 各类中转），或 `"openai-responses"`（Responses API）。
- **(b) Anthropic 兼容端点** → `api: "anthropic-messages"`。

### 1.4 注册用法（途径 A，可直接照抄）

```ts
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
// 类型也来自顶层导出：
import type { ProviderConfigInput } from "@earendil-works/pi-coding-agent";

const runtime = await ModelRuntime.create({ modelsPath: null }); // null => 不读 models.json

runtime.registerProvider("my-openai", {
  name: "My OpenAI-compatible",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-...",              // 或稍后：await runtime.setRuntimeApiKey("my-openai", key)
  api: "openai-completions",
  models: [{
    id: "my-model",
    name: "My Model",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat: { supportsUsageInStreaming: false, maxTokensField: "max_tokens" },
  }],
});
```

相关声明面（`pi-coding-agent/dist/core/model-registry.d.ts` 与 `model-runtime.d.ts`）：

```ts
// ModelRegistry
registerProvider(provider: Provider): void;
registerProvider(providerName: string, config: ProviderConfigInput): void;
unregisterProvider(providerName: string): void;
getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined;
getRegisteredProviderIds(): readonly string[];

// ModelRuntime
setRuntimeApiKey(providerId: string, apiKey: string, options?: AuthOperationOptions): Promise<void>;
removeRuntimeApiKey(providerId: string, options?: AuthOperationOptions): Promise<void>;
registerProvider(providerId: string, config: ProviderConfigInput): void;
registerNativeProvider(provider: Provider): void;
```

运行时 apiKey 由 `RuntimeCredentials`（内存态 `CredentialStore` overlay）持有，**不落盘**；`models.json` 里的 `apiKey`（以及 `models.json` 的 `apiKey` 字段才持久化）否则靠 `setRuntimeApiKey`。

### 1.5 兼容性旗标 `compat`（自定义/自建端点最重要的字段）

OpenAI 兼容端点用 `OpenAICompletionsCompat`（复制自 `pi-ai/dist/types.d.ts`，节选关键字段）：

```ts
export interface OpenAICompletionsCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;   // 流式是否带 stream_options.include_usage
  supportsFinishReason?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "baseten" | "zai"
    | "qwen" | "chat-template" | "qwen-chat-template" | "string-thinking" | "ant-ling";
  chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
  chatTemplateArgs?: Record<string, ChatTemplateKwargValue>;
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
  cacheControlFormat?: "anthropic";
  // ...openRouterRouting / vercelGatewayRouting / sendSessionAffinityHeaders / sessionAffinityFormat / supportsLongCacheRetention 等
}
```

Anthropic 兼容端点用 `AnthropicMessagesCompat`：

```ts
export interface AnthropicMessagesCompat {
  supportsEagerToolInputStreaming?: boolean;
  supportsLongCacheRetention?: boolean;
  sendSessionAffinityHeaders?: boolean;
  supportsCacheControlOnTools?: boolean;
  supportsTemperature?: boolean;
  forceAdaptiveThinking?: boolean;
  allowEmptySignature?: boolean;
  supportsStrictTools?: boolean;
  supportsToolReferences?: boolean;
}
```

> 说明：`supportsStore`、`supportsDeveloperRole`、`supportsReasoningEffort`、`maxTokensField` 等默认「按 baseUrl 自动探测」；对自建端点建议显式给 `compat`，避免探测失败。

### 1.6 `Model` 本体（`baseUrl/headers/compat` 就挂在这里，复制自 `pi-ai/dist/types.d.ts`）

```ts
export interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: ProviderId;      // string
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: ModelCost;           // { input, output, cacheRead, cacheWrite, tiers? }
  contextWindow: number;
  maxTokens: number;
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: TApi extends "openai-completions" ? OpenAICompletionsCompat
         : TApi extends ("openai-responses" | "azure-openai-responses" | "openai-codex-responses") ? OpenAIResponsesCompat
         : TApi extends "anthropic-messages" ? AnthropicMessagesCompat
         : TApi extends "bedrock-converse-stream" ? BedrockCompat : never;
}
```

### 1.7 途径 C：纯 `pi-ai` 层构造（只用 LLM、不引 coding-agent 时）

```ts
import {
  createModels, createProvider, lazyApi, envApiKeyAuth,
} from "@earendil-works/pi-ai";
import type { Model, ProviderAuth, ProviderStreams } from "@earendil-works/pi-ai";

const myModel: Model<"openai-completions"> = {
  id: "my-model", name: "My Model", api: "openai-completions", provider: "my-openai",
  baseUrl: "https://api.example.com/v1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000, maxTokens: 8_192,
};

const auth: ProviderAuth = {
  apiKey: {
    name: "API key",
    resolve: async () => ({ apiKey: "sk-...", baseUrl: "https://api.example.com/v1" }),
  },
};

const provider = createProvider({
  id: "my-openai",
  baseUrl: "https://api.example.com/v1",
  auth,
  models: [myModel],
  api: lazyApi(async () =>
    (await import("@earendil-works/pi-ai/api/openai-completions")) as ProviderStreams
  ),
});

const models = createModels();
models.setProvider(provider);
```

`createProvider` / `createModels` / auth 精确签名（复制自 `pi-ai/dist/models.d.ts`、`auth/types.d.ts`、`auth/helpers.d.ts`）：

```ts
export interface CreateProviderOptions<TApi extends Api = Api> {
  id: string;
  name?: string;
  baseUrl?: string;
  headers?: ProviderHeaders;          // Record<string, string | null>
  auth: ProviderAuth;                 // 必填，每个 provider 都有 auth 语义
  models: readonly Model<TApi>[];     // 静态基线模型列表
  fetchModels?: (context: RefreshModelsContext) => Promise<readonly Model<TApi>[]>;
  filterModels?: (models, credential) => readonly Model<TApi>[];
  api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}
export declare function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi>;

export declare function createModels(options?: CreateModelsOptions): MutableModels;
// CreateModelsOptions = { credentials?: CredentialStore; modelsStore?: ModelsStore; authContext?: AuthContext }
// MutableModels 额外有 setProvider / deleteProvider / clearProviders

// auth
export interface ModelAuth { apiKey?: string; headers?: ProviderHeaders; baseUrl?: string; }
export interface AuthResult { auth: ModelAuth; env?: ProviderEnv; source?: string; }
export interface ProviderAuth { apiKey?: ApiKeyAuth; oauth?: OAuthAuth; }
export declare function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth;
```

`ApiKeyAuth.resolve` 签名（自定义 provider 的 auth 核心）：

```ts
export interface ApiKeyAuth {
  name: string;
  login?(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential>;
  check?(input: { ctx: AuthContext; credential?: ApiKeyCredential; signal: AbortSignal }): Promise<AuthCheck | undefined>;
  resolve(input: {
    ctx: AuthContext;
    credential?: ApiKeyCredential;
    signal: AbortSignal;
  }): Promise<AuthResult | undefined>;   // AuthResult.auth = { apiKey?, baseUrl?, headers? }
}
```

### 1.8 `./providers/*` 与 `./api/*` 实际含什么

- `@earendil-works/pi-ai/providers/*`：每个 provider 家族一个模块。**注意**：`providers/openai.ts` 只导出 `openaiProvider(): Provider<"openai-responses">`，`providers/anthropic.ts` 只导出 `anthropicProvider(): Provider<"anthropic-messages">`（都是零参、ambient auth）。每个还带生成目录 `*.models.ts`（如 `providers/openai.models.ts` 的 `OPENAI_MODELS`）。`providers/all.ts` 导出：`builtinProviders()`、`builtinModels()`、`getBuiltinModels(provider)`、`getBuiltinModel(provider, id)`、`getBuiltinProviders()`。
- `@earendil-works/pi-ai/api/*`：每个线上 API 实现一个模块（`openai-completions`、`openai-responses`、`anthropic-messages`、`mistral-conversations`、`google-generative-ai`、`google-vertex`、`bedrock-converse-stream`、`azure-openai-responses`、`openai-codex-responses`、`pi-messages`，另有 `cloudflare`、`github-copilot-headers`、`openrouter-images` 等）。每个模块按 `ProviderStreams` 契约导出 `stream(model, context, options)` 与 `streamSimple(model, context, options)`。**顶层 index 不 re-export `./api/*`**（只 re-export `./api/lazy.ts` 的 `lazyApi`/`lazyStream`），要用 API 实现请走 subpath。
- `@earendil-works/pi-ai/providers/all.ts` 的 `builtinModels(options?)` 返回已注册所有内置 provider 的 `MutableModels`。

---

## 2. 模型列出

### 2.1 `pi-ai` 层

```ts
export interface Models {
  getProviders(): readonly Provider[];
  getProvider(id: string): Provider | undefined;
  getModels(provider?: string): readonly Model<Api>[];      // 同步，最新已知列表
  getModel(provider: string, id: string): Model<Api> | undefined;
  refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
  checkAuth(providerId: string, options?): Promise<AuthCheck | undefined>;
  getAvailable(providerId?: string, options?): Promise<readonly Model<Api>[]>;  // auth 已配置的模型
  getAuth(providerId: string, overrides?): Promise<AuthResult | undefined>;
  stream<TApi extends Api>(model, context, options?): AssistantMessageEventStream;
  complete<TApi extends Api>(model, context, options?): Promise<AssistantMessage>;
  streamSimple(model, context, options?): AssistantMessageEventStream;
  completeSimple(model, context, options?): Promise<AssistantMessage>;
  // ...login/logout/fetchDeferred/cancelDeferred
}

export interface ModelsRefreshOptions {
  allowNetwork?: boolean;
  providers?: readonly string[];
  force?: boolean;
  signal?: AbortSignal;
}
export interface ModelsRefreshResult {
  aborted: boolean;
  errors: ReadonlyMap<string, Error>;
}
```

`Provider.getModels(): readonly Model<TApi>[]` 同步返回已知列表；动态 provider 有可选 `refreshModels?(context: RefreshModelsContext): Promise<void>`。`RefreshModelsContext` 含 `credential?`、`stored?`、`publish(publication): Promise<boolean>`、`allowNetwork`、`force?`、`signal`。

> 对**自定义**端点，pi **没有**硬编码 `GET /v1/models` 拉取器；请通过 `ProviderConfigInput.refreshModels()`（或 `CreateProviderOptions.fetchModels`）自行实现 OpenAI `/v1/models` 等价接口并返回 `Model[]`。内置 provider 各自实现自己的拉取。

### 2.2 `pi-coding-agent` 层

```ts
// ModelRuntime（implements Models），来自 dist/core/model-runtime.d.ts
getModels(providerId?: string): readonly Model<Api>[];
getAvailable(providerId?: string, options?): Promise<readonly Model<Api>[]>;
getAvailableSnapshot(): readonly Model<Api>[];   // 同步内存快照，UI/首页最方便
refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;

// ModelRegistry（同步 facade，来自 dist/core/model-registry.d.ts）
getAll(): Model<Api>[];
getAvailable(): Model<Api>[];
find(provider: string, modelId: string): Model<Api> | undefined;
refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
getRegisteredProviderIds(): readonly string[];
```

Headless RPC 模式下有 `get_available_models` 命令（返回 `{ models: Model<any>[] }`，见 §9）。

> 顶层**没有** `getModel(provider, id)` / `listModels()` 一次性 helper；`providers/all.ts` 有 `getBuiltinModel(provider, modelId)`，`models.generated.d.ts` 有 `MODELS[provider][modelId]` 目录对象。

---

## 3. 三档生命周期（Agent / AgentHarness / createAgentSession+AgentSession）

> **嵌入选择结论**：嵌入你自己的 Node（Electron 主进程 / Next 服务端）进程，用 **进程内** 方式（本 § 三档任意一档皆可）；`pi-client`/`RemoteSession`（§9）用于**独立 `pi` 子进程**隔离场景。

### 3.1 低层次：`Agent`（`@earendil-works/pi-agent-core`）

```ts
export interface AgentOptions {
  initialState?: Partial<Omit<AgentState, "pendingToolCalls"|"isStreaming"|"streamingMessage"|"errorMessage">>;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  streamFn: StreamFn;   // (model, context, options?) => AssistantMessageEventStream  ← 传 models.streamSimple
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  beforeToolCall?: (context: BeforeToolCallContext, signal?) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (context: AfterToolCallContext, signal?) => Promise<AfterToolCallResult | undefined>;
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext, signal?) => boolean | Promise<boolean>;
  prepareNextTurn?: (signal?) => Promise<AgentLoopTurnUpdate | undefined> | ...;
  prepareNextTurnWithContext?: (context: PrepareNextTurnContext, signal?) => ...;
  steeringMode?: QueueMode;   // "all" | "one-at-a-time"
  followUpMode?: QueueMode;
  sessionId?: string;
  thinkingBudgets?: ThinkingBudgets;
  transport?: Transport;
  maxRetryDelayMs?: number;
  toolExecution?: ToolExecutionMode;   // "sequential" | "parallel"（默认 parallel）
}

export declare class Agent {
  constructor(options: AgentOptions);
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
  get state(): AgentState;
  set steeringMode(mode: QueueMode); get steeringMode(): QueueMode;
  set followUpMode(mode: QueueMode); get followUpMode(): QueueMode;
  steer(message: AgentMessage): void;
  followUp(message: AgentMessage): void;
  clearSteeringQueue(): void; clearFollowUpQueue(): void; clearAllQueues(): void;
  hasQueuedMessages(): boolean;
  get signal(): AbortSignal | undefined;
  abort(): void;                          // 取消当前 run
  waitForIdle(): Promise<void>;
  reset(): void;                          // 清空 transcript/runtime/队列
  prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  prompt(input: string, images?: ImageContent[]): Promise<void>;
  continue(): Promise<void>;              // 从当前 transcript 继续（最后一条必须是 user/toolResult）
}
```

`AgentState`（`pi-agent-core/dist/types.d.ts`）：

```ts
export interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  set tools(tools: AgentTool<any>[]);   get tools(): AgentTool<any>[];
  set messages(messages: AgentMessage[]); get messages(): AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

`AgentTool`（`pi-agent-core/dist/types.d.ts`）：

```ts
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  label: string;   // Tool = { name; description; parameters: TSchema; constrainedSampling? }
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (toolCallId: string, params: Static<TParameters>, signal?: AbortSignal,
            onUpdate?: AgentToolUpdateCallback<TDetails>) => Promise<AgentToolResult<TDetails>>;
  executionMode?: ToolExecutionMode;
}
export interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  usage?: Usage;
  addedToolNames?: string[];
  terminate?: boolean;
}
```

> **语义要点**：`Agent` **不含 cwd/会话持久化/内置工具**。cwd 由你通过工具的 execute 闭包/`getApiKey`/`streamFn` 自己处理；会话续接靠 `initialState.messages` 传 `AgentMessage[]`，或 `constructor` 后赋值 `agent.state.messages = ...`。**cancel** = `abort()`（`AbortSignal` 注入当前 run）+ `waitForIdle()`；**close** = `reset()`（此层无异步资源，无需 dispose）。流经 `subscribe` 回调吐 `AgentEvent`（§5.2）。

### 3.2 中层次：`AgentHarness`（`@earendil-works/pi-agent-core`）

带 JSONL 会话持久化、压缩（compaction）、分支（branch/tree）、abort/resume 崩溃恢复：

```ts
export interface AgentHarnessOptions {
  session: Session;                 // 见 SessionRepo/Session（§3.2.1）
  models: Models;                   // pi-ai Models（同时充当 streamFn 来源）
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  activeToolNames?: string[];
  tools?: HarnessTool[];            // AgentTool & { replay?: "never" | "safe" }
  toolContext?: object | (() => object | Promise<object>);
  systemPrompt?: string | (() => string | Promise<string>);
  resources?: Resources;            // { skills?, promptTemplates? }
  streamOptions?: StreamOptions;    // SimpleStreamOptions
  retry?: RetryPolicy;
  compaction?: CompactionSettings;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  toolExecution?: "sequential" | "parallel";
  drive?: "automatic" | "manual";
  toProviderMessages?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  entryProjectors?: Record<string, EntryProjector>;
  context?: TelemetryContext;
}

export declare class AgentHarness implements AgentLane {
  static create(options: AgentHarnessOptions): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }>;
  prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
  prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
  steer(text, images?): Promise<QueueResult>; steer(message): Promise<QueueResult>;
  followUp(text, images?): Promise<QueueResult>; followUp(message): Promise<QueueResult>;
  nextRun(text, images?): Promise<QueueResult>; nextRun(message): Promise<QueueResult>;
  cancelQueued(entryId: string): Promise<CancelQueuedResult>;
  abort(): Promise<AbortResult>;
  resume(): Promise<ResumeResult>;
  waitForIdle(): Promise<void>;
  getModel(): Promise<Model<Api>>; setModel(m): Promise<void>;
  getThinkingLevel(): Promise<ThinkingLevel>; setThinkingLevel(l): Promise<void>;
  getActiveTools(): Promise<string[]>; setActiveTools(names): Promise<void>;
  setTools(tools: HarnessTool[], activeNames?): Promise<void>;
  watch(): Promise<WatchHandle<LaneSnapshot>>;      // snapshot + start(listener)
  watchSession(): Promise<WatchHandle<SessionSnapshot>>;
  readonly session: SessionTree;
  close(): Promise<void>;
  // lane：lane(name), createLane(name, at), lanes()
}
export type RunResult = ResultValue<{ runId: string } & RunOutcome, RunRejected>;
export type RunOutcome =
  | { kind: "completed"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
  | { kind: "aborted";   leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
  | { kind: "failed";    leafId: string; error: OperationError; finalEntryId?; finalMessage? }
  | { kind: "suspended"; leafId: string; finalEntryId: string; deferred: DeferredHandle };
```

`Result`（`pi-agent-core/dist/harness/result.d.ts`）：`{ ok: true; value } | { ok: false; error }`，助手 `ok/err/matchError`。**cancel** = `abort()`（返回 `AbortResult`，含回填的 `steer/followUp`）；**close** = `close()`；**流** = `watch().start(listener)`（`LaneSnapshot.transcript: Entry[]`）或 `events.on(type, listener)`（`RunStartEvent`/`RunEndEvent`，字段 `{type:"run_start"|"run_end", lane, runId, ...}`）；**continue/resume** = `resume()`。

#### 3.2.1 会话持久化（`SessionRepo` / `SessionTree`，`pi-agent-core/dist/harness/session/`）

```ts
export interface SessionRepo<TMetadata, TCreateOptions, TListOptions = void> {
  create(options: TCreateOptions): Promise<Session<TMetadata>>;
  open(metadata: TMetadata): Promise<Session<TMetadata>>;
  list(options?: TListOptions): Promise<TMetadata[]>;
  delete(metadata: TMetadata): Promise<void>;
  fork(source: TMetadata, options: ForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
}
export interface SessionTree {
  getLeafId(): Promise<string | null>;
  getEntry(id): Promise<Entry | undefined>;
  appendMessage(message: AgentMessage): Promise<string>;
  appendCustomEntry(customType: string, data?): Promise<string>;
  findEntries(query?): Promise<Entry[]>;
  findEntriesOnBranch(query?): Promise<Entry[]>;
  getStats(): Promise<SessionStats>;
  // getName/setName/getLabel/setLabel ...
}
```

`Entry` 判别联合（`pi-agent-core/dist/harness/session/types.d.ts`）含 `message` / `model_change` / `thinking_level_change` / `active_tools_change` / `compaction` / `branch_summary` / `custom`，各自 `{ type, id, seq, parentId, timestamp }`。JSONL 后端 `JsonlSessionRepo`（`pi-agent-core/dist/harness/session/jsonl.ts`，`session/index.ts` re-export）。

> ⚠️ `AgentHarness` 是偏底层的持久化 harness；它的 `tools` 需要你手动构造（`createReadTool/createBashTool/createEditTool/createWriteTool` 在 `pi-agent-core/dist/harness/tools/`）。若你想要「cwd + 内置 coding 工具 + 系统提示 + 会话恢复」开箱即用，请直接走 §3.3 的 `createAgentSession`。

### 3.3 最高层次：`createAgentSession` + `AgentSession`（`@earendil-works/pi-coding-agent`）

```ts
export interface CreateAgentSessionOptions {
  cwd?: string;                       // 工作目录（默认 process.cwd()）
  agentDir?: string;                  // 全局配置目录（默认 ~/.pi/agent）
  modelRuntime?: ModelRuntime;        // 默认用 agentDir/auth.json + models.json
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
  noTools?: "all" | "builtin";
  tools?: string[];                   // 内置工具名 allowlist：read/bash/edit/write/grep/find/ls
  excludeTools?: string[];            // denylist（在 tools 之后生效）
  customTools?: ToolDefinition[];
  resourceLoader?: ResourceLoader;
  sessionManager?: SessionManager;    // 默认 SessionManager.create(cwd)
  settingsManager?: SettingsManager;
  sessionStartEvent?: SessionStartEvent;
}
export interface CreateAgentSessionResult {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  modelFallbackMessage?: string;      // 恢复时模型不匹配的警告
}
export declare function createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
```

> ⚠️ **「未核实（stale doc）」**：`createAgentSession` 在 `.d.ts` 里的 docstring 示例仍写着 `continueSession: true` 和 `SessionManager.inMemory()`，但 **`continueSession` 并不是 0.84.2 `CreateAgentSessionOptions` 的字段**（doc 注释落后于接口）。**续接会话**请改用：`SessionManager.continueRecent(cwd, sessionDir?)` 或 `SessionManager.open(path, sessionDir?, cwdOverride?)`，再通过 `createAgentSessionServices` + `createAgentSessionFromServices`（见 §3.3.1）把该 sessionManager 传进去；或直接构造 `AgentSession` 时传入。

`AgentSession` 公开面（复制自 `pi-coding-agent/dist/core/agent-session.d.ts`，节选关键方法）：

```ts
export declare class AgentSession {
  prompt(text: string, options?: PromptOptions): Promise<void>;        // 发用户消息 / 触发回合
  sendUserMessage(content: string | (TextContent|ImageContent)[], options?: {
    deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): Promise<void>;
  steer(text: string, images?: ImageContent[]): Promise<void>;
  followUp(text: string, images?: ImageContent[]): Promise<void>;
  sendCustomMessage<T>(message, options?: { triggerTurn?; deliverAs?: "steer"|"followUp"|"nextTurn" }): Promise<void>;
  subscribe(listener: AgentSessionEventListener): () => void;          // 流事件（AgentSessionEvent，§5.3）
  abort(): Promise<void>;                                             // cancel：中止当前操作并等待 idle
  waitForIdle(): Promise<void>;
  dispose(): void;                                                     // close：移除监听、断开 agent
  clearQueue(): { steering: string[]; followUp: string[] };
  setModel(model: Model<any>): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  setActiveToolsByName(toolNames: string[]): void;
  getActiveToolNames(): string[]; getAllTools(): ToolInfo[];
  setSessionName(name: string): void;
  setAutoCompactionEnabled(b: boolean): void; setAutoRetryEnabled(b: boolean): void;
  compact(customInstructions?: string): Promise<CompactionResult>;
  executeBash(command, onChunk?, options?): Promise<BashResult>;
  get state(): AgentState;
  get model(): Model<any> | undefined;
  get messages(): AgentMessage[];
  get sessionId(): string; get sessionFile(): string | undefined;
  get isStreaming(): boolean; get isIdle(): boolean;
  getSessionStats(): SessionStats;
  exportToHtml(path?, options?): Promise<string>; exportToJsonl(path?): string;
}

export interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  preflightResult?: (success: boolean) => void;
}
```

> **语义**：**send** = `prompt()` / `sendUserMessage()`（always triggers a turn）；流式期间再发消息会走 `steer`/`followUp` 队列（`streamingBehavior`/`deliverAs` 决定）。**stream** = `subscribe(listener)` 收 `AgentSessionEvent`。**cancel** = `abort()`（内部 `AbortController` 注入当前 run，随后 `waitForIdle()`）。**close** = `dispose()`。**continue/resume** = 用 `SessionManager`（见 §3.3.2）打开既有会话重建 session。

#### 3.3.1 Services 拆解（把「服务」和「会话」解耦，便于对 cwd 做续接）

```ts
export interface CreateAgentSessionServicesOptions {
  cwd: string;
  agentDir?: string;
  settingsManager?: SettingsManager;
  modelRuntime?: ModelRuntime;
  modelRuntimeSignal?: AbortSignal;
  extensionFlagValues?: Map<string, boolean | string>;
  resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd"|"agentDir"|"settingsManager">;
  resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
}
export interface AgentSessionServices {
  cwd: string; agentDir: string;
  modelRuntime: ModelRuntime; settingsManager: SettingsManager;
  resourceLoader: ResourceLoader; diagnostics: AgentSessionRuntimeDiagnostic[];
}
export declare function createAgentSessionServices(options: CreateAgentSessionServicesOptions): Promise<AgentSessionServices>;

export interface CreateAgentSessionFromServicesOptions {
  services: AgentSessionServices;
  sessionManager: SessionManager;
  sessionStartEvent?: SessionStartEvent;
  model?: Model<any>; thinkingLevel?: ThinkingLevel;
  scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
  tools?: string[]; excludeTools?: CreateAgentSessionOptions["excludeTools"];
  noTools?: CreateAgentSessionOptions["noTools"];
  customTools?: ToolDefinition[];
}
export declare function createAgentSessionFromServices(options: CreateAgentSessionFromServicesOptions): Promise<CreateAgentSessionResult>;
```

#### 3.3.2 会话持久化 `SessionManager`（`pi-coding-agent/dist/core/session-manager.d.ts`，append-only JSONL 树）

```ts
export interface NewSessionOptions { id?: string; parentSession?: string; }

export declare class SessionManager {
  static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
  static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
  static continueRecent(cwd: string, sessionDir?: string): SessionManager;
  static inMemory(cwd?: string, options?: NewSessionOptions): SessionManager;
  static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
  static list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
  static listAll(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
  // 实例：newSession(options?), setSessionFile(file), getEntries()/getTree()/getLeafId()/getHeader(), getSessionId(), buildContextEntries(...)
}
export interface SessionInfo {
  path: string; id: string; cwd: string; name?: string;
  parentSessionPath?: string; created: Date; modified: Date;
  messageCount: number; firstMessage: string; allMessagesText: string;
}
```

---

## 4. 内置工具与增删配置形状

### 4.1 内置工具名（复制自 `pi-coding-agent/dist/core/tools/index.d.ts`）

```ts
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export declare const allToolNames: Set<ToolName>;
export declare function createCodingTools(cwd: string, options?: ToolsOptions): Tool[];
export declare function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[];
export declare function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool;
export declare function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef;
export declare function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool>;
export interface ToolsOptions {
  read?: ReadToolOptions; bash?: BashToolOptions; write?: WriteToolOptions;
  edit?: EditToolOptions; grep?: GrepToolOptions; find?: FindToolOptions; ls?: LsToolOptions;
}
```

默认启用集合（`CreateAgentSessionOptions` doc / `AgentSessionConfig.initialActiveToolNames` 默认）= `["read","bash","edit","write"]`；`grep/find/ls` 存在但需显式开启。

### 4.2 各工具入参 schema（复制自各自 `.d.ts`）

- `read`：`{ path: string, offset?: number, limit?: number }`
- `bash`：`{ command: string, timeout?: number }`（opts：`operations?`、`commandPrefix?`、`shellPath?`）
- `edit`：`{ path: string, edits: { oldText: string, newText: string }[] }`（opts：`operations?` = `EditOperations`）
- `write`：`{ path: string, content: string }`
- `grep`：`{ pattern: string, path?: string, glob?: string, ignoreCase?: boolean, literal?: boolean, context?: number, limit?: number }`
- `find`：`{ pattern: string, path?: string, limit?: number }`
- `ls`：`{ path?: string, limit?: number }`

### 4.3 增删工具

- **加自定义工具**：`CreateAgentSessionOptions.customTools?: ToolDefinition[]`（扩展风格）；更低层用 `AgentState.tools = [...]` / `AgentTool[]`，或 `AgentHarnessOptions.tools`。
- **允许/禁止内置工具**：`tools`（allowlist）、`excludeTools`（denylist，在 `tools` 之后生效）、`noTools: "all" | "builtin"`（`"all"` 起手全禁；`"builtin"` 禁默认内置但保留扩展/自定义工具）。
- **运行时**：`session.setActiveToolsByName(names)`（只暴露已注册工具名，未知名忽略，下次回合生效）。
- **可插拔执行后端**：每个工具都是可替换接口 —— e.g. `BashOperations.exec(command, cwd, { onData, signal, timeout, env }) => Promise<{ exitCode: number | null }>`；`EditOperations`/`ReadOperations`/`WriteOperations`/`FindOperations`/`GrepOperations`/`LsOperations` 类似。doc 明确写了可用于 SSH/远程（沙箱）委托。`withFileMutationQueue(...)` 给 write/edit 加变更队列。

### 4.4 subagent / task-spawn 工具

**没有。** 0.84.2 无 `task`/`subagent`/`spawn` 工具；只有 steer/follow-up 消息队列与 skills（`Skill`/`loadSkills`/`formatSkillsForPrompt`，`pi-coding-agent/dist/core/skills.ts`）。

---

## 5. 事件判别联合（判别字段都是 `type`，CBOR 请求用 `command`）

### 5.1 Provider 级：`AssistantMessageEvent`（`pi-ai/dist/types.d.ts`）

```ts
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start";     contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta";     contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end";       contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end";   contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end";   contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done";  reason: Extract<StopReason, "stop"|"length"|"toolUse"|"deferred">; message: AssistantMessage }
  | { type: "error"; reason: Extract<StopReason, "aborted"|"error">; error: AssistantMessage };
```

内容块（`pi-ai/dist/types.d.ts`）：

```ts
export interface TextContent { type: "text"; text: string; textSignature?: string; }
export interface ThinkingContent { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean; }
export interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, any>; thoughtSignature?: string; namespace?: string; }
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api; provider: ProviderId; model: string;
  responseModel?: string; responseId?: string; diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage; stopReason: StopReason; deferred?: DeferredHandle; errorMessage?: string;
  rawStopReason?: string; endTurn?: boolean; timestamp: number;
}
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
```

### 5.2 Agent 循环级：`AgentEvent`（`pi-agent-core/dist/types.d.ts`）

```ts
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }  // 文本/工具增量嵌在这里
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

> 助手**文本增量**到你就是 `message_update.assistantMessageEvent.type === "text_delta"`（`.delta`）；**工具调用**是 `message_update` 里的 `toolcall_end`（`.toolCall`），工具的执行结果/开始是 `tool_execution_start/update/end`；**回合结束**是 `turn_end` → 最后 `agent_end`。

### 5.3 Session 级：`AgentSessionEvent`（`pi-coding-agent/dist/core/agent-session.d.ts`，extends `AgentEvent`）

```ts
export type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "agent_settled" }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "compaction_end"; reason: "manual"|"threshold"|"overflow"; result: CompactionResult|undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "summarization_retry_attempt_start"; source: "branchSummary" }
  | { type: "summarization_retry_attempt_start"; source: "compaction"; reason: "manual"|"threshold"|"overflow" }
  | { type: "summarization_retry_finished" }
  | { type: "bash_execution_update"; id?: string; delta: string };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
// AgentSession.subscribe(listener): () => void
```

### 5.4 CBOR 协议级：`ServerEvent` / `TranscriptProgress`（`pi-protocol/dist/schemas.d.ts`）

```ts
// ServerEvent 变体（type 判别）：
// { type: "server_snapshot";   snapshot: ServerSnapshot }         // sessions + models 列表
// { type: "session_snapshot";  snapshot: SessionSnapshot }        // 完整 transcript 快照
// { type: "session_progress";  ...; progress: TranscriptProgress }// 流式增量
// { type: "session_removed";   sessionId: string }

// TranscriptProgress 变体：
// { type: "item_started",  item }
// { type: "item_updated",  item }
// { type: "item_finished", item }
// { type: "assistant_delta", messageId: string; contentIndex: number;
//     kind: "text"|"thinking"|"toolCall"; delta: string }

// SessionSnapshot 字段（节选）：
// { id?, name?, cwd, createdAt, updatedAt,
//   phase: "idle"|"turn"|"compaction"|"branch_summary"|"retry",
//   model: ModelRef, thinkingLevel, attached, locked, revision,
//   transcript: TranscriptItem[] }
// TranscriptItem = user | assistant(streaming|complete|error|aborted) | tool(running|complete|error)

export type ModelRef = { provider: string; id: string };
export type ThinkingLevel = "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max";
```

`Command` 联合（客户端→服务端请求）：`list` | `create {cwd?, name?, model?, thinkingLevel?}` | `attach {sessionId}` | `detach {sessionId}` | `prompt {sessionId, text}` | `steer {sessionId, text}` | `abort {sessionId}` | `set_model {sessionId, model: ModelRef}` | `set_thinking {sessionId, thinkingLevel}`。传输：`framing.d.ts`（长度前缀 CBOR 帧）、`codec.d.ts`、`PROTOCOL_VERSION = 1`。

### 5.5 JSON-lines RPC 模式事件（`pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`）

命令与响应见 §9；**事件**就是 `AgentSessionEvent`（同 §5.3）+ `RpcExtensionUIRequest`/`RpcExtensionUIResponse`。

---

## 6. MCP 支持 —— **未内置**（已核实）

- 对所有五个包 `dist/**/*.d.ts` 做大小写不敏感全文搜索 `mcp`，**仅命中一处**，且是 `pi-coding-agent/dist/utils/tool-result-images.d.ts` 里一句 doc 注释：*"…that produce images themselves (extensions, MCP bridges, screenshot tools) hand back arbitrary…"* —— 这是把「MCP bridge」当作「能产出图片的自定义工具」的举例，**不是** MCP 集成。
- 五个包 0.84.2 的依赖图里**没有** `pi-mcp-adapter` 包；没有任何 stdio/http MCP server 配置，没有 MCP 相关内置工具。

> 对你的含义：MCP stdio/http server 需要**自己桥接**——进程内起 MCP client、枚举其 tools、把每个作为 `AgentTool`（`customTools` 的 `ToolDefinition`，或 `AgentState.tools`）注册，`execute()` 里做 MCP 调用转发。
>
> **「未核实」**：是否存在**独立发布的** `@earendil-works/pi-mcp-adapter`（本结论仅严格限定于这五个包 0.84.2；未查询 npm 全量搜索）。

---

## 7. 安装清单

```jsonc
{
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.84.2",
    "@earendil-works/pi-agent-core":     "0.84.2",
    "@earendil-works/pi-ai":            "0.84.2",
    // 仅当用 CBOR 远程客户端：
    "@earendil-works/pi-client":        "0.84.2",
    "@earendil-works/pi-protocol":      "0.84.2"
  }
}
```

- **Node ≥ 22.19.0 必需**：每个包 `"engines": { "node": ">=22.19.0" }`，且 `pi-coding-agent` 是 `"type": "module"`。**Node 22.19 可用；低于 22.19.0 不行。** 发布/构建环境为 Node 22.23.1。
- **全部纯 ESM**（`"type": "module"` + exports map 仅 `import` 条件）。Electron 主进程需跑 ESM（或打包），Next 服务端无碍；**没有 CJS entry**。
- **无原生/构建步骤**：`pi-coding-agent` 的 `build:binary` 只产出独立 `pi` CLI 的 Bun 二进制；npm 装的 JS entry 是纯 JS + 少量复制进 `dist` 的 `.json/.html/` 资源。五个包均无 node-gyp/`.node`/postinstall。
- **传递依赖**（打包注意）：`pi-ai` 依赖 `openai`、`@anthropic-ai/sdk`、惰性 `@google/genai`；`pi-agent-core` 依赖 `typebox`、`yaml`、`diff`、`ignore`、`@earendil-works/pi-ai`、`@earendil-works/pi-telemetry`。`pi-ai` 另有 `./bun-oauth`、`./oauth`、`./compat` 子路径，只有引入了才会拖 Bun 相关运行时。

### 7.1 ESM / 动态 import 的 bundler 注意事项（重要）

- `pi-ai` 用 **bundler-opaque 的动态 import（variable specifier）** 做惰性加载，例如 `lazyApi(load)`、`lazyOAuth({ load })` 内部是 `import(specifier)`（specifier 是变量，非字面量）来加载 `./api/*`、`./providers/*`。这意味着 esbuild/webpack 无法静态分析这些依赖：
  - **Next.js**：服务端请把这三个包加进 `serverExternalPackages`（Next 13+；否则 webpack/turbopack 可能 resolve 不到 `dist/api/*`、`dist/providers/*` 子路径而报错）。
  - **esbuild/webpack/Vite（Electron 主进程打包）**：把这些 `@earendil-works/*` 包 `external`（或确保 `./api/*`、`./providers/*` subpath 正确映射到其 `dist` 文件）。
- 顶层 package `exports` 只暴露了有限子路径，**不要** deep import `dist/...` 内部文件（`exports` 未开放 `./*` 时会被拒）；请用每个包的 public subpath，例如：
  - `@earendil-works/pi-agent-core/node`
  - `@earendil-works/pi-ai/api/openai-completions`、`@earendil-works/pi-ai/providers/openai`
  - `@earendil-works/pi-coding-agent/client`、`@earendil-works/pi-coding-agent/rpc-entry`
  - `@earendil-works/pi-client/unix`
- `pi-client`/`pi-protocol` 的 CBOR 编解码是纯 JS，无 WASM 依赖。

---

## 8. 三种嵌入方式的取舍对照（结论）

| 方式 | 包 | 适合 | 关键点 |
|---|---|---|---|
| `Agent`（低层） | `pi-agent-core` | 完全自控 transcript/tools，只要 LLM 循环 | 无 cwd/持久化/内置工具，需自己给 `streamFn`/`convertToLlm`/`AgentTool[]` |
| `AgentHarness`（中层） | `pi-agent-core` | 要 JSONL 持久化/压缩/分支，自备 tools | `Tools` 手动构造；`SessionRepo` 手动接 |
| `createAgentSession`+`AgentSession`（高层） | `pi-coding-agent` | **开箱即用**：cwd+内置工具+系统提示+会话恢复 | 用 `ModelRuntime.registerProvider` 接自定义 provider；`SessionManager` 做续接 |
| `PiClient`/`RemoteSession`（CBOR） | `pi-client`/`pi-protocol` | 独立 `pi` 子进程（沙箱/崩溃隔离） | 需另起 pi server 进程；`prompt` 返回快照、增量走 `onEvent` |

---

## 9. 附：CBOR 客户端 & JSON-lines RPC（独立进程两种 remote 方式）

### 9.1 `pi-client`（`pi-client/dist/client.d.ts`、`session-handle.d.ts`、`unix.d.ts`）

```ts
export declare class PiClient {
  constructor(options: PiClientOptions);   // { transportFactory: ByteTransportFactory, maxFrameLength?, onListenerError? }
  static connect(options: PiClientOptions): Promise<PiClient>;
  connect(): Promise<ServerSnapshot>; reconnect(): Promise<ServerSnapshot>;
  disconnect(reason?: string): void;
  subscribe(listener: (snapshot: ServerSnapshot) => void): Unsubscribe;
  onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
  onConnectionStateChange(listener: (change: ConnectionStateChange) => void): Unsubscribe;
  listSessions(): Promise<readonly SessionMetadata[]>;
  createSession(options?: CreateSessionOptions): Promise<PiSessionHandle>;  // {cwd?, name?, model?, thinkingLevel?}
  attachSession(sessionId: string): Promise<PiSessionHandle>;
  acquireSession(sessionId: string, options: AcquireSessionOptions): Promise<PiSessionHandle>; // {mode:"shared"|"exclusive"}
  dispose(): Promise<void>; [Symbol.asyncDispose](): Promise<void>;
}

export interface SessionLease extends AsyncDisposable {
  readonly id: string; readonly active: boolean; readonly attached: boolean;
  readonly snapshot: SessionSnapshot | undefined;
  subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe;
  onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
  detach(): Promise<void>; dispose(): Promise<void>;
  prompt(text: string): Promise<SessionSnapshot>;
  steer(text: string): Promise<SessionSnapshot>;
  abort(): Promise<SessionSnapshot>;
  setModel(model: ModelRef): Promise<SessionSnapshot>;
  setThinking(thinkingLevel: ThinkingLevel): Promise<SessionSnapshot>;
}
export type PiSessionHandle = SessionLease;

// Node Unix socket 传输工厂：
// import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
export declare function createUnixTransportFactory(options: UnixTransportOptions): ByteTransportFactory;
// UnixTransportOptions = { path: string; maxPendingBytes?: number }
```

`pi-coding-agent/client` 的 `RemoteSession`（更厚的包装，`pi-coding-agent/dist/client/remote-session.d.ts`）：

```ts
export declare class RemoteSession {
  static open(client: PiClient, sessionId: string, options?): Promise<RemoteSession>;
  open(sessionId: string): Promise<void>;
  static create(client: PiClient, createOptions: CreateRemoteSessionOptions, options?): Promise<RemoteSession>;
  create(options: CreateRemoteSessionOptions): Promise<void>;   // { cwd: string; model?; thinkingLevel? }
  submit(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(model: ModelRef): Promise<void>; setThinking(thinkingLevel: ThinkingLevel): Promise<void>;
  get state(): RemoteSessionState;   // { lifecycle: "unbound"|"ready"|"busy"(op)|"disposed"; snapshot?; transcript: readonly TranscriptItem[] }
  subscribe(listener: (state: RemoteSessionState) => void): Unsubscribe;
  // .id / .snapshot / .phase / .operation / .models / .sessions / .connectionState / .disposed
  dispose(): Promise<void>; [Symbol.asyncDispose](): Promise<void>;
}
```

服务端侧（要 spawn 的进程）：export `@earendil-works/pi-coding-agent/rpc-entry`（entry），`dist/server/create-harness.d.ts` 的 `createCodingAgentHarness(options: CreateCodingAgentHarnessOptions)`（extends `AgentHarnessOptions` 去掉 `toolContext`/`tools`，加 `env: ExecutionEnv`、`bashCommandPrefix?`、`sessionFile?`、`systemPromptOptions?`）返回 `{ harness, suspended }`；`dist/modes/rpc/rpc-mode.d.ts` 的 `runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never>` 即 JSON-lines headless 模式。

### 9.2 JSON-lines RPC（`pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`）

命令（stdin JSON-lines，`id?` 关联）：`prompt {message, images?, streamingBehavior?}` / `steer` / `follow_up` / `abort` / `new_session` / `get_state` / `set_model {provider, modelId}` / `cycle_model` / **`get_available_models`** / `set_thinking_level` / `cycle_thinking_level` / `get_available_thinking_levels` / `set_steering_mode` / `set_follow_up_mode` / `compact` / `set_auto_compaction` / `set_auto_retry` / `abort_retry` / `bash` / `abort_bash` / `get_session_stats` / `export_html` / `switch_session` / `fork {entryId}` / `clone` / `get_fork_messages` / `get_entries` / `get_tree` / `get_last_assistant_text` / `set_session_name` / `get_messages` / `get_commands`。

`RpcSessionState`（`get_state` 返回）：`{ model?, thinkingLevel, isStreaming, isCompacting, steeringMode, followUpMode, sessionFile?, sessionId, sessionName?, autoCompactionEnabled, messageCount, pendingMessageCount }`。

---

## 10. 「未核实」/ 注意事项汇总

1. **`continueSession` stale doc**：`createAgentSession` docstring 示例仍写 `continueSession: true` / `SessionManager.inMemory()`，但 **`continueSession` 不是 0.84.2 `CreateAgentSessionOptions` 的字段**。续接 = `SessionManager.continueRecent()` / `.open()`（+ `createAgentSessionServices`/`createAgentSessionFromServices`）。
2. **MCP**：五个包 0.84.2 无内置 MCP；是否存在独立 `pi-mcp-adapter` 包**未核实**（未做 npm 全量搜索）。
3. **无 `/v1/models` 自动拉取**：自定义端点需自己实现 `refreshModels`/`fetchModels`。
4. **内置 provider 工厂零参**：`openaiProvider()`/`anthropicProvider()` 不接 baseUrl/apiKey；自定义一律走 `ProviderConfigInput` / `Model.baseUrl`+`headers`+`compat` + 自定义 `ProviderAuth.apiKey.resolve()`（或 `models.json` 的 `apiKey`/`!command`/`$ENV`）。

### 主要参考文件（解包 tarball 内）

- `pi-ai/dist/{types,models,providers/{openai,anthropic,all},auth/types,models-store}.d.ts`
- `pi-agent-core/dist/{agent,types,node,harness/agent-harness,harness/types,harness/tools/*}.d.ts`
- `pi-coding-agent/dist/{index,core/{sdk,agent-session,model-registry,model-runtime,provider-composer,session-manager,tools/index},client/*,modes/rpc/rpc-types,server/create-harness}.d.ts`
- `pi-client/dist/*.d.ts`
- `pi-protocol/dist/schemas.d.ts`
