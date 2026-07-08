"use client";

/**
 * 任务页统一「跟 AI 说」输入条（V0.11.9、事件流底部常驻）
 *
 * 用户拍板的入口合一（原「再聊聊」弹窗 + 「问一问」输入条 90% 重复、二合一）：
 * 一个输入条、系统按任务状态自动懂语境：
 * - 当前产出在等审阅（awaiting_ack）→ 按「再聊聊」送（[ACTION_ACK revise]、
 *   agent 自己二分类：纯疑问就答疑、改动意见就改完重新交卷）
 * - 其他时刻 → 纯提问（[USER_QUESTION]、只答不动手不动任务进度）
 * - 会话接不回 → 服务端自动起一次性答疑 agent 兜底（带任务上下文、只读）
 * - 显式选了模型 → 一律走一次性答疑 agent（存活会话的模型锁死换不了）
 *
 * 支持贴图（粘贴 / 附图按钮）——「改成这样」+ 截图是再聊聊高频用法。
 * agent 正在跑时禁用；任务终态整条隐藏。
 */

import { useMemo, useState } from "react";
import { ImagePlus, Loader2, MessageCircleQuestion, Send, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ImageThumb } from "@/components/ui/image-preview";
import { ModelSelect } from "@/components/ui/model-select";
import { Textarea } from "@/components/ui/textarea";
import { useImageAttach } from "@/hooks/use-image-attach";
import { useModels } from "@/hooks/use-models";
import { useSubmitShortcut } from "@/hooks/use-settings";
import { getSettings } from "@/lib/local-store";
import { shouldSubmitOnKeyDown } from "@/lib/submit-shortcut";
import { submitActionAck, submitTaskQuestion } from "@/lib/task-store";
import type { ModelSelection, Task } from "@/lib/types";

interface Props {
  task: Task;
  // 提交成功后父组件用返回的最新 task 刷状态（running 态 UI 立即切）
  onTaskUpdate: (next: Task) => void;
}

export const TaskTalkComposer = ({ task, onTaskUpdate }: Props) => {
  // 草稿
  const [draft, setDraft] = useState("");
  // 请求飞行中：防双击
  const [submitting, setSubmitting] = useState(false);
  // 显式指定的答疑模型（id 空 = 跟随会话；选了 = 一次性答疑 agent 用它答）
  const [pickedModel, setPickedModel] = useState<ModelSelection>({ id: "" });
  const submitShortcut = useSubmitShortcut();
  // 模型列表：打开选择器时按需拉（SWR 缓存、不重复打网络）
  const { models, fetchModels } = useModels();
  // 贴图（粘贴 / 选文件）——revise 高频带截图
  const attach = useImageAttach({ maxImages: 6, disabled: submitting });

  // 当前产出是否在等审阅：是 → 输入按「再聊聊」送、agent 二分类处理
  const currentAction = useMemo(
    () => task.actions.find((a) => a.id === task.currentActionId) ?? null,
    [task],
  );
  const canAck =
    !!currentAction &&
    currentAction.status === "awaiting_ack" &&
    task.runStatus === "awaiting_user";

  // agent 在跑时不可说；任务终态整条隐藏
  const busy = submitting || task.runStatus === "running";

  const handleSubmit = async () => {
    const text = draft.trim();
    if ((!text && attach.images.length === 0) || busy) return;
    setSubmitting(true);
    try {
      const images = attach.toUploadPayload();
      // 等审阅且没显式换模型 → revise 通道（agent 二分类：问就答、改就改完重新交卷）；
      // 否则 → 问一问通道（只答不动手；显式选模型 = 一次性答疑 agent）
      const updated =
        canAck && !pickedModel.id
          ? await submitActionAck(task.id, currentAction!.id, "revise", {
              feedback: text,
              images,
            })
          : await submitTaskQuestion(
              task.id,
              text,
              images,
              pickedModel.id ? pickedModel : undefined,
            );
      onTaskUpdate(updated);
      setDraft("");
      attach.reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // 终态没有可说的对象、整条隐藏
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
          onPaste={attach.onPaste}
          onKeyDown={(e) => {
            if (shouldSubmitOnKeyDown(e, submitShortcut)) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={
            canAck
              ? "跟 AI 说：改意见或提问（针对当前产出、可贴图）"
              : "问一问（只回答、不改代码、不影响任务进度）"
          }
          rows={1}
          disabled={busy}
          className="min-h-8 resize-none border-0 bg-transparent px-1 py-1.5 text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={attach.triggerFilePicker}
          disabled={busy || attach.images.length >= attach.maxImages}
          aria-label="附图"
          title="附图（也可直接粘贴）"
          className="mb-1 shrink-0 text-muted-foreground/70"
        >
          <ImagePlus />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => void handleSubmit()}
          disabled={busy || (draft.trim().length === 0 && attach.images.length === 0)}
          aria-label="发送"
          title="发送"
          className="mb-1 shrink-0 text-muted-foreground"
        >
          {submitting ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
        <input
          ref={attach.fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={attach.onFileInputChange}
        />
      </div>

      {/* 已贴的图（发送前可移除、点击看大图） */}
      {attach.images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-1 pl-8">
          {attach.images.map((img, i) => (
            <ImageThumb
              key={img.id}
              src={img.dataUrl}
              alt={img.file.name}
              className="size-10 rounded bg-background"
              onRemove={() => attach.removeImage(img.id)}
              group={attach.images.map((im) => ({
                src: im.dataUrl,
                alt: im.file.name,
              }))}
              index={i}
            />
          ))}
        </div>
      )}

      {/* 答疑模型（可选）：默认跟随会话；显式选了 = 单独起答疑 agent 用它答 */}
      <div className="flex items-center gap-1 px-3 pb-1.5 pl-8">
        <ModelSelect
          models={models}
          selection={pickedModel}
          onChange={setPickedModel}
          disabled={busy}
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
