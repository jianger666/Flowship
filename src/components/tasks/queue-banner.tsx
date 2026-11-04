"use client";

/**
 * 排队提示条 + 可展开队列面板（chat 与 task 共用的一份面板）
 *
 * chat（chat-queue-banner）与 task（talk-queue-banner）的排队条以前各写一套，行为也分叉：
 * chat 能编辑 / 立即发送、task 只能删。现在面板（Popover、行内编辑、立即发送确认、自动弹开 / 不抢焦点、
 * 条数文案）收成这一份，两边只提供各自的**数据来源与动作**（{@link QueueBannerAdapter}）：
 *
 * - chat：打开面板时 GET /chat-queue 拉服务端快照（`fetchRows`）；
 * - task：条目就是 SSE `talk_queue` 帧的整份快照（`rows`，实时），不另拉接口。
 *
 * 一行能做什么由行自己声明（`canEdit` / `canSendNow`）：task 的群属主话 / 群回执 / 群提问不是「用户自己的话」，
 * 只给删除（规则在 lib/talk-queue 的 canEditTalkQueueItem / canSendNowTalkQueueItem，服务端同样校验）。
 *
 * 常驻挂载（第三轮 review R6-01）：0 条时本组件返回 null 而不是被父组件卸载——
 * 条件挂载下「排队从无到有」每次都是「挂上来就是 N」，自动弹开永远不可达。
 * 「从无到有」由调用方判定、递增 autoOpenTick 通知本组件；进入 / 切回已有排队的会话属于恢复、不递增（不弹，N1）。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { queueEditDraftToSave, queueEditKeyAction, type SendNowCopy } from "@/lib/queue-banner";
import { isImeComposing } from "@/lib/ime";

/** 暂存中（held）的行按钮的 hover 提示 */
const QUEUE_ROW_HELD_TIP = "正在为另一条的「立即发送」让位，稍后可操作";

/** 面板里的一行 */
export interface QueueRow {
  id: string;
  /** 展示文本（也是 hover 全文）。task 的快照里只有 ≤120 字预览，编辑起手用 adapter.loadEditText 取完整正文 */
  text: string;
  canEdit: boolean;
  canSendNow: boolean;
  /** 保存编辑时允许清空文字（这条带图片 / 文件，只剩附件也能发） */
  allowEmptyEdit?: boolean;
  /** 文本上方的一行附加信息（task：来源标签 / 发话人 / 机器人标）；chat 没有 */
  prefix?: ReactNode;
  /**
   * 正在为「立即发送」让位（task：服务端把它暂存、稍后放回）：行照常显示——条数不跳变——
   * 但编辑 / 立即发送 / 删除都禁用（服务端也拒）。
   */
  held?: boolean;
}

/**
 * 面板的动作。约定：真失败 **throw**（面板统一 toast「xx失败：原因」）；
 * 「这条已经送出 / 被移除了」不是错误，由适配器吞掉、返回 `"gone"`，面板静默对齐。
 */
export interface QueueBannerAdapter {
  /** 编辑起手要的完整正文；缺省直接用 row.text。返回 null = 这条已不在队里 */
  loadEditText?: (row: QueueRow) => Promise<string | null>;
  /** 保存编辑；返回新文本，或 "gone" */
  save: (row: QueueRow, text: string) => Promise<{ text: string } | "gone">;
  remove: (row: QueueRow) => Promise<void>;
  /**
   * 立即发送的预备：能发就返回「真正去发」的闭包，不能发（比如缺凭据，已自行 toast）返回 null。
   * 面板按 {@link sendNowCopy} 决定要不要先确认，确认后才调这个闭包。
   */
  prepareSendNow: (row: QueueRow) => (() => Promise<"sent" | "gone">) | null;
  /** 立即发送的 hover 提示 + 确认框文案（会打断当前回复时带 confirm）；按需读（打开面板后 / 点击时） */
  sendNowCopy: () => SendNowCopy;
}

interface Props {
  /** 条上显示的排队条数（chat：本地 ledger 统计；task：快照条数）；0 = 不显示（组件返回 null） */
  queuedCount: number;
  /**
   * 「排队从无到有」的实时信号：调用方发现 0→N 时递增。本组件只认「变化」，
   * 初值取挂载时的值（挂载 = 恢复，不弹，N1）。
   */
  autoOpenTick: number;
  adapter: QueueBannerAdapter;
  /** 实时条目（task：SSE 快照）。给了就不再自己拉 */
  rows?: readonly QueueRow[];
  /** 打开面板 / 自动弹开时拉一次条目（chat）。`rows` 与它二选一 */
  fetchRows?: () => Promise<QueueRow[]>;
  /** 条子的 hover 提示 */
  tooltip?: string;
}

export const QueueBanner = ({
  queuedCount,
  autoOpenTick,
  adapter,
  rows: liveRows,
  fetchRows,
  tooltip = "点击管理排队消息（可编辑 / 删除 / 立即发送）",
}: Props) => {
  const { confirm } = useDialog();
  // 面板开关（受控：fetch 模式下打开时拉一次服务端队列快照）
  const [open, setOpen] = useState(false);
  // fetch 模式的服务端快照（null = 尚未拉到）；live 模式不用
  const [fetched, setFetched] = useState<QueueRow[] | null>(null);
  // 拉取飞行中
  const [loading, setLoading] = useState(false);
  // 删除飞行中的 id 集合（行内按钮 disabled、防连点）
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  // 「立即发送」飞行中的 id 集合（防连点）
  const [sendingNow, setSendingNow] = useState<ReadonlySet<string>>(new Set());
  // 行内编辑态：id → 草稿文本（null = 不在编辑）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  // 点「编辑」后取完整正文飞行中的 id（loadEditText 是异步的；期间该行按钮 disabled）
  const [loadingEditId, setLoadingEditId] = useState<string | null>(null);
  // A：排队从无到有时自动弹开一次（用户要常驻感知；关了等下一轮 0→N 再弹）。
  // 「从无到有」由调用方判定、经 autoOpenTick 递增通知（本组件常驻挂载，0 条返回 null，R6-01）。
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

  const rows = liveRows ?? fetched;

  const loadQueue = (openWhenNonEmpty: boolean) => {
    if (!fetchRows) return;
    const myReq = ++reqRef.current;
    setLoading(true);
    setLoadError(false);
    void fetchRows()
      .then((list) => {
        if (reqRef.current !== myReq) return; // 过期回包（切 task / 手动关后）直接丢
        setFetched(list);
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
        setFetched(null);
        setLoadError(true);
      })
      .finally(() => {
        if (reqRef.current === myReq) setLoading(false);
      });
  };

  const handleOpenChange = (next: boolean) => {
    reqRef.current++; // 手动开关作废在飞的自动弹开
    setAutoOpened(false);
    setOpen(next);
    if (!next) return;
    loadQueue(false);
  };

  // 排队从无到有（调用方递增 tick）→ fetch 模式先拉快照、有货才弹；live 模式条目已在手、直接弹；
  // 队内 1→2 不重复弹、不打断编辑
  useEffect(() => {
    if (autoOpenTick === lastTickRef.current) return;
    lastTickRef.current = autoOpenTick;
    if (fetchRows) {
      loadQueue(true);
    } else if (liveRows && liveRows.length > 0) {
      setAutoOpened(true);
      setOpen(true);
    }
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

  const markDone = (set: typeof setDeleting, id: string) =>
    set((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  /** fetch 模式：本地列表去掉一行（live 模式下条目由快照驱动，这里无事可做） */
  const dropLocal = (id: string) =>
    setFetched((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));

  const handleDelete = (row: QueueRow) => {
    setDeleting((prev) => new Set(prev).add(row.id));
    void adapter
      .remove(row)
      // 排队操作静默：成功只改列表（用户看得见行消失），
      // 已发出删不到也只对齐列表、不弹；真失败才弹 error。
      .then(() => dropLocal(row.id))
      .catch((err) => {
        toast.error(`删除失败：${(err as Error).message}`);
      })
      .finally(() => markDone(setDeleting, row.id));
  };

  /**
   * 立即发送：先预备（缺凭据等自行 toast 并返回 null）→（会打断当前回复时先确认）→ 去发。
   * 发成功关面板；已送出（gone）只对齐列表。
   */
  const handleSendNow = async (row: QueueRow) => {
    const run = adapter.prepareSendNow(row);
    if (!run) return;

    // 会打断当前回复的路径：如实说明、让用户确认，别让「立即发送」悄悄把正在进行的回复停掉
    const confirmCopy = adapter.sendNowCopy().confirm;
    if (confirmCopy && !(await confirm(confirmCopy))) return;

    setSendingNow((prev) => new Set(prev).add(row.id));
    void run()
      .then((result) => {
        dropLocal(row.id);
        if (result === "sent") setOpen(false);
      })
      .catch((err) => {
        toast.error(`立即发送失败：${(err as Error).message}`);
      })
      .finally(() => markDone(setSendingNow, row.id));
  };

  const handleStartEdit = (row: QueueRow) => {
    if (!adapter.loadEditText) {
      setEditingId(row.id);
      setEditDraft(row.text);
      return;
    }
    setLoadingEditId(row.id);
    void adapter
      .loadEditText(row)
      .then((full) => {
        if (full === null) return; // 已不在队里：行会随快照消失
        setEditingId(row.id);
        setEditDraft(full);
      })
      .catch((err) => {
        toast.error(`读取原文失败：${(err as Error).message}`);
      })
      .finally(() => setLoadingEditId((cur) => (cur === row.id ? null : cur)));
  };

  /**
   * 行内编辑保存：原地改文本（仍在原位置排队）。
   * 成功静默（行内状态本身就是反馈）；真失败才弹 error；
   * 保存时这条已经送出（gone）→ 退出编辑并说一声：用户的改动没有生效，别让他以为发出去的是改后的。
   */
  const handleSaveEdit = (row: QueueRow) => {
    const text = queueEditDraftToSave(editDraft, row.allowEmptyEdit === true);
    if (text === null) return;
    // 正在编辑的行恰好被暂存（为另一条的「立即发送」让位）：服务端会按「已不在队里」拒，
    // 但这条并没有送出——不能走下面 gone 的「已经送出」提示。留在编辑态，等窗口结束再存。
    if (row.held === true) {
      toast.info(QUEUE_ROW_HELD_TIP);
      return;
    }
    setSavingEdit(true);
    void adapter
      .save(row, text)
      .then((result) => {
        if (result === "gone") {
          toast.info("这条消息已经送出，修改没有生效");
          setEditingId(null);
          return;
        }
        setFetched((prev) =>
          prev ? prev.map((r) => (r.id === row.id ? { ...r, text: result.text } : r)) : prev,
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

  const sendCopy = adapter.sendNowCopy();

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {/* hover 提示走 Tooltip、不用原生 title（规范「Hover 提示」）。PopoverTrigger.render 必须是可交互 DOM，
          Tooltip 不透传 onClick / ref，塞进 render 会让点击打不开面板——所以包在外层 span（同 chat-mcp-picker）；
          原先挂在 button 上的 mx / mb 与 flex 版式搬到外层 span，button 用 flex-1 铺满 */}
      <Tooltip content={tooltip}>
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
        {loading && rows === null && !loadError ? (
          <LoadingState variant="inline" className="px-1" />
        ) : loadError && rows === null ? (
          <div className="px-1 py-2 text-xs text-destructive">
            队列拉取失败，稍后重新点条子再试
          </div>
        ) : !rows || rows.length === 0 ? (
          <EmptyHint size="sm">队列已空（可能刚被发出或删除）</EmptyHint>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {rows.map((row) => {
              const locked = row.held === true;
              const busy =
                locked ||
                deleting.has(row.id) ||
                sendingNow.has(row.id) ||
                loadingEditId === row.id;
              const isEditing = editingId === row.id;
              if (isEditing) {
                return (
                  <li key={row.id} className="rounded-md bg-muted/40 px-1.5 py-1">
                    {row.prefix ? (
                      <div className="mb-1 flex flex-wrap items-center gap-1 text-xs">
                        {row.prefix}
                      </div>
                    ) : null}
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
                        if (act.type === "save") handleSaveEdit(row);
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
                        onClick={() => handleSaveEdit(row)}
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
                  key={row.id}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    {row.prefix ? (
                      <div className="mb-0.5 flex flex-wrap items-center gap-1 text-xs">
                        {row.prefix}
                      </div>
                    ) : null}
                    <Tooltip content={row.text}>
                      <span
                        className={
                          row.prefix
                            ? "line-clamp-2 block break-words text-xs"
                            : "block truncate text-xs"
                        }
                      >
                        {summarize(row.text) || "（纯附件消息）"}
                      </span>
                    </Tooltip>
                  </div>
                  {row.canEdit ? (
                    <Tooltip content={locked ? QUEUE_ROW_HELD_TIP : "编辑这条排队消息"}>
                      <span className="inline-flex">
                        <button
                          type="button"
                          onClick={() => handleStartEdit(row)}
                          disabled={busy}
                          aria-label="编辑"
                          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                          {loadingEditId === row.id ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Pencil className="size-3" />
                          )}
                        </button>
                      </span>
                    </Tooltip>
                  ) : null}
                  {row.canSendNow ? (
                    <Tooltip content={locked ? QUEUE_ROW_HELD_TIP : sendCopy.tooltip}>
                      <span className="inline-flex">
                        <button
                          type="button"
                          onClick={() => void handleSendNow(row)}
                          disabled={busy}
                          aria-label="立即发送"
                          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                          {sendingNow.has(row.id) ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Zap className="size-3" />
                          )}
                        </button>
                      </span>
                    </Tooltip>
                  ) : null}
                  <Tooltip content={locked ? QUEUE_ROW_HELD_TIP : "从队列删除"}>
                    <span className="inline-flex">
                      <button
                        type="button"
                        onClick={() => handleDelete(row)}
                        disabled={busy}
                        aria-label="删除"
                        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
                      >
                        {deleting.has(row.id) ? (
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
