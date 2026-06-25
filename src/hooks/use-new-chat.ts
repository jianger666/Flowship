"use client";

/**
 * useNewChat：一键新建自由对话（V0.8、侧栏 + 首页共用）
 *
 * 对齐 codex / Cursor Agent Window 的零表单入口——不弹表单、直接建空 chat task 进详情。
 * 封装：防连点 state + 默认参数（空标题占位、不绑工作目录、模型 + MCP 黑名单取 settings 默认）+ 错误 toast。
 * onCreated 由调用方决定后续（插侧栏列表 + 跳详情）。
 */

import { useState } from "react";
import { toast } from "sonner";

import { getSettings } from "@/lib/local-store";
import { createTask } from "@/lib/task-store";
import type { Task } from "@/lib/types";

export const useNewChat = (onCreated: (task: Task) => void) => {
  // 创建飞行中：防双击连建俩
  const [creating, setCreating] = useState(false);

  const createChat = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const s = getSettings();
      const model = s.defaultModel?.id?.trim() ? s.defaultModel : undefined;
      const task = await createTask({
        mode: "chat",
        title: "",
        repoPaths: [],
        model,
        // 跟随设置页「默认禁用 MCP」黑名单（对齐 task 模式 new-task-dialog）、
        // 不传 = 黑名单空 = 全部 MCP 启用、不符合用户在设置页配的默认
        disabledMcpServers:
          s.disabledMcpServers && s.disabledMcpServers.length > 0
            ? s.disabledMcpServers
            : undefined,
      });
      onCreated(task);
    } catch (err) {
      toast.error(`新建对话失败：${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  return { createChat, creating };
};
