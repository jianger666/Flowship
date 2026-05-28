/**
 * /api/tasks/[id]
 *
 *   GET    → 单任务详情（含 events + 各 action artifact）
 *   PATCH  → 元数据修改（archived / disabledMcpServers / uiLayout）
 *   DELETE → 删除任务（连带 data/tasks/<id>/ 整个文件夹）
 *
 * V0.6 改造：cancelChat → cancelTaskRun（task-runner）
 *
 * Next.js 15 的 dynamic route params 是 Promise、要 await
 */

import { NextResponse } from "next/server";
import {
  deleteTask,
  getTask,
  setTaskArchived,
  setTaskDisabledMcpServers,
  setTaskUiLayout,
} from "@/lib/server/task-fs";
import { cancelTaskRun } from "@/lib/server/task-runner";
import { cleanupChatTaskState } from "@/lib/server/chat-mcp";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = async (_req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const task = await getTask(id);
    if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ task });
  } catch (err) {
    console.error("[GET /api/tasks/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};

export const PATCH = async (req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const body = (await req.json()) as {
      archived?: boolean;
      disabledMcpServers?: string[] | null;
      uiLayout?: { artifactPanelSize?: number } | null;
    };

    if (typeof body.archived === "boolean") {
      const task = await setTaskArchived(id, body.archived);
      if (!task)
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ task });
    }

    if ("disabledMcpServers" in body) {
      const value = body.disabledMcpServers;
      if (
        value !== null &&
        !(Array.isArray(value) && value.every((s) => typeof s === "string"))
      ) {
        return NextResponse.json(
          { error: "disabledMcpServers 必须是字符串数组或 null" },
          { status: 400 },
        );
      }
      const task = await setTaskDisabledMcpServers(
        id,
        value === null ? undefined : value,
      );
      if (!task)
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ task });
    }

    if ("uiLayout" in body) {
      const value = body.uiLayout;
      if (value === null) {
        await setTaskUiLayout(id, undefined);
        return NextResponse.json({ ok: true });
      }
      if (
        typeof value !== "object" ||
        (value.artifactPanelSize !== undefined &&
          typeof value.artifactPanelSize !== "number")
      ) {
        return NextResponse.json(
          { error: "uiLayout.artifactPanelSize 必须是数字或 undefined" },
          { status: 400 },
        );
      }
      await setTaskUiLayout(id, value);
      // 不返完整 task：高频拖动期间 round-trip 全量没必要、前端 state 已经是源头
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json(
      { error: "需要 archived / disabledMcpServers / uiLayout 中的一个字段" },
      { status: 400 },
    );
  } catch (err) {
    console.error("[PATCH /api/tasks/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};

export const DELETE = async (_req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    // 先停 task agent + 清 pending、再删文件
    // 顺序很关键：删了文件 agent 还在跑会写不到 events.jsonl 报错
    cancelTaskRun(id);
    cleanupChatTaskState(id);
    const ok = await deleteTask(id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/tasks/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
