/**
 * 飞书 chat 桥接共享类型（S1）
 *
 * 入向事件字段对齐真实样本 docs/feishu-event-sample-im-message.json；
 * 卡片按钮 value 走结构化对象（飞书回调原样回传）。
 */

/** 卡片 header 配色模板（Hermes 全态：思考 indigo、生成 blue、成功 green、失败 red、等待 orange、停止 grey） */
export type CardHeaderTemplate = "blue" | "green" | "red" | "orange" | "purple" | "indigo" | "wathet" | "turquoise" | "yellow" | "grey";

/** 控制面板卡快捷按钮对应的命令（等价文本命令） */
export type PanelCommand = "new" | "clean" | "status" | "chats" | "model";

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
    }
  | {
      /**
       * 对话遥控器（/chats 一家）：换对话 / 新对话 / 换模型 / 搜，全走这一种 value。
       * 卡片只管把参数带回来，过滤/翻页/建对话都在点击时按最新数据重算。
       */
      kind: "chats";
      op:
        | "panel"
        | "switch"
        | "list"
        | "repos"
        | "repo"
        | "new"
        | "new_model"
        | "create"
        | "model"
        | "model_set"
        | "models_all"
        | "search_hint";
      /** switch / model_set 上下文带的 task */
      taskId?: string;
      /** 翻页（list / repos / models_all） */
      page?: number;
      /** 仓库 path（repo 筛选 / 新对话选仓） */
      repo?: string;
      /** 列表含归档 */
      archived?: boolean;
      /** 要切/要建的模型 id */
      modelId?: string;
      /** 仓库列表点进去的目的地 */
      purpose?: "switch" | "new";
      /** model_set 给新对话用（建对话），不带 = 给现有对话换模型 */
      forNew?: boolean;
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
  /** 发送人身份：user / app(bot) / 缺省当 user（只读补拉链路用） */
  sender_type?: string;
  /** 发送方 app_id（cli_xxx，bot 消息才有；live 事件 sender 形态不定、缺了即空） */
  sender_app_id?: string;
  /** 发送方机器人 open_id（ou_xxx，bot 消息才有；关联判定时与 sender_id 二选一） */
  sender_bot_open_id?: string;
  /** 发送人姓名（enrichment 有时带；缺则由成员映射表兜底） */
  sender_name?: string;
  /** 群消息里被 @ 的人（p2p 无）——判「有没有 @ 本机 bot」用 */
  mentions?: FeishuMention[];
  /** 文本内容，或其它类型的原始 JSON 字符串 */
  content: string;
  /** 用户「回复」某条消息时的根消息 id——用于 card-map 锚定 */
  root_id?: string;
  parent_id?: string;
  /** 被回复的消息 id（enrichment 形态；关联消费取被指内容用） */
  reply_to?: string;
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

/** 卡片熔断器打开时的回调入参（card-stream → outbound） */
export interface CardStreamBreakerInfo {
  /** 连续失败次数 */
  consecutiveFails: number;
  /** 多久后放行下一次探测（ms） */
  retryInMs: number;
  /** 最近一次失败（已瘦身：一行摘要 + 错误码 / 命令 / log_id 等结构化字段，不带 raw） */
  error: unknown;
  /**
   * 仅「致命」故障才有（B4-3）：这类故障再试也不会好，熔断不会半开探测——
   * `gone` / `auth`：本轮不再同步到飞书；`too_long`：结束时发截断版；`stream_closed`：流式重开次数用完、结束时整卡同步一次。
   * 普通熔断（连续失败 / 限流 / 瞬时）没有这个字段，对象形状与 B1 完全一致。
   */
  fatalKind?: LarkFailureKind;
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
  /**
   * 持续性故障才调：熔断累计第 2 次跳闸（= 首次探测仍失败）时调一次，每张卡最多一次。
   * 1–2 秒的小抖动 3 连败即跳闸、首次探测就恢复了——那种不会调，免得给用户一条转瞬即逝的「已暂停」。
   * 用途：outbound 当场落一条 info——不用等 finalize，用户此刻就知道「飞书卡片在掉线」。
   * 回调自己抛的异常会被吞：观测回调不能拖垮卡片流。
   */
  onBreakerOpen?: (info: CardStreamBreakerInfo) => void;
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

/**
 * 卡片同步健康度：outbound 用它判定「用户在飞书里看到的是不是完整回复」。
 * 累计失败数（failCount）会随偶发抖动只增不减，不能当「现在是否同步失败」的依据——
 * 看 finalizeOk（终稿到没到）和 breakerOpen（此刻是否在持续失败）。
 */
export interface CardStreamHealth {
  /** lark 调用累计失败次数（同 getFailCount） */
  failCount: number;
  /** 当前连续失败次数；任一次成功即清零 */
  consecutiveFails: number;
  /** 熔断器此刻是否打开（打开 = 近期在持续失败，流式更新被暂停、只放行探测） */
  breakerOpen: boolean;
  /** 本卡生命周期内熔断器是否打开过（后来恢复了也算：中途丢过流式更新） */
  breakerEverOpened: boolean;
  /**
   * 终稿内容是否落到了飞书卡片：undefined = 还没 finalize；true = 已落成；
   * false = 没落成——含「start 就失败、这一轮飞书里根本没有卡」（用户看到的可能是半截内容，也可能什么都没有）。
   * 只看内容：收尾的「关 streaming_mode」失败不算（内容已完整，只是卡片在飞书侧多显示一会儿「生成中」）。
   */
  finalizeOk?: boolean;
  /** 最近一次失败（已瘦身：一行摘要 + 结构化字段，不带 raw；可能是 LarkApiError） */
  lastError?: unknown;
  /** 致命故障的类别（见 `CardStreamBreakerInfo.fatalKind`）；没有致命故障 = undefined */
  fatalKind?: LarkFailureKind;
  /**
   * 终稿为了塞进飞书卡片被截断过（卡片体积 / 命令行超限，B4-3）：true = 飞书里是截断版、完整回复在 app 里；
   * 没截断过 = undefined。`finalizeOk` 仍表示「终稿内容落到了卡片」——截断版也算落到了，要不要提示看这个字段。
   */
  truncated?: boolean;
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
  /**
   * lark 调用累计失败次数（坑 #10 静默降级可观测）。
   * 只增不减、偶发抖动也会累加——判断「现在是否同步失败」请用 getHealth。
   */
  getFailCount: () => number;
  /** 当前同步健康度（熔断器 + finalize 结果） */
  getHealth: () => CardStreamHealth;
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

// ---------- 失败分类（R14 B4-3 · Q12a-07） ----------

/**
 * 飞书 / lark-cli 失败的处置类别。**单一来源**：card-stream 的失败策略、提示文案共用这一张表，
 * 不要在各处再拿 message 正则各判各的。
 *
 * - `rate_limit`：限流（99991400 / 230020 / HTTP 429）——退避，别硬打
 * - `seq_conflict`：卡片 sequence 没严格递增（300317）——重算序号可自愈
 * - `stream_closed`：流式模式已关（200850 超时自动关 / 300309）——卡片流式 PUT 永远失败，要重新打开流式
 * - `gone`：卡片实体不存在 / 已过期（200740 / 200750，实体只活 14 天）——再试也没用
 * - `auth`：权限 / 身份（缺 scope、token 失效、应用无权操作这张卡、机器人不在会话）——再试也没用
 * - `too_long`：内容 / 参数超限（卡片体积 200860、本地命令行超长 ARGV_TOO_LONG / ENAMETOOLONG）——要缩内容
 * - `transient`：传输瞬时（断网 / 超时 / 5xx / 卡片正在交互中 200810）——退避后重试
 * - `unknown`：认不出来——按保守默认处理（连续失败熔断）
 *
 * ⚠️ 错误码取自飞书开放平台 CardKit / 通用错误码文档，其中仓库内**有真机样例**的只有
 * 99991672 / 230002 / 300317（见各处注释）；其余没有真机样例，认不出就落到 `unknown`，不会误判成致命。
 */
export type LarkFailureKind =
  | "rate_limit"
  | "seq_conflict"
  | "stream_closed"
  | "gone"
  | "auth"
  | "too_long"
  | "transient"
  | "unknown";

/** 本地预检（argv 超长）抛出的错误码——`lark-api.ts` 的 win32 命令行预检用 */
export const LARK_ARGV_TOO_LONG_CODE = "ARGV_TOO_LONG";

/** 按错误码归类（字符串比较：lark-cli 的 code 可能是数字也可能是字符串）；先到先得 */
const LARK_CODE_KINDS: ReadonlyArray<readonly [LarkFailureKind, readonly string[]]> = [
  // 200860 = Card content exceeds limit（卡片体积 30KB 上限）；ENAMETOOLONG / E2BIG = spawn 命令行超长
  ["too_long", [LARK_ARGV_TOO_LONG_CODE, "ENAMETOOLONG", "E2BIG", "200860"]],
  // 300317 = The sequence number for operating on the card did not increment consecutively（仓库内有真机样例）
  ["seq_conflict", ["300317"]],
  // 200850 = Card streaming timeout；300309 = Card streaming closed
  ["stream_closed", ["200850", "300309"]],
  // 200740 = The card entity does not exist；200750 = The card entity has expired（14 天）
  ["gone", ["200740", "200750"]],
  // 99991672 缺 scope（仓库内有真机样例）、99991661 / 99991663 / 99991668 access_token 缺失 / 失效、
  // 300311 应用无权更新这张卡、230002 机器人不在会话（feishu-group.ts 有真机样例）/ 230035 无发送权限（仅官方码表，无真机样例）
  ["auth", ["99991672", "99991661", "99991663", "99991668", "300311", "230002", "230035"]],
  // 99991400 = request trigger frequency limit；230020 = 发消息触发频率限制
  ["rate_limit", ["99991400", "230020"]],
  // 300120 = Server Internal Error；200810 = 卡片正处于用户交互回调中、暂时不能更新
  ["transient", ["300120", "200810"]],
];

/** 按文案归类（码认不出时兜底）；**顺序有意义**：更具体的在前，`transient` 在最后（"card streaming timeout" 不能被 timeout 吃掉） */
const LARK_TEXT_KINDS: ReadonlyArray<readonly [LarkFailureKind, RegExp]> = [
  ["seq_conflict", /sequence number|sequence.{0,30}(compare|increment|conflict)|序号.{0,10}(冲突|递增)/i],
  ["stream_closed", /streaming (mode )?(is )?closed|card streaming timeout|streaming timeout/i],
  [
    "gone",
    /card entity (does not exist|has expired)|(message|card).{0,20}(has been |was |is )?(recalled|withdrawn|deleted)|消息已(被)?(撤回|删除)|卡片(实体)?(不存在|已过期|已删除)/i,
  ],
  [
    "auth",
    /access denied|permission denied|no permission|lack of (the )?(required )?scope|missing (required )?scope|scope.{0,20}(not granted|missing|required)|not in (the )?chat|can not be outside|无权限|没有权限|权限不足/i,
  ],
  [
    "rate_limit",
    /\b429\b|too many requests|rate.?limit|frequency limit|trigger(s|ed)? (the )?frequency|请求(过于)?频繁|频率(限制|过高)|限流/i,
  ],
  [
    // 只认「内容 / 参数 / 命令行」一类的超限说法——裸 "too long" 可能是 "request took too long"（超时），不能当超限
    "too_long",
    /ARGV_TOO_LONG|ENAMETOOLONG|E2BIG|argument list too long|(content|card|message|text|payload|body|argument|parameter)s?[^.\n]{0,40}(exceeds?|exceeded|reaches?|too (long|large|big)|over)[^.\n]{0,24}(limit|size|length|characters)|(内容|卡片|消息|文本|参数|正文)[^。\n]{0,8}(过长|超长|超出[^。\n]{0,4}(限制|上限)|超限)|体积超限/i,
  ],
  [
    "transient",
    /internal (server )?error|service unavailable|bad gateway|gateway time-?out|服务内部错误|系统繁忙|server busy/i,
  ],
];

/** 判定用全文的单段上限：message 看头、stdout / stderr 看尾（错误原因在尾部），避免对几十 KB 的 argv 跑正则 */
const FAILURE_TEXT_SEGMENT_MAX = 2000;

const failureEvidenceText = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err ?? "").slice(0, FAILURE_TEXT_SEGMENT_MAX);
  // stdout / stderr：LarkApiError 挂在 raw 里，原生 execFile 错误直接挂在自己身上
  const raw = (err as { raw?: unknown }).raw as { stdout?: unknown; stderr?: unknown } | undefined;
  const direct = err as { stdout?: unknown; stderr?: unknown };
  const pick = (v: unknown): string =>
    typeof v === "string" ? v.slice(-FAILURE_TEXT_SEGMENT_MAX) : "";
  const message = err.message ?? "";
  // `Command failed: <整条命令行>\n<stderr>`：命令行里是 `--data` 整卡 / 任务正文（用户随便写什么都可能出现
  // "access denied" / "rate limit" 之类的字样）——这种 message 不看，只看 stderr / stdout 的尾部
  const argvBearing = message.startsWith("Command failed:");
  return [
    argvBearing ? "" : message.slice(0, FAILURE_TEXT_SEGMENT_MAX),
    pick(raw?.stdout ?? direct.stdout),
    pick(raw?.stderr ?? direct.stderr),
  ].join("\n");
};

/**
 * 把一次飞书 / lark-cli 失败归到 `LarkFailureKind`。
 *
 * 判据顺序：① 错误码（最硬）→ ② `permissionViolations` 非空 → `auth` → ③ 文案正则（码认不出时兜底）→
 * ④ 既有的传输瞬时判据（`isTransientLarkMessage`，看的是剔除了命令行的判定全文）→ ⑤ `unknown`。
 * 吃任意抛出物：非 Error 只看字符串化后的文案；`code` 取 `err.code`（LarkApiError / Node 系统错误都有）。
 */
export const classifyLarkFailure = (err: unknown): LarkFailureKind => {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "number" || typeof code === "string") {
    const key = String(code);
    for (const [kind, codes] of LARK_CODE_KINDS) {
      if (codes.includes(key)) return kind;
    }
  }
  if (err instanceof LarkApiError) {
    const pv = err.permissionViolations;
    if (Array.isArray(pv) ? pv.length > 0 : Boolean(pv)) return "auth";
  }
  const text = failureEvidenceText(err);
  for (const [kind, re] of LARK_TEXT_KINDS) {
    if (re.test(text)) return kind;
  }
  // 传输瞬时：看判定用全文（带命令行的 message 已被剔除），不用 isTransientLarkError(err)——
  // 它会拿 `Command failed: <整条命令行>` 的 message 去匹配，正文里有 "network" / "timeout" 就误判
  return isTransientLarkMessage(text) ? "transient" : "unknown";
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
