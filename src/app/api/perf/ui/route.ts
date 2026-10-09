/**
 * POST /api/perf/ui —— 前端流畅度上报（长任务 / 慢交互 / 回前台追赶 / 页面规模）。
 *
 * 前端 hooks/use-ui-perf-reporter 每 30s（有信号时）或切后台 / 离开页面时发一条；
 * 校验、限频、落盘全在 lib/server/ui-perf-ingest（这里只是薄壳）。
 * 永远不返回会让前端重试的状态：被限频 / 写失败都是 204。
 */
import {
  MAX_UI_PERF_BODY_BYTES,
  defaultUiPerfDeps,
  handleUiPerfPost,
} from "@/lib/server/ui-perf-ingest";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_UI_PERF_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return new Response(null, { status: 400 });
  }
  const { status } = handleUiPerfPost(text, defaultUiPerfDeps());
  return new Response(null, { status });
}
