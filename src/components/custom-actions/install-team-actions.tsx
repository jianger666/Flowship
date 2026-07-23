"use client";

/**
 * Action tab「共享市场」子 tab 内容
 *
 * 列共享库里带 .flowship-action.json 的条目；安装 / 卸载走统一 API
 *（/api/team-library/install|uninstall、server 内聚处理 skill-state + action 挂/删）。
 * 「从库删除」走 /api/team-library/delete（远端删目录 + commit/push）。
 */

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import {
  TeamActionViewDialog,
  type TeamActionViewTarget,
} from "@/components/custom-actions/team-action-view-dialog";
import { AuthorByline } from "@/components/ui/author-byline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { useDialog } from "@/hooks/use-dialog";
import {
  useTeamLibrary,
  type TeamActionEntry,
} from "@/hooks/use-team-library";
import { formatRelative } from "@/lib/task-display";
import { labelTeamSharedCategory } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 行内次要操作：紧凑 ghost 文字按钮（与能力页 Skill/Action 行统一） */
const ROW_ACTION_BTN =
  "h-6 shrink-0 px-2 text-[12px] text-muted-foreground hover:text-foreground";

type Props = {
  /** 安装 / 卸载后回调（父组件刷新自定义 action 列表） */
  onInstalled?: () => void;
};

/** 从 dirPath 推导分类 key：skills/<cat>/... → cat；knowledge/... → null（本区块只关心共享） */
const categoryKeyFromDir = (dirPath: string): string | null => {
  const parts = dirPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts[0] === "skills" && parts.length >= 3 && parts[1]) {
    return parts[1];
  }
  return null;
};

export const InstallTeamActions = ({ onInstalled }: Props) => {
  const { confirm } = useDialog();
  const { status, actions, loading, refresh } = useTeamLibrary(true);
  // 分类 chip（"all" 或分类 key）
  const [activeChip, setActiveChip] = useState("all");
  // 同步中
  const [syncing, setSyncing] = useState(false);
  // 正在安装 / 卸载 / 从库删除的 skillName（行内 spinner、跨行禁用渲染）
  const [busyName, setBusyName] = useState<string | null>(null);
  // ref 与 state 同步：挡同帧双击（state 异步置位前第二次 handler 仍读到 null）
  const busyNameRef = useRef<string | null>(null);
  // 只读查看壳定义（装之前看看长什么样；null = 关）
  const [viewing, setViewing] = useState<TeamActionViewTarget | null>(null);

  // 仅显示有内容的分类 chip
  const chips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of actions) {
      const key = categoryKeyFromDir(a.dirPath);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const preferred = ["common", "fe", "be", "qa", "other"];
    const keys = [...counts.keys()].sort((a, b) => {
      const ia = preferred.indexOf(a);
      const ib = preferred.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.localeCompare(b);
    });
    return keys.map((value) => ({
      value,
      label: labelTeamSharedCategory(value),
      count: counts.get(value) ?? 0,
    }));
  }, [actions]);

  const filtered: TeamActionEntry[] = useMemo(() => {
    if (activeChip === "all") return actions;
    return actions.filter(
      (a) => categoryKeyFromDir(a.dirPath) === activeChip,
    );
  }, [actions, activeChip]);

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch("/api/team-library/sync", { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "同步失败");
        return;
      }
      await refresh();
      // 成功：同步时间戳自更新，不 toast
    } catch (err) {
      toast.error(
        `同步失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSyncing(false);
    }
  };

  const handleInstall = async (skillName: string) => {
    if (busyNameRef.current) return;
    busyNameRef.current = skillName;
    setBusyName(skillName);
    try {
      const res = await fetch("/api/team-library/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: skillName }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        actionLabel?: string;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "安装失败");
        return;
      }
      // 成功：按钮变「已安装 / 卸载」，不 toast
      await refresh();
      onInstalled?.();
    } catch (err) {
      toast.error(
        `安装失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      busyNameRef.current = null;
      setBusyName(null);
    }
  };

  const handleUninstall = async (skillName: string, label: string) => {
    if (busyNameRef.current) return;
    // 确认弹窗打开期间也挡其它行
    busyNameRef.current = skillName;
    setBusyName(skillName);
    const ok = await confirm({
      title: `卸载「${skillName}」？`,
      description: `推进面板的「${label}」会一并移除`,
      destructive: true,
      confirmLabel: "卸载",
    });
    if (!ok) {
      busyNameRef.current = null;
      setBusyName(null);
      return;
    }
    try {
      const res = await fetch("/api/team-library/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: skillName }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "卸载失败");
        return;
      }
      // 成功：按钮变回「安装」，不 toast
      await refresh();
      onInstalled?.();
    } catch (err) {
      toast.error(
        `卸载失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      busyNameRef.current = null;
      setBusyName(null);
    }
  };

  /** 从共享库远端删除（误上传清理） */
  const handleDeleteFromLibrary = async (skillName: string) => {
    if (busyNameRef.current) return;
    busyNameRef.current = skillName;
    setBusyName(skillName);
    const ok = await confirm({
      title: `从共享库删除「${skillName}」？`,
      description: "从共享库删除、全组同步后消失",
      destructive: true,
      confirmLabel: "从库删除",
    });
    if (!ok) {
      busyNameRef.current = null;
      setBusyName(null);
      return;
    }
    try {
      const res = await fetch("/api/team-library/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: skillName }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        pendingReview?: boolean;
        mrUrl?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "从库删除失败");
        return;
      }
      if (data.pendingReview && data.mrUrl) {
        toast.success("已提交删除 MR，合并后全组生效", {
          action: {
            label: "查看 MR",
            onClick: () => window.open(data.mrUrl, "_blank", "noopener"),
          },
        });
      } else {
        toast.success(`已从共享库删除「${skillName}」`);
      }
      await refresh();
      onInstalled?.();
    } catch (err) {
      toast.error(
        `从库删除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      busyNameRef.current = null;
      setBusyName(null);
    }
  };

  return (
    <section className="space-y-3">
      {/* 工具行：一句说明 + 同步 */}
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          安装后出现在推进面板；带壳参数的 skill 才会列出
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {status?.syncedAt != null && (
            <span
              className="max-w-[5.5rem] truncate text-[10px] text-muted-foreground"
              title={new Date(status.syncedAt).toLocaleString("zh-CN")}
            >
              {formatRelative(status.syncedAt)}
            </span>
          )}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="同步"
            title="同步"
            disabled={syncing || !!busyName}
            onClick={() => void handleSync()}
          >
            {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <ChoiceButton
            shape="chip"
            selected={activeChip === "all"}
            onClick={() => setActiveChip("all")}
          >
            全部 {actions.length}
          </ChoiceButton>
          {chips.map((c) => (
            <ChoiceButton
              key={c.value}
              shape="chip"
              selected={activeChip === c.value}
              onClick={() => setActiveChip(c.value)}
            >
              {c.label} {c.count}
            </ChoiceButton>
          ))}
        </div>
      )}

      {loading && !status ? (
        <LoadingState variant="inline" />
      ) : status?.needsToken ? (
        <EmptyHint size="sm">
          配置 GitLab Token 后可用 ·{" "}
          <Link
            href="/settings"
            className="underline underline-offset-2 hover:text-foreground"
          >
            去设置
          </Link>
        </EmptyHint>
      ) : status && !status.cloned ? (
        <EmptyHint size="sm">未同步过，点右上角同步拉取</EmptyHint>
      ) : filtered.length === 0 ? (
        <EmptyHint size="sm">
          {actions.length === 0 ? "共享库暂无可安装 action" : "此分类暂无内容"}
        </EmptyHint>
      ) : (
        <div className="space-y-2">
          {filtered.map((a) => {
            const catKey = categoryKeyFromDir(a.dirPath);
            const cat = catKey ? labelTeamSharedCategory(catKey) : null;
            const busy = busyName === a.skillName;
            // 仅 skills/<cat>/... 可从库删除；knowledge 镜像不允许删
            const canDeleteFromLibrary = catKey !== null;
            return (
              <div
                key={a.dirPath}
                className={cn(
                  // 操作区相对整行垂直居中
                  "flex items-center gap-3 rounded-md border border-border/60 px-3 py-2.5",
                  a.installed && "opacity-70",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="min-w-0 truncate text-sm font-medium">
                      {a.label}
                    </span>
                    {cat && (
                      <Badge
                        variant="secondary"
                        className="shrink-0 text-[10px]"
                      >
                        {cat}
                      </Badge>
                    )}
                    {a.installed && (
                      <Badge
                        variant="secondary"
                        className="shrink-0 text-[10px] text-muted-foreground"
                      >
                        已安装
                      </Badge>
                    )}
                    {a.author && <AuthorByline author={a.author} />}
                  </div>
                  {a.description && (
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                      {a.description}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className={ROW_ACTION_BTN}
                    onClick={() =>
                      setViewing({
                        label: a.label,
                        skillName: a.skillName,
                        placeholder: a.placeholder,
                        categoryLabel: cat ?? undefined,
                        author: a.author,
                      })
                    }
                  >
                    查看
                  </Button>
                  {a.installed ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className={cn(ROW_ACTION_BTN, "hover:text-destructive")}
                      disabled={!!busyName}
                      onClick={() =>
                        void handleUninstall(a.skillName, a.label)
                      }
                    >
                      {busy ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        "卸载"
                      )}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 px-2.5 text-[12px]"
                      disabled={!!busyName}
                      onClick={() => void handleInstall(a.skillName)}
                    >
                      {busy ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        "安装"
                      )}
                    </Button>
                  )}
                  {/* 从库删除：仅共享沉淀；已装/未装都有、放最后 */}
                  {canDeleteFromLibrary && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className={cn(ROW_ACTION_BTN, "hover:text-destructive")}
                      disabled={!!busyName}
                      onClick={() => void handleDeleteFromLibrary(a.skillName)}
                    >
                      从库删除
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {viewing && (
        <TeamActionViewDialog
          target={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </section>
  );
};
