"use client";

/**
 * 公共 hook：文件 / 目录路径附件（v1.1.x 抽、chat 输入岛 + task「跟 AI 说」条共用）
 *
 * 跟 use-image-attach 平行的一套：原生 picker（pickNativePaths）选绝对路径、
 * 去重 + 上限截断（带 toast、两个调用方行为统一）、发送后 reset。
 * 路径本身就是字符串、不上传内容——server 侧 stat 校验后拼 [ATTACHED_PATHS] 给 agent read。
 */

import { useCallback, useState } from "react";
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
  /** 发送成功 / 切上下文时清空 */
  reset: () => void;
}

export const usePathAttach = (): UsePathAttachReturn => {
  // 待发送的文件 / 目录绝对路径列表（原生 picker 选的）
  const [paths, setPaths] = useState<string[]>([]);
  // picker 飞行中标记（存 mode 让被点的那颗按钮转 spinner——mac osascript 有 ~1s 冷启动）
  const [picking, setPicking] = useState<false | "file" | "folder">(false);

  // 回调全部 useCallback（稳定引用）：调用方可安全放进 useEffect 依赖（如切 task 时 reset）
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
      setPaths((prev) => {
        const set = new Set(prev);
        let dup = 0;
        for (const p of got) {
          if (set.has(p)) dup++;
          else set.add(p);
        }
        const merged = Array.from(set);
        if (dup > 0) toast.info(`已忽略 ${dup} 条重复路径`);
        if (merged.length > MAX_PATHS) {
          toast.warning(`路径数超上限 ${MAX_PATHS}、已截断到前 ${MAX_PATHS} 条`);
          return merged.slice(0, MAX_PATHS);
        }
        return merged;
      });
    } finally {
      setPicking(false);
    }
  }, []);

  const removePath = useCallback(
    (p: string) => setPaths((prev) => prev.filter((x) => x !== p)),
    [],
  );

  const reset = useCallback(() => setPaths([]), []);

  return { paths, picking, pickPaths, removePath, reset };
};
