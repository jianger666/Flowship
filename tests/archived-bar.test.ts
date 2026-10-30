/**
 * 详情页「已归档」提示条（R14 B6-3 / Q3-03）：src/components/tasks/archived-bar.tsx + 两处接线。
 *
 * 改前：详情页（task / chat 两种形态）完全不认 task.archived——从 Cmd+K 搜索 / 系统通知 / 定时管理页进到已归档会话，
 * 页面和正常会话一模一样，用户接着聊却不知道它在侧栏里已经看不见了。
 * 改后：顶部多一条灰条「这个会话已归档，侧栏里不显示。」+「恢复归档」按钮；没归档时什么都不画。
 *
 * 项目里没有 DOM 测试环境，走 renderToStaticMarkup 的 SSR 冒烟（手法同 low-disk-bar.test.ts）：
 *   ① ArchivedBar 结构：role="note"（不是 alert）、文案、按钮；颜色走语义 token；静止（restoring 才转圈）；className 透传；
 *   ② 点击接线：直接调组件函数拿元素树，找到「恢复归档」按钮，它的 onClick 就是传入的 onRestore；
 *   ③ ArchivedNotice（恢复动作的 hook 用 mock 顶替）：archived 才画；没归档也照样调 hook（hook 个数不能随 archived 变）；
 *   ④ 源码接线契约：task 形态放在顶栏分隔线之后、主区之前；chat 形态放在标题栏与内容区之间，
 *      不放进 page.tsx 的 chat 外层 wrapper（ChatView 根是 h-full，并列会撑出视口）；canAdvance 不看 archived（本批刻意不改推进语义）。
 * 恢复动作本身（请求 / 双击 / 失败重试）见 use-restore-archived.test.ts。
 *
 * ⚠ 只做了 SSR 渲染检查：没有在真实窗口里看过灰条的实际观感与它在 chat / task 两种布局里的高度占用。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  restore: vi.fn(),
  restoring: false,
  calls: [] as unknown[][],
}));
vi.mock("@/hooks/use-restore-archived", () => ({
  useRestoreArchived: (...args: unknown[]) => {
    h.calls.push(args);
    return { restore: h.restore, restoring: h.restoring };
  },
}));

import { ArchivedBar, ArchivedNotice } from "@/components/tasks/archived-bar";
import { Button } from "@/components/ui/button";

beforeEach(() => {
  h.restore.mockReset();
  h.restoring = false;
  h.calls.length = 0;
});

/** 根元素（灰条的外层 div）的 class 属性值 */
const rootClass = (html: string): string => /^<div\b[^>]*\bclass="([^"]*)"/.exec(html)?.[1] ?? "";
/** 去掉标签，只剩用户看得到的文字 */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "");
/**
 * 按钮开始标签里、去掉 class 之后的属性文本。
 * class 里有 disabled:pointer-events-none / disabled:opacity-50 这类变体，直接在整个标签里找 disabled 恒为真——必须先剥掉 class。
 */
const buttonAttrs = (html: string): string =>
  (/<button\b[^>]*>/.exec(html)?.[0] ?? "").replace(/\sclass="[^"]*"/, "");

// 与 ui-convention-scan.test.ts / low-disk-bar.test.ts 同款的裸色规则
// （不能 import 它们：import 一个测试文件会把它的 describe 一并注册进来）
const RAW_PALETTE =
  /\b(?:bg|text|border(?:-[xytblrse])?|ring|fill|stroke|from|via|to|outline|divide|shadow|decoration|accent|caret)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/;
const RAW_WHITE_BLACK = /\b(?:bg|text|border|ring|fill|stroke)-(?:white|black)\b/;
const MID_OPACITY = /(?<![\w/-])(?:[\w/-]+:)*opacity-(?:[2-9]\d)\b/;

/** 递归找出元素树里所有满足条件的元素（不渲染，只看 React 元素） */
const findElements = (
  node: ReactNode,
  pred: (el: ReactElement<Record<string, unknown>>) => boolean,
): Array<ReactElement<Record<string, unknown>>> => {
  const out: Array<ReactElement<Record<string, unknown>>> = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as ReactElement<Record<string, unknown>>;
    if (pred(el)) out.push(el);
    Children.forEach(el.props.children as ReactNode, walk);
  };
  walk(node);
  return out;
};

const renderBar = (props: { restoring?: boolean; className?: string } = {}): string =>
  renderToStaticMarkup(createElement(ArchivedBar, { onRestore: () => {}, ...props }));

describe("ArchivedBar 结构与样式", () => {
  it("是信息提示不是告警：role=note、没有 role=alert；文案说清「已归档、侧栏里不显示」；有恢复按钮", () => {
    const html = renderBar();
    expect(html).toContain('role="note"');
    expect(html).not.toContain('role="alert"');
    expect(textOf(html)).toContain("这个会话已归档，侧栏里不显示。");
    expect(textOf(html)).toContain("恢复归档");
    expect(html).toContain("<button");
  });

  it("文案不承诺它不知道的事：不写「N 个定时已取消」（页面读不到有没有被取消的定时）", () => {
    const text = textOf(renderBar());
    expect(text).not.toMatch(/\d+\s*个定时/);
    expect(text).not.toContain("定时");
  });

  it("颜色走语义 token；没有裸色、没有整块 opacity；中性灰底（bg-muted），不是告警红", () => {
    const html = renderBar();
    const cls = rootClass(html);
    expect(cls).toContain("bg-muted");
    expect(cls).toContain("text-muted-foreground");
    expect(cls).toContain("border-b");
    expect(cls).not.toContain("destructive");
    expect(html).not.toMatch(RAW_PALETTE);
    expect(html).not.toMatch(RAW_WHITE_BLACK);
    // 整块 opacity 只查本组件自己的根元素：按钮的 disabled:opacity-50 是 ui/button 自带的，不算这条灰条的
    expect(cls).not.toMatch(MID_OPACITY);
  });

  it("静止：没在恢复时不转圈、按钮可点；图标对读屏隐藏", () => {
    const html = renderBar({ restoring: false });
    expect(html).not.toContain("animate-");
    expect(buttonAttrs(html)).toContain("<button");
    expect(buttonAttrs(html)).not.toMatch(/\bdisabled\b/);
    expect(html).toContain('aria-hidden="true"');
  });

  it("恢复中：按钮禁用并转圈（防双击的视觉面；真正的防重入在 hook 的 ref 里）", () => {
    const html = renderBar({ restoring: true });
    expect(buttonAttrs(html)).toMatch(/\bdisabled\b/);
    expect(html).toContain("animate-spin");
    expect(textOf(html)).toContain("恢复归档");
  });

  it("className 透传到根元素；不吞默认样式", () => {
    const cls = rootClass(renderBar({ className: "mt-9" }));
    expect(cls).toContain("mt-9");
    expect(cls).toContain("bg-muted");
  });
});

describe("ArchivedBar 点击接线", () => {
  it("「恢复归档」按钮的 onClick 就是传入的 onRestore", () => {
    const onRestore = vi.fn();
    const tree = ArchivedBar({ onRestore });
    const buttons = findElements(tree, (el) => el.type === Button);
    expect(buttons).toHaveLength(1);
    const onClick = buttons[0].props.onClick as () => void;
    onClick();
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(buttons[0].props.disabled).toBe(false);
  });

  it("恢复中：按钮 disabled", () => {
    const tree = ArchivedBar({ onRestore: () => {}, restoring: true });
    const buttons = findElements(tree, (el) => el.type === Button);
    expect(buttons[0].props.disabled).toBe(true);
  });
});

describe("ArchivedNotice 容器", () => {
  const task = { id: "t1", title: "旧会话", pinned: false, archived: true as boolean | undefined };
  const onTaskUpdate = vi.fn();

  it("已归档：画灰条", () => {
    const html = renderToStaticMarkup(createElement(ArchivedNotice, { task, onTaskUpdate }));
    expect(html).toContain('role="note"');
    expect(textOf(html)).toContain("恢复归档");
  });

  it("没归档（false / undefined）：什么都不画", () => {
    for (const archived of [false, undefined]) {
      const html = renderToStaticMarkup(
        createElement(ArchivedNotice, { task: { ...task, archived }, onTaskUpdate }),
      );
      expect(html).toBe("");
    }
  });

  it("不管有没有归档都照样调 hook——hook 个数不能随 archived 变（恢复成功那一刻 archived 会从 true 变 false）", () => {
    renderToStaticMarkup(createElement(ArchivedNotice, { task, onTaskUpdate }));
    renderToStaticMarkup(
      createElement(ArchivedNotice, { task: { ...task, archived: false }, onTaskUpdate }),
    );
    expect(h.calls).toHaveLength(2);
  });

  it("hook 拿到的是这条任务和页面给的回调（恢复成功后页面据此换 task）", () => {
    renderToStaticMarkup(createElement(ArchivedNotice, { task, onTaskUpdate }));
    expect(h.calls[0][0]).toBe(task);
    expect(h.calls[0][1]).toBe(onTaskUpdate);
  });

  it("灰条上的恢复按钮 = hook 的 restore；restoring 状态也来自 hook", () => {
    h.restoring = true;
    const tree = ArchivedNotice({ task, onTaskUpdate }) as ReactElement<{
      onRestore: () => void;
      restoring: boolean;
    }>;
    expect(tree.type).toBe(ArchivedBar);
    expect(tree.props.restoring).toBe(true);
    tree.props.onRestore();
    expect(h.restore).toHaveBeenCalledTimes(1);
  });
});

describe("详情页接线契约", () => {
  const readSrc = (rel: string) =>
    readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");
  const page = readSrc("src/app/tasks/[id]/page.tsx");
  const chat = readSrc("src/components/tasks/chat-view.tsx");

  it("task 形态：顶栏分隔线之后、主区之前挂一次，吃 absorbTask", () => {
    const notice = '<ArchivedNotice task={task} onTaskUpdate={absorbTask} />';
    expect(page.split(notice).length - 1).toBe(1);
    expect(page).toContain('import { ArchivedNotice } from "@/components/tasks/archived-bar"');
    const separator = page.indexOf("<Separator />");
    const at = page.indexOf(notice);
    const main = page.indexOf("{/* 主区 */}");
    expect(separator).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(separator);
    expect(main).toBeGreaterThan(at);
  });

  it("chat 形态：挂在 ChatView 里的标题栏与内容区之间，吃 onTaskUpdate；page.tsx 的 chat 外层 wrapper 里没有", () => {
    const notice = '<ArchivedNotice task={task} onTaskUpdate={onTaskUpdate} />';
    expect(chat.split(notice).length - 1).toBe(1);
    expect(chat).toContain('import { ArchivedNotice } from "@/components/tasks/archived-bar"');
    const header = chat.indexOf('<div className="border-b px-6 py-2.5">');
    const at = chat.indexOf(notice);
    const body = chat.indexOf('<div className="min-h-0 flex-1">');
    expect(header).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(header);
    expect(body).toBeGreaterThan(at);

    const chatBranch = page.slice(
      page.indexOf('if (task.mode === "chat") {'),
      page.indexOf("// 运行态只看属主主 run"),
    );
    expect(chatBranch).toContain("<ChatView");
    expect(chatBranch).not.toContain("ArchivedNotice");
  });

  it("本批刻意不改推进语义：canAdvance 不看 archived（已归档会话里发消息 / 推进不会隐式取消归档）", () => {
    const start = page.indexOf("const canAdvance =");
    expect(start).toBeGreaterThan(-1);
    const expr = page.slice(start, page.indexOf(";", start));
    expect(expr).not.toContain("archived");
  });
});
