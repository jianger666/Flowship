"use client";

/**
 * 客户端 Providers 集合
 * - next-themes：默认 dark 主题、不跟随系统、不允许切换
 *   （未来如果做主题切换、把 enableSystem / forcedTheme 拆开）
 * - 后续如果接 react-query / jotai 等也都加在这里
 */

import { ThemeProvider } from "next-themes";
import { useEffect, type ReactNode } from "react";

import { DialogProvider } from "@/hooks/use-dialog";
import { getSettings } from "@/lib/local-store";
import { useModels } from "@/hooks/use-models";

interface ProvidersProps {
  children: ReactNode;
}

// 模型列表预热（V0.7.13 用户拍板「打开软件就拉一次」）：
// app 加载后台静默拉一遍 → 写进 localStorage 缓存 + server 内存缓存、
// 之后所有用到模型列表的入口（新建任务 / 设置 / 切模型）全是秒出
const ModelsPrefetch = () => {
  const { fetchModels } = useModels();
  useEffect(() => {
    const key = getSettings().apiKey?.trim();
    if (key) void fetchModels(key);
  }, [fetchModels]);
  return null;
};

export const Providers = ({ children }: ProvidersProps) => {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      forcedTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      {/* DialogProvider 提供全局 confirm/prompt——禁用 window.{alert,confirm,prompt}、
          统一走 shadcn 风格弹窗。组件内用 useDialog() 拿到 confirm / prompt */}
      <DialogProvider>
        <ModelsPrefetch />
        {children}
      </DialogProvider>
    </ThemeProvider>
  );
};
