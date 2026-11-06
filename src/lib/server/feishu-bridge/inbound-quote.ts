/**
 * 取回被引用的那条消息并规整成给 agent 看的形态（单聊 router 与群 group-route 共用）。
 *
 * 从 group-route 抽出来：单聊（p2p）和群都要把被回复的那条交给 agent，
 * 取回 / 校验 / 规整 / 属主图片附件的逻辑只能有一份。
 *
 * best-effort：任何失败 / 限流 / 对不上本会话 → null，调用方当没引用、消息照常走。
 * 依赖（取回函数、查名字、解析下载）都由调用方传入——本文件不碰 router / group-roster（避免循环依赖，
 * 也让两边测试都能用假实现）。
 */
import {
  admitNonOwnerQuoteFetch,
  normalizeQuotedText,
  QUOTE_ATTACHMENTS_MAX,
  QUOTE_FETCH_TIMEOUT_MS,
  QUOTE_IMAGES_MAX,
  quoteSenderLabel,
} from "./group-quote";
import { sanitizeGroupMemberName } from "./group-shared";
import {
  fetchInboundMessageDetail,
  type InboundMessageDetail,
} from "./lark-api";
import type { ParsedInboundContent } from "./router";
import type { FeishuInboundMessage } from "./types";

/** 取回并规整后的被引用消息 */
export type InboundQuote = {
  /** 被引用消息 id */
  messageId: string;
  senderLabel: string;
  text: string;
  truncated: boolean;
  /** 仅属主：被引用消息里下载好的图 / 附件（非属主恒空——陌生人不能靠引用让我们下载东西） */
  images: ParsedInboundContent["images"];
  attachments: string[];
};

/** 被引用消息里可能带图 / 文件资源的类型（interactive 卡片 / 视频 / 语音不取资源） */
const QUOTE_RESOURCE_MSG_TYPES = new Set(["image", "file", "post", "text"]);
const QUOTE_RESOURCE_KEY_RE = /\b(?:img|file)_[A-Za-z0-9_-]+/;

/**
 * - 非属主先过限流：取回占全局单飞的 lark 队列，陌生人（含对方机器人）刷「回复 + @」不能拖住入向链；
 * - 回包带了会话 id 且不是本会话 → 丢弃（bot 身份读不到时会退到 user 身份重试，
 *   那条路读得到的东西更多，不能让它把别的会话的消息带进这个任务）；
 * - 已撤回 / 无正文 → null；
 * - 属主的引用里若带图 / 文件，复用 router 的解析下载（带 MAX 闸与 50MB 校验），非属主只取文字。
 */
export const resolveInboundQuote = async (args: {
  msg: Pick<
    FeishuInboundMessage,
    "message_id" | "chat_id" | "chat_type" | "sender_id"
  >;
  anchorId: string;
  isOwner: boolean;
  /** 本机机器人自己的 id（open_id / app_id），判「引用的是不是自己的旧回复」 */
  selfIds: Array<string | null | undefined>;
  parseContent: (msg: FeishuInboundMessage) => Promise<ParsedInboundContent>;
  /** 同步查名字（群：roster；单聊没有名单、传 `() => undefined`） */
  lookupName: (chatId: string, openId: string) => string | undefined;
  /** 日志前缀（区分单聊 / 群） */
  logPrefix: string;
  /** 没有名字可用时对真人的称呼（群缺省「群成员」，单聊传「用户」） */
  userFallbackLabel?: string;
  /** 引用的是机器人自己的旧回复时的字数上限（缺省与普通引用同）；单聊用它压住「回复卡片」带来的重复内容 */
  selfTextMaxChars?: number;
  /** 取回函数（单测缝；缺省走 lark-api） */
  fetchDetail?: (
    messageId: string,
    timeoutMs: number,
  ) => Promise<InboundMessageDetail | null>;
}): Promise<InboundQuote | null> => {
  const { msg, anchorId, isOwner } = args;
  const LOG = args.logPrefix;
  if (!isOwner && !admitNonOwnerQuoteFetch()) {
    console.warn(
      `${LOG} 非属主引用取回被限流、按无引用处理 message=${msg.message_id} sender=${msg.sender_id}`,
    );
    return null;
  }
  const fetchDetail = args.fetchDetail ?? fetchInboundMessageDetail;
  const detail = await fetchDetail(anchorId, QUOTE_FETCH_TIMEOUT_MS).catch(
    () => null,
  );
  if (!detail || detail.deleted) return null;
  if (detail.chatId && detail.chatId !== msg.chat_id) {
    console.warn(
      `${LOG} 被引用消息不在本会话、丢弃 message=${msg.message_id} quoted=${anchorId}`,
    );
    return null;
  }

  const selfIds = args.selfIds.filter((x): x is string => !!x);
  const isSelf = detail.sender.ids.some((id) => selfIds.includes(id));
  const norm = normalizeQuotedText(
    { text: detail.text, msgType: detail.msgType },
    {
      resolveOpenId: (id) => args.lookupName(msg.chat_id, id),
      ...(isSelf && args.selfTextMaxChars
        ? { maxChars: args.selfTextMaxChars }
        : {}),
    },
  );
  const name =
    sanitizeGroupMemberName(detail.sender.name) ||
    sanitizeGroupMemberName(
      detail.sender.openId
        ? args.lookupName(msg.chat_id, detail.sender.openId)
        : undefined,
    );

  let images: ParsedInboundContent["images"] = [];
  let attachments: string[] = [];
  if (
    isOwner &&
    QUOTE_RESOURCE_MSG_TYPES.has(detail.msgType) &&
    QUOTE_RESOURCE_KEY_RE.test(detail.text)
  ) {
    try {
      const full = await args.parseContent({
        type: "im.message.receive_v1",
        message_id: anchorId,
        create_time: "",
        chat_id: msg.chat_id,
        chat_type: msg.chat_type,
        message_type: detail.msgType,
        sender_id: detail.sender.openId,
        content: detail.text,
      });
      if (!full.unsupported) {
        images = full.images.slice(0, QUOTE_IMAGES_MAX);
        attachments = full.attachments.slice(0, QUOTE_ATTACHMENTS_MAX);
      }
    } catch (err) {
      // 引用里的图下不下来不影响正文：文字照常带上
      console.warn(
        `${LOG} 引用消息的图 / 附件解析失败、只带文字 quoted=${anchorId}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    messageId: anchorId,
    senderLabel: quoteSenderLabel({
      name,
      kind: detail.sender.kind,
      isSelf,
      userFallback: args.userFallbackLabel,
    }),
    text: norm.text,
    truncated: norm.truncated,
    images,
    attachments,
  };
};
