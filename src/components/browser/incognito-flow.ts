/**
 * 用户侧「新建无痕标签页」的执行流程（纯逻辑，依赖全部注入，可在 node 里测）
 *
 * 入口在面板「更多」菜单（AI 侧早有 `browser_tabs new incognito:true`，用户这头此前没有入口）。三条要点：
 * - 老壳没有 `newIncognitoTab` → 不画入口（{@link canOpenIncognitoTab}）。**绝不退化成 `newTab`**：那会悄悄开出一个持久标签，
 *   用户以为是无痕、登录态却写进了持久档案。
 * - 主进程的 `browser:newIncognitoTab` 永不 reject、失败带中文 error；但 IPC 本身也可能抛（不可信发送者 / 壳异常），
 *   这里一律落到 onError，不向上抛——调用方是点击处理器，抛出去就是未处理的 rejection。
 * - 新标签页的出现由主进程的状态推送带来（会话不存在时也会因此出现），这里只回答「成没成」。
 */
import type { BrowserBridge, NewIncognitoTabResult } from "@/lib/browser-bridge-types";

/** 桥上有 `newIncognitoTab` 才画入口（老壳 / 网页版 / SSR 都没有） */
export const canOpenIncognitoTab = (bridge: Pick<BrowserBridge, "newIncognitoTab"> | null | undefined): boolean =>
  typeof bridge?.newIncognitoTab === "function";

export interface IncognitoTabDeps {
  /** 真正去开（主进程 `newIncognitoTab`）；没有桥时返回 undefined */
  open: () => Promise<NewIncognitoTabResult> | undefined;
  onError: (message: string) => void;
}

export const OPEN_INCOGNITO_FALLBACK_ERROR = "无法新建无痕标签页";

/** @returns 是否成功开出了无痕标签页（失败已通过 onError 告知） */
export const runOpenIncognitoTab = async (deps: IncognitoTabDeps): Promise<boolean> => {
  try {
    const res = await deps.open();
    if (res && typeof res === "object" && res.ok === true) return true;
    const error = res && typeof res === "object" && res.ok === false && typeof res.error === "string" ? res.error.trim() : "";
    deps.onError(error || OPEN_INCOGNITO_FALLBACK_ERROR);
  } catch (err) {
    deps.onError(`${OPEN_INCOGNITO_FALLBACK_ERROR}：${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
};
