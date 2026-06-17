"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SUBMIT_SHORTCUT_LABEL } from "@/lib/submit-shortcut";
import type { SubmitShortcut } from "@/lib/types";

interface ShortcutCardProps {
  submitShortcut: SubmitShortcut;
  onSubmitShortcutChange: (next: SubmitShortcut) => void;
}

export const ShortcutCard = ({
  submitShortcut,
  onSubmitShortcutChange,
}: ShortcutCardProps) => (
  <Card>
    <CardHeader>
      <CardTitle>提交快捷键</CardTitle>
      <CardDescription>聊天、推进、再聊聊输入框的提交方式</CardDescription>
    </CardHeader>
    <CardContent>
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
    </CardContent>
  </Card>
);
