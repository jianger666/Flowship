"use client";

/**
 * chat 用户消息「原地编辑」的编辑框：正文 textarea + 图片（看得见、能删、能加）+ 取消 / 发送。
 *
 * 从 rows.tsx 抽出来，是因为图片编辑要挂 `useImageAttach`（粘贴 / 拖拽 / 选文件 / 缩略图带 ✕，
 * 跟输入框同一套）——只在真进入编辑态时才挂载，不让每个事件行都背一份 hook state。
 *
 * 图片的来源与去向：
 *  - 进入编辑：把原消息贴的图从 uploads 回读成 base64、放进编辑框（loadUserReplyImages）；
 *  - 编辑中：增删都只动这一组；用户把最后一张图删掉那一下记一个「亲手全删了」标记；
 *  - 发送：交给父组件的就是编辑框里最终这一组（可以是空数组 = 一张都不带），不再偷偷回读原消息的图。
 *
 * 行被虚拟列表卸载再挂回：图走附件快照还原（scope "edit"，见 lib/user-edit-images），
 * 正文草稿与「是否在编辑」由父组件走 useRowViewState，三者行为一致。
 * 挂回时要不要重读原图由 {@link shouldLoadOriginalImages} 定：快照有图 / 用户亲手全删了都不读；
 * 快照没了又没有「全删」标记（比如被全局 LRU 挤掉）就读回原图——绝不静默地带着 0 张图发出去（评审 R18-03）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ImageThumb } from "@/components/ui/image-preview";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { useImageAttach } from "@/hooks/use-image-attach";
import { useRowViewState } from "@/hooks/use-row-view-state";
import { useSubmitShortcut } from "@/hooks/use-settings";
import { uploadPayloadsToPending } from "@/lib/optimistic-submit";
import { shouldSubmitOnKeyDown } from "@/lib/submit-shortcut";
import type { ImagePayload } from "@/lib/task-store";
import type { TaskEvent } from "@/lib/types";
import {
  shouldLoadOriginalImages,
  USER_EDIT_IMAGES_CLEARED,
  userEditImagesSnapshotId,
} from "@/lib/user-edit-images";
import { cn } from "@/lib/utils";
import { loadAttachmentSnapshot } from "@/lib/view-memory";

import { loadUserReplyImages } from "./resend-payload";
import { extractUserReplyImages } from "./utils";

export interface UserEditFormProps {
  taskId: string;
  /** 被编辑的原消息：原图从它的 meta.images 回读 */
  ev: TaskEvent;
  draft: string;
  onDraftChange: (next: string) => void;
  /** 只有「点编辑按钮进入」才聚焦；虚拟列表卸载后重挂恢复编辑态不能抢焦点 */
  autoFocus: boolean;
  /** 父组件的发送飞行锁：发送中整块禁用 */
  submitting: boolean;
  /** 「用户亲手把图全删了」标记的存档 key（来自 userEditViewKeys；null = 不持久化） */
  imagesClearedKey: string | null;
  onCancel: () => void;
  /** 发送：text 已 trim；images = 编辑框里最终这一组（可为空数组） */
  onSubmit: (text: string, images: ImagePayload[]) => void;
}

export const UserEditForm = ({
  taskId,
  ev,
  draft,
  onDraftChange,
  autoFocus,
  submitting,
  imagesClearedKey,
  onCancel,
  onSubmit,
}: UserEditFormProps) => {
  const submitShortcut = useSubmitShortcut();

  // 要不要读原图（挂载那一刻的事实，见 shouldLoadOriginalImages）：
  //  - 快照里已有图 = 用户上次的编辑结果，以它为准；
  //  - 「亲手全删了」标记在 = 就是要空的；
  //  - 两样都没有（还没读过 / 快照被全局 LRU 挤掉了）= 读回原图。
  const originalCount = useMemo(
    () => extractUserReplyImages(ev.meta).length,
    [ev.meta],
  );
  const [clearedMark, setClearedMark] = useRowViewState<string>(
    imagesClearedKey,
    "",
  );
  const userCleared = clearedMark === USER_EDIT_IMAGES_CLEARED;
  const [mountSnapshotCount] = useState(
    () =>
      loadAttachmentSnapshot("edit", userEditImagesSnapshotId(taskId, ev.id))
        ?.images.length ?? 0,
  );
  // 本次挂载内读原图这件事做完了（读到几张都算；全部读不到也算，免得一直转圈——下次重挂会再试）
  const [originalsSettled, setOriginalsSettled] = useState(false);
  const loadingOriginals =
    !originalsSettled &&
    shouldLoadOriginalImages({
      originalCount,
      snapshotImageCount: mountSnapshotCount,
      userCleared,
    });

  const attach = useImageAttach({
    // 原图读进来之前不让贴 / 拖 / 选：否则读完整体替换会把刚贴的图盖掉
    disabled: submitting || loadingOriginals,
    persist: { scope: "edit", id: userEditImagesSnapshotId(taskId, ev.id) },
  });

  const evRef = useRef(ev);
  evRef.current = ev;
  const replaceAll = attach.replaceAll;
  useEffect(() => {
    if (!loadingOriginals) return;
    // 卸载（取消 / 滚出视口）后迟到的结果不落地：不写快照、也不置「读完了」，重挂会重新读
    let cancelled = false;
    void loadUserReplyImages(taskId, evRef.current)
      .catch(() => ({ images: [] as ImagePayload[], partial: true }))
      .then(({ images, partial }) => {
        if (cancelled) return;
        replaceAll(uploadPayloadsToPending(images));
        setOriginalsSettled(true);
        if (partial) toast.warning("部分附图未能载入编辑框");
      });
    return () => {
      cancelled = true;
    };
  }, [loadingOriginals, taskId, ev.id, replaceAll]);

  // 删图：删掉的是最后一张 = 用户亲手清空，记下标记（挂回来时据此不再读回原图）；
  // 只是快照被挤掉没有这个标记，挂回来会把原图读回来（见 shouldLoadOriginalImages）
  const removeImage = (imageId: string) => {
    const emptiesAll = attach.images.every((im) => im.id === imageId);
    attach.removeImage(imageId);
    if (emptiesAll) setClearedMark(USER_EDIT_IMAGES_CLEARED);
  };

  const trimmed = draft.trim();
  const imageCount = attach.images.length;
  // 允许「只有图、没有字」：输入框本来就能发纯图消息
  const canSubmit =
    !submitting && !loadingOriginals && (trimmed.length > 0 || imageCount > 0);
  const atLimit = imageCount >= attach.maxImages;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(trimmed, attach.toUploadPayload() ?? []);
  };

  const previewGroup = attach.images.map((im) => ({
    src: im.dataUrl,
    alt: im.file.name,
  }));

  return (
    <div
      className={cn(
        "rounded-2xl border border-ring bg-secondary p-2 shadow-sm",
        attach.isDragging && "border-primary/50 bg-primary/5",
      )}
      onDragOver={attach.onDragOver}
      onDragLeave={attach.onDragLeave}
      onDrop={attach.onDrop}
    >
      {(imageCount > 0 || loadingOriginals) && (
        <div className="flex flex-wrap items-center gap-2 px-1.5 pb-1 pt-0.5">
          {attach.images.map((img, i) => (
            <ImageThumb
              key={img.id}
              src={img.dataUrl}
              alt={img.file.name}
              className="size-12 rounded bg-background"
              onRemove={submitting ? undefined : () => removeImage(img.id)}
              group={previewGroup}
              index={i}
            />
          ))}
          {loadingOriginals && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              载入附图…
            </span>
          )}
        </div>
      )}
      <Textarea
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onPaste={attach.onPaste}
        autoFocus={autoFocus}
        disabled={submitting}
        className="max-h-64 min-h-[52px] resize-none border-none bg-transparent p-1.5 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!submitting) onCancel();
            return;
          }
          // 提交快捷键跟设置页偏好一致（helper 内部已处理 IME / enter vs mod-enter）
          if (shouldSubmitOnKeyDown(e, submitShortcut)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-1 flex items-center gap-1.5">
        <Tooltip
          content={
            atLimit
              ? `已达上限 ${attach.maxImages} 张`
              : "附图（也支持粘贴 / 拖拽）"
          }
        >
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="size-7 p-0 text-muted-foreground hover:text-foreground"
              disabled={submitting || loadingOriginals || atLimit}
              onClick={attach.triggerFilePicker}
              aria-label="附图"
            >
              <ImagePlus className="size-3.5" />
            </Button>
          </span>
        </Tooltip>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={submitting}
            onClick={onCancel}
          >
            取消
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={!canSubmit}
            onClick={submit}
          >
            {submitting ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Send className="size-3" />
            )}
            发送
          </Button>
        </div>
      </div>
      <input
        ref={attach.fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={attach.onFileInputChange}
      />
    </div>
  );
};
