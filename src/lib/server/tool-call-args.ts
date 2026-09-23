/**
 * Tool-call 参数注册表（v3.1 接线层：payloadProvider 的真参数来源）。
 *
 * - intent 记录本身只带 payloadHash；恢复反查要的分支/commit/文案等结构化参数
 *   由外部副作用执行点在执行前登记到这里（key = toolCallId）；
 * - 有界 FIFO（默认 2000，防慢泄漏）；缺失返回 null（调用方按 abandoned 处理，不猜参数）；
 * - 纯内存（进程重启即空——重启后的恢复靠接力消息 + 重新执行，不靠本表）。
 */

export interface ToolCallArgs {
  taskId: string;
  actionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  recordedAt: number;
}

const MAX_ENTRIES = 2000;
const registry = new Map<string, ToolCallArgs>();

const keyOf = (taskId: string, toolCallId: string): string => `${taskId}:${toolCallId}`;

/** 外部副作用执行点调用：执行前登记参数（绝不 throw）。 */
export const recordToolCallArgs = (entry: Omit<ToolCallArgs, "recordedAt">): void => {
  try {
    registry.set(keyOf(entry.taskId, entry.toolCallId), { ...entry, recordedAt: Date.now() });
    while (registry.size > MAX_ENTRIES) {
      const oldest = registry.keys().next();
      if (oldest.done) break;
      registry.delete(oldest.value);
    }
  } catch {
    /* 埋点不许反伤执行 */
  }
};

export const getToolCallArgs = (taskId: string, toolCallId: string): ToolCallArgs | null => {
  try {
    return registry.get(keyOf(taskId, toolCallId)) ?? null;
  } catch {
    return null;
  }
};

export const toolCallArgsSize = (): number => registry.size;

/** 单测隔离用。 */
export const clearToolCallArgs = (): void => {
  registry.clear();
};
