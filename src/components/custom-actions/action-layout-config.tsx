"use client";

/**
 * Action 管理列表（V0.9、嵌在 /actions 页、内置 + 自定义统一一个地方管）
 *
 * 内置 + 自定义混排成一个列表：拖拽调「推进」里的顺序（framer-motion Reorder）+ 开关控显隐、
 * 自定义项带扳手角标、且额外给「编辑 / 删除」入口（内置不可改不可删）。
 * 隐藏的在「推进」弹窗直接不出现（v0.9.12 删「更多」折叠区、本页开关是唯一恢复入口）。
 * 顺序 / 显隐偏好落 config.json（settings.actionLayout）、个人级、全任务生效。
 * 拖拽：onReorder 只更新本地态、松手（onDragEnd）才落盘——避免拖动过程狂发 config.json 写请求。
 */

import { useEffect, useRef, useState } from "react";
import { Reorder, useDragControls } from "framer-motion";
import {
  Eye,
  GripVertical,
  Loader2,
  Pencil,
  Share,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { useSettings } from "@/hooks/use-settings";
import {
  BUILTIN_ADVANCE_ACTIONS,
  isBuiltinAdvanceAction,
  sortByOrder,
} from "@/lib/action-layout";
import { ACTION_LABEL } from "@/lib/task-display";
import type { CustomActionDef } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  // 当前自定义 action 列表（由 /actions 页加载后传入、增删后自动反映）
  customActions: CustomActionDef[];
  // 本机可用 skill 名集合（/actions 页拉一次传入；null = 未拉到、不判定缺失防误报）
  knownSkills: Set<string> | null;
  // 自定义 action 行的编辑 / 删除 / 导出（内置行不展示这些按钮）
  onEdit: (def: CustomActionDef) => void;
  onDelete: (def: CustomActionDef) => void;
  onExport: (def: CustomActionDef) => void;
  // 旧格式行「查看原内容」（只读 dialog、供复制后重建）
  onViewLegacy: (def: CustomActionDef) => void;
  // 旧格式行「转建新版」：对话创建 + action-creator 把 playbook 转成 skill+壳
  onConvertLegacy: (def: CustomActionDef) => void;
  // 正在转建的旧格式 action id（防双击；非该行不转圈）
  convertingLegacyId?: string | null;
}

interface RowProps {
  value: string;
  label: string;
  isCustom: boolean;
  isHidden: boolean;
  // 旧格式（playbook 写正文）已停用：标 Badge + 只留查看 / 删除、开关禁用
  isLegacy?: boolean;
  // 自定义 action 引用的 skill（缺失的灰显、提示推进时跳过）
  skills?: { name: string; missing: boolean }[];
  onToggleHidden: (visible: boolean) => void;
  onDragEnd: () => void;
  // 仅自定义 action 传——内置 action 不可编辑 / 删除 / 导出
  onEdit?: () => void;
  onDelete?: () => void;
  onExport?: () => void;
  // 仅旧格式行传：只读查看原 playbook
  onViewLegacy?: () => void;
  // 仅旧格式行传：转建新版（对话创建链路）
  onConvertLegacy?: () => void;
  // 本行是否正在转建（按钮 spinner）
  converting?: boolean;
}

// 单行：拖拽手柄 + 名称（自定义带扳手角标 + skill chips）+ [自定义]编辑 / 删除 + 显隐开关
const LayoutRow = ({
  value,
  label,
  isCustom,
  isHidden,
  isLegacy,
  skills,
  onToggleHidden,
  onDragEnd,
  onEdit,
  onDelete,
  onExport,
  onViewLegacy,
  onConvertLegacy,
  converting,
}: RowProps) => {
  // 每个 Item 独立拖拽控制器——dragListener={false} 只让手柄发起拖拽、不误触开关 / 按钮 / 整行
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={value}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDragEnd}
      className="flex items-center gap-2 rounded-md border bg-card px-2 py-2"
    >
      <button
        type="button"
        onPointerDown={(e) => controls.start(e)}
        className="cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing"
        title="拖拽排序"
      >
        <GripVertical className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            "flex items-center gap-1.5 overflow-hidden text-sm",
            isHidden && "text-muted-foreground line-through",
          )}
        >
          <span className="truncate">{label}</span>
          {isCustom && (
            <Tooltip content="自定义 Action">
              <Wrench className="size-3 shrink-0 text-muted-foreground" />
            </Tooltip>
          )}
          {isLegacy && (
            <Badge variant="secondary" className="shrink-0">
              旧格式・已停用
            </Badge>
          )}
          {/* 引用的 skill chips：缺失的灰显划线（本机未找到、推进时自动跳过） */}
          {skills?.map((s) => (
            <Tooltip
              key={s.name}
              content={s.missing ? "本机未找到、推进时自动跳过" : "引用的 skill"}
            >
              <span
                className={cn(
                  "shrink-0 rounded border px-1 py-px font-mono text-[10px] text-muted-foreground",
                  s.missing && "border-dashed line-through opacity-60",
                )}
              >
                {s.name}
              </span>
            </Tooltip>
          ))}
        </span>
        {isLegacy && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            点「转建新版」让 AI 提炼成 skill 并挂壳；验收后再删旧条目
          </p>
        )}
      </div>
      {isHidden && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          已隐藏
        </span>
      )}
      {/* 旧格式：主按钮转建 + 查看原文 / 删除；新格式：编辑 / 导出 / 删除 */}
      {onConvertLegacy && (
        <Button
          size="sm"
          onClick={onConvertLegacy}
          disabled={converting}
          title="开对话、把旧 playbook 转建成 skill + 挂载壳"
        >
          {converting ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Sparkles />
          )}
          转建新版
        </Button>
      )}
      {onViewLegacy && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onViewLegacy}
          title="查看原内容"
        >
          <Eye />
        </Button>
      )}
      {onEdit && (
        <Button variant="ghost" size="icon-sm" onClick={onEdit} title="编辑">
          <Pencil />
        </Button>
      )}
      {onExport && (
        <Button variant="ghost" size="icon-sm" onClick={onExport} title="导出">
          <Share />
        </Button>
      )}
      {onDelete && (
        <Button variant="ghost" size="icon-sm" onClick={onDelete} title="删除">
          <Trash2 />
        </Button>
      )}
      {/* 旧格式不进推进列表、显隐无意义——开关禁用 */}
      <Switch
        checked={!isHidden}
        onCheckedChange={onToggleHidden}
        disabled={isLegacy}
      />
    </Reorder.Item>
  );
};

export const ActionLayoutConfig = ({
  customActions,
  knownSkills,
  onEdit,
  onDelete,
  onExport,
  onViewLegacy,
  onConvertLegacy,
  convertingLegacyId,
}: Props) => {
  const { settings, saveFieldValue, loaded } = useSettings();
  const layout = settings.actionLayout ?? { order: [], hidden: [] };
  const hiddenSet = new Set(layout.hidden);
  const customById = new Map(customActions.map((d) => [d.id, d] as const));

  // 混排全序（内置 + 自定义、按 order 排、增删 custom 自动反映）
  const computedOrder = sortByOrder(
    [...BUILTIN_ADVANCE_ACTIONS, ...customById.keys()],
    layout.order,
  );

  // 本地拖拽态：拖动中实时更新（不落盘）、松手才 persist；orderRef 给松手 / 显隐回调读最新顺序
  const [order, setOrder] = useState<string[]>(computedOrder);
  const orderRef = useRef(order);
  orderRef.current = order;
  // computedOrder 内容变了（增删 custom / 外部改 order）才回灌——用 join 当指纹、避免每 render 重置打断拖拽
  const computedKey = computedOrder.join("|");
  useEffect(() => {
    setOrder(computedOrder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedKey]);

  // 落盘：order 始终用最新本地顺序、清理已删除的 custom id 残留
  const persist = (nextOrder: string[], nextHidden: string[]) => {
    const valid = new Set<string>([
      ...BUILTIN_ADVANCE_ACTIONS,
      ...customActions.map((d) => d.id),
    ]);
    saveFieldValue("actionLayout", {
      order: nextOrder.filter((k) => valid.has(k)),
      hidden: nextHidden.filter((k) => valid.has(k)),
    });
  };

  const handleDragEnd = () => persist(orderRef.current, layout.hidden);

  const toggleHidden = (key: string, visible: boolean) => {
    const set = new Set(layout.hidden);
    if (visible) set.delete(key);
    else set.add(key);
    persist(orderRef.current, [...set]);
  };

  if (!loaded) return <LoadingState variant="inline" />;

  return (
    <Reorder.Group
      axis="y"
      values={order}
      onReorder={setOrder}
      className="grid gap-1.5"
    >
      {order.map((key) => {
        const def = customById.get(key);
        // 旧格式（playbook 写正文）已停用：不可编辑 / 导出、只留转建 / 查看原内容 + 删除
        const isLegacy = !!def?.legacyPlaybook;
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
            // 主 skill：knownSkills 没拉到（null）时不标缺失、避免加载中误报；
            // legacy 无挂载 skill（空串）、chips 不展示
            skills={
              def && !isLegacy
                ? [def.skill].map((name) => ({
                    name,
                    missing: knownSkills !== null && !knownSkills.has(name),
                  }))
                : undefined
            }
            onToggleHidden={(visible) => toggleHidden(key, visible)}
            onDragEnd={handleDragEnd}
            onEdit={def && !isLegacy ? () => onEdit(def) : undefined}
            onDelete={def ? () => onDelete(def) : undefined}
            onExport={def && !isLegacy ? () => onExport(def) : undefined}
            onViewLegacy={def && isLegacy ? () => onViewLegacy(def) : undefined}
            onConvertLegacy={
              def && isLegacy ? () => onConvertLegacy(def) : undefined
            }
            converting={!!def && convertingLegacyId === def.id}
          />
        );
      })}
    </Reorder.Group>
  );
};
