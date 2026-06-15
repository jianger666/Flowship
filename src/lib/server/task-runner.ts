/**
 * Task runner（V0.6 重构、仅服务 task.mode === "task" 的 task）
 *
 * # 整体模型（详见 docs/V0.6-REFACTOR.md）
 *
 * - **task 容器 + action 历史**：task = 需求生命周期容器、action = 单次动作
 *   （plan / build / review / ship / test / learn）、用户自由触发
 * - **单 SDK Run 永生**：整个 task 共用一个 Agent + Run、task 终态前不退
 * - **每次推进** = 后端 `appendAction` + 向 agent 发 `[NEXT_ACTION ...]` 指令
 * - **每次 ack** = wait-ack write `[ACTION_ACK approve|revise]`
 * - **终态** = wait-ack write `[TASK_DONE]` / `[TASK_ABANDONED]` / `[CANCELLED]`
 *
 * # V0.6.0.1：chat 模式剥离
 *
 * 自由对话（task.mode === "chat"）走独立 chat-runner.ts、不复用本模块。
 * 本模块仅处理 task.mode === "task" 的 feature task。
 *
 * # 跟 V0.5 plan-runner 的差异
 *
 * - phase chain（plan→build→review）拆掉、agent 不再预知 action 顺序、用户每次推进时指定
 * - artifact 命名 `01-plan.md` → `<N>-plan.md`、N = ActionRecord.n（不前导 0）
 * - wait_for_user MCP 参数 `phase` → `actionId`、信号 `[PHASE_ACK]` → `[ACTION_ACK]`
 * - 新增信号：`[NEXT_ACTION ...]`（用户在 UI 推进新 action 时 wait-ack 路由写入）
 *   + `[TASK_DONE]` / `[TASK_ABANDONED]`（finalizeTask 时写、agent 退 Run）
 *
 * # publish/subscribe（SSE 推送）
 *
 * task-runner 内嵌 publish 系统、chat-runner 复用本模块的 publishTaskStreamEvent。
 * 跨进程状态挂 globalThis（避免 Next.js dev hot reload 拆 chunk 时分裂）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Agent } from "@cursor/sdk";
import type { McpServerConfig, ModelSelection, SDKMessage } from "@cursor/sdk";

import {
  appendAction,
  appendActionSideEffectMR,
  appendEvent,
  getActionArtifactPath,
  getActionsDir,
  getEventsLogPath,
  getTask,
  patchAction,
  setFeishuTesterUserKeys,
  upsertGitBranch,
  upsertMR,
  setTaskRepoStatus,
  setTaskRunStatus,
  snapshotActionArtifact,
} from "./task-fs";
import {
  runActionCheck,
  computeWorktreeFingerprint,
  captureActionStartBaseline,
} from "./action-checks";
import { buildSdkErrorMessage } from "./sdk-error";
import {
  cancelPending,
  getChatMcpUrl,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
  submitActionAck,
  submitNextAction,
  submitTaskTerminate,
  unsetChatAwaitingNotifierIf,
  unsetChatTaskActionHandlerIf,
  type AwaitingNotifier,
  type ChatTaskActionHandler,
} from "./chat-mcp";
import { createMR, getMRMergeStatus, closeOpenMR } from "./gitlab-client";
import { validateSubmitMr } from "./submit-mr-guard";
import { ensureStopHookInstalled } from "./stop-hook-inject";
import { reapTaskOrphans } from "./kill-orphans";
import { renderContextDocsSection } from "./context-docs-prompt";
import { waitDisciplineSection } from "./wait-protocol-prompt";
import {
  formatRepoSectionForPrompt,
  getEffectiveCwd,
} from "@/lib/path-utils";
import {
  DEFAULT_BRANCH_TEMPLATE,
  renderBranchName,
} from "@/lib/branch-template";
import {
  loadSkills,
  renderSkillsForPrompt,
  type SkillEntry,
} from "./skills-loader";
import {
  filterDisabledMcp,
  readGlobalCursorMcpServers,
  readGlobalCursorRulesForPrompt,
} from "./cursor-config";
import { enrichMcpServersWithOAuth } from "./mcp-oauth";
import { filterHealthyMcp } from "./mcp-probe";
import type {
  ActionRecord,
  ActionType,
  CheckOverride,
  GitBranchInfo,
  RepoStatus,
  ShipPrecheck,
  Task,
  TaskEvent,
} from "@/lib/types";
import {
  ACTION_FRESH_AGENT_DEFAULT,
  ACTION_LABEL,
  MCP_HEALTH_LABEL,
  TASK_ROLE_LABEL,
  TEST_STRATEGY_LABEL,
} from "@/lib/types";
import { computeBatchProgress } from "@/lib/task-display";
import { buildNextActionHead } from "@/lib/protocol-signals";

// ----------------- 配置 -----------------

// task 不主动超时（用户随时可能 24h 后才 ack）
const TASK_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// chat-mcp 在 Agent.mcpServers 里的注册名（agent prompt 里得点明、跟 V0.5 沿用）
const TASK_TOOL_MCP_NAME = "aiFlowChat";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");
const SUPER_PROMPT_FILE = "_super.md";
const SHARED_PROMPT_FILE = "_shared.md";

// 每种 action 对应的 prompt 文件、_super.md 占位符注入用
const ACTION_PROMPT_FILE: Record<ActionType, string> = {
  plan: "action-plan.md",
  build: "action-build.md",
  review: "action-review.md",
  ship: "action-ship.md",
  test: "action-test.md",
  learn: "action-learn.md",
};

// 已实装的 action 类型（advanceTask 准入门槛 1）
// learn V0.6.29 实装；test 待上线、当前拒绝
const AVAILABLE_ACTIONS: ReadonlySet<ActionType> = new Set([
  "plan",
  "build",
  "review",
  "ship",
  "learn",
]);

const NULL_PLACEHOLDER = "（未提供）";

// ----------------- prompt 模板渲染 -----------------

// V0.5 沿用：缺失 / 空白都替换成「（未提供）」、防漏 business 字段
const fillTemplate = (
  template: string,
  vars: Record<string, string | undefined>,
): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v && v.trim().length > 0 ? v.trim() : NULL_PLACEHOLDER;
  });

// V0.5.11 沿用：super-prompt 专用、空字符串保留字面（如不 fork 时占位段 = ""）
const renderSuperPromptTemplate = (
  template: string,
  vars: Record<string, string | undefined>,
): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) return NULL_PLACEHOLDER;
    return v;
  });

const loadFileSafe = async (rel: string): Promise<string> => {
  const fpath = path.join(PROMPTS_DIR, rel);
  try {
    return await fs.readFile(fpath, "utf-8");
  } catch (err) {
    return `（prompt 文件 ${rel} 未找到：${err instanceof Error ? err.message : String(err)}）`;
  }
};

const loadSharedPrompt = async (task: Task): Promise<string> => {
  const tpl = await loadFileSafe(SHARED_PROMPT_FILE);
  return fillTemplate(tpl, {
    repoPath: getEffectiveCwd(task.repoPaths),
    taskId: task.id,
  });
};

// 加载某个 action 的 prompt、填模板变量
// V0.6 模板可用占位符：
//   {{taskId}} / {{taskTitle}} / {{repoPath}}（effective cwd）
//   {{role}} / {{roleLabel}}
//   {{actionArtifactsDir}}（绝对路径、给 agent write 用）
//   {{eventsLogPath}}（V0.6.29、learn action 挖事件日志用）
// ⚠️ 加占位符记得同步 tests/protocol-signals.test.ts 的供值表对账
const loadActionPrompt = async (
  type: ActionType,
  task: Task,
): Promise<string> => {
  const fname = ACTION_PROMPT_FILE[type];
  const tpl = await loadFileSafe(fname);
  return fillTemplate(tpl, {
    taskId: task.id,
    taskTitle: task.title,
    repoPath: getEffectiveCwd(task.repoPaths),
    role: task.role,
    roleLabel: TASK_ROLE_LABEL[task.role],
    actionArtifactsDir: getActionsDir(task.id),
    eventsLogPath: getEventsLogPath(task.id),
  });
};

// ----------------- super-prompt 拼装 -----------------

/**
 * V0.6.27：只注入**当前 action** 的 playbook（原 V0.6 全量注入 6 种、已废）。
 *
 * 改单注入的原因：
 *   - V0.6.27 起每 action 默认新 agent（见 ACTION_FRESH_AGENT_DEFAULT 注释）、
 *     一个 Run 大概率只跑一种 action、其余 5 个 playbook 是纯指令稀释
 *   - 全量注入还有「串台」风险——plan agent 看得见 ship 的 git push 指令
 *   - 例外路径（用户勾「续用当前 agent」）收到 [NEXT_ACTION] 时、载荷里会附带
 *     新 action 的完整 playbook（见 buildNextActionDirective）、指令不会缺
 *
 * @param firstNextAction 首次启动时、把第一个 [NEXT_ACTION ...] 指令也拼到 prompt 末尾
 *                        让 agent 起 Run 第一动作就是执行用户选的 action
 */
const buildSuperPrompt = async (
  task: Task,
  skills: SkillEntry[],
  firstNextAction: {
    action: ActionRecord;
    userInstruction: string;
    attachedImagePaths?: string[];
    attachedFilePaths?: string[];
    branchCheckoutHint?: string;
    batchDirective?: string;
  },
): Promise<string> => {
  const template = await loadFileSafe(SUPER_PROMPT_FILE);
  const sharedRules = await loadSharedPrompt(task);
  // 全局 rules（~/.cursor/rules/、user 层、settingSources["project"] 够不着、fe 读了注入）
  const rulesSection = await readGlobalCursorRulesForPrompt();

  // 只加载当前 action 的 playbook（后续 action 的指令随 [NEXT_ACTION] 载荷下发）
  const currentType = firstNextAction.action.type;
  const currentActionPlaybook = [
    `### Action: ${currentType}`,
    "",
    await loadActionPrompt(currentType, task),
  ].join("\n");

  // 当前已存在的 action history（agent 起 Run 时能看到之前的工作）
  const actionHistorySection = renderActionHistorySection(task);

  // 第一个 [NEXT_ACTION ...] 指令（含用户指令、附件、branch checkout hint）
  const firstActionDirective = buildNextActionDirective(firstNextAction);

  return renderSuperPromptTemplate(template, {
    taskId: task.id,
    taskTitle: task.title,
    repoSection: formatRepoSectionForPrompt(task.repoPaths),
    repoBranchSection: renderRepoBranchSection(task),
    repoPath: getEffectiveCwd(task.repoPaths),
    roleLabel: TASK_ROLE_LABEL[task.role],
    role: task.role,
    contextDocsSection: renderContextDocsSection(
      task,
      "→ 没有上下文文档时、按 action 内容判断要不要主动调 MCP / read / grep 摸资料。",
    ),
    rulesSection,
    skillsSection: renderSkillsForPrompt(skills),
    eventsLogPath: getEventsLogPath(task.id),
    actionArtifactsDir: getActionsDir(task.id),
    sharedRules,
    actionHistorySection,
    firstActionDirective,
    currentActionPlaybook,
    // V0.7.20：等待纪律共用片段（chat / task 单一源、见 wait-protocol-prompt.ts）
    waitDiscipline: waitDisciplineSection(),
  });
};

// 起 Run 时把已有 action history 一并 inject、agent 知道之前做过啥
// 首次启动 task（actions 只有刚 append 的那一条）时返回「无历史」段
const renderActionHistorySection = (task: Task): string => {
  // 软删核心：excluded（用户划除）的 action 不进 agent 上下文——不列摘要、不引导 read artifact。
  // 这个函数是 agent 上下文的主来源、过滤掉就治本了「冗余/跑歪 action 污染后续推进」。
  const visible = task.actions.filter((a) => !a.excluded);
  if (visible.length <= 1) {
    return "（这是 task 的第一个 action、无历史）";
  }
  const lines: string[] = ["以下是已完成 / 进行中的历史 action（按时间正序）："];
  for (const a of visible) {
    const artifactBit = a.artifactPath ? ` artifact=\`${a.artifactPath}\`` : "";
    lines.push(`  - \`${a.id}\` n=${a.n} type=${a.type} status=${a.status}${artifactBit}`);
    if (a.userInstruction && a.userInstruction.trim().length > 0) {
      lines.push(`    用户指令：${a.userInstruction.slice(0, 200)}`);
    }
  }
  lines.push(
    "",
    "需要参考时用 SDK 内置 `read` 工具读 artifactPath（路径相对 task 根、agent cwd 是仓库、不能直接 cd 到 task 根、用绝对路径如下表）：",
  );
  for (const a of visible) {
    if (!a.artifactPath) continue;
    lines.push(`  - \`${getActionArtifactPath(task.id, a.n, a.type)}\``);
  }
  return lines.join("\n");
};

// V0.6.7：渲染「仓库分支配置」段注入 super prompt——ship 读测试分支、各 action 兜底参考
// 每仓列：线上分支（feature 拉取基线）/ 测试分支（ship 提测 MR 目标）/ dev 分支
const renderRepoBranchSection = (task: Task): string => {
  const repoPaths = task.repoPaths ?? [];
  if (repoPaths.length === 0) return "（无绑定仓库）";
  const lines: string[] = [
    "每个仓的分支配置（建 task 时从设置页快照固化、ship 提测目标分支以此为准）：",
    "",
  ];
  for (const p of repoPaths) {
    const online = task.repoBaseBranches?.[p]?.trim();
    const test = task.repoTestBranches?.[p]?.trim();
    const dev = task.repoDevBranches?.[p]?.trim();
    const tail = p.split("/").filter(Boolean).pop() ?? p;
    lines.push(
      `- \`${tail}\`（${p}）：线上分支=${online || "（未配、自动探测）"}、` +
        `测试分支=${test || "test（默认）"}、dev 分支=${dev || "（未配）"}`,
    );
  }
  return lines.join("\n");
};

// V0.6.6 热更：agent 长生期间用户可能在详情页编辑 role / title / feishuStoryUrl、
// 用 agent 启动时的快照 diff 出「变了哪几项」、reused 推进时注入告知。
// 注：model 是 SDK Run 启动时绑定的硬约束、改了只能换新 agent、不在热更之列。
interface TaskFieldsSnapshot {
  title: string;
  role: Task["role"];
  feishuStoryUrl?: string;
}

const captureTaskFieldsSnapshot = (task: Task): TaskFieldsSnapshot => ({
  title: task.title,
  role: task.role,
  feishuStoryUrl: task.feishuStoryUrl,
});

// diff 当前 task vs 启动快照、只把变了的字段拼成一段 [TASK_UPDATED]；无变化返 undefined（不注入）
const buildTaskUpdateHint = (
  task: Task,
  snapshot: TaskFieldsSnapshot,
): string | undefined => {
  const lines: string[] = [];
  if (task.role !== snapshot.role) {
    lines.push(
      `- ⚠️ 角色已从「${TASK_ROLE_LABEL[snapshot.role]}」改为「${TASK_ROLE_LABEL[task.role]}」、后续所有 action 以此角色视角为准、忽略开头 super prompt 里的旧角色`,
    );
  }
  if (task.title !== snapshot.title) {
    lines.push(`- 任务标题已更新为「${task.title}」`);
  }
  const oldUrl = snapshot.feishuStoryUrl ?? "";
  const newUrl = task.feishuStoryUrl ?? "";
  if (oldUrl !== newUrl) {
    lines.push(newUrl ? `- 飞书链接已更新为 ${newUrl}` : "- 飞书链接已清空");
  }
  if (lines.length === 0) return undefined;
  return [
    "[TASK_UPDATED] 用户在详情页编辑了任务字段、以下为最新值：",
    ...lines,
  ].join("\n");
};

// 构造 build 的「本次做哪批」指令段（注入 NEXT_ACTION、放用户指令之后）
//
// - 无批次（plan 没拆 / 没 plan）→ undefined、不注入本段、build 退化「做全部」老流程
// - requestedBatchIds 空（V0.6.29 批次选填）→「自由改动」指令——修 bug / 跨批次散改、
//   只做用户指令里的事、不开做未完成批次、不计批次进度（老语义「空=全做」已废、想全做点全选）
// - 进度（累计 X/Y 批）派生自 computeBatchProgress、纯算不存计数器
const buildBatchDirective = (
  task: Task,
  requestedBatchIds?: string[],
): string | undefined => {
  const { batches, doneIds, total } = computeBatchProgress(task);
  if (batches.length === 0) return undefined;

  // V0.6.29：用户没勾批次 = 自由改动（多见于多轮之后回头修 bug、忘了 / 不属于哪个批次）
  if (!requestedBatchIds || requestedBatchIds.length === 0) {
    const doneCount = batches.filter((b) => doneIds.has(b.id)).length;
    return [
      `[BUILD_BATCHES] 本需求 plan 共拆 ${total} 个批次（已完成 ${doneCount}/${total}）、但**本次 build 不绑定批次**——用户没有勾选批次、这是一次自由改动（修 bug / 跨批次散改）：`,
      "- **范围**：只做用户指令里点到的事、范围以指令为准",
      "- **不要顺手开做未完成批次**——批次推进要用户在推进 dialog 里显式勾选、不归这次",
      "- **进度**：本次不计入批次进度、artifact 总览「本次完成批次」写「无（自由改动）」",
    ].join("\n");
  }

  const selected = batches.filter((b) => requestedBatchIds.includes(b.id));
  if (selected.length === 0) return undefined;

  const isAll = selected.length === batches.length;
  const afterIds = new Set([...doneIds, ...selected.map((b) => b.id)]);
  const afterDone = batches.filter((b) => afterIds.has(b.id)).length;

  const lines: string[] = [
    `[BUILD_BATCHES] 本需求 plan 共拆 ${total} 个批次、本次 build 只做下面 ${selected.length} 个${
      isAll ? "（= 全部批次）" : "（挑批：其它批次的 task 这次一行都不要碰）"
    }：`,
  ];
  for (const b of selected) {
    const redo = doneIds.has(b.id) ? "　⚠️ 这批之前 build 过、本次是返工" : "";
    lines.push(
      `  - [${b.id}] ${b.title}　测试策略=${TEST_STRATEGY_LABEL[b.testStrategy]}　含：${
        b.taskRefs.length > 0 ? b.taskRefs.join(" / ") : "见 plan §5"
      }${redo}`,
    );
  }
  lines.push(
    "",
    "分批 build 规则：",
    "- **范围**：只做上面列出批次对应的 plan §5 task、属于其它批次的 task 这次不要碰",
    "- **测试策略**：TDD 批先写测试看红 → 实现到绿；实现后测试批先实现再补关键路径；免测批跳过测试",
    "- **留痕**：build artifact 总览写明「本次完成批次：<id 列表>」、给 review / 进度核对用",
    `- **进度**：做完本次累计 ${afterDone}/${total} 批${
      afterDone >= total
        ? "（全部批次做完、后续可推整体 review 看批次之间是否打架）"
        : ""
    }`,
  );
  return lines.join("\n");
};

// 构造 review 的「本次复核范围」指令段（注入 NEXT_ACTION、放用户指令之后）
//
// 大需求分批 build 时、review 分两层：增量（还有批次没做完、聚焦新批 + 衔接）vs
// 集成（全部批次做完、重点查批次之间打不打架）。这里纯派生进度、给 agent 明确信号、
// 省得它自己猜「这次该增量还是全量」（对应用户原始疑问）。
// - 无批次 → undefined、常规单次 review、不注入本段
const buildReviewScopeDirective = (task: Task): string | undefined => {
  const { total, done } = computeBatchProgress(task);
  if (total === 0) return undefined;
  const allDone = done >= total;
  return [
    `[REVIEW_SCOPE] 本需求 plan 分了 ${total} 批 build、目前已完成 ${done}/${total} 批。`,
    allDone
      ? "→ 本次按**集成 review**：常规差值 + bug 复审之外、重点查「批次之间是否打架」（接口对接 / 数据流 / 重复实现 / 类型冲突）。详见 review prompt §4.5。"
      : `→ 本次按**增量 review**：聚焦最近 build 的批次改动、并检查它跟已完成批次的衔接（还剩 ${total - done} 批没 build、别把「没做的批次」误判成漏实现 / 未完成 task）。详见 review prompt §4.5。`,
  ].join("\n");
};

// 构造一个 [NEXT_ACTION ...] 头部 + 任务字段热更 + 用户指令 + 批次指令 + 附件段 + branch checkout hint
// V0.6.27：续接路径（用户勾「续用当前 agent」）可传 actionPlaybook——super prompt 只注入了启动时
// 那个 action 的 playbook、续接的新 action 指令必须随载荷下发（同类型也附、利用新近性强化遵循）
const buildNextActionDirective = (input: {
  action: ActionRecord;
  userInstruction: string;
  attachedImagePaths?: string[];
  attachedFilePaths?: string[];
  branchCheckoutHint?: string;
  taskUpdateHint?: string;
  batchDirective?: string;
  actionPlaybook?: string;
}): string => {
  const {
    action,
    userInstruction,
    attachedImagePaths,
    attachedFilePaths,
    branchCheckoutHint,
    taskUpdateHint,
    batchDirective,
    actionPlaybook,
  } = input;
  const head = buildNextActionHead({
    actionId: action.id,
    actionType: action.type,
    n: action.n,
    artifactPath: action.artifactPath ?? undefined,
  });
  const lines: string[] = [head, ""];
  // 任务字段热更（仅 reused 路径会传、有变化才有值）放最前、让 agent 先校准上下文再读指令
  if (taskUpdateHint && taskUpdateHint.trim().length > 0) {
    lines.push(taskUpdateHint.trim(), "");
  }
  if (userInstruction.trim().length > 0) {
    lines.push(userInstruction.trim(), "");
  } else {
    lines.push("（用户没填具体指令、按本 action 标准流程执行）", "");
  }
  // V0.6.23：build 分批指令（仅 build 且 plan 有批次时有值）放用户指令后、让 agent 先框定本次范围
  if (batchDirective && batchDirective.trim().length > 0) {
    lines.push(batchDirective.trim(), "");
  }
  if (attachedImagePaths && attachedImagePaths.length > 0) {
    lines.push(
      "[ATTACHED_IMAGES] 用户附了以下图片、请用 `read` 工具逐一读取：",
      ...attachedImagePaths.map((p, i) => `  ${i + 1}. ${p}`),
      "",
    );
  }
  if (attachedFilePaths && attachedFilePaths.length > 0) {
    lines.push(
      "[ATTACHED_PATHS] 用户附了以下文件 / 目录、按需用 `read` / `grep` / `glob` 读取：",
      ...attachedFilePaths.map((p, i) => `  ${i + 1}. ${p}`),
      "",
    );
  }
  if (branchCheckoutHint && branchCheckoutHint.trim().length > 0) {
    lines.push("---", "", branchCheckoutHint.trim(), "");
  }
  // 续接路径：附本 action 的完整 playbook（你启动时注入的是别的 action 的指令、以这份为准）
  if (actionPlaybook && actionPlaybook.trim().length > 0) {
    lines.push(
      "---",
      "",
      `## 本 action（${action.type}）的执行指令（以这份为准、覆盖你 context 里其它 action 的指令段）`,
      "",
      actionPlaybook.trim(),
      "",
    );
  }
  return lines.join("\n");
};

const buildRestartActionInstruction = (task: Task, action: ActionRecord): string => {
  const lines: string[] = [
    "[RESTART_ACTION]",
    "当前 action 因 SDK/agent 断开或用户手动重启而重新拉起。不要追加新 action、不要从零重做，继续完成同一个 action。",
    "",
    "重启后的第一步：",
    `- 先读取事件日志，确认断点和用户最近反馈：\`${getEventsLogPath(task.id)}\``,
    "- 再检查相关仓库当前工作区，基于已存在的半成品继续推进。",
  ];

  if (action.artifactPath) {
    lines.push(
      `- 如果已有 artifact，请先读取并在同一路径继续覆盖更新：\`${getActionArtifactPath(task.id, action.n, action.type)}\``,
    );
  }
  if (action.userInstruction.trim().length > 0) {
    lines.push("", "原始用户指令：", action.userInstruction.trim());
  }
  lines.push(
    "",
    "完成后仍然调用 `wait_for_user({ task_id, action_id, artifact_path })`，等待用户对这个同一个 action approve / revise。",
  );
  return lines.join("\n");
};

// ----------------- 工具截断 -----------------

const truncate = (s: string, max = 500): string =>
  s.length <= max ? s : `${s.slice(0, max)}…(truncated ${s.length - max} chars)`;

const stringifyMeta = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

// ----------------- 流事件类型（publish/subscribe 协议） -----------------

// V0.6：跟 V0.5 ChatStreamEvent 同结构（避免 watch-task 路由 / use-task-watch hook 同步改）
// kind:
//   - event: events.jsonl 写新事件、UI 增量渲染
//   - task: task 状态变化（meta 更新）、UI 重 hydrate
//   - action: 单条 ActionRecord 更新（V0.6 新、UI 增量刷 timeline）
//   - done: agent run 终止（运行时层、跟 task 业务终态独立）
//   - error: 顶层错误（用于显示 toast）
//   - assistant_delta: assistant_message 流式 chunk、UI 拼接打字效果
export type TaskStreamEvent =
  | { kind: "event"; event: TaskEvent }
  | { kind: "task"; task: Task }
  | { kind: "action"; action: ActionRecord }
  | { kind: "done"; task: Task; ok: boolean }
  | { kind: "error"; message: string }
  | { kind: "assistant_delta"; text: string };

export type TaskStreamListener = (ev: TaskStreamEvent) => void;

// ----------------- 进程全局状态（挂 globalThis） -----------------

interface RunningTaskRecord {
  agentId: string;
  startedAt: number;
  // V0.6.6 热更：agent 启动时的 {title,role,feishuStoryUrl} 快照、reused 推进时 diff 出变更注入 directive
  startSnapshot: TaskFieldsSnapshot;
  cancel: () => void;
}

interface TaskRunnerGlobalState {
  // taskId → 运行中的 task 控制对象
  runningTasks: Map<string, RunningTaskRecord>;
  // taskId → 订阅者集合（watch-task 路由 subscribe）
  subscribers: Map<string, Set<TaskStreamListener>>;
  // V0.6：标记 task 即将被 force new agent（advanceTask forceNewAgent=true）
  // cancel 旧 run 时命中跳过 done、保留 SSE 通道给新 agent 用
  forkPendingTasks: Set<string>;
}

// V2：2026-05-27 V0.6 上线、bump 版本号防 dev hot reload 拿到 V0.5 残留 state
const TASK_RUNNER_GLOBAL_KEY = "__feAiFlowTaskRunnerStateV2__";

const getRunnerState = (): TaskRunnerGlobalState => {
  const g = globalThis as unknown as Record<
    string,
    TaskRunnerGlobalState | undefined
  >;
  if (!g[TASK_RUNNER_GLOBAL_KEY]) {
    g[TASK_RUNNER_GLOBAL_KEY] = {
      runningTasks: new Map(),
      subscribers: new Map(),
      forkPendingTasks: new Set(),
    };
  }
  return g[TASK_RUNNER_GLOBAL_KEY]!;
};

const runningTasks = getRunnerState().runningTasks;
const subscribers = getRunnerState().subscribers;
const forkPendingTasks = getRunnerState().forkPendingTasks;

// ----------------- publish / subscribe -----------------

const publish = (taskId: string, ev: TaskStreamEvent): void => {
  const set = subscribers.get(taskId);
  if (!set || set.size === 0) return;
  for (const listener of set) {
    try {
      listener(ev);
    } catch (err) {
      console.error("[task-runner] subscriber listener threw:", err);
    }
  }
};

export const publishTaskStreamEvent = (
  taskId: string,
  ev: TaskStreamEvent,
): void => publish(taskId, ev);

export const subscribeTaskStream = (
  taskId: string,
  listener: TaskStreamListener,
): (() => void) => {
  let set = subscribers.get(taskId);
  if (!set) {
    set = new Set();
    subscribers.set(taskId, set);
  }
  set.add(listener);
  return () => {
    const cur = subscribers.get(taskId);
    if (!cur) return;
    cur.delete(listener);
    if (cur.size === 0) subscribers.delete(taskId);
  };
};

// 持久化 + publish 一体（防御性吞错、不让 IO 抖动挡 SDK 主流程）
// V0.6.27：appendEvent 改返回 event 本身（轻量路径、不再 hydrate 全量 Task）
const writeEventAndPublish = async (
  taskId: string,
  ev: Omit<TaskEvent, "id" | "ts">,
): Promise<TaskEvent | null> => {
  try {
    const event = await appendEvent(taskId, ev);
    if (event) publish(taskId, { kind: "event", event });
    return event;
  } catch (err) {
    console.warn(
      `[task-runner] writeEventAndPublish 失败 task=${taskId} kind=${ev.kind}：`,
      err,
    );
    return null;
  }
};

// ----------------- 公开 query API -----------------

export const cancelTaskRun = (taskId: string): boolean => {
  const rec = runningTasks.get(taskId);
  if (!rec) return false;
  rec.cancel();
  return true;
};

/**
 * V0.6.3：agent_id 反查 task_id（stop hook 认领用）
 *
 * runningTasks 是 task_id → { agentId, ... }、这里遍历找 agentId 匹配的（活着的 task 数量很小、
 * 遍历开销可忽略）。找不到 = 不是当前活着的 fe task（IDE agent / 已死 task）、stop hook 应放行。
 */
export const findTaskIdByAgentId = (agentId: string): string | null => {
  for (const [taskId, rec] of runningTasks) {
    if (rec.agentId === agentId) return taskId;
  }
  return null;
};

const waitForTaskToStop = async (
  taskId: string,
  timeoutMs = 8000,
): Promise<boolean> => {
  const rec = runningTasks.get(taskId);
  if (!rec) return true;
  const start = Date.now();
  while (runningTasks.has(taskId)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
};

/**
 * V0.5.7 沿用：强制清除 in-memory runner state（dev hot reload / 手改 meta.json 后用）
 * 调用方负责对 task 当前是否真的活做判断、本函数不验证
 */
const forceClearStaleRunnerState = (taskId: string): void => {
  runningTasks.delete(taskId);
  forkPendingTasks.delete(taskId);
};

// ----------------- 准入门槛 1：action 类型 + 上游 action 依赖 -----------------

interface PrerequisiteContext {
  gitHost?: string;
  gitToken?: string;
}

const checkActionPrerequisites = (
  task: Task,
  actionType: ActionType,
  ctx: PrerequisiteContext = {},
): { ok: true } | { ok: false; reason: string } => {
  if (!AVAILABLE_ACTIONS.has(actionType)) {
    return {
      ok: false,
      reason: `action 类型「${ACTION_LABEL[actionType]}」尚未实现、当前支持 plan / build / review / ship / learn。`,
    };
  }

  const lastCompletedOfType = (t: ActionType): ActionRecord | undefined =>
    task.actions
      .slice()
      .reverse()
      .find((a) => a.type === t && a.status === "completed");

  switch (actionType) {
    case "plan":
      return { ok: true }; // 永远可
    case "build":
      // V0.6.17：放开「build 必须先 plan」——小改 / 修 bug 直接 build、plan 是过度流程。
      // 有 plan 时按 plan 工单走、无 plan 时按用户指令直接改（范围以指令为准、靠 review 兜底）。
      return { ok: true };
    case "review":
      if (!lastCompletedOfType("build")) {
        return {
          ok: false,
          reason: "review 前需要至少 1 个已 approve 的 build action。先推进 build、再进 review。",
        };
      }
      return { ok: true };
    case "ship": {
      // V0.6.1 准入：
      //   1. 至少 1 个 build 已 approve（不强求 review、用户可跳过 review 直接 ship）
      //   2. settings 配了 gitHost + gitToken（不然 server 没法调 GitLab API）
      if (!lastCompletedOfType("build")) {
        return {
          ok: false,
          reason: "ship 前需要至少 1 个已 approve 的 build action。先推进 build、再进 ship。",
        };
      }
      if (!ctx.gitHost || ctx.gitHost.trim().length === 0) {
        return {
          ok: false,
          reason: "ship 需要配 GitLab Host、请去「设置 → GitLab 配置」填上（如 gitlab.wukongedu.net）。",
        };
      }
      if (!ctx.gitToken || ctx.gitToken.trim().length === 0) {
        return {
          ok: false,
          reason: "ship 需要配 GitLab Personal Access Token、请去「设置 → GitLab 配置」填上（需要 api scope）。",
        };
      }
      return { ok: true };
    }
    case "learn": {
      // V0.6.29 放宽（原草稿要求 merged 后 + 整 task 一次）：
      //   - 很多沉淀点在 review / ship 阶段就暴露了、且用户不一定及时标 merged
      //   - 多次跑无危害（prompt 要求第二轮先读上一轮 learn artifact、不重复提炼）
      const hasCompleted = task.actions.some(
        (a) => a.type !== "learn" && a.status === "completed",
      );
      if (!hasCompleted) {
        return {
          ok: false,
          reason:
            "learn 需要至少 1 个已完成的 action（plan / build / review / ship）——有了过程才有可沉淀的经验。",
        };
      }
      return { ok: true };
    }
    case "test":
      // 已被上面 AVAILABLE_ACTIONS 拦掉、走不到这里
      return { ok: false, reason: "test action 未实现" };
    default: {
      const _: never = actionType;
      return { ok: false, reason: `未知 action 类型：${_}` };
    }
  }
};

/**
 * V0.6.25 ship gate：最新 build 的 CheckRun 没过 / 没配 / 没运行时、要求 per-ship override（风险接受、不是偏好）
 *
 * - 只看「最新一个 completed build」的 checkRun（ship 提的就是它的产出）
 * - checkRun.status === passed **且各仓工作区指纹没变** → 直接放行
 * - 工作区指纹比对（V0.6.25 review）：check 后又改工作区 → 指纹不一致、即使 passed 也要 override（防「曾经检查过」≠「当前要 ship 的内容检查过」）
 * - failed / not_configured / 没 checkRun（老 build / 异常）→ 必须带 override、且：
 *   · override.buildActionId 等于这个 build（重 build = 新 build action id、旧 override 自动失效）
 *   · checkRun 存在时 override.checkRunId 也要等于它（双保险：同 build 重跑过 check 也失效）
 *   · override.reason 非空（审计：为什么明知没过还提测）
 * - HITL 底线：这道门永远能被 override 越过、但必须留痕。
 */
const checkShipCheckGate = async (
  task: Task,
  override?: CheckOverride,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const lastBuild = task.actions
    .slice()
    .reverse()
    .find((a) => a.type === "build" && a.status === "completed");
  // 没 completed build 的情况由 checkActionPrerequisites 先拦、这里兜底放行
  if (!lastBuild) return { ok: true };

  const cr = lastBuild.checkRun;
  let worktreeChanged = false;
  if (cr) {
    for (const repo of cr.repos) {
      if (!repo.worktreeFingerprint) continue;
      const current = await computeWorktreeFingerprint(repo.repoPath);
      if (current && current !== repo.worktreeFingerprint) {
        worktreeChanged = true;
        break;
      }
    }
  }
  if (cr && cr.status === "passed" && !worktreeChanged) return { ok: true };

  const why = worktreeChanged
    ? "检查通过后工作区又被改动（建议重新 build 检查、或确认风险后强制提测）"
    : !cr
      ? "未运行检查"
      : cr.status === "failed"
        ? "检查未通过"
        : cr.status === "not_configured"
          ? "有改动的仓没配检查命令"
          : "检查未通过";
  if (!override) {
    return {
      ok: false,
      reason: `最新 build 的${why}、ship 被拦。如确认无碍、请在提测 dialog 勾「仍继续提测」并填写原因。`,
    };
  }
  if (override.buildActionId !== lastBuild.id) {
    return {
      ok: false,
      reason:
        "提测确认已失效（绑定的不是最新 build、可能你又 build 过）、请重新勾选确认。",
    };
  }
  if (cr && override.checkRunId !== cr.id) {
    return {
      ok: false,
      reason: "提测确认已失效（检查已重跑）、请重新勾选确认。",
    };
  }
  if (!override.reason.trim()) {
    return { ok: false, reason: "提测确认必须填写原因。" };
  }
  return { ok: true };
};

/**
 * V0.6.25 review：ship 前置预检（GET /api/tasks/[id]/ship-precheck 调）
 *
 * 复用 checkShipCheckGate（不带 override）跑一遍、把结论给 client 展示 override 区。
 * gate 逻辑单一源在此、client 不自己用 checkRun.status 猜。⚠ 仅展示、/advance 仍会重算 gate。
 */
export const getShipPrecheck = async (task: Task): Promise<ShipPrecheck> => {
  const lastBuild = task.actions
    .slice()
    .reverse()
    .find((a) => a.type === "build" && a.status === "completed");
  // 没 completed build：ship 准入会被 checkActionPrerequisites 拦、这里不涉及 override
  if (!lastBuild) {
    return {
      needsOverride: false,
      reason: "",
      buildActionId: null,
      checkRunId: null,
      reviewMissing: false,
    };
  }
  const gate = await checkShipCheckGate(task);
  // V0.6.27 F3：最新 build 之后有没有 completed review——没有就提醒（非阻断、HITL 用户可跳过）。
  // 按 startedAt 比：action 串行、review 启动晚于 build 启动即必然 review 的是这轮 build 后的代码。
  const reviewMissing = !task.actions.some(
    (a) =>
      a.type === "review" &&
      a.status === "completed" &&
      !a.excluded &&
      a.startedAt > lastBuild.startedAt,
  );
  return {
    needsOverride: !gate.ok,
    reason: gate.ok ? "" : gate.reason,
    buildActionId: lastBuild.id,
    checkRunId: lastBuild.checkRun?.id ?? null,
    reviewMissing,
  };
};

// ----------------- branch checkout 挂接（build action 第一次跑前）-----------------

/**
 * V0.6.1：build action 第一动作前、拼每仓 GitBranchInfo + 引导 agent 逐仓 idempotent checkout
 *
 * branch 命名规则（V0.6 拍板、多仓共用同一 name）：
 *   `feature/<username>/<飞书 story id>-<task.title 转换后>`
 *   - username 取自 settings.username
 *   - 飞书 story id 从 task.feishuStoryUrl 抠 URL 末段数字（如 detail/6956910305）
 *   - task.title 转换：保留中文、空白/特殊字符替换为 -
 *
 * base branch 探测交给 agent：每仓自探（不同仓可能 master / main / develop）
 *
 * V0.6.1 简化：**每次 build 都 inject hint、agent 跑 idempotent shell**
 *   （branch 存在 → checkout、不存在 → 基于探到的主分支建）、不再维护 checkedOut 状态。
 *   gitBranches 数组只在首次建条目时落库、之后保留 createdAt 历史值。
 *
 * 返回 null：缺 username / feishuStoryUrl / repoPaths 为空、不建 branch
 */
const planBranchesForBuild = (
  task: Task,
  username: string | undefined,
): { infos: GitBranchInfo[]; promptHint: string } | null => {
  // V0.6.7：username 不再硬性必需（后端模板可能用 {date} 段替代 {username} 段）；
  //   storyId 仍需要（默认 + 后端模板都含 {storyId}）、feishuStoryUrl 空则不建分支
  if (!task.feishuStoryUrl || task.feishuStoryUrl.trim().length === 0) {
    return null;
  }
  const repoPaths = task.repoPaths ?? [];
  if (repoPaths.length === 0) {
    return null;
  }

  // 飞书 story id：URL 里 detail/<digits> 这段、最长一段连续数字兜底
  const m = task.feishuStoryUrl.match(/detail\/(\d+)/) ??
    task.feishuStoryUrl.match(/(\d{6,})/);
  const storyId = m ? m[1] : null;
  if (!storyId) {
    return null;
  }

  const now = Date.now();
  // V0.6.7：分支名按 per-repo 有效模板渲染（task.repoBranchTemplates 建 task 时固化、缺省回退内置默认）。
  //   占位符 {username}/{storyId}/{taskTitle}/{date:fmt}、值各自 branch-safe 化、详见 branch-template.ts
  const renderForRepo = (repoPath: string): string =>
    renderBranchName(
      task.repoBranchTemplates?.[repoPath] || DEFAULT_BRANCH_TEMPLATE,
      { username, storyId, taskTitle: task.title },
    );

  // 每仓 1 条 GitBranchInfo（已存在的保留历史记录、不覆盖 baseBranch / createdAt）
  // V0.6.3：用户给某仓填了「已有工作分支」→ 用它当 name（build 复用、不另建）；否则按模板渲染。
  //   name 落库到 gitBranches[].name、ship 提测的 MR 源分支也取这个、自动用对。
  const existing = task.gitBranches ?? [];
  const infos: GitBranchInfo[] = repoPaths.map((repoPath) => {
    const old = existing.find((b) => b.repoPath === repoPath);
    if (old) return old;
    const explicitName = task.repoFeatureBranches?.[repoPath]?.trim();
    return {
      repoPath,
      name: explicitName || renderForRepo(repoPath),
      baseBranch: "",
      checkedOut: false,
      createdAt: now,
    };
  });

  // 多仓 hint：逐仓 idempotent checkout（branch 存在则 checkout、不存在则建）
  const isMultiRepo = repoPaths.length > 1;
  // V0.6.3：每仓实际分支名取自 infos（可能因用户指定「已有工作分支」而各仓不同名）
  const uniqueNames = [...new Set(infos.map((i) => i.name))];
  const lines: string[] = [];
  lines.push("## 准入：build 第一动作、逐仓 idempotent checkout 分支");
  lines.push("");
  if (isMultiRepo) {
    if (uniqueNames.length === 1) {
      lines.push(
        `本 task 涉及 ${repoPaths.length} 个仓、共用同一 branch name：\`${uniqueNames[0]}\``,
      );
    } else {
      lines.push(
        `本 task 涉及 ${repoPaths.length} 个仓、各仓 branch name 见下（部分仓指定了已有分支）`,
      );
    }
  } else {
    lines.push(`本 task 的 branch name：\`${infos[0]?.name ?? ""}\``);
  }
  lines.push("");
  lines.push(
    "**第一动作**：调 `shell` 工具、对每个仓跑下面 idempotent 命令（branch 存在则 checkout、不存在则基于主分支建）：",
  );
  lines.push("");

  for (const repoPath of repoPaths) {
    // V0.6.3：该仓实际分支名（用户指定的已有分支 or 模板渲染名）、下面 checkout 用它
    const name =
      infos.find((i) => i.repoPath === repoPath)?.name ??
      renderForRepo(repoPath);
    if (isMultiRepo) {
      lines.push(`### 仓 \`${repoPath}\``);
      lines.push("");
    }
    lines.push("```bash");
    if (isMultiRepo) {
      lines.push(`cd ${repoPath}`);
    }
    // V0.6.3：该仓的线上分支（建 task 时从 settings 快照、per-repo）。配了就用、没配回退探测
    const repoBase = task.repoBaseBranches?.[repoPath]?.trim();
    if (repoBase) {
      // 用户在设置页给这个仓配了线上分支 → 直接用、不探测（后端 develop 默认分支会误判）
      lines.push("# 线上分支由用户在设置页指定（per-repo）、不探测");
      lines.push(`BASE=${JSON.stringify(repoBase)}`);
      lines.push("# 校验该分支在远程存在（防设置里填错名）");
      lines.push(
        'if ! git ls-remote --exit-code --heads origin "$BASE" >/dev/null 2>&1; then',
      );
      lines.push(
        '  echo "[error] 远程不存在分支 $BASE（设置页填的线上分支名、请核对）、放弃 checkout"',
      );
      lines.push("  exit 1");
      lines.push("fi");
    } else {
      lines.push("# 探主分支名（master / main / develop 都可能、用户没手填线上分支）");
      lines.push(
        "BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')",
      );
      lines.push('if [ -z "$BASE" ]; then');
      lines.push(
        "  BASE=$(git remote show origin 2>/dev/null | sed -n '/HEAD branch:/s/.*: //p')",
      );
      lines.push("fi");
      lines.push('if [ -z "$BASE" ]; then');
      lines.push('  echo "[error] 探不到主分支、放弃 checkout、稍后回报用户"');
      lines.push("  exit 1");
      lines.push("fi");
    }
    lines.push("# Idempotent：branch 已存在则 checkout、否则基于主分支建");
    lines.push(`if git show-ref --verify --quiet refs/heads/${name}; then`);
    lines.push(`  git checkout ${name}`);
    lines.push("else");
    lines.push(
      `  git fetch origin "$BASE" && git checkout -b ${name} "origin/$BASE"`,
    );
    lines.push("fi");
    // V0.6.20 防御：checkout 后强制 verify 当前分支 == 目标分支。
    //   防 checkout 静默失败 / 仍停在别的 task 分支上、agent 继续在错分支改代码（曾踩坑：
    //   agent 没切分支直接在别的需求 feature 分支上改、污染了那个分支）。
    lines.push("# 防御：确认确实切到目标分支（不对就停、绝不在错分支改代码）");
    lines.push("CURRENT=$(git rev-parse --abbrev-ref HEAD)");
    lines.push(`if [ "$CURRENT" != ${JSON.stringify(name)} ]; then`);
    lines.push(
      `  echo "[error] 当前分支 $CURRENT != 目标分支 ${name}、停止 build（不要在错分支改代码、调 wait_for_user 报告用户）"`,
    );
    lines.push("  exit 1");
    lines.push("fi");
    lines.push(`echo "[ok] 已在目标分支 ${name}"`);
    lines.push("```");
    lines.push("");
  }

  lines.push(
    "checkout 成功后、按下面 build action 标准流程做实施（多仓 task：所有仓都得 checkout 成功才开始改代码）。",
  );
  lines.push(
    "checkout 失败（工作区脏 / 探不到主分支 / 仓不是 git 仓库）→ emit 一段简短 assistant_message 告知问题、调 wait_for_user 等用户处理（**不要**自己 force / reset 操作硬盘）。",
  );

  return { infos, promptHint: lines.join("\n") };
};

// ----------------- 公开 mutation API -----------------

/**
 * V0.6 主推进入口
 *
 * 行为分支：
 *  1. 已有 running entry 在 chat-mcp pendingMap（agent 在待命态 / 等 ack）→ submitNextAction 续接
 *  2. 没 entry（首次启动 / agent 已退出 / 用户选 forceNewAgent）→ Agent.create + 启 Run
 *
 * 调用方应保证：
 *  - task 已 hydrate（getTask 拿到非 null）
 *  - settings.apiKey / model 已校验
 *（MCP 不再由调用方传：runner 自己读全局 ~/.cursor/mcp.json + 按 task.disabledMcpServers 过滤）
 */
export interface AdvanceTaskInput {
  task: Task;
  actionType: ActionType;
  userInstruction: string;
  attachedImagePaths?: string[];
  attachedFilePaths?: string[];
  apiKey: string;
  model: ModelSelection;
  // V0.6.27 语义反转：默认每 action 起新 Agent（context 截断治跑偏）、勾「续用当前 agent」才续接。
  // true = 续用内存里活着的 agent entry（续接 [NEXT_ACTION]、省 send 配额）；
  // 注：ACTION_FRESH_AGENT_DEFAULT 里 true 的 action（review）勾了续用也强起 fresh。
  reuseAgent?: boolean;
  // 设置页 username（拼 build branch 名用、缺省时不建 branch）
  username?: string;
  // V0.6.1 ship action 用：GitLab host（不带协议）+ Personal Access Token
  // 来自 settings.gitHost / gitToken、agent 启动时快照、改 token 需 forceNewAgent
  gitHost?: string;
  gitToken?: string;
  // V0.6.23：build 分批——本次做哪些批次（推进 dialog 勾选、仅 build、空=自由改动不计进度）
  requestedBatchIds?: string[];
  // V0.6.25 CheckRun：ship 时的 gate override（最新 build 的 check 没过 / 没配、用户勾「仍继续」+ reason）
  //   server 端校验它绑的是最新 build 的 checkRun（防重 build 后失效的 override 蒙混过关）、仅 ship 用
  checkOverride?: CheckOverride;
}

export interface RestartCurrentActionInput {
  task: Task;
  actionId?: string;
  apiKey: string;
  model: ModelSelection;
  username?: string;
  gitHost?: string;
  gitToken?: string;
}

/**
 * 收尾 task 里所有「卡在非终态」（running / awaiting_ack）的 action（V0.6.12）
 *
 * 单 Run 多 action 模型下、Run 结束有多条路径（finished / error / cancel / fork / finalize）、
 * 早期各自只收尾「闭包起的那个 action」或「currentActionId 指的那个」、会漏掉 Run 期间推进出来的新 action
 * （典型踩坑：agent 推进到 act_N awaiting_ack 后 run error、catch 却去收尾「起 agent 时的旧 action」）
 * → 遗留 action 永久卡 awaiting_ack、既划不掉（action-exclude 409）又停不掉（currentActionId 已被清 null）。
 * 这个 helper 统一把所有非终态 action 收掉、各路径调它即可、不再各写一份。
 *
 * @param status         收尾成的终态：agent 异常退出 → error；用户主动停 / 换 agent / abandon → cancelled
 * @param exceptActionId 排除某个 action（force-new-agent 时刚 appendAction 的新 action 还要继续跑、别误伤）
 */
const finalizeStaleActions = async (
  taskId: string,
  status: "error" | "cancelled",
  exceptActionId?: string,
): Promise<void> => {
  const fresh = await getTask(taskId);
  if (!fresh) return;
  const stale = fresh.actions.filter(
    (a) =>
      a.id !== exceptActionId &&
      (a.status === "running" || a.status === "awaiting_ack"),
  );
  for (const a of stale) {
    await patchAction(taskId, a.id, { status });
  }
};

// ----------------- P1-3：同一 task 的 advanceTask 串行化 -----------------
//
// advanceTask 全程 async（appendAction → 路由决策 → internalStartAgent 里 Agent.create/send）、
// 中间多个 await。并发触发（双击「推进」/ 多标签页同时推进同一 task）会踩两个坑：
//   ① appendAction 各追加一条 action（凭空多出一条）；
//   ② 决策时都读到「runningTasks 无 entry」→ 各起一个 agent、后 set 的把前一个覆盖 → 旧 agent 泄漏。
// 解法：按 taskId 把 advanceTask 串起来——同 task 排队执行、不同 task 互不阻塞。
//
// V0.6.27 改挂 globalThis：advance route 和 restart-action route 是不同 chunk、
// module-level Map 各持一份会让这道串行化跨 route 失效（同 runningTasks 的老坑）。
const ADVANCE_CHAINS_KEY = "__feAiFlowAdvanceChainsV1__";
const getAdvanceChains = (): Map<string, Promise<void>> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, Promise<void>> | undefined
  >;
  if (!g[ADVANCE_CHAINS_KEY]) g[ADVANCE_CHAINS_KEY] = new Map();
  return g[ADVANCE_CHAINS_KEY]!;
};
const advanceChains = getAdvanceChains();

const runAdvanceExclusive = async <T>(
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const prev = advanceChains.get(taskId) ?? Promise.resolve();
  // 本次的「门」：跑完后 release() 放行下一个排队者
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // 新链尾 = 等前驱跑完 + 等本次 gate 打开（吞前驱错、不让前一个失败把后续永久卡死）
  const tail = prev.then(() => gate);
  advanceChains.set(taskId, tail);
  await prev.catch(() => {}); // 排队：阻塞到上一个 advance 结束
  try {
    return await fn();
  } finally {
    release();
    // 我是当前链尾 → 删 key、避免 Map 随 task 数无限增长（identity 比对、有人排在后面则保留）
    if (advanceChains.get(taskId) === tail) {
      advanceChains.delete(taskId);
    }
  }
};

export const advanceTask = async (
  input: AdvanceTaskInput,
): Promise<{ action: ActionRecord }> =>
  runAdvanceExclusive(input.task.id, () => advanceTaskInner(input));

const advanceTaskInner = async (
  input: AdvanceTaskInput,
): Promise<{ action: ActionRecord }> => {
  const {
    task,
    actionType,
    userInstruction,
    attachedImagePaths,
    attachedFilePaths,
    apiKey,
    model,
    reuseAgent,
    username,
    gitHost,
    gitToken,
    requestedBatchIds,
    checkOverride,
  } = input;

  // V0.6.27 默认反转：每 action 默认起新 agent（context 截断是治跑偏的根、artifact 是唯一接力棒）。
  // 用户勾「续用当前 agent」（reuseAgent）才续接——除了 ACTION_FRESH_AGENT_DEFAULT 里 true 的
  // action（review = 换人复审铁律）、勾了也压不掉。
  const effectiveForceNewAgent =
    !reuseAgent || ACTION_FRESH_AGENT_DEFAULT[actionType];

  // 1) 准入条件（V0.6 门槛 1）
  const pre = checkActionPrerequisites(task, actionType, { gitHost, gitToken });
  if (!pre.ok) {
    throw new Error(`准入条件不满足：${pre.reason}`);
  }

  // V0.6.25 ship gate：最新 build 的 CheckRun 没过 / 没配 / 工作区指纹变了时、要求 per-ship override（绑当前 checkRunId）
  // async：要重算 git 指纹比对（防 check 后又改工作区）
  if (actionType === "ship") {
    const gate = await checkShipCheckGate(task, checkOverride);
    if (!gate.ok) {
      throw new Error(`准入条件不满足：${gate.reason}`);
    }
  }

  // 2) appendAction：写一条新 ActionRecord、task.runStatus 自动转 running
  const created = await appendAction(task.id, {
    type: actionType,
    userInstruction,
    agentModel: model,
    // V0.6.23：仅 build 带批次选择（其它 action 不传、appendAction 内部空数组也归 undefined）
    requestedBatchIds: actionType === "build" ? requestedBatchIds : undefined,
  });
  if (!created) {
    throw new Error(`appendAction 失败 task=${task.id}（task 不存在）`);
  }
  const { task: taskAfterAppend, action } = created;
  publish(task.id, { kind: "task", task: taskAfterAppend });
  publish(task.id, { kind: "action", action });
  // V0.6.25：ship gate override 落到本 ship action（审计：明知 check 没过仍提测的原因 + 绑定指纹）
  if (actionType === "ship" && checkOverride) {
    await patchAction(task.id, action.id, {
      checkOverride: { ...checkOverride, createdAt: Date.now() },
    });
  }
  // V0.6.27：review / build 启动基线（review=各仓内容指纹、build=兄弟仓状态 hash）
  // 后置检查比对用（review 只读硬校验 / 兄弟仓越权检测）、采集失败 fail-open 不挡启动
  if (actionType === "review" || actionType === "build") {
    const baseline = await captureActionStartBaseline(task, actionType);
    if (baseline) {
      await patchAction(task.id, action.id, { startBaseline: baseline });
      action.startBaseline = baseline;
    }
  }
  await writeEventAndPublish(task.id, {
    kind: "action_start",
    actionId: action.id,
    // V0.6.25：ship override reason 拼进事件流——审计「明知 check 没过仍提测」的可见留痕（reviewer 要求至少进 task event）
    text: `开始 ${ACTION_LABEL[actionType]}（${action.type}）n=${action.n}${
      userInstruction.trim().length > 0 ? `\n用户指令：${truncate(userInstruction, 200)}` : ""
    }${
      actionType === "ship" && checkOverride
        ? `\n⚠ 绕过检查提测、原因：${truncate(checkOverride.reason, 200)}`
        : ""
    }`,
    meta: { type: actionType, n: action.n, artifactPath: action.artifactPath },
  });

  // 3) branch checkout 挂接（仅 build action、V0.6.1 每次都 inject 多仓 idempotent hint）
  let branchCheckoutHint: string | undefined;
  if (actionType === "build") {
    const planned = planBranchesForBuild(taskAfterAppend, username);
    if (planned) {
      // 仅新仓 upsert（已存在的保留 createdAt / baseBranch 历史值、不覆盖）
      const existingRepos = new Set(
        (taskAfterAppend.gitBranches ?? []).map((b) => b.repoPath),
      );
      for (const info of planned.infos) {
        if (!existingRepos.has(info.repoPath)) {
          await upsertGitBranch(task.id, info);
        }
      }
      branchCheckoutHint = planned.promptHint;
    }
  }

  // V0.6.23：分批指令——plan 拆了批次时注入 NEXT_ACTION（taskAfterAppend 含最新 plan 的 planBatches）
  // - build：拼「本次做哪批」（含本 build 的 requestedBatchIds）
  // - review：拼「当前进度 + 增量 / 集成建议」（纯派生、不需选批）
  const batchDirective =
    actionType === "build"
      ? buildBatchDirective(taskAfterAppend, requestedBatchIds)
      : actionType === "review"
        ? buildReviewScopeDirective(taskAfterAppend)
        : undefined;

  // 4) 决定路由
  const existingRecord = runningTasks.get(task.id);
  if (existingRecord && !effectiveForceNewAgent) {
    // V0.6.6 热更：agent 长生期间用户可能在详情页改了 role / title / feishuStoryUrl
    // diff 启动快照、有变才拼一段 [TASK_UPDATED] 注入；注入后把快照推进到当前值、避免下次重复告知同一变更
    const taskUpdateHint = buildTaskUpdateHint(
      taskAfterAppend,
      existingRecord.startSnapshot,
    );
    existingRecord.startSnapshot = captureTaskFieldsSnapshot(taskAfterAppend);
    // V0.6.27：续接载荷附本 action 的完整 playbook——super prompt 只注入了启动时那个
    // action 的指令、续接的新 action（哪怕同类型）以载荷这份为准
    const actionPlaybook = await loadActionPrompt(action.type, taskAfterAppend);
    // agent 在「待命态」（等下一 action 指令）、submitNextAction 直接续接
    const ok = submitNextAction(
      task.id,
      {
        actionId: action.id,
        type: action.type,
        n: action.n,
        artifactPath: action.artifactPath ?? "",
      },
      buildNextActionDirective({
        action,
        userInstruction,
        attachedImagePaths,
        attachedFilePaths,
        branchCheckoutHint,
        taskUpdateHint,
        batchDirective,
        actionPlaybook,
      }),
      attachedImagePaths,
      attachedFilePaths,
    );
    if (!ok) {
      // race：runningTasks entry 存在但 chat-mcp pendingMap 没（agent 已死、entry 还没清）
      // 走「force new agent」分支补救
      console.warn(
        `[task-runner] advanceTask: task=${task.id} runningTasks 有 entry 但 submitNextAction 失败、降级 force-new-agent`,
      );
      await internalStartAgent({
        task: taskAfterAppend,
        action,
        userInstruction,
        attachedImagePaths,
        attachedFilePaths,
        branchCheckoutHint,
        apiKey,
        model,
        gitHost,
        gitToken,
        batchDirective,
      });
    }
    return { action };
  }

  // 5) 没活 agent / forceNewAgent：起新 Run
  if (existingRecord && effectiveForceNewAgent) {
    forkPendingTasks.add(task.id);
    existingRecord.cancel();
    const stopped = await waitForTaskToStop(task.id, 5000);
    if (!stopped) {
      console.warn(
        `[task-runner] advanceTask: task=${task.id} 旧 agent 没在 5s 内停、强清 runner state 继续`,
      );
      forceClearStaleRunnerState(task.id);
    }
    // 收尾被新 agent 取代的旧非终态 action（排除本次刚 appendAction 的新 action、否则误伤）
    await finalizeStaleActions(task.id, "cancelled", action.id);
  }
  await internalStartAgent({
    task: taskAfterAppend,
    action,
    userInstruction,
    attachedImagePaths,
    attachedFilePaths,
    branchCheckoutHint,
    apiKey,
    model,
    gitHost,
    gitToken,
    batchDirective,
  });

  return { action };
};

export const restartCurrentAction = async (
  input: RestartCurrentActionInput,
): Promise<{ action: ActionRecord }> =>
  runAdvanceExclusive(input.task.id, () => restartCurrentActionInner(input));

const restartCurrentActionInner = async (
  input: RestartCurrentActionInput,
): Promise<{ action: ActionRecord }> => {
  const fresh = await getTask(input.task.id);
  if (!fresh) throw new Error("task 不存在、无法重启当前 action");
  if (fresh.mode === "chat") {
    throw new Error("chat 模式不支持 action 重启，请继续发消息");
  }
  if (fresh.repoStatus === "merged" || fresh.repoStatus === "abandoned") {
    throw new Error("任务已终结，不能重启当前 action");
  }

  const actionId = input.actionId ?? fresh.currentActionId;
  if (!actionId) {
    throw new Error("当前没有可重启的 action");
  }
  const action = fresh.actions.find((a) => a.id === actionId);
  if (!action) {
    throw new Error(`action ${actionId} 不存在、无法重启`);
  }
  if (action.status === "awaiting_ack") {
    throw new Error("当前 action 已在等待确认，请用「再聊聊」继续修改");
  }
  if (action.status === "completed") {
    throw new Error("已通过的 action 不能重启，请推进新的 action");
  }

  const existingRecord = runningTasks.get(fresh.id);
  if (existingRecord) {
    forkPendingTasks.add(fresh.id);
    existingRecord.cancel();
    const stopped = await waitForTaskToStop(fresh.id, 5000);
    if (!stopped) {
      console.warn(
        `[task-runner] restartCurrentAction: task=${fresh.id} 旧 agent 没在 5s 内停、强清 runner state 继续`,
      );
      forceClearStaleRunnerState(fresh.id);
    }
  }
  cancelPending(fresh.id);
  reapTaskOrphans(fresh.repoPaths);

  const patchedTask = await patchAction(fresh.id, action.id, { status: "running" });
  const patchedAction =
    patchedTask?.actions.find((a) => a.id === action.id) ?? action;
  if (patchedTask) {
    publish(fresh.id, { kind: "task", task: patchedTask });
    publish(fresh.id, { kind: "action", action: patchedAction });
  }
  let startTask =
    (await setTaskRunStatus(fresh.id, "running", action.id)) ??
    patchedTask ??
    fresh;
  publish(fresh.id, { kind: "task", task: startTask });

  await writeEventAndPublish(fresh.id, {
    kind: "info",
    actionId: action.id,
    text: `用户重启了当前 ${ACTION_LABEL[action.type]} action（n=${action.n}），沿用原 action 继续执行`,
    meta: { restartedActionId: action.id, actionType: action.type, n: action.n },
  });

  let branchCheckoutHint: string | undefined;
  if (action.type === "build") {
    const planned = planBranchesForBuild(startTask, input.username);
    if (planned) {
      const existingRepos = new Set(
        (startTask.gitBranches ?? []).map((b) => b.repoPath),
      );
      for (const info of planned.infos) {
        if (!existingRepos.has(info.repoPath)) {
          await upsertGitBranch(fresh.id, info);
        }
      }
      branchCheckoutHint = planned.promptHint;
      startTask = (await getTask(fresh.id)) ?? startTask;
    }
  }
  const startAction =
    startTask.actions.find((a) => a.id === action.id) ?? patchedAction;
  const batchDirective =
    startAction.type === "build"
      ? buildBatchDirective(startTask, startAction.requestedBatchIds)
      : startAction.type === "review"
        ? buildReviewScopeDirective(startTask)
        : undefined;

  await internalStartAgent({
    task: startTask,
    action: startAction,
    userInstruction: buildRestartActionInstruction(startTask, startAction),
    branchCheckoutHint,
    apiKey: input.apiKey,
    model: input.model,
    gitHost: input.gitHost,
    gitToken: input.gitToken,
    batchDirective,
  });

  return { action: startAction };
};

/**
 * V0.6 ack：approve / revise 当前 action
 *
 * - approve：write [ACTION_ACK approve] → agent 接着调 wait_for_user(待命态) 等下一 action
 *   后端 patch action.status=awaiting_ack（之前是 running）→ completed（approve 时）
 * - revise：先 snapshotActionArtifact 旧版本、再 write [ACTION_ACK revise] + feedback
 *   action.status 保持 running（agent 接着改）
 */
export const acknowledgeAction = async (
  taskId: string,
  actionId: string,
  decision: "approve" | "revise",
  feedback?: string,
  imagePaths?: string[],
): Promise<void> => {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error("task 不存在、无法 ack action");
  }
  const action = task.actions.find((a) => a.id === actionId);
  if (!action) {
    throw new Error(`action ${actionId} 不存在`);
  }
  // P0-1：只有「agent 正在等 ack」（awaiting_ack）的 action 才能 ack。
  //   running（ask_user 进行中 / revise 后还在改）/ completed / cancelled 一律拒——
  //   配合 chat-mcp submitActionAck 的 pending.actionId 绑定校验、双层堵住「ack 错对象」。
  if (action.status !== "awaiting_ack") {
    throw new Error(
      `action ${actionId} 当前状态 ${action.status}、不是在等 ack（awaiting_ack）、无法 ack`,
    );
  }

  if (decision === "revise" && action.artifactPath) {
    await snapshotActionArtifact(taskId, actionId).catch((err) => {
      console.warn(
        `[task-runner] snapshotActionArtifact 失败 task=${taskId} action=${actionId}（吞错继续）：`,
        err,
      );
    });
  }

  const res = submitActionAck(taskId, actionId, decision, feedback, imagePaths);
  if (!res.ok) {
    throw new Error(
      `${res.reason}（agent 可能已推进 / 已退出、刷新后重试、或点「推进」起新 agent）`,
    );
  }

  // V0.6：approve 时 action 标 completed；revise 时 agent 已重新开跑，同步把 task.runStatus 拉回 running。
  // 之前只把 action 改回 running、task 仍停在 awaiting_user，会出现「当前 action=running 但顶部显示推进」的僵尸组合。
  const patched = await patchAction(taskId, actionId, {
    status: decision === "approve" ? "completed" : "running",
  });
  if (patched) {
    publish(taskId, { kind: "task", task: patched });
    const newAction = patched.actions.find((a) => a.id === actionId);
    if (newAction) publish(taskId, { kind: "action", action: newAction });
  }
  if (decision === "revise") {
    const running = await setTaskRunStatus(taskId, "running", actionId);
    if (running) publish(taskId, { kind: "task", task: running });
  }
  await writeEventAndPublish(taskId, {
    kind: "action_ack",
    actionId,
    text:
      decision === "approve"
        ? `Action ${action.type} n=${action.n} 已通过`
        : `Action ${action.type} n=${action.n} 用户要求改：${truncate(feedback ?? "", 200)}`,
    meta: { decision, feedback: feedback ? truncate(feedback, 500) : undefined },
  });
};

/**
 * V0.6 终态：task 合入 / abandon
 *
 * - merged：write [TASK_DONE]、agent 收尾退出、setTaskRepoStatus=merged + runStatus=idle
 *   V0.6.29 起 merged 后推进 dialog 默认选 learn（沉淀时机、runner 准入允许）
 * - abandoned：write [TASK_ABANDONED]、agent 立刻退、setTaskRepoStatus=abandoned + runStatus=idle
 */
export const finalizeTask = async (
  taskId: string,
  finalStatus: Extract<RepoStatus, "merged" | "abandoned">,
  reason?: string,
): Promise<void> => {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error("task 不存在、无法 finalize");
  }

  // 让 agent 拿到终态信号、自然退出 Run
  const kind = finalStatus === "merged" ? "done" : "abandoned";
  const ok = submitTaskTerminate(taskId, kind, reason);
  if (!ok) {
    // 信号发不出去 = agent 不在 wait 挂起。两种情况：
    //   a) agent 已退出 → runningTasks 无 entry、什么都不用做
    //   b) agent 正在跑（如 build 中途）→ 不硬停的话它会继续改代码、之后挂在
    //      wait_for_user 上没人再发终态信号、长挂到超时——而 task 在 UI 已显示终态。
    //      finalize 语义就是「关掉这个 task」、直接 cancel 掉 SDK Run。
    const hadLiveRun = cancelTaskRun(taskId);
    console.log(
      `[task-runner] finalizeTask: task=${taskId} 没活 pending、${
        hadLiveRun ? "硬停了运行中的 agent" : "agent 已退出"
      }、patch repoStatus=${finalStatus}`,
    );
  }

  // 兜底收尾遗留的非终态 action（防 abandon / merge 后 action 卡 awaiting_ack、永久划不掉）
  await finalizeStaleActions(taskId, "cancelled");

  // 业务状态 patch
  const patched = await setTaskRepoStatus(taskId, finalStatus);
  if (patched) publish(taskId, { kind: "task", task: patched });
  await setTaskRunStatus(taskId, "idle", null);

  await writeEventAndPublish(taskId, {
    kind: "info",
    text:
      finalStatus === "merged"
        ? `Task 已标合入 main、收尾结束${reason ? `（${reason}）` : ""}`
        : `Task 已被 abandon${reason ? `（${reason}）` : ""}`,
    meta: { finalStatus, reason },
  });
};

/**
 * 恢复终态 task（merged / abandoned → developing）、让它能重新推进（V0.6.12）
 *
 * 误 abandon、或想把已终结的 task 重新捡起来继续时用。只翻 repoStatus、
 * runStatus 保持 idle（没有活 agent、用户后续点「推进」才起新 Run）。
 */
export const reopenTask = async (taskId: string): Promise<void> => {
  const task = await getTask(taskId);
  if (!task) throw new Error("task 不存在、无法恢复");
  if (task.repoStatus !== "merged" && task.repoStatus !== "abandoned") {
    throw new Error("只有已合入 / 已放弃的任务才能恢复");
  }
  const patched = await setTaskRepoStatus(taskId, "developing");
  if (patched) publish(taskId, { kind: "task", task: patched });
  await writeEventAndPublish(taskId, {
    kind: "info",
    text: "任务已恢复（→ 开发中）、可继续推进",
  });
};

// ----------------- 内部：起新 Agent + 消息循环 -----------------

interface StartAgentInput {
  task: Task;
  action: ActionRecord;
  userInstruction: string;
  attachedImagePaths?: string[];
  attachedFilePaths?: string[];
  branchCheckoutHint?: string;
  apiKey: string;
  model: ModelSelection;
  // V0.6.1 ship action 用：注册 task-scoped action handler 时闭包
  gitHost?: string;
  gitToken?: string;
  // V0.6.23：build 分批指令（仅 build 有值、拼进首个 NEXT_ACTION）
  batchDirective?: string;
}

const internalStartAgent = async (input: StartAgentInput): Promise<void> => {
  const {
    task,
    action,
    userInstruction,
    attachedImagePaths,
    attachedFilePaths,
    branchCheckoutHint,
    apiKey,
    model,
    gitHost,
    gitToken,
    batchDirective,
  } = input;

  // 已有活 entry 时不重启（advanceTask 入口已处理 forceNewAgent 时的 cancel）
  if (runningTasks.has(task.id)) {
    console.warn(
      `[task-runner] internalStartAgent: task=${task.id} 已有 running entry、跳过（幂等）`,
    );
    return;
  }

  // 1) merge MCP：全局 cursor mcp（按 task 黑名单过滤）+ chat-tool（我们的 wait_for_user / ask_user）
  //    全局 ~/.cursor/mcp.json 由 fe 读（settingSources["project"] 够不着 user 层）、
  //    per-task 用 task.disabledMcpServers 精简、详见 cursor-config.ts
  // 注入 OAuth token：走 OAuth 授权的远程 MCP（如飞书项目）token 不在 mcp.json、
  // 由 fe 自己跑过 OAuth 落盘、起 agent 前补到 headers.Authorization、详见 mcp-oauth.ts
  const enrichedMcp = await enrichMcpServersWithOAuth(
    filterDisabledMcp(
      await readGlobalCursorMcpServers(),
      task.disabledMcpServers,
    ),
  );
  // V0.6.11 容错：起 agent 前剔除连不上 / 未授权的远程 MCP、单个 MCP 挂不拖垮整个 run
  const { servers: cursorMcp, dropped: droppedMcp } =
    await filterHealthyMcp(enrichedMcp);
  const mergedMcp: Record<string, McpServerConfig> = {
    ...cursorMcp,
    [TASK_TOOL_MCP_NAME]: {
      type: "http",
      url: getChatMcpUrl(),
    },
  };
  const cursorMcpNames = Object.keys(cursorMcp).filter(
    (n) => n !== TASK_TOOL_MCP_NAME,
  );
  const mcpDesc = `Task MCP: ${TASK_TOOL_MCP_NAME}${
    cursorMcpNames.length > 0 ? ` + cursor MCP: ${cursorMcpNames.join(", ")}` : ""
  }`;

  await writeEventAndPublish(task.id, {
    kind: "info",
    actionId: action.id,
    text: `启动新 agent（model: ${model.id}、${mcpDesc}）`,
  });

  // V0.6.11：有被剔除的 MCP → 写一条提示、让用户知道为什么少了能力（不再「莫名其妙报错」）
  if (droppedMcp.length > 0) {
    await writeEventAndPublish(task.id, {
      kind: "info",
      actionId: action.id,
      text: `⚠️ 已跳过 ${droppedMcp.length} 个不可用的 MCP：${droppedMcp
        .map((d) => `${d.name}（${d.detail?.split("\n")[0] ?? MCP_HEALTH_LABEL[d.status]}）`)
        .join("、")}——相关能力本次不可用、去设置页检查 / 授权`,
    });
  }

  // 2) 注册 task-scoped action handler（V0.6.1 submit_mr / set_feishu_testers）
  // 闭包里持 gitHost / gitToken 快照——task 运行期间不可变、要换 token 需 force-new-agent
  // 具名化：finally 注销走 conditional unset（只清自己这个实例、防 force-new-agent race 误清新 handler）
  const taskActionHandler: ChatTaskActionHandler = async (taskAction) => {
    if (taskAction.kind === "submit_mr") {
      if (!gitHost || !gitToken) {
        return {
          ok: false,
          error: "task 启动时没拿到 GitLab Host / Token、ship 准入应该已被拦、不应该走到这里",
        };
      }
      // P0-2：起 createMR 前、server 端按 task 权威数据 + 该仓真实 git remote 校验 agent 上报。
      // agent 幻觉 / prompt 被污染 / remote 解析出错时、防它用 server PAT 给越权 project 提 MR。
      // 读 fresh task（闭包 task 是启动时快照、不含本轮 ship 刚 upsert 的 MR、且校验要最新 gitBranches）。
      const fresh = await getTask(task.id);
      if (!fresh) {
        return { ok: false, error: "task 不存在、无法校验 submit_mr" };
      }
      const valid = await validateSubmitMr(fresh, taskAction);
      if (!valid.ok) {
        await writeEventAndPublish(task.id, {
          kind: "error",
          actionId: taskAction.actionId,
          text: `提测被拦截（${taskAction.repoPath}）：${valid.error}`,
          meta: {
            repoPath: taskAction.repoPath,
            projectPath: taskAction.projectPath,
          },
        });
        return { ok: false, error: valid.error };
      }

      // V0.6.8：AI 智能解冲突会换 source 分支（feature → feature__conflict）、
      // 先读出该仓「上一次 ship 用的 source 分支」、待新 MR 建好后把旧 MR 关掉（防双 MR 垃圾）。
      const prevMrBranch = fresh.mrs?.find(
        (m) => m.repoPath === taskAction.repoPath,
      )?.branch;

      // V0.6.14：合并后是否删源分支——读 task 配置（缺省保留、用户拍板）。
      // 但 `<feature>__conflict` 一次性解冲突分支必删（不留垃圾分支、不受用户开关影响）。
      const isConflictBranch = taskAction.sourceBranch.endsWith("__conflict");
      const removeSourceBranch = isConflictBranch
        ? true
        : (fresh.removeSourceBranchOnMerge ?? false);

      const result = await createMR({
        config: { host: gitHost, token: gitToken },
        projectPath: taskAction.projectPath,
        sourceBranch: taskAction.sourceBranch,
        targetBranch: taskAction.targetBranch,
        title: taskAction.title,
        description: taskAction.description,
        removeSourceBranch,
      });
      if (!result.ok) {
        await writeEventAndPublish(task.id, {
          kind: "error",
          actionId: taskAction.actionId,
          text: `提测失败（${taskAction.repoPath}）：${result.error}`,
          meta: { repoPath: taskAction.repoPath, projectPath: taskAction.projectPath },
        });
        return { ok: false, error: result.error };
      }

      // 新 MR 建好后、若 source 分支跟上一次不同（= 走了 __conflict 智能解冲突流程）、
      // 把被取代的旧 `<旧分支>→test` MR 关掉。失败只记日志、不阻塞 ship（新 MR 已建好、旧的留着也只是脏）。
      if (prevMrBranch && prevMrBranch !== taskAction.sourceBranch) {
        const closed = await closeOpenMR({
          config: { host: gitHost, token: gitToken },
          projectPath: taskAction.projectPath,
          sourceBranch: prevMrBranch,
          targetBranch: taskAction.targetBranch,
        });
        if (!closed.ok) {
          console.warn(
            `[task-runner] 关旧 MR 失败（${taskAction.projectPath} ${prevMrBranch}→${taskAction.targetBranch}）：${closed.error}`,
          );
        } else if (closed.closed) {
          await writeEventAndPublish(task.id, {
            kind: "info",
            actionId: taskAction.actionId,
            text: `已关闭被取代的旧 MR（${prevMrBranch} → ${taskAction.targetBranch}、冲突废弃）`,
            meta: { repoPath: taskAction.repoPath, projectPath: taskAction.projectPath },
          });
        }
      }

      // V0.6.1.1：MR 建好后 poll GitLab 可合性、检测 feature↔test 冲突
      // GitLab 建 MR 不管有没有冲突都返回成功、冲突要单独查 detailed_merge_status；
      // 且 GitLab 异步算 mergeability、刚建完可能还在 checking、getMRMergeStatus 内部 poll 到稳定
      const mergeStatus = await getMRMergeStatus({
        config: { host: gitHost, token: gitToken },
        projectPath: taskAction.projectPath,
        iid: result.iid,
      });
      // poll 失败 / 超时未定时、保守按「无冲突」处理（不误拦 ship、detailed 记 unknown 供审计）
      const hasConflicts = mergeStatus.ok ? mergeStatus.hasConflicts : false;
      const detailedStatus = mergeStatus.ok ? mergeStatus.detailedStatus : "unknown";
      const mergeUndetermined = mergeStatus.ok ? mergeStatus.undetermined : true;

      // upsert task.mrs[]（按 repoPath、同仓多次 ship 累计 version++）
      const upserted = await upsertMR(task.id, taskAction.repoPath, {
        url: result.url,
        title: taskAction.title,
        branch: taskAction.sourceBranch,
        status: "open",
        createdByActionId: taskAction.actionId,
        lastCommitHash: taskAction.lastCommitHash,
        hasConflicts,
        mergeStatus: detailedStatus,
      });
      const mrVersion = upserted?.mr.version ?? 1;
      if (upserted) {
        publish(task.id, { kind: "task", task: upserted.task });
      }

      // 把本次 MR 原子追加到 action.sideEffects.mrs[]（多仓 task 一次 ship 可能落 N 条）
      // 走 task-fs 原子函数（withTaskLock 包 read-modify-write）、不在这里 getTask→patchAction 两段非原子
      const patched = await appendActionSideEffectMR(task.id, taskAction.actionId, {
        repoPath: taskAction.repoPath,
        mrUrl: result.url,
        mrVersion,
        branch: taskAction.sourceBranch,
        commitHash: taskAction.lastCommitHash,
        hasConflicts,
      });
      if (patched) {
        publish(task.id, { kind: "task", task: patched });
        const a = patched.actions.find((x) => x.id === taskAction.actionId);
        if (a) publish(task.id, { kind: "action", action: a });
      }

      // 有冲突走 error 事件（红、醒目）、无冲突走 info——用户在事件流一眼看到「这条 MR 合不了」
      const mrVerb = mrVersion > 1 ? `推送（v${mrVersion}）` : "创建";
      if (hasConflicts) {
        await writeEventAndPublish(task.id, {
          kind: "error",
          actionId: taskAction.actionId,
          text: `MR 已${mrVerb}、但跟 ${taskAction.targetBranch} 有冲突、需用户手动解决后才能合：${result.url}`,
          meta: {
            repoPath: taskAction.repoPath,
            projectPath: taskAction.projectPath,
            mrUrl: result.url,
            mrIid: result.iid,
            mrVersion,
            mergeStatus: detailedStatus,
          },
        });
      } else {
        await writeEventAndPublish(task.id, {
          kind: "info",
          actionId: taskAction.actionId,
          text: `MR 已${mrVerb}：${result.url}`,
          meta: {
            repoPath: taskAction.repoPath,
            projectPath: taskAction.projectPath,
            mrUrl: result.url,
            mrIid: result.iid,
            mrVersion,
            mergeStatus: detailedStatus,
          },
        });
      }
      return {
        ok: true,
        data: {
          mr_url: result.url,
          mr_iid: result.iid,
          mr_version: mrVersion,
          // agent 据此决策：true → ask_user 让用户解冲突、且本仓「不」发飞书评论
          has_conflicts: hasConflicts,
          merge_status: detailedStatus,
          merge_undetermined: mergeUndetermined,
        },
      };
    }

    if (taskAction.kind === "set_feishu_testers") {
      const patched = await setFeishuTesterUserKeys(
        task.id,
        taskAction.userKeys,
      );
      if (patched) {
        publish(task.id, { kind: "task", task: patched });
      }
      await writeEventAndPublish(task.id, {
        kind: "info",
        actionId: taskAction.actionId,
        text: `已记忆飞书测试人员（${taskAction.userKeys.length} 人、同 task 后续 ship 直接复用）`,
        meta: { userKeys: taskAction.userKeys },
      });
      return { ok: true };
    }

    if (taskAction.kind === "set_plan_batches") {
      // V0.6.23：plan agent 上报拆好的批次 → 落到该 plan action 的 planBatches 字段
      // build 选批 + 进度推导都读「最新 completed plan 的 planBatches」（见 task-display.computeBatchProgress）
      const patched = await patchAction(task.id, taskAction.actionId, {
        planBatches: taskAction.batches,
      });
      if (patched) {
        publish(task.id, { kind: "task", task: patched });
        const a = patched.actions.find((x) => x.id === taskAction.actionId);
        if (a) publish(task.id, { kind: "action", action: a });
      }
      await writeEventAndPublish(task.id, {
        kind: "info",
        actionId: taskAction.actionId,
        text: `已记录 ${taskAction.batches.length} 个批次（build 可分批推进、其余批次先不动）`,
        meta: { batchCount: taskAction.batches.length },
      });
      return { ok: true };
    }

    return { ok: false, error: "未知 task action kind" };
  };
  setChatTaskActionHandler(task.id, taskActionHandler);

  // 3) 注册 awaiting notifier（chat-mcp → runner 的回调）
  // 具名化：同 taskActionHandler、finally 走 conditional unset 防 force-new-agent race 误清
  const awaitingNotifier: AwaitingNotifier = async (signal) => {
    if (signal.kind === "ask_user_request") {
      const previewText = signal.questions
        .map((q, idx) => `Q${idx + 1}: ${q.question}`)
        .join("\n");
      await writeEventAndPublish(task.id, {
        kind: "ask_user_request",
        actionId: signal.actionId,
        text: previewText,
        meta: {
          askId: signal.askId,
          token: signal.token,
          questions: signal.questions,
        },
      });
      const updated = await setTaskRunStatus(task.id, "awaiting_user");
      if (updated) publish(task.id, { kind: "task", task: updated });
      return;
    }

    // awaiting_start：agent 完成一个 action 调 wait_for_user(action_id) → 切 action.status=awaiting_ack
    //                 或 agent 待命 wait_for_user(待命态、不带 action_id) → 只切 runStatus=awaiting_user
    if (signal.actionId) {
      // V0.6 门槛 2：先跑后置 deterministic 检查、把 postCheck 落到 ActionRecord
      // 跑完无论 pass / fail 都切 awaiting_ack（用户看到结果再决定 approve / revise）
      // 跑后置 deterministic 检查（V0.6 门槛 2）
      // V0.6.0.1：检查结果只落到 action.postCheck 字段（meta.json 里）、不再 publish 到事件流给用户看
      // 用户原话：「这个检查不应该给用户看吧、我理解这更像是调试内容」
      // 想 debug 时直接看 data/tasks/<id>/meta.json 里对应 action 的 postCheck 字段、或者后续 UI 加「调试信息」折叠面板
      let postCheck: ActionRecord["postCheck"] | undefined;
      // V0.6.25 CheckRun：build 的结构化校验摘要单独落 checkRun 字段（postCheck 只留 passed/details）
      let checkRun: ActionRecord["checkRun"] | undefined;
      const fresh = await getTask(task.id);
      const targetAction = fresh?.actions.find(
        (a) => a.id === signal.actionId,
      );
      if (fresh && targetAction) {
        try {
          const result = await runActionCheck(fresh, targetAction);
          // postCheck 只存 passed/details（复用红绿条）；checkRun 是 build 专属结构化明细、分开落
          postCheck = { passed: result.passed, details: result.details };
          checkRun = result.checkRun;
          console.log(
            `[task-runner] runActionCheck task=${task.id} action=${signal.actionId} passed=${result.passed} details=${result.details.slice(0, 200)}`,
          );
        } catch (err) {
          console.warn(
            `[task-runner] runActionCheck 异常 task=${task.id} action=${signal.actionId}：`,
            err,
          );
        }
      }

      const patched = await patchAction(task.id, signal.actionId, {
        status: "awaiting_ack",
        ...(postCheck ? { postCheck } : {}),
        ...(checkRun ? { checkRun } : {}),
      });
      if (patched) {
        publish(task.id, { kind: "task", task: patched });
        const a = patched.actions.find((x) => x.id === signal.actionId);
        if (a) publish(task.id, { kind: "action", action: a });
      }
      const updated = await setTaskRunStatus(
        task.id,
        "awaiting_user",
        signal.actionId,
      );
      if (updated) publish(task.id, { kind: "task", task: updated });
      await writeEventAndPublish(task.id, {
        kind: "info",
        actionId: signal.actionId,
        text: `Action 产出完成、等待用户 ack${
          signal.artifactPath ? `（artifact=${signal.artifactPath}）` : ""
        }`,
        meta: {
          artifactPath: signal.artifactPath,
          // 留个标志位给将来 UI 调试面板用、文本里不展示
          postCheckPassed: postCheck?.passed,
          // 里程碑标记：UI 事件流默认展开（action 产出完成等 ack、用户要看 artifact 决定 approve / revise）
          awaitingAck: true,
        },
      });
    } else {
      // 待命态：runStatus 切 awaiting_user、currentActionId 留 null
      const updated = await setTaskRunStatus(task.id, "awaiting_user", null);
      if (updated) publish(task.id, { kind: "task", task: updated });
    }
  };
  setChatAwaitingNotifier(task.id, awaitingNotifier);

  // 4) 启动 Agent + 消息循环（在独立 Promise 里跑、advanceTask 立即返回）
  let agent: Awaited<ReturnType<typeof Agent.create>> | null = null;
  let cancelled = false;
  // V0.6.8：标记本次结束是「换新 agent」（force-new-agent）——是的话 finally 不清孤儿进程、
  // 否则会误杀新 agent 刚在同仓拉起的 shell（带同样签名、cwd 也在 repoPaths）
  let isForkRestart = false;
  let hardTimer: NodeJS.Timeout | null = null;

  // fire-and-forget：advanceTask 立即返回、外部 waitForTaskToStop 靠 poll runningTasks.has 收敛、不依赖此 promise
  void (async () => {
    try {
      // V0.6.3：起 agent 前给业务仓库装 stop hook（保证 agent 交卷后才放行结束 Run、失败不阻断启动）
      const effectiveCwd = getEffectiveCwd(task.repoPaths);
      await ensureStopHookInstalled(effectiveCwd);

      agent = await Agent.create({
        apiKey,
        model,
        // settingSources:["project"] = 加载目标仓库 + 全局 .cursor/ 的 rules/skills/mcp/hooks
        //（跟 Cursor IDE 一致、配置双向绑定）；inline mcpServers 仍叠加生效、
        // chat-tool 安全（同名 inline 优先、不同名共存、已探针实测、见 ROADMAP）
        local: { cwd: effectiveCwd, settingSources: ["project"] },
        mcpServers: mergedMcp,
      });
      console.log(
        `[task-runner] task=${task.id} Agent.create OK agentId=${agent.agentId}`,
      );

      // 加载平台自带 skills（repo + 全局 skills 由 settingSources 交给 SDK 加载、不在此读、避免重复进 prompt）
      const skills = await loadSkills().catch((err) => {
        console.error("[task-runner] loadSkills failed", err);
        return [] as SkillEntry[];
      });
      const superPrompt = await buildSuperPrompt(task, skills, {
        action,
        userInstruction,
        attachedImagePaths,
        attachedFilePaths,
        branchCheckoutHint,
        batchDirective,
      });

      const run = await agent.send(superPrompt);

      runningTasks.set(task.id, {
        agentId: agent.agentId,
        startedAt: Date.now(),
        startSnapshot: captureTaskFieldsSnapshot(task),
        cancel: () => {
          cancelled = true;
          cancelPending(task.id);
          void run.cancel().catch(() => {
            /* noop */
          });
        },
      });

      hardTimer = setTimeout(() => {
        cancelled = true;
        cancelPending(task.id);
        void run.cancel().catch(() => {
          /* noop */
        });
      }, TASK_HARD_TIMEOUT_MS);

      // 流式消费
      const assistantCtx: AssistantBufferCtx = {
        buffer: "",
        flush: async () => {
          const trimmed = assistantCtx.buffer.trim();
          assistantCtx.buffer = "";
          if (trimmed.length === 0) return;
          await writeEventAndPublish(task.id, {
            kind: "assistant_message",
            actionId: undefined,
            text: trimmed,
          });
        },
      };

      for await (const msg of run.stream()) {
        await handleSdkMessage(task.id, msg, assistantCtx);
      }
      await assistantCtx.flush();

      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }

      const result = await run.wait();

      if (cancelled || result.status === "cancelled") {
        const isForkPending = forkPendingTasks.has(task.id);
        if (isForkPending) {
          forkPendingTasks.delete(task.id);
          isForkRestart = true; // 换新 agent：finally 不清孤儿（新 agent 同仓 shell 会被误杀）
          await writeEventAndPublish(task.id, {
            kind: "info",
            text: "旧 agent 已收尾、正在为推进起新 agent...",
          });
          return;
        }
        // 正常 cancel（stop / 硬超时触发）→ 收尾卡住的 action + 关运行时状态
        // （repoStatus 仍由 finalizeTask 管、这里只补 action 收尾、不动业务态）
        await finalizeStaleActions(task.id, "cancelled");
        const updated = await setTaskRunStatus(task.id, "idle", null);
        if (updated) publish(task.id, { kind: "task", task: updated });
        publish(task.id, { kind: "done", task: updated ?? task, ok: true });
        return;
      }

      if (result.status !== "finished") {
        const resultDump = stringifyMeta(result).slice(0, 1500);
        const sdkErr = assistantCtx.sdkErrorMessage
          ? `\n--- SDK stream error message ---\n${assistantCtx.sdkErrorMessage}`
          : "";
        throw new Error(
          `agent run status=${result.status}${sdkErr}\n--- SDK result dump ---\n${resultDump}`,
        );
      }

      // SDK run 自然 finished：在 V0.6 单 Run 永生模型下、这意味着 agent 主动 exit
      // 检查最后一个 action 是否 ack——没 ack 就标 error
      const fresh = await getTask(task.id);
      const lastAction = fresh?.actions[fresh.actions.length - 1];
      if (
        lastAction &&
        (lastAction.status === "running" || lastAction.status === "awaiting_ack")
      ) {
        await patchAction(task.id, lastAction.id, { status: "error" });
        await setTaskRunStatus(task.id, "error", lastAction.id);
        await writeEventAndPublish(task.id, {
          kind: "error",
          actionId: lastAction.id,
          text: [
            `agent 在 action ${lastAction.type} n=${lastAction.n} 没 ack 就自然结束 Run、这通常是协议理解错误`,
            "",
            "下一步：点顶部「推进」选「换新 agent」、或换更稳的模型（claude-opus-4 / claude-sonnet-4）",
          ].join("\n"),
        });
        const updated = await getTask(task.id);
        if (updated) publish(task.id, { kind: "task", task: updated });
        publish(task.id, { kind: "done", task: updated ?? task, ok: false });
      } else {
        // 干净结束：last action 已 completed、agent 自愿退出（极少见、正常应等终态信号）
        const updated = await setTaskRunStatus(task.id, "idle", null);
        if (updated) publish(task.id, { kind: "task", task: updated });
        publish(task.id, { kind: "done", task: updated ?? task, ok: true });
      }
    } catch (err) {
      if (hardTimer) clearTimeout(hardTimer);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[task-runner] task=${task.id} failed:`, err);

      // SDK 错误详情（code/cause/...）抠出来一并落到 event、方便从 events 直接定位根因
      const fullMessage = buildSdkErrorMessage(message, err);

      // 收尾所有卡在非终态的 action（单 Run 多 action：卡住的可能 ≠ 闭包起的 action、见 finalizeStaleActions）
      await finalizeStaleActions(task.id, "error");
      await setTaskRunStatus(task.id, "error", action.id);
      await writeEventAndPublish(task.id, {
        kind: "error",
        actionId: action.id,
        text: `Task agent 失败：${fullMessage}`,
      });
      const errored = await getTask(task.id);
      publish(task.id, { kind: "done", task: errored ?? task, ok: false });
      publish(task.id, { kind: "error", message: fullMessage });
    } finally {
      runningTasks.delete(task.id);
      cancelPending(task.id);
      // conditional unset：只清「自己注册的那个实例」、force-new-agent race 下新 handler/notifier 不被误清
      unsetChatAwaitingNotifierIf(task.id, awaitingNotifier);
      unsetChatTaskActionHandlerIf(task.id, taskActionHandler);
      // V0.6.8：真正结束（停止 / 自然退出 / 报错）才清孤儿进程；换新 agent 不清（见 isForkRestart 注释）
      if (!isForkRestart) reapTaskOrphans(task.repoPaths);
      if (agent) {
        try {
          agent.close();
        } catch {
          /* noop */
        }
      }
    }
  })();
};

// ----------------- SDKMessage 翻译器（沿用 V0.5 plan-runner 同款分支）-----------------

interface AssistantBufferCtx {
  buffer: string;
  flush: () => Promise<void>;
  sdkErrorMessage?: string;
}

// 「写文件」类工具名白名单——只有这些工具命中 actions/ 路径才算「在写 artifact」。
// SDK 的 read（读）和 edit（写）都用 path 参数、无法靠 args 区分读写、只能靠工具名。
// 宁可漏标（某写工具不在表里 → 降级成「调用 X」、无害）、不可错标（read 标成「在写」= 误导）。
const WRITE_TOOL_NAMES = new Set([
  "write",
  "edit",
  "create",
  "create_file",
  "search_replace",
  "str_replace",
  "multi_edit",
  "MultiEdit",
  "apply_patch",
]);

const handleSdkMessage = async (
  taskId: string,
  msg: SDKMessage,
  assistantCtx: AssistantBufferCtx,
): Promise<void> => {
  switch (msg.type) {
    case "thinking": {
      await assistantCtx.flush();
      await writeEventAndPublish(taskId, {
        kind: "thinking",
        text: msg.text,
        meta: msg.thinking_duration_ms
          ? { durationMs: msg.thinking_duration_ms }
          : undefined,
      });
      break;
    }

    case "tool_call": {
      await assistantCtx.flush();
      const argsAny = (msg.args ?? {}) as Record<string, unknown>;
      const innerToolName =
        typeof argsAny.toolName === "string" ? argsAny.toolName : "";
      const isWaitForUser =
        msg.name === "wait_for_user" ||
        msg.name === "Wait For User" ||
        innerToolName === "wait_for_user" ||
        innerToolName === "Wait For User";

      // V0.6：write / edit 写 actions/N-<type>.md 时推一份「在写 artifact」事件给 UI（同 V0.5 artifacts/ 同款套路）
      // ⚠️ 必须先用 WRITE_TOOL_NAMES 卡是不是「写」工具——read 跟 edit 都用 path 参数、
      //    早期漏判直接看 path、导致 read artifact 被误标成「在写 artifact」
      //    （V0.6.12 实测单 task：89 条 read 被误标、比 55 条真 edit 还多、看着像 agent 狂写文件）
      const possibleTarget = WRITE_TOOL_NAMES.has(msg.name)
        ? ((argsAny.target_file as string | undefined) ??
          (argsAny.file_path as string | undefined) ??
          (argsAny.path as string | undefined))
        : undefined;
      if (
        possibleTarget &&
        (possibleTarget.includes("/actions/") ||
          possibleTarget.startsWith("actions/"))
      ) {
        if (msg.status === "running") {
          const argsStr = stringifyMeta(msg.args);
          await writeEventAndPublish(taskId, {
            kind: "tool_call",
            text: `agent 在写 artifact: ${possibleTarget}`,
            meta: {
              name: msg.name,
              args: argsStr ? truncate(argsStr) : undefined,
            },
          });
          break;
        }
        if (msg.status === "error") {
          const resStr = stringifyMeta(msg.result);
          await writeEventAndPublish(taskId, {
            kind: "error",
            text: `artifact 写入失败 ${msg.name} → ${possibleTarget}：${truncate(resStr, 200)}`,
            meta: { name: msg.name, target: possibleTarget, result: truncate(resStr) },
          });
          break;
        }
        // 写成功（status 非 running 非 error = SDK tool 执行完、文件已落盘）
        // 事件驱动根治「artifact 落盘后页面不刷新」：从路径解析 n、刷新对应 action 的
        // artifactUpdatedAt + 推 action 帧 → 前端面板 effect 依赖它立即重拉、不靠退避猜落盘时刻。
        // （artifactPath 在 appendAction 建 action 时已预设成 actions/<n>-<type>.md、文件在即可读、
        //   这里只需触发一次「文件变了、来重读」的信号）
        {
          const m = possibleTarget.match(/actions\/(\d+)-[a-z]+\.md$/);
          if (m) {
            const n = Number(m[1]);
            const fresh = await getTask(taskId);
            const target = fresh?.actions.find((a) => a.n === n);
            if (target) {
              const patched = await patchAction(taskId, target.id, {
                artifactUpdatedAt: Date.now(),
              });
              const a = patched?.actions.find((x) => x.id === target.id);
              if (a) publish(taskId, { kind: "action", action: a });
            }
          }
        }
        break;
      }

      if (isWaitForUser) {
        // status 维护：notifier 自己处理 awaiting；这里只记 error
        if (msg.status === "error") {
          const resStr = stringifyMeta(msg.result);
          await writeEventAndPublish(taskId, {
            kind: "error",
            text: `wait_for_user 工具调用失败：${truncate(resStr, 200)}`,
          });
        }
        break;
      }

      if (msg.status === "running") {
        const argsStr = stringifyMeta(msg.args);
        await writeEventAndPublish(taskId, {
          kind: "tool_call",
          text: `调用 ${msg.name}${argsStr ? `:${truncate(argsStr, 120)}` : ""}`,
          meta: { name: msg.name, args: argsStr ? truncate(argsStr) : undefined },
        });
      } else if (msg.status === "error") {
        const resStr = stringifyMeta(msg.result);
        await writeEventAndPublish(taskId, {
          kind: "error",
          text: `工具调用失败 ${msg.name}：${truncate(resStr, 200)}`,
          meta: { name: msg.name, result: truncate(resStr) },
        });
      }
      break;
    }

    case "assistant": {
      let text = "";
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          text += block.text;
        }
      }
      if (text.length > 0) {
        assistantCtx.buffer += text;
        publish(taskId, { kind: "assistant_delta", text });
      }
      break;
    }

    case "status": {
      console.log(
        `[task-runner] SDK status message: status=${msg.status} message=${
          (msg as { message?: string }).message ?? "(none)"
        }`,
      );
      if (
        (msg.status === "ERROR" || msg.status === "EXPIRED") &&
        msg.message
      ) {
        assistantCtx.sdkErrorMessage = msg.message;
        await writeEventAndPublish(taskId, {
          kind: "error",
          text: `SDK ${msg.status}：${msg.message}`,
          meta: { sdkStatus: msg.status, sdkMessage: msg.message },
        });
      }
      break;
    }

    case "system":
    case "user":
    case "request":
    case "task":
    default:
      break;
  }
};
