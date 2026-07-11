"use client";

/**
 * /chats——对话模式落点（v1.0 胶囊双模式）
 *
 * 顶栏胶囊切到「对话」时来这：**自动跳最近一条对话**（对话的主体在详情页、
 * 落点页本身没内容价值、别让用户多点一下）；一条对话都没有时显示空态 +
 * 「新建对话」大按钮。跳转用 replace（落点页不进历史、返回键不会退回空壳）。
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MessageSquare, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { useNewChat } from "@/hooks/use-new-chat";
import { useTaskList } from "@/hooks/use-task-list";

const ChatsPage = () => {
  const router = useRouter();
  const { tasks, loaded, upsertTask } = useTaskList();
  // 跳转只做一次：列表轮询更新时不要反复 replace（用户可能已手动去了别的对话）
  const redirectedRef = useRef(false);

  const { createChat, creating } = useNewChat((task) => {
    upsertTask(task);
    router.push(`/tasks/${task.id}`);
  });

  const chats = tasks.filter((t) => t.mode === "chat");

  useEffect(() => {
    if (!loaded || redirectedRef.current || chats.length === 0) return;
    // 最近活跃的对话（updatedAt 倒序第一条）
    const latest = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    redirectedRef.current = true;
    router.replace(`/tasks/${latest.id}`);
  }, [loaded, chats, router]);

  if (!loaded) return <LoadingState variant="hero" />;

  // 有对话时 effect 会跳走、这里只在「一条对话都没有」时真正渲染
  if (chats.length > 0) return <LoadingState variant="hero" />;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-muted">
        <MessageSquare className="size-7 text-muted-foreground" />
      </div>
      <div className="text-center">
        <div className="text-sm font-medium">还没有对话</div>
        <div className="mt-1 text-xs text-muted-foreground">
          自由提问、临时 bug、代码探索都可以开一个对话
        </div>
      </div>
      <Button onClick={createChat} disabled={creating}>
        {creating ? <Loader2 className="animate-spin" /> : <Plus />}
        新建对话
      </Button>
    </div>
  );
};

export default ChatsPage;
