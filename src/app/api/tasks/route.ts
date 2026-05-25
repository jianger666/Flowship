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
import {
  WORKFLOWS,
  type NewTaskInput,
  type TaskRole,
  type WorkflowId,
} from "@/lib/types";

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

// V0.5.9：repoPaths 必须是非空 string 数组、否则视为无效
const sanitizeRepoPaths = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim());
};

// 把 body.workflowId 转成强类型 WorkflowId、不在白名单的丢弃
const sanitizeWorkflowId = (v: unknown): WorkflowId | undefined => {
  if (typeof v !== "string") return undefined;
  return (v in WORKFLOWS ? v : undefined) as WorkflowId | undefined;
};

// V0.4：角色字段、当前只允许 "fe"。未来扩 enum 时这里加白名单
const sanitizeRole = (v: unknown): TaskRole | undefined => {
  if (v === "fe") return "fe";
  return undefined;
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
    // mode 校验：只接受 chat / plan、其他值都拒；不传时 createTask 会默认 plan（V0.2 起）
    const mode =
      body.mode === "chat" || body.mode === "plan" ? body.mode : undefined;
    // V0.5.9：repoPaths 数组替代 repoPath、plan 模式至少 1 个、chat 模式可空（task-fs 兜底 home）
    const repoPaths = sanitizeRepoPaths(body.repoPaths);
    if (mode !== "chat") {
      if (!isNonEmptyString(body.title) || repoPaths.length === 0) {
        return NextResponse.json(
          { error: "plan 模式 title 和 repoPaths 必填（至少 1 个仓库）" },
          { status: 400 },
        );
      }
    }
    const workflowId = sanitizeWorkflowId(body.workflowId);
    const task = await createTask({
      // 不强行 trim：task-fs.createTask 内部会判空并按 mode 兜底（chat 给占位标题、用户 home）
      title: isNonEmptyString(body.title) ? body.title.trim() : "",
      repoPaths,
      mode,
      workflowId,
      role: sanitizeRole(body.role),
      feishuStoryUrl: isNonEmptyString(body.feishuStoryUrl)
        ? body.feishuStoryUrl.trim()
        : undefined,
      description: isNonEmptyString(body.description)
        ? body.description.trim()
        : undefined,
      // V0.5.3：swaggerUrl / attachedDocs 字段已删（被 contextDocs 取代）、不再接收
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
