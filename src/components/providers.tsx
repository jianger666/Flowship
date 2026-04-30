"use client";

/**
 * 客户端 Providers 集合
 * - next-themes：默认 dark 主题、不跟随系统、不允许切换
 *   （未来如果做主题切换、把 enableSystem / forcedTheme 拆开）
 * - 后续如果接 react-query / jotai 等也都加在这里
 */

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

interface ProvidersProps {
  children: ReactNode;
}

export const Providers = ({ children }: ProvidersProps) => {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      forcedTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
};
