"use client";

/**
 * 路径链接（事件流等）：展示 pathDisplayLabel，按文件意图进入浏览器、IDE 或本地预览。
 *
 * 保留 IdePathLinker / useIdePathLinker 名称以减少 call site 改动；
 * 具体主动作由 LocalFileLink 统一判断。
 */

import {
  LocalFileLink,
  useLocalFilePathLinker,
  type LocalFilePathLinker,
} from "@/components/ui/local-file-link";
import { pathDisplayLabel } from "@/lib/path-utils";
import type { ReactNode } from "react";

export type IdePathLinker = LocalFilePathLinker;

export const useIdePathLinker = useLocalFilePathLinker;

interface IdePathLinkProps {
  linker: IdePathLinker;
  path: string;
  line?: number;
  children?: ReactNode;
  className?: string;
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
  const target = linker.resolveFor(path, line);
  const display =
    children ??
    (target ? pathDisplayLabel(target.absolute) : path);

  return (
    <LocalFileLink
      linker={linker}
      path={path}
      line={line}
      className={className}
      linkClassName={linkClassName}
    >
      {display}
    </LocalFileLink>
  );
};
