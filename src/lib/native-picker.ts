"use client";

/**
 * 原生文件 / 文件夹选择器的客户端封装（V0.7.13）
 *
 * POST /api/fs/pick-native、server 同机弹系统原生 picker。
 * 返回：选中的绝对路径数组；用户取消返 null（调用方静默即可）；
 * 出错 toast 后也返 null、调用方不用再处理错误分支。
 */

import { toast } from "sonner";

export const pickNativePaths = async (opts: {
  mode: "file" | "folder";
  multiple?: boolean;
  prompt?: string;
}): Promise<string[] | null> => {
  try {
    const res = await fetch("/api/fs/pick-native", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    const json = (await res.json()) as {
      paths?: string[];
      canceled?: boolean;
      error?: string;
    };
    if (!res.ok) {
      toast.error(json.error || "打开选择器失败");
      return null;
    }
    if (json.canceled || !json.paths?.length) return null;
    return json.paths;
  } catch (err) {
    toast.error(`打开选择器失败：${(err as Error).message}`);
    return null;
  }
};
