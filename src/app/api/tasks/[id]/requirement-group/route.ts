/**
 * /api/tasks/[id]/requirement-group
 *
 * GET：只读当前绑定（绝不建群）→ { ok: true, bound: null | { chatId, chatName?,
 *   ownerStillIn?, membershipUnknown?, unreachable? } }。需求群设置弹窗的“当前绑定”卡用。
 * POST：只建/取需求群（不发卡片）：ensureRequirementGroup → 回 { chatId, chatName?, created }。
 *
 * Body: { recreateFrom? } —— 与 share-to-group 同款死绑定重建口令。
 */

import { getTask } from "@/lib/server/task-fs";
import {
  describeBoundRequirementGroup,
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

/**
 * POST 的预期内失败 → 409（`ensure` 复用已绑定群时真会抛这两码，前端弹重建引导）。
 * GET 不走这套：`describeBound` 只读状态、死绑定以状态对象返回（`unreachable` /
 * `ownerStillIn: false`），从不抛这两码——GET 的错误只有 no_story / 鉴权 / 权限 / 502。
 */
const POST_GUIDED_CODES = new Set<FeishuGroupError["code"]>([
  "owner_not_in_group",
  "group_unreachable",
]);
/** GET 没有 409 引导：死绑定以状态对象返回，错误只剩通码映射 */
const GET_GUIDED_CODES: ReadonlySet<FeishuGroupError["code"]> = new Set();

const groupErrorResponse = (
  taskId: string,
  err: FeishuGroupError,
  guided: ReadonlySet<FeishuGroupError["code"]> = POST_GUIDED_CODES,
): Response => {
  if (!guided.has(err.code)) {
    console.error(
      `[requirement-group] task=${taskId} code=${err.code}:`,
      err.message,
    );
  }
  const httpStatus = guided.has(err.code)
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

export const GET = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);
  try {
    const bound = await describeBoundRequirementGroup(task);
    return new Response(JSON.stringify({ ok: true, bound }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    if (err instanceof FeishuGroupError)
      return groupErrorResponse(id, err, GET_GUIDED_CODES);
    console.error(`[requirement-group] task=${id} 读绑定失败:`, err);
    return errorResponse(err instanceof Error ? err.message : String(err), 500);
  }
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
