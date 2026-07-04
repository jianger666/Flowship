"use client";

/**
 * 导出自定义 action 的勾选弹窗（v0.9.14）
 *
 * 用户反馈：顶部「导出」一键导全部太糙——改成先弹勾选列表（默认全选、可全选/取消），
 * 确认后父组件再走原生目录 picker 真正导出。导出唯一入口在这里（行内单个导出已删、用户拍板）。
 */

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CustomActionDef } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: CustomActionDef[];
  /** 确认导出：父组件接手（目录 picker + 请求）、本弹窗只负责选出 ids */
  onConfirm: (ids: string[]) => void;
}

export const ExportActionsDialog = ({
  open,
  onOpenChange,
  actions,
  onConfirm,
}: Props) => {
  // 勾选中的 action id 集合（每次打开重置为全选）
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) setSelected(new Set(actions.map((a) => a.id)));
  }, [open, actions]);

  const allChecked = selected.size === actions.length && actions.length > 0;
  const someChecked = selected.size > 0 && !allChecked;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allChecked ? new Set() : new Set(actions.map((a) => a.id)));
  };

  const handleConfirm = () => {
    onOpenChange(false);
    onConfirm([...selected]);
  };

  return (
    // disablePointerDismissal：带勾选草稿、点外误关丢选择；Esc / X / 取消仍可关
    <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>导出 action</DialogTitle>
          <DialogDescription>
            勾选要导出的 action、每个写成一个 md 文件
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1">
          {/* 全选行 */}
          <label className="flex cursor-pointer items-center gap-2 rounded-md border-b px-2 py-2">
            <Checkbox
              checked={allChecked}
              indeterminate={someChecked}
              onCheckedChange={toggleAll}
            />
            <span className="text-sm font-medium">
              全选（{selected.size}/{actions.length}）
            </span>
          </label>

          {/* 列表最长也就十几个、不做虚拟滚动；超长时靠 Dialog 自带 mask 滚动 */}
          {actions.map((a) => (
            <label
              key={a.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
            >
              <Checkbox
                checked={selected.has(a.id)}
                onCheckedChange={() => toggle(a.id)}
              />
              <span className="min-w-0 flex-1 truncate text-sm" title={a.label}>
                {a.label}
              </span>
              {a.skills && a.skills.length > 0 && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {a.skills.length} skill
                </span>
              )}
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={selected.size === 0}>
            导出（{selected.size}）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
