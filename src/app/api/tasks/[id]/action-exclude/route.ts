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
 * - **正在跑 / 等 ack 的 action 不能直接划除**：得先走「停止」(/stop) 把它中断、
 *   否则会留个活 agent 指着一个被排除的 action、状态打架。
 *
 * # 错误语义
 *
 * - task / action 不存在 → 404
 * - 划除一个还在进行中的 action → 409（提示先停止）
 */

import { getTask, setActionArtifactExcluded } from "@/lib/server/task-fs";
import { publishTaskStreamEvent } from "@/lib/server/task-runner";
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

  // 进行中的 action 不能直接划除——先停止再划。
  // 但仅当 task 还有活 agent 在跑（runStatus running / awaiting_user）时才拦：
  // task 已 idle / error（agent 早退 / abandon 等）时、遗留的非终态 action 没有活 agent 指着它、
  // 直接允许划除——否则「划除 409 → 让你先停止 → 停止又因 currentActionId=null 收不到它」死循环。
  const taskHasLiveAgent =
    task.runStatus === "running" || task.runStatus === "awaiting_user";
  if (
    body.excluded &&
    taskHasLiveAgent &&
    (action.status === "running" || action.status === "awaiting_ack")
  ) {
    return errorResponse("这个 action 还在进行中、请先「停止」再划除", 409);
  }

  // V0.8.16：不只翻 excluded flag、连 artifact 文件一起挪进 / 挪出隐藏子目录
  // （治本「划除的旧 plan 被 agent ls / 按编号拼路径翻出来读」、见 setActionArtifactExcluded）
  const updated = await setActionArtifactExcluded(id, actionId, body.excluded);
  if (!updated) return errorResponse("not_found", 404);

  publishTaskStreamEvent(id, { kind: "task", task: updated });

  return new Response(JSON.stringify({ ok: true, task: updated }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
