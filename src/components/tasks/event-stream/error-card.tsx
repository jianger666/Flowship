"use client";

/**
 * 错误卡（2026-07-28 事件流体验第二批）
 *
 * 以前 error 事件的三个毛病叠在一起：进「工作过程」组 → run 一结束整组自动收起、
 * 用户正在读的错误啪一下消失；视觉权重跟 thinking 一样是条灰细行；runner 明明把原始
 * 诊断写进了 `meta.detail`（见 sdk-error.ts）、UI 从来没读过。跑了 40 分钟的 build 挂了，
 * 用户只能看到一行灰字，分不清是网断了、key 过期了还是 worktree 锁没了。
 *
 * 现在：error 不进组（见 lib/chat-turns.ts 的 MEMBER_KINDS）、独立平铺成这张卡——
 * destructive 边框 + 底衬给足视觉权重，原始诊断可展开，一键复制整份，
 * 当轮失败按「是谁触发了这一轮」给恢复入口（单点判定 chat-turns.resolveErrorRecovery）：
 * 用户消息触发 → 「重试」（把触发它的那条消息原样再发）；推进 / action 触发 → 「重新推进」；
 * 其余（定时 / 后台唤醒 / 答题回执 / 找不到触发源）→ 没有入口——重放旧消息会把几天前的指令再执行一遍。
 * 回合内工具失败（grep 挂了、run 还在继续）不走这张卡，见 isInTurnToolErrorEvent。
 *
 * 事件流 v2 分两档视觉权重：「当轮失败」（最新一条 error 且 agent 没在跑）保持整块 destructive
 * 底衬——这是用户此刻要处理的；其余翻篇的历史错误降成中性白卡 + 3px 红色左线，只留「这里挂过」的
 * 记号。旧版每条错误都是整块粉底，一个断过好几次的会话整屏发红，真正要处理的那条反而淹没。
 * 没加 alert 角色（也没加 live 属性）：事件流是虚拟列表，卡片每次滚进视口都会重新挂载，live region 会反复播报。
 *
 * 第二轮 review V3-03：限流 / 鉴权 / 模型不可用 / 上下文超长 / 额度 / 网络这几类最常见的失败，
 * 以前只展示英文原串、按钮只有 查看详情 / 复制 / 重试——看不懂、也不知道该去哪改，
 * 鉴权类还把「重试」摆成主按钮（同模型同 key 必然再败）。现在由 lib/error-classify.ts 分类：
 * 命中时正文换成中文标题 + 一句建议，**英文原串进「查看详情」与「复制」**；
 * 并按类给入口——鉴权 / 额度 / 模型不可用 →「去设置」；上下文超长（仅 chat）→「开新对话」；
 * 这几类的「重试」降为次要按钮（不隐藏：用户去设置改完回来要能直接点）。
 * 「换模型」没做成按钮——输入条底栏的模型下拉就在卡片下方，事件流与输入条之间没有现成的
 * 「聚焦模型选择器」通道，不为它新造跨组件通信，只在建议文案里说。未命中任何分类则与旧版完全一致。
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  CircleAlert,
  Loader2,
  MessageSquarePlus,
  RotateCcw,
  Settings,
  Zap,
} from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { useNewChat } from "@/hooks/use-new-chat";
import { useTaskList } from "@/hooks/use-task-list";
import { isCurrentErrorCard, resolveErrorRecovery } from "@/lib/chat-turns";
import { buildErrorCardModel, planErrorActions } from "@/lib/error-classify";
import { settingsUrl } from "@/lib/settings-link";
import type { TaskEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

import { useStreamActions } from "./stream-actions";
import { ActionTag, EVENT_LABEL, formatTs } from "./utils";

/**
 * 「开新对话」：复用现成的新建对话 hook（建空草稿 / 复用没说过话的草稿；带上当前工作目录），
 * 成功后跟 /chats 落点页一样 upsert + push 到详情。
 * hook 只在这个子组件里调：绝大多数错误卡用不上它，不该让每张卡都去订阅任务列表。
 */
const NewChatButton = ({ repoPaths }: { repoPaths?: string[] }) => {
  const router = useRouter();
  const { upsertTask } = useTaskList();
  const { createChat, creating } = useNewChat((task) => {
    upsertTask(task);
    router.push(`/tasks/${task.id}`);
  });
  return (
    <Button
      variant="destructive"
      size="xs"
      disabled={creating}
      onClick={() => void createChat({ repoPaths })}
    >
      {creating ? (
        <Loader2 className="animate-spin motion-reduce:animate-none" />
      ) : (
        <MessageSquarePlus />
      )}
      开新对话
    </Button>
  );
};

export const ErrorCard = ({
  ev,
  events,
  runActive,
  eventsTruncated,
  actionTag,
  mode = "chat",
  repoPaths,
}: {
  ev: TaskEvent;
  /** 整条事件流：判断这条错误是不是「当轮失败」（决定给不给重试入口） */
  events: readonly TaskEvent[];
  /**
   * **属主主 run** 正在跑：这条错误已经翻篇、不给重试。
   * 只认属主 run——旁路群答疑 run 在飞与主任务的错误无关，不能让「当轮失败」整张翻成历史样式（第三轮 review D6-02）。
   */
  runActive?: boolean;
  /**
   * events 只是最近一段窗口（task.eventsTruncated）：往前找不到触发源不代表没有触发源，
   * 交给 resolveErrorRecovery 降级（task 形态 → 重新推进），否则长 run 崩了重开页面红卡没有出口（D8-02）
   */
  eventsTruncated?: boolean;
  /** log 形态的 action 归属标（plan / build / …），chat 形态不传 */
  actionTag?: string;
  /** 事件流形态：chat 才有「开新对话」（task 的上下文超长只建议换模型）；默认 chat */
  mode?: "chat" | "task";
  /** 当前对话绑定的工作目录：「开新对话」带上，别让用户重新选目录 */
  repoPaths?: string[];
}) => {
  // 原始诊断展开态：默认收起（正文那句友好文案已够日常判断、详情是排查时才看）
  const [detailOpen, setDetailOpen] = useState(false);
  // 重试飞行中：按钮 spinner + 禁用，防连点发两条
  const [retrying, setRetrying] = useState(false);
  // 重试能力由上层通过 Context 注入（chat 是 ChatView、task 是详情页）；没有 Provider = 不显示
  const streamActions = useStreamActions();

  const detail =
    typeof ev.meta?.detail === "string" ? ev.meta.detail.trim() : "";
  // 卡片要画的几段（分类 / 中文标题 + 建议 / 原始诊断 / 复制串）单点在 lib 里算：
  // 未命中分类 = 与旧版一致（有诊断、且不等于正文才单开详情）；命中 = 原串进详情
  const model = buildErrorCardModel(ev.text, detail, { mode });
  const classified = model.classification.kind !== "unknown";
  const hasDetail = model.diagnostic !== "";
  const plan = planErrorActions(model.classification.kind, { mode });

  // 「当轮失败」= 最新一条 error 且 agent 没在跑：视觉上整块 destructive、并且只有它给恢复入口——
  // 翻历史时点旧错误上的重试会把今天最后那条消息重发出去、完全不是用户预期
  const isCurrent = isCurrentErrorCard(events, ev.id, !!runActive);
  // 恢复入口按「是谁触发了这一轮」分流（单点判定）：用户消息 → 重试；推进 / action → 重新推进；其余没有。
  // 只靠 isCurrent 会让推进失败 / 定时失败 / 后台唤醒失败的卡也带「重试」、点了重放旧 user_reply
  const recovery = isCurrent
    ? resolveErrorRecovery(events, ev.id, { truncated: eventsTruncated, mode })
    : ({ kind: "none" } as const);
  const retrySource = recovery.kind === "retry" ? recovery.source : undefined;
  const canRetry = !!streamActions?.onRetryLastMessage && !!retrySource;
  const canReadvance =
    !!streamActions?.onReadvance && recovery.kind === "readvance";
  // 鉴权 / 额度 / 模型不可用 / 上下文超长：同模型同 key 同上下文重试必然再败 → 降为次要（outline），
  // 主按钮让给「去设置 / 开新对话」；不隐藏——改完设置回来要能直接点
  const retryVariant = plan.retry === "primary" ? "destructive" : "outline";

  const handleRetry = () => {
    if (retrying || !streamActions?.onRetryLastMessage) return;
    setRetrying(true);
    void (async () => {
      try {
        await streamActions.onRetryLastMessage?.(retrySource);
      } finally {
        setRetrying(false);
      }
    })();
  };

  return (
    <div
      className={cn(
        "mt-1.5 rounded-md border p-3",
        isCurrent
          ? "border-destructive/40 bg-destructive/5"
          : "border-border border-l-[3px] border-l-destructive bg-card",
      )}
    >
      <div className="flex items-start gap-2">
        <CircleAlert
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-destructive"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-destructive">
              {EVENT_LABEL.error}
            </span>
            {actionTag && <ActionTag label={actionTag} />}
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {formatTs(ev.ts)}
            </span>
          </div>
          {classified ? (
            <>
              {/* 命中分类：中文标题 + 一句建议；英文原串在下面「查看详情」里 */}
              <div className="mt-1 text-sm font-medium leading-relaxed wrap-break-word text-foreground">
                {model.headline}
              </div>
              <div className="mt-0.5 text-xs leading-relaxed wrap-break-word text-muted-foreground">
                {model.hint}
              </div>
            </>
          ) : (
            // whitespace-pre-wrap：正文可能是多行结构（如 wk 门禁「结论 + 逐条明细」），
            // 不保留换行会被压成一团、明细完全没法读
            <div className="mt-1 text-sm leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground">
              {ev.text}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {hasDetail && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setDetailOpen((v) => !v)}
              >
                查看详情
                <ChevronDown
                  className={cn(
                    "transition-transform",
                    detailOpen && "rotate-180",
                  )}
                />
              </Button>
            )}
            {/* 复制走公共件（勾号反馈 / 失败提示都在里面）；p-1.5 对齐旁边 xs 按钮的 h-6 */}
            <CopyButton
              text={model.copyText}
              label="复制错误"
              className="p-1.5"
            />
            {/* 去设置：凭据 / 提供方 / 模型列表都在设置页「模型」栏；走 Link 客户端跳转（不整页刷新、对话不丢） */}
            {plan.settings && isCurrent && (
              <Link
                href={settingsUrl(plan.settings.focus)}
                className={cn(
                  buttonVariants({ variant: "destructive", size: "xs" }),
                  "no-underline",
                )}
              >
                <Settings />
                去设置
              </Link>
            )}
            {plan.newChat && isCurrent && (
              <NewChatButton repoPaths={repoPaths} />
            )}
            {canRetry && (
              <Button
                variant={retryVariant}
                size="xs"
                disabled={retrying}
                onClick={handleRetry}
              >
                <RotateCcw className={cn(retrying && "animate-spin")} />
                重试
              </Button>
            )}
            {canReadvance && (
              <Button
                variant={retryVariant}
                size="xs"
                onClick={() => streamActions?.onReadvance?.()}
              >
                <Zap />
                重新推进
              </Button>
            )}
          </div>
          {detailOpen && hasDetail && (
            // 诊断串常含无空格长 JSON / 路径：wrap-anywhere + 限高滚动，别把卡片撑爆
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-2 font-mono text-[11px] leading-relaxed text-muted-foreground wrap-anywhere">
              {model.diagnostic}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
};
