import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center overflow-hidden rounded-4xl border border-transparent font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      // 尺寸只两档（2026-07-28 胶囊家族收口）：
      // default = 独立徽标（状态 / 类型标）；xs = 挤在行内的元信息标（列表行尾、
      // 事件流行内、表格单元格）。别再在调用处手写 px-1 py-0 + 更小字号拼第三档。
      size: {
        default: "h-5 gap-1 px-2 py-0.5 text-xs",
        xs: "h-4.5 gap-0.5 px-1.5 py-0 text-[11px]",
      },
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        // 语义色徽标：与 destructive 同一形状（底衬 /10、深色 /20），
        // 让「成功 / 注意 / 失败」三态在徽标位上完全对称、调用方不用自己拼 tone class
        success:
          "bg-success/10 text-success focus-visible:ring-success/20 dark:bg-success/20 [a]:hover:bg-success/20",
        warning:
          "bg-warning/10 text-warning focus-visible:ring-warning/20 dark:bg-warning/20 [a]:hover:bg-warning/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      size: "default",
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant, size }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      size,
      variant,
    },
  })
}

export { Badge, badgeVariants }
