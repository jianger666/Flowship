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

import { promises as fs } from "node:fs";
import path from "node:path";
import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
// TypeBox 1.x 把这些构造器作为顶层具名导出（会 shadow JS 全局、统一加 TB 前缀）
import {
  Array as TBArray,
  Boolean as TBBoolean,
  Enum as TBEnum,
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
import { buildAskWaitCurl, openAskWait } from "./ask-wait";
import { createCustomAction } from "./custom-action-fs";
import { getAppSkillsDir } from "./skills-loader";
import { getTask } from "./task-fs";
import { writeEventAndPublish } from "./task-stream";

export type FlowshipToolContent = Array<{ type: "text"; text: string }>;

export interface FlowshipToolDef {
  name: string;
  label: string;
  description: string;
  /** TypeBox schema（pi customTools + Cursor SDK customTools 共用） */
  parameters: unknown;
  handler: (
    args: Record<string, unknown>,
    callerToken: string | undefined,
  ) => Promise<{ content: FlowshipToolContent }>;
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
    const raw = (Array.isArray(args.questions) ? args.questions : []) as Array<{
      id?: unknown;
      question?: unknown;
      options?: Array<{ id?: unknown; label?: unknown }>;
      allow_text?: unknown;
    }>;
    const questions: AskUserQuestion[] = raw.map((q) => ({
      id: str(q.id),
      question: str(q.question).trim(),
      options: Array.isArray(q.options)
        ? q.options.map((o) => ({ id: str(o.id), label: str(o.label) }))
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

const shareToGroupDef: FlowshipToolDef = {
  name: "share_to_group",
  label: "分享到飞书需求群（产物 / 疑问 / 进展）",
  description: [
    "把内容以互动卡片发到当前任务关联飞书工作项的需求群。",
    "只在用户明确要求分享 / playbook 编排时调；不要自行滥发。",
    "提测在需求群 @ 测试人员不要走本工具，用 notify_group_testers。",
    "入参：task_id、content（必填）、title / kind(artifact|message|question) / links([{label,url}]) / at([名字]) 可选。",
    "at 是通用 @：传中文名或邮箱，卡片正文自动 @ 并推送；精确匹配才@，换不出/重名进返回的 at.unresolved（不挡发送）。artifact 卡无正文、at 会全进 unresolved。",
    "返回 { ok, chatName?, messageId?, docMessageId? } 或 { ok:false, error, code? }——失败如实转告用户、不要自行重试。",
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
    try {
      const result = await shareToRequirementGroup(
        task,
        {
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
        },
        { verifyOwnerMembership: true },
      );
      return text(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
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
];

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
 * 不再把身份塞进 HTTP MCP URL。oneshot / 受限答疑不要调这个。
 */
export const buildSdkCustomTools = (
  callerToken: string,
): Record<string, SDKCustomTool> => {
  const tools: Record<string, SDKCustomTool> = {};
  for (const t of flowShipTools) {
    tools[t.name] = {
      description: t.description,
      inputSchema: typeBoxToJsonSchema(t.parameters),
      execute: async (args) => {
        const r = await t.handler(args, callerToken);
        return { content: r.content };
      },
    };
  }
  return tools;
};

/**
 * 正式会话：把系统工具挂进 `local.customTools`。已有 customTools 不覆盖。
 * 无 callerToken（oneshot / 受限答疑）原样返回。
 */
export const withFlowshipSdkCustomTools = <T extends object>(
  local: T | undefined,
  callerToken: string | undefined,
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
    customTools: buildSdkCustomTools(callerToken),
  } as T & { customTools: Record<string, SDKCustomTool> };
};
