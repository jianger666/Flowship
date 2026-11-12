/**
 * task 详情页头部的「浏览器紧凑态」规则（纯函数 + 可注入 storage，可在 node 里测；client / server 都能 import）
 *
 * 背景：头部（标题行 + 仓库 / 分支两排 + 测试链接 + 辅助入口 chip 行）高约 130px，浏览器标签激活时它和浏览器自己的
 * 「产物 | 浏览器」切换行、工具栏、标签栏、状态条叠在一起，窗口 800px 高时视口只剩一半。
 * 浏览器可见时头部收成标题行（标题 / 状态徽标 / 主操作 + 分栏按钮 + 「任务详情」展开钮），其余入口收进「任务详情」；
 * 例外：有预览位在跑（或正在启动）时，预览胶囊留在紧凑态里、会多出一行（想点它的端口进内置浏览器就是这时候）；
 * 用户想看时点一下就展开，这个选择记在本机（全局一个值，不分任务——想不想要头部详情跟屏幕高度有关、跟任务无关）。
 *
 * 只有「浏览器真的看得见」才紧凑：产物栏被折叠（事件流占满）时浏览器不可见，头部照常完整显示。
 */

export const TASK_HEADER_DETAILS_IN_BROWSER_KEY = "flowship.task-header-details-in-browser";

/**
 * 头部此刻是否处于紧凑态。
 * @param browserPaneOpen 浏览器标签激活且产物栏没有折叠（= 浏览器真的在屏幕上）
 * @param detailsOpen 用户是否点了「任务详情」展开（默认 false；只在浏览器可见时才有意义）
 */
export const isTaskHeaderCompact = (input: { browserPaneOpen: boolean; detailsOpen: boolean }): boolean =>
  input.browserPaneOpen && !input.detailsOpen;

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // 隐私模式 / 被禁用时访问 localStorage 本身会抛
    return null;
  }
};

/** 读「浏览器可见时头部详情是否展开」：只认精确的 "1"，其余（缺失 / 脏值 / storage 抛错）一律回到默认「收起」 */
export const readTaskHeaderDetailsOpen = (storage: StorageLike | null = defaultStorage()): boolean => {
  try {
    return storage?.getItem(TASK_HEADER_DETAILS_IN_BROWSER_KEY) === "1";
  } catch {
    return false;
  }
};

/** 写入展开态；存不下就算了（本次运行内由组件状态保证生效）。返回是否写成功 */
export const writeTaskHeaderDetailsOpen = (
  open: boolean,
  storage: StorageLike | null = defaultStorage(),
): boolean => {
  try {
    if (!storage) return false;
    storage.setItem(TASK_HEADER_DETAILS_IN_BROWSER_KEY, open ? "1" : "0");
    return true;
  } catch {
    return false;
  }
};
