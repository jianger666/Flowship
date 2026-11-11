/**
 * 属主「一次性 agent」（task 页还没有会话时，输入条 / 定时到点落到的那条通道，`startOneShotQuestion`）能用的 Flowship 系统工具名。
 *
 * 单独成文件：task-runner 要用这份清单，而 flowship-tools 很重（拖着 task-fs / schedule-store / 飞书等一大串模块），
 * 不值得为一个名字数组在 task-runner 里再引一份；这里只依赖两个轻量常量。
 *
 * 只挂「不依赖当前 action、也不依赖待答提问 notifier」的：
 * - `schedule`：定时是任务级的（落 schedule-store、到点把消息发回本任务），和有没有推进过 action 无关——
 *   以前这条通道一个系统工具都没有，结果「任务还没推进过」就建不了定时；
 * - `wait`：纯等待，无副作用。
 * 交卷 / 提问 / 提 MR / 设批次 / 自定义 action / 推进这类要靠 action 与 notifier 的**不挂**（挂了也只会回「没有 notifier」，
 * 还让模型以为自己在 action 里）；浏览器工具与子代理随 callerToken 一起挂（见 flowship-tools 的 `buildSdkCustomTools` /
 * pi 的 `buildCustomTools`）——**有意保留**（用户 2026-11-11 决定：与正式会话一致、之后要它登录之类也用得上；
 * R10-02），不受这份清单收窄；由 tests/one-shot-system-tools.test.ts「能力面」一节钉住，改门控条件会红。
 */
import { SCHEDULE_TOOL_NAME } from "@/lib/schedule";
import { WAIT_TOOL_NAME } from "@/lib/wait-display";

export const ONE_SHOT_SYSTEM_TOOL_NAMES: readonly string[] = [
  SCHEDULE_TOOL_NAME,
  WAIT_TOOL_NAME,
];
