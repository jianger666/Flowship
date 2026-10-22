/**
 * 事件流「丝滑」重构的源码契约闸（2026-10-17）
 *
 * 用户实测「chat 和 task 的事件流很生硬：思考 / 脚本 / 吐字完成后都会抖一下，全是大动作；
 * 吐字时点上面的横幅回到上一条，回去一半又弹回来」。排查出的根因与修法：
 *
 *  1. 折叠体 `{collapsed ? null : <body/>}` 一帧消失 / 冒出 → 统一走 <Collapse>（高度动画，先动画后卸载）
 *  2. 流式项与定稿事件是两个组件、两个 key，定稿时整段卸载重挂 → 同一个 EventRow + 定稿接管流式项的 key
 *  3. run 结束时状态行槽位 28px 一帧消失、跟 1/2 撞在同一帧 → 槽位高度过渡
 *  4. 横幅 / 悬浮条 display:none ↔ block 硬切 → 淡入淡出
 *  5. 流式时点横幅：程序化 scrollToIndex 被贴底拽回 → 跳转前先停跟随（见 event-stream-scroll-contract）
 *  6. 「回到最新」瞬移 → 控制器里的短缓动（见 stream-follow-controller.test）
 *
 * UI 行为在 node 环境跑不起来（见 vitest.config.ts），靠源码契约守住接线；
 * 判定逻辑本身在 collapse-motion / stream-handoff / scroll-follow-smooth 的纯函数测试里。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { COLLAPSE_MOTION_MS } from "@/lib/collapse-motion";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...segments: string[]): string =>
  readFileSync(path.join(srcDir, ...segments), "utf-8");

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const collapse = read("components", "tasks", "event-stream", "collapse.tsx");
const rows = read("components", "tasks", "event-stream", "rows.tsx");
const toolBlock = read("components", "tasks", "event-stream", "tool-block.tsx");
const workGroup = read("components", "tasks", "event-stream", "work-group.tsx");
const eventStream = read("components", "tasks", "event-stream.tsx");

const count = (source: string, needle: string): number =>
  source.split(needle).length - 1;

describe("Collapse：折叠体的高度动画", () => {
  const code = stripComments(collapse);

  it("用 grid-template-rows 1fr ↔ 0fr（不量高度，内容在长动画也不会算错），时长与 COLLAPSE_MOTION_MS 同值", () => {
    expect(code).toContain("transition-[grid-template-rows]");
    expect(code).toContain("grid-rows-[1fr]");
    expect(code).toContain("grid-rows-[0fr]");
    // Tailwind 类里的时长必须是 COLLAPSE_MOTION_MS——两处各写一个数迟早漂
    expect(code).toContain(`duration-[${COLLAPSE_MOTION_MS}ms]`);
  });

  it("阶段转移全部来自 lib/collapse-motion（组件里不另写一份状态机）", () => {
    for (const fn of [
      "stepCollapse",
      "collapseOnFrame",
      "collapseOnEnd",
      "initialCollapsePhase",
    ]) {
      expect(code).toContain(fn);
    }
    expect(code).toContain('from "@/lib/collapse-motion"');
  });

  it("首次挂载不播动画：初始阶段由 initialCollapsePhase(open) 给（Virtuoso 里行会反复挂载）", () => {
    expect(code).toMatch(/useState<CollapsePhase>\(\(\) =>\s*initialCollapsePhase\(open\)/);
  });

  it("收起期间继续画「最后一次展开时」的子树（思考落盘会把 body 从 5 行窗口换成全文，不冻结高度会先暴涨再收）", () => {
    expect(code).toContain("lastOpenChildren");
    expect(code).toContain("{open ? children : lastOpenChildren.current}");
    // 只有 open 时才刷新快照
    expect(code).toContain("if (open) lastOpenChildren.current = children;");
  });

  it("静止展开时撤掉 overflow:hidden（否则焦点环 / 阴影 / 绝对定位小按钮被裁）；过渡中才裁剪", () => {
    expect(code).toContain('synced === "open" ? "overflow-visible" : "overflow-hidden"');
  });

  it("过渡中 inert（收起那 220ms 键盘焦点不能钻进正在消失的内容）", () => {
    expect(code).toContain("inert={inert}");
    expect(code).toContain('synced === "leaving" || synced === "enter-from"');
  });

  it("transitionend 只认自己的 grid-template-rows（子孙的 chevron 旋转 / 嵌套折叠体会冒泡上来）", () => {
    expect(code).toContain("e.target !== e.currentTarget");
    expect(code).toContain('e.propertyName !== "grid-template-rows"');
  });

  it("兜底定时器：transitionend 不来（后台标签页 / 被隐藏）也要收尾，且卸载 / 换阶段清定时器", () => {
    expect(code).toContain("COLLAPSE_MOTION_MS + COLLAPSE_END_SLACK_MS");
    expect(code).toContain("window.clearTimeout(timer)");
  });

  it("「减少动态效果」：CSS 关 transition、阶段机直接跳阶段", () => {
    expect(code).toContain("motion-reduce:transition-none");
    expect(code).toContain("prefers-reduced-motion: reduce");
    expect(code).toMatch(/stepCollapse\(phase, open, prefersReducedMotion\(\)\)/);
  });

  it("起跑线 0fr 画出来后强制一次样式计算再切 1fr（否则两次变化被合并、transition 不触发）", () => {
    expect(code).toContain("getBoundingClientRect()");
    expect(code).toContain("useLayoutEffect");
  });
});

describe("折叠体全部走 <Collapse>（不再 `{!collapsed && <body/>}` 硬切）", () => {
  it("工作过程组：成员列表 + 处理中占位整体在 Collapse 里", () => {
    expect(workGroup).toContain("<Collapse open={expanded}>");
    expect(workGroup).not.toMatch(/\{expanded && \(\s*<div/);
  });

  it("思考 / 过程行 body、log 卡片 body、log AI 回复正文、被跳过的提问回放", () => {
    // ProcessEventRow（思考 / 过程行）+ log 回执卡 + 回放卡
    expect(rows).toContain("<Collapse open={!collapsed}>");
    expect(count(rows, "<Collapse open={!collapsed}>")).toBe(2);
    expect(rows).toContain("<Collapse open={open}>");
    // log 形态的 AI 回复正文折叠；chat 正文永远展开、不套 Collapse
    expect(rows).toContain("<Collapse open={showBody}>{assistantBody}</Collapse>");
    expect(rows).not.toMatch(/\{!collapsed && \(\s*<div/);
    expect(rows).not.toMatch(/\{open && \(\s*<div/);
  });

  it("工具块家族：普通块 / 待办清单 / 动词组 + 普通块里的 diff 与输出子折叠（子代理卡已无内联展开，整条点击开抽屉）", () => {
    expect(count(toolBlock, "<Collapse open={!collapsed}>")).toBe(3);
    expect(toolBlock).toContain("<Collapse open={!diffCollapsed}>");
    expect(toolBlock).toContain('<Collapse open={block.status === "running" || outputOpen}>');
    // 折叠体不许再有硬切（标题行里「展开时露出路径」那条是 header 内容、不带 <div 体）
    expect(toolBlock).not.toMatch(/\{!collapsed && \(\s*<(div|ul)/);
  });

  it("过程层的折叠头（chevron 旋转）本来就有 transition，Collapse 的 220ms 与它并行、不互相等", () => {
    expect(read("components", "tasks", "event-stream", "stream-style.tsx")).toContain(
      "transition-transform duration-150",
    );
  });
});

describe("流式 → 定稿：同一个节点原地交接（不再卸载重挂）", () => {
  const code = stripComments(eventStream);
  const rowsCode = stripComments(rows);

  it("独立的流式占位组件已删：流式项走 EventRow 的 streaming 态、合成 assistant_message", () => {
    expect(rows).not.toContain("StreamingAssistantRow");
    expect(eventStream).not.toContain("StreamingAssistantRow");
    const branch = code.slice(
      code.indexOf("{isStreamingItem(item) ? ("),
      code.indexOf(") : isLoadingItem(item) ? ("),
    );
    expect(branch).toContain("<EventRow");
    expect(branch).toContain('kind: "assistant_message"');
    expect(branch).toContain("streaming");
    expect(branch).toContain("id: item.id");
  });

  it("交接状态走渲染期推导（nextStreamHandoff + 引用变了才 setState），不用 effect（effect 晚一帧 = 先重挂再补 key）", () => {
    expect(code).toContain("const handoff = nextStreamHandoff(handoffState, {");
    expect(code).toContain("if (handoff !== handoffState) setHandoffState(handoff);");
    expect(code).toContain("findLastAssistantId(orderedItems)");
  });

  it("流式项 id 按段编号（streamItemId(handoff.seq)），且 handoff.seq 在 items 的依赖里", () => {
    const items = code.slice(
      code.indexOf("const items: RenderItem[] = useMemo"),
      code.indexOf("const contentCount"),
    );
    expect(items).toContain("id: streamItemId(handoff.seq)");
    expect(items).toContain("handoff.seq,");
    // 固定的 "__streaming__" id 不再出现（上一段被接管的 key 会被下一段撞上）
    expect(items).not.toContain('id: "__streaming__"');
  });

  it("Virtuoso key 经 resolveItemKey 查接管表：定稿事件沿用流式项的 key", () => {
    expect(code).toContain(
      "computeItemKey={(_idx, item) => resolveItemKey(item.id, handoff.aliases)}",
    );
    // 老的「key = id」不能回来
    expect(code).not.toContain("computeItemKey={(_idx, item) => item.id}");
  });

  it("EventRow 的 streaming 态：同一个 MarkdownText 只切 streaming、log 头同高、流式中不挂动作条", () => {
    expect(rowsCode).toContain("streaming = false,");
    expect(rowsCode).toContain("streaming={streaming}");
    // 搜索高亮早已走 DOM 的 CSS Highlight，<mark> 管线（searchField 等 props）已删（D3-07 / 第三轮），不再断言
    expect(rowsCode).not.toContain("searchField=");
    expect(rowsCode).toContain("{showBody && !streaming && (");
    // 渲染 MarkdownText 的位置不依赖 streaming 条件：它在 JSX 子节点序列里的槽位固定，
    // 流式 / 定稿切换才会复用同一个实例（条件渲染会让槽位错位）
    expect(count(rowsCode, "{assistantBody}")).toBe(1);
    expect(count(rowsCode, "assistantBody\n")).toBeGreaterThanOrEqual(1);
  });

  it("吐字不劈开代理对（emoji 一闪一闪）", () => {
    const hook = read("components", "tasks", "use-smooth-streaming.ts");
    expect(hook).toContain("safeSliceEnd(");
    expect(hook).toMatch(/displayedLenRef\.current = safeSliceEnd\(/);
  });
});

describe("横幅 / 悬浮条：淡入淡出，不 display:none 硬切", () => {
  const code = stripComments(eventStream);

  it("粘性「本轮提问」横幅：不再 toggle `hidden`，走 visible/opacity/translate 两组类 + 过渡", () => {
    expect(code).not.toContain('classList.add("hidden")');
    expect(code).not.toContain('classList.remove("hidden")');
    expect(code).toContain("root.classList.remove(...STICKY_HIDDEN_CLASSES);");
    expect(code).toContain("root.classList.add(...STICKY_SHOWN_CLASSES);");
    // 过渡属性含 visibility：淡出结束才真正不可点、淡入时立刻可见
    expect(code).toContain("transition-[opacity,translate,visibility]");
    expect(code).toContain("motion-reduce:transition-none");
  });

  it("横幅根节点的初始类就是隐藏态（STICKY_HIDDEN_CLASSES 同一组）", () => {
    const hidden = /const STICKY_HIDDEN_CLASSES = \[([^\]]+)\]/.exec(code)?.[1] ?? "";
    expect(hidden).not.toBe("");
    const classes = [...hidden.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(classes.length).toBeGreaterThanOrEqual(3);
    const rootStart = code.indexOf("ref={stickyRootRef}");
    const rootClass = code.slice(rootStart, rootStart + 600);
    for (const c of classes) expect(rootClass).toContain(c);
  });

  it("淡出期间文字保留（不在隐藏分支里清 textContent）；只有切任务才立刻清", () => {
    const apply = code.slice(
      code.indexOf("const applyStickyTurn"),
      code.indexOf("const [hasMoreEarlier"),
    );
    expect(apply).not.toContain('textContent = ""');
  });

  it("「回到最新」按钮与「AI 在等你回答」提示条入场淡入", () => {
    const bar = code.slice(
      code.indexOf("const StreamFloatingBar"),
      code.indexOf("/** 渲染管线入口过滤"),
    );
    expect(count(bar, "animate-in")).toBe(2);
    expect(count(bar, "motion-reduce:animate-none")).toBe(2);
  });
});
