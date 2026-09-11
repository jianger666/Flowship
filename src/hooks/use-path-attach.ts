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
import {
  loadAttachmentSnapshot,
  updateAttachmentSnapshot,
  type DraftScope,
} from "@/lib/view-memory";

// 单次最多附几条路径（跟 chat-reply / question 路由的上限对齐）
const MAX_PATHS = 10;

// 读快照恢复路径列表；无快照 / 无 persist 返回空（跟以前行为一致）
const restorePaths = (
  persist: { scope: DraftScope; id: string } | null,
): string[] => {
  if (!persist) return [];
  return (
    loadAttachmentSnapshot(persist.scope, persist.id)?.paths ?? []
  );
};

// 快照写穿：只换 paths、images 原样保留（走原子更新，跟 images 侧互不覆盖）
const persistPaths = (
  persist: { scope: DraftScope; id: string } | null,
  paths: string[],
): void => {
  if (!persist) return;
  updateAttachmentSnapshot(persist.scope, persist.id, (prev) => ({
    images: prev?.images ?? [],
    paths,
  }));
};

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
  /** 发送成功 / 切上下文时清空（restore() 传 skipPersist 只清 UI 不碰快照） */
  reset: (opts?: { skipPersist?: boolean }) => void;
  /** 整单替换（切任务回来时从快照恢复用；默认同步写穿快照，restore() 传 skipPersist 做 0 写恢复） */
  replaceAll: (paths: string[], opts?: { skipPersist?: boolean }) => void;
}

export interface UsePathAttachOptions {
  /**
   * 路径快照持久化（切页/切任务不丢）。不传 = 不持久化——
   * 弹窗 / 答题卡这类「关掉就该没了」的输入不该留快照。
   */
  persist?: { scope: DraftScope; id: string } | null;
}

export const usePathAttach = (
  options?: UsePathAttachOptions,
): UsePathAttachReturn => {
  const persist = options?.persist ?? null;
  // 当前快照 key 的同步镜像：pickPaths / addPastedText 跨 await 后回来可能已切任务——
  // 跟 use-image-attach 同套路：快照写调用时刻的 key，setState 只在 key 没变时做
  const persistRef = useRef(persist);
  persistRef.current = persist;
  // 待发送的文件 / 目录绝对路径列表（原生 picker 选的 / 粘贴文本落盘的）；
  // 有 persist 时初值从快照恢复（切页/切任务回来路径还在）
  const [paths, setPaths] = useState<string[]>(() =>
    restorePaths(persist),
  );
  // paths 的同步镜像：pickPaths / addPastedText 是 async 回调、闭包里的 paths 可能陈旧——合并前读 ref；
  // 也让 toast 副作用留在事件回调里、不进 setState updater（updater 必须纯、StrictMode 双调会弹两次）
  const pathsRef = useRef<string[]>([]);
  pathsRef.current = paths;
  // picker 飞行中标记（存 mode 让被点的那颗按钮转 spinner——mac osascript 有 ~1s 冷启动）
  const [picking, setPicking] = useState<false | "file" | "folder">(false);

  // 统一落盘：setState 只在快照 key 没变（或无 key）时做，切任务后回来的迟到
  // 合并只写旧任务快照、不碰当前屏幕（防路径串任务，跟 use-image-attach 同套路）
  const applyPaths = useCallback(
    (next: string[], snapScope?: DraftScope, snapId?: string) => {
      const cur = persistRef.current;
      const stillCurrent =
        !snapScope ||
        !snapId ||
        (cur?.scope === snapScope && cur?.id === snapId);
      if (stillCurrent) {
        pathsRef.current = next;
        setPaths(next);
      }
      if (snapScope && snapId) {
        persistPaths({ scope: snapScope, id: snapId }, next);
      }
    },
    [],
  );

  // 调用时刻的合并基准：有 key 时以那份快照为准（切任务后 ref 可能已是新任务的）
  const mergeBase = useCallback(
    (snapScope?: DraftScope, snapId?: string): string[] => {
      if (snapScope && snapId) {
        return (
          loadAttachmentSnapshot(snapScope, snapId)?.paths ?? []
        );
      }
      return pathsRef.current;
    },
    [],
  );

  // 回调全部 useCallback（稳定引用）：调用方可安全放进 useEffect 依赖（如切 task 时 reset）
  const addAbsPath = useCallback(
    (p: string): boolean => {
      const trimmed = p.trim();
      if (!trimmed) return false;
      const cap = persistRef.current;
      const base = mergeBase(cap?.scope, cap?.id);
      if (base.includes(trimmed)) {
        toast.info("路径已在附件列表");
        return false;
      }
      if (base.length >= MAX_PATHS) {
        toast.warning(`路径数超上限 ${MAX_PATHS}、无法再附加`);
        return false;
      }
      applyPaths([...base, trimmed], cap?.scope, cap?.id);
      return true;
    },
    [applyPaths, mergeBase],
  );

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
    // 调用时刻的 key：原生 picker 有 ~1s 冷启动，回来时用户可能已切任务
    const cap = persistRef.current;
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
      // picking 闸保证同时只有一次 pick 在飞；基准读调用时刻的快照（防串任务）
      const set = new Set(mergeBase(cap?.scope, cap?.id));
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
      applyPaths(merged, cap?.scope, cap?.id);
    } finally {
      setPicking(false);
    }
  }, [applyPaths, mergeBase]);

  const removePath = useCallback(
    (p: string) => {
      // 同步 ref：之前只 setPaths 不动 ref，后续合并会基于过期 ref 把删掉的路径复活
      const next = pathsRef.current.filter((x) => x !== p);
      const cap = persistRef.current;
      applyPaths(next, cap?.scope, cap?.id);
    },
    [applyPaths],
  );

  // 整单替换（切任务回来时从快照恢复用；默认同步写穿快照，restore() 传 skipPersist 做 0 写恢复）。
  // 调用方永远是“装回当前 key 的内容”，直接落 UI 即可（不需要 applyPaths 的 stillCurrent 分支）。
  const replaceAll = useCallback(
    (paths: string[], opts?: { skipPersist?: boolean }) => {
      const cap = persistRef.current;
      const next = [...paths];
      pathsRef.current = next;
      setPaths(next);
      if (!opts?.skipPersist && cap?.scope && cap?.id) {
        persistPaths({ scope: cap.scope, id: cap.id }, next);
      }
    },
    [],
  );

  const reset = useCallback((opts?: { skipPersist?: boolean }) => {
    // 有 persist 时同步写穿空快照（保留 images 那半）：跟 use-image-attach 同理；
    // restore() 传 skipPersist 只清 UI（0 写恢复、不污染 LRU）。空即删由 view-memory 兜底。
    const p = persistRef.current;
    if (!opts?.skipPersist && p) persistPaths(p, []);
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
    replaceAll,
  };
};
