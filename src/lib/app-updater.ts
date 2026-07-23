/**
 * Electron 壳自动更新桥的共享类型（preload window.__appUpdater、见
 * electron-app/preload.cjs / main.js updateState）
 *
 * UpdateBadge（右上角徽标、状态机驱动）与 CheckUpdateButton（设置页）共用；
 * declare global 集中在这一处、避免多组件重复声明冲突。
 * web 版没壳、window.__appUpdater 恒 undefined。
 */

/** 手动「检查更新」返回 */
export type UpdateCheckResult = {
  status: "latest" | "available" | "error";
  current: string;
  latest?: string;
  message?: string;
};

/** 更新状态机快照（主进程唯一数据源、语义见 electron-app/main.js updateState） */
export type UpdateState = {
  phase: "idle" | "available" | "downloading" | "ready" | "installing";
  version: string | null;
  percent: number;
  error: string | null;
};

export type AppUpdaterBridge = {
  /** 按需查一次更新（设置页按钮） */
  check: () => Promise<UpdateCheckResult>;
  /** 安装更新（点徽标；主进程按状态分流并有互斥锁） */
  install: () => void;
  /** 拉全量状态（mount / 刷新时） */
  getState: () => Promise<UpdateState>;
  /** 订阅状态变化、返回取消订阅函数 */
  onState: (callback: (state: UpdateState) => void) => () => void;
};

declare global {
  interface Window {
    /** Electron 壳注入：自动更新桥（web 版无） */
    __appUpdater?: AppUpdaterBridge;
    /** Electron 壳注入：当前 app 版本号（设置页展示用） */
    __appVersion?: string;
  }
}
