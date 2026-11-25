/**
 * 设置保存「首次失败、正在自动重试」期间的常驻提示（第二十轮评审 R20-11；纯函数，不依赖 React）。
 *
 * 背景：saveFieldValue 是乐观更新——开关一点界面就显示新值。5xx / 断网时首次保存失败，会按 2 / 8 / 30 秒退避自动重试（约 40 秒加上每次请求的耗时）；
 * 这段时间里界面显示的是新值、磁盘上仍是旧值。对「收紧」方向的开关（限制群里非宿主成员 / 关掉页面脚本 / 关掉电脑操作…）这是个误导：
 * 用户以为已经收紧，实际还放着。原来只有一条几秒后自动消失的 toast。
 *
 * 决定（第二十轮评审 R20-11，按推荐）：在设置页顶部的浮顶栏里挂一条**常驻**提示，列出还没存进去的字段，直到该字段重试成功 / 被拒 / 放弃重试 / 用户又改了它才消失。
 * 不只对「收紧」方向的开关：失败状态对所有字段都一样，列出来的成本很低，也省得在每个开关上再维护一份「哪个方向算收紧」的表。
 * 放弃重试 / 被拒之后，开关 / 单选草稿由 settings-draft-rollback 恢复原样；输入框 / 列表的内容保留（仍算未保存，离页会拦）。
 *
 * 为什么是页面级一条而不是每行一个标记：开关分散在 7 张卡 / 十几个组件里，逐行加标记要给每个组件穿一个 prop；浮顶栏里的一条提示不管用户滚到哪里都看得见。
 */
import type { FeAiFlowSettings } from "@/lib/types";

/**
 * 每个设置字段给用户看的名字（与设置页上的标签对齐）。`satisfies Record<keyof FeAiFlowSettings, string>`：新增字段不补这里编译期就报错。
 */
export const SETTING_FIELD_LABELS = {
  apiKey: "Cursor API Key",
  provider: "默认模型提供方",
  customProviders: "自定义模型提供方",
  defaultModel: "默认模型",
  repos: "仓库",
  jumpIde: "代码跳转 IDE",
  submitShortcut: "提交快捷键",
  linkOpenMode: "链接默认打开方式",
  userRole: "我的角色",
  gitToken: "GitLab Token",
  branchTemplate: "默认分支命名模板",
  disabledMcpServers: "MCP 服务开关",
  mcpServers: "MCP 服务配置",
  actionLayout: "Action 布局",
  reuseAgentDefault: "推进时默认续用当前 Agent",
  agentShellGitBash: "Agent shell 用 Git Bash",
  isolateWorktreeDefault: "新任务默认使用 worktree",
  disabledSkills: "Skill 开关",
  disabledRules: "规则开关",
  starredModels: "常用模型",
  meegleProject: "飞书项目空间",
  feishuChatBridge: "飞书消息桥接",
  feishuBridgeKeepAwake: "插电时防休眠",
  feishuBridgeStreaming: "流式回复",
  feishuGroupNonOwnerGuard: "限制群里非宿主成员",
  feishuGroupBotsEqualRights: "机器人与真人同权",
  teamKnowledgeEnabled: "团队规范",
  browserEvaluateEnabled: "允许 AI 执行页面脚本",
  browserRecordInputValues: "记录你输入的内容",
  browserStorageAccess: "允许 AI 读写登录态",
  browserPagePermissions: "允许 AI 授予页面权限",
  browserTrustLoopbackCerts: "自动放行本机的自签名证书",
  browserNetworkBodyRead: "允许 AI 读取网络响应内容",
  browserAdvancedTools: "高级调试工具",
  browserMaxTabs: "标签页数量上限",
  computerUse: "电脑操作",
  computerUseLockedAccess: "锁屏时也能用",
  companyEnv: "环境配置",
} as const satisfies Record<keyof FeAiFlowSettings, string>;

/** 自动重试的总时长说明（delays 2 + 8 + 30 秒，再加每次请求的耗时；对应 save-retry 的 DEFAULT_RETRY_DELAYS_MS） */
export const RETRY_WINDOW_NOTE = "最多约 40 秒";

/** 提示里最多点名几项，其余折成「等 N 项」 */
const MAX_NAMED = 3;

/**
 * 「正在自动重试」的字段集合上加 / 减一个字段：状态没变时返回**同一个**引用（React setState 据此跳过重渲染），变了返回新集合（不改入参）。
 */
export const withRetryPending = (set: ReadonlySet<string>, key: string, pending: boolean): ReadonlySet<string> => {
  if (set.has(key) === pending) return set;
  const next = new Set(set);
  if (pending) next.add(key);
  else next.delete(key);
  return next;
};

const labelOf = (key: string): string => (SETTING_FIELD_LABELS as Record<string, string>)[key] ?? key;

/**
 * 浮顶栏提示的文案；集合为空返回 null（不渲染）。
 * 标题点名没存进去的字段（超过 3 项折成「等 N 项」），正文说清「界面是新值、实际生效的仍是旧值」与最长等多久、之后怎样。
 */
export const describeRetryPending = (keys: ReadonlySet<string>): { headline: string; detail: string } | null => {
  if (keys.size === 0) return null;
  const names = [...keys].map(labelOf);
  const shown = names.slice(0, MAX_NAMED).map((n) => `「${n}」`).join("");
  const more = names.length > MAX_NAMED ? ` 等 ${names.length} 项` : "";
  return {
    headline: `${shown}${more}还没存进去，正在自动重试`,
    detail: `重试期间界面上是你刚改的值，实际生效的仍是旧值（${RETRY_WINDOW_NOTE}）。成功后这条提示自动消失；多次失败后开关 / 选项会恢复原样，输入框里的内容保留、仍算未保存。`,
  };
};
