/**
 * 预览窗各 viewer 的 SSR 冒烟：每个组件在「典型数据」和「边界数据」下都能渲染出预期的骨架（工具栏文案 / 页签 / 提示条）。
 *
 * 诚实声明：node 环境没有 DOM / 布局引擎 / 浏览器 —— Virtuoso 在这里量不出尺寸，所以虚拟列表里的「行」不会出现在静态标记里；
 * 滚动、拖拽、缩放手感、粘性表头、Esc 冒泡、CSS Highlight 绘制、编辑器光标等都**没有**在这里验证（需要真机 / Electron 肉眼过）。
 * 这里只证明：组件不会在服务端 / 首帧抛错、不同数据走对分支、关键文案与可访问性属性在。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArchiveViewer } from "@/components/preview/archive-viewer";
import { CodeViewer, type CodeViewerProps } from "@/components/preview/code-viewer";
import { CsvViewer } from "@/components/preview/csv-viewer";
import { ImageViewer } from "@/components/preview/image-viewer";
import { JsonViewer } from "@/components/preview/json-viewer";
import { MarkdownViewer } from "@/components/preview/markdown-viewer";
import { SlidesViewer } from "@/components/preview/slides-viewer";
import { SvgViewer } from "@/components/preview/svg-viewer";
import { TableViewer } from "@/components/preview/table-viewer";
import { LocalFilePreviewBody } from "@/components/ui/local-file-preview-body";
import { DialogProvider } from "@/hooks/use-dialog";
import type { LocalFilePreviewPayload, PreviewTable } from "@/lib/preview/types";

const noop = () => {};

const codeProps = (over: Partial<CodeViewerProps> = {}): CodeViewerProps => ({
  path: "/tmp/demo.ts",
  ext: "ts",
  text: "const a = 1;\nconst b = 2;\n",
  size: 26,
  mtimeMs: 1_700_000_000_000,
  eol: "lf",
  bom: false,
  editable: true,
  resetKey: 0,
  onDirtyChange: noop,
  onSaved: noop,
  onRequestReload: noop,
  ...over,
});

/** 这些 viewer 里有 useDialog（confirm）→ 必须在 DialogProvider 里渲染，与真实挂载位置一致 */
const render = (el: ReturnType<typeof createElement>): string =>
  renderToStaticMarkup(createElement(DialogProvider, null, el));

const table = (over: Partial<PreviewTable> = {}): PreviewTable => ({
  rows: [
    ["name", "qty"],
    ["apple", "3"],
    ["pear", "12"],
  ],
  totalRows: 3,
  totalCols: 2,
  truncatedRows: false,
  truncatedCols: false,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CodeViewer", () => {
  it("可编辑：显示行数 / 大小 / 换行与编码，带「编辑」按钮", () => {
    const html = render(createElement(CodeViewer, codeProps()));
    expect(html).toContain("3 行"); // 末尾换行多出一个空行：与行号口径一致
    expect(html).toContain("LF · UTF-8");
    expect(html).toContain("编辑");
    expect(html).not.toContain("只读");
    expect(html).toContain('aria-label="查找"');
    expect(html).toContain('aria-label="自动换行"');
  });

  it("不可编辑：显示「只读」徽标而不是编辑按钮", () => {
    const html = render(createElement(CodeViewer, codeProps({ editable: false, editBlockedReason: "这个文件在受保护目录里" })));
    expect(html).toContain("只读");
    expect(html).not.toMatch(/>\s*编辑\s*</);
  });

  it("CRLF / BOM / 混合换行都标出来", () => {
    expect(render(createElement(CodeViewer, codeProps({ eol: "crlf", bom: true })))).toContain("CRLF · UTF-8 BOM");
    expect(render(createElement(CodeViewer, codeProps({ eol: "mixed", editable: false })))).toContain("混合换行");
  });

  it("截断：底部给出说明；tail 模式说明只显示了末尾", () => {
    // tail 模式让 Virtuoso 带 initialTopMostItemIndex（用到 rAF）；node 没有 rAF，补一个空实现（真实环境这个组件只在浏览器里挂载）
    vi.stubGlobal("requestAnimationFrame", () => 0);
    expect(render(createElement(CodeViewer, codeProps({ truncated: true })))).toContain("只显示了前面一部分");
    expect(render(createElement(CodeViewer, codeProps({ truncated: true, tail: true, ext: "log" })))).toContain("只显示了末尾部分");
  });

  it("超过着色上限：提示已关闭语法着色", () => {
    const big = "x".repeat(160_000);
    expect(render(createElement(CodeViewer, codeProps({ text: big, size: big.length })))).toContain("已关闭语法着色");
  });

  it("空文件也能渲染", () => {
    expect(() => render(createElement(CodeViewer, codeProps({ text: "", size: 0 })))).not.toThrow();
  });
});

describe("JsonViewer", () => {
  it("合法 JSON：默认树视图，带 树 / 源码 页签与「个可见节点」计数", () => {
    const text = JSON.stringify({ a: 1, b: { c: [1, 2, 3] } });
    const html = render(createElement(JsonViewer, codeProps({ ext: "json", text, size: text.length })));
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/aria-selected="true"[^>]*>树</);
    expect(html).toContain("个可见节点");
    expect(html).toContain('aria-label="展开全部"');
  });

  it("语法错误：只剩源码视图并说明原因", () => {
    const html = render(createElement(JsonViewer, codeProps({ ext: "json", text: "{ nope", size: 6 })));
    expect(html).toContain("无法解析为树");
    expect(html).not.toContain("个可见节点");
  });

  it("文件被截断：不尝试解析", () => {
    const html = render(createElement(JsonViewer, codeProps({ ext: "json", text: '{"a":', truncated: true })));
    expect(html).toContain("只载入了前面一部分");
  });
});

describe("TableViewer / CsvViewer", () => {
  it("行列统计、过滤框、首行表头开关", () => {
    const html = render(createElement(TableViewer, { table: table() }));
    expect(html).toContain("2 行 × 2 列");
    expect(html).toContain('aria-label="过滤行"');
    expect(html).toContain("首行当作表头");
  });

  it("多 sheet：渲染工作表页签并标出当前页", () => {
    const html = render(
      createElement(TableViewer, { table: table(), sheetNames: ["汇总", "明细"], sheetIndex: 1, onSelectSheet: noop }),
    );
    expect(html).toContain('aria-label="工作表"');
    expect(html).toMatch(/aria-selected="true"[^>]*>明细</);
    expect(html).toMatch(/aria-selected="false"[^>]*>汇总</);
  });

  it("单 sheet 不显示页签；切换中显示「切换中…」", () => {
    expect(render(createElement(TableViewer, { table: table(), sheetNames: ["Sheet1"] }))).not.toContain('aria-label="工作表"');
    expect(render(createElement(TableViewer, { table: table(), sheetLoading: true }))).toContain("切换中…");
  });

  it("截断提示带总数；空表有说明", () => {
    const html = render(
      createElement(TableViewer, {
        table: table({ totalRows: 50_000, truncatedRows: true, totalCols: 300, truncatedCols: true }),
      }),
    );
    expect(html).toContain("共 50,000 行");
    expect(html).toContain("共 300 列");
    expect(render(createElement(TableViewer, { table: table({ rows: [], totalRows: 0, totalCols: 0 }) }))).toContain("这张表是空的");
  });

  it("CSV：有 table 时默认表格视图 + 表格 / 源码页签；没有 table 只给源码", () => {
    const withTable = render(createElement(CsvViewer, { ...codeProps({ ext: "csv", text: "a,b\n1,2" }), table: table({ delimiter: "," }) }));
    expect(withTable).toMatch(/aria-selected="true"[^>]*>表格</);
    expect(withTable).toContain("分隔符 ,");
    const noTable = render(createElement(CsvViewer, codeProps({ ext: "csv", text: "a,b\n1,2" })));
    expect(noTable).toContain("只提供源码视图");
  });
});

describe("MarkdownViewer / SvgViewer", () => {
  it("markdown：预览 / 源码页签；front matter 显示成属性卡且不进正文", () => {
    const text = "---\nname: demo\nowner: me\n---\n\n# 标题\n\n正文";
    const html = render(createElement(MarkdownViewer, codeProps({ ext: "md", text, size: text.length })));
    expect(html).toMatch(/aria-selected="true"[^>]*>预览</);
    expect(html).toContain("属性（2）");
    expect(html).toContain("owner");
    expect(html).toContain("标题");
    expect(html).not.toContain("name: demo");
  });

  it("svg：渲染不了（被截断 / 空）时只给源码视图", () => {
    expect(render(createElement(SvgViewer, codeProps({ ext: "svg", text: "<svg", truncated: true })))).toContain("只提供源码视图");
    expect(render(createElement(SvgViewer, codeProps({ ext: "svg", text: "  " })))).toContain("只提供源码视图");
  });

  it("svg：可渲染时首帧是占位（blob URL 在 effect 里生成），不闪源码视图", () => {
    const html = render(createElement(SvgViewer, codeProps({ ext: "svg", text: "<svg xmlns='http://www.w3.org/2000/svg'/>" })));
    expect(html).not.toContain("行"); // 没渲染 CodeViewer 的工具栏
  });
});

describe("ImageViewer", () => {
  it("渲染 <img>（src 原样来自调用方）与缩放 / 旋转 / 棋盘格工具", () => {
    const html = render(createElement(ImageViewer, { src: "/api/local-image?path=%2Ftmp%2Fa.png&v=1", alt: "a.png", size: 2048 }));
    expect(html).toContain('src="/api/local-image?path=%2Ftmp%2Fa.png&amp;v=1"');
    expect(html).toContain("2.00 KB");
    for (const label of ["缩小", "放大", "适应窗口", "实际大小（100%）", "向左旋转 90°", "向右旋转 90°"]) {
      expect(html).toContain(`aria-label="${label}`);
    }
    // 图片加载完成前先隐藏，避免以 100% 闪一下再缩到适应窗口
    expect(html).toContain("visibility:hidden");
  });
});

describe("SlidesViewer / ArchiveViewer", () => {
  const slides = [
    { index: 1, title: "开场", paragraphs: [{ text: "要点一", level: 0 }, { text: "子要点", level: 1 }], notes: "先讲背景", pictureCount: 2 },
    { index: 2, title: "", paragraphs: [{ text: "只有正文", level: 0 }], notes: "", pictureCount: 0 },
  ];

  it("幻灯片：当前页标题 / 要点 / 备注 / 图片数，页列表里没标题的页用首段文字", () => {
    const html = render(createElement(SlidesViewer, { slides, slideCount: 2 }));
    expect(html).toContain("第 1 / 2 页");
    expect(html).toContain("开场");
    expect(html).toContain("要点一");
    expect(html).toContain("子要点");
    expect(html).toContain("先讲背景");
    expect(html).toContain("2 个图片 / 图表");
    expect(html).toContain("只有正文"); // 第二页在左侧列表里的标签
    expect(html).toContain("文字大纲（不含版式）");
  });

  it("幻灯片：被截断时提示总页数；一页都没有也能渲染", () => {
    expect(render(createElement(SlidesViewer, { slides, slideCount: 500 }))).toContain("共 500 页");
    expect(render(createElement(SlidesViewer, { slides: [], slideCount: 0 }))).toContain("没有可显示的幻灯片");
  });

  it("压缩包：汇总行 + 过滤框；条目被截断时提示", () => {
    const entries = [
      { name: "src/", size: 0, compressedSize: 0, isDir: true },
      { name: "src/a.ts", size: 2000, compressedSize: 800, isDir: false },
      { name: "README.md", size: 100, compressedSize: 90, isDir: false },
    ];
    const html = render(createElement(ArchiveViewer, { entries, entryCount: 3 }));
    expect(html).toContain("2 个文件");
    expect(html).toContain("解压后");
    expect(html).toContain('aria-label="按路径过滤"');
    expect(render(createElement(ArchiveViewer, { entries, entryCount: 9000, entriesTruncated: true }))).toContain("共 9,000 个");
    expect(render(createElement(ArchiveViewer, { entries: [] }))).toContain("压缩包是空的");
  });
});

describe("LocalFilePreviewBody 按类型分发", () => {
  const base = (over: Partial<LocalFilePreviewPayload>): LocalFilePreviewPayload => ({
    kind: "code",
    absolutePath: "/tmp/demo.ts",
    ext: "ts",
    size: 10,
    mtimeMs: 1,
    previewable: true,
    ...over,
  });
  const body = (data: LocalFilePreviewPayload | null, extra: Record<string, unknown> = {}) =>
    render(createElement(LocalFilePreviewBody, { data, loading: false, error: null, ...extra }));

  it("加载中 / 出错 / 不可预览（带具体原因）", () => {
    expect(render(createElement(LocalFilePreviewBody, { data: null, loading: true, error: null }))).toContain("加载中");
    expect(render(createElement(LocalFilePreviewBody, { data: null, loading: false, error: "炸了" }))).toContain("炸了");
    const html = body(base({ kind: "pptx", ext: "ppt", previewable: false, reason: "旧版 .ppt 格式不支持预览" }));
    expect(html).toContain("旧版 .ppt 格式不支持预览");
    expect(html).toContain("用系统应用打开");
  });

  it("静默刷新时（有旧内容 + loading=true）不退回加载中，旧内容保留", () => {
    const html = render(
      createElement(LocalFilePreviewBody, {
        data: base({ text: "keep me", size: 7, editable: true }),
        loading: true,
        error: null,
      }),
    );
    expect(html).not.toContain("加载中");
  });

  it("各类型走各自的 viewer", () => {
    expect(body(base({ text: "x", editable: true }))).toContain("LF · UTF-8");
    expect(body(base({ kind: "code", ext: "json", text: '{"a":1}' }))).toContain("个可见节点");
    expect(body(base({ kind: "markdown", ext: "md", text: "# hi" }))).toMatch(/aria-selected="true"[^>]*>预览</);
    expect(body(base({ kind: "csv", ext: "csv", text: "a,b", table: table() }))).toMatch(/aria-selected="true"[^>]*>表格</);
    expect(body(base({ kind: "xlsx", ext: "xlsx", table: table(), sheetNames: ["A", "B"], sheetIndex: 0 }))).toContain('aria-label="工作表"');
    expect(body(base({ kind: "pptx", ext: "pptx", slides: [{ index: 1, title: "T", paragraphs: [], notes: "", pictureCount: 0 }], slideCount: 1 }))).toContain("第 1 / 1 页");
    expect(body(base({ kind: "archive", ext: "zip", entries: [{ name: "a.txt", size: 1, compressedSize: 1, isDir: false }], entryCount: 1 }))).toContain("1 个文件");
    expect(body(base({ kind: "image", ext: "png", mediaPath: "/api/local-image?path=%2Fa.png" }))).toContain("/api/local-image?path=%2Fa.png&amp;v=1");
  });

  it("docx：净化后的 HTML 进文档外框；脚本不会出现", () => {
    const html = body(base({ kind: "docx", ext: "docx", html: "<h1>标题</h1><p>正文</p><script>alert(1)</script>" }));
    expect(html).toContain("标题");
    expect(html).toContain("正文");
    expect(html).not.toContain("<script");
  });

  it("缺必要字段（例如 xlsx 没有 table）→ 退回通用不可预览提示，不白屏", () => {
    expect(body(base({ kind: "xlsx", ext: "xlsx" }))).toContain("无法在此预览此类型文件");
  });

  it("html 不在预览窗里渲染（交给系统浏览器）：真走到预览窗时只当源码看，不出现 iframe / 渲染后的标题", () => {
    const html = body(base({ kind: "code", ext: "html", text: "<h1>渲染后才会看到的标题</h1>" }));
    expect(html).toContain("LF · UTF-8"); // 源码查看器的工具栏
    expect(html).not.toContain("<iframe");
  });
});
