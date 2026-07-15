"use client";

/**
 * 手动建任务页：看板「手动建任务」入口 + 收件箱「改bug」引流入口
 *
 * 手动路径：不经飞书排期预览——标题 / 飞书链接都手填（有些需求没排到甘特、看板上没有入口）。
 * 引流路径（2026-07-15）：收件箱 bug 无对应开发中任务时带 query 进来——
 *   ?fixBug=1&name=<bug 名>&url=<story 或 bug URL>&bugUrl=<bug URL>&storyName=<关联需求名>
 *   标题 / 飞书链接预填、创建成功后跳任务页深链打开推进弹窗（预选「改bug」、用户确认后启动）；
 *   预置 action / skill 被删 → confirm 重建后再跳深链。
 * 启动表单复用 TaskLaunchForm。
 */

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Bug } from "lucide-react";
import { toast } from "sonner";

import { TaskLaunchForm } from "@/components/tasks/task-launch-form";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { LoadingState } from "@/components/ui/loading-state";
import { useDialog } from "@/hooks/use-dialog";
import { useMrInbox } from "@/hooks/use-mr-inbox";
import { useTaskList } from "@/hooks/use-task-list";
import {
  checkFixBugPreset,
  reinstallFixBugPreset,
} from "@/lib/fix-bug-advance";
import type { Task } from "@/lib/types";

const ManualLaunchInner = () => {
  const router = useRouter();
  const sp = useSearchParams();
  const { upsertTask } = useTaskList();
  const { setSeen } = useMrInbox();
  const { confirm } = useDialog();

  // 收件箱「改bug」引流参数（无参 = 纯手动建任务、行为不变）
  const fixBug = sp.get("fixBug") === "1";
  const bugName = sp.get("name") ?? "";
  const prefillUrl = sp.get("url") ?? "";
  const bugUrl = sp.get("bugUrl") ?? "";
  const storyName = sp.get("storyName") ?? undefined;
  const isFixBugFlow = fixBug && !!bugUrl;

  const handleCreated = (task: Task) => {
    upsertTask(task);
    if (!isFixBugFlow) {
      router.replace(`/tasks/${task.id}`);
      return;
    }
    // 创建后跳深链打开推进弹窗（预选改bug、用户确认后启动——不再自动 POST advance）
    void (async () => {
      try {
        let status = await checkFixBugPreset();
        if (status === "missing") {
          const ok = await confirm({
            title: "重建「改bug」预置？",
            description:
              "改bug 预置不可用。重建将恢复出厂版本（覆盖对该 action 的修改）。",
            confirmLabel: "重建",
          });
          if (!ok) {
            router.replace(`/tasks/${task.id}`);
            return;
          }
          await reinstallFixBugPreset();
          status = await checkFixBugPreset();
          if (status === "missing") {
            toast.error("重建后预置仍缺失、请到能力页检查");
            router.replace(`/tasks/${task.id}`);
            return;
          }
        }
        void setSeen(bugUrl, true);
        toast.success("任务已创建");
        const q = new URLSearchParams({
          advance: "fix-bug",
          bugTitle: bugName,
          bugUrl,
          ...(storyName ? { storyName } : {}),
        });
        router.replace(`/tasks/${task.id}?${q.toString()}`);
      } catch (err) {
        toast.error(
          `任务已创建、但打开改bug失败：${err instanceof Error ? err.message : String(err)}`,
        );
        router.replace(`/tasks/${task.id}`);
      }
    })();
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 overflow-y-auto px-6 py-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/")} className="gap-1 px-2">
          <ArrowLeft className="size-4" />
          看板
        </Button>
        <Separator orientation="vertical" className="h-4" />
        <span className="text-sm text-muted-foreground">
          {isFixBugFlow ? "新建改bug任务" : "手动建任务"}
        </span>
      </div>

      {isFixBugFlow && (
        <div className="flex items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          <Bug className="size-4 shrink-0 text-amber-600 dark:text-amber-500" />
          <span className="min-w-0 flex-1">
            将修复：
            <a
              href={bugUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium hover:underline"
            >
              {bugName || bugUrl}
            </a>
            {storyName ? `（关联：${storyName}）` : ""}
          </span>
        </div>
      )}

      <TaskLaunchForm
        initialTitle={isFixBugFlow ? `改bug：${bugName}` : ""}
        feishuStoryUrl={prefillUrl}
        onCreated={handleCreated}
      />
    </div>
  );
};

const ManualLaunchPage = () => (
  <Suspense fallback={<LoadingState variant="block" />}>
    <ManualLaunchInner />
  </Suspense>
);

export default ManualLaunchPage;
