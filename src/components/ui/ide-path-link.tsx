"use client";

/**
 * 路径链接（事件流等）：展示 pathDisplayLabel，点击打开本地文件预览弹窗。
 *
 * 保留 IdePathLinker / useIdePathLinker 名称以减少 call site 改动；
 * IDE 跳转改到弹窗顶栏动作。
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
