/**
 * 飞书桥接统一启动入口
 *
 * 挂载方式（S5 坑 #4 之后的现状，勿再改回 instrumentation）：
 * - 由 `/api/tasks`、`/api/feishu-bridge/status`、`chat-reply` 等 route 模块加载时
 *   副作用调用 `ensureFeishuBridgeBootstrapped()`（webpack 吃 serverExternalPackages
 *   会炸 instrumentation，故不能挂那里——见提案 S5 实录 #4）
 * - Electron 壳 waitForReady 成功后会 fire-and-forget GET
 *   `/api/feishu-bridge/status` 一次，兜底 headless / Tray 静默启动无人发 HTTP
 *   时也能起 consumer（R1-14）
 *
 * 各模块自带 globalThis 幂等，这里只负责「一处调齐」：
 * - outbound：全局 tap 订阅 chat 事件流 → 流式卡片
 * - card-action：卡片按钮回调（ask 答题 / 错误重试）
 * - commands：/stop /new /list /status /help
 * - reactions：注入结果 emoji 回执（Get / Typing / CrossMark）
 * - inbound runtime：consumer 守护 + keep-awake + 30s 开关轮询
 *
 * 撤回同步（recall）已下线（2026-07-19 用户拍板：CLI 未收录 recalled_v1、支持不确定）。
 */

import { ensureCardActionHandlerRegistered } from "./card-action";
import { ensureBridgeCommandsRegistered } from "./commands";
import { ensureBridgeRuntimePolling } from "./inbound";
import { ensureFeishuOutboundRegistered } from "./outbound";
import { ensureReactionReceiptsRegistered } from "./reactions";

/** server 启动时调一次；重复调用无副作用 */
export const ensureFeishuBridgeBootstrapped = (): void => {
  ensureFeishuOutboundRegistered();
  ensureCardActionHandlerRegistered();
  ensureBridgeCommandsRegistered();
  ensureReactionReceiptsRegistered();
  // vitest：ownership 等测会 import chat-reply /tasks 路由触发本函数；
  // 那些用例常只 mock kill-orphans.reapTaskOrphans，sync→stopConsumer 调
  // unregisterManagedChild 会炸成 unhandled rejection。桥接单测自行调
  // ensureBridgeRuntimePolling / syncBridgeRuntime，不依赖本锚点起 consumer。
  if (process.env.VITEST) return;
  // 放最后：consumer 起来时上面的 handler / 命令表已就位
  ensureBridgeRuntimePolling();
};
