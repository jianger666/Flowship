"use client";

/**
 * 「分享到需求群」交互收口：调 shareToGroup + 成功 toast / 两类失败引导。
 * 调用方自己管 sharing spinner（防双击）；本 hook 不管飞行态。
 *
 * 两条引导（都是「点两下就能自救」的预期内失败、不是错误 toast 了事）：
 *
 * 1. **bot 不在群**（后来者的 bot 事后拉不进去、缺 scope 不可补救）→ 弹窗给准确 bot 名 +
 *    一键复制 + 三步指引 → 用户加完点「已添加，重试发送」→ 原样重发。一个群只需一次。
 * 2. **本人已不在群**（退群 / 被踢 / 群解散，而 bot 还在里面）→ confirm 问一句、
 *    确认后带 `recreateFrom` 重建一个新群再发。不重建的话用户是**完全卡死**的：
 *    工作项上的死绑定会让每次分享都静默发进他看不见的群。
 *
 * 所以 runShare 的 promise **要等引导走完才结算**：调用方 `await runShare(...)` 拿到的
 * true 是「这份内容真发出去了」，它才好关自己那层确认弹窗。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { BotAddGuideDialog } from "@/components/tasks/bot-add-guide-dialog";
import { useDialog } from "@/hooks/use-dialog";
import { prepareShareContent } from "@/lib/share-to-group";
import { shareToGroup, type ShareToGroupInput } from "@/lib/task-store";

/** 服务端没给名字时的兜底称呼（正常路径 server 一定带 botLabel） */
const BOT_LABEL_FALLBACK = "你的机器人";

/** 死绑定引导要用的信息：哪个群失效了 */
interface DeadGroup {
  chatId: string;
  chatName?: string;
}

/** 一次发送的结果：needBot / rebuild 有值 = 该走对应引导 */
type SendOutcome =
  | { ok: true }
  | { ok: false; needBot?: string; rebuild?: DeadGroup };

/** 引导弹窗挂起态：记住原样载荷，用户加完机器人点重试直接重发 */
interface GuideState {
  botLabel: string;
  taskId: string;
  body: ShareToGroupInput;
}

/**
 * 成功回执带上群名——「已发到「XXX需求群」」。
 * 这一条本身就是死绑定的第一道自查：发错地方了用户当场就能看出来。
 */
const shareSuccessText = (r: { created: boolean; chatName?: string }): string => {
  const name = r.chatName?.trim();
  if (r.created) return name ? `已建群「${name}」并分享` : "已建需求群并分享";
  return name ? `已发到「${name}」` : "已分享到需求群";
};

export const useShareToGroup = () => {
  const { confirm } = useDialog();
  // 引导弹窗状态；null = 不弹
  const [guide, setGuide] = useState<GuideState | null>(null);
  // 重试发送飞行中（按钮 spinner + 防双击）
  const [retrying, setRetrying] = useState(false);
  // 挂起中的 runShare resolve——引导结束（取消 / 重试成功 / 其它错误）时才调
  const pendingResolveRef = useRef<((ok: boolean) => void) | null>(null);

  // 卸载时结算残留 promise，避免调用方永远 await 不到
  useEffect(
    () => () => {
      pendingResolveRef.current?.(false);
      pendingResolveRef.current = null;
    },
    [],
  );

  /** 收掉引导态 + 结算挂起的 runShare */
  const settle = useCallback((ok: boolean) => {
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;
    setGuide(null);
    setRetrying(false);
    resolve?.(ok);
  }, []);

  /**
   * 真正发一次请求；成功 toast / 普通失败 toast 都在这里收口。
   * `guided: false` = 调用方不再接引导（重建后的那一发），任何失败一律 toast 收口，
   * 免得引导链绕回自己形成死循环。
   */
  const send = useCallback(
    async (
      taskId: string,
      body: ShareToGroupInput,
      opts: { guided?: boolean } = {},
    ): Promise<SendOutcome> => {
      const guided = opts.guided !== false;
      try {
        const result = await shareToGroup(taskId, {
          ...body,
          // artifact 不截断（正文走 md 文件）、其余截 4000 进卡片——口径见 lib/share-to-group
          content: prepareShareContent(body.kind, body.content),
        });
        if (result.ok) {
          toast.success(shareSuccessText(result));
          return { ok: true };
        }
        if (guided && result.needManualBotAdd) {
          return {
            ok: false,
            needBot: result.botLabel?.trim() || BOT_LABEL_FALLBACK,
          };
        }
        if (guided && result.needGroupRebuild && result.chatId) {
          return {
            ok: false,
            rebuild: { chatId: result.chatId, chatName: result.chatName },
          };
        }
        toast.error(result.error || "分享失败");
        return { ok: false };
      } catch (err) {
        toast.error(
          err instanceof Error ? `分享失败：${err.message}` : "分享失败",
        );
        return { ok: false };
      }
    },
    [],
  );

  /**
   * 死绑定引导：问一句 → 确认后带 `recreateFrom` 重建群再原样重发。
   * 重发那一轮不再接引导（guided: false），失败就 toast 收口。
   */
  const rebuildAndResend = useCallback(
    async (
      taskId: string,
      body: ShareToGroupInput,
      dead: DeadGroup,
    ): Promise<SendOutcome> => {
      const ok = await confirm({
        title: dead.chatName
          ? `你已不在「${dead.chatName}」`
          : "你已不在原来的需求群",
        description: "重建一个需求群再发？",
        confirmLabel: "重新建群",
      });
      if (!ok) return { ok: false };
      return send(taskId, { ...body, recreateFrom: dead.chatId }, { guided: false });
    },
    [confirm, send],
  );

  const runShare = useCallback(
    async (taskId: string, body: ShareToGroupInput): Promise<boolean> => {
      let outcome = await send(taskId, body);
      if (!outcome.ok && outcome.rebuild) {
        outcome = await rebuildAndResend(taskId, body, outcome.rebuild);
      }
      if (outcome.ok) return true;
      const botLabel = outcome.needBot;
      if (!botLabel) return false;
      return new Promise<boolean>((resolve) => {
        // 极端情况：上一轮引导还挂着（同一 hook 实例被连点两次）→ 先结算掉旧的
        pendingResolveRef.current?.(false);
        pendingResolveRef.current = resolve;
        setGuide({ botLabel, taskId, body });
      });
    },
    [rebuildAndResend, send],
  );

  const handleRetry = useCallback(async () => {
    if (!guide || retrying) return;
    setRetrying(true);
    const outcome = await send(guide.taskId, guide.body);
    if (outcome.ok) {
      settle(true);
      return;
    }
    if (outcome.needBot) {
      // 还是不在群（没加成 / 加错了）——弹窗留着让他再来一次
      setRetrying(false);
      setGuide({ ...guide, botLabel: outcome.needBot });
      toast.error("机器人还不在群里，确认添加后再试");
      return;
    }
    if (outcome.rebuild) {
      // 极罕见：加机器人这段时间里绑定被换成了另一个「我不在」的群。
      // 不在引导弹窗里套第二层引导，收掉让用户重新点一次分享走完整流程
      toast.error("需求群已失效，重新点一次分享");
      settle(false);
      return;
    }
    // 其它错误已经 toast 过，收掉引导别把用户困在弹窗里
    settle(false);
  }, [guide, retrying, send, settle]);

  /** 调用方渲染它（bot 不在群时才会出现，平时是 null） */
  const guideDialog = guide ? (
    <BotAddGuideDialog
      open
      botLabel={guide.botLabel}
      retrying={retrying}
      onRetry={() => void handleRetry()}
      onCancel={() => settle(false)}
    />
  ) : null;

  return { runShare, guideDialog };
};
