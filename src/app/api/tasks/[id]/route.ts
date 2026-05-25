/**
 * /api/tasks/[id]
 *
 *   GET    → 单任务详情（含 events + 各 phase artifact）
 *   PATCH  → 元数据修改（V1 仅支持 archived 字段、不写事件、不改 updatedAt）
 *   DELETE → 删除任务（连带 data/tasks/<id>/ 整个文件夹）
 *
 * Next.js 15 的 dynamic route params 是 Promise、要 await
 * (https://nextjs.org/docs/app/api-reference/file-conventions/route)
 */

import { NextResponse } from "next/server";
import {
  deleteTask,
  getTask,
  setTaskArchived,
  setTaskDisabledMcpServers,
  setTaskUiLayout,
} from "@/lib/server/task-fs";
import { cancelChat } from "@/lib/server/chat-runner";
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
    // 拼写错误 / 路径穿越会进 catch、当 400 处理（task-fs 抛 Error）
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};

// PATCH 支持的字段（当次只改一个、保持 API 简单）：
//   - archived: boolean —— 软删除归档
//   - disabledMcpServers: string[] | null —— 任务级 MCP 黑名单、null/空 = 全开
//   - uiLayout: { artifactPanelSize?: number } | null —— V0.5.10 加、resizable 分栏比例持久化
//     不返完整 task（拖动期间高频 PATCH、前端有自己的 state、不需要 round-trip 拿全量）
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
      // null 或空数组都视为「清空黑名单 = 全开」、值规范化在 server 内做
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
      // null = 清空回默认；object 时校验 artifactPanelSize 是数字
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
    // 先停 chat 任务（agent run + pending wait）、再删文件
    // 顺序很关键：删了文件 agent 还在跑会写不到 events.jsonl 报错
    cancelChat(id);
    cleanupChatTaskState(id);
    const ok = await deleteTask(id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/tasks/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
