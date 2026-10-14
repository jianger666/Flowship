/**
 * 需求群协作（答疑旁路 / 出向 / UI）的**共享契约**——只放类型与常量，没有任何逻辑、没有任何 import。
 *
 * 为什么单独一个文件：群答疑涉及 roster 拉取、回复协议解析、状态快照、出向落地、UI 展示
 * 五六个模块，各自独立实现再对接。先把它们之间交换的数据形状钉在这里，各模块只依赖本文件、
 * 互不 import，改一处不牵动另一处。
 *
 * # 背景（2026-10-14 花果排课对接后端机器人的真实案例）
 * - 对端「安若流年」是后端自研机器人（不是 Flowship），比较聪明、会按上下文回话；
 * - 旧设计「答疑回答无条件真 @ 回提问人」+「失败也 @ 一句去 Flowship 看事件流」让两个机器人互 @ 成环，
 *   对端上下文还被「去 Flowship 看事件流」这类对它毫无意义的句子带偏；
 * - 新设计不再做计数熔断，改为：系统回执对机器人静默 + 答疑 agent 按提示词自己判断「回不回 / @ 谁」。
 */

// ----------------- 群成员（roster） -----------------

export type GroupMemberKind = "user" | "bot";

export interface GroupMember {
  openId: string;
  /** 展示名（群昵称 / 应用名）；拿不到时为空串，调用方按需兜底 */
  name: string;
  kind: GroupMemberKind;
}

export interface GroupRoster {
  chatId: string;
  members: GroupMember[];
  /** 拉取时间（ms）；缓存按它判过期 */
  fetchedAt: number;
  /**
   * api = lark-cli 成员列表接口；learned = 接口不可用，只靠入向消息里见过的发送人 / mention 拼出来的；
   * none = 什么都没有（members 为空）。
   */
  source: "api" | "learned" | "none";
}

// ----------------- 群历史消息（给答疑 agent 当上下文） -----------------

export interface GroupHistoryMessage {
  messageId: string;
  /** 飞书返回的原样时间串（"2026-10-14 16:29"，分钟精度） */
  createTime: string;
  senderOpenId: string;
  /** 发送人展示名；拿不到时为空串 */
  senderName: string;
  /** user = 真人；bot = 机器人；unknown = 判不出 */
  senderKind: GroupMemberKind | "unknown";
  msgType: string;
  /** 原始正文（卡片仍是 `<card>…</card>` 富文本，未净化——净化由 inbound-card-sanitize 负责） */
  content: string;
  mentions: { openId: string; name: string }[];
}

// ----------------- 答疑回复协议（agent 的最终回复 → 群里发什么） -----------------
//
// 答疑 agent 的**最终回复**（最后一段、工具调用之后的文字）按下面约定解析：
//
// 1. 整段回复 trim 后恰好是 `NO_REPLY`（大小写不敏感，允许首尾标点 / 引号 / 代码围栏）
//    → 什么都不发（对方只是确认 / 复述 / 无需回应，或系统噪音）。
// 2. 正文里写 `@名字`（名字与群成员展示名完全一致；`@宿主` / `@属主` = 任务属主本人）
//    → 系统换成真 @。认不出的 `@xxx` 原样当文本保留，并计入 unresolvedAts。
// 3. 可选一行 `[[需属主确认：一句话说明要属主定什么]]` → 系统把这行从群消息里剥掉，
//    自动补 @属主，并在 Flowship 事件流给属主写一条醒目的待办提示。
// 4. 正文里一个真 @ 都没有时：提问人是真人 → 系统在开头补 @提问人；提问人是机器人 → 不补
//    （无 @ 的话机器人看不见，这是有意的防环：答疑 agent 想让机器人看见，就得自己写 @）。

/** 「无需回复」哨兵 */
export const GROUP_NO_REPLY_TOKEN = "NO_REPLY";

/** 指代任务属主（宿主）的别名；`@宿主` 解析成属主的真 @ */
export const GROUP_OWNER_ALIASES = ["宿主", "属主"] as const;

/** 「需属主确认」标记行（全局匹配可能有多行，取第一条说明） */
export const GROUP_NEEDS_OWNER_RE = /\[\[需属主确认[:：]([\s\S]*?)\]\]/;

export interface GroupMention {
  openId: string;
  name: string;
}

export interface ParsedGroupReply {
  /** silent = 不发群；send = 发 text（已含真 @ 标签，可直接给 post+md 发送） */
  kind: "silent" | "send";
  /** 发群正文（kind=silent 时为空串） */
  text: string;
  /** 最终真 @ 了谁（去重、含自动补的提问人 / 属主） */
  mentions: GroupMention[];
  /** 正文里写了但认不出的 `@xxx`（原样留在 text 里） */
  unresolvedAts: string[];
  /** 「需属主确认」说明（没写为 undefined） */
  needsOwner?: string;
}

// ----------------- 落盘事件的 meta 约定（UI 据此折叠 / 展示） -----------------

/**
 * 答疑旁路 run 写盘的**每一条**事件都带 `meta.groupRun = <runTag>`
 *（thinking / assistant_message / tool_call / tool_result / info / error 一律）。
 * 主事件流据此把整轮折叠成「群答疑 · 提问人 · 用时 ✓」一行，不再混进属主自己的会话。
 */
export const GROUP_RUN_META_KEY = "groupRun";

/**
 * 轮次汇总事件 `meta.groupQaSummary` 的新增可选字段（旧字段不变，旧数据没有这些字段）：
 * - askerIsBot：提问人是机器人（UI 打「机器人」徽标）
 * - noReply：这轮 agent 选择了 NO_REPLY（群里没发任何东西；answer 里存 agent 的原话供审计）
 * - needsOwner：agent 标记的「需属主确认」说明（UI 顶部醒目提示）
 * - mentioned：最终真 @ 了谁（名字列表）
 * - startedAt / durationMs：本轮起止，UI 显示用时
 */
export interface GroupQaSummaryExtra {
  askerIsBot?: boolean;
  noReply?: boolean;
  needsOwner?: string;
  mentioned?: string[];
  startedAt?: number;
  durationMs?: number;
}
