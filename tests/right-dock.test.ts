/**
 * 右侧侧栏「只有一条位」：占位模块（lib/right-dock）+ 三个侧栏的接线契约
 *
 * 没有 jsdom：React hook 本身（useSyncExternalStore + 两个 effect）跑不起来，所以分两层——
 *   1. 纯逻辑：用 hook 完全相同的协议（开着 → claim；订阅回调里 shouldYield(me, open, getOwner()) → 让位）
 *      在测试里搭一个「侧栏」小模型，验证后开的替换先开的、让位不会误清别人的位、自己刚开不会被自己关掉。
 *      这证明的是协议正确，不证明 React 渲染时序（effect 先后顺序靠下面的源码契约锁住）。
 *   2. 源码契约：三个侧栏都接了 useRightDockSlot、让位走各自的原关闭路径；hook 里两个 effect 的先后顺序没被调换。
 *
 * 真机行为（滑出 / 滑入动画是否衔接、内置浏览器截图盖层是否闪、脏草稿确认被取消后两栏叠着的样子）要肉眼过。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetRightDockForTest,
  claimRightDock,
  getRightDockOwner,
  releaseRightDock,
  shouldYieldRightDock,
  subscribeRightDock,
  type RightDockId,
} from "@/lib/right-dock";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

beforeEach(() => {
  __resetRightDockForTest();
});

describe("占位 store", () => {
  it("初始没人占；claim 后 owner 是自己；release 后清空", () => {
    expect(getRightDockOwner()).toBeNull();
    claimRightDock("changes");
    expect(getRightDockOwner()).toBe("changes");
    releaseRightDock("changes");
    expect(getRightDockOwner()).toBeNull();
  });

  it("后 claim 的顶掉先 claim 的", () => {
    claimRightDock("file-preview");
    claimRightDock("changes");
    expect(getRightDockOwner()).toBe("changes");
  });

  it("release 只在位子还是自己的时候才清：被顶掉的一方关自己时，不能把新占位人清掉", () => {
    claimRightDock("file-preview");
    claimRightDock("subagent-detail");
    releaseRightDock("file-preview");
    expect(getRightDockOwner()).toBe("subagent-detail");
  });

  it("重复 claim 同一个 id 不重复通知（避免无意义的重渲染）", () => {
    let n = 0;
    subscribeRightDock(() => {
      n += 1;
    });
    claimRightDock("changes");
    claimRightDock("changes");
    expect(n).toBe(1);
    // 没占位时 release 也不通知
    releaseRightDock("file-preview");
    expect(n).toBe(1);
  });

  it("订阅返回的取消函数有效", () => {
    let n = 0;
    const off = subscribeRightDock(() => {
      n += 1;
    });
    claimRightDock("changes");
    off();
    claimRightDock("file-preview");
    expect(n).toBe(1);
  });
});

describe("shouldYieldRightDock（该不该让位）", () => {
  it.each<[string, boolean, RightDockId | null, boolean]>([
    ["自己开着、别人占位 → 让", true, "changes", true],
    ["自己开着、没人占位 → 不让", true, null, false],
    ["自己开着、占位的就是自己 → 不让", true, "file-preview", false],
    ["自己没开（已关）、别人占位 → 不用让", false, "changes", false],
    ["自己没开、没人占位 → 不用让", false, null, false],
  ])("%s", (_name, open, current, expected) => {
    expect(shouldYieldRightDock("file-preview", open, current)).toBe(expected);
  });
});

/**
 * hook 协议的小模型：与 use-right-dock-slot 做的事一一对应——
 *   open() = 打开：先 claim（占位 effect），再按「此刻」的 owner 判断要不要让位（让位 effect，只在订阅回调里触发）。
 *   别人 claim → emit → 订阅回调里按「此刻」owner 判断，该让就调 close。
 */
const makePanel = (me: RightDockId, opts: { refuseClose?: boolean } = {}) => {
  const panel = {
    me,
    isOpen: false,
    closeCalls: 0,
    open() {
      panel.isOpen = true;
      claimRightDock(me);
    },
    close() {
      if (!panel.isOpen) return;
      panel.isOpen = false;
      releaseRightDock(me);
    },
  };
  subscribeRightDock(() => {
    if (shouldYieldRightDock(me, panel.isOpen, getRightDockOwner())) {
      panel.closeCalls += 1;
      // 模拟「脏草稿确认被用户取消」：让位调用了，但没关成
      if (!opts.refuseClose) panel.close();
    }
  });
  return panel;
};

describe("三个侧栏的交互（协议模型）", () => {
  it("后开的替换先开的：预览开着时开改动面板 → 预览让位；再开子代理抽屉 → 改动面板让位", () => {
    const preview = makePanel("file-preview");
    const changes = makePanel("changes");
    const sub = makePanel("subagent-detail");

    preview.open();
    expect([preview.isOpen, changes.isOpen, sub.isOpen]).toEqual([true, false, false]);

    changes.open();
    expect([preview.isOpen, changes.isOpen, sub.isOpen]).toEqual([false, true, false]);
    expect(getRightDockOwner()).toBe("changes");

    sub.open();
    expect([preview.isOpen, changes.isOpen, sub.isOpen]).toEqual([false, false, true]);
    expect(getRightDockOwner()).toBe("subagent-detail");
  });

  it("自己刚打开不会被自己关掉（只有别人占位才触发让位）", () => {
    const preview = makePanel("file-preview");
    preview.open();
    expect(preview.isOpen).toBe(true);
    expect(preview.closeCalls).toBe(0);
  });

  it("让位的一方关自己时不会清掉新占位人；新占位人关掉后位子才空出来", () => {
    const preview = makePanel("file-preview");
    const changes = makePanel("changes");
    preview.open();
    changes.open();
    expect(getRightDockOwner()).toBe("changes");
    changes.close();
    expect(getRightDockOwner()).toBeNull();
  });

  it("同一个侧栏开着时换内容（open 状态不变）不触发任何让位或重复占位", () => {
    const preview = makePanel("file-preview");
    const changes = makePanel("changes");
    preview.open();
    // 连点不同文件链接：open 本来就是 true，hook 的 effect 依赖不变，不会重新 claim；这里用「不额外 claim」表示
    expect(getRightDockOwner()).toBe("file-preview");
    expect(changes.closeCalls).toBe(0);
    expect(preview.closeCalls).toBe(0);
  });

  it("让位被拒（脏草稿确认被取消）：只调用一次，不会死循环反复关；两栏暂时都开着", () => {
    const preview = makePanel("file-preview", { refuseClose: true });
    const changes = makePanel("changes");
    preview.open();
    changes.open();
    expect(preview.closeCalls).toBe(1);
    expect(preview.isOpen).toBe(true);
    expect(changes.isOpen).toBe(true);
    // 新占位人关掉后，被拒的一方不会再被要求让位（位子空了）
    changes.close();
    expect(preview.closeCalls).toBe(1);
  });
});

describe("hook 与三处接线（源码契约）", () => {
  const hook = read("src/hooks/use-right-dock-slot.ts");

  it("hook：占位 effect 在让位 effect 之前，且让位读『此刻』的占位人而不是渲染时的 owner", () => {
    const claimAt = hook.indexOf("claimRightDock(me)");
    const yieldAt = hook.indexOf("shouldYieldRightDock(me, open, getRightDockOwner())");
    expect(claimAt).toBeGreaterThan(-1);
    expect(yieldAt).toBeGreaterThan(claimAt);
    // 不能把渲染时 owner 直接喂给 shouldYield（自己刚打开那一帧 owner 还是上一个人，会把自己关掉）
    expect(hook).not.toMatch(/shouldYieldRightDock\(me, open, owner\)/);
    // 订阅是 useSyncExternalStore，且有服务端快照
    expect(hook).toMatch(/useSyncExternalStore\(subscribeRightDock, getRightDockOwner, \(\) => null\)/);
    // 关掉 / 卸载时还位
    expect(hook).toContain("return () => releaseRightDock(me);");
  });

  it("文件预览：占位 id 与让位回调（requestClose：脏草稿仍会先确认）", () => {
    const src = read("src/components/ui/local-file-preview.tsx");
    expect(src).toContain('useRightDockSlot("file-preview", open, requestClose)');
  });

  it("代码改动面板：占位 id 与让位回调（走原关闭路径 handleOpenChange(false)）", () => {
    const src = read("src/components/tasks/task-changes-panel.tsx");
    expect(src).toContain('useRightDockSlot("changes", open, () => handleOpenChange(false))');
    // 必须在组件早退（return null）之前调用，否则违反 Hooks 规则
    const hookAt = src.indexOf('useRightDockSlot("changes"');
    expect(hookAt).toBeGreaterThan(-1);
    expect(src.indexOf("return null;", hookAt)).toBeGreaterThan(hookAt);
  });

  it("子代理详情抽屉：占位 id 用 visible（真正显示时才占位）、让位走 setOpen(false)", () => {
    const src = read("src/components/tasks/subagent-detail.tsx");
    expect(src).toContain('useRightDockSlot("subagent-detail", visible, () => setOpen(false))');
  });

  it("RightDockId 与实际使用的 id 一一对应（新增侧栏忘了登记会在类型检查就挂，这里再锁一下集合）", () => {
    const lib = read("src/lib/right-dock.ts");
    expect(lib).toContain('export type RightDockId = "file-preview" | "changes" | "subagent-detail";');
  });
});
