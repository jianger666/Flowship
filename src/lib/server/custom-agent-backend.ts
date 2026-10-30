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
 *   - compaction_start/end → 合成 SDKMessage（事件流「正在压缩上下文…」过程行）
 *   - agent_settled       → run 结束（wait 返回 finished/cancelled）
 *   - assistant stopReason=error → wait 返回 error（pi 不抛，写在会话消息里；
 *     缺 finish_reason 的残缺收尾除外，当 finished）
 *
 * MCP 已桥成 customTools（`mcp-tool-bridge.ts`）；子 agent 用进程内嵌套会话。
 */

import { existsSync } from "node:fs";
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
  SettingsManager,
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
  EMPTY_REPLY_MESSAGE,
  RETRY_INTERRUPTED_TOOL_RESULT,
  assistantMessageHasOutput,
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
  catalogPiInputModalities,
  getModelsDevIndex,
  lookupCatalogReasoning,
} from "@/lib/server/models-dev-catalog";
import { mcpDisplayName } from "@/lib/mcp-tool-name";
import {
  catalogFromModelOptions,
  currentEffortValue,
  formatModelCatalog,
  resolveSubagentModel,
  SubagentUsageError,
  subagentNeedsCatalog,
  wantsModelList,
  type ModelCatalogEntry,
  type SubagentRequest,
} from "@/lib/subagent-spec";

import { dataRoot } from "./data-root";
import { flowShipTools } from "./flowship-tools";
import { listModelOptions } from "./model-catalog";
import { connectMcpServer, type BridgedMcpServer } from "./mcp-tool-bridge";
import {
  buildCodingToolDefs,
  buildGitTokenFreeBashTool,
  buildNativeToolAliasWrappers,
  buildReadOnlyToolDefs,
  READONLY_CUSTOM_TOOL_NAMES,
} from "./pi-coding-tools";
import {
  startSubagentRun,
  type SubagentRunHandle,
} from "./subagent-transcript";
import { withModelBudget, type ModelBudgetSpill } from "./tool-output-budget";
import { loadSkillsForTask } from "./skills-loader";
import { injectSdkRgPath } from "./sdk-platform-bin";

const PROVIDER_ID = "flowship-custom";
// pi 原生里名字跟规范面一致的内置工具（read/grep/edit/write）；
// bash→shell、find→glob、delete/task 由 buildCodingToolDefs 补成 customTools。
// write/edit/read 另有同名 custom 包装（认 Cursor 字段别名、盖掉 builtin）。
const NATIVE_TOOLS = ["read", "edit", "write", "grep"];
// 子 agent 用 pi 原生全套（读/写/跑命令），不带 task / 系统工具——防递归与副作用
const SUBAGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
// subagentType=explore：真只读（不给 bash / edit / write）
const SUBAGENT_READONLY_TOOLS = ["read", "grep", "find", "ls"];
// 自定义端点元数据缺省（用户 endpoint 不提供时给合理兜底）。
// 窗口优先用 models.dev limit.context；缺目录才 12.8 万。muse-spark 实际 1M，
// 写死 12.8 万会过早 overflow，压完剩余输出配额被卡死、界面上看不到回复。
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

// pi 的 agent 配置 / 会话文件都收进 app 数据目录、不污染 ~/.pi、也不和用户装的 pi 撞车
const piAgentDir = (): string => path.join(dataRoot(), "pi-agent");

/**
 * 统一 skill 注入管道：fe 自管 loader（skills-loader.ts，含 agentskills 标准目录）
 * 是唯一来源；pi 自带发现只作兜底——与 loader 同名的滤掉，防 pi 的
 * <available_skills> 块和 fe 的「## Skills」段双渲染 / 版本漂移。
 */
/** @internal 导出仅供单测（验证项目目录不被信任） */
export const buildResourceLoader = async (cwd: string) => {
  const owned = new Set(
    (await loadSkillsForTask([cwd]).catch(() => [])).map((s) => s.name),
  );
  // 项目目录一律「不受信任」：pi 对受信项目会自动执行 `<cwd>/.pi/extensions/*.ts`
  // （在 Flowship server 进程内、无沙箱），并用 `.pi/SYSTEM.md` 替换系统提示词、
  // `.pi/settings.json` 追加 packages——被绑定的仓库里只要有人放一个文件就是 RCE，
  // 不需要任何提示注入。untrusted 后只剩 agentDir（我们自己的 pi-agent 数据目录）的
  // 全局资源；项目 skill 由上面 fe 自管 loader（含 .agents/skills）负责，不受影响。
  // loader 与 session 必须共用同一个 settingsManager：createAgentSession 缺省会自己
  // `SettingsManager.create(cwd, agentDir)` 出一个默认受信的，读到项目 settings。
  const settingsManager = SettingsManager.create(cwd, piAgentDir(), {
    projectTrusted: false,
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: piAgentDir(),
    settingsManager,
    skillsOverride: (base) => ({
      skills: base.skills.filter((s) => !owned.has(s.name)),
      diagnostics: base.diagnostics,
    }),
  });
  await loader.reload();
  return { resourceLoader: loader, settingsManager };
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
  local?: { cwd?: string; settingSources?: unknown; customTools?: unknown };
  // cursor 形状里带 mcpServers；pi 无 MCP、用户 MCP 在这里桥成 customTools
  mcpServers?: unknown;
  /** 正式会话身份；无值则不挂交卷/提问等系统工具（oneshot / 受限答疑） */
  callerToken?: string;
  /**
   * 任务 id：透传给 withModelBudget 做超预算全量落盘（V2）。
   * 无值（title 生成等 oneshot）→ V1 后缀，不落盘。
   */
  taskId?: string;
  /** 只读轮次：白名单只留读类 customTools（read/grep），shell/写类/子代理/MCP 全不给 */
  readOnly?: boolean;
  /**
   * 本会话的 shell / 子代理 bash 不继承 FLOWSHIP_GITLAB_TOKEN（需求群非属主答疑旁路传 true，N3-01）。
   * 显式标记而不是「无 callerToken」推断：属主的 one-shot 同样无 callerToken、却该保留 token。
   * 只对 pi provider 有效；Cursor provider 的 shell 继承 server env、摘不掉（见 git-token-env.ts）。
   */
  omitGitToken?: boolean;
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
  imageInput: boolean,
  contextWindow: number,
): ModelConfigEntry => {
  const entry: ModelConfigEntry = {
    id: modelId,
    name: modelId,
    api: face,
    reasoning: fields.reasoning,
    // 目录标明多模态才让 pi 把 read 到的图塞进请求；否则会换成空占位
    input: catalogPiInputModalities(imageInput),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
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
  imageInput: boolean,
  contextWindow: number,
): Model<never> => {
  const model = {
    id: modelId,
    name: modelId,
    api: face,
    provider: PROVIDER_ID,
    baseUrl: customSdkBaseUrlForFace(input.baseUrl, face),
    reasoning: fields.reasoning,
    input: catalogPiInputModalities(imageInput),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
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
  // 窗口跟目录走：写死 12.8 万会让 20 万+ 的 muse-spark 过早 overflow，压完没配额写正文
  const contextWindow = hit?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  console.log(
    `[custom-agent] model=${modelId} face=${face} contextWindow=${contextWindow} catalog=${hit?.contextWindow ?? "miss"}`,
  );
  const runtime = await ModelRuntime.create({ modelsPath: null });
  const sdkBase = customSdkBaseUrlForFace(input.baseUrl, face);
  // 注册 provider 让 runtime 能解析 apiKey + api 流实现；model 直接构造引用同 provider
  runtime.registerProvider(PROVIDER_ID, {
    name: "Custom",
    baseUrl: sdkBase,
    apiKey: input.apiKey,
    api: face,
    models: [
      buildModelConfig(
        modelId,
        face,
        fields,
        Boolean(hit?.imageInput),
        contextWindow,
      ),
    ],
  });
  return {
    runtime,
    model: buildModel(
      modelId,
      input,
      face,
      fields,
      Boolean(hit?.imageInput),
      contextWindow,
    ),
    thinkingLevel,
  };
};

// ----------------- Flowship 自有工具桥接（pi customTools） -----------------

/**
 * 用户 MCP 仍走 mcpServers；系统工具不再从 URL ?caller= 解身份，
 * 由 facade 传入的 callerToken 闭包进 handler。
 */
const extractUserMcpServers = (
  mcpServers: unknown,
): Record<string, McpServerConfig> => {
  if (!mcpServers || typeof mcpServers !== "object") return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(mcpServers as Record<string, unknown>)) {
    // 旧会话配置里可能残留 HTTP 注入名，系统工具已直连、不桥
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
          // 第 3 参 signal（pi 规范）必须往下传：用户点停止 / 任务被停时，这次 MCP 调用才能立刻中止
          // （之前丢掉它，点停止后要一直等到 SDK 的 60 秒超时，R14 Q11-06）
          execute: async (
            _toolCallId: string,
            params: unknown,
            signal?: AbortSignal,
          ) => {
            const r = await t.call(params as Record<string, unknown>, { signal });
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

/**
 * create / resume 的失败路径兜底关闭 MCP 桥：此时 adapter 没造出来、没人会再调 closeAll。
 * 清理本身绝不能盖掉原始错误（closeAll 理论上不抛，这里再兜一层）。
 */
const closeMcpQuietly = (mcp: { closeAll: () => unknown }): void => {
  try {
    void Promise.resolve(mcp.closeAll()).catch(() => {});
  } catch {
    /* noop */
  }
};

type PiRuntime = Awaited<ReturnType<typeof ModelRuntime.create>>;

/** 父会话的模型上下文：沿用模型时直接复用 runtime，换模型 / 换 effort 才按 input 重建 */
export interface SubagentParent {
  input: CustomAgentInput;
  runtime: PiRuntime;
  model: Model<never>;
  thinkingLevel: ReturnType<typeof thinkingLevelFromParams>;
}

/**
 * 子代理可选模型清单（当前 provider）。拿不到（端点没有 /models、超时）就返回 null——
 * 此时不校验 model id（自定义端点常有清单外的可用 id），不能因为列清单失败拦掉子任务。
 */
const loadSubagentCatalog = async (
  input: CustomAgentInput,
): Promise<ModelCatalogEntry[] | null> => {
  try {
    const options = await listModelOptions({
      kind: "custom",
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      format: input.format,
    });
    return catalogFromModelOptions(options);
  } catch (err) {
    console.warn(
      "[custom-agent] 子代理模型清单拿不到、跳过校验：",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
};

/**
 * pi 子会话事件 → 与 Cursor 同形的 SDKMessage（给子代理过程记录喂；翻译口径同 `PiRunAdapter.onEvent`
 * 里翻主会话的那几类：text_delta / thinking_delta / toolcall_end / tool_execution_end；另外
 * auto_retry_start 翻成一条只当「封口」信号的合成消息，见下面的分支）。
 * `toolArgs` 缓存 toolcall_end 的入参：执行结束事件里没有入参，要靠它补。
 * 纯函数（只读写传进来的缓存），不认识的事件返回空数组。
 */
export const piSubagentEventMessages = (
  ev: AgentSessionEvent,
  toolArgs: Map<string, { name: string; args: unknown }>,
): SDKMessage[] => {
  if (ev.type === "message_update") {
    const inner = ev.assistantMessageEvent;
    if (!inner) return [];
    if (inner.type === "text_delta" && inner.delta) {
      return [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: inner.delta }] },
        } as unknown as SDKMessage,
      ];
    }
    if (inner.type === "thinking_delta" && inner.delta) {
      return [{ type: "thinking", text: inner.delta } as unknown as SDKMessage];
    }
    if (inner.type === "toolcall_end" && inner.toolCall) {
      const tc = inner.toolCall;
      const name = mcpDisplayName(tc.name);
      toolArgs.set(tc.id, { name, args: tc.arguments });
      return [
        {
          type: "tool_call",
          call_id: tc.id,
          name,
          args: tc.arguments,
          status: "running",
        } as unknown as SDKMessage,
      ];
    }
    return [];
  }
  if (ev.type === "tool_execution_end") {
    const cached = toolArgs.get(ev.toolCallId) ?? {
      name: mcpDisplayName(ev.toolName),
      args: {},
    };
    return [
      {
        type: "tool_call",
        call_id: ev.toolCallId,
        name: cached.name,
        args: cached.args,
        status: ev.isError ? "error" : "completed",
        result: ev.result,
      } as unknown as SDKMessage,
    ];
  }
  if (ev.type === "auto_retry_start") {
    // pi 要把这条回复整个重新生成一遍。过程记录只认 thinking / assistant_message / tool_call / tool_result 四类，
    // 所以这不是一条说明（info 会被丢掉），只是个「封口」信号：记录器收到后，重新生成的文本另起一条，
    // 不和出错的半截焊成一段（R14 Q11-02）。不带 pi 的错误原文。
    return [{ type: "auto_retry_start" } as unknown as SDKMessage];
  }
  return [];
};

/** 起一份 pi 子代理过程记录；没 taskId（一次性调用）/ 起不来 → undefined（只告警） */
const startPiSubagentRecord = (input: {
  taskId: string | undefined;
  toolCallId: string | undefined;
  req: SubagentRequest;
  model: string;
  effort: string | undefined;
}): SubagentRunHandle | undefined => {
  if (!input.taskId) return undefined;
  try {
    return startSubagentRun({
      taskId: input.taskId,
      provider: "pi",
      // 与 Cursor 路径的 describeJob 同口径：没写 description 就取任务书开头
      description:
        input.req.description?.trim() ||
        input.req.prompt.replace(/\s+/g, " ").trim().slice(0, 30) ||
        "子任务",
      prompt: input.req.prompt,
      model: input.model,
      effort: input.effort,
      explore: input.req.subagentType === "explore",
      toolCallId: input.toolCallId,
    });
  } catch (err) {
    console.warn(
      "[custom-agent] 子代理过程记录起不来（已忽略、照常跑）：",
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
};

const safeFinishRecord = (
  rec: SubagentRunHandle | undefined,
  outcome: Parameters<SubagentRunHandle["finish"]>[0],
): void => {
  if (!rec) return;
  try {
    rec.finish(outcome);
  } catch (err) {
    console.warn(
      "[custom-agent] 子代理过程记录收尾出错（已忽略）：",
      err instanceof Error ? err.message : err,
    );
  }
};

/**
 * 进程内嵌套子会话：给 task 工具用——起一个子 agent、跑完返最终文本。
 *
 * - 模型 / effort：缺省沿用父会话；显式指定则在**当前 provider** 内解析（见 subagent-spec），
 *   无效直接抛 SubagentUsageError，不静默回退。
 * - subagentType=explore 只给 read / grep / find / ls（真只读）；general 才有 bash / edit / write。
 * - signal 取消时中止子会话（父会话被停后子会话不再空转烧 token）。
 * - 子会话自己的模型失败（鉴权 / 模型名被端点拒 / 5xx）不吞成「无输出」，抛出去让父模型看到原因。
 * 子 agent 不带 task / 系统工具——防递归与副作用。
 */
export const runPiSubagent = async (
  req: SubagentRequest,
  signal: AbortSignal | undefined,
  ctx: {
    parent: SubagentParent;
    cwd: string;
    taskId?: string;
    /** 父会话里这次 `task` 调用的 callId：过程记录据此绑到事件流卡片 */
    toolCallId?: string;
  },
): Promise<string> => {
  const { parent, cwd, taskId, toolCallId } = ctx;
  const parentSel = {
    id: parent.input.model?.id?.trim() || "default",
    params: parent.input.model?.params,
  };

  const catalog = subagentNeedsCatalog(req)
    ? await loadSubagentCatalog(parent.input)
    : null;
  if (wantsModelList(req.model)) {
    return catalog
      ? `当前模型：${parentSel.id}\n可选模型（当前 provider）：\n${formatModelCatalog(catalog)}`
      : "拿不到当前 provider 的模型清单（端点没有 /models 或请求失败）；可直接填模型 id，或省略 model 沿用当前模型。";
  }
  const resolved = resolveSubagentModel(req, parentSel, catalog);
  if (!resolved.ok) throw new SubagentUsageError(resolved.error);

  // 沿用模型且没覆盖 effort → 复用父 runtime（省一次构建）；否则按解析结果重建
  const child =
    resolved.inherited && !resolved.effort
      ? {
          runtime: parent.runtime,
          model: parent.model,
          thinkingLevel: parent.thinkingLevel,
        }
      : await buildRuntime({ ...parent.input, model: resolved.model });
  // effort 被 pi 侧丢掉（目录不认这档）就不能假装生效了
  if (resolved.effort && child.thinkingLevel === undefined) {
    throw new SubagentUsageError(
      `模型「${resolved.model.id}」的思考档目录里不认 effort=「${resolved.effort}」，不会生效；换一档或去掉 effort。`,
    );
  }
  if (signal?.aborted) throw new Error("子任务已取消");

  const { session } = await createAgentSession({
    cwd,
    agentDir: piAgentDir(),
    ...(await buildResourceLoader(cwd)),
    modelRuntime: child.runtime,
    model: child.model,
    tools:
      req.subagentType === "explore"
        ? [...SUBAGENT_READONLY_TOOLS]
        : [...SUBAGENT_TOOLS],
    // 内层同样落盘（同 task 配额），文件名加 sub- 前缀防与父会话 callId 撞车；
    // 内层工具调用不进父会话事件流，落盘只给模型读
    customTools: [
      // 父会话要求不带 GitLab token（旁路，omitGitToken）：general 子代理的原生 bash 也得摘，
      // 否则 `task` → 子代理 `printenv` 就绕过了父会话 shell 工具的摘除（同名 customTool 盖掉原生 bash）
      ...(parent.input.omitGitToken === true && req.subagentType !== "explore"
        ? [buildGitTokenFreeBashTool(cwd)]
        : []),
      ...buildNativeToolAliasWrappers(
        cwd,
        taskId ? { taskId, filePrefix: "sub-" } : undefined,
      ),
    ],
    thinkingLevel: child.thinkingLevel,
    // 子 agent 不落会话文件（一次性）
    sessionManager: SessionManager.inMemory(cwd),
  });
  const onAbort = () => {
    void Promise.resolve(session.abort()).catch(() => {});
  };
  let rec: SubagentRunHandle | undefined;
  try {
    signal?.addEventListener("abort", onAbort, { once: true });
    // 创建期间可能已被取消（上面的 aborted 检查与监听挂上之间有 await）。
    // 不能在这里调 session.abort()：prompt() 还没开始，abort 是空操作，子代理会照常把整轮跑完。
    // 直接抛错、不往下走到 prompt（这里到 prompt 之间没有 await，不会再漏窗口）；finally 会 dispose 会话。
    if (signal?.aborted) throw new Error("子任务已取消");
    let result = "";
    // 当前这条 assistant 消息开始时 result 已经有多长：pi 自动重试要把「出错的那一条」整个重新生成，
    // 只该丢它的半截；result 是整个子会话所有轮次累计的，更早轮次已经说完的正文要留（R14 Q11-02）
    let msgStartLen = 0;
    // 过程记录（详情面板）：起不来 / 中途出错都只告警，绝不影响子代理本身
    rec = startPiSubagentRecord({
      taskId,
      toolCallId,
      req,
      model: resolved.model.id,
      effort: resolved.effort ?? currentEffortValue(resolved.model.params),
    });
    const toolArgs = new Map<string, { name: string; args: unknown }>();
    // 用对象承接：闭包里赋值，直接 let 会被 TS 窄化成 null
    const fail: { prompt: string | null } = { prompt: null };
    await new Promise<void>((resolve) => {
      const unsub = session.subscribe((ev) => {
        if (rec) {
          try {
            for (const m of piSubagentEventMessages(ev, toolArgs)) rec.onMessage(m);
          } catch (err) {
            console.warn(
              "[custom-agent] 子代理过程记录出错（已忽略）：",
              err instanceof Error ? err.message : err,
            );
          }
        }
        if (ev.type === "message_update") {
          const inner = ev.assistantMessageEvent;
          if (inner?.type === "text_delta" && inner.delta) result += inner.delta;
        } else if (ev.type === "message_start") {
          // pi 为每条 assistant 消息都发 message_start（流没来得及发 start 就出错的，结束 / 出错时补发，
          // 见 pi-agent-core 的 agent-loop），所以重试开始时最近一次 assistant 的就是出错那条的起点。
          // 只认 assistant：user / toolResult 的 message_start 不是「这条回复的起点」
          // `?.`：事件是 pi 的内部事件、类型上 message 必填，但合成 / 异常事件缺它时这里抛错会在 pi 的
          // _emit（for…of 直接调监听者、没有 try/catch）里中断后面的监听者（R14 Q11-03 顺带的 P3）
          if (ev.message?.role === "assistant") msgStartLen = result.length;
        } else if (ev.type === "auto_retry_start") {
          // pi 要把这条回复整个重新生成一遍：只丢出错那条的半截，免得把「半截 + 全文」当子任务结果还给父会话；
          // 更早轮次的正文留着（R14 Q11-02）。没收到过 message_start（合成 / 旧事件）→ 起点 0，退化成整个清零
          result = result.slice(0, msgStartLen);
        } else if (ev.type === "agent_end" && !ev.willRetry) {
          unsub();
          resolve();
        } else if (ev.type === "agent_settled") {
          unsub();
          resolve();
        }
      });
      void session.prompt(req.prompt).catch((err) => {
        fail.prompt = err instanceof Error ? err.message : String(err);
        unsub();
        resolve();
      });
    });
    if (signal?.aborted) throw new Error("子任务已取消");
    const text = result.trim();
    // pi 把 API 失败写在 assistant 消息里、prompt() 不抛；只认最后一条 assistant
    const failure =
      fail.prompt ??
      settleErrorFromTranscript(
        session.state.messages,
        session.state.errorMessage?.trim() ?? null,
      );
    if (failure) {
      throw new Error(
        text ? `${failure}\n（子任务中途失败，已产出的部分内容：）\n${text}` : failure,
      );
    }
    safeFinishRecord(rec, { status: "done", result: text || "(子任务无输出)" });
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    safeFinishRecord(
      rec,
      signal?.aborted || msg === "子任务已取消"
        ? { status: "cancelled" }
        : { status: "failed", error: msg },
    );
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      session.dispose();
    } catch {
      /* noop */
    }
  }
};

/**
 * Flowship 自有工具 + 规范编码工具 → pi ToolDefinition[]。
 * 编码工具（shell/glob/delete/task）由 buildCodingToolDefs 提供、task 的 runSubagent 闭包绑好父会话模型上下文 / cwd。
 */
const buildCustomTools = (
  callerToken: string | undefined,
  cwd: string,
  parent: SubagentParent,
  mcpToolDefs: ToolDefinition[],
  taskId?: string,
): ToolDefinition[] => {
  // V2 落盘配置：全工具共用（编码工具 + MCP 桥接）；无 taskId → V1 后缀
  const spill: ModelBudgetSpill | undefined = taskId ? { taskId } : undefined;
  return [
    ...(callerToken
      ? flowShipTools.map(
        (t) =>
          ({
            name: t.name,
            label: t.label,
            description: t.description,
            parameters: t.parameters,
            // pi 的 execute 第三位是 AbortSignal（Cursor 的 customTool 回调没有）：
            // `wait` 要靠它在 run 被取消时立刻醒；taskId 让停止 / 插话 / 跳过也能按任务唤醒
            execute: async (
              _toolCallId: string,
              params: unknown,
              signal?: AbortSignal,
            ) => {
              const r = await t.handler(
                params as Record<string, unknown>,
                callerToken,
                { ...(taskId ? { taskId } : {}), ...(signal ? { signal } : {}) },
              );
              return { content: r.content, details: undefined };
            },
          }) as unknown as ToolDefinition,
      )
    : []),
    ...buildCodingToolDefs(
      cwd,
      (req, signal, c) =>
        runPiSubagent(req, signal, {
          parent,
          cwd,
          taskId,
          toolCallId: c?.toolCallId,
        }),
      spill,
      // 旁路（无 GitLab 凭证）：shell 摘 token；子代理 bash 在 runPiSubagent 里同口径摘
      { omitGitToken: parent.input.omitGitToken === true },
    ),
    // D1：MCP 桥接工具回包无上限，全包输出预算；flowShipTools（submit_work/ask_user）输出小、不碰
    ...mcpToolDefs.map((d) => withModelBudget(d, spill)),
  ];
};

// ----------------- run 适配器 -----------------

type RunWaitResult = { status: "finished" | "cancelled" | "error"; result?: string };

/**
 * pi 事件 → Flowship run 的翻译器（一次 send 一个）。
 * 导出只为事件级单测（tests/pi-run-adapter.test.ts 喂合成事件，不起 HTTP / 真会话）；业务代码走 createCustomAgent。
 */
export class PiRunAdapter {
  id: string;
  requestId: string;
  private buffer: SDKMessage[] = [];
  private toolArgs = new Map<string, { name: string; args: unknown }>();
  /**
   * 已推出 running、还没等到执行结果的工具调用 id。pi 对「以错误收尾的 assistant 消息」不会执行里面的工具，
   * 流被掐断之后这些调用永远等不到 tool_execution_end——自动重试开始时据此补成 error，
   * 卡片才不会一直转圈（R14 Q11-02）。
   */
  private openToolCallIds = new Set<string>();
  private ended = false;
  private cancelled = false;
  /** pi 把 API 失败写在 assistant 消息里，先记下、settle 时带出去 */
  private lastAssistantError: string | null = null;
  /**
   * 本轮（含 pi 内部自动重试，它们在同一个 run 里）是否出现过用户看得见的产出：
   * 非空白正文 / 工具调用。思考不算。agent_settled 时一路没产出 = 空回复（R14 Q11-01），见 settleWithoutError。
   * 按整个 run 累计、不看最后一条 assistant：工具跑完后模型一句话不说是正常的。
   */
  private sawOutput = false;
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

  /** subscribe 后由 createCustomAgent 绑定；收尾时 settle() 会在微任务里调用它退订（R14 Q11-03） */
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
    // 收尾即退订（R14 Q11-03）。之前 unsub 只存不用：同一会话每多一轮，这个 run 的监听者就多留一个，
    // 收尾后下一轮的增量（bash 输出 / 文本 / 工具调用）还会灌进它的 onDelta / onStep。
    // 必须放到微任务里退、不能同步：settle 常在 pi 的事件派发里被调用，pi 的 _emit 是 for…of 遍历监听数组、
    // 退订是 splice，回调里同步退订会让排在后面的监听者漏收这一次事件。
    // 为什么微任务就够：下一轮的事件来自 provider 流 / 子进程输出 / 工具执行，至少隔一个异步边界（宏任务），
    // 一定在这次退订之后才到，所以下一轮的增量灌不进这个旧 run。
    // 注意：调用方的 await wait() 若在 settle 之前就已挂起，它的续跑排在这次退订之前（endResolve 先于 queueMicrotask）——
    // 那一刻它最多只是去订阅下一轮；而 pi 的退订是按监听函数自己 indexOf + splice，不会误删下一轮刚订阅的那个。
    queueMicrotask(() => {
      try {
        this.unsub?.();
      } catch {
        /* 退订失败不能拖垮收尾：最多是回到旧行为（监听者留着） */
      }
      this.unsub = null;
    });
  }

  /**
   * 没有错误时的收尾：取消 → cancelled；一路没产出 → 空回复报错；否则 finished。
   *
   * 为什么不能一律 finished：端点地址填成网页（200 + HTML）、网关吞了正文、模型直接空 stop，
   * pi 都当正常结束（supportsFinishReason 已关，流里没 finish_reason 时 pi 补成 stop），
   * 用户看到「已完成」却什么都没有（R14 Q11-01）。取消优先：取消不是模型的错。
   *
   * 两处调用：agent_settled（没有错误），以及 auto_retry_end 失败但只是「缺 finish_reason」这种残缺收尾
   * （fatalAssistantError 为 null）。后者在当前配置下基本走不到——compat 已关 supportsFinishReason，
   * pi 不再抛 Stream ended without finish_reason——但事件级可测（tests/pi-run-adapter.test.ts）；
   * 统一走这里，免得以后 compat / pi 变动让它重新可达时，空回复的洞又从这条路径漏出去。
   */
  private settleWithoutError(): void {
    if (this.cancelled) {
      this.settle({ status: "cancelled" });
      return;
    }
    if (!this.sawOutput) {
      this.settle({ status: "error", result: EMPTY_REPLY_MESSAGE });
      return;
    }
    this.settle({ status: "finished" });
  }

  onEvent(ev: AgentSessionEvent): void {
    try {
      switch (ev.type) {
        case "message_update": {
          const inner = ev.assistantMessageEvent;
          if (!inner) break;
          if (inner.type === "text_delta" && inner.delta) {
            // 空白 delta（只有换行 / 空格）不算产出：整轮只有空白，屏幕上就是个空气泡
            if (inner.delta.trim() !== "") this.sawOutput = true;
            this.push({
              type: "assistant",
              message: { content: [{ type: "text", text: inner.delta }] },
            } as unknown as SDKMessage);
          } else if (inner.type === "thinking_delta" && inner.delta) {
            // 思考不计入 sawOutput：只想不说，用户这边仍是一条空回复
            this.push({ type: "thinking", text: inner.delta } as unknown as SDKMessage);
          } else if (inner.type === "toolcall_end" && inner.toolCall) {
            this.sawOutput = true;
            const tc = inner.toolCall;
            const displayName = mcpDisplayName(tc.name);
            this.toolArgs.set(tc.id, { name: displayName, args: tc.arguments });
            this.openToolCallIds.add(tc.id);
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
          // 兜底：只给整条消息、不发 text_delta 的 provider 也算有产出（以整条 assistant 消息为权威口径）
          if (assistantMessageHasOutput(ev.message)) this.sawOutput = true;
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
        case "auto_retry_start": {
          // pi 要把这条回复整个重新生成一遍，而出错的那半截已经推给 UI 了（R14 Q11-02）。
          // ① 半截里已经 running、却永远等不到执行结果的工具调用补成 error：pi 对出错的 assistant 消息不执行工具，
          //    不补的话卡片一直转圈，重试后模型再发同样的调用又会多出一张
          for (const callId of this.openToolCallIds) {
            const cached = this.toolArgs.get(callId) ?? { name: "tool", args: {} };
            this.push({
              type: "tool_call",
              call_id: callId,
              name: cached.name,
              args: cached.args,
              status: "error",
              result: RETRY_INTERRUPTED_TOOL_RESULT,
            } as unknown as SDKMessage);
            this.fireDelta({
              type: "tool-call-completed",
              callId,
              toolCall: {
                type: cached.name === "bash" ? "shell" : cached.name,
                result: {
                  status: "error",
                  value: { output: RETRY_INTERRUPTED_TOOL_RESULT },
                },
              },
            } as unknown as InteractionUpdate);
          }
          this.openToolCallIds.clear();
          // ② 合成边界消息交给 sdk-message-handler：在那里把半截正文落成独立一条、再写一行说明，
          //    重新生成的全文才是新的一条（不分开会被焊成「半截 + 全文」）。不删已经流出的字
          this.push({
            type: "auto_retry_start",
            attempt: ev.attempt,
            maxAttempts: ev.maxAttempts,
            delayMs: ev.delayMs,
          } as unknown as SDKMessage);
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
          if (err) {
            this.settle({ status: "error", result: err });
          } else {
            // 缺 finish_reason 这种残缺收尾不算出错：正文已在就按成功收尾（避免再等 agent_settled）；
            // 但一路没产出仍是空回复（Q11-01）、取消优先——与 agent_settled 同一套口径，见 settleWithoutError
            this.settleWithoutError();
          }
          break;
        }
        case "tool_execution_end": {
          // 兜底：toolcall_end 没来（或没带 toolCall）但工具确实跑了，也不是空回复
          this.sawOutput = true;
          this.openToolCallIds.delete(ev.toolCallId);
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
        case "compaction_start": {
          // 合成消息给 sdk-message-handler 落过程行；不在这里 settle——压缩 = 这轮还没结束
          this.push({
            type: "compaction_start",
            reason: ev.reason,
          } as unknown as SDKMessage);
          break;
        }
        case "compaction_end": {
          this.push({
            type: "compaction_end",
            reason: ev.reason,
            aborted: ev.aborted,
            willRetry: ev.willRetry,
          } as unknown as SDKMessage);
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
            // 没有错误：取消 / 空回复（一路没产出）/ 正常结束，见 settleWithoutError
            this.settleWithoutError();
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
  const callerToken = input.callerToken;
  const readOnly = input.readOnly === true;
  const mcp = readOnly
    ? { toolDefs: [] as never[], closeAll: async () => {} }
    : await bridgeUserMcpServers(input.mcpServers);
  // 桥接 MCP 之后任何一步抛错（createAgentSession / 建会话文件 / 工具装配…），adapter 都没造出来，
  // 没有人会再调 closeAll：已经连上的 stdio MCP 子进程会一直活到 app 退出（R14 Q11-05）→ 这里替它收
  try {
    // pi 的 `tools` 选项是「允许工具白名单」，必须把 customTools（含 MCP 桥接工具）
    // 的名字也列进去；否则只传 NATIVE_TOOLS 会把 flowShipTools / 编码工具 / MCP 工具
    // 全部过滤掉，模型只看到 read/edit/write/grep。
    // 只读轮次：白名单 + customTools 双收敛（read/grep/glob/合test-MR，写类 / shell 不给）。
    // 注：旁路 honor-system 后不再传 readOnly，此分支当前无人接线，留作收紧时直接用。
    const customTools = readOnly
      ? buildReadOnlyToolDefs(
          cwd,
          input.taskId ? { taskId: input.taskId } : undefined,
        )
      : buildCustomTools(
          callerToken,
          cwd,
          { input, runtime, model, thinkingLevel },
          mcp.toolDefs,
          input.taskId,
        );
    const { session } = await createAgentSession({
      cwd,
      agentDir: piAgentDir(),
      ...(await buildResourceLoader(cwd)),
      modelRuntime: runtime,
      model,
      thinkingLevel,
      tools: readOnly
        ? [...READONLY_CUSTOM_TOOL_NAMES]
        : [...NATIVE_TOOLS, ...customTools.map((t) => t.name)],
      customTools,
      sessionManager: SessionManager.create(cwd, piSessionDir()),
    });
    const agentId = session.sessionFile ?? session.sessionId;
    return buildAdapter(session, agentId, mcp.closeAll);
  } catch (err) {
    closeMcpQuietly(mcp);
    throw err;
  }
};

/** resume 确定性失败：message 带 code 前缀，日志 / 降级统计可 grep `E_SESSION_` */
const sessionResumeError = (
  code: "E_SESSION_MISSING" | "E_SESSION_EMPTY",
  agentId: string,
): Error & { code: string } => {
  const detail =
    code === "E_SESSION_MISSING"
      ? "Custom session file missing"
      : "Custom session empty";
  const err = new Error(`${code}: ${detail}: ${agentId}`) as Error & {
    code: string;
  };
  err.code = code;
  return err;
};

export const resumeCustomAgent = async (
  agentId: string,
  input: CustomAgentInput,
): Promise<PiAgentAdapter> => {
  injectSdkRgPath();
  const cwd = input.local?.cwd || process.cwd();
  const { runtime, model, thinkingLevel } = await buildRuntime(input);
  const callerToken = input.callerToken;
  const readOnly = input.readOnly === true;
  // agentId 存的是上次的 sessionFile 路径 → SessionManager.open 续接。
  // pi 对缺失文件会静默建空会话（resume「成功」但 messages=[]），随后 send 只有当前句、
  // 连起手 prompt 都没有。缺文件 / 空会话一律抛，让 chat-inject 降级新会话并注入最近对话。
  // 这两项检查必须排在桥接 MCP **之前**（R14 Q11-05）：它们是设计内的确定性失败（降级新会话是常态路径），
  // 先桥再检查的话，每次降级都白连一遍所有 stdio MCP、又不关，泄漏 N 个子进程直到 app 退出。
  if (!existsSync(agentId)) {
    throw sessionResumeError("E_SESSION_MISSING", agentId);
  }
  const sessionManager = SessionManager.open(agentId, piSessionDir(), cwd);
  if (sessionManager.buildSessionContext().messages.length === 0) {
    throw sessionResumeError("E_SESSION_EMPTY", agentId);
  }
  const mcp = readOnly
    ? { toolDefs: [] as never[], closeAll: async () => {} }
    : await bridgeUserMcpServers(input.mcpServers);
  // 桥接 MCP 之后抛错（createAgentSession 等）同样没有 adapter 来关 → 这里收（同 createCustomAgent）
  try {
    // 同 createCustomAgent：白名单必须包含全部 customTools，否则续会话同样丢掉 MCP/编码工具。
    // 只读分支同上，当前无人接线（旁路 honor-system 不传 readOnly），留作收紧时直接用。
    const customTools = readOnly
      ? buildReadOnlyToolDefs(
          cwd,
          input.taskId ? { taskId: input.taskId } : undefined,
        )
      : buildCustomTools(
          callerToken,
          cwd,
          { input, runtime, model, thinkingLevel },
          mcp.toolDefs,
          input.taskId,
        );
    const { session } = await createAgentSession({
      cwd,
      agentDir: piAgentDir(),
      ...(await buildResourceLoader(cwd)),
      modelRuntime: runtime,
      model,
      thinkingLevel,
      tools: readOnly
        ? [...READONLY_CUSTOM_TOOL_NAMES]
        : [...NATIVE_TOOLS, ...customTools.map((t) => t.name)],
      customTools,
      sessionManager,
    });
    return buildAdapter(session, agentId, mcp.closeAll);
  } catch (err) {
    closeMcpQuietly(mcp);
    throw err;
  }
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
    ...(await buildResourceLoader(cwd)),
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
        } else if (ev.type === "auto_retry_start") {
          // pi 要把这条回复整个重新生成一遍：出错的半截丢掉，标题只取最后一遍（R14 Q11-02）
          result = "";
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
