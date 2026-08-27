"use client";

/**
 * 启动表单里的「激活项目」确认区
 *
 * 只在需求任务 + Hub 已配 + 还没手填 REQ-ID 时出现。勾上后展开要填的格：
 * 语义编码 / 需求方 / 技术 Owner（Hub 候选）/ 上线日。
 */

import { CheckboxRow } from "@/components/ui/checkbox-row";
import { DatePicker } from "@/components/ui/date-picker";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Picker } from "@/components/ui/picker";
import {
  DEMAND_PARTY_OPTIONS,
  type HubOwnerOption,
  type WkActivateFieldErrors,
} from "@/lib/wk-activate";

interface Props {
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  /** 勾选是否可用：Hub 没有启用中的 Owner 就禁用 */
  canEnable: boolean;
  owners: HubOwnerOption[];
  techOwner: string;
  onTechOwnerChange: (next: string) => void;
  semanticCode: string;
  onSemanticCodeChange: (next: string) => void;
  businessLine: string;
  onBusinessLineChange: (next: string) => void;
  plannedOnlineDate: string;
  onPlannedOnlineDateChange: (next: string) => void;
  errors?: WkActivateFieldErrors;
}

export const WkActivateFields = ({
  enabled,
  onEnabledChange,
  canEnable,
  owners,
  techOwner,
  onTechOwnerChange,
  semanticCode,
  onSemanticCodeChange,
  businessLine,
  onBusinessLineChange,
  plannedOnlineDate,
  onPlannedOnlineDateChange,
  errors,
}: Props) => (
  <div className="grid gap-3">
    <Field
      label={
        <CheckboxRow
          checkboxId="l-wk-activate"
          checked={enabled}
          disabled={!canEnable}
          onCheckedChange={onEnabledChange}
        >
          <span className="text-sm font-normal leading-none">激活项目</span>
        </CheckboxRow>
      }
      description={canEnable ? undefined : "Hub 没有启用中的 Owner"}
    />

    {enabled && (
      <div className="grid grid-cols-1 gap-3 *:min-w-0 sm:grid-cols-2">
        <Field
          htmlFor="l-wk-semantic"
          label="人工语义编码"
          required
          error={errors?.semanticCode}
        >
          <Input
            id="l-wk-semantic"
            value={semanticCode}
            onChange={(e) => onSemanticCodeChange(e.target.value)}
            placeholder="如 OPENSEA"
          />
        </Field>
        <Field
          label="需求方"
          required
          error={errors?.businessLine}
        >
          <Picker
            value={businessLine}
            onChange={onBusinessLineChange}
            className="h-8"
            options={DEMAND_PARTY_OPTIONS.map((item) => ({
              value: item.value,
              label: item.label,
            }))}
          />
        </Field>
        <Field
          label="技术 Owner"
          required
          error={errors?.techOwner}
        >
          <Picker
            value={techOwner}
            searchable
            onChange={onTechOwnerChange}
            className="h-8"
            options={owners.map((item) => ({
              value: item.value,
              label: item.label,
            }))}
          />
        </Field>
        <Field
          htmlFor="l-wk-online-date"
          label="计划上线日"
          required
          error={errors?.plannedOnlineDate}
        >
          <DatePicker
            id="l-wk-online-date"
            value={plannedOnlineDate}
            onChange={onPlannedOnlineDateChange}
          />
        </Field>
      </div>
    )}
  </div>
);
