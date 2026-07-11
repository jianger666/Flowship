import type { ReactNode } from "react";

/**
 * 统一设置行（v1.0.x 设置页定式、对标 VS Code / Linear）
 *
 * 两种形态：
 * - 默认：左「名称 + 一句说明」、右控件右对齐（Select / Switch 等窄控件）
 * - stacked：名称行（可带右侧附加操作）+ 全宽控件（Input / ModelSelect 等宽控件）
 *
 * 用法约定（ui-conventions）：设置类页面每个配置项一律用本组件、外层容器 `divide-y`
 * 出行间分隔；不要再手拼「小节头 + Label + 控件」三层文字（实测「乱」的根源）。
 */
export const SettingRow = ({
  label,
  hint,
  control,
  stacked,
  labelExtra,
}: {
  label: string;
  hint?: ReactNode;
  control: ReactNode;
  /** 宽控件形态：名称行 + 全宽控件（Input / 组合控件用） */
  stacked?: boolean;
  /** 名称行右侧的附加操作（如「获取列表」按钮、显隐切换） */
  labelExtra?: ReactNode;
}) =>
  stacked ? (
    <div className="space-y-2 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm">{label}</div>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {labelExtra}
      </div>
      {control}
    </div>
  ) : (
    <div className="flex items-center justify-between gap-6 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
