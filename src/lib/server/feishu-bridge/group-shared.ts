/**
 * 需求群回流共享状态 / 纯工具（第二批）
 *
 * 单独一个模块的原因：入向（group-route：群消息 → 任务）与出向（group-outbound：
 * 任务事件 → 回群）都要读写「这轮回答该发回哪个群、@ 谁」，放任一侧都会成环。
 * 同理，「同一 action 的产物卡只发一张」的防重表也放这里——出向 done flush 与
 * 自动播报（group-broadcast）两条链必须看同一张表。
 *
 * 状态挂 globalThis（dev route-chunk / HMR 分裂防护，对齐 bridge 其它单例）。
 *
 * # 回群登记的 token 化投递协议（V3、第四轮双审后收敛）
 *
 * 每条登记绑一个不可复用 token，并记死「认哪一路 run」（`runTag`）：属主主链的事件
 * 不带 origin（runTag=null）、旁路只读答疑 run 的事件带 origin=它自己的 token。
 * **攒回答与 flush 只认 runTag 相等的那一路**——同 task 的属主 run 与多位同事的
 * 答疑 run 可以同时在飞，各回各的，不再互相错投 / 顶掉（同族问题第三次冒头后
 * 按本仓铁律收敛成单一协议，不再逐分支加条件）。
 *
 * 已知边界（有意为之）：属主主链是**一条通道**、不是 per-run token——task-runner /
 * chat-runner / stop 有二十来个 done 出口，全量贯通 run id 的收益不抵改动面。
 * 而 task 状态机本身保证同一 task 同时只有一个属主 run，所以属主通道单格够用；
 * 真正会并行的旁路 run 才按 token 精确投递（白名单方向：旁路事件**永远**带 origin，
 * 绝进不了属主那格）。
 *
 * # advance 登记的保活策略（V4、第六～七轮双审后收敛）
 *
 * 「摘掉一条推进登记」= 群里再也收不到这轮的产物，所以四条清理链**一条都不许
 * 对在飞的 advance 静默动手**（表要与 `docs/feishu-group-collab.md` 同款、别只改一边）：
 *
 * | 清理链 | 对 question | 对 advance |
 * |--------|-------------|------------|
 * | 租约到期（{@link pruneTask}） | 直接摘 | 只推给出向钩子判定（续租 / 补收口 / 摘 + 回执） |
 * | 属主单格覆盖（{@link rememberGroupReply}） | 后到覆盖先到 | 不被 question 顶掉；被下一轮 advance 顶掉时由 group-route 回群补一句 |
 * | 容量上限（同上） | 丢最老的 | 永不挤掉 |
 * | 失败回滚（{@link restoreGroupReply}） | 租约过期就不放回 | 无条件放回（过期自有到期收口协议接手） |
 *
 * 「有事件就续租」只是顺手——它治不了纯等待（agent 调 `ask_user` 之后到人作答之间
 * 一条事件都没有），别把它当保活的主手段。
 */

import { redactSecretsInText } from "@/lib/server/event-secret-redact";
import type { ParsedInboundContent } from "./router";

// ----------------- 群问答排队 -----------------
//
// task 型群问答一次只答一个（防刷屏 + 省额度），忙时后来问题不再忙线拒收、而是攒起来：
// 前一轮 done / 属主动作终态 / 新消息到达时 draining，前一个答完就答它。
// 属主 / chat 型 / 答 pendingAsk / **feed 进活会话的**关联回执不排（属主用 app 当主通道，关联数据有时效性）。
// 注意：**没有活会话的关联回执会排**（它按普通非属主消息走只读旁路，旁路在飞时就是忙线、照常入队）；
// 入队时不焚登记，回放时 injectGroupMessage 重算 correlated——登记若已在排队期间被焚 / 过期，
// 回放就按普通消息处理（数据头与 correlatedAnswer 标记随之丢失，且计个人额度；第八轮 L3-03 核实）。
// 有界：最多攒这么多，满了落回忙线拒收；TTL 过期丢弃（发件人是人才回一句，机器人静默）。
// 同一条消息（message_id）重复入队（飞书重投 / 重放）只算一次。
// 队列变化会通知订阅者（task-talk-queue 据此把「群里排队中」推给 UI）。
/** 队里最多攒几个（不含正在答的那个） */
export const GROUP_QUESTION_QUEUE_MAX = 10;
/** 排队超过这么久还没轮到就丢弃（属主长任务可能跑很久，30 分钟内都还算有效） */
export const GROUP_QUESTION_QUEUE_TTL_MS = 30 * 60 * 1000;
/**
 * 同一发送人在同一 task 队里最多占几个槽（G3-02）。
 * 「互 @ 熔断」整套删掉后，队列上限 10 只限积压、不限来源：一个人 / 一个机器人
 * 就能独占整队。2 个够正常追问一次，又让别人至少有 8 个槽。
 */
export const GROUP_QUESTION_QUEUE_MAX_PER_SENDER = 2;
/** 非属主旁路 run 的 per-task 滑动窗长度（G3-02） */
export const GROUP_BYPASS_RUN_WINDOW_MS = 10 * 60 * 1000;
/** 滑动窗内最多**启动**几个非属主旁路 run（G3-02，第六轮口径：起了 run 才计）；超限静默丢弃 */
export const GROUP_BYPASS_RUN_WINDOW_MAX = 12;
/**
 * 滑动窗内同一发送人最多**启动**几次旁路 run（第六轮）——总上限 12 不变，
 * 这条防「一个人 / 一个机器人把 12 个名额独吞、饿死别人」。
 */
export const GROUP_BYPASS_RUN_WINDOW_MAX_PER_SENDER = 4;
/** 排队中的一个群问题：injectGroupMessage 入参的子集 + 启动凭据快照 */
export interface QueuedGroupQuestion {
  messageId: string;
  chatId: string;
  text: string;
  parsed: ParsedInboundContent;
  requester: { openId: string; name: string };
  senderIds?: Array<string | undefined>;
  requesterIsBot?: boolean;
  /** 入队时解析好的启动凭据（复用调用方 ctx，不从 router 引运行时） */
  boot: {
    apiKey: string;
    model: { id: string; params?: Array<{ id: string; value: string }> };
  } | null;
  enqueuedAt: number;
}

// 队列表 / 订阅集合挂 globalThis（G3-06，对齐本文件头注释与下面其它单例）：
// dev 下 HMR 重新求值本模块时，task-talk-queue 的「已订阅」标记在 globalThis 上还活着，
// 若监听集合是模块级新建的空集，订阅就永久丢失、UI 再也收不到「群里排队中」的推送；
// 排队中的问题（带启动凭据）也会随旧模块实例一起凭空消失。
// 模块级常量只是**引用** globalThis 上的同一个 Map / Set，所以下面所有读写点无需改动。
const QUEUE_STATE_KEY = "__flowshipGroupQuestionQueueStateV1__";
type GroupQuestionQueueState = {
  queues: Map<string, QueuedGroupQuestion[]>;
  listeners: Set<(taskId: string) => void>;
  /**
   * 非属主旁路 run 的滑动窗（G3-02，与队列同属「群问答准入」状态，复用这一份 globalThis 状态）：
   * stamps = 窗内已**启动**的 run（时间 / 发送人 / message_id，message_id 用来重投去重与失败退还）；
   * noticeAt = 上一次发「总限额」info 的时刻；senderNotices = 各发送人上一次被发「个人限额」info 的时刻
   * （按发送人分桶：A 撞线提示过，不能吞掉 B 的——属主要知道每个被限的人是谁）；
   * dropHints = 各发送人上一次收到「排队回放被限流丢弃」群内提示的时刻（K2-02，每窗每人一条）。
   * 三类各自节流、互不吞对方的提示。
   */
  bypassWindows: Map<string, GroupBypassWindow>;
  /** 合成 messageId 的自增序号（L3-05；只用于日志可读，不参与任何判定） */
  anonSeq: number;
};
type GroupBypassStamp = {
  t: number;
  sender: string;
  messageId: string;
  /**
   * 这次启动是关联回执（命中出问登记的托办回执，K2-01）：计总限额、不计个人限额。
   * 缺省 = 普通消息（旧形状的 stamp 没有这个字段，按普通算）。
   */
  receipt?: true;
  /**
   * 调用方没给 messageId、由本模块合成 id（`anon:<自增>`）记下的名额（第八轮 L3-05）。
   * 这类 stamp **不参与**按 id 的重投去重与退还——合成 id 只是占位、不是调用方认得的 id，
   * 否则一个字面恰为 `anon:3` 的真实 id 会撞上它（被当重投吞掉、或被误退还）。
   */
  anon?: true;
};
type GroupBypassWindow = {
  stamps: GroupBypassStamp[];
  noticeAt: number;
  senderNotices: Map<string, number>;
  dropHints: Map<string, number>;
};
const getQueueState = (): GroupQuestionQueueState => {
  const g = globalThis as unknown as Record<
    string,
    GroupQuestionQueueState | undefined
  >;
  if (!g[QUEUE_STATE_KEY]) {
    g[QUEUE_STATE_KEY] = {
      queues: new Map(),
      listeners: new Set(),
      bypassWindows: new Map(),
      anonSeq: 0,
    };
  }
  const s = g[QUEUE_STATE_KEY]!;
  // 同进程热更前已建出的旧形状状态：补齐新字段，别让它 undefined
  if (!s.bypassWindows) s.bypassWindows = new Map();
  if (typeof s.anonSeq !== "number") s.anonSeq = 0;
  return s;
};
const groupQuestionQueues = getQueueState().queues;

/** UI 用的队列只读视图（不含图片 / 启动凭据） */
export interface GroupQuestionQueueViewItem {
  id: string;
  senderName: string;
  senderIsBot: boolean;
  /** 问题正文预览（已截断） */
  preview: string;
  createdAt: number;
}
const groupQueueListeners = getQueueState().listeners;
/** 订阅队列变化（入队 / 出队 / 过期 / 清空）；返回取消订阅函数。监听器抛错只吞、不影响队列 */
export const subscribeGroupQuestionQueue = (
  listener: (taskId: string) => void,
): (() => void) => {
  groupQueueListeners.add(listener);
  return () => {
    groupQueueListeners.delete(listener);
  };
};
const notifyGroupQueueChanged = (taskId: string): void => {
  for (const l of groupQueueListeners) {
    try {
      l(taskId);
    } catch (err) {
      console.warn("[feishu-bridge/group-shared] 群队列订阅者抛错：", err);
    }
  }
};
/** 当前排队中的群问题（FIFO、队首在前）；不剔除过期条目——过期由入队 / pump 时清理并通知 */
export const listGroupQuestionQueueView = (
  taskId: string,
): GroupQuestionQueueViewItem[] =>
  (groupQuestionQueues.get(taskId) ?? []).map((e) => ({
    id: e.messageId,
    senderName: e.requester.name,
    senderIsBot: !!e.requesterIsBot,
    preview: e.text.replace(/\s+/g, " ").trim().slice(0, 120),
    createdAt: e.enqueuedAt,
  }));
/**
 * 入队（满了返回 queued:false，调用方落回忙线拒收）。now 参数只给单测用。
 * 先懒清过期（review A）：TTL 是 shift 时才丢的，不先清会拿死槽位误拒新问题。
 */
export const enqueueGroupQuestion = (
  taskId: string,
  entry: Omit<QueuedGroupQuestion, "enqueuedAt">,
  now: number = Date.now(),
  /**
   * `maxPerSender`：同一发送人最多占几个槽（G3-02，生产调用方传
   * {@link GROUP_QUESTION_QUEUE_MAX_PER_SENDER}）。缺省不限——纯队列函数保持原行为，
   * 发送人口径是调用方的准入策略。
   */
  opts?: { maxPerSender?: number },
): {
  queued: boolean;
  position: number;
  ejected: QueuedGroupQuestion[];
  /** queued:false 时的原因：队满 / 该发送人槽位已满（调用方两者同走忙线拒收） */
  reason?: "full" | "sender_limit";
} => {
  const none = { queued: false, position: 0, ejected: [] as QueuedGroupQuestion[] };
  if (!taskId) return none;
  // filter 永远返回新数组：无条件写回，否则 push 进空气（review 三轮实测抓包）。
  // 被清掉的过期条目如数返回——调用方负责告诉用户“超时作废”，不能悄悄吞
  //（review 八轮-2；和 shift 的 warn 对齐，排查时两边对得上）。
  const prev = groupQuestionQueues.get(taskId) ?? [];
  const ejected = prev.filter((e) => now - e.enqueuedAt >= GROUP_QUESTION_QUEUE_TTL_MS);
  const q = prev.filter((e) => now - e.enqueuedAt < GROUP_QUESTION_QUEUE_TTL_MS);
  if (ejected.length > 0) {
    console.warn(
      `[feishu-bridge/group-shared] 入队清掉 ${ejected.length} 个过期排队 task=${taskId}`,
    );
  }
  groupQuestionQueues.set(taskId, q);
  // 同一 message_id 已在队里：幂等，不重复入队（飞书重投 / 重放）
  const dupIdx = q.findIndex((e) => e.messageId === entry.messageId);
  if (dupIdx >= 0) {
    if (ejected.length > 0) notifyGroupQueueChanged(taskId);
    return { queued: true, position: dupIdx + 1, ejected };
  }
  if (q.length >= GROUP_QUESTION_QUEUE_MAX) {
    if (ejected.length > 0) notifyGroupQueueChanged(taskId);
    return { queued: false, position: q.length, ejected, reason: "full" };
  }
  // 发送人槽位（G3-02）：放在幂等与队满判定之后——重投不算新占位、队满先报队满。
  // 过期条目上面已清掉，不会拿死槽位误拒新问题。
  // 槽位 key 与限流 key 同口径（第八轮 L3-04：此前是裸 `openId || name`——无 open_id 的机器人按展示名
  // 连坐 / 改名多占槽，展示名写成别人 open_id 的发送人与真人同 key）。
  if (opts?.maxPerSender !== undefined) {
    const sender = groupBypassSenderKey(entry.requester, entry.senderIds);
    const used = q.filter(
      (e) => groupBypassSenderKey(e.requester, e.senderIds) === sender,
    ).length;
    if (used >= opts.maxPerSender) {
      if (ejected.length > 0) notifyGroupQueueChanged(taskId);
      return { queued: false, position: q.length, ejected, reason: "sender_limit" };
    }
  }
  q.push({ ...entry, enqueuedAt: now });
  notifyGroupQueueChanged(taskId);
  return { queued: true, position: q.length, ejected };
};
/**
 * 取队首。过期的一并丢弃并如数返回（调用方负责告诉用户“超时作废”，不能静默——
 * 入队 ack 承诺过“答完就答你”，见 pump；review 八轮-2）。now 参数只给单测用。
 */
export const shiftGroupQuestionQueue = (
  taskId: string,
  now: number = Date.now(),
): { head: QueuedGroupQuestion | null; expired: QueuedGroupQuestion[] } => {
  const empty = { head: null, expired: [] as QueuedGroupQuestion[] };
  const q = groupQuestionQueues.get(taskId);
  if (!q) return empty;
  const expired: QueuedGroupQuestion[] = [];
  while (q.length > 0) {
    const head = q[0];
    if (!head) {
      q.shift();
      continue;
    }
    if (now - head.enqueuedAt >= GROUP_QUESTION_QUEUE_TTL_MS) {
      q.shift();
      expired.push(head);
      console.warn(
        `[feishu-bridge/group-shared] 排队问题过期丢弃 task=${taskId} message=${head.messageId}`,
      );
      continue;
    }
    q.shift();
    if (q.length === 0) groupQuestionQueues.delete(taskId);
    notifyGroupQueueChanged(taskId);
    return { head, expired };
  }
  groupQuestionQueues.delete(taskId);
  if (expired.length > 0) notifyGroupQueueChanged(taskId);
  return { head: null, expired };
};
/** 放回队首（pump 时还忙：静默等下一轮 draining，不回群） */
export const unshiftGroupQuestionQueue = (
  taskId: string,
  entry: QueuedGroupQuestion,
): void => {
  if (!taskId) return;
  const q = groupQuestionQueues.get(taskId) ?? [];
  q.unshift(entry);
  groupQuestionQueues.set(taskId, q);
  notifyGroupQueueChanged(taskId);
};
/** 清空（任务删除 / 终结时整队丢弃）：返回丢掉的条数 */
export const clearGroupQuestionQueue = (taskId: string): number => {
  const q = groupQuestionQueues.get(taskId);
  groupQuestionQueues.delete(taskId);
  // 任务终结 / 归档 / 删除：滑动窗状态也随之作废，别把 taskId 攒成长跑进程的内存泄漏
  getQueueState().bypassWindows.delete(taskId);
  const n = q?.length ?? 0;
  if (n > 0) notifyGroupQueueChanged(taskId);
  return n;
};
/** 按 message_id 摘掉一条排队中的群问题（UI「取消」）；摘到返回 true */
export const removeGroupQuestionFromQueue = (
  taskId: string,
  messageId: string,
): boolean => {
  const q = groupQuestionQueues.get(taskId);
  if (!q) return false;
  const idx = q.findIndex((e) => e.messageId === messageId);
  if (idx < 0) return false;
  q.splice(idx, 1);
  if (q.length === 0) groupQuestionQueues.delete(taskId);
  notifyGroupQueueChanged(taskId);
  return true;
};
/** 当前队长（排查 / 单测用） */
export const groupQuestionQueueLength = (taskId: string): number =>
  groupQuestionQueues.get(taskId)?.length ?? 0;

/**
 * 旁路 run 的「发送人」口径（每人子限额的分桶键）：open_id（机器人同样适用）→
 * 其余服务端稳定 ID 格（bot open_id / app_id）→ 展示名兜底，兜底时加 `name:` 前缀（K2-09）→
 * 连名字都没有（缺失 / 空串 / 全空白）时是 `anon:`（第八轮 L3-04：此前拼出 `name:undefined`）。
 * 队内槽位（enqueueGroupQuestion）也用这同一个 key（第八轮 L3-04：此前是裸 `openId || name`）。
 *
 * 为什么兜底要加前缀：展示名是用户可改的自由文本，不加前缀时一个展示名叫 `ou_xxx` 的无 id
 * 发送人会和真 `ou_xxx` 落进同一个桶（互相连坐 / 或被冒充者借走别人的额度）。前缀把两个命名空间
 * 分开：稳定 ID 永远是 `ou_` / `cli_` 之类的服务端下发串，不会以 `name:` / `anon:` 开头。
 * `anon:` 桶是所有「无 id 无名」发送人共用的一个桶——保守聚合（认不出是谁，就当同一个人限）。
 */
export const groupBypassSenderKey = (
  requester: { openId: string; name: string },
  senderIds?: Array<string | undefined>,
): string => {
  const id = requester.openId || senderIds?.find((s) => !!s);
  if (id) return id;
  // 运行时 name 可能缺失（类型是 string，但入向清洗之前的形状不保证）
  const name = typeof requester.name === "string" ? requester.name : "";
  return name.trim() ? `name:${name}` : "anon:";
};

/** {@link admitGroupBypassRun} 的结果 */
export type GroupBypassAdmit =
  | {
      allowed: true;
      notify: false;
      /**
       * 本次调用是否**新记了一个名额**。false = 同一 message_id 重投、名额早已计过（幂等放行）；
       * 起 run 失败要退还时，只有 counted:true 的那次才有名额可退（见 {@link releaseGroupBypassRun}）。
       * 例外：空 messageId（合成 id 占位）是 counted:true 但**退不掉**——退还对它是 no-op、保守不退。
       */
      counted: boolean;
    }
  | {
      allowed: false;
      /** 本次是否该写那条节流 info（总限额 / 个人限额各自每窗最多一条） */
      notify: boolean;
      /** 撞上的是总限额还是该发送人的个人限额（info 文案据此区分） */
      scope: "total" | "sender";
    };

/**
 * 非属主旁路 run 准入（G3-02，第六轮口径修正）：per-task 滑动窗，窗内最多
 * {@link GROUP_BYPASS_RUN_WINDOW_MAX} 次**启动**、同一发送人最多
 * {@link GROUP_BYPASS_RUN_WINDOW_MAX_PER_SENDER} 次。
 *
 * 「互 @ 熔断」整套删掉后，没有任何按 task / 时间窗的计数——两个机器人互 @、或任何群成员
 * 持续 @，都能持续烧属主额度（队列上限 10 只限积压、不限速率）。这里补一道保守的硬上限：
 * 超限由调用方**静默丢弃**（不回群消息，防对端机器人被喂噪音再续环），并只在 `notify`
 * 为 true 时写一条 info 事件让属主知道。
 *
 * **只拦真正花钱的 run**，所以调用方必须在「忙线 / 队满 / 槽位 / 启动凭据都过了」之后、紧接着起 run
 * 的那一刻才调——被忙线 / 队满拒收的、入队等回放的、被限流丢弃的都不占名额；排队回放在真正起 run 时
 * 计一次。起 run 失败（注入抛错 / 非 200）调 {@link releaseGroupBypassRun} 退还。
 *
 * **原子的只有「判定 + 计数」本身**（本函数同步、无 await，两条并发消息不会同时挤进最后一个名额）。
 * 它与忙线判定**不是**原子的：调用方在忙线判定之后还要 `await loadBootContext()` 才走到这里，
 * 并发的两条消息可能都通过忙线判定、各自起 run——忙线闸是「串行意图」而非硬互斥，名额总量由这里守住。
 * 调用方能保证的只有：本函数返回到「注入调用」之间没有 await（无 pendingAsk 时）。
 *
 * - 只有被放行并起 run 的才进窗口：被拒的不续窗，攻击者不能靠狂发把窗口一直锁死
 * - 同一 message_id 重投（飞书至少一次投递 / 补拉）：窗内已计过的不再计、直接幂等放行
 *   （不被「已满」挡住——它早已被受理过；真正的重复处理由入向的已处理去重负责）
 * - **空 messageId 用合成 id（`anon:<自增>`）照常计数、照常受限额约束（第八轮 L3-05，推翻第七轮 K2-09
 *   「空 id 放行不计数」）**：此前连调多少次都 `{allowed:true, counted:false}`，限流器 fail-open。
 *   生产上到不了（入向 `normalizeInboundEvent` 在没有 message_id 时整条丢弃，排队回放用的是队列项自带的 id），
 *   但换个入口 / 漏传 id 的调用方就是后门。合成 id 的 stamp 带 `anon` 标记，**不参与**按 id 的重投去重与退还，
 *   所以与任何真实 id（包括字面恰为 `anon:N` 的）互不冲突；没有 id 就无从按 id 重投去重——两次空 id 调用
 *   就是两次启动。**退还不了、保守不退**（{@link releaseGroupBypassRun} 对空 id 恒返回 false）：多占的名额
 *   随 stamp 一起在窗口（10 分钟）滑过后自然过期，不是永久占位（第七轮「永久占着」的理由不成立）。
 *   返回 `counted:true`（名额确实新记了），但调用方的退还对它是 no-op。
 * - 先判总限额再判个人限额（总额满了所有人都进不来，提示点总额更有用）
 * - **关联回执（`correlatedReceipt`，K2-01）只计总限额、不计个人限额**：命中出问登记的托办回执
 *   是属主自己托办的数据回流（登记两门已过、送达即焚，数量受登记约束），没有活会话时走只读旁路起 run；
 *   若计入个人额度，同一目标 10 分钟内第 5 次回执会被静默丢掉、托办的数据就丢了。仍计总限额，
 *   总量上限不被它绕过；它的 stamp 也不进个人计数，不会反过来挤占该人后续普通提问的额度。
 * - 总限额的节流 info 每窗最多一条；个人限额的**按发送人分桶**、每人每窗最多一条（K2-08：此前所有人
 *   共用一个计时，A 撞线提示过后 B 撞线会被吞掉，属主只知道有人被限、不知道是谁）
 * - 属主自己、答 pendingAsk（走活会话）、feed 进活会话的关联回执、chat 型都不经过这里，由调用方负责
 * now 参数只给单测用。
 */
export const admitGroupBypassRun = (
  taskId: string,
  who: { sender: string; messageId: string; correlatedReceipt?: boolean },
  now: number = Date.now(),
): GroupBypassAdmit => {
  const state = getQueueState();
  const { bypassWindows } = state;
  // 空 messageId：合成 id 占位（只在真正被放行、要记 stamp 时才自增，见下）
  const synthetic = !who.messageId;
  // 顺手清掉已过窗且提示也过期的 task，长跑进程别攒内存
  for (const [id, other] of bypassWindows) {
    if (id === taskId) continue;
    if (isBypassWindowIdle(other, now)) bypassWindows.delete(id);
  }
  const w = ensureBypassWindow(taskId);
  w.stamps = w.stamps.filter((s) => now - s.t < GROUP_BYPASS_RUN_WINDOW_MS);
  pruneBypassNotices(w, now);

  // 重投去重只认调用方给的真实 id：合成 stamp（anon）不参与，空 id 调用本身也不去重
  if (
    !synthetic &&
    w.stamps.some((s) => !s.anon && s.messageId === who.messageId)
  ) {
    return { allowed: true, notify: false, counted: false };
  }

  // 超限：提示每类每窗最多一条（以上一次提示起算一整个窗口；个人限额按发送人各算各的）
  const deny = (scope: "total" | "sender"): GroupBypassAdmit => {
    const last =
      scope === "total"
        ? w.noticeAt
        : (w.senderNotices.get(who.sender) ?? Number.NEGATIVE_INFINITY);
    const notify = now - last >= GROUP_BYPASS_RUN_WINDOW_MS;
    if (notify) {
      if (scope === "total") w.noticeAt = now;
      else w.senderNotices.set(who.sender, now);
    }
    return { allowed: false, notify, scope };
  };
  if (w.stamps.length >= GROUP_BYPASS_RUN_WINDOW_MAX) return deny("total");
  if (!who.correlatedReceipt) {
    // 个人计数不含回执 stamp：回执不占该人后续普通提问的额度
    const used = w.stamps.filter((s) => !s.receipt && s.sender === who.sender).length;
    if (used >= GROUP_BYPASS_RUN_WINDOW_MAX_PER_SENDER) return deny("sender");
  }

  w.stamps.push({
    t: now,
    sender: who.sender,
    messageId: synthetic ? `anon:${++state.anonSeq}` : who.messageId,
    ...(synthetic ? { anon: true as const } : {}),
    ...(who.correlatedReceipt ? { receipt: true as const } : {}),
  });
  return { allowed: true, notify: false, counted: true };
};

/**
 * 取 / 建该 task 的旁路窗口，并把热更前旧形状补齐：旧窗口没有 `senderNotices` / `dropHints`
 * （旧版是单个 `senderNoticeAt` 数字，此处直接忽略——最坏多发一次提示）；旧 stamps 是裸时间戳，
 * `s.t` 为 undefined → `now - s.t` 是 NaN → 调用方的过滤自然丢掉，无需另判。
 */
const ensureBypassWindow = (taskId: string): GroupBypassWindow => {
  const { bypassWindows } = getQueueState();
  const w: GroupBypassWindow = bypassWindows.get(taskId) ?? {
    stamps: [],
    noticeAt: Number.NEGATIVE_INFINITY,
    senderNotices: new Map(),
    dropHints: new Map(),
  };
  if (!(w.senderNotices instanceof Map)) w.senderNotices = new Map();
  if (!(w.dropHints instanceof Map)) w.dropHints = new Map();
  if (typeof w.noticeAt !== "number") w.noticeAt = Number.NEGATIVE_INFINITY;
  if (!Array.isArray(w.stamps)) w.stamps = [];
  bypassWindows.set(taskId, w);
  return w;
};

/** 摘掉已过一整窗的分桶提示记录（每人一条，不清会随发送人数线性增长） */
const pruneBypassNotices = (w: GroupBypassWindow, now: number): void => {
  for (const book of [w.senderNotices, w.dropHints]) {
    for (const [sender, at] of book) {
      if (now - at >= GROUP_BYPASS_RUN_WINDOW_MS) book.delete(sender);
    }
  }
};

/** 窗口已「空」：窗内没有 stamp、总提示 / 各人提示也都过期——可整项删（形状可能是热更前的旧形状） */
const isBypassWindowIdle = (w: GroupBypassWindow, now: number): boolean => {
  const old = (at: unknown): boolean =>
    typeof at !== "number" || now - at >= GROUP_BYPASS_RUN_WINDOW_MS;
  const stamps: GroupBypassStamp[] = Array.isArray(w.stamps) ? w.stamps : [];
  return (
    stamps.every((s) => now - s.t >= GROUP_BYPASS_RUN_WINDOW_MS) &&
    old(w.noticeAt) &&
    (w.senderNotices instanceof Map
      ? [...w.senderNotices.values()].every(old)
      : true) &&
    (w.dropHints instanceof Map ? [...w.dropHints.values()].every(old) : true)
  );
};

/**
 * 排队回放被限流丢弃后，要不要给提问人回那一句群内提示（K2-02）：每窗（10 分钟）每人最多一条，
 * 返回 true = 本次该发（同时记下时刻），false = 这个人本窗已提示过。
 *
 * 为什么只有回放要提示：入队时已回过「答完就答你」，这是承诺；回放遇限流被丢弃等于食言，必须交代。
 * 即时到达的消息被限流静默丢弃（没承诺过、且对端若是机器人任何回执都是续环素材），不调这里。
 * 机器人提问人调用方不要调（系统回执对机器人一律静默），免得白占它的名额。
 * 与 {@link admitGroupBypassRun} 的 info 节流分开记账：info 是给属主看的，这条是给提问人看的。
 *
 * **调用方应「先 {@link peekGroupBypassDropHint} 看有没有名额、发送成功后才调本函数认领」**（第八轮 L3-04）：
 * 先认领再发，发送失败时名额已耗、这个人在本窗里再也等不到那一句。本函数仍是「检查 + 记录」的原子形态，
 * 保持原语义（返回 true = 这次抢到了名额并已记录）。
 * now 参数只给单测用。
 */
export const claimGroupBypassDropHint = (
  taskId: string,
  sender: string,
  now: number = Date.now(),
): boolean => {
  if (!taskId) return false;
  const w = ensureBypassWindow(taskId);
  pruneBypassNotices(w, now);
  const last = w.dropHints.get(sender);
  if (last !== undefined && now - last < GROUP_BYPASS_RUN_WINDOW_MS) return false;
  w.dropHints.set(sender, now);
  return true;
};

/**
 * 只读版的 {@link claimGroupBypassDropHint}：这个人本窗还有没有回放丢弃提示的名额（true = 还没提示过、可以发）。
 * **不记录、不建窗口**——发送成功后再调 claim 认领；发送失败就什么都不用做（名额没耗）。
 * now 参数只给单测用。
 */
export const peekGroupBypassDropHint = (
  taskId: string,
  sender: string,
  now: number = Date.now(),
): boolean => {
  if (!taskId) return false;
  const w = getQueueState().bypassWindows.get(taskId);
  const last = w && w.dropHints instanceof Map ? w.dropHints.get(sender) : undefined;
  return last === undefined || now - last >= GROUP_BYPASS_RUN_WINDOW_MS;
};

/**
 * 退还一个旁路 run 名额（起 run 失败路径专用）：按 message_id 摘掉窗内那条计数，摘到返回 true。
 *
 * 只该由 {@link admitGroupBypassRun} 返回 `counted: true` 的那次调用在「注入抛错 / 非 200、
 * 没有 run 开跑」时调——名额的语义是「真启动了的 run」，没启动就不该占。窗口早已滑过去（计数已被
 * 清掉）时什么都不做。返回后窗口里同一 message_id 不再有计数，飞书重投时按新到处理、只计一次。
 */
export const releaseGroupBypassRun = (
  taskId: string,
  messageId: string,
): boolean => {
  // 空 id 退不了（合成 stamp 没有调用方认得的 id，第八轮 L3-05：保守不退）；
  // 合成 stamp（anon）也不会被某个字面相同的真实 id 误摘
  if (!messageId) return false;
  const w = getQueueState().bypassWindows.get(taskId);
  if (!w) return false;
  const idx = w.stamps.findIndex((s) => !s.anon && s.messageId === messageId);
  if (idx < 0) return false;
  w.stamps.splice(idx, 1);
  return true;
};

/**
 * 一条登记等的是**哪一路 run** 的流事件。
 *
 * - `owner`：属主主链（task run / 活会话 / one-shot / stop 补发的 done）——
 *   这条链上的事件不带 `origin`
 * - `restricted`：非属主的只读旁路答疑 run（restricted-question）——它的事件带
 *   `origin` = 本条登记的 token（起 run 时把 token 交给它）
 */
export type GroupReplyChannel = "owner" | "restricted";

/** 一条「等着回群」的登记 */
export interface PendingGroupReply {
  /** 回哪个群 */
  chatId: string;
  /** 发起人 open_id（回群时 @ 他） */
  requesterOpenId: string;
  /**
   * 回群时要不要 @ 发起人。缺省 true（人类和机器人提问都 @；发起方吃掉后静默，一轮结束）。
   * false = 只发正文不 @——保留字段，兼容旧登记/旧单测，新登记不再置 false。
   */
  atRequester?: boolean;
  /** 发起人姓名（@ 标签展示名 / 事件 meta） */
  requesterName: string;
  /**
   * question：agent 这轮的答复文本回群；
   * advance：跑完把 action 产物以分享卡回群（受「群内推进结果回群」开关控制）。
   */
  kind: "question" | "advance";
  /** advance：本次推进的 action id（done 时按它取 artifact） */
  actionId?: string;
  /**
   * advance：这次推进占的是哪张选择卡的坑（pickId）。收口时按它放坑——
   * 同一张卡跑完 A 还能再点 B，不用等 24h 过期（十四轮 P2）。
   * 打字直推没有卡，缺省就行。
   */
  advancePickId?: string;
  /**
   * 提问人是不是机器人（group-route 入向判定后传进来）。
   * 出向据此决定：失败 / 空回答时机器人提问人静默（不让两个机器人互 @ 成环）、
   * 回复协议里「没写 @ 时要不要自动补 @提问人」。缺省 = 真人。
   */
  requesterIsBot?: boolean;
  /**
   * 累积的「当前这一段」回答文本（assistant_delta / assistant_message 攒）。
   * 语义是**最后一次工具调用之后的那段文字**——每遇到本 run 的 tool_call 就收段
   *（见 {@link closeGroupReplySegment}），中途「我先查一下…」之类旁白不进群。
   */
  answer: string;
  /**
   * 上一个被工具调用截断的非空段落。flush 时 `answer` 为空（最后一次工具调用后
   * agent 没再说话）就退回它，免得「答案写在工具调用之前」时整轮空回答。
   */
  lastSegment: string;
  /** 登记时刻（汇总事件算 durationMs 用）；与 createdAt 同值、语义独立 */
  startedAt: number;
  /**
   * 已被 tool_call 收段、但对应 `assistant_message` 落盘版还没到的段落文本（trim 后）。
   * 落盘版晚到时按它认出「这是已收段落的重复」丢掉，不让它被当成新一段的开头。
   */
  awaitingMessages?: string[];
  /** 当前段的 `assistant_message` 落盘版是否已经见过（见过 = 收段时不必再等它） */
  answerMessageSeen?: boolean;
  createdAt: number;
  /**
   * 租约到期时刻（墙钟）。登记时 = `createdAt + GROUP_REPLY_TTL_MS`。
   *
   * 之所以是「租约」而不是死的 `createdAt + TTL`：advance 登记会被续租——
   * 有流事件说明这一路还活着（{@link appendGroupReplyAnswer}），纯等待期
   * 则由过期收口协议问一句 action 状态再定（见 {@link pruneTask}）。
   */
  expiresAt: number;
  /**
   * 本次登记的身份 token（不可复用、发号器挂 globalThis）。
   * 失败路径一律按它做条件回滚——绝不裸删「当前那条」，因为它可能已经是别人的登记了。
   */
  token: string;
  /**
   * 入向群消息 id（UI 群问答 tab 配对备用：user_reply meta.feishuMessageId == 它）。
   * flush 写汇总事件时原样带过去， temporal 配对兜底（no_pending 竞态落回旁路时问题事件没有 runTag）。
   */
  sourceMessageId?: string;
  /**
   * **唯一投递判据**：只有 `origin` 等于它的流事件才能攒进本条登记 / flush 它。
   * - `null`  = 属主主链（那条链上的事件不带 origin）
   * - 非 null = 旁路 run 的 token（恒等于本条登记自己的 token）
   */
  runTag: string | null;
}

/**
 * 一次登记的凭据：token（身份）+ previous（被本次覆盖掉的上一条）+ runTag。
 * 注入失败时交给 {@link restoreGroupReply} 原样回滚；
 * runTag 非空时**必须**交给这轮旁路 run 当事件 origin，否则它的回答投不进来。
 */
export interface GroupReplyHandle {
  token: string;
  previous: PendingGroupReply | null;
  runTag: string | null;
}

/** 登记租约时长——agent 跑挂 / 进程重启后不要无限期挂着占位 */
export const GROUP_REPLY_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * advance 租约到点后、下次再问的间隔。
 * 到期只是「该问一句了」而不是「该摘了」——判定是异步的（要读 action 状态），
 * 这段宽限既防「每帧事件都重复触发同一次判定」，又保证判定失败时下一轮还会再问。
 */
export const GROUP_ADVANCE_EXPIRY_REVIEW_MS = 60 * 1000;

/**
 * 单个 task 同时在飞的登记上限。
 * 旁路答疑可以多人并发（各认各的 token），但别让某个 task 无上限攒下去——
 * 超限丢最老的那条（它多半是 run 挂了没发 done 的僵尸）。
 */
export const GROUP_REPLY_MAX_PER_TASK = 8;

/**
 * 「这条 advance 登记的租约到点了」的收口钩子——由出向层注册
 * （`group-outbound.ensureFeishuGroupOutboundRegistered`）。
 *
 * 本模块是同步纯状态：读不到 action 状态、也发不了消息，凭什么判断一条推进登记
 * 该不该摘？所以到期只负责**把判定推出去**，真正的决定（续租 / 补收口 / 摘 + 回执）
 * 归出向层。没注册钩子时到期的 advance 一律留着——宁可多占一格，也不静默摘。
 */
export type GroupAdvanceExpiryHandler = (taskId: string, token: string) => void;

/** question 登记被静默摘掉的原因：expired = 2h 到期 / evicted = 超 8 条被挤 */
export type GroupQuestionDroppedReason = "expired" | "evicted";
/**
 * 「这条 question 登记没等到收口就被摘了」的通知钩子——由出向层注册。
 * advance 到期有收口协议三选一，question 只有“摘”：频率极低（2h 挂起的 run、
 * 8 路并发答疑），摘时写一条 ok:false 汇总进 tab、群里不再回（2h 前的 @ 再弹
 * 出来更吓人）。没注册时静默摘（老行为）。
 */
export type GroupQuestionDroppedHandler = (
  taskId: string,
  dropped: PendingGroupReply,
  reason: GroupQuestionDroppedReason,
) => void;

// V4：登记从「createdAt + 死 TTL」改成可续租的 expiresAt（第六轮双审 P1-1）
const STATE_KEY = "__flowshipFeishuGroupReplyStateV4__";

type GroupReplyState = {
  byTask: Map<string, PendingGroupReply[]>;
  /** token 发号器（挂 globalThis 防 route-chunk / HMR 分裂后重号） */
  seq: number;
  /** advance 租约到点时的收口钩子（见 {@link GroupAdvanceExpiryHandler}） */
  onAdvanceExpiry: GroupAdvanceExpiryHandler | null;
  /** question 登记被静默摘掉时的通知钩子（见 {@link GroupQuestionDroppedHandler}） */
  onQuestionDropped: GroupQuestionDroppedHandler | null;
};

const getState = (): GroupReplyState => {
  const g = globalThis as unknown as Record<string, GroupReplyState | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      byTask: new Map(),
      seq: 0,
      onAdvanceExpiry: null,
      onQuestionDropped: null,
    };
  }
  return g[STATE_KEY]!;
};

/** 注册 / 注销 advance 过期收口钩子（传 null 注销） */
export const setGroupAdvanceExpiryHandler = (
  handler: GroupAdvanceExpiryHandler | null,
): void => {
  getState().onAdvanceExpiry = handler;
};

/** 注册 / 注销 question 掉落通知钩子（传 null 注销） */
export const setGroupQuestionDroppedHandler = (
  handler: GroupQuestionDroppedHandler | null,
): void => {
  getState().onQuestionDropped = handler;
};

const newReplyToken = (state: GroupReplyState): string => {
  state.seq += 1;
  return `${state.seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
};

/**
 * 摘掉本 task 已过期的登记、返回仍有效的那张**原地表**（调用方可直接增删）。
 * 空表顺手删键——长跑进程别把 taskId 攒成内存泄漏。
 *
 * # advance 登记永远不在这里被摘掉（第六轮双审 P1-1）
 *
 * 固定策略下（`advanceResultToGroup=true` + `autoBroadcast="off"`）推进登记是
 * 「群内推进 → 群里拿到产物」的**唯一**路径，静默 splice 掉 = 群里永久没下文，
 * 既没有产物卡也没有失败回执。而墙钟超 2h 一点都不极端：群里推进 → agent 中途
 * `ask_user` → 人开完会 / 隔夜才在 App 里作答，这段纯等待期一条流事件都没有
 *（所以「有 delta 就续租」治不了它），登记却在任意一次 peek / has / remember 触发的
 * prune 里被摘走。
 *
 * 收敛办法：到期对 advance 只意味着「该问一句了」——先把租约往后推一小段
 *（{@link GROUP_ADVANCE_EXPIRY_REVIEW_MS}），再把判定推给出向钩子。
 */
const pruneTask = (taskId: string, now = Date.now()): PendingGroupReply[] => {
  const { byTask, onAdvanceExpiry, onQuestionDropped } = getState();
  const list = byTask.get(taskId);
  if (!list) return [];
  /** 本轮到期、需要出向层判定的推进登记 */
  const toReview: string[] = [];
  /** 本轮到期被摘的 question 登记（出向层给它们写 ok:false 汇总，十六轮 P3） */
  const dropped: PendingGroupReply[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i]!;
    if (now <= entry.expiresAt) continue;
    if (entry.kind === "advance") {
      entry.expiresAt = now + GROUP_ADVANCE_EXPIRY_REVIEW_MS;
      toReview.push(entry.token);
      continue;
    }
    list.splice(i, 1);
    dropped.push(entry);
  }
  if (list.length === 0) byTask.delete(taskId);
  // 钩子会回调进本模块（peek / renew / take）——等这张表稳定了再叫
  for (const token of toReview) onAdvanceExpiry?.(taskId, token);
  for (const entry of dropped) onQuestionDropped?.(taskId, entry, "expired");
  return byTask.get(taskId) ?? [];
};

/** 全表清过期——登记是低频动作、随调随清足够，不另起定时器 */
const pruneAllTasks = (now: number): void => {
  for (const taskId of [...getState().byTask.keys()]) pruneTask(taskId, now);
};

/** 按 token 读一条登记（顺带清过期）；无则 null */
export const peekGroupReplyByToken = (
  taskId: string,
  token: string,
): PendingGroupReply | null =>
  pruneTask(taskId).find((e) => e.token === token) ?? null;

/**
 * 续租（出向的过期收口器判定「这轮推进还在跑」时调）。
 *
 * ⚠️ 活跃续租**单独兜不住** advance：`ask_user` 等人回话那段一条事件都没有，
 * 真正的兜底是过期收口协议（见 {@link pruneTask}）。
 */
export const renewGroupReply = (taskId: string, token: string): void => {
  const entry = peekGroupReplyByToken(taskId, token);
  if (entry) entry.expiresAt = Date.now() + GROUP_REPLY_TTL_MS;
};

/**
 * 登记「这个 task 这轮的结果要回群」，返回本次登记的凭据。
 *
 * 两条通道各自独立（见 {@link GroupReplyChannel}）：
 * - `restricted`（旁路答疑）：**并存**——多位同事先后提问各自一条，各认各的 token
 *   投递；属主主链的 delta / done 一个字都进不来（第四轮双审 P1：属主 run 的 done
 *   曾把同事的登记 flush 掉、同事收到属主的产物、真答案永远回不了群）
 * - `owner`（属主主链）：每 task 只留一格、后到的覆盖先到的（群里连着 @ 两句、
 *   只回最后一句的语境即可），**覆盖掉的那条随凭据一起带走**：本次注入若失败，
 *   `restoreGroupReply` 把它原样放回（P1-1：B 的 409 曾把 A 的登记一起清掉）
 *
 * 属主那一格里 **advance 不被 question 顶掉**、返 `null` 表示「本次不另开登记」：
 * 群内推进跑到一半 agent 调 `ask_user`、群里有人作答，这条答案本就属于同一轮推进——
 * 让它顶掉推进登记，就是拿一句「答完的旁白」换掉整份产物卡（第五轮双审 P1-A 的邻域）。
 */
export const rememberGroupReply = (
  taskId: string,
  entry: Omit<
    PendingGroupReply,
    | "answer"
    | "lastSegment"
    | "startedAt"
    | "awaitingMessages"
    | "answerMessageSeen"
    | "createdAt"
    | "expiresAt"
    | "token"
    | "runTag"
  > & { channel: GroupReplyChannel },
): GroupReplyHandle | null => {
  if (!taskId || !entry.chatId) return null;
  const state = getState();
  const now = Date.now();
  pruneAllTasks(now);

  const { channel, ...rest } = entry;
  const token = newReplyToken(state);
  const runTag = channel === "restricted" ? token : null;

  let list = state.byTask.get(taskId);
  if (!list) {
    list = [];
    state.byTask.set(taskId, list);
  }
  // 属主通道单格：把上一条摘出来交给凭据（失败时原样放回）
  let previous: PendingGroupReply | null = null;
  if (runTag === null) {
    const idx = list.findIndex((e) => e.runTag === null);
    const occupant = idx >= 0 ? list[idx] : undefined;
    // 在飞的推进登记优先——这轮 ask 答案是它的一部分，产物卡才是群里要的结果
    if (occupant?.kind === "advance" && rest.kind !== "advance") return null;
    if (idx >= 0) previous = list.splice(idx, 1)[0] ?? null;
  }
  list.push({
    ...rest,
    answer: "",
    lastSegment: "",
    startedAt: now,
    createdAt: now,
    expiresAt: now + GROUP_REPLY_TTL_MS,
    token,
    runTag,
  });
  // 超限只丢**非 advance** 的最老那条（第六轮双审 P1-2）：旁路答疑能多人并发攒满，
  // 而在飞的推进登记是群里拿到产物的唯一路径——被挤掉同样是永久静默。
  // 裸 shift 与上面那条「advance 不被 question 顶掉」的策略自相矛盾：
  // 前门挡住了，后门（推进占 1 格 + 旁路攒到 8 → 第 9 条挤掉最早的推进）还开着。
  while (list.length > GROUP_REPLY_MAX_PER_TASK) {
    const idx = list.findIndex((e) => e.kind !== "advance");
    // 全是 advance（属主单格、正常到不了这里）——宁可超一格也不丢产物
    if (idx < 0) break;
    const [evicted] = list.splice(idx, 1);
    // 挤掉也别静默吞：这轮的回答此后无处投递，tab 里会残半轮“回答中”——
    // 推给出向钩子写 ok:false 汇总（十六轮 P3，和到期摘同口径）
    if (evicted) state.onQuestionDropped?.(taskId, evicted, "evicted");
  }
  return { token, previous, runTag };
};

/**
 * 回滚一次登记（注入 / 起 agent 失败路径专用）。
 *
 * 两道条件：
 * 1. 自己那条已不在表里（被 flush / 过期摘走）→ 什么都不做，不许误删别人的
 * 2. 自己那次覆盖过别人 → 把被覆盖的原样放回（连同它已攒的回答与租约，不续期）
 *
 * 放回时 **advance 不看租约**（清理链口径表第四行）：这一路的租约在被顶掉期间照走墙钟，
 * 按「过期就不放回」丢掉，等于在回滚路径上偷偷执行了一次静默摘除——而到期该做的是
 * 交给收口协议问一句 action 状态（放回后下一次 prune 自然会推给出向钩子）。
 */
export const restoreGroupReply = (
  taskId: string,
  handle: GroupReplyHandle | null,
): void => {
  if (!handle) return;
  const list = pruneTask(taskId);
  const idx = list.findIndex((e) => e.token === handle.token);
  if (idx < 0) return;
  list.splice(idx, 1);
  const prev = handle.previous;
  if (prev && (prev.kind === "advance" || Date.now() <= prev.expiresAt)) {
    list.push(prev);
  }
  if (list.length === 0) getState().byTask.delete(taskId);
};

/**
 * 读「这一路 run」对应的登记（过期自动摘掉）；无则 null。
 * @param runTag 事件带的 origin——属主主链传 `null`，旁路 run 传它的 token
 */
export const peekGroupReply = (
  taskId: string,
  runTag: string | null,
): PendingGroupReply | null =>
  pruneTask(taskId).find((e) => e.runTag === runTag) ?? null;

/** 这个 task 此刻有没有任何在飞登记（出向 tap 的同步零 IO 预筛） */
export const hasGroupReplies = (taskId: string): boolean =>
  pruneTask(taskId).length > 0;

/** 只读快照（单测断言 / 排查用；顺带清过期） */
export const listGroupReplies = (taskId: string): PendingGroupReply[] => [
  ...pruneTask(taskId),
];

/**
 * 这个 action 的产物已经有「群内推进」登记在等着吗——自动播报据此让位
 * （出向 flush 会发同一份产物卡）。推进登记恒走属主通道。
 *
 * **只认 actionId 精确相等**：曾经把「登记还没补记 actionId」也算让位（`!e.actionId`），
 * 于是那个窗口里**任意** action 的自动播报都被静默吞掉（第五轮双审 P2-3）。
 * 补记窗口只有 advanceTask 一个返回的工夫，真撞上了也有产物卡防重表兜底
 *（先占再发、只出一张），不需要在这里放宽。
 */
export const hasGroupAdvanceReplyFor = (
  taskId: string,
  actionId: string,
): boolean =>
  !!actionId &&
  pruneTask(taskId).some(
    (e) => e.kind === "advance" && e.actionId === actionId,
  );

/**
 * 补记 actionId（群内推进：登记要抢在 advanceTask 之前，action id 得等它返回）。
 * 原地改、不重建条目——保住这期间已攒的回答文本。
 * 同样按 token 条件执行：advanceTask 那段 await 里若已被别的群消息顶掉登记，
 * 这个 actionId 不能盖到人家的条目上。
 */
export const setGroupReplyActionId = (
  taskId: string,
  handle: GroupReplyHandle | null,
  actionId: string,
): void => {
  if (!handle) return;
  const entry = peekGroupReplyByToken(taskId, handle.token);
  if (entry) entry.actionId = actionId;
};

/**
 * 把本次登记从属主通道改挂到旁路 run，返回新的 runTag（登记已不在则 null）。
 *
 * 只有一个用途：群里有待答提问时先按「答案送进属主活会话」登记，结果 ask 刚被别人
 * 答掉（no_pending）→ 这条消息落回只读旁路。不改挂的话旁路 run 带 origin 的回答
 * 找不到登记、群里等不到答案。
 */
export const retagGroupReplyToRestricted = (
  taskId: string,
  handle: GroupReplyHandle | null,
): string | null => {
  if (!handle) return null;
  const entry = peekGroupReplyByToken(taskId, handle.token);
  if (!entry) return null;
  entry.runTag = entry.token;
  return entry.runTag;
};

/**
 * 累积本轮回答文本（delta / 完整消息都走这里）。
 * 只认 runTag 对得上的那条——属主 run 的旁白绝不进同事的答疑登记。
 */
export const appendGroupReplyAnswer = (
  taskId: string,
  runTag: string | null,
  text: string,
): void => {
  const entry = peekGroupReply(taskId, runTag);
  if (!entry || !text) return;
  // 对累积文本再脱敏（delta 在 publish 已按帧滤过；这里补上 token 被切在相邻两帧的跨帧情形，
  // 群里最终发出去的是整段 answer）
  entry.answer = redactSecretsInText(entry.answer + text);
  // 有 delta 就说明这一路还活着——顺手续租（纯等待期另由过期收口协议兜底）
  entry.expiresAt = Date.now() + GROUP_REPLY_TTL_MS;
};

/** awaitingMessages 的容量（极端长链路里的工具调用数上限，防无限涨） */
const AWAITING_MESSAGES_MAX = 50;

/**
 * 本 run 又调了一次工具 → 当前段结束：非空就存进 `lastSegment`、`answer` 清空。
 *
 * 为什么要分段：答疑回复原先是整轮所有文字拼在一起，「我先查一下…」旁白和英文残句
 * 全发给了外部同事。现在只认「最后一次工具调用之后」的那段。
 *
 * 事件真实顺序（sdk-message-handler）：tool_call 消息进来先冲 delta、再 `assistantCtx.flush()`
 * 落 assistant_message，最后才写 tool_call 事件——即 delta* → assistant_message → tool_call，
 * 此时当前段的落盘版早已见过（answerMessageSeen）。万一落盘版晚于 tool_call 到达，
 * 这里把收掉的段落文本记进 awaitingMessages，{@link acceptGroupReplyMessage} 凭它认出重复。
 * 只认 runTag 对得上的那条——属主 run 的工具调用绝不截断同事的答疑段落。
 */
export const closeGroupReplySegment = (
  taskId: string,
  runTag: string | null,
): void => {
  const entry = peekGroupReply(taskId, runTag);
  if (!entry || entry.kind !== "question") return;
  const seg = entry.answer.trim();
  if (!seg) return;
  entry.lastSegment = seg;
  entry.answer = "";
  if (!entry.answerMessageSeen) {
    const waiting = entry.awaitingMessages ?? [];
    waiting.push(seg);
    if (waiting.length > AWAITING_MESSAGES_MAX) waiting.shift();
    entry.awaitingMessages = waiting;
  }
  entry.answerMessageSeen = false;
};

/**
 * `assistant_message`（同一段文字的落盘版）进来：
 * 1. 是某个已收段落的晚到重复 → 消费掉那条记录、丢弃；
 * 2. 当前段已有 delta → 就是当前段的落盘版，丢弃（并记「已见」）；
 * 3. 当前段还是空的（没收到 delta）→ 用它兜底追加。
 * 第 1 条必须排在第 2 条之前：下一段的 delta 可能已经开始攒，不先认重复就会被
 * 「answer 非空」那条误当成当前段的落盘版吞掉标记。
 */
export const acceptGroupReplyMessage = (
  taskId: string,
  runTag: string | null,
  text: string,
): void => {
  const entry = peekGroupReply(taskId, runTag);
  const t = text?.trim();
  if (!entry || !t) return;
  const waiting = entry.awaitingMessages;
  const idx = waiting ? waiting.indexOf(t) : -1;
  if (waiting && idx >= 0) {
    waiting.splice(idx, 1);
    return;
  }
  entry.answerMessageSeen = true;
  if (entry.answer.trim()) return;
  appendGroupReplyAnswer(taskId, runTag, text);
};

/** 这条登记最终该发的文本：当前段，空则退回上一非空段 */
export const finalGroupReplyText = (
  entry: Pick<PendingGroupReply, "answer" | "lastSegment">,
): string => entry.answer.trim() || (entry.lastSegment ?? "").trim();

/**
 * 取出并摘掉指定 token 的那条登记（无则 null）。
 *
 * **按 token 而不是 runTag 摘**：收口链是「peek → await（读 task / 读设置）→ take」，
 * 那段 await 里属主那格可能已被下一轮推进换成新登记——按 runTag 摘会取走新的那条、
 * 把上一轮的产物发给它，也会在恰逢租约边界时扑空（第六轮双审 P2-3）。
 * token 不可复用：取不到就是「这条已经不归我管」，直接放手。
 */
export const takeGroupReplyByToken = (
  taskId: string,
  token: string,
): PendingGroupReply | null => {
  const list = pruneTask(taskId);
  const idx = list.findIndex((e) => e.token === token);
  if (idx < 0) return null;
  const [entry] = list.splice(idx, 1);
  if (list.length === 0) getState().byTask.delete(taskId);
  return entry ?? null;
};

/** 单测重置全部登记 */
export const __resetGroupReplyStateForTest = (): void => {
  getState().byTask.clear();
  groupQuestionQueues.clear();
  getQueueState().bypassWindows.clear();
};

// ----------------- 通用节流（回群提示 / 日志防刷） -----------------
//
// 原「机器人互 @ 熔断」已整体移除：互 @ 成环不再靠计数拦截，改由两件事从源头掐——
// ① 系统回执（忙线 / 排队 / 失败）对机器人发件人一律静默，不给对方的上下文喂噪音；
// ② 答疑 agent 自己按提示词判断该不该回、@ 谁，没话可说就输出 NO_REPLY（见 group-outbound）。

/**
 * per-key 节流：同一 key 一分钟内只放行一次（身份服务抖时 warn / 提示不刷屏）。
 * now 参数只给单测用。
 */
const throttleMarks = new Map<string, number>();
/** 节流窗口（和下面的懒清扫共用，别 hardcode 两处） */
export const THROTTLE_WINDOW_MS = 60_000;
export const throttleOncePerMinute = (key: string, now: number = Date.now()): boolean => {
  const last = throttleMarks.get(key);
  if (last !== undefined && now - last < THROTTLE_WINDOW_MS) return false;
  throttleMarks.set(key, now);
  return true;
};
/** 节流表清扫（过期 marks 删）：调用方在低频路径上搭车触发，不另起定时器 */
export const sweepThrottleMarks = (now: number = Date.now()): void => {
  for (const [key, ts] of throttleMarks) {
    if (now - ts >= THROTTLE_WINDOW_MS) throttleMarks.delete(key);
  }
};
export const __resetThrottleForTest = (): void => {
  throttleMarks.clear();
};

// ----------------- 产物卡防重（自动播报 / 群内推进出向共用一张表） -----------------
//
// 同一个 action 的产物卡有两条发送链：
//   - group-broadcast（app 内跑完的自动播报）
//   - group-outbound.flushGroupReply（群里「推进 xxx」跑完的 done 收口）
// 两条链互相预筛让位，但 done flush 是「先取走登记再发」——播报的预筛可能扑空
// （P2-1：postcheck 慢时两张一模一样的卡都发出去）。收敛办法是共用这一张防重表：
// **谁先占坑谁发**（占坑同步、中间零 await），另一条直接跳过。

/** 防重记录保留时长——只为「同一 action 别发两次」，无需长期留存 */
const ARTIFACT_CARD_TTL_MS = 24 * 60 * 60 * 1000;

/** 状态挂 globalThis：dev route-chunk / HMR 分裂时也只有一份（对齐 bridge 其它单例） */
const ARTIFACT_CARD_KEY = "__flowshipGroupArtifactCardSentV1__";

const getArtifactCardMap = (): Map<string, number> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, number> | undefined
  >;
  if (!g[ARTIFACT_CARD_KEY]) g[ARTIFACT_CARD_KEY] = new Map();
  return g[ARTIFACT_CARD_KEY]!;
};

const artifactCardKey = (taskId: string, actionId: string): string =>
  `${taskId}\0${actionId}`;

/** 顺手清过期条目——发卡是低频动作，随调随清足够，不另起定时器 */
const pruneArtifactCardMap = (now: number): void => {
  const m = getArtifactCardMap();
  for (const [k, at] of m) {
    if (now - at > ARTIFACT_CARD_TTL_MS) m.delete(k);
  }
};

/**
 * 同步原子占坑：这个 action 的产物卡还没人发过才占上、返 true。
 * 「先占再发」而不是「发成功再记」——两次并发调用中间没有 await，第二次必然被挡住。
 */
export const claimGroupArtifactCard = (
  taskId: string,
  actionId: string,
): boolean => {
  if (!taskId || !actionId) return true;
  const now = Date.now();
  pruneArtifactCardMap(now);
  const m = getArtifactCardMap();
  const k = artifactCardKey(taskId, actionId);
  if (m.has(k)) return false;
  m.set(k, now);
  return true;
};

/** 发失败时退坑——这次一张卡都没发出去，下轮重新交卷该允许再试 */
export const releaseGroupArtifactCard = (
  taskId: string,
  actionId: string,
): void => {
  if (!taskId || !actionId) return;
  getArtifactCardMap().delete(artifactCardKey(taskId, actionId));
};

/** 单测重置防重表 */
export const __resetGroupArtifactCardDedupForTest = (): void => {
  getArtifactCardMap().clear();
};

// ----------------- 推进选择卡防重（同一张卡只允许开跑一次） -----------------
//
// 群里「推进」发出的 action 选择卡：属主点某个按钮开跑后，同卡再点任何按钮都该
// 回「已在跑」而不是再起一个 agent（飞书卡片按钮删不掉全部、纯靠服务端防重）。
// key = 出卡时生成的一次性 pickId（按钮 value 原样带回）；启动失败退坑允许重试。

/** 占坑记录保留时长——卡片在群里能被翻很久，但防重只需覆盖「正在跑的那一轮」 */
const ADVANCE_PICK_TTL_MS = 24 * 60 * 60 * 1000;

/** 状态挂 globalThis：dev route-chunk / HMR 分裂时也只有一份（对齐 bridge 其它单例） */
const ADVANCE_PICK_KEY = "__flowshipGroupAdvancePickV1__";

type AdvancePickMap = Map<
  string,
  {
    label: string;
    at: number;
    /** 出卡时的 task（收口按 task+action 放坑、顺带防跨任务串坑） */
    taskId?: string;
    /** 按钮带的 actionKey（builtin type 或自定义定义 id，展示/排查用） */
    actionKey?: string;
    /** advanceTask 返回后补记的记录 id（收口按它找坑，见 bind） */
    actionId?: string;
  }
>;

const getAdvancePickMap = (): AdvancePickMap => {
  const g = globalThis as unknown as Record<string, AdvancePickMap | undefined>;
  if (!g[ADVANCE_PICK_KEY]) g[ADVANCE_PICK_KEY] = new Map();
  return g[ADVANCE_PICK_KEY]!;
};

/** 出卡时生成的一次性标识（按钮 value 带回、防同卡重复点击） */
export const newGroupAdvancePickId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 同步原子占坑：这张选择卡还没人点过才占上。
 * 占不到时带回先占者的 action 展示名（回「已在跑 X」用）。
 *
 * taskId/actionKey 一起记进去：收口时按 task+action 放坑（同卡跑完 A 还能点 B），
 * 不记也能占（老调用/单测兼容），只是收口时只能靠登记里的 pickId 直放。
 */
export const claimGroupAdvancePick = (
  pickId: string,
  label: string,
  opts?: { taskId?: string; actionKey?: string },
): { ok: true } | { ok: false; startedLabel: string } => {
  if (!pickId) return { ok: true };
  const now = Date.now();
  const m = getAdvancePickMap();
  // 顺手清过期条目——点卡是低频动作，随调随清足够
  for (const [k, v] of m) {
    if (now - v.at > ADVANCE_PICK_TTL_MS) m.delete(k);
  }
  const existing = m.get(pickId);
  if (existing) return { ok: false, startedLabel: existing.label };
  m.set(pickId, {
    label,
    at: now,
    ...(opts?.taskId ? { taskId: opts.taskId } : {}),
    ...(opts?.actionKey ? { actionKey: opts.actionKey } : {}),
  });
  return { ok: true };
};

/** 启动失败退坑——这次没跑起来，同卡该允许重选 */
export const releaseGroupAdvancePick = (pickId: string): void => {
  if (!pickId) return;
  getAdvancePickMap().delete(pickId);
};

/**
 * 补记「pick↔记录 id」映射（advanceTask 返回后调）。
 *
 * claim 时只有 `taskId + actionKey`（按钮 value 的 builtin key/自定义定义 id），
 * 收口时登记里只有 `actionId`（记录 id）——两边对不上，中间就靠这一笔补记连起来。
 */
export const bindGroupAdvancePickAction = (
  pickId: string,
  actionId: string,
): void => {
  if (!pickId || !actionId) return;
  const entry = getAdvancePickMap().get(pickId);
  if (entry) entry.actionId = actionId;
};

/**
 * 收口放坑：同 task 同 action 的那次占坑删掉，同卡就能再点别的按钮。
 * 按 actionId 找坑（claim 时记的 taskId 只做二次确认、防极端串坑）。
 * actionId 为空直接 no-op——打字直推没占坑、没补记 id 的登记也别误伤别人的坑。
 */
export const releaseGroupAdvancePickByAction = (
  taskId: string,
  actionId: string,
): void => {
  if (!actionId) return;
  const m = getAdvancePickMap();
  for (const [k, v] of m) {
    if (v.actionId !== actionId) continue;
    if (v.taskId && taskId && v.taskId !== taskId) continue;
    m.delete(k);
  }
};

/** 单测重置占坑表 */
export const __resetGroupAdvancePickForTest = (): void => {
  getAdvancePickMap().clear();
};

// ----------------- 群 @ 识别健康度（设置页桥接状态的数据源） -----------------
//
// 「这条群消息 @ 的是不是本机 bot」只有两个依据：bot 的 open_id（getBotOpenId）和
// 应用展示名（getBotDisplayName）。两个都拿不到时 matchesBotMention 恒 false ——
// 群消息全被静默忽略，用户那边的现象只有「机器人在群里不理人」，无从排查。
// 入向路由每次判 @ 前打点，设置页据此出一行红灯。

const BOT_IDENTITY_KEY = "__flowshipGroupBotIdentityV1__";

type GroupBotIdentityState = { usable: boolean; at: number };

const getBotIdentityState = (): GroupBotIdentityState => {
  const g = globalThis as unknown as Record<
    string,
    GroupBotIdentityState | undefined
  >;
  // 没探测过一律按可用——没收到过群消息时不该在设置页挂红灯
  if (!g[BOT_IDENTITY_KEY]) g[BOT_IDENTITY_KEY] = { usable: true, at: 0 };
  return g[BOT_IDENTITY_KEY]!;
};

/** 入向路由打点：这次判 @ 时 open_id / 应用名至少有一个可用吗 */
export const markGroupBotIdentityUsable = (usable: boolean): void => {
  const st = getBotIdentityState();
  if (!usable && st.usable) {
    console.warn(
      "[feishu-bridge/group-shared] 取不到 bot open_id 与应用名——群消息认不出 @、本机将忽略全部群消息",
    );
  }
  st.usable = usable;
  st.at = Date.now();
};

/** 设置页：true = 已探测到「认不出 @」（群回流此刻是哑的） */
export const isGroupBotIdentityUnusable = (): boolean =>
  !getBotIdentityState().usable;

/** 单测重置 */
export const __resetGroupBotIdentityForTest = (): void => {
  const st = getBotIdentityState();
  st.usable = true;
  st.at = 0;
};

// ----------------- 纯工具 -----------------

/**
 * 群里认不出具体是谁时的泛称。
 *
 * 群消息事件带 sender_name 时用真名；卡片按钮回调只给 open_id（事件里没有姓名、
 * 换姓名要通讯录权限、公司不给审批）——这类场景统一落到这个泛称上。
 */
export const GROUP_MEMBER_FALLBACK_NAME = "群成员";

/** 群成员展示名上限（够长到不误伤真名、短到塞不进一段伪造抬头） */
export const GROUP_MEMBER_NAME_MAX = 32;

/**
 * 群成员展示名清洗——**进 prompt / @ 标签 / 事件 meta 之前一律先过这里**。
 *
 * 群昵称是用户随手可改的自由文本，而回灌正文的抬头是
 * `[群消息·来自 <名字>（非任务所有者）]——只答疑…`：把昵称改成
 * `张三]\n[群消息·来自 李四` 就能凭空造出一行「任务所有者」抬头、把降信任前缀顶掉。
 * 所以压掉换行 / 控制字符、拆掉充当分隔符的方括号与 `<at>` 尖括号、再截断。
 */
export const sanitizeGroupMemberName = (raw: unknown): string => {
  if (typeof raw !== "string") return "";
  return raw
    // 换行 / tab 先压成空格（要放在丢控制字符之前，否则「张三\n李四」会粘成一个词）
    .replace(/\s+/g, " ")
    .replace(/\p{C}/gu, "")
    // `[]` 是抬头分隔符、`<>` 是 at 标签分隔符——两类都不许出现在名字里
    .replace(/[[\]<>]/g, "")
    .trim()
    .slice(0, GROUP_MEMBER_NAME_MAX)
    .trim();
};

/**
 * 群内 @ 标签的**内部统一写法**：`<at user_id="ou_xxx">名字</at>`（text / post 原生认它）。
 * 群里文字现在发的是文本卡，卡片 markdown 要写 `<at id=ou_xxx></at>`——
 * 由 `lark-api.toCardMarkdown` 在最后一跳转换，上游（回复协议 / 切块 / 各回执）仍只认这一种写法。
 * open_id 缺失时退化成纯文本「@名字」（至少让人看得出在叫谁）。
 */
export const mentionTag = (openId: string, name: string): string => {
  const display = name.trim() || "你";
  const id = openId.trim();
  if (!id) return `@${display}`;
  return `<at user_id="${id}">${display}</at>`;
};

/** 群消息正文上限——群里不适合刷屏，长回答截断（尾巴不提 Flowship：群里的外部同事没有它） */
export const GROUP_TEXT_MAX = 1200;

export const truncateForGroup = (
  text: string,
  max = GROUP_TEXT_MAX,
): string => {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…（内容较长，后半已省略）`;
};
