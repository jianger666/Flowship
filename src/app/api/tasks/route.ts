/**
 * /api/tasks
 *
 *   GET  → 任务列表
 *   POST → 创建任务（body: NewTaskInput）
 *
 * 这两个路由只做 IO + 校验、状态推进 / 业务规则归 task-fs.ts。
 * 错误统一走 4xx / 500 + JSON 报错、不暴露 stack（生产里看不到）。
 */

import { NextResponse } from "next/server";
import { createTask, listTasks } from "@/lib/server/task-fs";
import { WORKFLOWS, type NewTaskInput, type WorkflowId } from "@/lib/types";

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

// 把 body.workflowId 转成强类型 WorkflowId、不在白名单的丢弃
const sanitizeWorkflowId = (v: unknown): WorkflowId | undefined => {
  if (typeof v !== "string") return undefined;
  return (v in WORKFLOWS ? v : undefined) as WorkflowId | undefined;
};

export const GET = async () => {
  try {
    const tasks = await listTasks();
    return NextResponse.json({ tasks });
  } catch (err) {
    console.error("[GET /api/tasks] failed", err);
    return NextResponse.json({ error: "list_failed" }, { status: 500 });
  }
};

export const POST = async (req: Request) => {
  try {
    const body = (await req.json()) as Partial<NewTaskInput>;
    if (!isNonEmptyString(body.title) || !isNonEmptyString(body.repoPath)) {
      return NextResponse.json(
        { error: "title 和 repoPath 必填" },
        { status: 400 },
      );
    }
    // mode 校验：只接受 chat / plan、其他值都拒；不传时 createTask 会默认 plan（V0.2 起）
    const mode =
      body.mode === "chat" || body.mode === "plan" ? body.mode : undefined;
    const workflowId = sanitizeWorkflowId(body.workflowId);
    const task = await createTask({
      title: body.title.trim(),
      repoPath: body.repoPath.trim(),
      mode,
      workflowId,
      feishuStoryUrl: isNonEmptyString(body.feishuStoryUrl)
        ? body.feishuStoryUrl.trim()
        : undefined,
      feishuUrl: isNonEmptyString(body.feishuUrl)
        ? body.feishuUrl.trim()
        : undefined,
      swaggerUrl: isNonEmptyString(body.swaggerUrl)
        ? body.swaggerUrl.trim()
        : undefined,
      description: isNonEmptyString(body.description)
        ? body.description.trim()
        : undefined,
      attachedDocs:
        Array.isArray(body.attachedDocs) &&
        body.attachedDocs.every((s) => isNonEmptyString(s))
          ? (body.attachedDocs as string[]).map((s) => s.trim())
          : undefined,
      // V0.3.3：任务级 MCP 黑名单（创建时指定）
      // 只接受 string[] 类型、其它值丢弃（后端 createTask 兜底处理空数组）
      disabledMcpServers:
        Array.isArray(body.disabledMcpServers) &&
        body.disabledMcpServers.every((s) => typeof s === "string")
          ? body.disabledMcpServers
          : undefined,
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/tasks] failed", err);
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }
};
