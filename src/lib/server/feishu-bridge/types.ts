/**
 * 飞书 chat 桥接共享类型（S1）
 *
 * 入向事件字段对齐真实样本 docs/feishu-event-sample-im-message.json；
 * 卡片按钮 value 走结构化对象（飞书回调原样回传）。
 */

/** 卡片 header 配色模板（流式中 blue、成功 green、失败 red） */
export type CardHeaderTemplate = "blue" | "green" | "red" | "orange" | "purple" | "wathet" | "turquoise" | "yellow" | "grey";

/** ask_user 选项按钮 / 错误重试按钮内嵌的 value 结构 */
export type CardButtonValue =
  | {
      /** 答题卡选项 */
      kind: "ask";
      taskId: string;
      askId: string;
      questionId: string;
      optionId: string;
    }
  | {
      /** 错误终态「重试」——重发上一条用户消息 */
      kind: "retry";
      taskId: string;
      /** 可选：便于回调侧拼提示，不依赖也可重发 */
      lastUserMessage?: string;
    };

/** 入向 im.message.receive_v1 精简后的消息（consumer 解析 NDJSON 后的形态） */
export interface FeishuInboundMessage {
  type: string;
  /** 事件 / 消息 id（样本里与 message_id 相同） */
  event_id?: string;
  id?: string;
  message_id: string;
  create_time: string;
  chat_id: string;
  /** 样本为 p2p；群聊忽略 */
  chat_type: string;
  message_type: string;
  /** 发送人 open_id（ou_xxx） */
  sender_id: string;
  /** 文本内容，或其它类型的原始 JSON 字符串 */
  content: string;
  /** 用户「回复」某条消息时的根消息 id——用于 card-map 锚定 */
  root_id?: string;
  parent_id?: string;
  timestamp?: string;
}

/** card-map 单条：发出去的 interactive 消息 ↔ 本轮卡片 ↔ chat task */
export interface CardMapEntry {
  messageId: string;
  cardId: string;
  taskId: string;
  createdAt: number;
}

/** 落盘结构：条目 FIFO + 断线补拉游标 */
export interface CardMapStore {
  entries: CardMapEntry[];
  /** 上次成功处理的入向消息 create_time（毫秒字符串或数字串） */
  lastProcessedTs: string;
}

/** createCardStream 构造选项 */
export interface CardStreamOptions {
  /** 卡片 header 标题（chat 标题） */
  title: string;
  /** 接收人 open_id；省略则用 getBotAppInfo() 的 ownerOpenId */
  openId?: string;
}

/** start() 时可选的 app 侧回显 */
export interface CardStreamStartOpts {
  echoText?: string;
  /** 已上传飞书的 image_key 列表，嵌进引用块 */
  echoImageKeys?: string[];
}

/** appendAskUser 入参（对齐 AskUserQuestion + 本轮 askId） */
export interface CardStreamAskQuestion {
  id: string;
  question: string;
  options?: Array<{ id: string; label: string }>;
  allowText?: boolean;
}

export interface CardStreamAppendAskOpts {
  askId: string;
  questions: CardStreamAskQuestion[];
}

/** finalize 统计 */
export interface CardStreamFinalizeOpts {
  ok: boolean;
  durationMs?: number;
  model?: string;
  error?: string;
  /**
   * 终态样式扩展：用户 stop 等非自然完成（ok 仍可为 true）。
   * 与 pending ask 等待态互斥——outbound 按 runStatus 判定后传入。
   */
  outcome?: "stopped";
}

/** 单轮卡片句柄（card-stream 返回） */
export interface CardStreamHandle {
  /** 创建卡片实体并发送 interactive 消息；失败静默降级 */
  start: (opts?: CardStreamStartOpts) => Promise<void>;
  /** 推送「思考与工具」折叠区全量文本（节流） */
  pushProcess: (fullText: string) => void;
  /** 推送正文全量文本（节流） */
  pushAnswer: (fullText: string) => void;
  /** 更新 header 状态行；合并进下次 flush */
  setHeaderStatus: (subtitle: string, template?: CardHeaderTemplate) => void;
  /** 追加 ask_user 问题 markdown + 选项按钮 */
  appendAskUser: (opts: CardStreamAppendAskOpts) => Promise<void>;
  /** 错误终态追加「重试」按钮 */
  appendRetryButton: (lastUserMessage: string) => Promise<void>;
  /** 刷余量 → 关 streaming → header/footer 终态 */
  finalize: (opts: CardStreamFinalizeOpts) => Promise<void>;
  /** lark 调用累计失败次数（坑 #10 静默降级可观测） */
  getFailCount: () => number;
  /** 发出后的飞书 message_id / card_id（start 成功后才有） */
  getIds: () => { messageId?: string; cardId?: string };
}

/** getBotAppInfo 缓存结果 */
export interface BotAppInfo {
  appId: string;
  /** 应用 owner.open_id——桥接「本人」身份来源 */
  ownerOpenId: string;
  appName?: string;
}

/** lark-cli 结构化错误（含权限引导字段） */
export class LarkApiError extends Error {
  readonly code?: number | string;
  readonly permissionViolations?: unknown;
  readonly consoleUrl?: string;
  readonly raw?: unknown;

  constructor(
    message: string,
    opts: {
      code?: number | string;
      permissionViolations?: unknown;
      consoleUrl?: string;
      raw?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "LarkApiError";
    this.code = opts.code;
    this.permissionViolations = opts.permissionViolations;
    this.consoleUrl = opts.consoleUrl;
    this.raw = opts.raw;
  }
}

/** 发文本 / 发卡片成功后的最小回执 */
export interface SendMessageResult {
  chat_id: string;
  message_id: string;
}
