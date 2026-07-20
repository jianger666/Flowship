/**
 * 深链跳板：`GET /open/task/<id>`
 *
 * 飞书卡片不放行自定义协议链接、Chrome 又拦「无手势的外部协议跳转」——
 * 但本路由就跑在 app 自己的 server 进程里（同机同实例），直接由服务端执行
 * 系统级唤起（mac `open` / win `start`）触发 flowship[-test]:// 协议，
 * 单实例锁会聚焦已运行的壳并路由到对应对话；浏览器侧只留一个兜底按钮。
 */
import { spawn } from "node:child_process";

import { getProtocolDeepLink } from "@/lib/server/feishu-bridge/bridge-config";

export const runtime = "nodejs";

/** 服务端直接唤起协议 URL（分平台；失败不抛、由页面按钮兜底） */
const openProtocolUrl = (url: string): boolean => {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      // start 的第一个引号参数是窗口标题占位、URL 必须放第二个
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch {
    return false;
  }
};

export const GET = async (
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await ctx.params;
  const target = getProtocolDeepLink(id);
  const opened = openProtocolUrl(target);
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
<p>${opened ? "已为你打开 Flowship，可关闭本页。" : "自动打开失败，点下方按钮。"}</p>
<a class="btn" href="${target}">打开 Flowship</a>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};
