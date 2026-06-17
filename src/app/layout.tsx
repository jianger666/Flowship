import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/app-shell";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI工作流",
  description: "开发流水线",
};

/**
 * Root layout
 * - 主题由 next-themes 控制（三态：浅色 / 深色 / 跟随系统）、不再硬编码 .dark
 *   next-themes 注入的 beforeInteractive 脚本会在首帧前定好主题、避免 SSR 闪色
 *   （suppressHydrationWarning 是 next-themes 推荐配置、抑制 <html> class 水合差异）
 * - 外壳 AppShell（V0.8）：顶栏 + 侧栏（可展开 / 收起）+ 主内容区、取代原 header + main
 * - body 定高 h-screen + overflow-hidden：整体不滚、滚动交给 AppShell 内的主区
 * - Next.js App Router 要求 layout 必须 default export 一个组件、所以这里
 *   保留 default export，但函数体本身用箭头声明
 */
const RootLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="h-screen overflow-hidden bg-background text-foreground antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
          {/* Windows 右上角是系统窗口按钮区域，toast 放 top-center 并下移到 56px 标题栏下方。 */}
          <Toaster position="top-center" offset={64} />
        </Providers>
      </body>
    </html>
  );
};

export default RootLayout;
