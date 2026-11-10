/**
 * 需求群回流（第二批 · 出向）
 *
 * 一个全局 task 流 tap（对齐 outbound.ensureFeishuOutboundRegistered）干三件事：
 *
 * 1. **ask 卡发群**：agent 调 ask_user → 若开了「问题同步到需求群」且该任务绑了群，
 *    把答题卡也发一份到群（跨角色答题；按钮回调是 card.action.trigger、天然只到属主本机）
 * 2. **回答回群**：群里 @bot 提的问题，边出边推一张流式卡（group-card-stream；开关 = 任务级覆盖 > 设置页
 *    全局「流式回复」）。版式照私聊流式卡：正文 = **累积全文**（已收段落 + 当前段，只增不换）、
 *    思考 / 工具进「思考与工具」折叠面板、收尾 header 变已完成 / 处理失败并带耗时 · 模型；done 时整卡定稿。
 *    （2026-11-09 前只推 / 只发「最后一次工具调用之后」那段，卡上永远只有一句话——已撤。）
 *    不再有回复协议（2026-11-06 撤）：agent 写什么发什么，只剩首行 NO_REPLY 不发（group-silent-reply）、
 *    真人提问人开头固定 @。机器人提问人失败 / 空回答一律静默（防两个机器人互 @ 成环）。
 *    群里的文字（回答正文 / 短状态回执）一律发**文本卡**（`lark-api.sendMarkdownCardToChat`），
 *    不再发 text / post；上游仍按 `<at user_id>` 拼 @，发送前统一转成卡片写法。
 *    攒 / flush **只认事件 origin 与登记 runTag 相等的那一路 run**（token 化投递协议、
 *    见 group-shared）——属主 run 和多位同事的旁路答疑 run 同时在飞也各回各的
 * 3. **推进产物回群**：群内「推进 xxx」跑完，把 action 产物以 share 卡发回群
 *    （受「群内推进结果回群」开关控制）；与自动播报共用 group-shared 那张产物卡
 *    防重表、先占再发，两条链只出一张卡。
 *    ⚠️ 推进的收口判据是 **action 状态**、不是 turn 结束——见 flushGroupAdvanceReply
 *
 * 外加一个收口器：推进登记的租约到点时 group-shared 会把判定推给本模块
 *（reviewExpiredGroupAdvance）——只有这里读得到 action 状态、也只有这里发得出回执。
 *
 * 全程 best-effort：任何一步失败只 warn，绝不影响 task 主链（对齐坑 #10）。
 */

import { promises as fs } from "node:fs";

import { redactSecretsInText } from "@/lib/server/event-secret-redact";

import type { ShareToGroupInput } from "@/lib/server/feishu-group";
import { getActionArtifactPath } from "@/lib/server/task-fs-core";
import {
  subscribeAllTaskStreams,
  writeEventAndPublish,
  type TaskStreamEvent,
} from "@/lib/server/task-stream";
import { buildGroupQaSummaryEvent } from "@/lib/group-qa";
import { getTask } from "@/lib/server/task-fs";
import {
  setTalkQueueGroupOtherDropHandler,
  type GroupOtherDroppedInfo,
} from "@/lib/server/task-talk-queue";
import { ACTION_LABEL, type Task } from "@/lib/types";

import {
  isAdvanceResultToGroupEnabled,
  isAskToGroupEnabled,
  isFeishuBridgeStreamingEnabled,
  isFeishuChatBridgeEnabled,
} from "./bridge-config";
import { parseAskVoidMarker, settleAskCardsOnVoidMarker } from "./ask-stale";
import { rememberAskCard } from "./card-map";
import { buildGroupAskCardJson } from "./group-ask-card";
import { noteGroupSendFailure } from "./group-failure-notice";
import {
  createGroupCardStream,
  type GroupCardStream,
} from "./group-card-stream";
import {
  acceptGroupReplyMessage,
  appendGroupReplyAnswer,
  claimGroupArtifactCard,
  closeGroupReplySegment,
  groupQuestionQueueLength,
  hasAnyGroupReplyText,
  hasGroupReplies,
  mentionTag,
  peekGroupReply,
  peekGroupReplyByToken,
  releaseGroupAdvancePick,
  releaseGroupAdvancePickByAction,
  releaseGroupArtifactCard,
  rememberGroupReply,
  renewGroupReply,
  setGroupAdvanceExpiryHandler,
  setGroupQuestionDroppedHandler,
  takeGroupReplyByToken,
  truncateForGroup,
  visibleGroupReplyText,
  type GroupQuestionDroppedReason,
  type PendingGroupReply,
} from "./group-shared";
import {
  sendInteractiveCardToChat,
  sendMarkdownCardToChat,
} from "./lark-api";
import {
  argsSummaryFromMeta,
  renderProcess,
  toolNameFromMeta,
  type ProcessPart,
} from "./outbound";
import type { CardStreamAskQuestion } from "./types";

const LOG = "[feishu-bridge/group-outbound]";

const warn = (op: string, err: unknown): void => {
  console.warn(`${LOG} ${op} 失败（静默）:`, err instanceof Error ? err.message : err);
};

// ----------------- 可注入依赖（单测 mock 外部调用） -----------------

export interface GroupOutboundDeps {
  getTask: typeof getTask;
  getBoundGroupChatId: (
    task: Pick<Task, "feishuStoryUrl">,
  ) => Promise<string | null>;
  resolveSenderName: () => Promise<string>;
  sendAskCard: typeof sendInteractiveCardToChat;
  /** 短状态回执（推进失败 / 没产物 / 到期）：发出去是卡片，入参仍是纯文本 + `<at user_id>` */
  sendText: typeof sendMarkdownCardToChat;
  /** 群答疑正文：markdown 卡片，会渲染粗体 / 代码 / 列表（与 sendText 同一个出口、两个依赖名只为单测分开断言） */
  sendMarkdown: typeof sendMarkdownCardToChat;
  shareToGroup: (task: Task, input: ShareToGroupInput) => Promise<unknown>;
  rememberAskCard: typeof rememberAskCard;
  isBridgeEnabled: typeof isFeishuChatBridgeEnabled;
  isAskToGroupEnabled: typeof isAskToGroupEnabled;
  isAdvanceResultToGroupEnabled: typeof isAdvanceResultToGroupEnabled;
  readArtifact: (absPath: string) => Promise<string>;
  /**
   * 排队 draining（答完 / 动作终态后泵一次，空队秒回）。group-route 的实现、
   * 这里动态 import（出向挂在 bootstrap 启动链上，静态连边会成环，见下注释）。
   */
  pumpGroupQuestionQueue: (taskId: string) => Promise<void>;
  /** 全局「流式回复」开关（设置页）；任务级覆盖在 isGroupStreamingEnabled 里叠加 */
  isStreamingEnabled: () => Promise<boolean>;
  /** 建一张群答疑流式卡（按 chat_id 发到群里；首次 push 才真建卡）。`title` = 卡片 header 标题（任务标题） */
  createGroupCardStream: (
    chatId: string,
    opts?: { title?: string },
  ) => GroupCardStream;
}

/**
 * feishu-group 一律走动态 import——它静态引 meegle-cli，而本模块挂在 bootstrap
 * 启动链上；静态连边会让「把 meegle-cli 整个 mock 掉」的 ownership 单测在 import
 * 阶段炸 missing export（同 group-route 的处理）。
 */
const defaultDeps = (): GroupOutboundDeps => ({
  getTask,
  getBoundGroupChatId: async (task) =>
    (await import("@/lib/server/feishu-group")).getBoundGroupChatId(task),
  resolveSenderName: async () =>
    (await import("@/lib/server/feishu-group")).resolveShareSenderName(),
  sendAskCard: sendInteractiveCardToChat,
  sendText: sendMarkdownCardToChat,
  sendMarkdown: sendMarkdownCardToChat,
  shareToGroup: async (task, input) =>
    (await import("@/lib/server/feishu-group")).shareToRequirementGroup(
      task,
      input,
    ),
  rememberAskCard,
  isBridgeEnabled: isFeishuChatBridgeEnabled,
  isAskToGroupEnabled,
  isAdvanceResultToGroupEnabled,
  readArtifact: (absPath) => fs.readFile(absPath, "utf-8"),
  pumpGroupQuestionQueue: (taskId) =>
    import("./group-route").then((m) => m.pumpGroupQuestionQueue(taskId)),
  isStreamingEnabled: isFeishuBridgeStreamingEnabled,
  createGroupCardStream: (chatId, opts) =>
    createGroupCardStream({ chatId, title: opts?.title }),
});

let deps: GroupOutboundDeps = defaultDeps();

/**
 * 群里发一条短状态回执（推进失败 / 没产物 / 到期 …）。发送失败不抛：warn + 在任务事件流留一条 info，
 * 让属主看得见（群里文字走卡片、缺 `cardkit:card:write` 之类时回执自己就发不出去，见 group-failure-notice）。
 * 调用点都是各自分支的最后一步，吞掉失败与原先「抛给外层 catch 只 warn」在流程上等价。
 */
const sendReceipt = async (
  taskId: string,
  chatId: string,
  text: string,
): Promise<void> => {
  try {
    await deps.sendText(chatId, text);
  } catch (err) {
    warn(`群回执发送失败 task=${taskId}`, err);
    await noteGroupSendFailure(taskId, chatId, err, "回执");
  }
};

// ----------------- 桥接开关缓存（对齐 p2p outbound） -----------------
//
// 有登记等着回群时，`assistant_delta` 是**每 token 一发**——每条都去 readSettingsFile
// 读一次 config.json 就是一轮回答几百次同步读盘。短 TTL 足够：用户在设置页关桥接后
// 最多多跑几秒的群回流。

const BRIDGE_ENABLED_TTL_MS = 8_000;

let bridgeEnabledCache: { value: boolean; at: number } | null = null;

const isBridgeEnabledCached = async (): Promise<boolean> => {
  const now = Date.now();
  if (
    bridgeEnabledCache &&
    now - bridgeEnabledCache.at < BRIDGE_ENABLED_TTL_MS
  ) {
    return bridgeEnabledCache.value;
  }
  const value = await deps.isBridgeEnabled();
  bridgeEnabledCache = { value, at: now };
  return value;
};

/** 单测替换依赖；传 null 恢复 */
export const __setGroupOutboundDepsForTest = (
  partial: Partial<GroupOutboundDeps> | null,
): void => {
  deps = partial ? { ...defaultDeps(), ...partial } : defaultDeps();
  // 换了依赖 = 缓存里那个值来自上一套 mock，必须作废
  bridgeEnabledCache = null;
};

// ----------------- done 后的排空重试 -----------------

/**
 * done 帧上 pump 撞见「还在忙」时的短延迟重试间隔（逐次补一圈，用完即止）。
 *
 * 为什么需要：task-runner 先 publish done、**之后**才 `await finalizeOpenToolCalls` 并 `runningTasks.delete`，
 * 而 pump 判「忙」用的是 `runningTasks.has(id) || runStatus === "running"`——done 帧上立刻 pump，
 * 多半落在这个收尾窗口里：队首被静默放回，之后没有任何帧再触发排空，排队的同事只能等下一条群 @
 * 或 30 分钟后收到「超时作废」。这里不去改 task-runner 的收尾顺序（它牵着一堆 lease / 闩锁语义），
 * 只在出向侧补几次重试把窗口盖住；真有新 run 接着跑就一直忙，重试用完即停、等那个 run 自己的 done。
 */
export const GROUP_PUMP_RETRY_DELAYS_MS = [300, 1_200, 4_000] as const;

/** 有重试链在跑的 task（同一 task 同时只留一条链，连着来的 done 帧不堆定时器） */
const pumpRetryActive = new Set<string>();
const pumpRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

const armPumpRetries = (taskId: string): void => {
  if (pumpRetryActive.has(taskId)) return;
  if (groupQuestionQueueLength(taskId) === 0) return;
  pumpRetryActive.add(taskId);
  let step = 0;
  const arm = (): void => {
    const timer = setTimeout(() => {
      pumpRetryTimers.delete(taskId);
      void (async () => {
        try {
          await deps.pumpGroupQuestionQueue(taskId);
        } catch (err) {
          // 排空失败不抛：下一圈 / 下一个 done 帧还会再来
          console.warn(`${LOG} done 后排空重试失败 task=${taskId}：`, err);
        }
        step += 1;
        if (step < GROUP_PUMP_RETRY_DELAYS_MS.length && groupQuestionQueueLength(taskId) > 0) {
          arm();
        } else {
          pumpRetryActive.delete(taskId);
        }
      })();
    }, GROUP_PUMP_RETRY_DELAYS_MS[step]);
    // 不拦进程退出
    timer.unref?.();
    pumpRetryTimers.set(taskId, timer);
  };
  arm();
};

const clearPumpRetries = (): void => {
  for (const timer of pumpRetryTimers.values()) clearTimeout(timer);
  pumpRetryTimers.clear();
  pumpRetryActive.clear();
};

// ----------------- ask 卡发群 -----------------

/** 从 ask_user_request 事件 meta 抠 askId + questions（形状对齐 card-stream） */
export const askOptsFromGroupEvent = (
  meta: Record<string, unknown> | undefined,
): { askId: string; questions: CardStreamAskQuestion[] } | null => {
  if (!meta) return null;
  const askId = typeof meta.askId === "string" ? meta.askId : "";
  if (!askId || !Array.isArray(meta.questions)) return null;
  const questions: CardStreamAskQuestion[] = [];
  for (const raw of meta.questions as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const q = raw as Record<string, unknown>;
    if (typeof q.id !== "string" || typeof q.question !== "string") continue;
    const options: Array<{ id: string; label: string }> = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options as unknown[]) {
        if (!o || typeof o !== "object") continue;
        const opt = o as Record<string, unknown>;
        if (typeof opt.id === "string" && typeof opt.label === "string") {
          options.push({ id: opt.id, label: opt.label });
        }
      }
    }
    questions.push({
      id: q.id,
      question: q.question,
      ...(options.length > 0 ? { options } : {}),
    });
  }
  return questions.length > 0 ? { askId, questions } : null;
};

/**
 * 把 ask 答题卡也发一份到需求群。
 *
 * card-map 里记两件事：
 * - **路由判据 `taskId` 记空串**——群卡片不该参与 p2p 回复锚定（被 p2p 直发误命中）
 * - **ask 索引 `(askTaskId, askId)`**——这组提问不管从哪个入口了结（app 答题 / 群里打字 /
 *   用户跳过），`ask-card-settle` 都能反查到这张卡把它置成终态（原来只有「从这张卡点按钮」
 *   那一条分支会置态，别处答完群里这张卡一直挂着像待答）
 */
export const sendAskCardToGroup = async (
  task: Task,
  askId: string,
  questions: CardStreamAskQuestion[],
): Promise<void> => {
  const chatId = await deps.getBoundGroupChatId(task);
  // 无群静默跳过：只打 warn 不写事件（问群卡高频，事件流别脏；和播报 skipped_no_group 同口径，review 十二轮-1）
  if (!chatId) {
    warn("问群卡无群跳过", `task=${task.id} ask=${askId}`);
    return;
  }
  let senderName = "Flowship";
  try {
    senderName = await deps.resolveSenderName();
  } catch {
    /* 署名兜底、不阻断发卡 */
  }
  const card = buildGroupAskCardJson({
    requirementName: task.title || task.id,
    taskId: task.id,
    chatId,
    askId,
    questions,
    senderName,
  });
  let sent: Awaited<ReturnType<typeof deps.sendAskCard>>;
  try {
    sent = await deps.sendAskCard(chatId, card);
  } catch (err) {
    // 问群卡发不出去：属主在群里等不到题、app 里答题照常——让他知道群里为什么没卡；异常照旧抛给调用方
    await noteGroupSendFailure(task.id, chatId, err, "问群卡");
    throw err;
  }
  try {
    await deps.rememberAskCard({
      messageId: sent.message_id,
      cardId: sent.card_id,
      routeTaskId: "",
      askTaskId: task.id,
      askId,
    });
  } catch (err) {
    // 记不上只影响答完后的卡片置态、答题本身照常
    warn("rememberAskCard(group ask)", err);
  }
};

const handleAskUserRequest = async (
  taskId: string,
  meta: Record<string, unknown> | undefined,
): Promise<void> => {
  if (!(await deps.isAskToGroupEnabled())) return;
  const opts = askOptsFromGroupEvent(meta);
  if (!opts) return;
  const task = await deps.getTask(taskId);
  if (!task) return;
  await sendAskCardToGroup(task, opts.askId, opts.questions);
};

// ----------------- 回答 / 产物回群 -----------------

/** 读本次推进 action 的 artifact 正文；读不到返 null（回退到 agent 旁白） */
const readActionArtifact = async (
  task: Task,
  actionId: string,
): Promise<{ text: string; label: string } | null> => {
  const action = task.actions.find((a) => a.id === actionId);
  if (!action) return null;
  const label =
    action.type === "custom"
      ? action.customLabel?.trim() || ACTION_LABEL.custom
      : (ACTION_LABEL[action.type as keyof typeof ACTION_LABEL] ?? action.type);
  if (!action.artifactPath) return null;
  try {
    const abs = getActionArtifactPath(task.id, action.n, action.type);
    const content = await deps.readArtifact(abs);
    if (!content.trim()) return null;
    return { text: content, label };
  } catch (err) {
    warn("读 artifact", err);
    return null;
  }
};

/**
 * 一条推进登记此刻该怎么收口。
 * - `running`：**先别 take**，原样挂着等下一帧
 * - `ok`：action 已落成功终态，发产物
 * - `failed`：action 被停 / 报错、或 run 直接挂了，发失败文案
 */
type AdvancePhase =
  | { phase: "running" }
  | { phase: "ok"; task: Task; actionId: string }
  | { phase: "failed" };

/**
 * 推进登记的收口判据——**看 action 状态，不看 turn 结束**（第五轮双审 P1-A）。
 *
 * `done` 是 turn 级语义：agent 跑到一半调 `ask_user` 就会自然结束 turn 并发一帧
 * `done(ok=true)`，此时 artifact 根本还没写。按 done 收口的后果三连：产物读不到 →
 * 回落成 agent 半程旁白 → 以「产物卡」发进群，顺手把防重坑占死，真产物再也发不出去。
 * 所以只认 action 的终态；`running`（含等 ask 答案）一律继续等，后置检查落
 * `awaiting_ack` 时 publish 的那帧 task / action 会再来敲一次。
 *
 * 唯一不看 action 状态的出口是 `ok === false`：run 真挂了 / 被停时有的失败路径来不及
 * 标 action，不收口就是登记挂到 TTL 过期、群里永远等不到回音。
 */
const resolveAdvancePhase = async (
  taskId: string,
  entry: PendingGroupReply,
  ok: boolean,
): Promise<AdvancePhase> => {
  const task = await deps.getTask(taskId);
  if (!task) return { phase: "failed" };
  if (!ok) return { phase: "failed" };
  // actionId 由 advanceTask 返回后补记——还没补上就是「这轮还没真正开跑」，继续等。
  // ⛔ 别退回 task.currentActionId 顶包：那多半是上一轮已交卷的 action，
  //    一帧 task 就能把**别人的旧产物**当本轮结果发进群
  const actionId = entry.actionId ?? "";
  const action = actionId
    ? task.actions.find((a) => a.id === actionId)
    : undefined;
  if (!action || action.status === "running") return { phase: "running" };
  if (action.status === "cancelled" || action.status === "error") {
    return { phase: "failed" };
  }
  return { phase: "ok", task, actionId };
};

/**
 * 推进登记收口：action 落终态才 take、按状态决定发产物还是发失败文案。
 *
 * 还在跑就原样挂着——`ask_user` 等人隔夜作答也照挂，group-shared 的四条清理链
 * 都不会静默摘走它（见那边的「advance 登记的保活策略」）；租约到点由
 * {@link reviewExpiredGroupAdvance} 来问一句，真收不了尾才摘 + 回执。
 */
const flushGroupAdvanceReply = async (
  taskId: string,
  pending: PendingGroupReply,
  ok: boolean,
): Promise<void> => {
  const resolved = await resolveAdvancePhase(taskId, pending, ok);
  if (resolved.phase === "running") return;
  // 上面这段 await 里可能已被别的帧收口（per-task 串行链只保证不交错、不保证唯一）；
  // 按 token 摘——那段 await 里属主那格可能已换成下一轮推进的登记
  const entry = takeGroupReplyByToken(taskId, pending.token);
  if (!entry) return;
  // 收口放坑：这轮跑完了，同卡允许再点别的按钮（十四轮 P2）。开关关不关都放——
  // 坑防的是“重复开跑”，开关管的是“回不回群”，两回事。直放 pickId + 按 action 兜底
  //（老登记没 pickId、只靠 bind 补记的那种）。
  if (entry.advancePickId) releaseGroupAdvancePick(entry.advancePickId);
  if (entry.actionId) releaseGroupAdvancePickByAction(taskId, entry.actionId);
  if (!(await deps.isAdvanceResultToGroupEnabled())) return;

  const at = mentionTag(entry.requesterOpenId, entry.requesterName);
  if (resolved.phase === "failed") {
    await sendReceipt(taskId, entry.chatId, `${at} 推进没跑成功、去 Flowship 看事件流`);
    return;
  }

  const { task, actionId } = resolved;
  const artifact = await readActionArtifact(task, actionId);
  if (!artifact) {
    // action 已终态还没 artifact = 这轮真没出文档。旁白按文本回、**绝不冒充产物卡**
    //（也就不占防重坑——那张坑位只属于真产物）
    const narration = truncateForGroup(entry.answer.trim());
    await sendReceipt(
      taskId,
      entry.chatId,
      narration ? `${at} 已跑完：${narration}` : `${at} 已跑完（没有产出文档）`,
    );
    return;
  }
  // 与自动播报共用同一张产物卡防重表、先占再发（占坑同步、中间零 await）。
  // 占不到 = 播报侧已经在发同一份产物：上面 takeGroupReply 已把登记摘走、
  // 它的预筛会扑空并照发，这里再发就是群里两张一模一样的卡（P2-1）。
  // 但发起人还等着交代：卡片那边不 @ 人（artifact 无正文拼不上 @），这里补一句
  // 轻提醒（review 十一轮-1）。能到这里的都是属主本人（路由层 + 回调层双验），@ 没事。
  if (!claimGroupArtifactCard(taskId, actionId)) {
    await sendReceipt(taskId, entry.chatId, `${at} 刚交卷，产物见上卡`);
    return;
  }
  try {
    await deps.shareToGroup(task, {
      kind: "artifact",
      title: artifact.label,
      content: artifact.text,
    });
  } catch (err) {
    // 一张卡都没发出去 → 退坑，别把播报侧也一起堵死
    releaseGroupArtifactCard(taskId, actionId);
    warn("产物发群", err);
    // 产物没发出去本身也让属主看得见（兜底回执若也发不出去，下面 sendReceipt 的那条被同群节流吃掉，这条已经写了）
    await noteGroupSendFailure(taskId, entry.chatId, err, "产物");
    await sendReceipt(taskId, entry.chatId, `${at} 已跑完，但产物没发出来（去 Flowship 看）`);
  }
};

// ----------------- 答疑回复（question 登记）的出向落地 -----------------
//
// 2026-11-06 用户拍板：「协议不用管，AI 自己判断就行」+「群里流式跟着 lk-harness 的来」——
// 原先的回复协议（`@名字` 换真 @ / `[[需属主确认]]` 标记 / NO_REPLY 的各种变体）整套删掉：
// 群里发的就是 agent 写的原样（卡片 markdown，`<at user_id>` 由 lark-api 转卡片写法），
// 边出边推（group-card-stream）。只留两条系统层规矩：
// ① 回复首行是 NO_REPLY → 不发（group-silent-reply；流式下首行没写完不起卡）；
// ② 提问人是真人 → 系统在开头固定 @ 他（机器人不补：想让机器人看见，AI 自己写 @）；
//    机器人提问人失败 / 空回答一律静默（群里绝不出现「Flowship / 事件流」）。
// 答案仍是「最后一次工具调用之后那段」——中途「我先查一下…」的旁白不进最终回复
//（流式中会短暂出现在卡上，收尾整卡换成终稿）。

/** 真人提问人：这轮跑失败时发给群的中性提示（外部同事没有 Flowship，别让他去看事件流） */
const GROUP_FAIL_HINT = "这轮我没答上来，麻烦再 @ 我一次";
/** 真人提问人：这轮跑成功但没有任何文字时的提示 */
const GROUP_EMPTY_HINT = "这轮我没整理出回复，麻烦再 @ 我一次";
/** 机器人提问人时群里不发、只进群问答卡的审计文案（问答卡在属主的 Flowship 里，可以提 ta） */
const BOT_FAIL_NOTE = "这轮没跑成功（提问方是机器人，群里未回复）";
const BOT_EMPTY_NOTE = "这轮没有文字回复（提问方是机器人，群里未回复）";

/** 单条群消息字数上限 / 最多发几条 */
export const GROUP_REPLY_CHUNK_MAX = 1800;
export const GROUP_REPLY_MAX_CHUNKS = 3;
const GROUP_REPLY_OMITTED_TAIL = "（内容较长，后半已省略）";

/**
 * 一段文本里的 `max` 位置不能落在 `<at ...>名字</at>` 中间：切断标签群里就是一堆乱码。
 * 落在标签里就把切点挪到标签起点（标签在开头无处可挪就放弃、照原位切）。
 */
const avoidSplittingAtTag = (text: string, cut: number): number => {
  const open = text.lastIndexOf("<at", cut - 1);
  if (open <= 0) return cut;
  const close = text.indexOf("</at>", open);
  return close >= 0 && close + "</at>".length > cut ? open : cut;
};

/** 单段超长：优先在句号 / 换行处切，找不到再硬切（不切断 at 标签） */
const hardSplit = (text: string, max: number): string[] => {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    for (let i = window.length - 1; i >= Math.floor(max / 2); i--) {
      if ("\n。！？!?；;".includes(window[i]!)) {
        cut = i + 1;
        break;
      }
    }
    if (cut < 0) {
      // 英文句点要求后面跟空白，免得切在小数点 / 域名里
      for (let i = window.length - 2; i >= Math.floor(max / 2); i--) {
        if (window[i] === "." && /\s/.test(window[i + 1]!)) {
          cut = i + 1;
          break;
        }
      }
    }
    if (cut < 0) cut = max;
    cut = avoidSplittingAtTag(rest, cut);
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
};

/**
 * 答疑回复切块：按段落（空行）贪心装进每条 ≤ `GROUP_REPLY_CHUNK_MAX` 的消息，
 * 单段超长按句号 / 换行硬切；最多 `GROUP_REPLY_MAX_CHUNKS` 条，还装不下的在最后一条末尾
 * 注明「后半已省略」。**不提 Flowship**——收到的是外部同事 / 机器人，他们没有它。
 * 真 @ 只在 text 里原有的位置（协议已把 @ 放在开头 / 正文里），后续块不再补 @。
 */
export const splitGroupReplyChunks = (
  text: string,
  maxLen = GROUP_REPLY_CHUNK_MAX,
  maxChunks = GROUP_REPLY_MAX_CHUNKS,
): string[] => {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= maxLen) return [t];
  const pieces = t
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length > maxLen ? hardSplit(p, maxLen) : [p]));
  const chunks: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (!cur) {
      cur = p;
    } else if (cur.length + 2 + p.length <= maxLen) {
      cur = `${cur}\n\n${p}`;
    } else {
      chunks.push(cur);
      cur = p;
    }
  }
  if (cur) chunks.push(cur);
  if (chunks.length <= maxChunks) return chunks;
  const kept = chunks.slice(0, maxChunks);
  kept[maxChunks - 1] = `${kept[maxChunks - 1]}\n${GROUP_REPLY_OMITTED_TAIL}`;
  return kept;
};

/** 问答卡里存的答案：把 `<at user_id="ou_x">名字</at>` 还原成 `@名字`（问答卡不渲染飞书标签） */
const atTagsToPlain = (text: string): string =>
  text.replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, (_m, name: string) =>
    name.trim() ? `@${name.trim()}` : "",
  );

/** 发言前缀：真人提问人固定 @ 他（`atRequester === false` 的旧登记不补）；机器人不补 */
const replyPrefix = (entry: PendingGroupReply): string =>
  entry.requesterIsBot === true ||
  entry.atRequester === false ||
  !entry.requesterOpenId
    ? ""
    : `${mentionTag(entry.requesterOpenId, entry.requesterName)} `;

// ----------------- 群答疑流式卡（per 登记） -----------------

/**
 * 群答疑卡里要不要放「思考与工具」折叠面板（私聊卡有、群卡 2026-11-09 起照抄）。
 *
 * ⚠️ 面板内容 = agent 的思考原文 + 工具名 / 参数摘要（命令、文件路径；凭据类已脱敏），**群里所有人都看得见**，
 * 而不只是属主——若觉得对外暴露太多，把它改成 false：卡退回「header + 正文 + footer」，不再累积 / 推送过程区。
 */
const GROUP_CARD_SHOW_PROCESS = true;
/** 单段思考累积上限（防一次超长思考把内存撑大；面板里本来就只展示前 1200 字） */
const GROUP_THINKING_TEXT_MAX = 8_000;

/** 一条登记的流式状态：enabled = 本轮开不开流式（首次事件读一次定稿）；stream = 卡（判定要说话后才建） */
type GroupStreamState = {
  enabled: boolean;
  /** 卡片 header 标题（任务标题）与 footer 模型名（建状态时读一次） */
  title?: string;
  model?: string;
  stream?: GroupCardStream;
  /** 最近一次推给卡的全文（落盘版 / 同文重复帧不重复推） */
  lastPushed?: string;
  /** 过程区（思考 / 工具）累积；没建卡前也攒，建卡时一并带上 */
  parts: ProcessPart[];
  /** 工具 callId → parts 下标（tool_result 回填状态用） */
  toolIndex: Map<string, number>;
  /** 最近一次渲染出的过程区 markdown（没变就不重复推） */
  lastProcess?: string;
  /** 渲染过程区时「正文是否已开始」（开放思考段在正文开始后置 completed；变化时才重渲染） */
  answerStarted?: boolean;
};

/** 同时在飞的流式状态上限（防登记被各种路径悄悄摘掉后泄漏；超限丢最老的） */
const GROUP_STREAM_STATES_MAX = 64;

/**
 * 这个任务的群回复要不要流式：任务级覆盖（需求群弹窗）> 全局「流式回复」；读不到按全局。
 * 顺带读卡片 header 标题（任务标题）/ footer 模型名——同一次 getTask，不多读盘。
 */
const readGroupStreamConfig = async (
  taskId: string,
): Promise<{ enabled: boolean; title?: string; model?: string }> => {
  let title: string | undefined;
  let model: string | undefined;
  try {
    const task = await deps.getTask(taskId);
    title = task?.title?.trim() || undefined;
    model = task?.model?.id || undefined;
    const override = task?.feishuGroupStreaming;
    if (typeof override === "boolean") return { enabled: override, title, model };
  } catch (err) {
    warn(`读任务级流式开关 task=${taskId}`, err);
  }
  try {
    return { enabled: await deps.isStreamingEnabled(), title, model };
  } catch (err) {
    warn("读全局流式开关", err);
    return { enabled: true, title, model };
  }
};

/** 取（没有就建）一条登记的流式状态；开关 / 标题 / 模型在建状态时读一次定稿 */
const ensureStreamState = async (
  taskId: string,
  entry: PendingGroupReply,
): Promise<GroupStreamState> => {
  const { streams } = getReg();
  const hit = streams.get(entry.token);
  if (hit) return hit;
  if (streams.size >= GROUP_STREAM_STATES_MAX) {
    const oldest = streams.keys().next().value;
    if (oldest !== undefined) streams.delete(oldest);
  }
  const st: GroupStreamState = {
    enabled: true,
    parts: [],
    toolIndex: new Map(),
  };
  streams.set(entry.token, st);
  const cfg = await readGroupStreamConfig(taskId);
  st.enabled = cfg.enabled;
  st.title = cfg.title;
  st.model = cfg.model;
  return st;
};

/**
 * 重渲染过程区（思考 / 工具时间线，同私聊卡的 `renderProcess`）；`force` = 建卡时无条件推一次。
 * 没建卡时只记在状态里（建卡那刻 `force` 带上），**绝不因过程更新而建卡**（保 NO_REPLY 零消息）。
 */
const syncProcess = (
  st: GroupStreamState,
  entry: PendingGroupReply,
  force = false,
): void => {
  if (!GROUP_CARD_SHOW_PROCESS) return;
  const started = hasAnyGroupReplyText(entry);
  st.answerStarted = started;
  const text = renderProcess(st.parts, started);
  if (text === st.lastProcess && !force) return;
  st.lastProcess = text;
  if (text || force) st.stream?.pushProcess(text);
};

/** 一条流事件里取过程区需要的几个字段（thinking / tool_call / tool_result） */
type ProcessEventLike = {
  kind: string;
  text?: string;
  meta?: Record<string, unknown> | undefined;
};

/** 把 thinking / tool_call / tool_result 累积进 parts（逻辑逐条对齐 outbound 的 handleThinking / handleToolCall / handleToolResult） */
const applyProcessEvent = (
  st: GroupStreamState,
  event: ProcessEventLike,
): void => {
  const meta = event.meta as Parameters<typeof toolNameFromMeta>[0];
  if (event.kind === "thinking") {
    const text = redactSecretsInText((event.text ?? "").trim());
    if (!text) return;
    // SDK 会把一次连贯思考拆成多条 thinking 事件：中间没有工具调用就并进同一「思考 N」段
    const last = st.parts.at(-1);
    if (last?.kind === "thinking") {
      if (last.text.length < GROUP_THINKING_TEXT_MAX) {
        last.text = `${last.text}\n\n${text}`;
      }
    } else {
      st.parts.push({ kind: "thinking", text });
    }
    return;
  }
  const callId =
    (meta && typeof meta.callId === "string" && meta.callId) || "";
  const name = toolNameFromMeta(meta);
  const argsSummary = argsSummaryFromMeta(meta, event.text ?? "");
  if (event.kind === "tool_call") {
    const id = callId || `anon_${st.parts.length + 1}`;
    const idx = st.toolIndex.get(id);
    const part = idx != null ? st.parts[idx] : undefined;
    if (part && part.kind === "tool") {
      part.name = name;
      part.argsSummary = argsSummary;
      part.status = "running";
    } else {
      st.toolIndex.set(id, st.parts.length);
      st.parts.push({
        kind: "tool",
        callId: id,
        name,
        argsSummary,
        status: "running",
      });
    }
    return;
  }
  if (event.kind === "tool_result") {
    const ok =
      !(meta && typeof meta.status === "string" && meta.status === "error");
    const idx = callId ? st.toolIndex.get(callId) : undefined;
    const part = idx != null ? st.parts[idx] : undefined;
    if (part && part.kind === "tool") {
      part.status = ok ? "ok" : "err";
      // result 常不带 args——保留 call 时的摘要
      if (argsSummary && argsSummary !== "…") part.argsSummary = argsSummary;
    } else {
      // 没见过 running（偶发只落 result）→ 直接追加完成行
      st.parts.push({
        kind: "tool",
        callId: callId || `result_${st.parts.length + 1}`,
        name: toolNameFromMeta(meta, "tool"),
        argsSummary,
        status: ok ? "ok" : "err",
      });
    }
  }
};

/**
 * 过程事件（thinking / tool_call / tool_result）：累积进该登记的过程区，已建卡就推给卡。
 * 只认 runTag 对得上的那条登记（属主 run 的工具调用不进同事的答疑卡）。
 */
const handleGroupProcessEvent = async (
  taskId: string,
  runTag: string | null,
  event: ProcessEventLike,
): Promise<void> => {
  if (!GROUP_CARD_SHOW_PROCESS) return;
  const entry = peekGroupReply(taskId, runTag);
  if (!entry || entry.kind !== "question") return;
  const st = await ensureStreamState(taskId, entry);
  if (!st.enabled) return;
  applyProcessEvent(st, event);
  syncProcess(st, entry);
};

/**
 * 回答文本又长了（delta / 落盘版兜底）：把「累积全文」（已收段落 + 当前段）推给流式卡。
 * 只在有可见正文之后才建卡（NO_REPLY / 空回复不会在群里留下卡）；一轮的开关值在首次事件读一次定稿。
 *
 * 推的是**累积全文**（{@link visibleGroupReplyText}）、只增不换——和私聊流式卡一样；
 * 此前只推「当前段」，agent 每调一次工具整句就被换掉，卡上永远只有一句话。
 */
const streamGroupReply = async (
  taskId: string,
  runTag: string | null,
): Promise<void> => {
  const entry = peekGroupReply(taskId, runTag);
  if (!entry || entry.kind !== "question") return;
  const st = await ensureStreamState(taskId, entry);
  if (!st.enabled) return;
  // 每次都重新判：首行没写完（可能是 NO_REPLY）先别起卡；当前段判成沉默就不显示它——
  // 已经起了卡的话，卡保持已有内容（新一段写成 NO_REPLY 不能把「NO_REPLY」字样推到群里）
  const text = visibleGroupReplyText(entry, false);
  if (!text) return;
  const full = `${replyPrefix(entry)}${text}`;
  if (!st.stream) {
    st.stream = deps.createGroupCardStream(entry.chatId, { title: st.title });
    // 建卡前攒下的过程区（先调了几次工具才开口）随首帧一起带上
    syncProcess(st, entry, true);
  } else if (st.answerStarted !== true) {
    // 正文刚开始：过程区里「进行中」的思考段收敛成 completed
    syncProcess(st, entry);
  }
  if (full === st.lastPushed) return;
  st.stream.push(full);
  st.lastPushed = full;
};

/** 摘掉一条登记的流式状态（收口 / 被摘都走这里）；返回它让调用方决定怎么收尾 */
const takeStreamState = (token: string): GroupStreamState | undefined => {
  const { streams } = getReg();
  const st = streams.get(token);
  streams.delete(token);
  return st;
};

/**
 * question 登记收口（已 take）：按「累积全文」（已收段落 + 当前段，见 visibleGroupReplyText）决定群里发什么、问答卡记什么。
 * 有流式卡就把卡收尾成终稿（整份累积全文进卡、header 变已完成 / 处理失败、footer 写耗时 · 模型），
 * 没有就切块直接发文本卡（≤3 块）。
 */
const flushQuestionReply = async (
  taskId: string,
  entry: PendingGroupReply,
  ok: boolean,
): Promise<void> => {
  const askerIsBot = entry.requesterIsBot === true;
  const askerName = entry.requesterName.trim();
  const at = mentionTag(entry.requesterOpenId, entry.requesterName);
  // 累积全文（final=true：最后一段是 NO_REPLY 则整轮静默）；anyText 区分「一个字没说」与「说了但全是 NO_REPLY」
  const finalText = visibleGroupReplyText(entry, true);
  const anyText = hasAnyGroupReplyText(entry);
  const streamState = takeStreamState(entry.token);
  const stream = streamState?.stream;
  const prefix = replyPrefix(entry);

  let toSend: string[] = [];
  /** 给流式卡的整份终稿（累积全文）；不给 = 第 1 块进卡、其余块另发（旧行为） */
  let cardBody: string | undefined;
  let recorded = "";
  let noReply = false;
  let mentioned: string[] = [];

  if (!ok) {
    // 失败：机器人提问人一个字都不发（对端把群消息当上下文，发了就是污染 + 可能再触发它回话）；
    // 但流式卡若已经在群里了，就让它保持已有内容收尾（不能一直挂着「生成中」）——
    // 真人提问人：卡上保留已累积的正文，末尾补一句失败提示（红色 header / footer「处理失败」）
    if (askerIsBot) {
      recorded = BOT_FAIL_NOTE;
    } else {
      toSend = [`${at} ${GROUP_FAIL_HINT}`];
      cardBody = finalText
        ? `${prefix}${finalText}\n\n${at} ${GROUP_FAIL_HINT}`
        : undefined;
      recorded = `${askerName ? `@${askerName} ` : ""}${GROUP_FAIL_HINT}`;
      mentioned = [askerName || "你"];
    }
  } else if (!anyText) {
    if (askerIsBot) {
      recorded = BOT_EMPTY_NOTE;
    } else {
      toSend = [`${at} ${GROUP_EMPTY_HINT}`];
      recorded = `${askerName ? `@${askerName} ` : ""}${GROUP_EMPTY_HINT}`;
      mentioned = [askerName || "你"];
    }
  } else if (!finalText) {
    // agent 自己选择不回（最后一段是 NO_REPLY）：群里零消息；原话存进问答卡供审计。
    // 若卡因更早的旁白已经起了：保持卡上已有内容、只关流式（不再追加）
    noReply = true;
    recorded = [...(entry.closedSegments ?? []), entry.answer.trim()]
      .filter(Boolean)
      .join("\n\n");
  } else {
    toSend = splitGroupReplyChunks(`${prefix}${finalText}`);
    // 流式卡里放整份累积全文（卡片没有 1800 字的单条限制；超长由 group-card-stream 按飞书体积上限收紧）
    cardBody = `${prefix}${finalText}`;
    recorded = atTagsToPlain(toSend.join("\n\n"));
    if (prefix) mentioned = [askerName || "你"];
  }

  // 发送炸了也写汇总（review C 二轮）：外层整段吞异常，不写问答卡与群就两边全静默、没处查。
  // take 先摘，写两次不可能 duplicate。多块发送遇到第一个失败就停（后面的没有意义）。
  let sendOk = true;
  if (stream) {
    // 卡已在群里：无论成败都要收尾；toSend 为空（机器人失败 / 静默）= 保持卡上已有内容、只关流式
    const res = await stream.finalize(toSend, {
      ...(cardBody ? { body: cardBody } : {}),
      outcome: ok ? "ok" : "failed",
      durationMs: Math.max(0, Date.now() - entry.startedAt),
      ...(streamState?.model ? { model: streamState.model } : {}),
    });
    if (!res.delivered) {
      sendOk = false;
      warn(`回答回群发送失败 task=${taskId}`, res.error);
      await noteGroupSendFailure(taskId, entry.chatId, res.error, "答疑回复");
    }
  } else {
    for (const chunk of toSend) {
      try {
        // 不再拼 head：该有的 @ 已经在 text 里（固定前缀 / agent 自己写的）
        await deps.sendMarkdown(entry.chatId, chunk);
      } catch (err) {
        sendOk = false;
        warn(`回答回群发送失败 task=${taskId}`, err);
        // 答疑回复没发出去：除了群问答卡的 ok:false 汇总，主事件流也留一条 info 让属主看得见
        await noteGroupSendFailure(taskId, entry.chatId, err, "答疑回复");
        break;
      }
    }
  }

  // 群问答卡的聚合记录（只记旁路 restricted 轮：runTag 非空；属主通道不记）。
  // 发送炸了也记（ok:false）：答案躺问答卡里至少能复制，不至于两边全静默。
  // publish 不带 origin：投不进任何登记、不触发回群。
  // 并入同会话的非属主一轮不写（sameSession）：它的问与答都在主事件流里，不再往群问答卡灌新数据
  if (entry.runTag && !entry.sameSession) {
    await writeEventAndPublish(
      taskId,
      buildGroupQaSummaryEvent({
        runTag: entry.runTag,
        askerOpenId: entry.requesterOpenId,
        askerName: entry.requesterName,
        ...(entry.sourceMessageId
          ? { questionMessageId: entry.sourceMessageId }
          : {}),
        answer: recorded,
        ok: sendOk && ok,
        askerIsBot,
        ...(noReply ? { noReply: true } : {}),
        ...(mentioned.length > 0 ? { mentioned } : {}),
        startedAt: entry.startedAt,
        durationMs: Math.max(0, Date.now() - entry.startedAt),
      }),
    );
  }
};

/**
 * done 时把这一轮的结果发回群（question 走文本、advance 走 share 卡）。
 *
 * `runTag` = 这条 done 的来路（属主主链 null / 旁路 run 的 token）：**只 flush 认这一路的
 * 那条登记**。同 task 属主 run 与同事的答疑 run 可以同时在飞，谁的 done 收谁的登记；
 * 无对应登记（如属主在 app 里推进、stop 补发的 done）直接返回、绝不误发。
 */
const flushGroupReply = async (
  taskId: string,
  runTag: string | null,
  ok: boolean,
): Promise<void> => {
  // 先 peek 不 take：advance 可能还要接着等（见 resolveAdvancePhase）
  const pending = peekGroupReply(taskId, runTag);
  if (!pending) return;

  if (pending.kind === "advance") {
    await flushGroupAdvanceReply(taskId, pending, ok);
    return;
  }

  const entry = takeGroupReplyByToken(taskId, pending.token);
  if (!entry) return;
  await flushQuestionReply(taskId, entry, ok);
};

/**
 * task / action 帧的收口尝试：**只敲推进登记**（question 登记仍然只认 done）。
 * 推进恒走属主通道 → runTag 固定 null。同步零 IO 预筛，没推进登记直接返回。
 */
const flushGroupAdvanceOnActionUpdate = async (
  taskId: string,
): Promise<void> => {
  const pending = peekGroupReply(taskId, null);
  if (!pending || pending.kind !== "advance") return;
  await flushGroupAdvanceReply(taskId, pending, true);
};

// ----------------- 到期推进登记的收口（第六轮双审 P1-1） -----------------
//
// group-shared 的租约到点时对 advance 只做一件事：把判定推到这里。
// 它是同步纯状态、读不到 action 也发不了消息，凭什么判断一条推进该不该摘？
// 本模块拿得到 getTask / sendText，所以三种情形在这里各归各位。

/** 群里等太久没等到结果时的兜底回执——摘登记可以，静默消失不行 */
const ADVANCE_EXPIRED_TEXT = "这轮推进等太久没拿到结果、去 Flowship 看事件流";

/**
 * 一条到期推进登记该怎么办（对外可测；整段吞异常——绝不影响主链）。
 *
 * - action 仍 `running`：多半是 agent 调了 `ask_user`、人还没回来答 → **续租**，
 *   这条登记是群里拿到产物的唯一路径
 * - action 已终态：收口那帧丢了（进程重启 / 事件没到）→ 现在补一次正常收口
 * - action 查不到：`advanceTask` 压根没返回过 id、或任务已被删 → 摘登记 + @ 一句回执
 *
 * 判定本身失败（读盘炸了等）什么都不做：登记原样挂着，租约里已留了重问的宽限。
 */
export const reviewExpiredGroupAdvance = async (
  taskId: string,
  token: string,
): Promise<void> => {
  try {
    const entry = peekGroupReplyByToken(taskId, token);
    if (!entry || entry.kind !== "advance") return;
    // 桥接总开关自己判一次：本钩子是 `hasGroupReplies` 那次 prune 触发的，而那句预筛
    // 排在 handleGroupOutboundEvent 的开关判定**之前**——桥接关掉后仍会走到这里，
    // 不判就是往群里发到期回执。判不过什么都不做（登记留着、下轮再问，见宽限）
    if (!(await isBridgeEnabledCached())) return;
    const task = await deps.getTask(taskId);
    const action = entry.actionId
      ? task?.actions.find((a) => a.id === entry.actionId)
      : undefined;
    if (action?.status === "running") {
      renewGroupReply(taskId, token);
      return;
    }
    if (action) {
      await flushGroupAdvanceReply(taskId, entry, true);
      return;
    }
    const taken = takeGroupReplyByToken(taskId, token);
    if (!taken) return;
    // 到期摘也放坑：这条登记再也等不到收口了，卡不能跟着白锁（同 flush 口径）
    if (taken.advancePickId) releaseGroupAdvancePick(taken.advancePickId);
    if (taken.actionId) releaseGroupAdvancePickByAction(taskId, taken.actionId);
    // 开关关掉 = 用户本就不要推进结果回群，那也不必回执
    if (!(await deps.isAdvanceResultToGroupEnabled())) return;
    await sendReceipt(
      taskId,
      taken.chatId,
      `${mentionTag(taken.requesterOpenId, taken.requesterName)} ${ADVANCE_EXPIRED_TEXT}`,
    );
  } catch (err) {
    warn(`到期推进登记收口 task=${taskId}`, err);
  }
};

/**
 * question 登记没等到收口就被摘了（2h 到期 / 超 8 条被挤）→ 写一条 ok:false 汇总。
 *
 * 对应 advance 的收口回执，但只写问答卡、不回群：2h 前的 @ 此刻再弹出来更吓人。
 * runTag 沿用登记的（restricted 旁路 = 问题事件 restrictedRunTag，精确配对）；
 * 属主通道没有 runTag，用 `dropped:<token>` 另起 + questionMessageId 兜底配对。
 * 整段吞异常——这是收尾补偿，绝不能影响主链（对外可测）。
 */
export const handleDroppedQuestionReply = (
  taskId: string,
  dropped: PendingGroupReply,
  reason: GroupQuestionDroppedReason,
): void => {
  if (dropped.kind !== "question") return;
  // 已经起了流式卡的登记被摘：卡不能一直挂着「生成中」——按卡上已有内容收尾（不补任何文字）
  const droppedStream = takeStreamState(dropped.token)?.stream;
  if (droppedStream) {
    void droppedStream.finalize([]).catch((err) => {
      warn(`被摘登记的流式卡收尾 task=${taskId}`, err);
    });
  }
  // 并入同会话的非属主一轮：不写群问答卡汇总（新数据不再生成旁路问答卡）；属主在主事件流里本就看得到这一轮
  if (dropped.sameSession) return;
  void (async () => {
    try {
      await writeEventAndPublish(
        taskId,
        buildGroupQaSummaryEvent({
          runTag: dropped.runTag ?? `dropped:${dropped.token}`,
          askerOpenId: dropped.requesterOpenId,
          askerName: dropped.requesterName,
          ...(dropped.sourceMessageId
            ? { questionMessageId: dropped.sourceMessageId }
            : {}),
          answer:
            reason === "expired"
              ? "这条群问题等太久没拿到回答（登记已过期），麻烦重问"
              : "群问题太多、这条被挤掉没等到回答，麻烦重问",
          ok: false,
        }),
      );
    } catch (err) {
      warn(`掉落问题汇总 task=${taskId}`, err);
    }
  })();
};

// ----------------- 并入同会话的非属主一轮（从 user_reply 事件现建登记） -----------------
//
// 非属主的群消息进属主同一个活会话、逐条各跑一轮（见 task-question-inject 的 groupNonOwner）。
// 这一轮的 user_reply 事件在**送达成功之后**才落盘，且 meta 里带着回群所需的一切
//（groupChatId / feishuMessageId / groupSender / groupSenderOpenId / groupSenderIsBot + groupNonOwnerTurn 标记）。
// 登记就从这条事件现建（restricted 通道、不占属主单格）：
//   - 登记与 run 严格同序（同一条 per-task 串行链里：user_reply → 本轮 delta / tool_call / message → done），
//     不存在「登记早于 run」带来的覆盖 / 错投窗口；
//   - 空闲直送、排队重放（TTQ drain）是同一条路，不需要预登记、也不需要重放闭包；
//   - 主链帧本来不带 origin，turns 表把「这一轮」的 runTag 当作它们的有效 origin，delta / tool_call / done
//     就能对号入座，且不会误碰属主那一格（advance / 属主问答）。
// 已知缝隙：user_reply 落盘与首批 delta 不是原子的——极快的首帧可能先到（此时该 delta 因无登记被丢弃，
// 只会少答案开头几个字、不会错投）。

type NonOwnerTurnMeta = {
  chatId: string;
  openId: string;
  name: string;
  messageId?: string;
  isBot: boolean;
};

const readNonOwnerTurnMeta = (
  meta: Record<string, unknown> | undefined,
): NonOwnerTurnMeta | null => {
  if (!meta || meta.groupNonOwnerTurn !== true) return null;
  const chatId = typeof meta.groupChatId === "string" ? meta.groupChatId : "";
  const openId =
    typeof meta.groupSenderOpenId === "string" ? meta.groupSenderOpenId : "";
  if (!chatId || !openId) return null;
  return {
    chatId,
    openId,
    name: typeof meta.groupSender === "string" ? meta.groupSender : "",
    ...(typeof meta.feishuMessageId === "string" && meta.feishuMessageId
      ? { messageId: meta.feishuMessageId }
      : {}),
    isBot: meta.groupSenderIsBot === true,
  };
};

/** 任务队列里排着的非属主消息被丢弃（过期 / 被停 / 被删 / 重放失败）→ 给发言人回一句，别让人干等 */
const GROUP_OTHER_DROP_TEXT: Record<
  GroupOtherDroppedInfo["reason"],
  (detail?: string) => string
> = {
  expired: () => "你这条排队太久没轮到处理（已过期），麻烦重新 @ 我一次",
  stopped: () => "任务被停止了，你这条排队的消息没处理，等任务恢复后再 @ 我一次",
  deleted: () => "你这条排队的消息被宿主移出队列了，没有处理",
  closed: () => "这个任务已经结束（或被删除），你这条排队的消息没有处理",
  failed: (detail) =>
    `你这条排队的消息没处理上${detail ? `（${detail}）` : ""}，麻烦再 @ 我一次`,
};

export const handleGroupOtherDropped = (info: GroupOtherDroppedInfo): void => {
  // 机器人发言人静默（防互 @ 成环，与回群协议同口径）
  if (info.senderIsBot) return;
  const m = readNonOwnerTurnMeta(
    info.meta ? { ...info.meta, groupNonOwnerTurn: true } : undefined,
  );
  if (!m) return;
  void (async () => {
    try {
      if (!(await isBridgeEnabledCached())) return;
      await sendReceipt(
        info.taskId,
        m.chatId,
        `${mentionTag(m.openId, m.name)} ${GROUP_OTHER_DROP_TEXT[info.reason](info.detail)}`,
      );
    } catch (err) {
      warn(`非属主排队丢弃回执 task=${info.taskId}`, err);
    }
  })();
};

// ----------------- 事件分发 -----------------

/** 处理单条流事件（对外可测）；整段吞异常 */
export const handleGroupOutboundEvent = async (
  taskId: string,
  ev: TaskStreamEvent,
): Promise<void> => {
  try {
    const isAsk = ev.kind === "event" && ev.event.kind === "ask_user_request";
    // ask 作废标记（取消 / 顶替 / 停止 / 重启 / 过期 / 跳过都会写）：旧卡要跟着置终态（M5-03）。
    // 放在本 tap 而不是 chat-pending / runner：标记事件本来就经 writeEventAndPublish fanout 到这里，
    // 不动 ask 登记的原子摄取状态机；而且本 tap 同时覆盖 chat / task 两种任务、与有没有群无关
    // （私聊流式卡的承载卡也由同一个收口点按 card-map 反查）
    const isAskVoid =
      ev.kind === "event" && parseAskVoidMarker(ev.event) !== null;
    // 相关性预筛（同步、零 IO）：除 ask / 作废标记外，只有「有登记等着回群」的任务才需要处理。
    // assistant_delta 是每 token 一发的高频事件——绝不能每条都去读一次 config.json。
    // 例外（G3-01）：群问题排队非空时 done / task / action 帧也算相关。排队的非属主问题
    // 不建回群登记、属主在 app 里发起的 run 也没有登记——只认登记的话，这些 run 一结束
    // 就没人触发排空，排队的同事要等下一条群 @ 或 30 分钟后收到「超时作废」。
    // 只放行这三种低频的终态 / 进展帧；assistant_delta / event 仍被预筛拦掉（每 token 一发）。
    const isPumpFrame =
      ev.kind === "done" || ev.kind === "task" || ev.kind === "action";
    // 并入同会话的非属主一轮的起点（user_reply 带 groupNonOwnerTurn）：要穿过预筛现建登记；
    // 以及这一轮进行中的 turn（登记被挤 / 过期后仍要在 done 清 turn）。同步零 IO。
    const turns = getReg().turns;
    const isNonOwnerTurnStart =
      ev.kind === "event" &&
      ev.event.kind === "user_reply" &&
      !ev.origin &&
      ev.event.meta?.groupNonOwnerTurn === true;
    if (
      !isAsk &&
      !isAskVoid &&
      !isNonOwnerTurnStart &&
      !turns.has(taskId) &&
      !hasGroupReplies(taskId) &&
      !(isPumpFrame && groupQuestionQueueLength(taskId) > 0)
    ) {
      return;
    }
    // 桥接总开关关掉时整条群链不跑（与 p2p 出向同口径）；带 8s 缓存、别每个 delta 读盘
    if (!(await isBridgeEnabledCached())) {
      // 主链 done 无论如何收掉 turn，免得开关关着时它一直挂着
      if (ev.kind === "done" && !ev.origin) turns.delete(taskId);
      return;
    }

    // 这条事件出自哪一路 run（属主主链不带 origin → null）——投递的唯一判据。
    // 并入同会话的非属主一轮在主链上、帧不带 origin：用这一轮的 runTag 当有效 origin（turns 表）
    const runTag =
      ((ev.kind === "event" ||
      ev.kind === "assistant_delta" ||
      ev.kind === "done"
        ? ev.origin
        : undefined) ??
        turns.get(taskId)) ||
      null;

    if (ev.kind === "assistant_delta") {
      appendGroupReplyAnswer(taskId, runTag, ev.text);
      await streamGroupReply(taskId, runTag);
      return;
    }
    if (ev.kind === "done") {
      try {
        await flushGroupReply(taskId, runTag, ev.ok);
      } finally {
        // 主链的 done = 并入同会话的那一轮到此为止（无论登记还在不在）
        if (!ev.origin) turns.delete(taskId);
        // 上一轮答完 → 泵排队（空队秒回；还忙就放回队首等下一轮）。
        // 放 finally：回群发送炸了也不能把排队饿死（外层整段吞异常）。
        try {
          await deps.pumpGroupQuestionQueue(taskId);
        } finally {
          // pump 此刻多半还撞在 task-runner 的收尾窗口里（见 GROUP_PUMP_RETRY_DELAYS_MS）：队列没清空就补重试
          armPumpRetries(taskId);
        }
      }
      return;
    }
    // action 落终态（后置检查把 awaiting_ack 落盘）才是「推进跑完」的真信号——
    // done 是 turn 级的、agent 中途 ask_user 也会发（见 resolveAdvancePhase）
    if (ev.kind === "task" || ev.kind === "action") {
      try {
        await flushGroupAdvanceOnActionUpdate(taskId);
      } finally {
        // 属主动作有进展 → 顺手泵一次排队（忙就放回，不打扰）
        await deps.pumpGroupQuestionQueue(taskId);
      }
      return;
    }
    if (ev.kind !== "event") return;

    // 主链上又有一条 user_reply：新一轮开始了。
    // ① 上一轮非属主的 turn 还没等到 done 就被打断（属主在 app 里「立即发送」等）→ 收口成失败，别让发言人干等；
    // ② 这条自己就是非属主一轮的起点 → 从它的 meta 现建登记，并把 runTag 记进 turns。
    // 旁路答疑的问题事件（meta.restrictedRunTag）是另一条线、不在主链上，既不算新一轮也不打断这一轮
    if (
      ev.event.kind === "user_reply" &&
      !ev.origin &&
      typeof ev.event.meta?.restrictedRunTag !== "string"
    ) {
      const stale = turns.get(taskId);
      if (stale) {
        turns.delete(taskId);
        await flushGroupReply(taskId, stale, false);
      }
      const m = readNonOwnerTurnMeta(ev.event.meta);
      if (m) {
        const handle = rememberGroupReply(taskId, {
          chatId: m.chatId,
          requesterOpenId: m.openId,
          requesterName: m.name,
          kind: "question",
          requesterIsBot: m.isBot,
          ...(m.messageId ? { sourceMessageId: m.messageId } : {}),
          sameSession: true,
          channel: "restricted",
        });
        if (handle?.runTag) turns.set(taskId, handle.runTag);
      }
      return;
    }

    if (ev.event.kind === "ask_user_request") {
      await handleAskUserRequest(taskId, ev.event.meta);
      return;
    }
    if (isAskVoid) {
      await settleAskCardsOnVoidMarker(taskId, ev.event, (id) =>
        deps.getTask(id),
      );
      return;
    }
    // 本 run 又调了工具 → 当前段收成已收段落（累积全文照旧：已收段落 + 当前段，只是分了段，NO_REPLY 按段判）；
    // 同时把这次工具调用记进卡片的「思考与工具」过程区。
    // pi 与 Cursor SDK 两条后端的工具调用经 sdk-message-handler 统一落成 kind=tool_call
    if (ev.event.kind === "tool_call") {
      closeGroupReplySegment(taskId, runTag);
      await handleGroupProcessEvent(taskId, runTag, ev.event);
      return;
    }
    if (ev.event.kind === "thinking" || ev.event.kind === "tool_result") {
      await handleGroupProcessEvent(taskId, runTag, ev.event);
      return;
    }
    if (ev.event.kind === "assistant_message") {
      // delta 已攒过就别重复追加（完整消息是同一段文字的落盘版）；
      // 晚于 tool_call 到达的落盘版由登记里的「待认领段落」去重，见 acceptGroupReplyMessage
      acceptGroupReplyMessage(taskId, runTag, ev.event.text);
      // 没有 delta、只有落盘版的兜底路径：这里也要推给流式卡
      await streamGroupReply(taskId, runTag);
    }
  } catch (err) {
    warn(`处理事件 task=${taskId}`, err);
  }
};

// ----------------- 注册 -----------------

const REG_KEY = "__flowshipFeishuGroupOutboundV1__";

type GroupOutboundGlobal = {
  registered: boolean;
  unsub: (() => void) | null;
  /** per-task 串行链——publish 是同步 fanout、handle 内有 await，不入链会交错 */
  chains: Map<string, Promise<void>>;
  /**
   * 并入同会话的非属主一轮：taskId → 这一轮登记的 runTag（主链帧不带 origin、靠它对号入座）。
   * 只在 per-task 串行链里读写；主链 done / 被新 user_reply 打断时清掉。
   */
  turns: Map<string, string>;
  /** 群答疑流式卡的 per 登记状态（token → 状态）；收口 / 被摘时清掉 */
  streams: Map<string, GroupStreamState>;
};

const getReg = (): GroupOutboundGlobal => {
  const g = globalThis as unknown as Record<
    string,
    GroupOutboundGlobal | undefined
  >;
  if (!g[REG_KEY]) {
    g[REG_KEY] = {
      registered: false,
      unsub: null,
      chains: new Map(),
      turns: new Map(),
      streams: new Map(),
    };
  }
  // 热更新后沿用的旧 globalThis 注册表可能没有 turns / streams（旧版本建的）：补上
  g[REG_KEY]!.turns ??= new Map();
  g[REG_KEY]!.streams ??= new Map();
  return g[REG_KEY]!;
};

/** 幂等注册全局 tap（bootstrap 调） */
export const ensureFeishuGroupOutboundRegistered = (): void => {
  const reg = getReg();
  if (reg.registered) return;
  reg.registered = true;
  // 到期推进登记的判定权交给本模块（登记只可能在 bootstrap 之后产生、注册顺序安全）
  setGroupAdvanceExpiryHandler((taskId, token) => {
    void reviewExpiredGroupAdvance(taskId, token);
  });
  // question 登记被静默摘掉时写 ok:false 汇总（只写问答卡、不回群，十六轮 P3）
  setGroupQuestionDroppedHandler(handleDroppedQuestionReply);
  // task 待送达队列里排着的非属主消息被丢弃 → 给发言人回一句（task 侧不 import 群模块，靠这个钩子）
  setTalkQueueGroupOtherDropHandler(handleGroupOtherDropped);
  reg.unsub = subscribeAllTaskStreams((taskId, ev) => {
    const prev = reg.chains.get(taskId) ?? Promise.resolve();
    reg.chains.set(
      taskId,
      prev.then(() => handleGroupOutboundEvent(taskId, ev)),
    );
  });
  console.log(`${LOG} 已注册全局 tap`);
};

/** 单测重置注册 */
export const __resetGroupOutboundForTest = (): void => {
  const reg = getReg();
  reg.unsub?.();
  reg.unsub = null;
  reg.registered = false;
  reg.chains.clear();
  reg.turns.clear();
  reg.streams.clear();
  clearPumpRetries();
  setGroupAdvanceExpiryHandler(null);
  setGroupQuestionDroppedHandler(null);
  setTalkQueueGroupOtherDropHandler(null);
  bridgeEnabledCache = null;
};
