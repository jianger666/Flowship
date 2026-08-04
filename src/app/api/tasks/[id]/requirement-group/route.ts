/**
 * POST /api/tasks/[id]/requirement-group
 *
 * 只建/取需求群（不发卡片）：ensureRequirementGroup → 回 { chatId, chatName?, created }。
 * 前端「需求群」按钮用：成功后用 applink 打开飞书客户端。
 *
 * Body: { recreateFrom? } —— 与 share-to-group 同款死绑定重建口令。
 */

import { getTask } from "@/lib/server/task-fs";
import {
  ensureRequirementGroup,
  FeishuGroupError,
} from "@/lib/server/feishu-group";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  recreateFrom?: string;
}

/** 前端有引导的「预期内失败」→ 409，不当异常刷日志 */
const GUIDED_CODES = new Set<FeishuGroupError["code"]>([
  "owner_not_in_group",
  "group_unreachable",
]);

const groupErrorResponse = (taskId: string, err: FeishuGroupError): Response => {
  if (!GUIDED_CODES.has(err.code)) {
    console.error(
      `[requirement-group] task=${taskId} code=${err.code}:`,
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

  let body: PostBody = {};
  try {
    // 允许空 body（只点按钮、不重建）
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const recreateFrom =
    typeof body.recreateFrom === "string" ? body.recreateFrom.trim() : "";

  try {
    const result = await ensureRequirementGroup(task, {
      // 显式进群：目标读者是发起人自己，他不在群里 = 这次没意义
      verifyOwnerMembership: true,
      allowCreate: true,
      ...(recreateFrom ? { recreateFrom } : {}),
    });
    return new Response(
      JSON.stringify({
        ok: true,
        chatId: result.chatId,
        created: result.created,
        ...(result.chatName ? { chatName: result.chatName } : {}),
        ...(result.membershipUnknown ? { membershipUnknown: true } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    if (err instanceof FeishuGroupError) return groupErrorResponse(id, err);
    console.error(`[requirement-group] task=${id} 失败:`, err);
    return errorResponse(
      err instanceof Error ? err.message : String(err),
      500,
    );
  }
};
