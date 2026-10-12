/**
 * 「分支被其他工作树占用」的展示文案（纯函数、前后端共用单一源）
 *
 * 背景：git 不允许同一个分支同时在两个工作树检出——别的 worktree（任务隔离工作区 /
 * 手动 `git worktree add`）占着的分支，在当前目录 `git checkout` 只会拿到一条
 * `fatal: '<branch>' is already checked out at '<path>'`（而且跟着系统语言变）。
 * 分支选择器以前把它列成普通可点项、点了才把这条原文丢进 toast。
 *
 * 现在服务端用 `git worktree list --porcelain`（与 locale 无关）算出占用关系，
 * 选择器据此置灰并说明原因；切换接口也复用同一份措辞兜底（列表过期 / 刚建好 worktree）。
 */

import type { GitBranchOccupant } from "./types";

/**
 * 占用者的简短标签：路径末两段（`my/Flowship-win-fix`）。
 *
 * 不用 basename：任务隔离工作区是 `<数据目录>/worktrees/<taskId>/<仓库名>`，
 * 末段就是仓库名，「已在 Flowship 检出」会被读成「就在主仓里」。
 * 取两段能带出上一级（任务 id / 父目录），Windows 反斜杠路径同样适用。
 */
export const occupantLabel = (occupantPath: string): string => {
  const segments = occupantPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments.slice(-2).join("/") || occupantPath;
};

/** 选择器里被占用分支名下面那行小字（要短、一行放得下） */
export const occupiedBranchHint = (occupant: GitBranchOccupant): string =>
  occupant.missing
    ? "登记在已删除的工作树上"
    : `已在 ${occupantLabel(occupant.path)} 检出`;

/**
 * 完整说明：选择器行的 title + 切换接口失败时返回给 toast 的报错，共用这一份。
 * 要告诉用户三件事：为什么不行、占在哪、怎么办。
 */
export const occupiedBranchMessage = (
  branch: string,
  occupant: GitBranchOccupant,
): string =>
  occupant.missing
    ? `分支 ${branch} 还登记在一个已不存在的工作树上（${occupant.path}）。` +
      "在仓库里执行 git worktree prune 清理后即可切换。"
    : `分支 ${branch} 已在另一个工作树检出（${occupant.path}），` +
      "同一分支不能同时检出到两个目录。请先在那个目录里切走，或直接在那个目录里工作。";

/**
 * 取某分支的占用者（只认自有属性）。
 * 分支名完全由用户起、`constructor` / `toString` 都是合法分支名，
 * 直接 `occupied[b]` 会命中 Object.prototype 上的函数、把普通分支误判成被占用。
 */
export const occupantOf = (
  occupied: Record<string, GitBranchOccupant> | undefined,
  branch: string,
): GitBranchOccupant | undefined =>
  occupied && Object.hasOwn(occupied, branch) ? occupied[branch] : undefined;
