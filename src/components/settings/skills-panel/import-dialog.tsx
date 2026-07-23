"use client";

/**
 * 从 Cursor 导入 skill dialog
 */

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyHint } from "@/components/ui/empty-hint";

import type { CursorGlobalSkill } from "./types";

export const ImportSkillsDialog = ({
  open,
  busy,
  cursorGlobal,
  appNames,
  onClose,
  onImport,
}: {
  open: boolean;
  busy: boolean;
  cursorGlobal: CursorGlobalSkill[];
  /** 已存在的自管 skill 名（标「导入将覆盖」） */
  appNames: Set<string>;
  onClose: () => void;
  onImport: (dirNames: string[]) => void;
}) => {
  // 勾选集合；关闭清空、重开不残留
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!open) setPicked(new Set());
  }, [open]);

  const toggle = (dirName: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(dirName)) next.delete(dirName);
      else next.add(dirName);
      return next;
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      disablePointerDismissal
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>从 Cursor 导入</DialogTitle>
        </DialogHeader>
        {cursorGlobal.length === 0 ? (
          <EmptyHint size="sm">~/.cursor/skills 下没有 skill</EmptyHint>
        ) : (
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {cursorGlobal.map((s) => (
              <label
                key={s.dirName}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50"
              >
                <Checkbox
                  checked={picked.has(s.dirName)}
                  onCheckedChange={() => toggle(s.dirName)}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{s.dirName}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {s.description}
                  </div>
                </div>
                {appNames.has(s.dirName) && (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    将覆盖
                  </Badge>
                )}
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            onClick={() => onImport([...picked])}
            disabled={busy || picked.size === 0}
          >
            导入{picked.size > 0 ? `（${picked.size}）` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
