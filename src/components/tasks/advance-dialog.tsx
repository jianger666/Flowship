"use client";

/**
 * 推进 Action Dialog（V0.6 重写、V0.6.0.1 任务模式去 chat、末段砍 retry 入口 + 加换模型 + 删推荐标签）
 *
 * V0.6 任务容器模型下：用户从「上一个 action ack 完 / 任务刚创建 / 任务跑挂了」状态进推进 dialog、
 * 选下一个 action 类型 + 写指令。
 *
 * 字段：
 *   - action 类型（plan / build / review / ship / test / learn）
 *     - V0.6.0 stub：ship / test / learn 灰掉、不让选
 *     - V0.6.0.1 起 chat 不再是 action 类型——chat 走 task.mode="chat" 独立通路、ChatView 渲染、跟本 dialog 无关
 *     - dialog 打开时按 task 状态选一个默认 chip 选中、纯减少用户点击；UI 不再标「推荐」二字（避免「我跟你说要走这个」的语义）
 *   - 用户指令（textarea、选填）、placeholder 跟着 action 类型动态变
 *   - forceNewAgent（高级开关、默认 false）：老 agent 跑挂了 / 想跑新 prompt 时打开
 *     - 打开后冒出「本次起新 agent 用的模型」一段 ModelPicker、默认 = settings.defaultModel、
 *       可以临时换 base + 调 thinking/effort 等 params；不开关时本段隐藏、续接走 task.model
 *
 * 行为：
 *   - 提交后父组件调 advanceTask(taskId, { actionType, userInstruction, forceNewAgent, model? })
 *   - 成功后父组件自行关 dialog、新 ActionRecord 通过 SSE 推回来
 *
 * 历史决策：
 *   - V0.6.0.1 中段试过给 ActionTimeline 失败 chip 加 retry 快捷入口（带 `initialActionType` / `retryHint` props）、
 *     用户实测发现「点旧 error chip retry」语义混乱（实际是打断当前 running + 起一个全新 action）、retry chip
 *     整套砍了、本 dialog 入口唯一、不接外部 prefill；同步把 `inferRecommended` 里「last action error → 同 type」
 *     那一条删了、错误后默认仍走流程顺推（plan→build→review）、用户手动改、跟「没有自动重试」语义一致
 *   - V0.6.0.1 末段把右上角「推荐」微标签删了：那条逻辑（has_bug→build / plan→build / build→review）本身
 *     只是「流程顺推 + 业务状态映射」、谈不上智能推荐、暗示「我跟你说要走这个」反而误导；改成「打开 dialog 时
 *     默认选中一个、用户每次自己拍」、函数也重命名为 inferDefaultActionType
 *   - 同时加换模型是为了「task 在不同阶段配不同模型」更自然——比如 plan 用 opus、build 切 sonnet 省 token；
 *     之前 agent 挂掉重启时也没法换模型、只能去 settings 改全局再回来
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ModelPicker } from "@/components/ui/model-picker";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useModels } from "@/hooks/use-models";
import { getSettings } from "@/lib/local-store";
import { ACTION_LABEL } from "@/lib/task-display";
import type { ActionType, ModelSelection, Task } from "@/lib/types";

// V0.6.0 已实装的 action 类型；ship/test/learn 灰掉
// V0.6.0.1：ActionType 不再含 chat（chat 走独立 mode=chat 任务、不复用 action 体系）
const IMPLEMENTED_ACTIONS: ActionType[] = ["plan", "build", "review"];
const STUB_ACTIONS: ActionType[] = ["ship", "test", "learn"];
const STUB_VERSION: Record<ActionType, string | undefined> = {
  plan: undefined,
  build: undefined,
  review: undefined,
  ship: "V0.6.1",
  test: "V0.6.2",
  learn: "V0.6.3",
};

// 跟 runner 的 checkActionPrerequisites 对齐（V0.6 门槛 1 软提示）
// 服务端会双重校验、UI 仅为提示用户「为什么这个 action 不能选」
const inferDisabledReason = (
  task: Task,
  type: ActionType,
): string | null => {
  const hasCompleted = (t: ActionType) =>
    task.actions.some((a) => a.type === t && a.status === "completed");
  switch (type) {
    case "plan":
      return null;
    case "build":
      return hasCompleted("plan") ? null : "需要先有一个已通过的 plan";
    case "review":
      return hasCompleted("build") ? null : "需要先有一个已通过的 build";
    case "ship":
    case "test":
    case "learn":
      return `${STUB_VERSION[type]} 上线`;
    default: {
      const _: never = type;
      return _;
    }
  }
};

// 各 action 的指令 placeholder（V0.6 门槛 6、§6.7 表格）
// 简单情况下用固定文案；首次 plan / 修 bug 等场景由 buildPlaceholder() 进一步细化
const ACTION_PLACEHOLDER: Record<ActionType, string> = {
  plan: "需求是什么？要解决什么问题？",
  build: "具体改什么、指向哪个文件 / 函数 / bug",
  review: "（可选）特别关注什么？默认对照 plan + 飞书需求差异分析",
  ship: "（V0.6.1 上线）PR 标题 / 描述补充",
  test: "（V0.6.2 上线）跑哪些 case？默认全跑",
  learn: "（V0.6.3 上线）learn 不需要 textarea、看 propose 列表",
};

// 根据 task 当前状态 + 选中 action 类型动态调整 placeholder
// - has_bug + build → 「修哪个 bug、症状 / 复现路径」
// - 没 plan + plan → 「需求是什么？要解决什么问题？」（首次）
// - 有 plan + plan → 「方案要怎么调整？」（再次 plan）
const buildPlaceholder = (task: Task, type: ActionType): string => {
  if (type === "build" && task.repoStatus === "has_bug") {
    return "修哪个 bug、症状 / 复现路径";
  }
  if (type === "plan") {
    const hasPlan = task.actions.some(
      (a) => a.type === "plan" && a.status === "completed",
    );
    return hasPlan ? "方案要怎么调整？" : "需求是什么？要解决什么问题？";
  }
  return ACTION_PLACEHOLDER[type];
};

// 算 dialog 打开时默认选中哪个 action chip（V0.6.0.1 起改名、原 inferRecommended）：
// - repoStatus = has_bug → build（业务状态映射：有 bug 就是要回 build）
// - repoStatus = merged → plan（V0.6.3 起改 learn）
// - repoStatus = abandoned → plan（task 已关闭、用户也不会走推进 dialog）
// - 无 action → plan
// - 最近一条 completed action：plan → build / build → review / review → plan（V0.6.1 起改 ship）
// V0.6.0.1 删的：「最后一条 error → 同 type」——之前是 retry 入口的兜底、retry 砍掉后保留它跟「没有自动重试」
// 语义冲突、不如让默认值仍按流程顺推（error 后用户手动选要不要换 type 走、跟没失败时一样）
// 注意：这个函数算的是「默认值」、不是「推荐」——UI 上不会标「推荐」二字、避免暗示「我跟你说要走这个」
const inferDefaultActionType = (task: Task): ActionType => {
  if (task.repoStatus === "has_bug") return "build";
  if (task.repoStatus === "merged") return "plan"; // V0.6.3 起改 learn
  if (task.repoStatus === "abandoned") return "plan";

  if (task.actions.length === 0) return "plan";

  const last = [...task.actions]
    .reverse()
    .find(
      (a) =>
        a.status === "completed" &&
        (a.type === "plan" || a.type === "build" || a.type === "review"),
    );
  if (!last) return "plan";
  if (last.type === "plan") return "build";
  if (last.type === "build") return "review";
  return "plan"; // V0.6.1 起改 ship
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task;
  onSubmit: (input: {
    actionType: ActionType;
    userInstruction: string;
    forceNewAgent: boolean;
    // 用户在 dialog 里临时挑的模型；只在 forceNewAgent=true 时传、其他场景父组件用默认
    model?: ModelSelection;
  }) => Promise<void>;
  submitting: boolean;
}

export const AdvanceDialog = ({
  open,
  onOpenChange,
  task,
  onSubmit,
  submitting,
}: Props) => {
  // dialog 打开时默认选中哪个 chip（不叫推荐、纯减少首次点击）
  const defaultActionType = useMemo(() => inferDefaultActionType(task), [task]);

  // 当前选的 action 类型；dialog 打开时取默认值、用户随便改
  const [actionType, setActionType] = useState<ActionType>(defaultActionType);
  // 用户指令、选填——飞书/上下文都已带上、空也能跑
  const [instruction, setInstruction] = useState("");
  // 高级：强制起新 agent（默认 false、复用旧 agent；老 agent 跑挂了 / 想跑新 prompt 时打开）
  const [forceNewAgent, setForceNewAgent] = useState(false);
  // 强制起新 agent 时用的模型 selection、默认从 settings.defaultModel 拷一份
  // 仅 forceNewAgent=true 时透传给父组件、否则 ignore（续接 Run 不能换模型）
  const [pickedModel, setPickedModel] = useState<ModelSelection>({ id: "" });
  // 可选模型列表、用 settings.apiKey 按需拉一次、跟 settings page / new-task-dialog 同一套
  const { models: availableModels, fetchModels } = useModels();

  useEffect(() => {
    if (!open) return;
    setActionType(defaultActionType);
    setInstruction("");
    setForceNewAgent(false);
    // 默认 = settings.defaultModel（已经包含 params）、用户切别的 base 时 ModelPicker 会自动填默认 params
    const s = getSettings();
    setPickedModel(
      s.defaultModel ?? { id: "" },
    );
    // 第一次打开 / 切 task 时按需拉模型列表（settings page 已拉过、内存里有就跳过）
    if (s.apiKey?.trim() && availableModels.length === 0) {
      void fetchModels(s.apiKey);
    }
  }, [open, defaultActionType, availableModels.length, fetchModels]);

  // 用户当前选的 action 是不是被准入条件挡住（实装类型 + 满足准入）
  const disabledReason = useMemo(
    () => inferDisabledReason(task, actionType),
    [task, actionType],
  );
  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (disabledReason) return false;
    return true;
  }, [submitting, disabledReason]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onSubmit({
      actionType,
      userInstruction: instruction.trim(),
      forceNewAgent,
      // 只在「强制起新 agent」时透传模型选择、续接走 task.model
      model: forceNewAgent && pickedModel.id ? pickedModel : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>推进任务</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          {/* action 类型选择：grid 卡片 */}
          <div className="grid gap-1.5">
            <Label>下一步</Label>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {IMPLEMENTED_ACTIONS.map((type) => {
                const reason = inferDisabledReason(task, type);
                return (
                  <ChoiceButton
                    key={type}
                    shape="card"
                    selected={actionType === type}
                    onClick={() => setActionType(type)}
                    disabled={submitting || !!reason}
                    className="flex flex-col items-start gap-0.5"
                    title={reason ?? `选「${ACTION_LABEL[type]}」推进`}
                  >
                    <div className="flex w-full items-center justify-between gap-1">
                      <span className="font-medium">{ACTION_LABEL[type]}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {reason
                        ? reason
                        : type === "plan"
                          ? "出方案"
                          : type === "build"
                            ? "写代码"
                            : "复核差异"}
                    </span>
                  </ChoiceButton>
                );
              })}
              {STUB_ACTIONS.map((type) => (
                <ChoiceButton
                  key={type}
                  shape="card"
                  selected={false}
                  onClick={() => {}}
                  disabled
                  className="flex flex-col items-start gap-0.5 opacity-50"
                  title={`${STUB_VERSION[type]} 上线`}
                >
                  <div className="flex w-full items-center justify-between gap-1">
                    <span className="font-medium">{ACTION_LABEL[type]}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {STUB_VERSION[type]}
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    未实装
                  </span>
                </ChoiceButton>
              ))}
            </div>
          </div>

          {/* 用户指令、选填——飞书/上下文 doc 已经在 super-prompt 里带上、空提交也能跑 */}
          <div className="grid gap-1.5">
            <Label htmlFor="advance-instruction">
              指令 <span className="text-xs text-muted-foreground">（选填）</span>
            </Label>
            <Textarea
              id="advance-instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder={buildPlaceholder(task, actionType)}
              disabled={submitting}
              rows={4}
              autoFocus
              className="resize-none"
            />
          </div>

          {/* 高级：强制起新 agent */}
          <div className="flex flex-col gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="advance-force-new"
                className="flex-1 cursor-pointer text-xs leading-relaxed text-muted-foreground"
              >
                <span className="block font-medium text-foreground/80">
                  强制起新 agent
                </span>
                <span className="block">
                  老 agent 跑挂了 / 想跑新 prompt 时打开（耗 1 次 send 配额）
                </span>
              </label>
              <Switch
                id="advance-force-new"
                checked={forceNewAgent}
                onCheckedChange={setForceNewAgent}
                disabled={submitting}
              />
            </div>

            {/* 模型选择：只在开关打开后显示、续接 Run 不能换模型 */}
            {forceNewAgent && (
              <div className="grid gap-1.5 border-t border-border/60 pt-2">
                <Label className="text-xs text-foreground/80">
                  本次起新 agent 用的模型
                </Label>
                <ModelPicker
                  models={availableModels}
                  selection={pickedModel}
                  onChange={setPickedModel}
                  disabled={submitting}
                  variant="compact"
                  emptyPlaceholder="（请先在设置页拉取模型列表）"
                />
                <p className="text-[10px] text-muted-foreground">
                  默认 = 设置页选的模型；本次推进后不会改设置页全局默认
                </p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="animate-spin" />}
            {submitting ? "推进中…" : "推进"}
            <ArrowRight />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
