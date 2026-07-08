/**
 * Task prompt 拼装（V0.9.x 从 task-runner.ts 拆出、纯搬家零逻辑变更）
 *
 * 职责（全部是纯函数 / 只读文件、不碰运行时状态）：
 *   - prompt 模板渲染（fillTemplate / renderSuperPromptTemplate / loadActionPrompt）
 *   - super-prompt 拼装（buildSuperPrompt + 各 render 段）
 *   - [NEXT_ACTION] directive 构造（buildNextActionDirective + 批次 / replan / dev 指令段）
 *   - task 字段热更快照 / diff（captureTaskFieldsSnapshot / buildTaskUpdateHint）
 *
 * 依赖方向（保证无环）：只依赖 task-fs / 各 prompt 片段模块 / types、不 import task-runner / task-stream。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  getActionArtifactPath,
  getActionsDir,
  getEventsLogPath,
} from "./task-fs-core";
import { renderContextDocsSection } from "./context-docs-prompt";
import { turnDisciplineSection } from "./turn-discipline";
import { formatRepoSectionForPrompt } from "@/lib/path-utils";
import {
  getTaskCwd,
  getTaskWorkRepoPaths,
  isWorktreeTask,
} from "./task-worktrees";
import {
  listAvailableSkillNames,
  renderSkillsForPrompt,
  type SkillEntry,
} from "./skills-loader";
import { readGlobalCursorRulesForPrompt } from "./cursor-config";
import { getCustomAction } from "./custom-action-fs";
import type { AskUserQuestion } from "@/lib/types";
import type {
  ActionRecord,
  ActionType,
  Task,
} from "@/lib/types";
import { TASK_ROLE_LABEL, TEST_STRATEGY_LABEL } from "@/lib/types";
import { computeBatchProgress } from "@/lib/task-display";
import { buildNextActionHead } from "@/lib/protocol-signals";

// ----------------- 配置 -----------------

const PROMPTS_DIR = path.join(process.cwd(), "prompts");
const SUPER_PROMPT_FILE = "_super.md";
const SHARED_PROMPT_FILE = "_shared.md";

// 每种内置 action 对应的 prompt 文件、_super.md 占位符注入用
// custom 不在此表（playbook 来自用户定义、见 loadCustomActionPlaybook）
const ACTION_PROMPT_FILE: Record<Exclude<ActionType, "custom">, string> = {
  plan: "action-plan.md",
  build: "action-build.md",
  review: "action-review.md",
  ship: "action-ship.md",
  learn: "action-learn.md",
  dev: "action-dev.md",
};

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
    // V0.10：隔离 task 的 repoPath 占位符 = worktree cwd（agent 实际干活的地方）
    repoPath: getTaskCwd(task),
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
export const loadActionPrompt = async (
  action: ActionRecord,
  task: Task,
): Promise<string> => {
  const vars = {
    taskId: task.id,
    taskTitle: task.title,
    repoPath: getTaskCwd(task),
    role: task.role,
    roleLabel: TASK_ROLE_LABEL[task.role],
    actionArtifactsDir: getActionsDir(task.id),
    eventsLogPath: getEventsLogPath(task.id),
  };
  // 自定义 action：playbook 来自用户定义（dataRoot/custom-actions）、不走 prompts/action-*.md
  if (action.type === "custom") {
    return loadCustomActionPlaybook(action, task, vars);
  }
  const tpl = await loadFileSafe(ACTION_PROMPT_FILE[action.type]);
  return fillTemplate(tpl, vars);
};

// 自定义 action 的 playbook 渲染：定义正文（填同样的模板变量）+ 点名本 action 重点用的 skill。
// 全量 skill 已在 super prompt 的可用 skills 段、这里只是高亮、agent 按需 read 完整 SKILL.md。
const loadCustomActionPlaybook = async (
  action: ActionRecord,
  task: Task,
  vars: Record<string, string | undefined>,
): Promise<string> => {
  const def = action.customActionId
    ? await getCustomAction(action.customActionId)
    : null;
  if (!def) {
    return `（自定义 action 定义未找到${
      action.customActionId ? `：${action.customActionId}` : "（缺 id）"
    }、可能已在 /actions 页删除。仍需产出 artifact——按用户指令尽力执行、并在 artifact 说明定义缺失。）`;
  }
  const parts = [fillTemplate(def.playbook, vars)];
  if (def.skills && def.skills.length > 0) {
    // v0.9.14 skill 缺失兜底：定义可能是别人导出的、引用了对方个人 skill——
    // 本机（平台 + 全局 + 绑定仓 repo 层）不存在的名字静默滤掉、不进 prompt、
    // agent 不会拿着悬空引用去文件系统瞎找 / 脑补。UI 侧另有灰 chip 提示用户。
    const available = await listAvailableSkillNames(task.repoPaths ?? []);
    const usable = def.skills.filter((s) => available.has(s));
    if (usable.length > 0) {
      parts.push(
        "",
        "## 本 action 重点使用以下 skill",
        "（详情见上方可用 skills 段、按场景用 `read` 读完整 SKILL.md）：",
        ...usable.map((s) => `- ${s}`),
      );
    }
  }
  return parts.join("\n");
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
export const buildSuperPrompt = async (
  task: Task,
  skills: SkillEntry[],
  firstNextAction: {
    action: ActionRecord;
    userInstruction: string;
    attachedImagePaths?: string[];
    attachedFilePaths?: string[];
    branchCheckoutHint?: string;
    batchDirective?: string;
    // V0.8.12 A：plan append 硬指令（已分批 task 追加需求时拼进首个 NEXT_ACTION）
    replanDirective?: string;
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
    await loadActionPrompt(firstNextAction.action, task),
  ].join("\n");

  // 当前已存在的 action history（agent 起 Run 时能看到之前的工作）
  const actionHistorySection = renderActionHistorySection(task);

  // 第一个 [NEXT_ACTION ...] 指令（含用户指令、附件、branch checkout hint）
  const firstActionDirective = buildNextActionDirective(firstNextAction);

  return renderSuperPromptTemplate(template, {
    taskId: task.id,
    taskTitle: task.title,
    repoSection: renderRepoSection(task),
    repoBranchSection: renderRepoBranchSection(task),
    repoPath: getTaskCwd(task),
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
    waitDiscipline: turnDisciplineSection(),
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

// 渲染「任务基本信息」的仓库段：非隔离 = 原样列原仓库路径；隔离 task 额外拼一段
// worktree 语境说明（分支已由系统检出、禁自己 checkout、依赖要自装）
const renderRepoSection = (task: Task): string => {
  const workPaths = getTaskWorkRepoPaths(task);
  const base = formatRepoSectionForPrompt(workPaths);
  if (!isWorktreeTask(task)) return base;

  // 逐仓列已检出的任务分支（ensureTaskWorktrees 已 upsert 进 gitBranches、此处必有值）
  const branchLines = task.repoPaths.map((p) => {
    const tail = p.split("/").filter(Boolean).pop() ?? p;
    const branch = task.gitBranches?.find((b) => b.repoPath === p)?.name;
    return `  - \`${tail}\`：分支 \`${branch ?? "（未记录）"}\`（原仓库 \`${p}\`）`;
  });
  return [
    base,
    "",
    "**⚠️ 任务隔离工作区（git worktree）**：以上路径是系统为本 task 专门检出的 worktree、不是原仓库目录：",
    ...branchLines,
    "  - 任务分支已由系统检出好——**禁止自己 checkout / 切换分支**、也不要 cd 到原仓库目录去改代码",
    "  - git 命令（diff / add / commit / push / fetch）在 worktree 里照常用、跟原仓库共享同一 git 数据库",
    "  - 依赖：系统会尽量把原仓库现成的依赖目录（node_modules / vendor / Pods）克隆过来；克隆不了 / 其它生态（如 Python venv）时、需要跑安装 / 构建 / 测试前先自行装依赖（按仓库的包管理器来、如 pnpm install / pip venv）",
  ].join("\n");
};

// V0.6.7：渲染「仓库分支配置」段注入 super prompt——ship 读测试分支、各 action 兜底参考
// 每仓列：线上分支（feature 拉取基线）/ 测试分支（ship 提测 MR 目标）/ dev 分支
const renderRepoBranchSection = (task: Task): string => {
  const repoPaths = task.repoPaths ?? [];
  if (repoPaths.length === 0) return "（无绑定仓库）";
  // V0.10：隔离 task 括号里展示 worktree 路径（agent 实际干活的目录、别引它 cd 回原仓库）
  const workPaths = getTaskWorkRepoPaths(task);
  const lines: string[] = [
    "每个仓的分支配置（建 task 时从设置页快照固化、ship 提测目标分支以此为准）：",
    "",
  ];
  for (let i = 0; i < repoPaths.length; i++) {
    const p = repoPaths[i];
    const online = task.repoBaseBranches?.[p]?.trim();
    const test = task.repoTestBranches?.[p]?.trim();
    const dev = task.repoDevBranches?.[p]?.trim();
    const tail = p.split("/").filter(Boolean).pop() ?? p;
    lines.push(
      `- \`${tail}\`（${workPaths[i]}）：线上分支=${online || "（未配、自动探测）"}、` +
        `测试分支=${test || "test（默认）"}、dev 分支=${dev || "（未配）"}`,
    );
  }
  return lines.join("\n");
};

// ----------------- task 字段热更（快照 + diff） -----------------

// V0.6.6 热更：agent 长生期间用户可能在详情页编辑 role / title / feishuStoryUrl、
// 用 agent 启动时的快照 diff 出「变了哪几项」、reused 推进时注入告知。
// 注：model 是 SDK Run 启动时绑定的硬约束、改了只能换新 agent、不在热更之列。
export interface TaskFieldsSnapshot {
  title: string;
  role: Task["role"];
  feishuStoryUrl?: string;
}

export const captureTaskFieldsSnapshot = (task: Task): TaskFieldsSnapshot => ({
  title: task.title,
  role: task.role,
  feishuStoryUrl: task.feishuStoryUrl,
});

// diff 当前 task vs 启动快照、只把变了的字段拼成一段 [TASK_UPDATED]；无变化返 undefined（不注入）
export const buildTaskUpdateHint = (
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

// ----------------- directive 构造（批次 / review 范围 / replan / dev 推送） -----------------

// 构造 build 的「本次做哪批」指令段（注入 NEXT_ACTION、放用户指令之后）
//
// - 无批次（plan 没拆 / 没 plan）→ undefined、不注入本段、build 退化「做全部」老流程
// - requestedBatchIds 空（V0.6.29 批次选填）→「自由改动」指令——修 bug / 跨批次散改、
//   只做用户指令里的事、不开做未完成批次、不计批次进度（老语义「空=全做」已废、想全做点全选）
// - 进度（累计 X/Y 批）派生自 computeBatchProgress、纯算不存计数器
export const buildBatchDirective = (
  task: Task,
  requestedBatchIds?: string[],
): string | undefined => {
  const { batches, doneIds, total } = computeBatchProgress(task);
  if (batches.length === 0) return undefined;

  // V0.6.29：用户没勾批次 = 自由改动（多见于多轮之后回头修 bug、忘了 / 不属于哪个批次）
  if (!requestedBatchIds || requestedBatchIds.length === 0) {
    const doneCount = batches.filter((b) => doneIds.has(b.effectiveId)).length;
    return [
      `[BUILD_BATCHES] 本需求 plan 共拆 ${total} 个批次（已完成 ${doneCount}/${total}）、但**本次 build 不绑定批次**——用户没有勾选批次、这是一次自由改动（修 bug / 跨批次散改）：`,
      "- **范围**：只做用户指令里点到的事、范围以指令为准",
      "- **不要顺手开做未完成批次**——批次推进要用户在推进 dialog 里显式勾选、不归这次",
      "- **进度**：本次不计入批次进度、artifact 总览「本次完成批次」写「无（自由改动）」",
    ].join("\n");
  }

  const selected = batches.filter((b) => requestedBatchIds.includes(b.effectiveId));
  if (selected.length === 0) return undefined;

  const isAll = selected.length === batches.length;
  const afterIds = new Set([...doneIds, ...selected.map((b) => b.effectiveId)]);
  const afterDone = batches.filter((b) => afterIds.has(b.effectiveId)).length;

  const lines: string[] = [
    `[BUILD_BATCHES] 本需求 plan 共拆 ${total} 个批次、本次 build 只做下面 ${selected.length} 个${
      isAll ? "（= 全部批次）" : "（挑批：其它批次的 task 这次一行都不要碰）"
    }：`,
  ];
  for (const b of selected) {
    const redo = doneIds.has(b.effectiveId)
      ? "　⚠️ 这批之前 build 过、本次是返工"
      : "";
    lines.push(
      `  - [${b.rawId} / 来源方案 #${b.sourceActionN}] ${b.title}　测试策略=${TEST_STRATEGY_LABEL[b.testStrategy]}　含：${
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
export const buildReviewScopeDirective = (task: Task): string | undefined => {
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

// V0.8.12 A（治本、动态硬指令）：append 模式下、若该 task 此前已分过批次、
// 基于真实批次状态注入「必须出 ≥1 新批次」硬要求——不给 agent「补充小就不分批」的口子
// （对应 plan prompt §5.3 例外）。这是 A 能否真生效的关键：静态 prompt 规则容易被
// agent 自判「这次小」绕过、动态指令贴着真实状态（已拆 N 批）下硬命令、绕不过去。
export const buildPlanReplanDirective = (
  action: ActionRecord,
  task: Task,
): string | undefined => {
  if (action.type !== "plan" || !action.replanMode) return undefined;
  if (action.replanMode === "append") {
    const { total } = computeBatchProgress(task);
    const lines = [
      "[REPLAN_MODE append] 本次 plan 是在已有方案 / 批次基础上追加补充需求。",
    ];
    if (total > 0) {
      // 已分批 task：硬要求出新批次（不留「小可跳过」余地）
      lines.push(
        `- ⚠️ **本 task 已拆 ${total} 批、追加需求必须调 set_plan_batches 出 ≥1 新批次**（即使补充很小）——已分批的 task 追加范围不进批次会让进度断裂（看着像全完成）、用户无法按批推进。这是硬要求、见 plan prompt §5.3 例外。`,
        "- set_plan_batches 只上报新增 / 补充批次 delta、不要重复旧 plan 已有批次；旧批次和进度由系统从历史 action 自动派生。",
      );
    } else {
      // 没分批历史的 append（少见）：维持原弹性、按规模自判
      lines.push(
        "- 如果需要继续分批：`set_plan_batches` 只上报新增 / 补充批次 delta，不要重复旧 plan 已有批次。",
        "- 旧批次和已完成进度由系统从历史 action 自动派生，你只负责新增范围。",
      );
    }
    lines.push(
      "- 如果你认为用户其实要求完整重拆，请先在方案里说明风险，并按用户指令优先；不要把旧批次重复上报。",
    );
    return lines.join("\n");
  }
  return [
    "[REPLAN_MODE rebuild] 本次 plan 是重建后续方案。",
    "- 可以重新上报完整的后续批次；系统会把此前仍 pending 的旧批次派生为已被替代，已完成批次作为历史保留。",
    "- artifact 里说明哪些旧范围被新方案替代，方便用户核对。",
  ].join("\n");
};

// V0.x：联调（dev action）推送方式指令——根据 action.devPushMode 钉「直推 / 提 PR」、两套流程细节在 action-dev.md。
//   仅 dev action 有值（其它 action 返 undefined）。复用 buildNextActionDirective 通道注入（它已持 action、
//   不必再走 buildSuperPrompt / internalStartAgent 那一长串传参）。
const buildDevDirective = (action: ActionRecord): string | undefined => {
  if (action.type !== "dev") return undefined;
  const mode = action.devPushMode ?? "direct";
  if (mode === "mr") {
    return [
      "[DEV_PUSH_MODE] 本次联调走「提 PR」：",
      "- push feature 到 origin、调 submit_mr（target = 该仓 dev 分支、见上方「仓库分支配置」段）建 feature→dev 的 MR。",
      "- 冲突处理按 action-dev.md「提 PR」段走（同 ship 的 __conflict 智能解 / 用户自己解）。",
      "- 不要走直推（不在本地 merge dev、不 push dev 分支）。",
    ].join("\n");
  }
  return [
    "[DEV_PUSH_MODE] 本次联调走「直推」：",
    "- 本地基于 origin/dev 切 dev、把 feature merge 进来、直推 origin/dev（feature 分支全程不动）。",
    "- 冲突处理按 action-dev.md「直推」段走（在本地 dev 上 AI 智能解 / 用户自己解）。",
    "- 不要走提 PR（不调 submit_mr）。",
  ].join("\n");
};

// 构造一个 [NEXT_ACTION ...] 头部 + 任务字段热更 + 用户指令 + 批次指令 + 附件段 + branch checkout hint
// V0.6.27：续接路径（用户勾「续用当前 agent」）可传 actionPlaybook——super prompt 只注入了启动时
// 那个 action 的 playbook、续接的新 action 指令必须随载荷下发（同类型也附、利用新近性强化遵循）
export const buildNextActionDirective = (input: {
  action: ActionRecord;
  userInstruction: string;
  attachedImagePaths?: string[];
  attachedFilePaths?: string[];
  branchCheckoutHint?: string;
  taskUpdateHint?: string;
  batchDirective?: string;
  // V0.8.12 A：plan append 硬指令（由调用方外部算好传入、拿得到 task 判断已分批）
  replanDirective?: string;
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
    replanDirective,
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
  if (replanDirective && replanDirective.trim().length > 0) {
    lines.push(replanDirective.trim(), "");
  }
  // V0.6.23：build 分批指令（仅 build 且 plan 有批次时有值）放用户指令后、让 agent 先框定本次范围
  if (batchDirective && batchDirective.trim().length > 0) {
    lines.push(batchDirective.trim(), "");
  }
  // V0.x：联调推送方式指令（仅 dev action 有值）——直推 / 提 PR 二选一、从 action.devPushMode 算
  const devDirective = buildDevDirective(action);
  if (devDirective) {
    lines.push(devDirective, "");
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

/**
 * 「输入条唤醒当前 action」指令（V0.11.9、原「重启当前阶段」按钮退役后的替身）
 *
 * 场景：action 停在 error / cancelled、会话接不回、用户在底部输入条说话——
 * 起新 agent **原地续同一个 action**（不 append 新 action、链不分叉）、用户这条消息就是最新指示。
 */
export const buildResumeActionInstruction = (
  task: Task,
  action: ActionRecord,
  // 断线前 agent 正等用户回答、但用户还没答完的那组问题（断点续传重问用）
  pendingQuestions: AskUserQuestion[],
  // 用户唤醒时说的话（输入条内容、非空）
  userMessage: string,
  imagePaths?: string[],
): string => {
  const lines: string[] = [
    "[RESUME_ACTION]",
    "当前 action 之前中断了（agent 断开 / 报错 / 被停止）、现在被用户唤醒。不要追加新 action、不要从零重做，继续完成同一个 action。",
    "你可能是被换上来接手的新模型——先把下面的上下文完整读一遍、确认理解了断点和已有产物，再动手。",
    "",
    "严格按顺序执行：",
    `1. 先读取事件日志，确认断点和用户最近反馈：\`${getEventsLogPath(task.id)}\``,
    "2. 再检查相关仓库当前工作区，摸清已有的半成品。",
  ];

  let step = 3;
  if (action.artifactPath) {
    lines.push(
      `${step}. 如果已有 artifact，先读取它：\`${getActionArtifactPath(task.id, action.n, action.type)}\`（后续在同一路径覆盖更新）。`,
    );
    step += 1;
  }

  // 用户唤醒时说的话 = 最新指示（纯提问先答疑、指令按它执行）——这条消息就是「方向确认」、
  // 不再像旧「重启」那样先 ask_user 问「按原计划继续吗」
  lines.push(
    `${step}. **用户唤醒本阶段时说了这条消息（最新指示、优先处理）**：`,
    "",
    `> ${userMessage.split("\n").join("\n> ")}`,
    "",
    "   - 纯提问 → 先在事件流里答疑（emit assistant_message）、再继续完成本 action",
    "   - 改动 / 继续类指令 → 按它执行",
  );
  step += 1;
  if (imagePaths && imagePaths.length > 0) {
    lines.push(
      "   - 用户随消息附了图、先用 \`read\` 逐一读：",
      ...imagePaths.map((p, i) => `     ${i + 1}. ${p}`),
    );
  }

  if (pendingQuestions.length > 0) {
    // 断点在「等用户答问题」：接手 agent 把没答完的问题原样重问（用户消息若已回答某题、跳过该题）
    const questionsJson = JSON.stringify(
      pendingQuestions.map((q) => ({
        id: q.id,
        question: q.question,
        ...(q.options && q.options.length > 0 ? { options: q.options } : {}),
        allow_text: q.allowText ?? true,
      })),
    );
    lines.push(
      `${step}. **断点续传**：中断前你正等用户回答下面这组问题、用户还没答完。若上面那条用户消息没有回答它们、读完上下文后调一次 \`ask_user\` 原样重问（已被回答的题跳过）：`,
      `   - task_id="${task.id}"、action_id="${action.id}"`,
      `   - questions=${questionsJson}`,
      "   - ⛔ 不要替用户作答、不要按 default 跳过。",
    );
  }

  if (action.userInstruction.trim().length > 0) {
    lines.push("", "本 action 的原始用户指令：", action.userInstruction.trim());
  }
  lines.push(
    "",
    "完成后调用 \`submit_work({ task_id, action_id, artifact_path })\` 对这个同一个 action 交卷、然后结束本轮回复。",
  );
  return lines.join("\n");
};
