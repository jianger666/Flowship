import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import { AppHeader } from "@/components/app-header";
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
 * - 顶部条 = AppHeader（自定义标题栏、与应用同色一体、品牌靠左、详见组件注释）
 * - Next.js App Router 要求 layout 必须 default export 一个组件、所以这里
 *   保留 default export，但函数体本身用箭头声明
 */
const RootLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Providers>
          <div className="flex min-h-screen flex-col">
            <AppHeader />
            <main className="flex-1">{children}</main>
          </div>
          <Toaster position="top-right" />
        </Providers>
      </body>
    </html>
  );
};

export default RootLayout;
