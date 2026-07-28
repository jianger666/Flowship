/**
 * 「用户不答提问、直接发新消息」＝ 隐式跳过这组提问（chat / task 两种模式共用）
 *
 * # 背景（用户实测）
 *
 * agent 调 `ask_user` 之后用户往往已经自己有答案了，于是绕过答题卡直接在输入框说话。
 * 原来 chat 模式那条链一个字都没处理这件事：答题卡永远挂在事件流里、顶部「AI 在等你
 * 回答」悬浮条一直亮、推进按钮被 `canAdvance` 里的未答 ask 判定按住——用户原话
 * 「像牛皮癣一样」。task 模式虽然作废了旧 ask，但作废原因写的是中性「失效」、
 * 也没同步飞书那边的答题卡。
 *
 * # 协议（三段式：claim → commit / rollback）
 *
 * 「答」和「跳过」是同一组 ask 的两个出口，**只能有一个赢**。仲裁者只有一个：
 * `chat-pending` 的 pendingAsks 登记表——认领 = 同步原子摘走（{@link takePendingAskIf}）。
 *
 * 1. **claim**（同步、零 await、发消息链一进门就调）：摘到才算这轮由我跳过；
 *    摘不到 = 答题链已经抢先，本轮什么都不做（不写事件、不加 prompt 提示、不动卡片）
 * 2. **commit**（消息**确认交给 agent 之后**）：写作废事件（`meta.supersededAskId`
 *    + `askSkipped`）+ 置飞书卡片终态。幂等
 * 3. **rollback**（消息没送出去：4xx / 5xx / 抛错）：把登记原样放回，用户还能回去答题
 *
 * 提交点必须**紧贴真实副作用**（本仓铁律）：send 成功 / 入队成功 / 起会话成功之后才
 * commit，绝不在「打算发」的时候先写事件。
 *
 * # 孤儿 ask（内存里没登记、事件却还未了结）
 *
 * 进程重启 / agent 异常退出后 pendingAsks 会丢，但 `ask_user_request` 事件仍未了结——
 * 答题卡照样挂着。这种没有登记可摘，直接按事件收口。
 *
 * 「登记没了」有两种含义，靠 `chat-pending.wasAskTakenRecently` 区分：**本进程刚摘走**
 *（答题链在飞）就放手，否则才当孤儿。这张打点表是内存态、重启后天然为空，正好对上。
 * 答题那条链对孤儿走的是「僵尸态唤醒」，它入口先看 `isAskSkipped` 让路。
 */

import {
  ASK_SKIPPED_META_KEY,
  askIdOfEvent,
  extractAskQuestions,
  findPendingAskEvent,
} from "@/lib/ask-pending";
import type { AskUserQuestion, Task } from "@/lib/types";

import {
  clearAskTakenMark,
  getPendingAsk,
  markAskSettlingWithoutPending,
  restorePendingAskIf,
  takePendingAskIf,
  wasAskTakenRecently,
  type PendingAsk,
} from "./chat-pending";
import { writeEventAndPublish } from "./task-stream";

const LOG = "[ask-skip]";

/**
 * 拼进 agent 消息最前面的一句上下文。
 *
 * 不加这句的话 agent 看不出「刚才那组问题被无视了」，多半会换个说法再问一遍
 *（用户实测过的老毛病）。同时留一个后门：信息真的必要时允许结合新消息重新问。
 */
export const ASK_SKIP_AGENT_HINT =
  "（提示：你上一组提问用户没有回答、已跳过——直接按下面这条新消息继续；若其中信息仍然必要、结合新消息重新问一次。）\n\n";

/** 事件流里那条作废记录的文案（UI 会把它折成一行「已跳过」） */
export const ASK_SKIP_EVENT_TEXT =
  "上一组提问已跳过（你直接发了新消息）、无需再回答。";

/** 认领到的一次跳过 */
interface AskSkipClaim {
  askId: string;
  /** 作废事件挂到提问所属的 action 上（跟 supersedePendingAsks 同口径） */
  actionId?: string;
  questions: AskUserQuestion[];
  /** 摘到的内存登记；null = 孤儿 ask（重启后登记已丢），回滚时无需放回 */
  taken: PendingAsk | null;
}

/**
 * 一次跳过的句柄。**永远非空**（没东西可跳时是个惰性壳），调用方不必判空。
 */
export interface AskSkipHandle {
  /** 拼进 agent 消息的上下文；没跳过任何东西时是空串 */
  readonly hint: string;
  /** 本轮真的认领到了一组提问吗（单测 / 日志用） */
  readonly claimed: boolean;
  /** 消息已交给 agent → 落作废事件 + 置飞书卡片终态。幂等、绝不抛 */
  commit: () => Promise<void>;
  /** 消息没送出去 → 把登记放回让用户还能答。幂等；已 commit 则什么都不做 */
  rollback: () => void;
}

const NOOP_HANDLE: AskSkipHandle = {
  hint: "",
  claimed: false,
  commit: async () => undefined,
  rollback: () => undefined,
};

/**
 * 同步认领「跳过当前这组提问」。**必须在任何 await 之前调**——它是与答题链互斥的那一步。
 *
 * @param task 请求入口读到的 task（只用它的 events 找当前未了结的那条 ask）
 * @returns 句柄；没有待答提问 / 已被答题链抢走时返回惰性壳
 */
export const beginAskSkip = (task: Task): AskSkipHandle => {
  const ev = findPendingAskEvent(task.events);
  if (!ev) return NOOP_HANDLE;
  const askId = askIdOfEvent(ev);
  if (!askId) return NOOP_HANDLE;

  const token = typeof ev.meta?.token === "string" ? ev.meta.token : undefined;
  const registered = getPendingAsk(task.id);
  let taken: PendingAsk | null = null;
  if (registered) {
    // 有活登记：必须原子摘到本组才算赢（摘不到 = 答题链先到 / 已被新提问顶替）
    taken = takePendingAskIf(task.id, askId, token);
    if (!taken) return NOOP_HANDLE;
  } else if (wasAskTakenRecently(task.id, askId)) {
    // 登记没了但**是本进程刚摘走的** = 答题链正在投递 / 已了结（reply 事件还没落盘的窗口）。
    // 这时抢着标「跳过」，agent 会同时收到答案和「上一组问题跳过了」两条矛盾指令
    return NOOP_HANDLE;
  } else {
    // 登记为空且本进程没摘过 = 真孤儿（进程重启 / agent 异常退出后登记丢了）：
    // 按事件收口，否则那张答题卡永远挂着。没登记可摘 → 打个占位，
    // 并发的第二条消息就不会也认领一遍、各写一条跳过标记
    markAskSettlingWithoutPending(task.id, askId);
  }

  const claim: AskSkipClaim = {
    askId,
    actionId: ev.actionId,
    questions: extractAskQuestions(ev.meta),
    taken,
  };
  return makeHandle(task.id, claim);
};

const makeHandle = (taskId: string, claim: AskSkipClaim): AskSkipHandle => {
  // 单向状态：commit / rollback 只允许发生一次，之后都是 no-op
  let settled = false;
  return {
    hint: ASK_SKIP_AGENT_HINT,
    claimed: true,
    commit: async () => {
      if (settled) return;
      settled = true;
      await commitAskSkip(taskId, claim);
    },
    rollback: () => {
      if (settled) return;
      settled = true;
      if (claim.taken) {
        // 有登记就放回（restorePendingAskIf 顺带撤打点）——用户还能回去答
        restorePendingAskIf(taskId, claim.taken);
        return;
      }
      // 孤儿分支没有登记可放回、认领时只在 takenAsks 打了个占位。占位不撤的话接下来
      // 一整个 TTL 里用户每发一条消息都会命中 wasAskTakenRecently → 跳过永远认领不上、
      // 答题卡持续挂着（协议说的「没送出去就当什么都没发生」在孤儿路径上落空了）
      clearAskTakenMark(taskId, claim.askId);
    },
  };
};

/** 落作废事件 + 置飞书卡片终态。整段吞异常——消息已经发出去了，收尾失败不该报错给用户 */
const commitAskSkip = async (
  taskId: string,
  claim: AskSkipClaim,
): Promise<void> => {
  try {
    // 走同一个「作废」语义（meta.supersededAskId）——了结判定只有 ask-pending 一套；
    // askSkipped 额外说明「作废原因是用户主动跳过」，UI 据此收成一行「已跳过」
    await writeEventAndPublish(taskId, {
      kind: "info",
      actionId: claim.actionId,
      text: ASK_SKIP_EVENT_TEXT,
      meta: {
        supersededAskId: claim.askId,
        [ASK_SKIPPED_META_KEY]: true,
      },
    });
  } catch (err) {
    console.warn(
      `${LOG} 写跳过事件失败 task=${taskId} ask=${claim.askId}:`,
      err instanceof Error ? err.message : err,
    );
    // 事件没落盘 = 事件流里没有跳过标记、答题卡还挂着；而登记已被摘走、commit 又不能
    // 放回（跳过 hint 已随消息交给 agent 了、放回等于让用户对着已继续的 agent 答题）。
    // 撤掉「有人在了结」的打点 → 用户下一条消息立刻能按孤儿把这组提问重新收口，
    // 把自愈窗口从一整个打点 TTL 缩到零
    clearAskTakenMark(taskId, claim.askId);
  }
  if (claim.questions.length === 0) return;
  try {
    // 动态 import：feishu-bridge 那张图不该被 chat / task 注入链静态挂上
    //（card-action 反过来还 import chat-inject，静态连边直接成环）
    const {
      ASK_CARD_SKIPPED_HINT,
      ASK_CARD_SKIPPED_NOTE,
      settleAskCards,
    } = await import("./feishu-bridge/ask-card-settle");
    await settleAskCards({
      taskId,
      askId: claim.askId,
      questions: claim.questions,
      fallbackNote: ASK_CARD_SKIPPED_NOTE,
      hintNote: ASK_CARD_SKIPPED_HINT,
    });
  } catch (err) {
    console.warn(
      `${LOG} 置飞书卡片终态失败 task=${taskId} ask=${claim.askId}:`,
      err instanceof Error ? err.message : err,
    );
  }
};
