"use client";

/**
 * LocalFilePreview 上下文层（与弹窗 UI 解耦，打破 MarkdownText ↔ preview 循环依赖）
 *
 * LocalFileLink / MarkdownText 只依赖本文件；Provider + 弹窗在 local-file-preview.tsx。
 */

import { createContext, useContext } from "react";

import { resolveIdeTarget } from "@/lib/path-utils";

export interface OpenLocalFileOptions {
  /** 相对路径解析基准（task cwd） */
  baseDir?: string;
  /** 行号（弹窗顶栏 IDE 打开用） */
  line?: number;
}

interface LocalFilePreviewContextValue {
  open: (pathLike: string, opts?: OpenLocalFileOptions) => void;
}

export const LocalFilePreviewContext =
  createContext<LocalFilePreviewContextValue | null>(null);

export const useLocalFilePreview = (): LocalFilePreviewContextValue => {
  const ctx = useContext(LocalFilePreviewContext);
  if (!ctx) {
    throw new Error("useLocalFilePreview 必须在 LocalFilePreviewProvider 内使用");
  }
  return ctx;
};

/** 供 LocalFileLink 用的路径解析（与 IDE 链接同一套 baseDir 规则） */
export const resolveLocalFileAbsolute = (
  pathLike: string,
  baseDir?: string,
): { absolute: string; line?: number } | null => resolveIdeTarget(pathLike, baseDir);
