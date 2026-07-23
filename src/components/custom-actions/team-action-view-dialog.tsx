"use client";

/**
 * 共享库 action 只读查看 dialog（2026-07-22 三件收尾之一）
 *
 * Action 管理列表与「共享市场」查看共用（同款视觉单一来源）：
 * 壳参数（label / placeholder / 分类 / 创建人）+ 壳 skill 的 SKILL.md 全文。
 * 内容走 /api/skills/content（source=team）按需拉、不随列表预载。
 */

import { useEffect, useState } from "react";

import { AuthorByline } from "@/components/ui/author-byline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/loading-state";

export type TeamActionViewTarget = {
  /** 壳展示名（dialog 标题） */
  label: string;
  /** 挂载的壳 skill 名（内容按它拉） */
  skillName: string;
  placeholder?: string;
  /** 分类中文名（如「共享 · 前端」；没有不显示） */
  categoryLabel?: string;
  /** 创建人（没有不显示） */
  author?: string;
};

export const TeamActionViewDialog = ({
  target,
  onClose,
}: {
  target: TeamActionViewTarget;
  onClose: () => void;
}) => {
  // SKILL.md 全文（null = 拉取中；空串 = 拉失败的兜底提示由渲染层给）
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/skills/content?name=${encodeURIComponent(target.skillName)}&source=team`,
          { cache: "no-store" },
        );
        const data = (await res.json()) as { content?: string };
        if (!cancelled) setContent(res.ok ? (data.content ?? "") : "");
      } catch {
        if (!cancelled) setContent("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target.skillName]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate">{target.label}</span>
            {target.categoryLabel && (
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                {target.categoryLabel}
              </Badge>
            )}
            {target.author && <AuthorByline author={target.author} />}
          </DialogTitle>
          {target.placeholder && (
            <p className="text-xs text-muted-foreground">
              指令提示：{target.placeholder}
            </p>
          )}
        </DialogHeader>
        {content === null ? (
          <LoadingState variant="inline" />
        ) : (
          // 等宽只读展示（与 skills-card 的 SkillViewDialog 同款样式）
          <pre className="max-h-[60vh] overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap">
            {content || "（读取 SKILL.md 失败——先同步共享库再试）"}
          </pre>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
