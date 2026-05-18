/**
 * POST /api/tasks/[id]/chat-reply
 *
 * Body: {
 *   text?: string;
 *   images?: Array<{...}>;
 *   attachments?: string[];
 *   // V0.4 chat 自由化：task 处于 draft / completed / failed 时
 *   // 用户发消息会同时触发「自动启 agent」、需要 SDK 启动参数
 *   bootArgs?: { apiKey, model, mcpServers }
 * }
 *
 * 路由职责（两种模式）：
 *
 * 1. **awaiting_user + hasPending=true**（正常对话循环）：
 *    - 写 user_reply 事件
 *    - submitUserMessage（resolve wait_for_user）
 *    - patch task.status=running
 *
 * 2. **chat 模式 + draft/completed/failed + 无 pending**（V0.4 自动启动）：
 *    - 写 user_reply 事件（用户立刻看到自己的话）
 *    - patch task.status=running
 *    - fire-and-forget runChatSession（带 firstMessage）启 agent
 *    - agent 起手 prompt 已包含用户首条、直接回答、回答完调 wait_for_user 进等待
 *    - 用户感觉「发一条 = 启动 + 回答一气呵成」、无需手动启动按钮
 *    - 不走 pendingFirstMessage 队列：避免 agent 起手 wait_for_user 时短暂切 awaiting_user
 *      误导 UI、也避免 agent emit「正在调用 wait_for_user 等你」之类协议元叙述
 *
 * 失败情况：
 *   - task 不存在 → 404
 *   - task.mode !== "chat" → 409
 *   - 模式 2 但缺 bootArgs → 400
 *   - hasPending=false 且 task.status 还在 awaiting_user/running → 410（僵尸态、当场标 failed）
 *
 * 进程重启 / agent 崩溃后的体验：
 *   - getTask 顶部已 await ensureBootRecovery、绝大多数僵尸任务在用户首次访问时就被标 failed
 *   - 但极小概率：用户访问页面 → SSE 连上 → 发消息全在 boot recovery 完成之前
 *     兜底：本路由检测 hasPending=false 且 status=awaiting_user/running → 当场补一次「僵尸标记」
 *   - status=draft/completed/failed 在 V0.4 起不再 409、改为「自动启动」逻辑（如果 bootArgs 齐）
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import {
  appendEvent,
  getTask,
  patchPhase,
  saveImageAttachments,
  type ImageAttachmentInput,
} from "@/lib/server/task-fs";
import {
  hasPending,
  submitUserMessage,
} from "@/lib/server/chat-mcp";
import { isChatRunning, publishChatStreamEvent, runChatSession } from "@/lib/server/chat-runner";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  text?: string;
  // 用户上传的图片附件、纯 base64（不带 data: 前缀）
  // 后端会 1. 校验 mimeType 白名单 + 单图 size 上限 2. 落盘到 data/tasks/<id>/uploads/<uuid>.<ext>
  // 3. 把绝对路径塞给 wait_for_user return、agent 用 SDK 内置 read_file 读看图
  images?: Array<{
    data?: string;
    mimeType?: string;
    filename?: string;
  }>;
  // 用户附加的文件 / 目录绝对路径（FsPickerDialog 选的、纯路径不传内容）
  // 后端会 1. 校验路径必须绝对 + 存在 2. 写 user_reply.meta.attachments
  // 3. 把路径塞给 wait_for_user return（[ATTACHED_PATHS] 段）、agent 用 read_file / grep / glob 自己读
  attachments?: string[];
  // V0.4 chat 自由化：当 task 处于 draft / completed / failed 状态时
  // 用户发消息要同时启动 agent、需要 SDK 启动参数
  // 状态 = awaiting_user 时这个字段可以省略（agent 已在跑、不需要启动）
  bootArgs?: {
    apiKey?: string;
    model?: ModelSelection;
    mcpServers?: Record<string, McpServerConfig>;
  };
}

// 整批上传 size 上限（防一次发 N 张超大图把服务端 / agent context 撑爆）
// 单图 ≤ 10MB 由 task-fs.ts 内部强制
const MAX_TOTAL_UPLOAD_BYTES = 30 * 1024 * 1024;
// 单次最多附图数（防滥用）
const MAX_IMAGES_PER_REPLY = 6;
// 单次最多附路径数（防 agent context 被路径列表刷爆）
// 跟前端 event-stream.tsx 的 MAX_ATTACHMENTS_PER_REPLY 保持一致
const MAX_ATTACHMENTS_PER_REPLY = 10;

const errorResponse = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// V0.4 自动启动：终态发消息时需要 bootArgs（apiKey + model + 可选 mcpServers）
// 校验 helper 直接搬自原 start-chat 路由（已删）
const isValidModel = (m: unknown): m is ModelSelection => {
  if (!m || typeof m !== "object") return false;
  const x = m as Partial<ModelSelection>;
  return typeof x.id === "string" && x.id.length > 0;
};

const isValidMcpServers = (
  v: unknown,
): v is Record<string, McpServerConfig> => {
  if (v == null) return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every(
    (cfg) => cfg != null && typeof cfg === "object",
  );
};

export const runtime = "nodejs";

// "几十毫秒空窗"兜底：hasPending 第一次为 false 时、稍等再查一次
//
// V0.3.5 起保活机制改成 shell + curl long-poll、entry 一旦 registerPendingEntry
// 就一直在 pendingMap 里（直到 finalizeEntry resolve）。理论上没有 V0.3.5 之前
// 的「50s timer fire → resolve → 重新调 wait_for_user」中间空窗。
//
// 仍保留 retry 作防御：极少数 race 场景下（用户连答两次 / agent 主动顶替旧 wait
// → grace cleanup 期 + 新 wait_for_user 还没到达）hasPending 可能瞬时 false。
// 200ms 给的余量足够、命中代价仅 200ms 延迟、保留更稳。
const KEEPALIVE_RACE_RETRY_MS = 200;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const text = body.text?.trim() ?? "";
  // 校验 images 入参格式（不校验内容、内容校验放 saveImageAttachments 里抛错）
  const rawImages = Array.isArray(body.images) ? body.images : [];
  if (rawImages.length > MAX_IMAGES_PER_REPLY) {
    return errorResponse(
      `单次最多附 ${MAX_IMAGES_PER_REPLY} 张图（你传了 ${rawImages.length}）`,
    );
  }
  const images: ImageAttachmentInput[] = [];
  let totalBytes = 0;
  for (const img of rawImages) {
    if (typeof img?.data !== "string" || !img.data.trim()) {
      return errorResponse("images[].data 必须是非空 base64 字符串");
    }
    if (typeof img.mimeType !== "string" || !img.mimeType.trim()) {
      return errorResponse("images[].mimeType 必填");
    }
    // 粗略估算 base64 → bytes（实际字节数 ≈ b64长度 * 3 / 4 - padding）
    // 校验在这里只为快速过滤超大、最终 size check 在 saveImageAttachments 里走真字节
    totalBytes += Math.floor((img.data.length * 3) / 4);
    images.push({
      data: img.data,
      mimeType: img.mimeType,
      filename:
        typeof img.filename === "string" && img.filename.trim()
          ? img.filename.trim()
          : undefined,
    });
  }
  if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
    return errorResponse(
      `本次上传图片总大小约 ${(totalBytes / 1024 / 1024).toFixed(2)} MB、超过上限 ${MAX_TOTAL_UPLOAD_BYTES / 1024 / 1024} MB`,
    );
  }

  // 校验 attachments：必须绝对路径、必须存在
  // 不校验类型（文件 / 目录都能附）、不读内容、只 stat 一下
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (rawAttachments.length > MAX_ATTACHMENTS_PER_REPLY) {
    return errorResponse(
      `单次最多附 ${MAX_ATTACHMENTS_PER_REPLY} 条路径（你传了 ${rawAttachments.length}）`,
    );
  }
  const attachments: Array<{ absPath: string; isDir: boolean; bytes?: number }> = [];
  for (const raw of rawAttachments) {
    if (typeof raw !== "string" || !raw.trim()) {
      return errorResponse("attachments 必须是非空字符串数组");
    }
    const abs = path.resolve(raw.trim());
    if (!path.isAbsolute(abs)) {
      return errorResponse(`attachments 必须是绝对路径：${raw}`);
    }
    try {
      const stat = await fs.stat(abs);
      attachments.push({
        absPath: abs,
        isDir: stat.isDirectory(),
        bytes: stat.isDirectory() ? undefined : stat.size,
      });
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

  // 文本 / 图 / 路径至少有一个、纯空消息不让发
  if (!text && images.length === 0 && attachments.length === 0) {
    return errorResponse("text / images / attachments 至少给一个");
  }

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);
  if (task.mode !== "chat") {
    return errorResponse(`任务 mode=${task.mode}、chat-reply 不适用`, 409);
  }

  // V0.4 chat 自由化：根据 task.status 判断走哪条链路
  // - awaiting_user / running：原 hasPending 链路（正常对话回合 / 僵尸态兜底）
  // - draft / completed / failed：自动启动链路（启 agent + 投递首条）
  // - 其他（不应出现）：报错
  const shouldAutoStart =
    task.status === "draft" ||
    task.status === "completed" ||
    task.status === "failed";

  // 自动启动分支：先校验 bootArgs、其他错都先 fail-fast、避免后面落盘了又退
  let autoStartConfig:
    | { apiKey: string; model: ModelSelection; userMcpServers?: Record<string, McpServerConfig> }
    | null = null;
  if (shouldAutoStart) {
    const apiKey = body.bootArgs?.apiKey?.trim();
    if (!apiKey) {
      return errorResponse(
        `task.status=${task.status}、自动启动需要 bootArgs.apiKey`,
        400,
      );
    }
    if (!isValidModel(body.bootArgs?.model)) {
      return errorResponse("bootArgs.model 非法（缺少 id 字段）");
    }
    if (!isValidMcpServers(body.bootArgs?.mcpServers)) {
      return errorResponse(
        "bootArgs.mcpServers 必须是对象（key=server名、value=配置）",
      );
    }
    if (isChatRunning(task.id)) {
      // 终态但还有残留 run：通常不会发生（chat-runner finally 块会把 running 清掉）
      // 兜底防止重复 spawn agent
      console.warn(
        `[chat-reply] task=${task.id} status=${task.status} 但 isChatRunning=true、忽略本次自动启动请求`,
      );
      return errorResponse(
        "agent 启动状态异常（status 是终态但 run 在跑）、稍后重试",
        409,
      );
    }
    autoStartConfig = {
      apiKey,
      model: body.bootArgs.model,
      userMcpServers: body.bootArgs.mcpServers,
    };
  } else {
    // 非自动启动分支：走 hasPending 检测 + 200ms race retry（详见上方常量注释）
    let pending = hasPending(task.id);
    if (!pending) {
      await sleep(KEEPALIVE_RACE_RETRY_MS);
      pending = hasPending(task.id);
    }
    if (!pending) {
      // 真没 pending、又不在终态 → 一定是僵尸态
      // 当场补一次"僵尸标记"、UI 拿到 failed 会展示「重新启动 Chat」按钮
      console.warn(
        `[chat-reply] task=${task.id} 僵尸态 status=${task.status} hasPending=false、当场标 failed`,
      );
      const errorTask = await appendEvent(task.id, {
        kind: "error",
        text: "Chat agent 已断开（进程重启或异常退出）、本段对话不能继续。再发一条消息会自动开启新一段会话。",
      });
      if (errorTask) {
        const lastEvent = errorTask.events[errorTask.events.length - 1];
        if (lastEvent) {
          publishChatStreamEvent(task.id, { kind: "event", event: lastEvent });
        }
      }
      const failedTask = await patchPhase(task.id, { taskStatus: "failed" });
      if (failedTask) {
        publishChatStreamEvent(task.id, { kind: "task", task: failedTask });
        publishChatStreamEvent(task.id, {
          kind: "done",
          task: failedTask,
          ok: false,
        });
      }
      return errorResponse(
        "agent 已断开、再发一条消息会自动开启新一段会话",
        410,
      );
    }
  }

  console.log(
    `[chat-reply] task=${task.id} status=${task.status} autoStart=${shouldAutoStart} text=${text.slice(0, 60)} images=${images.length} attachments=${attachments.length}`,
  );

  // 0) 落盘图片（如果有）、拿绝对路径数组
  // 失败：mimeType 不白名单 / size 超 / base64 损坏 → 400
  let savedImages: Awaited<ReturnType<typeof saveImageAttachments>> = [];
  if (images.length > 0) {
    try {
      savedImages = await saveImageAttachments(task.id, images);
    } catch (err) {
      return errorResponse(
        `图片处理失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 1) 先写 user_reply 事件（用户视角先看到自己的话进了事件流）
  // meta.images 存图片元信息：absPath（agent 用）/ relPath / mimeType / bytes / filename
  // meta.attachments 存文件 / 目录元信息：absPath（agent 读用）/ isDir / bytes
  // UI 读 meta.images / meta.attachments 渲染气泡下方的缩略图 / 路径 chip
  const metaParts: Record<string, unknown> = {};
  if (savedImages.length > 0) {
    metaParts.images = savedImages.map((s) => ({
      absPath: s.absPath,
      relPath: s.relPath,
      mimeType: s.mimeType,
      bytes: s.bytes,
      filename: s.filename,
    }));
  }
  if (attachments.length > 0) {
    metaParts.attachments = attachments;
  }
  // 文本回退优先级：text > 「(用户附了文件)」 > 「(用户附了图片)」
  // 让事件流摘要更精确
  const fallbackText =
    attachments.length > 0
      ? "(用户附了文件)"
      : savedImages.length > 0
        ? "(用户附了图片)"
        : "";
  const updatedAfterEvent = await appendEvent(task.id, {
    kind: "user_reply",
    text: text || fallbackText,
    meta: Object.keys(metaParts).length > 0 ? metaParts : undefined,
  });
  // 主动 publish user_reply：让 SSE 订阅者立刻看到用户消息
  // （chat-reply 路由跟 chat-runner 不在一条调用链上、必须显式 publish）
  if (updatedAfterEvent) {
    const lastEvent =
      updatedAfterEvent.events[updatedAfterEvent.events.length - 1];
    if (lastEvent) {
      publishChatStreamEvent(task.id, { kind: "event", event: lastEvent });
    }
  }

  // 2) 切到 running（agent 拿到消息后会继续跑、UI 立刻把输入框 disable）
  const updated = await patchPhase(task.id, { taskStatus: "running" });
  if (updated) publishChatStreamEvent(task.id, { kind: "task", task: updated });

  // 3) 分两条链路投递消息给 agent
  const imagePathsArg =
    savedImages.length > 0 ? savedImages.map((s) => s.absPath) : undefined;
  const attachmentPathsArg =
    attachments.length > 0 ? attachments.map((a) => a.absPath) : undefined;

  if (autoStartConfig) {
    // V0.4 自动启动链路：首条消息直接塞进 initialPrompt
    // 不走 pendingFirstMessage 队列：
    //   - 旧方案：agent 起手 wait_for_user → 后端 race 消费队列 → agent 走 shell long-poll → 拿消息
    //     副作用：wait_for_user 工具进来时会触发 task.status = awaiting_user、UI 输入框短暂可用
    //     而且 agent 偏偏喜欢 emit「正在调用 wait_for_user 等你」之类废话（prompt 压不住）
    //   - 新方案：firstMessage 拼进 prompt、agent 第一次 turn 就回答、答完才调 wait_for_user 进等待
    //     UI 状态：running → 回答中 → awaiting_user、流转干净、agent 也不需要绕一圈
    void runChatSession({
      task: updated ?? task,
      apiKey: autoStartConfig.apiKey,
      model: autoStartConfig.model,
      userMcpServers: autoStartConfig.userMcpServers,
      firstMessage: {
        text,
        imagePaths: imagePathsArg,
        attachmentPaths: attachmentPathsArg,
      },
    }).catch((err) => {
      console.error(
        `[chat-reply] task=${task.id} auto runChatSession threw:`,
        err,
      );
    });
    return new Response(
      JSON.stringify({ ok: true, task: updated, autoStarted: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // 正常对话回合：resolve 阻塞中的 wait_for_user
  // wait-ack 路由会把附件路径拼到 text 里：
  //   - [ATTACHED_IMAGES]：图片专用、agent 调 read_file → SDK 自动 vision 处理
  //   - [ATTACHED_PATHS]：任意文件 / 目录、agent 按需 read_file / grep / glob
  const ok = submitUserMessage(
    task.id,
    text,
    imagePathsArg,
    attachmentPathsArg,
  );
  if (!ok) {
    // 极小概率：从 hasPending 校验到这里之间被别的请求抢先 resolve 了 / pending 又消失了
    // 这种情况不标 failed（agent 还活着、可能下一次 wait_for_user 就进来）、
    // 让用户重发即可
    return errorResponse(
      "agent 已不在等用户输入（可能并发处理 / keepalive 切换）、稍后重试",
      409,
    );
  }

  return new Response(
    JSON.stringify({ ok: true, task: updated }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
