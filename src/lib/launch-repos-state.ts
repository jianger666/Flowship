/**
 * 启动表单「目标仓库」区的三态口径（第二轮 review V11-04）
 *
 * 背景：task-launch-form 在 `await initSettings()` 之后无条件 `getSettings()` 预填。init 失败
 * （服务没就绪 / 网络抖动 / config.json 不可读）时拿到的是**默认值**（repos = []），于是表单对用户说反话
 * 「还没配置仓库——去设置页添加」，而且永不重试——用户明明配过仓库。
 *
 * 现在把「设置读取到哪一步了」独立成一个阶段，仓库区只认它 + 仓库数：
 *   - loading：init 在途 → 占位（不先闪一下「还没配置仓库」）
 *   - failed ：init 没读到真实配置 → 「设置读取失败 + 重试」（默认值里的 repos = [] 不是用户的配置）
 *   - ready  ：读到了 → 有仓库画选择器；**确认读到真实配置且为空**才说「还没配置仓库」
 *
 * 判据复用 local-store 的 `isSettingsLoaded()`（设置页同款，见 settings-load-state.ts），不另造一套。
 * 纯逻辑（不依赖 React / DOM / fetch），便于在 node 环境单测。
 */

/** 启动表单读取设置的阶段 */
export type LaunchSettingsPhase = "loading" | "ready" | "failed";

/** init 结束后的阶段：只有读到磁盘上的真实配置才算 ready（`loaded` = local-store 的 isSettingsLoaded()） */
export const launchSettingsPhase = (loaded: boolean): "ready" | "failed" =>
  loaded === true ? "ready" : "failed";

/** 「目标仓库」区该画什么 */
export type LaunchReposView = "loading" | "failed" | "picker" | "empty";

export const resolveLaunchReposView = (input: {
  phase: LaunchSettingsPhase;
  repoCount: number;
}): LaunchReposView => {
  if (input.phase === "loading") return "loading";
  if (input.phase === "failed") return "failed";
  return input.repoCount > 0 ? "picker" : "empty";
};

export interface LaunchSettingsFailureText {
  /** 失败提示（说清读取失败 + 怎么办；不说「还没配置」） */
  message: string;
  /** 是否再给一个「去设置页查看」入口（config.json 不可读时：重试不一定能好，设置页有修复指引） */
  showSettingsLink: boolean;
}

/** @param unreadable local-store 的 getSettingsUnreadable() 是否非空（config.json 本身读不了） */
export const describeLaunchSettingsFailure = (
  unreadable: boolean,
): LaunchSettingsFailureText =>
  unreadable
    ? {
        message:
          "配置文件 config.json 无法读取，暂时看不到你配置过的仓库。修好文件后点「重试」，修复方法见设置页。",
        showSettingsLink: true,
      }
    : {
        message:
          "设置读取失败，暂时看不到你配置过的仓库（本机服务可能还没就绪）。点「重试」再读一次。",
        showSettingsLink: false,
      };

/**
 * 要不要在启动表单里让服务端对仓库做 `git fetch --prune`（第三轮 D2a-01）。
 * 分支候选的唯一消费者是 QA 的「被测业务分支」框（日常任务隐藏）；其它角色挂 refresh 等于每选一个仓
 * 就在服务端联网 fetch 一次（≤20s、并发无上限，还会改用户原仓的远端跟踪引用）——不需要就别发。
 */
export const needsRemoteBranchRefresh = (input: {
  isDailyLaunch: boolean;
  userRole: string | null | undefined;
  repoCount: number;
}): boolean =>
  !input.isDailyLaunch && input.userRole === "qa" && input.repoCount > 0;

/**
 * 所选仓里「git 认它是仓库、但目录下没有 .git」的路径（monorepo 子目录）：
 * 任务快照判它非 git → 不创建隔离工作区、不建分支（第三轮 D2a-03）。表单用来在仓库下方给一行 warning。
 */
export const notGitRootRepoPaths = (
  paths: readonly string[],
  branchMap: Readonly<
    Record<string, { isRepo: boolean; notRoot?: boolean } | undefined>
  >,
): string[] =>
  paths.filter((p) => {
    const b = branchMap[p];
    return b?.isRepo === true && b.notRoot === true;
  });
