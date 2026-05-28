/**
 * /api/tasks
 *
 *   GET  → 任务列表
 *   POST → 创建任务（body: NewTaskInput）
 *
 * V0.6.0.1 改造：
 *   - 重新引入 mode（"task" | "chat"、对齐 V0.5 概念）
 *   - mode="task"：正经 feature task、title / repoPaths / feishuStoryUrl 三必填
 *   - mode="chat"：自由对话、title / repoPaths / feishuStoryUrl 全选填（title 缺省自动补「未命名对话 MM-DD HH:mm」）
 *
 * 路由只做 IO + 校验、状态推进 / 业务规则归 task-fs.ts。
 */

import { NextResponse } from "next/server";
import { createTask, listTasks } from "@/lib/server/task-fs";
import type { NewTaskInput, TaskMode, TaskRole } from "@/lib/types";

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const sanitizeRepoPaths = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim());
};

const sanitizeRole = (v: unknown): TaskRole | undefined => {
  if (v === "fe") return "fe";
  return undefined;
};

const sanitizeMode = (v: unknown): TaskMode => {
  return v === "chat" ? "chat" : "task";
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

    const mode = sanitizeMode(body.mode);
    const isChat = mode === "chat";

    // chat 模式三选填、其他模式三必填
    if (!isChat) {
      if (!isNonEmptyString(body.title)) {
        return NextResponse.json({ error: "title 必填" }, { status: 400 });
      }
      if (!isNonEmptyString(body.feishuStoryUrl)) {
        return NextResponse.json(
          { error: "feishuStoryUrl 必填" },
          { status: 400 },
        );
      }
    }

    const repoPaths = sanitizeRepoPaths(body.repoPaths);
    if (!isChat && repoPaths.length === 0) {
      return NextResponse.json(
        { error: "repoPaths 至少 1 个仓库" },
        { status: 400 },
      );
    }

    // chat 模式未填 title 时自动生成「未命名对话 MM-DD HH:mm」
    const title = isNonEmptyString(body.title)
      ? body.title.trim()
      : isChat
        ? `未命名对话 ${new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`
        : "";

    const task = await createTask({
      title,
      repoPaths,
      role: sanitizeRole(body.role),
      mode,
      feishuStoryUrl: isNonEmptyString(body.feishuStoryUrl)
        ? body.feishuStoryUrl.trim()
        : undefined,
      disabledMcpServers:
        Array.isArray(body.disabledMcpServers) &&
        body.disabledMcpServers.every((s) => typeof s === "string")
          ? body.disabledMcpServers
          : undefined,
      model: body.model,
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/tasks] failed", err);
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }
};
