/**
 * 飞书桥接统一启动入口（instrumentation 调用）
 *
 * 各模块自带 globalThis 幂等，这里只负责「一处调齐」：
 * - outbound：全局 tap 订阅 chat 事件流 → 流式卡片
 * - card-action：卡片按钮回调（ask 答题 / 错误重试）
 * - commands：/stop /compact /new /list /history /status /help
 * - reactions：注入结果 emoji 回执（Get / Typing / CrossMark）
 * - recall：撤回消息同步出队
 * - inbound runtime：consumer 守护 + keep-awake + 30s 开关轮询
 */

import { ensureCardActionHandlerRegistered } from "./card-action";
import { ensureBridgeCommandsRegistered } from "./commands";
import { ensureBridgeRuntimePolling } from "./inbound";
import { ensureFeishuOutboundRegistered } from "./outbound";
import { ensureReactionReceiptsRegistered } from "./reactions";
import { ensureRecallHandlingRegistered } from "./recall";

/** server 启动时调一次；重复调用无副作用 */
export const ensureFeishuBridgeBootstrapped = (): void => {
  ensureFeishuOutboundRegistered();
  ensureCardActionHandlerRegistered();
  ensureBridgeCommandsRegistered();
  ensureReactionReceiptsRegistered();
  ensureRecallHandlingRegistered();
  // 放最后：consumer 起来时上面的 handler / 命令表已就位
  ensureBridgeRuntimePolling();
};
