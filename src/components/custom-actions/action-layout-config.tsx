"use client";

/**
 * Action 管理列表（V0.9、嵌在 /actions 页、内置 + 自定义统一一个地方管）
 *
 * 按固定三组分区展示：组头可拖拽换组序（framer-motion Reorder）+ 「默认折叠」开关；
 * 组内 action 行同套拖拽调「推进」顺序 + 开关控显隐。
 * 隐藏的在「推进」弹窗直接不出现（v0.9.12 删「更多」折叠区、本页开关是唯一恢复入口）。
 * 顺序 / 显隐 / 组序 / 默认折叠落 config.json（settings.actionLayout）、个人级、全任务生效。
 * 拖拽：onReorder 只更新本地态、松手（onDragEnd）才落盘——避免拖动过程狂发 config.json 写请求。
 *
 * 组头拖拽：开始拖任意组时全体临时收起只留组头（Notion/Trello section 同款），
 * 松手恢复拖前展开态（能力页常态 = 组内全展开；「默认折叠」只影响推进弹窗）。
 * 行操作一律常驻文字按钮（与 Skill tab 统一；废除纯 icon）。
 * T24：Reorder layout 动画只在拖拽会话中启用——mount / 数据回灌不重放位移。
 * 空组：能力页仍显示组头（可配折叠）；推进弹窗空组不渲染。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Reorder, useDragControls } from "framer-motion";
import { GripVertical, Loader2 } from "lucide-react";

import {
  TeamActionViewDialog,
  type TeamActionViewTarget,
} from "@/components/custom-actions/team-action-view-dialog";
import { AuthorByline } from "@/components/ui/author-byline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/loading-state";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/use-settings";
import {
  ACTION_GROUP_LABEL,
  BUILTIN_ADVANCE_ACTIONS,
  DEFAULT_GROUP_ORDER,
  isBuiltinAdvanceAction,
  normalizeCollapsedGroups,
  normalizeGroupOrder,
  partitionActionsByGroup,
  resolveActionGroup,
  sortByOrder,
  type ActionGroupKey,
} from "@/lib/action-layout";
import { fetchCustomActions } from "@/lib/custom-action-client";
import { ACTION_DESC, ACTION_LABEL } from "@/lib/task-display";
import {
  labelTeamCategoryBadge,
  type ActionLayoutPref,
  type CustomActionDef,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/** 行内次要操作：紧凑 ghost 文字按钮（查看/编辑/删除/卸载/转建共用基线） */
const ROW_ACTION_BTN =
  "h-6 shrink-0 px-2 text-[12px] text-muted-foreground hover:text-foreground";

/** 组头 / action 行共用拖拽手柄样式（视觉一致） */
const DRAG_HANDLE_CLASS =
  "cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing";

interface Props {
  // 当前自定义 action 列表（由 /actions 页加载后传入、增删后自动反映）
  customActions: CustomActionDef[];
  // 本机全部 skill 名（含已关闭自管；null = 未拉到、不判定缺失防误报）
  knownSkills: Set<string> | null;
  // 自管源 skill 名（配合 settings.disabledSkills 标「skill 已关闭」；null = 未拉到）
  appSkillNames: Set<string> | null;
  // 自定义 action 行的编辑 / 删除 / 导出（内置行不展示这些按钮）
  onEdit: (def: CustomActionDef) => void;
  onDelete: (def: CustomActionDef) => void;
  // 旧格式行「查看原内容」（只读 dialog、供复制后重建）
  onViewLegacy: (def: CustomActionDef) => void;
  // 旧格式行「转建新版」：对话创建 + action-creator 把 playbook 转成 skill+壳
  onConvertLegacy: (def: CustomActionDef) => void;
  // 正在转建的旧格式 action id（防双击；非该行不转圈）
  convertingLegacyId?: string | null;
}

/** 内置行只读查看目标（形态对齐 TeamActionViewDialog、不拉 playbook） */
type BuiltinViewTarget = {
  label: string;
  description: string;
};

interface RowProps {
  value: string;
  label: string;
  isCustom: boolean;
  isHidden: boolean;
  // 旧格式（playbook 写正文）已停用：标 Badge + 只留查看 / 删除、开关禁用
  isLegacy?: boolean;
  /** 派生 team action：不可编辑 / 导出、删除语义 = 卸载 */
  isTeam?: boolean;
  /** 仅派生行：来源分类 Badge 文案（如「共享 · 前端」） */
  teamBadge?: string;
  /** 仅派生行：创建人小字（共享库 git 首次引入者） */
  author?: string;
  /** 挂载的自管 skill 已关闭：仍展示但置灰 + 标因 */
  skillDisabled?: boolean;
  /**
   * 团队规范总开关关 + 本行 requiresKnowledge：置灰 +「团队规范已关闭」
   * （与 skillDisabled 同视觉；开关/卸载仍可操作）
   */
  knowledgeDisabled?: boolean;
  /** 内置行副标题（ACTION_DESC）；自定义行用 skills 副标题 */
  description?: string;
  /** 派生行 / 内置行：只读查看 */
  onView?: () => void;
  // 自定义 action 引用的 skill（缺失的灰显、提示推进时跳过）
  skills?: { name: string; missing: boolean }[];
  onToggleHidden: (visible: boolean) => void;
  onDragEnd: () => void;
  /** 拖拽会话中 → 启用 layout 动画；否则关（防 mount 重放） */
  layoutEnabled: boolean;
  onDragSessionStart: () => void;
  // 仅自定义 action 传——内置 action 不可编辑 / 删除 / 导出
  onEdit?: () => void;
  onDelete?: () => void;
  // 仅旧格式行传：只读查看原 playbook
  onViewLegacy?: () => void;
  // 仅旧格式行传：转建新版（对话创建链路）
  onConvertLegacy?: () => void;
  // 本行是否正在转建（按钮 spinner）
  converting?: boolean;
}

/** 内置 action 只读弹窗：label + 描述 + 平台 playbook 说明 */
const BuiltinActionViewDialog = ({
  target,
  onClose,
}: {
  target: BuiltinViewTarget;
  onClose: () => void;
}) => (
  <Dialog open onOpenChange={(o) => !o && onClose()}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle className="min-w-0 truncate">{target.label}</DialogTitle>
        <p className="text-sm text-muted-foreground">{target.description}</p>
      </DialogHeader>
      <p className="text-xs text-muted-foreground">
        内置 action，行为由平台 playbook 定义
      </p>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

// 单行：拖拽手柄 + 名称行（badge / 创建人）+ 副标题 + 文字操作 + 显隐开关
const LayoutRow = ({
  value,
  label,
  isCustom,
  isHidden,
  isLegacy,
  isTeam,
  teamBadge,
  author,
  description,
  onView,
  skillDisabled,
  knowledgeDisabled,
  skills,
  onToggleHidden,
  onDragEnd,
  layoutEnabled,
  onDragSessionStart,
  onEdit,
  onDelete,
  onViewLegacy,
  onConvertLegacy,
  converting,
}: RowProps) => {
  // 每个 Item 独立拖拽控制器——dragListener={false} 只让手柄发起拖拽、不误触开关 / 按钮 / 整行
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={value}
      // 进页 / 数据回灌不播入场动画
      initial={false}
      // 非拖拽会话：layout 时长 0，避免切 tab / mount 重放位移；拖拽中开 spring
      layout="position"
      transition={
        layoutEnabled
          ? { layout: { type: "spring", stiffness: 450, damping: 32 } }
          : { layout: { duration: 0 } }
      }
      dragListener={false}
      dragControls={controls}
      onDragStart={onDragSessionStart}
      onDragEnd={onDragEnd}
      className={cn(
        // 操作区相对整行垂直居中
        "flex items-center gap-2 rounded-md border bg-card px-2 py-2.5",
        (skillDisabled || knowledgeDisabled) && "opacity-60",
      )}
    >
      <button
        type="button"
        onPointerDown={(e) => controls.start(e)}
        className={DRAG_HANDLE_CLASS}
        title="拖拽排序"
      >
        <GripVertical className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        {/* 名称行：名称 + badge 群 + 创建人 */}
        <div
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-1.5 text-sm",
            (isHidden || skillDisabled || knowledgeDisabled) &&
              "text-muted-foreground",
            isHidden && "line-through",
          )}
        >
          <span className="min-w-0 truncate font-medium">{label}</span>
          {/* 只标自定义、内置多数不吵；一眼可辨来源 */}
          {isCustom && !isTeam && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              自管
            </Badge>
          )}
          {isLegacy && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              旧格式・已停用
            </Badge>
          )}
          {skillDisabled && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              skill 已关闭
            </Badge>
          )}
          {knowledgeDisabled && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              团队规范已关闭
            </Badge>
          )}
          {teamBadge && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {teamBadge}
            </Badge>
          )}
          {/* 创建人：派生行小字（共享库 git 首次引入者） */}
          {author && <AuthorByline author={author} />}
        </div>
        {/* 副标题：内置用 ACTION_DESC；自定义挂 skill；旧格式转建提示 */}
        {description && (
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted-foreground">
            {description}
          </p>
        )}
        {skills && skills.length > 0 && (
          <p
            className={cn(
              "mt-0.5 truncate text-[12px] leading-snug text-muted-foreground",
              skills[0]?.missing && "line-through opacity-60",
            )}
            title={
              skillDisabled
                ? "挂载的自管 skill 已关闭、推进面板隐藏"
                : knowledgeDisabled
                  ? "团队规范已关闭、推进面板隐藏"
                  : skills[0]?.missing
                    ? "本机未找到、推进时自动跳过"
                    : undefined
            }
          >
            skill: {skills[0]?.name}
          </p>
        )}
        {isLegacy && (
          <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
            点「转建新版」让 AI 提炼成 skill 并挂壳
          </p>
        )}
      </div>
      {isHidden && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          已隐藏
        </span>
      )}
      {/* 操作区常驻文字按钮 */}
      <div className="flex shrink-0 items-center gap-0.5">
        {onConvertLegacy && (
          <Button
            size="sm"
            variant="ghost"
            className={ROW_ACTION_BTN}
            onClick={onConvertLegacy}
            disabled={converting}
          >
            {converting ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              "转建新版"
            )}
          </Button>
        )}
        {onViewLegacy && (
          <Button
            size="sm"
            variant="ghost"
            className={ROW_ACTION_BTN}
            onClick={onViewLegacy}
          >
            查看
          </Button>
        )}
        {onEdit && (
          <Button
            size="sm"
            variant="ghost"
            className={ROW_ACTION_BTN}
            onClick={onEdit}
          >
            编辑
          </Button>
        )}
        {/* 内置 / 派生：只读查看（字段结构一致） */}
        {onView && (
          <Button
            size="sm"
            variant="ghost"
            className={ROW_ACTION_BTN}
            onClick={onView}
          >
            查看
          </Button>
        )}
        {/* 本地导出已下线（2026-07-22：分发统一走共享库） */}
        {onDelete && (
          <Button
            size="sm"
            variant="ghost"
            className={cn(ROW_ACTION_BTN, "hover:text-destructive")}
            onClick={onDelete}
          >
            {isTeam ? "卸载" : "删除"}
          </Button>
        )}
      </div>
      {/* 旧格式不进推进列表、显隐无意义——开关禁用 */}
      <Switch
        className="shrink-0"
        checked={!isHidden}
        onCheckedChange={onToggleHidden}
        disabled={isLegacy}
      />
    </Reorder.Item>
  );
};

/** 一组：可拖拽组头（换组序）+ 组内 action Reorder */
const GroupSection = ({
  groupKey,
  keys,
  collapsedDefault,
  layoutEnabled,
  // 拖任意组头时全体 true → 组内 action height 收起，松手恢复
  collapseActions,
  onGroupDragSessionStart,
  onGroupDragEnd,
  onToggleCollapsed,
  onActionReorder,
  renderRow,
}: {
  groupKey: ActionGroupKey;
  keys: string[];
  collapsedDefault: boolean;
  layoutEnabled: boolean;
  collapseActions: boolean;
  onGroupDragSessionStart: () => void;
  onGroupDragEnd: () => void;
  onToggleCollapsed: (on: boolean) => void;
  onActionReorder: (nextKeys: string[]) => void;
  renderRow: (key: string) => ReactNode;
}) => {
  // 组头独立拖拽控制器——只手柄发起、不误触「默认折叠」开关
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={groupKey}
      initial={false}
      // position：只跟 x/y。换位判定看 onLayoutMeasure 的流式盒 + drag offset
      //（framer check-reorder），不跟兄弟投影中间态——短 layout tween 安全；
      // 高度收起（grid-rows）才是漂移元凶，必须瞬时。
      layout="position"
      transition={
        collapseActions
          ? // 拖组中：兄弟挤开让位（~150ms tween）；收起高度仍无过渡
            { layout: { duration: 0.15, ease: "easeOut" } }
          : layoutEnabled
            ? { layout: { type: "spring", stiffness: 450, damping: 32 } }
            : { layout: { duration: 0 } }
      }
      dragListener={false}
      dragControls={controls}
      onDragStart={onGroupDragSessionStart}
      onDragEnd={onGroupDragEnd}
      className="grid gap-1.5"
    >
      {/* 组头：手柄 + 标题 + 数量 + 默认折叠（空组也显示，方便配折叠） */}
      <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
        <button
          type="button"
          onPointerDown={(e) => controls.start(e)}
          className={DRAG_HANDLE_CLASS}
          title="拖拽调整组顺序"
        >
          <GripVertical className="size-4" />
        </button>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {ACTION_GROUP_LABEL[groupKey]}
        </span>
        <span className="shrink-0 tabular-nums text-xs text-muted-foreground/70">
          {keys.length}
        </span>
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span>默认折叠</span>
          <Switch
            checked={collapsedDefault}
            onCheckedChange={onToggleCollapsed}
          />
        </label>
      </div>
      {/* 组内 action：收起瞬时（拖中 y 坐标不能漂）、展开平滑；勿用 display:none */}
      {keys.length > 0 && (
        <div
          className={cn(
            "grid",
            collapseActions
              ? "grid-rows-[0fr]"
              : "grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <Reorder.Group
              axis="y"
              values={keys}
              onReorder={onActionReorder}
              className="grid gap-1.5"
            >
              {keys.map((key) => renderRow(key))}
            </Reorder.Group>
          </div>
        </div>
      )}
    </Reorder.Item>
  );
};

export const ActionLayoutConfig = ({
  customActions,
  knownSkills,
  appSkillNames,
  onEdit,
  onDelete,
  onViewLegacy,
  onConvertLegacy,
  convertingLegacyId,
}: Props) => {
  const { settings, saveFieldValue, loaded } = useSettings();
  // 共享库装/卸后本地覆写列表（父页 ActionsPanel 不感知 install，靠此刷新）
  const [actionsOverride, setActionsOverride] = useState<
    CustomActionDef[] | null
  >(null);
  // 派生 team action 的只读查看（null = 关）
  const [viewingTeam, setViewingTeam] = useState<TeamActionViewTarget | null>(
    null,
  );
  // 内置 action 只读查看
  const [viewingBuiltin, setViewingBuiltin] = useState<BuiltinViewTarget | null>(
    null,
  );
  // 拖拽会话中才开 Reorder layout 动画（T24：防切 tab / 进页重放）
  const [dragging, setDragging] = useState(false);
  // 正在拖组头：全体组临时收起只留组头（Notion section 同款）；松手恢复展开
  // 收起必须瞬时（无过渡）——过渡期 y 漂移会让 Reorder 换位判定失灵
  const [draggingGroup, setDraggingGroup] = useState(false);
  // 父 props 指纹变化（新建 / 编辑 / 删除）时清覆写、以父为准
  const parentKey = customActions.map((a) => `${a.id}:${a.updatedAt ?? a.label}`).join("|");
  useEffect(() => {
    setActionsOverride(null);
  }, [parentKey]);

  const effectiveActions = actionsOverride ?? customActions;
  const layout = settings.actionLayout ?? {
    order: [],
    hidden: [],
    groupOrder: [...DEFAULT_GROUP_ORDER],
    collapsedGroups: [],
  };
  const hiddenSet = new Set(layout.hidden);
  // 自管关闭名单（settings 响应式；开/关 skill 后 Action 列表即标「skill 已关闭」）
  const disabledSkills = new Set(settings.disabledSkills ?? []);
  // Map 引用稳定：避免每次 render 新 Map 触发 sections useMemo 重算
  const customById = useMemo(
    () => new Map(effectiveActions.map((d) => [d.id, d] as const)),
    [effectiveActions],
  );

  // 设置里的组序 / 默认折叠（落盘源）
  const settingsGroupOrder = normalizeGroupOrder(layout.groupOrder);
  const collapsedGroupSet = new Set(
    normalizeCollapsedGroups(layout.collapsedGroups),
  );

  // 混排全序（内置 + 自定义、按 order 排、增删 custom 自动反映）
  const computedOrder = sortByOrder(
    [...BUILTIN_ADVANCE_ACTIONS, ...customById.keys()],
    layout.order,
  );

  // 本地拖拽态：拖动中实时更新（不落盘）、松手才 persist
  const [order, setOrder] = useState<string[]>(computedOrder);
  const orderRef = useRef(order);
  orderRef.current = order;
  // 组序本地态（组头拖拽）；与 settings 同步
  const [groupOrderLocal, setGroupOrderLocal] =
    useState<ActionGroupKey[]>(settingsGroupOrder);
  const groupOrderRef = useRef(groupOrderLocal);
  groupOrderRef.current = groupOrderLocal;

  // computedOrder 内容变了（增删 custom / 外部改 order）才回灌——用 join 当指纹、避免每 render 重置打断拖拽
  const computedKey = computedOrder.join("|");
  useEffect(() => {
    setOrder(computedOrder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedKey]);

  const settingsGroupKey = settingsGroupOrder.join("|");
  useEffect(() => {
    setGroupOrderLocal(settingsGroupOrder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsGroupKey]);

  // 按当前本地 order + 组序分桶（空组也出、能力页要能配折叠）
  const sections = useMemo(
    () =>
      partitionActionsByGroup(order, customById, groupOrderLocal, {
        includeEmpty: true,
      }),
    [order, customById, groupOrderLocal],
  );

  /** 从扁平 order 按归属拆成三组桶（组内相对序保留） */
  const bucketsFromFlat = (flat: string[]) => {
    const buckets: Record<ActionGroupKey, string[]> = {
      builtin: [],
      team: [],
      custom: [],
    };
    for (const key of flat) {
      buckets[resolveActionGroup(key, customById)].push(key);
    }
    return buckets;
  };

  const flatFromBuckets = (
    groups: ActionGroupKey[],
    buckets: Record<ActionGroupKey, string[]>,
  ) => groups.flatMap((g) => buckets[g]);

  // 落盘：order / 组序 / 折叠字段一并写入；清理已删除 custom id
  const persist = (
    nextOrder: string[],
    nextHidden: string[],
    groupPatch?: Pick<ActionLayoutPref, "groupOrder" | "collapsedGroups">,
  ) => {
    const valid = new Set<string>([
      ...BUILTIN_ADVANCE_ACTIONS,
      ...effectiveActions.map((d) => d.id),
    ]);
    saveFieldValue("actionLayout", {
      order: nextOrder.filter((k) => valid.has(k)),
      hidden: nextHidden.filter((k) => valid.has(k)),
      groupOrder: groupPatch?.groupOrder ?? groupOrderRef.current,
      collapsedGroups:
        groupPatch?.collapsedGroups ??
        normalizeCollapsedGroups(layout.collapsedGroups),
    } satisfies ActionLayoutPref);
  };

  const toggleCollapsedDefault = (key: ActionGroupKey, on: boolean) => {
    const set = new Set(collapsedGroupSet);
    if (on) set.add(key);
    else set.delete(key);
    persist(orderRef.current, layout.hidden, {
      collapsedGroups: [...set],
    });
  };

  const endDragSession = () => {
    // 松手后再关 layout 动画，让落位 spring 跑完（立刻关会 snap）
    window.setTimeout(() => setDragging(false), 280);
  };

  /** 组头开始拖：全体临时收起（只剩三行组头） */
  const handleGroupDragStart = () => {
    setDragging(true);
    setDraggingGroup(true);
  };

  /** 组头拖拽松手 / 取消：立刻恢复展开 + 落盘组序 */
  const handleGroupDragEnd = () => {
    setDraggingGroup(false);
    persist(orderRef.current, layout.hidden, {
      groupOrder: groupOrderRef.current,
    });
    endDragSession();
  };

  /** 组内 action 拖拽松手 */
  const handleActionDragEnd = () => {
    persist(orderRef.current, layout.hidden);
    endDragSession();
  };

  const handleGroupReorder = (nextGroups: ActionGroupKey[]) => {
    setGroupOrderLocal(nextGroups);
    const buckets = bucketsFromFlat(orderRef.current);
    setOrder(flatFromBuckets(nextGroups, buckets));
  };

  const handleActionReorder = (groupKey: ActionGroupKey, nextKeys: string[]) => {
    const buckets = bucketsFromFlat(orderRef.current);
    buckets[groupKey] = nextKeys;
    setOrder(flatFromBuckets(groupOrderRef.current, buckets));
  };

  const toggleHidden = (key: string, visible: boolean) => {
    const set = new Set(layout.hidden);
    if (visible) set.delete(key);
    else set.add(key);
    persist(orderRef.current, [...set]);
  };

  /** 共享库安装成功 / 删了仅存在于 override 的条目后，重拉列表覆写 */
  const reloadActionsLocally = async () => {
    try {
      setActionsOverride(await fetchCustomActions());
    } catch {
      // 刷新失败不挡主流程；用户可切 tab 重进
    }
  };

  const renderRow = (key: string) => {
    const def = customById.get(key);
    // 旧格式（playbook 写正文）已停用：不可编辑 / 导出、只留转建 / 查看原内容 + 删除
    const isLegacy = !!def?.legacyPlaybook;
    // 派生 team action：定义在共享库、不可编辑 / 导出、删除 = 卸载
    const isTeam = def?.origin === "team";
    const skillName = def?.skill?.trim() ?? "";
    // 自建 action 挂自管 skill 且该 skill 在 disabledSkills → 推进面板隐藏、本列表置灰
    const skillDisabled =
      !!def &&
      !isLegacy &&
      !isTeam &&
      !!skillName &&
      appSkillNames !== null &&
      appSkillNames.has(skillName) &&
      disabledSkills.has(skillName);
    // 团队规范总开关关 + requiresKnowledge → 同视觉（推进面板已隐藏该行）
    const knowledgeDisabled =
      !!def &&
      def.requiresKnowledge === true &&
      settings.teamKnowledgeEnabled === false;
    const builtin =
      isBuiltinAdvanceAction(key) && key in ACTION_DESC
        ? (key as keyof typeof ACTION_DESC)
        : null;
    return (
      <LayoutRow
        key={key}
        value={key}
        label={
          isBuiltinAdvanceAction(key)
            ? ACTION_LABEL[key]
            : (def?.label ?? key)
        }
        isCustom={!isBuiltinAdvanceAction(key)}
        isHidden={hiddenSet.has(key)}
        isLegacy={isLegacy}
        isTeam={isTeam}
        skillDisabled={skillDisabled}
        knowledgeDisabled={knowledgeDisabled}
        description={builtin ? ACTION_DESC[builtin] : undefined}
        teamBadge={
          isTeam && def
            ? labelTeamCategoryBadge(def.teamCategory)
            : undefined
        }
        author={isTeam ? def?.author : undefined}
        layoutEnabled={dragging}
        onDragSessionStart={() => setDragging(true)}
        onView={
          isTeam && def
            ? () =>
                setViewingTeam({
                  label: def.label,
                  skillName: def.skill,
                  placeholder: def.placeholder,
                  categoryLabel: labelTeamCategoryBadge(def.teamCategory),
                  author: def.author,
                })
            : builtin
              ? () =>
                  setViewingBuiltin({
                    label: ACTION_LABEL[builtin],
                    description: ACTION_DESC[builtin],
                  })
              : undefined
        }
        // 主 skill：knownSkills 没拉到（null）时不标缺失、避免加载中误报；
        // legacy 无挂载 skill（空串）、chips 不展示；已关闭不算缺失
        skills={
          def && !isLegacy
            ? [def.skill].map((name) => ({
                name,
                missing:
                  knownSkills !== null &&
                  !knownSkills.has(name) &&
                  !skillDisabled,
              }))
            : undefined
        }
        onToggleHidden={(visible) => toggleHidden(key, visible)}
        onDragEnd={handleActionDragEnd}
        onEdit={def && !isLegacy && !isTeam ? () => onEdit(def) : undefined}
        onDelete={
          def
            ? () => {
                // 父删完再本地重拉：覆盖「仅 override 里有、父 state 不知」的安装项
                void Promise.resolve(onDelete(def)).then(() => {
                  void reloadActionsLocally();
                });
              }
            : undefined
        }
        onViewLegacy={def && isLegacy ? () => onViewLegacy(def) : undefined}
        onConvertLegacy={
          def && isLegacy ? () => onConvertLegacy(def) : undefined
        }
        converting={!!def && convertingLegacyId === def.id}
      />
    );
  };

  if (!loaded) return <LoadingState variant="inline" />;

  return (
    <div className="space-y-3">
      {/* 外层：组可拖拽换序；每组内嵌 action Reorder */}
      <Reorder.Group
        axis="y"
        values={groupOrderLocal}
        onReorder={handleGroupReorder}
        className="grid gap-3"
      >
        {sections.map((section) => (
          <GroupSection
            key={section.key}
            groupKey={section.key}
            keys={section.keys}
            collapsedDefault={collapsedGroupSet.has(section.key)}
            layoutEnabled={dragging}
            collapseActions={draggingGroup}
            onGroupDragSessionStart={handleGroupDragStart}
            onGroupDragEnd={handleGroupDragEnd}
            onToggleCollapsed={(on) =>
              toggleCollapsedDefault(section.key, on)
            }
            onActionReorder={(nextKeys) =>
              handleActionReorder(section.key, nextKeys)
            }
            renderRow={renderRow}
          />
        ))}
      </Reorder.Group>

      {viewingTeam && (
        <TeamActionViewDialog
          target={viewingTeam}
          onClose={() => setViewingTeam(null)}
        />
      )}
      {viewingBuiltin && (
        <BuiltinActionViewDialog
          target={viewingBuiltin}
          onClose={() => setViewingBuiltin(null)}
        />
      )}
    </div>
  );
};
