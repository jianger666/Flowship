/**
 * 收件箱轮询器（N9-3）：把 use-mr-inbox 里「tick / 回前台补拉 / 上次发起时刻」三处接线抽成不依赖 React 的小对象。
 *
 * 为什么抽：这三处原先直接写在 hook 的 effect 里，项目没有 jsdom / testing-library，只能靠源码文本契约，
 * 而文本契约拦不住「删掉 `lastFetchAt` 赋值（托盘退化成每 5 分钟扫）/ tick 判定整体反转 / tick 不调 refresh /
 * 回前台补拉阈值或条件改坏」这类改动。不是 hook 不能测，是环境访问（可见性、是否壳内、时钟、定时器、可见性事件）
 * 没有注入——这里全部从外面注入，vitest 的 fake timers 就能做行为测试，不需要 jsdom。
 *
 * 职责边界：
 * - 「这一拍要不要扫」的判定仍是纯函数 `shouldPollInboxNow`（mr-inbox-state.ts）；本对象只负责在对的时机调它；
 * - 「在飞合并 / 尾随 force」仍由 hook 的 refresh（runCoalescedInboxRefresh）负责，本对象只管**发起**；
 * - `lastFetchAt` 记的是「请求发起时刻」（由扫描函数开头调 `noteFetchStarted()`），不是完成时刻——
 *   与服务端缓存 TTL 的口径配套（见 mr-inbox.ts 的 MR_INBOX_CACHE_TTL_MS 注释）。
 */
import { MR_INBOX_POLL_INTERVAL_MS } from "@/lib/mr-inbox";
import { shouldPollInboxNow } from "@/lib/mr-inbox-state";

export interface InboxPollerEnv {
  /** 窗口当前是否可见（`document.visibilityState === "visible"`） */
  isVisible: () => boolean;
  /** 是否在 Electron 壳内（`window.__shell` 存在） */
  isInShell: () => boolean;
  now: () => number;
  setIntervalFn: (fn: () => void, ms: number) => unknown;
  clearIntervalFn: (id: unknown) => void;
  /** 订阅「可见性变化」事件；返回取消订阅 */
  subscribeVisibility: (fn: () => void) => () => void;
}

export interface InboxPoller {
  /** 扫描函数开头调用：记「请求发起时刻」（回前台补拉 / 托盘隔拍扫都靠它判断数据多旧） */
  noteFetchStarted: () => void;
  /**
   * 启动即拉一次 + 每 MR_INBOX_POLL_INTERVAL_MS 一拍 + 回前台补拉；返回停止函数。
   * `refresh` 每次 start 现传（hook 里的 refresh 身份可能随依赖变），`lastFetchAt` 留在对象里、跨 start / stop 不丢。
   */
  start: (refresh: () => void) => () => void;
}

export const createInboxPoller = (env: InboxPollerEnv): InboxPoller => {
  let lastFetchAt = 0;

  return {
    noteFetchStarted: () => {
      lastFetchAt = env.now();
    },
    start: (refresh) => {
      refresh();
      // 要不要扫（可见 / 壳内不可见放宽 / 标签页不可见不扫）全在纯函数 shouldPollInboxNow 里（N1-03）
      const tick = () => {
        if (
          !shouldPollInboxNow({
            visible: env.isVisible(),
            inShell: env.isInShell(),
            sinceLastFetchMs: env.now() - lastFetchAt,
          })
        ) {
          return;
        }
        refresh();
      };
      // 回前台补拉：只在「变成可见」且数据已超过一拍时补；切走（变成不可见）那一下不能扫
      const onVisibilityChange = () => {
        if (!env.isVisible()) return;
        if (env.now() - lastFetchAt >= MR_INBOX_POLL_INTERVAL_MS) refresh();
      };
      const intervalId = env.setIntervalFn(tick, MR_INBOX_POLL_INTERVAL_MS);
      const unsubscribe = env.subscribeVisibility(onVisibilityChange);
      return () => {
        env.clearIntervalFn(intervalId);
        unsubscribe();
      };
    },
  };
};

/**
 * 浏览器 / Electron 渲染进程里的真实环境：`document` / `window` / 定时器都在**调用时**才取
 * （`useState(createDomInboxPoller)` 的初始化器在 SSR 阶段也会跑，创建对象时不能碰 `document`）；
 * 测试用 `vi.stubGlobal("document" | "window", …)` + fake timers 就能驱动这一层。
 */
export const createDomInboxPoller = (): InboxPoller =>
  createInboxPoller({
    isVisible: () => document.visibilityState === "visible",
    isInShell: () => window.__shell !== undefined,
    now: () => Date.now(),
    setIntervalFn: (fn, ms) => setInterval(fn, ms),
    clearIntervalFn: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    subscribeVisibility: (fn) => {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
  });
