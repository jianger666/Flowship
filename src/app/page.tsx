"use client";

/**
 * 首页：轻量欢迎页（V0.8 侧栏导航、V0.8.x 加自由对话入口）
 *
 * 任务列表 / 切换全在左侧常驻侧栏——首页不堆列表（避免与侧栏重复信息）。
 * 只留居中「开始」入口：logo + 一句定位 + 新建对话（主）/ 新建任务（次）。
 * 「继续最近」已去掉（侧栏第一条就是最近、首页不重复）。
 */

import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import { NewTaskDialog } from "@/components/tasks/new-task-dialog";
import { Button } from "@/components/ui/button";
import { useNewChat } from "@/hooks/use-new-chat";
import { useTaskList } from "@/hooks/use-task-list";
import type { Task } from "@/lib/types";

const HomePage = () => {
  const router = useRouter();
  const { upsertTask } = useTaskList();

  // 新建后插入侧栏列表 + 跳详情
  const handleCreated = (task: Task) => {
    upsertTask(task);
    router.push(`/tasks/${task.id}`);
  };

  // 一键新建对话（跟侧栏共用 useNewChat hook）
  const { createChat, creating } = useNewChat(handleCreated);

  return (
    <div className="flex h-full items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-md flex-col items-center gap-8 text-center">
        {/* logo + 柔和光晕（signature、克制） */}
        <div className="relative">
          <div
            className="absolute -inset-8 rounded-full bg-primary/8 blur-3xl"
            aria-hidden
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="relative size-20" />
        </div>

        {/* 一句定位（中性、兼顾自由对话 + 结构化任务） */}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          今天想做点什么？
        </h1>

        {/* 开始：新建对话（主、一键零表单）/ 新建任务（次、走完整流程） */}
        <div className="flex items-center gap-3">
          <Button
            size="lg"
            className="rounded-full px-5"
            onClick={createChat}
            disabled={creating}
          >
            <Plus />
            新建对话
          </Button>
          <NewTaskDialog
            onCreated={handleCreated}
            trigger={
              <Button variant="outline" size="lg" className="rounded-full px-5">
                新建任务
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );
};

export default HomePage;
