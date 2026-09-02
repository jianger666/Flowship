/**
 * 需求群回流（第二批 · 出向）
 *
 * 一个全局 task 流 tap（对齐 outbound.ensureFeishuOutboundRegistered）干三件事：
 *
 * 1. **ask 卡发群**：agent 调 ask_user → 若开了「问题同步到需求群」且该任务绑了群，
 *    把答题卡也发一份到群（跨角色答题；按钮回调是 card.action.trigger、天然只到属主本机）
 * 2. **回答回群**：群里 @bot 提的问题，agent 这轮的答复攒起来、done 时 @ 提问人发回群。
 *    走 `post` + `md`（飞书 `text` 不渲染 markdown）；短状态回执仍用纯文本。
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

import type { ShareToGroupInput } from "@/lib/server/feishu-group";
import { getActionArtifactPath } from "@/lib/server/task-fs-core";
import {
  subscribeAllTaskStreams,
  type TaskStreamEvent,
} from "@/lib/server/task-stream";
import { getTask } from "@/lib/server/task-fs";
import { ACTION_LABEL, type Task } from "@/lib/types";

import {
  isAdvanceResultToGroupEnabled,
  isAskToGroupEnabled,
  isFeishuChatBridgeEnabled,
} from "./bridge-config";
import { rememberAskCard } from "./card-map";
import { buildGroupAskCardJson } from "./group-ask-card";
import {
  appendGroupReplyAnswer,
  claimGroupArtifactCard,
  hasGroupReplies,
  mentionTag,
  peekGroupReply,
  peekGroupReplyByToken,
  releaseGroupArtifactCard,
  renewGroupReply,
  setGroupAdvanceExpiryHandler,
  takeGroupReplyByToken,
  truncateForGroup,
  type PendingGroupReply,
} from "./group-shared";
import {
  sendInteractiveCardToChat,
  sendPostMarkdownToChat,
  sendTextMessageToChat,
} from "./lark-api";
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
  sendText: typeof sendTextMessageToChat;
  /** 群答疑正文：post markdown，会渲染粗体 / 代码 / 列表 */
  sendMarkdown: typeof sendPostMarkdownToChat;
  shareToGroup: (task: Task, input: ShareToGroupInput) => Promise<unknown>;
  rememberAskCard: typeof rememberAskCard;
  isBridgeEnabled: typeof isFeishuChatBridgeEnabled;
  isAskToGroupEnabled: typeof isAskToGroupEnabled;
  isAdvanceResultToGroupEnabled: typeof isAdvanceResultToGroupEnabled;
  readArtifact: (absPath: string) => Promise<string>;
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
  sendText: sendTextMessageToChat,
  sendMarkdown: sendPostMarkdownToChat,
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
});

let deps: GroupOutboundDeps = defaultDeps();

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
  if (!chatId) return;
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
  const sent = await deps.sendAskCard(chatId, card);
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
  if (!(await deps.isAdvanceResultToGroupEnabled())) return;

  const at = mentionTag(entry.requesterOpenId, entry.requesterName);
  if (resolved.phase === "failed") {
    await deps.sendText(entry.chatId, `${at} 推进没跑成功、去 Flowship 看事件流`);
    return;
  }

  const { task, actionId } = resolved;
  const artifact = await readActionArtifact(task, actionId);
  if (!artifact) {
    // action 已终态还没 artifact = 这轮真没出文档。旁白按文本回、**绝不冒充产物卡**
    //（也就不占防重坑——那张坑位只属于真产物）
    const narration = truncateForGroup(entry.answer.trim());
    await deps.sendText(
      entry.chatId,
      narration ? `${at} 已跑完：${narration}` : `${at} 已跑完（没有产出文档）`,
    );
    return;
  }
  // 与自动播报共用同一张产物卡防重表、先占再发（占坑同步、中间零 await）。
  // 占不到 = 播报侧已经在发同一份产物：上面 takeGroupReply 已把登记摘走、
  // 它的预筛会扑空并照发，这里再发就是群里两张一模一样的卡（P2-1）。
  if (!claimGroupArtifactCard(taskId, actionId)) return;
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
    await deps.sendText(entry.chatId, `${at} 已跑完，但产物没发出来（去 Flowship 看）`);
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
  const answer = entry.answer.trim();
  const body = !ok
    ? "这轮没跑成功、去 Flowship 看看事件流"
    : answer || "已处理完成（这轮没有文字回复）";
  // post md：@ 标签写进 markdown 正文（飞书扩展语法），整段才会渲染 ** / ` / 列表
  await deps.sendMarkdown(
    entry.chatId,
    `${mentionTag(entry.requesterOpenId, entry.requesterName)} ${truncateForGroup(body)}`,
  );
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
    // 开关关掉 = 用户本就不要推进结果回群，那也不必回执
    if (!(await deps.isAdvanceResultToGroupEnabled())) return;
    await deps.sendText(
      taken.chatId,
      `${mentionTag(taken.requesterOpenId, taken.requesterName)} ${ADVANCE_EXPIRED_TEXT}`,
    );
  } catch (err) {
    warn(`到期推进登记收口 task=${taskId}`, err);
  }
};

// ----------------- 事件分发 -----------------

/** 处理单条流事件（对外可测）；整段吞异常 */
export const handleGroupOutboundEvent = async (
  taskId: string,
  ev: TaskStreamEvent,
): Promise<void> => {
  try {
    const isAsk = ev.kind === "event" && ev.event.kind === "ask_user_request";
    // 相关性预筛（同步、零 IO）：除 ask 外，只有「有登记等着回群」的任务才需要处理。
    // assistant_delta 是每 token 一发的高频事件——绝不能每条都去读一次 config.json。
    if (!isAsk && !hasGroupReplies(taskId)) return;
    // 桥接总开关关掉时整条群链不跑（与 p2p 出向同口径）；带 8s 缓存、别每个 delta 读盘
    if (!(await isBridgeEnabledCached())) return;

    // 这条事件出自哪一路 run（属主主链不带 origin → null）——投递的唯一判据
    const runTag =
      (ev.kind === "event" || ev.kind === "assistant_delta" || ev.kind === "done"
        ? ev.origin
        : undefined) ?? null;

    if (ev.kind === "assistant_delta") {
      appendGroupReplyAnswer(taskId, runTag, ev.text);
      return;
    }
    if (ev.kind === "done") {
      await flushGroupReply(taskId, runTag, ev.ok);
      return;
    }
    // action 落终态（后置检查把 awaiting_ack 落盘）才是「推进跑完」的真信号——
    // done 是 turn 级的、agent 中途 ask_user 也会发（见 resolveAdvancePhase）
    if (ev.kind === "task" || ev.kind === "action") {
      await flushGroupAdvanceOnActionUpdate(taskId);
      return;
    }
    if (ev.kind !== "event") return;

    if (ev.event.kind === "ask_user_request") {
      await handleAskUserRequest(taskId, ev.event.meta);
      return;
    }
    if (ev.event.kind === "assistant_message") {
      // delta 已攒过就别重复追加（完整消息是同一段文字的落盘版）
      const entry = peekGroupReply(taskId, runTag);
      if (entry && !entry.answer.trim() && ev.event.text) {
        appendGroupReplyAnswer(taskId, runTag, ev.event.text);
      }
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
};

const getReg = (): GroupOutboundGlobal => {
  const g = globalThis as unknown as Record<
    string,
    GroupOutboundGlobal | undefined
  >;
  if (!g[REG_KEY]) {
    g[REG_KEY] = { registered: false, unsub: null, chains: new Map() };
  }
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
  setGroupAdvanceExpiryHandler(null);
  bridgeEnabledCache = null;
};
