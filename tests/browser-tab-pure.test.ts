/**
 * tab.mjs 里不依赖 electron 的纯部分单测（其余 BrowserTab 逻辑要真 WebContentsView，归 e2e）。
 */
import { describe, expect, it } from "vitest";

import { createRing } from "../electron-app/browser/tab.mjs";

describe("createRing：定长环形缓冲", () => {
  it("满了丢最旧并累计 dropped；list 返回副本", () => {
    const ring = createRing(3);
    for (let i = 1; i <= 5; i++) ring.push(i);
    expect(ring.list()).toEqual([3, 4, 5]);
    expect(ring.dropped).toBe(2);
    expect(ring.size()).toBe(3);
    const copy = ring.list();
    copy.push(99);
    expect(ring.list()).toEqual([3, 4, 5]); // 改副本不影响内部
  });

  it("clear 清空条目并把 dropped 归零", () => {
    const ring = createRing(2);
    ring.push("a");
    ring.push("b");
    ring.push("c");
    expect(ring.dropped).toBe(1);
    ring.clear();
    expect(ring.list()).toEqual([]);
    expect(ring.size()).toBe(0);
    expect(ring.dropped).toBe(0);
  });

  it("max=1 只留最新一条", () => {
    const ring = createRing(1);
    ring.push(1);
    ring.push(2);
    expect(ring.list()).toEqual([2]);
    expect(ring.dropped).toBe(1);
  });
});
