/**
 * 测试用：模拟「这个任务**当前会话**里的 agent 在调工具」。
 *
 * 背景（第十八轮，第十六轮评审 P3-T2 / P3-C3 的收口）：`invokeFlowshipTool` 咽喉在标记闸之后多了一道**过期会话闸**——
 * 标记会拒的那几类调用（desktop_* 除收尾、`groupOpenTurnToolDenied` 命中的几个），调用方的 callerToken 必须仍是该任务**当前**会话登记的那一个，
 * 否则按 `CALLER_MISMATCH_ERROR` 拒（见 flowship-tools.ts 的 `isStaleSessionRestrictedCall`）。
 * 所以凡是「没有标记 / 标记放行 → 工具应当进 handler」的正控，都得先让任务有一个当前会话的 token，而且调用时用的就是它：
 * - 真 runner（`internalStartAgent` 等）起的会话已经由 `installSessionIfCurrent` 装好了自己的 callerToken（`String(allocTaskRunInstanceId())`）——
 *   假 agent 在 `send` 里调工具时应当用这个 token（= 本会话的 agent 在调工具）；
 * - 测试直接塞进 `agentSessions` 的假会话、或根本没有会话的纯咽喉用例，没人登记 token——这里补登记一个（`setOneShotCallerToken`，只写期望 token）。
 *
 * 静态 import 的 `chat-pending` 只依赖类型 / 协议常量 / ask-wait / session-wait，没有数据目录之类的副作用，不受「先设 FLOWSHIP_DATA_DIR 再动态 import」的顺序约束。
 * 整体 `vi.mock("@/lib/server/chat-pending")` 且没透传这两个函数的测试不要用本 helper（它拿到的是 mock）。
 */
import { clearOneShotCallerTokenIf, getExpectedCallerToken, setOneShotCallerToken } from "@/lib/server/chat-pending";

/** 缺省 token 名：与各测试里历来写的 `"tok"` 一致，改动最小 */
export const SESSION_TOKEN = "tok";

/**
 * 取该任务当前会话的 token；还没人登记就补登记 `fallback`，并返回它。
 * 真 runner 已经装了 token 的任务：返回 runner 装的那个（不覆盖）。
 *
 * ⚠️ 它对**任意** taskId 都会补登记，所以用它包装调用的用例（如 `browser-e2e-bridge.test.ts` 的 `invoke`）**永远走不到「token 被拒」分支**——
 * 它只能证明「当前会话的 agent 调受限工具能进 handler」，不能证明「过期会话被拒」。拒绝分支的行为用例在 `stale-session-gate.test.ts`
 * （`bindSessionToken` 换 token / `releaseSessionToken` 摘 token 之后拿旧的去调）与 `task-forceclear-keeps-marker.test.ts` 等真链路用例里（第二十轮评审 R20-9）。
 */
export const currentSessionToken = (taskId: string, fallback: string = SESSION_TOKEN): string => {
  const cur = getExpectedCallerToken(taskId);
  if (cur) return cur;
  setOneShotCallerToken(taskId, fallback);
  return fallback;
};

/**
 * 取 **runner 自己**为该任务装好的当前会话 token；没装就抛错（不像 {@link currentSessionToken} 那样补登记一个 fallback）。
 *
 * 用在「真 runner 起的会话、假 agent 在 `send` 里调工具」的用例：它要证明的恰恰是 runner 自己装了 token、且调用方拿到的就是它。
 * 用 `currentSessionToken` 的话，runner 漏装 token 时这里会悄悄补一个 `"tok"`、用例照样绿——测试本身把缺陷遮住了（第十九轮评审 R19-10）。
 * 直接塞进 `agentSessions` 的假会话 / 纯咽喉用例没有 runner 装 token，照旧用 `currentSessionToken` / `bindSessionToken`。
 */
export const installedSessionToken = (taskId: string): string => {
  const cur = getExpectedCallerToken(taskId);
  if (!cur) {
    throw new Error(
      `installedSessionToken：任务 ${taskId} 没有登记会话 token——真 runner 没装？（假会话 / 纯咽喉用例请用 currentSessionToken / bindSessionToken）`,
    );
  }
  return cur;
};

/** 强制把该任务的当前会话 token 设成 `token`（覆盖已有的；纯咽喉用例里模拟「会话换人 / 被接管」） */
export const bindSessionToken = (taskId: string, token: string = SESSION_TOKEN): void => {
  setOneShotCallerToken(taskId, token);
};

/** 摘掉该任务的当前会话 token（只摘是 `token` 的那个；模拟「会话关了 / 已停止」） */
export const releaseSessionToken = (taskId: string, token: string = SESSION_TOKEN): void => {
  clearOneShotCallerTokenIf(taskId, token);
};
