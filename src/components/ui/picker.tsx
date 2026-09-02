"use client";

/**
 * Picker（下拉底层：trigger + 列表弹层）
 *
 * 为什么不用 shadcn Select（`src/components/ui/select.tsx` / Base UI Select）当底层：
 * - Select 只有单选语义，MultiSelect / 模型调参这种「点完还要接着点」做不了
 * - Base UI Select 默认 `alignItemWithTrigger`：弹层把当前选中项对齐到 trigger 上，
 *   短列表（提供方 / 协议）会看起来像「列表飘到按钮中间」，用户已拍板禁止
 * - 可搜索、手填、多选、列表头/底（自定义顶行、参数 chips）都是 Popover + 自绘列表更干净
 *
 * 本组件只用现成 `@/components/ui/popover`，不再手写 Portal。
 * PopoverTrigger 的 render **必须直接是原生 `<button>`**：中间不能套 Tooltip
 *（Base UI 的 onClick/ref 落到不透传组件上会「按钮能看不能点」）。
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Check, ChevronDown, CornerDownLeft, Search, X } from "lucide-react";

import { useFormDisabled } from "@/components/ui/form-context";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { OverflowTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type PickerOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
};

export type PickerTriggerCtx = {
  selected: PickerOption[];
  placeholder: string;
  open: boolean;
};

type PickerSharedProps = {
  options: PickerOption[];
  searchable?: boolean;
  /** 搜索词不在列表里时底部「使用「xxx」」；选中即写入该字符串。暗示需要搜索框 */
  allowCustom?: boolean;
  /** trigger 右侧 X：点了清空且不打开弹层 */
  clearable?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** 提交校验失败：trigger 走 aria-invalid 红框 */
  invalid?: boolean;
  loading?: boolean;
  emptyHint?: ReactNode;
  /** 单选默认 true，多选默认 false */
  closeOnSelect?: boolean;
  renderOption?: (option: PickerOption, selected: boolean) => ReactNode;
  /** 选项行右侧动作（如模型五角星），放在选中勾左边、不触发选中 */
  renderOptionAction?: (option: PickerOption, selected: boolean) => ReactNode;
  renderTrigger?: (ctx: PickerTriggerCtx) => ReactNode;
  /** 列表顶部自定义行；调用方自己画整行 */
  listHeader?: ReactNode;
  /** 列表底部（如 ModelSelect 参数 chips）；Picker 不管模型参数 */
  footer?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  filterOption?: (option: PickerOption, query: string) => boolean;
  /** 打在 trigger 上 */
  className?: string;
  /**
   * 包 trigger+弹层的那层。默认 `w-full`（设置页表单）。
   * composer footer 这种行内并排必须传 `w-auto`：两个 `w-full` 都会按父级 100% 算，叠在一起。
   * 跟固定宽 label 并排时再加 `min-w-0 flex-1`：`w-full` 作为 flex item 会按父级 100% 算，
   * 再加 label 就把清空按钮挤出弹窗（被测业务分支踩过）。
   */
  wrapperClassName?: string;
  /** 覆盖弹层宽度等；默认跟 trigger 等宽 `w-(--anchor-width)` */
  contentClassName?: string;
  searchPlaceholder?: string;
  /** Combobox 兼容：原生 title。新调用方请用外层 Tooltip，不要扩大这个 prop */
  title?: string;
  /** 弹层相对 trigger 水平对齐；贴下方展开、默认 start */
  align?: "start" | "center" | "end";
  /** 受控开关；不传则内部自管 */
  open?: boolean;
};

export type PickerSingleProps = PickerSharedProps & {
  multiple?: false;
  value: string;
  onChange: (next: string) => void;
};

export type PickerMultipleProps = PickerSharedProps & {
  multiple: true;
  value: string[];
  onChange: (next: string[]) => void;
};

export type PickerProps = PickerSingleProps | PickerMultipleProps;

type PickerComponent = {
  (props: PickerSingleProps): ReactElement;
  (props: PickerMultipleProps): ReactElement;
};

const defaultFilterOption = (option: PickerOption, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (option.value.toLowerCase().includes(q)) return true;
  return (
    typeof option.label === "string" && option.label.toLowerCase().includes(q)
  );
};

// px-3 左右对称：文字距左边框 = 箭头距右边框。勾/箭头是内容不是间距。
// min-w-0：flex 行里长文案默认 min-content，不写会把右侧 X 挤出父容器。
const TRIGGER_CLASS =
  "flex h-9 w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

/** 选项行：列表 p-1（4px 框）+ 这里 px-2 → 文字距弹层边 12px，跟 trigger px-3 对齐。
 *  items-center：两行（名称 + id）时星/勾跟整块文字垂直居中，不要顶对齐第一行。 */
const OPTION_BUTTON_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:pointer-events-none disabled:opacity-50";

export const Picker: PickerComponent = (props) => {
  const {
    options,
    searchable = false,
    allowCustom = false,
    clearable = false,
    placeholder = "请选择",
    disabled: disabledProp = false,
    invalid = false,
    loading = false,
    emptyHint = "无候选",
    renderOption,
    renderOptionAction,
    renderTrigger,
    listHeader,
    footer,
    onOpenChange,
    filterOption,
    className,
    wrapperClassName,
    contentClassName,
    searchPlaceholder = "搜索…",
    title,
    align = "start",
    open: openControlled,
  } = props;
  const formDisabled = useFormDisabled();
  const disabled = disabledProp || formDisabled;

  const multiple = props.multiple === true;
  const closeOnSelect = props.closeOnSelect ?? !multiple;
  // allowCustom 必须能敲字，所以搜索框跟 searchable 一样开
  const showSearch = searchable || allowCustom;

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = openControlled !== undefined;
  const open = isControlled ? openControlled : uncontrolledOpen;
  // 搜索词：过滤候选；allowCustom 时兼当手填值
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const setOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  // 打开后再聚焦：portal 当帧还没挂上 input。关的时候不清 query，下次打开 effect 会重置
  useEffect(() => {
    if (!open) return;
    setQuery("");
    if (!showSearch) return;
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, showSearch]);

  const selectedKeys: string[] =
    props.multiple === true
      ? props.value
      : props.value
        ? [props.value]
        : [];

  // 多选只展示仍在 options 里的项（跟旧 MultiSelect 一致）；单选允许手填值不在列表里
  let selectedOptions: PickerOption[] = [];
  if (props.multiple === true) {
    selectedOptions = selectedKeys
      .map((k) => options.find((o) => o.value === k))
      .filter((x): x is PickerOption => x != null);
  } else if (props.value) {
    const raw = props.value;
    selectedOptions = [
      options.find((o) => o.value === raw) ?? { value: raw, label: raw },
    ];
  }

  const filtered = useMemo(() => {
    if (!showSearch) return options;
    const filter = filterOption ?? defaultFilterOption;
    return options.filter((o) => filter(o, query));
  }, [options, query, showSearch, filterOption]);

  const customCandidate = useMemo(() => {
    const q = query.trim();
    if (!allowCustom || !q) return null;
    if (options.some((o) => o.value === q)) return null;
    return q;
  }, [allowCustom, query, options]);

  const hasValue =
    props.multiple === true ? props.value.length > 0 : Boolean(props.value);

  const commitSingle = (next: string) => {
    if (props.multiple) return;
    props.onChange(next);
    if (closeOnSelect) setOpen(false);
  };

  const commitMultiple = (next: string[]) => {
    if (!props.multiple) return;
    props.onChange(next);
    if (closeOnSelect) setOpen(false);
  };

  const pick = (v: string) => {
    if (props.multiple === true) {
      const cur = props.value;
      commitMultiple(
        cur.includes(v) ? cur.filter((k) => k !== v) : [...cur, v],
      );
      return;
    }
    commitSingle(v);
  };

  const stopTriggerOpen = (e: MouseEvent | PointerEvent) => {
    // 拦下事件：否则会冒泡给 trigger 把弹层打开
    e.stopPropagation();
  };

  const handleClear = (e: MouseEvent) => {
    stopTriggerOpen(e);
    // 清空不关弹层（跟旧 Combobox 一致）；也不走 pick，避免 closeOnSelect 把层带没
    if (props.multiple === true) {
      props.onChange([]);
    } else {
      props.onChange("");
    }
  };

  const triggerInner = renderTrigger ? (
    renderTrigger({ selected: selectedOptions, placeholder, open })
  ) : multiple ? (
    selectedOptions.length === 0 ? (
      <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
        {placeholder}
      </span>
    ) : selectedOptions.length === 1 ? (
      <span className="min-w-0 flex-1 truncate text-left">
        {selectedOptions[0]!.label}
      </span>
    ) : (
      <span className="truncate font-medium">已选 {selectedOptions.length} 个</span>
    )
  ) : selectedOptions.length === 0 ? (
    <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
      {placeholder}
    </span>
  ) : (
    <span className="min-w-0 flex-1 truncate text-left">
      {selectedOptions[0]!.label}
    </span>
  );

  const showEmpty =
    !loading && filtered.length === 0 && !customCandidate;
  const emptyMessage =
    query.trim() && options.length > 0
      ? `没有匹配「${query.trim()}」的项`
      : emptyHint;

  return (
    <Popover
      open={disabled ? false : open}
      onOpenChange={(next) => {
        if (disabled) return;
        setOpen(next);
      }}
    >
      {/* 包一层：Portal 打开时会在 trigger 旁插入 FocusGuard。SettingRow 的 space-y
          会把这些兄弟当成额外子元素、给后面的行加 margin（设置页点开下拉会往下挤）。 */}
      <div className={cn("relative w-full min-w-0", wrapperClassName)}>
        <PopoverTrigger
          render={
            // PopoverTrigger 的 render 必须直接是可交互 DOM。之前套 Tooltip 组件后，
            // Base UI 注入的 onClick / ref 落到了不透传 props 的 Tooltip 上，按钮视觉正常但点击无效。
            <button
              type="button"
              disabled={disabled}
              aria-invalid={invalid || undefined}
              title={title}
              className={cn(TRIGGER_CLASS, className)}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                {triggerInner}
              </span>
              {clearable && hasValue && !disabled ? (
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="清空"
                  onClick={handleClear}
                  onPointerDown={stopTriggerOpen}
                  className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" />
                </span>
              ) : (
                <ChevronDown className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
              )}
            </button>
          }
        />
        <PopoverContent
          align={align}
          side="bottom"
          sideOffset={4}
          className={cn(
            // 默认跟 trigger 等宽；调用方用 contentClassName 抬 min-w（窄环境框）。
            // 选项单行省略，超出 hover 出全文（OverflowTooltip）。
            "w-(--anchor-width) min-w-(--anchor-width) max-w-(--anchor-width) overflow-hidden p-0",
            contentClassName,
          )}
        >
          {showSearch ? (
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  if (loading) return;
                  const target =
                    filtered.find((o) => !o.disabled)?.value ?? customCandidate;
                  if (target) pick(target);
                }}
                placeholder={searchPlaceholder}
                className="min-w-0 flex-1 truncate bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          ) : null}

          {/* p-1：选中灰底不要贴弹层圆角。左右 4px + 选项 px-2 = 12px，跟 trigger px-3 齐。
              滚动条槽已在 globals.css 对弹层退出，不会再把右边多空 8px。 */}
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto p-1">
            {listHeader ? <li>{listHeader}</li> : null}
            {loading ? (
              <li className="px-2 py-4">
                <LoadingState variant="inline" label="加载中…" />
              </li>
            ) : (
              <>
                {filtered.map((option) => {
                  const selected = selectedKeys.includes(option.value);
                  const labelText =
                    typeof option.label === "string" ? option.label : null;
                  return (
                    <li
                      key={option.value}
                      className={cn(
                        "flex min-w-0 items-center rounded-md",
                        selected
                          ? "bg-selected text-selected-foreground"
                          : "hover:bg-accent",
                      )}
                    >
                      <button
                        type="button"
                        disabled={option.disabled}
                        onClick={() => {
                          if (option.disabled) return;
                          pick(option.value);
                        }}
                        className={cn(OPTION_BUTTON_CLASS, "flex-1")}
                      >
                        {renderOption ? (
                          renderOption(option, selected)
                        ) : labelText != null ? (
                          <OverflowTooltip
                            text={labelText}
                            className="text-sm"
                          />
                        ) : (
                          <span className="min-w-0 flex-1 overflow-hidden text-sm">
                            {option.label}
                          </span>
                        )}
                        {!renderOptionAction ? (
                          <span className="flex size-4 shrink-0 items-center justify-center">
                            <Check
                              className={cn(
                                "size-4",
                                selected ? "opacity-100" : "opacity-0",
                              )}
                            />
                          </span>
                        ) : null}
                      </button>
                      {renderOptionAction ? (
                        <div className="mr-2 flex shrink-0 items-center gap-0.5">
                          {renderOptionAction(option, selected)}
                          <span className="flex size-4 items-center justify-center">
                            <Check
                              className={cn(
                                "size-4",
                                selected ? "opacity-100" : "opacity-0",
                              )}
                            />
                          </span>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
                {showEmpty ? (
                  <li className="px-2 py-6 text-center text-xs text-muted-foreground">
                    {emptyMessage}
                  </li>
                ) : null}
                {customCandidate && !loading ? (
                  <li>
                    <button
                      type="button"
                      onClick={() => pick(customCandidate)}
                      className={cn(OPTION_BUTTON_CLASS, "items-center hover:bg-accent")}
                    >
                      <OverflowTooltip
                        text={`使用「${customCandidate}」`}
                        className="text-sm"
                      />
                      <CornerDownLeft className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ) : null}
              </>
            )}
          </ul>
          {footer}
        </PopoverContent>
      </div>
    </Popover>
  );
};
