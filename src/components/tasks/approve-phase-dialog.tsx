"use client";

/**
 * Phase ack 高级选项 Dialog（V0.5）
 *
 * 触发：phase 处于 awaiting_ack 时、主按钮「通过 PHASE_LABEL[cur]」旁边的小齿轮图标按钮打开。
 *
 * 提供 2 个选项：
 *   1. 「换新 agent」switch（默认关）
 *      - 关：approve 后旧 agent 继续跑下一 phase、不消耗新 send 配额
 *      - 开：cancel 旧 agent、起一个新 Agent.create run、消耗 +1 send 配额
 *   2. 模型 selector（默认 = settings.defaultModel.id）
 *      - 切到其他模型时 = 隐含勾上「换新 agent」（旧 agent 已经在用旧模型、不可热切）
 *
 * 模型列表懒加载：dialog 打开时 fetchModels(apiKey)。
 * 用户没拉过 / apiKey 没填 → 显示「请先在设置页拉模型列表」、disable selector。
 *
 * 设计取舍：
 *   - 不在 dialog 内编辑 model.params（thinking / effort 等）—— 那是 settings 页才该有的精细配置
 *     用户要切「Opus 4.7 thinking xhigh」之类完整 variant、统一在设置页改
 *     这里只切 base model id、params 保留 settings.defaultModel.params
 *     ← V0.5 简化、V0.6+ 视使用情况看是否加 variant 切换
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Loader2, RotateCcw } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useModels } from "@/hooks/use-models";
import { PHASE_LABEL } from "@/lib/task-display";
import {
  getNextPhase,
  WORKFLOWS,
  type ModelSelection,
  type PhaseId,
} from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // 当前等待 ack 的 phase
  phaseId: PhaseId;
  // 从 settings 拿的默认模型、用户没改时按这个走
  // 没传时 selector disable + 提示去 settings 配
  defaultModel: ModelSelection | null;
  // 拉模型列表用的 apiKey、没填时 selector disable
  apiKey: string;
  // 父组件调用 submitPhaseAck 的实际入口
  // 用户在 dialog 里点「应用并通过」时调
  // - forkAgent: 用户显式勾的「换新 agent」状态
  // - nextModel: 用户最终选的模型（可能就是 defaultModel、可能切了）
  onSubmit: (opts: {
    forkAgent: boolean;
    nextModel: ModelSelection;
  }) => Promise<void>;
  submitting: boolean;
}

export const ApprovePhaseDialog = ({
  open,
  onOpenChange,
  phaseId,
  defaultModel,
  apiKey,
  onSubmit,
  submitting,
}: Props) => {
  // 用户切换的 model id；默认 = settings.defaultModel.id
  const [pickedModelId, setPickedModelId] = useState<string>(
    defaultModel?.id ?? "",
  );
  // 用户勾的「换新 agent」状态；切了模型自动 true 且 disable 关闭
  const [forkAgent, setForkAgent] = useState(false);
  const { models, loading, error, fetchModels } = useModels();

  // dialog 打开时拉模型列表
  // 没拉过 / apiKey 没填 → 拉不动、UI 显示 disable + 提示
  useEffect(() => {
    if (open && apiKey.trim() && models.length === 0 && !loading) {
      void fetchModels(apiKey);
    }
  }, [open, apiKey, models.length, loading, fetchModels]);

  // dialog 重开时把状态重置回默认（防止用户上次切了模型后没提交、下次开还残留）
  useEffect(() => {
    if (open) {
      setPickedModelId(defaultModel?.id ?? "");
      setForkAgent(false);
    }
  }, [open, defaultModel?.id]);

  // 切了模型 = 必须 fork、强制勾上
  const modelChanged = pickedModelId !== (defaultModel?.id ?? "");
  const effectiveFork = forkAgent || modelChanged;

  const handleSubmit = useCallback(async () => {
    if (!defaultModel) return;
    // 切了模型时：构造新 ModelSelection；params 保留默认值（用户没在这里编辑 variant）
    // 没切：直接用默认
    const nextModel: ModelSelection = modelChanged
      ? { id: pickedModelId, params: defaultModel.params }
      : defaultModel;
    await onSubmit({ forkAgent: effectiveFork, nextModel });
  }, [
    defaultModel,
    modelChanged,
    pickedModelId,
    effectiveFork,
    onSubmit,
  ]);

  const handleReset = () => {
    setPickedModelId(defaultModel?.id ?? "");
    setForkAgent(false);
  };

  const phaseLabel = PHASE_LABEL[phaseId];
  // 找下一 phase（V0.5.3 起复用 lib/types.getNextPhase、跟 WORKFLOWS 单源）
  // review 是最后一个、approve 后 workflow 结束、没有下一 phase
  const nextPhase = getNextPhase(WORKFLOWS["feishu-story-impl"], phaseId);
  const nextPhaseLabel = nextPhase ? PHASE_LABEL[nextPhase] : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>通过 {phaseLabel}</span>
            {nextPhaseLabel && (
              <>
                <ArrowRight className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground">{nextPhaseLabel}</span>
              </>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* 模型 selector */}
          <div className="space-y-2">
            <Label className="text-xs">下一 phase 使用的模型</Label>
            {!defaultModel ? (
              <div className="text-xs text-muted-foreground">
                未配置默认模型、请先在「设置」页选好模型
              </div>
            ) : !apiKey.trim() ? (
              <div className="text-xs text-muted-foreground">
                未填 API Key、无法拉取模型列表
              </div>
            ) : (
              <>
                <Select
                  value={pickedModelId || undefined}
                  onValueChange={(v) => v && setPickedModelId(v)}
                  disabled={models.length === 0 || loading}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={
                        loading ? "拉取模型列表中..." : "请选择模型"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <span className="flex flex-col">
                          <span>{m.displayName}</span>
                          <span className="text-xs text-muted-foreground font-mono">
                            {m.id}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {loading && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    拉模型列表...
                  </div>
                )}
                {error && (
                  <div className="text-xs text-destructive">{error}</div>
                )}
                {modelChanged && (
                  <div className="text-xs text-amber-500">
                    已切到其他模型、隐含「换新 agent」
                  </div>
                )}
              </>
            )}
          </div>

          {/* 换新 agent switch */}
          <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="forkAgent"
                className="cursor-pointer text-sm font-medium"
              >
                换新 agent
              </Label>
              <p className="text-xs text-muted-foreground">
                {modelChanged
                  ? "切了模型、必须新起 agent（不可关闭）"
                  : "起一个新 Agent.create run、消耗 +1 send 配额"}
              </p>
            </div>
            <Switch
              id="forkAgent"
              checked={effectiveFork}
              onCheckedChange={setForkAgent}
              disabled={modelChanged || submitting}
            />
          </div>

        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={submitting}
            title="重置为默认（同 agent + 默认模型）"
          >
            <RotateCcw />
            重置
          </Button>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !defaultModel}
          >
            {submitting && <Loader2 className="animate-spin" />}
            {effectiveFork ? "起新 agent 并通过" : "通过"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

