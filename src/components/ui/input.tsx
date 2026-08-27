"use client";

import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { useFormDisabled } from "@/components/ui/form-context"
import { cn } from "@/lib/utils"

/** 文本类 input 没传 placeholder 时的默认占位（date / file 等原生控件不套） */
const TEXT_LIKE_INPUT_TYPES = new Set([
  "text",
  "password",
  "email",
  "url",
  "tel",
  "search",
  "number",
]);

function Input({
  className,
  type,
  placeholder,
  disabled,
  invalid,
  ...props
}: React.ComponentProps<"input"> & { invalid?: boolean }) {
  const formDisabled = useFormDisabled()
  const resolvedPlaceholder =
    placeholder ??
    (type == null || TEXT_LIKE_INPUT_TYPES.has(type) ? "请输入" : undefined);
  return (
    <InputPrimitive
      type={type}
      placeholder={resolvedPlaceholder}
      disabled={disabled || formDisabled}
      aria-invalid={props["aria-invalid"] ?? (invalid ? true : undefined)}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
