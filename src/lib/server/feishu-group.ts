/**
 * 需求群协作：幂等取/建群 + 分享互动卡片
 *
 * 权限边界（已实测、不可事后补救）：
 * - bot 建群 ✓、建群时带人（≤50）✓、bot 发消息 ✓
 * - 事后拉人 / 拉 bot ✗、用户身份发消息 ✗
 *
 * 接入形态：建群时按「需求群成员自动注册表」（`feishu-group-registry`、团队库共享
 * 单文件）把工作项角色成员和他们各自的 bot 一次带齐——每台 Flowship 自动把自己的
 * email → open_id / bot app_id 写进注册表，建群方按 meegle 给的角色成员 email 反查。
 * 免审 scope 下这是唯一可行的桥：meegle 给的 user_key / lark_user_id / union_id
 * 都换不出我们自建 app 可用的 open_id（实测表见 docs/feishu-group-collab.md）。
 * 注册表读不到 / 没命中的人照旧跳过（退回「只拉发起人本人」的老行为）——他们首次
 * 分享时本机 bot 不在群，走 `bot_not_in_group` 引导弹窗（带准确 bot 名 + 复制），
 * 加完重试即可，一个群只需一次。
 *
 * 「bot 在不在群」采用**事后判定**：直接发卡、发送失败按飞书错误码（230002 一族）
 * 映射成 bot_not_in_group。事前查群成员列表在免审权限下不可行——
 * `GET /im/v1/chats/:id/members` 不收 member_id_type=app_id（field validation failed）、
 * 且接口本身缺 im:chat.members:read scope（实测 99991672），第二次分享必挂。
 *
 * 「**本人**在不在群」反过来必须**事前**判（`inspectBoundGroup`、显式分享才跑）：
 * 用户退群 / 被踢 / 群解散换群之后，工作项上的 bind 还指着老群、bot 也还在里面，
 * 于是卡片发得出去、前端提示「分享成功」、而用户什么都看不到（真实 P0）。
 * 事后判定在这里失效——发送成功恰恰是症状。判据是「问自己在不在」
 *（`is_in_chat`、user 身份），成员列表那条路同样被 scope 挡着。
 * **查不出来时不猜**：标 membershipUnknown、照常发，绝不因为查不了就挡住正常分享。
 *
 * 飞书 API 通道复用 feishu-bridge/lark-api（token / 队列 / 建卡）；
 * 工作项读写复用 meegle-cli（group_type 读写协议不对称：读 value / 写 type）。
 */

import { extractFeishuStoryId } from "@/lib/branch-template";
import type { Task } from "@/lib/types";
import {
  createImChat,
  fetchChatInfo,
  getBotAppInfo,
  getBotDisplayName,
  getLarkLocalIdentity,
  probeLarkAuthStatus,
  probeSelfInChat,
  sendFileMessageToChat,
  sendInteractiveCardToChat,
} from "@/lib/server/feishu-bridge/lark-api";
import {
  describeLarkError,
  isTransientLarkError,
  LarkApiError,
} from "@/lib/server/feishu-bridge/types";
import {
  bindWorkitemGroup,
  decodeWorkitemUrl,
  fetchMyIdentity,
  fetchWorkitemGroupType,
  fetchWorkitemName,
  fetchWorkitemRoleMembers,
  MeegleError,
  type WorkitemGroupType,
} from "@/lib/server/meegle-cli";
import {
  emptyGroupMemberRegistry,
  pickGroupCreationTargets,
  readGroupMemberRegistry,
  scheduleSelfRegistration,
  type GroupCreationTargets,
  type GroupMemberRegistry,
} from "@/lib/server/feishu-group-registry";

// ----------------- 公开类型 -----------------

/** 分享内容类型（卡片 header 徽标色） */
export type ShareKind = "artifact" | "message" | "question";

export interface ShareLink {
  label: string;
  url: string;
}

export interface ShareToGroupInput {
  kind: ShareKind;
  title?: string;
  content: string;
  links?: ShareLink[];
}

export interface EnsureGroupResult {
  chatId: string;
  /** 本次是否由本机新建了群（并发收敛到别人的群时为 false） */
  created: boolean;
  /**
   * 群名（读到才有）——回执里的「已发到「XXX需求群」」就靠它。
   * **只放真实读到的名字**：按 `<需求名>需求群` 反推出来的名字在群被改过名时是错的，
   * 而「看着像对的群名」比没有群名更容易让用户放下戒心。
   */
  chatName?: string;
  /**
   * 「本人还在不在这个群」没查出来（scope 不够 / 网络抖 / user 身份没登录）。
   * 此时**照常发**（不因为查不了就把正常分享挡掉），但把不确定性透到回执 + 日志。
   */
  membershipUnknown?: boolean;
}

export interface ShareToGroupResult extends EnsureGroupResult {
  /** 卡片消息 id（发不出去就整体失败、这个字段一定有值） */
  messageId: string;
  /**
   * 整份产物的 md 文件消息 id；只有 kind=artifact 才发。
   * 缺失 = 没发（非 artifact）或发失败（已降级、卡片仍算发出去了）。
   */
  docMessageId?: string;
}

/**
 * 面向用户的结构化错误。
 * API / MCP 用 code 分流文案；message 已是可读中文。
 */
export class FeishuGroupError extends Error {
  readonly code:
    | "no_story"
    | "meegle_not_installed"
    | "meegle_not_authed"
    | "meegle_error"
    | "lark_not_authed"
    | "lark_permission"
    | "lark_error"
    | "bot_not_in_group"
    /**
     * 工作项上的绑定还在，但**发起人本人已经不在那个群里**（退群 / 被踢 / 换群）。
     * bot 还在群里 → 卡片发得出去 → 用户看不到任何东西还以为分享成功了（P0）。
     * 前端据此弹「重新建群」引导。
     */
    | "owner_not_in_group"
    /** 绑定指向的群飞书那边已经描述不出来了（解散 / chat_id 失效）——同样引导重建 */
    | "group_unreachable"
    /** 还没有需求群、且本次调用不许建（allowCreate: false，自动播报专用） */
    | "no_group"
    | "invalid_input";

  /** bot_not_in_group 时附带本机 bot 展示名 */
  readonly botLabel?: string;
  readonly chatId?: string;
  /** 死绑定两码附带群名（读到才有）——引导弹窗里点名是哪个群 */
  readonly chatName?: string;

  constructor(
    code: FeishuGroupError["code"],
    message: string,
    opts: { botLabel?: string; chatId?: string; chatName?: string } = {},
  ) {
    super(message);
    this.name = "FeishuGroupError";
    this.code = code;
    this.botLabel = opts.botLabel;
    this.chatId = opts.chatId;
    this.chatName = opts.chatName;
  }
}

// ----------------- 可注入依赖（单测 mock 外部调用） -----------------

export interface FeishuGroupDeps {
  fetchGroupType: (
    workItemId: string,
    projectKey?: string,
  ) => Promise<WorkitemGroupType | null>;
  bindGroup: (
    workItemId: string,
    projectKey: string | undefined,
    groupId: string,
  ) => Promise<void>;
  fetchWorkitemName: (
    workItemId: string,
    projectKey?: string,
  ) => Promise<string | undefined>;
  /** 工作项角色成员的邮箱清单——建群拉人的数据源（注册表反查 key） */
  fetchRoleMemberEmails: (
    workItemId: string,
    projectKey?: string,
  ) => Promise<string[]>;
  /** 需求群成员注册表（团队库共享单文件、本地克隆直读） */
  readMemberRegistry: () => Promise<GroupMemberRegistry>;
  /** 本机身份自动注册（同步返回、后台跑、静默失败） */
  scheduleSelfRegister: () => void;
  decodeUrl: typeof decodeWorkitemUrl;
  createChat: typeof createImChat;
  getBotInfo: typeof getBotAppInfo;
  /** 机器人展示名（bot/v3/info → auth status → 应用信息接口的降级链） */
  getBotName: typeof getBotDisplayName;
  /** 本机 lark 凭据实况——判「真没授权」还是「授权着但这次调用挂了」 */
  probeAuthStatus: typeof probeLarkAuthStatus;
  /** 群信息（群名 + 群还在不在）——复用已绑定群前的可用性探针 */
  fetchChatInfo: typeof fetchChatInfo;
  /** 本人（user 身份）还在不在这个群里——死绑定检测的主判据 */
  probeSelfInChat: typeof probeSelfInChat;
  sendCard: typeof sendInteractiveCardToChat;
  /** 发 md 文件消息（整份产物的正文载体、卡片之后紧跟一条） */
  sendDoc: typeof sendFileMessageToChat;
  resolveSenderName: () => Promise<string>;
  warn: (msg: string) => void;
}

const defaultDeps = (): FeishuGroupDeps => ({
  // 一律包一层箭头：避免模块顶层求值时碰到 const TDZ，也方便单测覆盖
  fetchGroupType: (id, key) => fetchWorkitemGroupType(id, key),
  bindGroup: (id, key, groupId) => bindWorkitemGroup(id, key, groupId),
  fetchWorkitemName: (id, key) => fetchWorkitemName(id, key),
  fetchRoleMemberEmails: async (id, key) =>
    (await fetchWorkitemRoleMembers(id, key))
      .map((m) => m.email?.trim() ?? "")
      .filter(Boolean),
  readMemberRegistry: () => readGroupMemberRegistry(),
  scheduleSelfRegister: () => scheduleSelfRegistration(),
  decodeUrl: (url) => decodeWorkitemUrl(url),
  createChat: (opts) => createImChat(opts),
  getBotInfo: () => getBotAppInfo(),
  getBotName: () => getBotDisplayName(),
  probeAuthStatus: () => probeLarkAuthStatus(),
  fetchChatInfo: (chatId) => fetchChatInfo(chatId),
  probeSelfInChat: (chatId) => probeSelfInChat(chatId),
  sendCard: (chatId, card) => sendInteractiveCardToChat(chatId, card),
  sendDoc: (chatId, filename, content) =>
    sendFileMessageToChat(chatId, filename, content),
  resolveSenderName: () => resolveLocalSenderName(),
  warn: (msg) => console.warn(`[feishu-group] ${msg}`),
});

/** null = 用默认；partial = 覆盖部分依赖 */
let depsOverride: Partial<FeishuGroupDeps> | null = null;

const getDeps = (): FeishuGroupDeps =>
  depsOverride ? { ...defaultDeps(), ...depsOverride } : defaultDeps();

/** 单测替换依赖；传 null 恢复默认 */
export const __setFeishuGroupDepsForTest = (
  partial: Partial<FeishuGroupDeps> | null,
): void => {
  depsOverride = partial;
};

// ----------------- 机器人展示名 -----------------

/** 连 app_id 都拿不到时的泛称（真出现说明 lark-cli 整个不通） */
const BOT_LABEL_FALLBACK = "你的机器人";

/**
 * 引导弹窗里的机器人标签——「在群里搜这个名字添加机器人」，所以准确度第一。
 *
 * 真名的降级链收在 lark-api 的 `getBotDisplayName()`（单一来源）；这里只负责
 * 名字彻底拿不到时的最后两级：app_id（搜不到人、但能在开放平台对上号）→ 泛称。
 */
export const resolveBotDisplayLabel = async (): Promise<string> => {
  try {
    const name = (await getDeps().getBotName())?.trim();
    if (name) return name;
  } catch {
    /* 名字这一级全挂：继续退 app_id */
  }
  try {
    return (await getDeps().getBotInfo()).appId.trim() || BOT_LABEL_FALLBACK;
  } catch {
    return BOT_LABEL_FALLBACK;
  }
};

// ----------------- 故事定位 -----------------

export interface ResolvedStory {
  workItemId: string;
  projectKey?: string;
  storyUrl: string;
}

/**
 * 从 task.feishuStoryUrl 解析工作项 id + project（simpleName 可当 project-key）。
 * 只吃 feishuStoryUrl 一个字段——TaskSummary（群回流反查时手里只有它）也能传。
 */
export const resolveTaskStory = async (
  task: Pick<Task, "feishuStoryUrl">,
  decodeUrl: typeof decodeWorkitemUrl = getDeps().decodeUrl,
): Promise<ResolvedStory> => {
  const url = task.feishuStoryUrl?.trim();
  if (!url) {
    throw new FeishuGroupError(
      "no_story",
      "当前任务未关联飞书工作项，无法分享到需求群",
    );
  }
  const decoded = await decodeUrl(url);
  const workItemId =
    decoded?.workItemId ?? extractFeishuStoryId(url) ?? "";
  if (!workItemId) {
    throw new FeishuGroupError(
      "no_story",
      "无法从飞书工作项链接解析 ID，请检查任务里的飞书链接",
    );
  }
  return {
    workItemId,
    projectKey: decoded?.simpleName,
    storyUrl: url,
  };
};

// ----------------- 错误映射 -----------------

/**
 * 发群消息失败里代表「bot 不在群 / 没资格往这个群发」的飞书错误码
 * （官方 `POST /im/v1/messages` 错误码表）。命中即走 bot_not_in_group 引导弹窗——
 * 这几种在本产品语境下的补救动作是同一个：去群设置里把本机 bot 加进群 / 放开发言。
 */
const BOT_NOT_IN_GROUP_LARK_CODES = new Set<string>([
  "230002", // The bot can not be outside the group（机器人不在群，主码）
  "230013", // Bot has NO availability to this user（不在应用可用范围）
  "230018", // 群设置禁止当前操作（如仅指定成员可发言）
  "230027", // Lack of necessary permissions（如外部群未开共享）
  "230035", // Send Message Permission deny（禁言 / 被屏蔽）
]);

/** 发送失败是否该判成「bot 不在群」——码优先、报文关键词兜底（CLI 偶尔丢 code） */
export const isBotNotInGroupSendError = (err: unknown): boolean => {
  if (!(err instanceof LarkApiError)) return false;
  if (err.code !== undefined && BOT_NOT_IN_GROUP_LARK_CODES.has(String(err.code))) {
    return true;
  }
  return /outside the group|not in the (?:chat|group)|机器人不在/i.test(
    err.message ?? "",
  );
};

/**
 * 读群信息失败时，飞书是否**明确表示这个群不存在 / 不可见**（解散、chat_id 失效）。
 *
 * 刻意只认「正面信号」、不用「排除法」：读群信息失败的原因还有缺 scope、网络抖、
 * CLI 超时、bot 被移出群——它们各有各的补救路径（补权限 / 重试 / 把机器人加回去），
 * 误判成「群没了」就是诱导用户白建一个新群、再攒一个孤儿群。判不准就当没判。
 */
const CHAT_GONE_MESSAGE =
  /chat\s*(?:id\s*)?(?:is\s*)?(?:not\s*found|not\s*exist|does\s*not\s*exist|invalid)|(?:dissolved|disbanded)|群(?:聊)?(?:不存在|已解散|已删除)/i;

const isChatGoneError = (err: unknown): boolean => {
  if (!(err instanceof LarkApiError)) return false;
  // 网络抖 / 超时：重试能好，不是群没了
  if (isTransientLarkError(err)) return false;
  // bot 自己被移出群：补救是「把机器人加回去」，交给发送后的 bot_not_in_group 引导
  if (isBotNotInGroupSendError(err)) return false;
  // 缺 scope：补权限，不是群没了
  if (err.permissionViolations || err.consoleUrl) return false;
  return CHAT_GONE_MESSAGE.test(err.message ?? "");
};

/**
 * 「拿不到身份」≠「没授权」。
 *
 * 2026-07-27 踩过：test 实例的应用信息接口间歇性 `EOF`、取 tenant_access_token 的
 * 报文里也天然带 token 字样——老的关键词正则（含一个裸 `token`）把这些一律判成
 * 「飞书机器人未登录」，用户照着提示反复重新授权也修不好（`auth status` 里 bot
 * 明明 ready）。所以以实况为准：**bot 明确不可用才叫未登录，bot 可用就一定不是**。
 *
 * 只有连 auth status 都读不到（CLI 没装 / 跑挂了、登录态未知）时，才退回收紧后的
 * 关键词判断——裸 `token` 已去掉，只留真正指向「没登录」的措辞。
 */
const NOT_AUTHED_MESSAGE =
  /not logged|auth login|unauthorized|identity missing|no local token|未登录/i;

const isLarkNotAuthedError = async (err: LarkApiError): Promise<boolean> => {
  const status = await getDeps().probeAuthStatus();
  if (status) return !status.botAvailable;
  return NOT_AUTHED_MESSAGE.test(err.message ?? "");
};

const mapExternalError = async (err: unknown): Promise<FeishuGroupError> => {
  if (err instanceof FeishuGroupError) return err;
  if (err instanceof MeegleError) {
    if (err.kind === "not_installed") {
      return new FeishuGroupError(
        "meegle_not_installed",
        "meegle CLI 未安装，请先在设置页安装并授权飞书项目",
      );
    }
    if (err.kind === "not_authed") {
      return new FeishuGroupError(
        "meegle_not_authed",
        "飞书项目未登录，请先在设置页完成 meegle 授权",
      );
    }
    return new FeishuGroupError("meegle_error", err.message);
  }
  if (err instanceof LarkApiError) {
    const msg = err.message || "飞书 API 调用失败";
    // 原始响应进日志：message 常常是「field validation failed」这种无信息量文案，
    // 只有 raw 里的 code / field_violations / log_id 才查得动（2026-07-27 踩过）
    console.error(
      `[feishu-group] 飞书调用失败 api=${err.api ?? "?"} code=${err.code ?? "?"} log_id=${err.logId ?? "?"}:`,
      msg,
      err.raw ?? "",
    );
    if (await isLarkNotAuthedError(err)) {
      return new FeishuGroupError(
        "lark_not_authed",
        "飞书机器人未登录，请先在设置页完成 lark-cli 授权（bot 身份）",
      );
    }
    if (err.permissionViolations || err.consoleUrl) {
      const hint = err.consoleUrl
        ? `（可在开放平台补权限：${err.consoleUrl}）`
        : "";
      return new FeishuGroupError(
        "lark_permission",
        `飞书权限不足：${describeLarkError(err)}${hint}`,
      );
    }
    return new FeishuGroupError("lark_error", describeLarkError(err));
  }
  return new FeishuGroupError(
    "lark_error",
    err instanceof Error ? err.message : String(err),
  );
};

// ----------------- 群管理 -----------------

/**
 * 建群拉谁：工作项角色成员邮箱 → 注册表反查 open_id / bot app_id。
 *
 * **绝不抛**——注册表是增强路径。meegle 查角色挂了 / 团队库没同步下来 / 一个人都
 * 没命中，一律退回「只拉发起人本人」（老行为），绝不因此挡住建群。
 */
const resolveGroupInvites = async (
  story: ResolvedStory,
  ownerOpenId: string,
  ownBotAppId: string,
): Promise<GroupCreationTargets> => {
  const ownerOnly = (): GroupCreationTargets =>
    pickGroupCreationTargets({
      ownerOpenId,
      ownBotAppId,
      roleEmails: [],
      registry: emptyGroupMemberRegistry(),
    });

  try {
    const emails = await getDeps().fetchRoleMemberEmails(
      story.workItemId,
      story.projectKey,
    );
    if (emails.length === 0) return ownerOnly();

    const registry = await getDeps().readMemberRegistry();
    const picked = pickGroupCreationTargets({
      ownerOpenId,
      ownBotAppId,
      roleEmails: emails,
      registry,
    });
    if (picked.missedEmails.length > 0) {
      // 「同事还没用过 Flowship 群功能」是常态、不是错误——但要留痕，
      // 否则事后没人说得清「为什么老王没被拉进群」
      getDeps().warn(
        `建群按注册表命中 ${picked.matchedEmails.length} 人、跳过 ${picked.missedEmails.length} 位未注册成员（${picked.missedEmails.join("、")}）——他们用一次 Flowship 群功能就会自动登记`,
      );
    }
    if (picked.crossAppEmails.length > 0) {
      // open_id 应用级隔离：别的 Flowship 应用名下的 open_id 不能跨应用拉人建群、
      // 飞书会报「open_id cross app」整次建群失败——跳过本人、他们的 bot 仍随群加入
      getDeps().warn(
        `建群跳过 ${picked.crossAppEmails.length} 位跨应用成员（${picked.crossAppEmails.join("、")}）——open_id 属于其它 Flowship 应用、不能跨应用拉人；这些人的 bot 已加入群`,
      );
    }
    return picked;
  } catch (err) {
    getDeps().warn(
      `读取需求群成员注册表失败、本次只拉发起人：${err instanceof Error ? err.message : String(err)}`,
    );
    return ownerOnly();
  }
};

// ----------------- 已绑定群的「死绑定」检测 -----------------

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** 已绑定群的可用性快照（三态：能用 / 确定不能用 / 判不了） */
interface BoundGroupHealth {
  /** 真实群名（读到才有） */
  chatName?: string;
  /** 确定不能用 → 调用方直接抛这个结构化错误，前端据此引导重建 */
  dead?: FeishuGroupError;
  /** 本人在不在群没查出来——不阻断、但要透到回执 */
  membershipUnknown?: boolean;
}

/**
 * 复用工作项上已绑定的群之前，校验它对**发起人本人**还有没有意义。
 *
 * 治的是这个 P0：用户退了那个群（或被踢 / 群被解散换群），但工作项上的 bind 还指着它，
 * 而 bot 仍在群里 → 卡片发得出去 → 前端提示「分享成功」→ 用户什么都看不到。
 *
 * 两层探测，都**绝不主动抛**（除非确诊死绑定）：
 * 1. `fetchChatInfo`（bot 身份）：拿真实群名（回执要用），顺带识别「群已解散」
 * 2. `probeSelfInChat`（**user 身份**）：本人在不在群——这是唯一直接的判据。
 *    群成员列表那条路免审 scope 下走不通（缺 `im:chat.members:read`、实测 99991672），
 *    所以只能问「我自己在不在」
 *
 * ⚠️ **查不出来时不猜**：`membershipUnknown` 标记 + 一条 warn，本次照常发。
 * 免审 scope 下这两个接口能不能用还没有实测结论，宁可漏检也不能把正常分享挡掉。
 */
const inspectBoundGroup = async (
  chatId: string,
): Promise<BoundGroupHealth> => {
  let chatName: string | undefined;
  try {
    chatName = (await getDeps().fetchChatInfo(chatId)).name?.trim() || undefined;
  } catch (err) {
    if (isChatGoneError(err)) {
      return {
        dead: new FeishuGroupError(
          "group_unreachable",
          "原来的需求群已经不在了，重建一个再分享",
          { chatId },
        ),
      };
    }
    getDeps().warn(
      `读群信息失败（不影响本次分享、回执少个群名）chat=${chatId}：${errText(err)}`,
    );
  }

  const named = chatName ? { chatName } : {};
  try {
    if (await getDeps().probeSelfInChat(chatId)) return named;
  } catch (err) {
    getDeps().warn(
      `没查出本人还在不在需求群、本次照常发 chat=${chatId}：${errText(err)}`,
    );
    return { ...named, membershipUnknown: true };
  }
  return {
    ...named,
    dead: new FeishuGroupError(
      "owner_not_in_group",
      chatName
        ? `你已不在需求群「${chatName}」，重建一个再分享`
        : "你已不在这个需求群，重建一个再分享",
      { chatId, ...named },
    ),
  };
};

export interface EnsureGroupOptions {
  /**
   * 允许在没群时建群（默认 true）。
   *
   * 自动播报传 false：它是后台行为，不能因为跑完一个 action 就悄悄给全组人拉个群。
   * 播报侧自己也先 `getBoundGroupChatId` 预筛过，但那次读和这里的建群之间隔着
   * 「读产物 + 占坑」几个 await——期间别人可能刚解绑 / meegle 刚好抖一下（TOCTOU）。
   * 真正的闸必须贴在 `createChat` 紧前，也就是这个开关。
   */
  allowCreate?: boolean;
  /**
   * 复用已绑定的群之前，校验发起人本人还在不在群里（默认 false）+ 顺带取群名。
   *
   * **只有「用户显式分享」才开**（API / MCP / UI 分享按钮）——那条路的目标读者就是
   * 发起人自己，他看不见 = 这次分享没有意义。反过来，群内推进的产物回执和自动播报
   * 是**群里的人**要的东西，属主在不在群不影响该不该发，开了反而会把同事的产物挡掉；
   * 而且它们跑在热路径 / 后台，不该白付两次 CLI 往返。
   */
  verifyOwnerMembership?: boolean;
  /**
   * 用户已确认失效的群 id：跳过复用、直接重建并覆盖 bind。
   *
   * 走的是同一条建群链（幂等 / 拉人 / bind 全复用），只在两处认这个 id：
   * ① 复用快路径对它视而不见；② bind 前的并发收敛不把它当「别人抢先建好的群」
   *（否则重建会原地收敛回那条死绑定、白建一个群）。
   */
  recreateFrom?: string;
}

/**
 * 幂等取/建需求群。
 * 1) 读 group_type → 已有 group_id：先过一道可用性校验（`verifyOwnerMembership`），
 *    本人已不在群 / 群没了就抛结构化错误让前端引导重建，否则直接返回
 * 2) 无群（或用户确认重建）→ bot 建群（带发起人 + 注册表命中的角色成员和他们的 bot）
 *    （`allowCreate: false` 时到此为止、抛 `no_group`）
 * 3) bind 前再读一次防并发双建；若已被别人 bind，用别人的群并 warning
 */
export const ensureRequirementGroup = async (
  task: Task,
  opts: EnsureGroupOptions = {},
): Promise<EnsureGroupResult> => {
  // 用到群协作 = 本机身份该进注册表（后台跑、静默失败、不阻塞本次建群）
  getDeps().scheduleSelfRegister();
  try {
    const story = await resolveTaskStory(task);
    const existing = await getDeps().fetchGroupType(
      story.workItemId,
      story.projectKey,
    );
    const existingId = existing?.groupId?.trim();
    // 用户已在引导弹窗里确认「我不在这个群、重建一个」——只对**当前仍是这一条**的
    // 绑定生效；期间已经被换成别的群就当普通复用（照常校验），别白建一个
    const staleId = opts.recreateFrom?.trim() || undefined;
    if (existingId && (existing?.value === "auto" || existing?.value === "bind")) {
      if (staleId === existingId) {
        getDeps().warn(
          `按用户确认重建需求群：工作项 ${story.workItemId} 丢弃失效绑定 ${existingId}`,
        );
      } else {
        const health = opts.verifyOwnerMembership
          ? await inspectBoundGroup(existingId)
          : {};
        if (health.dead) throw health.dead;
        return {
          chatId: existingId,
          created: false,
          ...(health.chatName ? { chatName: health.chatName } : {}),
          ...(health.membershipUnknown ? { membershipUnknown: true } : {}),
        };
      }
    }

    // —— 无群：建 ——
    // 不许建群的调用方（自动播报）到此为止：闸贴在建群这条路的入口、不是调用方
    // 几个 await 之前的那次预筛（TOCTOU）
    if (opts.allowCreate === false) {
      throw new FeishuGroupError(
        "no_group",
        "这个需求还没有需求群、本次不建群",
      );
    }

    // 建群是**唯一**能带人 / 带 bot 的时机（事后拉人拉 bot 免审 scope 下全不可用），
    // 所以这一次要尽量带齐：发起人本人（bot 建群自己自动入群、但不带人的话建群人
    // 自己都看不见这个群）+ 注册表命中的角色成员 + 他们各自的 bot。
    const botInfo = await getDeps().getBotInfo();
    const ownerOpenId = botInfo.ownerOpenId.trim();

    const workitemName = await getDeps().fetchWorkitemName(
      story.workItemId,
      story.projectKey,
    );

    const reqName = (workitemName || task.title || story.workItemId).trim();
    const chatName = `${reqName}需求群`;

    const invites = await resolveGroupInvites(
      story,
      ownerOpenId,
      botInfo.appId?.trim() ?? "",
    );
    const created = await getDeps().createChat({
      name: chatName,
      userIdList: invites.userIdList,
      // 一个都没命中时不塞空数组：载荷干净、也不动老调用方的断言
      ...(invites.botIdList.length > 0 ? { botIdList: invites.botIdList } : {}),
    });
    const myChatId = created.chat_id;

    // bind 前再查一次——别人可能刚 bind 完
    const again = await getDeps().fetchGroupType(
      story.workItemId,
      story.projectKey,
    );
    const racedId = again?.groupId?.trim();
    if (
      racedId &&
      racedId !== myChatId &&
      // 重建时那条死绑定还挂在工作项上是意料之中的，不是「别人抢先建好了」——
      // 认了就会原地收敛回去、白建一个群，用户点了「重新建群」却什么都没变
      racedId !== staleId &&
      (again?.value === "auto" || again?.value === "bind")
    ) {
      getDeps().warn(
        `并发双建收敛：工作项 ${story.workItemId} 已 bind ${racedId}，丢弃本机新建群 ${myChatId}`,
      );
      return { chatId: racedId, created: false };
    }

    // bind 抛错**不能**把已经建好的群一起丢掉：群在飞书那边已经存在、人也拉进去了，
    // 抛出去只会让用户看到「分享失败」→ 重试 → 再建一个 → 攒孤儿群（回读校验那条
    // 静默失败路径踩过同一个坑）。所以吞错 + warn，照常返回本次新建的群、卡片发得出去；
    // bind 没落地的后果（下次分享读不到绑定、会再建一个群）由这条 warn 讲清楚。
    try {
      await getDeps().bindGroup(story.workItemId, story.projectKey, myChatId);
      await warnIfBindDidNotStick(story, myChatId);
    } catch (bindErr) {
      getDeps().warn(
        `bind 失败（群已建好、本次卡片照发）：工作项 ${story.workItemId} ← ${myChatId}：${
          bindErr instanceof Error ? bindErr.message : String(bindErr)
        }——下次分享读不到绑定会再建一个群，请检查飞书项目「拉群方式选择」字段写权限`,
      );
    }
    // 刚建的群名是本机拼的、无需再查一次；建群人自己必在群里，不用校验
    return { chatId: myChatId, created: true, chatName };
  } catch (err) {
    throw await mapExternalError(err);
  }
};

/**
 * bind 后回读校验——**只 warn、不抛**（群已经建好、卡还得发出去）。
 *
 * 为什么必须回读：meegle `workitem update` 对写失败**一声不吭**（2026-07-27 实测：
 * 传不存在的 field_key、传畸形 group_id，返回都是 `{"mcp_result":""}` 且工作项纹丝不动）。
 * bind 悄悄没写进去 → 下次分享读不到群 → 又建一个 → 攒出一堆没人进得去的孤儿群
 *（用户那个测试工作项就攒出了 2 个同名需求群）。回读把这条静默失败打进日志。
 */
const warnIfBindDidNotStick = async (
  story: ResolvedStory,
  chatId: string,
): Promise<void> => {
  try {
    const after = await getDeps().fetchGroupType(
      story.workItemId,
      story.projectKey,
    );
    if (after?.groupId?.trim() === chatId) return;
    getDeps().warn(
      `bind 回读未生效：工作项 ${story.workItemId} 期望 ${chatId}、实际 ${after?.groupId?.trim() || "空"}（value=${after?.value ?? "无"}）——下次分享会再建一个群，请检查飞书项目「拉群方式选择」字段写权限`,
    );
  } catch (err) {
    // 回读本身失败只是少一条诊断信息，绝不能因此把已经建好的群判失败
    getDeps().warn(
      `bind 回读失败（不影响本次分享）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

/**
 * **只读**取工作项已绑定的需求群 id（绝不建群）。
 *
 * 与 ensureRequirementGroup 的分工：ensure 是「分享时保证有群」（可能建群 + bind、
 * 有副作用）；本函数是「群消息回流反查 chatId ↔ task」用的纯查询——回流链每条群消息
 * 都会走，绝不能顺手建群。任何失败（无飞书链接 / meegle 挂）一律返 null、不抛。
 */
export const getBoundGroupChatId = async (
  task: Pick<Task, "feishuStoryUrl">,
): Promise<string | null> => {
  // 群消息回流 / 播报 gate 都会走这里 = 本机在用群协作 → 顺带确保自己在注册表里
  // （同步零 IO 快路径，本进程注册到位后直接 return）
  getDeps().scheduleSelfRegister();
  try {
    const story = await resolveTaskStory(task);
    const existing = await getDeps().fetchGroupType(
      story.workItemId,
      story.projectKey,
    );
    const id = existing?.groupId?.trim();
    if (!id) return null;
    if (existing?.value !== "auto" && existing?.value !== "bind") return null;
    return id;
  } catch {
    // 反查是增强路径：未关联工作项 / meegle 未登录 / 超时都当「没绑群」
    return null;
  }
};

// ----------------- 卡片构建 -----------------

const KIND_META: Record<
  ShareKind,
  { label: string; template: string }
> = {
  artifact: { label: "产物", template: "blue" },
  message: { label: "消息", template: "wathet" },
  question: { label: "疑问", template: "orange" },
};

const CONTENT_MAX = 2000;

/** 调用方链接按钮上限（不含固定的「查看工作项」） */
const LINK_BUTTON_MAX = 6;

/** 正文截断（飞书卡片 markdown 不宜过长） */
export const truncateShareContent = (
  content: string,
  max = CONTENT_MAX,
): string => {
  const t = content.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
};

/**
 * 构建需求群分享互动卡（纯函数、无副作用）。
 * 复用 bridge 卡片 schema 2.0 壳：header + markdown + 外链按钮 + footer。
 *
 * **kind=artifact 不渲染正文**（2026-07-27 用户拍板）：整份产物的正文改由紧跟其后的
 * md 文件消息承载，卡片只留身份信息（需求名 · action 标题 + 链接按钮 + 署名）。
 * 摘要既说不清内容又占版面，md 文件点开即看。message / question 是短内容、照旧进正文。
 */
export const buildShareCardJson = (opts: {
  requirementName: string;
  kind: ShareKind;
  title?: string;
  content: string;
  links?: ShareLink[];
  storyUrl?: string;
  senderName: string;
}): Record<string, unknown> => {
  const meta = KIND_META[opts.kind];
  const headerTitle = opts.title?.trim()
    ? `${opts.requirementName} · ${opts.title.trim()}`
    : opts.requirementName;
  const elements: unknown[] = [];
  if (opts.kind !== "artifact") {
    // kind 徽标：只在有正文时当正文上方的标签用。artifact 没正文了，
    // 再放一行「**产物**」就是跟 header subtitle 重复占版面
    elements.push({
      tag: "markdown",
      element_id: "md_kind",
      content: `**${meta.label}**`,
    });
    elements.push({
      tag: "markdown",
      element_id: "md_body",
      content: truncateShareContent(opts.content),
    });
  }

  const buttons: unknown[] = [];
  let btnIdx = 0;
  const pushLink = (label: string, url: string) => {
    if (!url.trim()) return;
    btnIdx += 1;
    buttons.push({
      tag: "button",
      element_id: `btn_l${btnIdx}`,
      text: { tag: "plain_text", content: label.slice(0, 20) || "链接" },
      type: "default",
      size: "medium",
      // 只给 default_url：pc/ios/android 是「分端覆盖」可选项，
      // 没有分端差异就省略，别塞空串（语义是「该端跳空链接」）
      behaviors: [{ type: "open_url", default_url: url }],
    });
  };

  // 调用方给的链接按钮封顶：产物正文里可能挖出十几条 MR，全挂上卡片会糊成一片。
  // 「查看工作项」不占这个额度——它是每张卡的固定出口、不能被 MR 挤掉。
  for (const link of (opts.links ?? []).slice(0, LINK_BUTTON_MAX)) {
    pushLink(link.label || "链接", link.url);
  }
  if (opts.storyUrl?.trim()) {
    pushLink("查看工作项", opts.storyUrl.trim());
  }
  if (buttons.length > 0) {
    // 分割线只在上方真有内容时加——artifact 卡没正文，开头顶一条 hr 是条孤零零的横线
    if (elements.length > 0) {
      elements.push({ tag: "hr", element_id: "hr_links" });
    }
    elements.push(...buttons);
  }

  elements.push({ tag: "hr", element_id: "hr_foot" });
  elements.push({
    tag: "markdown",
    element_id: "md_footer",
    content: `来自 ${opts.senderName} · Flowship`,
  });

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: headerTitle.slice(0, 50) },
      template: meta.template,
      subtitle: { tag: "plain_text", content: meta.label },
    },
    body: { elements },
  };
};

/**
 * 本机用户展示名（卡片 footer 署名单一来源）。
 * 群答题卡等其它群内卡片复用它、别各自再拼一份署名。
 */
export const resolveShareSenderName = (): Promise<string> =>
  getDeps().resolveSenderName();

const resolveLocalSenderName = async (): Promise<string> => {
  const id = await fetchMyIdentity();
  if (id?.name) return id.name;
  // meegle 没登录时退 lark 侧本人姓名（auth status 自带、零 API）——
  // 这里要的是**人**的名字，别拿 bot 的应用名来冒充署名
  return (await getLarkLocalIdentity())?.userName?.trim() || "未知用户";
};

// ----------------- 整份产物的 md 文件 -----------------

/** md 文件名主体上限（中文按字计；留足余量避开文件系统 255 字节上限） */
const DOC_NAME_MAX = 60;

/**
 * 洗一段文件名素材：去不可见字符、路径分隔符 / 各平台保留符换成 `-`、压掉多余空白。
 * 需求名和 action 标题都是人写的自由文本，直接当文件名会拼出非法路径。
 */
const sanitizeDocNamePart = (raw: string): string =>
  raw
    // 换行 / tab 先压成空格（放在丢控制字符之前，否则「标题\n换行」会粘成一个词）
    .replace(/\s+/g, " ")
    .replace(/\p{C}/gu, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .trim()
    // 别拼出 `.xxx` 隐藏文件
    .replace(/^\.+/, "")
    .trim();

/**
 * 整份产物的 md 文件名——**群里显示的就是它**，所以要一眼看得出是哪个需求的哪一步。
 * 形如 `登录优化-方案 (Plan).md`；两段都洗不出内容时退 `产物.md`。
 */
export const buildShareDocFilename = (opts: {
  requirementName: string;
  title?: string;
}): string => {
  const base =
    [sanitizeDocNamePart(opts.requirementName), sanitizeDocNamePart(opts.title ?? "")]
      .filter(Boolean)
      .join("-")
      .slice(0, DOC_NAME_MAX)
      .trim() || "产物";
  return `${base}.md`;
};

// ----------------- 分享闭环 -----------------

/**
 * ensure → 发互动卡；发送失败按错误码事后判定「bot 不在群」。
 *
 * `opts.allowCreate: false` = 只往已有的群发、没群直接抛 `no_group`（自动播报用）。
 * `opts.verifyOwnerMembership: true` = 显式分享专用，复用已绑定群前先确认
 * 「本人还在这个群里」，死绑定直接抛 `owner_not_in_group` / `group_unreachable`。
 *
 * kind=artifact 还会**紧跟着发一条 md 文件消息**装全文（卡片本身不再放正文）。
 * 顺序固定「先卡片后文件」：卡片是身份信息、先到先给上下文。文件发失败只 warn、
 * 整体仍算成功——卡片已经在群里了，再抛错会让用户以为什么都没发出去、重复点分享。
 *
 * 返回 { chatId, messageId, created, docMessageId? }。
 */
export const shareToRequirementGroup = async (
  task: Task,
  input: ShareToGroupInput,
  opts: EnsureGroupOptions = {},
): Promise<ShareToGroupResult> => {
  const content = (input.content ?? "").trim();
  if (!content) {
    throw new FeishuGroupError("invalid_input", "分享内容不能为空");
  }
  if (!["artifact", "message", "question"].includes(input.kind)) {
    throw new FeishuGroupError("invalid_input", "kind 必须是 artifact / message / question");
  }

  try {
    // allowCreate 原样透传——自动播报靠它拿到「贴着 createChat 的那道闸」
    const ensured = await ensureRequirementGroup(task, opts);

    const story = await resolveTaskStory(task);
    let requirementName = task.title;
    try {
      const workitemName = await getDeps().fetchWorkitemName(
        story.workItemId,
        story.projectKey,
      );
      if (workitemName?.trim()) requirementName = workitemName.trim();
    } catch {
      /* 标题用 task.title 兜底 */
    }

    const senderName = await getDeps().resolveSenderName();
    const card = buildShareCardJson({
      requirementName,
      kind: input.kind,
      title: input.title,
      content,
      links: input.links,
      storyUrl: story.storyUrl,
      senderName,
    });

    // 建群人本次 create 时本机 bot 已自动入群；后来者的 bot 可能还没被拉进群。
    // 事前查群成员在免审权限下不可行（member_id_type 不收 app_id + 缺 scope）→
    // 直接发、失败按错误码判「bot 不在群」，带准确 bot 名让用户手动加一次，
    // 前端按 code=bot_not_in_group 弹引导弹窗（名称一键复制 + 加完重试发送）。
    let sent;
    try {
      sent = await getDeps().sendCard(ensured.chatId, card);
    } catch (sendErr) {
      if (isBotNotInGroupSendError(sendErr)) {
        const botLabel = await resolveBotDisplayLabel();
        throw new FeishuGroupError(
          "bot_not_in_group",
          `群里还没有你的机器人「${botLabel}」，在群设置里添加一次即可`,
          { botLabel, chatId: ensured.chatId },
        );
      }
      throw sendErr;
    }

    // 整份产物：卡片只是索引、正文全在这条 md 文件消息里（不截断）
    const docMessageId =
      input.kind === "artifact"
        ? await sendShareDoc(ensured.chatId, requirementName, input.title, content)
        : undefined;

    return {
      chatId: ensured.chatId,
      messageId: sent.message_id,
      created: ensured.created,
      // 回执带群名：用户一眼能看出「发到哪个群了」——这条本身就能让发错群暴露出来
      ...(ensured.chatName ? { chatName: ensured.chatName } : {}),
      ...(ensured.membershipUnknown ? { membershipUnknown: true } : {}),
      ...(docMessageId ? { docMessageId } : {}),
    };
  } catch (err) {
    throw await mapExternalError(err);
  }
};

/**
 * 发整份产物的 md 文件；**绝不抛**——卡片已经发出去了，文件挂了只是「少一份附件」，
 * 不该把整次分享判失败（用户会以为没发、重复点，群里就攒出一堆重复卡）。
 * 失败留一条 warn 日志，前端按 `docMessageId` 缺失也能看出来。
 */
const sendShareDoc = async (
  chatId: string,
  requirementName: string,
  title: string | undefined,
  content: string,
): Promise<string | undefined> => {
  const filename = buildShareDocFilename({ requirementName, title });
  try {
    const sent = await getDeps().sendDoc(chatId, filename, content);
    return sent.message_id;
  } catch (err) {
    getDeps().warn(
      `完整产物发送失败（卡片已发出、不影响本次分享）file=${filename}：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
};
