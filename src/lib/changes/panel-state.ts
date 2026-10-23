/**
 * 代码改动入口（TaskChangesPanel）的几条纯判断。
 *
 * 从组件里抽出来是为了能单测：「该不该发请求 / 挂入口」「选中的提交失效要不要回落」是业务规则，
 * 不是渲染细节；写在组件里就只能靠肉眼，而这个环境又没法真机看 UI。
 */
import type { Task, TaskChangeScope, TaskRepoChanges } from "@/lib/types";

/** 读不到 git 内容的两种「目录本身有问题」的原因：不是 git 仓库 / 目录没了（chat 里用户选的目录随时可能被删） */
const NOT_A_REPO: ReadonlySet<string> = new Set(["not_git", "dir_missing"]);

/**
 * 能不能为这个任务发改动请求：
 * - task：工作区已启动（workCwd 有值）且绑了仓；
 * - chat：选了工作目录（repoPaths[0]）。chat 没选目录时服务端也会挡（否则会兜底到 Flowship 自己的目录），
 *   这里先挡掉省一次请求。
 */
export const canLoadChanges = (task: Pick<Task, "workCwd" | "repoPaths">): boolean =>
  !!task.workCwd && task.repoPaths.length > 0;

/**
 * 入口 chip 要不要挂：
 * - 没有任何仓信息 → 不挂；
 * - chat 且所有仓都不是 git / 目录不存在 → 不挂（挂一个只会说「不是 git 仓库」的按钮没有意义）；
 * - task 里不是 git 的仓照挂（面板里会逐仓说明原因，多仓时别的仓还有内容）。
 */
export const shouldShowChangesEntry = (
  repos: readonly TaskRepoChanges[],
  chat: boolean,
): boolean => {
  if (repos.length === 0) return false;
  if (chat && repos.every((r) => r.unavailable !== undefined && NOT_A_REPO.has(r.unavailable))) {
    return false;
  }
  return true;
};

/**
 * 「单个提交」范围下选中的提交已经不在当前分支上（切了分支 / 提交被改写）→ 该自动切回「整条分支」吗？
 * - 所有仓都报 scope_invalid 才回落：多仓里只有一个仓失效时其它仓仍有内容，留在原范围，失效仓里面板自己提示；
 * - 响应还没跟上当前查询（stale）时不判断——那份 data 是上一个范围的，拿它判会误回落。
 */
export const shouldFallBackToBranch = (
  scope: TaskChangeScope,
  repos: readonly TaskRepoChanges[] | null,
  stale: boolean,
): boolean =>
  !stale &&
  scope.kind === "commit" &&
  !!repos &&
  repos.length > 0 &&
  repos.every((r) => r.unavailable === "scope_invalid");
