"use client";

/**
 * ModelSelect（统一模型选择器、取代旧 model-picker.tsx）
 *
 * 全站模型选择的唯一组件：一个「trigger + 可搜索 popover + 参数」一体的选择器。
 *
 * 针对旧 ModelPicker 的几个老问题逐个解决：
 * 1. 模型几十个、纯下拉无搜索 → 顶部搜索框按 displayName / id 实时过滤
 * 2. base 和 params 两段割裂、切 base 重置 → 同一个 popover 里选完 base 紧跟着调 params
 * 3. **「选完点空白要两次才关」**→ 关键根因是旧实现嵌套了弹层（Popover 套 Select / Select 套 Select）。
 *    本组件 popover 内**零嵌套弹层**：模型列表是普通 button、params 用 ChoiceButton chips
 *    （点一下原地切值、不弹二级 listbox）。整个 popover 单层、点一次空白即关。
 * 4. trigger 直接显示「模型名 · 参数摘要」、compact 态也一眼看到当前参数
 *
 * variant：
 * - full：trigger 全宽（设置页 / dialog 表单内）
 * - compact：trigger 紧凑行内小按钮（chat footer）
 *
 * 受控契约（跟旧 ModelPicker 一致）：调用方传 models（负责拉取）+ selection + onChange。
 * onOpenChange 暴露出去、让调用方在 open=true 时按需拉模型列表。
 */

import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

import { ChoiceButton } from "@/components/ui/choice-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ModelOption, ModelParameter, ModelSelection } from "@/lib/types";
import { cn } from "@/lib/utils";

// displayName 里带 ":icon-xxx" 这种图标占位 token 时、退回显示 id（沿用旧 ModelPicker 逻辑）
const isIconToken = (s?: string) => !s || /:icon-/.test(s);

const renderParamLabel = (p: ModelParameter): string =>
  isIconToken(p.displayName) ? p.id : (p.displayName as string);

const renderParamValue = (v: {
  value: string;
  displayName?: string;
}): string =>
  isIconToken(v.displayName)
    ? v.value === "true"
      ? "开"
      : v.value === "false"
        ? "关"
        : v.value
    : (v.displayName as string);

// 选 base 模型时给个合理初始 params：优先取 variants 里 isDefault 的那组
const defaultParamsFor = (
  m: ModelOption | undefined,
): ModelSelection["params"] => {
  if (!m?.variants || m.variants.length === 0) return undefined;
  const def = m.variants.find((v) => v.isDefault) ?? m.variants[0];
  return def.params.length > 0 ? def.params : undefined;
};

// 模型名展示：displayName 是图标 token 就退显 id
const modelName = (m: ModelOption): string =>
  isIconToken(m.displayName) ? m.id : m.displayName;

interface Props {
  models: ModelOption[];
  selection: ModelSelection;
  onChange: (next: ModelSelection) => void;
  disabled?: boolean;
  variant?: "full" | "compact";
  // 无选中时 trigger 占位文案
  emptyPlaceholder?: string;
  // 打开 / 关闭回调：调用方可在 open=true 时按需拉模型列表
  onOpenChange?: (open: boolean) => void;
}

export const ModelSelect = ({
  models,
  selection,
  onChange,
  disabled = false,
  variant = "full",
  emptyPlaceholder = "选择模型",
  onOpenChange,
}: Props) => {
  // popover 开关（受控）：选模型 / 调参数都不主动关、允许连续操作；点外 / Esc 才关
  const [open, setOpen] = useState(false);
  // 搜索词：按 displayName / id 过滤模型列表
  const [query, setQuery] = useState("");
  // 搜索框 ref：打开时自动聚焦、用户可直接敲字过滤
  const searchRef = useRef<HTMLInputElement>(null);

  // 当前选中的 base model 完整定义（id 反查）
  const selectedModel = useMemo(
    () => models.find((m) => m.id === selection.id),
    [models, selection.id],
  );

  // trigger 摘要：模型名 + 各 param 当前值（如「Claude Opus 4.8 · 思考 高」）
  const triggerLabel = useMemo(() => {
    if (!selection.id) return emptyPlaceholder;
    const name = selectedModel ? modelName(selectedModel) : selection.id;
    // params 摘要：只在能反查到 parameter 定义时拼、拼不出就只显示模型名
    const paramSummary = (selection.params ?? [])
      .map((sp) => {
        const def = selectedModel?.parameters?.find((p) => p.id === sp.id);
        if (!def) return null;
        const vv = def.values.find((x) => x.value === sp.value);
        return vv ? renderParamValue(vv) : null;
      })
      .filter(Boolean);
    return paramSummary.length > 0 ? `${name} · ${paramSummary.join(" · ")}` : name;
  }, [selection, selectedModel, emptyPlaceholder]);

  // 过滤后的模型列表（displayName / id 大小写不敏感匹配）
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q),
    );
  }, [models, query]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    if (next) {
      setQuery("");
      // portal 渲染后下一帧再聚焦搜索框（直接 focus 拿不到节点）
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  };

  // 选 base 模型：写 id + 该模型 default params（不关 popover、让用户接着调 params）
  const handlePickModel = (m: ModelOption) => {
    onChange({ id: m.id, params: defaultParamsFor(m) });
  };

  // 调单个 param：原地切值、不弹二级弹层（关键——避免嵌套 popup 的「点两次才关」）
  const handlePickParam = (paramId: string, value: string) => {
    const old = selection.params ?? [];
    const exists = old.some((p) => p.id === paramId);
    const next = exists
      ? old.map((p) => (p.id === paramId ? { ...p, value } : p))
      : [...old, { id: paramId, value }];
    onChange({ id: selection.id, params: next });
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            // 视觉对齐 shadcn SelectTrigger（src/components/ui/select.tsx）
            className={cn(
              "flex h-9 items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
              variant === "compact" ? "h-7 max-w-52 text-xs" : "w-full",
            )}
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-left",
                !selection.id && "text-muted-foreground",
              )}
            >
              {triggerLabel}
            </span>
            <ChevronDown className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-72 overflow-hidden p-0"
      >
        {/* 搜索框：popover 内零嵌套、敲字实时过滤 */}
        <div className="flex items-center gap-2 border-b px-2.5 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型…"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        {/* 模型列表：普通 button 列表（非嵌套 Select）、选中打勾、点选不关 popover */}
        <ul className="max-h-60 overflow-y-auto p-1">
          {models.length === 0 ? (
            <li className="px-2 py-6 text-center text-xs text-muted-foreground">
              请先在设置页拉取模型列表
            </li>
          ) : filtered.length === 0 ? (
            <li className="px-2 py-6 text-center text-xs text-muted-foreground">
              没有匹配「{query}」的模型
            </li>
          ) : (
            filtered.map((m) => {
              const selected = m.id === selection.id;
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => handlePickModel(m)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
                      selected && "bg-accent/40",
                    )}
                  >
                    <Check
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        selected ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                      <span className="truncate text-sm">{modelName(m)}</span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {m.id}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>

        {/* 参数区：选中模型有 parameters 才显示。chips 点一下原地切、零嵌套弹层 */}
        {selectedModel?.parameters && selectedModel.parameters.length > 0 && (
          <div className="flex flex-col gap-2 border-t px-2.5 py-2">
            {selectedModel.parameters.map((p) => {
              const current = selection.params?.find((x) => x.id === p.id)?.value;
              return (
                <div key={p.id} className="flex flex-col gap-1">
                  <span className="text-[11px] capitalize text-muted-foreground">
                    {renderParamLabel(p)}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {p.values.map((v) => (
                      <ChoiceButton
                        key={v.value}
                        shape="chip"
                        selected={current === v.value}
                        disabled={disabled}
                        onClick={() => handlePickParam(p.id, v.value)}
                      >
                        {renderParamValue(v)}
                      </ChoiceButton>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};
