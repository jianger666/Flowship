import type { Metadata } from "next";
import Link from "next/link";
import { Settings } from "lucide-react";
import { Providers } from "@/components/providers";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI工作流",
  description: "开发流水线",
};

/**
 * Root layout
 * - <html> 上加 className="dark"、立即生效 dark 主题、避免 SSR 闪白
 *   （suppressHydrationWarning 是 next-themes 推荐配置）
 * - 顶部 header 全站固定、左 logo / 右设置入口
 * - Next.js App Router 要求 layout 必须 default export 一个组件、所以这里
 *   保留 default export，但函数体本身用箭头声明
 */
const RootLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <html lang="zh-CN" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Providers>
          <div className="min-h-screen flex flex-col">
            <header className="h-14 px-6 flex items-center justify-between">
              <Link
                href="/"
                className="flex items-center gap-2 font-semibold tracking-tight no-underline text-foreground hover:opacity-80"
              >
                AI工作流
                <span className="text-xs text-muted-foreground font-normal">
                  开发流水线
                </span>
              </Link>
              {/* Base UI 的 Button 通过 render prop 实现 polymorphic、不再用 asChild
                  nativeButton={false} 是因为 render 出来的是 <a>、不是 <button>、
                  不传会被 Base UI runtime warn */}
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link href="/settings" className="no-underline" />}
              >
                <Settings />
                设置
              </Button>
            </header>
            <Separator />
            <main className="flex-1">{children}</main>
          </div>
          <Toaster position="top-right" />
        </Providers>
      </body>
    </html>
  );
};

export default RootLayout;
