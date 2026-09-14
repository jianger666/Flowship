"use client";

/**
 * 输入面统一的“切换提供方”动作（chat 输入条 / task 输入条 / 推进弹窗共用）。
 *
 * 三处原来各写一遍 handleProviderChange，确认文案、toast、清覆盖逻辑迟早改漏。
 * 收敛到这里：有会话锚点先弹窗确认 → setTaskProvider（清旧会话锚点、换模型）→
 * 清说话条模型覆盖 → onSwitched(最新 task) → toast。调用方只剩自己的后事：
 * 拉新家模型列表 / 清本地覆盖 state / 继续提交。
 *
 * 跑中禁止切由调用方先拦（running/latch 各面状态不同），后端 setTaskProvider 还会再判一次。
 */

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { useDialog } from "@/hooks/use-dialog";
import { defaultModelForProvider } from "@/lib/types";
import { clearTalkOverride } from "@/lib/talk-model-override";
import { setTaskProvider } from "@/lib/task-store";
import { getSettings } from "@/lib/local-store";
import type { ModelSelection, Task } from "@/lib/types";

export interface UseProviderSwitchOptions {
  taskId: string;
  /** 有会话锚点 = 切即丢精细上下文，先让用户亲口确认；无锚点静默切 */
  sessionAgentId?: string | null;
  /** 切成功后接最新 task（推新 task 给页面 / 拉新家模型列表都走这里） */
  onSwitched: (latest: Task) => void;
  /** 成功 toast 的后半句（输入条：“下条消息…”；推进：“下次推进…”） */
  nextStepHint?: string;
}

export const useProviderSwitch = ({
  taskId,
  sessionAgentId,
  onSwitched,
  nextStepHint = "下条消息用新会话继续",
}: UseProviderSwitchOptions) => {
  const [saving, setSaving] = useState(false);
  // 内部重入 guard（useRef 不闭包过期）：调用方各自 disabled 挡连点不够，hook 公开后下个调用方忘了就是双 PATCH
  const savingRef = useRef(false);
  const { confirm } = useDialog();
  // sessionAgentId 读 ref：弹窗/SSE 间隙落盘了新锚点，闭包旧值会漏弹确认框。
  // 后端还有锁兜底，这里只影响“弹不弹确认”，读最新最稳。
  const sessionAgentIdRef = useRef(sessionAgentId);
  sessionAgentIdRef.current = sessionAgentId;

  const switchProvider = useCallback(
    async (nextId: string, model?: ModelSelection): Promise<Task | null> => {
      if (!nextId?.trim()) return null;
      if (savingRef.current) return null;
      // 确认框和 toast 同口径：入口快照一次，两处都用它（中间隔 await，SSE 可能改掉 ref，两次读会分裂）
      const hadAnchor = !!sessionAgentIdRef.current?.trim();
      if (hadAnchor) {
        const ok = await confirm({
          title: "切换提供方？",
          description:
            "会丢掉当前会话的精细上下文（tool 调用历史），只保留界面消息、磁盘文件和 worktree，新提供方重新开始。",
          confirmLabel: "确认切换",
          cancelLabel: "再想想",
        });
        if (!ok) return null;
      }
      // 新家没模型不发 PATCH：切过去落盘+清会话，首推必“请选择模型”失败，等于切完即晾起。
      // 在这里拦（调用方 advance-dialog 传了用户手挑的 pickedModel，输入条走默认，三入口全收敛）。
      const picked =
        model?.id?.trim() ? model : defaultModelForProvider(getSettings(), nextId);
      if (!picked?.id?.trim()) {
        toast.error("新提供方还没有默认模型，请先选一个模型再切换");
        return null;
      }
      savingRef.current = true;
      setSaving(true);
      try {
        const latest = await setTaskProvider(taskId, nextId, picked);
        // 模型 id 两家不通用：清掉说话条粘住的旧覆盖，防拿上一家的 id 往新提供方发
        clearTalkOverride(taskId);
        onSwitched(latest);
        // toast 跟确认框同口径（入口快照）：静默切的不打扰
        if (hadAnchor) {
          toast.success(`已切换提供方，${nextStepHint}（精细上下文已丢）`);
        }
        return latest;
      } catch (err) {
        toast.error(`切换提供方失败：${(err as Error).message}`);
        return null;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [taskId, onSwitched, nextStepHint, confirm],
  );

  return { switchProvider, saving };
};
