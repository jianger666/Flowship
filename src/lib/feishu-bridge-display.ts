/**
 * 飞书消息桥接设置页：检查行文案 / 色调（单一来源）
 *
 * conflict = 本机另一处 Flowship 已占长连接，飞书本身往往没坏——注意态，不当失败红叉。
 */

export type FeishuCheckTone = "ok" | "warning" | "error";

export const FEISHU_CONSUMER_LABEL: Record<string, string> = {
  "im.message.receive_v1": "收消息",
  "card.action.trigger": "卡片按钮",
};

/** 未订阅 / CLI 不支持：要用户去开通 */
const CONSUMER_UNSUPPORTED_HINT: Record<string, string> = {
  "im.message.receive_v1": "开通后才能在飞书里回消息",
  "card.action.trigger": "开通后可直接点卡片按钮答题",
};

/** 本进程监听挂了：要恢复 */
const CONSUMER_ERROR_HINT: Record<string, string> = {
  "im.message.receive_v1": "恢复后才能在飞书里回消息",
  "card.action.trigger": "恢复后才能点卡片按钮答题",
};

/** 长连接已被本机另一处占用：飞书收发走那边 */
const CONSUMER_CONFLICT_HINT: Record<string, string> = {
  "im.message.receive_v1": "本机另一处 Flowship 已在收消息",
  "card.action.trigger": "本机另一处 Flowship 已在处理卡片按钮",
};

export const isFeishuConsumerConflict = (status: string): boolean =>
  status === "conflict";

/** 真要用户处理的监听故障（没开通 / 挂了）；conflict 不算坏 */
export const isFeishuConsumerBlocking = (status: string): boolean =>
  status === "unsupported" || status === "error";

export const feishuConsumerIssueTone = (status: string): FeishuCheckTone =>
  isFeishuConsumerConflict(status) ? "warning" : "error";

export const feishuConsumerIssueDetail = (c: {
  eventKey: string;
  status: string;
  lastError?: string;
}): string => {
  if (c.status === "conflict") {
    return CONSUMER_CONFLICT_HINT[c.eventKey] ?? "本机另一处 Flowship 已在收消息";
  }
  if (c.status === "unsupported") {
    return CONSUMER_UNSUPPORTED_HINT[c.eventKey] ?? c.lastError ?? "";
  }
  return CONSUMER_ERROR_HINT[c.eventKey] ?? c.lastError ?? "";
};
