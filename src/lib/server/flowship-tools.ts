/**
 * Flowship 自有工具（交卷 / 提问 / 提 MR / 测试人员 / 批次 / 挂 action / 分享群 / 群 @ 测试）。
 *
 *   - cursor：`buildSdkCustomTools` → `Agent.create({ local: { customTools } })`
 *   - custom：pi customTools（TypeBox schema，见 custom-agent-backend.ts）
 *
 * 工具名必须与 prompt 教的一致；sdk-message-handler 按名字 +
 * `[SUBMITTED]` / `[ASK_SUBMITTED]` 判定交卷/提问成功。
 *
 * handler 调 chat-pending 原语（runTaskAction / safeNotify* / registerPendingAsk），
 * 不经 HTTP MCP。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
// TypeBox 1.x 把这些构造器作为顶层具名导出（会 shadow JS 全局、统一加 TB 前缀）
import {
  Array as TBArray,
  Boolean as TBBoolean,
  Enum as TBEnum,
  Number as TBNumber,
  Object as TBObject,
  Optional as TBOptional,
  String as TBString,
} from "typebox/type";

import {
  CALLER_MISMATCH_ERROR,
  cancelPendingIf,
  matchExpectedCallerToken,
  registerPendingAsk,
  runTaskAction,
  safeNotifyAskUserRequest,
  safeNotifyAwaiting,
  type AskUserQuestion,
  type NotifyAwaitingResult,
} from "./chat-pending";
import {
  buildScheduleInfoMeta,
  describeSchedulePlan,
  formatScheduleDateTime,
  formatScheduleLocalIso,
  formatScheduleTime,
  SCHEDULE_MAX_ACTIVE_PER_TASK,
  SCHEDULE_MIN_INTERVAL_MINUTES,
  SCHEDULE_STATUS_LABEL,
  SCHEDULE_TOOL_NAME,
  validateScheduleCreate,
  type ScheduleRecord,
} from "@/lib/schedule";
import { WAIT_TOOL_NAME } from "@/lib/wait-display";
import { ACTION_LABEL } from "@/lib/types";
import {
  NON_OWNER_TURN_ALLOWED_TOOLS,
  buildNonOwnerToolDenied,
} from "@/lib/group-non-owner-prompt";
import { buildAskWaitCurl, openAskWait } from "./ask-wait";
import { isNonOwnerTurnActive, touchNonOwnerTurn } from "./non-owner-turn-guard";
import { cancelSchedule, createSchedule, readSchedules } from "./schedule-store";
import { createCustomAction, getCustomAction } from "./custom-action-fs";
import {
  WAIT_MAX_SECONDS,
  WAIT_MIN_SECONDS,
  formatWaitResult,
  normalizeWaitSeconds,
  runWait,
} from "./session-wait";
import { getAppSkillsDir } from "./skills-loader";
import {
  ADVANCE_CHAIN_ACTIONS,
  ADVANCE_CHAIN_GROUNDING_EVENT_TAIL,
  ADVANCE_CHAIN_MAX_AUTO_STEPS,
  collectAuthorizationSources,
  getAutoAdvanceSteps,
  isAutoAdvanceCapReached,
  isUserWordsGrounded,
  parseAdvanceNextArgs,
  registerAdvanceChain,
} from "./advance-chain";
import { getBrowserTools } from "./browser/tools";
import { getTask, getTaskMeta, getTaskWithTailEvents } from "./task-fs";
import { getTaskOpGeneration, writeEventAndPublish } from "./task-stream";

/**
 * 工具结果内容块。`image` 目前只有 browser_screenshot 用：两条后端都原样透传给模型
 * （Cursor SDK 的 SDKCustomToolContent 与 pi 的 ToolResult content 都原生支持 image 块）。
 */
export type FlowshipToolContent = Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
>;

/** 工具结果：`isError` 让后端把它按「失败的工具调用」呈现给模型（文案仍在 content 里，是模型能自修复的话） */
export interface FlowshipToolResult {
  content: FlowshipToolContent;
  isError?: boolean;
}

/**
 * 工具回调的运行时上下文（两条后端各自能给多少给多少，全可选）。
 * 现在只有 `wait` 用它；其余工具自己带 task_id 入参、校验 callerToken，不依赖这里。
 */
export interface FlowshipToolContext {
  /**
   * 这个会话属于哪个任务：`wait` 据此登记，停止 / 插话 / 「跳过等待」按 taskId 把它唤醒。
   * 两条后端在工具构建处都知道 taskId；没有时 `wait` 仍能等，只是只能被定时器 / signal 结束。
   */
  taskId?: string;
  /**
   * agent 实例级 scope：这个实例的 run 被取消 / 会话被关时（懒重启、错误收尾、超时……不经 stop 的那些路径）
   * 按它叫醒在睡的 `wait`。只有 Cursor 路径有（pi 靠 signal）；见 session-wait 头注释。
   */
  scope?: string;
  /** 本次调用被取消的信号。pi 有；Cursor SDK 的 customTool 回调没有（靠注册表在停止时主动唤醒） */
  signal?: AbortSignal;
}

export interface FlowshipToolDef {
  name: string;
  label: string;
  description: string;
  /** TypeBox schema（pi customTools + Cursor SDK customTools 共用） */
  parameters: unknown;
  handler: (
    args: Record<string, unknown>,
    callerToken: string | undefined,
    ctx?: FlowshipToolContext,
  ) => Promise<FlowshipToolResult>;
}

const text = (t: string): { content: FlowshipToolContent } => ({
  content: [{ type: "text", text: t }],
});

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** notify 未送达时提问工具返回（反登记后、非 ASK_SUBMITTED） */
const ASK_NOTIFY_FAILED_TEXT = "任务已被接管/通知失败、请重试";

const submittedText = (actionId: string): string =>
  [
    `[SUBMITTED] action=${actionId} 已交卷，后台在跑检查。现在把要给用户看的话说完（收尾 1-3 句业务结论，答疑该长就长；详情指向产物），然后结束本轮。不要再调本工具、不要轮询、不要复述交卷或提工具名。`,
  ].join("\n");

const idleWaitText = (): string =>
  [
    "[NO_WAIT_NEEDED] 本系统不需要挂起等待：请直接结束本轮回复（正常结束 turn）。",
    "用户的下一步操作会作为新消息发给你、你会在同一会话里继续。",
  ].join("\n");

/**
 * 把 safeNotifyAwaiting 结果映射为 submit_work 工具文案。
 * 导出供 ownership 测试断言「stale/busy 不是 submitted」。
 */
export const mapSubmitWorkNotifyToToolText = (
  notifyResult: NotifyAwaitingResult,
  actionId: string,
): string => {
  if (notifyResult.status === "error") {
    return `交卷未受理：${notifyResult.message}`;
  }
  if (notifyResult.status === "busy") {
    return `交卷未受理：${notifyResult.message}`;
  }
  if (notifyResult.status === "stale") {
    return "该 action 已结束/已被后续操作取代、请结束本轮回复";
  }
  if (notifyResult.status === "mismatch") {
    return CALLER_MISMATCH_ERROR;
  }
  if (notifyResult.status === "no_notifier") {
    return "交卷未受理：任务当前没有活跃会话桥（可能已被停止/接管）、请结束本轮回复";
  }
  return submittedText(actionId);
};

/** ask_user 成功返回：答题卡已推；本轮用返回里那条前台 curl 等答案 */
export const askSubmittedText = (askId: string, waitCurl?: string): string => {
  const lines = [
    `[ASK_SUBMITTED] 问题组 ${askId} 已推送给用户（UI 答题卡）。`,
    "",
    "**本轮还没结束。**立刻用一条**前台** shell 执行下面这行（禁止 `&` / nohup / 后台），一直挂到退出。",
    "- 不要 grep / read / 再调本工具，也不要自己编 URL",
    "- 这条 shell 的 timeout 填 86400000（毫秒，24 小时），不要用默认 120000",
    "- 以 `#` 开头的行是空闲输出，忽略；stdout 里出现 `[ASK_USER_REPLY]`（或 `[ASK_USER_REPLY deferred]`）才是答案",
    "- 拿到答案后在同一轮继续干活。交卷仍然走 `submit_work`，不要为交卷挂 curl",
  ];
  if (waitCurl) {
    lines.push("", waitCurl);
  }
  return lines.join("\n");
};

/** 交卷分派（工具 handler + 测试共用） */
export const dispatchSubmitWork = async (args: {
  taskId: string;
  callerToken: string | undefined;
  actionId?: string;
  artifactPath?: string;
}): Promise<{ text: string }> => {
  if (!matchExpectedCallerToken(args.taskId, args.callerToken)) {
    return { text: CALLER_MISMATCH_ERROR };
  }
  if (!args.actionId) {
    const idleNotify = await safeNotifyAwaiting(args.taskId, {
      callerToken: args.callerToken,
    });
    if (idleNotify.status === "mismatch") {
      return { text: CALLER_MISMATCH_ERROR };
    }
    if (
      idleNotify.status === "stale" ||
      idleNotify.status === "busy" ||
      idleNotify.status === "error"
    ) {
      return {
        text: mapSubmitWorkNotifyToToolText(idleNotify, "<idle>"),
      };
    }
    return { text: idleWaitText() };
  }
  const notifyResult = await safeNotifyAwaiting(args.taskId, {
    actionId: args.actionId,
    artifactPath: args.artifactPath,
    callerToken: args.callerToken,
  });
  if (notifyResult.status === "mismatch") {
    return { text: CALLER_MISMATCH_ERROR };
  }
  return {
    text: mapSubmitWorkNotifyToToolText(notifyResult, args.actionId),
  };
};

/** ask_user 一次最多几项：再多答题卡没法看，也多半是模型把整份文档当成问题塞进来了 */
export const ASK_USER_MAX_QUESTIONS = 20;

/**
 * 提问入参校验（`dispatchAskUser` 开头调；工具 handler 与测试共用）。
 * 弱模型 / 自定义 provider 不强制 inputSchema（pi 路径 TypeBox 只校验类型、不校验非空），会传
 * `questions: []` 或 `[{id:"",question:""}]`：不校验就登记一个没有可答项的 pending ask、推一张空卡，
 * 还让模型去挂 24 小时的 curl 等一份没人能提交的答案（只能靠用户点「跳过」/ 停止）。
 * 返回 null = 合法；否则是给模型看的、点名第几项哪个字段的具体原因（模型据此自修复重发）。
 */
export const validateAskUserQuestions = (
  questions: AskUserQuestion[],
): string | null => {
  const t = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  if (!Array.isArray(questions) || questions.length === 0) {
    return "questions 至少要有 1 项（当前 0 项）";
  }
  if (questions.length > ASK_USER_MAX_QUESTIONS) {
    return `questions 最多 ${ASK_USER_MAX_QUESTIONS} 项（当前 ${questions.length} 项），请合并或拆成多轮`;
  }
  const seen = new Set<string>();
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const at = `questions[${i}]`;
    const id = t(q?.id);
    if (!id) return `${at}.id 不能为空`;
    if (seen.has(id)) return `${at}.id「${id}」与前面的项重复，id 必须唯一`;
    seen.add(id);
    if (!t(q?.question)) return `${at}（id=${id}）.question 不能为空`;
    const options = q?.options;
    if (options !== undefined) {
      if (!Array.isArray(options) || options.length === 0) {
        return `${at}（id=${id}）.options 给了空数组：要么至少 1 个选项，要么不要传 options（只收文字回答）`;
      }
      const optSeen = new Set<string>();
      for (let j = 0; j < options.length; j++) {
        const oid = t(options[j]?.id);
        if (!oid) return `${at}（id=${id}）.options[${j}].id 不能为空`;
        if (optSeen.has(oid)) {
          return `${at}（id=${id}）.options[${j}].id「${oid}」重复，同一题里选项 id 必须唯一`;
        }
        optSeen.add(oid);
        if (!t(options[j]?.label)) {
          return `${at}（id=${id}）.options[${j}].label 不能为空`;
        }
      }
    } else if (q?.allowText === false) {
      return `${at}（id=${id}）既没有 options 又不允许文字回答（allow_text=false），用户无法作答`;
    }
  }
  return null;
};

/** 校验不过时回给模型的整段文案（不登记、不推卡、没有 ASK_SUBMITTED，所以不要去挂 curl） */
const askUserInvalidText = (reason: string): string =>
  `提问未发出：${reason}。没有推送答题卡，也不要去执行 curl。请按 { id, question, options?: [{id,label}], allow_text? } 补全后重新调用 ask_user。`;

/** 提问分派（工具 handler + 测试共用） */
export const dispatchAskUser = async (args: {
  taskId: string;
  callerToken: string | undefined;
  actionId?: string;
  questions: AskUserQuestion[];
}): Promise<{ ok: true; askId: string; waitCurl: string } | { ok: false; error: string }> => {
  if (!matchExpectedCallerToken(args.taskId, args.callerToken)) {
    return { ok: false, error: CALLER_MISMATCH_ERROR };
  }
  const invalid = validateAskUserQuestions(args.questions);
  if (invalid) return { ok: false, error: askUserInvalidText(invalid) };
  const askId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ask = registerPendingAsk(args.taskId, {
    askId,
    questions: args.questions,
    actionId: args.actionId,
  });
  const askNotify = await safeNotifyAskUserRequest(args.taskId, {
    askId,
    token: ask.token,
    questions: args.questions,
    actionId: args.actionId,
    callerToken: args.callerToken,
  });
  if (askNotify.status !== "accepted") {
    cancelPendingIf(args.taskId, askId);
    if (askNotify.status === "mismatch") {
      return { ok: false, error: CALLER_MISMATCH_ERROR };
    }
    return { ok: false, error: ASK_NOTIFY_FAILED_TEXT };
  }
  openAskWait({ taskId: args.taskId, askId, token: ask.token });
  return {
    ok: true,
    askId,
    waitCurl: buildAskWaitCurl(args.taskId, ask.token),
  };
};

// ----------------- 交卷 submit_work -----------------

const submitWorkDef: FlowshipToolDef = {
  name: "submit_work",
  label: "交卷：宣告当前 action 完成",
  description: [
    "Task 模式（action 容器）专用：完成一个 action（写完 artifact）后调本工具交卷。",
    "系统后台跑质量检查后通知用户审阅。非阻塞、立即返回。",
    "产物写好后先调本工具交卷；拿到 [SUBMITTED] 后再说 1-3 句业务结论并结束本轮。不要轮询 / 重复调本工具。",
    "Chat 模式（自由对话）不需要调本工具。",
  ].join("\n"),
  parameters: TBObject({
    task_id: TBString(),
    message: TBOptional(TBString()),
    action_id: TBOptional(TBString()),
    artifact_path: TBOptional(TBString()),
  }),
  handler: async (args, callerToken) => {
    const r = await dispatchSubmitWork({
      taskId: str(args.task_id),
      callerToken,
      actionId: str(args.action_id) || undefined,
      artifactPath: str(args.artifact_path) || undefined,
    });
    return text(r.text);
  },
};

// ----------------- 提问 ask_user -----------------

const askUserDef: FlowshipToolDef = {
  name: "ask_user",
  label: "打包提问（一次问完所有不确定项）",
  description: [
    "遇到不确定 / 要用户选择时、把当前轮想问的全部打包成 questions[]、推 UI 答题卡。task / chat 都可用。",
    "每项 { id, question, options?: [{id,label}], allow_text? }；别塞 Other/其他；options 缺省 allow_text 默认 true。",
    "返回 [ASK_SUBMITTED] 后立刻前台执行返回里的 curl（shell timeout 86400000），挂到 stdout 出现 [ASK_USER_REPLY]。不要 grep、不要结束本轮、不要自己编 URL。交卷不要挂 curl。",
  ].join("\n"),
  parameters: TBObject({
    task_id: TBString(),
    action_id: TBOptional(TBString()),
    questions: TBArray(
      TBObject({
        id: TBString(),
        question: TBString(),
        options: TBOptional(
          TBArray(TBObject({ id: TBString(), label: TBString() })),
        ),
        allow_text: TBOptional(TBBoolean()),
      }),
    ),
  }),
  handler: async (args, callerToken) => {
    // 项不是对象（null / 字符串…）按空项处理，交给 dispatchAskUser 的校验点名，别在这里 TypeError
    const obj = (v: unknown): Record<string, unknown> =>
      v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    const raw = (Array.isArray(args.questions) ? args.questions : []).map(obj);
    const questions: AskUserQuestion[] = raw.map((q) => ({
      id: str(q.id),
      question: str(q.question).trim(),
      options: Array.isArray(q.options)
        ? q.options.map((o) => {
            const oo = obj(o);
            return { id: str(oo.id), label: str(oo.label) };
          })
        : undefined,
      allowText: q.allow_text !== false,
    }));
    const r = await dispatchAskUser({
      taskId: str(args.task_id),
      callerToken,
      actionId: str(args.action_id) || undefined,
      questions,
    });
    return text(r.ok ? askSubmittedText(r.askId, r.waitCurl) : r.error);
  },
};

// ----------------- 提 MR submit_mr -----------------

const submitMrDef: FlowshipToolDef = {
  name: "submit_mr",
  label: "提交 GitLab MR（ship / 改bug / dev / custom）",
  description: [
    "server 同步调 GitLab REST API 建 MR。调用前须已 git push、并用 git rev-parse HEAD 拿 last_commit_hash。",
    "同一仓再次 ship 直接再调即可、server 复用现有 open MR。多仓 task 每仓调一次。",
    "返回 { ok, data:{ mr_url, has_conflicts, ... } }；has_conflicts=true 时绝不 merge/rebase 目标分支、先调 ask_user。",
  ].join("\n"),
  parameters: TBObject({
    task_id: TBString(),
    action_id: TBString(),
    repo_path: TBString(),
    project_path: TBString(),
    source_branch: TBString(),
    target_branch: TBString(),
    title: TBString(),
    description: TBString(),
    last_commit_hash: TBString(),
  }),
  handler: async (args, callerToken) => {
    const result = await runTaskAction(
      str(args.task_id),
      {
        kind: "submit_mr",
        actionId: str(args.action_id),
        repoPath: str(args.repo_path),
        projectPath: str(args.project_path),
        sourceBranch: str(args.source_branch),
        targetBranch: str(args.target_branch),
        title: str(args.title),
        description: str(args.description),
        lastCommitHash: str(args.last_commit_hash),
      },
      callerToken,
    );
    return text(JSON.stringify(result));
  },
};

// ----------------- 测试人员 set_feishu_testers -----------------

const setFeishuTestersDef: FlowshipToolDef = {
  name: "set_feishu_testers",
  label: "持久化飞书 story 测试人员 user_key 列表",
  description: [
    "把当前 task 关联飞书 story 的测试人员 user_key（纯数字）列表写到 task.feishuTesterUserKeys。",
    "首次 ship 内用 meegle CLI 探测后调本工具落库；同 task 后续 ship 直接读、不再探测。",
    "user_keys 可为空数组（= 显式记忆「没测试人 / 跳过 @」）。",
  ].join("\n"),
  parameters: TBObject({
    task_id: TBString(),
    action_id: TBString(),
    user_keys: TBArray(TBString()),
  }),
  handler: async (args, callerToken) => {
    const result = await runTaskAction(
      str(args.task_id),
      {
        kind: "set_feishu_testers",
        actionId: str(args.action_id),
        userKeys: Array.isArray(args.user_keys)
          ? args.user_keys.map((k) => str(k))
          : [],
      },
      callerToken,
    );
    return text(JSON.stringify(result));
  },
};

// ----------------- 上报批次 set_plan_batches -----------------

const setPlanBatchesDef: FlowshipToolDef = {
  name: "set_plan_batches",
  label: "上报 plan 拆出的批次（大需求分批 build 用）",
  description: [
    "把当前 plan 拆出的「批次」结构化上报、落到该 plan action（不用在 artifact 里写批次表）。",
    "仅当需求够大、一次 build 跑不稳时才调；小需求别调。",
    "batches 每项 { id, title, test_strategy: tdd|after|none, task_refs: string[] }、数组顺序 = 建议 build 顺序。",
  ].join("\n"),
  parameters: TBObject({
    task_id: TBString(),
    action_id: TBString(),
    batches: TBArray(
      TBObject({
        id: TBString(),
        title: TBString(),
        test_strategy: TBEnum(["tdd", "after", "none"]),
        task_refs: TBArray(TBString()),
      }),
    ),
  }),
  handler: async (args, callerToken) => {
    const result = await runTaskAction(
      str(args.task_id),
      {
        kind: "set_plan_batches",
        actionId: str(args.action_id),
        batches: (Array.isArray(args.batches) ? args.batches : []).map((b) => {
          const bb = b as Record<string, unknown>;
          const ts = str(bb.test_strategy);
          return {
            id: str(bb.id),
            title: str(bb.title),
            testStrategy: (ts === "tdd" || ts === "after" ? ts : "none") as
              | "tdd"
              | "after"
              | "none",
            taskRefs: Array.isArray(bb.task_refs)
              ? bb.task_refs.map((t) => str(t))
              : [],
          };
        }),
      },
      callerToken,
    );
    return text(JSON.stringify(result));
  },
};

// ----------------- 挂自定义 action create_custom_action -----------------

const createCustomActionDef: FlowshipToolDef = {
  name: "create_custom_action",
  label: "挂载自定义 Action（skill 已写好）",
  description: [
    "把已写好的主 skill 挂成自定义 Action（推进面板里的动作按钮）。",
    "先写 SKILL.md 进自管 skills、再调本工具；产出要求写进 output、别写进 SKILL.md。",
    "入参：label（必填）、skill（必填、须已存在）、output / placeholder（可选）。",
  ].join("\n"),
  parameters: TBObject({
    label: TBString(),
    skill: TBString(),
    output: TBOptional(TBString()),
    placeholder: TBOptional(TBString()),
  }),
  handler: async (args) => {
    const labelTrimmed = str(args.label).trim();
    if (!labelTrimmed) return text("label 不能为空（trim 后须有实质内容）");
    const skillName = str(args.skill).trim();
    const appDir = path.join(getAppSkillsDir(), skillName);
    const appExists = await fs
      .stat(appDir)
      .then((st) => st.isDirectory())
      .catch(() => false);
    if (!appExists) {
      return text(
        `主 skill「${skillName}」不在自管目录。请先把 SKILL.md 写进自管 skills（目录名=${skillName}）、再调本工具挂壳。`,
      );
    }
    try {
      const action = await createCustomAction({
        label: labelTrimmed,
        skill: skillName,
        output: str(args.output).trim() || undefined,
        placeholder: str(args.placeholder).trim() || undefined,
      });
      return text(
        `已挂载自定义 Action：id=${action.id}、label=${action.label}、skill=${action.skill}。请告诉用户去能力页 Action tab 查看 / 排序 / 显隐。`,
      );
    } catch (err) {
      return text(`挂载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ----------------- 分享群 share_to_group -----------------

// 服务端短窗幂等：断线重连 / 会话恢复后模型常把「刚发过的那张卡」原样再调一遍，没有这道门就会
// 在需求群里刷出两张一模一样的卡。口径对齐 notify_group_testers 的 claimNotify（见
// feishu-bridge/group-tester-notify.ts）：发之前占位、**明确失败就退坑**让重试放行、成功占位保留；
// 区别是这里按「同 task + 同内容哈希」且只管一个短窗（用户确实想再发一次相同内容 → 等窗口过去或改一个字）。
/** 去重窗口：同一任务相同内容在这么久之内重复调用 → 跳过（不当失败） */
export const SHARE_TO_GROUP_DEDUP_WINDOW_MS = 2 * 60_000;
/** 去重表容量上限（防无界）：超限先清过期、仍超限丢最旧 */
const SHARE_TO_GROUP_DEDUP_MAX = 200;
const SHARE_TO_GROUP_DEDUP_KEY = "__flowshipShareToGroupDedupV1__";

/** key → 过期时刻（ms）。挂 globalThis：dev hot reload 后表不丢 */
const getShareToGroupDedup = (): Map<string, number> => {
  const g = globalThis as unknown as Record<string, Map<string, number> | undefined>;
  if (!g[SHARE_TO_GROUP_DEDUP_KEY]) g[SHARE_TO_GROUP_DEDUP_KEY] = new Map();
  return g[SHARE_TO_GROUP_DEDUP_KEY]!;
};

/** 同 task + 同发送内容（kind / title / content / links / at 全相同）才算重复；只存哈希、不存正文 */
const shareToGroupDedupKey = (taskId: string, input: unknown): string =>
  `${taskId}:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;

/** true = 抢到占位（可以发）；false = 窗口内已发过 / 正在发同一内容（跳过） */
const claimShareToGroup = (key: string, now = Date.now()): boolean => {
  const table = getShareToGroupDedup();
  for (const [k, expiresAt] of table) {
    if (expiresAt <= now) table.delete(k);
  }
  if (table.has(key)) return false;
  while (table.size >= SHARE_TO_GROUP_DEDUP_MAX) {
    const oldest = table.keys().next().value;
    if (oldest === undefined) break;
    table.delete(oldest);
  }
  table.set(key, now + SHARE_TO_GROUP_DEDUP_WINDOW_MS);
  return true;
};

/** 发送明确失败时退坑：失败的那次不算「发过」，模型 / 用户重试要能放行 */
const releaseShareToGroup = (key: string): void => {
  getShareToGroupDedup().delete(key);
};

/** 单测清空去重表 */
export const __resetShareToGroupDedupForTest = (): void => {
  getShareToGroupDedup().clear();
};

const shareToGroupDef: FlowshipToolDef = {
  name: "share_to_group",
  label: "分享到飞书需求群（产物 / 疑问 / 进展）",
  description: [
    "把内容以互动卡片发到当前任务关联飞书工作项的需求群。",
    "只在用户明确要求分享 / playbook 编排时调；不要自行滥发。",
    "提测在需求群 @ 测试人员不要走本工具，用 notify_group_testers。",
    "入参：task_id、content（必填）、title / kind(artifact|message|question) / links([{label,url}]) / at([名字]) 可选。",
    "at 是通用 @：传中文名或邮箱，卡片正文自动 @ 并推送；精确匹配才@，换不出/重名进返回的 at.unresolved（不挡发送）。artifact 卡无正文、at 会全进 unresolved。",
    "本工具只往任务已绑定的需求群发，不会自动建群：任务还没绑群时返回 code=no_group，把 error 原文转告用户（需先在任务页飞书协作入口创建/绑定需求群）。",
    "返回 { ok, chatName?, messageId?, docMessageId? } 或 { ok:false, error, code? }——失败如实转告用户、不要自行重试。",
    "防重：同一任务在 2 分钟内重复发送完全相同的内容（标题 / 正文 / 链接 / @ 都一样）会被跳过，返回 { ok:true, skipped:true, outcome:\"skipped_duplicate\" }——这不是失败，说明上一张卡已经发出，不用再发；如确需重发，请稍候再试或改动内容。",
  ].join("\n"),
  parameters: TBObject({
    task_id: TBString(),
    content: TBString(),
    title: TBOptional(TBString()),
    kind: TBOptional(TBEnum(["artifact", "message", "question"])),
    links: TBOptional(
      TBArray(TBObject({ label: TBString(), url: TBString() })),
    ),
    at: TBOptional(TBArray(TBString())),
  }),
  handler: async (args, callerToken) => {
    const taskId = str(args.task_id);
    if (!matchExpectedCallerToken(taskId, callerToken)) {
      return text(CALLER_MISMATCH_ERROR);
    }
    // 动态 import：避免本模块静态依赖 feishu-group → meegle、拉垮只 mock 轻依赖的单测
    const { FeishuGroupError, shareToRequirementGroup } = await import(
      "./feishu-group"
    );
    const task = await getTask(taskId);
    if (!task) {
      return text(JSON.stringify({ ok: false, error: "任务不存在" }));
    }
    const shareInput = {
      kind: (["artifact", "message", "question"].includes(str(args.kind))
        ? str(args.kind)
        : "message") as "artifact" | "message" | "question",
      title: str(args.title) || undefined,
      content: str(args.content),
      links: Array.isArray(args.links)
        ? (args.links as Array<{ label: unknown; url: unknown }>).map(
            (l) => ({ label: str(l.label), url: str(l.url) }),
          )
        : undefined,
      at: Array.isArray(args.at)
        ? (args.at as unknown[]).map((n) => str(n)).filter((n) => n.trim())
        : undefined,
    };
    // 发之前占位（并发的同内容调用也只放第一个进去）；跳过不当失败：ok:true + outcome
    const dedupKey = shareToGroupDedupKey(taskId, shareInput);
    if (!claimShareToGroup(dedupKey)) {
      return text(
        JSON.stringify({
          ok: true,
          skipped: true,
          outcome: "skipped_duplicate",
          message:
            "2 分钟内已向需求群发过相同内容的卡片（或同一内容正在发送），本次已跳过、不是失败。" +
            "如确需重发，请稍候再试或改动内容。",
        }),
      );
    }
    try {
      const result = await shareToRequirementGroup(task, shareInput, {
        verifyOwnerMembership: true,
      });
      return text(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      // 发送抛错 = 这次没发成：退坑，让重试 / 用户再来一次能放行
      releaseShareToGroup(dedupKey);
      if (err instanceof FeishuGroupError) {
        return text(
          JSON.stringify({
            ok: false,
            error: err.message,
            code: err.code,
            ...(err.botLabel ? { botLabel: err.botLabel } : {}),
            ...(err.chatId ? { chatId: err.chatId } : {}),
          }),
        );
      }
      return text(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  },
};

// ----------------- 需求群 @ 测试 notify_group_testers -----------------

const notifyGroupTestersDef: FlowshipToolDef = {
  name: "notify_group_testers",
  label: "在需求群 IM @ 测试人员",
  description: [
    "提测 playbook：写完飞书项目评论之后调。往已绑定的需求群发一张提测通知卡（MR 按钮 + 邮箱 @ 同一批测试人员，能推飞书提及），替代工作项评论 @（评论 @ 不推通知）。",
    "入参只要 task_id、action_id。人从 task.feishuTesterUserKeys 取、MR 从本 action 的 submit_mr 记录取；不要传 open_id，不要用 share_to_group 代替。",
    "只允许当前 running 的 ship 调。返回 { ok, outcome }：sent / skipped_*（没群 / bot 不在群 / 没人可换 / 无 MR / 有冲突 / 重复调用等）/ failed（超时或发送失败）。skipped 与 failed 都不是 ship 失败：原样记进 artifact 即可，不要改调 share_to_group。failed 可重调一次：若重调回 skipped_duplicate 说明上一轮实际已发出，不用再试。",
  ].join("\n"),
  parameters: TBObject({
    task_id: TBString(),
    action_id: TBString(),
  }),
  handler: async (args, callerToken) => {
    const taskId = str(args.task_id);
    const actionId = str(args.action_id);
    if (!matchExpectedCallerToken(taskId, callerToken)) {
      return text(CALLER_MISMATCH_ERROR);
    }
    const task = await getTask(taskId);
    if (!task) {
      return text(JSON.stringify({ ok: false, error: "任务不存在" }));
    }
    const action = task.actions.find((a) => a.id === actionId);
    if (
      task.currentActionId !== actionId ||
      !action ||
      action.status !== "running" ||
      action.type !== "ship"
    ) {
      return text(
        JSON.stringify({
          ok: false,
          error: "notify_group_testers 只允许当前 running 的 ship 调用",
        }),
      );
    }
    // 动态 import：避开 feishu-group → meegle 的静态依赖（同 share_to_group）
    const { notifyShipTestersInGroup } = await import(
      "./feishu-bridge/group-tester-notify"
    );
    const outcome = await notifyShipTestersInGroup(task, action, {
      // best-effort 回执：只在还是同一轮 ship 时写进事件流，失主/切 action 就丢掉；
      // 写失败也不影响已经发出去的 @（writeEventAndPublish 本来就吞错返 null）
      emitInfo: async (text) => {
        const fresh = await getTask(taskId);
        if (!fresh || fresh.currentActionId !== actionId) return;
        await writeEventAndPublish(taskId, {
          kind: "info",
          actionId,
          text,
        });
      },
    });
    return text(JSON.stringify({ ok: true, outcome }));
  },
};

// ----------------- 群出问登记 expect_group_reply -----------------

const expectGroupReplyDef: FlowshipToolDef = {
  name: "expect_group_reply",
  label: "登记群里问出去的问题（等对方回结论）",
  description: [
    "在需求群里 @ 谁要数据之后调（如 @同事 要学号、@另一台机器人要结论）。登记后对方在窗口期（默认 2 小时）内的回复会被当成答案数据送回本任务（只读呈现；会话活着则自动喂给会话当数据，吃掉后群里不再回）。",
    "前置要求：群里那条必须带真 @（手写 <at user_id=\"ou_xxx\"> 标签的 text 消息；分享卡片的 at 只认人、@机器人不会亮，对方可能收不到提醒）。对方 open_id 先用成员列表查，查不到就问用户要。",
    "调用时机：先登记再发——查到对方 open_id 后先调本工具占位（message_id 随手填个唯一串，每次换一个，如 pending-1、pending-2，别复用同一个占位串——同串会被当成同一条去重），再去群里发真 @ 消息；对方秒回也漏不掉。若已发出，拿到回执立刻补登（同目标只留最新，重复登无害）。message_id 取回执里的 message_id（om_xxx）只用于对账，不参与判定；target 必须是 @ 标签里的 user_id/open_id（ou_xxx / cli_xxx，原样抄）。不知道 id 时不许填显示名凑合（填了直接拒单——群昵称随手可改，精确相等防不住改名冒充）：先用成员列表查（群成员详情里能看到 ou_xxx），查不到就问用户要；keywords/about 都是备注（1-5 个关键词或一句话在等什么事，给模型看，不做硬拦）。",
    "出问措辞（决定对方的回复能不能被本机收到）：群里那条消息正文里必须明写「请直接 @本机机器人（写上它的展示名）回复」——对方（尤其是别的机器人）默认会 @ 它自己的负责人而不是你，没 @ 到本机机器人，本机根本收不到回复。一条只问一件事、写清要什么形态的答案；对方是机器人时再加一句「只回实质答案，不用回复『收到』」，免得两边互相客套成环。",
    "不调 = 对方回来只走普通只读答疑，不会当答案数据消费。有效期默认 2 小时（一问一答、消费即焚；ttl_minutes 可改，单位分钟）；一次只等一件事，上一个没回来先别问下一个；内容不够最多补问一次，补问前需重新登记；占位后尽快发真 @（占位传 ttl_minutes: 10，发出后再补登正式登记），别留长时间空窗。",
    "回话位置跟着上下文走：本轮若是用户在群里发消息触发的（用户消息以 `[群消息·来自 …]` 开头），你这一轮的回复会自动发回那个群，而对方回来后你喂回会话的那一轮结论也会自动发回群里 @ 最初提问的人——所以用户在群里让你去问、你也是在同一个群里问的，那条 @ 消息群里的人都看得见，收尾**不要再在群里复述「我已经 @ 了谁、问了什么」**：整段回复的第一行只写 NO_REPLY（群里就一条消息都不发；这一轮中间也别写会发到群里的旁白），下面可另起行写一句给 Flowship 里看的说明（不会外发）。结论等对方回来再说。用户是在 Flowship 里（不是群里）让你去问的，则照常告诉用户你问了谁、问了什么，对方回来后的结论也只留在 Flowship。",
  ].join("\n"),
  parameters: TBObject({
    task_id: TBString(),
    message_id: TBString(),
    target: TBString(),
    keywords: TBOptional(TBArray(TBString())),
    about: TBOptional(TBString()),
    ttl_minutes: TBOptional(TBNumber()),
  }),
  handler: async (args, callerToken) => {
    const taskId = str(args.task_id);
    // 失败形状统一 JSON（模型侧只 parse 一支；纯文本分支曾让调用方漏处理）
    if (!matchExpectedCallerToken(taskId, callerToken)) {
      return text(JSON.stringify({ ok: false, error: CALLER_MISMATCH_ERROR }));
    }
    const task = await getTask(taskId);
    if (!task) {
      return text(JSON.stringify({ ok: false, error: "任务不存在" }));
    }
    const { registerOutboundQuestion } = await import(
      "./feishu-bridge/group-outbound-registry"
    );
    const keywords = Array.isArray(args.keywords)
      ? (args.keywords as unknown[]).map((k) => str(k)).filter((k) => k.trim())
      : [];
    const about = str(args.about);
    // ttl 分钟数先收原始值，具体换算等下面 OUTBOUND_QUESTION_TTL_MS 到手再做（单一数据源）。
    const ttlMinutesRaw = args.ttl_minutes;
    // 群 ID 能反查就写死（跨群同目标不串味）；查不到放空、靠 target+窗口判定
    let chatId = "";
    try {
      const { getBoundGroupChatId } = await import("./feishu-group");
      chatId = (await getBoundGroupChatId(task)) ?? "";
    } catch {
      // 查不到不挡登记
    }
    // 这件事最初是谁在群里提的：agent 此刻正在服务某位真人在群里发的消息（属主通道的回群登记还在、且提问人不是机器人）。
    // 对方回执被喂回会话后，这一轮的结论就发回群里 @ 他（见 group-route 的 feedIntoSession）；
    // 任务是在 Flowship 里发起的 / 提问人是机器人 / 没有登记 → 不记，维持旧行为（吃掉回执、群里不再回）。
    let replyTo: { requesterOpenId: string; requesterName: string; chatId: string } | undefined;
    try {
      const { listGroupReplies } = await import("./feishu-bridge/group-shared");
      const origin = listGroupReplies(taskId).find(
        (e) => e.runTag === null && e.kind === "question" && e.requesterIsBot !== true,
      );
      if (origin && origin.chatId) {
        replyTo = {
          requesterOpenId: origin.requesterOpenId,
          requesterName: origin.requesterName,
          chatId: origin.chatId,
        };
      }
    } catch {
      // 查不到不挡登记
    }
    const r = registerOutboundQuestion({
      taskId,
      chatId,
      messageId: str(args.message_id),
      target: str(args.target),
      keywords,
      ...(replyTo ? { replyTo } : {}),
      ...(about.trim() ? { about: about.trim() } : {}),
      // 占位传小的 ttl（如 10 分钟），正式问不传（默认 2 小时）；非法值回落默认，不断登记。
      ...(typeof ttlMinutesRaw === "number" &&
      Number.isFinite(ttlMinutesRaw) &&
      ttlMinutesRaw > 0
        ? { ttlMs: Math.min(ttlMinutesRaw, 24 * 60) * 60 * 1000 }
        : {}),
    });
    if (!r.ok) return text(JSON.stringify({ ok: false, error: r.error }));
    // 同目标覆盖要可见：hint 里带被顶掉的旧登记，对不上时查无对证变有据可查。
    return text(
      JSON.stringify({
        ok: true,
        hint:
          "已登记，对方窗口期内的回复会当答案数据送回（吃掉后群里不再回）" +
          (r.replaced ? `（已覆盖同目标旧登记 ${r.replaced}）` : ""),
      }),
    );
  },
};

// ----------------- 等待 wait -----------------

/** reason 回显给模型 / 用户的最大长度（模型自己填的、别让一段长文顶满状态行） */
const WAIT_REASON_MAX = 120;

const waitDef: FlowshipToolDef = {
  name: WAIT_TOOL_NAME,
  label: "等待一段时间",
  description: [
    "等待一段时间再继续。需要等外部的事（后台命令跑完、CI / 流水线、文件生成、接口限流冷却、让某个服务先起来……）时用本工具——不要用 shell 的 `sleep`，也不要用 SDK 自带的 await / sleep：本工具在界面上会显示已等时长和原因、用户能随时「跳过等待」；停止任务、用户点「立即发送」插话、后台子代理交回结果也会让它提前返回（用户用普通发送排进队列的消息要等这一轮结束才会送达，不会唤醒它）。",
    `入参：seconds（${WAIT_MIN_SECONDS}–${WAIT_MAX_SECONDS}，必填）；reason（一句话说明在等什么，会显示给用户，强烈建议填）。`,
    "它只是睡觉：**不会替你检查**要等的事是否完成。醒来后你自己去确认；没好再决定要不要继续等，间隔适当拉长（几十秒到几分钟），别每隔几秒就轮询一次。",
    "返回以 [WAIT_DONE]（等够了）/ [WAIT_SKIPPED]（用户不想再等——不代表要等的事已完成，仍要自己确认）/ [WAIT_INTERRUPTED]（有新消息：用户插话或后台子代理交回结果）/ [WAIT_CANCELLED]（任务被停止——立刻结束本轮、不再调任何工具）开头；后三种按返回文案里的指示做，不要不管不顾地再睡一遍。",
  ].join("\n"),
  parameters: TBObject({
    seconds: TBNumber(),
    reason: TBOptional(TBString()),
  }),
  handler: async (args, _callerToken, ctx) => {
    // 不校验 callerToken：本工具没有 task_id 入参、也没有任何副作用（只是睡觉），
    // 被新 agent 接管后旧 agent 的等待最多白睡到自己的定时器 / 停止时被唤醒
    const norm = normalizeWaitSeconds(args.seconds);
    if (!norm) {
      return text(
        `参数错误：seconds 必须是 ${WAIT_MIN_SECONDS}–${WAIT_MAX_SECONDS} 之间的数字（秒）。`,
      );
    }
    const reason = str(args.reason).trim().slice(0, WAIT_REASON_MAX);
    const outcome = await runWait({
      key: ctx?.taskId,
      scope: ctx?.scope,
      plannedMs: norm.seconds * 1000,
      signal: ctx?.signal,
    });
    return text(formatWaitResult(outcome, { reason, clamped: norm.clamped }));
  },
};

// ----------------- 定时 schedule -----------------

const scheduleLine = (r: ScheduleRecord): string => {
  const next =
    r.nextFireAt !== null ? `，下次 ${formatScheduleDateTime(r.nextFireAt)}` : "";
  const counts =
    r.fireCount > 0 || r.missedCount > 0
      ? `，已触发 ${r.fireCount} 次${r.missedCount > 0 ? `、错过 ${r.missedCount} 次` : ""}`
      : "";
  return `- ${r.id}｜${r.title}｜${describeSchedulePlan(r)}｜${SCHEDULE_STATUS_LABEL[r.status]}${next}${counts}`;
};

const scheduleDef: FlowshipToolDef = {
  name: SCHEDULE_TOOL_NAME,
  label: "定时叫你",
  description: [
    "给自己设一个定时：到点由系统把你当时留的 `message` 作为新消息发回**本会话**（会话被回收了会先恢复再送）。用于「之后再做 / 再看」——N 分钟后查 CI、每 10 分钟看一次部署、明早提醒用户。设完正常结束本轮即可，不用干等；几十分钟的等待别用 `wait` 硬睡。",
    "`action=create`：`title`（一句话，会显示给用户）+ `message`（到点留给你自己的话，必填）。时间三选一：`delay_minutes`（N 分钟后，一次性）/ `at`（ISO 8601 绝对时间，一次性；必须带具体时刻、最好带时区偏移，如 `2026-10-20T09:00:00+08:00`，**不能只写日期**；不带偏移按本机时区）/ `every_minutes`（周期；首次触发在一个间隔后，也可再给 `delay_minutes` 或 `at` 指定首次时间；可加 `max_runs` 限制次数——按「到点次数」计，会话忙时合并掉的 / 错过的也占名额，所以实际送达数可能少于它）。数字参数请传数字。",
    `约束：最小 ${SCHEDULE_MIN_INTERVAL_MINUTES} 分钟、最远 7 天；每个会话最多同时 ${SCHEDULE_MAX_ACTIVE_PER_TASK} 条。`,
    "`message` 要写清：到点做什么；没有值得报告的变化时怎么办（一两句带过、别打扰用户）；什么时候该自己 `cancel` 它——周期任务不需要了就取消，别让它一直触发。",
    "应用没开 / 电脑睡眠时错过的**不会补发**（会标记为已错过）。会话被归档或删除时定时一起取消。",
    "`action=list`：列出本会话的定时（含 id）。`action=cancel`：用 `id` 取消一条。",
    "到点那条消息以 `[SCHEDULE_FIRED id=…]` 开头：这是系统发的、不是用户说话，按你当时留的话做。",
  ].join("\n"),
  parameters: TBObject({
    action: TBEnum(["create", "list", "cancel"]),
    title: TBOptional(TBString()),
    message: TBOptional(TBString()),
    delay_minutes: TBOptional(TBNumber()),
    at: TBOptional(TBString()),
    every_minutes: TBOptional(TBNumber()),
    max_runs: TBOptional(TBNumber()),
    id: TBOptional(TBString()),
  }),
  handler: async (args, callerToken, ctx) => {
    // 没有 task_id 入参：会话归属取自工具构建处带进来的 taskId（模型指不到别的会话）
    const taskId = ctx?.taskId;
    if (!taskId) {
      return text("定时不可用：当前会话缺少任务信息（不是正式会话）。");
    }
    // 与 wait 不同，本工具有副作用（落盘、日后往会话里注入消息）：像 submit_work / ask_user 一样先验 callerToken，
    // 被新 agent 接管 / 已停止的旧实例里还在飞的调用不许再建 / 取消定时（fail-closed：没注册 / 没带 token 也拒）
    if (!matchExpectedCallerToken(taskId, callerToken)) {
      return text(CALLER_MISMATCH_ERROR);
    }
    const action = str(args.action);
    const now = Date.now();

    if (action === "list") {
      const list = (await readSchedules(taskId)).filter(
        (r) => r.status === "active" || r.status === "paused",
      );
      if (list.length === 0) return text("本会话没有进行中的定时。");
      return text(
        [`本会话有 ${list.length} 条定时：`, ...list.map(scheduleLine)].join("\n"),
      );
    }

    if (action === "cancel") {
      const id = str(args.id).trim();
      if (!id) return text("参数错误：cancel 需要 id（先用 action=list 查）。");
      const r = await cancelSchedule(taskId, id, "AI 取消");
      if (!r.ok) return text(`取消失败：${r.error}`);
      // 提示事件只是给界面刷新定时条用的：写失败不能让模型看到「取消失败」——定时其实已经取消了
      await writeEventAndPublish(taskId, {
        kind: "info",
        text: `定时「${r.record.title}」已取消`,
        meta: buildScheduleInfoMeta(r.record.id, "cancelled"),
      }).catch((err) => console.warn("[schedule] 写取消提示事件失败", err));
      return text(`[CANCELLED id=${r.record.id}] 已取消定时「${r.record.title}」。`);
    }

    if (action === "create") {
      const v = validateScheduleCreate(args, now);
      if (!v.ok) return text(`参数错误：${v.error}`);
      // 已归档 / 已终结（合入 / 放弃）的会话：这时建的定时到点必然送不进去（周期的还会反复失败），直接拒绝。
      // 归档的 chat 后台可能还有 AI 在跑，所以挡在创建这一关
      const meta = await getTaskMeta(taskId);
      if (meta?.archived) return text("创建失败：这个会话已归档，不能再设定时。");
      if (meta && (meta.repoStatus === "merged" || meta.repoStatus === "abandoned")) {
        return text(
          `创建失败：这个任务已${meta.repoStatus === "merged" ? "合入" : "放弃"}，不能再设定时。`,
        );
      }
      const created = await createSchedule(taskId, v.value, now);
      if (!created.ok) return text(`创建失败：${created.error}`);
      // R14 Q20-05：已经有一条完全等价的活定时——没有新建，也不再写「已设定」提示事件（别往事件流重复刷）
      if (created.deduped) {
        const e = created.record;
        return text(
          [
            `[ALREADY_SCHEDULED id=${e.id}] 这个会话里已经有同样的定时「${e.title}」（${describeSchedulePlan(e)}，${e.status === "paused" ? "当前已暂停" : `下次 ${formatScheduleLocalIso(e.nextFireAt ?? now)}（本机时间）`}），没有重复创建。`,
            "不需要再设一次；要改时间 / 间隔，先取消这条（action=cancel）再新建。",
            // R14 Q20-05 的使用侧副作用：接力续期（旧的周期定时次数快用完、再建下一条）正好是「同标题 / 同正文 / 同间隔 / 同次数、
            // 只有首次时刻不同」，会被判成重复而断档——回执必须直接教出口，别让模型只能猜
            "确实要另建一条并存的（如周期定时的次数快用完、需要接力续期）：请改标题或正文再建——标题、正文、间隔、次数都相同的，只要旧的还活着就会一直被当成重复。",
          ].join("\n"),
        );
      }
      const r = created.record;
      // 定时已经落盘：提示事件写失败不能让模型看到「创建失败」（它会重试 → 重复创建）
      await writeEventAndPublish(taskId, {
        kind: "info",
        text:
          r.kind === "once"
            ? `已设定定时「${r.title}」：${formatScheduleTime(r.nextFireAt ?? now, now)} 触发`
            : `已设定周期定时「${r.title}」：${describeSchedulePlan(r)}，首次 ${formatScheduleTime(r.nextFireAt ?? now, now)}`,
        meta: buildScheduleInfoMeta(r.id, "created"),
      }).catch((err) => console.warn("[schedule] 写创建提示事件失败", err));
      return text(
        [
          `[SCHEDULED id=${r.id}] 已设定定时「${r.title}」：${describeSchedulePlan(r)}，${r.kind === "once" ? "" : "首次 "}${formatScheduleLocalIso(r.nextFireAt ?? now)}（本机时间）。`,
          "到点系统会把你留的 message 作为新消息发回本会话。现在继续手头的事或直接结束本轮——不要为了等它去 wait / 轮询。应用没开 / 电脑睡眠时错过的不会补发。",
        ].join("\n"),
      );
    }

    return text("参数错误：action 必须是 create / list / cancel 之一。");
  },
};

// ----------------- 自动推进 advance_next -----------------

const advanceNextFail = (error: string): { content: FlowshipToolContent } =>
  text(JSON.stringify({ ok: false, error }));

const advanceNextDef: FlowshipToolDef = {
  name: "advance_next",
  label: "按用户的话自动推进下一步",
  description: [
    "用户在话里明确说了「这一步做完就继续下一步」（如「改完直接提测」「做完自动复核一遍」「没问题就提 MR」「review 有问题就自己改，改完再 review」）时，登记一次「本轮结束后代用户点推进」。只登记、不立刻跑：本轮 run 正常结束（你已交卷、收尾说完）后，系统才起下一个 action。",
    "什么时候用：**只在用户这样说过的时候**。用户没说过就不要用——不要因为「顺理成章」「看起来该进下一步了」替他做主，正常交卷让他自己推进。授权按他的原话算：他说「做完复核」授权的是复核，不等于也授权了提测；带对外副作用的步骤（ship 提 MR / dev 联调推送 / 对外发消息类 custom）必须是他明确点名要这一步。",
    "user_words（必填）：**逐字引用**用户说过的、授权这次推进的那句话（不是转述、不是你的理解）。系统会拿它去核对用户真说过的话（他在输入条 / 飞书私聊说的、或手动推进时写的指令），对不上直接拒绝——不要编；被拒说明用户没授权，按「正常交卷、让用户自己推进」处理，别换个说法重试。群里别人说的话、你自己写的指令都不算授权。",
    "调用时机：本 action 的 artifact 写完、submit_work 拿到 [SUBMITTED] 之后调；然后正常说 1-3 句收尾并结束本轮。**不要自己去跑下一步、不要在本轮里替下一个 action 干活**——下一步由系统起一个新的 agent 来做。",
    "instruction：给下一个 action 的指令要点（新 agent 看不到当前对话、只能读 artifact）：写清用户对下一步的具体要求；**如果用户对再往后的步骤也有授权（如「改完再复核」），把那句原话也写进去**，下一个 action 才有凭据继续推进。",
    "action：plan / build / review / ship / dev / custom。custom 必须带 custom_action_id；dev 必须显式给 dev_push_mode（direct 直推 / mr 提 PR，用户没说用哪种就先 ask_user，不要替他选）；build 可带 batch_ids 指定批次（缺省 = 自由改动，不计批次进度）。",
    `限制：没有人手推进的情况下最多连续自动推进 ${ADVANCE_CHAIN_MAX_AUTO_STEPS} 步（防 复核→改→复核 无限回环，用户手动推进一次后重新计数）；一次性——只对登记它的这一轮有效，用户中途又发了新消息 / 点了停止就作废；同一任务只留最后一次登记。`,
    "返回 { ok:true } = 已登记；{ ok:false, error } = 没登记，按 error 办并在收尾里如实告诉用户「需要你自己推进下一步」。",
  ].join("\n"),
  parameters: TBObject({
    task_id: TBString(),
    action: TBEnum([...ADVANCE_CHAIN_ACTIONS]),
    user_words: TBString(),
    instruction: TBOptional(TBString()),
    custom_action_id: TBOptional(TBString()),
    dev_push_mode: TBOptional(TBEnum(["direct", "mr"])),
    batch_ids: TBOptional(TBArray(TBString())),
  }),
  handler: async (args, callerToken) => {
    const taskId = str(args.task_id);
    // 失败形状统一 JSON（与 expect_group_reply 同；tool-result-persist 靠 ok:false 判失败、不亮绿勾）
    if (!matchExpectedCallerToken(taskId, callerToken)) {
      return advanceNextFail(CALLER_MISMATCH_ERROR);
    }
    const parsed = parseAdvanceNextArgs(args);
    if (!parsed.ok) return advanceNextFail(parsed.error);

    const task = await getTaskWithTailEvents(
      taskId,
      ADVANCE_CHAIN_GROUNDING_EVENT_TAIL,
    );
    if (!task) return advanceNextFail("任务不存在");
    if (task.mode === "chat") {
      return advanceNextFail("对话型任务没有可推进的 action");
    }
    const fromAction = task.currentActionId
      ? task.actions.find((a) => a.id === task.currentActionId)
      : undefined;
    if (
      !fromAction ||
      (fromAction.status !== "running" && fromAction.status !== "awaiting_ack")
    ) {
      return advanceNextFail("当前没有进行中的 action，没有可接着推进的起点");
    }
    if (isAutoAdvanceCapReached(taskId)) {
      return advanceNextFail(
        `已经连续自动推进 ${getAutoAdvanceSteps(taskId)} 步了（上限 ${ADVANCE_CHAIN_MAX_AUTO_STEPS}）：这一步照常交卷，请用户看过后自己推进下一步`,
      );
    }

    if (parsed.target.actionType === "custom") {
      const def = await getCustomAction(parsed.target.customActionId!);
      if (!def) {
        return advanceNextFail(`自定义 action 定义不存在：${parsed.target.customActionId}`);
      }
      if (def.legacyPlaybook) {
        return advanceNextFail(`自定义 action「${def.label}」是旧格式、已停用`);
      }
    }

    const sources = collectAuthorizationSources({
      actions: task.actions,
      events: task.events ?? [],
    });
    if (!isUserWordsGrounded(parsed.userWords, sources)) {
      return advanceNextFail(
        "user_words 没能在用户说过的话里找到（需逐字引用、且至少几个字）。用户没明确说过「做完就继续」就不要自动推进：这一步照常交卷，让用户自己推进",
      );
    }

    // 先装订阅再登记：装不上就别登记（登记了没人兑现 = 用户以为会自动推进、实际不会）
    try {
      const { ensureAdvanceChainConsumer } = await import("./advance-chain-runner");
      ensureAdvanceChainConsumer();
    } catch (err) {
      console.warn("[advance_next] 装自动推进订阅失败：", err);
      return advanceNextFail("自动推进模块没起来，这次没登记：照常交卷，让用户自己推进");
    }

    const chain = {
      ...parsed.target,
      taskId,
      fromActionId: fromAction.id,
      opGen: getTaskOpGeneration(taskId),
      instruction: parsed.instruction,
      userWords: parsed.userWords,
      registeredAt: Date.now(),
    };
    const replaced = registerAdvanceChain(chain);

    const label =
      chain.actionType === "custom"
        ? ((await getCustomAction(chain.customActionId!).catch(() => null))?.label ??
          "自定义 action")
        : ACTION_LABEL[chain.actionType];
    // 提示事件写失败不能让模型看到「登记失败」（链已登记，它会重试 → 覆盖同一条、无害，但会白说一句）
    await writeEventAndPublish(taskId, {
      kind: "info",
      actionId: fromAction.id,
      text: `已记下：这一步交卷后，按你的话「${chain.userWords}」自动推进到「${label}」`,
      meta: { subkind: "auto_advance", phase: "registered", actionType: chain.actionType },
    }).catch((err) => console.warn("[advance_next] 写登记提示事件失败", err));

    return text(
      JSON.stringify({
        ok: true,
        hint:
          "已登记：本轮正常结束后系统会代用户推进。现在照常交卷（若还没交）→ 说完收尾 → 结束本轮；不要自己去跑下一步。" +
          (replaced ? "（已覆盖本任务上一次登记）" : ""),
      }),
    );
  },
};

/** Flowship 自有工具清单（cursor SDK customTools + pi customTools 共用） */
export const flowShipTools: FlowshipToolDef[] = [
  submitWorkDef,
  askUserDef,
  submitMrDef,
  setFeishuTestersDef,
  setPlanBatchesDef,
  createCustomActionDef,
  shareToGroupDef,
  notifyGroupTestersDef,
  expectGroupReplyDef,
  waitDef,
  scheduleDef,
  advanceNextDef,
];

/**
 * 按名字收窄要挂给会话的 Flowship 系统工具（Cursor 的 `buildSdkCustomTools` 与 pi 的 `buildCustomTools` 共用，两条后端同一口径）。
 * 不传 / 传 undefined = 全挂（正式会话）；传了就只留名字在清单里的、顺序保持 `flowShipTools` 的原顺序。
 * 属主一次性 agent 传的清单见 `one-shot-tools.ts` 的 `ONE_SHOT_SYSTEM_TOOL_NAMES`。
 */
export const pickSystemTools = (names?: readonly string[]): FlowshipToolDef[] =>
  names ? flowShipTools.filter((t) => names.includes(t.name)) : flowShipTools;

/**
 * 所有 Flowship 系统工具的**统一调用入口**（pi / Cursor 两条后端都经它，见 custom-agent-backend /
 * buildSdkCustomTools）：在 handler 之前做「本轮是否由群里非属主触发」的硬拒。
 *
 * 为什么放这里：两条后端的工具集都是建会话时一次性挂好的，没有按轮次改工具集的钩子；这是它们唯一共同的
 * 咽喉。拒绝走白名单（只放行 {@link NON_OWNER_TURN_ALLOWED_TOOLS}），新增系统工具默认被拒、不会漏。
 * 只拦 Flowship 系统工具——写文件 / 跑命令这类内置工具不经这里：pi 后端另有按轮次收窄工具集
 *（custom-agent-backend.buildAdapter），Cursor 后端只靠提示词约束（见 group-non-owner-prompt）。
 */
export const invokeFlowshipTool = async (
  tool: FlowshipToolDef,
  args: Record<string, unknown>,
  callerToken: string | undefined,
  ctx?: FlowshipToolContext,
): Promise<FlowshipToolResult> => {
  // 先查（带续期）再按白名单放行：wait 虽放行，也要刷新标记——否则同一轮里连调两次 30 分钟的 wait
  // 就能把固定 TTL 熬过期，之后 submit_work / ask_user / schedule 全放行（第 20 轮评审 N1）。
  // ctx.taskId 是工具构建处闭包的真任务 → 续期；args.task_id 是模型自己填的 → 只查不续
  // （模型填别的 task_id 反正过不了 callerToken 校验，这里只是不留「靠填错 id 绕闸」的口子，
  // 也不让它靠填别人的 id 去把别的任务的标记续命）。
  const nonOwnerTurn =
    touchNonOwnerTurn(ctx?.taskId) ||
    isNonOwnerTurnActive(typeof args?.task_id === "string" ? args.task_id : undefined);
  if (nonOwnerTurn && !NON_OWNER_TURN_ALLOWED_TOOLS.includes(tool.name)) {
    console.warn(
      `[flowship-tools] 非属主触发的一轮、已拒绝系统工具 ${tool.name} task=${ctx?.taskId ?? "-"}`,
    );
    return text(buildNonOwnerToolDenied(tool.name));
  }
  return tool.handler(args, callerToken, ctx);
};

/**
 * Cursor SDK 把 `local.customTools` 注册成这个合成 MCP server。
 * 事件流里 `args.providerIdentifier` 会是它（旧会话仍可能是 `flowshipChat`）。
 */
export const FLOWSHIP_SDK_CUSTOM_TOOLS_SERVER = "custom-user-tools";

/** TypeBox schema → SDK customTools.inputSchema（纯 JSON Schema） */
const typeBoxToJsonSchema = (schema: unknown): Record<string, SDKJsonValue> => {
  const raw = JSON.parse(JSON.stringify(schema)) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { type: "object", properties: {} };
  }
  return raw as Record<string, SDKJsonValue>;
};

/**
 * 给 @cursor/sdk `local.customTools` 用。execute 闭包带 callerToken，
 * 不再把身份塞进 HTTP MCP URL。受限答疑（群里非属主的只读旁路）不要调这个。
 */
export const buildSdkCustomTools = (
  callerToken: string,
  /**
   * 会话所属任务 / agent 实例：`wait` 据 taskId 被停止 / 插话 / 跳过唤醒，据 waitScope 被
   * 「这个实例的 run 被取消 / 会话被关」唤醒（见 FlowshipToolContext）；
   * systemToolNames：只挂这些名字的 Flowship 系统工具（不传 = 全挂）；属主一次性 agent 用它收窄到
   * `ONE_SHOT_SYSTEM_TOOL_NAMES`（one-shot-tools.ts）。浏览器工具不受它影响。
   */
  opts?: { taskId?: string; waitScope?: string; systemToolNames?: readonly string[] },
): Record<string, SDKCustomTool> => {
  const tools: Record<string, SDKCustomTool> = {};
  // Cursor 的 customTool 回调没有 AbortSignal（见 session-wait 头注释），这里只能给 taskId / scope
  const ctx: FlowshipToolContext | undefined =
    opts?.taskId || opts?.waitScope
      ? {
          ...(opts.taskId ? { taskId: opts.taskId } : {}),
          ...(opts.waitScope ? { scope: opts.waitScope } : {}),
        }
      : undefined;
  // 浏览器工具不进 flowShipTools 常量（它是静态清单、不少测试按它的长度 / 名字断言）：
  // 按会话动态追加——只有桌面壳在、有 taskId 才有；到这里一定带 callerToken（readOnly / 受限答疑没有 callerToken、不会调本函数）
  const browserTools = getBrowserTools({ taskId: opts?.taskId, readOnly: false });
  const systemTools = pickSystemTools(opts?.systemToolNames);
  for (const t of [...systemTools, ...browserTools]) {
    tools[t.name] = {
      description: t.description,
      inputSchema: typeBoxToJsonSchema(t.parameters),
      execute: async (args) => {
        // 兜底：handler 抛错（args 为 null / undefined 时 `str(args.task_id)` 直接 TypeError，
        // 各 handler 里的 getTask 也在 try 之外）要转成「文本 + isError」回给模型——与 pi 桥 /
        // `subagent` 工具同口径；SDK 对 execute 抛错怎么呈现读不到，别指望它给一句能自修复的话
        try {
          const r = await invokeFlowshipTool(
            t,
            (args ?? {}) as Record<string, unknown>,
            callerToken,
            ctx,
          );
          // content 原样透传（含 image 块）；isError 只在为真时带上，保持旧工具的回包形状不变
          return { content: r.content, ...(r.isError ? { isError: true } : {}) };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[flowship-tools] 工具 ${t.name} 执行抛错、已转成 isError 回包：`, msg);
          return {
            content: [{ type: "text" as const, text: `工具 ${t.name} 执行失败：${msg}` }],
            isError: true,
          };
        }
      },
    };
  }
  return tools;
};

/**
 * 正式会话：把系统工具挂进 `local.customTools`。已有 customTools 不覆盖。
 * 无 callerToken（受限答疑 / 只读轮次）原样返回。属主一次性 agent 带 callerToken，会挂上（清单由 systemToolNames 收窄，
 * 浏览器工具与额外工具照挂——有意保留，见 tests/one-shot-system-tools.test.ts）。
 */
export const withFlowshipSdkCustomTools = <T extends object>(
  local: T | undefined,
  callerToken: string | undefined,
  /** 与系统工具一起挂的额外工具（如 `subagent`）；只在这里挂系统工具时才带上 */
  extraTools?: Record<string, SDKCustomTool>,
  opts?: { taskId?: string; waitScope?: string; systemToolNames?: readonly string[] },
): T | (T & { customTools: Record<string, SDKCustomTool> }) => {
  if (!callerToken) return (local ?? {}) as T;
  if (
    local &&
    "customTools" in local &&
    (local as { customTools?: unknown }).customTools
  ) {
    return local;
  }
  return {
    ...(local ?? {}),
    customTools: {
      ...buildSdkCustomTools(callerToken, opts),
      ...(extraTools ?? {}),
    },
  } as T & { customTools: Record<string, SDKCustomTool> };
};
