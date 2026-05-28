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
  appendEvent,
  getActionArtifactPath,
  getActionsDir,
  getEventsLogPath,
  getTask,
  patchAction,
  setGitBranch,
  setTaskLastAgentId,
  setTaskRepoStatus,
  setTaskRunStatus,
  snapshotActionArtifact,
} from "./task-fs";
import { runActionCheck } from "./action-checks";
import {
  cancelPending,
  getChatMcpUrl,
  setChatAwaitingNotifier,
  submitActionAck,
  submitNextAction,
  submitTaskTerminate,
} from "./chat-mcp";
import { renderContextDocsSection } from "./context-docs-prompt";
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
  ActionRecord,
  ActionType,
  GitBranchInfo,
  RepoStatus,
  Task,
  TaskEvent,
} from "@/lib/types";
import {
  ACTION_LABEL,
  TASK_ROLE_LABEL,
} from "@/lib/types";

// ----------------- 配置 -----------------

// task 不主动超时（用户随时可能 24h 后才 ack）
const TASK_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// chat-mcp 在 Agent.mcpServers 里的注册名（agent prompt 里得点明、跟 V0.5 沿用）
const TASK_TOOL_MCP_NAME = "feAiFlowChat";

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

// V0.6.0 范围内允许的 action 类型（advanceTask 准入门槛 1）
// ship / test / learn 在 V0.6.1+ 上线、当前拒绝
const ACTION_AVAILABLE_IN_V060: ReadonlySet<ActionType> = new Set([
  "plan",
  "build",
  "review",
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
  });
};

// ----------------- super-prompt 拼装 -----------------

/**
 * V0.6：一次性把 6 种 action 的 prompt 全部注入到 _super.md、
 * agent 在 [NEXT_ACTION type=X] 时翻到对应段执行。
 *
 * 不动态注入是因为：
 *   - SDK Run 永生、agent 起 Run 时一次性拿全部蓝图、不需要中途扩 context
 *   - 全量 prompt ≈ 15-20K tokens、远小于 200K 模型上下文
 *   - 中途新增 prompt 段会产生「context 不一致」风险（同一 Run 内规则换了一次）
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
  },
): Promise<string> => {
  const template = await loadFileSafe(SUPER_PROMPT_FILE);
  const sharedRules = await loadSharedPrompt(task);

  // 加载 6 种 action 的 prompt（plan / build / review / ship / test / learn）
  const actionPromptVars: Record<string, string> = {};
  for (const t of Object.keys(ACTION_PROMPT_FILE) as ActionType[]) {
    actionPromptVars[`action_${t}_prompt`] = await loadActionPrompt(t, task);
  }

  // 当前已存在的 action history（agent 起 Run 时能看到之前的工作）
  const actionHistorySection = renderActionHistorySection(task);

  // 第一个 [NEXT_ACTION ...] 指令（含用户指令、附件、branch checkout hint）
  const firstActionDirective = buildNextActionDirective(firstNextAction);

  return renderSuperPromptTemplate(template, {
    taskId: task.id,
    taskTitle: task.title,
    repoSection: formatRepoSectionForPrompt(task.repoPaths),
    repoPath: getEffectiveCwd(task.repoPaths),
    roleLabel: TASK_ROLE_LABEL[task.role],
    role: task.role,
    contextDocsSection: renderContextDocsSection(
      task,
      "→ 没有上下文文档时、按 action 内容判断要不要主动调 MCP / read / grep 摸资料。",
    ),
    skillsSection: renderSkillsForPrompt(skills),
    eventsLogPath: getEventsLogPath(task.id),
    actionArtifactsDir: getActionsDir(task.id),
    sharedRules,
    actionHistorySection,
    firstActionDirective,
    ...actionPromptVars,
  });
};

// 起 Run 时把已有 action history 一并 inject、agent 知道之前做过啥
// 首次启动 task（actions 只有刚 append 的那一条）时返回「无历史」段
const renderActionHistorySection = (task: Task): string => {
  if (task.actions.length <= 1) {
    return "（这是 task 的第一个 action、无历史）";
  }
  const lines: string[] = ["以下是已完成 / 进行中的历史 action（按时间正序）："];
  for (const a of task.actions) {
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
  for (const a of task.actions) {
    if (!a.artifactPath) continue;
    lines.push(`  - \`${getActionArtifactPath(task.id, a.n, a.type)}\``);
  }
  return lines.join("\n");
};

// 构造一个 [NEXT_ACTION ...] 头部 + 用户指令 + 附件段 + branch checkout hint
const buildNextActionDirective = (input: {
  action: ActionRecord;
  userInstruction: string;
  attachedImagePaths?: string[];
  attachedFilePaths?: string[];
  branchCheckoutHint?: string;
}): string => {
  const { action, userInstruction, attachedImagePaths, attachedFilePaths, branchCheckoutHint } =
    input;
  const head =
    `[NEXT_ACTION action_id=${action.id} type=${action.type} n=${action.n}` +
    (action.artifactPath ? ` artifact_path=${action.artifactPath}` : "") +
    "]";
  const lines: string[] = [head, ""];
  if (userInstruction.trim().length > 0) {
    lines.push(userInstruction.trim(), "");
  } else {
    lines.push("（用户没填具体指令、按本 action 标准流程执行）", "");
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
  cancel: () => void;
  completion: Promise<void>;
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
      `[task-runner] writeEventAndPublish 失败 task=${taskId} kind=${ev.kind}：`,
      err,
    );
    return null;
  }
};

// ----------------- 公开 query API -----------------

export const isTaskRunning = (taskId: string): boolean =>
  runningTasks.has(taskId);

export const markTaskForFork = (taskId: string): void => {
  forkPendingTasks.add(taskId);
};

export const cancelTaskRun = (taskId: string): boolean => {
  const rec = runningTasks.get(taskId);
  if (!rec) return false;
  rec.cancel();
  return true;
};

export const waitForTaskToStop = async (
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
export const forceClearStaleRunnerState = (taskId: string): void => {
  runningTasks.delete(taskId);
  forkPendingTasks.delete(taskId);
};

// ----------------- 准入门槛 1：action 类型 + 上游 action 依赖 -----------------

const checkActionPrerequisites = (
  task: Task,
  actionType: ActionType,
): { ok: true } | { ok: false; reason: string } => {
  if (!ACTION_AVAILABLE_IN_V060.has(actionType)) {
    return {
      ok: false,
      reason: `action 类型「${ACTION_LABEL[actionType]}」在 V0.6.0 阶段未实现、当前仅支持 plan / build / review。等 V0.6.1+ 上线后再用。`,
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
      if (!lastCompletedOfType("plan")) {
        return {
          ok: false,
          reason: "build 前需要至少 1 个已 approve 的 plan action。先推进 plan、再进 build。",
        };
      }
      return { ok: true };
    case "review":
      if (!lastCompletedOfType("build")) {
        return {
          ok: false,
          reason: "review 前需要至少 1 个已 approve 的 build action。先推进 build、再进 review。",
        };
      }
      return { ok: true };
    case "learn":
      if (task.repoStatus !== "merged") {
        return {
          ok: false,
          reason: "learn 只在 task 已 merged 后跳一次。当前 task 还没 merged。",
        };
      }
      if (task.actions.some((a) => a.type === "learn")) {
        return {
          ok: false,
          reason: "本 task 已经跑过 learn action、整 task 内只能跑一次。",
        };
      }
      return { ok: true };
    case "ship":
    case "test":
      // V0.6.0 已被上面 ACTION_AVAILABLE_IN_V060 拦掉、走不到这里
      return { ok: false, reason: "V0.6.0 未实现" };
    default: {
      const _: never = actionType;
      return { ok: false, reason: `未知 action 类型：${_}` };
    }
  }
};

// ----------------- branch checkout 挂接（build action 第一次跑前）-----------------

/**
 * V0.6：build action 第一次跑前、拼 GitBranchInfo + 引导 agent checkout
 *
 * branch 命名规则（V0.6 拍板）：
 *   `feature/<username>/<飞书 story id>-<task.title 转换后>`
 *   - username 取自 settings.username
 *   - 飞书 story id 从 task.feishuStoryUrl 抠 URL 末段数字（如 detail/6956910305）
 *   - task.title 转换：保留中文、空白/特殊字符替换为 -
 *
 * base branch 探测交给 agent：runner 不再要用户填 mainBranch、agent shell 现场跑
 *   `git symbolic-ref refs/remotes/origin/HEAD`（克隆时自动设的）或
 *   `git remote show origin | grep "HEAD branch"`（远端权威值、兼容补救）
 *
 * 返回 null：缺 username 或 feishuStoryUrl、不建 branch
 */
const planBranchForBuild = (
  task: Task,
  username: string | undefined,
): { info: GitBranchInfo; promptHint: string } | null => {
  if (!username || username.trim().length === 0) {
    return null;
  }
  if (!task.feishuStoryUrl || task.feishuStoryUrl.trim().length === 0) {
    return null;
  }

  // 飞书 story id：URL 里 detail/<digits> 这段、最长一段连续数字兜底
  const m = task.feishuStoryUrl.match(/detail\/(\d+)/) ??
    task.feishuStoryUrl.match(/(\d{6,})/);
  const storyId = m ? m[1] : null;
  if (!storyId) {
    return null;
  }

  // title 转 branch-safe：保留中文 + 字母数字、其他换 -
  const titleSafe = task.title
    .trim()
    .replace(/[\s\\/:*?"<>|【】（）()\[\]{}]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const branchName = `feature/${username.trim()}/${storyId}-${titleSafe}`;

  const info: GitBranchInfo = {
    name: branchName,
    baseBranch: "",
    checkedOut: false,
    createdAt: Date.now(),
  };

  const promptHint = [
    "## 准入：build 第一次跑、先建 + checkout 分支",
    "",
    `本 task 没建过分支、runner 拼好的 branch name：\`${branchName}\``,
    "",
    "**第一动作**：调 `shell` 工具、按下面 2 步跑（探主分支 → 基于它建 feature 分支）：",
    "",
    "```bash",
    "# 1) 探主分支名（master / main / develop 都可能、用户不再手动配）",
    "BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')",
    'if [ -z "$BASE" ]; then',
    "  # origin/HEAD 没设、用 git remote show 拿远端权威值",
    "  BASE=$(git remote show origin 2>/dev/null | sed -n '/HEAD branch:/s/.*: //p')",
    "fi",
    'if [ -z "$BASE" ]; then',
    '  echo "[error] 探不到主分支、放弃 checkout、稍后回报用户"',
    "  exit 1",
    "fi",
    "",
    "# 2) 基于主分支建 feature 分支",
    `git fetch origin "$BASE" && git checkout -b "${branchName}" "origin/$BASE"`,
    "```",
    "",
    "checkout 成功后、再按下面 build action 标准流程做实施。",
    "checkout 失败（如分支已存在 / 工作区脏 / 不是 git 仓库 / 探不到主分支）→ emit 一段简短 assistant_message 告知用户问题、然后调 wait_for_user 等用户处理（**不要**自己 force / reset 操作硬盘）。",
  ].join("\n");

  return { info, promptHint };
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
 *  - userMcpServers 已按 task.disabledMcpServers 过滤
 */
export interface AdvanceTaskInput {
  task: Task;
  actionType: ActionType;
  userInstruction: string;
  attachedImagePaths?: string[];
  attachedFilePaths?: string[];
  apiKey: string;
  model: ModelSelection;
  // 用户配置的 MCP servers（已解析 + 过滤）
  // chat-tool 是 runner 自己塞、不需要调用方传
  userMcpServers?: Record<string, McpServerConfig>;
  // 强制起新 Agent（不复用 lastAgentId）；UI「换新 agent」时为 true
  forceNewAgent?: boolean;
  // 设置页 username（拼 build branch 名用、缺省时不建 branch）
  username?: string;
}

export const advanceTask = async (
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
    userMcpServers,
    forceNewAgent,
    username,
  } = input;

  // 1) 准入条件（V0.6 门槛 1）
  const pre = checkActionPrerequisites(task, actionType);
  if (!pre.ok) {
    throw new Error(`准入条件不满足：${pre.reason}`);
  }

  // 2) appendAction：写一条新 ActionRecord、task.runStatus 自动转 running
  const created = await appendAction(task.id, {
    type: actionType,
    userInstruction,
    agentModel: model,
  });
  if (!created) {
    throw new Error(`appendAction 失败 task=${task.id}（task 不存在）`);
  }
  const { task: taskAfterAppend, action } = created;
  publish(task.id, { kind: "task", task: taskAfterAppend });
  publish(task.id, { kind: "action", action });
  await writeEventAndPublish(task.id, {
    kind: "action_start",
    actionId: action.id,
    text: `开始 ${ACTION_LABEL[actionType]}（${action.type}）n=${action.n}${
      userInstruction.trim().length > 0 ? `\n用户指令：${truncate(userInstruction, 200)}` : ""
    }`,
    meta: { type: actionType, n: action.n, artifactPath: action.artifactPath },
  });

  // 3) branch checkout 挂接（仅 build action、且 task 还没建过 branch）
  let branchCheckoutHint: string | undefined;
  if (actionType === "build" && !taskAfterAppend.gitBranch?.checkedOut) {
    const planned = planBranchForBuild(taskAfterAppend, username);
    if (planned) {
      // 落库 GitBranchInfo（checkedOut=false、agent 跑完 git checkout 后由路由层标 checkedOut=true）
      await setGitBranch(task.id, planned.info);
      branchCheckoutHint = planned.promptHint;
    }
  }

  // 4) 决定路由
  const existingRecord = runningTasks.get(task.id);
  if (existingRecord && !forceNewAgent) {
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
        userMcpServers,
        forceNewAgent: true,
      });
    }
    return { action };
  }

  // 5) 没活 agent / forceNewAgent：起新 Run
  if (existingRecord && forceNewAgent) {
    forkPendingTasks.add(task.id);
    existingRecord.cancel();
    const stopped = await waitForTaskToStop(task.id, 5000);
    if (!stopped) {
      console.warn(
        `[task-runner] advanceTask: task=${task.id} 旧 agent 没在 5s 内停、强清 runner state 继续`,
      );
      forceClearStaleRunnerState(task.id);
    }
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
    userMcpServers,
    forceNewAgent: !!forceNewAgent,
  });

  return { action };
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
  if (action.status === "completed" || action.status === "cancelled") {
    throw new Error(`action ${actionId} 状态 ${action.status}、不能 ack`);
  }

  if (decision === "revise" && action.artifactPath) {
    await snapshotActionArtifact(taskId, actionId).catch((err) => {
      console.warn(
        `[task-runner] snapshotActionArtifact 失败 task=${taskId} action=${actionId}（吞错继续）：`,
        err,
      );
    });
  }

  const ok = submitActionAck(taskId, decision, feedback, imagePaths);
  if (!ok) {
    throw new Error(
      "没有 pending wait_for_user 等 ack（agent 可能已退出、点「推进」起新 agent 再试）",
    );
  }

  // V0.6：approve 时 action 标 completed、revise 时保持 running
  const patched = await patchAction(taskId, actionId, {
    status: decision === "approve" ? "completed" : "running",
  });
  if (patched) {
    publish(taskId, { kind: "task", task: patched });
    const newAction = patched.actions.find((a) => a.id === actionId);
    if (newAction) publish(taskId, { kind: "action", action: newAction });
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
 *   V0.6.3+ 此时会推荐 learn action（runner 准入仍允许）；V0.6.0 不实现 learn
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
    // agent 已经退出 / 没在等、不算错——直接 patch 业务状态收尾
    console.log(
      `[task-runner] finalizeTask: task=${taskId} 没活 agent pending、直接 patch repoStatus=${finalStatus}`,
    );
  }

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
  userMcpServers?: Record<string, McpServerConfig>;
  forceNewAgent: boolean;
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
    userMcpServers,
  } = input;

  // 已有活 entry 时不重启（advanceTask 入口已处理 forceNewAgent 时的 cancel）
  if (runningTasks.has(task.id)) {
    console.warn(
      `[task-runner] internalStartAgent: task=${task.id} 已有 running entry、跳过（幂等）`,
    );
    return;
  }

  // 1) merge MCP：用户的 + chat-tool（我们自己的 wait_for_user / ask_user）
  const mergedMcp: Record<string, McpServerConfig> = {
    ...(userMcpServers ?? {}),
    [TASK_TOOL_MCP_NAME]: {
      type: "http",
      url: getChatMcpUrl(),
    },
  };
  const userMcpNames = Object.keys(userMcpServers ?? {}).filter(
    (n) => n !== TASK_TOOL_MCP_NAME,
  );
  const mcpDesc = `Task MCP: ${TASK_TOOL_MCP_NAME}${
    userMcpNames.length > 0 ? ` + 用户 MCP: ${userMcpNames.join(", ")}` : ""
  }`;

  await writeEventAndPublish(task.id, {
    kind: "info",
    actionId: action.id,
    text: `启动新 agent（model: ${model.id}、${mcpDesc}）`,
  });

  // 2) 注册 awaiting notifier（chat-mcp → runner 的回调）
  setChatAwaitingNotifier(task.id, async (signal) => {
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
      const fresh = await getTask(task.id);
      const targetAction = fresh?.actions.find(
        (a) => a.id === signal.actionId,
      );
      if (fresh && targetAction) {
        try {
          const result = await runActionCheck(fresh, targetAction);
          postCheck = result;
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
        },
      });
    } else {
      // 待命态：runStatus 切 awaiting_user、currentActionId 留 null
      const updated = await setTaskRunStatus(task.id, "awaiting_user", null);
      if (updated) publish(task.id, { kind: "task", task: updated });
    }
  });

  // 3) 启动 Agent + 消息循环（在独立 Promise 里跑、advanceTask 立即返回）
  let agent: Awaited<ReturnType<typeof Agent.create>> | null = null;
  let cancelled = false;
  let hardTimer: NodeJS.Timeout | null = null;

  const completion = (async () => {
    try {
      agent = await Agent.create({
        apiKey,
        model,
        local: { cwd: getEffectiveCwd(task.repoPaths) },
        mcpServers: mergedMcp,
      });
      console.log(
        `[task-runner] task=${task.id} Agent.create OK agentId=${agent.agentId}`,
      );
      try {
        await setTaskLastAgentId(task.id, agent.agentId);
      } catch (err) {
        console.warn(`[task-runner] setTaskLastAgentId failed task=${task.id}`, err);
      }

      // 加载 skills + 拼 super-prompt + send
      const skills = await loadSkills(getEffectiveCwd(task.repoPaths)).catch(
        (err) => {
          console.error("[task-runner] loadSkills failed", err);
          return [] as SkillEntry[];
        },
      );
      const superPrompt = await buildSuperPrompt(task, skills, {
        action,
        userInstruction,
        attachedImagePaths,
        attachedFilePaths,
        branchCheckoutHint,
      });

      const run = await agent.send(superPrompt);

      runningTasks.set(task.id, {
        agentId: agent.agentId,
        startedAt: Date.now(),
        cancel: () => {
          cancelled = true;
          cancelPending(task.id);
          void run.cancel().catch(() => {
            /* noop */
          });
        },
        completion: Promise.resolve(), // 占位、外部 await 走的是当前函数返回的 Promise
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
          await writeEventAndPublish(task.id, {
            kind: "info",
            text: "旧 agent 已收尾、正在为推进起新 agent...",
          });
          return;
        }
        // 正常 cancel（用户在 ack dialog 选 abandon / merged）→ 业务状态由 finalizeTask 处理
        // 这里只关闭运行时状态、不动 repoStatus
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

      const sdkBits: Record<string, unknown> = {};
      try {
        const e = err as Record<string, unknown>;
        if (typeof e.code === "string") sdkBits.code = e.code;
        if (typeof e.status === "number") sdkBits.status = e.status;
        if (typeof e.requestId === "string") sdkBits.requestId = e.requestId;
        if (e.cause instanceof Error) {
          sdkBits.causeName = e.cause.name;
          sdkBits.causeMessage = e.cause.message;
        }
      } catch {
        /* noop */
      }
      const fullMessage =
        Object.keys(sdkBits).length > 0
          ? `${message}\n--- SDK error fields ---\n${JSON.stringify(sdkBits, null, 2)}`
          : message;

      // 当前 action 标 error
      const fresh = await getTask(task.id);
      const curAction = fresh?.actions.find((a) => a.id === action.id);
      if (curAction && (curAction.status === "running" || curAction.status === "awaiting_ack")) {
        await patchAction(task.id, action.id, { status: "error" });
      }
      await setTaskRunStatus(task.id, "error", action.id);
      const updated = await writeEventAndPublish(task.id, {
        kind: "error",
        actionId: action.id,
        text: `Task agent 失败：${fullMessage}`,
      });
      publish(task.id, { kind: "done", task: updated ?? task, ok: false });
      publish(task.id, { kind: "error", message: fullMessage });
    } finally {
      runningTasks.delete(task.id);
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
  })();

  // 把 completion 落到 entry（advanceTask 已 return、外部 waitForTaskToStop 用）
  // 注意：runningTasks.set 在 try 里 Agent.create 之后才做、所以这里要等 entry 出现
  // 但 advanceTask 不 await 这个 promise、它 fire-and-forget、所以 entry 出现时机晚于这里
  // → completion 字段的赋值靠 try 里 runningTasks.set 时塞 Promise.resolve()、本函数返回的
  //   completion promise 本身才是「真活」、外部 waitForTaskToStop 仅 poll runningTasks.has 不依赖此字段
  void completion;
};

// ----------------- SDKMessage 翻译器（沿用 V0.5 plan-runner 同款分支）-----------------

interface AssistantBufferCtx {
  buffer: string;
  flush: () => Promise<void>;
  sdkErrorMessage?: string;
}

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

      // V0.6：write / edit 写 actions/N-<type>.md 时推一份 tool_call 事件给 UI（同 V0.5 artifacts/ 同款套路）
      const possibleTarget =
        (argsAny.target_file as string | undefined) ??
        (argsAny.file_path as string | undefined) ??
        (argsAny.path as string | undefined);
      if (
        possibleTarget &&
        typeof possibleTarget === "string" &&
        (possibleTarget.includes("/actions/") || possibleTarget.startsWith("actions/"))
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
