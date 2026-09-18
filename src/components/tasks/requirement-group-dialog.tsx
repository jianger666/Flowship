"use client";

/**
 * 需求群设置弹窗：当前绑定可视 + 自动创建/复用 vs 手动绑定已有群。
 *
 * 入口是任务头「需求群」按钮（TaskUtilityActions）。点开不直接动作，先把现状摆出来：
 * - 当前绑定卡：群名 + 群 ID（可复制）+ 状态（正常 / 你已不在群 / 群已失效 / 未确认）
 * - 双模式：自动创建（幂等复用/新建）/ 手动绑定（粘贴 oc_xxx）
 *
 * 换绑是覆盖写，旧群立即失效（播报/回流都跟新群走），所以覆盖时有显式 warning，
 * 主键走 destructive。所有业务失败都做内联展示（可改完重试），不只 toast 了事。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { useDialog } from "@/hooks/use-dialog";
import {
  bindRequirementGroup,
  ensureRequirementGroup,
  getRequirementGroupStatus,
} from "@/lib/task-store";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
}

type Mode = "auto" | "manual";
type Bound = {
  chatId: string;
  chatName?: string;
  ownerStillIn?: boolean;
  membershipUnknown?: boolean;
  unreachable?: boolean;
};

// 与服务端 `extractBindChatId` 同一份正则拷贝（client 不能 import server 模块）：
// 两边改动时必须同步，否则前端回显的“将绑定”与服务端实际绑的会不一致。
// 口径同样对齐服务端：命中 ≥2 个直接算错（不猜第一个），让用户一次只贴一个群 ID。
const CHAT_ID_PATTERN = /oc_[A-Za-z0-9]+/g;
const extractChatId = (raw: string): string | null => {
  const hits = (raw ?? "").match(CHAT_ID_PATTERN) ?? [];
  return hits.length === 1 ? hits[0] : null;
};
const countChatIds = (raw: string): number => (raw ?? "").match(CHAT_ID_PATTERN)?.length ?? 0;

export const RequirementGroupDialog = ({ open, onOpenChange, taskId }: Props) => {
  const { confirm } = useDialog();
  const [mode, setMode] = useState<Mode>("auto");
  // 当前绑定
  const [statusLoading, setStatusLoading] = useState(false);
  const [bound, setBound] = useState<Bound | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [noStory, setNoStory] = useState(false);
  // 手动输入
  const [manualInput, setManualInput] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [bindError, setBindError] = useState<string | null>(null);
  const [bindBotLabel, setBindBotLabel] = useState<string | null>(null);
  // 自动路径
  const [autoError, setAutoError] = useState<string | null>(null);
  const [rebuild, setRebuild] = useState<{ chatId: string; chatName?: string } | null>(null);
  // 飞行态
  const [autoBusy, setAutoBusy] = useState(false);
  const [bindBusy, setBindBusy] = useState(false);
  // 两个复制按钮各记各的：共用一个 bool 会让没点的那个也短暂变 ✅，用户会误以为复制错了东西
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const busy = autoBusy || bindBusy;
  // loadStatus 并发防守：弹窗开着切任务会重载，迟到的旧任务响应不得覆盖新任务的绑定卡
  const loadSeqRef = useRef(0);

  const resetTransient = useCallback(() => {
    setFieldError(null);
    setBindError(null);
    setBindBotLabel(null);
    setAutoError(null);
  }, []);

  const loadStatus = useCallback(async () => {
    const seq = (loadSeqRef.current += 1);
    setStatusLoading(true);
    setStatusError(null);
    setNoStory(false);
    try {
      const r = await getRequirementGroupStatus(taskId);
      if (seq !== loadSeqRef.current) return;
      if (r.ok) {
        setBound(r.bound);
      } else {
        if (r.code === "no_story") {
          setNoStory(true);
          setBound(null);
        } else {
          setStatusError(r.error || "读取当前绑定失败");
        }
      }
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setStatusError(err instanceof Error ? err.message : "读取当前绑定失败");
    } finally {
      if (seq === loadSeqRef.current) setStatusLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (!open) return;
    setMode("auto");
    setManualInput("");
    setRebuild(null);
    resetTransient();
    void loadStatus();
  }, [open, loadStatus, resetTransient]);

  const parsedInputId = useMemo(() => extractChatId(manualInput), [manualInput]);
  const isSameAsBound = !!bound && !!parsedInputId && bound.chatId === parsedInputId;
  const isOverwrite = !!bound && !!parsedInputId && bound.chatId !== parsedInputId;

  const copyText = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      toast.success("已复制");
      window.setTimeout(() => {
        setCopiedKey((cur) => (cur === key ? null : cur));
      }, 1500);
    } catch {
      toast.error("复制失败");
    }
  }, []);

  const close = useCallback(
    (next: boolean) => {
      if (busy) return;
      onOpenChange(next);
    },
    [busy, onOpenChange],
  );

  const runAuto = useCallback(async () => {
    if (autoBusy || bindBusy) return;
    resetTransient();
    setAutoBusy(true);
    try {
      const r = await ensureRequirementGroup(taskId);
      if (r.ok) {
        if (!r.chatId.trim()) {
          setAutoError("需求群创建成功但缺少群 id");
          return;
        }
        // 与 runBind 同款：membershipUnknown 别丢，没确认本人在群里必须告诉用户去看一眼
        const base = r.created
          ? (r.chatName ? `已建群「${r.chatName}」` : "已建需求群")
          : r.chatName ? `需求群「${r.chatName}」已就绪` : "需求群已就绪";
        toast.success(r.membershipUnknown ? `${base}，但没确认你在群里，进群看一眼` : base);
        onOpenChange(false);
        return;
      }
      if (r.needGroupRebuild && r.chatId) {
        setRebuild({ chatId: r.chatId, chatName: r.chatName });
        return;
      }
      setAutoError(r.error || "创建需求群失败");
    } catch (err) {
      setAutoError(err instanceof Error ? `创建需求群失败：${err.message}` : "创建需求群失败");
    } finally {
      setAutoBusy(false);
    }
  }, [autoBusy, bindBusy, onOpenChange, resetTransient, taskId]);

  const runRebuild = useCallback(async () => {
    if (!rebuild || autoBusy || bindBusy) return;
    const ok = await confirm({
      title: rebuild.chatName ? `你已不在「${rebuild.chatName}」` : "你已不在原来的需求群",
      description: "重建一个需求群？旧绑定会被覆盖。",
      confirmLabel: "重新建群",
    });
    if (!ok) return;
    resetTransient();
    setAutoBusy(true);
    try {
      const r = await ensureRequirementGroup(taskId, { recreateFrom: rebuild.chatId });
      if (r.ok) {
        toast.success(r.chatName ? `已建群「${r.chatName}」` : "已建需求群");
        onOpenChange(false);
        return;
      }
      // 重建那一发不再套第二层引导，直接收口
      setAutoError(r.error || "重建需求群失败");
      setRebuild(null);
    } catch (err) {
      setAutoError(err instanceof Error ? `重建失败：${err.message}` : "重建失败");
      setRebuild(null);
    } finally {
      setAutoBusy(false);
    }
  }, [autoBusy, bindBusy, confirm, onOpenChange, rebuild, resetTransient, taskId]);

  const runBind = useCallback(async () => {
    if (bindBusy || autoBusy) return;
    setFieldError(null);
    setBindError(null);
    setBindBotLabel(null);
    const raw = manualInput.trim();
    if (!raw) {
      setFieldError("请先粘贴群 ID");
      return;
    }
    // 一次只认一个群 ID：粘了“从 oc_A 换到 oc_B”这种话术不猜，直接让用户只贴目标那段
    if (countChatIds(raw) > 1) {
      setFieldError("检测到多个群 ID，一次只贴目标群的一段");
      return;
    }
    const parsed = extractChatId(raw);
    if (!parsed) {
      setFieldError("没找到 oc_ 开头的群 ID，请检查是否复制完整");
      return;
    }
    if (bound && bound.chatId === parsed) {
      setFieldError(
        bound.unreachable
          ? "这个群已失效，换一个有效的群 ID"
          : "这个群已经是当前绑定的群，不用重复绑定",
      );
      return;
    }
    // 覆盖写二次确认：旧群立即失效，不是可以随手点的操作
    if (bound) {
      const ok = await confirm({
        title: "确认换绑？",
        description: bound.chatName
          ? `将从「${bound.chatName}」换到 ${parsed}，旧群不再接收播报，群里 @ 机器人会提示没关联。`
          : `将换到 ${parsed}，旧群不再接收播报，群里 @ 机器人会提示没关联。`,
        confirmLabel: "确认换绑",
        destructive: true,
      });
      if (!ok) return;
    }
    setBindBusy(true);
    try {
      const r = await bindRequirementGroup(taskId, parsed);
      if (r.ok) {
        // membershipUnknown 别丢：没确认本人在群里，关弹窗前必须告诉用户去群里看一眼
        if (r.membershipUnknown) {
          toast.success(
            r.chatName
              ? `已绑定到「${r.chatName}」，但没确认你在群里，进群看一眼`
              : `已绑定到 ${r.chatId}，但没确认你在群里，进群看一眼`,
          );
        } else {
          toast.success(r.chatName ? `已绑定到「${r.chatName}」` : `已绑定到 ${r.chatId}`);
        }
        onOpenChange(false);
        return;
      }
      if (r.code === "invalid_input") {
        setFieldError(r.error);
        return;
      }
      if (r.code === "bot_not_in_group") {
        setBindBotLabel(r.botLabel ?? null);
        setBindError(r.error);
        return;
      }
      setBindError(r.error || "换绑失败");
    } catch (err) {
      setBindError(err instanceof Error ? `换绑失败：${err.message}` : "换绑失败");
    } finally {
      setBindBusy(false);
    }
  }, [autoBusy, bindBusy, bound, confirm, manualInput, onOpenChange, taskId]);

  // rebuild 存在时自动模式的主按钮即重建：再跑一遍不带 recreateFrom 的 runAuto 只会
  // 又撞回 needGroupRebuild、白转一圈，所以不给用户留第二个“该点哪个”的选择
  const primary = mode === "auto"
    ? rebuild
      ? { label: "重新建群并绑定", onClick: runRebuild, loading: autoBusy, destructive: true as const }
      : { label: bound ? "自动进入需求群" : "自动创建并绑定", onClick: runAuto, loading: autoBusy, destructive: false as const }
    : { label: isOverwrite ? "确认换绑" : "绑定到这个群", onClick: runBind, loading: bindBusy, destructive: isOverwrite };

  const manualConfirmDisabled =
    bindBusy || autoBusy || !manualInput.trim() || isSameAsBound || noStory;

  return (
    <Dialog open={open} onOpenChange={close} disablePointerDismissal>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>需求群</DialogTitle>
          <DialogDescription>
            分享、自动播报、群里 @ 回任务都走这里绑的群。换绑后旧群立即失效。
          </DialogDescription>
        </DialogHeader>

        {/* 当前绑定 */}
        <div className="rounded-md border bg-muted/40 p-2.5">
          {statusLoading ? (
            <p className="text-sm text-muted-foreground">正在读取当前绑定…</p>
          ) : noStory ? (
            <p className="text-sm text-muted-foreground">当前任务未关联飞书工作项，无法使用需求群。</p>
          ) : statusError ? (
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-destructive">{statusError}</p>
              <Button type="button" variant="outline" size="sm" disabled={statusLoading} onClick={() => void loadStatus()}>
                重试
              </Button>
            </div>
          ) : !bound ? (
            <p className="text-sm text-muted-foreground">还没绑定需求群，选下面一种方式绑定。</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">
                  {bound.chatName?.trim() || "已绑定的需求群"}
                </span>
                {bound.unreachable ? (
                  <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">群已失效</span>
                ) : bound.ownerStillIn === false ? (
                  <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">你已不在群里</span>
                ) : bound.membershipUnknown ? (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">未确认你在群里</span>
                ) : (
                  <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600">正常</span>
                )}
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{bound.chatId}</span>
                <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => void copyText(bound.chatId, "chatId")}>
                  {copiedKey === "chatId" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  复制群 ID
                </Button>
              </div>
              {bound.unreachable && (
                <p className="text-xs text-muted-foreground">原群已不在（解散/失效），用下面“自动创建”重建，或手动绑一个新群。</p>
              )}
              {bound.ownerStillIn === false && !bound.unreachable && (
                <p className="text-xs text-muted-foreground">你已不在当前绑定的群里，分享会发进你看不见的群。先回群，或换绑/重建。</p>
              )}
            </div>
          )}
        </div>

        {/* 双模式 */}
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="绑定方式">
          <button
            type="button"
            role="radio"
            aria-checked={mode === "auto"}
            disabled={busy || noStory}
            onClick={() => { setMode("auto"); resetTransient(); }}
            className={cn(
              "rounded-md border p-2.5 text-left transition-colors",
              mode === "auto" ? "border-ring bg-accent/60" : "hover:bg-muted/60",
            )}
          >
            <span className="block text-sm font-medium">自动创建</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">按工作项建群并绑定，首建自动拉入相关人</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "manual"}
            disabled={busy || noStory}
            onClick={() => { setMode("manual"); resetTransient(); }}
            className={cn(
              "rounded-md border p-2.5 text-left transition-colors",
              mode === "manual" ? "border-ring bg-accent/60" : "hover:bg-muted/60",
            )}
          >
            <span className="block text-sm font-medium">绑定已有群</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">把工作项指向你指定的群</span>
          </button>
        </div>

        {mode === "manual" && (
          <div className="flex flex-col gap-1.5">
            <Input
              value={manualInput}
              onChange={(e) => { setManualInput(e.target.value); setFieldError(null); setBindError(null); setBindBotLabel(null); }}
              placeholder="粘贴群 ID，如 oc_xxxx"
              spellCheck={false}
              autoFocus
              aria-invalid={!!fieldError}
              invalid={!!fieldError}
              onKeyDown={(e) => { if (e.key === "Enter" && !manualConfirmDisabled) { e.preventDefault(); void runBind(); } }}
            />
            {parsedInputId && !isSameAsBound && (
              <p className="font-mono text-xs text-muted-foreground">将绑定：{parsedInputId}</p>
            )}
            {fieldError && <p className="text-xs text-destructive">{fieldError}</p>}
            {isSameAsBound && !fieldError && (
              <p className="text-xs text-muted-foreground">这个群已经是当前绑定的群，不用重复绑定。</p>
            )}
            {isOverwrite && !fieldError && (
              <p className="text-xs text-destructive">
                换绑后{bound?.chatName ? `「${bound.chatName}」` : "旧群"}不再接收播报，旧群里 @ 机器人会提示没关联。
              </p>
            )}
            {bindError && <p className="text-xs text-destructive">{bindError}</p>}
            {bindBotLabel && (
              <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
                <p>先在目标群设置 → 机器人 → 添加机器人，搜索并添加「{bindBotLabel}」，加完点“绑定到这个群”重试。一个群只需加一次。</p>
                <Button
                  type="button" variant="outline" size="sm" className="mt-1.5 h-6 text-xs"
                  onClick={() => void copyText(bindBotLabel, "botName")}
                >
                  {copiedKey === "botName" ? <Check className="size-3" /> : <Copy className="size-3" />}
                  {copiedKey === "botName" ? "已复制" : "复制机器人名"}
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              群 ID 获取：在飞书里打开目标群 → 点群头像进群设置 → 右下角“复制群 ID”。支持粘整段文本（自动提取 oc_ 开头那段，一次只贴一个群的 ID）。
            </p>
            <p className="text-xs text-muted-foreground">换绑前确认你的机器人已在目标群里，否则首次分享会提示手动添加。</p>
          </div>
        )}

        {mode === "auto" && (
          <div className="flex flex-col gap-1.5">
            {autoError && <p className="text-xs text-destructive">{autoError}</p>}
            {rebuild && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2">
                <p className="text-xs">
                  {rebuild.chatName ? `你已不在「${rebuild.chatName}」` : "你已不在原来的需求群"}，分享会发进你看不见的群。点右下角“重新建群并绑定”，旧绑定会被覆盖。
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => close(false)}>
            取消
          </Button>
          {mode === "auto" ? (
            <Button type="button" disabled={busy || noStory} onClick={() => void primary.onClick()} variant={primary.destructive ? "destructive" : "default"}>
              {autoBusy && <Loader2 className="size-4 animate-spin" />}
              {primary.label}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={manualConfirmDisabled}
              onClick={() => void runBind()}
              variant={isOverwrite ? "destructive" : "default"}
            >
              {bindBusy && <Loader2 className="size-4 animate-spin" />}
              {primary.label}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
