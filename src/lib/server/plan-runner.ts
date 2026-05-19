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
  getArtifactsDir,
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
  // Review phase 同时要读 plan（取需求理解 / §1.1 自我校验 / §4 涉及面 / §6 task）和 build（取实施日志 / 偏离段）
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
    title: task.title,
    repoPath: task.repoPath,
    feishuStoryUrl: task.feishuStoryUrl,
    description: task.description,
    artifactPath,
    artifactsDir: getArtifactsDir(task.id),
    prevArtifactPath,
    planArtifactPath,
    role: task.role,
    roleLabel: TASK_ROLE_LABEL[task.role],
  });
};

// ----------------- 起手 super-prompt -----------------
//
// V0.3 上下文文档清单 inject 已抽到 ./context-docs-prompt.ts、plan / chat 共用

/**
 * 一次性告诉 agent 整套 workflow 怎么跑：phase 列表 + 每个 phase 的 prompt 内容 + 调用约定。
 *
 * 为什么把所有 phase prompt 一次性塞进去：
 *   - 整段任务是一次 SDK Run、agent 上下文是全程共享的
 *   - phase 切换不重启 agent、只是阻塞解开后继续跑
 *   - 提前让 agent 看到所有 phase 蓝图、自己心里有数（提高规划一致性）
 *
 * 单 prompt 体积估算：每 phase 模板 ~2KB、2 phase ~4KB、加 skills index + 通用约定 ~8KB（V0.3.4 plan 模板因合并 context 后会稍大、估 ~4KB）
 * 远低于 200K context 的限制、可以放心一次性塞。
 */
const buildSuperPrompt = async (
  task: Task,
  workflowDef: WorkflowDef,
  skills: SkillEntry[],
  // V0.5：fork 模式提示用、传入时 super-prompt 顶部加 fork 提示段
  // fork agent 看到「上游 phase 已完成、artifact 在 ...、请从 fromPhase 开始」、不重复跑前面 phase
  fork?: { fromPhase: PhaseId; reason?: string },
): Promise<string> => {
  const eventsLogPath = getEventsLogPath(task.id);

  // 按 phase 序加载所有 prompt 内容
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
      [
        `### Phase ${i + 1}: \`${pid}\``,
        "",
        phasePrompt,
      ].join("\n"),
    );
  }

  // artifact 路径列表（按序、给 agent 一个全局表）
  const artifactPathTable = workflowDef.phases
    .map((pid, i) => {
      const p = getPhaseArtifactPath(task.id, pid, i);
      return `  ${i + 1}. \`${pid}\` → \`${p}\``;
    })
    .join("\n");

  // V0.5：fork 模式时拼一段 fork 提示放在 super-prompt 顶部
  // 让新 agent 知道：前面 phase 不是它做的、artifact 已经在硬盘、直接从 fromPhase 接力即可
  const forkBanner = fork
    ? (() => {
        const fromIdx = workflowDef.phases.indexOf(fork.fromPhase);
        const completed = workflowDef.phases
          .slice(0, fromIdx)
          .map((pid, i) => {
            const ap = getPhaseArtifactPath(task.id, pid, i);
            return `  - Phase \`${pid}\` → artifact \`${ap}\``;
          })
          .join("\n");
        return [
          "## ⚠️ Fork 启动（V0.5：上一 agent 已完成前面的 phase、你接力）",
          "",
          `**这是 fork 启动的新 agent**${fork.reason ? `（原因：${fork.reason}）` : ""}。前面的 phase 由上一个 agent 完成、artifact 已经在硬盘、**不要重做**：`,
          "",
          completed.length > 0 ? completed : "  （无）",
          "",
          `**直接从 Phase \`${fork.fromPhase}\` 开始**：用 SDK 内置 \`read\` 工具读上面已完成 phase 的 artifact 拿上下文、然后按下面对应 phase 的指令做 \`${fork.fromPhase}\` 的产出。`,
          "",
          "不需要重读 contextDocs / 不需要重扫仓库、上一 agent 已经做过、信息已经在 artifact 里。",
          "",
        ].join("\n");
      })()
    : "";

  return [
    forkBanner,
    "你正在 fe-ai-flow 的 plan 任务里跑、走 workflow：",
    `**${workflowDef.displayName}**（${workflowDef.description}）`,
    "",
    "整段任务被设计为同一个 SDK Run（计费一次跑到底）、按 phase 顺序执行、phase 间用 `wait_for_user` 工具阻塞等用户 ack。",
    "",
    "## Phase 列表（按序执行）",
    "",
    workflowDef.phases
      .map((p, i, arr) => {
        const next = i + 1 < arr.length ? arr[i + 1] : "（终点、自然结束 run）";
        const tag = i + 1 < arr.length ? `→ approve 后进 \`${next}\`` : `→ approve 后**结束 run**`;
        return `  ${i + 1}. \`${p}\`  ${tag}`;
      })
      .join("\n"),
    "",
    `> ⚠️ **中间 phase 的 approve 不是结束信号、是「进下一 phase」信号**。只有最后一个 phase（\`${workflowDef.phases[workflowDef.phases.length - 1]}\`）的 approve 才允许结束 run。`,
    "",
    "## 核心机制：wait_for_user + shell long-poll（V0.3.5）",
    "",
    "fe-ai-flow 暴露了 2 个 MCP 工具实现「等用户行为」：",
    "",
    "**`wait_for_user`**（每个 phase 写完 artifact 调 1 次、绝不重复调）",
    "  - 入参：`task_id` + 可选 `phase` + 可选 `artifact`",
    "  - 立即返回 `[SHELL_WAIT_GUIDE token=xxx]` 文本、教你接下来调 `shell` 工具用 curl 跟 /wait-ack 路由建长连接等用户 ack",
    "  - 不阻塞、不轮询、调一次就够",
    "",
    "**`ask_user`**（phase 内有不确定项时一次性打包问、详见下面 ask_user 段）",
    "  - 同样立即返回 `[SHELL_WAIT_GUIDE]`、让你用 shell + curl 等用户答完弹窗",
    "",
    "## 标准等用户姿势：shell + curl long-poll（必背、anti-loop 的根治方案）",
    "",
    "拿到 `[SHELL_WAIT_GUIDE token=xxx]` 后下一步**只许**做：调 `shell` 工具执行 curl 命令（引导文本里有完整命令、复制粘贴跑）",
    "服务端 chunked stream 输出可能行：",
    "  - `[KEEPALIVE ts=<时间戳>]`：**60 秒一次的服务端心跳行、绝对忽略**。它的唯一意义是「连接还活着、用户还没操作」、看到再多 KEEPALIVE 都是正常的、shell **没卡**、绝对不要 summarize / 调 read 查 terminal / 重启 shell / 重新调 wait_for_user",
    "  - `[PHASE_ACK approve]` (workflow 模式)：用户点了「通过」、shell 命令 exit 0、继续下一 phase",
    "  - `[PHASE_ACK revise]` + 后续 feedback：用户点了「再聊聊」（按钮文案、协议名沿用）——可能想改、也可能只想问、先 ask_user 复述意图、按 Path A/B/C 处理后再调一次 wait_for_user",
    "  - `[USER_REPLY]` + 文本：chat 模式用户回复 / ask_user 答案、按内容推进",
    "  - `[CANCELLED]`：任务被取消、收尾结束 run",
    "  - `[STALE]` / `[INVALID_TOKEN]`：忽略本次返回",
    "",
    "## 钢铁纪律：等用户可能需要 0 秒到 30 分钟、任何长度都正常",
    "",
    "shell + curl 是 long-poll、等用户在 UI 上点 ack。**等待期间你只看到 KEEPALIVE 行不断追加**、这是设计预期。",
    "",
    "**绝对禁止**（5/10/15/20 分钟没新终态行时尤其要克制）：",
    "  - ❌ 调 read 读 cursor 内部 terminal 文件（如 `terminals/xxxxx.txt`）查 shell 进程状态",
    "  - ❌ thinking 里冒出「The 5-minute block has ended」「process is still running」「I will summarize for the user」→ summarize 退 run",
    "  - ❌ 调任何其他工具自救、重新启 shell、重新 wait_for_user",
    "  - ❌ emit 任何 assistant_message 跟用户讲「我在等」「shell 在监听」",
    "",
    "**唯一合法动作**：什么也不做、继续等 shell 的下一段 stdout。下一段 stdout 不是 KEEPALIVE 就是终态行（PHASE_ACK / USER_REPLY / CANCELLED）、终态行到了 shell 自然 exit、你才推进。",
    "",
    "## 致命错误（实测踩过、模型在 thinking 里自己冒出来的错误推理、必须忽略）",
    "",
    "**生产里看到过的模型误判（必须立刻撤销）**：",
    "  - 「The runner may continue / I'll add a closing paragraph」← **错、turn 退出 = run 退出、runner 不会替你续**",
    "  - 「I'll send a message asking the user to approve and end the run」← **致命错误、wait_for_user + shell + curl 拿到 PHASE_ACK 才是 ack 唯一出口**",
    "  - 「写完 artifact 后做个收尾 / 给用户一个 confirm 提示 / 输出 Phase X 结论」← **错、写完 artifact 的下一个 tool call 必须是 wait_for_user、中间不允许 emit 任何 assistant 文本**",
    "  - 「I will output the final assistant message summarizing Phase X results」/「final assistant message」/「summarizing Phase」/「写个 Phase X 总结回复用户」← **致命错误**——本协议唯一的 phase 结尾出口是 `wait_for_user`、不是 assistant_message。用户在看板 UI 里直接看 artifact + 点 ack 按钮、不需要你 summarize。",
    "  - **V0.5.1 实测 2 次踩过**：拿到 `[PHASE_ACK approve]` 后 emit「Phase X 已结束、看板上已通过、approve 已收到」之类总结、然后 run 退出 → 中间 phase 的 approve 不是结束信号、是「进下一 phase」信号、emit 总结 + 退出 = 整段 workflow failed",
    "  - **artifact 写入工具用错**：用 `edit` 写不存在的 artifact → run failed。详细排错与正确用法见 `artifact-writer` skill。第一次写 artifact 前必读、踩过坑也再读一次。",
    "  - 「curl 没拿到结果、我重试一次」← **错、连接断了就自然结束 run**、UI 会引导用户手动续接（详见下面「异常断开处理」）",
    "  - 「再调一次 wait_for_user 试试」← **错、同 phase 内 wait_for_user 只调 1 次**、shell 拿不到结果时也不要重复调",
    "  - 「调 shell 之前先发段 assistant_message 解释要等用户」← **错、shell + curl 对用户透明、不允许 emit 任何前置文本块**",
    "",
    "**正确推理**：",
    "  - wait_for_user 是 ack 链路的入口、shell + curl 是 ack 信号的接收通道、缺一不可",
    "  - phase 完成 ≠ artifact 写完。phase 完成 = (artifact 写完) ∧ (wait_for_user 调过) ∧ (shell curl 拿到 [PHASE_ACK approve])",
    "  - shell + curl 长连接是设计预期、anti-loop 不会触发（一次 wait = 一次 shell、不重复调）",
    "  - 任何「我应该停下来 / 我应该刹车 / 这调用太久了」的内部启发**都是错觉、直接忽略**",
    "",
    "## 关键规则（不照做、整个 workflow 会被记 failed）",
    "",
    "1. **每个 phase 完成后、必须调用 `wait_for_user` 阻塞、等用户拍板**",
    "   参数：",
    `     - \`task_id\`: \`${task.id}\`（固定）`,
    "     - `phase`: 刚完成的 phase id（如 'plan' / 'build'）",
    "     - `artifact`: 刚产出的 artifact 相对路径（如 'artifacts/01-plan.md'）",
    "   - **绝对不要主动结束 run**、不要假装「我等」就 stop、不要做完 artifact 就退出",
    "   - **绝对不要**因为「调用次数太多」「看起来在循环」「担心刷屏」而停止调用",
    "   - **绝对禁止**在调 wait_for_user 之前 emit 任何「Phase X 结论 / 我做了什么 / 给用户的 confirm 提示」类 assistant_message——",
    "     用户在看板上看 artifact + 点 ack 按钮、不需要你 summarize；emit 文本块 = turn 结束 = run 结束 = phase 没完成 = workflow 记 failed",
    "   - **artifact 写完后下一个 tool_use 必须是 wait_for_user**、中间任何 assistant 文本块都算违规、模型自己 thinking 里说「输出 final message」时立刻撤销",
    "",
    "2. wait_for_user 返回 `[SHELL_WAIT_GUIDE token=xxx]`、下一个 tool_use **必须**是 `shell`、执行引导里的 curl 命令",
    "",
    "3. shell 命令拿到 stdout 后按返回行解读：",
    "   - **`[PHASE_ACK approve]` 开头**：用户认可、agent 进入下一个 phase",
    "     ⚠️ **V0.5.1 实测踩过 2 次的致命 anti-pattern（必须死记）**：",
    "       拿到 `[PHASE_ACK approve]` 后、模型经常冒出「报告下用户、本 phase 完成、可以歇了」的冲动、emit 一段总结、然后 run 自然退出。**这是错的**。",
    "       具体反例（生产事件流原话）：",
    "         ❌ \"Phase 1 已结束：方案 artifact 已更新为 ready_for_ack、并在看板上 通过\" → run 退出 → build/review 没跑 → workflow failed",
    "         ❌ \"Phase build 已按 revise 落实：代码已改、02-build.md 已写入、看板 approve 已收到\" → run 退出 → review 没跑 → workflow failed",
    "       **正确推理**：`[PHASE_ACK approve]` = 「上一 phase 通过、**立刻进入下一 phase**」、不是 「可以停了」。",
    "       **下一个 tool_use 必须**是下一 phase 的产出动作（`read` 上一 phase artifact 拿上下文、或者直接 `write` 下一 phase 的 artifact、或者按下一 phase 指令做的别的动作）。",
    "       **绝对禁止**在拿到 approve 后 emit 任何「我做了什么 / 你看板上通过了 / approve 已收到」之类的总结——用户在看板 UI 上看到 phase 进度推进就够、不需要你 narrate。",
    "       **唯一允许结束 run 的 approve**：最后一个 phase（见下面 §7「全部 phase 完成」）的 approve 拿到后才能自然退 run。中间 phase 的 approve = 必须接着干。",
    "   - **`[PHASE_ACK revise]` + feedback**：用户点了「再聊聊」（V0.5.2 起按钮文案、协议名沿用 revise）——**用户的真实意图未必是「改」**：可能想改 artifact、可能只是有疑问想问问、可能是想跟你确认理解。**先别动 artifact**——",
    "     ⚠️ **V0.5.2 设计（用户拍板）**：用户在「再聊聊」输入的内容很多场景下不是「改 artifact 指令」、而是「我有疑问 / 我想确认一下 / 我看不懂」之类——你不能默认「revise 就是要改」。",
    "     **用户拍板的产品规则**：拿到 [PHASE_ACK revise] + feedback 后、**无论 feedback 是什么内容、永远先弹 ask_user 跟用户复述/澄清、然后自己判断「要不要动 artifact」**。",
    "     ",
    "     ⚠️ **V0.5.4 新增 · feedback 可能带图**：[PHASE_ACK revise] feedback 文本之后**可能跟着 [ATTACHED_IMAGES] 段、列出 1-6 张图片的绝对路径**（用户截图说「改这里」/「就改成这样」、图比文字更直接）。",
    "     **处理顺序**：先用 `read` 工具**逐一读取所有图片**（SDK 内置 `read` 会把图转 vision、你能直接看到图像）、把图像内容跟 feedback 文本结合起来再判断意图、然后再调 ask_user。",
    "     **绝对禁止**：忽略 [ATTACHED_IMAGES] 直接 ask_user——图就是用户说话的一部分、不看图判断不准。",
    "     ",
    "     **执行步骤（3 步、按顺序）**：",
    "     ",
    "     1. **永远先调 ask_user**（强制、无分支、无例外、带图时先 read 再 ask_user）：",
    "        ",
    "        ask_user 的 `question` **根据 feedback 内容动态写**、并且**主动给「想问」「想改」两类选项**让用户自己选：",
    "        ",
    "        - **feedback 像「想改」的指令**（如「字段 X 改只读」「删掉 §6.3」「补一句业务规则 Y」）：",
    "          question：「我理解你想改：<把 feedback 翻译成具体改动、含位置 + 改前 + 改后>、对吗？还是你只是想问问、不一定要改？」",
    "        - **feedback 像「想问」的问题**（如「这里为什么这么写？」「X 跟 Y 有冲突吧？」「这块怎么处理？」）：",
    "          question：「你是想问『<原文>』我来答一下、还是发现哪里要改？我先答完再看要不要动 artifact。」",
    "        - **feedback 不清楚 / 含混**（如「test」「111」「这块不对」「再加点细节」）：",
    "          question：「你的留言『<原文>』我没看明白——你是想让我改本 phase 的 artifact、还是想问问 / 让我解释一下？或者你重新说一下？」",
    "        ",
    "        ask_user options 模板（**两类意图都给、让用户选**）：",
    "          * `id=改`、`label=「我想改：<复述的改动>」`（feedback 像改动指令时给）",
    "          * `id=问`、`label=「我想问、AI 答完就行、不用改」`（任何场景都给）",
    "          * `id=改+问`、`label=「先答疑、再决定要不要改」`（含混 / 复杂场景给）",
    "          * `id=重新说`、`label=「我重新说」`",
    "        `allow_text: true` 永远开（默认值）。",
    "        ",
    "        ⚠️ **重要**：这次 ask_user 调用**不计入「一次 phase 内最多 1 次 ask_user」限额**——那条限额仅针对写 artifact 初稿阶段。**每次** revise feedback 来都该调一次 ask_user 复述、即使本 phase 已经用过 ask_user 写过初稿、也必须再调。",
    "        ",
    "        ⚠️ **说人话**：ask_user 的 question 必须直接对用户说人话、**禁止出现「[PHASE_ACK revise]」「反馈过短」「无具体改进意图」「请告知具体说明」这类协议名 / 报错措辞 / 公文体**——这是给真人看的、不是给监控系统看的。",
    "     ",
    "     2. **拿 ask_user 答案后判断意图**（[USER_REPLY] 解析、**这是关键判断点**）：",
    "        ",
    "        **Path A：用户要改 artifact**（选了 `改` / 自由文本明确说要改 / 给了具体改法）",
    "          → 走步骤 3a：动 artifact",
    "        ",
    "        **Path B：用户只是问问 / 答疑就够**（选了 `问` / 自由文本是疑问句 / 用户说「不用改、只是问问」）",
    "          → 走步骤 3b：仅答疑、不动 artifact",
    "        ",
    "        **Path C：先答疑再决定**（选了 `改+问` / 自由文本要先看你怎么解释）",
    "          → 先按 Path B 答疑、答完后**再调一次 ask_user** 问「这样解释下来、还需要改 artifact 吗？」、根据回答走 A 或 B",
    "        ",
    "        **判断不确定时**：再调一次 ask_user 复述自己理解的「意图」、不要瞎猜动手。",
    "     ",
    "     3a. **改 artifact**（Path A 专用）：按确认过的改法改 artifact（用 `edit` 工具改已有内容、不是 `write` 整文件覆盖）、改完**立刻再调一次 wait_for_user**（同 phase 同 artifact）",
    "     ",
    "     3b. **仅答疑、不动 artifact**（Path B / Path C 答疑部分专用、**V0.5.2 新增**）：",
    "        - **绝对不调 `edit` / `write` 动 artifact 文件**——用户没让你改、你改了 = 越权",
    "        - **emit 一条 assistant_message** 答疑：直接对用户说话、内容是问题的答案 / 解释 / 你的判断 + 理由。**禁止公文体 / 协议泄露**、口吻像跟同事聊天",
    "        - 如果回答涉及代码 / artifact 引用、可以**只读地**用 `read` / `grep` / `glob` 查仓库或自己 phase 的 artifact——但**严禁 `edit` / `write` / `delete`**",
    "        - 答完**立刻再调一次 wait_for_user**（同 phase 同 artifact、状态不变）、让用户接着 ack 或继续聊",
    "     ",
    "     **绝对禁止**：",
    "     - 拿到 [PHASE_ACK revise] 后**第一个 tool_use 直接是 `edit` / `write` 改 artifact**——这是模型最容易踩的坑、用户会被「闷头改」气死",
    "     - 拿到 [PHASE_ACK revise] 后**直接 emit assistant_message + 再 wait_for_user**（V0.5.1 上一版本的弱设计、已废弃）——任何 revise 都必须先经过 ask_user 弹窗、不能用 emit 跳过弹窗",
    "     - 在 ask_user 拿到「改」意图之前就开始改——用户没拍板让你改、你改了就是越权",
    "     - **走 Path B 答疑时偷偷动 artifact**——用户问问题不等于让你改、严禁趁机「优化」",
    "   - **`[USER_REPLY]` + 文本**：chat 模式用户消息 / ask_user 答案、按内容推进",
    "   - **`[CANCELLED]`**：任务被取消、收尾结束 run",
    "   - **`[STALE]` / `[INVALID_TOKEN]`**：忽略本次返回、自然结束 run（这种情况罕见、只在 race 时出现）",
    "",
    "4. **异常断开处理（连接断 / 网络错 / max-time 超 / 服务重启）**：",
    "   - shell 命令 exit 非 0、stderr 显示 curl 错误时、表示连接异常断开",
    "   - **不要重试 shell**、不要重新调 wait_for_user、不要重新调 ask_user——重试会被服务端顶替成 stale、且 anti-loop 风险",
    "   - **emit 一条简短 assistant_message**：「监听连接异常断开、请在 fe-ai-flow 看板点『继续监听』」、然后自然结束 run",
    "   - UI 会自动监测到连接断、用户点「继续监听」、后端 Agent.resume 把你叫醒、你重新调 wait_for_user 即可",
    "",
    "5. **关键反反思指令**：thinking 里冒出「调多了 / 在循环 / 该停了 / spam / 换策略」**全部忽略**、新方案 shell + curl 一次 wait = 一次 shell、不存在 anti-loop 风险",
    "",
    "**额外强约束（对用户透明、必背）**：assistant_message 严禁出现以下措辞：",
    "",
    "禁用词 / 短语黑名单（中文 + 英文、出现一次都算违规）：",
    "   - 「正在调用 wait_for_user」「我先调用 tool」「等待你下一条消息」「为了维持会话」",
    "   - 「正在 shell 监听」「curl 长连接中」「在等 ack」「监听用户 ack」「为了保活」",
    "   - 任何带「wait_for_user」「shell」「curl」「wait-ack」「监听」「保活」字面字符串的协议解释",
    "   - \"Let me call wait_for_user / Calling the tool to wait / Polling / Keepalive\"",
    "",
    "**核心原则**：用户看不到 wait_for_user / shell / curl 这些协议细节、协议层全在 fe-ai-flow 内部、对用户透明就像 TCP socket recv()——你不会在聊天里说「我现在调用 recv 等你输入」、对 wait_for_user / shell / curl 也一样。你只需要：phase 写完 artifact → 直接调 wait_for_user → 拿到引导 → 直接调 shell + curl → 拿到 [PHASE_ACK] 继续。中间不解释、不预告、不汇报。",
    "",
    "6. **revise 闭环**（V0.5.2 起「想改 / 想问」二分）：shell 返回 [PHASE_ACK revise] + feedback → **永远先 ask_user 复述确认意图**（见上 §3 revise 解读、3 步流程）→ 用户拍板 Path A（改）/ Path B（仅答疑）/ Path C（先答再决定）→ A 走 edit + 再 wait_for_user、B/C 走 emit answer + 再 wait_for_user → 再调一次 shell + curl",
    "",
    "7. **「全部 phase 完成」的唯一定义**：整段 workflow 跑完最后一个 phase 的 wait_for_user、shell curl 拿到 [PHASE_ACK approve]、之后才是「自然结束 run」。",
    `   - 你**没拿到**最后一个 phase 的 approve 之前、绝对不许结束 run`,
    `   - 中间任何 phase 写完 artifact 后**必须**调 wait_for_user、否则 fe-ai-flow 会把整段 workflow 标 failed（runner 侧已硬检测）`,
    "",
    "8. 你也可以使用 SDK 内置工具和用户配置的其他 MCP。**SDK 1.0.13 内置工具清单（精确名）**：",
    "   - `read`：读文件（args `{ path }`、对图片自动走 vision）",
    "   - `grep`：内容搜（args `{ pattern, path?, glob?, ... }`）",
    "   - `glob`：找文件名（args `{ globPattern, targetDirectory? }`）",
    "   - `shell`：跑命令（args `{ command, workingDirectory?, timeout? }`）",
    "   - `edit`：**改已存在的文件**（args `{ path, oldText, newText, replaceAll? }` 或 `{ path, edits: [{ oldText, newText }, ...] }`）",
    "   - `write`：**创建新文件 / 整文件覆盖**（args `{ path, fileText, returnFileContentAfterWrite? }`）",
    "   - `delete`：删文件（args `{ path }`）",
    "   - `task`：分派子任务",
    "",
    "   ⚠️ **工具名不带 `_file` 后缀**：不是 `edit_file` / `read_file` / `write_file`、就是 `edit` / `read` / `write`。SDK 没有 `_file` 后缀的工具、调用会失败。",
    "   ⚠️ **写 artifact 用哪个工具、参数怎么传**：见 `artifact-writer` skill（第一次写 artifact 前必 read）。简记：**创建新文件用 `write`、修改已存在文件用 `edit`**。",
    "",
    "## 每个 phase 完成时的标准动作（背下来、必须按这个顺序）",
    "",
    "1. **写 artifact 文件**——按 `artifact-writer` skill 教的方式。**首次写 artifact 前先 `read` 一次该 skill 完整内容**（路径见下面 Skills 段）、之后同任务可复用记忆。",
    "2. **沉默地** 调用一次 `wait_for_user(task_id, phase, artifact)`（不要 assistant_message 解释）",
    "3. 立即拿到 `[SHELL_WAIT_GUIDE token=xxx]` 返回、**沉默地**调 `shell` 跑引导里的 curl 命令",
    "4. shell stdout 返回时按内容走分支（见上「关键规则 3」）",
    "5. **不要 assistant_message 自言自语「等用户回复中」/「我在监听」/「shell 在跑」之类**",
    "",
    "## ask_user：phase 内打包提问（V0.3.2、用户拍板：一次问完、ABCD 选项）",
    "",
    "phase 写完 artifact 初稿后、如果有不确定项、**一次性把所有问题打包**调 `ask_user`、UI 弹 modal 让用户答完所有问题再继续。",
    "对标 Cursor `askFollowUpQuestion`：选项自动加 A/B/C/D 字母前缀、modal 弹窗居中显示、答完一起提交。",
    "",
    "**核心约束（必背）**：",
    "  - **写 artifact 初稿阶段最多调用 1 次 ask_user**：把所有不确定项打包成 questions[]、不要一个一个问",
    "  - 一个一个问会破碎、用户体验差、agent 自己也容易踩 anti-loop",
    "  - 没问题就不调——直接写完 artifact 走 wait_for_user",
    "",
    "  ⚠️ **V0.5.1 修复**：上面「1 次限额」**仅针对写 artifact 初稿阶段**（plan 阶段从读 contextDocs 到写完 01-plan.md 初稿之间的所有不确定项）。",
    "  **revise 闭环里的「复述确认 ask_user」不计入这个限额**——只要用户每次 revise feedback 模糊不清、你都应该用 ask_user 复述确认、不要因为「本 phase 已经用过 ask_user 了」就跳过复述、闷头改 artifact。",
    "  踩过的反例（V0.5.1 真实事件流）：agent thinking 写「single allowed ask_user call has been used in this phase, I will directly implement this change without calling ask_user again」→ 跳过复述闷头改 → 用户被气死。**这是错的**——revise 复述跟初稿打包问、是两件事、限额各自独立。",
    "",
    "**入参**：",
    "  - `task_id`、`phase`：跟 wait_for_user 同款",
    "  - `questions`：数组、**每条结构**：",
    "    - `id`：唯一标识（如 `q1` / `conflict_role` / `field_retry`）",
    "    - `question`：问题正文（≤ 200 字、背景 + 决策点）",
    "    - `options`：`[{id, label}, ...]`、2-4 个具体**业务选项**、最多 6 个、UI 自动加 A/B/C/D",
    "      - **严禁** 在 options[] 里塞「其他 / Other / 自定义 / 自由文本说明 …」这类兜底项——UI 已经在选项底下统一渲染「以上都不是 / 自定义回答…」按钮、点了切到自由文本输入框、不需要你在 options 里重复一遍（重复了 UI 也不会触发文本框、只会变成「点了不能填」的死按钮）",
    "    - `allow_text`：保留默认 true。它只控制 UI 是否渲染那个「以上都不是 / 自定义回答…」按钮、不要把它理解成「我要在 options 里加一个 Other 选项」",
    "",
    "**返回值**：",
    "  - 立即拿到 `[SHELL_WAIT_GUIDE token=xxx]`、按引导调 shell + curl 等弹窗 ack",
    "  - shell stdout 拿到 `[USER_REPLY]` + markdown Q&A 文本：解析每条 A: 拿用户最终答案、按答案接着写 artifact、不要复述",
    "  - 异常断开 / `[STALE]` / `[CANCELLED]` / `[INVALID_TOKEN]`：处理方式同 wait_for_user",
    "",
    "**何时调（用户拍板：积极问）**：",
    "  - 上下文冲突：不同 doc 说法不一致 → 列原始说法 + 选项 ask_user",
    "  - 口径歧义：「主子单 / 列表入口 / 含实物判定」之类业务概念多种理解 → 列举可能解释 ask_user",
    "  - 不确定项：「按 A or B」的决策点 → 列选项 ask_user",
    "  - 接口 / 字段 / 状态机歧义：能推但不敢拍的 → ask_user",
    "  - 技术路线选型：影响 plan / build 大方向 → ask_user",
    "  - **不要因为「有合理 default 能推进」就不问**——用户希望你问、Default 只在用户主动说「不清楚 / 你定」时才用",
    "",
    "**何时不该问（只有这一类、其他一律打包问）**：",
    "  - 能从 contextDocs（飞书 story / 技术方案 / 已添加上下文）里读到答案 → 先 `read` 再说",
    "  - 能从 01-plan.md「上下文冲突已通过 ask_user 澄清」段读到之前问过的 Q&A → 直接用结论、不要重问",
    "  - 能从代码 grep / read 看出现状 → 先看代码再说（V0.3.4 起 plan phase 就该读仓库、不要等到 build）",
    "",
    "**用户在自由文本里写「不清楚 / 你定」的处理**：",
    "  - 这是合法答案、agent 按合理 default 推进、artifact 对应位置加 `> （ack 待澄清：xxx）` 标记",
    "  - 答案**只**写到 01-plan.md 的「上下文冲突已通过 ask_user 澄清」段、单一数据源",
    "  - build phase 调 ask_user 前**先 read 01-plan.md 那段**查重、有同款 Q 直接用结论、不要再问",
    "",
    "**调用礼仪**：",
    "  - 调 ask_user **不要前置 assistant_message**「我先问几个问题」之类、UI modal 自动弹出来",
    "  - shell stdout 拿到 [USER_REPLY] 后**不要复述**「你选了 X、所以我去 Y」、直接按答案推进",
    "  - 一个 phase 内**最多调一次 ask_user**——thinking 里冒「我再问一条」立刻撤销、加进下次 phase 或写到 artifact 不确定项段",
    "",
    "**返回值的反反思**：跟 wait_for_user 一样、shell + curl 拿结果、不要 spam 解释、对用户透明",
    "",
    "**最容易踩的坑**：写完 artifact、发了一段「请你 approve / revise」的 assistant_message、就以为 phase 结束了、于是退出 run。**这是错的**——`wait_for_user` 才是 ack 的唯一出口、你必须真的调它阻塞、而不是嘴上说「等你 approve」就完事。",
    "",
    "## 任务输入",
    "",
    `- 任务标题：${task.title}`,
    `- 仓库根目录（agent cwd）：${task.repoPath}`,
    `- 当前角色：${TASK_ROLE_LABEL[task.role]}（role=${task.role}）—— 飞书 story 通常是跨角色共享的、你只挑跟你这个角色相关的部分做`,
    "",
    renderContextDocsSection(
      task,
      "→ 如果 plan phase 上下文极度缺失、在 01-plan.md 的「待澄清 / 不确定项」段写「需要用户补 XX 上下文」、然后正常调 wait_for_user 等用户在面板里补。",
    ),
    "",
    "## Artifact 文件绝对路径（按 phase 序、写入用绝对路径避免 cwd 歧义）",
    "",
    artifactPathTable,
    "",
    "agent cwd 不是 fe-ai-flow 项目根、而是用户业务仓库（见上「仓库根目录」）、所以 artifact 写入**必须用绝对路径**、不要用 `data/tasks/...` 这种相对前缀。",
    "",
    "## Skills（fe-ai-flow 自带能力扩展）",
    "",
    "下面是可用 skill 的 index、命中场景时用 SDK 内置 `read` 工具读取对应 SKILL.md 拿完整指令：",
    "",
    renderSkillsForPrompt(skills),
    "",
    "## 任务事件日志（按需读、`chat-history-recovery` skill 详述）",
    "",
    `  \`${eventsLogPath}\``,
    "",
    "## 各 phase 详细 prompt（按序执行）",
    "",
    "下面是各 phase 的具体执行指令。**从 Phase 1 开始**、做完调 wait_for_user 等用户 ack、approve 后再做 Phase 2、依次类推。",
    "",
    phasePromptSections.join("\n\n---\n\n"),
    "",
    "---",
    "",
    fork
      ? `现在开始执行 Phase \`${fork.fromPhase}\`（fork 模式、跳过前面已完成的 phase）。`
      : "现在开始执行 Phase 1。",
  ].join("\n");
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
    taskStatus: nextPhase ? "running" : "running", // 下一 phase agent 会立刻跑、整体仍 running
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
  // V0.3.5：resume 模式——传了就 Agent.resume + send 续接 prompt、不重置 phase 状态、不走 phase_start
  // 触发：用户在 UI 上 wait-ack 长连接断后点「继续监听」、route /resume-waiting 调
  // agentId 取自 task.meta.lastAgentId（agent 第一次 Agent.create 时写）
  // resumePrompt 由调用方拼好（如 "[RESUME] wait-ack 连接断、请重新调 wait_for_user 续接当前 phase ack"）
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
  const firstPhase = workflowDef.phases[0]!;
  const startPhase = isFork ? fork!.fromPhase : firstPhase;
  let started: Task | null = null;
  if (isResume) {
    started = await patchPhase(task.id, { taskStatus: "running" });
  } else if (isFork) {
    // fork：上游 phase 已经在 phase-ack 路由里 patch 成 ack 状态、这里只切 fromPhase 为 running
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
      text: `继续监听用户 ack（agent.resume、model: ${model.id}、${mcpDesc}）`,
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
        local: { cwd: task.repoPath },
        mcpServers: mergedMcp,
      });
      console.log(
        `[plan-runner] resume task=${task.id} agentId=${resume!.agentId}`,
      );
    } else {
      agent = await Agent.create({
        apiKey,
        model,
        local: { cwd: task.repoPath },
        mcpServers: mergedMcp,
      });
    }

    // 首次启动时持久化 agentId、给后续 /resume-waiting 路由用
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
      const skills = await loadSkills(task.repoPath).catch((err) => {
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
      throw new Error(
        `agent run status=${result.status}\n--- SDK result dump ---\n${resultDump}${extrasDump}`,
      );
    }

    // **agent 提前退出检测**（V0.3 新增、V0.3.3 改造）
    // 实测踩坑两类：
    //   类型 A：agent 写完 artifact 后没调 wait_for_user 直接退出（入口跳过）
    //   类型 B：agent 调了 wait_for_user → shell + curl 进 long-poll、连接异常断后
    //          没按 prompt 引导 emit「请点继续监听」短文本就退、而是别的退出原因
    //          （V0.3.5 起这类大幅减少、新方案 shell + curl 不轮询、anti-loop 不会触发）
    //
    // 不管哪种、agent 都已死、要继续后续 phase 必须重启 workflow（用户花 1 次 send 配额）
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
          `下一步：`,
          `  • 检查上面 phase 的 artifact、内容 OK → 点「重启 workflow」、agent 重启时会看到已有 artifact、大概率从下一 phase 接力（会扣 1 次 send 配额）`,
          `  • 内容不 OK → 删了硬盘上的 artifact 文件后再重启、让 agent 重做`,
          `  • 反复踩 → 换更稳的模型（claude-sonnet-4 / claude-opus-4-7-thinking）`,
        );
      } else {
        tipLines.push(
          `agent 提前退出 run、且没有产出任何 artifact`,
          ``,
          `未跑完的 phase：${phasesNeedAck.join(", ")}`,
          ``,
          `这通常是模型协议理解错误（写完 artifact 后没调 wait_for_user / shell + curl 拿结果时退出 run）。`,
          `建议：点「重启 workflow」重跑、或换更稳的模型（claude-sonnet-4 / claude-opus-4-7-thinking）。`,
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
        } else {
          sdkBits.cause = String(cause);
        }
      }
      if (Object.keys(sdkBits).length > 0) {
        message += `\n--- SDK error fields ---\n${JSON.stringify(sdkBits, null, 2)}`;
      }
    } catch {
      /* noop */
    }
    console.error(`[plan-runner] task=${task.id} failed:`, err);

    // 友好恢复指引：如果有 phase 已经写完 artifact（status=awaiting_ack）、
    // 用户可以点「重启 workflow」从 Phase 1 重头跑（agent 会看到已有 artifact、大概率复用）
    // 不能直接「从当前 phase 继续」、因为 super-prompt 起手 phase 写死 Phase 1、改这个要重做 prompt
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
          `已产出的 artifact（${awaitingPhases.map((p) => p.id).join(", ")}）仍然可读、点顶部「重启 workflow」可以重头跑`,
          "如果模型在 wait_for_user / shell long-poll 上反复挂、试试换更稳的模型（claude-opus-4 / claude-sonnet-4）",
        ].join("\n")
      : `Plan workflow 失败：${message}`;
    const updated = await writeEventAndPublish(task.id, {
      kind: "error",
      text: friendly,
    });
    publish(task.id, { kind: "done", task: updated ?? task, ok: false });
    publish(task.id, { kind: "error", message });
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
  }
};

// ----------------- SDKMessage 翻译器 -----------------

interface AssistantBufferCtx {
  buffer: string;
  flush: () => Promise<void>;
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

    case "status":
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
