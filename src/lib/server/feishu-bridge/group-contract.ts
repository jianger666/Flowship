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
// 答疑 agent 的**最终回复**（最后一段、工具调用之后的文字）按下面约定解析
//（这里只是摘要，细节与边界以 group-reply-protocol.ts 的 `parseGroupReply` 为准）：
//
// 1. 哨兵 `NO_REPLY`（大小写不敏感）：
//    - 整段回复除「包裹」外就是它 → 什么都不发（对方只是确认 / 复述 / 无需回应，或系统噪音）。
//      包裹 = 首尾空白 / 末尾标点 / 成对引号（含反引号）/ 代码围栏 / markdown 强调，可多层嵌套；
//      判定前先做 NFKC 归一并去掉零宽 / 格式控制字符（全角 `ＮＯ＿ＲＥＰＬＹ`、`NO\u200b_REPLY` 也算）。
//    - 「哨兵 + 自我解释」：首个非空行是裸写 / markdown 强调包住的哨兵（`NO_REPLY\n对方只是确认`、
//      `**NO_REPLY**（对方只是确认）`、`NO_REPLY：…`）→ 整段静默，模型的自我解释不外发。
//    - 单独成行的哨兵行（含「哨兵词 + 括号 / 冒号 / 破折号 / 逗号 + 说明」）夹在正文里 → 只剔那一行，其余照发。
//    - 例外：被**反引号 / 引号**包住的哨兵词、后面还跟着正文（`` `NO_REPLY`，不过我还是答一下：… ``，
//      或首行 `` `NO_REPLY` `` 后面跟一大段答复）是在**解释**哨兵词、不是在用它 → 不当哨兵，正文照发
//      （独占一行的纯哨兵行仍会被剔掉）。「标注型」仍按「哨兵 + 说明」静默，有两种：
//      ① 说明只是**一对括号、括号配平后恰好到行尾**（`` `NO_REPLY`（对方只是确认） ``；括号之后若还有正文，
//      如 `` `NO_REPLY`（先说明）接口是 /a/b ``，那是一句真正的回复，照发）；
//      ② **整行被一对引号 / 反引号包住**（`` `NO_REPLY：对方只是确认` ``：行首包裹符在哨兵词之后第一次出现的收尾符就是整行最后的东西）。
//      残余：`` `NO_REPLY`：说明 ``（包裹符只包哨兵词、冒号后是正文）仍视为在解释哨兵词、照发；说明自己含同种引号时同理。
// 2. 正文里写 `@名字`（名字与群成员展示名完全一致；`@宿主` / `@属主` = 任务属主本人）
//    → 系统换成真 @。认不出的 `@xxx` 原样当文本保留，并计入 unresolvedAts。不要手写 at 标签。
// 3. 可选一行 `[[需属主确认：一句话说明要属主定什么]]` → 系统把这行从群消息里剥掉，
//    自动补 @属主，并在 Flowship 事件流给属主写一条醒目的待办提示。解析比提示词教的写法宽：
//    `[[`、`【` 两种括号，括号后 / 冒号前可有空白（含全角空格），半 / 全角冒号；漏写闭合符时说明取到行尾；
//    判定前同样先做 NFKC 归一并去掉零宽 / 格式控制字符（全角 `［［…］］`、括号后夹零宽字符也认），
//    剪切位置映射回原文——发群的永远是原文剔掉标记后的内容。
//    闭合符在**同一段**里找（段 = 以空行分隔）：说明里的 `]` / `]]` 先按 `[` 配平、不提前截断（`看 a[0]` 也行），
//    不会跨到后文无关的 `]]`；例外是说明里含空行——闭合符在行尾、离起头不远（600 字内）、中间没有别的标记起头、
//    说明配平时才跨过空行收进来。代码围栏 / 行内代码里的标记是示例，不触发（也不会留下空围栏）。
//    识别与剥离的唯一入口是 `parseGroupReply`（内部 `stripNeedsOwnerMarkers`）；契约里不再提供「标准写法」的正则。
// 4. 正文里一个真 @ 都没有时：提问人是真人 → 系统在开头补 @提问人；提问人是机器人 → 不补
//    （无 @ 的话机器人看不见，这是有意的防环：答疑 agent 想让机器人看见，就得自己写 @）。
//    正文里已经有经过校验的真 @（认得出的名字 / `@宿主` / id 可信的手写标签）就不再补提问人——
//    想让提问人也收到提醒，要自己 @；补属主确认行里的 @ 不算「正文里的 @」。

/** 「无需回复」哨兵 */
export const GROUP_NO_REPLY_TOKEN = "NO_REPLY";

/** 指代任务属主（宿主）的别名；`@宿主` 解析成属主的真 @ */
export const GROUP_OWNER_ALIASES = ["宿主", "属主"] as const;

/**
 * 「需属主确认」标记的**起头**：`[[` 或 `【` + 关键词 + 半 / 全角冒号。
 * 括号后、冒号前容忍水平空白（含全角空格 U+3000、制表符），不跨行；group1 = 开括号。
 * 解析器（group-reply-protocol 的 `stripNeedsOwnerMarkers`）用它找每个标记的起点——**在 NFKC + 去 Cf 折叠后的文本上**匹配
 *（全角 `［［`、括号后夹零宽字符也能命中），所以这里只需要写半角形态。
 */
export const GROUP_NEEDS_OWNER_HEAD_RE = /(\[\[|【)[^\S\n]*需属主确认[^\S\n]*[:：]/;

/**
 * 开括号 → 闭合符（按族配对：`[[…]]` 里可以有【】，`【…】` 里可以有 `[[ ]]`）。
 * 找闭合符时说明里的 `[` / `]`（`【` 族是 `【` / `】`）要先配平、不提前截断，细节见 `stripNeedsOwnerMarkers`。
 */
export const GROUP_NEEDS_OWNER_CLOSERS: Readonly<Record<string, string>> = {
  "[[": "]]",
  "【": "】",
};

// （第七轮 K4-11：这里原有一个「标准写法」的契约正则 `GROUP_NEEDS_OWNER_RE`，生产上没有调用方，
//  又对没有闭合符的长文本是二次型、口径也早已落后于解析器——已删除。标记的识别与剥离一律走
//  group-reply-protocol 的 `parseGroupReply` / `stripNeedsOwnerMarkers`，不要再给契约加「再抄一份口径」的正则。）

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
