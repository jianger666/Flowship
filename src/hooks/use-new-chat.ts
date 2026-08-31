"use client";

/**
 * useNewChat：一键新建自由对话（V0.8、侧栏 + 首页共用）
 *
 * 对齐 Codex / Cursor Agent Window 的零表单入口——不弹表单、直接进详情。
 * 已有没说过话的空草稿时复用（切走再点新建 / Cmd+N 不再堆空窗口）。
 *
 * 可选 options.repoPaths：侧栏组头「+」预绑该仓；缺省 / 空 = 不绑（Home）。
 * 复用空草稿且指定了目录时，若草稿绑的不是这个目录会改绑再打开。
 */

import { useState } from "react";
import { toast } from "sonner";

import { useTaskList } from "@/hooks/use-task-list";
import { getSettings } from "@/lib/local-store";
import {
  findUnusedDraftChat,
  sameRepoPaths,
} from "@/lib/task-display";
import { createTask, setTaskRepoPaths } from "@/lib/task-store";
import {
  defaultModelForProvider,
  type Task,
  type TaskSummary,
} from "@/lib/types";
import { promoteSidebarChat } from "@/lib/view-memory";

export type CreateChatOptions = {
  /** 预绑工作目录；不传或 [] = Home（不绑仓） */
  repoPaths?: string[];
};

export const useNewChat = (
  onCreated: (task: Task | TaskSummary) => void,
) => {
  // 创建飞行中：防双击连建俩
  const [creating, setCreating] = useState(false);
  const { tasks } = useTaskList();

  const createChat = async (options?: CreateChatOptions) => {
    if (creating) return;
    setCreating(true);
    try {
      const repoPaths = options?.repoPaths ?? [];
      const unused = findUnusedDraftChat(tasks, repoPaths);
      if (unused) {
        if (
          options?.repoPaths &&
          !sameRepoPaths(unused.repoPaths, repoPaths)
        ) {
          const latest = await setTaskRepoPaths(unused.id, repoPaths);
          promoteSidebarChat(latest.id);
          onCreated(latest);
        } else {
          promoteSidebarChat(unused.id);
          onCreated(unused);
        }
        return;
      }

      const s = getSettings();
      const defaultModel = defaultModelForProvider(s);
      const model = defaultModel?.id?.trim() ? defaultModel : undefined;
      const task = await createTask({
        mode: "chat",
        title: "",
        repoPaths,
        model,
        provider: s.provider,
        // 跟随设置页「默认禁用 MCP」黑名单（对齐 task 模式 new-task-dialog），
        // 不传 = 黑名单空 = 全部 MCP 启用、不符合用户在设置页配的默认
        disabledMcpServers:
          s.disabledMcpServers && s.disabledMcpServers.length > 0
            ? s.disabledMcpServers
            : undefined,
      });
      promoteSidebarChat(task.id);
      onCreated(task);
    } catch (err) {
      toast.error(`新建对话失败：${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  return { createChat, creating };
};
