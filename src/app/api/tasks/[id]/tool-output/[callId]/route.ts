/**
 * GET /api/tasks/[id]/tool-output/[callId]
 *
 * 读 tool_result 截断后落盘的全量输出：data/tasks/<id>/tool-outputs/<callId>.txt
 * callId 消毒复用 sanitizeCallIdForPath（与落盘路径一致）。
 *
 * 注意：SDK 子代理（name=task）的 callId 常含换行（`call-…-N\nfc_…`）；
 * 落盘时已把非法字符换成 `_`。此处必须先 sanitize 再校验——若对原始 callId
 * 跑 `/^[a-zA-Z0-9_-]+$/` 会误 400，前端点「加载完整输出」必失败。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot } from "@/lib/server/data-root";
import { TOOL_OUTPUTS_DIR } from "@/lib/server/task-fs-core";
import {
  redactToolOutputText,
  sanitizeCallIdForPath,
} from "@/lib/server/tool-result-persist";

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
  if (!callId || typeof callId !== "string" || !callId.trim()) {
    return errorJson("缺少 callId");
  }

  // 与落盘同款消毒；消毒后的文件名才做安全字符校验（防路径穿越）
  const safeName = sanitizeCallIdForPath(callId);
  if (!isSafeId(safeName)) return errorJson("非法 callId");

  const absPath = path.join(
    dataRoot(),
    "tasks",
    id,
    TOOL_OUTPUTS_DIR,
    `${safeName}.txt`,
  );

  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf-8");
  } catch {
    return errorJson("not_found", 404);
  }
  // 读出来再脱敏一次：写盘端（tool-result-persist）已脱敏，这里兜住改动前落盘、尚未被启动期迁移处理的老文件
  // （当时是原始 stdout 明文）与「写盘后才轮换 / 新增的凭据」。纯文本精确值替换、线性扫描、有输入上限
  // （超大文件只回头尾脱敏窗口 + 提示，见 redactToolOutputText），没配凭据 / 没命中时原样返回，不动换行与行数。
  // 脱敏抛错 = fail-closed：回 500、绝不把读到的原文发出去（也不当成 404——文件在，只是不能安全展示）。
  let text: string;
  try {
    text = redactToolOutputText(raw);
  } catch (err) {
    console.warn(
      `[tool-output] 读时脱敏失败、未返回内容 task=${id} err=${err instanceof Error ? err.name : typeof err}`,
    );
    return errorJson("redact_failed", 500);
  }
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // 全量输出按 callId 唯一、可短缓存
      "Cache-Control": "private, max-age=60",
    },
  });
};
