/**
 * 公共 API 路由 helper
 *
 * 抽出来的动机：`chat-reply/route.ts` 和 `phase-ack/route.ts` 都各自实现了：
 *   - `errorResponse(msg, status)`
 *   - `isValidModel(m)` / `isValidMcpServers(v)`
 *   - `images[]` 入参 parse + 单图字段校验 + 累计字节上限校验
 *   - `KEEPALIVE_RACE_RETRY_MS` + `sleep`
 *
 * 三处复制粘贴（V0.5.5 ask-reply 加贴图时本来要变四处）。统一到这里、未来加新
 * route 直接复用、改 image 校验规则也只改一份。
 *
 * 设计取舍：
 *   - 不抽 chat-reply 独有的 attachments 校验（涉及 fs.stat 异步 + 路径校验、且只一处用）
 *   - 不抽 hasPending 双查（语义跟 keepalive race 强相关、嵌套 if 在 route 里读更清楚）
 *   - 不抽各路由自定义的「images 总数上限」常量（chat 6 / revise 6 / 未来 ask 1）、
 *     这些是业务参数、由 route 自己定、helper 只校验「不超传入的 max」
 */

import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import type { ImageAttachmentInput } from "@/lib/server/task-fs";

// ----------------- Response helpers -----------------

/**
 * 简易 JSON 错误响应（替代多个 route 文件里各自的 errorResponse）
 *
 * @param message 错误消息（会塞到 `{ error: message }` body 里）
 * @param status  HTTP 状态码、默认 400
 */
export const errorResponse = (message: string, status = 400): Response =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// ----------------- 类型守卫 -----------------

/**
 * 校验 ModelSelection：id 必须是非空字符串
 *
 * SDK 还有 params 等字段、但 fe-ai-flow 这层只关心 id 是否填了、params 由调用方自己保证
 */
export const isValidModel = (m: unknown): m is ModelSelection => {
  if (!m || typeof m !== "object") return false;
  const x = m as Partial<ModelSelection>;
  return typeof x.id === "string" && x.id.length > 0;
};

/**
 * 校验 mcpServers 对象：null/undefined 算合法（= 不接 MCP）、否则必须是对象 + value 是对象
 *
 * 不深校验 server cfg schema、留给 SDK 报错（更准）
 */
export const isValidMcpServers = (
  v: unknown,
): v is Record<string, McpServerConfig> | undefined => {
  if (v == null) return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every(
    (cfg) => cfg != null && typeof cfg === "object",
  );
};

// ----------------- Image 入参校验 -----------------

/**
 * 整批上传 size 上限（chat-reply / phase-ack 共享、防一次发 N 张超大图把服务端 + agent context 撑爆）
 * 单图 ≤ 10MB 由 task-fs.ts 内部强制
 */
const MAX_TOTAL_UPLOAD_BYTES = 30 * 1024 * 1024;

interface RawImage {
  data?: string;
  mimeType?: string;
  filename?: string;
}

interface ParseImagesOk {
  ok: true;
  images: ImageAttachmentInput[];
}

interface ParseImagesErr {
  ok: false;
  errorResponse: Response;
}

/**
 * 把 body.images 入参解析 + 校验成 ImageAttachmentInput[]
 *
 * 检查项：
 *   1. images.length > maxCount → 400
 *   2. 每张：data 必须非空字符串、mimeType 必须非空字符串
 *   3. 累计 base64 大小估算 > MAX_TOTAL_UPLOAD_BYTES → 400
 *
 * 不校验 base64 内容是否合法（留给 saveImageAttachments 真解码时抛）。
 *
 * 返回：
 *   - `{ ok: true, images }`：调用方拿 images 直接传给 saveImageAttachments
 *   - `{ ok: false, errorResponse }`：调用方直接 `return result.errorResponse`
 */
export const parseAndValidateImages = (
  raw: unknown,
  maxCount: number,
): ParseImagesOk | ParseImagesErr => {
  const rawList: RawImage[] = Array.isArray(raw) ? (raw as RawImage[]) : [];

  if (rawList.length > maxCount) {
    return {
      ok: false,
      errorResponse: errorResponse(
        `单次最多附 ${maxCount} 张图（你传了 ${rawList.length}）`,
      ),
    };
  }

  const images: ImageAttachmentInput[] = [];
  let totalBytes = 0;
  for (const img of rawList) {
    if (typeof img?.data !== "string" || !img.data.trim()) {
      return {
        ok: false,
        errorResponse: errorResponse("images[].data 必须是非空 base64 字符串"),
      };
    }
    if (typeof img.mimeType !== "string" || !img.mimeType.trim()) {
      return {
        ok: false,
        errorResponse: errorResponse("images[].mimeType 必填"),
      };
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
    return {
      ok: false,
      errorResponse: errorResponse(
        `本次上传图片总大小约 ${(totalBytes / 1024 / 1024).toFixed(2)} MB、超过上限 ${MAX_TOTAL_UPLOAD_BYTES / 1024 / 1024} MB`,
      ),
    };
  }

  return { ok: true, images };
};

// ----------------- hasPending race 兜底 -----------------

/**
 * hasPending 第一次为 false 时、稍等再查一次的延迟（毫秒）
 *
 * V0.3.5 起保活机制改成 shell + curl long-poll、entry 一旦 registerPendingEntry
 * 就一直在 pendingMap 里（直到 finalizeEntry resolve）。理论上没有 V0.3.5 之前
 * 的「50s timer fire → resolve → 重新调 wait_for_user」中间空窗。
 *
 * 仍保留 retry 作防御：极少数 race 场景下（用户连答两次 / agent 主动顶替旧 wait
 * → grace cleanup 期 + 新 wait_for_user 还没到达）hasPending 可能瞬时 false。
 * 200ms 给的余量足够、命中代价仅 200ms 延迟、保留更稳。
 */
export const KEEPALIVE_RACE_RETRY_MS = 200;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
