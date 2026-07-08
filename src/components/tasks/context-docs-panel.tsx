"use client";

/**
 * 任务级上下文文档（V0.3、V0.3.3 改成 button + dialog、V0.6.0.1 加贴图）
 *
 * 跟 SKILL.md 同思路：只 inject「清单」、agent 按需拉。
 * 用户在这里增删上下文文档（飞书 URL / 本地路径 / 自由文本 / 截图）、
 * agent 下次启动 / revise 时会看到这个清单、决定是否拉取。
 *
 * UI：
 *   - 外层只渲染紧凑 Button：「上下文文档 (N)」、点开弹 Dialog
 *   - Dialog 内：文档列表 + 内联添加表单（不再 sub-dialog、心智更轻）
 *   - 添加表单：title + content 主条目 + 贴图区（粘贴 / 拖拽 / 选文件）
 *   - 主条目跟贴图至少有一个、UI 允许仅贴图（title 自动用「贴图 N」、image 也常用）
 *
 * 节奏说明（V0.6）：
 *   - task.runStatus ∈ {running, awaiting_user} 时、加完 toast 提示「下次推进 action / revise 时生效」
 *   - 其他状态加完直接生效（下次 advance action 会拼最新清单）
 */

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  ImagePlus,
  Link2,
  Notebook,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ImageThumb } from "@/components/ui/image-preview";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useImageAttach } from "@/hooks/use-image-attach";
import { addContextDoc, removeContextDoc } from "@/lib/task-store";
import type { Task, TaskContextDoc, TaskContextDocType } from "@/lib/types";

const TITLE_PRESETS: string[] = ["后端技术方案"];

const renderTypeIcon = (type: TaskContextDocType) => {
  switch (type) {
    case "url":
      return <Link2 className="size-3.5 shrink-0" />;
    case "image":
      return <ImageIcon className="size-3.5 shrink-0" />;
    case "path":
    case "text":
    default:
      return <FileText className="size-3.5 shrink-0" />;
  }
};

// 简短预览：URL / path / image 显示原文（截断）、text 显示首 N 字截断
const renderPreview = (doc: TaskContextDoc): string => {
  const c = doc.content.trim();
  if (doc.type === "text") {
    return c.length > 80 ? `${c.slice(0, 80)}…` : c;
  }
  if (doc.type === "image") {
    // image 路径太长不友好、只显示文件名
    const idx = c.lastIndexOf("/");
    return idx >= 0 ? c.slice(idx + 1) : c;
  }
  if (c.length <= 60) return c;
  return `${c.slice(0, 30)}…${c.slice(-25)}`;
};

// 从 image doc 的 absPath 抠 filename、拼 /api/tasks/[id]/uploads/[filename]、给列表行渲染缩略图
const imageThumbnailUrl = (
  taskId: string,
  doc: TaskContextDoc,
): string | null => {
  if (doc.type !== "image") return null;
  const idx = doc.content.lastIndexOf("/");
  const filename = idx >= 0 ? doc.content.slice(idx + 1) : doc.content;
  // uploads 路由只接受 [a-zA-Z0-9_]+\.<ext>、不匹配就别拼
  if (!/^[a-zA-Z0-9_]+\.(png|jpg|jpeg|webp|gif)$/i.test(filename)) return null;
  return `/api/tasks/${encodeURIComponent(taskId)}/uploads/${encodeURIComponent(filename)}`;
};

interface Props {
  task: Task;
  // 父组件刷新整 task 状态、避免重复 fetch
  onTaskUpdate: (task: Task) => void;
}

export const ContextDocsPanel = ({ task, onTaskUpdate }: Props) => {
  // 主 Dialog 开关、默认关
  const [open, setOpen] = useState(false);
  // 添加表单字段
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  // 提交中态、防止双击
  const [submitting, setSubmitting] = useState(false);
  // 当前正在删的 docId、避免重复点击
  const [removingId, setRemovingId] = useState<string | null>(null);
  // 正在看详情的 doc id（非 null 时 Dialog 切详情视图、返回键回列表）——
  // 存 id 不存对象、删除/刷新后从最新 task.contextDocs 反查、不会看到过期内容
  const [detailDocId, setDetailDocId] = useState<string | null>(null);

  // 贴图 hook：粘贴 / 拖拽 / 选文件 → 缩略图 → 上传
  const attach = useImageAttach({ maxImages: 6 });

  const docs = task.contextDocs ?? [];

  // 详情视图的 doc（从最新列表反查、被删后自动回列表视图）
  const detailDoc = detailDocId
    ? (docs.find((d) => d.id === detailDocId) ?? null)
    : null;
  const detailThumb = detailDoc ? imageThumbnailUrl(task.id, detailDoc) : null;

  // 任务跑动中的提示文案
  const isLive =
    task.runStatus === "running" || task.runStatus === "awaiting_user";

  // 提交条件：title + content 一对必须同填或同空、加上 images 至少 1 项
  const canSubmit = useMemo(() => {
    if (submitting) return false;
    const hasTitle = title.trim().length > 0;
    const hasContent = content.trim().length > 0;
    const hasMain = hasTitle && hasContent;
    const partialMain = hasTitle !== hasContent;
    if (partialMain) return false;
    return hasMain || attach.images.length > 0;
  }, [submitting, title, content, attach.images.length]);

  const resetForm = () => {
    setTitle("");
    setContent("");
    attach.reset();
  };

  const handleAdd = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const updated = await addContextDoc(task.id, {
        title: title.trim() || undefined,
        content: content.trim() || undefined,
        images: attach.toUploadPayload(),
      });
      onTaskUpdate(updated);
      resetForm();
      if (isLive) {
        toast.info("已加上下文、下次推进 action / revise 时生效", {
          description: "当前 agent run 拿不到、避免节奏错乱",
        });
      } else {
        toast.success("上下文文档已加");
      }
    } catch (err) {
      toast.error(
        `加文档失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (docId: string) => {
    if (removingId) return;
    setRemovingId(docId);
    try {
      const updated = await removeContextDoc(task.id, docId);
      onTaskUpdate(updated);
    } catch (err) {
      toast.error(
        `删除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setRemovingId(null);
    }
  };

  // 提交按钮文案：根据当前填了啥动态变（用户秒懂自己将要加几条）
  const submitLabel = (() => {
    if (submitting) return "提交中…";
    const imgCount = attach.images.length;
    const hasMain = title.trim().length > 0 && content.trim().length > 0;
    if (hasMain && imgCount > 0) return `添加（1 条 + ${imgCount} 图）`;
    if (hasMain) return "添加";
    if (imgCount > 0)
      return imgCount === 1 ? "添加（1 张图）" : `添加（${imgCount} 张图）`;
    return "添加";
  })();

  return (
    <>
      {/* 触发按钮：紧凑展示当前文档数、点击弹 Dialog */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <Notebook />
        上下文文档
        <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {docs.length}
        </span>
      </Button>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            resetForm();
            setDetailDocId(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          {detailDoc ? (
            // ---------- 详情视图（点列表行进入、返回键回列表） ----------
            <>
              <DialogHeader>
                <DialogTitle className="flex min-w-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setDetailDocId(null)}
                    aria-label="返回列表"
                    title="返回列表"
                    className="shrink-0"
                  >
                    <ArrowLeft />
                  </Button>
                  <span className="truncate min-w-0">{detailDoc.title}</span>
                  <span className="text-[10px] uppercase text-muted-foreground/60 shrink-0">
                    {detailDoc.type}
                  </span>
                </DialogTitle>
              </DialogHeader>

              {detailThumb ? (
                // 图片：大图预览（点击站内 lightbox 再放大）
                <ImageThumb
                  src={detailThumb}
                  alt={detailDoc.title}
                  className="max-h-72 w-full rounded-md border bg-muted/30"
                  imgClassName="max-h-72 w-full object-contain"
                />
              ) : (
                // 文本 / URL / 路径：全文展示（限高滚动、长串可折断）
                <div className="max-h-72 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2">
                  <p className="whitespace-pre-wrap text-xs leading-relaxed wrap-anywhere text-foreground/90">
                    {detailDoc.content}
                  </p>
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                {detailDoc.type === "url" && (
                  <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={
                      <a
                        href={detailDoc.content.trim()}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="no-underline"
                      />
                    }
                  >
                    <ExternalLink />
                    打开链接
                  </Button>
                )}
                {detailDoc.type !== "image" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(detailDoc.content);
                        toast.success("已复制");
                      } catch {
                        toast.error("复制失败");
                      }
                    }}
                  >
                    <Copy />
                    复制内容
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void handleRemove(detailDoc.id);
                    setDetailDocId(null);
                  }}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 />
                  删除
                </Button>
              </div>
            </>
          ) : (
            <>
          <DialogHeader>
            <DialogTitle>上下文文档</DialogTitle>
            <DialogDescription>
              agent 启动时会看到清单、按需读取（点条目看全文）
            </DialogDescription>
          </DialogHeader>

          {/* 现有列表（限高 + 滚动）*/}
          <div className="rounded-md border">
            {docs.length === 0 ? (
              <div className="px-3 py-4 text-xs text-muted-foreground">
                还没有文档。下面填表单加一条。
              </div>
            ) : (
              <ul className="max-h-48 divide-y overflow-y-auto">
                {docs.map((doc) => {
                  const thumb = imageThumbnailUrl(task.id, doc);
                  return (
                    <li
                      key={doc.id}
                      className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 group"
                    >
                      {thumb ? (
                        // image 类型展示缩略图、点击站内看大图（行内小图、去掉默认框）
                        <ImageThumb
                          src={thumb}
                          alt={doc.title}
                          className="size-5 shrink-0 rounded border-0 bg-transparent"
                          imgClassName="rounded"
                        />
                      ) : (
                        <span className="text-muted-foreground">
                          {renderTypeIcon(doc.type)}
                        </span>
                      )}
                      {/* 标题 + 预览区整体可点、进详情看全文（V0.11.x 用户痛点：加完看不了详情） */}
                      <button
                        type="button"
                        onClick={() => setDetailDocId(doc.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
                        title="查看详情"
                      >
                        <span className="font-medium text-foreground/90 shrink-0 group-hover:underline underline-offset-2">
                          {doc.title}
                        </span>
                        <span className="text-muted-foreground truncate flex-1 min-w-0">
                          {renderPreview(doc)}
                        </span>
                      </button>
                      <span className="text-[10px] uppercase text-muted-foreground/60 shrink-0">
                        {doc.type}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => handleRemove(doc.id)}
                        disabled={removingId === doc.id}
                        className="text-muted-foreground/60 shrink-0 hover:bg-destructive/10 hover:text-destructive"
                        aria-label="删除"
                        title="删除"
                      >
                        <Trash2 />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* 内联添加表单 */}
          <div
            className={`grid gap-3 rounded-md border p-3 transition-colors ${
              attach.isDragging
                ? "border-primary bg-primary/5"
                : "bg-muted/30"
            }`}
            onDragOver={attach.onDragOver}
            onDragLeave={attach.onDragLeave}
            onDrop={attach.onDrop}
          >
            <div className="flex items-center gap-2 text-xs font-medium text-foreground/80">
              <Plus className="size-3.5" />
              添加新文档
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ctx-title" className="text-xs">
                标题
              </Label>
              <Input
                id="ctx-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="如：后端技术方案 / 设计稿 / 开发补充（仅贴图可省）"
              />
              {TITLE_PRESETS.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {TITLE_PRESETS.map((preset) => (
                    <ChoiceButton
                      key={preset}
                      shape="chip"
                      selected={title === preset}
                      onClick={() => setTitle(preset)}
                    >
                      {preset}
                    </ChoiceButton>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ctx-content" className="text-xs">
                内容
              </Label>
              <Textarea
                id="ctx-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onPaste={attach.onPaste}
                placeholder="贴 URL / 给绝对路径 / 直接写文本（也可粘贴 / 拖拽图片）"
                rows={4}
                className="resize-none"
              />
            </div>

            {/* 贴图区：缩略图（点击站内看大图、多图左右切换）+ 添加按钮 */}
            <div className="flex flex-wrap items-center gap-2">
              {attach.images.map((img, i) => (
                <ImageThumb
                  key={img.id}
                  src={img.dataUrl}
                  alt={img.file.name}
                  className="size-14 rounded bg-background"
                  onRemove={() => attach.removeImage(img.id)}
                  group={attach.images.map((im) => ({
                    src: im.dataUrl,
                    alt: im.file.name,
                  }))}
                  index={i}
                />
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={attach.triggerFilePicker}
                disabled={attach.images.length >= attach.maxImages}
                title={
                  attach.images.length >= attach.maxImages
                    ? `已达上限 ${attach.maxImages} 张`
                    : "选图片（也可在内容框粘贴 / 拖拽到本卡）"
                }
              >
                <ImagePlus />
                附图
                <span className="ml-1 text-[10px] text-muted-foreground">
                  {attach.images.length}/{attach.maxImages}
                </span>
              </Button>
              <input
                ref={attach.fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={attach.onFileInputChange}
              />
            </div>

            <div className="flex justify-end">
              <Button size="sm" onClick={handleAdd} disabled={!canSubmit}>
                {submitLabel}
              </Button>
            </div>
          </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
