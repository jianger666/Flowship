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

import type { CustomAgentInput } from "./custom-agent-backend";
import { withCursorJsonlStore } from "./sdk-agent-store";
import { readSettingsFile } from "./settings-fs";

/** 与 @cursor/sdk 的 Agent.create 返回类型一致（下游类型零改动） */
export type AgentInstance = Awaited<ReturnType<typeof CursorAgent.create>>;
/** 与 @cursor/sdk 的 agent.send 返回类型一致 */
export type AgentRun = Awaited<ReturnType<AgentInstance["send"]>>;

export type CustomProviderFormat = "openai" | "anthropic";

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

/** facade 额外带本窗口 providerId，传给 SDK 前会剥掉 */
export type AgentCreateInput = CursorCreateInput & { providerId?: string };
export type AgentResumeInput = NonNullable<CursorResumeInput> & {
  providerId?: string;
};
export type AgentPromptInput = NonNullable<CursorPromptInput> & {
  providerId?: string;
};

const stripProviderId = <T extends { providerId?: string }>(
  input: T,
): { providerId?: string; rest: Omit<T, "providerId"> } => {
  const { providerId, ...rest } = input;
  return { providerId, rest };
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
      format: cp?.format === "anthropic" ? "anthropic" : "openai",
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
    const { providerId, rest } = stripProviderId(input);
    const creds = await resolveBackendCreds(rest.apiKey ?? "", providerId);
    const sanitized = stripHiddenModelParams(rest);
    if (creds.kind === "custom") {
      const { createCustomAgent } = await loadCustomBackend();
      return createCustomAgent({
        ...sanitized,
        ...creds,
      } as CustomAgentInput) as unknown as AgentInstance;
    }
    return CursorAgent.create(await withCursorJsonlStore(sanitized));
  },

  async resume(
    agentId: string,
    input: AgentResumeInput,
  ): Promise<AgentInstance> {
    const { providerId, rest } = stripProviderId(input);
    const creds = await resolveBackendCreds(
      rest.apiKey ?? "",
      providerId,
      agentId,
    );
    const sanitized = stripHiddenModelParams(rest);
    if (creds.kind === "custom") {
      const { resumeCustomAgent } = await loadCustomBackend();
      return resumeCustomAgent(agentId, {
        ...sanitized,
        ...creds,
      } as CustomAgentInput) as unknown as AgentInstance;
    }
    return CursorAgent.resume(
      agentId,
      await withCursorJsonlStore(sanitized),
    );
  },

  async prompt(
    prompt: string,
    input: AgentPromptInput,
  ): Promise<Awaited<ReturnType<typeof CursorAgent.prompt>>> {
    const { providerId, rest } = stripProviderId(input);
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
