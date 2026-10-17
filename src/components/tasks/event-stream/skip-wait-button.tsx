"use client";

/**
 * 工具块上的「跳过等待」按钮（`wait` 工具运行中才画，条件见 `isSkippableWaitBlock`）。
 *
 * 叫醒这个任务里正在睡的 `wait`：模型收到 `[WAIT_SKIPPED]` 后继续往下做。**不是终止这一轮**——
 * run 的上下文和后续步骤都在，所以这里只调 `skipWait`（叫醒），不碰停止接口。
 *
 * task 形态没有状态行，用户想让模型别再睡了只能靠这个按钮（否则唯一出路是「停止」、会连 action 一起杀掉）；
 * chat 形态下状态行上也有一个，两处叫醒的是同一批 wait、幂等。
 */

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { skipWait } from "@/lib/task-store";

export const SkipWaitButton = ({ taskId }: { taskId: string }) => {
  const [skipping, setSkipping] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={skipping}
      onClick={async () => {
        // 点了就禁用、处理完恢复：别让人连点出一串请求。
        // 成功后不用提示——工具块靠事件流里 wait 的 tool_result 自己切走、按钮随之消失；
        // woken=0（刚好到点自己醒了）也不是错误，同样不提示
        setSkipping(true);
        try {
          await skipWait(taskId);
        } catch (err) {
          toast.error(`跳过等待失败：${(err as Error).message}`);
        } finally {
          setSkipping(false);
        }
      }}
    >
      跳过等待
    </Button>
  );
};
