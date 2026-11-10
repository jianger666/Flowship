"use client";

/**
 * 页面 JS 对话框条（契约 §14.3 / §14.1 对话框策略）：state.dialog 非空时画在状态条下方。
 *
 * 为什么画在 Flowship 自己的 UI 里：页面的 alert / confirm / prompt 被主进程挂起（最多 20 秒，超时自动兜底），
 * 用户在这里点「确定 / 取消」→ browser:answerDialog → tab.answerDialog（V5 实现，可能比本切片晚落地，缺失时是空操作）。
 * 注意：不能用 role="dialog" / "alertdialog"——use-overlay-cover 会把它们当成常驻浮层去遮盖视口。
 */
import { memo, useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import type { DialogInfo } from "@/lib/browser-bridge-types";
import { isImeComposing } from "@/lib/ime";
import {
  DIALOG_FOCUS_HELD_HINT,
  decideDialogInputFocus,
  dialogDefaultText,
  dialogMessageText,
} from "./browser-dialog-logic";
import { describeDialogBar } from "./browser-user-logic";

const DialogBarInner = ({ taskId, dialog }: { taskId: string; dialog: DialogInfo }) => {
  const model = describeDialogBar(dialog);
  // 默认值与说明文字都是页面给的：展示 / 预填前剥格式字符（U+202E 能把文字反向显示，R2-13 ③）
  const [value, setValue] = useState(() => dialogDefaultText(model?.defaultPrompt));
  const inputWrapRef = useRef<HTMLDivElement>(null);
  // 用户正在别处打字、所以没抢焦点：条上显示醒目提示，直到用户自己点进输入框
  const [focusHeld, setFocusHeld] = useState(false);
  const wantsInput = !!model?.showInput;
  useEffect(() => {
    if (!wantsInput) return;
    // 不用 autoFocus：页面随时能弹 prompt()，用户正在应用的某个输入框里打字时被抢焦点，接下来的按键 + Enter 会把
    // 用户写了一半的内容提交给页面（R2-13 ③）。只有焦点不在任何可编辑元素里才自动聚焦；组件以 dialog.since 为 key，挂载 = 新对话框
    const active = document.activeElement;
    const action = decideDialogInputFocus(active, !!active && !!inputWrapRef.current?.contains(active));
    if (action === "focus") inputWrapRef.current?.querySelector("input")?.focus();
    else if (action === "held") setFocusHeld(true);
  }, [wantsInput]);
  if (!model) return null;

  const answer = (accept: boolean) =>
    window.__browser?.answerDialog?.(taskId, accept, accept && model.showInput ? value : undefined);

  return (
    <div role="alert" aria-label="页面对话框" className="shrink-0 border-b bg-warning/10 text-xs">
      <div className="flex min-h-8 items-center gap-2 px-3 py-1">
        <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
        {/* 来源 + 类型（R3-09 ①）：让用户看得出这句话是页面说的，不是应用自己的提示 */}
        {/* 窄面板里标题会被 CSS 截断：完整来源放进 Tooltip（项目约定不用原生 title；R4-04 ④） */}
        <Tooltip content={model.headingFull} side="bottom">
          <span className="max-w-[45%] shrink-0 truncate font-medium">{model.heading}</span>
        </Tooltip>
        <span className="min-w-0 flex-1 line-clamp-2 break-words">{dialogMessageText(model.message)}</span>
        {model.showCancel && (
          <Button type="button" size="xs" variant="outline" onClick={() => answer(false)}>
            {model.cancelLabel}
          </Button>
        )}
        <Button type="button" size="xs" onClick={() => answer(true)}>
          {model.acceptLabel}
        </Button>
      </div>
      {model.showInput && (
        <div ref={inputWrapRef} className="px-3 pb-2">
          {focusHeld && <p className="mb-1 text-xs font-medium text-foreground">{DIALOG_FOCUS_HELD_HINT}</p>}
          <Input
            value={value}
            maxLength={2000}
            aria-label="对话框输入"
            placeholder="请输入"
            className="h-7 text-xs md:text-xs"
            onFocus={() => setFocusHeld(false)}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // 中文输入法选词时的 Enter 不能当「确定」（会把半截文字提交给页面）：统一口径，同时看 isComposing 与 keyCode 229。
              // 长按重复的 Enter（e.repeat）也不算：它多半是上一个控件上还没松开的那次按键，不是用户对这个对话框的答复
              if (e.key === "Enter" && !e.repeat && !isImeComposing(e)) {
                e.preventDefault();
                answer(true);
              }
            }}
          />
        </div>
      )}
    </div>
  );
};

/** 对话框条；没有对话框（缺省 / null）什么都不画。以 since 为 key：换了一个新对话框就重置输入框 */
export const BrowserDialogBar = memo(function BrowserDialogBar({
  taskId,
  dialog,
}: {
  taskId: string;
  dialog: DialogInfo | null | undefined;
}) {
  if (!describeDialogBar(dialog)) return null;
  return <DialogBarInner key={dialog!.since} taskId={taskId} dialog={dialog!} />;
});
