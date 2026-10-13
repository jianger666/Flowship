/**
 * 思考吐字平滑 + 实时文本区的源码契约（2026-10-12 用户反馈「思考吐字很机械、上下重复」）
 *
 * 算法本身（位置怎么推进、切片怎么算）在纯函数层、有行为测试：
 *   tests/smooth-reveal.test.ts   匀速吐字 + 250ms 批量到达的模拟（速度是否匀 / 停顿 / 延迟，对比冻结的旧算法）
 *   tests/thinking-live.test.ts   累积 / 累计坐标 / revealLiveThinking 切片
 *
 * 这里只守 node 环境跑不起来的两处接线——它们改坏了既不会有类型错误、也不会让任何纯函数测试变红：
 *   1. use-smooth-thinking.ts：rAF 循环 + state，是把纯函数接到界面上的薄壳
 *   2. live-thinking-tail.tsx：固定高度、随书写连续上移、顶部渐隐的实时文本区
 *      （上移量的算法在 src/lib/live-tail-scroll.ts，行为测试见 tests/live-tail-scroll.test.ts）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");

const read = (...segments: string[]): string =>
  readFileSync(path.join(srcDir, ...segments), "utf-8");

const hook = read("components", "tasks", "use-smooth-thinking.ts");
const tail = read("components", "tasks", "event-stream", "live-thinking-tail.tsx");
const smoothStreaming = read("components", "tasks", "use-smooth-streaming.ts");

/** 去掉注释后的源码：断言「没有用某个 API」时不被解释它为什么不用的注释干扰 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** 取 `from` 与 `to` 两个标记之间的源码（含 from、不含 to） */
const between = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  expect(start, `源码里找不到 \`${from}\``).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `\`${from}\` 之后找不到 \`${to}\``).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("use-smooth-thinking：rAF 推进循环", () => {
  const tick = between(hook, "const tick = useCallback(", "// 每批新到达");

  it("算法不在 hook 里另写一套：位置推进走 createRevealer、渲染期切片走 revealLiveThinking（都有纯函数测试）", () => {
    expect(hook).toContain('import { createRevealer } from "@/lib/smooth-reveal";');
    expect(hook).toContain("revealLiveThinking(");
  });

  it("这一段的位置还没登记（新挂载 / 刚换段）时从下限 liveThinkingFloor 起步、不是 0：快照重建的实时态（切回对话 / SSE 重连）第一帧就是整段已有内容，不先空着再从头长一遍（2026-10-13）", () => {
    const render = hook.slice(hook.lastIndexOf("return useMemo("));
    expect(render).toContain(
      "revealed.id === live.id ? revealed.len : liveThinkingFloor(live)",
    );
    // 旧写法：起步 0——快照重建的实时态会先渲染成空、再从第一个字重新长
    expect(stripComments(hook)).not.toContain("revealed.len : 0");
  });

  it("位置推进走 stepLiveReveal，hook 里不另写一套（目标取累计总数 / 窗口截尾后位置跳到起点——行为由 thinking-reveal-integration.test.ts 逐条守住）", () => {
    expect(tick).toContain("stepLiveReveal(revealerRef.current, cur, now)");
    // 这些规则在纯函数里；hook 里再出现 = 又长出一套没有行为测试的实现
    expect(tick).not.toContain("text.length");
    expect(tick).not.toContain(".seek(");
    expect(tick).not.toContain(".advance(");
  });

  it("换段（id 变了）从头吐：先对齐段（归零推进器）再推进（否则新一段从上一段的位置接着走）", () => {
    const sync = between(
      hook,
      "const syncSegment = useCallback(",
      "const tick = useCallback(",
    );
    expect(sync).toContain("if (segmentRef.current === cur.id) return;");
    expect(sync).toContain("revealerRef.current.reset();");
    expect(sync).toContain("segmentRef.current = cur.id;");
    const syncAt = tick.indexOf("syncSegment(cur);");
    const stepAt = tick.indexOf("stepLiveReveal(");
    expect(syncAt).toBeGreaterThanOrEqual(0);
    expect(stepAt).toBeGreaterThan(syncAt);
  });

  it("没追平才排下一帧、追平就停（不空转 rAF）", () => {
    expect(tick).toContain(
      "if (!done) rafRef.current = requestAnimationFrame(tick);",
    );
  });

  it("位置（取整）没变就不触发渲染：低速时每三帧才出一个字，其余帧不该重渲染", () => {
    expect(tick).toContain(
      "prev.id === cur.id && prev.len === len ? prev : { id: cur.id, len }",
    );
  });

  it("没在思考：取消残留 rAF、重置位置与段标记；新一批到达时重新点火", () => {
    const effect = between(hook, "// 每批新到达", "// 回到前台");
    expect(effect).toContain("cancelAnimationFrame(rafRef.current)");
    expect(effect).toContain("revealerRef.current.reset();");
    expect(effect).toContain("segmentRef.current = null;");
    expect(effect).toContain(
      "if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick);",
    );
    // 依赖是 live：每批换了对象就要登记最新目标（写成 [] = 目标冻在第一批）
    expect(effect).toContain("[live, tick]");
  });

  it("卸载取消未决的 rAF（漏了 = 组件没了循环还在跑、还会 setState）", () => {
    const unmount = hook.slice(hook.indexOf("// 卸载"));
    expect(unmount).toContain("cancelAnimationFrame(rafRef.current)");
  });

  it("渲染期只从 state 派生、不读 ref（读 ref 不触发重渲染，会读到过期值）", () => {
    const render = hook.slice(hook.lastIndexOf("return useMemo("));
    expect(render).not.toMatch(/Ref\.current/);
  });
});

describe("use-smooth-thinking：回到前台时位置直接跳到最新（没在看的时候长出来的字不用演，2026-10-13）", () => {
  // 后台期间 rAF 暂停、SSE 照常到，回来时积压几百上千字：不跳的话推进器会当大积压，
  // 先一帧刷出一大块、再以几倍于正常的速度滚几秒。行为本身（不爆发、速率估计不被污染）
  // 由 thinking-snapshot.test.ts 的 skipLiveReveal / 前台模拟守住；这里守 hook 的接线
  const effect = between(hook, "// 回到前台", "// 卸载");

  it("监听 document 的 visibilitychange，卸载时摘掉同一个处理函数（漏摘 = 组件没了监听还在、还会 setState）", () => {
    expect(effect).toContain(
      'document.addEventListener("visibilitychange", onVisibilityChange);',
    );
    expect(effect).toContain(
      'document.removeEventListener("visibilitychange", onVisibilityChange)',
    );
  });

  it("只在页面可见时处理、没在思考时什么都不做（隐藏那一刻跳位置没有意义）", () => {
    expect(effect).toContain('if (document.visibilityState !== "visible") return;');
    expect(effect).toContain("if (!cur) return;");
  });

  it("位置走 skipLiveReveal、hook 里不另写 seek；先对齐段再跳（否则 seek 的位置被随后的 reset 抹掉）", () => {
    const syncAt = effect.indexOf("syncSegment(cur);");
    const skipAt = effect.indexOf("skipLiveReveal(revealerRef.current, cur)");
    expect(syncAt).toBeGreaterThanOrEqual(0);
    expect(skipAt).toBeGreaterThan(syncAt);
    expect(effect).not.toContain(".seek(");
  });

  it("跳完立刻同步到 state（否则渲染期还读着旧位置、要等下一个 rAF 才变）；位置没变不重渲染", () => {
    expect(effect).toContain("setRevealed((prev) =>");
    expect(effect).toContain(
      "prev.id === cur.id && prev.len === len ? prev : { id: cur.id, len }",
    );
  });
});

describe("LiveThinkingTail：固定高度、随书写连续上移、顶部渐隐", () => {
  it("固定上限高度的滚动窗口（全文随吐字变高，会把后面的行一路顶下去）", () => {
    expect(tail).toContain('"max-h-28 overflow-hidden"');
  });

  it("上移量走 liveTailOffset，组件里不另写一套（算法由 live-tail-scroll.test.ts 的行为测试守住）", () => {
    expect(tail).toContain(
      '} from "@/lib/live-tail-scroll";',
    );
    expect(tail).toContain("liveTailOffset(metrics, !reduceMotion)");
    expect(tail).toContain("isLiveTailOverflowing(metrics)");
  });

  it("不用浏览器的 smooth scroll：换行时 scrollTo 一次 = 一段 ease-in-out 脉冲、行间纹丝不动，这就是「加速又刹车又加速」（2026-10-12 实测 82% 的时间不动）", () => {
    const tailCode = stripComments(tail);
    expect(tailCode).not.toContain("scrollTo(");
    expect(tailCode).not.toContain('"smooth"');
    expect(tailCode).not.toContain("scrollTop");
  });

  it("用 transform 平移内容、不是 scrollTop（连续上移需要内容底部再多一行空白，空白会改窗口的布局高度）；吸附到设备像素免得文字发虚", () => {
    expect(tail).toContain("content.style.transform =");
    expect(tail).toContain("translateY(");
    expect(tail).toContain("window.devicePixelRatio");
  });

  it("每次文本变化都重新定位（逐帧）：layout effect 依赖 [text]，且声明在「建立定位函数」的 effect 之后（挂载时先建、再用）", () => {
    const setupAt = tail.indexOf("placeRef.current = place;");
    const perTextAt = tail.indexOf("placeRef.current();");
    expect(setupAt).toBeGreaterThanOrEqual(0);
    expect(perTextAt).toBeGreaterThan(setupAt);
    expect(tail).toMatch(/useLayoutEffect\(\(\) => \{\s*placeRef\.current\(\);\s*\}, \[text\]\);/);
  });

  it("盯的是内容、不是窗口本身：窗口高度被 max-h 钉死、永远不变；重排（窗口变窄 / 字号缩放）时文本没变也要重新定位", () => {
    expect(tail).toContain("ro.observe(content);");
    expect(tail).not.toContain("ro.observe(scroller)");
    const roBody = between(tail, "new ResizeObserver(() => {", "ro.observe(content);");
    expect(roBody).toContain("measure();");
    expect(roBody).toContain("place();");
  });

  it("layout effect 里先同步定位一次、再挂观察者：首次绘制前就在正确位置，不闪一帧「停在顶部」", () => {
    const placeAt = tail.indexOf("\n    place();\n");
    const observerAt = tail.indexOf("new ResizeObserver(");
    expect(placeAt).toBeGreaterThanOrEqual(0);
    expect(observerAt).toBeGreaterThan(placeAt);
    expect(tail).toContain("useLayoutEffect(");
  });

  it("卸载断开观察者、清掉定位函数", () => {
    expect(tail).toContain("ro.disconnect();");
    expect(tail).toContain("placeRef.current = () => {};");
  });

  it("偏好「减少动态效果」：只按整行阶跃、行内不动（连续上移也是一种动效）", () => {
    expect(tail).toContain("(prefers-reduced-motion: reduce)");
    expect(tail).toContain("liveTailOffset(metrics, !reduceMotion)");
  });

  it("只在溢出时顶部渐隐（刚开始想、内容不够一屏时第一行不能被淡化）", () => {
    expect(tail).toMatch(
      /overflowing &&\s*"\[mask-image:linear-gradient\(to_bottom,transparent,black_1\.5rem\)\]"/,
    );
  });

  it("末尾脉冲光标：定位靠它（ref）、纯装饰（aria-hidden）、「减少动态效果」时不脉冲", () => {
    expect(tail).toContain("ref={caretRef}");
    expect(tail).toContain("caret.offsetTop");
    expect(tail).toContain("caret.offsetLeft");
    expect(tail).toContain("aria-hidden");
    expect(tail).toContain("animate-pulse");
    expect(tail).toContain("motion-reduce:animate-none");
  });

  it("内容区 relative：光标的 offsetTop / offsetLeft 才是相对内容区的（否则相对更外层的定位祖先，上移量全错）", () => {
    expect(tail).toContain('"relative wrap-break-word');
  });

  it("排版与落盘后的思考行一致（text-xs / italic / muted）：落盘换成全文时不跳样式", () => {
    expect(tail).toContain(
      'wrap-break-word text-xs italic leading-relaxed text-muted-foreground"',
    );
  });

  it("不对实时文本做搜索高亮（逐帧变化的临时文本，落盘后全文才参与搜索）", () => {
    expect(tail).not.toContain("SearchHighlightText");
  });
});

describe("护栏：不碰用户明确称赞的正文吐字", () => {
  it("use-smooth-streaming 的步进公式没动，也没和思考共用算法（思考的平滑是另一套、按批间隔设计）", () => {
    expect(smoothStreaming).toContain(
      "const step = Math.max(2, Math.ceil(remaining * 0.12));",
    );
    expect(smoothStreaming).not.toMatch(/from\s+["'][^"']*smooth-reveal["']/);
    expect(hook).not.toMatch(/from\s+["'][^"']*use-smooth-streaming["']/);
  });
});
