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
  description:
    "会清掉内置浏览器里所有网站的登录状态（cookies 与本地存储）。所有任务共用同一份，清除后需要重新登录。",
  confirmLabel: "清除",
  destructive: true,
};

export type ClearDataOutcome = "cancelled" | "cleared" | "failed";

export interface ClearDataDeps {
  /** 弹确认框；resolve true = 用户确认 */
  confirm: (opts: ClearDataConfirmOptions) => Promise<boolean>;
  /** 真正清除（主进程 `clearBrowsingData`） */
  clear: () => Promise<unknown> | undefined;
  onSuccess: () => void;
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
    await deps.clear();
    deps.onSuccess();
    return "cleared";
  } catch (err) {
    deps.onError(err instanceof Error ? err.message : String(err));
    return "failed";
  }
};
