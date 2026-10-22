/**
 * Streamdown 配置 / 流式 → 定稿交接的行为契约（2026-10-20 第二轮 review：V15-01 / V15-02 / V15-08 / V14-04）。
 *
 * 为什么用 `streamdown` 包直接渲染、而不是 import MarkdownText：markdown-text.tsx 是 .tsx（tsconfig `jsx: preserve`，
 * vitest 不转 JSX），本仓测试一律只 import .ts。所以把「会影响行为的常量 / 判定」抽到 `lib/streamdown-options.ts`，
 * 这里用**同一份常量**驱动真实的 Streamdown（renderToStaticMarkup），再用源码契约钉住 MarkdownText 的接线。
 *
 * 每条都能「修前红、修后绿」：断言里同时保留了「不带修法时的坏输出」，既是回归证据、也在上游升级改了行为时报警。
 */
import fs from "node:fs";
import path from "node:path";
import React, {
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  defaultTranslations,
} from "streamdown";
import { describe, expect, it } from "vitest";

import {
  STREAMDOWN_REMEND_OPTIONS,
  STREAMDOWN_TRANSLATIONS_ZH,
  resolveStreamdownMode,
} from "@/lib/streamdown-options";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string =>
  fs.readFileSync(path.join(REPO, rel), "utf-8");
const mdSource = read("src/components/markdown-text.tsx");

// 与 markdown-text.tsx 同款管线（raw → sanitize → harden；remark 带 gfm）。本地图改写 / 自定义 remark 与这里无关
const REHYPE = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
];
const REMARK = [...Object.values(defaultRemarkPlugins)];
const CONTROLS = { code: { copy: true, download: false }, table: false };

const render = (text: string, props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        rehypePlugins: REHYPE,
        remarkPlugins: REMARK,
        controls: CONTROLS,
        ...props,
      } as never,
      text,
    ),
  );

/** static 是整篇一次渲染、streaming 是逐块渲染，块与块之间差一些纯空白文本节点，标记比较前抹掉 */
const norm = (html: string): string => html.replace(/>\s+</g, "><");

describe("V15-02 流式中的链接不再闪「文字 [blocked]」", () => {
  const HALF_LINK = "看 [文档](https://exa";

  it("【根因】不带 remend 配置：半截链接被渲染成灰色英文「文字 [blocked]」+ 原生 title（修前的坏输出）", () => {
    const html = render(HALF_LINK, { mode: "streaming", isAnimating: true });
    expect(html).toContain("[blocked]");
    expect(html).toContain("Blocked URL");
  });

  it("带 STREAMDOWN_REMEND_OPTIONS（linkMode: text-only）：半截链接只显示文字，没有 blocked / 灰色 span", () => {
    const html = render(HALF_LINK, {
      mode: "streaming",
      isAnimating: true,
      remend: STREAMDOWN_REMEND_OPTIONS,
    });
    expect(html).not.toMatch(/blocked/i);
    expect(html).not.toContain("text-gray-500");
    expect(norm(html)).toContain("<p>看 文档</p>");
  });

  it("链接写完整后照常渲染成可点链接（text-only 只影响没写完的那一段）", () => {
    const html = render("看 [文档](https://example.com/a) 好", {
      mode: "streaming",
      isAnimating: true,
      remend: STREAMDOWN_REMEND_OPTIONS,
    });
    expect(html).toContain('data-streamdown="link"');
    expect(html).toContain("文档");
    expect(html).not.toMatch(/blocked/i);
  });

  it("配置本身：linkMode 是 text-only", () => {
    expect(STREAMDOWN_REMEND_OPTIONS).toEqual({ linkMode: "text-only" });
  });

  it("接线：MarkdownText 把它传给 Streamdown 的 remend prop", () => {
    expect(mdSource).toMatch(/remend=\{STREAMDOWN_REMEND_OPTIONS\}/);
  });
});

describe("V15-08 / V14-04 Streamdown 控件文案走中文", () => {
  it("键集合与上游 defaultTranslations 完全一致（升级后上游加了键，这里红、提醒补中文）", () => {
    expect(Object.keys(STREAMDOWN_TRANSLATIONS_ZH).sort()).toEqual(
      Object.keys(defaultTranslations).sort(),
    );
  });

  it("每条都有中文（纯缩写 SVG / PNG / MMD / CSV / TSV / Markdown 除外），且没有原样沿用英文默认值", () => {
    const acronymKeys = new Set([
      "mermaidFormatSvg",
      "mermaidFormatPng",
      "mermaidFormatMmd",
      "tableFormatCsv",
      "tableFormatTsv",
      "tableFormatMarkdown",
    ]);
    for (const [key, value] of Object.entries(STREAMDOWN_TRANSLATIONS_ZH)) {
      if (acronymKeys.has(key)) continue;
      expect(value, key).toMatch(/[\u4e00-\u9fff]/);
      expect(value, key).not.toBe(
        (defaultTranslations as unknown as Record<string, string>)[key],
      );
    }
  });

  it("真实渲染：代码块复制按钮的 title 是「复制代码」；不传 translations 时是英文「Copy Code」（修前）", () => {
    const code = "```js\nconst a = 1;\n```";
    expect(
      render(code, { mode: "static", translations: STREAMDOWN_TRANSLATIONS_ZH }),
    ).toContain('title="复制代码"');
    expect(render(code, { mode: "static" })).toContain('title="Copy Code"');
  });

  it("接线：MarkdownText 传 translations={STREAMDOWN_TRANSLATIONS_ZH}", () => {
    expect(mdSource).toMatch(/translations=\{STREAMDOWN_TRANSLATIONS_ZH\}/);
  });

  it("对话框关闭钮：dialog.tsx 的 sr-only 文案与 DialogFooter 可见文案是「关闭」（对照 sheet.tsx），不再有英文 Close", () => {
    const dialog = read("src/components/ui/dialog.tsx");
    expect(dialog).not.toMatch(/sr-only">Close</);
    expect(dialog.match(/sr-only">关闭</g)).toHaveLength(2);
    expect(dialog).toMatch(
      /<DialogPrimitive\.Close render=\{<Button variant="outline" \/>\}>\s*关闭\s*<\/DialogPrimitive\.Close>/,
    );
    // 与 sheet 同款
    expect(read("src/components/ui/sheet.tsx")).toMatch(/sr-only">关闭</);
  });
});

describe("V15-01 流式 → 定稿：Streamdown 的 mode 不再切换，子树结构不再从数组变单元素", () => {
  /** 把 resolveStreamdownMode 的结果 + isAnimating 摊成 Streamdown props（与 MarkdownText 同款） */
  const propsFor = (streaming: boolean, hasStreamed: boolean) => {
    const m = resolveStreamdownMode(streaming, hasStreamed);
    return {
      mode: m.mode,
      parseIncompleteMarkdown: m.parseIncompleteMarkdown,
      isAnimating: streaming,
    };
  };

  describe("resolveStreamdownMode（纯判定）", () => {
    it("从没流式过：static，整篇一次解析（历史消息 / 产物栏 / 文件预览，开销与修前一致）", () => {
      expect(resolveStreamdownMode(false, false)).toEqual({
        mode: "static",
        parseIncompleteMarkdown: true,
        throttledCode: false,
      });
    });

    it("流式中：streaming、补全未闭合标记、限频高亮", () => {
      expect(resolveStreamdownMode(true, true)).toEqual({
        mode: "streaming",
        parseIncompleteMarkdown: true,
        throttledCode: true,
      });
      // 首帧就是流式（hasStreamed 由调用方在同一次渲染里置位，这里也容错 false）
      expect(resolveStreamdownMode(true, false).mode).toBe("streaming");
    });

    it("流式过的实例定稿（streaming=false）：mode 仍是 streaming，只关 parseIncompleteMarkdown、仍用流式代码插件", () => {
      expect(resolveStreamdownMode(false, true)).toEqual({
        mode: "streaming",
        parseIncompleteMarkdown: false,
        throttledCode: true,
      });
    });

    it("整条生命周期（挂载 → 流式 → 定稿 → 之后任意重渲）里 mode 至多切一次、定稿后不回头", () => {
      let hasStreamed = false;
      const modes: string[] = [];
      for (const streaming of [true, true, true, false, false, false]) {
        if (streaming) hasStreamed = true; // 与 MarkdownText 里的 ref 闩锁同款：只增不减
        modes.push(resolveStreamdownMode(streaming, hasStreamed).mode);
      }
      expect(modes).toEqual([
        "streaming",
        "streaming",
        "streaming",
        "streaming",
        "streaming",
        "streaming",
      ]);
    });
  });

  describe("子树结构（对照 streamdown 2.5.0 源码核实：static 返回单元素 child、streaming 返回数组 child）", () => {
    // 用最小的 hooks 桩直接调用 Streamdown 的函数体，拿到它返回的元素树（不挂载、不渲染），
    // 往下走到最外层 `div`，看它的 children 是「数组」还是「单个元素」。
    // 这是 React 协调的分界线：单元素 ↔ 数组 类型对不上就整棵删旧挂新。
    // 依赖 React 内部 dispatcher 槽位；上游 / React 升级后若桩不够用会直接抛错、提醒重新评估这条假设。
    const internals = (
      React as unknown as Record<string, { H: unknown } | undefined>
    ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

    const childShape = (props: Record<string, unknown>): "array" | "single" => {
      if (!internals) throw new Error("拿不到 React 内部 dispatcher，请更新这个测试的桩");
      const prev = internals.H;
      internals.H = {
        useId: () => "sd",
        useTransition: () => [false, (fn: () => void) => fn()],
        useMemo: (fn: () => unknown) => fn(),
        useRef: (v: unknown) => ({ current: v }),
        useEffect: () => {},
        useState: (v: unknown) => [
          typeof v === "function" ? (v as () => unknown)() : v,
          () => {},
        ],
        useCallback: (fn: unknown) => fn,
      };
      let tree: ReactElement;
      try {
        tree = (
          Streamdown as unknown as { type: (p: unknown) => ReactElement }
        ).type({ children: "# 标题\n\n段落\n\n```js\nx\n```", ...props });
      } finally {
        internals.H = prev;
      }
      // 一路沿 props.children 往下找最外层 div（前面全是 Context.Provider / 图标 Provider 包装）
      let node: ReactNode = tree;
      while (isValidElement(node) && node.type !== "div") {
        node = (node.props as { children?: ReactNode }).children;
      }
      if (!isValidElement(node)) throw new Error("没找到最外层 div");
      const children = (node.props as { children?: unknown }).children;
      return Array.isArray(children) ? "array" : "single";
    };

    it("【根因】上游 mode 一换，子树形状就变：static = 单元素、streaming = 数组", () => {
      expect(childShape({ mode: "static" })).toBe("single");
      expect(childShape({ mode: "streaming" })).toBe("array");
    });

    it("【修前】旧写法 mode={streaming ? 'streaming' : 'static'}：流式 → 定稿形状从数组切成单元素（= 整树重挂）", () => {
      const legacy = (streaming: boolean) => ({
        mode: streaming ? "streaming" : "static",
        isAnimating: streaming,
      });
      expect(childShape(legacy(true))).toBe("array");
      expect(childShape(legacy(false))).toBe("single");
    });

    it("【修后】流式 → 定稿：两个阶段 child 形状一致（都是数组），React 协调走同一条路径、不卸载重挂", () => {
      const during = childShape(propsFor(true, true));
      const after = childShape(propsFor(false, true));
      expect(during).toBe("array");
      expect(after).toBe(during);
    });

    it("从没流式过的实例保持 static（单元素），与修前完全一致", () => {
      expect(childShape(propsFor(false, false))).toBe("single");
    });
  });

  describe("定稿态的渲染结果不退化：与 static 逐元素一致", () => {
    const DOCS: Record<string, string> = {
      标题段落行内码:
        "# 标题\n\n段落 **粗** 与 *斜* 与 `code` 与 [链接](https://example.com/a)\n\n> 引用\n",
      围栏代码块: "前言\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n\n后记\n",
      有序列表含多段: "1. **标题一**\n\n   说明一\n\n2. **标题二**\n\n   说明二\n",
      表格: "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n",
      未闭合粗体: "结尾有个没闭合的 **粗体",
      波浪号: "范围 20~25 度",
    };

    for (const [name, doc] of Object.entries(DOCS)) {
      it(`${name}：流式过 → 定稿（mode=streaming、parseIncompleteMarkdown=false）的标记 = static 的标记`, () => {
        const fin = propsFor(false, true);
        expect(fin.mode).toBe("streaming");
        expect(norm(render(doc, fin))).toBe(
          norm(render(doc, { mode: "static" })),
        );
      });
    }

    it("定稿时必须关 parseIncompleteMarkdown：否则 remend 会把已完整的文本改写（未闭合 ** 被补成粗体）", () => {
      const doc = DOCS["未闭合粗体"]!;
      const staticHtml = norm(render(doc, { mode: "static" }));
      // 关掉：与 static 一致，保留字面量 **
      expect(norm(render(doc, propsFor(false, true)))).toBe(staticHtml);
      expect(staticHtml).toContain("**粗体");
      // 不关（mode 保持 streaming、parseIncompleteMarkdown 缺省 true）：被改写成粗体，与 static 不一致
      const withRemend = norm(
        render(doc, { mode: "streaming", isAnimating: false }),
      );
      expect(withRemend).not.toBe(staticHtml);
      expect(withRemend).toContain('data-streamdown="strong"');
    });
  });

  it("接线：MarkdownText 用 ref 闩锁「流式过」、由 resolveStreamdownMode 决定 mode / parseIncompleteMarkdown / 代码插件，且不再手写 streaming ? … : …", () => {
    expect(mdSource).toMatch(/const hasStreamedRef = useRef\(false\);/);
    expect(mdSource).toMatch(/if \(streaming\) hasStreamedRef\.current = true;/);
    expect(mdSource).toMatch(
      /resolveStreamdownMode\(!!streaming, hasStreamedRef\.current\)/,
    );
    expect(mdSource).toMatch(/mode=\{streamMode\.mode\}/);
    expect(mdSource).toMatch(
      /parseIncompleteMarkdown=\{streamMode\.parseIncompleteMarkdown\}/,
    );
    expect(mdSource).toMatch(/streamMode\.throttledCode\s*\?\s*STREAMDOWN_STREAMING_PLUGINS/);
    // isAnimating 仍单独跟 streaming
    expect(mdSource).toMatch(/isAnimating=\{streaming\}/);
    // 旧写法（mode 随 streaming 切换 / plugins 定稿时换回上游 code）不许回来
    expect(mdSource).not.toMatch(/mode=\{streaming \?/);
    expect(mdSource).not.toMatch(/plugins=\{streaming \?/);
  });

  it("三处旧注释已更正：不再断言「一个块都不重建 / 原地换 mode / 换回上游插件」", () => {
    const handoff = read("src/lib/stream-handoff.ts");
    const rows = read("src/components/tasks/event-stream/rows.tsx");
    expect(handoff).not.toContain("Streamdown 在原地从 streaming 模式切 static，已渲染的块一个都不重建");
    expect(handoff).toContain("管不到 Streamdown 内部");
    expect(rows).not.toContain("Streamdown 原地换 mode");
    expect(rows).not.toContain("正文原地从 streaming 切 static，不卸载 / 不重挂");
    expect(mdSource).not.toContain("流式结束后（streaming=false）换回上游插件");
  });
});
