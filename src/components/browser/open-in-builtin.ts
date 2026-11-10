/**
 * 「默认用内置浏览器打开」的运行时绑定：把 `lib/builtin-open.ts` 的注入依赖接到真实的 window / 设置 / 面板桥 / toast。
 * 决策与流程本身（含全部回退条件）在 lib/builtin-open.ts，有单测；这里只做胶水，不含判断。
 */

import { toast } from "sonner";

import {
  normalizeLinkOpenMode,
  openHttpLink,
  openLocalHtml,
  type BuiltinOpenDeps,
  type BuiltinOpenEnv,
  type LinkOpenMode,
} from "@/lib/builtin-open";
import { getSettings } from "@/lib/local-store";
import { requestOpenLocalPath } from "@/lib/local-file-open";

import { getActiveBrowserTaskId, requestOpenInActiveBrowser } from "./browser-panel-bridge";

/** 点击时读设置（Providers 启动时已 initSettings；init 前是默认 = 内置，不会空窗） */
export const readLinkOpenMode = (): LinkOpenMode => normalizeLinkOpenMode(getSettings().linkOpenMode);

/** force：右键「在内置浏览器打开」——无视设置、也不按授权链接启发式回退（explicit） */
const readEnv = (force: boolean): BuiltinOpenEnv => {
  const bridge = typeof window === "undefined" ? undefined : window.__browser;
  return {
    mode: force ? "builtin" : readLinkOpenMode(),
    explicit: force,
    bridgeReady: typeof bridge?.newTab === "function",
    serveLocalHtmlReady: typeof bridge?.serveLocalHtml === "function",
    hasTask: getActiveBrowserTaskId() !== null,
    app: typeof window === "undefined" ? null : { hostname: window.location.hostname, port: window.location.port },
  };
};

const realDeps = (force: boolean): BuiltinOpenDeps => ({
  env: () => readEnv(force),
  openInBuiltin: (url) => requestOpenInActiveBrowser(url, { newTab: true }),
  serveLocalHtml: async (absPath) => {
    const serve = window.__browser?.serveLocalHtml;
    if (typeof serve !== "function") return { ok: false, error: "当前版本的内置浏览器不支持" };
    return serve.call(window.__browser, absPath);
  },
  openSystemPath: (absPath) => requestOpenLocalPath(absPath),
  notify: (kind, message) => (kind === "error" ? toast.error(message) : toast.info(message)),
});

/**
 * 点网页链接：返回 "builtin" = 已在内置浏览器新标签打开（调用方 preventDefault）；"system" = 走默认行为（`<a target=_blank>`）。
 * `forceBuiltin`：右键菜单「在内置浏览器打开」——无视「默认系统」的设置、也不按登录 / 授权链接启发式回退（显式意图优先），
 * 环境做不到（网页版 / 没有任务 / 站内地址…）时仍回退系统。
 */
export const openHttpInBuiltin = (url: string, opts: { forceBuiltin?: boolean } = {}): "builtin" | "system" =>
  openHttpLink(url, realDeps(opts.forceBuiltin === true));

/** 点本地 .html / .htm（无行号）。永远会打开点什么（内置不行回退系统默认应用）；系统打开失败会抛，调用方 toast */
export const openLocalHtmlInBuiltin = (absPath: string, opts: { forceBuiltin?: boolean } = {}): Promise<"builtin" | "system"> =>
  openLocalHtml(absPath, realDeps(opts.forceBuiltin === true));

/** 显式交给系统浏览器（右键「在系统浏览器打开」）：壳的 setWindowOpenHandler 把 http(s) 转给 shell.openExternal；站内地址壳会拒 */
export const openHttpInSystem = (url: string): void => {
  const open = window.__shell?.openExternal;
  if (typeof open === "function") open(url);
  else window.open(url, "_blank", "noopener,noreferrer");
};
