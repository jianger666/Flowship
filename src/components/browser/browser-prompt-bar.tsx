"use client";

/**
 * 「等待你处理」的提示条（契约 §15.1）：HTTP 认证 / 证书不受信任 / 页面权限 / AI 请求执行页面脚本 / 客户端证书。
 *
 * 为什么画在 Flowship 自己的 UI 里（同 BrowserDialogBar）：这些决定只能由**用户**做，AI 不能代答；
 * 页面 / 网络给的文字（站点声明的 realm、证书主题、权限来源）一律剥格式字符 + 限长后展示。
 * 用户名 / 密码只活在本组件的 state 里，点「登录」时经 `ext("prompt.answer")` 交给主进程直接递给网络栈——
 * 不进状态推送、不进日志、不进活动日志、不给 AI；组件卸载（提示结束 / 超时 / 取消）即丢弃。
 * 注意：不能用 role="dialog" / "alertdialog"——use-overlay-cover 会把它们当成常驻浮层去遮盖视口。
 */
import { memo, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Tooltip } from "@/components/ui/tooltip";
import type { BrowserPromptInfo } from "@/lib/browser-bridge-types";
import { isImeComposing } from "@/lib/ime";
import { PROMPT_ARM_DELAY_MS, describePrompt, queuedPromptCount, visiblePrompts } from "./browser-extra-logic";

const PromptBarInner = ({ taskId, prompt, queued }: { taskId: string; prompt: BrowserPromptInfo; queued: number }) => {
  const model = describePrompt(prompt);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // R6-20：新提示出现后短暂置灰按钮（防止上一条提示刚被取消、这一条立刻顶到同一位置时误点）。
  // 组件以提示 id 为 key，换提示就重新挂载 → 重新计时。
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), PROMPT_ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!model) return null;

  const answer = (action: string) => {
    if (busy || !armed) return;
    setBusy(true);
    const decision =
      model.needsCredentials && action === "submit" ? { action, username, password } : { action };
    void Promise.resolve(window.__browser?.ext?.("prompt.answer", taskId, prompt.id, decision))
      .catch(() => {})
      .finally(() => {
        // 提示结束后组件会随状态推送卸载；这里只防「回答失败 / 主进程没响应」时按钮永久灰掉
        setBusy(false);
        setPassword("");
      });
  };

  return (
    <div role="alert" aria-label="等待你处理" className="shrink-0 border-b bg-warning/10 text-xs">
      <div className="flex min-h-8 flex-wrap items-center gap-2 px-3 py-1">
        <ShieldAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
        <Tooltip content={model.headingFull} side="bottom">
          <span className="max-w-[55%] shrink-0 truncate font-medium">{model.heading}</span>
        </Tooltip>
        {queued > 0 && <span className="shrink-0 text-muted-foreground">另有 {queued} 条等待</span>}
        <span className="flex-1" />
        {model.actions.map((a) => (
          <Button
            key={a.id}
            type="button"
            size="xs"
            variant={a.variant}
            disabled={!armed || busy || (a.id === "submit" && username === "" && password === "")}
            onClick={() => answer(a.id)}
          >
            {a.label}
          </Button>
        ))}
      </div>
      <div className="space-y-0.5 px-3 pb-1.5 text-muted-foreground">
        {model.lines.map((l, i) => (
          <p key={i} className="break-words">
            {l}
          </p>
        ))}
        {model.timeoutHint && <p>{model.timeoutHint}</p>}
      </div>
      {model.needsCredentials && (
        <div className="flex flex-wrap gap-2 px-3 pb-2">
          <Input
            value={username}
            maxLength={256}
            autoComplete="off"
            aria-label="用户名"
            placeholder="用户名"
            className="h-7 min-w-32 flex-1 text-xs md:text-xs"
            onChange={(e) => setUsername(e.target.value)}
          />
          <PasswordInput
            value={password}
            maxLength={1024}
            autoComplete="off"
            aria-label="密码"
            placeholder="密码"
            wrapperClassName="min-w-40 flex-1"
            className="h-7 text-xs md:text-xs"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.repeat && !isImeComposing(e)) {
                e.preventDefault();
                answer("submit");
              }
            }}
          />
        </div>
      )}
    </div>
  );
};

/** 提示条：只画队首一条（其余在「另有 N 条等待」里计数）；以提示 id 为 key，换提示就重置输入框 */
export const BrowserPromptBar = memo(function BrowserPromptBar({
  taskId,
  prompts,
}: {
  taskId: string;
  prompts: BrowserPromptInfo[] | null | undefined;
}) {
  const [first] = visiblePrompts(prompts);
  if (!first || !describePrompt(first)) return null;
  return <PromptBarInner key={first.id} taskId={taskId} prompt={first} queued={queuedPromptCount(prompts)} />;
});
