"use client";

/**
 * 任务级上下文文档（V0.3、V0.3.3 改成 button + dialog）
 *
 * 跟 SKILL.md 同思路：只 inject「清单」、agent 按需拉。
 * 用户在这里增删上下文文档（飞书 URL / 本地路径 / 自由文本）、
 * agent 下次启动 / revise 时会看到这个清单、决定是否拉取。
 *
 * UI（V0.3.3 改造）：
 *   - 外层只渲染紧凑 Button：「上下文文档 (N)」、点开弹 Dialog
 *   - Dialog 内：文档列表 + 内联添加表单（不再 sub-dialog、心智更轻）
 *   - 不再占顶部高度、内容区不被挤
 *
 * 节奏说明：
 *   - task.status ∈ {running, awaiting_user} 时、加完 toast 提示「下次启动 / revise 时生效」
 *   - 其他状态加完直接生效（下次 startWorkflow 会拼最新清单）
 */

import { useMemo, useState } from "react";
import { FileText, Link2, Notebook, Plus, Trash2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { addContextDoc, removeContextDoc } from "@/lib/task-store";
import type { Task, TaskContextDoc, TaskContextDocType } from "@/lib/types";

// title 预设：第一期就一个、后面有新的常见类型再加
const TITLE_PRESETS: string[] = ["后端技术方案"];

// 状态 → 图标
const renderTypeIcon = (type: TaskContextDocType) => {
  switch (type) {
    case "url":
      return <Link2 className="size-3.5 shrink-0" />;
    case "path":
      return <FileText className="size-3.5 shrink-0" />;
    default:
      return <FileText className="size-3.5 shrink-0" />;
  }
};

// 简短预览：URL / path 显示原文（截断）、text 显示首 N 字截断
const renderPreview = (doc: TaskContextDoc): string => {
  const c = doc.content.trim();
  if (doc.type === "text") {
    return c.length > 80 ? `${c.slice(0, 80)}…` : c;
  }
  // url / path：太长截中间（保留头尾）
  if (c.length <= 60) return c;
  return `${c.slice(0, 30)}…${c.slice(-25)}`;
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

  const docs = task.contextDocs ?? [];

  // 任务跑动中的提示文案
  const isLive = task.status === "running" || task.status === "awaiting_user";

  const canSubmit = useMemo(
    () => !submitting && title.trim().length > 0 && content.trim().length > 0,
    [submitting, title, content],
  );

  const resetForm = () => {
    setTitle("");
    setContent("");
  };

  const handleAdd = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const updated = await addContextDoc(task.id, {
        title: title.trim(),
        content: content.trim(),
      });
      onTaskUpdate(updated);
      resetForm();
      if (isLive) {
        toast.info("已加上下文、下次启动 workflow / revise 时生效", {
          description: "当前 agent run 拿不到、避免节奏错乱",
        });
      } else {
        toast.success("上下文文档已加");
      }
    } catch (err) {
      toast.error(`加文档失败：${err instanceof Error ? err.message : String(err)}`);
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
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRemovingId(null);
    }
  };

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
          if (!o) resetForm();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>上下文文档</DialogTitle>
            <DialogDescription>
              agent 启动时会看到清单、按需读取
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
                {docs.map((doc) => (
                  <li
                    key={doc.id}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 group"
                  >
                    <span className="text-muted-foreground">
                      {renderTypeIcon(doc.type)}
                    </span>
                    <span className="font-medium text-foreground/90 shrink-0">
                      {doc.title}
                    </span>
                    <span
                      className="text-muted-foreground truncate flex-1"
                      title={doc.content}
                    >
                      {renderPreview(doc)}
                    </span>
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
                ))}
              </ul>
            )}
          </div>

          {/* 内联添加表单（不再 sub-dialog）*/}
          <div className="grid gap-3 rounded-md border bg-muted/30 p-3">
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
                placeholder="如：后端技术方案 / 设计稿 / 开发补充"
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
                placeholder="贴 URL（https://wukongedu.feishu.cn/...）/ 给绝对路径 / 直接写文本"
                rows={4}
                className="resize-none"
              />
              <p className="text-[11px] text-muted-foreground">
                URL → 自动拉取；/ 起手 → 当文件路径；其他 → 当文本
              </p>
            </div>

            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={handleAdd}
                disabled={!canSubmit}
              >
                {submitting ? "提交中…" : "添加"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
