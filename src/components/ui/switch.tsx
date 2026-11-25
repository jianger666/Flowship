"use client";

/**
 * Switch（开关）—— shadcn base-nova 风格、底层用 @base-ui/react/switch
 *
 * 对外接口：
 *   - checked / onCheckedChange：受控 boolean
 *   - disabled：禁用态
 *   - aria-label / aria-labelledby / aria-describedby：无障碍名称与说明（透传给 role="switch" 的根节点）。
 *     在 SettingRow 里时：没显式写名字就自动用本行的名称（labelledby）和说明（describedby）——见 setting-row-context.ts；
 *     显式写的优先。授权类开关（电脑操作等）仍请显式写 aria-label（名字要说清「授权什么」，不能只靠行标题）。
 *     不在 SettingRow 里（表单 / 弹窗单独用）时旁边的文字和它没有 DOM 关联，读屏只会念「开关」——同样要自己给名字
 *   - extraDescribedBy：**追加**一个说明节点的 id，和上面那份说明（行的 hint 或显式写的 aria-describedby）**一起念**，不顶掉它。
 *     风险披露没放进 hint、而是在行外另起一段话时用（「锁屏时也能用」下面那段风险说明）：读屏聚焦开关就能听到，不靠用户自己去翻。
 *
 * 视觉：
 *   - 关：bg-input；开：bg-primary
 *   - thumb 用 absolute + transform 平移、跟 shadcn radix 版本对齐
 */

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { useFormDisabled } from "@/components/ui/form-context";
import { useSettingRowA11y } from "@/components/ui/setting-row-context";
import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** 追加的说明节点 id（和行的 hint / 显式 aria-describedby 一起念，不顶掉它们），见头注释 */
  extraDescribedBy?: string;
}

export const Switch = ({
  checked,
  onCheckedChange,
  disabled,
  className,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  extraDescribedBy,
}: SwitchProps) => {
  // hook 必须无条件调用：写成 `Boolean(disabled) || useFormDisabled()` 时 disabled 为真会短路、跳过这次 hook 调用，
  // 调用顺序随 props 变化（违反 Hooks 规则）。S-7：先取值再 ||
  const formDisabled = useFormDisabled();
  const locked = Boolean(disabled) || formDisabled;
  // 在 SettingRow 里：显式写的名字 / 说明优先；没写 aria-label 时才借行的名称（有 aria-label 再挂 labelledby 会盖掉它）
  const row = useSettingRowA11y();
  const labelledBy = ariaLabelledBy ?? (ariaLabel ? undefined : row?.labelId);
  // 说明节点 id 列表（空格分隔）：基础说明（显式写的优先，否则行的 hint）+ 追加的；都没有 → undefined（不挂指向空气的属性）
  const describedBy = [ariaDescribedBy ?? row?.hintId, extraDescribedBy].filter(Boolean).join(" ") || undefined;
  return (
    <SwitchPrimitive.Root
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={locked}
      className={cn(
        "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
        // Base UI 的 Switch.Root 渲染成 span：禁用态挂在 data-disabled / aria-disabled 上、没有 disabled 属性，
        // Tailwind 的 disabled:（:disabled 伪类）匹配不上；与 dropdown-menu / select 等其它 Base UI 封装一致用 data-disabled:
        "data-disabled:cursor-not-allowed data-disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
        className,
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-md ring-0 transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
};
