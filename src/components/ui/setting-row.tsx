"use client";

import { useId, useMemo, type ReactNode } from "react";
import { Info } from "lucide-react";

import { SettingRowA11yContext } from "@/components/ui/setting-row-context";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * 统一设置行（v1.0.x 设置页定式、对标 VS Code / Linear）
 *
 * 两种形态：
 * - 默认：左「名称 + 一句说明」、右控件右对齐（Select / Switch 等窄控件）
 * - stacked：名称行（可带右侧附加操作）+ 全宽控件（Input / ModelSelect 等宽控件）
 *
 * 用法约定（ui-conventions）：设置类页面每个配置项一律用本组件、外层容器 `divide-y`
 * 出行间分隔；不要再手拼「小节头 + Label + 控件」三层文字（实测「乱」的根源）。
 *
 * **hint 只写一句**（字数上限 HINT_MAX、detail 上限 DETAIL_MAX，数字只在 tests/helpers/settings-copy-limits.ts 里写一份，
 * tests/settings-hint-brevity.test.ts 直接扫文案数据，超了会红；窄窗口里一句话最多折成两行）：这项是什么、开了会怎样。
 * 放不下的背景 / 边界 / 风险细节一律进 `detail`：名称后面多一个 ⓘ，悬停或键盘聚焦才出气泡。
 * ⛔ 不要把教程塞进 hint（浏览器卡、飞书桥接块都因此被用户点名「一大串字」）。
 * 但 hint 里要保住「风险 / 默认值」这类做决定必须看到的词，别全藏进气泡。
 *
 * 无障碍：行里的 Switch 没写 aria-label 时，自动用本行的名称（labelledby）和说明（describedby）当自己的名字——
 * 见 setting-row-context.ts。ⓘ 按钮不在名称节点里，所以不会被念进开关的名字。
 *
 * ⓘ 对读屏的可达性（S-3）：Base UI 的 Tooltip trigger / popup 自己没有 aria-describedby 也没有 role，
 * 气泡只在悬停 / 聚焦时才挂载，读屏用户听不到 detail。所以 detail 另外常驻渲染一份 sr-only 文本（视觉上不可见、
 * 不占位），ⓘ 按钮用 aria-describedby 指向它——聚焦 ⓘ 时读屏念「<名称>：更多说明，<detail 全文>」。
 * 这份 sr-only 文本**不在名称节点里、也不在 hint 里**，不会被念进开关的名字 / 说明。
 * 刻意**不做**触屏 Popover：Flowship 是桌面应用，以鼠标 + 键盘为主；Tooltip 的交互形式（悬停 / 聚焦出气泡、
 * 气泡不可悬停）保持不变。要给触屏设备用的话，需要把 ⓘ 换成点按开合的 Popover（已知边界，不在这次范围）。
 * ⓘ 的可点区域放大到 24px（size-6，WCAG 2.2 的最小目标尺寸），用负外边距抵消，图标和行高视觉不变。
 */
export const SettingRow = ({
  label,
  hint,
  detail,
  control,
  stacked,
  labelExtra,
  className,
}: {
  label: string;
  hint?: ReactNode;
  /** 补充说明（悬停 / 聚焦名称后的 ⓘ 出气泡，同时常驻一份 sr-only 文本给读屏）。纯文字或轻量 JSX；不给就不渲染 ⓘ，名称节点与以前逐字一致 */
  detail?: ReactNode;
  control: ReactNode;
  /** 宽控件形态：名称行 + 全宽控件（Input / 组合控件用） */
  stacked?: boolean;
  /** 名称行右侧的附加操作（如「获取列表」按钮、显隐切换） */
  labelExtra?: ReactNode;
  /** 外层容器 class 覆盖（如在 space-y + Separator 分节的卡里去掉自带 py） */
  className?: string;
}) => {
  const uid = useId();
  const labelId = `${uid}-label`;
  const hintId = hint ? `${uid}-hint` : undefined;
  const detailId = `${uid}-detail`;
  // context 值稳定引用：{labelId, hintId} 每次渲染新建对象会让行里所有 useSettingRowA11y 的消费者（Switch）白白重渲染
  const a11y = useMemo(() => ({ labelId, hintId }), [labelId, hintId]);

  const labelNode = detail ? (
    <div className="flex items-center gap-1 text-sm">
      <span id={labelId}>{label}</span>
      <Tooltip content={detail} className="max-w-sm">
        <button
          type="button"
          aria-label={`${label}：更多说明`}
          aria-describedby={detailId}
          className="-m-1 inline-flex size-6 shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Info className="size-3.5" aria-hidden="true" />
        </button>
      </Tooltip>
      {/* 常驻的 sr-only 全文：ⓘ 的 aria-describedby 指向它（原因见头注释）；放在名称 span 之外，不会进开关的名字 */}
      <span id={detailId} className="sr-only">
        {detail}
      </span>
    </div>
  ) : (
    <div id={labelId} className="text-sm">
      {label}
    </div>
  );

  const hintNode = hint ? (
    <p id={hintId} className="mt-0.5 text-xs text-muted-foreground">
      {hint}
    </p>
  ) : null;

  return (
    <SettingRowA11yContext.Provider value={a11y}>
      {stacked ? (
        <div className={cn("space-y-2 py-4 first:pt-0 last:pb-0", className)}>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              {labelNode}
              {hintNode}
            </div>
            {labelExtra}
          </div>
          {control}
        </div>
      ) : (
        <div
          className={cn(
            "flex items-center justify-between gap-6 py-4 first:pt-0 last:pb-0",
            className,
          )}
        >
          <div className="min-w-0">
            {labelNode}
            {hintNode}
          </div>
          <div className="shrink-0">{control}</div>
        </div>
      )}
    </SettingRowA11yContext.Provider>
  );
};
