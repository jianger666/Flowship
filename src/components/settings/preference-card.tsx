"use client";

/**
 * 交互习惯配置节（v0.9.11 由 shortcut-card 扩展；v1.0.x 设置整合：Card 壳退役、
 * 作为「偏好」卡的一节）
 *
 * - 提交快捷键：聊天 / 推进 / 再聊聊输入框的提交方式
 * - 推进时默认续用当前 Agent：advance-dialog「续用当前 Agent」开关的初始值
 *   （只是默认勾选、dialog 内仍可临时切；review 强起新 agent 的 server 铁律不受影响）
 */

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SUBMIT_SHORTCUT_LABEL } from "@/lib/submit-shortcut";
import type { SubmitShortcut } from "@/lib/types";

interface InteractionSectionProps {
  submitShortcut: SubmitShortcut;
  reuseAgentDefault: boolean;
  onSubmitShortcutChange: (next: SubmitShortcut) => void;
  onReuseAgentDefaultChange: (next: boolean) => void;
}

export const InteractionSection = ({
  submitShortcut,
  reuseAgentDefault,
  onSubmitShortcutChange,
  onReuseAgentDefaultChange,
}: InteractionSectionProps) => (
  <div className="space-y-4">
    {/* 小节头（跟连接卡同款层级、防「偏好」卡一锅粥） */}
    <div>
      <div className="text-sm font-medium">输入习惯</div>
      <p className="text-xs text-muted-foreground">聊天 / 推进输入框的提交方式</p>
    </div>
    <div className="grid gap-1.5">
      <Label htmlFor="settings-submit-shortcut" className="text-xs">
        提交快捷键
      </Label>
      <Select
        value={submitShortcut}
        onValueChange={(v) =>
          onSubmitShortcutChange(v === "enter" ? "enter" : "mod-enter")
        }
      >
        <SelectTrigger id="settings-submit-shortcut" className="w-72">
          <SelectValue>{SUBMIT_SHORTCUT_LABEL[submitShortcut]}</SelectValue>
        </SelectTrigger>
        <SelectContent
          side="bottom"
          alignItemWithTrigger={false}
          collisionAvoidance={{
            side: "shift",
            align: "shift",
            fallbackAxisSide: "none",
          }}
        >
          <SelectItem value="mod-enter">
            {SUBMIT_SHORTCUT_LABEL["mod-enter"]}
          </SelectItem>
          <SelectItem value="enter">{SUBMIT_SHORTCUT_LABEL.enter}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div className="flex items-center justify-between gap-2">
      {/* 不绑 htmlFor：点标题就切开关误触率高（用户点名「点标题能开关不合理」）、
          只有开关本体可点 */}
      <Label className="text-xs">推进时默认续用当前 Agent</Label>
      <Switch
        checked={reuseAgentDefault}
        onCheckedChange={onReuseAgentDefaultChange}
      />
    </div>
  </div>
);
