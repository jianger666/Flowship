/**
 * /api/custom-actions/[id]
 *   GET    → 单个自定义 action（app: / team: / legacy）
 *   PATCH  → 更新壳参数（仅 app:；skill 不可改）
 *   DELETE → 删除：
 *     - team: → 卸载
 *     - app:  → ?withSkill=1 连 skill 删；默认仅删 .flowship-action.json
 *     - legacy → 删旧 ACTION.md 目录
 */

import { NextResponse } from "next/server";
import {
  getCustomAction,
  isAppActionId,
  isTeamActionId,
  removeActionShell,
  removeAppSkillWithAction,
  removeCustomAction,
  skillNameFromAppActionId,
  skillNameFromTeamActionId,
  updateCustomAction,
  type CustomActionInput,
} from "@/lib/server/custom-action-fs";
import { uninstallTeamSkill } from "@/lib/server/team-library";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = async (_req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const action = await getCustomAction(id);
    if (!action)
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ action });
  } catch (err) {
    console.error("[GET /api/custom-actions/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};

export const PATCH = async (req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    // 派生 team action 无本地定义文件——拒改
    if (isTeamActionId(id)) {
      return NextResponse.json(
        { error: "定义在共享库、修改请上传新版" },
        { status: 400 },
      );
    }
    const body = (await req.json()) as Record<string, unknown>;

    // 只收传了的字段（部分更新）——没传的保留原值；skill 由 fs 层锁定
    const patch: Partial<CustomActionInput> = {};
    if ("label" in body) {
      if (typeof body.label !== "string" || !body.label.trim()) {
        return NextResponse.json(
          { error: "label 必须是非空字符串" },
          { status: 400 },
        );
      }
      patch.label = body.label;
    }
    if ("output" in body) {
      patch.output = typeof body.output === "string" ? body.output : "";
    }
    if ("placeholder" in body) {
      patch.placeholder =
        typeof body.placeholder === "string" ? body.placeholder : "";
    }
    if ("requiresKnowledge" in body) {
      // 显式 false / 其它 → 清掉；仅 true 写入
      patch.requiresKnowledge = body.requiresKnowledge === true;
    }

    const action = await updateCustomAction(id, patch);
    return NextResponse.json({ action });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("不存在")) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    console.error("[PATCH /api/custom-actions/[id]] failed", err);
    return NextResponse.json({ error: msg || "bad_request" }, { status: 400 });
  }
};

export const DELETE = async (req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    // 派生 team action：删除转卸载语义
    if (isTeamActionId(id)) {
      const name = skillNameFromTeamActionId(id);
      if (!name) {
        return NextResponse.json({ error: "非法 team action id" }, { status: 400 });
      }
      const result = await uninstallTeamSkill(name);
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      return NextResponse.json({ ok: true });
    }

    // app: 派生：?withSkill=1 连 skill 目录删；默认只摘壳
    if (isAppActionId(id)) {
      const name = skillNameFromAppActionId(id);
      if (!name) {
        return NextResponse.json({ error: "非法 app action id" }, { status: 400 });
      }
      const withSkill =
        new URL(req.url).searchParams.get("withSkill") === "1";
      if (withSkill) {
        await removeAppSkillWithAction(name);
      } else {
        await removeActionShell(name);
      }
      return NextResponse.json({ ok: true });
    }

    // legacy / 旧目录 id
    await removeCustomAction(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/custom-actions/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
