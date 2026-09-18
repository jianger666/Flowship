/**
 * /api/tasks/[id]/requirement-group/bind
 *
 * POST：手动关联到一个已有群：校验目标群 → 只记本任务本地 → 回最新 task。
 *   Body: { chatId: string } —— 群设置复制的群 ID（oc_ 开头，允许粘整段文本、
 *   服务端自动提取；一次只认一个，多个直接 invalid_input）。
 *   成功: { ok: true, chatId, chatName?, overwritten, previousChatId?,
 *     membershipUnknown?, task }
 * DELETE：取消本任务自带的群关联（回落读项目群默认）→ 回最新 task。
 *   成功: { ok: true, cleared, chatId?, task }
 *
 * 工作项碰都不碰：这里的关联只归这个任务，别人的机器、别人的任务不受影响。
 *
 * 错误分流（前端按 code 做内联引导，不只 toast）：
 * - 409 bot_not_in_group：机器人还不在目标群（带 botLabel + chatId）
 * - 409 owner_not_in_group：本人还不在目标群（带 chatId + chatName）
 * - 400 invalid_input / no_story：群 ID 格式不对、群已解散、未关联工作项
 * - 401 meegle_not_authed / lark_not_authed，403 lark_permission，其余 502
 */

import {
  getTask,
  setTaskGroupAssociation,
} from "@/lib/server/task-fs";
import {
  bindExistingRequirementGroup,
  clearTaskGroupAssociation,
  FeishuGroupError,
} from "@/lib/server/feishu-group";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  chatId?: unknown;
}

/** 有明确自救路径的预期内失败 → 409，不当异常刷日志 */
const GUIDED_CODES = new Set<FeishuGroupError["code"]>([
  "bot_not_in_group",
  "owner_not_in_group",
  "group_unreachable",
]);

const groupErrorResponse = (taskId: string, err: FeishuGroupError): Response => {
  if (!GUIDED_CODES.has(err.code)) {
    console.error(
      `[requirement-group/bind] task=${taskId} code=${err.code}:`,
      err.message,
    );
  }
  const httpStatus = GUIDED_CODES.has(err.code)
    ? 409
    : err.code === "no_story" || err.code === "invalid_input"
      ? 400
      : err.code === "meegle_not_authed" || err.code === "lark_not_authed"
        ? 401
        : err.code === "lark_permission"
          ? 403
          : 502;
  return new Response(
    JSON.stringify({
      error: err.message,
      code: err.code,
      ...(err.botLabel ? { botLabel: err.botLabel } : {}),
      ...(err.chatId ? { chatId: err.chatId } : {}),
      ...(err.chatName ? { chatName: err.chatName } : {}),
    }),
    { status: httpStatus, headers: { "Content-Type": "application/json" } },
  );
};

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  try {
    const result = await bindExistingRequirementGroup(
      task,
      body.chatId,
      // 只记本任务本地（工作项碰都不碰）
      (chatId, chatName) =>
        setTaskGroupAssociation(id, { chatId, chatName }).then(() => {}),
    );
    // 落盘后重读：把最新的任务（含本地群关联）带回去，调用方直接刷 UI
    const updated = await getTask(id);
    if (!updated) return errorResponse("任务不存在或已删除", 404);
    return new Response(
      JSON.stringify({
        ok: true,
        chatId: result.chatId,
        overwritten: result.overwritten,
        ...(result.previousChatId
          ? { previousChatId: result.previousChatId }
          : {}),
        ...(result.chatName ? { chatName: result.chatName } : {}),
        ...(result.membershipUnknown ? { membershipUnknown: true } : {}),
        task: updated,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    if (err instanceof FeishuGroupError) return groupErrorResponse(id, err);
    console.error(`[requirement-group/bind] task=${id} 失败:`, err);
    return errorResponse(
      err instanceof Error ? err.message : String(err),
      500,
    );
  }
};

export const DELETE = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  try {
    const result = await clearTaskGroupAssociation(task, () =>
      setTaskGroupAssociation(id, null).then(() => {}),
    );
    const updated = await getTask(id);
    if (!updated) return errorResponse("任务不存在或已删除", 404);
    return new Response(
      JSON.stringify({
        ok: true,
        cleared: result.cleared,
        ...(result.chatId ? { chatId: result.chatId } : {}),
        task: updated,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    if (err instanceof FeishuGroupError) return groupErrorResponse(id, err);
    console.error(`[requirement-group/bind] task=${id} 取消关联失败:`, err);
    return errorResponse(
      err instanceof Error ? err.message : String(err),
      500,
    );
  }
};
