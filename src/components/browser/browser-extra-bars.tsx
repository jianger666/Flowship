"use client";

/**
 * 增强包 E2 的面板条合集（契约 §15.2），在 browser-panel.tsx 里只占一个插槽：状态条 / 对话框条下方。
 * 顺序 = 紧迫程度：等待用户处理的提示 → 断点暂停 → 网络规则 → 录制。各条都是「state 里有才画」，缺省什么都不画。
 */
import { memo } from "react";

import type { BrowserState } from "@/lib/browser-bridge-types";
import { BrowserPromptBar } from "./browser-prompt-bar";
import { DebugPausedBar, NetRulesBanner, RecordingBar } from "./browser-state-bars";

export const BrowserExtraBars = memo(function BrowserExtraBars({
  taskId,
  state,
}: {
  taskId: string;
  state: Pick<BrowserState, "prompts" | "netRules" | "debug" | "recording"> | null | undefined;
}) {
  if (!state) return null;
  return (
    <>
      <BrowserPromptBar taskId={taskId} prompts={state.prompts} />
      <DebugPausedBar taskId={taskId} debug={state.debug} />
      <NetRulesBanner taskId={taskId} rules={state.netRules} />
      <RecordingBar taskId={taskId} recording={state.recording} />
    </>
  );
});
