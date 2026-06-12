/**
 * localStorage 配置存取层
 * - 所有 settings 都序列化到一个 key、整体读写、避免局部 setItem 撕裂
 * - SSR 安全：服务器端没 window、所有读操作返回默认值；写操作直接 noop
 * - 数据 schema 看 src/lib/types.ts
 */

import { DEFAULT_BRANCH_TEMPLATE } from "./branch-template";
import type { FeAiFlowSettings, ModelSelection } from "./types";

const KEY = "fe-ai-flow:settings";

export const DEFAULT_SETTINGS: FeAiFlowSettings = {
  apiKey: "",
  defaultModel: { id: "" },
  repos: [],
  username: "",
  jumpIde: "cursor",
  gitHost: "",
  gitToken: "",
  branchTemplate: DEFAULT_BRANCH_TEMPLATE,
  disabledMcpServers: [],
};

const isBrowser = (): boolean =>
  typeof window !== "undefined" && typeof window.localStorage !== "undefined";

// defaultModel 字段读出来校验：必须是 { id: string } 形态、不然回 default
// 老 schema 兼容（V0.5.12.2 删）：以前 defaultModel 是纯 string、用户 localStorage 里如果还残留就重配
const readDefaultModel = (raw: unknown): ModelSelection => {
  if (
    raw &&
    typeof raw === "object" &&
    "id" in raw &&
    typeof (raw as { id: unknown }).id === "string"
  ) {
    return raw as ModelSelection;
  }
  return { id: "" };
};

export const getSettings = (): FeAiFlowSettings => {
  if (!isBrowser()) return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<FeAiFlowSettings> & {
      defaultModel?: unknown;
    };
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      defaultModel: readDefaultModel(parsed.defaultModel),
      repos: Array.isArray(parsed.repos) ? parsed.repos : [],
      // V0.6 加：username 串行存档可能丢、强转 string 兜底
      username: typeof parsed.username === "string" ? parsed.username : "",
      // 代码跳转 IDE：枚举外的值（旧档 / 手改坏）回退 cursor
      jumpIde: parsed.jumpIde === "idea" ? "idea" : "cursor",
      // V0.6.1 加：ship action GitLab 配置、PAT 明文存（用户拍板可接受）
      gitHost: typeof parsed.gitHost === "string" ? parsed.gitHost : "",
      gitToken: typeof parsed.gitToken === "string" ? parsed.gitToken : "",
      // V0.6.7：全局默认分支命名模板、缺省 / 非串回退内置默认
      branchTemplate:
        typeof parsed.branchTemplate === "string" && parsed.branchTemplate.trim()
          ? parsed.branchTemplate
          : DEFAULT_BRANCH_TEMPLATE,
      // V0.6.5：建任务默认 MCP 黑名单快照源
      disabledMcpServers: Array.isArray(parsed.disabledMcpServers)
        ? parsed.disabledMcpServers
        : [],
    };
  } catch (err) {
    console.warn(
      "[local-store] settings JSON 损坏、已 fallback 到默认值",
      err
    );
    return DEFAULT_SETTINGS;
  }
};

/**
 * 写设置到 localStorage
 *
 * @returns true=写入成功；false=被浏览器拒绝（quota 满 / 隐私模式 / 其它 DOMException）
 *          调用方需要据此 toast.error 提示用户、避免「显示已保存但其实没存」
 */
export const saveSettings = (next: FeAiFlowSettings): boolean => {
  if (!isBrowser()) return false;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
    return true;
  } catch (err) {
    console.error("[local-store] saveSettings 失败", err);
    return false;
  }
};

