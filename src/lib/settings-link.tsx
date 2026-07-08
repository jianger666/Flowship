/**
 * 设置页 URL 工具
 *
 * focus 对应 settings/page.tsx 里各卡片的 id 后缀（如 api-key → #card-api-key），
 * 供 toast action、空态链接等「一键跳到对应配置块」用。
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export const settingsUrl = (focus?: string) =>
  focus ? `/settings?focus=${focus}` : "/settings";

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
