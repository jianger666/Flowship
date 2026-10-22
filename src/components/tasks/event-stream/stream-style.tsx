/**
 * 事件流样式单一来源（事件流 v2，2026-10-12）
 *
 * 为什么有这个文件：过程层（工作过程组头 / 思考行 / 工具行 / verb 组 / 重连 / 压缩）
 * 以前各写各的——CollapseChevron 在 rows / work-group / tool-block 三处各有一份，
 * 行按钮的类名也是三份近似拷贝。同一视觉元素出现在 ≥2 处必须抽单一来源（learned-conventions）。
 *
 * 本次重构的三条硬规则（依据见 docs/HANDOFF.md「事件流 v2」）：
 *
 * 1. **文字不叠透明度来表达层级。** 浅色下 `text-muted-foreground/70` 只有 3.3:1、`/50` 只有 2.2:1，
 *    都低于 WCAG AA 的 4.5:1；`text-muted-foreground` 本身是 6.5:1（深色 7.5:1）。
 *    「更弱」靠字号档位（12px → 11px）和位置表达，不靠 alpha。透明度只留给装饰（引导线 / 底衬 / 显隐动画）。
 * 2. **颜色只用现有语义 token，不新增档位**：运行中 = info、完成 = success、失败 = destructive、
 *    思考 / 子代理 = subagent、等你行动 = brand，其余一律中性灰阶。彩色只落在图标 / 点 / 细条上，文字保持中性。
 * 3. **字号只用规范里的 4 档**（15 / 14 / 12 / 11，见 .cursor/rules/ui-conventions.mdc）：
 *    过程行主文 12px，时间 / 耗时 / 计数 11px，展开后的原始数据（命令 / 输出 / diff）11px mono。
 */

import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 折叠 chevron：展开时顺时针转 90°。
 * 颜色走 text-muted-foreground（6.5:1），不再用 opacity-50——它是控件指示、不是纯装饰，
 * 非文本 UI 组件的对比度要求是 3:1。reduced-motion 下不做旋转过渡。
 */
export const CollapseChevron = ({
  open,
  className,
}: {
  open: boolean;
  className?: string;
}) => (
  <ChevronRight
    aria-hidden
    className={cn(
      "size-3 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
      open && "rotate-90",
      className,
    )}
  />
);

/**
 * 过程行的折叠头按钮（工作过程组头 / 思考行 / 工具行 / verb 组共用）。
 *
 * - 12px 主文、中性灰、hover 走 `bg-accent`（浅色下 1.12 的底色差，旧的 `bg-muted/40` 只有 1.03、
 *   肉眼几乎看不出有 hover 反馈）；瞬时态按规范用 hover:bg-accent。
 * - 焦点环不在这里写：globals.css 全局 `outline-ring`（不透明，2026-10-20 起；原 /50 只有 ~1.8:1）已经给原生 button 的 :focus-visible 画了轮廓，
 *   这里只要「不写 outline-none」就是键盘可达的。
 */
export const PROCESS_ROW_BUTTON =
  "flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/** 过程行展开区的左侧引导线：结构线用满色 border（旧的 /50 /40 在浅色下几乎消失） */
export const PROCESS_BODY_RAIL = "border-l border-border pl-3";
