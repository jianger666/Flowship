/**
 * 事件流滚动手感的源码契约闸（2026-07-28）
 *
 * 用户实测「AI 流式吐字时去滚动会抖动、自动折叠也感觉怪」。排查下来是四条互相
 * 叠加的路径，修法各自都很容易在后续改动里被无声还原（改回一个数字、加一个
 * useMemo 依赖就够），而 UI 行为在 node 环境跑不起来（见 vitest.config.ts）——
 * 所以跟 event-stream-run-active.test.ts 一样，靠源码契约守住。
 *
 * 判定逻辑本身的测试在 tests/scroll-follow.test.ts。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");

const read = (...segments: string[]): string =>
  readFileSync(path.join(srcDir, ...segments), "utf-8");

const eventStream = read("components", "tasks", "event-stream.tsx");
const workGroup = read("components", "tasks", "event-stream", "work-group.tsx");
const followHook = read("hooks", "use-stream-follow.ts");

/** 剥掉注释再查代码本身（注释里要解释「为什么不用 X」，不该因此误报） */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * 从 `marker` 处起按配对符号截出完整片段（只检查某个 useMemo 的依赖数组 /
 * 某个 JSX prop 的表达式，而不是「整份文件里有没有出现过这个词」）。
 */
const sliceBalanced = (
  source: string,
  marker: string,
  open: "(" | "{",
): string => {
  const close = open === "(" ? ")" : "}";
  const start = source.indexOf(marker);
  expect(start, `源码里找不到 \`${marker}\``).toBeGreaterThanOrEqual(0);
  const from = source.indexOf(open, start + marker.length - 1);
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`\`${marker}\` 的 ${open}${close} 没配平`);
};

describe("贴底跟随：用户上滚意图 > 几何阈值", () => {
  it("不再用大阈值兼职「防流式增高误判」（120px 会把用户的小幅上滚一起吞掉）", () => {
    expect(eventStream).not.toContain("atBottomThreshold={120}");
  });

  it("Virtuoso 的底部带永远不算「在底部」——带宽给任何正数，它自己的「内容增高就贴底」都会把往回滚的人拽回去", () => {
    // 48（= 恢复跟随的判定线）和 4（它的默认值）都实测弹回过：
    // 滚轮上滚 30px 后 49ms 就被它 scrollTo 回底部，而此刻我们的跟随态明明是 false
    expect(eventStream).toContain("atBottomThreshold={VIRTUOSO_NEVER_AT_BOTTOM}");
    expect(eventStream).not.toContain("atBottomThreshold={FOLLOW_PIN_THRESHOLD}");
  });

  it("调试 / 实验开关不许带进产品代码", () => {
    expect(eventStream).not.toContain("TEMP-EXPERIMENT");
    expect(eventStream).not.toContain("TEMP-DEBUG");
    expect(eventStream).not.toContain("__EXP");
    // Virtuoso 的 logLevel 会把每次 props 更新 / 每次滚动都打到控制台
    expect(eventStream).not.toContain("logLevel=");
  });

  it("滚动容器必须挂给跟随控制器——漏了手势检测整个静默失效、又退回「一滚就被拽回底」", () => {
    expect(eventStream).toContain("scrollerRef={attachScrollerRef}");
    const attachScroller = sliceBalanced(
      eventStream,
      "const attachScrollerRef = useCallback",
      "(",
    );
    expect(attachScroller).toContain("follow.attachScroller(el)");
  });

  it("跟随判定收口在控制器，组件里不再自己维护 atBottom state", () => {
    // atBottomStateChange 里 setState = 贴底态一翻转就重渲整条事件流
    // （只查 JSX prop 形式，注释里可以提这段历史）
    expect(eventStream).not.toContain("atBottomStateChange={");
    expect(eventStream).not.toContain("setAtBottomState");
    // 悬浮条改成自己订阅跟随态、只重渲那一颗
    expect(eventStream).toContain("useIsFollowing(follow)");
  });
});

describe("自动滚只有一套：统一 auto、不留 smooth", () => {
  it("不给 Virtuoso 传 followOutput——它在条数变化时自己 scrollToIndex，启动的重试链没法取消、用户上滚后还把人拉回底部", () => {
    // 实测：流式第一个 chunk 让条数 +1 就触发它，链一直活到用户滚轮之后。
    // 只查 JSX prop 形式（注释里要解释为什么不传）
    expect(eventStream).not.toContain("followOutput=");
  });

  it("条数 / 总高变化后的贴底走控制器：跟随 effect + totalListHeightChanged，都只发「请贴底」的请求", () => {
    expect(eventStream).toContain("totalListHeightChanged={onTotalHeightChanged}");
    const handler = sliceBalanced(
      eventStream,
      "const onTotalHeightChanged = useCallback",
      "(",
    );
    // 只在跟随态发请求；真正写不写 scrollTop 由控制器按跟随态 + 距底判定
    expect(handler).toContain("follow.isFollowing()");
    expect(handler).toContain("follow.requestScrollToBottom()");
    expect(handler).not.toContain("scrollToIndex");
    expect(handler).not.toContain("scrollTop");
  });

  it("跟随 effect 是条数 / 流式文本 / 运行态变化后贴底的入口：三个依赖缺一不可，且只在跟随态发请求", () => {
    // 允许格式化差异（空白 / 换行），不允许少依赖、少闸门
    expect(eventStream).toMatch(
      /useEffect\(\(\) => \{\s*if \(!follow\.isFollowing\(\)\) return;\s*follow\.requestScrollToBottom\(\);\s*\}, \[follow, items, streamingText, isRunning\]\);/,
    );
  });

  it("贴底动作只有 scrollToBottom 一个出口、且走控制器的 rAF 合批", () => {
    // 「滚到末项」的 scrollToIndex 调用全流程只该有一处（scrollToBottom 里）
    const lastScrolls =
      eventStream.match(/scrollToIndex\(\{[^}]*"LAST"/g) ?? [];
    expect(lastScrolls).toHaveLength(1);
    expect(eventStream).toContain("follow.requestScrollToBottom()");
  });
});

describe("贴底不走 Virtuoso 的 scrollToIndex（它的重试链内容一直在长就不会结束、也没法取消）", () => {
  it("控制器自己写 scrollTop、代码里不出现 scrollToIndex", () => {
    // 每次 scrollToIndex 都会盯列表 150ms、期间列表又变就重滚一遍再盯——流式时每 80ms 变一次，
    // 链永不结束；用户上滚后我们早不再发起贴底，链还在每 ~100ms 把人拉回底部（实测）
    const code = stripComments(followHook);
    expect(code).not.toContain("scrollToIndex");
    expect(code).toContain("scroller.scrollTop = scroller.scrollHeight");
  });

  it("贴底帧的第一件事是看跟随态——用户一上滚、这条链当场作废", () => {
    const schedulePin = sliceBalanced(
      followHook,
      "const schedulePin = (progress: { stable: number; budget: number }) => {",
      "{",
    );
    const body = schedulePin.slice(schedulePin.indexOf("requestAnimationFrame"));
    expect(body.indexOf("if (!following) return;")).toBeGreaterThan(0);
    // 必须排在任何写 scrollTop / 调贴底动作之前
    expect(body.indexOf("if (!following) return;")).toBeLessThan(
      body.indexOf("scroller.scrollTop ="),
    );
    expect(body.indexOf("if (!following) return;")).toBeLessThan(
      body.indexOf("scrollToBottomRef.current()"),
    );
  });

  it("跟随态翻成 false 时取消已排队的帧", () => {
    const setFollowing = sliceBalanced(
      followHook,
      "const setFollowing = (next: boolean) => {",
      "{",
    );
    expect(setFollowing).toContain("cancelPin()");
  });

  it("组件里 scrollToIndex 只剩「跳到某一项」的用途（搜索命中 / 提问锚点 / 回到本轮开头）+ 一个兜底贴底", () => {
    // 兜底那一处是 "LAST"；其余都带具体 index（idx），语义是用户主动跳转
    const all = eventStream.match(/scrollToIndex\(\{/g) ?? [];
    const last = eventStream.match(/scrollToIndex\(\{[^}]*"LAST"/g) ?? [];
    expect(last).toHaveLength(1);
    expect(all.length - last.length).toBe(3);
  });
});

describe("回到最新按钮", () => {
  it("点击 = 恢复跟随 + 复用控制器的贴底出口（自己再滚一次就把「两套自动滚」请回来了）", () => {
    const backToBottom = sliceBalanced(
      eventStream,
      "const backToBottom = useCallback",
      "(",
    );
    // 只滚不开闸 → 下一个 chunk 又把人甩回历史位置；开闸不滚 → 得等下一条事件才动
    expect(backToBottom).toContain("follow.setFollowing(true)");
    expect(backToBottom).toContain("follow.requestScrollToBottom()");
    expect(backToBottom).not.toContain("scrollToIndex");
  });

  it("跟琥珀色 ask 悬浮条错位摆放——两条的显示条件都含「非贴底」、必定同时出现", () => {
    // 琥珀条居中悬在上一排（bottom-14）；回底按钮在右下角（bottom-3 right-3），纵向错开
    expect(eventStream).toContain("absolute bottom-3 right-3");
    expect(eventStream).toContain("absolute bottom-14 left-1/2");
    expect(eventStream).not.toContain("absolute bottom-3 left-1/2");
  });

  it("「N 条新内容」走 scroll-follow 的纯函数、别在组件里另拼一套算法", () => {
    expect(eventStream).toContain("nextNewItemsBaseline(");
    expect(eventStream).toContain("countNewItems(");
  });

  it("计数按工作过程组的成员摊开——退回 items.length 会在长 action 里常驻 0", () => {
    // 一个 build action 的几十个工具块是连续过程项、被收进同一个工作过程组，
    // items.length 全程不动；而那恰恰是「用户翻在历史里想知道错过了啥」的主场景
    expect(eventStream).toContain("countStreamContentUnits");
    expect(eventStream).toMatch(
      /countStreamContentUnits[\s\S]*__work_group__[\s\S]*members\.length/,
    );
    const contentCount = sliceBalanced(
      eventStream,
      "const contentCount = useMemo",
      "(",
    );
    // 挂 orderedItems 不挂 items：虚拟项跟着 chunk 变、没必要每秒重算几十次
    expect(contentCount).toContain("orderedItems");
    expect(eventStream).toContain("contentCount={contentCount}");
  });
});

describe("粘性状态行：liveToolOutputs 每个 delta 都是新引用、别拖着全量事件重扫", () => {
  it("deriveActiveStatus 吃的是本轮切片、不是 task.events 全量", () => {
    const activeStatus = sliceBalanced(
      eventStream,
      "const activeStatus = useMemo",
      "(",
    );
    // 挂回 task.events → shell 直播时每秒几十次 O(几千条) 的 doneCallIds 白扫
    expect(activeStatus).toContain("statusEvents");
    expect(activeStatus).not.toContain("task.events");
    // 切片本身只跟事件走（liveToolOutputs 进了它的依赖就白切了）
    const statusEvents = sliceBalanced(
      eventStream,
      "const statusEvents = useMemo",
      "(",
    );
    expect(statusEvents).not.toContain("liveToolOutputs");
  });
});

describe("渲染管线分层：流式 chunk 不许重跑事件管线", () => {
  it("buildStreamItems 只挂真实事件、依赖里不能有 streamingText", () => {
    const baseItems = sliceBalanced(eventStream, "const baseItems = useMemo", "(");
    expect(baseItems).toContain("buildStreamItems(task.events");
    // 挂上 streamingText → 每个 chunk 重跑一遍管线、产出的 ToolBlock /
    // WorkGroupItem 全是新身份 → memo(ToolBlockRow) / memo(WorkGroupRow) 集体失效
    expect(baseItems).not.toContain("streamingText");
  });

  it("虚拟项那层（跟着 chunk 变的那层）不许再调 buildStreamItems", () => {
    const items = sliceBalanced(eventStream, "const items: RenderItem[] = useMemo", "(");
    expect(items).toContain("streamingText");
    expect(items).toContain("insertBeforeTrailingCompaction");
    expect(items).not.toContain("buildStreamItems");
  });
});

describe("工作过程组自动折叠有防打扰闸", () => {
  it("收起判定要看用户是不是在翻历史（走 shouldPinWorkGroupOpen）", () => {
    expect(workGroup).toContain("useStreamFollowContext");
    expect(workGroup).toContain("shouldPinWorkGroupOpen");
  });
});
