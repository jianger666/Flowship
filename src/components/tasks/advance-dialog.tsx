"use client";

/**
 * 推进 Action Dialog（V0.6 重写、V0.6.0.1 任务模式去 chat、末段砍 retry 入口 + 加换模型 + 删推荐标签）
 *
 * V0.6 任务容器模型下：用户从「上一个 action ack 完 / 任务刚创建 / 任务跑挂了」状态进推进 dialog、
 * 选下一个 action 类型 + 写指令。
 *
 * 字段：
 *   - action 类型（plan / build / review / ship / test / learn）
 *     - 已实装：plan / build / review / ship / learn（V0.6.29）；test 仍 stub 灰掉
 *     - V0.6.0.1 起 chat 不再是 action 类型——chat 走 task.mode="chat" 独立通路、ChatView 渲染、跟本 dialog 无关
 *     - dialog 打开时按 task 状态选一个默认 chip 选中、纯减少用户点击；UI 不再标「推荐」二字（避免「我跟你说要走这个」的语义）
 *   - 用户指令（textarea、选填）、placeholder 跟着 action 类型动态变
 *   - reuseAgent（开关、默认 false = 起新 agent、V0.6.27 语义反转）：想省 send 配额 / 要连续上下文时打开续用
 *     - 默认（起新 agent）显示「本次起新 agent 用的模型」ModelPicker、默认值 = 本 task 最近 action 实际
 *       用的模型 → task.model → settings.defaultModel（沿用我在这个任务一直用的模型、不必每次重挑）、
 *       可以临时换 base + 调 thinking/effort 等 params；勾续用后本段隐藏、续接走 task.model
 *
 * 行为：
 *   - 提交后父组件调 advanceTask(taskId, { actionType, userInstruction, reuseAgent, model? })
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

import { useEffect, useMemo, useRef, useState } from "react";
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
import { fetchShipPrecheck } from "@/lib/task-store";
import { cn } from "@/lib/utils";
import { TEST_STRATEGY_LABEL } from "@/lib/types";
import type {
  ActionType,
  CheckOverride,
  ModelSelection,
  ShipPrecheck,
  Task,
} from "@/lib/types";

// 已实装的 action 类型；test 灰掉（learn V0.6.29 实装）
// V0.6.0.1：ActionType 不再含 chat（chat 走独立 mode=chat 任务、不复用 action 体系）
const IMPLEMENTED_ACTIONS: ActionType[] = [
  "plan",
  "build",
  "review",
  "ship",
  "learn",
];
const STUB_ACTIONS: ActionType[] = ["test"];
const STUB_VERSION: Record<ActionType, string | undefined> = {
  plan: undefined,
  build: undefined,
  review: undefined,
  ship: undefined,
  test: "待上线",
  learn: undefined,
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
    case "learn":
      // V0.6.29：跟 runner 准入对齐——至少 1 个已完成的 action 才有可沉淀的经验
      return task.actions.some(
        (a) => a.type !== "learn" && a.status === "completed",
      )
        ? null
        : "需要至少 1 个已完成的 action";
    case "test":
      return `${STUB_VERSION[type]}`;
    default: {
      const _: never = type;
      return _;
    }
  }
};

// action 卡片副标题（V0.6.29 抽常量表——原来是嵌套三元、新增 learn 时漏改、
// fallthrough 兜底把「沉淀」卡也显示成「提 MR 到 test」、用户实测抓到）
const ACTION_SUBTITLE: Record<ActionType, string> = {
  plan: "出方案",
  build: "写代码",
  review: "复核差异 + 找 bug",
  ship: "提 MR 到 test",
  test: "AI 手测",
  learn: "沉淀经验进仓库",
};

// 各 action 的指令 placeholder（V0.6 门槛 6、§6.7 表格）
// 简单情况下用固定文案；首次 plan / 修 bug 等场景由 buildPlaceholder() 进一步细化
const ACTION_PLACEHOLDER: Record<ActionType, string> = {
  plan: "需求是什么？要解决什么问题？",
  build: "具体改什么、指向哪个文件 / 函数 / bug",
  review: "（可选）特别关注什么？默认对照 plan + 飞书需求差异分析",
  ship: "（可选）MR 标题 / 描述要点、不填自动生成",
  test: "（待上线）跑哪些 case？默认全跑",
  learn: "（可选）想重点沉淀什么？默认全量复盘提炼",
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
// - repoStatus = merged → learn（V0.6.29 起、task 收尾沉淀时机）
// - repoStatus = abandoned → plan（task 已关闭、用户也不会走推进 dialog）
// - 无 action → plan
// - 最近一条 completed action：plan → build / build → review / review → ship（V0.6.1 起解锁）
// V0.6.0.1 删的：「最后一条 error → 同 type」——之前是 retry 入口的兜底、retry 砍掉后保留它跟「没有自动重试」
// 语义冲突、不如让默认值仍按流程顺推（error 后用户手动选要不要换 type 走、跟没失败时一样）
// 注意：这个函数算的是「默认值」、不是「推荐」——UI 上不会标「推荐」二字、避免暗示「我跟你说要走这个」
const inferDefaultActionType = (task: Task): ActionType => {
  if (task.repoStatus === "has_bug") return "build";
  if (task.repoStatus === "awaiting_test") return "ship"; // 测试反馈后 fix 完仍走 ship
  // merged 后默认 learn（V0.6.29 实装）：task 收尾、经验最完整的沉淀时机
  if (task.repoStatus === "merged") return "learn";
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
    // V0.6.27：默认每 action 新 agent、勾「续用当前 agent」时为 true
    reuseAgent: boolean;
    // 用户在 dialog 里临时挑的模型；只在起新 agent 时传、续接场景父组件用默认
    model?: ModelSelection;
    // 指令配的截图附件（选填、贴图说明改哪）
    images?: ImagePayload[];
    // V0.6.14：合并后是否删源分支（仅 actionType==="ship" 时传、其它为 undefined）
    removeSourceBranch?: boolean;
    // V0.6.23：build 分批——本次做哪些批次（仅 build 且 plan 拆批时传、其它 undefined=全做）
    requestedBatchIds?: string[];
    // V0.6.25：ship gate override（仅 ship 且最新 build 的 check 没过、用户勾「仍继续」时传）
    checkOverride?: CheckOverride;
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
  // V0.6.23：批次进度（最新 plan 拆的批次 + 已 build 哪些）——build 选批 UI 基于它
  const batchProgress = useMemo(() => computeBatchProgress(task), [task]);
  const hasBatches = batchProgress.total > 0;

  // dialog 打开时模型默认值的「task 派生部分」：优先本 task 最近一个 action 实际用的模型
  //（沿用我在这个任务一直用的模型、不必每次推进都重挑 opus）、再回退 task.model；都没有返 undefined、
  // 由 open-effect 当次再读最新 settings.defaultModel 兜底。只是 UI 默认值、不回写任何持久字段。
  // settings 兜底放 effect 不放这里：getSettings 不是响应式、塞进 memo([task]) 会用到 stale settings
  //（开 dialog 只触发 render、task 引用不一定变 → 拿不到刚改的设置页默认模型）（reviewAI P2）。
  const defaultPickedModel = useMemo<ModelSelection | undefined>(() => {
    const lastWithModel = [...task.actions]
      .reverse()
      .find((a) => a.agentModel?.id?.trim());
    if (lastWithModel?.agentModel?.id?.trim()) return lastWithModel.agentModel;
    if (task.model?.id?.trim()) return task.model;
    return undefined;
  }, [task]);
  // 用 ref 持最新默认值：open-effect 只在「打开瞬间」读它、不进 effect 依赖——
  // 否则 SSE 推 task（每次新引用）会让这个 memo 变、连带打回用户已改的表单（reviewAI 提醒）。
  const defaultPickedModelRef = useRef(defaultPickedModel);
  defaultPickedModelRef.current = defaultPickedModel;

  // 当前选的 action 类型；dialog 打开时取默认值、用户随便改
  const [actionType, setActionType] = useState<ActionType>(defaultActionType);
  // 用户指令、选填——飞书/上下文都已带上、空也能跑
  const [instruction, setInstruction] = useState("");
  // V0.6.27 语义反转：默认每 action 起新 agent（context 截断治跑偏）、勾「续用当前 agent」才续接
  const [reuseAgent, setReuseAgent] = useState(false);
  // V0.6.14：ship 提测「合并后删除源分支」开关（默认保留、用户拍板；dialog 打开时按 task 上次选择初始化）
  const [removeSourceBranch, setRemoveSourceBranch] = useState(false);
  // V0.6.23：build 分批——本次勾选的批次 id（仅 build 且 plan 拆了批次时用、空=未拆/全做）
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>([]);
  // V0.6.29：「自由改动（不绑定批次）」显式选项卡——修 bug / 跨批次散改、跟批次勾选互斥
  // 三态全显式：选批（按批做）/ 自由改动（指令为准、不计进度）/ 都没选（拦提交、语义不明）
  const [freeFormBuild, setFreeFormBuild] = useState(false);
  // 起新 agent 时用的模型 selection、默认从 settings.defaultModel 拷一份
  // 仅起新 agent（默认）时透传给父组件、勾续用时 ignore（续接 Run 不能换模型）
  const [pickedModel, setPickedModel] = useState<ModelSelection>({ id: "" });
  // V0.6.1：ship 准入 UI 软提示用、dialog 打开时从 settings 快照、不实时同步（用户开 dialog 中途换 host/token 极少）
  const [gitConfig, setGitConfig] = useState<{ host?: string; token?: string }>(
    {},
  );
  // V0.6.25：ship override——最新 build 的 check 没过时、勾「仍继续提测」+ 填原因才放行
  const [shipOverrideOn, setShipOverrideOn] = useState(false);
  const [shipOverrideReason, setShipOverrideReason] = useState("");
  // V0.6.25 review：ship 前置预检（server 算 gate 结论、含工作区指纹比对）——决定是否显示 override 区
  // client 算不了 git 指纹、不再自己用 checkRun.status 猜、gate 单一源在 server
  const [shipPrecheck, setShipPrecheck] = useState<ShipPrecheck | null>(null);
  const [shipPrecheckLoading, setShipPrecheckLoading] = useState(false);
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
    setReuseAgent(false);
    setRemoveSourceBranch(defaultRemoveSourceBranch);
    // V0.6.23：build 批次默认不勾选，避免用户回头修 bug 时误提交到下一个未完成批次。
    // V0.6.29：批次 / 自由改动二选一、都不选拦提交（语义不明）——每次打开都回到「未表态」。
    setSelectedBatchIds([]);
    setFreeFormBuild(false);
    // V0.6.25：每次打开重置 ship override（默认不绕过、需用户主动勾）
    setShipOverrideOn(false);
    setShipOverrideReason("");
    // 默认模型 = 本 task 最近 action 用的 → task.model（ref.current、打开瞬间最新、不进 deps 防 SSE 重置）
    // → 当次 getSettings().defaultModel 兜底（含 params）。settings 在这里读、保证拿到最新设置页默认模型。
    const s = getSettings();
    setPickedModel(defaultPickedModelRef.current ?? s.defaultModel ?? { id: "" });
    setGitConfig({
      host: s.gitHost?.trim() || undefined,
      token: s.gitToken?.trim() || undefined,
    });
  }, [open, defaultActionType, defaultRemoveSourceBranch]);

  // V0.6.25 review：ship 时拉 server precheck（含工作区指纹比对）决定 override 区。
  // actionType 可能在 dialog 里被切到 ship、所以依赖它；非 ship 清空。
  useEffect(() => {
    if (!open || actionType !== "ship") {
      setShipPrecheck(null);
      return;
    }
    let cancelled = false;
    setShipPrecheckLoading(true);
    fetchShipPrecheck(task.id)
      .then((pc) => {
        if (!cancelled) setShipPrecheck(pc);
      })
      .catch(() => {
        // 拉失败不挡提交、server /advance 会再跑同一套 gate 兜底
        if (!cancelled) setShipPrecheck(null);
      })
      .finally(() => {
        if (!cancelled) setShipPrecheckLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, actionType, task.id]);

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
  // V0.6.25：ship 且 server precheck 判定需 override → 必须勾「仍继续」+ 填原因才能提测
  const shipNeedsOverride =
    actionType === "ship" && !!shipPrecheck?.needsOverride;
  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (disabledReason) return false;
    // V0.6.25 review：ship 时等 precheck 拉完再判断（没拿到 gate 结论就放行会被 server 拒）
    if (actionType === "ship" && shipPrecheckLoading) return false;
    // V0.6.29：分批 build 必须显式表态——选批 or「自由改动」选项卡、都没选语义不明拦提交
    if (
      actionType === "build" &&
      hasBatches &&
      selectedBatchIds.length === 0 &&
      !freeFormBuild
    ) {
      return false;
    }
    // V0.6.25：ship 需 override 时、必须勾「仍继续」+ 填原因
    if (shipNeedsOverride && (!shipOverrideOn || !shipOverrideReason.trim())) {
      return false;
    }
    return true;
  }, [
    submitting,
    disabledReason,
    actionType,
    shipPrecheckLoading,
    hasBatches,
    selectedBatchIds.length,
    freeFormBuild,
    shipNeedsOverride,
    shipOverrideOn,
    shipOverrideReason,
  ]);

  // V0.6.23：批次卡片点选 toggle（含已做批次、允许返工重选）
  // V0.6.29：选批跟「自由改动」互斥、点批次自动退出自由改动
  const toggleBatch = (id: string) => {
    setFreeFormBuild(false);
    setSelectedBatchIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  // V0.6.29：「自由改动」选项卡 toggle——选中清空批次勾选（互斥）
  const toggleFreeForm = () => {
    setFreeFormBuild((prev) => {
      if (!prev) setSelectedBatchIds([]);
      return !prev;
    });
  };

  // V0.6.24：全选 / 全不选切换（批次多时省得一个个点；已全选则点成全不选）
  const allBatchesSelected =
    batchProgress.total > 0 && selectedBatchIds.length === batchProgress.total;
  const toggleAllBatches = () => {
    setFreeFormBuild(false);
    setSelectedBatchIds(
      allBatchesSelected ? [] : batchProgress.batches.map((b) => b.id),
    );
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onSubmit({
      actionType,
      userInstruction: instruction.trim(),
      reuseAgent,
      // 只在起新 agent（默认）时透传模型选择、续接走 task.model
      model: !reuseAgent && pickedModel.id ? pickedModel : undefined,
      // 截图附件（选填）、后端落盘后把路径注入 agent prompt
      images: toUploadPayload(),
      // 仅 ship 时传「合并后删源分支」、其它 action 无意义（advance route 据此决定是否落字段）
      removeSourceBranch: actionType === "ship" ? removeSourceBranch : undefined,
      // 仅 build 且 plan 拆批且选了批次时传；空选不传（V0.6.29 = 自由改动、server 注入「不绑定批次」指令）
      requestedBatchIds:
        actionType === "build" && hasBatches && selectedBatchIds.length > 0
          ? selectedBatchIds
          : undefined,
      // V0.6.25：ship 绕过 check 的 override（仅 ship 且 check 没过 + 勾「仍继续」时传、server 再校验绑定）
      checkOverride:
        shipNeedsOverride && shipOverrideOn
          ? {
              checkRunId: shipPrecheck?.checkRunId ?? "",
              buildActionId: shipPrecheck?.buildActionId ?? "",
              reason: shipOverrideReason.trim(),
              createdAt: Date.now(),
            }
          : undefined,
    });
  };

  return (
    // disablePointerDismissal：带草稿表单（指令 + 附件）、点外误关丢草稿；Esc / X / 取消仍可关
    <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
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
                      {reason ?? ACTION_SUBTITLE[type]}
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
                {/* V0.6.29：自由改动选项卡——多轮后回头修 bug 时忘了哪批 / 跨批次、不绑定批次 */}
                <ChoiceButton
                  shape="card"
                  selected={freeFormBuild}
                  onClick={toggleFreeForm}
                  disabled={submitting}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="text-xs font-medium">
                    自由改动（不绑定批次）
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    修 bug / 跨批次散改、范围以指令为准、不计批次进度
                  </span>
                </ChoiceButton>
              </div>
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

          {/* V0.6.27 F3：最新 build 后没 review 过——非阻断提醒（用户有权跳过、但要知情） */}
          {actionType === "ship" && shipPrecheck?.reviewMissing && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              最新 build 之后还没跑过 review——建议先复核再提测（不拦、可直接继续）。
            </div>
          )}

          {/* V0.6.25：ship override——最新 build 的 check 没过时、必须确认才放行（HITL 底线、留痕） */}
          {shipNeedsOverride && (
            <div className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
              <div className="text-xs font-medium text-destructive">
                {shipPrecheck?.reason || "最新 build 的检查没通过、确认仍要提测？"}
              </div>
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="ship-override"
                  className="flex-1 cursor-pointer text-xs text-foreground/80"
                >
                  仍继续提测（绕过检查）
                </label>
                <Switch
                  id="ship-override"
                  checked={shipOverrideOn}
                  onCheckedChange={setShipOverrideOn}
                  disabled={submitting}
                />
              </div>
              {shipOverrideOn && (
                <Textarea
                  value={shipOverrideReason}
                  onChange={(e) => setShipOverrideReason(e.target.value)}
                  placeholder="为什么检查没过还提测？（必填、进审计）"
                  rows={2}
                  disabled={submitting}
                  className="resize-none text-xs"
                />
              )}
            </div>
          )}

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

          {/* V0.6.27 语义反转：默认每 action 新 agent、勾「续用」才接老 agent（review 勾了也强起新） */}
          <div className="flex flex-col gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="advance-reuse-agent"
                className="flex-1 cursor-pointer text-xs font-medium text-foreground/80"
              >
                续用当前 Agent
              </label>
              <Switch
                id="advance-reuse-agent"
                checked={reuseAgent}
                onCheckedChange={setReuseAgent}
                disabled={submitting}
              />
            </div>

            {/* 模型选择：起新 agent（默认）时显示、续接 Run 不能换模型 */}
            {!reuseAgent && (
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
