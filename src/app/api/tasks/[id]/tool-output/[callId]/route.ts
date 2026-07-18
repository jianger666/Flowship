/**
 * GET /api/tasks/[id]/tool-output/[callId]
 *
 * 读 tool_result 截断后落盘的全量输出：data/tasks/<id>/tool-outputs/<callId>.txt
 * callId 消毒复用 sanitizeCallIdForPath（与落盘路径一致）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot } from "@/lib/server/data-root";
import { TOOL_OUTPUTS_DIR } from "@/lib/server/task-fs-core";
import { sanitizeCallIdForPath } from "@/lib/server/tool-result-persist";

interface Ctx {
  params: Promise<{ id: string; callId: string }>;
}

const errorJson = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const isSafeId = (id: string): boolean => /^[a-zA-Z0-9_-]+$/.test(id);

export const GET = async (_req: Request, { params }: Ctx) => {
  const { id, callId } = await params;
  if (!isSafeId(id)) return errorJson("非法 task id");
  // 空 / 非法 callId → 400（与落盘 sanitize 前校验对齐；避免走 call_unknown 误读）
  if (!callId || typeof callId !== "string" || !callId.trim()) {
    return errorJson("缺少 callId");
  }
  if (!isSafeId(callId)) return errorJson("非法 callId");

  const safeName = sanitizeCallIdForPath(callId);
  const absPath = path.join(
    dataRoot(),
    "tasks",
    id,
    TOOL_OUTPUTS_DIR,
    `${safeName}.txt`,
  );

  try {
    const text = await fs.readFile(absPath, "utf-8");
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        // 全量输出按 callId 唯一、可短缓存
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch {
    return errorJson("not_found", 404);
  }
};
