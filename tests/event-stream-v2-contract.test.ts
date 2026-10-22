/**
 * 事件流 v2（2026-10-12）源码契约闸
 *
 * 用户拍板「整个时间流重构、按最佳实践来、包括交互和色系；task 和 chat 保持一致」。
 * 这次重构的每一条都是「肉眼一眼能看出来、但改坏了既没有类型错误、也没有任何行为测试变红」的
 * 视觉 / 交互约定：对比度、层级、状态色语义、动效收敛、键盘可达、task 与 chat 同一套外观。
 * UI 组件在 node 环境跑不起来（见 vitest.config.ts），只能走源码契约。
 *
 * 这个文件只守 v2 新立的约定；老契约（消息级 UI / ask 跳过 / 状态行接线 / 布局溢出）
 * 各自的测试文件仍然有效，其中 tests/event-stream-message-ui-contract.test.ts 的两条断言
 * 随「log 的 AI 回复并入 chat 共用分支」做过结构性改写，改动原因写在那两条 it 的注释里。
 *
 * 每个 describe 对应一类「回归了用户会立刻看出来」的问题；依据（含对比度实测数据）见 docs/HANDOFF.md「事件流 v2」。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const streamDir = path.join(srcDir, "components", "tasks", "event-stream");

const read = (...segments: string[]): string =>
  readFileSync(path.join(srcDir, ...segments), "utf-8");

const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/**
 * 去掉块注释 / 行注释：契约管的是「真正生效的类名 / 代码」，
 * 而注释里解释旧写法时会点名被禁的字串（比如「旧版 bg-background/75」）。
 * 行注释的 `//` 前不许是 `:` / 引号 / 反引号，避开 URL 与字符串里的 `//`。
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const readBare = (...segments: string[]): string =>
  stripComments(read(...segments));

/** 取 `from` 与 `to` 两个标记之间的源码（含 from、不含 to） */
const between = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  expect(start, `源码里找不到 \`${from}\``).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `\`${from}\` 之后找不到 \`${to}\``).toBeGreaterThan(start);
  return source.slice(start, end);
};

/** 从 marker（以 `{` 结尾）起按花括号配对截出完整块 */
const sliceBlock = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  expect(start, `源码里找不到 \`${marker}\``).toBeGreaterThanOrEqual(0);
  const from = start + marker.length - 1;
  expect(source[from]).toBe("{");
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`\`${marker}\` 的花括号没配平`);
};

const rows = readBare("components", "tasks", "event-stream", "rows.tsx");
const toolBlock = readBare(
  "components",
  "tasks",
  "event-stream",
  "tool-block.tsx",
);
const workGroup = readBare(
  "components",
  "tasks",
  "event-stream",
  "work-group.tsx",
);
const errorCard = readBare(
  "components",
  "tasks",
  "event-stream",
  "error-card.tsx",
);
const statusLine = readBare(
  "components",
  "tasks",
  "event-stream",
  "active-status-line.tsx",
);
const streamStyle = readBare(
  "components",
  "tasks",
  "event-stream",
  "stream-style.tsx",
);
const eventStream = readBare("components", "tasks", "event-stream.tsx");
const composer = readBare("components", "conversation-composer.tsx");
const globalsCss = readBare("app", "globals.css");

// `text-muted-foreground/70` 在浅色下 3.3:1、`/50` 2.2:1，都低于 WCAG AA 的 4.5:1；
// 「更弱」只能靠 11px 档 + 位置，alpha 只留给装饰（底衬 / 引导线 / 显隐动画）。
// 字号简写（text-sm/6 这类 line-height 写法）不在禁止范围
const TEXT_ALPHA = /\btext-(?!xs\b|sm\b|base\b|lg\b|xl\b)[a-z][a-z-]*\/\d+/;
// 20~99 的中间 opacity（opacity-0 / opacity-100 是 hover 显隐、允许；disabled: 等变体前缀也允许）
const MID_OPACITY = /(?<![\w:-])opacity-(?:[2-9]\d)\b/;
const RAW_PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/;

/** 事件流渲染层的全部源码文件（event-stream/ 目录 + 入口 event-stream.tsx） */
const streamSources: Array<[name: string, source: string]> = [
  ...readdirSync(streamDir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .sort()
    .map((f): [string, string] => [
      `event-stream/${f}`,
      stripComments(readFileSync(path.join(streamDir, f), "utf-8")),
    ]),
  ["event-stream.tsx", eventStream],
];

describe("共享样式单一来源：stream-style", () => {
  it("导出折叠箭头 / 过程行按钮 / 展开区引导线三件套", () => {
    expect(streamStyle).toContain("export const CollapseChevron");
    expect(streamStyle).toContain("export const PROCESS_ROW_BUTTON");
    expect(streamStyle).toContain("export const PROCESS_BODY_RAIL");
  });

  it("过程层三个文件都从 ./stream-style 取，没有各自再造一份 chevron", () => {
    for (const [name, src] of [
      ["rows.tsx", rows],
      ["tool-block.tsx", toolBlock],
      ["work-group.tsx", workGroup],
    ] as const) {
      expect(src, `${name} 没从 ./stream-style 取共享件`).toContain(
        'from "./stream-style"',
      );
      expect(src, `${name} 又自己定义了一份 CollapseChevron`).not.toMatch(
        /\b(?:const|function)\s+CollapseChevron\b/,
      );
    }
  });

  it("行按钮样式只有一份：工具行 / verb 组 / 组头 / 思考行都套 PROCESS_ROW_BUTTON", () => {
    // 每个文件各含一次 import，所以阈值 = 使用处数 + 1
    expect(countOf(rows, "PROCESS_ROW_BUTTON")).toBeGreaterThanOrEqual(3);
    expect(countOf(toolBlock, "PROCESS_ROW_BUTTON")).toBeGreaterThanOrEqual(4);
    expect(countOf(workGroup, "PROCESS_ROW_BUTTON")).toBeGreaterThanOrEqual(2);
  });

  it("展开箭头是纯装饰（aria-hidden）、reduced-motion 下不做旋转过渡、颜色不叠透明度", () => {
    const chevron = between(
      streamStyle,
      "export const CollapseChevron",
      "export const PROCESS_ROW_BUTTON",
    );
    expect(chevron).toContain("aria-hidden");
    expect(chevron).toContain("motion-reduce:transition-none");
    expect(chevron).toContain("text-muted-foreground");
    expect(chevron).not.toMatch(/opacity-\d/);
  });
});

describe("文字层级不靠透明度、颜色只用语义 token", () => {
  it("事件流渲染层没有任何文字叠 alpha（text-xxx/NN）", () => {
    for (const [name, src] of streamSources) {
      expect(src, `${name} 里有文字叠 alpha`).not.toMatch(TEXT_ALPHA);
    }
  });

  it("事件流 event-stream/ 目录里没有 20~99 的中间 opacity（整行压淡 = 文字对比度掉出 AA）", () => {
    for (const [name, src] of streamSources) {
      // 入口 event-stream.tsx 里 composer 禁用态的整块调暗是控件态、不是文字层级，不在此列
      if (name === "event-stream.tsx") continue;
      expect(src, `${name} 里有中间 opacity`).not.toMatch(MID_OPACITY);
    }
  });

  it("事件流渲染层没有硬编码调色板色（bg-blue-500 这类），全部走语义 token", () => {
    for (const [name, src] of streamSources) {
      expect(src, `${name} 里有硬编码调色板色`).not.toMatch(RAW_PALETTE);
    }
  });

  it("重连 / 压缩行翻篇后整行转中性灰，而不是给 warning 色文字再叠 opacity", () => {
    const reconnecting = between(
      rows,
      "export const ReconnectingRow",
      "ReconnectingRow.displayName",
    );
    expect(reconnecting).toContain('settled ? "text-muted-foreground" : "text-warning"');
  });
});

describe("动效收敛 + prefers-reduced-motion", () => {
  it("状态行：静态 info 色点 + 仅 label 一处 shimmer，不再内联 <style>、不再有脉冲点", () => {
    expect(statusLine).not.toContain("<style");
    expect(statusLine).not.toContain("animate-pulse");
    expect(statusLine).toContain("status-shimmer");
    expect(statusLine).toMatch(/size-1\.5 shrink-0 rounded-full bg-info/);
  });

  it("globals.css 持有 status-shimmer 的 keyframes 与类", () => {
    expect(globalsCss).toContain("@keyframes status-shimmer");
    expect(globalsCss).toMatch(/\.status-shimmer\s*\{[^}]*animation:\s*status-shimmer/);
  });

  it("「减少动态效果」下：脉冲停、shimmer 停并回纯色（否则停在渐变某一帧左浅右深）", () => {
    const reduced = sliceBlock(
      globalsCss,
      "@media (prefers-reduced-motion: reduce) {",
    );
    expect(reduced).toMatch(/\.animate-pulse\s*\{\s*animation:\s*none;?\s*\}/);
    expect(reduced).toMatch(/\.status-shimmer\s*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(/\.status-shimmer\s*\{[^}]*background-image:\s*none/);
  });

  it("running = info：输入栏 / 等待行 / 启动阶段行的 spinner 都是 text-info", () => {
    expect(composer).toContain("animate-spin text-info");
    // BootStageRow + PendingRow 两处
    expect(
      countOf(eventStream, 'Loader2 className="size-3.5 animate-spin text-info"'),
    ).toBeGreaterThanOrEqual(2);
  });

  it("工作过程组头的 spinner 只在折叠时转：展开后成员自己在转，同屏不叠第三处", () => {
    expect(workGroup).toMatch(/expanded\s*\?\s*null\s*:/);
  });
});

describe("task(log) 与 chat 对话外观统一", () => {
  const eventRow = between(
    rows,
    "const EventRowImpl",
    "export const EventRow = memo",
  );

  it("AI 回复 / 用户消息在 chat 与 log 共用同一段分支（log 只放对话类事件进来）", () => {
    expect(eventRow).toContain(
      'if (variant === "chat" || isAssistant || isUser)',
    );
    // 不许再有 log 专属的第二套 assistant / user 渲染：EventRow 里的 MarkdownText 只有两处，
    // 都在这段共用分支里——AI 回复正文（text={ev.text}）、飞书群机器人的用户气泡（text={displayText}，chat / log 同一处）
    expect(countOf(eventRow, "<MarkdownText")).toBe(2);
    expect(countOf(eventRow, "<MarkdownText\n          size={isLog")).toBe(1);
    expect(countOf(eventRow, "<MarkdownText text={displayText}")).toBe(1);
  });

  it("log 的 AI 回复只多一个可折叠的元信息头：aria-expanded + 共享行按钮 + 共享 chevron", () => {
    const logHeader = between(
      eventRow,
      "{isLog &&",
      "{showBody && !streaming && (",
    );
    expect(logHeader).toContain("aria-expanded={!collapsed}");
    expect(logHeader).toContain("PROCESS_ROW_BUTTON");
    expect(logHeader).toContain("<CollapseChevron");
    expect(logHeader).toContain("<ActionTag");
  });

  it("log 的用户消息：同一个气泡 + 气泡上方右对齐的元信息行（action 归属标 + 时间）", () => {
    expect(eventRow).toContain("if (!isLog) return bubble;");
    const metaRow = between(
      eventRow,
      "if (!isLog) return bubble;",
      'if (ev.kind === "ask_user_reply" && images.length > 0)',
    );
    expect(metaRow).toContain("justify-end");
    expect(metaRow).toContain("<ActionTag");
    expect(metaRow).toContain("{bubble}");
  });

  it("用户气泡：实心 secondary 面、不画边框（旧 bg-muted/40 对页面底只有 1.03:1，全靠 1px 边框撑）", () => {
    const bubbleClass =
      /const USER_REPLY_BUBBLE =\s*"([^"]+)"/.exec(rows)?.[1] ?? "";
    expect(bubbleClass, "找不到 USER_REPLY_BUBBLE 定义").not.toBe("");
    expect(bubbleClass).toContain("bg-secondary");
    expect(bubbleClass).not.toMatch(/\bborder/);
    expect(bubbleClass).not.toMatch(/bg-muted/);
    // 右对齐收窄 + 防长 URL 撑破的几何不能丢
    expect(bubbleClass).toContain("ml-auto w-fit max-w-[85%] min-w-0");
    // 占位气泡（inflight）与正式气泡同一个常量：占位 → 真气泡没有视觉跳变
    expect(countOf(rows, "USER_REPLY_BUBBLE")).toBeGreaterThanOrEqual(3);
  });

  it("排队中的气泡用「空心虚线框」表达未落定，不再整个气泡压 opacity", () => {
    const pending = between(
      rows,
      "export const PendingLocalReplyRow",
      "PendingLocalReplyRow.displayName",
    );
    expect(pending).toContain("border border-dashed border-border");
    expect(pending).not.toMatch(MID_OPACITY);
  });

  it("旧 log 卡片里对话外观的痕迹不再出现", () => {
    expect(rows).not.toContain("bg-card/40");
    expect(rows).not.toContain("border-primary/30");
    expect(rows).not.toContain("hover:opacity-80");
  });

  it("流式行与定稿 AI 回复是同一个组件、同一套外壳（不再有独立的 StreamingAssistantRow）：头高一致、正文同一个 MarkdownText", () => {
    // 2026-10-17「吐完字整段抖一下」：流式项曾用独立组件，定稿事件一到整段卸载重挂。
    // 现在流式项走 EventRow 的 `streaming` 态，定稿事件通过 Virtuoso key 接管同一个节点（lib/stream-handoff）
    expect(rows).not.toContain("StreamingAssistantRow");
    expect(rows).toContain("streaming = false,");
    expect(eventRow).toContain("streaming={streaming}");
    // 流式头与定稿头同高（h-7）：它们是同一个节点原地切换，高度差 = 吐完字整段往下顶一截
    const logHeader = between(
      eventRow,
      "{isLog &&",
      "{showBody && !streaming && (",
    );
    expect(countOf(logHeader, "h-7")).toBe(2);
    expect(logHeader).toContain("animate-spin text-info");
    expect(logHeader).toContain("AI 回复中…");
    // 流式头不是带边框的 info 卡
    expect(logHeader).not.toContain("border-info");
    expect(logHeader).not.toContain("bg-info/5");
    // 流式中：不挂 hover 动作条 / 选区引用，log 头强制展开
    expect(eventRow).toContain("{showBody && !streaming && (");
    expect(eventRow).toContain("const showBody = !isLog || !collapsed || streaming;");
    expect(eventRow).toContain("onMouseUp={streaming ? undefined : onAssistantMouseUp}");
  });

  it("回合节奏：chat 与 log 走同一个纯函数（lib/event-stream-rhythm），JSX 里不再各写一套 pt-* 三元", () => {
    // 数值与档间关系由 tests/event-stream-rhythm.test.ts 钉住；这里只守「接线」
    expect(eventStream).toContain('from "@/lib/event-stream-rhythm"');
    const wrapper = between(
      eventStream,
      "itemContent={(absIdx, item) => {",
      "idx === items.length - 1 &&",
    );
    expect(wrapper).toContain("rhythmPaddingTop(");
    expect(wrapper).toContain("rhythmTier(");
    // 上一条取 items[idx - 1]、第一条传 null（rhythmTier 靠它区分「紧跟对话」）
    expect(wrapper).toContain("idx > 0 ? rhythmFacts(items[idx - 1]) : null");
    expect(eventStream).toContain(
      "idx === items.length - 1 && rhythmPaddingBottom(variant)",
    );
    // wrapper 的 className 里不许再有硬编码的上下留白（数值只在一处改）
    expect(wrapper).not.toMatch(/"p[tb]-\d/);
    expect(eventStream).not.toContain("isConversational(items[idx - 1])");
  });

  it("节奏档的「过程行」事实覆盖工作过程组 / 工具块 / 工具动词组（折叠态都只有一行小字）；对话类来自 isConversational", () => {
    const facts = between(
      eventStream,
      "const rhythmFacts = (it: RenderItem): RhythmFacts => ({",
      "});",
    );
    expect(facts).toContain("talk: isConversational(it)");
    // 组间分隔线要的两个事实：AI 平铺正文（含流式）/ 用户这一侧的话（气泡 + 待发送 + 提问卡）
    expect(facts).toContain(
      'aiText: isStreamingItem(it) || it.kind === "assistant_message"',
    );
    for (const kind of ['"user_reply"', '"ask_user_request"']) {
      expect(facts).toContain(kind);
    }
    expect(facts).toContain("isPendingLocalItem(it)");
    for (const kind of [
      '"__work_group__"',
      '"__tool_block__"',
      '"__tool_verb_group__"',
    ]) {
      expect(facts).toContain(kind);
    }
  });

  it("组间分隔线接线：tier / facts 只算一次、线落在留白正中、两端渐隐（不是整宽实线）、纯装饰不拦指针", () => {
    const wrapper = between(
      eventStream,
      "itemContent={(absIdx, item) => {",
      // 源码已去注释：wrapper + 分隔线 + A3 轮次胶囊都在这一段里，到各行渲染分发（流式行）为止
      "{isStreamingItem(item) ? (",
    );
    // 同一份 tier 同时喂给 padding 和分隔线判定——两边各算一遍迟早会算岔
    expect(wrapper).toContain("const tier = rhythmTier(idx, facts, prevFacts);");
    expect(wrapper).toContain("rhythmPaddingTop(variant, tier)");
    expect(wrapper).toContain(
      "rhythmShowsGroupDivider(tier, facts, prevFacts)",
    );
    // 只有画线的那条才 relative（线是绝对定位、以本容器 padding 盒为基准）
    expect(wrapper).toContain('showGroupDivider && "relative"');
    // 线本体：渐隐两端（markdown hr 是整宽实线，用户 2026-07-20 实测「太像」）、不拦指针、对读屏隐藏
    expect(wrapper).toContain("RHYTHM_GROUP_DIVIDER_TOP");
    expect(wrapper).toContain(
      "pointer-events-none absolute h-px bg-gradient-to-r from-transparent via-border to-transparent",
    );
    expect(wrapper).toContain("aria-hidden");
    // 横向与内容区同边距：log px-4、chat px-6
    expect(wrapper).toContain('isChat ? "inset-x-6" : "inset-x-4"');
  });
});

describe("浮层 / 分隔：实心面、不糊字", () => {
  it("sticky「本轮提问」条：不透明底 + 完整边 + 轻阴影，不再 bg-background/75 + backdrop-blur", () => {
    const idx = eventStream.indexOf("本轮提问");
    expect(idx).toBeGreaterThan(0);
    const bar = eventStream.slice(Math.max(0, idx - 900), idx);
    expect(bar).toContain("bg-background ");
    expect(bar).toContain("border-border");
    expect(bar).toContain("shadow-sm");
    expect(bar).not.toContain("bg-background/");
    expect(bar).not.toContain("backdrop-blur");
  });

  it("回合分隔时间胶囊：中性实心底、文字不叠 alpha", () => {
    expect(eventStream).toContain(
      "rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground",
    );
  });
});

describe("错误卡 / 提问卡：当前要你处理的强、已过去的弱", () => {
  it("错误卡「当轮」= 没在跑 + 是最近一条错误；恢复入口（重试 / 重新推进）只给当轮，且按触发源单点判定", () => {
    // 「当轮」资格走 chat-turns.isCurrentErrorCard（= !mainRunActive && isLatestErrorEvent）；
    // 传进来的 runActive 是属主主 run 的在跑态、不含旁路群答疑（D6-02，行为见 tests/main-run-active.test.ts）
    expect(errorCard).toContain(
      "const isCurrent = isCurrentErrorCard(events, ev.id, !!runActive);",
    );
    // 第二轮 review F4-01 / V3-02 / V3-04 / V9-01 / V12-03：只靠 isCurrent 会让推进失败 / 定时失败 /
    // 后台唤醒失败的卡也带「重试」、点了重放旧 user_reply——资格统一走 resolveErrorRecovery
    // 第三个参数带窗口截断信息（D8-02：task 形态触发源被挤出窗口时降级「重新推进」）
    expect(errorCard).toContain("resolveErrorRecovery(events, ev.id, {");
    expect(errorCard).toContain(
      "const canRetry = !!streamActions?.onRetryLastMessage && !!retrySource;",
    );
    expect(errorCard).toContain("recovery.kind === \"readvance\"");
    expect(errorCard).not.toMatch(/canRetry\s*=\s*[^;]*&&\s*isCurrent\s*;/);
  });

  it("错误卡当轮整卡 destructive 描边 + 淡底；历史只留左侧一道 destructive 线 + 白卡底", () => {
    expect(errorCard).toContain('"border-destructive/40 bg-destructive/5"');
    expect(errorCard).toContain(
      '"border-border border-l-[3px] border-l-destructive bg-card"',
    );
  });

  it("错误卡不加 role=alert（事件流是虚拟列表，每次滚进视口重新挂载会反复播报）", () => {
    expect(errorCard).not.toMatch(/role=["']alert["']/);
    expect(rows).not.toMatch(/role=["']alert["']/);
  });

  it("提问卡：未答保留 brand「等你行动」强视觉；已答 / 已失效降成中性白卡（已答多一道 success 左线）", () => {
    const ask = between(
      rows,
      "const AskUserRequestRowImpl",
      "export const AskUserRequestRow = memo",
    );
    expect(ask).toContain('"border-2 border-brand/40 bg-brand/10"');
    expect(ask).toContain('"border border-l-[3px] border-l-success bg-card"');
    expect(ask).not.toContain("bg-success/5");
    expect(ask).not.toContain("border-success/30");
    expect(ask).not.toContain("bg-muted/30");
  });

  it("折叠的提问行（已跳过 / 已过期）：白卡 + 不叠 alpha 的灰字", () => {
    const collapsed = between(
      rows,
      "const CollapsedAskRow",
      "const AskUserRequestRowImpl",
    );
    expect(collapsed).toContain('className="rounded-md border bg-card"');
    expect(collapsed).toContain("aria-expanded={open}");
    expect(collapsed).not.toMatch(/opacity-\d/);
    expect(collapsed).not.toContain("bg-muted/30");
  });
});

describe("键盘 / 读屏可达", () => {
  it("所有折叠按钮都声明 aria-expanded（rows 5 处 / tool-block 3 处 / work-group 1 处）", () => {
    expect(countOf(rows, "aria-expanded")).toBeGreaterThanOrEqual(5);
    // 子代理卡已不是折叠按钮（整条点击开抽屉、没有展开区），所以比原来少一处：普通块 / 待办 / 动词组
    expect(countOf(toolBlock, "aria-expanded")).toBeGreaterThanOrEqual(3);
    expect(countOf(workGroup, "aria-expanded")).toBeGreaterThanOrEqual(1);
  });

  it("hover 才显的时间戳同时挂 focus-within：Tab 聚焦到那一行时也能看到", () => {
    expect(rows).toContain(
      "group-hover/proc:opacity-100 group-focus-within/proc:opacity-100",
    );
    for (const group of ["tool", "verb"]) {
      expect(
        toolBlock,
        `tool-block 里 ${group} 组的时间戳只挂了 hover、没挂 focus-within`,
      ).toContain(
        `group-hover/${group}:opacity-100 group-focus-within/${group}:opacity-100`,
      );
    }
  });

  it("排队气泡的编辑 / 删除：Tab 聚焦也会显形（不是 hidden + group-hover）、提示走 Tooltip 不用原生 title", () => {
    const pending = between(
      rows,
      "export const PendingLocalReplyRow",
      "PendingLocalReplyRow.displayName",
    );
    expect(pending).toContain("group-focus-within:opacity-100");
    expect(pending).not.toContain("group-hover:inline-flex");
    expect(pending).not.toMatch(/\btitle=/);
    expect(pending).toContain("<Tooltip");
  });

  it("组头的「有警告」标：lucide 图标 + Tooltip，不用 emoji（不跟主题走）+ 原生 title（违反 Hover 提示规范）", () => {
    expect(workGroup).toContain("<TriangleAlert");
    expect(workGroup).toContain("<Tooltip");
    expect(workGroup).not.toContain("⚠");
    expect(workGroup).not.toMatch(/\btitle=/);
  });
});

describe("prose 取色走站内语义 token", () => {
  // @tailwindcss/typography 默认 gray 色板让 AI 正文成了蓝灰 rgb(54,65,83)，
  // 而站内 --foreground 是 rgb(21,23,27)；invert 变量也要指向同一组 token，
  // 否则 dark:prose-invert 一切换就又被覆盖回 gray-300
  const prose = sliceBlock(globalsCss, ".prose {");
  const keys = [
    "body",
    "headings",
    "lead",
    "links",
    "bold",
    "counters",
    "bullets",
    "hr",
    "quotes",
    "quote-borders",
    "captions",
    "kbd",
    "code",
    "th-borders",
    "td-borders",
  ];

  it("prose 与 prose-invert 两套变量全部映射到 foreground / muted-foreground / border", () => {
    for (const key of keys) {
      for (const prefix of ["--tw-prose-", "--tw-prose-invert-"]) {
        expect(
          prose,
          `${prefix}${key} 没映射到语义 token`,
        ).toMatch(
          new RegExp(
            `${prefix}${key}:\\s*var\\(--(?:foreground|muted-foreground|border)\\)`,
          ),
        );
      }
    }
  });

  it("代码块底 / 字不在这里动（交给 Streamdown + Shiki 双主题那套）", () => {
    expect(prose).not.toContain("--tw-prose-pre");
    expect(prose).not.toContain("--tw-prose-invert-pre");
  });
});