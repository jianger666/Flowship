/**
 * Agent 后端抽象层（v1.2.x 引入自定义 provider）
 *
 * 把「起会话 / 续会话 / 单发 prompt」三个入口收敛到一个 `Agent` facade，
 * 按本窗口的 providerId 分发到两套实现：
 *   - `cursor`：直通 @cursor/sdk（历史行为零变化）
 *   - 自定义 id：走 pi（@earendil-works/pi-coding-agent）承接用户 HTTP API
 *
 * 关键设计：
 * 1. `Agent` facade 的签名与返回值**完全沿用 @cursor/sdk 的类型**（`AgentInstance`
 *    / `AgentRun` 就是 SDK 的 Agent / Run 类型）。custom 后端把自己适配出的对象
 *    cast 成这些形状——四个调用点只改 import、下游事件管线一行不动。
 * 2. **pi 懒加载**：custom-agent-backend（及其拖入的 pi 依赖）只在自定义分支里
 *    动态 `import()`——cursor 默认路径不加载 pi，避免 pi 的 ESM/动态 import
 *    被 webpack 提前拖进 server bundle。
 *
 * 凭据来源：cursor 用调用方传的 apiKey；自定义读 config.json 里对应条目的
 * baseUrl/apiKey/format，调用方传的 apiKey 被忽略。
 */

import { Agent as CursorAgent } from "@cursor/sdk";

import {
  findCustomProvider,
  migrateProviderSettings,
  resolveTaskProvider,
} from "@/lib/agent-provider";
import { withoutHiddenModelSelection } from "@/lib/model-params";
import { isCursorProvider } from "@/lib/types";

import { CURSOR_SUBAGENT_TOOL_NAME } from "@/lib/cursor-subagent-display";

import {
  createCursorSubagentLinkForSession,
  withNativeTaskDisabled,
  type SubagentLink,
} from "./cursor-subagent";
import type { CustomAgentInput } from "./custom-agent-backend";
import { withFlowshipSdkCustomTools } from "./flowship-tools";
import { withCursorJsonlStore } from "./sdk-agent-store";
import { readSettingsFile } from "./settings-fs";

/** 与 @cursor/sdk 的 Agent.create 返回类型一致（下游类型零改动） */
export type AgentInstance = Awaited<ReturnType<typeof CursorAgent.create>>;
/** 与 @cursor/sdk 的 agent.send 返回类型一致 */
export type AgentRun = Awaited<ReturnType<AgentInstance["send"]>>;

/** 与 @/lib/types 的 CustomProviderFormat 一致（含 auto 自动路由档） */
export type CustomProviderFormat = "auto" | "openai" | "anthropic";

export type BackendCreds =
  | { kind: "cursor"; apiKey: string }
  | {
      kind: "custom";
      apiKey: string;
      baseUrl: string;
      format: CustomProviderFormat;
    };

type CursorCreateInput = Parameters<typeof CursorAgent.create>[0];
type CursorResumeInput = Parameters<typeof CursorAgent.resume>[1];
type CursorPromptInput = Parameters<typeof CursorAgent.prompt>[1];

/** facade 额外字段，传给 SDK 前会剥掉 */
export type AgentCreateInput = CursorCreateInput & {
  providerId?: string;
  /** 正式会话身份；有值才挂系统 customTools。oneshot / 受限答疑不传。 */
  callerToken?: string;
  /** 只读轮次：两边走各自原生工具开关（cursor tools 白名单 / pi 白名单），写类工具执行层拒掉 */
  readOnly?: boolean;
  /** 任务 id：custom 后端做超预算全量落盘用；Cursor 路径不下发给 SDK，只用来给后台子代理的收尾事件定投递键 */
  taskId?: string;
  /**
   * chat 会话传 true：Cursor 路径的 `subagent` 工具开「后台运行」（run_in_background + 用户插话自动转后台），
   * 收尾事件按 `taskId` 投递（所以需要同时传 taskId）。task 模式 / 一次性调用不传。pi 路径忽略。
   */
  backgroundSubagents?: boolean;
  /**
   * 本会话的 shell / 子代理 bash 不继承 FLOWSHIP_GITLAB_TOKEN（N3-01）。
   * 只有需求群「非属主答疑旁路」（restricted-question.ts）传 true——它是工具全开的 honor-system agent、
   * 输入来自群里任何能 @ 机器人的人。**新增任何由非属主输入驱动的会话也必须传 true**（显式标记是 fail-open 的，
   * 没传就默认带 token；之所以不按「无 callerToken」推断，是因为属主 one-shot 同样无 callerToken、却该保留）。
   * ⚠️ 只对 pi provider 有效：Cursor 路径的本地 agent shell 由 SDK 拉起、原样继承 server 的 process.env，
   * SDK 没有 env 选项、也不能临时删进程全局 env（会弄坏属主并行会话）——所以 Cursor 下该标记是空操作，
   * 不下发给 SDK（见 git-token-env.ts 头部）。
   */
  omitGitToken?: boolean;
};
export type AgentResumeInput = NonNullable<CursorResumeInput> & {
  providerId?: string;
  callerToken?: string;
  readOnly?: boolean;
  /** 同 create */
  taskId?: string;
  /** 同 create */
  backgroundSubagents?: boolean;
  /** 同 create（含「Cursor 下无效」的限制） */
  omitGitToken?: boolean;
}; 
export type AgentPromptInput = NonNullable<CursorPromptInput> & {
  providerId?: string;
};

type FacadeExtras = {
  providerId?: string;
  callerToken?: string;
  readOnly?: boolean;
  taskId?: string;
  backgroundSubagents?: boolean;
  omitGitToken?: boolean;
};

/**
 * Cursor 内置白名单（read/grep only）。注：旁路已改 honor-system，两端默认全开、不接白名单；
 * READONLY_BUILTIN_TOOLS / pi-coding-tools.READONLY_CUSTOM_TOOL_NAMES（含 merge_test_mr）当前无人接线，
 * 留作单元覆盖，哪天收紧直接接回去。
 */
export const READONLY_BUILTIN_TOOLS = ["read", "grep"] as const;

const stripFacadeExtras = <T extends FacadeExtras>(
  input: T,
): {
  providerId?: string;
  callerToken?: string;
  readOnly?: boolean;
  taskId?: string;
  backgroundSubagents?: boolean;
  omitGitToken?: boolean;
  rest: Omit<
    T,
    | "providerId"
    | "callerToken"
    | "readOnly"
    | "taskId"
    | "backgroundSubagents"
    | "omitGitToken"
  >;
} => {
  const {
    providerId,
    callerToken,
    readOnly,
    taskId,
    backgroundSubagents,
    omitGitToken,
    ...rest
  } = input;
  return {
    providerId,
    callerToken,
    readOnly,
    taskId,
    backgroundSubagents,
    omitGitToken,
    rest,
  };
};

/**
 * Cursor 路径：正式会话把系统工具挂进 local.customTools。
 * 同时挂 `subagent`（能指定模型 / effort、能 resume 的子代理）——只在挂系统工具时
 * 才有（oneshot / 受限答疑 / 只读轮次没有 callerToken，也就没有子代理）。
 * 挂了它就**同时关掉 SDK 原生 `task`**（加进 `disallowedTools`）：原生 task 本地固定用 composer 系、
 * 选不了模型，留着会让模型顺手选到它、子任务悄悄降级。没挂 `subagent` 的会话不动。
 * `disallowedTools` 不持久化，create / resume 每次都要传——两条路径都经过这里。
 * 返回的 link 要在 agent 创建后 `attach(agent)`，把父 run 的取消联动到子 run。
 */
const attachFlowshipTools = <
  T extends {
    local?: CursorCreateInput["local"];
    apiKey?: string;
    model?: CursorCreateInput["model"];
    disallowedTools?: CursorCreateInput["disallowedTools"];
  },
>(
  input: T,
  callerToken: string | undefined,
  /** chat 会话：开后台运行，收尾事件按 taskId 投递；缺任一项 = 一律前台 */
  background?: { taskId?: string; enabled?: boolean },
): { input: T; subagent: SubagentLink | undefined } => {
  if (!callerToken) return { input, subagent: undefined };
  const subagent = createCursorSubagentLinkForSession({
    apiKey: input.apiKey ?? "",
    parentModel: input.model,
    cwd: input.local?.cwd,
    ...(background?.enabled && background.taskId
      ? { backgroundTaskId: background.taskId }
      : {}),
  });
  return {
    input: {
      ...input,
      local: withFlowshipSdkCustomTools(input.local, callerToken, {
        [CURSOR_SUBAGENT_TOOL_NAME]: subagent.tool,
      }),
      disallowedTools: withNativeTaskDisabled(input.disallowedTools),
    },
    subagent,
  };
};

/** 上下文窗口不给用户选、发给 SDK 前剥掉，走模型默认 */
const stripHiddenModelParams = <
  T extends { model?: { id: string; params?: Array<{ id: string; value: string }> } },
>(
  input: T,
): T => {
  if (!input.model) return input;
  const model = withoutHiddenModelSelection(input.model);
  if (model === input.model) return input;
  return { ...input, model };
};

/** pi 只在自定义分支动态加载，cursor 路径不拖进 webpack server bundle */
const loadCustomBackend = () => import("./custom-agent-backend");

/**
 * 解析本窗口的 agent 后端凭据：
 * - providerId 指向一条自定义（含地址被清空）→ custom，空地址让后面失败
 * - 已删的 id / cursor → cursor（用调用方传的 apiKey）
 */
export const resolveBackendCreds = async (
  clientApiKey: string,
  providerId?: string,
  sessionAgentId?: string,
): Promise<BackendCreds> => {
  const result = await readSettingsFile();
  const raw = result.status === "ok" ? result.settings : null;
  const migrated = migrateProviderSettings({
    provider: raw?.provider,
    customProvider: raw?.customProvider,
    customProviders: raw?.customProviders,
  });
  const settings = { customProviders: migrated.customProviders };
  const id = resolveTaskProvider(
    { provider: providerId, sessionAgentId },
    settings,
  );
  if (!isCursorProvider(id)) {
    const cp = findCustomProvider(settings, id);
    // 明确是自定义就不要 silently 掉回 Cursor（空地址让后面失败，避免跑错后端）
    return {
      kind: "custom",
      apiKey: cp?.apiKey ?? "",
      baseUrl: cp?.baseUrl.trim() ?? "",
      format:
        cp?.format === "anthropic"
          ? "anthropic"
          : cp?.format === "openai"
            ? "openai"
            : "auto",
    };
  }
  return { kind: "cursor", apiKey: clientApiKey };
};

export const resolveProviderIdFromDisk = async (task: {
  provider?: string;
  sessionAgentId?: string;
}): Promise<string> => {
  const result = await readSettingsFile();
  const migrated = migrateProviderSettings(
    result.status === "ok" ? result.settings : {},
  );
  return resolveTaskProvider(task, migrated);
};

/**
 * `Agent` facade——签名 / 返回类型与 @cursor/sdk 的 Agent 完全一致，
 * 四个调用点只需把 `import { Agent } from "@cursor/sdk"` 换成这里。
 */
export const Agent = {
  async create(input: AgentCreateInput): Promise<AgentInstance> {
    const {
      providerId,
      callerToken,
      readOnly,
      taskId,
      backgroundSubagents,
      omitGitToken,
      rest,
    } = stripFacadeExtras(input);
    const creds = await resolveBackendCreds(rest.apiKey ?? "", providerId);
    const sanitized = stripHiddenModelParams(
      readOnly ? { ...rest, tools: [...READONLY_BUILTIN_TOOLS] } : rest,
    );
    // readOnly 时不挂系统 customTools（submit_work 等能落盘）：Cursor 的 tools 白名单
    // 只管内置工具，customTools 走 "mcp" 族——默认按管不住处理，和 pi 对齐（双收敛）。
    const effectiveCallerToken = readOnly ? undefined : callerToken;
    if (creds.kind === "custom") {
      const { createCustomAgent } = await loadCustomBackend();
      return createCustomAgent({
        ...sanitized,
        ...creds,
        callerToken: effectiveCallerToken,
        ...(readOnly ? { readOnly: true } : {}),
        // 仅 pi 路径下发：Cursor 路径摘不掉 token（SDK 继承 server env），见 AgentCreateInput.omitGitToken
        ...(omitGitToken ? { omitGitToken: true } : {}),
        ...(taskId ? { taskId } : {}),
      } as CustomAgentInput) as unknown as AgentInstance;
    }
    const attached = attachFlowshipTools(sanitized, effectiveCallerToken, {
      taskId,
      enabled: backgroundSubagents,
    });
    const withTools = await withCursorJsonlStore(attached.input);
    const agent = await CursorAgent.create(withTools);
    return attached.subagent ? attached.subagent.attach(agent) : agent;
  },

  async resume(
    agentId: string,
    input: AgentResumeInput,
  ): Promise<AgentInstance> {
    const {
      providerId,
      callerToken,
      readOnly,
      taskId,
      backgroundSubagents,
      omitGitToken,
      rest,
    } = stripFacadeExtras(input);
    const creds = await resolveBackendCreds(
      rest.apiKey ?? "",
      providerId,
      agentId,
    );
    const sanitized = stripHiddenModelParams(
      readOnly ? { ...rest, tools: [...READONLY_BUILTIN_TOOLS] } : rest,
    );
    // 同 create：readOnly 不挂系统 customTools（双收敛）。
    const effectiveCallerToken = readOnly ? undefined : callerToken;
    if (creds.kind === "custom") {
      const { resumeCustomAgent } = await loadCustomBackend();
      return resumeCustomAgent(agentId, {
        ...sanitized,
        ...creds,
        callerToken: effectiveCallerToken,
        ...(readOnly ? { readOnly: true } : {}),
        ...(omitGitToken ? { omitGitToken: true } : {}),
        ...(taskId ? { taskId } : {}),
      } as CustomAgentInput) as unknown as AgentInstance;
    }
    const attachedResume = attachFlowshipTools(sanitized, effectiveCallerToken, {
      taskId,
      enabled: backgroundSubagents,
    });
    const withToolsResume = await withCursorJsonlStore(attachedResume.input);
    const agent = await CursorAgent.resume(agentId, withToolsResume);
    return attachedResume.subagent
      ? attachedResume.subagent.attach(agent)
      : agent;
  },

  async prompt(
    prompt: string,
    input: AgentPromptInput,
  ): Promise<Awaited<ReturnType<typeof CursorAgent.prompt>>> {
    const { providerId, rest } = stripFacadeExtras(input);
    const creds = await resolveBackendCreds(rest.apiKey ?? "", providerId);
    const sanitized = stripHiddenModelParams(rest);
    if (creds.kind === "custom") {
      const { promptOnceCustom } = await loadCustomBackend();
      return promptOnceCustom(prompt, {
        ...sanitized,
        ...creds,
      } as CustomAgentInput) as unknown as Awaited<
        ReturnType<typeof CursorAgent.prompt>
      >;
    }
    return CursorAgent.prompt(prompt, await withCursorJsonlStore(sanitized));
  },
};
