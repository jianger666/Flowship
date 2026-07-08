/**
 * 公共 API 路由 helper
 *
 * 抽出来的动机：多个 route 各自实现过：
 *   - `errorResponse(msg, status)`
 *   - `isValidModel(m)`
 *   - `images[]` 入参 parse + 单图字段校验 + 累计字节上限校验
 *
 * 统一到这里、未来加新 route 直接复用、改 image 校验规则也只改一份。
 *
 * 设计取舍：
 *   - 不抽 chat-reply 独有的 attachments 校验（涉及 fs.stat 异步 + 路径校验、且只一处用）
 *   - 不抽各路由自定义的「images 总数上限」常量（chat 6 / revise 6）、
 *     这些是业务参数、由 route 自己定、helper 只校验「不超传入的 max」
 */

import type { ModelSelection } from "@cursor/sdk";

import type { ImageAttachmentInput } from "@/lib/server/task-artifacts";

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
 * SDK 还有 params 等字段、但 ai-flow 这层只关心 id 是否填了、params 由调用方自己保证
 */
export const isValidModel = (m: unknown): m is ModelSelection => {
  if (!m || typeof m !== "object") return false;
  const x = m as Partial<ModelSelection>;
  return typeof x.id === "string" && x.id.length > 0;
};

/**
 * 「模型 + 参数」深比：id 相同 且 params 完全一致（无视 params 顺序）。
 *
 * chat 懒重启用：用户切了模型 / 调了参数（fast、thinking 级别等都在 params 里）后发下条消息、
 * 比对「当前 Run 绑定模型」vs「现在选的」——一致就续接（切了又切回零成本）、不一致才重启换模型。
 * 规范化序列化比、params 按 id 排序消顺序差异。
 */
const canonicalModel = (m: ModelSelection): string => {
  const params = [...(m.params ?? [])]
    .map((p) => [p.id, p.value] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify({ id: m.id, params });
};

export const modelEquals = (a: ModelSelection, b: ModelSelection): boolean =>
  canonicalModel(a) === canonicalModel(b);

/**
 * 字符串集合相等比对（顺序无关、去重后比）。
 *
 * 切 MCP 懒重启用：chat-reply 比对「当前 Run 绑定的 MCP 黑名单 vs 现在的」、
 * 决定续接还是重启（改了又改回去 = 净变化 0 = 相等 = 不重启）。
 */
export const stringSetEquals = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const x of a) {
    if (!setB.has(x)) return false;
  }
  // 长度相等 + a 全在 b 里 + 去重后 b 不会更大（用 Set 比 size 兜重复项）
  return setB.size === new Set(a).size;
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

