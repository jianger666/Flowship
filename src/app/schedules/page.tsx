"use client";

/**
 * 定时任务管理页（/schedules、中性页）
 *
 * 全部会话（chat + task）里 AI 用 `schedule` 工具设下的定时都汇在这里：
 *  - 筛状态：进行中（含已暂停、已错过没处理的）/ 已结束 / 全部
 *  - 每条能立即触发 / 暂停 / 恢复 / 取消 / 删除记录，点所属会话直达那个会话
 *  - 「已错过」要显眼：应用没开 / 电脑睡眠时到点的不会补发（和 Codex 一致），一次性任务就此静默失效的风险最大，
 *    所以保留记录、让用户能一键「立即触发」拉回来
 *
 * 定时只能由 AI 在会话里创建（没有「应用级」定时），所以这里没有「新建」按钮。
 * 版式对齐会话管理页：max-w-5xl + 返回 + 一句话描述 + 下划线 tab + Card 白底。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { ScheduleRow } from "@/components/schedules/schedule-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChoiceButton } from "@/components/ui/choice-button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { fetchAllSchedules } from "@/lib/schedule-client";
import { isFinishedStatus, scheduleEmptyMessage, type ScheduleListItem } from "@/lib/schedule";

type FilterKey = "ongoing" | "finished" | "all";

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "ongoing", label: "进行中" },
  { key: "finished", label: "已结束" },
  { key: "all", label: "全部" },
];

/** 「进行中」= 还会触发的 + 已暂停 + 已错过（错过的要让用户看见、能处理，所以留在这一栏） */
const isOngoing = (r: ScheduleListItem): boolean =>
  !isFinishedStatus(r.status) || r.status === "missed";

/** 兜底刷新间隔：到点触发 / 自动结束这类服务端状态变化没有推送，页面开着时每 15 秒拉一次 */
const POLL_MS = 15_000;

const SchedulesPage = () => {
  const router = useRouter();
  const [items, setItems] = useState<ScheduleListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  // 最近一次加载的错误（成功就清掉）。首次加载失败 ≠ 「还没有定时」：要把错误亮出来、给重试
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("ongoing");
  const [now, setNow] = useState(() => Date.now());
  // 请求序号：手动刷新 / 15 秒轮询 / 操作后的刷新可能重叠，只认最后发出的那次的响应（慢的旧响应不得盖掉新的）
  const loadSeqRef = useRef(0);

  const load = useCallback(async (opts?: { manual?: boolean }): Promise<void> => {
    const seq = ++loadSeqRef.current;
    // 只有手动刷新 / 重试才转圈：15 秒轮询和操作后的静默刷新也转的话，按钮会周期性闪一下并短暂禁用
    if (opts?.manual) setLoading(true);
    try {
      const list = await fetchAllSchedules();
      if (seq !== loadSeqRef.current) return;
      setItems(list);
      setLoadError(null);
      setNow(Date.now());
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setLoadError((err as Error).message || "未知错误");
      if (opts?.manual) toast.error(`加载失败：${(err as Error).message}`);
    } finally {
      // 只有最新的那次负责收 loading（旧请求晚到不能把新请求的转圈关掉）
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => {
      window.clearInterval(id);
      // 卸载后迟到的响应一律作废
      loadSeqRef.current += 1;
    };
  }, [load]);

  const counts = useMemo(() => {
    const list = items ?? [];
    const ongoing = list.filter(isOngoing).length;
    return { ongoing, finished: list.length - ongoing, all: list.length };
  }, [items]);

  const visible = useMemo(() => {
    const list = items ?? [];
    if (filter === "ongoing") return list.filter(isOngoing);
    if (filter === "finished") return list.filter((r) => !isOngoing(r));
    return list;
  }, [items, filter]);

  const missedCount = useMemo(
    () => (items ?? []).filter((r) => r.status === "missed").length,
    [items],
  );

  const handleBack = () => {
    if (window.history.length > 1) router.back();
    else router.push("/");
  };

  if (items === null && loadError === null) return <LoadingState variant="hero" />;
  if (items === null) {
    // 首次加载就失败：不是「还没有定时」，亮出错误 + 重试
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <Button variant="ghost" size="sm" className="-ml-2 mb-2 px-2" onClick={handleBack}>
          <ArrowLeft />
          返回
        </Button>
        <h1 className="text-lg font-semibold">定时任务</h1>
        <Card className="mt-4 gap-3 p-6">
          <p className="text-sm text-destructive">加载定时任务失败：{loadError}</p>
          <div>
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void load({ manual: true })}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              重试
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6">
        <Button variant="ghost" size="sm" className="-ml-2 mb-2 px-2" onClick={handleBack}>
          <ArrowLeft />
          返回
        </Button>
        <h1 className="text-lg font-semibold">定时任务</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          AI 在对话 / 任务里给自己设的「到点叫我」都在这里。应用没开或电脑睡眠时到点的不会补发，会标成已错过；
          会话归档或删除时，它的定时一起取消。
        </p>
        <div className="mt-4 flex items-center gap-1 border-b pb-2">
          {FILTERS.map((f) => (
            <ChoiceButton
              key={f.key}
              shape="tab"
              selected={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="ml-1 text-xs opacity-70">{counts[f.key]}</span>
            </ChoiceButton>
          ))}
        </div>
      </div>

      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
          <span>
            共 {visible.length} 条
            {missedCount > 0 ? ` · ${missedCount} 条已错过，可点闪电图标立即触发` : ""}
            {loadError ? (
              <span className="ml-2 text-destructive">刷新失败（{loadError}），显示的是上次的数据</span>
            ) : null}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2 text-xs text-muted-foreground"
            disabled={loading}
            onClick={() => void load({ manual: true })}
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            刷新
          </Button>
        </div>
        {visible.length === 0 ? (
          <div className="px-4 py-8">
            <EmptyHint variant="dashed" size="sm" align="center">
              {scheduleEmptyMessage(filter, counts)}
            </EmptyHint>
          </div>
        ) : (
          <div className="divide-y px-2.5">
            {visible.map((r) => (
              <ScheduleRow
                key={`${r.taskId}/${r.id}`}
                record={r}
                now={now}
                // 返回 Promise：操作按钮要等列表刷新回来才放开，避免刷新前连点（「立即触发」会连发两条）
                onChanged={() => load()}
                className="py-2.5"
                footer={
                  // 真链接（不是 button + router.push）：可以新标签 / 新窗口打开、能复制地址
                  <Link
                    href={`/tasks/${r.taskId}`}
                    className="mt-1 flex max-w-full cursor-pointer items-center gap-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <Badge variant={r.taskMode === "chat" ? "outline" : "secondary"} size="xs">
                      {r.taskMode === "chat" ? "对话" : "任务"}
                    </Badge>
                    <span className="min-w-0 truncate">{r.taskTitle || "（无标题）"}</span>
                    {r.taskArchived ? (
                      <Badge variant="outline" size="xs">
                        已归档
                      </Badge>
                    ) : null}
                    <ChevronRight className="size-3 shrink-0" aria-hidden />
                  </Link>
                }
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

export default SchedulesPage;
