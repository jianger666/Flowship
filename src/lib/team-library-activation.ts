/**
 * 「共享市场」打开时的加载顺序（R14 B6-2 · Q13-05）。
 *
 * 旧顺序：先 `await POST /api/team-library/sync`（git 拉取，断网 / 断 VPN 时最长 120 秒）再读列表——
 * 这段时间页面既没有列表也没有转圈，还会闪出「共享库暂无可安装 action」的错误空态。
 * 新顺序：先读本地缓存把列表秒出来；再在后台同步，同步成功才再读一次；同步失败静默（缓存照常能用）。
 *
 * 抽成纯异步函数是因为 hook 里的 effect 在服务端渲染探针里不会执行，不抽就没法单独测这个顺序。
 */
export type TeamLibraryActivationDeps = {
  /** 读完缓存后是否做一次后台同步（共享市场 = true；Skills 卡只读 = false） */
  autoSync: boolean;
  /** 读本地缓存里的状态与列表（GET /api/team-library）；自己处理错误，不抛 */
  refresh: () => Promise<void>;
  /** 后台 git 同步（POST /api/team-library/sync）；返回是否成功，抛错一律按失败处理 */
  sync: () => Promise<boolean>;
  /** 页面已卸载 / 被切走：之后不再发起新的读取 */
  isCancelled: () => boolean;
};

export const runTeamLibraryActivation = async (
  deps: TeamLibraryActivationDeps,
): Promise<void> => {
  await deps.refresh();
  if (!deps.autoSync || deps.isCancelled()) return;
  let synced = false;
  try {
    synced = await deps.sync();
  } catch {
    // 同步失败（断网 / 没配 token / 被取消）：静默，已经显示的缓存列表照常可用
    return;
  }
  // 同步没成功 = 没有新数据，不必再读；成功才再读一次把新内容换上去
  if (!synced || deps.isCancelled()) return;
  await deps.refresh();
};
