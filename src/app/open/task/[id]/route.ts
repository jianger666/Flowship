/**
 * 深链跳板页：`GET /open/task/<id>`
 *
 * 飞书卡片不放行自定义协议链接（flowship:// 点了没反应）——卡片里放的是本机
 * http 链接，浏览器打开本页后立即跳 flowship[-test]://tasks/<id> 唤起壳。
 * 壳已在跑 → 聚焦主窗并路由到对应对话；未跑 → 系统按协议注册拉起 app。
 */
import { getProtocolDeepLink } from "@/lib/server/feishu-bridge/bridge-config";

export const GET = async (
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await ctx.params;
  const target = getProtocolDeepLink(id);
  // 极简中转页：meta refresh + JS 双保险跳协议；留一行提示防止唤起被系统拦
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>正在打开 Flowship…</title>
<meta http-equiv="refresh" content="0;url=${target}" />
<style>body{font:14px/1.6 -apple-system,sans-serif;color:#666;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style>
</head>
<body>
<p>正在打开 Flowship…可以关闭本页。若未自动打开，请手动切换到 Flowship 应用。</p>
<script>location.href=${JSON.stringify(target)};</script>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};
