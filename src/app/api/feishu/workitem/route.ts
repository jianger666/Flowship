/**
 * GET /api/feishu/workitem?id=<workItemId>&project=<projectKey>
 * GET /api/feishu/workitem?url=<飞书项目工作项 URL>
 *
 * 工作项详情（V0.14 预览页 + 任务详情融合用）：
 * - 传 id（+可选 project）直接查
 * - 传 url 先本地 decode 出 id 再查（任务详情页只存了 feishuStoryUrl、走这条）
 */

import { NextResponse } from "next/server";

import {
  decodeWorkitemUrl,
  fetchWorkitemDetail,
  MeegleError,
} from "@/lib/server/meegle-cli";

export const runtime = "nodejs";

export const GET = async (req: Request) => {
  const u = new URL(req.url);
  let id = u.searchParams.get("id")?.trim() || "";
  let project = u.searchParams.get("project")?.trim() || undefined;
  const rawUrl = u.searchParams.get("url")?.trim() || "";

  try {
    if (!id && rawUrl) {
      const decoded = await decodeWorkitemUrl(rawUrl);
      if (!decoded) {
        return NextResponse.json({ status: "not_workitem" });
      }
      id = decoded.workItemId;
      project ??= decoded.simpleName;
    }
    if (!id) {
      return NextResponse.json({ status: "error", message: "缺 id 或 url" }, { status: 400 });
    }
    const detail = await fetchWorkitemDetail(id, project);
    return NextResponse.json({ status: "ok", id, project, detail });
  } catch (err) {
    if (err instanceof MeegleError) {
      return NextResponse.json({ status: err.kind, message: err.message });
    }
    console.error("[GET /api/feishu/workitem] failed", err);
    return NextResponse.json(
      { status: "error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
};
