/**
 * POST /api/tasks/[id]/action-exclude
 *
 * V0.6.x「划除 / 恢复」单条 action（软删）。
 *
 * # Body
 *
 * ```
 * {
 *   actionId: string,    // 必填：要划除 / 恢复的 action id
 *   excluded: boolean,   // true=划除（排出 agent 上下文）/ false=恢复
 * }
 * ```
 *
 * # 设计
 *
 * - 软删：只翻 ActionRecord.excluded 标记、不删 artifact / events / 不动 N——可逆。
 * - renderActionHistorySection（task-runner）会跳过 excluded=true 的 action、
 *   下次起 Run / 接力时它就不进 agent 上下文了（治本「冗余 action 污染后续推进」）。
 * - **正在跑（runStatus=running）的 action 不能直接划除**：得先走「停止」(/stop)
 *   把它中断、否则会留个活 agent 指着一个被排除的 action、状态打架。
 * - **交卷等 ack（runStatus=awaiting_user）的 action 划除时自动停止收尾**：turn 已
 *   结束、没有飞行中的 run、且该态顶栏没有「停止」按钮（409 让用户先停止是死胡同、
 *   2026-07-16 用户实测踩过）——划除即隐含「这个 action 不要了」、内联走 stopTaskAgent
 *   （关会话 / 清 ask / 标 cancelled / runStatus 回 idle）后再划。
 *
 * # 错误语义
 *
 * - task / action 不存在 → 404
 * - 划除一个正在跑的 action → 409（提示先停止）
 * - 搬动 artifact 后写 meta 失败：已把文件搬回去 → 500 `exclude_failed`；
 *   连搬回去也失败（文件还躺在 `.excluded/`）→ 500 `artifact_rollback_failed`。
 *   两种 500 的文案都**不含绝对路径**（与 stop 路由同口径）；文件现在在哪只写 server 日志
 */

import { getTask } from "@/lib/server/task-fs";
import {
  ArtifactMoveRollbackError,
  setActionArtifactExcluded,
} from "@/lib/server/task-artifacts";
import { publishTaskStreamEvent } from "@/lib/server/task-stream";
import { stopTaskAgent } from "@/lib/server/stop-task";
import { errorResponse } from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  actionId?: string;
  excluded?: boolean;
}

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const actionId = (body.actionId ?? "").trim();
  if (!actionId) return errorResponse("actionId 必填");
  if (typeof body.excluded !== "boolean") {
    return errorResponse("excluded 必须是 boolean");
  }

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  const action = task.actions.find((a) => a.id === actionId);
  if (!action) return errorResponse("action 不存在", 404);

  // 划除非终态（running / awaiting_ack）action 的分档处理：
  // - running：agent 真在跑、拦下让用户先「停止」（该态顶栏有停止按钮、流程通）
  // - awaiting_user：交卷等 ack、没有飞行中的 run、顶栏也没有停止按钮——自动停止收尾后放行
  // - idle / error（agent 早退 / abandon 等遗留非终态 action）：没有活 agent 指着它、直接放行
  //  （否则「划除 409 → 让你先停止 → 停止又因 currentActionId=null 收不到它」死循环）
  if (
    body.excluded &&
    (action.status === "running" || action.status === "awaiting_ack")
  ) {
    if (task.runStatus === "running") {
      return errorResponse("这个 action 还在进行中、请先「停止」再划除", 409);
    }
    if (task.runStatus === "awaiting_user") {
      await stopTaskAgent(task, { trigger: "exclude" });
    }
  }

  // V0.8.16：不只翻 excluded flag、连 artifact 文件一起挪进 / 挪出隐藏子目录
  // （治本「划除的旧 plan 被 agent ls / 按编号拼路径翻出来读」、见 setActionArtifactExcluded）
  let updated: Awaited<ReturnType<typeof setActionArtifactExcluded>>;
  try {
    updated = await setActionArtifactExcluded(id, actionId, body.excluded);
  } catch (err) {
    // 挪文件 / 写 meta 失败：setActionArtifactExcluded 已把 rename 回滚（文件与 meta 一致、本次操作没生效）；
    // 回滚也失败时错误文案会点明文件现在的位置。都给明确的 500，不让它变成没有信息的裸 500
    if (err instanceof ArtifactMoveRollbackError) {
      // 详细位置（绝对路径）只写 server 日志：与 stop 等路由同口径，不把本机路径回给前端；
      // 前端文案只说「没回滚成功、记录与文件可能不一致」，具体在哪靠日志 / 用户打开任务目录检查
      console.error(`[action-exclude] ${err.message} task=${id} action=${actionId}`);
      return errorResponse(
        "划除 / 恢复失败，且产出文件未能回滚到原位置：任务记录与产出文件可能不一致，请重试；仍失败请到该任务的产出目录（含 .excluded 子目录）检查，详细路径见应用日志",
        500,
        { code: "artifact_rollback_failed" },
      );
    }
    console.error(`[action-exclude] 划除 / 恢复失败 task=${id} action=${actionId}：`, err);
    return errorResponse("划除 / 恢复失败（产出文件保持原位置），请稍后重试", 500, {
      code: "exclude_failed",
    });
  }
  if (!updated) return errorResponse("not_found", 404);

  publishTaskStreamEvent(id, { kind: "task", task: updated });

  return new Response(JSON.stringify({ ok: true, task: updated }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
