"use client";

/**
 * 「群里还没有你的机器人」引导弹窗。
 *
 * 需求群由第一个分享的人建、他的 bot 自动在群里；后来者的 bot 事后拉不进去
 * （缺 scope、不可补救）——只能引导手动加一次：给准确的机器人名 + 一键复制 +
 * 三步指引，加完点「已添加，重试发送」原样重发刚才那条内容。一个群只需一次。
 */

import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";

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
  /** 机器人准确名称（群里搜这个名字添加） */
  botLabel: string;
  /** 重试发送飞行中：按钮 spinner + 禁止关闭 */
  retrying: boolean;
  onRetry: () => void;
  onCancel: () => void;
}

export const BotAddGuideDialog = ({
  open,
  botLabel,
  retrying,
  onRetry,
  onCancel,
}: Props) => {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(botLabel);
      toast.success("已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  // 一行一步；第三步带上名字，用户复制完直接搜
  const steps = [
    "打开群设置",
    "找到「机器人」→「添加机器人」",
    `搜索并添加「${botLabel}」`,
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 飞行中不关；点外部也不关——关掉就丢了待重发的那条内容
        if (retrying || next) return;
        onCancel();
      }}
      disablePointerDismissal
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>群里还没有你的机器人</DialogTitle>
          <DialogDescription>
            在群设置里手动添加一次，之后这个群就不用再加了。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
          <span
            className="min-w-0 flex-1 truncate font-mono text-sm"
            title={botLabel}
          >
            {botLabel}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
            <Copy className="size-3.5" />
            复制名称
          </Button>
        </div>

        <ol className="space-y-1.5 text-sm text-muted-foreground">
          {steps.map((step, i) => (
            <li key={step} className="flex items-start gap-2">
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-foreground">
                {i + 1}
              </span>
              <span className="min-w-0 wrap-anywhere">{step}</span>
            </li>
          ))}
        </ol>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={retrying}
            onClick={onCancel}
          >
            取消
          </Button>
          <Button type="button" disabled={retrying} onClick={onRetry}>
            {retrying && <Loader2 className="size-4 animate-spin" />}
            已添加，重试发送
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
