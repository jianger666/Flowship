"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

// required：必填字段统一在 label 末尾渲染红色星号——「必填校验」和「星号 UI」单一来源、
// 避免出现「逻辑必填但 UI 漏标星号」的不一致（调用方只传 required、不再各自手写 <span>*</span>）。
function Label({
  className,
  required,
  children,
  ...props
}: React.ComponentProps<"label"> & { required?: boolean }) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-1.5 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
      {required ? (
        <span className="text-destructive" aria-hidden="true">
          *
        </span>
      ) : null}
    </label>
  )
}

export { Label }
