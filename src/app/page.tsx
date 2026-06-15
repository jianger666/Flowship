"use client";

/**
 * 首页：轻量欢迎页（V0.8 侧栏导航）
 *
 * 任务列表 / 切换全在左侧常驻侧栏——首页不再堆列表（避免与侧栏重复信息、V0.8 用户反馈「信息太多」）。
 * 只留一个居中的「开始」入口：logo + 一句定位 + 新建 / 继续最近。
 * 视觉走「柔和圆润」：logo 背后一圈光晕作 signature、CTA 用圆角药丸、整体居中。
 */

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Plus } from "lucide-react";

import { NewTaskDialog } from "@/components/tasks/new-task-dialog";
import { Button } from "@/components/ui/button";
import { useTaskList } from "@/hooks/use-task-list";
import type { Task } from "@/lib/types";

const HomePage = () => {
  const router = useRouter();
  const { tasks, upsertTask } = useTaskList();

  // 最近一个活跃任务——「继续最近」快捷入口（完整列表在侧栏、首页不再列）
  const recent = useMemo(
    () =>
      [...tasks]
        .filter((t) => !t.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0],
    [tasks],
  );

  // 新建后插入侧栏列表 + 跳详情
  const handleCreated = (task: Task) => {
    upsertTask(task);
    router.push(`/tasks/${task.id}`);
  };

  return (
    <div className="flex h-full items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-md flex-col items-center gap-8 text-center">
        {/* logo + 柔和光晕（signature、克制；用户要更暗——透明度降到 /8） */}
        <div className="relative">
          <div
            className="absolute -inset-8 rounded-full bg-primary/8 blur-3xl"
            aria-hidden
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="relative size-20" />
        </div>

        {/* 一句定位（首页频率低、不堆解释文案、只留一句） */}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          把需求交给 AI 跑完整流程
        </h1>

        {/* 开始：新建 / 继续最近（圆角药丸、视觉更圆润） */}
        <div className="flex items-center gap-3">
          <NewTaskDialog
            onCreated={handleCreated}
            trigger={
              <Button size="lg" className="rounded-full px-5">
                <Plus />
                新建任务
              </Button>
            }
          />
          {recent && (
            <Button
              variant="outline"
              size="lg"
              className="rounded-full px-5"
              onClick={() => router.push(`/tasks/${recent.id}`)}
            >
              继续最近
              <ArrowRight />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default HomePage;
