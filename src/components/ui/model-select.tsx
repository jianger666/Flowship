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
import { getTopUsedModels } from "@/lib/local-store";
import { settingsUrl } from "@/lib/settings-link";
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

// 「模型名 · 参数摘要」（trigger 和常用 chip 共用）；models 里反查不到就退回 id
const summarizeSelection = (
  models: ModelOption[],
  sel: { id: string; params?: Array<{ id: string; value: string }> },
): string => {
  const m = models.find((x) => x.id === sel.id);
  const name = m ? modelName(m) : sel.id;
  const paramSummary = (sel.params ?? [])
    .map((sp) => {
      const def = m?.parameters?.find((p) => p.id === sp.id);
      if (!def) return null;
      const vv = def.values.find((x) => x.value === sp.value);
      return vv ? renderParamValue(vv) : null;
    })
    .filter(Boolean);
  return paramSummary.length > 0 ? `${name} · ${paramSummary.join(" · ")}` : name;
};

// 判断两个 selection 是不是同一「模型 + 参数组合」（params 顺序无关）
const sameSelection = (
  a: { id: string; params?: Array<{ id: string; value: string }> },
  b: { id: string; params?: Array<{ id: string; value: string }> },
): boolean => {
  if (a.id !== b.id) return false;
  const key = (params?: Array<{ id: string; value: string }>) =>
    (params ?? []).map((p) => `${p.id}=${p.value}`).sort().join(",");
  return key(a.params) === key(b.params);
};

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
  // 常用模型快捷位（V0.11.x 用户拍板「按使用次数自动排」）：true 时 trigger 上方
  // 常驻 top2 使用最多的「模型 + 参数组合」chip、点一下直接选中、不用开下拉搜
  quickPicks?: boolean;
  // 「不指定模型」选项文案（V0.12.x 任务页说话条用「跟随会话」）：传了就在列表顶部
  // 渲染一个可选项、点选 = onChange({ id: "" })——否则选过模型后没有入口回到未指定态
  followOption?: string;
}

export const ModelSelect = ({
  models,
  selection,
  onChange,
  disabled = false,
  variant = "full",
  emptyPlaceholder = "选择模型",
  onOpenChange,
  quickPicks = false,
  followOption,
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
    return summarizeSelection(models, selection);
  }, [selection, models, emptyPlaceholder]);

  // 常用模型 top2（使用次数自动排、getSettings 同步缓存直接读——挂载时快照一次即可、
  // 计数在提交动作时才变、同一次弹窗内不需要响应式刷新）
  const topUsed = useMemo(
    () => (quickPicks ? getTopUsedModels(2) : []),
    [quickPicks],
  );

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

  // 常用模型快捷 chip 行（quickPicks 且有使用记录才显示）：点一下直接选中「模型 + 参数组合」
  const quickPickRow =
    quickPicks && topUsed.length > 0 ? (
      <div className="flex flex-wrap items-center gap-1.5">
        {/* 文字标签（用户拍板：闪电图标像「快速模式」、有误导） */}
        <span className="shrink-0 text-[11px] text-muted-foreground/70">常用</span>
        {topUsed.map((entry) => (
          <ChoiceButton
            key={`${entry.id}:${(entry.params ?? []).map((p) => `${p.id}=${p.value}`).join(",")}`}
            shape="chip"
            selected={sameSelection(selection, entry)}
            disabled={disabled}
            onClick={() => onChange({ id: entry.id, params: entry.params })}
            className="text-xs"
          >
            {summarizeSelection(models, entry)}
          </ChoiceButton>
        ))}
      </div>
    ) : null;

  const popoverEl = (
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
          {/* 「不指定模型」项（如任务页的「跟随会话」）：常驻列表顶部、随时可点回未指定态 */}
          {followOption && (
            <li>
              <button
                type="button"
                onClick={() => {
                  onChange({ id: "" });
                  handleOpenChange(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
                  !selection.id && "bg-selected text-selected-foreground",
                )}
              >
                <Check
                  className={cn(
                    "size-4 shrink-0",
                    !selection.id ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="truncate text-sm">{followOption}</span>
              </button>
            </li>
          )}
          {models.length === 0 ? (
            <li className="px-2 py-6 text-center text-xs text-muted-foreground">
              <a
                href={settingsUrl("model")}
                className="text-primary underline-offset-2 hover:underline"
              >
                去设置页拉取模型列表
              </a>
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
                      selected && "bg-selected text-selected-foreground",
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

  // 没有快捷位时保持原结构（不包 wrapper、compact 行内用法零影响）
  if (!quickPickRow) return popoverEl;
  return (
    <div className="flex flex-col gap-1.5">
      {quickPickRow}
      {popoverEl}
    </div>
  );
};
