/**
 * Agent 后端抽象层（v1.2.x 引入自定义 provider）
 *
 * 把「起会话 / 续会话 / 单发 prompt」三个入口收敛到一个 `Agent` facade，
 * 按 settings.provider 分发到两套实现：
 *   - `cursor`：直通 @cursor/sdk（历史行为零变化）
 *   - `custom`：走 pi（@earendil-works/pi-coding-agent）承接用户 HTTP API
 *
 * 关键设计：`Agent` facade 的签名与返回值**完全沿用 @cursor/sdk 的类型**
 * （`AgentInstance` / `AgentRun` 就是 SDK 的 Agent / Run 类型）。custom 后端
 * 把自己适配出的对象 cast 成这些形状——这样 chat-runner / task-runner /
 * chat-title / restricted-question 四个调用点只改 import、下游事件管线
 * （sdk-message-handler / run-perf / shell-output-bridge）一行都不用动。
 *
 * 凭据来源：cursor 用调用方传的 apiKey；custom 读 config.json 的
 * customProvider（baseUrl/apiKey/format），调用方传的 apiKey 被忽略。
 */

import { Agent as CursorAgent } from "@cursor/sdk";

import { readSettingsFile } from "./settings-fs";
import {
  createCustomAgent,
  resumeCustomAgent,
  promptOnceCustom,
  type CustomAgentInput,
} from "./custom-agent-backend";

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

/**
 * 解析当前生效的 agent 后端凭据：
 * - settings.provider === "custom" 且 customProvider.baseUrl 非空 → custom
 * - 否则 cursor（用调用方传的 apiKey）
 */
export const resolveBackendCreds = async (
  clientApiKey: string,
): Promise<BackendCreds> => {
  const result = await readSettingsFile();
  const settings = result.status === "ok" ? result.settings : null;
  const cp = settings?.customProvider;
  if (
    settings?.provider === "custom" &&
    cp &&
    typeof cp === "object" &&
    !Array.isArray(cp)
  ) {
    const c = cp as { baseUrl?: unknown; apiKey?: unknown; format?: unknown };
    const baseUrl = typeof c.baseUrl === "string" ? c.baseUrl.trim() : "";
    if (baseUrl) {
      return {
        kind: "custom",
        apiKey: typeof c.apiKey === "string" ? c.apiKey : "",
        baseUrl,
        format: c.format === "anthropic" ? "anthropic" : "openai",
      };
    }
  }
  return { kind: "cursor", apiKey: clientApiKey };
};

/**
 * `Agent` facade——签名 / 返回类型与 @cursor/sdk 的 Agent 完全一致，
 * 四个调用点只需把 `import { Agent } from "@cursor/sdk"` 换成这里。
 */
export const Agent = {
  create(
    input: Parameters<typeof CursorAgent.create>[0],
  ): Promise<AgentInstance> {
    return resolveBackendCreds(input.apiKey ?? "").then((creds) => {
      if (creds.kind === "custom") {
        return createCustomAgent({
          ...input,
          ...creds,
        } as CustomAgentInput) as unknown as AgentInstance;
      }
      return CursorAgent.create(input);
    });
  },

  resume(
    agentId: string,
    input: Parameters<typeof CursorAgent.resume>[1],
  ): Promise<AgentInstance> {
    return resolveBackendCreds(input?.apiKey ?? "").then((creds) => {
      if (creds.kind === "custom") {
        if (!input) throw new Error("custom resume 缺少 input");
        return resumeCustomAgent(agentId, {
          ...input,
          ...creds,
        } as CustomAgentInput) as unknown as AgentInstance;
      }
      return CursorAgent.resume(agentId, input);
    });
  },

  prompt(
    prompt: string,
    input: Parameters<typeof CursorAgent.prompt>[1],
  ): Promise<Awaited<ReturnType<typeof CursorAgent.prompt>>> {
    return resolveBackendCreds(input?.apiKey ?? "").then((creds) => {
      if (creds.kind === "custom") {
        if (!input) throw new Error("custom prompt 缺少 input");
        return promptOnceCustom(prompt, {
          ...input,
          ...creds,
        } as CustomAgentInput) as unknown as Awaited<
          ReturnType<typeof CursorAgent.prompt>
        >;
      }
      return CursorAgent.prompt(prompt, input);
    });
  },
};
