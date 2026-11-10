import { Globe } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 「内置浏览器仅桌面端可用」：`window.__browser` 不存在时（网页版 `pnpm dev:web`、或旧壳）渲染它。
 * 纯展示、不碰 window，所以服务端渲染 / 无 bridge 都安全；不报错、不 toast。
 */
export const BrowserUnavailable = ({ className }: { className?: string }) => (
  <div
    className={cn(
      "flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground",
      className,
    )}
  >
    <Globe className="size-6 text-muted-foreground" aria-hidden />
    <div className="text-sm font-medium text-foreground">内置浏览器仅桌面端可用</div>
    <p className="max-w-xs text-xs">
      请在 Flowship 桌面应用里使用：AI 可以操作一个内嵌的真实浏览器，你也能随时看到并接管。
    </p>
  </div>
);
