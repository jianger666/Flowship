/**
 * Plan workflow runner（V0.2）
 *
 * V0.2 重定义：plan 任务 = 4 phase workflow（context → plan → build → ship）
 * V0.3.3 改为 3 phase（移除 ship）
 * V0.3.4 改为 2 phase（context 并入 plan、plan 自己读上下文 + 扫仓库 + 出方案）
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
 * Phase 边界 / 状态机（V0.3.4 起 2 phase: plan → build）：
 *   1. start：plan phase 开始、status=running、currentPhase=plan
 *   2. agent 跑 plan（读 contextDocs + 拉飞书 + 扫仓库 + 出方案）、写 01-plan.md、
 *      调 wait_for_user(phase=plan, artifact=...)
 *      → notifier 触发：patch phases.plan.status=awaiting_ack、taskStatus=awaiting_user
 *   3. 用户在 UI 看 artifact、点「通过」→ submitPhaseAck(approve)
 *      → agent 拿到 [PHASE_ACK approve]、进 build phase
 *      → 本文件**不需要主动 patch**：agent 下一次调 wait_for_user(phase=build) 时
 *        notifier 自动 patch 上一 phase=ack + 当前 phase=awaiting_ack
 *        （但实际上 "上一 phase=ack" 需要本文件在 ack 时单独处理、见 markPhaseAcked）
 *   4. 用户点「跟 AI 再聊聊」→ submitPhaseAck(revise, feedback)
 *      → agent 拿 [PHASE_ACK revise]、修 artifact、再调 wait_for_user
 *      → 任务状态保持 awaiting_user（按用户拍板：不抖屏）、artifact 内容更新即可
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
import {
  loadSkills,
  renderSkillsForPrompt,
  type SkillEntry,
} from "./skills-loader";
import type {
  PhaseId,
  Task,
  TaskContextDoc,
  TaskEvent,
  WorkflowDef,
} from "@/lib/types";
import { TASK_ROLE_LABEL, WORKFLOWS } from "@/lib/types";

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
const PHASE_PROMPT_FILE: Record<PhaseId, string> = {
  plan: "phase-1-plan.md",
  build: "phase-2-build.md",
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
  const attachedDocs =
    (task.attachedDocs ?? []).length > 0
      ? task.attachedDocs!.map((p, i) => `  ${i + 1}. ${p}`).join("\n")
      : "（无）";
  // phase 自身的 artifact 绝对路径（agent 写入用、避免相对路径 cwd 歧义）
  const artifactPath = getPhaseArtifactPath(task.id, phaseId, phaseIdx);
  // 上一 phase 的 artifact（给 Phase 2/3/4 读上游）
  // Phase 1 没有上游、塞「（未提供）」
  const prevArtifactPath =
    phaseIdx > 0
      ? getPhaseArtifactPath(
          task.id,
          workflowDef.phases[phaseIdx - 1]!,
          phaseIdx - 1,
        )
      : undefined;
  // V0.3.4 删除 contextArtifactPath：原本给 phase 3+ 读 phase 1 的 context artifact、
  // 现在 context 已合进 plan、plan 自己就是上游、用 prevArtifactPath 就够
  // V0.4：注入 role / roleLabel、phase prompt 按 role 调整视角
  return fillTemplate(tpl, {
    taskId: task.id,
    taskTitle: task.title,
    title: task.title,
    repoPath: task.repoPath,
    feishuStoryUrl: task.feishuStoryUrl,
    feishuUrl: task.feishuUrl ?? task.feishuStoryUrl,
    swaggerUrl: task.swaggerUrl,
    description: task.description,
    attachedDocs,
    artifactPath,
    artifactsDir: getArtifactsDir(task.id),
    prevArtifactPath,
    role: task.role,
    roleLabel: TASK_ROLE_LABEL[task.role],
  });
};

// ----------------- 上下文文档清单（V0.3） -----------------
//
// V0.3 设计：只 inject「数据」（清单本身）、规则都搬到 skill `context-docs-handler`。
//   - 命中 skill 触发条件 → agent 自己 read SKILL.md 拿规则
//   - super-prompt 末尾仍然给一行明确指引、防止 agent 不主动 read
//
// 对 text 类型仍然「短文本默认全 inject、长文本截断」——
// 这是「数据呈现规则」（信息保真要求）、不是「处理规则」、所以留在这里。
// 长 text 截断标记的语义解释 / 怎么处理截断、是 skill 的事。

const TEXT_INLINE_INJECT_MAX = 1000;

// text 类型 inject 规则
const renderContextDocBody = (doc: TaskContextDoc): string => {
  if (doc.type !== "text") {
    return `   ${doc.content.trim()}`;
  }
  const t = doc.content.trim();
  if (t.length <= TEXT_INLINE_INJECT_MAX) {
    return t
      .split("\n")
      .map((line) => `   ${line}`)
      .join("\n");
  }
  const head = t.slice(0, TEXT_INLINE_INJECT_MAX);
  return [
    ...head.split("\n").map((line) => `   ${line}`),
    `   …（**已截断、原文共 ${t.length} 字、超过 ${TEXT_INLINE_INJECT_MAX} 字上限**）`,
  ].join("\n");
};

const renderContextDocsSection = (task: Task): string => {
  const docs = task.contextDocs ?? [];
  if (docs.length === 0) {
    return [
      "## 用户提供的上下文文档（0 份）",
      "",
      "用户目前没有提供任何上下文文档。",
      "",
      "→ 如果 plan phase 上下文极度缺失、在 01-plan.md 的「待澄清 / 不确定项」段写「需要用户补 XX 上下文」、然后正常调 wait_for_user 等用户在面板里补。",
    ].join("\n");
  }
  const items = docs.map((doc, i) => {
    const idx = i + 1;
    const titleLine =
      doc.type === "text"
        ? `${idx}. **【${doc.title}】**（text、${doc.content.trim().length} 字）`
        : `${idx}. **【${doc.title}】**（${doc.type}）`;
    return [titleLine, renderContextDocBody(doc)].join("\n");
  });
  return [
    `## 用户提供的上下文文档（${docs.length} 份）`,
    "",
    items.join("\n\n"),
    "",
    "→ **不确定怎么拉 / 怎么处理 doc 间冲突 / text 截断标记是什么意思**、read skill `context-docs-handler`",
  ].join("\n");
};

// ----------------- 起手 super-prompt -----------------

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

  return [
    "你正在 fe-ai-flow 的 plan 任务里跑、走 workflow：",
    `**${workflowDef.displayName}**（${workflowDef.description}）`,
    "",
    "整段任务被设计为同一个 SDK Run（计费一次跑到底）、按 phase 顺序执行、phase 间用 `wait_for_user` 工具阻塞等用户 ack。",
    "",
    "## Phase 列表（按序执行）",
    "",
    workflowDef.phases
      .map((p, i) => `  ${i + 1}. \`${p}\``)
      .join("\n"),
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
    "  - `[PHASE_ACK revise]` + 后续 feedback：用户「补意见再跑」、按 feedback 改 artifact 后再调一次 wait_for_user",
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
    "   - **`[PHASE_ACK revise]` + feedback**：用户要求修改、按 feedback 改 artifact、然后**立刻再调一次 wait_for_user**（同 phase）",
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
    "6. **revise 闭环**：shell 返回 [PHASE_ACK revise] + feedback → 按意见改 artifact → 再调一次 wait_for_user（同 phase 同 artifact）→ 再调一次 shell + curl",
    "",
    "7. **「全部 phase 完成」的唯一定义**：整段 workflow 跑完最后一个 phase 的 wait_for_user、shell curl 拿到 [PHASE_ACK approve]、之后才是「自然结束 run」。",
    `   - 你**没拿到**最后一个 phase 的 approve 之前、绝对不许结束 run`,
    `   - 中间任何 phase 写完 artifact 后**必须**调 wait_for_user、否则 fe-ai-flow 会把整段 workflow 标 failed（runner 侧已硬检测）`,
    "",
    "8. 你也可以使用 SDK 内置工具（read_file / grep / glob / shell / edit_file）和用户配置的其他 MCP",
    "",
    "## 每个 phase 完成时的标准动作（背下来、必须按这个顺序）",
    "",
    "1. 用 `edit_file` 把 artifact 写到对应绝对路径（见下面 artifact 表）",
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
    "  - **一次 phase 内最多调用 1 次 ask_user**：把所有不确定项打包成 questions[]、不要一个一个问",
    "  - 一个一个问会破碎、用户体验差、agent 自己也容易踩 anti-loop",
    "  - 没问题就不调——直接写完 artifact 走 wait_for_user",
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
    "  - 能从 contextDocs（飞书 story / 技术方案 / 已添加上下文）里读到答案 → 先 `read_file` 再说",
    "  - 能从 01-plan.md「上下文冲突已通过 ask_user 澄清」段读到之前问过的 Q&A → 直接用结论、不要重问",
    "  - 能从代码 grep / read_file 看出现状 → 先看代码再说（V0.3.4 起 plan phase 就该读仓库、不要等到 build）",
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
    renderContextDocsSection(task),
    "",
    "## Artifact 文件绝对路径（按 phase 序、写入用绝对路径避免 cwd 歧义）",
    "",
    artifactPathTable,
    "",
    "agent cwd 不是 fe-ai-flow 项目根、而是用户业务仓库（见上「仓库根目录」）、所以 artifact 写入**必须用绝对路径**、不要用 `data/tasks/...` 这种相对前缀。",
    "",
    "## Skills（fe-ai-flow 自带能力扩展）",
    "",
    "下面是可用 skill 的 index、命中场景时用 SDK 内置 `read_file` 读取对应 SKILL.md 拿完整指令：",
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
    "现在开始执行 Phase 1。",
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
}

const PLAN_RUNNER_GLOBAL_KEY = "__feAiFlowPlanRunnerState__";

const getRunnerState = (): PlanRunnerGlobalState => {
  const g = globalThis as unknown as Record<string, PlanRunnerGlobalState>;
  if (!g[PLAN_RUNNER_GLOBAL_KEY]) {
    g[PLAN_RUNNER_GLOBAL_KEY] = {
      runningPlans: new Map(),
    };
  }
  return g[PLAN_RUNNER_GLOBAL_KEY];
};

const runningPlans = getRunnerState().runningPlans;

export const isPlanRunning = (taskId: string): boolean =>
  runningPlans.has(taskId);

export const cancelPlan = (taskId: string): boolean => {
  const rec = runningPlans.get(taskId);
  if (!rec) return false;
  rec.cancel();
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
  const idx = rec.workflowDef.phases.indexOf(phaseId);
  const nextPhase =
    idx >= 0 && idx + 1 < rec.workflowDef.phases.length
      ? rec.workflowDef.phases[idx + 1]!
      : null;
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
  const { task, apiKey, model, userMcpServers, resume } = input;
  const isResume = !!resume;

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
  const firstPhase = workflowDef.phases[0]!;
  const started = isResume
    ? await patchPhase(task.id, { taskStatus: "running" })
    : await patchPhase(task.id, {
        phaseId: firstPhase,
        status: "running",
        currentPhase: firstPhase,
        taskStatus: "running",
      });
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
  if (isResume) {
    await writeEventAndPublish(task.id, {
      kind: "info",
      phase: (task.currentPhase as PhaseId) ?? firstPhase,
      text: `继续监听用户 ack（agent.resume、model: ${model.id}、${mcpDesc}）`,
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
      agent = await Agent.resume(resume!.agentId, {
        apiKey,
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
      const superPrompt = await buildSuperPrompt(task, workflowDef, skills);
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
      currentPhase: firstPhase,
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

      // edit_file / write_file 调用时如果路径形如 artifacts/01-plan.md、把 artifact 内容也推一份给 SSE
      // 不严格依赖工具名（不同 SDK 版本可能叫 edit_file / write_file / Edit）
      // 通过 args.target_file 模式识别（agent 跑约定的路径时才推）
      if (msg.status === "running") {
        const possibleTarget =
          (argsAny.target_file as string | undefined) ??
          (argsAny.file_path as string | undefined) ??
          (argsAny.path as string | undefined);
        if (
          possibleTarget &&
          typeof possibleTarget === "string" &&
          possibleTarget.includes("artifacts/")
        ) {
          // artifact 写入由 agent 自己负责（agent 用 SDK 工具写到 task workdir）
          // 这里只记一条事件、不重复写文件
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
