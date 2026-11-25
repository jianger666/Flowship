/**
 * 设置页的两个 effect、滚到底高亮、点导航后的高亮锁定期、以及三个表单控件的 hook 调用顺序（S-6 / S-7 / S-8g / R20-12）。
 * 源码结构钉子 + 纯函数真值表 + 滚动跟随控制器（createScrollSpy）的假时钟行为用例：页面本身要 Electron / 浏览器里才能点
 * （重试加载后的滚动、深链、smooth scroll 的真实时长与高亮效果没法在这里验——没有 jsdom）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createScrollSpy, isScrolledToEnd, NAV_SCROLL_LOCK_MS } from "@/lib/settings-scroll-end";

import { stripComments } from "./helpers/source-text";

const read = (rel: string) => readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf8");
const page = read("src/app/settings/page.tsx");

/** 以 `useEffect(() => {` 开头、含 marker 的那个 effect 的完整文本（到 `}, [deps]);` 结束） */
const effectContaining = (marker: string): string => {
  const at = page.indexOf(marker);
  expect(at, `页面里找不到 ${marker}`).toBeGreaterThan(-1);
  const start = page.lastIndexOf("useEffect(() => {", at);
  const end = page.indexOf("]);", at) + 3;
  return page.slice(start, end);
};

describe("S-6 设置页：加载失败后「重试加载」成功，高亮与 ?focus= 深链要能生效", () => {
  it("?focus= 深链 effect：依赖里有 loadFailed，失败态下不去滚（卡片没渲染），重试成功后会再跑一次", () => {
    const eff = effectContaining('new URLSearchParams(window.location.search).get("focus")');
    expect(eff).toMatch(/\}, \[loaded, loadFailed, router, scrollToFocus\]\);$/);
    expect(eff).toMatch(/if \(loadFailed\) return;\s*const focus = /);
    // 重定向（storage / 能力页）在 loadFailed 判断之前，失败态下照常跳转
    expect(eff.indexOf('router.replace("/sessions")')).toBeLessThan(eff.indexOf("if (loadFailed) return;"));
  });

  it("滚动跟随高亮 effect：依赖里有 loadFailed，失败态下不建观察器；cleanup 里 disconnect（不会叠多个观察器）", () => {
    const eff = effectContaining("new IntersectionObserver(");
    expect(eff).toContain("if (!loaded || loadFailed) return;");
    // 依赖里多了 scrollSpy（R20-12）：它是 useRef 惰性创建的同一个对象，不会因它重建观察器
    expect(eff).toMatch(/\}, \[loaded, loadFailed, scrollSpy\]\);$/);
    expect(eff).toContain("observer.disconnect()");
  });

  it("卡片区确实受 !loadFailed 控制（这就是 effect 要依赖 loadFailed 的原因；这条断了说明前提变了、要重新评估）", () => {
    expect(page).toMatch(/\{!loadFailed && \(/);
  });
});

describe("S-8g 滚到底高亮最后一项（最后一张卡太短、进不了 -20% 0px -60% 0px 观察区间时）", () => {
  it("isScrolledToEnd 真值表：到底 / 差几个像素仍算到底 / 没到底 / 内容不够长不算", () => {
    expect(isScrolledToEnd({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
    expect(isScrolledToEnd({ scrollTop: 597, clientHeight: 400, scrollHeight: 1000 })).toBe(true); // 容差 4px
    expect(isScrolledToEnd({ scrollTop: 590, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
    expect(isScrolledToEnd({ scrollTop: 0, clientHeight: 800, scrollHeight: 800 })).toBe(false); // 没有滚动条
    expect(isScrolledToEnd({ scrollTop: 0, clientHeight: 800, scrollHeight: 500 })).toBe(false);
  });

  it("页面在 document 上以捕获阶段听 scroll（滚动容器是 AppShell 主区、scroll 不冒泡），只认包含最后一张卡的容器，卸载时摘掉；「到底」的判定与锁定期都交给 scrollSpy.scrolled", () => {
    const eff = effectContaining("new IntersectionObserver(");
    expect(eff).toContain('document.addEventListener("scroll", onScroll, true)');
    expect(eff).toContain('document.removeEventListener("scroll", onScroll, true)');
    expect(eff).toMatch(/box instanceof HTMLElement && lastCard && box\.contains\(lastCard\)\) scrollSpy\.scrolled\(box\)/);
    expect(page).toContain('import { createScrollSpy, type ScrollSpy } from "@/lib/settings-scroll-end"');
  });
});

describe("R20-12 点导航 / 深链之后的高亮锁定期（滚到底 / 观察器都不许把用户刚点的那项改写）", () => {
  /** 假时钟 + 记录每次 setActive 的控制器；lastFocus 对应真实页面里最后一项（仓库） */
  const mkSpy = () => {
    const clock = { t: 10_000 };
    const calls: string[] = [];
    const spy = createScrollSpy({ now: () => clock.t, setActive: (f) => calls.push(f) }, "repos");
    return { clock, calls, spy };
  };
  const atEnd = { scrollTop: 600, clientHeight: 400, scrollHeight: 1000 };
  const notAtEnd = { scrollTop: 100, clientHeight: 400, scrollHeight: 1000 };

  it("没点过导航：观察器照常更新、滚到底高亮最后一项、没到底不动", () => {
    const { calls, spy } = mkSpy();
    spy.observed("prefs");
    spy.scrolled(notAtEnd);
    spy.scrolled(atEnd);
    expect(calls).toEqual(["prefs", "repos"]);
  });

  it("点了「电脑操作」、它下面内容不足一屏（smooth scroll 一路滚到容器底）：锁定期内到底事件与观察器都不改写，高亮停在用户点的那项", () => {
    const { clock, calls, spy } = mkSpy();
    spy.navigate("computer-use");
    expect(calls).toEqual(["computer-use"]);
    // smooth scroll 途中：路过 / 到底
    clock.t += 200;
    spy.observed("browser");
    spy.scrolled(notAtEnd);
    clock.t += 300;
    spy.scrolled(atEnd); // 到底：此前会在这里被改写成「仓库」
    spy.observed("repos"); // 卡片比较矮时，进观察区间的是下一张卡
    clock.t += NAV_SCROLL_LOCK_MS - 500 - 1; // 锁定期的最后一毫秒之前
    spy.scrolled(atEnd);
    expect(calls).toEqual(["computer-use"]);
  });

  it("锁定期过后跟随恢复：用户自己再滚（到底 / 观察器）照常更新", () => {
    const { clock, calls, spy } = mkSpy();
    spy.navigate("computer-use");
    clock.t += NAV_SCROLL_LOCK_MS; // 恰好到点：不再锁
    spy.scrolled(atEnd);
    spy.observed("prefs");
    expect(calls).toEqual(["computer-use", "repos", "prefs"]);
  });

  it("再点一次从那一刻重新计锁定期；深链走同一个 navigate（页面里 scrollToFocus 唯一的高亮入口）", () => {
    const { clock, calls, spy } = mkSpy();
    spy.navigate("prefs");
    clock.t += NAV_SCROLL_LOCK_MS - 100;
    spy.navigate("browser"); // 第二次点击：锁定期顺延
    clock.t += NAV_SCROLL_LOCK_MS - 100;
    spy.scrolled(atEnd);
    expect(calls).toEqual(["prefs", "browser"]); // 第一次的锁定期早该过了，但第二次顺延着、仍锁
    clock.t += 100;
    spy.scrolled(atEnd);
    expect(calls).toEqual(["prefs", "browser", "repos"]);
  });

  it("页面里高亮只有 scrollSpy 一个入口：setActiveFocus 只出现在声明与交给 createScrollSpy 的那两处（以后谁绕过控制器直接 setActiveFocus 就红）", () => {
    const code = stripComments(page); // 注释里提到名字不算
    const uses = [...code.matchAll(/setActiveFocus/g)].length;
    // useState 解构一处 + createScrollSpy 的 setActive 一处
    expect(uses).toBe(2);
    expect(page).toContain("setActive: setActiveFocus");
    // 三个来源都过控制器
    expect(page).toContain("scrollSpy.navigate(focus);");
    expect(page).toContain("scrollSpy.observed(first.slice(5));");
    expect(page).toContain("scrollSpy.scrolled(box);");
  });
});

describe("S-7 hook 无条件调用：Switch / ChoiceButton / CheckboxRow 不再写 `|| useFormDisabled()` 短路", () => {
  const files = ["src/components/ui/switch.tsx", "src/components/ui/choice-button.tsx", "src/components/ui/checkbox-row.tsx"];

  for (const f of files) {
    it(`${path.basename(f)}：先无条件取 const formDisabled = useFormDisabled()，再 ||`, () => {
      // 去掉注释再查：注释里会解释「为什么不能写 `|| useFormDisabled()`」，那不算代码
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      // 任何把 useFormDisabled() 放在 || / && / ?? / 三元右侧的写法（短路会让 hook 调用顺序随 props 变化）
      expect(src).not.toMatch(/(\|\||&&|\?\?|\?|:)\s*useFormDisabled\(\)/);
      expect(src).toMatch(/const formDisabled = useFormDisabled\(\);/);
      expect(src).toMatch(/const locked = (Boolean\(disabled\)|disabled) \|\| formDisabled;/);
    });
  }
});
