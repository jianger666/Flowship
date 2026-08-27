"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

import { useFormDisabled } from "@/components/ui/form-context";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * 上标签下控件的表单项（对标 antd Form.Item，也可 `Form.Item`）
 *
 * - description / error：标题右侧同一位置，error 盖住 description，不另起一行
 * - 校验样式打在这一层；子控件只需自己干活，invalid / disabled 由这里和 Form context 注入
 */
export const Field = ({
  label,
  htmlFor,
  required,
  description,
  error,
  className,
  children,
}: {
  label?: ReactNode;
  htmlFor?: string;
  required?: boolean;
  description?: ReactNode;
  error?: ReactNode;
  className?: string;
  children?: ReactNode;
}) => {
  const invalid = Boolean(error);
  const hint = error ?? description;
  const formDisabled = useFormDisabled();
  return (
    <div
      data-slot="field"
      data-invalid={invalid || undefined}
      className={cn(
        "grid gap-1.5",
        invalid &&
          "[&_[data-slot=input][aria-invalid]]:border-warning [&_[data-slot=input][aria-invalid]]:ring-0 dark:[&_[data-slot=input][aria-invalid]]:ring-0 [&_[data-slot=textarea][aria-invalid]]:border-warning [&_[data-slot=textarea][aria-invalid]]:ring-0 [&_button[aria-invalid=true]]:border-warning [&_button[aria-invalid=true]]:ring-0 dark:[&_button[aria-invalid=true]]:ring-0",
        className,
      )}
    >
      {(label != null || hint != null) && (
        <div
          className={cn(
            "flex min-w-0 items-center gap-2",
            (typeof label === "string" || typeof label === "number" || label == null) &&
              "h-3.5",
          )}
        >
          {label != null &&
            (typeof label === "string" || typeof label === "number" ? (
              <Label htmlFor={htmlFor} required={required} className="shrink-0">
                {label}
              </Label>
            ) : (
              <div className="min-w-0">{label}</div>
            ))}
          {hint != null && (
            <span
              role={invalid ? "alert" : undefined}
              className={cn(
                "min-w-0 truncate text-[11px] font-normal leading-none",
                invalid ? "text-warning" : "text-muted-foreground",
              )}
            >
              {hint}
            </span>
          )}
        </div>
      )}
      {children != null && (
        <div className="min-w-0">
          {Children.map(children, (child) => {
            if (!isValidElement(child)) return child;
            const prev = child.props as {
              disabled?: boolean;
            };
            return cloneElement(child as ReactElement<Record<string, unknown>>, {
              disabled: Boolean(prev.disabled || formDisabled),
              ...(invalid ? { "aria-invalid": true, invalid: true } : {}),
            });
          })}
        </div>
      )}
    </div>
  );
};
