/**
 * Flowship 自有工具（交卷 / 提问 / 提 MR / 测试人员 / 批次 / 挂 action / 分享群）的
 * 「与传输无关」定义——同一套工具同时供两条链路用：
 *   - cursor 路径：chat-mcp.ts 的 flowshipChat MCP server（zod schema）
 *   - custom 路径：pi 的 customTools（TypeBox schema，见 custom-agent-backend.ts）
 *
 * 工具名必须与 prompt 教的一致（submit_work / ask_user / submit_mr / set_feishu_testers /
 * set_plan_batches / create_custom_action / share_to_group）、sdk-message-handler 也按
 * 这些名字 + 返回文案（[SUBMITTED] / [ASK_SUBMITTED]）判定交卷/提问成功。
 *
 * handler 复用 chat-pending 的原语（runTaskAction / safeNotify* / registerPendingAsk）
 * 与 chat-mcp 已导出的同口径分派（dispatchSubmitWorkForTest / dispatchAskUserForTest）、
 * 避免和 MCP 路径逻辑分叉。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
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
  matchExpectedCallerToken,
  runTaskAction,
  type AskUserQuestion,
} from "./chat-pending";
import {
  askSubmittedText,
  dispatchAskUserForTest,
  dispatchSubmitWorkForTest,
} from "./chat-mcp";
import { createCustomAction } from "./custom-action-fs";
import { getAppSkillsDir } from "./skills-loader";
import { getTask } from "./task-fs";

export type FlowshipToolContent = Array<{ type: "text"; text: string }>;

export interface FlowshipToolDef {
  name: string;
  label: string;
  description: string;
  /** TypeBox schema（pi customTools 用；cursor 路径仍走 chat-mcp 的 zod） */
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

// ----------------- 交卷 submit_work -----------------

const submitWorkDef: FlowshipToolDef = {
  name: "submit_work",
  label: "交卷：宣告当前 action 完成",
  description: [
    "Task 模式（action 容器）专用：完成一个 action（写完 artifact）后调本工具交卷。",
    "系统后台跑质量检查后通知用户审阅。非阻塞、立即返回。",
    "调完把要给用户的话说完再结束本轮；不要轮询 / 重复调本工具。",
    "Chat 模式（自由对话）不需要调本工具。",
  ].join("\n"),
  parameters: TBObject({
    task_id: TBString(),
    message: TBOptional(TBString()),
    action_id: TBOptional(TBString()),
    artifact_path: TBOptional(TBString()),
  }),
  handler: async (args, callerToken) => {
    const r = await dispatchSubmitWorkForTest({
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
    "返回 [ASK_SUBMITTED] 后结束本轮即可；提问后再说会被静音（用户看不见），说不说都行；答案以 [ASK_USER_REPLY] 新消息送达。",
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
    const r = await dispatchAskUserForTest({
      taskId: str(args.task_id),
      callerToken,
      actionId: str(args.action_id) || undefined,
      questions,
    });
    return text(r.ok ? askSubmittedText(r.askId) : r.error);
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
    "入参：task_id、content（必填）、title / kind(artifact|message|question) / links([{label,url}]) 可选。",
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

/** Flowship 自有工具清单（custom provider 的 pi customTools 数据源） */
export const flowShipTools: FlowshipToolDef[] = [
  submitWorkDef,
  askUserDef,
  submitMrDef,
  setFeishuTestersDef,
  setPlanBatchesDef,
  createCustomActionDef,
  shareToGroupDef,
];
