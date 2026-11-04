/**
 * 群答疑（受限问答 / 旁路）准入闸 —— 纯函数 + 少量内存状态（P0 安全硬化）
 *
 * # 为什么要有这道闸
 *
 * 需求群里**非属主**成员 @ 机器人，bridge 会起一个答疑 agent 来答。此前这条通道只有「君子协定」：
 * 群里任何人（含别的机器人）@ 一下就能驱动 agent，代码里没有任何准入判断。现在改成**多道闸、全部在代码里强制**：
 *
 * 0. **没有「按群开关」（第 11 轮起）**：第 7 轮曾做过「按群显式开启、默认关」（`task.feishuGroupRestrictedQa`），
 *    用户随后决定「答疑期望都是默认开的，不用开关」，这道闸整个删掉——**已绑定需求群里的非属主真人 @ 机器人，默认就会触发受限答疑**。
 *    盘上老 meta 里残留的 `feishuGroupRestrictedQa` 字段读盘时直接丢弃（不再进 `Task`、不会再挡放行，也不需要迁移）。
 *    所以这个功能**只适合可信内部群**：Cursor 路径的 `read` 没有路径约束，prompt 里有事件日志绝对路径、能推出数据根，
 *    进而读到 `config.json` / `company-env.json`（见 docs/feishu-group-collab.md「诚实的局限」）。
 * 1. **机器人发件人**：sender 是 app / bot（`isGroupBotSender`）→ 拒绝。[生效，**除非设置放开**]
 *    lark-cli compact 事件里有 `sender_type`（user / bot）这个真实数据源。
 *    ⚠ 2026-11-04 起设置项 `feishuGroupAllowBots`（默认开、与 lk-harness 的群内机器人协作一致）开着时，调用方传
 *    `allowBots: true`、这一条不再拒；关 / 读设置失败 → 仍是老口径（拒）。放开后机器人的消息**始终**按「只答疑」约束处理
 *    （不吃提示词开关、不自动 @ 对方、不客套，见 group-non-owner-prompt）。
 *    机器人「送托办回执」走出问登记（feed 进属主会话）那条路，不经过本闸。
 * 2. **租户校验** [当前不生效]：判定逻辑是「senderTenantKey 与本租户都拿得到且不一致 → 拒绝」，任何一边拿不到就不拦。
 *    但本机 `lark-cli event schema im.message.receive_v1` 的 compact 输出里**没有 `tenant_key`**
 *    （`inbound.ts` 也不再把 header 里的应用租户当发件人租户），所以生产里 senderTenantKey 恒为空、本闸恒不拦。
 *    代码留着是给将来 lark-cli 补上「确属发件人」的 tenant_key（`sender.tenant_key` / 顶层 `sender_tenant_key`）后自动生效。
 * 3. **外部成员** [当前不生效]：判定逻辑是调用方给出 `senderExternal === true` → 拒绝；
 *    compact 事件里没有 external 标记，目前没有任何调用方会传它，拿不到就不拦。
 *
 * 所以**真正生效的只有 1 机器人发件人拒绝**（再加受限 agent 的 read/grep(/glob) 只读工具白名单、事件流 / 回群的精确值脱敏）；
 * 2、3 不要当成已有的防线，也不要在文案 / 文档里写成「租户一致才放行 / 外部租户成员会被拒」。
 *
 * 本模块不碰 IO；调用方（group-route）负责「拒绝后静默 + 留一条 app 事件」。
 */

/** 拒绝原因（稳定枚举，事件 meta / 测试都按它断言） */
export type RestrictedQaDenyReason =
  | "bot_sender"
  | "tenant_mismatch"
  | "external_member";

export type RestrictedQaDecision =
  | { allow: true }
  | { allow: false; reason: RestrictedQaDenyReason };

export interface RestrictedQaAdmissionInput {
  /** 发件人是不是机器人（路由层 isGroupBotSender 判的） */
  senderIsBot: boolean;
  /**
   * 设置项 `feishuGroupAllowBots`（默认开、2026-11-04 起）：为 true 时机器人发件人不再被 bot_sender 拒绝。
   * **缺省 / false = 沿用老口径（拒）**——调用方不传就等于没放开，所以旧调用点与旧单测零影响。
   */
  allowBots?: boolean;
  /**
   * 事件里带的「确属发件人」的租户（`sender.tenant_key` / `sender_tenant_key`）；没带 = undefined。
   * 注意：当前 lark-cli compact 事件里没有 tenant_key，生产里恒为空（租户闸暂不生效，见文件头）。
   */
  senderTenantKey?: string | null;
  /** bridge 自己的租户；不知道 = undefined / null */
  ownTenantKey?: string | null;
  /**
   * 发件人是不是外部成员；拿不到 = undefined。
   * 注意：当前 compact 事件里没有 external 标记、也没有调用方传它，外部成员闸暂不生效（见文件头）。
   */
  senderExternal?: boolean;
}

const nonEmpty = (v: string | null | undefined): string => (v ?? "").trim();

/**
 * 判断一条非属主的群消息能不能进受限问答。
 * 顺序固定：bot_sender → tenant_mismatch → external_member（先报最根本的原因）。
 * 没有「按群开关」这一步（第 11 轮起，见文件头 0）：入参里不再有 `enabled`，传了多余字段也不会改变判定。
 */
export const decideRestrictedQaAdmission = (
  input: RestrictedQaAdmissionInput,
): RestrictedQaDecision => {
  if (input.senderIsBot && input.allowBots !== true) {
    return { allow: false, reason: "bot_sender" };
  }
  const sender = nonEmpty(input.senderTenantKey);
  const own = nonEmpty(input.ownTenantKey);
  // 两边都拿到才比；缺任何一边都不拦（不猜）
  if (sender && own && sender !== own) {
    return { allow: false, reason: "tenant_mismatch" };
  }
  if (input.senderExternal === true) {
    return { allow: false, reason: "external_member" };
  }
  return { allow: true };
};

/** 拒绝原因 → 事件流里给属主看的中文说明（不含消息原文、不含发件人 id） */
export const describeRestrictedQaDenial = (
  reason: RestrictedQaDenyReason,
  requesterName: string,
): string => {
  const who = requesterName.trim() || "群成员";
  switch (reason) {
    case "bot_sender":
      return `群答疑已拒绝：${who} 是机器人，当前设置不受理机器人的 @（设置 → 连接 → 飞书集成 里可放开；已静默忽略）`;
    case "tenant_mismatch":
      // 仅在事件带了发件人 tenant_key 时才可能走到；当前 lark-cli compact 事件没有该字段，生产里暂不会触发
      return `群答疑已拒绝：${who} 与本机器人不在同一租户（外部成员，已静默忽略）`;
    case "external_member":
      return `群答疑已拒绝：${who} 是外部成员（已静默忽略）`;
  }
};

// ----------------- 本租户：从「属主自己的群消息」学 -----------------
//
// bridge 目前没有直接拿「本机器人所属租户」的接口（lark-cli auth status 不返 tenant_key）。
// 设计上：属主（应用 owner）发的群消息一定来自本租户——事件若带了「确属发件人」的 tenant_key，就记下来当本租户；
// 属主还没在群里发过带 tenant_key 的消息 / 事件根本不带该字段时，返回 null → 租户闸不生效（不拦）。
// 注意：当前 lark-cli compact 事件里根本没有 tenant_key，所以生产里这里**永远学不到**、getOwnTenantKey() 恒为 null
// → 租户闸恒不生效；这套学习逻辑只是给将来 lark-cli 补上字段预留。仅进程内存，不落盘。

let learnedOwnTenantKey: string | null = null;

/** 属主消息到达时调用：事件带了 tenant_key 就记下（空值忽略） */
export const learnOwnTenantKey = (key: string | null | undefined): void => {
  const k = nonEmpty(key);
  if (k) learnedOwnTenantKey = k;
};

export const getOwnTenantKey = (): string | null => learnedOwnTenantKey;

/** 单测清状态 */
export const __resetOwnTenantKeyForTest = (): void => {
  learnedOwnTenantKey = null;
};
