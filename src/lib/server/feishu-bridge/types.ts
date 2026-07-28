/**
 * 飞书 chat 桥接共享类型（S1）
 *
 * 入向事件字段对齐真实样本 docs/feishu-event-sample-im-message.json；
 * 卡片按钮 value 走结构化对象（飞书回调原样回传）。
 */

/** 卡片 header 配色模板（Hermes 全态：思考 indigo、生成 blue、成功 green、失败 red、等待 orange、停止 grey） */
export type CardHeaderTemplate = "blue" | "green" | "red" | "orange" | "purple" | "indigo" | "wathet" | "turquoise" | "yellow" | "grey";

/** 控制面板卡快捷按钮对应的命令（等价文本命令：/new 无参 / 直发 /stop / /status） */
export type PanelCommand = "new" | "clean" | "status";

/** ask_user 选项 / 重试 / 清理卡 / 控制面板按钮内嵌的 value 结构 */
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
    }
  | {
      /** 清理卡「结束」——该对话飞书侧出局（app 数据不动） */
      kind: "end_chat";
      taskId: string;
    }
  | {
      /** 清理卡「全部结束」——点击时重算活跃集合、全部出局 */
      kind: "end_all";
    }
  | {
      /**
       * 需求群答题卡选项（第二批）——群内**任何人**可点（跨角色答题）、
       * 故 card-action 分发时不过「operator 必须是 owner」那道闸。
       */
      kind: "group_ask";
      taskId: string;
      askId: string;
      questionId: string;
      optionId: string;
      /** 回群通知（先到先得 / 已答提示）用 */
      chatId: string;
    }
  | {
      /**
       * 需求群推进选择卡按钮——属主本人点了开跑对应 action。
       * 属主闸在 group-route.handleGroupAdvancePick 内做（非属主要**回群提示**、
       * 不是 card-action 的静默丢弃），故分发时同 group_ask 先于 owner 闸处理。
       */
      kind: "group_advance";
      taskId: string;
      /** 回群通知（受理 / 拒绝 / 已在跑）用 */
      chatId: string;
      /** 本张卡的一次性标识（防同卡重复点击） */
      pickId: string;
      /** 内置 ActionType 或自定义 action 定义 id（app:xxx / team:xxx） */
      actionKey: string;
      /** action 展示名快照（回执文案用；缺省回退 ACTION_LABEL） */
      label?: string;
    }
  | {
      /** 控制面板快捷按钮——按 command 分发到对应命令流程 */
      kind: "cmd";
      command: PanelCommand;
    };

/** 群消息里的一条 @ 记录（官方 mentions 项归一后的形态） */
export interface FeishuMention {
  /** 占位键（`@_user_1`）——enrichment 文本里可能原样保留 */
  key?: string;
  /** 被 @ 者 open_id（机器人被 @ 时 = 机器人自己的 open_id） */
  openId?: string;
  /** 展示名 */
  name?: string;
}

/** 入向 im.message.receive_v1 精简后的消息（consumer 解析 NDJSON 后的形态） */
export interface FeishuInboundMessage {
  type: string;
  /** 事件 / 消息 id（样本里与 message_id 相同） */
  event_id?: string;
  id?: string;
  message_id: string;
  create_time: string;
  chat_id: string;
  /** `p2p` 走本人私聊链；`group` 走需求群回流链（第二批） */
  chat_type: string;
  message_type: string;
  /** 发送人 open_id（ou_xxx） */
  sender_id: string;
  /** 发送人姓名（enrichment 有时带；缺则由成员映射表兜底） */
  sender_name?: string;
  /** 群消息里被 @ 的人（p2p 无）——判「有没有 @ 本机 bot」用 */
  mentions?: FeishuMention[];
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
  /**
   * 飞书「回复」锚定用的 task（p2p 路由判据）。
   * ⚠️ 群答题卡刻意记空串——它不该参与 p2p 回复锚定（见 group-outbound.sendAskCardToGroup）。
   */
  taskId: string;
  createdAt: number;
  /**
   * 这张卡承载了「哪个 task 的哪组 ask」——答完 / 跳过时按 (askTaskId, askId) 反查
   * **所有**承载它的卡做终态 patch，不再只依赖「点击事件带回的 messageId」。
   *
   * 为什么不复用上面的 `taskId`：那一格是路由判据、群答题卡必须留空；两件事共用一格
   * 就只能二选一（欠账根因——群卡记了空串、于是只有「从这张卡点」的分支能置态）。
   */
  askTaskId?: string;
  askId?: string;
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
  /**
   * 是否走 CardKit 流式打字机（设置页「流式回复」）。默认 true。
   * false = turn 内只累积状态，finalize 一次性发普通卡（streaming_mode 关）。
   * 在 create 时定稿，turn 中途改设置不影响本轮。
   */
  streaming?: boolean;
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

/**
 * `GET /open-apis/bot/v3/info` 归一结果（机器人**自己**的身份、非应用 owner）。
 * 免审基础 scope，两个字段都不会变、进程内缓存一次即可。
 */
export interface BotSelfInfo {
  /** 机器人自己的 open_id——群里 @ 机器人时 mention 里的就是它 */
  openId: string;
  /** 机器人展示名——群成员列表 / 添加机器人搜索框里看到的名字 */
  appName?: string;
}

/** lark-cli 结构化错误（含权限引导字段） */
export class LarkApiError extends Error {
  readonly code?: number | string;
  readonly permissionViolations?: unknown;
  readonly consoleUrl?: string;
  /** 飞书排障关键字段——工单 / open.feishu.cn 搜索都靠它定位这次请求 */
  readonly logId?: string;
  /** 参数校验类错误（99992402 一族）的违规字段清单 */
  readonly fieldViolations?: unknown;
  /** 出错的那条命令（`api POST /open-apis/...` / `im +messages-send`） */
  readonly api?: string;
  readonly raw?: unknown;

  constructor(
    message: string,
    opts: {
      code?: number | string;
      permissionViolations?: unknown;
      consoleUrl?: string;
      logId?: string;
      fieldViolations?: unknown;
      api?: string;
      raw?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "LarkApiError";
    this.code = opts.code;
    this.permissionViolations = opts.permissionViolations;
    this.consoleUrl = opts.consoleUrl;
    this.logId = opts.logId;
    this.fieldViolations = opts.fieldViolations;
    this.api = opts.api;
    this.raw = opts.raw;
  }
}

/**
 * 传输层瞬时失败（网络抖 / 连接被掐 / 取 token 时断流）——**单一来源**。
 *
 * 判据是「这次调用压根没走完一次完整往返」，不是业务拒绝：权限不足、参数非法、
 * bot 不在群都不在此列（那些重试多少次都是同一个结果）。
 *
 * 两处消费：① 设置页探测把它渲染成「网络异常、点重试」而不是误导性的
 * 「权限缺失 → 去开通」（2026-07-20 同事实测踩过）；② `runLark` 的安全重试闸。
 */
export const isTransientLarkMessage = (msg: string): boolean =>
  /EOF|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN|fetch failed|timeout|network|socket hang up|socket disconnect|connection reset|broken pipe/i.test(
    msg,
  );

/**
 * 同上、直接吃 Error 对象（非 Error 一律不算瞬时——宁可不重试也别重复副作用）。
 *
 * `LarkApiError` 要连原始 stdout / stderr 一起看：CLI 的传输层报错解析不出 JSON 时，
 * message 只剩一句「Command failed」、真正的 `EOF` / `ECONNRESET` 全在 raw 里
 *（只看 message 会把瞬时抖动误判成业务错误）。
 */
export const isTransientLarkError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  if (isTransientLarkMessage(err.message ?? "")) return true;
  if (!(err instanceof LarkApiError)) return false;
  const raw = err.raw as { stdout?: unknown; stderr?: unknown } | undefined;
  return isTransientLarkMessage(
    [
      typeof raw?.stdout === "string" ? raw.stdout : "",
      typeof raw?.stderr === "string" ? raw.stderr : "",
    ].join("\n"),
  );
};

/**
 * 从 `field_violations` 抠出违规字段名。
 *
 * 飞书对参数校验类错误（99992402 field validation failed）只给一句无信息量的
 * 「field validation failed」，真正能定位的是这个数组 + log_id——2026-07-27
 * 踩过：`member_id_type=app_id` 非法枚举报的就是它，光看 message 完全查不出
 * 是哪个字段哪次调用。
 */
const collectFieldViolationPaths = (violations: unknown): string[] => {
  if (!Array.isArray(violations)) return [];
  const paths: string[] = [];
  for (const item of violations) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const field = rec.field ?? rec.field_path ?? rec.name;
    if (typeof field === "string" && field.trim()) paths.push(field.trim());
  }
  return paths;
};

/**
 * 把飞书结构化错误拍成一行可诊断文案（给 toast / 事件流 / 日志共用）。
 * 形如 `field validation failed（飞书 99992402 · api GET /open-apis/... · 字段 member_id_type · log_id=2026…）`
 */
export const describeLarkError = (err: LarkApiError): string => {
  const parts: string[] = [];
  if (err.code !== undefined && err.code !== null && `${err.code}`.trim()) {
    parts.push(`飞书 ${err.code}`);
  }
  if (err.api?.trim()) parts.push(err.api.trim());
  const fields = collectFieldViolationPaths(err.fieldViolations);
  if (fields.length > 0) parts.push(`字段 ${fields.join(" / ")}`);
  if (err.logId?.trim()) parts.push(`log_id=${err.logId.trim()}`);
  const base = err.message || "飞书 API 调用失败";
  return parts.length > 0 ? `${base}（${parts.join(" · ")}）` : base;
};

/** 发文本 / 发卡片成功后的最小回执 */
export interface SendMessageResult {
  chat_id: string;
  message_id: string;
}
