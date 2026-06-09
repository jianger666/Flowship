/**
 * POST /api/tasks/[id]/restart-action
 *
 * 重启当前 action：SDK / agent 断掉、但用户不想重复推进一条同类型 action 时使用。
 *
 * 行为：
 * - 不 append 新 ActionRecord，不消耗新的 action n。
 * - 把当前 action 拉回 running，沿用原 action_id / artifact_path 启动新的 SDK Run。
 * - 新 agent 会先读 events / 旧 artifact / 当前工作区，再继续同一个 action。
 */

import type { ModelSelection } from "@cursor/sdk";

import { errorResponse, isValidModel } from "@/lib/server/route-helpers";
import { getTask } from "@/lib/server/task-fs";
import { restartCurrentAction } from "@/lib/server/task-runner";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  actionId?: string;
  apiKey?: string;
  model?: ModelSelection;
  username?: string;
  gitHost?: string;
  gitToken?: string;
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

  const apiKey = body.apiKey?.trim();
  if (!apiKey) return errorResponse("缺少 apiKey");
  if (!isValidModel(body.model)) return errorResponse("model 非法");

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);
  if (task.mode === "chat") {
    return errorResponse("chat 模式不支持 action 重启，请继续发消息", 409);
  }

  try {
    const { action } = await restartCurrentAction({
      task,
      actionId: body.actionId?.trim() || undefined,
      apiKey,
      model: body.model,
      username: body.username?.trim() || undefined,
      gitHost: body.gitHost?.trim() || undefined,
      gitToken: body.gitToken?.trim() || undefined,
    });
    const fresh = await getTask(task.id);
    return new Response(
      JSON.stringify({ ok: true, task: fresh ?? task, action }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[restart-action] task=${task.id} failed:`, err);
    return errorResponse(message, 400);
  }
};
