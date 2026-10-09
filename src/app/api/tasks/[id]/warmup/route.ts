/**
 * POST /api/tasks/[id]/warmup
 *
 * 预热（v1.9.28）：前端在「回到窗口 / 聚焦输入框 / 进入任务页」时触发——
 * 趁用户还在敲字，后台刷新 MCP 探活缓存、预读会话存储，让首条消息少等一轮冷启动。
 *
 * 火忘：立即 202，不让前端等；预热做什么、做了多少都只进 warmup.jsonl。
 * 幂等、只读、可丢弃（见 task-warmup.ts）：不建会话、不发消息、不改任何 task 状态。
 * task 不存在 / 有 run 在跑 / 被节流等情形由 warmupTask 内部判定并跳过，对前端一律 202。
 */
import { warmupTask } from "@/lib/server/task-warmup";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const POST = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  // warmupTask 永不 reject；这里再兜一层，保证不会产生 unhandledRejection
  void warmupTask(id).catch(() => undefined);
  return new Response(JSON.stringify({ ok: true }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
};
