/**
 * Plan workflow runner（V0.2）
 *
 * V0.2 重定义：plan 任务 = 4 phase workflow（context → plan → build → ship）
 * V0.3.3 改为 3 phase（移除 ship、注意力管理决策）
 * V0.3.4 改为 2 phase（context 并入 plan、plan 自己读上下文 + 扫仓库 + 出方案）
 * V0.5 改为 3 phase（plan → build → review、加 review phase 拿确定性产物做差值对照 + 产出交付信息）
 * 整段任务跑在一次 SDK Run 里、phase 之间用 wait_for_user MCP 工具阻塞等 phase ack。
 *
 * 架构（跟 chat-runner 同款骨架）：
 *   - 启动 / 推送拆开：本文件管 agent 生命周期 + publish。
 *     SSE 推送由 watch-chat / watch-task 路由 subscribe 拿增量。
 *   - 复用 chat-runner 的 publishChatStreamEvent / subscribeChatStream：
 *     两个 runner 共享同一套 globalThis 状态、订阅协议统一、UI 不区分 mode 就能用。
 *   - wait_for_user 工具在 workflow 模式下传 phase / artifact 参数、
 *     chat-mcp 的 awaiting notifier 携带 phase 透出来、本文件据此 patch phase 状态。
 *
 * Phase 边界 / 状态机（V0.5 起 3 phase: plan → build → review）：
 *   1. start：plan phase 开始、status=running、currentPhase=plan
 *   2. agent 跑 plan（读 contextDocs + 拉飞书 + 扫仓库 + 出方案）、写 01-plan.md、
 *      调 wait_for_user(phase=plan, artifact=...)
 *      → notifier 触发：patch phases.plan.status=awaiting_ack、taskStatus=awaiting_user
 *   3. 用户在 UI 看 artifact、点「通过」→ submitPhaseAck(approve)
 *      → agent 拿到 [PHASE_ACK approve]、进 build phase
 *      → 本文件**不需要主动 patch**：agent 下一次调 wait_for_user(phase=build) 时
 *        notifier 自动 patch 上一 phase=ack + 当前 phase=awaiting_ack
 *        （但实际上 "上一 phase=ack" 需要本文件在 ack 时单独处理、见 markPhaseAcked）
 *   4. 用户点「再聊聊」（V0.5.2 文案、之前叫「补意见」/「跟 AI 再聊聊」、协议名沿用 revise）→ submitPhaseAck(revise, feedback)
 *      → agent 拿 [PHASE_ACK revise]、**先 ask_user 复述意图（想改 / 想问 / 先答再决定）**、
 *        想改 → edit artifact 再 wait_for_user；想问 → emit answer + 再 wait_for_user（不动 artifact）
 *      → 任务状态保持 awaiting_user（按用户拍板：不抖屏）、artifact 视情况更新
 *
 * 跟 chat-runner 的差异：
 *   - prompt 不同（多 phase workflow 指令）
 *   - awaiting notifier 携带 phase / artifact、需要 patch 对应 phase 状态
 *   - 暴露 markPhaseAcked() 给 phase-ack 路由调（用户 approve 后切上一 phase 为 ack）
 *
 * 不做：
 * - 不做断点续跑（agent 挂了就 failed、需要用户手动重启）
 * - 不做 token 级 delta（assistant_delta 已经够流式）
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Agent } from "@cursor/sdk";
import type { McpServerConfig, ModelSelection, SDKMessage } from "@cursor/sdk";

import {
  appendEvent,
  getEventsLogPath,
  getPhaseArtifactPath,
  getTask,
  patchPhase,
  setTaskLastAgentId,
} from "./task-fs";
import {
  cancelPending,
  getChatMcpUrl,
  setChatAwaitingNotifier,
} from "./chat-mcp";
import {
  publishChatStreamEvent,
  type ChatStreamEvent,
} from "./chat-runner";
import { renderContextDocsSection } from "./context-docs-prompt";
// V0.5.9：多仓 cwd helper
import {
  formatRepoSectionForPrompt,
  getEffectiveCwd,
} from "@/lib/path-utils";
import {
  loadSkills,
  renderSkillsForPrompt,
  type SkillEntry,
} from "./skills-loader";
import type {
  PhaseId,
  Task,
  TaskEvent,
  WorkflowDef,
} from "@/lib/types";
import { getNextPhase, TASK_ROLE_LABEL, WORKFLOWS } from "@/lib/types";

// ----------------- 配置 -----------------

// plan workflow 不主动超时（用户随时可能 24h 后才 ack）
const PLAN_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const CHAT_TOOL_MCP_NAME = "feAiFlowChat";

// ----------------- prompt 模板加载 -----------------

const PROMPTS_DIR = path.join(process.cwd(), "prompts");

// 各 phase 的 prompt 文件、每个 phase 一份独立模板
// V0.3.3 移除 ship phase（原 phase 4）
// V0.3.4 把原 context phase 合入 plan phase（phase 1 一气呵成读上下文 + 扫仓库 + 出方案）
// V0.4 起按 task.role 在 prompt 渲染时注入角色视角（详见 fillTemplate vars）
// V0.5 加 review phase：拿 git diff × plan × build × contextDocs 做差值对照 + 产出交付信息
const PHASE_PROMPT_FILE: Record<PhaseId, string> = {
  plan: "phase-1-plan.md",
  build: "phase-2-build.md",
  review: "phase-3-review.md",
};

// V0.5.7.7：跨 phase 共享规范文件、避免「不带 frontmatter / artifact-writer / path 完整路径 / 修改记录格式」这类约束被 3 个 phase prompt 各写一遍
// 加载顺序：每次 buildSuperPrompt 先把 _shared.md 拼到「各 phase 详细 prompt」段之前
const SHARED_PROMPT_FILE = "_shared.md";

// V0.5.11：super-prompt 主模板、把原先 buildSuperPrompt 里 443 行硬编码字符串拆到 .md 文件
// ts 层只负责「准备 vars + fillTemplate」、prompt 文案改动直接编辑 md、不动 ts、不用过 typecheck
// 占位符约定（在 buildSuperPrompt 里 build 后注入）：
//   {{forkBanner}}             fork 启动提示段（首位、空时 = 空字符串）
//   {{workflowDisplayName}}    workflow 显示名（如「方案规划 → 实施 → 复核」）
//   {{workflowDescription}}    workflow 描述
//   {{phaseTable}}             phase 列表表格（含「→ approve 后进 X / 结束 run」字面）
//   {{lastPhase}}              最后一个 phase id（如 `review`）
//   {{taskId}}                 任务 ID
//   {{taskTitle}}              任务标题
//   {{repoSection}}            仓库段落（单 / 多仓自动切）
//   {{roleLabel}}              角色中文标签
//   {{role}}                   角色 id
//   {{contextDocsSection}}     上下文文档段（已渲染好的 markdown 子段）
//   {{artifactPathTable}}      artifact 路径表
//   {{skillsSection}}          skill index 子段
//   {{eventsLogPath}}          事件日志绝对路径
//   {{sharedRules}}            _shared.md 内容
//   {{phasePromptSections}}    所有 phase 详细 prompt 拼接（含 ### 标题分隔）
//   {{startInstruction}}       结尾启动指令（normal / fork 切换）
const SUPER_PROMPT_FILE = "_super.md";

const NULL_PLACEHOLDER = "（未提供）";

// 用 {{key}} 占位、缺失替换成「（未提供）」
const fillTemplate = (
  template: string,
  vars: Record<string, string | undefined>,
): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v && v.trim().length > 0 ? v.trim() : NULL_PLACEHOLDER;
  });

// V0.5.7.7：加载跨 phase 共享规范（_shared.md）、填占位符
// 占位符跟 phase prompt 同款（repoPath / artifactPath...）、但目前 _shared 里只用了 {{repoPath}}
// V0.5.9：{{repoPath}} 的值改成 effective cwd（单仓 = 仓本身、多仓 = 公共父目录）、
// _shared.md / phase prompt 不动、模板字面意思就是「agent cwd」
const loadSharedPrompt = async (task: Task): Promise<string> => {
  const fpath = path.join(PROMPTS_DIR, SHARED_PROMPT_FILE);
  try {
    const tpl = await fs.readFile(fpath, "utf-8");
    return fillTemplate(tpl, {
      repoPath: getEffectiveCwd(task.repoPaths),
      taskId: task.id,
    });
  } catch (err) {
    return `（_shared.md 未找到：${err instanceof Error ? err.message : String(err)}）`;
  }
};

const loadPhasePrompt = async (
  phaseId: PhaseId,
  task: Task,
  phaseIdx: number,
  workflowDef: WorkflowDef,
): Promise<string> => {
  const fname = PHASE_PROMPT_FILE[phaseId];
  const fpath = path.join(PROMPTS_DIR, fname);
  const tpl = await fs.readFile(fpath, "utf-8");
  // V0.5.3：原先注入的 attachedDocs / swaggerUrl 模板变量已废弃（字段被 contextDocs 完全取代）
  // 当前 phase-*.md 模板没有引用这两个 {{}} 占位、删了不会触发「(未提供)」fallback
  // phase 自身的 artifact 绝对路径（agent 写入用、避免相对路径 cwd 歧义）
  const artifactPath = getPhaseArtifactPath(task.id, phaseId, phaseIdx);
  // 上一 phase 的 artifact（给 Phase 2/3 读上游）
  // Phase 1 没有上游、塞「（未提供）」
  const prevArtifactPath =
    phaseIdx > 0
      ? getPhaseArtifactPath(
          task.id,
          workflowDef.phases[phaseIdx - 1]!,
          phaseIdx - 1,
        )
      : undefined;
  // V0.5：planArtifactPath = workflow 里 phase=plan 的 artifact 绝对路径
  // Review phase 同时要读 plan（取需求理解 / §3 涉及接口 / §4 关键技术决策 / §5 task / 正文内联 ask_user 拍板备注）和 build（取实施日志 / 偏离段）
  // prevArtifactPath 对 review 是 build、planArtifactPath 是再上一个、单独抽一个变量给 review 模板用
  // phase 1/2 模板不用这个变量、缺失替换成「（未提供）」也无影响
  const planPhaseIdx = workflowDef.phases.indexOf("plan");
  const planArtifactPath =
    planPhaseIdx >= 0
      ? getPhaseArtifactPath(task.id, "plan", planPhaseIdx)
      : undefined;
  // V0.3.4 删除 contextArtifactPath：原本给 phase 3+ 读 phase 1 的 context artifact、
  // 现在 context 已合进 plan、plan 自己就是上游、用 prevArtifactPath 就够
  // V0.4：注入 role / roleLabel、phase prompt 按 role 调整视角
  // V0.5：注入 planArtifactPath 给 review phase 读 01-plan.md（prev 是 build、再上一个才是 plan）
  return fillTemplate(tpl, {
    taskId: task.id,
    taskTitle: task.title,
    // V0.5.9：{{repoPath}} 模板变量统一改为「agent effective cwd」语义
    // 单仓 = 仓自身、多仓 = 公共父目录、phase prompt 字面「从 {{repoPath}} 起算」自动兼容
    repoPath: getEffectiveCwd(task.repoPaths),
    artifactPath,
    prevArtifactPath,
    planArtifactPath,
    role: task.role,
    roleLabel: TASK_ROLE_LABEL[task.role],
  });
};

// ----------------- 起手 super-prompt -----------------
//
// V0.3 上下文文档清单 inject 已抽到 ./context-docs-prompt.ts、plan / chat 共用
// V0.5.11 重构：原 buildSuperPrompt 里 443 行硬编码字符串数组 + 8 处嵌套三目运算符
// 全部抽到 prompts/_super.md 模板、ts 层职责简化为「build sub-section 字符串 → 一次性 replace」

// 加载 super-prompt 主模板
// 失败时返回带错误信息的字符串、不抛——跟 loadSharedPrompt / loadPhasePrompt 同款防御性兜底
const loadSuperPromptTemplate = async (): Promise<string> => {
  const fpath = path.join(PROMPTS_DIR, SUPER_PROMPT_FILE);
  try {
    return await fs.readFile(fpath, "utf-8");
  } catch (err) {
    return `（_super.md 未找到：${err instanceof Error ? err.message : String(err)}）`;
  }
};

// V0.5.11：super-prompt 专用的模板渲染、跟 fillTemplate 区别：
//   - fillTemplate（phase prompt 用）：缺失 / 空字符串字段都替换成「（未提供）」、防漏 business 字段
//   - renderSuperPromptTemplate：只有 undefined / null 才占位、空字符串保留字面（如 fork 不存在时 forkBanner=""）
// 不 trim、保留 sub-section 原样（含 trailing newline）、跟旧版 `[...].join("\n")` inject 行为一致
const renderSuperPromptTemplate = (
  template: string,
  vars: Record<string, string | undefined>,
): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) return NULL_PLACEHOLDER;
    return v;
  });

/**
 * V0.5：fork 模式专用 banner——告诉新 agent「上一 agent 已完成 fromPhase 前面的 phase、artifact 在硬盘、直接接力」
 * V0.5.11：从 buildSuperPrompt 里 50 行 IIFE 抽成独立 helper、嵌套三目按 phase 拆成 map / 命名变量
 * 决策点：本段「fix 模式 step 2 / 4 / 5」按 fork.fromPhase 三分支不同——
 *   留在 ts 层用 record 选分支、不再抽到 md 模板（md 不支持条件分支、抽出去反而要在 ts 层切 3 个字符串再注入、多一层、不抽划算）
 */
const buildForkBanner = (
  task: Task,
  workflowDef: WorkflowDef,
  fork: { fromPhase: PhaseId; reason?: string },
): string => {
  const fromIdx = workflowDef.phases.indexOf(fork.fromPhase);

  // 已完成 phase 清单（fromPhase 之前的）
  const completed = workflowDef.phases
    .slice(0, fromIdx)
    .map((pid, i) => {
      const ap = getPhaseArtifactPath(task.id, pid, i);
      return `  - Phase \`${pid}\` → artifact \`${ap}\``;
    })
    .join("\n");
  const completedSection = completed.length > 0 ? completed : "  （无）";

  const reasonSuffix = fork.reason ? `（原因：${fork.reason}）` : "";
  const currentArtifact = getPhaseArtifactPath(task.id, fork.fromPhase, fromIdx);

  // fix mode 第 2 步：build phase 多一句 git 命令引导（其他 phase 走通用引导）
  const step2 =
    fork.fromPhase === "build"
      ? `  2. 你正在 fork **build** phase——仓库里几乎一定有上一轮的代码改动、跑 \`shell\` 调 \`git status\` / \`git log --oneline -10\` / \`git diff HEAD\`（或 \`git diff HEAD~ -- '<plan §5 各 task 改动文件>'\`）自己看上一轮改了哪些文件、改了什么`
      : `  2. 看仓库 / artifact 上一轮已有的内容、了解前置基线`;

  // fix mode 第 4 步：reason 有 / 无两种文案
  const step4 = fork.reason
    ? `  4. **本次 reason（用户描述要修的点）**：\n     > ${fork.reason}\n\n     按这个 reason 锁定影响范围、不要扩张到 reason 之外的内容`
    : `  4. 用户没填 reason、说明上一轮可能是「跑挂了重启」或「整体重做」、看 artifact + 代码自己判断要不要从零重生、还是局部修`;

  // fix mode 第 5 步：fix log 留痕规则按 phase 分流
  // build / review 走 ## 修改记录 专段（V0.5.7.2 起 build / V0.5.7.4 起 review）、plan 章节结构强、走内联 > ✅ 已确认 留痕
  const step5ByPhase: Record<PhaseId, string> = {
    build: `  5. 改完代码后**用 \`edit\` 把本轮修正追加到 02-build.md 的 \`## 修改记录\` 段末尾**（按 phase-2-build 骨架里「### 修改 N」三级标题 + 「用户反馈 / 改动文件 / 概要」三字段格式）。\n     ⛔ **严禁新建顶层标题**（如「## Fork 修复」「## Revise」「## 重启修复」），所有 fix log 都汇聚在 \`## 修改记录\` 段下。\n     ⛔ **严禁在 artifact 里出现「fork」「revise」「再聊聊」等内部技术词**——artifact 是给用户和 review agent 看的、用「用户反馈」「本次修改」等中文表述。\n     ⛔ **严禁复述**「Task 完成情况」「改动文件清单」段已有内容、修改记录只记「这次反馈带来的修正」。`,
    plan: `  5. 改完 artifact 用 \`edit\` 局部修正、在涉及结论的章节内联补一行 \`> ✅ 已确认：<用户反馈核心>\` 就地留痕（参考 phase-1-plan §1 顶部规则）。\n     ⛔ 严禁新建顶层标题（如「## Fork 修复」「## Revise」），保留旧章节结构、本轮修改内联反映在被改章节里。`,
    review: `  5. 改完代码 / 描述后**用 \`edit\` 把本轮修正追加到 03-review.md 的 \`## 修改记录\` 段末尾**（按 phase-3-review 骨架里「### 修改 N」三级标题 + 「用户反馈 / 影响位置 / 概要」三字段格式）。\n     ⛔ **严禁新建顶层标题**（如「## Fork 修复」「## Revise」「## 重启修复」），所有 fix log 都汇聚在 \`## 修改记录\` 段下、不要散在「实现偏差」「未完成」等正文章节里。\n     ⛔ **严禁在 artifact 里出现「fork」「revise」「再聊聊」等内部技术词**——artifact 是给用户看的、用「用户反馈」「本次修改」等中文表述。`,
  };
  const step5 = step5ByPhase[fork.fromPhase];

  return [
    "## ⚠️ Fork 启动（V0.5：上一 agent 已完成前面的 phase、你接力）",
    "",
    `**这是 fork 启动的新 agent**${reasonSuffix}。前面的 phase 由上一个 agent 完成、artifact 已经在硬盘、**不要重做**：`,
    "",
    completedSection,
    "",
    `**直接从 Phase \`${fork.fromPhase}\` 开始**：用 SDK 内置 \`read\` 工具读上面已完成 phase 的 artifact 拿上下文、然后按下面对应 phase 的指令做 \`${fork.fromPhase}\` 的产出。`,
    "",
    "不需要重读 contextDocs / 不需要重扫仓库、上一 agent 已经做过、信息已经在 artifact 里。",
    "",
    // V0.5.7.1：fix mode 提示——fork 同 phase 时上一轮可能也做过该 phase、artifact 在硬盘、代码改动在仓库
    // AI 拿到 prompt 后自己 read 一下 curPhaseArtifact 文件即可判断、不需要 stat
    `### 关于本次 \`${fork.fromPhase}\` phase（fix 模式判定）`,
    "",
    `先 \`read\` 一下 **当前 phase 的 artifact 路径**：\`${currentArtifact}\``,
    "",
    `- **如果文件存在且非空**——上一轮已经做过这个 phase、你这次是 **fix 模式**、不是从零重做：`,
    `  1. 仔细 \`read\` 旧 artifact、看上一轮的产物结构 / 已有的内容`,
    step2,
    `  3. **不要 rewrite 已有 artifact 和已有代码**、按下面 reason 描述定向增量修复、保留旧内容里有效的部分`,
    step4,
    step5,
    `  6. 写完调用 \`wait_for_user\` 让用户验收（同 phase、同 artifact、不要 ack 跳进下一 phase）`,
    "",
    `- **如果文件不存在 / 为空**——上一轮没跑到 / 上一轮中途挂了、按下面对应 phase 指令正常做该 phase 的产出（\`write\` artifact + 调 \`wait_for_user\`）`,
  ].join("\n");
};

/**
 * 一次性告诉 agent 整套 workflow 怎么跑：phase 列表 + 每个 phase 的 prompt 内容 + 调用约定。
 *
 * 为什么把所有 phase prompt 一次性塞进去：
 *   - 整段任务是一次 SDK Run、agent 上下文是全程共享的
 *   - phase 切换不重启 agent、只是阻塞解开后继续跑
 *   - 提前让 agent 看到所有 phase 蓝图、自己心里有数（提高规划一致性）
 *
 * V0.5.11 重构：
 *   - 原 443 行硬编码字符串数组拆到 prompts/_super.md
 *   - ts 层职责简化为：build sub-section 字符串 → renderSuperPromptTemplate 一次性 replace
 *   - 条件分支结果（如 phaseTable 含「→ approve 后进 X / 结束 run」）在 ts 层 build 好再注入、模板不含 if 逻辑
 *   - forkBanner 抽成独立 buildForkBanner helper（参见上方）
 *
 * 单 prompt 体积估算：每 phase 模板 ~2KB、3 phase ~6KB、加 _super.md + skills index + 共享规范 ~15KB、远低于 200K context。
 */
const buildSuperPrompt = async (
  task: Task,
  workflowDef: WorkflowDef,
  skills: SkillEntry[],
  // V0.5：fork 模式提示用、传入时 super-prompt 顶部加 fork 提示段
  // fork agent 看到「上游 phase 已完成、artifact 在 ...、请从 fromPhase 开始」、不重复跑前面 phase
  fork?: { fromPhase: PhaseId; reason?: string },
): Promise<string> => {
  // 1) 加载主模板 + 跨 phase 共享规范
  const template = await loadSuperPromptTemplate();
  const sharedRules = await loadSharedPrompt(task);

  // 2) 按 phase 序加载所有 phase 详细 prompt、各 phase 已填好自己的占位符
  const phasePromptSections: string[] = [];
  for (let i = 0; i < workflowDef.phases.length; i++) {
    const pid = workflowDef.phases[i]!;
    let phasePrompt: string;
    try {
      phasePrompt = await loadPhasePrompt(pid, task, i, workflowDef);
    } catch (err) {
      phasePrompt = `（phase=${pid} 的 prompt 文件未找到：${
        err instanceof Error ? err.message : String(err)
      }）`;
    }
    phasePromptSections.push(
      [`### Phase ${i + 1}: \`${pid}\``, "", phasePrompt].join("\n"),
    );
  }

  // 3) phase 列表表格（含「→ approve 后进 X / 结束 run」字面、条件结果先 build 好）
  const phaseTable = workflowDef.phases
    .map((p, i, arr) => {
      const next = i + 1 < arr.length ? arr[i + 1] : "（终点、自然结束 run）";
      const tag =
        i + 1 < arr.length
          ? `→ approve 后进 \`${next}\``
          : `→ approve 后**结束 run**`;
      return `  ${i + 1}. \`${p}\`  ${tag}`;
    })
    .join("\n");

  // 4) artifact 路径列表（按序、给 agent 一个全局表）
  const artifactPathTable = workflowDef.phases
    .map((pid, i) => {
      const p = getPhaseArtifactPath(task.id, pid, i);
      return `  ${i + 1}. \`${pid}\` → \`${p}\``;
    })
    .join("\n");

  // 5) fork banner（fork 模式才有内容、否则空字符串）
  const forkBanner = fork ? buildForkBanner(task, workflowDef, fork) : "";

  // 6) 结尾启动指令（fork / 正常两态）
  const startInstruction = fork
    ? `现在开始执行 Phase \`${fork.fromPhase}\`（fork 模式、跳过前面已完成的 phase）。`
    : "现在开始执行 Phase 1。";

  // 7) 一次性 fillTemplate（renderSuperPromptTemplate 区分 undefined / 空字符串）
  return renderSuperPromptTemplate(template, {
    forkBanner,
    workflowDisplayName: workflowDef.displayName,
    workflowDescription: workflowDef.description,
    phaseTable,
    lastPhase: workflowDef.phases[workflowDef.phases.length - 1]!,
    taskId: task.id,
    taskTitle: task.title,
    repoSection: formatRepoSectionForPrompt(task.repoPaths),
    roleLabel: TASK_ROLE_LABEL[task.role],
    role: task.role,
    contextDocsSection: renderContextDocsSection(
      task,
      "→ 如果 plan phase 上下文极度缺失、在 01-plan.md 的「待澄清 / 不确定项」段写「需要用户补 XX 上下文」、然后正常调 wait_for_user 等用户在面板里补。",
    ),
    artifactPathTable,
    skillsSection: renderSkillsForPrompt(skills),
    eventsLogPath: getEventsLogPath(task.id),
    sharedRules,
    phasePromptSections: phasePromptSections.join("\n\n---\n\n"),
    startInstruction,
  });
};

// ----------------- 工具：截断 -----------------

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

// ----------------- publish 借 chat-runner 的通道 -----------------

const publish = (taskId: string, ev: ChatStreamEvent): void =>
  publishChatStreamEvent(taskId, ev);

// 防御性包装：appendEvent 失败时不让整段 workflow 跟着挂
//
// 历史教训：之前 readMeta 读到空 / 损坏文件时 JSON.parse 裸抛、appendEvent throw、
// handlePlanSdkMessage callback 跟着 throw、整段 SDK run.wait() 返回 status=error、
// 用户跑了几分钟的 workflow 一下白跑、且 root cause 还要扒事件日志才能看到。
//
// 现在 readMeta 自己已经容错（原子写 + per-task lock 也堵住 race）、但仍然
// 兜底一层：哪怕 IO 真挂了、也只是丢一条事件 + console.warn、不影响 run 继续。
const writeEventAndPublish = async (
  taskId: string,
  ev: Omit<TaskEvent, "id" | "ts">,
): Promise<Task | null> => {
  try {
    const updated = await appendEvent(taskId, ev);
    if (updated) {
      const last = updated.events[updated.events.length - 1];
      if (last) publish(taskId, { kind: "event", event: last });
    }
    return updated;
  } catch (err) {
    console.warn(
      `[plan-runner] writeEventAndPublish 失败 task=${taskId}、kind=${ev.kind}、丢这条事件继续往下跑：`,
      err,
    );
    return null;
  }
};

// task 转 failed 时调：把 events.jsonl 里所有未答的 ask_user_request 主动写一条 reply
// 标 cancelled、推 SSE。UI 端 AskUserDialog 收到 reply 后 pendingEvent 重算为 null、
// 弹窗自动关、用户不会卡在「答完了提交点不动 / dialog 又 dismiss 不掉」的死锁里。
//
// 为什么不在 UI 端按 task.status=failed 跳过弹窗：
//   - UI 防御属于「假设服务端可能没清理」的冗余防御
//   - 服务端在状态机出口做收尾、机制更干净、未来加新失败入口也能复用此函数
const cancelUnrepliedAsks = async (taskId: string): Promise<void> => {
  const latest = await getTask(taskId);
  if (!latest) return;
  const unreplied: Array<{ askId: string; phase: PhaseId | undefined }> = [];
  for (const ev of latest.events) {
    if (ev.kind !== "ask_user_request") continue;
    const askId = typeof ev.meta?.askId === "string" ? ev.meta.askId : null;
    if (!askId) continue;
    const replied = latest.events.some(
      (e) =>
        e.kind === "ask_user_reply" &&
        typeof e.meta?.askId === "string" &&
        e.meta.askId === askId,
    );
    if (!replied) {
      unreplied.push({ askId, phase: ev.phase as PhaseId | undefined });
    }
  }
  for (const u of unreplied) {
    await writeEventAndPublish(taskId, {
      kind: "ask_user_reply",
      phase: u.phase,
      text: "[ASK_CANCELLED] 任务已失败、本次提问自动作废",
      meta: { askId: u.askId, cancelled: true },
    });
  }
};

// ----------------- 进程全局状态（挂 globalThis） -----------------

interface RunningRecord {
  cancel: () => void;
  // 当前 phase（agent 还没开始下一 phase 前 = 上一 phase awaiting 中）
  currentPhase: PhaseId;
  workflowDef: WorkflowDef;
}

interface PlanRunnerGlobalState {
  runningPlans: Map<string, RunningRecord>;
  // V0.5：标记「这个 task 正在被 fork（cancel 旧 agent 起新 agent）」
  // cancel 旧 run 时如果命中、cancelled 分支跳过 done 发送 + 不把 task 标 completed、保留 SSE 通道
  // 新 agent 启动时由 phase-ack 路由直接 runPlanWorkflow(fork=...)、共用同一条 SSE
  forkPendingTasks: Set<string>;
}

// V1：2026-05-15 加版本号后缀作防御；后续改 runner 内部 state 字段结构时 bump 版本号
// V2：2026-05-18 加 forkPendingTasks 字段、bump 版本号
const PLAN_RUNNER_GLOBAL_KEY = "__feAiFlowPlanRunnerStateV2__";

const getRunnerState = (): PlanRunnerGlobalState => {
  const g = globalThis as unknown as Record<string, PlanRunnerGlobalState>;
  if (!g[PLAN_RUNNER_GLOBAL_KEY]) {
    g[PLAN_RUNNER_GLOBAL_KEY] = {
      runningPlans: new Map(),
      forkPendingTasks: new Set(),
    };
  }
  return g[PLAN_RUNNER_GLOBAL_KEY];
};

const runningPlans = getRunnerState().runningPlans;
const forkPendingTasks = getRunnerState().forkPendingTasks;

/**
 * V0.5：标记 task 即将被 fork、cancel 旧 run 收尾时跳过 done 发送、保留 SSE 给新 agent 用。
 *
 * 调用方（phase-ack 路由）：
 *   1. markPlanForFork(taskId)
 *   2. cancelPlan(taskId)
 *   3. waitForPlanToStop(taskId)
 *   4. markPhaseAcked(taskId, ackPhase)
 *   5. runPlanWorkflow({ task, ..., fork: { fromPhase: nextPhase } })
 */
export const markPlanForFork = (taskId: string): void => {
  forkPendingTasks.add(taskId);
};

export const isPlanRunning = (taskId: string): boolean =>
  runningPlans.has(taskId);

export const cancelPlan = (taskId: string): boolean => {
  const rec = runningPlans.get(taskId);
  if (!rec) return false;
  rec.cancel();
  return true;
};

/**
 * V0.5.7：强制清除 in-memory runner state（不等 finally 块）
 *
 * 用途：start-workflow 路由发现 task 处于终态（draft / failed / completed）但
 * `isPlanRunning(taskId)` 仍 true 时——这是 stale state（dev hot reload / 手改 meta.json /
 * 老 bug 残留）、`cancelPlan` 拿到的 rec.cancel() 会尝试 cancel 一个已死的 SDK run、
 * 但 finally 块不会再次触发、entry 永远留着、用户视角就是「点启动按钮无反应」。
 *
 * 行为：直接 delete runningPlans + forkPendingTasks 两个 in-memory entry、
 * 不动硬盘（task.json 已是终态、不需要 patch）。
 *
 * 注意：只在「state 不一致」的场景调、正常路径不要用——会让正在跑的 agent 失联（finally 块清状态时 entry 已被删、虽然不致命但污染日志）。
 */
export const forceClearStaleRunnerState = (taskId: string): void => {
  runningPlans.delete(taskId);
  forkPendingTasks.delete(taskId);
};

/**
 * V0.5：等 runningPlans 里 task 对应记录被 finally 块清空。
 *
 * 触发：phase-ack 路由收到 forkAgent=true、需要先 cancelPlan 让旧 agent 收尾、
 * 再 runPlanWorkflow 起新 agent。两者中间必须确认旧 agent 已经从 runningPlans 里删除、
 * 否则新 runPlanWorkflow 会因为 `runningPlans.has(task.id)` 直接 return（幂等保护）。
 *
 * 实现：每 100ms 轮询一次、最长等 timeoutMs（默认 8 秒）。
 * 超时返 false、调用方决定是否重试 / 报错。
 */
export const waitForPlanToStop = async (
  taskId: string,
  timeoutMs = 8000,
): Promise<boolean> => {
  const start = Date.now();
  while (runningPlans.has(taskId)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
};

/**
 * 用户 approve 上一 phase 后、phase-ack 路由调这个、把上一 phase status 切到 ack。
 *
 * 注意：本函数只 patch 已 awaiting 的那个 phase；下一 phase 的 status 由 agent 下一次
 * 调用 wait_for_user 时通过 notifier 自动切。
 *
 * 返回最新 task。
 */
export const markPhaseAcked = async (
  taskId: string,
  phaseId: PhaseId,
): Promise<Task | null> => {
  const rec = runningPlans.get(taskId);
  if (!rec) {
    // agent 已经退出 / 没在跑、按 fail-safe 直接 patch
    return await patchPhase(taskId, {
      phaseId,
      status: "ack",
    });
  }
  // currentPhase 推进到下一个（agent 还没真切、但 UI 上先体现进度）
  const nextPhase = getNextPhase(rec.workflowDef, phaseId);
  const updated = await patchPhase(taskId, {
    phaseId,
    status: "ack",
    // currentPhase 切到下一 phase（最后一个 phase ack 时不变、等 agent run 结束自然 completed）
    ...(nextPhase ? { currentPhase: nextPhase } : {}),
    // 中间 phase ack → 下一 phase agent 立刻跑；最后一个 phase ack → agent run 自然收尾、整体仍 running
    taskStatus: "running",
  });
  if (nextPhase) {
    rec.currentPhase = nextPhase;
  }
  if (updated) publish(taskId, { kind: "task", task: updated });
  await writeEventAndPublish(taskId, {
    kind: "phase_ack",
    phase: phaseId,
    text: nextPhase
      ? `Phase ${phaseId} 已通过、推进到 ${nextPhase}`
      : `Phase ${phaseId} 已通过（最后一个 phase）、等待 agent 收尾`,
    meta: { nextPhase },
  });
  return updated;
};

// ----------------- 入参 -----------------

export interface RunPlanInput {
  task: Task;
  apiKey: string;
  model: ModelSelection;
  // 用户在设置页配的 MCP servers（已解析）
  // chat-tool 是我们自己塞进去的、不需要用户配
  userMcpServers?: Record<string, McpServerConfig>;
  // V0.3.5 引入、V0.5.7 移到 /start-workflow（mode=resume）：
  //   Agent.resume + send 续接 prompt、不重置 phase 状态、不走 phase_start
  // 触发：用户在 UI 上 wait-ack 长连接断后点「推进」、在 dialog 选「让原 agent 继续推进」
  // agentId 取自 task.lastAgentId（agent 第一次 Agent.create 时写）
  // resumePrompt 由调用方拼好（如 "[RESUME] wait-ack 连接断、请重新调 wait_for_user 续接当前 phase ack"）
  //
  // V0.5.7：resume 失败（NGHTTP2_ENHANCE_YOUR_CALM）时、本函数 catch 块会自动降级 fork、不要在
  // 外层加 retry 逻辑（双重 retry 会撞 backend rate limit）
  resume?: {
    agentId: string;
    prompt: string;
  };
  // V0.5：fork 模式——phase-ack 时用户主动选「换新 agent」/「切模型」
  //   - 走 Agent.create 新 agent（区别于 resume 的同 agentId）
  //   - super-prompt 顶部加 fork 提示、明确「fromPhase 之前的 phase 已完成、artifact 在 ...、直接从 fromPhase 开始」
  //   - phase 状态不重置（已 ack 的还是 ack、fromPhase 还是 running、等 agent 跑完调 wait_for_user）
  //   - 调用前调用方应：cancelPlan(taskId)→ 等 runningPlans delete → markPhaseAcked(prevPhase)
  fork?: {
    fromPhase: PhaseId;
    reason?: string;
  };
}

// ----------------- 主入口 -----------------

/**
 * 启动一个 plan workflow run（fire-and-forget 风格）。
 *
 * 进度通过 publishChatStreamEvent 广播给所有 SSE 订阅者（watch-chat 路由可以共用）。
 *
 * 已在跑就直接 return（幂等）。
 */
export const runPlanWorkflow = async (input: RunPlanInput): Promise<void> => {
  const { task, apiKey, model, userMcpServers, resume, fork } = input;
  const isResume = !!resume;
  const isFork = !!fork;

  if (runningPlans.has(task.id)) {
    return;
  }

  const workflowDef = WORKFLOWS[task.workflowId ?? "feishu-story-impl"];
  if (!workflowDef) {
    await patchPhase(task.id, { taskStatus: "failed" });
    await writeEventAndPublish(task.id, {
      kind: "error",
      text: `workflow ${task.workflowId} 未注册`,
    });
    return;
  }

  // 1) 切到 running：
  //    - 首次启动：phase 0 status=running + taskStatus=running
  //    - resume：保留 phase 状态（极可能是 awaiting_ack）、只切 taskStatus=running
  //      因为 agent 还没真醒、wait_for_user 还没重新调、awaiting_ack/awaiting_user 仍是事实
  //      只是「running」表示「agent 又在跑了」、用户能从 UI 看到 agent 不再是 dead 状态
  //    - fork（V0.5）：上游 phase 已 ack、fromPhase status=running + currentPhase=fromPhase
  //      跟首次启动的区别：firstPhase 换成 fork.fromPhase、phase 不重置全部、只切 fromPhase 为 running
  //      V0.5.7：fork 时 fromPhase 之后的所有 downstream phase 必须 reset 成 pending、
  //      不然「fork build」时 review 之前残留的 awaiting_ack 会让 UI 显示「review 待确认」语义错乱
  const firstPhase = workflowDef.phases[0]!;
  const startPhase = isFork ? fork!.fromPhase : firstPhase;
  let started: Task | null = null;
  if (isResume) {
    started = await patchPhase(task.id, { taskStatus: "running" });
  } else if (isFork) {
    const fromIdx = workflowDef.phases.indexOf(fork!.fromPhase);

    // V0.5.12.3：fork 模式自动 ack fromPhase 之前的所有 phase
    // 场景：用户在 build awaiting_ack 时直接点「推进 → fromPhase=review」
    //       从 start-workflow 路由走（不是 phase-ack 路由的 fork 分支）、
    //       此时 build phase 状态如果不 ack、phase-progress 会一直显示「build 待确认」
    //       但 review 已经基于 build 跑完了、状态机和实际进度脱节、用户视角懵
    // 语义：「fork from X」= 「用户认可 X 之前所有 phase 的产出」、自动 ack 符合直觉
    //       用户想 fix 上游 phase 应该 fork from 那个上游 phase、不是从更后的 phase 重跑
    // 区分：phase-ack 路由的 fork 已经在自己路径里 markPhaseAcked(ackPhase)、走到这里上游已 ack
    //       本逻辑覆盖的是 start-workflow 路由直接 fork 的场景、避免漏 ack 上游
    const upstreamPhases = workflowDef.phases.slice(0, fromIdx);
    for (const pid of upstreamPhases) {
      const currentMeta = await getTask(task.id);
      if (currentMeta && currentMeta.phases[pid]?.status !== "ack") {
        await patchPhase(task.id, { phaseId: pid, status: "ack" });
        await writeEventAndPublish(task.id, {
          kind: "phase_ack",
          phase: pid,
          text: `Phase ${pid} 由 fork 自动 ack（用户从 ${fork!.fromPhase} 重跑、隐式认可上游产出）`,
          meta: { autoAck: true, fromPhase: fork!.fromPhase },
        });
      }
    }

    // V0.5.7：reset fromPhase 之后的所有下游 phase 到 pending
    // 场景：用户在 review 已经 awaiting_ack 时点「推进 → 从 build 重启」、
    //       此时 review 状态如果不 reset、phase-progress 会显示「review 待确认」
    //       但实际新 agent 还没跑到 review、用户视觉跟实际状态错位
    const downstreamPhases = workflowDef.phases.slice(fromIdx + 1);
    for (const pid of downstreamPhases) {
      await patchPhase(task.id, { phaseId: pid, status: "pending" });
    }
    // 再 patch fromPhase 自身 + currentPhase + taskStatus（V0.5 老逻辑）
    started = await patchPhase(task.id, {
      phaseId: startPhase,
      status: "running",
      currentPhase: startPhase,
      taskStatus: "running",
    });
  } else {
    started = await patchPhase(task.id, {
      phaseId: firstPhase,
      status: "running",
      currentPhase: firstPhase,
      taskStatus: "running",
    });
  }
  if (started) publish(task.id, { kind: "task", task: started });

  // 2) 拼 mcpServers：用户的 + 我们自己的 chat-tool（plan 也复用 wait_for_user 工具）
  const mergedMcp: Record<string, McpServerConfig> = {
    ...(userMcpServers ?? {}),
    [CHAT_TOOL_MCP_NAME]: {
      type: "http",
      url: getChatMcpUrl(),
    },
  };

  const userMcpNames = Object.keys(userMcpServers ?? {}).filter(
    (n) => n !== CHAT_TOOL_MCP_NAME,
  );
  const mcpDesc = `Chat MCP: ${CHAT_TOOL_MCP_NAME}${
    userMcpNames.length > 0 ? ` + 用户 MCP: ${userMcpNames.join(", ")}` : ""
  }`;

  // resume 不写 phase_start（phase 没真重新开始、只是 agent 续接）、写 info 提示用户「正在续接」
  // fork（V0.5）写 phase_start、phase 是新 agent 真要跑的（fromPhase）、text 标明是 fork
  if (isResume) {
    await writeEventAndPublish(task.id, {
      kind: "info",
      phase: (task.currentPhase as PhaseId) ?? firstPhase,
      text: `推进 workflow（agent.resume 续接、model: ${model.id}、${mcpDesc}）`,
    });
  } else if (isFork) {
    await writeEventAndPublish(task.id, {
      kind: "phase_start",
      phase: startPhase,
      text: `Fork 启动新 agent（${workflowDef.id}、model: ${model.id}、${mcpDesc}、从 phase ${startPhase} 开始${
        fork!.reason ? `、原因: ${fork!.reason}` : ""
      }）`,
      meta: { fork: true, fromPhase: startPhase, reason: fork!.reason },
    });
  } else {
    await writeEventAndPublish(task.id, {
      kind: "phase_start",
      phase: firstPhase,
      text: `Plan workflow 启动（${workflowDef.id}、model: ${model.id}、${mcpDesc}）`,
    });
  }

  // 3) 注入 awaiting notifier：处理两类信号
  //   - awaiting_start：agent 调 wait_for_user(phase=xxx)、切对应 phase 状态 + 写一条 info
  //   - ask_user_request：agent phase 内提问、写 ask_user_request 事件 + 切 awaiting_user
  setChatAwaitingNotifier(task.id, async (signal) => {
    if (signal.kind === "ask_user_request") {
      // V0.3.2 一次打包多问题、modal 弹窗
      // text 给一个"N 个问题的预览"摘要、给 inline 回放卡片用
      // 真正的问题数组放在 meta.questions、modal 渲染时读
      const previewText = signal.questions
        .map((q, idx) => `Q${idx + 1}: ${q.question}`)
        .join("\n");
      const writtenTask = await writeEventAndPublish(task.id, {
        kind: "ask_user_request",
        phase: signal.phase as PhaseId | undefined,
        text: previewText,
        meta: {
          askId: signal.askId,
          token: signal.token,
          questions: signal.questions,
        },
      });
      const updated = await patchPhase(task.id, { taskStatus: "awaiting_user" });
      if (updated) publish(task.id, { kind: "task", task: updated });
      void writtenTask;
      return;
    }
    // awaiting_start：phase ack 边界
    const completedPhase = signal.phase as PhaseId | undefined;
    if (!completedPhase) {
      // 不带 phase 参数：agent 调用方式不对、按容错走任务级 awaiting
      const updated = await patchPhase(task.id, { taskStatus: "awaiting_user" });
      if (updated) publish(task.id, { kind: "task", task: updated });
      return;
    }
    const updated = await patchPhase(task.id, {
      phaseId: completedPhase,
      status: "awaiting_ack",
      currentPhase: completedPhase,
      taskStatus: "awaiting_user",
    });
    if (updated) publish(task.id, { kind: "task", task: updated });
    await writeEventAndPublish(task.id, {
      kind: "info",
      phase: completedPhase,
      text: `Phase ${completedPhase} 产出完成、等待用户确认${
        signal.artifact ? `（artifact=${signal.artifact}）` : ""
      }`,
      meta: { artifact: signal.artifact, phase: completedPhase },
    });
  });

  // 4) 启动 agent + 流式消费
  let agent: Awaited<ReturnType<typeof Agent.create>> | null = null;
  let cancelled = false;
  let hardTimer: NodeJS.Timeout | null = null;
  // V0.5.7：resume 失败降级 fork 标记
  // catch 块检测到 NGHTTP2_ENHANCE_YOUR_CALM 时设置、finally 末尾根据它调度新一次 runPlanWorkflow({ fork })
  let fallbackFork: { fromPhase: PhaseId } | null = null;

  try {
    // V0.3.5：resume 模式 vs 首次启动模式
    //   - 首次：Agent.create + send(superPrompt) 把完整 workflow 提示丢过去
    //   - resume：Agent.resume(agentId) + send(resumePrompt) 续接同一会话
    //     注：Agent.resume 内部会从 Cursor backend 拉之前的对话历史、不需要重发 superPrompt
    if (isResume) {
      // V0.5 修复：Agent.resume 也必须传 model（SDK 1.0.13 起 local agent 强制要求）
      // 之前漏传、resume 时 agent.send 报 ConfigurationError: "Local SDK agents require an explicit `model`"
      agent = await Agent.resume(resume!.agentId, {
        apiKey,
        model,
        // V0.5.9：cwd = effective（单仓 = 仓自身、多仓 = 公共父目录）
        local: { cwd: getEffectiveCwd(task.repoPaths) },
        mcpServers: mergedMcp,
      });
      console.log(
        `[plan-runner] resume task=${task.id} agentId=${resume!.agentId}`,
      );
    } else {
      agent = await Agent.create({
        apiKey,
        model,
        // V0.5.9：cwd = effective（单仓 = 仓自身、多仓 = 公共父目录）
        local: { cwd: getEffectiveCwd(task.repoPaths) },
        mcpServers: mergedMcp,
      });
    }

    // 首次启动时持久化 agentId、给后续 /start-workflow（mode=resume）用
    // resume 时不重新写（用同一个 agentId、不变）
    if (!isResume) {
      try {
        await setTaskLastAgentId(task.id, agent.agentId);
        console.log(
          `[plan-runner] 已持久化 lastAgentId=${agent.agentId} task=${task.id}`,
        );
      } catch (err) {
        console.warn(
          `[plan-runner] setTaskLastAgentId failed task=${task.id}`,
          err,
        );
      }
    }

    let run: Awaited<ReturnType<NonNullable<typeof agent>["send"]>>;
    if (isResume) {
      // resume prompt 由调用方拼好（短短一句、不重发 super-prompt）
      run = await agent.send(resume!.prompt);
    } else {
      // V0.5.9：skills 按 effective cwd 扫（单仓 = 仓自身、多仓 = 公共父目录）
      // 多仓时如果只一个子仓里有 .cursor/skills、loadSkills 在公共父目录扫不到——
      // 当前 skills 主要从 fe-ai-flow 项目内置目录走、跨仓影响小、暂不强化（后续真踩到再扫各子仓合并）
      const skills = await loadSkills(getEffectiveCwd(task.repoPaths)).catch((err) => {
        console.error("[plan-runner] loadSkills failed", err);
        return [];
      });
      // V0.5：fork 模式下 buildSuperPrompt 顶部多一段「fork 启动提示」
      // agent 看到后跳过前面 phase、直接从 fromPhase 开始
      const superPrompt = await buildSuperPrompt(
        task,
        workflowDef,
        skills,
        fork,
      );
      run = await agent.send(superPrompt);
    }

    runningPlans.set(task.id, {
      cancel: () => {
        cancelled = true;
        cancelPending(task.id);
        void run.cancel().catch(() => {
          /* noop */
        });
      },
      currentPhase: startPhase,
      workflowDef,
    });

    hardTimer = setTimeout(() => {
      cancelled = true;
      cancelPending(task.id);
      void run.cancel().catch(() => {
        /* noop */
      });
    }, PLAN_HARD_TIMEOUT_MS);

    // 流式消费：assistant text 聚合 → assistant_message 事件、跟 chat-runner 同款逻辑
    const assistantCtx: AssistantBufferCtx = {
      buffer: "",
      flush: async () => {
        const trimmed = assistantCtx.buffer.trim();
        assistantCtx.buffer = "";
        if (trimmed.length === 0) return;
        await writeEventAndPublish(task.id, {
          kind: "assistant_message",
          text: trimmed,
        });
      },
    };

    for await (const msg of run.stream()) {
      await handlePlanSdkMessage(task.id, msg, assistantCtx);
    }
    await assistantCtx.flush();

    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }

    const result = await run.wait();

    if (cancelled || result.status === "cancelled") {
      // V0.5：如果是 fork 引起的 cancel、跳过 done 发送、不切 task.status=completed
      // 让客户端 SSE 流保留、phase-ack 路由后续 runPlanWorkflow(fork=true) 会继续 publish 事件
      const isForkPending = forkPendingTasks.has(task.id);
      if (isForkPending) {
        forkPendingTasks.delete(task.id);
        await writeEventAndPublish(task.id, {
          kind: "info",
          text: "旧 agent 已收尾、正在为 fork 启动新 agent...",
        });
        return;
      }
      const cancelledTask = await patchPhase(task.id, {
        taskStatus: "completed",
      });
      if (cancelledTask)
        publish(task.id, { kind: "task", task: cancelledTask });
      const done = await writeEventAndPublish(task.id, {
        kind: "info",
        text: "Plan workflow 已被取消",
      });
      publish(task.id, { kind: "done", task: done ?? task, ok: true });
      return;
    }

    if (result.status !== "finished") {
      // SDK RunResult 类型只有 id/status/result?/model?/durationMs?/git? 6 个字段、
      // status=error 时 SDK 经常啥都不填、只能尽量从 result 本身 + agent / run 对象上抓更多信息
      let resultDump: string;
      try {
        resultDump = JSON.stringify(result, null, 2);
        if (resultDump.length > 1500) resultDump = `${resultDump.slice(0, 1500)}…(truncated)`;
      } catch {
        resultDump = String(result);
      }
      // 把 run 对象上的额外字段（result / durationMs / git）也 dump 一份、SDK 内部可能在 stream 结束后才更新
      const runExtras: Record<string, unknown> = {};
      try {
        const r = run as unknown as Record<string, unknown>;
        if (r.result !== undefined) runExtras.runResult = r.result;
        if (r.durationMs !== undefined) runExtras.runDurationMs = r.durationMs;
        if (r.git !== undefined) runExtras.runGit = r.git;
      } catch {
        /* noop */
      }
      const extrasDump = Object.keys(runExtras).length > 0
        ? `\n--- run object extras ---\n${JSON.stringify(runExtras, null, 2).slice(0, 800)}`
        : "";
      // 把 stream 里最近一条 SDK status=ERROR/EXPIRED 的 message 拼上（如果有的话）——
      // 这是排查 SDK 端致命错误最关键的诊断信息、不能丢
      const sdkErr = assistantCtx.sdkErrorMessage
        ? `\n--- SDK stream error message ---\n${assistantCtx.sdkErrorMessage}`
        : "";
      throw new Error(
        `agent run status=${result.status}${sdkErr}\n--- SDK result dump ---\n${resultDump}${extrasDump}`,
      );
    }

    // **agent 提前退出检测**（V0.3 新增、V0.3.3 改造）
    // 实测踩坑两类：
    //   类型 A：agent 写完 artifact 后没调 wait_for_user 直接退出（入口跳过）
    //   类型 B：agent 调了 wait_for_user → shell + curl 进 long-poll、连接异常断后
    //          没按 prompt 引导 emit「请点推进」短文本就退、而是别的退出原因
    //          （V0.3.5 起这类大幅减少、新方案 shell + curl 不轮询、anti-loop 不会触发）
    //
    // 不管哪种、agent 都已死、要继续后续 phase 必须点「推进」起新 run（用户花 1 次 send 配额）
    //
    // V0.3.3 改造：区分两种早退场景、给 UI 不同视觉信号、不要全标 failed
    //   - artifact 已落盘的 phase：标 awaiting_ack、UI 显示"等审阅"色 + artifact 内容
    //                              （用户重启后 agent 看到 artifact 大概率跳过这 phase）
    //   - artifact 未生成的 phase：标 failed（真完蛋、重启会重做）
    //   - task 整体仍标 failed（agent 已死、需要重启）
    //
    // 这一步本质是给用户更好的心理体验——"artifact 已生成、重启就能续"、不是"全废了"
    const latestForCheck = await getTask(task.id);
    const phasesNeedAck = workflowDef.phases.filter(
      (pid) => latestForCheck?.phases[pid]?.status !== "ack",
    );
    if (phasesNeedAck.length > 0) {
      // 按 artifact 是否落盘、把未 ack 的 phase 分两类
      // artifact.content 是 phaseState 里内联存的产物文本、空 / 缺失 = 没产出
      const phasesWithArtifact: string[] = [];
      const phasesNoArtifact: string[] = [];
      for (const pid of phasesNeedAck) {
        const phaseState = latestForCheck?.phases[pid];
        const hasArtifact = !!phaseState?.artifact?.content?.trim();
        if (hasArtifact) {
          phasesWithArtifact.push(pid);
          // 这个 phase 实际有产物、标 awaiting_ack（UI 上会显示"等审阅"色 + artifact）
          await patchPhase(task.id, {
            phaseId: pid,
            status: "awaiting_ack",
          });
        } else {
          phasesNoArtifact.push(pid);
          // 没产出的、维持 phase 原状态（pending / running）、不需要特别标 failed
          // 因为 task 整体已经标 failed、phase 卡片显示"未开始"也合理
        }
      }

      // task 整体标 failed——agent 已死、用户必须点重启才能继续
      const earlyExitTask = await patchPhase(task.id, {
        taskStatus: "failed",
      });
      // 收尾未答 ask_user_request——UI 弹窗自动关、否则用户卡死
      await cancelUnrepliedAsks(task.id);
      if (earlyExitTask)
        publish(task.id, { kind: "task", task: earlyExitTask });

      // 友好文案：根据是否有 artifact 给不同建议
      const tipLines: string[] = [];
      if (phasesWithArtifact.length > 0) {
        tipLines.push(
          `agent 提前退出 run、但已生成产物的 phase 不浪费`,
          ``,
          `已产出 artifact 的 phase（已标记"等审阅"、可在右侧面板查看内容）：`,
          ...phasesWithArtifact.map((p) => `  • ${p}`),
        );
        if (phasesNoArtifact.length > 0) {
          tipLines.push(
            ``,
            `还未开始的 phase：${phasesNoArtifact.join(", ")}`,
          );
        }
        tipLines.push(
          ``,
          `下一步（点顶部「推进」按钮）：`,
          `  • 内容 OK → 选「从指定 phase 重启」、phase 选 ${phasesNoArtifact[0] ?? "下一未完成"}（自动推断、+1 send 配额）`,
          `  • 内容不 OK → 删了硬盘上的 artifact 文件后再「从指定 phase 重启」选有问题的 phase、让 agent 重做`,
          `  • 反复踩 → 换更稳的模型（claude-sonnet-4 / claude-opus-4-7-thinking）`,
        );
      } else {
        tipLines.push(
          `agent 提前退出 run、且没有产出任何 artifact`,
          ``,
          `未跑完的 phase：${phasesNeedAck.join(", ")}`,
          ``,
          `这通常是模型协议理解错误（写完 artifact 后没调 wait_for_user / shell + curl 拿结果时退出 run）。`,
          `建议：点「推进」→ 在弹窗选「从指定 phase 重启」或「从头完全重跑」、或换更稳的模型（claude-sonnet-4 / claude-opus-4-7-thinking）。`,
        );
      }
      const done = await writeEventAndPublish(task.id, {
        kind: "error",
        text: tipLines.join("\n"),
      });
      publish(task.id, { kind: "done", task: done ?? task, ok: false });
      return;
    }

    // 真完成：所有 phase 都 ack 了、agent 自然退出
    const completedTask = await patchPhase(task.id, {
      taskStatus: "completed",
    });
    if (completedTask)
      publish(task.id, { kind: "task", task: completedTask });
    const done = await writeEventAndPublish(task.id, {
      kind: "info",
      text: "Plan workflow 全部 phase 完成",
    });
    publish(task.id, { kind: "done", task: done ?? task, ok: true });
  } catch (err) {
    if (hardTimer) clearTimeout(hardTimer);
    // CursorSdkError 携带 code / status / requestId / cause / endpoint、对诊断 backend 错误极有帮助
    // 普通 Error 只有 message
    let message = err instanceof Error ? err.message : String(err);
    // V0.5.7：把 cause.message 也并入到 detectFork 判断里（NGHTTP2_ENHANCE_YOUR_CALM
    // 经常埋在 ConnectError.cause.message）
    let causeMessage = "";
    try {
      const e = err as Record<string, unknown>;
      const sdkBits: Record<string, unknown> = {};
      if (typeof e.code === "string") sdkBits.code = e.code;
      if (typeof e.status === "number") sdkBits.status = e.status;
      if (typeof e.requestId === "string") sdkBits.requestId = e.requestId;
      if (typeof e.endpoint === "string") sdkBits.endpoint = e.endpoint;
      if (typeof e.operation === "string") sdkBits.operation = e.operation;
      if (typeof e.isRetryable === "boolean") sdkBits.isRetryable = e.isRetryable;
      if (e.cause !== undefined) {
        const cause = e.cause;
        if (cause instanceof Error) {
          sdkBits.causeName = cause.name;
          sdkBits.causeMessage = cause.message;
          causeMessage = cause.message;
        } else {
          sdkBits.cause = String(cause);
          causeMessage = String(cause);
        }
      }
      if (Object.keys(sdkBits).length > 0) {
        message += `\n--- SDK error fields ---\n${JSON.stringify(sdkBits, null, 2)}`;
      }
    } catch {
      /* noop */
    }
    console.error(`[plan-runner] task=${task.id} failed:`, err);

    // V0.5.7：resume 模式 + backend 拒（agent 已被 backend 清理）→ 自动降级 fork
    //
    // 触发特征（任一命中就降级）：
    //   - 错误 message / cause.message 含 NGHTTP2_ENHANCE_YOUR_CALM（HTTP/2 rate limit）
    //   - 错误 cause 是 ConnectError 且 message 含 "Stream closed"（agent 不可用）
    //
    // 行为：
    //   1. 不写 task.status=failed、不发 done 事件——让 SSE 流保持开着
    //   2. 写一条 info「resume 被 backend 拒绝、自动降级新 agent fork」
    //   3. 标记 fallbackFork = true、finally 块末尾用 setTimeout 触发新一次 runPlanWorkflow({ fork })
    //
    // 不命中时走老路径（写 failed + done + error）
    const isEnhanceYourCalm =
      message.includes("NGHTTP2_ENHANCE_YOUR_CALM") ||
      causeMessage.includes("NGHTTP2_ENHANCE_YOUR_CALM");
    const isStreamClosed =
      causeMessage.includes("Stream closed") ||
      causeMessage.includes("ERR_HTTP2_STREAM_ERROR");
    const shouldFallbackFork =
      isResume && (isEnhanceYourCalm || isStreamClosed);

    // V0.5.15：fallbackFork 决策诊断 log——便于排查「resume 失败但没自动降级」的 case
    // 关键 flags：isResume / isEnhanceYourCalm / isStreamClosed 任一不命中都不降级
    console.log(
      `[plan-runner] task=${task.id} catch decision: isResume=${isResume} isEnhanceYourCalm=${isEnhanceYourCalm} isStreamClosed=${isStreamClosed} → shouldFallbackFork=${shouldFallbackFork}`,
    );

    if (shouldFallbackFork) {
      console.log(
        `[plan-runner] task=${task.id} resume 失败 (ENHANCE_YOUR_CALM/StreamClosed)、安排降级 fork`,
      );
      // 留 task.status=running 不动（让 SSE 保持开着）、写 info 告知用户
      await writeEventAndPublish(task.id, {
        kind: "info",
        text: [
          "原 agent 在 Cursor backend 已被清理（NGHTTP2_ENHANCE_YOUR_CALM）",
          "自动降级为「起新 agent + 从当前 phase 接力」（同 fork 模式、扣 1 次 send 配额）",
        ].join("\n"),
      });
      fallbackFork = {
        fromPhase: (task.currentPhase as PhaseId) ?? "plan",
      };
    } else {
      // 友好恢复指引：如果有 phase 已经写完 artifact（status=awaiting_ack）、
      // 用户可以点「推进」从下一未完成 phase 接力（agent 会看到已有 artifact、大概率复用）
      const failedTask = await patchPhase(task.id, { taskStatus: "failed" });
      // 收尾未答 ask_user_request——UI 弹窗自动关、否则用户卡死
      await cancelUnrepliedAsks(task.id);
      const awaitingPhases =
        failedTask
          ? Object.values(failedTask.phases).filter(
              (p) => p.status === "awaiting_ack",
            )
          : [];
      const hasArtifact = awaitingPhases.length > 0;

      if (failedTask) publish(task.id, { kind: "task", task: failedTask });
      const friendly = hasArtifact
        ? [
            `Plan workflow 失败：${message}`,
            "",
            `已产出的 artifact（${awaitingPhases.map((p) => p.id).join(", ")}）仍然可读、点顶部「推进」可以从下一未完成 phase 接力`,
            "如果模型在 wait_for_user / shell long-poll 上反复挂、试试换更稳的模型（claude-opus-4 / claude-sonnet-4）",
          ].join("\n")
        : `Plan workflow 失败：${message}`;
      const updated = await writeEventAndPublish(task.id, {
        kind: "error",
        text: friendly,
      });
      publish(task.id, { kind: "done", task: updated ?? task, ok: false });
      publish(task.id, { kind: "error", message });
    }
  } finally {
    runningPlans.delete(task.id);
    cancelPending(task.id);
    setChatAwaitingNotifier(task.id, null);
    if (agent) {
      try {
        agent.close();
      } catch {
        /* noop */
      }
    }

    // V0.5.7：resume 失败降级 fork——finally 末尾、清完 runningPlans 之后调度
    // setTimeout 0 让事件循环转一圈、保证当前 finally 完全退出再起新 run
    if (fallbackFork) {
      const { fromPhase } = fallbackFork;
      console.log(
        `[plan-runner] task=${task.id} 调度 fallback fork（fromPhase=${fromPhase}）`,
      );
      setTimeout(() => {
        void runPlanWorkflow({
          task,
          apiKey,
          model,
          userMcpServers,
          fork: {
            fromPhase,
            reason: "resume 失败自动降级 (NGHTTP2_ENHANCE_YOUR_CALM)",
          },
        }).catch((err) => {
          console.error(
            `[plan-runner] task=${task.id} fallback fork threw:`,
            err,
          );
        });
      }, 0);
    }
  }
};

// ----------------- SDKMessage 翻译器 -----------------

interface AssistantBufferCtx {
  buffer: string;
  flush: () => Promise<void>;
  // SDK 推过来的最近一条 status=ERROR/EXPIRED 的 message——
  // RunResult 类型没 error message 字段、只有这条 stream 消息能拿到具体原因、
  // 后续 throw 时把它拼到 Error 文案上方便诊断
  sdkErrorMessage?: string;
}

const handlePlanSdkMessage = async (
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

      // write / edit 调用时如果路径形如 artifacts/01-plan.md、把 artifact 内容也推一份给 SSE
      // 不严格依赖工具名（SDK 1.0.13 是 `write` / `edit`、不带 _file 后缀）
      // 通过 args.target_file 模式识别（agent 跑约定的路径时才推）
      // V0.5.1 修：之前直接 break 把 edit / write 失败事件吞了、改成 running 推 tool_call、error 推 error
      {
        const possibleTarget =
          (argsAny.target_file as string | undefined) ??
          (argsAny.file_path as string | undefined) ??
          (argsAny.path as string | undefined);
        if (
          possibleTarget &&
          typeof possibleTarget === "string" &&
          possibleTarget.includes("artifacts/")
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
            // 注：之前在这做过「edit + 文件不存在」的 warning 检测、是误报
            // 实测 SDK 1.0.13 的 edit 工具能创建不存在文件、不会拒
            // 如果真的失败、会走下面 status=error 分支报「artifact 写入失败」
            break;
          }
          if (msg.status === "error") {
            const resStr = stringifyMeta(msg.result);
            await writeEventAndPublish(taskId, {
              kind: "error",
              text: `artifact 写入失败 ${msg.name} → ${possibleTarget}：${truncate(resStr, 200)}`,
              meta: {
                name: msg.name,
                target: possibleTarget,
                result: truncate(resStr),
              },
            });
            break;
          }
          break;
        }
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
          meta: {
            name: msg.name,
            args: argsStr ? truncate(argsStr) : undefined,
          },
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
      // SDK 把服务端致命错误的具体描述放在 status 消息的 message 字段里、
      // 而 RunResult 类型只有 status / model / durationMs、不带 message——
      // 不在这里把 ERROR / EXPIRED 推出来、最后 throw 出去的报错就是空的、只能猜原因
      //
      // V0.5.5 增强：先 console.log 一份 raw status 消息（运维 / 用户排查用）
      // 实测 SDK 1.0.13 status=error 时偶尔不发 status 流消息、run.wait() 拿到 error 就直接退、
      // 这条 log 能让用户在 dev server 终端看到「SDK 到底有没有给详细错误描述」
      console.log(
        `[plan-runner] SDK status message: status=${msg.status} message=${
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

// V0.2 起、旧的 V1 runPlanPhase / run-plan SSE route 已删
// 入口统一是 runPlanWorkflow + /api/tasks/[id]/start-workflow（fire-and-forget）+ watch-chat SSE
