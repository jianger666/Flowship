"use client";

/**
 * 全局快捷键统一注册（C 批次）：挂在 providers、全站只此一个 keydown 入口
 *（散落 listener 的例外：Cmd+B 在 app-shell 持有侧栏 state、Cmd+J 在任务页组件——
 * 它们绑定局部 state、暂不上收；新增全局键一律加在这）。
 *
 * - Cmd/Ctrl+K：命令面板（输入框聚焦时也生效——带修饰键、不影响打字）
 * - Cmd/Ctrl+N：新建对话（同上）
 * 键位匹配纯逻辑在 lib/keyboard-shortcuts（可单测）。
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CommandPalette } from "@/components/command-palette";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { useNewChat } from "@/hooks/use-new-chat";
import { useTaskList } from "@/hooks/use-task-list";
import { isModCombo } from "@/lib/keyboard-shortcuts";

export const GlobalShortcuts = () => {
  const router = useRouter();
  const { upsertTask } = useTaskList();
  // 命令面板开关
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 快捷键表开关（命令面板条目唤起）
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Cmd+N 新建对话：与侧栏同一 hook（内部有 creating 防连点）
  const { createChat } = useNewChat((task) => {
    upsertTask(task);
    router.push(`/tasks/${task.id}`);
  });
  // ref 化：keydown listener 只注册一次、不随 createChat 引用变化重绑
  const createChatRef = useRef(createChat);
  createChatRef.current = createChat;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Cmd+K / Cmd+N 都带修饰键、输入框聚焦时也放行（不劫持普通打字）
      if (isModCombo(e, "k")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (isModCombo(e, "n")) {
        e.preventDefault();
        void createChatRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onShowShortcuts={() => setShortcutsOpen(true)}
      />
      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
      />
    </>
  );
};
