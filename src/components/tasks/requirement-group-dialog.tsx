"use client";

/**
 * 需求群设置弹窗：当前关联可视 + 自动创建/复用 vs 手动绑定已有群。
 *
 * 模型（一句话）：一个任务同一时间只关联一个群，分享/播报/群回流全走它。
 * 关联存在任务本地：自动创建、手动绑定、重建都只写本任务，飞书项目工作项的
 * 群绑定碰都不碰（没关联时回落读项目群默认，也只是读）。
 *
 * 入口是任务头「需求群」按钮（TaskUtilityActions）。点开不直接动作，先把现状摆出来：
 * - 当前关联卡：群名 + 群 ID（可复制）+ 状态（正常 / 你已不在群里 / 群已失效 / 未确认）
 * - 双模式：自动创建（幂等复用/新建）/ 手动绑定（粘贴 oc_xxx）
 * - 已有关联时可“取消关联”，回到项目群默认。
 *
 * 换关联是覆盖写，旧群立即收不到本任务的消息，所以覆盖时有显式 warning，
 * 主键走 destructive。所有业务失败都做内联展示（可改完重试），不只 toast 了事。
 *
 * 两处「群里是谁在用机器人」的提醒（第四轮 B4-4）：
 * - 常驻一行「只绑定可信同事的内部群」（群里任何成员 @ 机器人都等于以属主身份读本机文件）；
 *   第一次手动绑定前再确认一次，点过就记 localStorage、以后不打断（lib/trusted-group-ack）；
 * - 绑完发现这个群上还有别的任务：toast 提示「群里的 @ 只会进其中一个」（lib/group-also-bound），不拦。
 *
 * 「群里 AI 的回复方式」三选一（跟随全局 / 流式 / 整条发送，2026-11-06）：任务级覆盖，存 `task.feishuGroupStreaming`，
 * 只在已有关联的群时显示；点选即存（乐观更新，失败回滚 + toast），不跟「绑定 / 创建」那套主按钮绑在一起。
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
import { createGenerationGuard, resolveFailureLanding, resolveLanding } from "@/lib/cancel-slot";
import { describeAlsoBoundBy } from "@/lib/group-also-bound";
import {
  bindRequirementGroup,
  clearRequirementGroupBind,
  ensureRequirementGroup,
  getRequirementGroupStatus,
  setRequirementGroupStreaming,
} from "@/lib/task-store";
import {
  GROUP_STREAMING_OPTIONS,
  groupStreamingChoiceOf,
  groupStreamingValueOf,
  type GroupStreamingChoice,
} from "@/lib/group-streaming-choice";
import type { Task } from "@/lib/types";
import { isImeComposing } from "@/lib/ime";
import {
  browserAckStorage,
  hasTrustedGroupAck,
  TRUSTED_GROUP_CONFIRM_LABEL,
  TRUSTED_GROUP_CONFIRM_TITLE,
  TRUSTED_GROUP_NOTICE,
  writeTrustedGroupAck,
} from "@/lib/trusted-group-ack";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  /**
   * 任务有没有飞书工作项（日常任务 = false）。决定几处文案：没有工作项就没有「项目群默认」可回落，
   * 自动创建用任务标题当群名、只拉本人。缺省按有工作项（原文案）。
   */
  hasStory?: boolean;
  /** 关联变更后把服务端回的最新任务刷回页面（不经过它页面里的任务就是旧的） */
  onTaskUpdate: (task: Task) => void;
  /** 本任务当前的「群回复是否流式」覆盖（`task.feishuGroupStreaming`；缺省 = 跟随全局） */
  groupStreaming?: boolean;
}

type Mode = "auto" | "manual";
type Bound = {
  chatId: string;
  chatName?: string;
  source: "task" | "project";
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

export const RequirementGroupDialog = ({
  open,
  onOpenChange,
  taskId,
  hasStory = true,
  onTaskUpdate,
  groupStreaming,
}: Props) => {
  const { confirm } = useDialog();
  const [mode, setMode] = useState<Mode>("auto");
  // 当前关联
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
  const [clearing, setClearing] = useState(false);
  // 两个复制按钮各记各的：共用一个 bool 会让没点的那个也短暂变 ✅，用户会误以为复制错了东西
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const busy = autoBusy || bindBusy || clearing;
  // loadStatus 并发防守：弹窗开着切任务会重载，迟到的旧任务响应不得覆盖新任务的绑定卡
  const loadSeqRef = useRef(0);
  const onTaskUpdateRef = useRef(onTaskUpdate);
  onTaskUpdateRef.current = onTaskUpdate;
  // 群回复方式：本地值跟着任务字段走（任务刷新 / 切任务时同步），点选时先乐观更新、失败回滚
  const [streamChoice, setStreamChoice] = useState<GroupStreamingChoice>(() => groupStreamingChoiceOf(groupStreaming));
  const [streamBusy, setStreamBusy] = useState(false);
  const streamTaskRef = useRef(taskId);
  streamTaskRef.current = taskId;
  useEffect(() => {
    setStreamChoice(groupStreamingChoiceOf(groupStreaming));
  }, [groupStreaming, taskId]);

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
        const b = r.bound;
        setBound(
          b
            ? {
                chatId: b.chatId,
                ...(b.chatName ? { chatName: b.chatName } : {}),
                source: b.source === "task" ? "task" : "project",
                ...(b.ownerStillIn !== undefined ? { ownerStillIn: b.ownerStillIn } : {}),
                ...(b.membershipUnknown ? { membershipUnknown: true as const } : {}),
                ...(b.unreachable ? { unreachable: true as const } : {}),
              }
            : null,
        );
      } else {
        if (r.code === "no_story") {
          setNoStory(true);
          setBound(null);
        } else {
          setStatusError(r.error || "读取当前关联失败");
        }
      }
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setStatusError(err instanceof Error ? err.message : "读取当前关联失败");
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

  // 请求在途时也允许关弹窗（Esc / X / 取消）：以前 busy 一律拦下，请求挂住（飞书 / 网络慢）时用户只能干等到服务端超时。
  // 在途状态（autoBusy / bindBusy / clearing）住在本组件、不随弹窗内容卸载而丢——关掉再打开主按钮仍是转圈、
  // 不会二次提交；请求落地后照常 toast + onTaskUpdate，用户不会错过结果。
  const close = useCallback(
    (next: boolean) => {
      onOpenChange(next);
    },
    [onOpenChange],
  );

  // 打开代际：每次打开领新代号、关闭作废；**同一实例换任务（taskId 变、open 不翻转）也算换了一代**。
  // 请求在途时用户可能关掉再重开（见上面 close 的说明）或调用方直接换任务，旧请求成功后的「关弹窗」
  // 只对发起它的那一代生效——否则会把用户刚重新打开 / 刚切到的新任务的对话框关掉。
  // toast / onTaskUpdate 不受影响（结果照常落地）；旧一代落地但弹窗还开着时刷新绑定卡（见 landSuccess）。
  // 失败分支同口径（见 landFailure）：内联错误 / rebuild 引导只写给发起它的那一代，旧一代失败改 toast 兜底。
  // cleanup 里 invalidate：依赖变化（关闭 / 换任务）后紧接着的 effect 体会重新 next()（同一次 flush、无异步窗口），
  // 所以只有**卸载**时才真正落在「无存活代」——此后在途请求落地全部丢弃（不再回调 onOpenChange / 触发 refresh）
  const [sessionGuard] = useState(createGenerationGuard);
  useEffect(() => {
    if (open) sessionGuard.next();
    else sessionGuard.invalidate();
    return () => sessionGuard.invalidate();
  }, [open, taskId, sessionGuard]);
  // 取「最新的」loadStatus：请求闭包里的 loadStatus 绑的是发请求时的 taskId，切任务后直接用会把旧任务状态刷进新任务的卡
  const loadStatusRef = useRef(loadStatus);
  loadStatusRef.current = loadStatus;
  // 请求成功后的收尾：同一代 → 关弹窗；弹窗已换代但还开着 → 刷新绑定卡（旧请求改了绑定、新一代开场拉的状态已过期）；已关 → 无事
  const landSuccess = useCallback(
    (gen: number) => {
      const action = resolveLanding(sessionGuard, gen);
      if (action === "close") onOpenChange(false);
      else if (action === "refresh") void loadStatusRef.current();
    },
    [onOpenChange, sessionGuard],
  );
  // 请求失败后的收尾：同一代 → 写内联错误 / rebuild 引导（applyInline）；弹窗已换代 / 已关 / 已卸载 → 不写内联状态
  // （否则任务 A 在途请求失败，会把 A 的 rebuild 引导 / 错误带进已切到的任务 B 的弹窗），改 toast 兜底让用户仍知道失败；
  // toastMessage 为 null 表示这类引导（如 needGroupRebuild）旧一代直接丢弃、不打扰——重开后再点一次就会重新得到。
  // busy 标志（autoBusy / bindBusy / clearing）不走这里：它代表「还有请求在飞」、必须由发起它的请求自己清（见各 run* 的 finally）
  const landFailure = useCallback(
    (gen: number, toastMessage: string | null, applyInline: () => void) => {
      if (resolveFailureLanding(sessionGuard, gen) === "inline") applyInline();
      else if (toastMessage) toast.error(toastMessage);
    },
    [sessionGuard],
  );

  const runAuto = useCallback(async () => {
    if (busy) return;
    resetTransient();
    const gen = sessionGuard.current();
    const failAuto = (message: string) => landFailure(gen, message, () => setAutoError(message));
    setAutoBusy(true);
    try {
      const r = await ensureRequirementGroup(taskId);
      if (r.ok) {
        if (!r.chatId.trim()) {
          failAuto("需求群创建成功但缺少群 id");
          return;
        }
        // membershipUnknown 别丢，没确认本人在群里必须告诉用户去看一眼
        const base = r.created
          ? (r.chatName ? `已建群「${r.chatName}」` : "已建需求群")
          : r.chatName ? `需求群「${r.chatName}」已就绪` : "需求群已就绪";
        toast.success(r.membershipUnknown ? `${base}，但没确认你在群里，进群看一眼` : base);
        if (r.task) onTaskUpdateRef.current(r.task);
        landSuccess(gen);
        return;
      }
      if (r.needGroupRebuild && r.chatId) {
        const { chatId, chatName } = r;
        landFailure(gen, null, () => setRebuild({ chatId, chatName }));
        return;
      }
      failAuto(r.error || "创建需求群失败");
    } catch (err) {
      failAuto(err instanceof Error ? `创建需求群失败：${err.message}` : "创建需求群失败");
    } finally {
      setAutoBusy(false);
    }
  }, [busy, landFailure, landSuccess, resetTransient, sessionGuard, taskId]);

  const runRebuild = useCallback(async () => {
    if (!rebuild || busy) return;
    // gen 必须在 await confirm 之前取：确认期间弹窗可能换了任务 / 被关 / 卸载，闭包里的 taskId、rebuild 还是旧上下文——
    // 若 confirm 之后才取，拿到的是「新一代」的代号，旧任务的请求落地时会被当成当前代（关掉新任务的框、把错误写进新任务的卡）
    const gen = sessionGuard.current();
    const ok = await confirm({
      title: rebuild.chatName ? `你已不在「${rebuild.chatName}」` : "你已不在原来的需求群",
      description: hasStory
        ? "重建一个需求群？只记本任务，飞书项目上的群绑定不受影响。"
        : "重建一个需求群？只记本任务。",
      confirmLabel: "重新建群",
    });
    if (!ok) return;
    // 确认期间已换代：用户确认的是旧上下文（旧任务的 chatId）、现在看到的是别的弹窗，不替他执行
    if (!sessionGuard.isCurrent(gen)) return;
    resetTransient();
    const failRebuild = (message: string) =>
      landFailure(gen, message, () => {
        setAutoError(message);
        setRebuild(null);
      });
    setAutoBusy(true);
    try {
      const r = await ensureRequirementGroup(taskId, { recreateFrom: rebuild.chatId });
      if (r.ok) {
        toast.success(r.chatName ? `已建群「${r.chatName}」` : "已建需求群");
        if (r.task) onTaskUpdateRef.current(r.task);
        landSuccess(gen);
        return;
      }
      // 重建那一发不再套第二层引导，直接收口
      failRebuild(r.error || "重建需求群失败");
    } catch (err) {
      failRebuild(err instanceof Error ? `重建失败：${err.message}` : "重建失败");
    } finally {
      setAutoBusy(false);
    }
  }, [busy, hasStory, landFailure, landSuccess, confirm, rebuild, resetTransient, sessionGuard, taskId]);

  const runBind = useCallback(async () => {
    if (busy) return;
    // gen 在任何 await（两次 confirm）之前取，理由同 runRebuild
    const gen = sessionGuard.current();
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
          : "这个群已经是当前关联的群，不用重复绑定",
      );
      return;
    }
    // 第一次手动绑定：先告知「群里任何成员 @ 机器人都等于以你的身份读本机文件」，确认过一次就不再打断
    // （常驻说明另在下面的绑定区；以「确认过没有」为准、不看当前有没有关联——只剩项目群默认的人同样没被告知过）
    const ackStorage = browserAckStorage();
    if (!hasTrustedGroupAck(ackStorage)) {
      const trusted = await confirm({
        title: TRUSTED_GROUP_CONFIRM_TITLE,
        description: TRUSTED_GROUP_NOTICE,
        confirmLabel: TRUSTED_GROUP_CONFIRM_LABEL,
      });
      if (!trusted) return;
      writeTrustedGroupAck(ackStorage);
      // 确认期间已换代：不替用户继续（ack 是用户确认过的事实，已写入、以后不再打断）
      if (!sessionGuard.isCurrent(gen)) return;
    }
    // 覆盖写二次确认：旧群立即收不到本任务的消息，不是可以随手点的操作
    if (bound) {
      const ok = await confirm({
        title: "确认换关联的群？",
        description:
          (bound.chatName
            ? `本任务将从「${bound.chatName}」换到 ${parsed}，旧群不再收到本任务的消息。`
            : `本任务将换到 ${parsed}，旧群不再收到本任务的消息。`) +
          (hasStory ? "飞书项目上的群绑定不受影响。" : ""),
        confirmLabel: "确认更换",
        destructive: true,
      });
      if (!ok) return;
      // 覆盖写是 destructive：确认期间弹窗已换代（换任务 / 关闭 / 卸载）就不执行——闭包里的 bound / parsed 是旧上下文
      if (!sessionGuard.isCurrent(gen)) return;
    }
    const failBind = (message: string) => landFailure(gen, message, () => setBindError(message));
    setBindBusy(true);
    try {
      const r = await bindRequirementGroup(taskId, parsed);
      if (r.ok) {
        // membershipUnknown 别丢：没确认本人在群里，关弹窗前必须告诉用户去群里看一眼
        if (r.membershipUnknown) {
          toast.success(
            r.chatName
              ? `已关联到「${r.chatName}」，但没确认你在群里，进群看一眼`
              : `已关联到 ${r.chatId}，但没确认你在群里，进群看一眼`,
          );
        } else {
          toast.success(r.chatName ? `已关联到「${r.chatName}」` : `已关联到 ${r.chatId}`);
        }
        // 这个群上还有别的任务也关联着：群里的 @ 只会进其中一个。绑多个是合法用法（比如拆分任务），
        // 所以不拦、不二次确认，只在绑完后告诉用户一声（弹窗马上关，所以用停留久一点的 toast）
        if (r.alsoBoundBy && r.alsoBoundBy.length > 0) {
          toast.warning(describeAlsoBoundBy(r.alsoBoundBy), { duration: 10_000 });
        }
        onTaskUpdateRef.current(r.task);
        landSuccess(gen);
        return;
      }
      if (r.code === "invalid_input") {
        landFailure(gen, r.error, () => setFieldError(r.error));
        return;
      }
      if (r.code === "bot_not_in_group") {
        landFailure(gen, r.error, () => {
          setBindBotLabel(r.botLabel ?? null);
          setBindError(r.error);
        });
        return;
      }
      failBind(r.error || "绑定失败");
    } catch (err) {
      failBind(err instanceof Error ? `绑定失败：${err.message}` : "绑定失败");
    } finally {
      setBindBusy(false);
    }
  }, [bound, busy, hasStory, landFailure, landSuccess, confirm, manualInput, sessionGuard, taskId]);

  const runClear = useCallback(async () => {
    if (!bound || busy) return;
    // gen 在 await confirm 之前取，理由同 runRebuild
    const gen = sessionGuard.current();
    const ok = await confirm({
      title: "取消关联？",
      description: hasStory
        ? "取消后回到项目群默认。飞书项目上的群绑定不受影响。"
        : "取消后本任务不再关联需求群（群本身不会解散）。",
      confirmLabel: "取消关联",
      destructive: true,
    });
    if (!ok) return;
    // 确认期间已换代：destructive 操作不替用户执行（闭包里的 taskId 是旧上下文）
    if (!sessionGuard.isCurrent(gen)) return;
    setClearing(true);
    try {
      const r = await clearRequirementGroupBind(taskId);
      // cleared=false 只可能发生在竞态（按钮只在 source=task 时渲染）：如实报，不谎报成功
      toast.success(
        r.cleared
          ? hasStory ? "已取消关联，回到项目群默认" : "已取消关联"
          : hasStory ? "本来就没有手动关联，已经是项目群默认" : "本来就没有关联需求群",
      );
      onTaskUpdateRef.current(r.task);
      landSuccess(gen);
    } catch (err) {
      toast.error(err instanceof Error ? `取消关联失败：${err.message}` : "取消关联失败");
    } finally {
      setClearing(false);
    }
  }, [bound, busy, hasStory, landSuccess, confirm, sessionGuard, taskId]);

  const pickStreaming = useCallback(
    async (next: GroupStreamingChoice) => {
      if (streamBusy || next === streamChoice) return;
      const forTask = taskId;
      const prev = streamChoice;
      setStreamChoice(next);
      setStreamBusy(true);
      try {
        const r = await setRequirementGroupStreaming(forTask, groupStreamingValueOf(next));
        onTaskUpdateRef.current(r.task);
      } catch (err) {
        // 请求在途时换了任务：旧任务的失败不回滚新任务的选项，toast 兜底让用户仍知道没存上
        if (streamTaskRef.current === forTask) setStreamChoice(prev);
        toast.error(err instanceof Error ? `保存失败：${err.message}` : "保存失败");
      } finally {
        setStreamBusy(false);
      }
    },
    [streamBusy, streamChoice, taskId],
  );

  // rebuild 存在时自动模式的主按钮即重建：再跑一遍不带 recreateFrom 的 runAuto 只会
  // 又撞回 needGroupRebuild、白转一圈，所以不给用户留第二个“该点哪个”的选择
  const primary = mode === "auto"
    ? rebuild
      ? { label: "重新建群并绑定", onClick: runRebuild, loading: autoBusy, destructive: true as const }
      : { label: bound ? "进入需求群" : "自动创建并关联", onClick: runAuto, loading: autoBusy, destructive: false as const }
    : { label: isOverwrite ? "确认更换" : "绑定到这个群", onClick: runBind, loading: bindBusy, destructive: isOverwrite };

  const manualConfirmDisabled =
    busy || !manualInput.trim() || isSameAsBound || noStory;

  return (
    <Dialog open={open} onOpenChange={close} disablePointerDismissal>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>需求群</DialogTitle>
          <DialogDescription>
            分享、自动播报、群里 @ 回任务都走这里关联的群。换关联后旧群立即收不到本任务的消息。
          </DialogDescription>
        </DialogHeader>

        {/* 当前关联 */}
        <div className="rounded-md border bg-muted/40 p-2.5">
          {statusLoading ? (
            <p className="text-sm text-muted-foreground">正在读取当前关联…</p>
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
            <p className="text-sm text-muted-foreground">还没关联需求群，选下面一种方式关联。</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">
                  {bound.chatName?.trim() || "已关联的需求群"}
                </span>
                {bound.unreachable ? (
                  <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">群已失效</span>
                ) : bound.ownerStillIn === false ? (
                  <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">你已不在群里</span>
                ) : bound.membershipUnknown ? (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">未确认你在群里</span>
                ) : (
                  <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">正常</span>
                )}
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{bound.chatId}</span>
                <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => void copyText(bound.chatId, "chatId")}>
                  {copiedKey === "chatId" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  复制群 ID
                </Button>
              </div>
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {bound.source === "task" ? "本任务已关联" : "项目群默认（未手动关联）"}
                </span>
                {bound.source === "task" && (
                  <Button
                    type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground"
                    disabled={busy} onClick={() => void runClear()}
                  >
                    {clearing ? <Loader2 className="size-3 animate-spin" /> : null}
                    取消关联
                  </Button>
                )}
              </div>
              {bound.unreachable && (
                <p className="text-xs text-muted-foreground">原群已不在（解散/失效），用下面“自动创建”重建，或手动关联一个新群。</p>
              )}
              {bound.ownerStillIn === false && !bound.unreachable && (
                <p className="text-xs text-muted-foreground">你已不在当前关联的群里，分享会发进你看不见的群。先回群，或换关联/重建。</p>
              )}
            </div>
          )}
        </div>

        {/* 群里 AI 的回复方式：只在已有关联的群时显示 */}
        {!statusLoading && !statusError && !noStory && bound && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">群里 AI 的回复方式</span>
            <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="群里 AI 的回复方式">
              {GROUP_STREAMING_OPTIONS.map((o) => (
                <button
                  key={o.choice}
                  type="button"
                  role="radio"
                  aria-checked={streamChoice === o.choice}
                  disabled={streamBusy}
                  onClick={() => void pickStreaming(o.choice)}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-sm transition-colors",
                    streamChoice === o.choice ? "border-ring bg-accent/60" : "hover:bg-muted/60",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {GROUP_STREAMING_OPTIONS.find((o) => o.choice === streamChoice)?.hint}
              只管这个任务的群；飞书私聊的流式看设置页的全局开关。
            </p>
          </div>
        )}

        {/* 双模式 */}
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="关联方式">
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
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {hasStory ? "按工作项建群并关联到本任务，首建自动拉入相关人" : "按任务标题建群并关联到本任务，首建只拉你本人和你的机器人"}
            </span>
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
            <span className="mt-0.5 block text-xs text-muted-foreground">把本任务指向你指定的群</span>
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
              onKeyDown={(e) => {
                // IME 选词中的 Enter 不是确认
                if (e.key === "Enter" && !isImeComposing(e) && !manualConfirmDisabled) {
                  e.preventDefault();
                  void runBind();
                }
              }}
            />
            {parsedInputId && !isSameAsBound && (
              <p className="font-mono text-xs text-muted-foreground">将关联：{parsedInputId}</p>
            )}
            {fieldError && <p className="text-xs text-destructive">{fieldError}</p>}
            {isSameAsBound && !fieldError && (
              <p className="text-xs text-muted-foreground">这个群已经是当前关联的群，不用重复绑定。</p>
            )}
            {isOverwrite && !fieldError && (
              <p className="text-xs text-destructive">
                关联后{bound?.chatName ? `「${bound.chatName}」` : "旧群"}不再收到本任务的消息。
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
            <p className="text-xs text-muted-foreground">绑定前确认你的机器人已在目标群里，否则首次分享会提示手动添加。</p>
            <p className="text-xs text-muted-foreground">{TRUSTED_GROUP_NOTICE}</p>
          </div>
        )}

        {mode === "auto" && (
          <div className="flex flex-col gap-1.5">
            {autoError && <p className="text-xs text-destructive">{autoError}</p>}
            <p className="text-xs text-muted-foreground">{TRUSTED_GROUP_NOTICE}</p>
            {rebuild && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2">
                <p className="text-xs">
                  {rebuild.chatName ? `你已不在「${rebuild.chatName}」` : "你已不在原来的需求群"}，分享会发进你看不见的群。点右下角“重新建群并绑定”，只记本任务。
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => close(false)}>
            {busy ? "关闭" : "取消"}
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
