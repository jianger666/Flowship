/**
 * 事件流搜索与「跟随最新」的配合（R14 B6-3 / Q2-02）：src/lib/stream-search-follow.ts + event-stream.tsx 接线。
 *
 * 旧行为：搜索框一有字（query 非空）就永久关掉跟随，关闭搜索也不恢复；只输入、没有命中，视口明明没动也被关了。
 * 新行为：只有「命中把视口带走」才停跟随（pauseForHit）；Esc / × 关闭搜索时，搜索前在跟随的缓动回最新（resumeOnClose）；
 * 搜索前本来就在翻历史的不动。
 *
 * 三层：
 *  ① 闸本身 × 假控制器：每个分支、调用顺序（先读「在不在跟随」、再停）；
 *  ② 闸 × 真控制器（createStreamFollowController，不挂滚动容器）：证明闸能和真实的跟随状态机接上，
 *     而不只是和一个我们自己写的假对象对得上；
 *  ③ 源码接线契约：旧的「query 非空就停跟随」effect 没了、pauseForHit 排在会滚动的调用之前、
 *     两个搜索栏的 onClose 都走 handleSearchClose、切任务只 reset 不滑动。
 *
 * ⚠ 没有在真实浏览器里验证 Virtuoso + 流式输出 + 程序化滚动的实际手感；①② 测的是决策，③ 测的是接线。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createStreamFollowController,
  type StreamFollowController,
} from "@/hooks/use-stream-follow";
import {
  createSearchFollowGate,
  type SearchFollowCtl,
} from "@/lib/stream-search-follow";

/** 假控制器：记下每次调用，状态与真的一样会变（setFollowing 改跟随态，回到最新会开闸） */
const makeFake = (initialFollowing: boolean) => {
  const state = { following: initialFollowing, calls: [] as string[] };
  const ctl: SearchFollowCtl = {
    isFollowing: () => {
      state.calls.push("isFollowing");
      return state.following;
    },
    setFollowing: (next) => {
      state.calls.push(`setFollowing(${next})`);
      state.following = next;
    },
    scrollToBottomSmooth: () => {
      state.calls.push("scrollToBottomSmooth");
      state.following = true;
    },
  };
  /** 去掉只读调用，只留「动了跟随态 / 发起滑动」的动作 */
  const actions = () => state.calls.filter((c) => c !== "isFollowing");
  const slides = () => state.calls.filter((c) => c === "scrollToBottomSmooth").length;
  return { ctl, state, actions, slides };
};

describe("闸 × 假控制器", () => {
  it("跟随中命中：先停跟随；关闭搜索时缓动回最新并恢复", () => {
    const f = makeFake(true);
    const gate = createSearchFollowGate(f.ctl);
    gate.pauseForHit();
    expect(f.state.following).toBe(false);
    expect(f.actions()).toEqual(["setFollowing(false)"]);
    gate.resumeOnClose();
    expect(f.actions()).toEqual(["setFollowing(false)", "scrollToBottomSmooth"]);
    expect(f.state.following).toBe(true);
  });

  it("搜索前就在翻历史：命中不记号，关闭搜索不动他", () => {
    const f = makeFake(false);
    const gate = createSearchFollowGate(f.ctl);
    gate.pauseForHit();
    gate.resumeOnClose();
    expect(f.slides()).toBe(0);
    expect(f.state.following).toBe(false);
  });

  it("从没命中过（只输入 / 无命中）：关闭搜索什么都不做，也没碰过跟随态", () => {
    const f = makeFake(true);
    const gate = createSearchFollowGate(f.ctl);
    gate.resumeOnClose();
    expect(f.state.calls).toEqual([]);
    expect(f.state.following).toBe(true);
  });

  it("pauseForHit 先读「在不在跟随」、再停——顺序反了就永远读到 false、记不下号", () => {
    const f = makeFake(true);
    createSearchFollowGate(f.ctl).pauseForHit();
    expect(f.state.calls).toEqual(["isFollowing", "setFollowing(false)"]);
  });

  it("pauseForHit 幂等：命中来回切换（第二次起已不在跟随）不会把记号清掉，关闭时只滑一次", () => {
    const f = makeFake(true);
    const gate = createSearchFollowGate(f.ctl);
    gate.pauseForHit();
    gate.pauseForHit();
    gate.pauseForHit();
    gate.resumeOnClose();
    expect(f.slides()).toBe(1);
    expect(f.state.following).toBe(true);
  });

  it("记号用完即清：连续关闭只滑一次", () => {
    const f = makeFake(true);
    const gate = createSearchFollowGate(f.ctl);
    gate.pauseForHit();
    gate.resumeOnClose();
    gate.resumeOnClose();
    expect(f.slides()).toBe(1);
  });

  it("关闭后再开新一轮搜索：重新记号、再次关闭又会滑", () => {
    const f = makeFake(true);
    const gate = createSearchFollowGate(f.ctl);
    gate.pauseForHit();
    gate.resumeOnClose(); // 滑回底部、跟随恢复
    expect(f.state.following).toBe(true);
    gate.pauseForHit();
    gate.resumeOnClose();
    expect(f.slides()).toBe(2);
  });

  it("搜索期间用户自己滚回了底部（跟随已恢复）：关闭时不再滑一次，并把记号清掉", () => {
    const f = makeFake(true);
    const gate = createSearchFollowGate(f.ctl);
    gate.pauseForHit();
    f.state.following = true; // 用户往下翻回贴底带、状态机恢复了跟随
    gate.resumeOnClose();
    expect(f.slides()).toBe(0);
    // 记号确实清了：用户随后又翻走，再关闭也不会替他滑回去
    f.state.following = false;
    gate.resumeOnClose();
    expect(f.slides()).toBe(0);
  });

  it("reset（切任务）丢掉记号：上一个任务的搜索不会在新任务里触发滑动", () => {
    const f = makeFake(true);
    const gate = createSearchFollowGate(f.ctl);
    gate.pauseForHit();
    gate.reset();
    gate.resumeOnClose();
    expect(f.slides()).toBe(0);
  });

  it("reset 只清记号、不碰跟随态", () => {
    const f = makeFake(true);
    const gate = createSearchFollowGate(f.ctl);
    gate.reset();
    expect(f.state.calls).toEqual([]);
    gate.pauseForHit();
    const before = f.state.calls.length;
    gate.reset();
    expect(f.state.calls.length).toBe(before);
    expect(f.state.following).toBe(false);
  });

  it("多个闸互不串号（每个事件流实例一个）", () => {
    const a = makeFake(true);
    const b = makeFake(true);
    const gateA = createSearchFollowGate(a.ctl);
    const gateB = createSearchFollowGate(b.ctl);
    gateA.pauseForHit();
    gateB.resumeOnClose();
    expect(b.state.calls).toEqual([]);
    gateA.resumeOnClose();
    expect(a.slides()).toBe(1);
  });
});

describe("闸 × 真控制器（不挂滚动容器）", () => {
  let rafCalls = 0;
  let ctrl: StreamFollowController;

  beforeEach(() => {
    rafCalls = 0;
    vi.stubGlobal("requestAnimationFrame", () => {
      rafCalls += 1;
      return rafCalls;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    ctrl = createStreamFollowController({ current: () => {} });
  });

  afterEach(() => {
    ctrl.dispose();
    vi.unstubAllGlobals();
  });

  it("跟随中：命中后控制器真的不再跟随；关闭搜索后回到跟随，并排了一次贴底", () => {
    const gate = createSearchFollowGate(ctrl);
    expect(ctrl.isFollowing()).toBe(true);
    gate.pauseForHit();
    expect(ctrl.isFollowing()).toBe(false);
    expect(rafCalls).toBe(0);
    gate.resumeOnClose();
    expect(ctrl.isFollowing()).toBe(true);
    expect(rafCalls).toBe(1);
  });

  it("搜索前在翻历史：关闭搜索后仍不跟随，也没有排过任何贴底帧", () => {
    ctrl.setFollowing(false);
    const gate = createSearchFollowGate(ctrl);
    gate.pauseForHit();
    gate.resumeOnClose();
    expect(ctrl.isFollowing()).toBe(false);
    expect(rafCalls).toBe(0);
  });

  it("没有命中：关闭搜索不改变跟随态、不排贴底", () => {
    const gate = createSearchFollowGate(ctrl);
    gate.resumeOnClose();
    expect(ctrl.isFollowing()).toBe(true);
    expect(rafCalls).toBe(0);
  });
});

describe("event-stream.tsx 接线契约", () => {
  const readSrc = (rel: string) =>
    readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");
  /** 剥掉注释再查代码本身（注释里要解释「为什么」，不该因此误报） */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const code = stripComments(readSrc("src/components/tasks/event-stream.tsx"));

  it("旧的「query 非空就停跟随」effect 没了（输入 / 无命中 / 输入法中间态不再关跟随）", () => {
    expect(code).not.toMatch(/if \(isSearchFiltering\) follow\.setFollowing\(false\)/);
    expect(code).not.toMatch(/follow\.setFollowing\(false\);\s*\}, \[follow, isSearchFiltering\]/);
  });

  it("闸随事件流实例建一次（useState 惰性初值，引用稳定），吃的是同一个 follow 控制器", () => {
    expect(code).toContain("useState(() => createSearchFollowGate(follow))");
    expect(code.match(/createSearchFollowGate\(/g)?.length).toBe(1);
  });

  it("pauseForHit 排在 revealMountedTarget 与 scrollToSearchHit 之前（后者经 jumpToItem 也会停跟随，之后就读不到原状态）", () => {
    const pause = code.indexOf("searchFollowGate.pauseForHit()");
    const mounted = code.indexOf("if (revealMountedTarget()) return;");
    const wake = code.indexOf("scrollToSearchHit(currentSearchOwnerId)");
    expect(pause).toBeGreaterThan(-1);
    expect(mounted).toBeGreaterThan(pause);
    expect(wake).toBeGreaterThan(mounted);
    expect(code.match(/searchFollowGate\.pauseForHit\(\)/g)?.length).toBe(1);
  });

  it("reveal effect 的依赖数组里有 searchFollowGate", () => {
    const m = /\}, \[\s*currentSearchOwnerOccurrenceIndex,[\s\S]*?\]\);/.exec(code);
    expect(m, "没找到 reveal effect 的依赖数组").not.toBeNull();
    expect(m![0]).toContain("searchFollowGate");
  });

  it("handleSearchClose = 关闭搜索 + resumeOnClose，两个搜索栏的 onClose 都绑它（旧的 closeStreamSearch 不再直接绑）", () => {
    const m =
      /const handleSearchClose = useCallback\(\(\) => \{([\s\S]*?)\}, \[([^\]]*)\]\);/.exec(
        code,
      );
    expect(m, "没找到 handleSearchClose").not.toBeNull();
    expect(m![1]).toContain("closeStreamSearch();");
    expect(m![1]).toContain("searchFollowGate.resumeOnClose();");
    expect(m![2]).toContain("closeStreamSearch");
    expect(m![2]).toContain("searchFollowGate");
    expect(code.match(/onClose=\{handleSearchClose\}/g)?.length).toBe(2);
    expect(code).not.toContain("onClose={closeStreamSearch}");
  });

  it("切任务：只清记号（reset），不走 handleSearchClose / resumeOnClose——切页不该触发滑动", () => {
    const m =
      /useEffect\(\(\) => \{\s*closeStreamSearch\(\);([\s\S]*?)\}, \[task\.id, closeStreamSearch, searchFollowGate\]\);/.exec(
        code,
      );
    expect(m, "没找到切任务的 effect").not.toBeNull();
    expect(m![1]).toContain("searchFollowGate.reset();");
    expect(m![1]).not.toContain("resumeOnClose");
    expect(m![1]).not.toContain("handleSearchClose");
  });

  it("closeStreamSearch 本身不碰跟随（它还被切任务复用）", () => {
    const m = /const closeStreamSearch = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\);/.exec(
      code,
    );
    expect(m, "没找到 closeStreamSearch").not.toBeNull();
    expect(m![1]).not.toContain("follow");
    expect(m![1]).not.toContain("searchFollowGate");
  });
});
