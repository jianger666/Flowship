/**
 * GET /api/mcp-oauth/callback?code=&state=
 *
 * OAuth 授权回调端点（DCR 注册时声明的 redirect_uri）。用户在飞书授权后浏览器跳到这、
 * 带 code + state。这里解析 state 定位是哪个 server、用 code 换 token 落盘、返回一个
 * 结果 HTML 页（成功自动关窗 + 通知打开它的 fe 窗口刷新状态）。
 */

import { completeMcpOAuth, parseOAuthState } from "@/lib/server/mcp-oauth";

export const runtime = "nodejs";

// HTML 转义（错误信息可能含用户内容、防注入）
const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// 渲染结果页：跟随系统深浅色、成功 1.2s 后自动关窗、并 postMessage 通知 opener 刷新
const renderHtml = (ok: boolean, title: string, detail: string): string => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${ok ? "授权成功" : "授权失败"}</title>
<style>
  /* 默认 dark、浅色系统下用 prefers-color-scheme 覆盖、跟应用主题观感一致 */
  :root { color-scheme: light dark; --bg:#0a0a0a; --fg:#ededed; --sub:#a1a1aa; }
  @media (prefers-color-scheme: light) { :root { --bg:#f5f6f8; --fg:#23242a; --sub:#6b7280; } }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .card { max-width:420px; padding:32px; text-align:center; }
  .icon { width:56px; height:56px; border-radius:50%; margin:0 auto 20px;
    display:flex; align-items:center; justify-content:center; font-size:28px;
    background:${ok ? "rgba(34,197,94,.12)" : "rgba(239,68,68,.12)"};
    color:${ok ? "#22c55e" : "#ef4444"}; }
  h1 { font-size:18px; margin:0 0 8px; }
  p { margin:0; color:var(--sub); word-break:break-word; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${ok ? "&#10003;" : "&#10007;"}</div>
    <h1>${esc(title)}</h1>
    <p>${esc(detail)}</p>
  </div>
  <script>
    try { if (window.opener) window.opener.postMessage({ type: "mcp-oauth", ok: ${ok} }, "*"); } catch (e) {}
    ${ok ? "setTimeout(function(){ try { window.close(); } catch (e) {} }, 1200);" : ""}
  </script>
</body>
</html>`;

const htmlResponse = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

export const GET = async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDesc = url.searchParams.get("error_description");

  if (error) {
    return htmlResponse(
      renderHtml(
        false,
        "授权被拒绝",
        `${error}${errorDesc ? `：${errorDesc}` : ""}`,
      ),
    );
  }
  if (!code || !state) {
    return htmlResponse(renderHtml(false, "授权失败", "回调缺少 code / state 参数"));
  }

  const parsed = parseOAuthState(state);
  if (!parsed) {
    return htmlResponse(renderHtml(false, "授权失败", "state 解析失败"));
  }

  try {
    await completeMcpOAuth(parsed.serverName, code, state);
    return htmlResponse(
      renderHtml(
        true,
        "授权成功",
        `「${parsed.serverName}」已授权、可关闭此页面回到 Flowship`,
      ),
    );
  } catch (err) {
    return htmlResponse(
      renderHtml(
        false,
        "换取 token 失败",
        err instanceof Error ? err.message : String(err),
      ),
    );
  }
};
