/**
 * POST /api/mr-inbox/bug-transition
 *
 * body:
 * - { action: "pass"|"reject", reason?, projectKey, workItemId, bugUrl? }
 *   pass → CLOSED；reject → OPEN/REOPENED + 评论
 * - { action: "transition", transitionId, targetStateKey?, targetStateLabel?,
 *     projectKey, workItemId, bugUrl }
 *   直接用传入 transitionId 流转（「我的 BUG」状态 chip 下拉）
 *
 * 流转前有 targetStateKey 时查 list-state-required；有未覆盖必填 → 409 + bugUrl。
 * 成功后：新状态仍属待修白名单 → invalidate 缓存；否则剔除该 bug。
 */

import { NextResponse } from "next/server";

import {
  BUG_STATUS,
  buildBugDetailUrl,
  isBugPendingFixStatus,
} from "@/lib/mr-inbox";
import {
  addWorkitemComment,
  fetchMyUserKey,
  listBugStateRequired,
  listBugStateTransitions,
  MeegleError,
  transitionBugState,
  type StateRequiredField,
  type StateTransitionOption,
} from "@/lib/server/meegle-cli";
import {
  invalidateMrInboxCache,
  removeBugFromInboxCache,
} from "@/lib/server/mr-inbox-scanner";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

const pickTransition = (
  options: StateTransitionOption[],
  preferLabels: string[],
  preferKeys: string[],
): StateTransitionOption | undefined => {
  const labelSet = new Set(preferLabels.map((s) => s.toUpperCase()));
  const keySet = new Set(preferKeys);
  const byLabel = options.find((o) =>
    o.targetStateLabel
      ? labelSet.has(o.targetStateLabel.trim().toUpperCase())
      : false,
  );
  if (byLabel) return byLabel;
  return options.find((o) =>
    o.targetStateKey ? keySet.has(o.targetStateKey) : false,
  );
};

/** 必填字段非空 → 409（前端 toast + 去飞书） */
const requiredFieldsConflict = (
  bugUrl: string,
  required: StateRequiredField[],
): NextResponse =>
  NextResponse.json(
    {
      error: "该状态流转有必填字段、去飞书处理",
      bugUrl,
      requiredFields: required,
    },
    { status: 409 },
  );

export const POST = async (req: Request) => {
  let body: {
    bugUrl?: unknown;
    projectKey?: unknown;
    workItemId?: unknown;
    action?: unknown;
    reason?: unknown;
    transitionId?: unknown;
    targetStateKey?: unknown;
    targetStateLabel?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }

  const projectKey =
    typeof body.projectKey === "string" ? body.projectKey.trim() : "";
  const workItemId =
    typeof body.workItemId === "string" ? body.workItemId.trim() : "";
  const actionRaw = typeof body.action === "string" ? body.action : "";
  const action =
    actionRaw === "pass" || actionRaw === "reject" || actionRaw === "transition"
      ? actionRaw
      : null;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const bugUrlRaw = typeof body.bugUrl === "string" ? body.bugUrl.trim() : "";
  const transitionId =
    typeof body.transitionId === "string" ? body.transitionId.trim() : "";
  const targetStateKey =
    typeof body.targetStateKey === "string"
      ? body.targetStateKey.trim()
      : "";
  const targetStateLabel =
    typeof body.targetStateLabel === "string"
      ? body.targetStateLabel.trim()
      : "";

  if (!projectKey || !workItemId || !action) {
    return errorResponse("缺少 projectKey / workItemId / action");
  }
  if (action === "reject" && !reason) {
    return errorResponse("不通过必须填写原因");
  }
  if (action === "transition" && !transitionId) {
    return errorResponse("缺少 transitionId");
  }

  const bugUrl =
    bugUrlRaw || buildBugDetailUrl({ projectKey, workItemId });

  try {
    const userKey = await fetchMyUserKey();
    if (!userKey) {
      return errorResponse("meegle 未登录、请先在设置页授权", 401);
    }

    // —— 就地流转：直接用客户端选中的 transitionId ——
    if (action === "transition") {
      if (targetStateKey) {
        const required = await listBugStateRequired(
          projectKey,
          workItemId,
          targetStateKey,
        );
        if (required.length > 0) {
          return requiredFieldsConflict(bugUrl, required);
        }
      }

      await transitionBugState(projectKey, workItemId, transitionId);

      // 新状态仍属待修 → 只失效缓存（statusLabel 过期）；否则从收件箱剔除
      if (isBugPendingFixStatus(targetStateLabel)) {
        invalidateMrInboxCache();
      } else {
        removeBugFromInboxCache(bugUrl);
      }

      return NextResponse.json({
        ok: true,
        action,
        bugUrl,
        transitionId,
        targetStateLabel: targetStateLabel || undefined,
        targetStateKey: targetStateKey || undefined,
        stillPendingFix: isBugPendingFixStatus(targetStateLabel),
      });
    }

    // —— pass / reject：按标签挑目标状态 ——
    const transitions = await listBugStateTransitions(
      projectKey,
      workItemId,
      userKey,
    );

    const target =
      action === "pass"
        ? pickTransition(
            transitions,
            [BUG_STATUS.CLOSED.label],
            [BUG_STATUS.CLOSED.key],
          )
        : pickTransition(
            transitions,
            [BUG_STATUS.OPEN.label, BUG_STATUS.REOPENED.label],
            [BUG_STATUS.OPEN.key, BUG_STATUS.REOPENED.key],
          );

    if (!target) {
      return errorResponse(
        action === "pass"
          ? "当前无法流转到 CLOSED、请去飞书处理"
          : "当前无法打回 OPEN/REOPENED、请去飞书处理",
      );
    }

    const stateKey = target.targetStateKey;
    if (stateKey) {
      const required = await listBugStateRequired(
        projectKey,
        workItemId,
        stateKey,
      );
      if (required.length > 0) {
        return requiredFieldsConflict(bugUrl, required);
      }
    }

    if (action === "reject") {
      await addWorkitemComment(
        projectKey,
        workItemId,
        `回归不通过：${reason}`,
      );
    }

    await transitionBugState(projectKey, workItemId, target.transitionId);
    removeBugFromInboxCache(bugUrl);

    return NextResponse.json({
      ok: true,
      action,
      bugUrl,
      transitionId: target.transitionId,
      targetStateLabel: target.targetStateLabel,
      targetStateKey: target.targetStateKey,
    });
  } catch (err) {
    if (err instanceof MeegleError) {
      const status =
        err.kind === "not_authed"
          ? 401
          : err.kind === "not_installed"
            ? 503
            : 502;
      return errorResponse(err.message, status);
    }
    console.error("[POST /api/mr-inbox/bug-transition] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : String(err),
      500,
    );
  }
};
