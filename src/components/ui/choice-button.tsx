import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * 「可选中」按钮 / 卡片
 *
 * 抽出来的动机：项目里至少 4 处用 native `<button>` + cn(...) 拼出「点选 / 高亮 / 边框」
 * 模式：new-task-dialog 的 ModeCard、ask-user-dialog 的 option / Other 切换、
 * context-docs-panel 的 preset chip 等。
 * shadcn `<Button>` 不能直接套（默认不带 selected 样式 + 形状对不上）、
 * 所以专门抽这个支持 selected 状态 + 多种形状的轻组件。
 *
 * shape：
 * - card：方块卡（ModeCard / option 选项块、左对齐文本、可包多行）
 * - chip：圆角小药丸（preset / Other 切换）
 * - chip-lg：等高 ~40px 单行选择 chip（推进弹窗「下一步」主角区）——
 *   圆角稍大（rounded-lg）、选中态 = bg-selected + 品牌色细环 + 左侧 inset 竖条点睛
 * - tab：行内按钮（phase-progress 之类、轻量 hover）
 *
 * 用法：
 * ```
 * <ChoiceButton selected={mode === "plan"} onClick={...} shape="card">
 *   <div className="font-medium">方案规划</div>
 *   <div className="text-xs text-muted-foreground">...</div>
 * </ChoiceButton>
 * ```
 *
 * 不做的：
 * - 不内置 letter prefix（A/B/C）：那是 ask-user-dialog 特有需求、它自己拼
 * - 不内置 icon 槽：用法多样、children 自己塞就行
 */

const choiceButtonVariants = cva(
  "transition-colors text-left disabled:cursor-not-allowed disabled:opacity-60",
  {
    variants: {
      shape: {
        card: "rounded-md border p-3",
        chip: "rounded-full border px-2.5 py-0.5 text-[11px]",
        "chip-lg":
          "inline-flex h-10 items-center rounded-lg border px-4 text-base font-medium transition-[color,background-color,border-color,box-shadow] duration-200 ease-out",
        tab: "rounded-md px-2 py-1 text-sm",
      },
      selected: {
        true: "",
        false: "",
      },
    },
    compoundVariants: [
      // card 形状
      {
        shape: "card",
        selected: true,
        className: "border-primary bg-primary/5",
      },
      {
        shape: "card",
        selected: false,
        className: "border-border bg-transparent hover:border-primary/50",
      },
      // chip 形状
      {
        shape: "chip",
        selected: true,
        className: "border-primary/40 bg-primary/10 text-primary",
      },
      {
        shape: "chip",
        selected: false,
        className: "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
      },
      // chip-lg——推进弹窗主角：选中 = selected 实底 + 品牌细环 + 左侧 inset 竖条 + 微内光
      //（克制、不堆叠装饰；竖条用 inset shadow 不占布局、选中切换不抖）
      {
        shape: "chip-lg",
        selected: true,
        className:
          "border-transparent bg-selected text-selected-foreground ring-2 ring-primary/40 shadow-[inset_2px_0_0_0_var(--primary),inset_0_1px_12px_0_color-mix(in_oklab,var(--primary)_12%,transparent)]",
      },
      {
        shape: "chip-lg",
        selected: false,
        className:
          "border-border bg-transparent text-muted-foreground hover:border-primary/35 hover:bg-primary/[0.04] hover:text-foreground",
      },
      // tab 形状——选中态走全局 selected token（bg-muted/60 在浅色下几乎不可见、
      // 用户实测点名「白色的选中状态太弱」、v1.0.x 立规见 ui-conventions）
      {
        shape: "tab",
        selected: true,
        className: "bg-selected font-medium text-selected-foreground",
      },
      {
        shape: "tab",
        selected: false,
        className: "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
      },
    ],
    defaultVariants: {
      shape: "card",
      selected: false,
    },
  },
);

interface ChoiceButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">,
    VariantProps<typeof choiceButtonVariants> {
  children: ReactNode;
}

export const ChoiceButton = ({
  shape,
  selected,
  className,
  children,
  type = "button",
  ...rest
}: ChoiceButtonProps) => (
  <button
    type={type}
    className={cn(choiceButtonVariants({ shape, selected }), className)}
    {...rest}
  >
    {children}
  </button>
);
