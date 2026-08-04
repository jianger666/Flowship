"use client";

/**
 * 「需求群」按钮：只建/取群，不发产物、不唤起飞书客户端
 *（applink 会先落中间页，体验差，用户拍板去掉自动打开）。
 * 死绑定（本人已不在原群）走与分享同款「重新建群」confirm。
 */

import { useCallback } from "react";
import { toast } from "sonner";

import { useDialog } from "@/hooks/use-dialog";
import { ensureRequirementGroup } from "@/lib/task-store";

interface DeadGroup {
  chatId: string;
  chatName?: string;
}

type EnsureOutcome =
  | { ok: true; chatId: string; created: boolean; chatName?: string }
  | { ok: false; rebuild?: DeadGroup };

const successText = (r: {
  created: boolean;
  chatName?: string;
}): string => {
  const name = r.chatName?.trim();
  if (r.created) return name ? `已建群「${name}」` : "已建需求群";
  return name ? `需求群「${name}」已就绪` : "需求群已就绪";
};

export const useRequirementGroup = () => {
  const { confirm } = useDialog();

  const ensureOnce = useCallback(
    async (
      taskId: string,
      opts: { recreateFrom?: string; guided?: boolean } = {},
    ): Promise<EnsureOutcome> => {
      const guided = opts.guided !== false;
      try {
        const result = await ensureRequirementGroup(taskId, {
          recreateFrom: opts.recreateFrom,
        });
        if (result.ok) {
          if (!result.chatId.trim()) {
            toast.error("需求群创建成功但缺少群 id");
            return { ok: false };
          }
          toast.success(successText(result));
          return {
            ok: true,
            chatId: result.chatId,
            created: result.created,
            chatName: result.chatName,
          };
        }
        if (guided && result.needGroupRebuild && result.chatId) {
          return {
            ok: false,
            rebuild: { chatId: result.chatId, chatName: result.chatName },
          };
        }
        toast.error(result.error || "创建需求群失败");
        return { ok: false };
      } catch (err) {
        toast.error(
          err instanceof Error
            ? `创建需求群失败：${err.message}`
            : "创建需求群失败",
        );
        return { ok: false };
      }
    },
    [],
  );

  const runEnsureGroup = useCallback(
    async (taskId: string): Promise<boolean> => {
      let outcome = await ensureOnce(taskId);
      if (!outcome.ok && outcome.rebuild) {
        const dead = outcome.rebuild;
        const ok = await confirm({
          title: dead.chatName
            ? `你已不在「${dead.chatName}」`
            : "你已不在原来的需求群",
          description: "重建一个需求群？",
          confirmLabel: "重新建群",
        });
        if (!ok) return false;
        outcome = await ensureOnce(taskId, {
          recreateFrom: dead.chatId,
          guided: false,
        });
      }
      return outcome.ok;
    },
    [confirm, ensureOnce],
  );

  return { runEnsureGroup };
};
