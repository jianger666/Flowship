"use client";

/**
 * 任务内「问一问」输入条（V0.11.9、事件流底部）
 *
 * 用户痛点：想就任务问点问题、以前必须推进一个 action 再嘱咐「只回答别改代码」。
 * 这里发的消息走 POST /api/tasks/[id]/question：纯提问送给存活会话、
 * AI 只回答不改代码不动任务进度（约束内联在协议消息里、见 chat-pending question 分支）。
 *
 * 形态克制：单个 textarea + 发送按钮（不带图 / 附件、要发图走「再聊聊」）、
 * agent 正在跑时禁用。提交快捷键跟设置页偏好走。
 */

import { useState } from "react";
import { Loader2, MessageCircleQuestion, Send, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ModelSelect } from "@/components/ui/model-select";
import { Textarea } from "@/components/ui/textarea";
import { useModels } from "@/hooks/use-models";
import { useSubmitShortcut } from "@/hooks/use-settings";
import { getSettings } from "@/lib/local-store";
import { shouldSubmitOnKeyDown } from "@/lib/submit-shortcut";
import { submitTaskQuestion } from "@/lib/task-store";
import type { ModelSelection, Task } from "@/lib/types";

interface Props {
  task: Task;
  // 提交成功后父组件用返回的最新 task 刷状态（running 态 UI 立即切）
  onTaskUpdate: (next: Task) => void;
}

export const TaskQuestionComposer = ({ task, onTaskUpdate }: Props) => {
  // 提问草稿
  const [draft, setDraft] = useState("");
  // 请求飞行中：防双击
  const [submitting, setSubmitting] = useState(false);
  // 显式指定的答疑模型（id 空 = 跟随会话；选了 = 起一次性答疑 agent 用它答）
  const [pickedModel, setPickedModel] = useState<ModelSelection>({ id: "" });
  const submitShortcut = useSubmitShortcut();
  // 模型列表：打开选择器时按需拉（SWR 缓存、不重复打网络）
  const { models, fetchModels } = useModels();

  // agent 在跑 / 任务终态时不可问
  const disabled =
    submitting ||
    task.runStatus === "running" ||
    task.repoStatus === "merged" ||
    task.repoStatus === "abandoned";

  const handleSubmit = async () => {
    const text = draft.trim();
    if (!text || disabled) return;
    setSubmitting(true);
    try {
      const updated = await submitTaskQuestion(
        task.id,
        text,
        undefined,
        pickedModel.id ? pickedModel : undefined,
      );
      onTaskUpdate(updated);
      setDraft("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // 终态没有可问的对象、整条隐藏
  if (task.repoStatus === "merged" || task.repoStatus === "abandoned") {
    return null;
  }

  return (
    <div className="flex flex-col border-t">
      <div className="flex items-end gap-1.5 px-3 pt-2">
        <MessageCircleQuestion className="mb-2 size-3.5 shrink-0 text-muted-foreground/60" />
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (shouldSubmitOnKeyDown(e, submitShortcut)) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder="问一问（只回答、不改代码、不影响任务进度）"
          rows={1}
          disabled={submitting || task.runStatus === "running"}
          className="min-h-8 resize-none border-0 bg-transparent px-1 py-1.5 text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => void handleSubmit()}
          disabled={disabled || draft.trim().length === 0}
          aria-label="发送提问"
          title="发送提问"
          className="mb-1 shrink-0 text-muted-foreground"
        >
          {submitting ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </div>
      {/* 答疑模型（可选）：默认跟随会话；显式选了 = 单独起答疑 agent 用它答（会话模型换不了） */}
      <div className="flex items-center gap-1 px-3 pb-1.5 pl-8">
        <ModelSelect
          models={models}
          selection={pickedModel}
          onChange={setPickedModel}
          disabled={submitting || task.runStatus === "running"}
          variant="compact"
          emptyPlaceholder="模型 · 跟随会话"
          onOpenChange={(open) => {
            if (!open) return;
            const s = getSettings();
            if (s.apiKey?.trim() && models.length === 0) void fetchModels(s.apiKey);
          }}
        />
        {pickedModel.id && (
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setPickedModel({ id: "" })}
            aria-label="恢复跟随会话模型"
            title="恢复跟随会话模型"
            className="text-muted-foreground/60"
          >
            <X />
          </Button>
        )}
      </div>
    </div>
  );
};
