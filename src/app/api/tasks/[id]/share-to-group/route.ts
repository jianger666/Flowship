/**
 * POST /api/tasks/[id]/share-to-group
 *
 * 把产物 / 消息 / 疑问分享到飞书「需求群」：
 * ensureRequirementGroup（幂等建/取群）→ 检测本机 bot 在群 → 发互动卡片。
 * kind=artifact 再紧跟一条 md 文件消息装全文（卡片不放正文）。
 *
 * Body: { kind, title?, content, links?: [{label,url}], recreateFrom? }
 * 成功: { ok: true, chatId, chatName?, messageId, created, membershipUnknown?, docMessageId? }
 * 失败: { error, code?, botLabel?, chatId?, chatName? }
 *      （bot_not_in_group / owner_not_in_group / group_unreachable 等结构化字段）
 *
 * `recreateFrom` = 用户在「你已不在原需求群」引导里确认重建时回传的那条失效 chatId：
 * 跳过复用、重建群并覆盖工作项绑定。只有用户显式确认过才会带，agent / 播报都不带。
 */

import { getTask } from "@/lib/server/task-fs";
import {
  FeishuGroupError,
  shareToRequirementGroup,
  type ShareKind,
  type ShareLink,
} from "@/lib/server/feishu-group";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  kind?: string;
  title?: string;
  content?: string;
  links?: Array<{ label?: string; url?: string }>;
  /** 用户确认重建时回传的失效 chatId（见文件头） */
  recreateFrom?: string;
}

const isShareKind = (v: unknown): v is ShareKind =>
  v === "artifact" || v === "message" || v === "question";

/**
 * 前端有弹窗引导、用户点两下就能自救的失败——统一 409，且不当异常刷日志。
 * bot 不在群 → 手动加机器人；本人不在群 / 群没了 → 重新建群。
 */
const GUIDED_CODES = new Set<FeishuGroupError["code"]>([
  "bot_not_in_group",
  "owner_not_in_group",
  "group_unreachable",
]);

/** 结构化错误响应（前端可按 code 弹引导） */
const groupErrorResponse = (taskId: string, err: FeishuGroupError): Response => {
  // 前端有引导弹窗兜着的「预期内失败」不刷 error 日志；其余一律进日志——
  // 之前这里静默返回，飞书那句「field validation failed」在服务端不留任何痕迹、
  // 事后完全无从排查（2026-07-27 踩过）
  if (!GUIDED_CODES.has(err.code)) {
    console.error(
      `[share-to-group] task=${taskId} code=${err.code}:`,
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

  if (!isShareKind(body.kind)) {
    return errorResponse("kind 必须是 artifact / message / question");
  }
  const content = (body.content ?? "").trim();
  if (!content) return errorResponse("content 不能为空");

  const links: ShareLink[] = [];
  if (body.links !== undefined) {
    if (!Array.isArray(body.links)) {
      return errorResponse("links 必须是数组");
    }
    for (const item of body.links) {
      if (!item || typeof item !== "object") continue;
      const url = typeof item.url === "string" ? item.url.trim() : "";
      if (!url) continue;
      links.push({
        label: typeof item.label === "string" ? item.label.trim() : "链接",
        url,
      });
    }
  }

  const recreateFrom =
    typeof body.recreateFrom === "string" ? body.recreateFrom.trim() : "";

  try {
    const result = await shareToRequirementGroup(
      task,
      {
        kind: body.kind,
        title: typeof body.title === "string" ? body.title : undefined,
        content,
        links: links.length > 0 ? links : undefined,
      },
      {
        // 显式分享：目标读者就是发起人本人，他看不见 = 这次分享没有意义 → 复用绑定前先校验
        verifyOwnerMembership: true,
        ...(recreateFrom ? { recreateFrom } : {}),
      },
    );
    return new Response(
      JSON.stringify({
        ok: true,
        chatId: result.chatId,
        messageId: result.messageId,
        created: result.created,
        // 回执带群名：前端 toast 说清「发到哪个群了」
        ...(result.chatName ? { chatName: result.chatName } : {}),
        // 「本人在不在群」没查出来（scope / 网络）——照常发了，但把不确定性透出去
        ...(result.membershipUnknown ? { membershipUnknown: true } : {}),
        // 整份产物才有：md 文件消息 id；缺失 = 没发或发失败（卡片仍已发出）
        ...(result.docMessageId ? { docMessageId: result.docMessageId } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    if (err instanceof FeishuGroupError) return groupErrorResponse(id, err);
    console.error(`[share-to-group] task=${id} 失败:`, err);
    return errorResponse(
      err instanceof Error ? err.message : String(err),
      500,
    );
  }
};
