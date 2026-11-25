/**
 * 「用户敲的网址成功打开了就记下来」的执行体（无 React / window，可在 node 里用假计时器测；React 薄壳见 use-typed-visit-recorder.ts）。
 * 判定本身在 typed-visit.ts，这里只管「待判定」这一个槽的生命周期：
 *
 * - `begin`：用户在地址栏提交了一个**网址**（不是搜索词）并且主进程接受了——登记「待判定」，同一时刻只留一个（后一次覆盖前一次），登记后立刻判一次
 *   （提交那一刻的状态可能已经是「打开了」，比如重敲当前页的地址，不能干等下一次推送）；
 * - `update`：标签状态变了（主进程每次状态推送）——复核一次：wait 继续等；drop 清掉；record 清掉并记；
 * - 有些「等」只会被时间解开（页面挂着个不返回的子资源：加载一直没结束、也不会再有状态推送）：等的时候到点自己复核一次；
 * - 记不上（服务端挂了 / 磁盘满了…）静默吞掉：这是个附带的记忆功能，不能因为它失败给用户弹提示；
 * - `dispose`：丢掉待判定并取消计时（面板卸载 / 换了 record 实现）。
 *
 * 只判断，不做导航：AI 的导航、页面里点链接、前进后退都不经过 `begin`，所以永远不会被记。
 */
import type { TabInfo } from "@/lib/browser-bridge-types";

import { decideTypedVisit, nextTypedVisitCheckAt, type PendingTypedVisit } from "./typed-visit";

/** 到点复核时多留的一点余量：setTimeout 偶尔会比预期早几毫秒触发，早了复核不出新结论还得再等一轮 */
export const RECHECK_SLACK_MS = 50;

export interface TypedVisitRecorderDeps {
  /** 记一次访问（history store 的 record） */
  record: (visit: { url: string; title: string }) => Promise<unknown>;
  /** 当前时间（epoch 毫秒）；测试注入 */
  now?: () => number;
  /** 定时器；测试注入。默认 setTimeout / clearTimeout */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface TypedVisitRecorder {
  begin: (pending: PendingTypedVisit) => void;
  update: (tabs: readonly TabInfo[]) => void;
  dispose: () => void;
}

export const createTypedVisitRecorder = (deps: TypedVisitRecorderDeps): TypedVisitRecorder => {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let pending: PendingTypedVisit | null = null;
  let tabs: readonly TabInfo[] = [];
  let timer: unknown = null;

  const clearTimer = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  };

  const evaluate = () => {
    clearTimer();
    if (!pending) return;
    const t = now();
    const verdict = decideTypedVisit(pending, tabs, t);
    if (verdict.action === "wait") {
      const at = nextTypedVisitCheckAt(pending, t);
      if (at !== null) {
        timer = schedule(() => {
          timer = null;
          evaluate();
        }, at - t + RECHECK_SLACK_MS);
      }
      return;
    }
    pending = null;
    if (verdict.action === "record") {
      // record 同步抛错（理论上不会，store.record 是 async）和异步 reject 都吞掉
      try {
        deps.record({ url: verdict.url, title: verdict.title }).catch(() => {});
      } catch {
        // 记不上就算了
      }
    }
  };

  return {
    begin: (p) => {
      pending = p;
      evaluate();
    },
    update: (next) => {
      tabs = next;
      evaluate();
    },
    dispose: () => {
      clearTimer();
      pending = null;
    },
  };
};
