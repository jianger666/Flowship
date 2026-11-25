/**
 * 自由对话（chat 任务）的会话挂哪些 Flowship 系统工具。
 *
 * 为什么收窄：正式会话默认把 `flowShipTools` 全挂（不传 `systemToolNames`），可 chat 里有 5 个纯属 task / action 容器的工具
 * 根本用不上，却每个新会话白付描述字符（合计约 2K，仅 `advance_next` 一个就约 1K）。不挂的这 5 个：
 * - `submit_work`：chat 不交卷（chat-runner 对误调只切 awaiting_user）；
 * - `advance_next`：flowship-tools 里 `task.mode === "chat"` 直接回「对话型任务没有可推进的 action」；
 * - `set_plan_batches` / `set_feishu_testers`：plan / ship 步骤专用；
 * - `notify_group_testers`：提测通知，要求当前有 running 的 ship action，chat 里调不了。
 *
 * **`submit_mr` 要保留**：chat 里确有用——`release-review` skill 在对话里直接建上线 MR。别当成「task 专用」顺手摘掉。
 * `create_custom_action`（action-creator skill）、`ask_user`（chat 有 awaiting notifier）、群协作的两个工具、
 * 定时 / 等待 / 预览 / 所有者备注同理，都留。
 *
 * 浏览器 / desktop / 子代理随 callerToken 一起挂，不受这份清单收窄（与属主一次性 agent 同一口径，见 one-shot-tools.ts）。
 *
 * 单独成文件：同 one-shot-tools.ts——chat-runner 不必为一个名字数组去引很重的 flowship-tools。
 * 与 `flowShipTools` 的对账钉在 tests/chat-system-tools.test.ts：新增系统工具必须在「挂 / 不挂」两份里选一份，否则测试红。
 */
import { OWNER_NOTE_TOOL_NAME } from "@/lib/owner-note";
import { SCHEDULE_TOOL_NAME } from "@/lib/schedule";
import { WAIT_TOOL_NAME } from "@/lib/wait-display";
import { ADVANCE_NEXT_TOOL_NAME, PREVIEW_TOOL_NAME } from "@/lib/server/one-shot-tools";

/** chat 会话挂的系统工具（传给 `Agent.create` / `Agent.resume` 的 `systemToolNames`） */
export const CHAT_SYSTEM_TOOL_NAMES: readonly string[] = [
  "ask_user",
  "submit_mr",
  "create_custom_action",
  "share_to_group",
  "expect_group_reply",
  WAIT_TOOL_NAME,
  SCHEDULE_TOOL_NAME,
  PREVIEW_TOOL_NAME,
  OWNER_NOTE_TOOL_NAME,
];

/** chat 不挂的系统工具；与上面一起恰好覆盖 `flowShipTools` 全集（tests/chat-system-tools.test.ts 钉着） */
export const CHAT_OMITTED_SYSTEM_TOOL_NAMES: readonly string[] = [
  "submit_work",
  ADVANCE_NEXT_TOOL_NAME,
  "set_plan_batches",
  "set_feishu_testers",
  "notify_group_testers",
];
