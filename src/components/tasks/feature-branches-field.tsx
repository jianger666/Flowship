"use client";

/**
 * 被测业务分支字段（per-repo）——新建任务 / 编辑任务共用
 *
 * 之前两边是复制粘贴的同一套行布局（Label + 提示 + 按仓 N 行 Tooltip + Combobox），
 * 长分支名撑破弹窗的 bug 修了两遍就是信号，所以抽出来：布局只此一份。
 *
 * 调用方只给数据 + hint 文案：
 * - 新建：分支还没建时可留空，先做分析/用例
 * - 编辑：补上后从下一个 Action 起生效
 */

import { Combobox } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import type { RepoBranchList } from "@/lib/types";

interface Props {
  /** 要展示分支行的仓库路径（调用方已按可见条件过滤好） */
  repoPaths: string[];
  /** 仓库展示名（查不到用路径尾段、调用方定） */
  repoNameOf: (path: string) => string;
  /** per-repo 被测业务分支草稿（key=repoPath） */
  featureBranches: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  /** useRepoBranches 回来的候选 map */
  branchMap: Record<string, RepoBranchList | undefined>;
  /** Label 下的说明行（新建 / 编辑文案不同） */
  hint: string;
}

export const FeatureBranchesField = ({
  repoPaths,
  repoNameOf,
  featureBranches,
  onChange,
  branchMap,
  hint,
}: Props) => {
  return (
    <div className="grid gap-1.5">
      <Label>被测业务分支（可后补）</Label>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {/* 外层 grid + 行 flex 都要 min-w-0：grid 子项默认 min-width:auto 会按最长分支名撑开、
          里面的 truncate / flex-1 收缩全失效、长分支名直接顶穿弹窗 */}
      <div className="grid min-w-0 gap-2">
        {repoPaths.map((p) => {
          const entry = branchMap[p];
          return (
            <div key={p} className="flex min-w-0 items-center gap-2">
              <Tooltip content={repoNameOf(p)}>
                <span className="w-28 shrink-0 truncate text-sm text-muted-foreground">
                  {repoNameOf(p)}
                </span>
              </Tooltip>
              <Combobox
                value={featureBranches[p] ?? ""}
                onValueChange={(v) => onChange({ ...featureBranches, [p]: v })}
                options={entry?.branches ?? []}
                emptyHint="暂无候选"
                allowCustom={Boolean(entry?.gitMissing)}
                placeholder={
                  entry?.isRepo === false
                    ? entry.pathMissing
                      ? "路径不存在"
                      : entry.gitMissing
                        ? "未检测到 git、可手填"
                        : "非 git 仓库"
                    : "选择业务分支"
                }
                wrapperClassName="w-auto min-w-0 flex-1"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};
