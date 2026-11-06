/**
 * GET /api/system/read-local-file?path=<绝对路径>[&sheet=<N>]
 *
 * 本地文件预览的数据源：返回 kind + 文本 / 表格 / 幻灯片 / 条目 / 媒体 URL。
 * 安全边界同 local-image：loopback 桌面端；绝对路径 + realpath + 大小截断。
 * 文本类额外带 editable / editBlockedReason：内容能否安全往返（读文件时判）+ 路径是否在可编辑范围（这里判），
 * 写入本身由 write-local-file 再校验一遍，这里只决定「预览窗显不显示编辑入口」。
 */

import { isTextKind } from "@/lib/local-file-kind";
import { editBlockReason, getEditRoots } from "@/lib/server/local-file-edit-policy";
import { readLocalFileForPreview } from "@/lib/server/local-file-read";
import { nonLocalPathReason } from "@/lib/unc-path";

const errorJson = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const runtime = "nodejs";

export const GET = async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const raw = params.get("path")?.trim() ?? "";
  if (!raw) return errorJson("path 必填");
  // UNC 在碰文件系统之前拒绝（Windows 上 realpath 会触发 SMB / NTLM 外发，见 lib/unc-path）
  const nonLocal = nonLocalPathReason(raw);
  if (nonLocal) return errorJson(nonLocal);

  const sheetRaw = params.get("sheet");
  const sheet = sheetRaw == null ? undefined : Number(sheetRaw);
  if (sheet !== undefined && (!Number.isInteger(sheet) || sheet < 0 || sheet > 1000)) {
    return errorJson("sheet 必须是 0~1000 的整数");
  }

  try {
    const { contentEditBlockReason, ...payload } = await readLocalFileForPreview(raw, { sheet });
    // xlsx 的 html 只是 server 内部沿用的旧产物（前端改用 table 渲染），不再整份发给浏览器
    if (payload.kind === "xlsx") delete payload.html;
    if (isTextKind(payload.kind)) {
      let reason = contentEditBlockReason ?? null;
      if (!reason) {
        try {
          reason = editBlockReason(payload.absolutePath, await getEditRoots());
        } catch {
          // 取不到可编辑范围（读任务列表失败）：保守按不可编辑处理，预览本身不受影响
          reason = "暂时无法确认这个文件是否可编辑";
        }
      }
      payload.editable = reason === null;
      if (reason) payload.editBlockedReason = reason;
    }
    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return errorJson("文件不存在", 404);
    return errorJson(`读取失败：${message}`, 500);
  }
};
