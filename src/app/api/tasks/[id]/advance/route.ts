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
 *   actionType: ActionType,            // plan / build / review / ship / dev / custom
 *   userInstruction: string,           // 用户在推进 dialog 写的指令（可空）
 *   images?: [{data, mimeType, filename}],
 *   attachments?: string[],            // 文件 / 目录绝对路径（原生 picker 选的）
 *   apiKey: string,
 *   model: ModelSelection,
 *   reuseAgent?: boolean,              // UI「续用当前 agent」勾选时为 true（V0.6.27 默认每 action 新 agent）
 * }
 * ```
 *
 * # 行为分支（由 task-runner.advanceTask 内部决定）
 *
 * - reuseAgent 且有存活会话 → `agent.send([NEXT_ACTION ...])` 续同一会话（V0.11）
 * - 默认 / 没会话 → Agent.create + send superPrompt（fresh agent 冷启动）
 *
 * # 错误语义
 *
 * - task 不存在 → 404
 * - 准入条件不满足（如 build 但没 plan）→ 400
 * - 缺 apiKey / model / images 等 → 400
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModelSelection } from "@cursor/sdk";

import { isAbsolutePathLike } from "@/lib/path-utils";
import {
  errorResponse,
  isValidModel,
  parseAndValidateImages,
} from "@/lib/server/route-helpers";
import {
  getTask,
  setTaskRemoveSourceBranchOnMerge,
} from "@/lib/server/task-fs";
import { saveImageAttachments } from "@/lib/server/task-artifacts";
import { advanceTask } from "@/lib/server/task-runner";
import { getCustomAction } from "@/lib/server/custom-action-fs";
import { getChatLifecycle } from "@/lib/server/chat-gate";
import { getTaskOpGeneration } from "@/lib/server/task-stream";
import {
  ACTION_TYPES,
  type ActionType,
  type DevPushMode,
  type ReplanMode,
} from "@/lib/types";

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
  reuseAgent?: boolean;
  // V0.6.1 ship action 用：GitLab PAT、ship 准入校验 + agent 调 submit_mr 时用
  // Host 不由 client 传——server 按任务仓库 remote 现推
  // 非 ship action 时为空字符串也 OK、不参与校验
  gitToken?: string;
  // V0.6.14 ship action 用：合并后是否删源分支（用户在推进 dialog 选、落 task 字段、submit_mr handler 读）
  removeSourceBranch?: boolean;
  // V0.6.23 build action 用：本次做哪些批次（advance-dialog 勾选、透传给 advanceTask）
  requestedBatchIds?: string[];
  // V0.x dev action 用：联调推送方式（direct 直推 / mr 提 PR、advance-dialog 选）
  devPushMode?: string;
  // V0.8.x plan action 用：重跑方案时的批次合并语义
  replanMode?: string;
  // V0.x A 方案：client 随推进带来的设置页最新分支配置（per-repo）、server 据此刷新 task 分支快照
  repoBaseBranches?: Record<string, string>;
  repoTestBranches?: Record<string, string>;
  repoDevBranches?: Record<string, string>;
  // V0.9：自定义 action 指向的定义 id（仅 actionType="custom" 时必填）
  customActionId?: string;
}

const MAX_IMAGES_PER_REQUEST = 6;
const MAX_ATTACHMENTS_PER_REQUEST = 10;

const isValidActionType = (v: unknown): v is ActionType =>
  typeof v === "string" &&
  ((ACTION_TYPES as readonly string[]).includes(v) || v === "custom");

const parseReplanMode = (v: unknown): ReplanMode | undefined =>
  v === "append" || v === "rebuild" ? v : undefined;

const parseDevPushMode = (v: unknown): DevPushMode | undefined =>
  v === "direct" || v === "mr" ? v : undefined;

// V0.x A 方案：per-repo 分支配置 map 粗清洗（object + value trim 非空、空 map 归 undefined）
const sanitizeRepoBranchMap = (
  v: unknown,
): Record<string, string> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" && val.trim()) out[k] = val.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

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
      `actionType 非法、必须是 ${ACTION_TYPES.join(" / ")} / custom 之一`,
    );
  }
  const userInstruction = (body.userInstruction ?? "").trim();

  const apiKey = body.apiKey?.trim();
  if (!apiKey) return errorResponse("缺少 apiKey");
  if (!isValidModel(body.model)) return errorResponse("model 非法");
  const model = body.model;

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
    // 必须对原始字符串判绝对路径：path.resolve 后再 isAbsolute 恒为 true，相对路径会被静默接受
    const trimmed = raw.trim();
    if (!isAbsolutePathLike(trimmed)) {
      return errorResponse(`attachments 必须是绝对路径：${raw}`);
    }
    const abs = path.resolve(trimmed);
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

  // V0.9：自定义 action 必须带存在的定义 id（定义可能被删——这里挡住、不让起一个找不到 playbook 的 agent）
  let customActionId: string | undefined;
  if (actionType === "custom") {
    customActionId = body.customActionId?.trim();
    if (!customActionId) {
      return errorResponse("自定义 action 必须带 customActionId");
    }
    const def = await getCustomAction(customActionId);
    if (!def) {
      return errorResponse(`自定义 action 定义不存在：${customActionId}`, 404);
    }
    // 旧格式已停用（推进弹窗已滤掉、这里挡直连 API）
    if (def.legacyPlaybook) {
      return errorResponse(
        `自定义 action「${def.label}」是旧格式、已停用——请在能力页重建`,
      );
    }
  }

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  // U1 / R24-5a：lifecycle 非 null（stopping/deleting/finalizing）一律拒推进
  {
    const life = getChatLifecycle(id);
    if (life !== null) {
      const msg =
        life === "deleting"
          ? "任务正在删除"
          : life === "finalizing"
            ? "正在终结、请稍后再试"
            : "正在停止、请稍后再试";
      return errorResponse(msg, 409);
    }
  }

  // W2：lifecycle 闸后立刻同步取 admission——其后有落分支偏好 / 存图等 await
  const opGen = getTaskOpGeneration(task.id);

  // V0.6.0.1：chat 模式 task 不走 advance、应走 /chat-reply
  if (task.mode === "chat") {
    return errorResponse(
      "本任务是 chat 模式、应该用 /chat-reply、不要调 /advance",
      409,
    );
  }

  // V0.6.14：ship 推进带「合并后是否删源分支」选择 → 先落 task 字段、
  // 之后 agent 调 submit_mr 时 handler 读 fresh task 拿到（advanceTask 内部不需要这字段）
  if (typeof body.removeSourceBranch === "boolean") {
    await setTaskRemoveSourceBranchOnMerge(task.id, body.removeSourceBranch);
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
    `[advance] task=${task.id} actionType=${actionType} reuseAgent=${
      body.reuseAgent ?? false
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
      reuseAgent: body.reuseAgent === true,
      gitToken: body.gitToken?.trim() || undefined,
      // V0.6.23：build 分批选择（仅 build 有意义、advanceTask 内部按 actionType 取用）
      requestedBatchIds: Array.isArray(body.requestedBatchIds)
        ? body.requestedBatchIds.filter((x) => typeof x === "string")
        : undefined,
      replanMode: actionType === "plan" ? parseReplanMode(body.replanMode) : undefined,
      // V0.x：联调推送方式（仅 dev 有意义、缺省 direct——advanceTask/appendAction 内部也按 type 过滤）
      devPushMode:
        actionType === "dev"
          ? (parseDevPushMode(body.devPushMode) ?? "direct")
          : undefined,
      // V0.x A 方案：client 带来的设置页最新分支配置、server 据此刷新 task 分支快照（设置页改了下次推进生效）
      repoBaseBranches: sanitizeRepoBranchMap(body.repoBaseBranches),
      repoTestBranches: sanitizeRepoBranchMap(body.repoTestBranches),
      repoDevBranches: sanitizeRepoBranchMap(body.repoDevBranches),
      // V0.9：自定义 action 定义 id（仅 custom、上面已校验定义存在）
      customActionId,
      opGen,
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
