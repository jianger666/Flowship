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

// ===========================================
// V1 任务模型（Task / Phase / Event / Artifact）
// ===========================================
//
// 设计原则（详见 docs/HANDOFF.md「V1 流程设计」）：
// 1. phase 不写死、用枚举但留 PhaseId 这个 string union 做扩展（V2 加 verify
//    只需扩这个 union + 注册新 phase）
// 2. 产物（artifact）走 markdown + frontmatter、UI 直接渲染、未来落盘统一格式
// 3. 事件流（events）= 可观测性的载体、agent 每个动作 / phase 边界 / HITL
//    feedback 都进 events、UI 右侧据此渲染时间线
// 4. HITL ack 不走单独字段、走 `phases[id].status === "ack"`
//    → "完成" = 最后一个 phase 是 ack（不写死 build 完成 = 任务完成）

// V1 砍掉 spec 阶段：实测下来 spec 写出来对开发参考价值有限、
// 反而拉长链路；现在直接 plan→build 两步走、plan agent 自己进仓库扫一遍
// 再产出 Task List（含简述 + 影响面 + 不做的）
//
// V0.2 扩展（feishu-story-impl workflow 引入）：
//   - "plan"：phase 1、拉飞书 story + 后端文档 + 扫本地仓库代码、出技术方案、产出 01-plan.md
//   - "build"：phase 2、SDK Agent 按 plan 写代码 + 跑 hooks
// V0.3.3 拆掉 ship phase（原 phase 4 提 PR + 同步飞书、效果不稳）、保留前 3 phase
// V0.3.4 把原 context phase（独立的上下文收集）合进 plan phase——
//   实操中分离 context / plan 价值未兑现：用户审 context 时的判断点跟审 plan 时重合、
//   反而多审一次、多 ack 一次、agent 也多写一份 artifact。合并后 plan 阶段一气呵成：
//   读上下文 → 扫仓库 → 出方案、用户只审 1 次、效率高。
// V0.2 workflow phase 序列 = [plan, build]、单 SDK Run 跨 2 phase
// 通过 wait_for_user MCP 在 phase 间阻塞等用户 ack（不是每 phase 起新 Run、省 Cursor 计费)
//
// V0.5 引入 review phase（详见 docs/HANDOFF.md「V0.5：review phase + 多 phase 模型选择 + plan 校验前移」段）：
//   - "review"：build 之后、拿 `git diff × 01-plan.md × 02-build.md × contextDocs` 做结构化差值
//     按 4 类分流（范围扩张 / 范围收缩 / 实现偏差 / 未完成）、产出 03-review.md
//     含整体一致性总评 + 4 类差异表 + 飞书需求对照 + 交付信息（commit msg / PR body / 飞书评论草稿 / 自测 checklist）
//   - HITL 边界：用户「整体通过」一次性 ack、或对单项 revise（agent 按指示动 build 或 plan 后再 review）
//   - 不做 ship 那种「自动 git push / 自动改飞书状态」、只输出信息让用户复制
export type PhaseId = "plan" | "build" | "review";

// ===========================================
// 上下文文档（V0.3、跟 Skill 同理：清单 inject + 按需拉取）
// ===========================================
//
// 用户在任务详情页随时加 / 删上下文（飞书文档 URL / 本地路径 / 自由文本）、
// agent 在 super-prompt 里看到清单、但内容不全量 inject——
//  - URL 类型：agent 用 feishu-mcp / fetch 工具按需拉
//  - path 类型：agent 用 SDK 内置 `read` 工具按需读
//  - text 类型：内容 ≤ 1000 字默认直接 inject（短文本反正不占 token）、> 1000 字截断
//
// 跟 Skill 类比：title + type = SKILL.md frontmatter；content = SKILL.md 正文
export type TaskContextDocType = "url" | "path" | "text";

export interface TaskContextDoc {
  id: string; // ctx_<ts>_<rand>
  title: string; // 用户取的标题、如「后端技术方案」「补充说明」
  content: string; // url / 路径 / 自由文本
  type: TaskContextDocType; // 后端保存时按 content 自动推断
  createdAt: number;
}

export type PhaseStatus =
  | "pending" // 还没轮到
  | "running" // agent 正在跑
  | "awaiting_ack" // agent 跑完产物已落、等用户 ack
  | "ack" // 用户已 ack、可以进下一 phase
  | "failed"; // agent 报错、需要用户介入

export interface PhaseState {
  id: PhaseId;
  status: PhaseStatus;
  startedAt?: number;
  endedAt?: number;
  // V1 直接把产物内容存内联、避免文件系统读写；V2 改成 path 引用
  artifact?: {
    filename: string;
    content: string;
  };
}

export type TaskStatus =
  | "draft" // 已建未启动
  | "running" // 某个 phase 在跑
  | "awaiting_user" // 等用户 ack 或 feedback 回复
  | "completed" // 全部 phase ack
  | "failed"; // 某 phase 报错且没恢复

export type EventKind =
  | "info" // agent 普通文本（非流式 / 系统消息）
  | "thinking" // agent 思考过程（来自 SDKThinkingMessage）
  | "phase_start"
  | "phase_ack"
  | "phase_failed"
  | "tool_call" // agent 调工具（read / grep / shell / write / edit 等）
  | "user_reply" // chat 模式：用户的消息
  | "assistant_message" // chat 模式 agent 完整一轮回复（不像 plan 那样累积成 artifact）
  // V0.3 ask_user 机制（phase 内细粒度问答、跟 wait_for_user 是不同语义）
  //
  // 设计（V0.3.2 改造、用户拍板）：
  //   - 一次 ask_user 调用 = 一组问题 questions[]（不再一次一问、避免反复弹窗 + 拉长对话节奏）
  //   - UI 用 modal dialog 弹窗展示、不在 event stream inline（inline 卡片留个简化「已答 Q&A」回放）
  //   - 每个 option 自动加 A/B/C/D 字母前缀（像 Cursor askFollowUpQuestion）
  //
  // 事件结构：
  // - ask_user_request：agent 调 ask_user 时服务端写入
  //   meta：{ askId, token, questions: AskUserQuestion[] }
  //   text：所有 question 拼接的预览文本（供 inline 卡片快速浏览）
  // - ask_user_reply：用户答完所有问题后服务端写入
  //   meta：{ askId, answers: AskUserAnswer[] }
  //   text：拼接好的 Q&A markdown（供 inline 卡片回放显示）
  | "ask_user_request"
  | "ask_user_reply"
  | "error";

// ask_user 单条问题
//
// - id：问题唯一标识、用户提交 answers 时携带回去（用来关联）
// - question：问题正文、UI 顶部显示
// - options：可选项数组（≤ 6 个、UI 自动加 A/B/C/D 前缀）
// - allowText：是否允许 Other 自由文本输入（默认 true）
export interface AskUserQuestion {
  id: string;
  question: string;
  options?: Array<{ id: string; label: string }>;
  allowText?: boolean;
}

// 用户对单条问题的回答
//
// - questionId：对应 AskUserQuestion.id
// - answer：最终答案文本（option label / Other 输入）
// - optionId：可选、用户选了哪个 option（meta 用）
export interface AskUserAnswer {
  questionId: string;
  answer: string;
  optionId?: string;
}

export interface TaskEvent {
  id: string;
  ts: number;
  kind: EventKind;
  phase?: PhaseId;
  text: string;
  meta?: Record<string, unknown>;
}

/**
 * 任务模式：决定整个任务的交互形态
 *
 * - `plan`：方案规划任务、走多 phase workflow（V0.5 起 plan → build → review）
 *   - V0.2 起：整段任务跑在一次 SDK Run、phase 间用 wait_for_user 阻塞等 ack
 *   - V0.3.3 起：移除原 phase 4（ship、提 PR + 同步飞书）
 *   - V0.3.4 起：把 context phase 合进 plan phase（合并理由见 PhaseId 注释）
 *   - V0.5 起：build 之后加 review phase（拿 git diff × plan × build × 飞书 做差值对照）
 *   - 配合 `workflowId` 决定具体走哪条 phase 序列（目前只有 feishu-story-impl）
 * - `chat`：自由对话、agent 长存活、调 wait_for_user MCP 等用户输入
 *
 * 创建时定死、不能切换。两种模式共用 events.jsonl + MCP 配置 + 模型配置 + wait_for_user 机制。
 */
export type TaskMode = "plan" | "chat";

/**
 * Plan 模式下的 workflow 标识：决定 phase 序列 / prompt 模板 / 必填字段
 *
 * - `feishu-story-impl`：从飞书 story 出发、走 3 phase 方案 + 实现 + 复核
 *   - phase 序列：[plan, build, review]
 *     （V0.3.3 移除原 ship phase、V0.3.4 合并原 context 进 plan、V0.5 加 review）
 *   - 必填：feishuStoryUrl
 *
 * V0.2 只有这一种。后面会加 `pr-review` / `interface-binding` 等。
 */
export type WorkflowId = "feishu-story-impl";

/**
 * 任务角色（V0.4 引入）
 *
 * 飞书 story 是「跨角色共享」的——同一条 story 可能涉及前端 / 后端 / 数仓 / 测试 / 移动端…
 * 每个研发只关心 story 里跟自己角色相关的部分、并在各自本地仓库建对应 task。
 *
 * 当前枚举（V0.4 阶段、单值）：
 *   - `fe`：前端（暂不分 B 端 / C 端、实操中差异主要在视觉规范、prompt 层不区分）
 *
 * 路线图（详见 `docs/MULTI-ROLE.md`）：
 *   - `be` 后端、`data` 数仓、`mobile-ios` / `mobile-android` 移动端、`qa` 测试
 *   - 每个角色对应 `prompts/roles/<role>.md` 片段、plan-runner 注入
 *   - 选 enum 而不是 string union 留扩展、便于 UI 选择器和 prompt 模板按角色分叉
 *
 * 设计原则：harness 工具链（typecheck / lint / build）由 agent 自己根据 repo 探测、
 * 不存 task 上。task.role 只负责告诉 agent「以哪种视角读 story / 出方案」。
 */
export type TaskRole = "fe";

/**
 * 角色展示文案（中文）、UI / prompt 注入用、统一来源
 */
export const TASK_ROLE_LABEL: Record<TaskRole, string> = {
  fe: "前端",
};

/**
 * Workflow 注册项（运行时表）
 *
 * plan-runner 启动时按 task.workflowId 查出对应 phase 序列、再按序跑。
 * 各 phase prompt 模板在 prompts/phase-<id>.md。
 */
export interface WorkflowDef {
  id: WorkflowId;
  displayName: string;
  description: string;
  phases: PhaseId[];
  // 创建任务时必须填的字段（前端表单据此校验）
  // V0.5.3 起只保留 feishuStoryUrl（swaggerUrl 字段已废弃、详见 Task 注释）
  requiredFields: Array<"feishuStoryUrl">;
}

export interface Task {
  id: string;
  title: string;
  // 任务模式（V1 创建时定死、不能切）
  mode: TaskMode;
  // workflow 模式必填、其他模式不用
  workflowId?: WorkflowId;
  // V0.4 引入：任务角色、决定 agent 以哪种视角读 story / 出方案
  // 创建时定死、跟仓库强相关（同一仓库的任务通常同 role、但允许例外）
  // 老数据没此字段、hydrate 时按 "fe" 兜底（V0.4 之前只支持前端）
  role: TaskRole;
  // 关联的本地仓库路径（必填、agent cwd）
  repoPath: string;
  // 可选输入源
  // V0.2 workflow 用 feishuStoryUrl（指向飞书项目 story 详情页）
  // V0.4 起 chat 模式建任务的「飞书相关链接」也复用这个字段、不分 feishuUrl
  feishuStoryUrl?: string;
  description?: string;
  // V0.3 起的旧字段 `swaggerUrl` / `attachedDocs` 已在 V0.5.3 删除——
  // contextDocs 完全覆盖「后端文档 URL / 附加文件路径 / 自由文本」三种语义、UI 表单不再单列、
  // 老 task.meta.json 里残留的这两个字段在 hydrateTask 时被忽略、不再出现在 Task / API 上
  // V0.3 引入：任务级上下文文档清单、可在详情页随时增删
  // - 飞书 story URL 在建任务时自动作为第一条 contextDoc（title="飞书 story"）
  // - 后续用户在详情页面板里加更多（如后端技术方案 / 设计稿 / 开发补充）
  // - agent 看清单决定是否拉取（不全量塞 super-prompt、防 token 爆）
  contextDocs?: TaskContextDoc[];
  // 任务级 MCP 黑名单（按 server 名）
  // - undefined / 空数组：本任务用 settings 里全部 MCP（默认全开）
  // - 有值：列出的 server 在本任务里被禁用、其它仍生效
  // 黑名单语义的好处：用户在 settings 加新 MCP、自动对所有任务生效、不用每个任务都去 enable
  disabledMcpServers?: string[];

  status: TaskStatus;
  currentPhase: PhaseId;
  phases: Record<PhaseId, PhaseState>;
  events: TaskEvent[];

  // V1 仅做「软隐藏」：列表默认筛掉 archived=true 的、不删数据
  // 自动归档规则：completed / failed 且 updatedAt 超过 7 天、listTasks 时 lazy 改写
  archived: boolean;

  createdAt: number;
  updatedAt: number;

  // V0.3.5：上一个 SDK Agent 的 id
  // - plan-runner 起 Agent.create 后立刻持久化、用户走 /resume-waiting 续监听时
  //   服务端 Agent.resume(this.id) + send "[RESUME] 继续监听用户 ack" 推进
  // - 没有 lastAgentId（如老数据、或 chat 模式）→ /resume-waiting 路由降级走 new agent
  lastAgentId?: string;

  // V0.5.1：任务级模型选择（新建任务时表单里挑、可跟 settings.defaultModel 不同）
  // - 启动 workflow / chat 时优先用 task.model、回退到 settings.defaultModel
  // - ack 时切了模型 = 隐含 fork（旧 agent 已经在用旧 model、不可热切）
  // - 老数据没此字段、prepareRunArgs 兜底走 settings.defaultModel
  model?: ModelSelection;
}

/**
 * 任务摘要：列表场景专用、不含 events / phases 详细产物（V0.5.3 引入）
 *
 * 设计动机：原来 listTasks / GET /api/tasks 直接返完整 Task[]、每条都 hydrate 全部
 * events.jsonl（可能几千行）+ 3 个 artifact 文件——首页列表根本不需要这些内容、
 * 只是为了渲染卡片白白付了 N × (1 readMeta + 1 readEvents + 3 readArtifact) 的 IO。
 *
 * TaskSummary 只保留卡片渲染必须的字段（title / status / currentPhase / updatedAt / mode 等）、
 * server-side `listTasks` 用 hydrateTaskSummary 跳过 readEvents / readArtifact、O(N) → 单读 meta.json。
 *
 * Task 本身是 TaskSummary 的超集——结构上向下兼容、setTaskArchived 等返 Task 的 API 可以直接塞进
 * `TaskSummary[]` state 而无需转换（TS structural typing 自动接受）。
 *
 * 详情页 / 单 task API 走 `Task`（带 events + phases.artifact 全量），不受影响。
 */
export type TaskSummary = Omit<Task, "events" | "phases">;

// 新建任务表单的入参（不含运行期字段）
// V0.2：默认 mode = "workflow"、workflowId = "feishu-story-impl"
// V0.3：contextDocs 在后端 createTask 时自动初始化（飞书 story 作为第一条）
// V0.3.3：可在创建时直接指定任务级 MCP 黑名单
// V0.4：role 可选、后端 createTask 默认 "fe"
// V0.5.3：删 swaggerUrl / attachedDocs（已被 contextDocs 取代）
export type NewTaskInput = Pick<
  Task,
  | "title"
  | "repoPath"
  | "feishuStoryUrl"
  | "description"
  | "disabledMcpServers"
  | "model"
> & {
  mode?: TaskMode;
  workflowId?: WorkflowId;
  // 不传时后端默认 "fe"（V0.4 阶段 enum 只有一个值、UI 上选了也只能选这个）
  role?: TaskRole;
};

// V0.3 加 / 删上下文文档的入参（API 接收）
export interface AddContextDocInput {
  title: string;
  content: string;
}

// V0.2 workflow 注册表（顶层导出、前后端共享）
// 现阶段只有一个；以后扩 workflow 时往这里加
// V0.5：phases 加 review、整条 workflow = plan → build → review
export const WORKFLOWS: Record<WorkflowId, WorkflowDef> = {
  "feishu-story-impl": {
    id: "feishu-story-impl",
    displayName: "飞书 story 实现",
    description:
      "从飞书 story 链接出发、agent 读上下文 / 扫仓库 / 出方案（plan）→ SDK Agent 按 plan 写代码（build）→ 拿 git diff × plan × 飞书原文做差值对照 + 产出交付信息（review）",
    phases: ["plan", "build", "review"],
    requiredFields: ["feishuStoryUrl"],
  },
};

/**
 * 取「下一 phase」的统一入口（V0.5.3 抽出、消除多处重复算法）
 *
 * 之前 plan-runner / phase-ack route / approve-phase-dialog 三处都自己写
 * `phases.indexOf(cur) + 1 < length ? phases[idx+1] : null`、容易漂移。
 *
 * 入参用 `WorkflowDef`（不是 `WorkflowId`）：避免 client-side 反查 WORKFLOWS、
 * 也方便单测；调用方通常已经拿到 workflowDef、直接传过去。
 *
 * - 返 `null` = 当前是最后一个 phase（approve 后 workflow 结束）
 * - 返 PhaseId = 下一 phase 的 id
 * - `current` 不在 workflowDef.phases 里（异常）也返 null、由调用方决定怎么 fallback
 */
export const getNextPhase = (
  workflowDef: WorkflowDef,
  current: PhaseId,
): PhaseId | null => {
  const idx = workflowDef.phases.indexOf(current);
  if (idx < 0) return null;
  return workflowDef.phases[idx + 1] ?? null;
};

