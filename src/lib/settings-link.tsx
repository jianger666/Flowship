/**
 * 设置页 URL 工具
 *
 * focus 对应 settings/page.tsx 里各卡片的 id 后缀（如 api-key → #card-api-key），
 * 供 toast action、空态链接等「一键跳到对应配置块」用。
 *
 * v1.0.x：MCP / Skill 配置迁去 /actions 能力页（tab 管理）——这两个 focus 直接出
 * 能力页链接（设置页也留了兜底重定向、双保险不断旧链）。
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// 能力类 focus → /actions 能力页 tab
const CAPABILITY_TABS: Record<string, string> = { mcp: "mcp", skills: "skills" };

export const settingsUrl = (focus?: string) => {
  if (focus && CAPABILITY_TABS[focus]) return `/actions?tab=${CAPABILITY_TABS[focus]}`;
  return focus ? `/settings?focus=${focus}` : "/settings";
};

interface SettingsLinkProps {
  focus?: string;
  children: ReactNode;
  className?: string;
}

/** 跳转设置页对应卡片（带 ?focus= 锚点） */
export const SettingsLink = ({
  focus,
  children,
  className,
}: SettingsLinkProps) => (
  <a
    href={settingsUrl(focus)}
    className={cn(
      "text-primary underline-offset-2 hover:underline",
      className,
    )}
  >
    {children}
  </a>
);
