"use client";

/**
 * 「再聊聊」对话框（V0.5.4 抽出、解决输入卡顿；V0.5.4 加贴图；V0.6 适配 action）
 *
 * 历史动机：原本 `draft` state 放在 `TaskDetailPage` 顶层、每次按键都触发整个 page
 * 重渲染、连带各子组件都参与 reconcile。EventStream 虽然 memo 过、但 SSE 持续
 * setTask(events) 会让 task 引用持续变化、memo 浅比较失效。
 *
 * 修法：把 draft + 提交逻辑下沉到本组件内部、父组件只持 open / onSubmit。
 *
 * V0.6 变更：
 *   - phaseLabel → actionLabel（action 模型）
 *   - submit 后父组件调用 submitActionAck("revise", feedback, ...)
 *   - ChatReplyImage → ImagePayload
 *
 * V0.6.33 变更（Windows 同事实测反馈）：模态弹窗 + 遮罩把方案文档整个挡住、
 * 用户写 revise 反馈时没法对照文档「摸瞎写」。改成**非模态右下角停靠**：
 *   - `modal={false}`：不锁滚动 / 不拦点击——弹窗开着可以滚动、选中左侧 artifact 文本
 *   - `disablePointerDismissal`：点外部不关、草稿不丢；Esc / X / 取消仍可关
 *   - `DialogDockedContent`：无遮罩、固定 bottom-right（见 ui/dialog.tsx）
 */

import { memo, useEffect, useState } from "react";
import { Loader2, Paperclip } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDockedContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ImageThumb } from "@/components/ui/image-preview";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useImageAttach } from "@/hooks/use-image-attach";
import { useSubmitShortcut } from "@/hooks/use-settings";
import {
  getSubmitShortcutHint,
  shouldSubmitOnKeyDown,
} from "@/lib/submit-shortcut";
import type { ImagePayload } from "@/lib/task-store";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // 当前 action 的中文展示文案（用于标题 / placeholder 中拼接）
  actionLabel: string;
  // 提交锁（父组件持、防连点）、submitting 时按钮 disable
  submitting: boolean;
  // 提交回调：父组件实际调用 submitActionAck("revise", feedback, ..., images)
  onSubmit: (feedback: string, images?: ImagePayload[]) => void | Promise<void>;
}

const ReviseDialogImpl = ({
  open,
  onOpenChange,
  actionLabel,
  submitting,
  onSubmit,
}: Props) => {
  // 留言草稿：抽到本组件内部、不上抛父组件
  // 打字时只触发本 dialog re-render、不会拖累整个详情页
  const [draft, setDraft] = useState("");
  // 跟聊天输入框共享同一提交偏好，避免用户在不同输入区切换心智。
  const submitShortcut = useSubmitShortcut();
  const submitShortcutHint = getSubmitShortcutHint(submitShortcut);

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

  // 跟 event-stream 输入框一致，按设置页个人偏好决定 Enter 语义。
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSubmitOnKeyDown(e, submitShortcut)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      modal={false}
      disablePointerDismissal
    >
      <DialogDockedContent>
        <DialogHeader>
          <DialogTitle>跟 AI 再聊聊 · {actionLabel}</DialogTitle>
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
          {/* 缩略图区：发送前可移除单张、点击站内看大图（多图左右切换） */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((img, i) => (
                <ImageThumb
                  key={img.id}
                  src={img.dataUrl}
                  alt={img.file.name}
                  className="size-16"
                  onRemove={() => removeImage(img.id)}
                  group={images.map((im) => ({
                    src: im.dataUrl,
                    alt: im.file.name,
                  }))}
                  index={i}
                />
              ))}
            </div>
          )}
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={onPaste}
            onKeyDown={handleKeyDown}
            rows={6}
            placeholder={`想改、想问、或者贴图说明（${submitShortcutHint}）`}
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
      </DialogDockedContent>
    </Dialog>
  );
};

// memo 包裹：父组件因为 SSE setTask 频繁 re-render 时、本组件 props
// 引用不变就跳过自身 re-render——这才是「打字不影响外部」之外的第二道防线
export const ReviseDialog = memo(ReviseDialogImpl);
