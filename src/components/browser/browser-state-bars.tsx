"use client";

/**
 * 增强包 E2 的常驻状态横幅（契约 §15.2）：AI 设置的网络规则 / 页面在断点暂停 / 正在录制。
 * 共同点：都是「AI 在影响你的页面」的可见提示（红线 5：新增的敏感操作必须让用户看得见），并给用户一个一键收回的出口。
 * 一键操作走 `ext(name)`：netrules.clear / debug.resume / record.stop（主进程模块登记；老壳没有 ext → 按钮无效，不抛错）。
 */
import { memo } from "react";
import { Bug, CircleDot, Waypoints } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { BrowserState } from "@/lib/browser-bridge-types";
import { describeDebugBar, describeNetRulesBanner, describeRecordingBar } from "./browser-extra-logic";

const callExt = (name: string, taskId: string) => {
  void Promise.resolve(window.__browser?.ext?.(name, taskId)).catch(() => {});
};

export const NetRulesBanner = memo(function NetRulesBanner({ taskId, rules }: { taskId: string; rules: BrowserState["netRules"] }) {
  const model = describeNetRulesBanner(rules);
  if (!model) return null;
  return (
    <div role="status" aria-label="网络规则" className="flex min-h-8 shrink-0 items-center gap-2 border-b bg-warning/10 px-3 py-1 text-xs">
      <Waypoints className="size-3.5 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{model.text}</span>
      <Button type="button" size="xs" variant="outline" onClick={() => callExt("netrules.clear", taskId)}>
        一键清除
      </Button>
    </div>
  );
});

export const DebugPausedBar = memo(function DebugPausedBar({ taskId, debug }: { taskId: string; debug: BrowserState["debug"] }) {
  const model = describeDebugBar(debug);
  if (!model) return null;
  return (
    <div role="status" aria-label="调试器暂停" className="flex min-h-8 shrink-0 items-center gap-2 border-b bg-warning/10 px-3 py-1 text-xs">
      <Bug className="size-3.5 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{model.text}</span>
      <Button type="button" size="xs" onClick={() => callExt("debug.resume", taskId)}>
        继续运行
      </Button>
    </div>
  );
});

export const RecordingBar = memo(function RecordingBar({ taskId, recording }: { taskId: string; recording: BrowserState["recording"] }) {
  const model = describeRecordingBar(recording);
  if (!model) return null;
  return (
    <div role="status" aria-label="录制中" className="flex min-h-8 shrink-0 items-center gap-2 border-b bg-destructive/10 px-3 py-1 text-xs">
      <CircleDot className="size-3.5 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{model.text}</span>
      <Button type="button" size="xs" variant="outline" onClick={() => callExt("record.stop", taskId)}>
        停止录制
      </Button>
    </div>
  );
});
