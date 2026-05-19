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
 * V0.5.4 加贴图：用户可粘贴 / 拖拽 / 点附图按钮挂图片、随 feedback 一起发给 agent。
 * agent 拿到 [PHASE_ACK revise] + [ATTACHED_IMAGES] 后先 `read` 图、再 ask_user 复述意图。
 *
 * 不抽公共 hook 的取舍：当前只本组件用、EventStream 那边已稳定运行不动；以后如果
 * EventStream 也要重构、再统一抽 `useImageAttach` hook（约定见 learned-conventions.mdc
 * 「复用 >= 2 且省 30+ 行才抽」）。
 *
 * 对外 API 收敛到：open / onOpenChange / phaseLabel / submitting / onSubmit(feedback, images)。
 */

import { memo, useEffect, useRef, useState } from "react";
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
import type { ChatReplyImage } from "@/lib/task-store";

// 跟 event-stream.tsx / 后端 task-fs.ts 保持一致的图片约束
const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_PER_REPLY = 6;

// 待发送的图片附件：发送后清空
interface PendingImage {
  id: string;
  file: File;
  dataUrl: string; // 含 mime 前缀、给 <img> src 预览用
  data: string; // 纯 base64（不带前缀）、POST body 用
  mimeType: string;
}

// FileReader.readAsDataURL Promise 化
const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("读文件失败"));
    reader.readAsDataURL(file);
  });

const stripDataUrlPrefix = (dataUrl: string): string => {
  const idx = dataUrl.indexOf("base64,");
  return idx >= 0 ? dataUrl.slice(idx + "base64,".length) : dataUrl;
};

const newPendingId = (): string =>
  `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // 当前 phase 的中文展示文案（用于标题 / placeholder 中拼接）
  phaseLabel: string;
  // 提交锁（父组件持、防连点）、submitting 时按钮 disable
  submitting: boolean;
  // 提交回调：父组件实际调用 submitPhaseAck("revise", feedback, ..., images)
  // 父侧成功后自行 setReviseOpen(false)；失败保持 dialog 开、用户能调整重发
  // images 可为 undefined（用户没附图）
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
  // 待发送的图片附件列表（粘贴 / 拖拽 / 选文件三种途径添进来）
  const [attachedImages, setAttachedImages] = useState<PendingImage[]>([]);
  // 拖拽状态：drag over 时输入区高亮、给视觉反馈
  const [isDragging, setIsDragging] = useState(false);
  // 隐藏 <input type="file">、点击附图按钮触发它
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 关闭时清空草稿 + 附图、避免下次再开时还显示上次的输入
  useEffect(() => {
    if (!open) {
      setDraft("");
      setAttachedImages([]);
      setIsDragging(false);
    }
  }, [open]);

  /**
   * 把 File[] 转成 PendingImage[] 加进 attachedImages
   * 校验：mimeType 白名单 / 单图 size / 总张数上限（任一失败 → toast + 跳过该图）
   */
  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const remainingSlots = MAX_IMAGES_PER_REPLY - attachedImages.length;
    if (remainingSlots <= 0) {
      toast.error(`最多附 ${MAX_IMAGES_PER_REPLY} 张图、先移除几张再加`);
      return;
    }
    const toProcess = files.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
      toast.warning(
        `图太多、超出上限 ${MAX_IMAGES_PER_REPLY} 张、已截断到 ${remainingSlots} 张`,
      );
    }
    const additions: PendingImage[] = [];
    for (const file of toProcess) {
      if (!ALLOWED_IMAGE_MIMES.has(file.type)) {
        toast.error(
          `${file.name || "(未命名)"} 不是支持的图片格式（${file.type || "未知"}）`,
        );
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast.error(
          `${file.name || "(未命名)"} 太大（${(file.size / 1024 / 1024).toFixed(2)} MB > ${MAX_IMAGE_BYTES / 1024 / 1024} MB）`,
        );
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        additions.push({
          id: newPendingId(),
          file,
          dataUrl,
          data: stripDataUrlPrefix(dataUrl),
          mimeType: file.type,
        });
      } catch (err) {
        toast.error(
          `读 ${file.name || "(未命名)"} 失败：${(err as Error).message}`,
        );
      }
    }
    if (additions.length > 0) {
      setAttachedImages((prev) => [...prev, ...additions]);
    }
  };

  // 粘贴：clipboardData.items 里可能含 image（截图工具粘贴 / 浏览器右键复制图片）
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  // 拖拽：dragenter / dragover 标 isDragging + preventDefault（不然 drop 不触发）
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setIsDragging(true);
    }
  };
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // 子元素 dragleave 会冒泡、用 relatedTarget 判断「真离开了输入区」才置 false
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragging(false);
  };
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length > 0) void addFiles(files);
  };

  // 附图按钮：触发隐藏 input file 的 click、选完文件回调 onChange
  const handleAttachClick = () => fileInputRef.current?.click();
  const handleFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    void addFiles(files);
    e.target.value = ""; // 清掉、不然连选同一张图不触发 onChange
  };

  const handleRemoveImage = (id: string) => {
    setAttachedImages((prev) => prev.filter((p) => p.id !== id));
  };

  const canSubmit =
    !submitting && (draft.trim().length > 0 || attachedImages.length > 0);

  const handleSubmit = () => {
    if (!canSubmit) return;
    const images: ChatReplyImage[] | undefined =
      attachedImages.length > 0
        ? attachedImages.map((p) => ({
            data: p.data,
            mimeType: p.mimeType,
            filename: p.file.name,
          }))
        : undefined;
    void onSubmit(draft.trim(), images);
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
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* 缩略图区：发送前可移除单张 */}
          {attachedImages.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachedImages.map((img) => (
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
                    onClick={() => handleRemoveImage(img.id)}
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
            onPaste={handlePaste}
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
            onChange={handleFilePicked}
          />
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">
              {attachedImages.length > 0
                ? `图 ${attachedImages.length}/${MAX_IMAGES_PER_REPLY}`
                : "可粘贴 / 拖拽截图、或点附图"}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleAttachClick}
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
