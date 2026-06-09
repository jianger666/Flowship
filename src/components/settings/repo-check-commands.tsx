"use client";

/**
 * 仓库「确定性检查命令」编辑器（V0.6.25）
 *
 * per-repo 配 checkCommands——build 跑完后 runner 自动按这些命令做确定性校验（typecheck / lint / test 等）。
 * 建 task 时这份配置会快照进 task.repoCheckCommands（server 读不到 localStorage、只能用快照）。
 *
 * 跟 repo-card 同款编辑契约：onChange 改草稿（文本输入）、onCommit 落盘（增删 / 失焦 / select / switch）。
 *
 * 为什么抽成独立组件：单条命令 5 个字段（name/cmd/kind/required/timeout）、内嵌 repo-card 会把那个
 * 已 200+ 行的文件撑爆；且「命令清单编辑」是可独立测试的内聚单元。
 */

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  CHECK_COMMAND_KIND_LABEL,
  CHECK_KIND_DEFAULT_TIMEOUT_MS,
} from "@/lib/types";
import type { CheckCommand, CheckCommandKind } from "@/lib/types";

// kind 下拉选项（顺序固定、单一源自 label 表的 key）
const CHECK_KINDS = Object.keys(
  CHECK_COMMAND_KIND_LABEL,
) as CheckCommandKind[];

interface Props {
  commands: CheckCommand[];
  onChange: (next: CheckCommand[]) => void;
  onCommit: (next: CheckCommand[]) => void;
}

export const RepoCheckCommands = ({
  commands,
  onChange,
  onCommit,
}: Props) => {
  // 改某条命令的某些字段——commit=true 立即落盘（离散操作）、false 仅改草稿（文本输入中）
  const updateCmd = (
    index: number,
    patch: Partial<CheckCommand>,
    commit: boolean,
  ) => {
    const next = commands.map((c, i) =>
      i === index ? { ...c, ...patch } : c,
    );
    (commit ? onCommit : onChange)(next);
  };

  // 新增一条：默认 custom kind + required（失败挡 ship）+ 该 kind 默认超时
  const addCommand = () => {
    onCommit([
      ...commands,
      {
        name: "",
        cmd: "",
        kind: "custom",
        required: true,
        timeoutMs: CHECK_KIND_DEFAULT_TIMEOUT_MS.custom,
      },
    ]);
  };

  const removeCommand = (index: number) => {
    onCommit(commands.filter((_, i) => i !== index));
  };

  return (
    <div className="grid gap-2">
      {commands.map((cmd, i) => {
        // 超时展示成秒（内部存 ms）；留空时 server 按 kind 给默认、placeholder 提示该默认值
        const timeoutSec =
          cmd.timeoutMs != null ? String(Math.round(cmd.timeoutMs / 1000)) : "";
        const defaultSec = Math.round(
          CHECK_KIND_DEFAULT_TIMEOUT_MS[cmd.kind] / 1000,
        );
        return (
          <div
            key={i}
            className="grid gap-2 rounded-md border bg-background/40 px-2.5 py-2"
          >
            {/* 第一行：名称 + 命令 + 删除 */}
            <div className="flex items-center gap-2">
              <Input
                value={cmd.name}
                onChange={(e) => updateCmd(i, { name: e.target.value }, false)}
                onBlur={() => onCommit(commands)}
                placeholder="名称"
                className="w-28 shrink-0"
              />
              <Input
                value={cmd.cmd}
                onChange={(e) => updateCmd(i, { cmd: e.target.value }, false)}
                onBlur={() => onCommit(commands)}
                placeholder="命令、如 pnpm typecheck && pnpm lint"
                className="flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => removeCommand(i)}
                title="删除"
              >
                <Trash2 />
              </Button>
            </div>

            {/* 第二行：kind + 是否挡 ship + 超时 */}
            <div className="flex items-center gap-3">
              <Select
                value={cmd.kind}
                onValueChange={(v) =>
                  v && updateCmd(i, { kind: v as CheckCommandKind }, true)
                }
              >
                <SelectTrigger size="sm" className="w-28">
                  <SelectValue>
                    {(value) =>
                      value
                        ? CHECK_COMMAND_KIND_LABEL[value as CheckCommandKind]
                        : "类型"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CHECK_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {CHECK_COMMAND_KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={cmd.required}
                  onCheckedChange={(v) => updateCmd(i, { required: v }, true)}
                />
                失败挡提测
              </label>

              <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                超时
                <Input
                  type="number"
                  min={1}
                  value={timeoutSec}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    const n = Number(v);
                    updateCmd(
                      i,
                      {
                        timeoutMs:
                          v === "" || !Number.isFinite(n) || n <= 0
                            ? undefined
                            : Math.round(n) * 1000,
                      },
                      false,
                    );
                  }}
                  onBlur={() => onCommit(commands)}
                  placeholder={String(defaultSec)}
                  className="w-16"
                />
                秒
              </div>
            </div>
          </div>
        );
      })}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={addCommand}
        className="justify-self-start"
      >
        <Plus />
        添加检查命令
      </Button>
    </div>
  );
};
