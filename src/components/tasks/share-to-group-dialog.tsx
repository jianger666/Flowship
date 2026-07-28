"use client";

/**
 * 「分享到需求群」二次确认 dialog：一句话问清楚发什么、点「分享」才真发。
 *
 * 不放正文预览（2026-07-27 用户拍板）：内容形态已改成「卡片 + md 文件」、
 * 弹窗里塞一大块灰底摘要既看不懂又占版面。这里只承担「别误点」这一个职责。
 * 可丢的不是输入稿、是「误点分享」——仍 disablePointerDismissal，点外不关。
 */

import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** action 标题（如「方案 (Plan)」）——进确认文案 */
  title: string;
  /** 请求飞行中：确认键 spinner + disabled */
  sharing: boolean;
  onConfirm: () => void;
}

export const ShareToGroupDialog = ({
  open,
  onOpenChange,
  title,
  sharing,
  onConfirm,
}: Props) => (
  <Dialog
    open={open}
    onOpenChange={(next) => {
      // 飞行中不允许关，防丢「已点分享还在路上」的体感
      if (sharing) return;
      onOpenChange(next);
    }}
    disablePointerDismissal
  >
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>分享到需求群</DialogTitle>
        <DialogDescription>
          把「{title}」的完整产物发到需求群？
        </DialogDescription>
      </DialogHeader>
      <DialogFooter className="gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={sharing}
          onClick={() => onOpenChange(false)}
        >
          取消
        </Button>
        <Button type="button" disabled={sharing} onClick={onConfirm}>
          {sharing && <Loader2 className="size-4 animate-spin" />}
          分享
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
