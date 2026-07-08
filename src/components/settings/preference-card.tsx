"use client";

/**
 * 交互偏好卡（v0.9.11 由 shortcut-card 扩展改名）
 *
 * 聚合「个人交互习惯」类设置、避免每加一个开关就多一张单项卡：
 * - 提交快捷键：聊天 / 推进 / 再聊聊输入框的提交方式
 * - 推进时默认续用当前 Agent：advance-dialog「续用当前 Agent」开关的初始值
 *   （只是默认勾选、dialog 内仍可临时切；review 强起新 agent 的 server 铁律不受影响）
 */

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

interface PreferenceCardProps {
  submitShortcut: SubmitShortcut;
  reuseAgentDefault: boolean;
  onSubmitShortcutChange: (next: SubmitShortcut) => void;
  onReuseAgentDefaultChange: (next: boolean) => void;
}

export const PreferenceCard = ({
  submitShortcut,
  reuseAgentDefault,
  onSubmitShortcutChange,
  onReuseAgentDefaultChange,
}: PreferenceCardProps) => (
  <Card>
    <CardHeader>
      <CardTitle>交互偏好</CardTitle>
    </CardHeader>
    <CardContent className="space-y-4">
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
        <Label
          htmlFor="settings-reuse-agent-default"
          className="cursor-pointer text-xs"
        >
          推进时默认续用当前 Agent
        </Label>
        <Switch
          id="settings-reuse-agent-default"
          checked={reuseAgentDefault}
          onCheckedChange={onReuseAgentDefaultChange}
        />
      </div>
    </CardContent>
  </Card>
);
