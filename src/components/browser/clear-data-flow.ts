/**
 * 「清除浏览器登录数据」的确认 → 执行流程（纯逻辑，依赖全部注入，可在 node 里测）
 *
 * 为什么抽出来：面板菜单与设置页（`settings/browser-card.tsx`）都有这个入口。
 * 设置页以前自己做了一套「点一次变『确认清除』、5 秒内再点才真清」的两步确认——
 * ui-conventions 规定不可逆操作一律走 `useDialog().confirm({ destructive: true })`（R2-14 ⑤），
 * 两处还要保持同一份文案 / 同一个顺序（先确认、取消绝不碰数据），所以把它收成一个函数两处共用。
 */

/** 与 `useDialog().confirm` 的 ConfirmOptions 子集同形；这里不 import hook，保持无 React 依赖 */
export interface ClearDataConfirmOptions {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: true;
}

export const CLEAR_BROWSING_DATA_CONFIRM: ClearDataConfirmOptions = {
  title: "清除浏览器登录数据？",
  // 「已打开的网页会重新加载」是这次修复带来的行为：不停下页面的话，页面里的内存 token 会把登录态写回；要让用户在点之前就知道
  description:
    "会清掉内置浏览器里所有网站的登录状态（cookies 与本地存储）。所有任务共用同一份，清除后需要重新登录。已打开的网页会重新加载，未保存的内容会丢失；无痕标签页不受影响。",
  confirmLabel: "清除",
  destructive: true,
};

export type ClearDataOutcome = "cancelled" | "cleared" | "failed";

/**
 * 从主进程的返回值里取「重新加载了几个标签」。老壳返回 undefined、返回值形状不对都当 0：
 * 渲染侧只拿它决定提示文案，不能因为它的形状让「清除成功」变成报错。
 */
export const reloadedTabsOf = (result: unknown): number => {
  const n = (result as { reloadedTabs?: unknown } | null | undefined)?.reloadedTabs;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
};

/** 清除成功后的 toast：有页面被重新加载就说一声（否则用户会奇怪页面为什么自己刷新了） */
export const clearSuccessMessage = (result: unknown): string => {
  const n = reloadedTabsOf(result);
  return n > 0 ? `已清除浏览器登录数据，已重新加载 ${n} 个标签页` : "已清除浏览器登录数据";
};

export interface ClearDataDeps {
  /** 弹确认框；resolve true = 用户确认 */
  confirm: (opts: ClearDataConfirmOptions) => Promise<boolean>;
  /** 真正清除（主进程 `clearBrowsingData`） */
  clear: () => Promise<unknown> | undefined;
  /** 清除成功；入参是 `clear` 的返回值（主进程给的 `{ reloadedTabs }`，老壳 / 无桥是 undefined），交给 {@link clearSuccessMessage} 出文案 */
  onSuccess: (result: unknown) => void;
  onError: (message: string) => void;
}

/**
 * 先确认、确认了才清；取消 = 一次 `clear` 都不调。
 * `clear` 同步抛错 / 异步 reject 都落到 onError（不向上抛——调用方是点击处理器，抛出去就是未处理的 rejection）。
 */
export const runClearBrowsingData = async (deps: ClearDataDeps): Promise<ClearDataOutcome> => {
  const ok = await deps.confirm(CLEAR_BROWSING_DATA_CONFIRM);
  if (!ok) return "cancelled";
  try {
    const result = await deps.clear();
    deps.onSuccess(result);
    return "cleared";
  } catch (err) {
    deps.onError(err instanceof Error ? err.message : String(err));
    return "failed";
  }
};
