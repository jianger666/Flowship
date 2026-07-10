"use client";

/**
 * 工作项预览页（V0.14）：看板点没跑过的工作项 → 这里
 *
 * 预览态设计（用户拍板）：**点开只是预览、点「启动」才落盘建任务**——
 * 防止看板里随便点几个看看需求、就自动庸生一堆空任务脏数据。
 *
 * 布局：上 = 工作项详情（需求原文、不用跳飞书）、下 = 启动配置区（TaskLaunchForm、
 * 仓库/角色预填上次的、90% 场景一键启动）。
 *
 * query：?project=<projectKey>&name=<工作项名>&url=<详情页URL>
 */

import { Suspense, use, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Rocket } from "lucide-react";

import { TaskLaunchForm } from "@/components/tasks/task-launch-form";
import { WorkitemDetail } from "@/components/feishu/workitem-detail";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useTaskList } from "@/hooks/use-task-list";
import { extractFeishuStoryId } from "@/lib/branch-template";
import type { Task } from "@/lib/types";

const WorkitemPreviewInner = ({ params }: { params: Promise<{ id: string }> }) => {
  const { id } = use(params);
  const router = useRouter();
  const sp = useSearchParams();
  const projectKey = sp.get("project") ?? undefined;
  const name = sp.get("name") ?? "";
  const url = sp.get("url") ?? "";
  const { tasks, upsertTask } = useTaskList();

  // 兜底防重复建：该工作项已有任务（看板正常不会带进来、直开 URL 场景）→ 提示直进。
  // 精确比 story id（不用 includes、防短 id 子串误匹配、与 board join 同口径）
  const existing = useMemo(
    () =>
      tasks.find(
        (t) =>
          t.mode !== "chat" && extractFeishuStoryId(t.feishuStoryUrl) === id,
      ),
    [tasks, id],
  );

  const handleCreated = (task: Task) => {
    upsertTask(task);
    router.replace(`/tasks/${task.id}`);
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 overflow-y-auto px-6 py-5">
      {/* 顶部：返回看板 */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/")} className="gap-1 px-2">
          <ArrowLeft className="size-4" />
          看板
        </Button>
        <Separator orientation="vertical" className="h-4" />
        <span className="text-sm text-muted-foreground">工作项预览</span>
      </div>

      {/* 工作项详情（需求原文） */}
      <WorkitemDetail workItemId={id} projectKey={projectKey} url={url || undefined} />

      <Separator />

      {/* 启动配置区 / 已有任务直进 */}
      {existing ? (
        <div className="flex items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
          <Rocket className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            这个工作项已有任务「{existing.title}」
          </span>
          <Button size="sm" render={<Link href={`/tasks/${existing.id}`}>进入任务</Link>} />
        </div>
      ) : (
        <TaskLaunchForm
          initialTitle={name}
          feishuStoryUrl={url}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
};

// useSearchParams 必须包 Suspense（Next 15 构建约束 missing-suspense）
const WorkitemPreviewPage = ({ params }: { params: Promise<{ id: string }> }) => (
  <Suspense>
    <WorkitemPreviewInner params={params} />
  </Suspense>
);

export default WorkitemPreviewPage;
