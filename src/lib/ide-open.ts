/**
 * 代码跳转的统一入口（客户端、V0.11.8）
 *
 * 两条通道按工具切换（见 types.ts JUMP_IDE_USES_PROTOCOL 注释）：
 * - cursor / vscode：`<a href="cursor://file/...">` deep link（协议注册可靠、零往返）
 * - JetBrains 系（idea / webstorm）：POST /api/system/open-in-ide、后端探测安装位置
 *   直接 spawn——不依赖 `idea://` 协议（只有 Toolbox 会注册、直装 IDEA 的 Windows 点了弹
 *   「找不到应用」、用户同事实测）
 *
 * 用法：渲染 `<a {...getIdeAnchorProps(pathLike, baseDir, ide)}>`——helper 返回
 * href（协议通道）或 href="#" + onClick（后端通道）、调用方零分支。
 */

import { toast } from "sonner";

import { buildIdeLink, resolveIdeTarget } from "@/lib/path-utils";
import { JUMP_IDE_USES_PROTOCOL, type JumpIde } from "@/lib/types";

/** 后端拉起 IDE（JetBrains 系跳转通道）、失败 toast */
export const openViaBackend = async (
  ide: JumpIde,
  absPath: string,
  line?: number,
): Promise<void> => {
  try {
    const res = await fetch("/api/system/open-in-ide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ide, path: absPath, line }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? `打开 IDE 失败（HTTP ${res.status}）`);
    }
  } catch (err) {
    toast.error(`打开 IDE 失败：${err instanceof Error ? err.message : String(err)}`);
  }
};

export interface IdeAnchorProps {
  href: string;
  onClick?: (e: React.MouseEvent) => void;
}

/**
 * 给 `<a>` 用的跳转属性：协议工具返 deep link href、后端工具返 "#" + onClick 拦截。
 * 解析不出目标（相对路径没 baseDir 等）返 null、调用方降级纯文本。
 */
export const getIdeAnchorProps = (
  pathLike: string,
  baseDir: string | undefined,
  ide: JumpIde,
): IdeAnchorProps | null => {
  if (JUMP_IDE_USES_PROTOCOL[ide]) {
    const href = buildIdeLink(pathLike, baseDir, ide);
    return href ? { href } : null;
  }
  const target = resolveIdeTarget(pathLike, baseDir);
  if (!target) return null;
  return {
    href: "#",
    onClick: (e) => {
      e.preventDefault();
      void openViaBackend(ide, target.absolute, target.line);
    },
  };
};
