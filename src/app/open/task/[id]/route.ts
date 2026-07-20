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
  // 中转页：自动尝试跳协议 + 大按钮兜底。
  // Chrome 拦截「无用户手势的外部协议跳转」（静默不弹，2026-07-20 用户实测点了没反应）——
  // 页内点击 = 新手势，按钮必达；Safari 等不拦的浏览器自动跳直接生效。
  const targetJson = JSON.stringify(target);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>打开 Flowship</title>
<style>
body{font:14px/1.6 -apple-system,sans-serif;color:#666;display:flex;flex-direction:column;gap:16px;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa}
a.btn{display:inline-block;padding:12px 32px;border-radius:8px;background:#171717;color:#fff;font-size:16px;text-decoration:none}
a.btn:active{opacity:.8}
</style>
</head>
<body>
<a class="btn" href="${target}">打开 Flowship</a>
<p>点按钮直达对话；打开后可关闭本页。</p>
<script>location.href=${targetJson};</script>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};
