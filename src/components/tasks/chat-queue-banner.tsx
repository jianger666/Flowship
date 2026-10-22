"use client";

/**
 * chat 排队提示条 + 可展开队列面板（D 批次、grok P1「队列可视化」）
 *
 * 原来只有一行文案「已排队…（第 N 条）」；现在点击展开 Popover 面板：
 * 列出排队中消息（GET /chat-queue 实时拉）、每行可「删除」/「立即发送」。
 * 删除走 DELETE /chat-queue → server removeQueuedChatMessages 会 publish
 * queue_failed(cancelled)，客户端 ledger 经 SSE 自动清 pending 占位、条数自然回落。
 * 「立即发送」= POST send_now，server 分两条路（chat-queue-send-now）：
 *   1. 能插话（Cursor 本地 run）：不停止、把这条插进正在跑的这一轮；
 *   2. 不能（自定义 provider 等）：take → 先救出其余排队 → stop → 用该条起新会话 → 其余排队放回队列
 *      （其余排队消息保留，只打断当前回复）。
 * 客户端按 provider 预判走哪条（lib/queue-banner.predictSendNowMode）：会打断时 tooltip 如实说明并先确认。
 * 不再走 promote + stop（stop 会 failQueuedItems 清整队、含刚置顶那条）。
 *
 * 常驻挂载（第三轮 review R6-01）：0 条时本组件返回 null 而不是被父组件卸载——
 * 条件挂载下「排队从无到有」每次都是「挂上来就是 N」，自动弹开永远不可达。
 * 「从无到有」由 chat-view 在订阅到的实时 dispatch 里判定、递增 autoOpenTick 通知本组件；
 * 进入 / 切回已有排队的会话属于恢复、不递增（不弹，N1）。
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Loader2, Pencil, Trash2, X, Zap } from "lucide-react";
import { toast } from "sonner";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Tooltip } from "@/components/ui/tooltip";
import { LoadingState } from "@/components/ui/loading-state";
import { summarize } from "@/components/tasks/event-stream/utils";
import { useDialog } from "@/hooks/use-dialog";
import { resolveTaskProvider } from "@/lib/agent-provider";
import { getSettings } from "@/lib/local-store";
import {
  predictSendNowMode,
  queueEditKeyAction,
  sendNowCopy,
} from "@/lib/queue-banner";
import { prepareRunArgs } from "@/lib/run-args";
import {
  fetchChatQueue,
  removeChatQueueItems,
  sendQueuedChatMessageNow,
  updateChatQueueItem,
  type ChatQueueItem,
} from "@/lib/task-store";
import type { Task } from "@/lib/types";
import { isImeComposing } from "@/lib/ime";

interface Props {
  task: Task;
  /** 本地 ledger 统计的排队条数（banner 文案用；面板列表以服务端为准）；0 = 不显示（组件返回 null） */
  queuedCount: number;
  /**
   * 「排队从无到有」的实时信号：chat-view 在订阅到的 ledger dispatch 里发现 0→N 时递增。
   * 本组件只认「变化」，初值取挂载时的值（挂载 = 恢复，不弹，N1）。
   */
  autoOpenTick: number;
}

export const ChatQueueBanner = ({ task, queuedCount, autoOpenTick }: Props) => {
  const taskId = task.id;
  const { confirm } = useDialog();
  // 面板开关（受控：打开时拉一次服务端队列快照）
  const [open, setOpen] = useState(false);
  // 服务端队列快照（null = 尚未拉到）
  const [items, setItems] = useState<ChatQueueItem[] | null>(null);
  // 拉取飞行中
  const [loading, setLoading] = useState(false);
  // 删除飞行中的 itemId 集合（行内按钮 disabled、防连点）
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  // 「立即发送」飞行中的 itemId 集合（防连点）
  const [sendingNow, setSendingNow] = useState<ReadonlySet<string>>(new Set());
  // 行内编辑态：itemId → 草稿文本（null = 不在编辑）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  // A：排队从无到有时自动弹开一次（用户要常驻感知；关了等下一轮 0→N 再弹）。
  // 「从无到有」由 chat-view 判定、经 autoOpenTick 递增通知（本组件常驻挂载，0 条返回 null，R6-01）。
  // 初值取挂载时的 tick（第二轮 review N1）：进入一个本来就有排队的会话不算「从无到有」，
  // 不弹——否则切回来时 composer 的自动聚焦会被弹层抢走
  const lastTickRef = useRef(autoOpenTick);
  // 面板是不是「自动弹开」的：自动弹开时不抢焦点（U3b-02——焦点被抢到第一条的「编辑」铅笔上，
  // 用户接着打的字落不进输入框、按空格 / 回车会点开行内编辑）；手动点开照常聚焦进弹层
  const [autoOpened, setAutoOpened] = useState(false);
  // 请求代际：自动弹开飞行中用户手动关了面板，回来的非空不许再顶开（违背意图）
  const reqRef = useRef(0);
  // 拉取失败标记：失败与空队是两回事，面板文案要分开（之前失败也显示“队列已空”，误导）
  const [loadError, setLoadError] = useState(false);

  const loadQueue = (openWhenNonEmpty: boolean) => {
    const myReq = ++reqRef.current;
    setLoading(true);
    setLoadError(false);
    void fetchChatQueue(taskId)
      .then((list) => {
        if (reqRef.current !== myReq) return; // 过期回包（切 task / 手动关后）直接丢
        setItems(list);
        // 自动弹开专用：队里真有东西才开。本地 pending 可能是刚发出的在途
        // （会话恢复/重连时常见），空队弹开只剩一句“队列已空”，尴尬。
        if (openWhenNonEmpty && list.length > 0) {
          setAutoOpened(true);
          setOpen(true);
        }
      })
      .catch((err) => {
        if (reqRef.current !== myReq) return;
        toast.error(`拉取队列失败：${(err as Error).message}`);
        setItems(null);
        setLoadError(true);
      })
      .finally(() => {
        if (reqRef.current === myReq) setLoading(false);
      });
  };

  const refreshQueue = () => loadQueue(false);

  const handleOpenChange = (next: boolean) => {
    reqRef.current++; // 手动开关作废在飞的自动弹开
    setAutoOpened(false);
    setOpen(next);
    if (!next) return;
    refreshQueue();
  };

  // 排队从无到有（chat-view 递增 tick）→ 先拉快照、有货才弹；队内 1→2 不重复弹、不打断编辑
  useEffect(() => {
    if (autoOpenTick === lastTickRef.current) return;
    lastTickRef.current = autoOpenTick;
    loadQueue(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenTick]);

  // 队列清空（返回 null 之前先把面板态收干净）：否则 open / 编辑态残留，下一轮排队一出现面板就是开着的；
  // 在飞的快照请求也作废，避免回包把它重新顶开
  useEffect(() => {
    if (queuedCount > 0) return;
    reqRef.current++;
    setOpen(false);
    setAutoOpened(false);
    setEditingId(null);
  }, [queuedCount]);

  const handleDelete = (itemId: string) => {
    setDeleting((prev) => new Set(prev).add(itemId));
    void removeChatQueueItems(taskId, [itemId])
      // 排队操作静默：成功只改列表（用户看得见行消失），
      // 已发出删不到也只对齐列表、不弹；真失败才弹 error。
      .then(() => {
        setItems((prev) =>
          prev ? prev.filter((it) => it.itemId !== itemId) : prev,
        );
      })
      .catch((err) => {
        toast.error(`删除失败：${(err as Error).message}`);
      })
      .finally(() => {
        setDeleting((prev) => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
      });
  };

  /** 按窗口绑定的 provider 预判「立即发送」会不会打断当前回复（读设置，只在面板打开后 / 点击时调用） */
  const currentSendNowMode = () =>
    predictSendNowMode(resolveTaskProvider(task, getSettings()));

  /**
   * 立即发送：prepareRunArgs 拿 bootArgs → （会打断时先确认）→ POST send_now。
   * server 原子编排：能插话就直接插，不能就 take→先救出其余排队→stop→起新会话→其余排队放回；
   * 本地列表直接去掉该条。
   */
  const handleSendNow = async (itemId: string) => {
    const args = prepareRunArgs(task);
    if (!args) return; // prepareRunArgs 已 toast

    // 会打断当前回复的路径（不能插话）：如实说明、让用户确认，别让「立即发送」悄悄把正在进行的回复停掉
    const confirmCopy = sendNowCopy(currentSendNowMode()).confirm;
    if (confirmCopy && !(await confirm(confirmCopy))) return;

    setSendingNow((prev) => new Set(prev).add(itemId));
    void sendQueuedChatMessageNow(taskId, itemId, {
      apiKey: args.apiKey,
      model: args.model,
    })
      .then(() => {
        setItems((prev) =>
          prev ? prev.filter((it) => it.itemId !== itemId) : prev,
        );
        setOpen(false);
      })
      .catch((err) => {
        toast.error(`立即发送失败：${(err as Error).message}`);
      })
      .finally(() => {
        setSendingNow((prev) => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
      });
  };

  /**
   * 行内编辑保存：PUT 原地改文本（仍在原位置排队）。
   * 成功 / 空文本都静默（行内状态本身就是反馈）；真失败才弹 error。
   */
  const handleSaveEdit = (itemId: string) => {
    const text = editDraft.trim();
    if (!text) return;
    setSavingEdit(true);
    void updateChatQueueItem(taskId, itemId, text)
      .then((updated) => {
        setItems((prev) =>
          prev
            ? prev.map((it) =>
                it.itemId === itemId
                  ? { ...it, displayText: updated.displayText }
                  : it,
              )
            : prev,
        );
        setEditingId(null);
      })
      .catch((err) => {
        toast.error(`更新失败：${(err as Error).message}`);
      })
      .finally(() => setSavingEdit(false));
  };

  // 常驻挂载、0 条不渲染（R6-01）：必须在所有 hook 之后——条数在 0 与 N 之间来回时 hook 顺序不能变
  if (queuedCount <= 0) return null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {/* hover 提示走 Tooltip、不用原生 title（规范「Hover 提示」）。PopoverTrigger.render 必须是可交互 DOM，
          Tooltip 不透传 onClick / ref，塞进 render 会让点击打不开面板——所以包在外层 span（同 chat-mcp-picker）；
          原先挂在 button 上的 mx / mb 与 flex 版式搬到外层 span，button 用 flex-1 铺满 */}
      <Tooltip content="点击管理排队消息（可编辑 / 删除 / 立即发送）">
        <span className="mx-2.5 mb-1.5 flex">
          <PopoverTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-left text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-primary/15"
              >
                {/* 静态点：事件流 v2「动效同屏只留一处主动效」——同屏已有状态行 shimmer，
                    排队条的点不再 animate-ping（它也没登记 prefers-reduced-motion 静止态） */}
                <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden />
                <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-primary-foreground">
                  {queuedCount}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  条排队中 · 点击管理
                </span>
                <ChevronRight className="size-3.5 shrink-0 opacity-70" />
              </button>
            }
          />
        </span>
      </Tooltip>
      <PopoverContent
        align="start"
        className="w-80 p-2"
        initialFocus={!autoOpened}
      >
        <div className="mb-1.5 px-1 text-xs font-medium">排队中的消息</div>
        {loading && items === null && !loadError ? (
          <LoadingState variant="inline" className="px-1" />
        ) : loadError && items === null ? (
          <div className="px-1 py-2 text-xs text-destructive">
            队列拉取失败，稍后重新点条子再试
          </div>
        ) : !items || items.length === 0 ? (
          <EmptyHint size="sm">队列已空（可能刚被发出或删除）</EmptyHint>
        ) : (
          <ul className="space-y-1">
            {items.map((it) => {
              const busy =
                deleting.has(it.itemId) || sendingNow.has(it.itemId);
              const isEditing = editingId === it.itemId;
              if (isEditing) {
                return (
                  <li key={it.itemId} className="rounded-md bg-muted/40 px-1.5 py-1">
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={2}
                      autoFocus
                      disabled={savingEdit}
                      onKeyDown={(e) => {
                        // 输入法组合输入中的 Enter / Esc 归输入法（queueEditKeyAction 内同口径再判一次）
                        if (isImeComposing(e)) return;
                        const act = queueEditKeyAction(e);
                        if (!act) return;
                        if (act.preventDefault) e.preventDefault();
                        // Esc 只退出编辑：拦住冒泡，弹层的 Esc 关闭（base-ui useDismiss 在 document 冒泡阶段监听）
                        // 不会一起触发——先退出编辑、再按一次才关弹层（V14-05）
                        if (act.stopPropagation) e.stopPropagation();
                        if (act.type === "save") handleSaveEdit(it.itemId);
                        else setEditingId(null);
                      }}
                      className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
                    />
                    <div className="mt-1 flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        disabled={savingEdit}
                        aria-label="取消编辑"
                        className="flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        <X className="size-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveEdit(it.itemId)}
                        disabled={savingEdit}
                        aria-label="保存编辑"
                        className="flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        {savingEdit ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Check className="size-3" />
                        )}
                      </button>
                    </div>
                  </li>
                );
              }
              return (
                <li
                  key={it.itemId}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-muted/40"
                >
                  <Tooltip content={it.displayText}>
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {summarize(it.displayText) || "（纯附件消息）"}
                    </span>
                  </Tooltip>
                  <Tooltip content="编辑这条排队消息">
                    <span className="inline-flex">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(it.itemId);
                          setEditDraft(it.displayText);
                        }}
                        disabled={busy}
                        aria-label="编辑"
                        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        <Pencil className="size-3" />
                      </button>
                    </span>
                  </Tooltip>
                  <Tooltip content={sendNowCopy(currentSendNowMode()).tooltip}>
                    <span className="inline-flex">
                      <button
                        type="button"
                        onClick={() => void handleSendNow(it.itemId)}
                        disabled={busy}
                        aria-label="立即发送"
                        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        {sendingNow.has(it.itemId) ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Zap className="size-3" />
                        )}
                      </button>
                    </span>
                  </Tooltip>
                  <Tooltip content="从队列删除">
                    <span className="inline-flex">
                      <button
                        type="button"
                        onClick={() => handleDelete(it.itemId)}
                        disabled={busy}
                        aria-label="删除"
                        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
                      >
                        {deleting.has(it.itemId) ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Trash2 className="size-3" />
                        )}
                      </button>
                    </span>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
};
