/**
 * 任务页还没有会话时（输入条 / 定时到点落到的那条通道，`startOneShotQuestion`），那个 agent 能用的 Flowship 系统工具名。
 *
 * 单独成文件：task-runner 要用这份清单，而 flowship-tools 很重（拖着 task-fs / schedule-store / 飞书等一大串模块），
 * 不值得为一个名字数组在 task-runner 里再引一份；这里只依赖几个轻量常量。
 *
 * 只挂「不依赖当前 action、也不依赖待答提问 notifier」的：
 * - `schedule`：定时是任务级的（落 schedule-store、到点把消息发回本任务），和有没有推进过 action 无关——
 *   以前这条通道一个系统工具都没有，结果「任务还没推进过」就建不了定时；
 * - `wait`：纯等待，无副作用；
 * - `advance_next`：用户在聊天里说话时，AI 自己判断要不要正式走一步（出方案 / 实现 / 复核）——主导权在 AI，
 *   用户也随时能自己点「推进」。它只用 callerToken + 任务元数据：没有当前 action 时登记「无起点」的链
 *  （见 advance-chain.ts 的 `fromActionId: null`），这一轮结束后由 runner 代用户推进。
 *   不挂它的话，这个 AI 面对「帮我出个方案」只能叫用户去点按钮——同一个 AI 在有没有 action 时能力不对等。
 *   **定时到点那一轮不挂它**（{@link ONE_SHOT_SCHEDULED_SYSTEM_TOOL_NAMES}）：那是 AI 自己留的备忘、不是用户在场说话，
 *   「要不要起下一步」的授权凭据没有来源；以前只在提示词里叫它别用，现在工具清单里直接没有（评审 R19-01）。
 * 交卷 / 提问 / 提 MR / 设批次 / 自定义 action 这类要靠 action 与 notifier 的**不挂**（挂了也只会回「没有 notifier」，
 * 还让模型以为自己在 action 里）；浏览器工具与子代理随 callerToken 一起挂（见 flowship-tools 的 `buildSdkCustomTools` /
 * pi 的 `buildCustomTools`）——**有意保留**（用户 2026-11-11 决定：与正式会话一致、之后要它登录之类也用得上；
 * R10-02），不受这份清单收窄；由 tests/one-shot-system-tools.test.ts「能力面」一节钉住，改门控条件会红。
 */
import { SCHEDULE_TOOL_NAME } from "@/lib/schedule";
import { WAIT_TOOL_NAME } from "@/lib/wait-display";

/** 与 flowship-tools 里 `advanceNextDef.name` 同值（tests/advance-chain-wiring.test.ts 钉死一致） */
export const ADVANCE_NEXT_TOOL_NAME = "advance_next";

/** 用户在场说话（输入条 / 属主的聊天）那条一次性通道的系统工具清单 */
export const ONE_SHOT_SYSTEM_TOOL_NAMES: readonly string[] = [
  SCHEDULE_TOOL_NAME,
  WAIT_TOOL_NAME,
  ADVANCE_NEXT_TOOL_NAME,
];

/** 定时到点那一轮的清单：同上、但**不含** `advance_next`（没有用户在场，登记不了「自动推进」） */
export const ONE_SHOT_SCHEDULED_SYSTEM_TOOL_NAMES: readonly string[] =
  ONE_SHOT_SYSTEM_TOOL_NAMES.filter((n) => n !== ADVANCE_NEXT_TOOL_NAME);

/**
 * 这一轮一次性 agent 该挂哪份系统工具清单（每轮重新算：同一任务的共用会话里，用户轮次与定时轮次交替时，
 * 两边各拿各的——两个后端的 resume 都按本轮入参重建工具，不会沿用上一轮的清单）。
 */
export const oneShotSystemToolNames = (scheduled: boolean): readonly string[] =>
  scheduled ? ONE_SHOT_SCHEDULED_SYSTEM_TOOL_NAMES : ONE_SHOT_SYSTEM_TOOL_NAMES;
