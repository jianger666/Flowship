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
}

export const TALK_QUEUE_SOURCE_LABEL: Record<TalkQueueSource, string> = {
  app: "我",
  group_owner: "我（群里）",
  group_reply: "群回执",
  group_question: "群提问",
};
