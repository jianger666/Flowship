"use client";

/**
 * 根布局里的外壳开关：普通页面套 Providers + AppShell + Toaster（与改动前完全一样），
 * 「裸路由」（见 lib/bare-routes，目前只有 /mermaid-render）只渲染页面本身。
 *
 * 为什么放在客户端组件里判：根 layout 是服务端组件，拿不到当前路径；`usePathname` 在 SSR 与客户端给的是同一个值，
 * 不会有水合差异。普通页面的树结构（Providers > AppShell > children、Toaster 在 Providers 内）与改动前一致。
 */

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";
import { Toaster } from "@/components/ui/sonner";
import { isBareRoute } from "@/lib/bare-routes";

export const AppFrame = ({ children }: { children: ReactNode }) => {
  const pathname = usePathname();
  if (isBareRoute(pathname)) return <>{children}</>;
  return (
    <Providers>
      <AppShell>{children}</AppShell>
      {/* Windows 右上角是系统窗口按钮区域，toast 放 top-center 并下移到 56px 标题栏下方。 */}
      <Toaster position="top-center" offset={64} />
    </Providers>
  );
};
