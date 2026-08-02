"use client";

/**
 * 复制按钮 + 「内容块右上角浮出复制」容器
 *
 * 为什么抽公共件：事件流里 shell 输出 / 子代理任务书 / 子代理产出 / inline diff 四处
 * 都要同一个复制体验（hover 浮出、点完图标切勾 2s、对齐 markdown 代码块的复制），
 * 各写一份必然漂移——视觉和「复制的是全量不是可见那截」的语义都收在这里。
 *
 * 全量语义：`text` 支持传异步 getter——展示被截断时（工具输出落盘、UI 只显示前 8KB）
 * 由调用方在 getter 里走「加载完整输出」同一通道拉全量再复制；取不到返 null
 * （getter 自己 toast 过原因）、这里静默收手、不复制半截内容。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** 字符串 = 直接复制；函数 = 异步取全量（返 null 表示取不到、不复制） */
export type CopyTextSource = string | (() => Promise<string | null>);

/** 复制成功后勾号停留时长（对齐 markdown 代码块复制按钮） */
const COPIED_FEEDBACK_MS = 2000;

interface CopyButtonProps {
  text: CopyTextSource;
  /** tooltip / aria 文案（如「复制输出」） */
  label?: string;
  className?: string;
}

export const CopyButton = ({
  text,
  label = "复制",
  className,
}: CopyButtonProps) => {
  // 刚复制完（图标切勾）；到点自动回落成 Copy 图标
  const [copied, setCopied] = useState(false);
  // 异步取全量中：按钮禁用防连点
  const [busy, setBusy] = useState(false);
  // 勾号回落定时器——卸载时清掉，避免 setState on unmounted
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const handleCopy = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const value = typeof text === "string" ? text : await text();
      // 取不到全量（404 / 网络失败）——取值方已提示过、这里不再叠一层 toast
      if (value == null) return;
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(
        () => setCopied(false),
        COPIED_FEEDBACK_MS,
      );
    } catch {
      toast.error("复制失败");
    } finally {
      setBusy(false);
    }
  };

  const Icon = copied ? Check : Copy;
  return (
    <Tooltip content={label}>
      <span className="inline-flex">
        <button
          type="button"
          disabled={busy}
          aria-label={label}
          // 外层常是「整块折叠」按钮 / 可点行：复制不该顺带把块折叠了
          onClick={(e) => {
            e.stopPropagation();
            void handleCopy();
          }}
          className={cn(
            "cursor-pointer rounded border border-border/60 bg-background/90 p-1",
            "text-muted-foreground shadow-sm transition-colors hover:text-foreground",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <Icon
            className={cn(
              "size-3",
              copied && "text-success",
            )}
          />
        </button>
      </span>
    </Tooltip>
  );
};

interface CopyableBlockProps {
  text: CopyTextSource;
  label?: string;
  /** 加在外层定位容器上（内容块自己的样式仍写在 children 上） */
  className?: string;
  children: ReactNode;
}

/**
 * 内容块 + 右上角浮出复制按钮：hover 才显形、绝对定位不占布局、
 * 内容滚动时按钮固定在块右上角（长输出滚到哪都能复制）。
 */
export const CopyableBlock = ({
  text,
  label,
  className,
  children,
}: CopyableBlockProps) => (
  <div
    className={cn("group/copyable relative min-w-0 max-w-full", className)}
  >
    {children}
    <CopyButton
      text={text}
      label={label}
      className="absolute right-2 top-1.5 opacity-0 transition-opacity group-hover/copyable:opacity-100 focus-visible:opacity-100"
    />
  </div>
);
