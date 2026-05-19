"use client";

/**
 * 「再聊聊」对话框（V0.5.4 抽出、解决输入卡顿；V0.5.4 加贴图）
 *
 * 历史动机：原本 `draft` state 放在 `TaskDetailPage` 顶层、每次按键都触发整个 page
 * 重渲染、连带 ArtifactPanel / ApprovePhaseDialog / ContextDocsPanel / TaskMcpPanel
 * / PhaseProgress 一堆子组件都参与 reconcile。EventStream 虽然 memo 过、但 SSE 持续
 * setTask(events) 会让 task 引用持续变化、memo 浅比较失效。打字时单次 keystroke
 * reconcile 时长 > 16ms、用户实测明显卡顿。
 *
 * 修法：把 draft + 提交逻辑下沉到本组件内部、父组件只持 open / onSubmit、
 * 打字不会上抛触发父 re-render。memo 包裹本组件、open 没变时父 re-render 也不重渲染本组件。
 *
 * V0.5.4 加贴图：图附件管理统一走 `useImageAttach` hook（同 event-stream 共用、避免重复）。
 * 用户可粘贴 / 拖拽 / 点附图按钮挂图、随 feedback 一起发给 agent。
 * agent 拿到 [PHASE_ACK revise] + [ATTACHED_IMAGES] 后先 `read` 图、再 ask_user 复述意图。
 */

import { memo, useEffect, useState } from "react";
import { Loader2, Paperclip, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useImageAttach } from "@/hooks/use-image-attach";
import type { ChatReplyImage } from "@/lib/task-store";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // 当前 phase 的中文展示文案（用于标题 / placeholder 中拼接）
  phaseLabel: string;
  // 提交锁（父组件持、防连点）、submitting 时按钮 disable
  submitting: boolean;
  // 提交回调：父组件实际调用 submitPhaseAck("revise", feedback, ..., images)
  // 父侧成功后自行 setReviseOpen(false)；失败保持 dialog 开、用户能调整重发
  onSubmit: (feedback: string, images?: ChatReplyImage[]) => void | Promise<void>;
}

const ReviseDialogImpl = ({
  open,
  onOpenChange,
  phaseLabel,
  submitting,
  onSubmit,
}: Props) => {
  // 留言草稿：抽到本组件内部、不上抛父组件
  // 打字时只触发本 dialog re-render、不会拖累整个详情页
  const [draft, setDraft] = useState("");

  // 图附件管理统一走 hook、跟 event-stream 共用
  const {
    images,
    isDragging,
    fileInputRef,
    maxImages,
    removeImage,
    reset: resetImages,
    triggerFilePicker,
    onPaste,
    onDragOver,
    onDragLeave,
    onDrop,
    onFileInputChange,
    toUploadPayload,
  } = useImageAttach();

  // 关闭时清空草稿 + 附图、避免下次再开时还显示上次的输入
  useEffect(() => {
    if (!open) {
      setDraft("");
      resetImages();
    }
    // resetImages 由 hook 创建、ref 每次 render 都新——故意只在 open 变化时跑、
    // 不需要 resetImages 进 deps（lint 不报警走 closure-stale 的边缘场景这里没问题）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const canSubmit = !submitting && (draft.trim().length > 0 || images.length > 0);

  const handleSubmit = () => {
    if (!canSubmit) {
      // 防御性：禁用按钮就不该被点；toast 仅给键盘 / accessibility 触发场景
      if (!draft.trim() && images.length === 0) {
        toast.error("留言或图至少给一个");
      }
      return;
    }
    void onSubmit(draft.trim(), toUploadPayload());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>跟 AI 再聊聊 · {phaseLabel}</DialogTitle>
        </DialogHeader>
        {/* 整片输入区支持拖拽：drag over 时整片轮廓变虚线提示 */}
        <div
          className={cn(
            "flex flex-col gap-2 rounded-md transition-colors",
            isDragging && "bg-primary/5 ring-1 ring-primary/30 ring-inset p-1",
          )}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {/* 缩略图区：发送前可移除单张 */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((img) => (
                <div
                  key={img.id}
                  className="group relative size-16 overflow-hidden rounded-md border bg-card"
                  title={img.file.name}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.dataUrl}
                    alt={img.file.name}
                    className="size-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="移除"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={onPaste}
            rows={6}
            placeholder="想改的地方、有疑问、想问问 AI——都行。可粘贴 / 拖拽 / 附图。AI 会先弹窗复述、再判断要不要动 artifact"
            autoFocus
          />
          {/* 隐藏 input：附图按钮触发它 */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={onFileInputChange}
          />
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">
              {images.length > 0
                ? `图 ${images.length}/${maxImages}`
                : "可粘贴 / 拖拽截图、或点附图"}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={triggerFilePicker}
              className="h-7 gap-1 px-2 text-xs"
              title="附图（也支持粘贴 / 拖拽）"
            >
              <Paperclip className="size-3.5" />
              附图
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="animate-spin" />}
            发给 AI
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// memo 包裹：父组件因为 SSE setTask 频繁 re-render 时、本组件 props
// 引用不变就跳过自身 re-render——这才是「打字不影响外部」之外的第二道防线
export const ReviseDialog = memo(ReviseDialogImpl);
