/**
 * 事件流「流 B」第二轮 review 的接线契约（2026-10-20）：V17-02 / V13-04 / V16-03
 *
 * UI 行为在 node 环境跑不起来（见 vitest.config.ts），靠源码契约防「被删 / 被改回去」；
 * 能抽成纯函数的部分（排序 / 状态文案 / 运行态判定）都另有行为测试：
 *   - V1-01 / V2-01：tests/stream-pending.test.ts
 *   - V16-01 / V16-02：tests/chat-turns.test.ts
 *   - V16-03 判定函数：tests/chat-pending-display.test.ts
 * 契约只能防回退，证明不了渲染正确——窄栏观感要肉眼看。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...segments: string[]): string =>
  readFileSync(path.join(srcDir, ...segments), "utf-8");

const eventStream = read("components", "tasks", "event-stream.tsx");
const composer = read("components", "conversation-composer.tsx");

/** 从 `marker` 起按圆括号配对截出完整片段（取 marker 之后第一个 `(` 起算） */
const sliceCall = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  expect(start, `源码里找不到 \`${marker}\``).toBeGreaterThanOrEqual(0);
  const from = source.indexOf("(", start);
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`括号没配平：${marker}`);
};

describe("V17-02：Virtuoso 重挂（列表清空后又有条目）后事件流一律落在最后一条", () => {
  // 空态占位把 Virtuoso 卸掉，之后再有条目是重新挂载：initialTopMostItemIndex 只在 mount 时读一次。
  // 位置由控制器接手（评审 K1），initialPositionedRef 只是「渲染期 latch 落过没有」的闸。
  // （2026-11-05 去掉「群问答」页签：原先页签往返那条重挂路径、[showQaPanel] effect 与 `!showQaPanel` 守卫一并删除。）
  it("没有任何「群问答」页签残留：不再有 showQaPanel / showGroupQa / GroupQaPanel", () => {
    expect(eventStream).not.toContain("showQaPanel");
    expect(eventStream).not.toContain("showGroupQa");
    expect(eventStream).not.toContain("GroupQaPanel");
  });

  it("渲染期 latch 还在：定位闸没落过且有条目时落在最后一条并恢复跟随", () => {
    // 评审 K1：latch 里多了 beginSettle（开启定位稳定期）；Virtuoso 的初始项改成「最后一项、底部对齐」常量
    // Virtuoso 在树上的条件就是 `items.length > 0`（行为见 tests/event-stream-remount-landing.test.ts）
    expect(eventStream).toMatch(
      /if \(!initialPositionedRef\.current && items\.length > 0\) \{\s*follow\.setFollowing\(true\);[\s\S]*?follow\.beginSettle\(\);\s*initialPositionedRef\.current = true;/,
    );
  });

  it("列表清空（空态占位卸掉 Virtuoso）开闸：[listEmpty] effect 只在变空时复位闸与 range 缓存（评审 R8-3 同类路径）", () => {
    const emptyEffect = sliceCall(
      eventStream,
      "useEffect(() => {\n    if (!listEmpty) return;",
    );
    expect(eventStream).toContain("const listEmpty = items.length === 0;");
    expect(emptyEffect).toContain("initialPositionedRef.current = false;");
    expect(emptyEffect).toContain("lastRangeStartRef.current = null;");
    expect(eventStream).toContain("}, [listEmpty]);");
    // Virtuoso 在树上的条件与 latch 守卫是一回事：JSX 是「空态 → Virtuoso」二选一
    expect(eventStream).toMatch(/\{items\.length === 0 \? \(/);
    // 评审 K1 根治：Virtuoso 不再传 initialTopMostItemIndex，落底由控制器接手（稳定期内挂上容器即起贴底链）
    expect(eventStream).not.toMatch(/initialTopMostItemIndex=\{/);
  });
});

describe("V13-04：窄栏下 Cmd+F 搜索框不被 leading 挤成几个字宽", () => {
  // log 形态标题栏：leading（「事件流」标题）是 flex-1，搜索激活后又有 flex-1 的 Input，
  // 两者平分剩余宽度——307px 的事件流栏里 Input 只剩约 71px。搜索一激活标题没有用处 → 让位。
  const logBar = (() => {
    const start = eventStream.indexOf("{!isChat && (\n        <EventStreamSearchBar");
    expect(start).toBeGreaterThanOrEqual(0);
    return eventStream.slice(start, eventStream.indexOf("{!isChat && renderSearchScopeNotice", start));
  })();

  it("log 标题栏的 leading 在搜索激活态不渲染", () => {
    expect(logBar).toMatch(/leading=\{\s*searchActive\s*\?\s*null\s*:/);
  });

  it("非激活态仍渲染「事件流」标题；标题栏里不再有「群问答」页签（2026-11-05 去掉）", () => {
    expect(logBar).toContain("事件流");
    expect(logBar).not.toContain("群问答");
    expect(logBar).not.toContain("groupQaScope");
  });

  it("与产物面板共用的 EventStreamSearchBar 组件本身不动：让位逻辑只在 event-stream 的调用处", () => {
    const bar = read("components", "tasks", "event-stream-search-bar.tsx");
    expect(bar).toMatch(/\{leading\}/);
    expect(bar).not.toMatch(/searchActive/);
  });
});

describe("V16-03：主 AI 空闲但后台子代理还在跑时，输入框要有可达的停止键", () => {
  // 第三轮 R3-02：后台子代理不再并进 composerRunning（那会带出整套运行态：转圈 / 「排队发送」/ 附件消失），
  // 改走单独的 composerStopOnly → ConversationComposer 的 stopOnly（只多一个停止键）；决策的行为测试见
  // tests/chat-pending-display.test.ts（shouldShowComposerStopOnly）与 tests/composer-submit-state.test.ts
  it("composerStopOnly 把后台子代理数传给 shouldShowComposerStopOnly，composerRunning 不再带它", () => {
    const stopOnlyCall = sliceCall(eventStream, "const composerStopOnly = shouldShowComposerStopOnly(");
    expect(stopOnlyCall).toMatch(/backgroundSubagentCount: backgroundSubagents\?\.length \?\? 0,/);
    expect(stopOnlyCall).toMatch(/isRunning,/);
    expect(stopOnlyCall).toMatch(/submitting: !!submitting,/);
    expect(stopOnlyCall).toMatch(/awaitingAsk,/);
    const runningCall = sliceCall(eventStream, "const composerRunning = shouldShowComposerRunning(");
    expect(runningCall).not.toMatch(/backgroundSubagentCount/);
    // 原有三项不能丢
    expect(runningCall).toMatch(/isRunning,/);
    expect(runningCall).toMatch(/submitting: !!submitting,/);
    expect(runningCall).toMatch(/awaitingAsk,/);
  });

  it("停止键 tooltip 写「停止（含 N 个后台子代理）」：按钮如实说明会连带取消（停止 = 整会话 cancelAll）", () => {
    expect(eventStream).toMatch(/stopLabel=\{/);
    expect(eventStream).toContain("停止（含 ${backgroundSubagents.length} 个后台子代理）");
  });

  it("ConversationComposer 接受可选 stopLabel、默认仍是「停止生成（中断 agent）」", () => {
    expect(composer).toMatch(/stopLabel\?: string;/);
    expect(composer).toMatch(/<Tooltip content=\{stopLabel \?\? "停止生成（中断 agent）"\}>/);
  });
});
