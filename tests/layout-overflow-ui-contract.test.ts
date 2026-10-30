/**
 * 长路径 / 长文件名的 UI 回归契约。
 *
 * 这些组件在 node 测试环境没有真实布局引擎；这里锁住关键的 CSS 收缩链，
 * 实际视口宽度与横向滚动行为由桌面端冒烟覆盖。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", relativePath), "utf-8");

describe("长内容不撑破视口", () => {
  it("事件流 diff 标题受父宽约束，文件名截断，代码内容只在 diff 内横滚", () => {
    const toolBlock = source(
      "src/components/tasks/event-stream/tool-block.tsx",
    );

    expect(toolBlock).toContain("group/tool w-full min-w-0 max-w-full");
    expect(toolBlock).toContain(
      "flex w-full min-w-0 cursor-pointer items-center gap-1 text-left",
    );
    expect(toolBlock).toContain(
      'className="min-w-0 flex-1 truncate font-mono"',
    );
    expect(toolBlock).toContain(
      "max-h-64 w-full max-w-full overflow-auto",
    );
  });

  it("事件项、工作过程和复制容器保持连续的 min-width: 0 收缩链", () => {
    const eventStream = source("src/components/tasks/event-stream.tsx");
    const workGroup = source(
      "src/components/tasks/event-stream/work-group.tsx",
    );
    const copyButton = source("src/components/ui/copy-button.tsx");

    expect(eventStream).toContain('"min-w-0 max-w-full px-4"');
    expect(workGroup).toContain(
      "ml-2 mt-0.5 min-w-0 max-w-full space-y-0.5",
    );
    expect(copyButton).toContain(
      '"group/copyable relative min-w-0 max-w-full"',
    );
  });

  it("全局内容型基础组件限制在宿主或视口宽度内", () => {
    const markdown = source("src/components/markdown-text.tsx");
    const table = source("src/components/ui/table.tsx");
    const popover = source("src/components/ui/popover.tsx");
    const dialog = source("src/components/ui/dialog.tsx");
    const localPreview = source("src/components/ui/local-file-preview.tsx");

    expect(markdown).toContain(
      "dark:prose-invert min-w-0 max-w-full wrap-break-word",
    );
    expect(table).toContain(
      "relative min-w-0 w-full max-w-full overflow-x-auto",
    );
    expect(popover).toContain('max-w-[calc(100vw-1rem)]');
    expect(dialog).toContain("overflow-x-hidden overflow-y-auto");
    expect(localPreview).toContain(
      "max-h-[min(90vh,calc(100vh-48px))]",
    );
    expect(localPreview).toContain(
      "sm:max-w-[min(960px,80vw,calc(100vw-48px))]",
    );
    expect(localPreview).toContain("min-h-0 flex-1 overflow-x-hidden overflow-y-auto");
  });
});

/**
 * 弹窗超高也能看完（X5）——a / b / c 三层，各自可单独回退。
 *
 * 背景：更新弹窗正文没有高度上限，3 个版本约 900 px 高过常规窗口；共用的 DialogContent 超高时只靠整页遮罩滚、
 * footer 随内容在最底、被挤出屏幕；AlertDialog 是 fixed 居中、完全不能滚。
 *
 * 诚实声明：node 测试环境没有布局引擎，也没有 DOM。下面只证明「这些类名还在、没被改回去」，
 * **不证明**真机上 sticky 在 flex-col 里真的吸底、内滚真的能滚、遮罩滚在超高时真的滚得动——这些要装包后用眼睛看。
 */

/** 去掉整行 `//` 注释（注释里会提到类名，会污染断言；只扫代码） */
const stripLineComments = (code: string): string =>
  code
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** `function Name(` 起到下一个顶层 `function ` / `export {` 之前的源码切片（已去整行注释） */
const functionBody = (src: string, name: string): string => {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `找不到 function ${name}`).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(?:function |export \{)/);
  return stripLineComments(
    next < 0 ? src.slice(start) : src.slice(start, start + 1 + next),
  );
};

/** 取 `marker` 之后第一个 `cn(` 的第一个字符串字面量，按空白拆成 class token */
const cnTokensAfter = (code: string, marker: string): string[] => {
  const at = code.indexOf(marker);
  expect(at, `找不到 ${marker}`).toBeGreaterThan(-1);
  const m = /cn\(\s*"([^"]+)"/.exec(code.slice(at));
  expect(m, `${marker} 之后没有 cn("…") 字面量`).not.toBeNull();
  return m![1].split(/\s+/).filter(Boolean);
};

/** 取第一个匹配 `pattern`（捕获 className 字符串）的元素的 class token */
const classTokensOf = (code: string, pattern: RegExp, what: string): string[] => {
  const m = pattern.exec(stripLineComments(code));
  expect(m, `找不到${what}`).not.toBeNull();
  return m![1].split(/\s+/).filter(Boolean);
};

describe("弹窗超高也能看完（X5：a / b / c 三层，各自可单独回退）", () => {
  describe("X5-a 更新弹窗：正文自己滚，标题和「知道了」始终在视口里", () => {
    const bodyTokens = () =>
      classTokensOf(
        source("src/components/whats-new-host.tsx"),
        /className="([^"]*\bspace-y-4\b[^"]*)"/,
        "更新弹窗的正文容器（带 space-y-4 的 div）",
      );

    it.each(["max-h-[min(60vh,32rem)]", "overflow-y-auto", "pr-1"])(
      "正文容器带 %s",
      (token) => {
        expect(bodyTokens()).toContain(token);
      },
    );
  });

  describe("X5-b AlertDialog：超高时自己滚，confirm() 的描述有上限", () => {
    const alertSource = () => source("src/components/ui/alert-dialog.tsx");
    const contentTokens = () =>
      cnTokensAfter(
        functionBody(alertSource(), "AlertDialogContent"),
        'data-slot="alert-dialog-content"',
      );
    const descriptionTokens = () =>
      classTokensOf(
        source("src/hooks/use-dialog.tsx"),
        /<AlertDialogDescription\s+className="([^"]+)"/,
        "confirm() 的 AlertDialogDescription",
      );

    it.each([
      "max-h-[calc(100dvh-2rem)]",
      "overflow-y-auto",
      "[-webkit-app-region:no-drag]",
    ])("AlertDialogContent 带 %s", (token) => {
      expect(contentTokens()).toContain(token);
    });

    it("AlertDialogContent 仍是 fixed 居中（没有被改成别的定位方式）", () => {
      expect(contentTokens()).toEqual(
        expect.arrayContaining(["fixed", "top-1/2", "left-1/2"]),
      );
    });

    it("AlertDialogFooter 不吸底：它是无底衬的紧凑按钮行，没有可吸的操作条", () => {
      const footer = cnTokensAfter(
        functionBody(alertSource(), "AlertDialogFooter"),
        'data-slot="alert-dialog-footer"',
      );
      expect(footer).not.toContain("sticky");
    });

    it.each(["whitespace-pre-line", "max-h-[min(50vh,20rem)]", "overflow-y-auto"])(
      "confirm() 的描述带 %s",
      (token) => {
        expect(descriptionTokens()).toContain(token);
      },
    );
  });

  describe("X5-c 共用 DialogContent：Popup 是 flex-col，DialogFooter 吸底且不透明", () => {
    const dialogSource = () => source("src/components/ui/dialog.tsx");
    const popupTokens = () =>
      cnTokensAfter(
        functionBody(dialogSource(), "DialogContent"),
        'data-slot="dialog-content"',
      );
    const footerTokens = () =>
      cnTokensAfter(
        functionBody(dialogSource(), "DialogFooter"),
        'data-slot="dialog-footer"',
      );

    it.each(["flex", "flex-col"])(
      "Popup 带 %s（sticky 的包含块要是 flex 容器的内容区；grid item 的包含块是它自己的行，sticky 不生效）",
      (token) => {
        expect(popupTokens()).toContain(token);
      },
    );

    it("Popup 不再是 grid", () => {
      expect(popupTokens()).not.toContain("grid");
    });

    it.each([
      "relative",
      "w-full",
      "max-w-[calc(100%-2rem)]",
      "gap-4",
      "p-4",
      "*:min-w-0",
      "[-webkit-app-region:no-drag]",
    ])("Popup 原有的 %s 保留", (token) => {
      expect(popupTokens()).toContain(token);
    });

    it("Popup 本身不内滚：没有 max-h-* / overflow-* 类（V0.5.4 用户拍板「mask 滚」）", () => {
      expect(popupTokens().filter((t) => /^(max-h-|overflow-)/.test(t))).toEqual(
        [],
      );
    });

    it("外层 wrapper 仍是整页遮罩滚", () => {
      const wrapper = classTokensOf(
        functionBody(dialogSource(), "DialogContent"),
        /<div className="([^"]*\bfixed inset-0\b[^"]*)"/,
        "DialogContent 外层的遮罩滚 wrapper",
      );
      expect(wrapper).toEqual(
        expect.arrayContaining([
          "fixed",
          "inset-0",
          "z-50",
          "grid",
          "place-items-center",
          "overflow-x-hidden",
          "overflow-y-auto",
          "p-4",
        ]),
      );
    });

    it.each(["sticky", "-bottom-4", "z-10"])("DialogFooter 带 %s（吸底）", (token) => {
      expect(footerTokens()).toContain(token);
    });

    it("DialogFooter 的 bottom 偏移恰好抵消外层 wrapper 的 padding（F1：sticky 从滚动容器内边距内沿算起，bottom-0 会在窗口底边留一条缝、露出正文）", () => {
      const wrapper = classTokensOf(
        functionBody(dialogSource(), "DialogContent"),
        /<div className="([^"]*\bfixed inset-0\b[^"]*)"/,
        "DialogContent 外层的遮罩滚 wrapper",
      );
      const pad = wrapper.find((t) => /^p-\d+$/.test(t)) ?? "";
      expect(pad).not.toBe("");
      const bottoms = footerTokens().filter((t) => /^-?bottom-/.test(t));
      expect(bottoms).toEqual([`-bottom-${pad.slice(2)}`]);
    });

    it.each(["-mx-4", "-mb-4", "rounded-b-xl", "border-t"])(
      "DialogFooter 原有的 %s 保留",
      (token) => {
        expect(footerTokens()).toContain(token);
      },
    );

    it("DialogFooter 底色不透明：只有一个 bg-*、不带透明度后缀（吸底后下面有内容滚过，半透明会透字）", () => {
      const backgrounds = footerTokens().filter((t) => t.startsWith("bg-"));
      expect(backgrounds).toHaveLength(1);
      expect(backgrounds[0]).not.toMatch(/\/\d+/);
      expect(backgrounds[0]).not.toBe("bg-transparent");
    });
  });
});
