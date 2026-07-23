"use client";

/**
 * Skills 编辑 / 只读详情 dialog
 *
 * SkillEditDialog 仅用于编辑已有自管 skill（「手写新增」入口已下线；新建走对话创建 / 导入）。
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export const SkillViewDialog = ({
  name,
  content,
  onClose,
}: {
  name: string;
  content: string;
  onClose: () => void;
}) => (
  <Dialog open onOpenChange={(o) => !o && onClose()}>
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{name}</DialogTitle>
      </DialogHeader>
      <pre className="max-h-[60vh] overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap">
        {content}
      </pre>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export const SkillEditDialog = ({
  initialName,
  initialContent,
  busy,
  onClose,
  onSave,
}: {
  /** 已有 skill 目录名（锁定、不可改名） */
  initialName: string;
  initialContent: string;
  busy: boolean;
  onClose: () => void;
  onSave: (name: string, content: string) => void;
}) => {
  // SKILL.md 内容草稿（目录名锁定为 initialName）
  const [content, setContent] = useState(initialContent);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} disablePointerDismissal>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{`编辑 ${initialName}`}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="skill-edit-content">SKILL.md</Label>
          <CodeEditor
            id="skill-edit-content"
            value={content}
            onChange={setContent}
            language="markdown"
            rows={16}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            onClick={() => onSave(initialName, content)}
            disabled={busy || !initialName.trim() || !content.trim()}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
