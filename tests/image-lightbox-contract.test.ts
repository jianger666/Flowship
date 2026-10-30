/**
 * R14 B6-4 / Q19-02：图片灯箱（`ui/image-preview.tsx`）的几个「点不到 / Tab 不到 / 焦点丢了」问题。
 *
 *  ① 关闭键原来在 `top-4`（16px），而 Windows 的系统窗口按钮条（titleBarOverlay）高 56px、盖在网页内容上面——
 *    关闭键正好被它盖住、点不到（只剩 Esc / 点背景能关）。
 *  ② 灯箱盖在 header 的拖拽区（`-webkit-app-region: drag`）上；Electron 的拖拽区按像素矩形算、不看 z-index，
 *    灯箱根不显式 no-drag 的话，顶部那一条点了只会拖窗口。
 *  ③ 打开后焦点留在触发它的缩略图上（被遮住的页面里），键盘 / 读屏用户按 Tab 会乱跳，关闭后焦点也丢了。
 *  ④ markdown 里的图是 `<img onClick>`——键盘 Tab 不到、读屏也不报「可点」，灯箱对只用键盘的人整个不可达。
 *
 * 本仓没有 jsdom：结构用 `renderToStaticMarkup` 看真实输出，焦点逻辑用 `helpers/react-hook-stub` 的槽位桩
 * 让 effect / cleanup 真跑，系统按钮条的高度直接从 `electron-app/main.js` 里读（改了那边，这边自动跟着红）。
 * 真机行为（Windows 上点得到关闭键、macOS / Windows 的拖拽区）无法在 CI 验证，见 HANDOFF 的人工验收清单。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ImageLightbox,
  ImagePreviewProvider,
  MarkdownImage,
  type PreviewImage,
} from "@/components/ui/image-preview";

import { createHookHarness, type HookHarness } from "./helpers/react-hook-stub";
import { mainSrc } from "./helpers/main-slice";

type LightboxProps = ComponentProps<typeof ImageLightbox>;

const IMAGES: PreviewImage[] = [
  { src: "/a.png", alt: "第一张" },
  { src: "/b.png", alt: "第二张" },
];

const lightboxProps = (over: Partial<LightboxProps> = {}): LightboxProps => ({
  images: IMAGES,
  index: 0,
  onClose: () => {},
  onGo: () => {},
  ...over,
});

const lightboxHtml = (over: Partial<LightboxProps> = {}): string =>
  renderToStaticMarkup(createElement(ImageLightbox, lightboxProps(over)));

/**
 * 灯箱根元素的开标签。不能取「输出里的第一个标签」：React 19 对没写 `loading="lazy"` 的 <img>
 * 会在最前面多吐一个 `<link rel="preload" as="image" …/>` 资源提示。灯箱根就是第一个 <div>。
 */
const rootTag = (html: string): string => {
  const m = /<div\b[^>]*>/.exec(html);
  if (!m) throw new Error(`灯箱没有渲染出根元素：${html.slice(0, 80)}`);
  return m[0];
};

/** 取带指定 aria-label 的整个 <button …> 开标签 */
const buttonTag = (html: string, label: string): string => {
  const m = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html);
  if (!m) throw new Error(`没找到 aria-label="${label}" 的按钮：${html.slice(0, 200)}`);
  return m[0];
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------- ① 关闭键避开系统按钮条

/** main.js 里 `marker` 之后第一个 `height: N`（两处声明的 height 都紧跟在 marker 后几行内） */
const heightAfter = (marker: string): number => {
  const at = mainSrc.indexOf(marker);
  expect(at, `main.js 里应有「${marker}」`).toBeGreaterThan(-1);
  const m = /height:\s*(\d+)/.exec(mainSrc.slice(at, at + 600));
  expect(m, `「${marker}」之后 600 字符内应有 height: N`).not.toBeNull();
  return Number(m?.[1]);
};

describe("关闭键落在 Windows 系统窗口按钮条下面（Q19-02 ①）", () => {
  it("main.js 里创建窗口时的 titleBarOverlay 高度与运行时 IPC 同步的高度一致（否则下面的比较没有意义）", () => {
    const created = heightAfter("titleBarOverlay: {");
    const runtime = heightAfter('ipcMain.on("set-titlebar-overlay"');
    expect(created).toBeGreaterThan(0);
    expect(runtime).toBe(created);
  });

  it("关闭键的 top-N：N × 4px ≥ 系统按钮条高度（Tailwind 间距刻度 = 0.25rem，根字号 16px）", () => {
    const overlay = heightAfter("titleBarOverlay: {");
    const cls = /class="([^"]*)"/.exec(buttonTag(lightboxHtml(), "关闭"))?.[1] ?? "";
    const m = /(?:^|\s)top-(\d+)(?:\s|$)/.exec(cls);
    expect(m, `关闭键应写成 top-N（N 为 Tailwind 间距刻度），实际 class：${cls}`).not.toBeNull();
    expect(Number(m?.[1]) * 4).toBeGreaterThanOrEqual(overlay);
  });
});

// ---------------------------------------------------------------------- ②③ 容器

describe("灯箱容器：语义、拖拽区、可聚焦（Q19-02 ②）", () => {
  it("根是带名字的模态对话框：role=dialog / aria-modal / aria-label", () => {
    const tag = rootTag(lightboxHtml());
    expect(tag).toContain('role="dialog"');
    expect(tag).toContain('aria-modal="true"');
    expect(tag).toContain('aria-label="图片预览"');
  });

  it("根显式 no-drag（盖在 header 拖拽区上）、可程序聚焦（tabindex=-1）且聚焦时不画框", () => {
    const tag = rootTag(lightboxHtml());
    expect(tag).toContain("[-webkit-app-region:no-drag]");
    expect(tag).toContain('tabindex="-1"');
    expect(tag).toMatch(/class="[^"]*\boutline-none\b/);
  });

  it("焦点不放进关闭键：关闭键上没有 autofocus（空格键「打开」时松开会把刚开的灯箱又关掉）", () => {
    expect(lightboxHtml()).not.toMatch(/autofocus/i);
  });

  it("多图才有左右切换和计数；单图只有关闭键；没有图就不渲染", () => {
    const multi = lightboxHtml();
    expect(multi).toContain('aria-label="上一张"');
    expect(multi).toContain('aria-label="下一张"');
    expect(multi).toContain("1 / 2");
    const single = lightboxHtml({ images: [IMAGES[0]] });
    expect(single).toContain('aria-label="关闭"');
    expect(single).not.toContain("上一张");
    expect(single).not.toContain("下一张");
    expect(lightboxHtml({ images: [] })).toBe("");
  });

  it("层级：灯箱根的 z-N 高于弹窗层（base-ui dialog 约 z-50），从弹窗里点图也盖得住", () => {
    const cls = /class="([^"]*)"/.exec(rootTag(lightboxHtml()))?.[1] ?? "";
    const m = /(?:^|\s)z-(\d+)(?:\s|$)/.exec(cls);
    expect(m, `根应写成 z-N，实际 class：${cls}`).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(50);
  });

  it("大图：src / alt 取当前这一张；没有 alt 时 alt 写成空串（装饰图）", () => {
    const second = lightboxHtml({ index: 1 });
    expect(second).toContain('src="/b.png"');
    expect(second).toContain('alt="第二张"');
    expect(second).not.toContain('src="/a.png"');
    expect(lightboxHtml({ images: [{ src: "/c.png" }] })).toContain('alt=""');
  });

  it("Provider 没打开时不渲染灯箱", () => {
    const html = renderToStaticMarkup(
      createElement(ImagePreviewProvider, null, createElement("p", null, "正文")),
    );
    expect(html).toContain("正文");
    expect(html).not.toContain('role="dialog"');
  });
});

// ---------------------------------------------------------------------- 点击接线（SSR 看不到 onClick）

type El = ReactElement<Record<string, unknown>>;

/** 把渲染出的元素树拍平成元素列表（深度优先）；跳过 null / false / 文本 */
const flatten = (node: unknown, out: El[] = []): El[] => {
  if (Array.isArray(node)) {
    for (const c of node) flatten(c, out);
  } else if (node && typeof node === "object" && "props" in node) {
    const el = node as El;
    out.push(el);
    flatten(el.props.children, out);
  }
  return out;
};

describe("灯箱的点击接线：背景 / 关闭键 / 上一张 / 下一张 / 大图（取元素树上的处理器真调）", () => {
  const setup = (over: Partial<LightboxProps> = {}) => {
    const onClose = vi.fn();
    const onGo = vi.fn();
    vi.stubGlobal("document", { activeElement: null });
    const h = createHookHarness();
    const root = h.render(() => ImageLightbox(lightboxProps({ onClose, onGo, ...over })));
    if (!root) throw new Error("灯箱没渲染出来");
    const els = flatten(root);
    const labelled = (label: string): El => {
      const el = els.find((e) => e.props["aria-label"] === label);
      if (!el) throw new Error(`没找到 aria-label="${label}" 的元素`);
      return el;
    };
    return { root: root as El, els, labelled, onClose, onGo };
  };
  /** 用假事件对象点一下，返回那个事件（看它的 stopPropagation 有没有被调） */
  const click = (el: El) => {
    const e = { stopPropagation: vi.fn() };
    (el.props.onClick as (ev: unknown) => void)(e);
    return e;
  };

  it("点背景（灯箱根）关闭", () => {
    const { root, onClose, onGo } = setup();
    click(root);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onGo).not.toHaveBeenCalled();
  });

  it("关闭键：自己的 onClick 就关闭（不靠冒泡到根）", () => {
    const { labelled, onClose } = setup();
    click(labelled("关闭"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("上一张 / 下一张：往前 / 往后切一张，并拦住冒泡（不拦的话这一下点击会冒泡到背景、把灯箱关掉）", () => {
    const { labelled, onClose, onGo } = setup();
    const prev = click(labelled("上一张"));
    expect(onGo).toHaveBeenLastCalledWith(-1);
    expect(prev.stopPropagation).toHaveBeenCalledTimes(1);
    const next = click(labelled("下一张"));
    expect(onGo).toHaveBeenLastCalledWith(1);
    expect(next.stopPropagation).toHaveBeenCalledTimes(1);
    expect(onGo).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("点大图本身不关：拦住冒泡，也不调 onClose / onGo", () => {
    const { els, onClose, onGo } = setup();
    const img = els.find((e) => e.type === "img");
    if (!img) throw new Error("没找到大图");
    const e = click(img);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onGo).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------- ③ 焦点管理

/** 真跑一次灯箱 render，把测试的假节点塞进根的 ref（没有真 DOM，ref 不会被 React 填） */
const renderLightbox = (
  h: HookHarness,
  props: LightboxProps,
  rootNode?: { focus: () => void },
): void => {
  const el = h.render(() => ImageLightbox(props));
  if (!el) throw new Error("灯箱没渲染出来");
  const ref = (el as ReactElement<{ ref: { current: unknown } }>).props.ref;
  if (rootNode) ref.current = rootNode;
};

describe("焦点管理：打开时移进灯箱、关闭时还给触发它的元素（Q19-02 ③）", () => {
  it("挂载时聚焦灯箱容器（不动触发元素）；左右切图不抢焦点；卸载时把焦点还给触发元素", () => {
    const trigger = { isConnected: true, focus: vi.fn() };
    vi.stubGlobal("document", { activeElement: trigger });
    const rootFocus = vi.fn();
    const h = createHookHarness();

    renderLightbox(h, lightboxProps(), { focus: rootFocus });
    h.flushEffects();
    expect(rootFocus).toHaveBeenCalledTimes(1);
    expect(trigger.focus).not.toHaveBeenCalled();

    // 切到第二张：还是同一个灯箱实例，effect 不该重跑（否则 cleanup 会把焦点提前还回去、再抢回来）
    renderLightbox(h, lightboxProps({ index: 1 }));
    h.flushEffects();
    expect(rootFocus).toHaveBeenCalledTimes(1);
    expect(trigger.focus).not.toHaveBeenCalled();

    h.unmount();
    expect(trigger.focus).toHaveBeenCalledTimes(1);
    expect(rootFocus).toHaveBeenCalledTimes(1);
  });

  it("触发元素已经不在页面上（被重渲染掉了）：不还焦点、也不抛", () => {
    const trigger = { isConnected: false, focus: vi.fn() };
    vi.stubGlobal("document", { activeElement: trigger });
    const h = createHookHarness();
    renderLightbox(h, lightboxProps(), { focus: vi.fn() });
    h.flushEffects();
    expect(() => h.unmount()).not.toThrow();
    expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("打开前页面上没有焦点元素（activeElement 为 null）、或灯箱根还没挂上：照常工作不抛", () => {
    vi.stubGlobal("document", { activeElement: null });
    const h = createHookHarness();
    renderLightbox(h, lightboxProps()); // 不塞 root 节点：ref.current 仍是 null
    expect(() => h.flushEffects()).not.toThrow();
    expect(() => h.unmount()).not.toThrow();
  });

  it("记下的是「打开那一刻」的焦点元素，不是关闭时的", () => {
    const opener = { isConnected: true, focus: vi.fn() };
    const other = { isConnected: true, focus: vi.fn() };
    const doc = { activeElement: opener as unknown };
    vi.stubGlobal("document", doc);
    const h = createHookHarness();
    renderLightbox(h, lightboxProps(), { focus: vi.fn() });
    h.flushEffects();
    doc.activeElement = other; // 灯箱开着期间焦点挪到了别处（比如点了灯箱里的按钮）
    h.unmount();
    expect(opener.focus).toHaveBeenCalledTimes(1);
    expect(other.focus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------- ④ MarkdownImage

const markdownImageHtml = (props: ComponentProps<typeof MarkdownImage>): string =>
  renderToStaticMarkup(
    createElement(ImagePreviewProvider, null, createElement(MarkdownImage, props)),
  );

describe("markdown 里的图：点开大图的是真按钮（Q19-02 ④）", () => {
  it("<button type=button> 包着 <img>，名字带上图的 alt", () => {
    const html = markdownImageHtml({ src: "https://example.com/a.png", alt: "登录页截图" });
    const btn = buttonTag(html, "查看大图:登录页截图");
    expect(btn).toContain('type="button"');
    // img 在按钮里面，不再自己是点击目标
    const open = html.indexOf(btn);
    const img = html.indexOf("<img", open);
    const close = html.indexOf("</button>", open);
    expect(img).toBeGreaterThan(open);
    expect(img).toBeLessThan(close);
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('alt="登录页截图"');
  });

  it("没有 alt 时名字退回「查看大图」；img 是装饰（alt 为空）", () => {
    const html = markdownImageHtml({ src: "https://example.com/a.png" });
    expect(html).toContain('aria-label="查看大图"');
    expect(html).not.toContain("查看大图:");
    expect(html).toContain('alt=""');
  });

  it("src 为空 / 不是字符串：不渲染按钮（沿用原行为）", () => {
    expect(markdownImageHtml({ src: "" })).toBe("");
    expect(markdownImageHtml({ src: undefined })).toBe("");
  });

  it("样式分工：按钮负责「可点」（cursor-zoom-in、整块、不超宽），img 保留原有外观且不再带 cursor-zoom-in", () => {
    const html = markdownImageHtml({ src: "https://example.com/a.png", alt: "示意图" });
    const classesOf = (tag: string): string[] => (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);
    const btn = classesOf(buttonTag(html, "查看大图:示意图"));
    for (const c of ["block", "w-fit", "max-w-full", "cursor-zoom-in"]) expect(btn, `按钮缺 ${c}`).toContain(c);
    const img = classesOf(/<img[^>]*>/.exec(html)?.[0] ?? "");
    for (const c of ["my-2", "max-h-80", "max-w-full", "rounded-md", "border", "object-contain"]) {
      expect(img, `图片缺 ${c}`).toContain(c);
    }
    expect(img).not.toContain("cursor-zoom-in");
  });
});

// ---------------------------------------------------------------------- 源码契约（SSR 看不到事件处理器和打开态）

const IMAGE_PREVIEW_SRC = readFileSync(
  path.resolve(import.meta.dirname, "..", "src/components/ui/image-preview.tsx"),
  "utf8",
);

/** 在名为 `scope` 的顶层 const 里找所有 `<tag …>`，返回各自的属性名（按书写顺序） */
const attrNamesIn = (scope: string, tag: string): string[][] => {
  const sf = ts.createSourceFile("image-preview.tsx", IMAGE_PREVIEW_SRC, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[][] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const open = ts.isJsxElement(n) ? n.openingElement : n;
      if (open.tagName.getText() === tag) {
        out.push(open.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText()));
      }
    }
    ts.forEachChild(n, visit);
  };
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => d.name.getText() === scope)) {
      visit(st);
    }
  }
  return out;
};

describe("源码契约：渲染结果里看不到的接线（Q19-02）", () => {
  it("MarkdownImage：onClick 挂在 <button> 上，<img> 上没有（点击目标是按钮，不是图片）", () => {
    const buttons = attrNamesIn("MarkdownImage", "button");
    const imgs = attrNamesIn("MarkdownImage", "img");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toEqual(expect.arrayContaining(["type", "onClick", "aria-label", "className"]));
    // 两个 <img>：button 里的那个没有 onClick；「外层已是链接 / 按钮」分支（InsideInteractive，链接里套图）里的那个自带 onClick——
    // 那里不能再套 button（见 tests/markdown-image-nesting.test.ts）
    expect(imgs).toHaveLength(2);
    expect(imgs.filter((a) => a.includes("onClick"))).toHaveLength(1);
    expect(imgs.filter((a) => !a.includes("onClick"))).toHaveLength(1);
  });

  it("Provider 只在有预览态时渲染 ImageLightbox，并把 images / index / onClose / onGo 接上", () => {
    expect(attrNamesIn("ImagePreviewProvider", "ImageLightbox")).toEqual([["images", "index", "onClose", "onGo"]]);
    const at = IMAGE_PREVIEW_SRC.indexOf("export const ImagePreviewProvider");
    const end = IMAGE_PREVIEW_SRC.indexOf("interface ImageThumbProps");
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    expect(IMAGE_PREVIEW_SRC.slice(at, end)).toMatch(/\{state && \(\s*<ImageLightbox\b/);
  });
});
