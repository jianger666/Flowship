"use client";

/**
 * 键盘快捷键表（C 批次）：命令面板「键盘快捷键」条目唤起。
 * 纯展示、两列（说明 + 键位）；提交类键位跟随设置页「提交快捷键」偏好实时显示。
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSubmitShortcut } from "@/hooks/use-settings";
import { oppositeSubmitShortcut } from "@/lib/keyboard-shortcuts";
import { getSubmitShortcutTitle } from "@/lib/submit-shortcut";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 键位胶囊（Cmd/Ctrl+K 这类展示用、非交互） */
const Kbd = ({ children }: { children: string }) => (
  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
    {children}
  </kbd>
);

export const KeyboardShortcutsDialog = ({ open, onOpenChange }: Props) => {
  const submitShortcut = useSubmitShortcut();
  const submitKey = getSubmitShortcutTitle(submitShortcut);
  const sendNowKey = getSubmitShortcutTitle(
    oppositeSubmitShortcut(submitShortcut),
  );

  const rows: Array<{ label: string; keys: string[] }> = [
    { label: "命令面板", keys: ["Cmd/Ctrl+K"] },
    { label: "新建对话", keys: ["Cmd/Ctrl+N"] },
    { label: "切换侧栏", keys: ["Cmd/Ctrl+B"] },
    { label: "聚焦输入框（任务页）", keys: ["Cmd/Ctrl+J"] },
    { label: "发送消息", keys: [submitKey] },
    { label: "运行中：排队发送", keys: [submitKey] },
    { label: "运行中：立即发送（打断）", keys: [sendNowKey] },
    { label: "清空输入框", keys: ["Esc", "Esc"] },
    { label: "关闭弹窗 / 菜单", keys: ["Esc"] },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>键盘快捷键</DialogTitle>
        </DialogHeader>
        <ul className="divide-y divide-border/50">
          {rows.map((row) => (
            <li
              key={row.label}
              className="flex items-center justify-between gap-3 py-2 text-sm"
            >
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="flex shrink-0 items-center gap-1">
                {row.keys.map((k, i) => (
                  <Kbd key={`${row.label}-${i}`}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
};
