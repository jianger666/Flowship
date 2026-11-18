/**
 * 「裸路由」：不套应用外壳（侧栏 / 顶栏 / 全局监听 / 弹窗宿主）的页面。
 *
 * 目前只有 `/mermaid-render`：桌面壳主进程开隐藏窗口加载它，把 Mermaid 渲染成 PNG 发飞书（electron-app/mermaid-render.mjs）。
 * 它不能套 Providers / AppShell——那一整套会在隐藏窗口里再起一份任务列表轮询、通知 / 提示监听、新版本弹窗，
 * 与真正的主窗口重复（甚至重复弹系统通知），而这个页面只要「一块白底舞台」。
 */
export const BARE_ROUTES: readonly string[] = ["/mermaid-render"];

export const isBareRoute = (pathname: string | null | undefined): boolean => {
  if (!pathname) return false;
  // 精确匹配或其子路径；不用 startsWith(route) 单独判，免得 `/mermaid-render-foo` 之类的前缀碰撞
  return BARE_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
};
