"use client";

/**
 * 本地路径链接：展示 pathDisplayLabel、hover 全路径、点击打开居中预览弹窗
 *
 * 与 IdePathLink 共用 baseDir 解析；拼不出绝对路径 → 纯文本（同退化原则）。
 */

import { useCallback, useMemo, type MouseEvent, type ReactNode } from "react";

import {
  resolveLocalFileAbsolute,
  useLocalFilePreview,
} from "@/components/ui/local-file-preview-context";
import { Tooltip } from "@/components/ui/tooltip";
import { pathDisplayLabel } from "@/lib/path-utils";
import { cn } from "@/lib/utils";

export interface LocalFilePathLinker {
  /** 拼得出绝对路径 → 目标；拼不出 → null */
  resolveFor: (pathLike: string, line?: number) => { absolute: string; line?: number } | null;
  baseDir?: string;
}

/** 一块 UI 调一次、块内路径共用 baseDir */
export const useLocalFilePathLinker = (baseDir?: string): LocalFilePathLinker => {
  const resolveFor = useCallback(
    (pathLike: string, line?: number) =>
      resolveLocalFileAbsolute(
        line != null ? `${pathLike}:${line}` : pathLike,
        baseDir,
      ),
    [baseDir],
  );
  return useMemo(() => ({ resolveFor, baseDir }), [resolveFor, baseDir]);
};

interface LocalFileLinkProps {
  linker: LocalFilePathLinker;
  path: string;
  line?: number;
  children?: ReactNode;
  className?: string;
  linkClassName?: string;
}

export const LocalFileLink = ({
  linker,
  path,
  line,
  children,
  className,
  linkClassName,
}: LocalFileLinkProps) => {
  const { open } = useLocalFilePreview();
  const target = linker.resolveFor(path, line);

  if (!target) {
    return (
      <Tooltip content={path}>
        <span className={cn("min-w-0 max-w-full", className)}>
          {children ?? path}
        </span>
      </Tooltip>
    );
  }

  const shown = children ?? pathDisplayLabel(target.absolute);

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    open(line != null ? `${path}:${line}` : path, {
      baseDir: linker.baseDir,
      line: target.line ?? line,
    });
  };

  return (
    <Tooltip content={target.absolute}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "min-w-0 max-w-full cursor-pointer bg-transparent p-0 text-left align-baseline",
          className,
          linkClassName ?? "font-mono text-info underline-offset-2 hover:underline",
        )}
      >
        {shown}
      </button>
    </Tooltip>
  );
};

/** artifact 多段行号：点任一段打开同一文件预览（行号记在弹窗 IDE 动作） */
export const LocalFilePathSegments = ({
  linker,
  parsedPath,
  segments,
  className,
}: {
  linker: LocalFilePathLinker;
  parsedPath: string;
  segments: Array<{ text: string; line: number; sep: string }>;
  className?: string;
}) => {
  const { open } = useLocalFilePreview();

  const openFile = (line: number, e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    open(`${parsedPath}:${line}`, { baseDir: linker.baseDir, line });
  };

  return (
    <span className={cn("font-mono text-[0.85em]", className)}>
      {segments.map((seg, i) => (
        <span key={`${seg.line}-${i}`}>
          {seg.sep}
          <Tooltip content={`${parsedPath}:${seg.text}\n（点击预览文件）`}>
            <button
              type="button"
              onClick={(e) => openFile(seg.line, e)}
              className="cursor-pointer bg-transparent p-0 text-info underline-offset-2 hover:underline"
            >
              {i === 0 ? `${parsedPath}:${seg.text}` : seg.text}
            </button>
          </Tooltip>
        </span>
      ))}
    </span>
  );
};
