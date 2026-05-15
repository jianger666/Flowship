/**
 * POST /api/tasks/[id]/chat-reply
 *
 * Body: { text: string }
 *
 * 用户在 ChatView 输入框里发了一条消息、这个路由：
 *   1. 写一条 user_reply 事件
 *   2. 调 submitUserMessage(taskId, text)、把消息塞给被阻塞的 wait_for_user 工具
 *   3. patch task.status = running（agent 拿到消息后会接着跑）
 *
 * 失败情况：
 *   - task 不存在 → 404
 *   - task.mode !== "chat" → 409
 *   - hasPending=false 且 task.status 还在 awaiting_user/running → 410（僵尸态、当场标 failed）
 *   - hasPending=false 但 task.status 已是终态 → 409
 *
 * 进程重启 / agent 崩溃后的体验：
 *   - getTask 顶部已 await ensureBootRecovery、绝大多数僵尸任务在用户首次访问时就被标 failed
 *   - 但极小概率：用户访问页面 → SSE 连上 → 发消息全在 boot recovery 完成之前
 *     兜底：本路由检测 hasPending=false 且 status 异常 → 当场补一次「僵尸标记」
 */

import { promises as fs } from "node:fs";
import path from "node:path";

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
import { publishChatStreamEvent } from "@/lib/server/chat-runner";

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

export const runtime = "nodejs";

// keepalive 切换的"几十毫秒空窗"兜底：hasPending 第一次为 false 时、稍等再查一次
// 时序：50s timer fire → resolve [KEEPALIVE] → agent 重新调 wait_for_user → 新 pending 进来
//      整个空窗在网络正常下通常 < 100ms、给 200ms 足够覆盖大部分情况
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

  // hasPending 检测带 keepalive 切换 race 兜底：第一次 false 时等 200ms 再试一次
  // agent 因为 [KEEPALIVE] 返回会立刻再调 wait_for_user、新 pending 通常 100ms 内进来
  let pending = hasPending(task.id);
  if (!pending) {
    await sleep(KEEPALIVE_RACE_RETRY_MS);
    pending = hasPending(task.id);
  }

  if (!pending) {
    // 真没 pending、分两种情况处理：
    if (task.status === "awaiting_user" || task.status === "running") {
      // 僵尸态：进程重启 / agent 崩溃 / 上面 boot recovery 还没扫到这个 task
      // 当场补一次"僵尸标记"、UI 拿到 failed 会展示「重新启动 Chat」按钮
      console.warn(
        `[chat-reply] task=${task.id} 僵尸态 status=${task.status} hasPending=false、当场标 failed`,
      );
      const errorTask = await appendEvent(task.id, {
        kind: "error",
        text: "Chat agent 已断开（进程重启或异常退出）、本段对话不能继续。点顶部「重新启动 Chat」开始新一段会话。",
      });
      // 主动 publish：让所有 SSE 订阅者（其他 tab / 当前 UI）立刻收到 task 状态变化
      // 不 publish 的话、UI task 会卡在 awaiting_user、用户摸不着头脑
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
        "agent 已断开、请点「重新启动 Chat」开始新一段会话",
        410,
      );
    }
    // status 已经是 draft / completed / failed 等终态：用户没启动就发消息、或 agent 已退出
    return errorResponse(
      `agent 当前没在等用户输入（task.status=${task.status}）。如已退出请点「重新启动 Chat」`,
      409,
    );
  }

  console.log(
    `[chat-reply] task=${task.id} 收到用户输入 text=${text.slice(0, 60)} images=${images.length} attachments=${attachments.length}`,
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
  await appendEvent(task.id, {
    kind: "user_reply",
    text: text || fallbackText,
    meta: Object.keys(metaParts).length > 0 ? metaParts : undefined,
  });

  // 2) 切到 running（agent 拿到消息后会继续跑、UI 立刻把输入框 disable）
  const updated = await patchPhase(task.id, { taskStatus: "running" });

  // 3) resolve 阻塞中的 wait_for_user
  // 把图片 / 路径绝对路径列表带过去、wait_for_user return text 会拼：
  //   - [ATTACHED_IMAGES]：图片专用、agent 调 read_file → SDK 自动 vision 处理
  //   - [ATTACHED_PATHS]：任意文件 / 目录、agent 按需 read_file / grep / glob
  const ok = submitUserMessage(
    task.id,
    text,
    savedImages.length > 0 ? savedImages.map((s) => s.absPath) : undefined,
    attachments.length > 0 ? attachments.map((a) => a.absPath) : undefined,
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
