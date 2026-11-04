/**
 * 「待送达」队列的客户端 / 服务端共用类型（纯类型 + 无副作用小工具）。
 *
 * task 模式下 agent 正在跑时，新来的消息不再 409 拒收，而是排队：
 * - `app`：用户在任务输入条里发的（运行中也能打字、回车即排队）
 * - `group_owner`：属主本人在需求群里说的话
 * - `group_reply`：群里「托办事项」的回执（后端同事 / 后端机器人的回复），当数据喂回会话
 * - `group_question`：非属主同事的答疑提问（只读答疑旁路，一次只答一个，其余排队）
 *
 * 服务端经 SSE `talk_queue` 帧下发整份快照（纯内存、不落盘；bootstrap 时补发一帧当前值）。
 */

export type TalkQueueSource =
  | "app"
  | "group_owner"
  | "group_reply"
  | "group_question";

export interface TalkQueueItem {
  /** 队内唯一 id（app / group_owner / group_reply = 服务端发号；group_question = 飞书 message_id） */
  id: string;
  source: TalkQueueSource;
  /** 群来源：发话人展示名（app 来源缺省） */
  senderName?: string;
  /** 群来源：发话人是不是机器人 */
  senderIsBot?: boolean;
  /** 正文预览（已压空白、已截断，≤120 字） */
  preview: string;
  /** 入队时间（ms） */
  createdAt: number;
  /** 这条带图片 / 文件（编辑时允许把文字清空——只剩附件也能发；快照只带这个布尔、不带附件本体） */
  hasAttachments?: true;
  /**
   * 正在为「立即发送」让位：这条被暂存起来（stop 清不到它），窗口结束后放回队列。
   * 列表里照常显示（条数不跳变），但暂时不可编辑 / 立即发送 / 删除（服务端同样拒：409 queue_item_gone）。
   */
  held?: true;
}

export const TALK_QUEUE_SOURCE_LABEL: Record<TalkQueueSource, string> = {
  app: "我",
  group_owner: "我（群里）",
  group_reply: "群回执",
  group_question: "群提问",
};

/**
 * 排队条目能做什么（客户端按钮显隐与服务端校验**共用这一份**，别两边各写一套来源判断）：
 * - 编辑：只有 `app`——用户自己在输入条里打的话。群属主（group_owner）的话带着飞书侧的来源标记、
 *   回执（group_reply）是外部机器人的数据、群提问（group_question）走只读答疑旁路，都不是「用户自己的话」；
 * - 立即发送：`app` + `group_owner`（都是属主本人的话，语义同「我现在就要说」）。
 *   group_reply 是当数据喂回会话的，不能插队；group_question 走群模块自己的队列；
 * - 删除：所有来源（原有行为）。
 */
export const TALK_QUEUE_EDITABLE_SOURCES: readonly TalkQueueSource[] = ["app"];
export const TALK_QUEUE_SEND_NOW_SOURCES: readonly TalkQueueSource[] = [
  "app",
  "group_owner",
];

export const canEditTalkQueueItem = (it: Pick<TalkQueueItem, "source">): boolean =>
  TALK_QUEUE_EDITABLE_SOURCES.includes(it.source);

export const canSendNowTalkQueueItem = (
  it: Pick<TalkQueueItem, "source">,
): boolean => TALK_QUEUE_SEND_NOW_SOURCES.includes(it.source);

/** 编辑后正文的字数上限（与 chat 排队编辑同值；task 的普通发送路径没有单独的字数上限、只受请求体大小限制） */
export const TALK_QUEUE_EDIT_MAX_CHARS = 20000;

/**
 * 「这条已经不在队里了」（已送出 / 正在送出 / 已被删）的稳定错误码：编辑、立即发送都用它回 409，
 * 客户端据此静默对齐列表、不弹错（和 chat 排队条「已发出删不到只对齐列表」同口径）。
 */
export const TALK_QUEUE_GONE_CODE = "queue_item_gone";
