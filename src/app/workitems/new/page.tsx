"use client";

/**
 * 手动建任务页：看板「手动建任务」入口
 *
 * 不经飞书排期预览——标题 / 飞书链接都手填（有些需求没排到甘特、看板上没有入口）。
 * 启动表单复用 TaskLaunchForm（无预填）。
 */

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { TaskLaunchForm } from "@/components/tasks/task-launch-form";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useTaskList } from "@/hooks/use-task-list";
import type { Task } from "@/lib/types";

const ManualLaunchPage = () => {
  const router = useRouter();
  const { upsertTask } = useTaskList();

  const handleCreated = (task: Task) => {
    upsertTask(task);
    router.replace(`/tasks/${task.id}`);
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 overflow-y-auto px-6 py-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/")} className="gap-1 px-2">
          <ArrowLeft className="size-4" />
          看板
        </Button>
        <Separator orientation="vertical" className="h-4" />
        <span className="text-sm text-muted-foreground">手动建任务</span>
      </div>

      <TaskLaunchForm initialTitle="" feishuStoryUrl="" onCreated={handleCreated} />
    </div>
  );
};

export default ManualLaunchPage;
