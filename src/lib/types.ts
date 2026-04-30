export interface RepoConfig {
  name: string;
  path: string;
}

/**
 * 用户最终选定的模型（含参数）
 * - id：基础模型（如 "claude-opus-4-7"）
 * - params：可选参数组合（如 [{ id: "thinking", value: "true" }]）
 *
 * 跟 SDK ModelSelection 同 schema、agent 启动时直接传过去。
 */
export interface ModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

export interface FeAiFlowSettings {
  apiKey: string;
  defaultModel: ModelSelection;
  repos: RepoConfig[];
  mcpServersJson: string;
}

/**
 * 单个模型可调参数定义（如 "thinking"）
 * - id：参数标识（thinking / effort 等）
 * - values：可选枚举值（each value 包含真实值和展示名）
 *
 * Schema 来自 SDK ModelParameterDefinition、不要随意改。
 */
export interface ModelParameter {
  id: string;
  displayName?: string;
  values: Array<{
    value: string;
    displayName?: string;
  }>;
}

/**
 * 模型预设组合（如 "Opus 4.7 thinking xhigh"）
 * SDK 直接返、用户选 variant 时可以直接拿到完整 params 数组。
 */
export interface ModelVariant {
  params: Array<{ id: string; value: string }>;
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

export interface ModelOption {
  id: string;
  displayName: string;
  description?: string;
  parameters?: ModelParameter[];
  variants?: ModelVariant[];
}

