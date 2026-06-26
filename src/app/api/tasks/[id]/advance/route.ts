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
 *   actionType: ActionType,            // plan / build / review / ship / learn / dev
 *   userInstruction: string,           // 用户在推进 dialog 写的指令（可空）
 *   images?: [{data, mimeType, filename}],
 *   attachments?: string[],            // 文件 / 目录绝对路径（原生 picker 选的）
 *   apiKey: string,
 *   model: ModelSelection,
 *   reuseAgent?: boolean,              // UI「续用当前 agent」勾选时为 true（V0.6.27 默认每 action 新 agent）
 *   username?: string,                 // settings.username、拼 build branch 名用
 * }
 * ```
 *
 * # 行为分支（由 task-runner.advanceTask 内部决定）
 *
 * - reuseAgent 且有活 agent 在「待命态」 → submitNextAction 推 [NEXT_ACTION] 接力（不消耗 send 配额）
 * - 默认 / 没活 agent → Agent.create + send superPrompt（消耗 1 次 send 配额）
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

import {
  errorResponse,
  isValidModel,
  parseAndValidateImages,
} from "@/lib/server/route-helpers";
import {
  getTask,
  saveImageAttachments,
  setTaskRemoveSourceBranchOnMerge,
} from "@/lib/server/task-fs";
import { advanceTask } from "@/lib/server/task-runner";
import {
  ACTION_TYPES,
  type ActionType,
  type CheckOverride,
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
  username?: string;
  // V0.6.1 ship action 用：GitLab host + PAT、ship 准入校验 + agent 调 submit_mr 时用
  // 非 ship action 时为空字符串也 OK、不参与校验
  gitHost?: string;
  gitToken?: string;
  // V0.6.14 ship action 用：合并后是否删源分支（用户在推进 dialog 选、落 task 字段、submit_mr handler 读）
  removeSourceBranch?: boolean;
  // V0.6.23 build action 用：本次做哪些批次（advance-dialog 勾选、透传给 advanceTask）
  requestedBatchIds?: string[];
  // V0.x dev action 用：联调推送方式（direct 直推 / mr 提 PR、advance-dialog 选）
  devPushMode?: string;
  // V0.8.x plan action 用：重跑方案时的批次合并语义
  replanMode?: string;
  // V0.6.25 ship action 用：CheckRun gate override（最新 build check 没过/没配时、用户勾「仍继续」+ reason）
  // 结构由 parseCheckOverride narrow、server 端 checkShipCheckGate 再校验绑定有效性
  checkOverride?: unknown;
  // V0.x A 方案：client 随推进带来的设置页最新分支配置（per-repo）、server 据此刷新 task 分支快照
  repoBaseBranches?: Record<string, string>;
  repoTestBranches?: Record<string, string>;
  repoDevBranches?: Record<string, string>;
}

const MAX_IMAGES_PER_REQUEST = 6;
const MAX_ATTACHMENTS_PER_REQUEST = 10;

const isValidActionType = (v: unknown): v is ActionType =>
  typeof v === "string" && (ACTION_TYPES as readonly string[]).includes(v);

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

// V0.6.25：把 client 传的 checkOverride narrow 成 CheckOverride（语义有效性交给 server gate 校验）
const parseCheckOverride = (raw: unknown): CheckOverride | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.buildActionId !== "string" ||
    typeof o.checkRunId !== "string" ||
    typeof o.reason !== "string"
  ) {
    return undefined;
  }
  return {
    checkRunId: o.checkRunId,
    buildActionId: o.buildActionId,
    reason: o.reason,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
  };
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
      `actionType 非法、必须是 ${ACTION_TYPES.join(" / ")} 之一`,
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
      username: body.username?.trim() || undefined,
      gitHost: body.gitHost?.trim() || undefined,
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
      // V0.6.25：ship gate override（仅 ship 有意义、server checkShipCheckGate 校验绑定有效性）
      checkOverride: parseCheckOverride(body.checkOverride),
      // V0.x A 方案：client 带来的设置页最新分支配置、server 据此刷新 task 分支快照（设置页改了下次推进生效）
      repoBaseBranches: sanitizeRepoBranchMap(body.repoBaseBranches),
      repoTestBranches: sanitizeRepoBranchMap(body.repoTestBranches),
      repoDevBranches: sanitizeRepoBranchMap(body.repoDevBranches),
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
