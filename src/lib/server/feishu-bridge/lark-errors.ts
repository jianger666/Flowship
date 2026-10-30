/**
 * 飞书「发群 / 读群」失败的判定（纯函数，只依赖 ./types）。
 *
 * 为什么单独成文件：这几个判定原先在 feishu-group.ts 里（bind / share 用）；而「发群失败提示」
 * （group-failure-notice，入向 / 出向 / 卡片回调共用）也要认「机器人不在群 / 群已解散」。
 * feishu-group.ts 静态依赖 meegle-cli，group-failure-notice 不能反向依赖它（group-route 头部有同一条约束：
 * 避开 meegle 整包），所以抽到这里，两边都只 import 本文件。
 * feishu-group.ts 仍从这里 re-export `isBotNotInGroupSendError`，原调用方与测试不用改。
 */

import { isTransientLarkError, LarkApiError } from "./types";

/**
 * 发群消息失败里代表「bot 不在群 / 没资格往这个群发」的飞书错误码
 * （官方 `POST /im/v1/messages` 错误码表）。命中即走 bot_not_in_group 引导弹窗——
 * 这几种在本产品语境下的补救动作是同一个：去群设置里把本机 bot 加进群 / 放开发言。
 */
export const BOT_NOT_IN_GROUP_LARK_CODES: ReadonlySet<string> = new Set<string>([
  "230002", // The bot can not be outside the group（机器人不在群，主码）
  "230013", // Bot has NO availability to this user（不在应用可用范围）
  "230018", // 群设置禁止当前操作（如仅指定成员可发言）
  "230027", // Lack of necessary permissions（如外部群未开共享）
  "230035", // Send Message Permission deny（禁言 / 被屏蔽）
]);

/** 上面这组码里「机器人还在群里、只是没有发言资格」的几个——发群失败提示要和「已被移出群」说不同的话 */
const NO_SEND_PERMISSION_LARK_CODES: ReadonlySet<string> = new Set<string>([
  "230013",
  "230018",
  "230027",
  "230035",
]);

/** 飞书限流码：OpenAPI 请求频率限制 / 发消息频率限制 */
const RATE_LIMIT_LARK_CODES: ReadonlySet<string> = new Set<string>([
  "99991400",
  "230020",
]);
const RATE_LIMIT_MESSAGE = /frequency limit|rate limit|too many requests/i;

/** Node `execFile` 失败时的 message 形如 `Command failed: <完整命令行>\n<stderr>` */
const CLI_FAILURE_PREFIX = /^Command failed:/;

/** 拿来和关键词比对的 stderr 尾部长度 */
const STDERR_MATCH_TAIL = 500;

/**
 * 拿来和关键词正则比对的文本。
 *
 * - `Command failed: <命令行>` 形态的 message 带着整个请求体——里面是用户 / agent 写的回复正文，
 *   正文里出现「机器人不在群」「rate limit」之类的字样就会把一次无关的失败判成这一类，
 *   提示还会据此给出错的补救建议。所以这种 message 不参与关键词匹配，只看 `raw.stderr` 的尾部。
 *   这是 Node `execFile` 的原始报错形态；真实路径上的错误已经过 `normalizeLarkError`（R14 B4-3），
 *   它把 message 瘦成了下一条说的样子，不再以 `Command failed:` 开头——这一支兜的是没经过它、仍带着命令行的错误。
 * - 其它 message（飞书接口返回的 msg、我们自己抛的、`normalizeLarkError` 瘦过的）原样参与，再补上 `raw.stderr` 的尾部：
 *   `normalizeLarkError` 把 `Command failed:` 瘦成了 stderr 的**最后一行**，关键词若在更靠前的行
 *   （最后一行是提示 / 堆栈）就只剩 stderr 能看到。`raw` 不是 `{stdout, stderr}`（飞书响应体、我们自己抛的）时没有 stderr，只剩 message。
 */
const matchableText = (err: LarkApiError): string => {
  const message = err.message ?? "";
  const raw =
    err.raw && typeof err.raw === "object"
      ? (err.raw as { stderr?: unknown })
      : undefined;
  const stderrTail =
    typeof raw?.stderr === "string" ? raw.stderr.slice(-STDERR_MATCH_TAIL) : "";
  if (CLI_FAILURE_PREFIX.test(message)) return stderrTail;
  return `${message}\n${stderrTail}`;
};

/** 发送失败是否该判成「bot 不在群」——码优先、报文关键词兜底（CLI 偶尔丢 code） */
export const isBotNotInGroupSendError = (err: unknown): boolean => {
  if (!(err instanceof LarkApiError)) return false;
  if (err.code !== undefined && BOT_NOT_IN_GROUP_LARK_CODES.has(String(err.code))) {
    return true;
  }
  return /outside the group|not in the (?:chat|group)|机器人不在/i.test(
    matchableText(err),
  );
};

/**
 * 读群信息失败时，飞书是否**明确表示这个群不存在 / 不可见**（解散、chat_id 失效）。
 *
 * 刻意只认「正面信号」、不用「排除法」：读群信息失败的原因还有缺 scope、网络抖、
 * CLI 超时、bot 被移出群——它们各有各的补救路径（补权限 / 重试 / 把机器人加回去），
 * 误判成「群没了」就是诱导用户白建一个新群、再攒一个孤儿群。判不准就当没判。
 */
export const CHAT_GONE_MESSAGE =
  /chat\s*(?:id\s*)?(?:is\s*)?(?:not\s*found|not\s*exist|does\s*not\s*exist|invalid)|(?:dissolved|disbanded)|群(?:聊)?(?:不存在|已解散|已删除)/i;

export const isChatGoneError = (err: unknown): boolean => {
  if (!(err instanceof LarkApiError)) return false;
  // 网络抖 / 超时：重试能好，不是群没了
  if (isTransientLarkError(err)) return false;
  // bot 自己被移出群：补救是「把机器人加回去」，交给发送后的 bot_not_in_group 引导
  if (isBotNotInGroupSendError(err)) return false;
  // 缺 scope：补权限，不是群没了
  if (err.permissionViolations || err.consoleUrl) return false;
  return CHAT_GONE_MESSAGE.test(matchableText(err));
};

/**
 * 发群失败的分类——只用来给「发群失败提示」选一句读得懂的原因和一条能照做的补救，
 * 不参与重试 / 熔断决策（那是 card-stream 的事）。
 *
 * - `bot_not_in_group`：机器人已不在群里（被移出）。补救：加回群 / 换绑；
 * - `no_send_permission`：机器人还在群里但没有发言资格（被禁言、群设置限制、外部群未开共享、不在应用可用范围）；
 * - `chat_gone`：群已解散 / chat_id 失效。补救：取消关联或换绑；
 * - `rate_limited`：飞书限流，稍后会好；
 * - `other`：认不出——调用方照旧显示原始原因。
 *
 * 判定顺序无所谓：`isChatGoneError` 已排除 bot 不在群 / 缺 scope / 暂时性错误，各类互斥。
 */
export type GroupSendFailureKind =
  | "bot_not_in_group"
  | "no_send_permission"
  | "chat_gone"
  | "rate_limited"
  | "other";

export const classifyGroupSendFailure = (err: unknown): GroupSendFailureKind => {
  if (!(err instanceof LarkApiError)) return "other";
  const code = err.code === undefined ? "" : String(err.code);
  if (isChatGoneError(err)) return "chat_gone";
  if (isBotNotInGroupSendError(err)) {
    return NO_SEND_PERMISSION_LARK_CODES.has(code)
      ? "no_send_permission"
      : "bot_not_in_group";
  }
  if (RATE_LIMIT_LARK_CODES.has(code) || RATE_LIMIT_MESSAGE.test(matchableText(err))) {
    return "rate_limited";
  }
  return "other";
};
