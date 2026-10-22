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

import { Suspense, use, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Loader2, RefreshCw, Rocket } from "lucide-react";

import { TaskLaunchForm } from "@/components/tasks/task-launch-form";
import { WorkitemDetail } from "@/components/feishu/workitem-detail";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Separator } from "@/components/ui/separator";
import { useTaskList } from "@/hooks/use-task-list";
import {
  decideWorkitemGate,
  findExistingWorkitemTask,
  safeHttpUrl,
} from "@/lib/workitem-link";
import type { Task } from "@/lib/types";

const WorkitemPreviewInner = ({ params }: { params: Promise<{ id: string }> }) => {
  const { id } = use(params);
  const router = useRouter();
  const sp = useSearchParams();
  const projectKey = sp.get("project") ?? undefined;
  const name = sp.get("name") ?? "";
  // query 可被任意构造：只放行 http(s) 链接（拒绝 javascript: / data: 等），非法当没有链接
  const url = safeHttpUrl(sp.get("url"));
  const { tasks, loaded, loadError, refresh, upsertTask } = useTaskList();
  // 列表加载失败后的重试中（按钮转圈 + 防连点）
  const [retrying, setRetrying] = useState(false);
  // 用户明确选择「仍要新建」后才放出表单（匹配口径再准也可能有误判 / 用户就是想再建一个）
  const [forceNew, setForceNew] = useState(false);
  // 表单已放出过的工作项 id：放出后即使之后才匹配到已有任务也不卸载表单（防丢已填内容）；记 id 是为切到别的工作项时自动失效
  const [formShownFor, setFormShownFor] = useState<string | null>(null);

  // 兜底防重复建：该工作项已有任务（看板正常不会带进来、直开 URL 场景）→ 提示直进，
  // 但永远留「仍要新建」出口。id 只从详情链接路径里取、再补归一化链接比对（口径见 workitem-link.ts）
  const existing = useMemo(
    () => findExistingWorkitemTask(tasks, { id, url }),
    [tasks, id, url],
  );

  // 启动区四态：任务列表首次加载完成前一律 loading——此时 tasks 为空、existing 必然查不到，
  // 先放表单会在匹配上后被卸载（丢输入 / 误建重复任务，N9-02）；
  // 列表首拉失败（loaded 但没数据 + 有 loadError）→ error：同样查不到 existing、
  // 放表单会让用户对已有任务的需求重复启动（F3-03），所以只画「加载失败 + 重试」
  const gate = decideWorkitemGate({
    loaded,
    existing,
    forceNew,
    formShown: formShownFor === id,
    loadError,
    taskCount: tasks.length,
  });

  // 表单一旦放出就记下来：之后轮询 / 别的窗口建了同一工作项的任务也只补提示、不收回表单
  useEffect(() => {
    if (gate === "form") setFormShownFor(id);
  }, [gate, id]);

  const handleCreated = (task: Task) => {
    upsertTask(task);
    router.replace(`/tasks/${task.id}`);
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 overflow-y-auto px-6 py-5">
      {/* 顶部：返回工作台 */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/")} className="gap-1 px-2">
          <ChevronLeft className="size-4" />
          返回
        </Button>
        <Separator orientation="vertical" className="h-4" />
        <span className="text-sm text-muted-foreground">工作项预览</span>
      </div>

      {/* 工作项详情（需求原文） */}
      <WorkitemDetail workItemId={id} projectKey={projectKey} url={url || undefined} />

      <Separator />

      {/* 启动配置区 / 已有任务直进；任务列表加载完成前只给占位、不渲染表单 */}
      {gate === "loading" && (
        <LoadingState variant="card" label="正在检查该工作项是否已有任务…" />
      )}
      {gate === "error" && (
        // 与侧栏 / 对话落点同款失败态：亮出原因 + 重试；不画启动表单（查不了「是否已有任务」）。
        // 重试成功后 loadError 清掉，gate 自动转成 existing / form
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed px-3 py-4 text-center">
          <p className="text-xs text-destructive">任务列表加载失败：{loadError}</p>
          <p className="text-xs text-muted-foreground">
            没法确认这个工作项是否已有任务，先不显示启动表单，免得重复启动。
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void refresh().finally(() => setRetrying(false));
            }}
          >
            {retrying ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            重试
          </Button>
        </div>
      )}
      {gate !== "loading" && existing && (
        <div className="flex items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
          <Rocket className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            已存在相关任务：
            <Link
              href={`/tasks/${existing.id}`}
              className="underline hover:text-foreground"
            >
              {existing.title}
            </Link>
          </span>
          {/* 表单已展开（点过「仍要新建」或之前就放出了）时不再给这个按钮 */}
          {gate === "existing" && (
            <Button size="sm" variant="outline" onClick={() => setForceNew(true)}>
              仍要新建
            </Button>
          )}
          <Button size="sm" render={<Link href={`/tasks/${existing.id}`}>进入任务</Link>} />
        </div>
      )}
      {gate === "form" && (
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
