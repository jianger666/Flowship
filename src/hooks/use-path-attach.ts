"use client";

/**
 * 公共 hook：文件 / 目录路径附件（v1.1.x 抽、chat 输入岛 + task「跟 AI 说」条共用）
 *
 * 跟 use-image-attach 平行的一套：原生 picker（pickNativePaths）选绝对路径、
 * 去重 + 上限截断（带 toast、两个调用方行为统一）、发送后 reset。
 * 路径本身就是字符串、不上传内容——server 侧 stat 校验后拼 [ATTACHED_PATHS] 给 agent read。
 *
 * 另：粘贴超长文本走 addPastedText（POST paste-text → absPath → addAbsPath），
 * 与 picker 共用同一 paths 列表 / pill 展示。
 */

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { pickNativePaths } from "@/lib/native-picker";

// 单次最多附几条路径（跟 chat-reply / question 路由的上限对齐）
const MAX_PATHS = 10;

export interface UsePathAttachReturn {
  /** 待发送的绝对路径列表 */
  paths: string[];
  /** 原生 picker 调用中（防双击连开系统对话框、被点的按钮转 spinner） */
  picking: false | "file" | "folder";
  /** 打开原生 picker 选文件 / 目录、选完合并进列表 */
  pickPaths: (mode: "file" | "folder") => Promise<void>;
  removePath: (p: string) => void;
  /**
   * 追加一条已落盘的绝对路径（粘贴超长文本 API 返回的 absPath）。
   * 去重 + 上限；已满 / 重复时 toast 并返回 false。
   */
  addAbsPath: (p: string) => boolean;
  /**
   * 粘贴超长文本：POST /api/tasks/:id/paste-text → 成功则 push absPath。
   * 返 true = 已转附件；false = 失败（调用方应把原文插回编辑器，别丢内容）。
   */
  addPastedText: (taskId: string, content: string) => Promise<boolean>;
  /** 发送成功 / 切上下文时清空 */
  reset: () => void;
}

export const usePathAttach = (): UsePathAttachReturn => {
  // 待发送的文件 / 目录绝对路径列表（原生 picker 选的 / 粘贴文本落盘的）
  const [paths, setPaths] = useState<string[]>([]);
  // paths 的同步镜像：pickPaths / addPastedText 是 async 回调、闭包里的 paths 可能陈旧——合并前读 ref；
  // 也让 toast 副作用留在事件回调里、不进 setState updater（updater 必须纯、StrictMode 双调会弹两次）
  const pathsRef = useRef<string[]>([]);
  pathsRef.current = paths;
  // picker 飞行中标记（存 mode 让被点的那颗按钮转 spinner——mac osascript 有 ~1s 冷启动）
  const [picking, setPicking] = useState<false | "file" | "folder">(false);

  // 回调全部 useCallback（稳定引用）：调用方可安全放进 useEffect 依赖（如切 task 时 reset）
  const addAbsPath = useCallback((p: string): boolean => {
    const trimmed = p.trim();
    if (!trimmed) return false;
    if (pathsRef.current.includes(trimmed)) {
      toast.info("路径已在附件列表");
      return false;
    }
    if (pathsRef.current.length >= MAX_PATHS) {
      toast.warning(`路径数超上限 ${MAX_PATHS}、无法再附加`);
      return false;
    }
    const merged = [...pathsRef.current, trimmed];
    pathsRef.current = merged;
    setPaths(merged);
    return true;
  }, []);

  const addPastedText = useCallback(
    async (taskId: string, content: string): Promise<boolean> => {
      if (!taskId || !content) return false;
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/paste-text`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        let data: { error?: string; absPath?: string; ok?: boolean } = {};
        try {
          data = (await res.json()) as typeof data;
        } catch {
          // body 非 JSON 时仍走下方统一失败文案
        }
        if (!res.ok || !data.absPath) {
          toast.error(
            `粘贴转附件失败：${data.error ?? `HTTP ${res.status}`}`,
          );
          return false;
        }
        return addAbsPath(data.absPath);
      } catch (err) {
        toast.error(
          `粘贴转附件失败：${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    },
    [addAbsPath],
  );

  const pickPaths = useCallback(async (mode: "file" | "folder") => {
    setPicking(mode);
    try {
      const got = await pickNativePaths({
        mode,
        multiple: true,
        prompt:
          mode === "folder"
            ? "附加目录（agent 用 read 工具看）"
            : "附加文件（agent 用 read 工具看）",
      });
      if (!got || got.length === 0) return;
      // picking 闸保证同时只有一次 pick 在飞、基于 ref 合并无并发写风险
      const set = new Set(pathsRef.current);
      let dup = 0;
      for (const p of got) {
        if (set.has(p)) dup++;
        else set.add(p);
      }
      let merged = Array.from(set);
      if (merged.length > MAX_PATHS) {
        toast.warning(`路径数超上限 ${MAX_PATHS}、已截断到前 ${MAX_PATHS} 条`);
        merged = merged.slice(0, MAX_PATHS);
      } else if (dup > 0) {
        toast.info(`已忽略 ${dup} 条重复路径`);
      }
      pathsRef.current = merged;
      setPaths(merged);
    } finally {
      setPicking(false);
    }
  }, []);

  const removePath = useCallback(
    (p: string) => setPaths((prev) => prev.filter((x) => x !== p)),
    [],
  );

  const reset = useCallback(() => {
    pathsRef.current = [];
    setPaths([]);
  }, []);

  return {
    paths,
    picking,
    pickPaths,
    removePath,
    addAbsPath,
    addPastedText,
    reset,
  };
};
