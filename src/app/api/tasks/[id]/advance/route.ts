/**
 * POST /api/tasks/[id]/advance
 *
 * V0.6 主推进入口：用户在 UI 选 action 类型 + 写指令、调本路由。
 *
 * 替代 V0.5 路由：start-workflow（首次启动 + restart + fork + resume 全部合并）
 *
 * # Body
 *
 * ```
 * {
 *   actionType: ActionType,            // plan / build / review / ship / test / learn
 *   userInstruction: string,           // 用户在推进 dialog 写的指令（可空）
 *   images?: [{data, mimeType, filename}],
 *   attachments?: string[],            // 文件 / 目录绝对路径（FsPickerDialog 选的）
 *   apiKey: string,
 *   model: ModelSelection,
 *   mcpServers?: Record<string, McpServerConfig>,
 *   forceNewAgent?: boolean,           // UI「换新 agent」勾选时为 true
 *   username?: string,                 // settings.username、拼 build branch 名用
 * }
 * ```
 *
 * # 行为分支（由 task-runner.advanceTask 内部决定）
 *
 * - 已有活 agent 在「待命态」 → submitNextAction 推 [NEXT_ACTION] 接力（不消耗 send 配额）
 * - 没活 agent / forceNewAgent → Agent.create + send superPrompt（消耗 1 次 send 配额）
 *
 * # 错误语义
 *
 * - task 不存在 → 404
 * - 准入条件不满足（如 build 但没 plan）→ 400
 * - 缺 apiKey / model / images 等 → 400
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import {
  errorResponse,
  isValidMcpServers,
  isValidModel,
  parseAndValidateImages,
} from "@/lib/server/route-helpers";
import { getTask, saveImageAttachments } from "@/lib/server/task-fs";
import { advanceTask } from "@/lib/server/task-runner";
import { ACTION_TYPES, type ActionType } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  actionType?: string;
  userInstruction?: string;
  images?: Array<{ data?: string; mimeType?: string; filename?: string }>;
  attachments?: string[];
  apiKey?: string;
  model?: ModelSelection;
  mcpServers?: Record<string, McpServerConfig>;
  forceNewAgent?: boolean;
  username?: string;
}

const MAX_IMAGES_PER_REQUEST = 6;
const MAX_ATTACHMENTS_PER_REQUEST = 10;

const isValidActionType = (v: unknown): v is ActionType =>
  typeof v === "string" && (ACTION_TYPES as readonly string[]).includes(v);

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const actionType = body.actionType;
  if (!isValidActionType(actionType)) {
    return errorResponse(
      `actionType 非法、必须是 ${ACTION_TYPES.join(" / ")} 之一`,
    );
  }
  const userInstruction = (body.userInstruction ?? "").trim();

  const apiKey = body.apiKey?.trim();
  if (!apiKey) return errorResponse("缺少 apiKey");
  if (!isValidModel(body.model)) return errorResponse("model 非法");
  if (!isValidMcpServers(body.mcpServers)) {
    return errorResponse("mcpServers 必须是对象（key=server名、value=配置）");
  }
  const model = body.model;
  const userMcpServers = body.mcpServers;

  // 校验 images
  const imagesResult = parseAndValidateImages(
    body.images,
    MAX_IMAGES_PER_REQUEST,
  );
  if (!imagesResult.ok) return imagesResult.errorResponse;
  const images = imagesResult.images;

  // 校验 attachments：绝对路径 + 存在
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (rawAttachments.length > MAX_ATTACHMENTS_PER_REQUEST) {
    return errorResponse(
      `单次最多附 ${MAX_ATTACHMENTS_PER_REQUEST} 条路径（你传了 ${rawAttachments.length}）`,
    );
  }
  const attachmentAbsPaths: string[] = [];
  for (const raw of rawAttachments) {
    if (typeof raw !== "string" || !raw.trim()) {
      return errorResponse("attachments 必须是非空字符串数组");
    }
    const abs = path.resolve(raw.trim());
    if (!path.isAbsolute(abs)) {
      return errorResponse(`attachments 必须是绝对路径：${raw}`);
    }
    try {
      await fs.stat(abs);
      attachmentAbsPaths.push(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return errorResponse(`attachments 路径不存在：${raw}`);
      }
      if (code === "EACCES") {
        return errorResponse(`attachments 无权限读取：${raw}`);
      }
      return errorResponse(`attachments stat 失败：${(err as Error).message}`);
    }
  }

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  // V0.6.0.1：chat 模式 task 不走 advance、应走 /chat-reply
  if (task.mode === "chat") {
    return errorResponse(
      "本任务是 chat 模式、应该用 /chat-reply、不要调 /advance",
      409,
    );
  }

  // 落盘图片（落任务目录 uploads/、拿绝对路径）
  let imageAbsPaths: string[] | undefined;
  if (images.length > 0) {
    try {
      const saved = await saveImageAttachments(task.id, images);
      imageAbsPaths = saved.map((s) => s.absPath);
    } catch (err) {
      return errorResponse(
        `图片处理失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    `[advance] task=${task.id} actionType=${actionType} forceNewAgent=${
      body.forceNewAgent ?? false
    } images=${imageAbsPaths?.length ?? 0} attachments=${attachmentAbsPaths.length}`,
  );

  try {
    const { action } = await advanceTask({
      task,
      actionType,
      userInstruction,
      attachedImagePaths: imageAbsPaths,
      attachedFilePaths:
        attachmentAbsPaths.length > 0 ? attachmentAbsPaths : undefined,
      apiKey,
      model,
      userMcpServers,
      forceNewAgent: body.forceNewAgent === true,
      username: body.username?.trim() || undefined,
    });

    // 重新读 task（advanceTask 内部已 publish、这里只为返最新 snapshot）
    const fresh = await getTask(task.id);
    return new Response(
      JSON.stringify({ ok: true, task: fresh ?? task, action }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[advance] task=${task.id} failed:`, err);
    return errorResponse(message, 400);
  }
};
