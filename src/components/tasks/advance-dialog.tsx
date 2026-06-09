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
import { ArrowRight, Loader2, Paperclip, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
import { useImageAttach } from "@/hooks/use-image-attach";
import { useModels } from "@/hooks/use-models";
import { getSettings } from "@/lib/local-store";
import { ACTION_LABEL, computeBatchProgress } from "@/lib/task-display";
import type { ImagePayload } from "@/lib/task-store";
import { cn } from "@/lib/utils";
import { TEST_STRATEGY_LABEL } from "@/lib/types";
import type { ActionType, ModelSelection, Task } from "@/lib/types";

// V0.6.1 已实装的 action 类型；test/learn 灰掉
// V0.6.0.1：ActionType 不再含 chat（chat 走独立 mode=chat 任务、不复用 action 体系）
const IMPLEMENTED_ACTIONS: ActionType[] = ["plan", "build", "review", "ship"];
const STUB_ACTIONS: ActionType[] = ["test", "learn"];
const STUB_VERSION: Record<ActionType, string | undefined> = {
  plan: undefined,
  build: undefined,
  review: undefined,
  ship: undefined,
  test: "V0.6.2",
  learn: "V0.6.3",
};

// 跟 runner 的 checkActionPrerequisites 对齐（V0.6 门槛 1 软提示）
// 服务端会双重校验、UI 仅为提示用户「为什么这个 action 不能选」
const inferDisabledReason = (
  task: Task,
  type: ActionType,
  ctx: { host?: string; token?: string } = {},
): string | null => {
  const hasCompleted = (t: ActionType) =>
    task.actions.some((a) => a.type === t && a.status === "completed");
  switch (type) {
    case "plan":
      return null;
    case "build":
      // V0.6.17：放开 plan 前置——无 plan 也能直接 build（按指令改、范围以指令为准）
      return null;
    case "review":
      return hasCompleted("build") ? null : "需要先有一个已通过的 build";
    case "ship":
      // V0.6.1：ship 准入 = 至少 1 个 build 已 approve + settings 配齐 gitHost/gitToken
      if (!hasCompleted("build")) return "需要先有一个已通过的 build";
      if (!ctx.host) return "需要先在「设置 → GitLab 配置」填 host";
      if (!ctx.token) return "需要先在「设置 → GitLab 配置」填 PAT";
      return null;
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
  ship: "（可选）MR 标题 / 描述要点、不填自动生成",
  test: "（V0.6.2 上线）跑哪些 case？默认全跑",
  learn: "（V0.6.3 上线）learn 不需要 textarea、看 propose 列表",
};

// 根据 task 当前状态 + 选中 action 类型动态调整 placeholder
// - has_bug + build → 「修哪个 bug、症状 / 复现路径」
// - 没 plan + plan → 「需求是什么？要解决什么问题？」（首次）
// - 有 plan + plan → 「方案要怎么调整？」（再次 plan）
// - 已有 MR + ship → 「已有 v<N> MR、本次继续推、可选填要点」
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
  if (type === "ship" && task.mrs.length > 0) {
    const maxVersion = Math.max(...task.mrs.map((m) => m.version));
    return `已有 v${maxVersion} MR、本次继续推、可选填要点`;
  }
  return ACTION_PLACEHOLDER[type];
};

// 算 dialog 打开时默认选中哪个 action chip（V0.6.0.1 起改名、原 inferRecommended）：
// - repoStatus = has_bug → build（业务状态映射：有 bug 就是要回 build）
// - repoStatus = awaiting_test → ship（V0.6.1 起：还能再推一次 / fix 后再 ship）
// - repoStatus = merged → plan（V0.6.3 起改 learn）
// - repoStatus = abandoned → plan（task 已关闭、用户也不会走推进 dialog）
// - 无 action → plan
// - 最近一条 completed action：plan → build / build → review / review → ship（V0.6.1 起解锁）
// V0.6.0.1 删的：「最后一条 error → 同 type」——之前是 retry 入口的兜底、retry 砍掉后保留它跟「没有自动重试」
// 语义冲突、不如让默认值仍按流程顺推（error 后用户手动选要不要换 type 走、跟没失败时一样）
// 注意：这个函数算的是「默认值」、不是「推荐」——UI 上不会标「推荐」二字、避免暗示「我跟你说要走这个」
const inferDefaultActionType = (task: Task): ActionType => {
  if (task.repoStatus === "has_bug") return "build";
  if (task.repoStatus === "awaiting_test") return "ship"; // 测试反馈后 fix 完仍走 ship
  if (task.repoStatus === "merged") return "plan"; // V0.6.3 起改 learn
  if (task.repoStatus === "abandoned") return "plan";

  if (task.actions.length === 0) return "plan";

  const last = [...task.actions]
    .reverse()
    .find(
      (a) =>
        a.status === "completed" &&
        (a.type === "plan" ||
          a.type === "build" ||
          a.type === "review" ||
          a.type === "ship"),
    );
  if (!last) return "plan";
  if (last.type === "plan") return "build";
  if (last.type === "build") return "review";
  if (last.type === "review") return "ship";
  return "plan"; // ship 后流程结束、默认回 plan、用户实际场景多半点终结 dialog
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
    // 指令配的截图附件（选填、贴图说明改哪）
    images?: ImagePayload[];
    // V0.6.14：合并后是否删源分支（仅 actionType==="ship" 时传、其它为 undefined）
    removeSourceBranch?: boolean;
    // V0.6.23：build 分批——本次做哪些批次（仅 build 且 plan 拆批时传、其它 undefined=全做）
    requestedBatchIds?: string[];
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
  // V0.6.14：ship「合并后删源分支」开关初始值（取 task 上次选择、缺省 false=保留）。
  // 提成 memo 依赖 primitive 字段、effect 据它初始化而非整个 task（防 SSE 推 task 引用变打回表单）
  const defaultRemoveSourceBranch = useMemo(
    () => task.removeSourceBranchOnMerge ?? false,
    [task.removeSourceBranchOnMerge],
  );
  // V0.6.23：批次进度（最新 plan 拆的批次 + 已 build 哪些）——build 选批 UI + 默认勾选都基于它
  const batchProgress = useMemo(() => computeBatchProgress(task), [task]);
  const hasBatches = batchProgress.total > 0;
  // build 选批默认值（id 串）：默认只勾「下一个未完成批次」(remaining[0]、用户拍板别全勾)、
  // 全做完了(remaining 空)默认全勾允许整体返工。memo 成稳定字符串、内容不变时 SSE 推 task
  // 引用变也不会重置用户已改的勾选（同 model list 那个坑）
  const defaultBatchIdsKey = useMemo(() => {
    if (batchProgress.remaining.length > 0) {
      return batchProgress.remaining[0].id;
    }
    return batchProgress.batches.map((b) => b.id).join(",");
  }, [batchProgress]);

  // 当前选的 action 类型；dialog 打开时取默认值、用户随便改
  const [actionType, setActionType] = useState<ActionType>(defaultActionType);
  // 用户指令、选填——飞书/上下文都已带上、空也能跑
  const [instruction, setInstruction] = useState("");
  // 高级：强制起新 agent（默认 false、复用旧 agent；老 agent 跑挂了 / 想跑新 prompt 时打开）
  const [forceNewAgent, setForceNewAgent] = useState(false);
  // V0.6.14：ship 提测「合并后删除源分支」开关（默认保留、用户拍板；dialog 打开时按 task 上次选择初始化）
  const [removeSourceBranch, setRemoveSourceBranch] = useState(false);
  // V0.6.23：build 分批——本次勾选的批次 id（仅 build 且 plan 拆了批次时用、空=未拆/全做）
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>([]);
  // 强制起新 agent 时用的模型 selection、默认从 settings.defaultModel 拷一份
  // 仅 forceNewAgent=true 时透传给父组件、否则 ignore（续接 Run 不能换模型）
  const [pickedModel, setPickedModel] = useState<ModelSelection>({ id: "" });
  // V0.6.1：ship 准入 UI 软提示用、dialog 打开时从 settings 快照、不实时同步（用户开 dialog 中途换 host/token 极少）
  const [gitConfig, setGitConfig] = useState<{ host?: string; token?: string }>(
    {},
  );
  // 可选模型列表、用 settings.apiKey 按需拉一次、跟 settings page / new-task-dialog 同一套
  const { models: availableModels, fetchModels } = useModels();

  // 指令输入框的图附件（粘贴 / 拖拽 / 选文件）、跟 revise-dialog 共用 hook
  const {
    images,
    isDragging,
    fileInputRef,
    maxImages,
    removeImage,
    reset: resetImages,
    triggerFilePicker,
    onPaste,
    onDragOver,
    onDragLeave,
    onDrop,
    onFileInputChange,
    toUploadPayload,
  } = useImageAttach();

  // dialog 打开时初始化表单 state。
  // 关键：依赖只放 open / defaultActionType，绝不放 availableModels.length——
  // 否则模型列表异步加载完成（length 0→N）会重跑本 effect，把用户已经改过的 action 选中
  //（如「提测」）、指令、开关全部打回默认值（「方案」），这就是「打开弹窗选中会跳一下」的根因。
  useEffect(() => {
    if (!open) return;
    setActionType(defaultActionType);
    setInstruction("");
    setForceNewAgent(false);
    setRemoveSourceBranch(defaultRemoveSourceBranch);
    // V0.6.23：build 选批默认勾选（未做批次优先 / 全做完则全勾）
    setSelectedBatchIds(defaultBatchIdsKey ? defaultBatchIdsKey.split(",") : []);
    // 默认 = settings.defaultModel（已经包含 params）、用户切别的 base 时 ModelPicker 会自动填默认 params
    const s = getSettings();
    setPickedModel(s.defaultModel ?? { id: "" });
    setGitConfig({
      host: s.gitHost?.trim() || undefined,
      token: s.gitToken?.trim() || undefined,
    });
  }, [open, defaultActionType, defaultRemoveSourceBranch, defaultBatchIdsKey]);

  // dialog 打开时按需拉模型列表（跟上面的表单初始化解耦）。
  // 本 effect 只负责拉取、不碰任何表单 state，所以 availableModels 变化导致它重跑也无副作用。
  useEffect(() => {
    if (!open) return;
    const s = getSettings();
    if (s.apiKey?.trim() && availableModels.length === 0) {
      void fetchModels(s.apiKey);
    }
  }, [open, availableModels.length, fetchModels]);

  // dialog 关闭时清空附图、下次打开不残留上次的图
  //（resetImages 每次 render 新引用、故意只在 open 变化时跑、不进 deps）
  useEffect(() => {
    if (!open) resetImages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 用户当前选的 action 是不是被准入条件挡住（实装类型 + 满足准入）
  const disabledReason = useMemo(
    () => inferDisabledReason(task, actionType, gitConfig),
    [task, actionType, gitConfig],
  );
  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (disabledReason) return false;
    // build 分批时至少选一批（清空全部勾选语义不明、不让提交）
    if (actionType === "build" && hasBatches && selectedBatchIds.length === 0) {
      return false;
    }
    return true;
  }, [
    submitting,
    disabledReason,
    actionType,
    hasBatches,
    selectedBatchIds.length,
  ]);

  // V0.6.23：批次卡片点选 toggle（含已做批次、允许返工重选）
  const toggleBatch = (id: string) => {
    setSelectedBatchIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  // V0.6.24：全选 / 全不选切换（批次多时省得一个个点；已全选则点成全不选）
  const allBatchesSelected =
    batchProgress.total > 0 && selectedBatchIds.length === batchProgress.total;
  const toggleAllBatches = () => {
    setSelectedBatchIds(
      allBatchesSelected ? [] : batchProgress.batches.map((b) => b.id),
    );
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onSubmit({
      actionType,
      userInstruction: instruction.trim(),
      forceNewAgent,
      // 只在「强制起新 agent」时透传模型选择、续接走 task.model
      model: forceNewAgent && pickedModel.id ? pickedModel : undefined,
      // 截图附件（选填）、后端落盘后把路径注入 agent prompt
      images: toUploadPayload(),
      // 仅 ship 时传「合并后删源分支」、其它 action 无意义（advance route 据此决定是否落字段）
      removeSourceBranch: actionType === "ship" ? removeSourceBranch : undefined,
      // 仅 build 且 plan 拆了批次时传选中批次；否则 undefined（无批次 / 全做、退化老流程）
      requestedBatchIds:
        actionType === "build" && hasBatches ? selectedBatchIds : undefined,
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
                const reason = inferDisabledReason(task, type, gitConfig);
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
                            : type === "review"
                              ? "复核差异 + 找 bug"
                              : "提 MR 到 test"}
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

          {/* V0.6.23：build 分批——plan 拆了批次时让用户挑本次做哪几批（默认勾未完成的、不勾的不动） */}
          {actionType === "build" && hasBatches && (
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label>
                  本次做哪些批次{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    （共 {batchProgress.total} 批 · 已完成 {batchProgress.done}{" "}
                    批）
                  </span>
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={toggleAllBatches}
                  disabled={submitting}
                  className="h-6 shrink-0 px-2 text-xs text-muted-foreground"
                >
                  {allBatchesSelected ? "全不选" : "全选"}
                </Button>
              </div>
              <div className="grid gap-2">
                {batchProgress.batches.map((b) => {
                  const done = batchProgress.doneIds.has(b.id);
                  return (
                    <ChoiceButton
                      key={b.id}
                      shape="card"
                      selected={selectedBatchIds.includes(b.id)}
                      onClick={() => toggleBatch(b.id)}
                      disabled={submitting}
                      className="flex flex-col items-start gap-0.5"
                    >
                      <div className="flex w-full items-center gap-1.5">
                        <span className="min-w-0 truncate text-xs font-medium">
                          {b.title}
                        </span>
                        {done && (
                          <Badge
                            variant="secondary"
                            className="ml-auto shrink-0 px-1 py-0 text-[10px]"
                          >
                            已做
                          </Badge>
                        )}
                      </div>
                      <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                        {TEST_STRATEGY_LABEL[b.testStrategy]}
                        {b.taskRefs.length > 0
                          ? ` · ${b.taskRefs.join(" / ")}`
                          : ""}
                      </span>
                    </ChoiceButton>
                  );
                })}
              </div>
              <p className="text-[10px] text-muted-foreground">
                默认勾下一个未完成批次、可手动多选 / 全选；每批以新 agent 上下文执行
              </p>
            </div>
          )}

          {/* 用户指令、选填——飞书/上下文 doc 已经在 super-prompt 里带上、空提交也能跑 */}
          <div className="grid gap-1.5">
            <Label htmlFor="advance-instruction">
              指令 <span className="text-xs text-muted-foreground">（选填）</span>
            </Label>
            {/* 整片输入区支持拖拽贴图：drag over 时轮廓高亮（跟 revise-dialog 一致） */}
            <div
              className={cn(
                "flex flex-col gap-2 rounded-md transition-colors",
                isDragging &&
                  "bg-primary/5 p-1 ring-1 ring-primary/30 ring-inset",
              )}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              {/* 缩略图区：提交前可移除单张 */}
              {images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {images.map((img) => (
                    <div
                      key={img.id}
                      className="group relative size-16 overflow-hidden rounded-md border bg-card"
                      title={img.file.name}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.dataUrl}
                        alt={img.file.name}
                        className="size-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeImage(img.id)}
                        className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                        aria-label="移除"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Textarea
                id="advance-instruction"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onPaste={onPaste}
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
              {/* 隐藏 input：附图按钮触发 */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
                multiple
                className="hidden"
                onChange={onFileInputChange}
              />
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">
                  {images.length > 0
                    ? `图 ${images.length}/${maxImages}`
                    : "可粘贴 / 拖拽截图、或点附图"}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={triggerFilePicker}
                  disabled={submitting}
                  className="h-7 gap-1 px-2 text-xs"
                  title="附图（也支持粘贴 / 拖拽）"
                >
                  <Paperclip className="size-3.5" />
                  附图
                </Button>
              </div>
            </div>
          </div>

          {/* V0.6.14：ship 提测——合并后是否删源分支（默认保留、用户拍板；仅选「提测」时显示） */}
          {actionType === "ship" && (
            <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
              <label
                htmlFor="advance-remove-source"
                className="flex-1 cursor-pointer text-xs font-medium text-foreground/80"
              >
                合并后删除源分支
              </label>
              <Switch
                id="advance-remove-source"
                checked={removeSourceBranch}
                onCheckedChange={setRemoveSourceBranch}
                disabled={submitting}
              />
            </div>
          )}

          {/* 高级：新启 Agent */}
          <div className="flex flex-col gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="advance-force-new"
                className="flex-1 cursor-pointer text-xs font-medium text-foreground/80"
              >
                新启 Agent
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
