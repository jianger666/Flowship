"use client";

/**
 * 路径 → IDE 跳转链接（拼不出绝对路径就退化成纯文本）
 *
 * 为什么抽公共件：事件流工具块里「文件路径」出现在多处（展开行 / diff 标题 / diff 行号），
 * 每处都要同一套「能拼绝对路径就给链接、拼不出就纯文本」的退化 + 同一套 tooltip 文案；
 * 散着写必漂移（artifact-panel 已有一份、那份带多段行号解析、语境不同不强行合并）。
 *
 * 退化原则跟 markdown-link 一致：**点了必没反应的链接比没有链接更误导**——
 * 相对路径又拿不到 baseDir 时一律纯文本。
 */

import { useCallback, useMemo, type ReactNode } from "react";

import { useJumpIde } from "@/hooks/use-settings";
import { getIdeAnchorProps, type IdeAnchorProps } from "@/lib/ide-open";
import { JUMP_IDE_LABEL } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface IdePathLinker {
  /** 拼得出绝对路径 → `<a>` 属性；拼不出（相对路径无 baseDir / 本身是 url）→ null */
  anchorFor: (pathLike: string, line?: number) => IdeAnchorProps | null;
  /** 当前跳转工具中文名（tooltip 用） */
  ideLabel: string;
}

/**
 * 取一次跳转配置、产出「路径 → anchor」工厂。
 * 一个工具块调一次、块内所有路径 / diff 行号共用（别每个路径各调一次 useJumpIde）。
 *
 * @param baseDir 相对路径的拼接基准（= task 的 agent cwd）；缺省时相对路径不给链接
 */
export const useIdePathLinker = (baseDir?: string): IdePathLinker => {
  const ide = useJumpIde();
  const anchorFor = useCallback(
    (pathLike: string, line?: number) =>
      // 行号走 `path:line` 后缀（buildIdeLink / resolveIdeTarget 的既有约定）
      getIdeAnchorProps(
        line != null ? `${pathLike}:${line}` : pathLike,
        baseDir,
        ide,
      ),
    [baseDir, ide],
  );
  return useMemo(
    () => ({ anchorFor, ideLabel: JUMP_IDE_LABEL[ide] }),
    [anchorFor, ide],
  );
};

interface IdePathLinkProps {
  linker: IdePathLinker;
  path: string;
  /** 跳到指定行（diff 行号用） */
  line?: number;
  /** 链接文案，缺省 = path 原文 */
  children?: ReactNode;
  /** 链接 / 纯文本两态共用的布局样式（truncate / 字号 / 宽度等） */
  className?: string;
  /** 仅链接态生效的样式；默认 sky 色 + hover 下划线（跟 artifact 路径链接同款） */
  linkClassName?: string;
}

export const IdePathLink = ({
  linker,
  path,
  line,
  children,
  className,
  linkClassName,
}: IdePathLinkProps) => {
  const anchor = linker.anchorFor(path, line);
  const text = children ?? path;
  const label = line != null ? `${path}:${line}` : path;

  if (!anchor) {
    // 纯文本兜底：title 仍给全路径（行内多半 truncate 了、hover 能看全）
    return (
      <span className={className} title={path}>
        {text}
      </span>
    );
  }

  return (
    <a
      {...anchor}
      // 外层常是「整行折叠」按钮：点路径只跳转、别顺带把块折叠了
      onClick={(e) => {
        e.stopPropagation();
        anchor.onClick?.(e);
      }}
      className={cn(
        "no-underline",
        className,
        linkClassName ??
          "text-info underline-offset-2 hover:underline",
      )}
      title={`点击在 ${linker.ideLabel} 中打开：${label}`}
    >
      {text}
    </a>
  );
};
