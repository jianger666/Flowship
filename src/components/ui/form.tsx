"use client";

import type { ReactNode } from "react";

import { Field } from "@/components/ui/field";
import { FormDisabledContext } from "@/components/ui/form-context";
import { cn } from "@/lib/utils";

export { useFormDisabled } from "@/components/ui/form-context";

/**
 * 表单壳（对标 antd Form）
 *
 * disabled 会沿 context 传给底下的 Input / Picker / CheckboxRow / DatePicker 等，
 * 不必每个控件再传一遍。校验样式仍在 Form.Item（Field）上。
 */
const FormRoot = ({
  disabled = false,
  className,
  children,
}: {
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) => (
  <FormDisabledContext.Provider value={disabled}>
    <div data-slot="form" className={cn(className)}>
      {children}
    </div>
  </FormDisabledContext.Provider>
);

export const Form = Object.assign(FormRoot, { Item: Field });
