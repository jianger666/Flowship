/**
 * R7-10：文件预览窗的图片查看器（`ImageViewer`）加「复制图片」——工具栏按钮 / 图片区右键菜单 / 聚焦时 ⌘C·Ctrl+C。
 *
 * 本仓没有 jsdom：结构用 `renderToStaticMarkup` 看真实输出；事件接线用 `helpers/react-hook-stub` 在受控 dispatcher 下真跑
 * 组件函数体（拿到的是元素树 + 当时的处理器闭包），再把元素树上的 onClick / onKeyDown / onPointerDown 真调一遍。
 * 真 Chromium 里的行为（真右键、Esc、菜单层级、剪贴板里到底有没有图）在 `scripts/browser-e2e/r7-image-viewer-copy.cjs`。
 *
 * 复制的落地（canvas / 剪贴板）在 `tests/copy-image.test.ts`；这里 mock 掉 `@/lib/copy-image`，只看 ImageViewer 怎么接线。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImageViewer, type ImageViewerProps } from "@/components/preview/image-viewer";
import { FindBar, ToolButton } from "@/components/preview/preview-ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useCanCopyImage } from "@/hooks/use-can-copy-image";
import { canCopyImage, copyImageToClipboard } from "@/lib/copy-image";

import { deferred } from "./helpers/deferred";
import { createHookHarness } from "./helpers/react-hook-stub";

vi.mock("@/lib/copy-image", () => ({ copyImageToClipboard: vi.fn(), canCopyImage: vi.fn(() => true) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SRC = "/api/local-image?path=%2Ftmp%2Fa.jpg&v=1700000000000";

type El = ReactElement<Record<string, unknown>>;

/** 把元素树拍平（深度优先）。不只走 children——`PreviewToolbar` 的 left / right、Trigger 的 render 里也藏着元素 */
const walk = (node: unknown, out: El[] = []): El[] => {
  if (Array.isArray(node)) {
    for (const c of node) walk(c, out);
  } else if (isValidElement(node)) {
    const el = node as El;
    out.push(el);
    for (const v of Object.values(el.props)) if (Array.isArray(v) || isValidElement(v)) walk(v, out);
  }
  return out;
};

/** 在受控 hook dispatcher 下渲染 ImageViewer；`rerender()` 读最新状态（桩里 setState 不会自动重渲，和真 React 一样看快照） */
const mount = (over: Partial<ImageViewerProps> = {}) => {
  const props: ImageViewerProps = { src: SRC, alt: "a.jpg", size: 2048, ...over };
  const h = createHookHarness();
  let els: El[] = [];
  const rerender = () => {
    els = walk(h.render(() => ImageViewer(props)));
  };
  rerender();
  const need = (what: string, el: El | undefined): El => {
    if (!el) throw new Error(`元素树里没找到：${what}`);
    return el;
  };
  const api = {
    h,
    rerender,
    /** 当前整棵（拍平的）元素树 */
    all: () => els,
    el: {
      copyButton: () => need("复制图片按钮", els.find((e) => e.type === ToolButton && e.props.label === "复制图片")),
      toolButton: (label: string) => need(`${label} 按钮`, els.find((e) => e.type === ToolButton && e.props.label === label)),
      trigger: () => need("ContextMenuTrigger", els.find((e) => e.type === ContextMenuTrigger)),
      content: () => need("ContextMenuContent", els.find((e) => e.type === ContextMenuContent)),
      item: () => need("ContextMenuItem", els.find((e) => e.type === ContextMenuItem)),
      img: () => need("<img>", els.find((e) => e.type === "img")),
      /** 图片区：Trigger 的 render 元素（ref / 键盘 / 拖拽处理器都挂在它上面） */
      box: () => need("图片区", walk(api.el.trigger().props.render).find((e) => e.props.tabIndex === 0)),
    },
    /** 触发 <img> 的 onLoad（`naturalWidth/Height` 由参数决定；0 = 没有固有尺寸的 SVG） */
    load: (w = 2250, hgt = 1494) => {
      (api.el.img().props.onLoad as (e: unknown) => void)({ currentTarget: { naturalWidth: w, naturalHeight: hgt } });
      rerender();
    },
    loadFail: () => {
      (api.el.img().props.onError as () => void)();
      rerender();
    },
    click: () => (api.el.copyButton().props.onClick as () => void)(),
    menuClick: () => (api.el.item().props.onClick as () => void)(),
    /** 菜单栏「编辑 ▸ 拷贝」（webContents.copy()）派发给图片区的 copy 事件 */
    copyEvent: () => {
      const e = { preventDefault: vi.fn() };
      (api.el.box().props.onCopy as (ev: unknown) => void)(e);
      return e;
    },
    key: (init: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => {
      const e = {
        key: "",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...init,
        preventDefault: vi.fn(),
      };
      (api.el.box().props.onKeyDown as (ev: unknown) => void)(e);
      return e;
    },
  };
  return api;
};

const ssr = (over: Partial<ImageViewerProps> = {}): string =>
  renderToStaticMarkup(createElement(ImageViewer, { src: SRC, alt: "a.jpg", size: 2048, ...over }));

/** 取带指定 aria-label 的 <button …> 开标签 */
const buttonTag = (html: string, label: string): string => {
  const m = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html);
  if (!m) throw new Error(`没找到 aria-label="${label}" 的按钮：${html.slice(0, 300)}`);
  return m[0];
};

beforeEach(() => {
  vi.mocked(copyImageToClipboard).mockReset().mockResolvedValue(undefined);
  vi.mocked(canCopyImage).mockReset().mockReturnValue(true);
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------- 结构

describe("结构：工具栏按钮 + 图片区右键菜单", () => {
  it("工具栏有 aria-label=「复制图片」的按钮（排在棋盘格之后、与旋转 / 棋盘格同一组）", () => {
    const html = ssr();
    expect(buttonTag(html, "复制图片")).toContain('type="button"');
    // 与旋转 / 棋盘格同一排：在「棋盘格背景」之后、图片区之前
    const at = (needle: string) => html.indexOf(needle);
    expect(at('aria-label="复制图片"')).toBeGreaterThan(at('aria-label="棋盘格背景（看透明区域）"'));
    expect(at('aria-label="复制图片"')).toBeGreaterThan(at('aria-label="向右旋转 90°"'));
    expect(at('aria-label="复制图片"')).toBeLessThan(at("<img"));
  });

  it("按钮是 ToolButton，label=复制图片，图标是 lucide 的 Copy", () => {
    const m = mount();
    const btn = m.el.copyButton();
    expect(btn.props.label).toBe("复制图片");
    expect((btn.props.children as El).type).toBe(Copy);
  });

  it("图片区整块被 ContextMenu 包住（Trigger 的 render 就是带 tabIndex / 键盘 / 拖拽处理器的那个 div），<img> 在里面", () => {
    const m = mount();
    const tree = walk(m.h.render(() => ImageViewer({ src: SRC, alt: "a.jpg" })));
    expect(tree.some((e) => e.type === ContextMenu)).toBe(true);
    const box = m.el.box();
    expect(box.type).toBe("div");
    for (const k of ["onKeyDown", "onPointerDown", "onPointerMove", "onPointerUp", "onPointerCancel", "onDoubleClick"]) {
      expect(typeof box.props[k], k).toBe("function");
    }
    // 整块（boxRef 那个 div）而不是只包 <img>：img 是 Trigger 的子孙，Trigger 自己就是图片区
    expect(walk(m.el.trigger().props.children).some((e) => e.type === "img")).toBe(true);
    expect(String(box.props.className)).toContain("flex-1");
  });

  it("菜单只有一项「复制图片」（Copy 图标），菜单弹层不在图片区子树里（点菜单碰不到图片区的双击 / 拖拽）", () => {
    const m = mount();
    const itemKids = walk(m.el.item().props.children);
    expect(itemKids.some((e) => e.type === Copy)).toBe(true);
    expect(JSON.stringify(m.el.item().props.children)).toContain("复制图片");
    expect(walk(m.el.content().props.children).filter((e) => e.type === ContextMenuItem)).toHaveLength(1);
    // Content 是 Trigger 的兄弟：既不在 Trigger.children 里，也不在 Trigger.render（图片区 div）里
    const inTrigger = [...walk(m.el.trigger().props.children), ...walk(m.el.trigger().props.render)];
    expect(inTrigger.some((e) => e.type === ContextMenuContent || e.type === ContextMenuItem)).toBe(false);
  });

  it("菜单层级高过预览弹窗（dialog.tsx 外层 fixed 容器的 z-N）", () => {
    const dialogSrc = readFileSync(path.resolve(import.meta.dirname, "..", "src/components/ui/dialog.tsx"), "utf8");
    const dialogZ = Number(/fixed inset-0 z-(\d+) grid place-items-center/.exec(dialogSrc)?.[1]);
    expect(dialogZ, "dialog.tsx 里应有外层 fixed inset-0 z-N grid place-items-center 容器").toBeGreaterThan(0);
    const m = mount();
    const menuZ = Number(/(?:^|\s)z-(\d+)(?:\s|$)/.exec(String(m.el.content().props.positionerClassName))?.[1]);
    expect(menuZ).toBeGreaterThan(dialogZ);
  });
});

// ---------------------------------------------------------------------- 三条入口都复制「ImageViewer 收到的那个 src」

describe("复制：按钮 / 菜单项 / ⌘C·Ctrl+C 都以收到的 src 原样调用 copyImageToClipboard", () => {
  it("点工具栏按钮", () => {
    const m = mount();
    m.load();
    m.click();
    expect(copyImageToClipboard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(copyImageToClipboard).mock.calls[0]![0]).toBe(SRC);
  });

  it("点右键菜单项", () => {
    const m = mount();
    m.load();
    m.menuClick();
    expect(copyImageToClipboard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(copyImageToClipboard).mock.calls[0]![0]).toBe(SRC);
  });

  it("⌘C 与 Ctrl+C（平台未知 / 非 mac：meta 与 ctrl 都认）；命中时 preventDefault", () => {
    for (const init of [{ metaKey: true }, { ctrlKey: true }]) {
      const m = mount();
      m.load();
      const e = m.key({ key: "c", ...init });
      expect(e.preventDefault, JSON.stringify(init)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(copyImageToClipboard).mock.calls.at(-1)![0]).toBe(SRC);
    }
    expect(copyImageToClipboard).toHaveBeenCalledTimes(2);
  });

  it("菜单栏「编辑 ▸ 拷贝」（给聚焦的图片区派发 copy 事件）→ preventDefault + 复制原图（真 Electron 实测 webContents.copy() 的 target 就是图片区）", () => {
    const m = mount();
    m.load();
    const e = m.copyEvent();
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(copyImageToClipboard).toHaveBeenCalledTimes(1);
    expect(copyImageToClipboard).toHaveBeenCalledWith(SRC, { fallbackSize: { w: 2250, h: 1494 } });
  });

  it("copy 事件的接管是安全的：图片区 select-none（里面没有可复制的文字），且处理器挂在图片区上而不是整个弹窗", () => {
    const m = mount();
    expect(String(m.el.box().props.className)).toContain("select-none");
    expect(m.el.box().props.onCopy).toBeTypeOf("function");
    // 工具栏 / 其它地方没有 onCopy：弹窗头里的文字（标题 / 路径）照常可复制
    const withOnCopy = m.all().filter((e) => e.props.onCopy);
    expect(withOnCopy).toHaveLength(1);
    expect(withOnCopy[0]!.props.tabIndex).toBe(0);
  });

  it("大小写不敏感（Caps Lock 下 key 是 C）", () => {
    const m = mount();
    m.load();
    m.key({ key: "C", metaKey: true });
    expect(copyImageToClipboard).toHaveBeenCalledTimes(1);
  });

  it("mac 只认 ⌘（Ctrl+C 在 mac 上是别的意思、不拦）；win32 / linux 认 Ctrl", () => {
    vi.stubGlobal("window", { __shell: { platform: "darwin" } });
    const mac = mount();
    mac.load();
    const ctrlOnMac = mac.key({ key: "c", ctrlKey: true });
    expect(ctrlOnMac.preventDefault).not.toHaveBeenCalled();
    expect(copyImageToClipboard).not.toHaveBeenCalled();
    mac.key({ key: "c", metaKey: true });
    expect(copyImageToClipboard).toHaveBeenCalledTimes(1);

    vi.stubGlobal("window", { __shell: { platform: "win32" } });
    const win = mount();
    win.load();
    win.key({ key: "c", ctrlKey: true });
    expect(copyImageToClipboard).toHaveBeenCalledTimes(2);
  });

  it("复制的是原图：先旋转 / 缩放 / 切棋盘格再复制，src 与选项都不变（不是「当前视图」）", () => {
    const m = mount();
    m.load();
    (m.el.toolButton("向右旋转 90°").props.onClick as () => void)();
    (m.el.toolButton("放大").props.onClick as () => void)();
    (m.el.toolButton("棋盘格背景（看透明区域）").props.onClick as () => void)();
    m.rerender();
    m.click();
    expect(copyImageToClipboard).toHaveBeenCalledTimes(1);
    const [src, opts] = vi.mocked(copyImageToClipboard).mock.calls[0]!;
    expect(src).toBe(SRC);
    expect(opts).toEqual({ fallbackSize: { w: 2250, h: 1494 } });
  });

  it("位图：fallbackSize = 图片自己的尺寸，不带 vector（放大规则只给 SVG）", () => {
    const m = mount();
    m.load(640, 480);
    m.click();
    const opts = vi.mocked(copyImageToClipboard).mock.calls[0]![1]!;
    expect(opts.fallbackSize).toEqual({ w: 640, h: 480 });
    expect(opts.vector).toBeFalsy();
  });

  it("SVG（vector）：把 natural 当 fallbackSize 传下去——无固有尺寸时就是显示用的 300×150 兜底；有固有尺寸时是真尺寸", () => {
    const noSize = mount({ vector: true });
    noSize.load(0, 0);
    noSize.click();
    expect(copyImageToClipboard).toHaveBeenLastCalledWith(SRC, { fallbackSize: { w: 300, h: 150 }, vector: true });

    const sized = mount({ vector: true });
    sized.load(24, 24);
    sized.click();
    expect(copyImageToClipboard).toHaveBeenLastCalledWith(SRC, { fallbackSize: { w: 24, h: 24 }, vector: true });
  });

  it("成功 → toast.success(「已复制图片」)", async () => {
    const m = mount();
    m.load();
    m.click();
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("已复制图片"));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("失败 → toast.error 带上 Error.message（lib 抛的中文文案）；抛的不是 Error → 兜底「复制图片失败」", async () => {
    vi.mocked(copyImageToClipboard).mockRejectedValueOnce(new Error("这张图来自外部站点，浏览器不允许复制"));
    const m = mount();
    m.load();
    m.click();
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("这张图来自外部站点，浏览器不允许复制"));

    vi.mocked(copyImageToClipboard).mockRejectedValueOnce("boom");
    const m2 = mount();
    m2.load();
    m2.menuClick();
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("复制图片失败"));
    expect(toast.success).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------- 禁用状态

describe("禁用：图片没加载 / 加载失败 / 环境不支持 / 在途——按钮置灰、菜单项禁用、任何入口都不调用", () => {
  const nothingCopied = (m: ReturnType<typeof mount>) => {
    m.click();
    m.menuClick();
    m.copyEvent();
    const e = m.key({ key: "c", metaKey: true });
    expect(copyImageToClipboard).not.toHaveBeenCalled();
    return e;
  };

  it("图片还没加载出来（natural === null）", () => {
    const m = mount();
    expect(m.el.copyButton().props.disabled).toBe(true);
    expect(m.el.item().props.disabled).toBe(true);
    nothingCopied(m);
  });

  it("加载成功后解除；加载失败（failed）后又置灰", () => {
    const m = mount();
    m.load();
    expect(m.el.copyButton().props.disabled).toBe(false);
    expect(m.el.item().props.disabled).toBe(false);
    const failed = mount();
    failed.loadFail();
    expect(failed.el.copyButton().props.disabled).toBe(true);
    expect(failed.el.item().props.disabled).toBe(true);
    nothingCopied(failed);
  });

  it("加载成功之后又报错（natural 还在、failed 为真）：failed 优先——仍然置灰、任何入口都不复制、提示写加载失败", () => {
    // 平时 failed 总和 natural === null 同时出现，`!natural` 会把 failed 遮住；这里把两者拆开，钉住「failed 自己也能拦」
    const m = mount();
    m.load();
    expect(m.el.copyButton().props.disabled).toBe(false);
    m.loadFail(); // 旧 <img> 的 onError 在加载成功之后触发
    expect(m.el.copyButton().props.disabled).toBe(true);
    expect(m.el.item().props.disabled).toBe(true);
    expect(m.el.copyButton().props.tooltip).toBe("图片加载失败，无法复制");
    expect(m.el.copyButton().props.shortcut).toBeUndefined();
    nothingCopied(m);
  });

  it("环境不支持（canCopyImage() === false）：即使图片加载好了也置灰，提示写「当前环境不支持复制图片」、不写快捷键", () => {
    vi.mocked(canCopyImage).mockReturnValue(false);
    const m = mount();
    m.load();
    expect(m.el.copyButton().props.disabled).toBe(true);
    expect(m.el.item().props.disabled).toBe(true);
    expect(m.el.copyButton().props.tooltip).toBe("当前环境不支持复制图片");
    expect(m.el.copyButton().props.shortcut).toBeUndefined();
    nothingCopied(m);
  });

  it("一次复制在途：置灰到 promise 落定；期间重复点击 / 重复 ⌘C / 菜单项都不再触发；落定后恢复", async () => {
    const d = deferred<void>();
    vi.mocked(copyImageToClipboard).mockReturnValueOnce(d.promise);
    const m = mount();
    m.load();
    const staleClick = m.el.copyButton().props.onClick as () => void; // 还没重渲时拿到的那份闭包
    staleClick();
    expect(copyImageToClipboard).toHaveBeenCalledTimes(1);
    // 还没重渲：同一份旧闭包再点（连按 ⌘C 的真实情形）也不重复
    staleClick();
    expect(copyImageToClipboard).toHaveBeenCalledTimes(1);
    // 重渲后：按钮 / 菜单项置灰
    m.rerender();
    expect(m.el.copyButton().props.disabled).toBe(true);
    expect(m.el.item().props.disabled).toBe(true);
    m.click();
    m.menuClick();
    m.copyEvent();
    m.key({ key: "c", metaKey: true });
    expect(copyImageToClipboard).toHaveBeenCalledTimes(1);
    // 落定
    d.resolve();
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    m.rerender();
    expect(m.el.copyButton().props.disabled).toBe(false);
    m.click();
    expect(copyImageToClipboard).toHaveBeenCalledTimes(2);
  });

  it("在途的那次失败也要解除置灰（不能卡死在「复制中」）", async () => {
    const d = deferred<void>();
    vi.mocked(copyImageToClipboard).mockReturnValueOnce(d.promise);
    const m = mount();
    m.load();
    m.click();
    m.rerender();
    expect(m.el.copyButton().props.disabled).toBe(true);
    d.reject(new Error("写入剪贴板失败（可能没有剪贴板权限）"));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    m.rerender();
    expect(m.el.copyButton().props.disabled).toBe(false);
    m.click();
    expect(copyImageToClipboard).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------- 成功反馈：图标切勾

describe("成功反馈：图标换成 Check 约 1.5 秒后回落成 Copy", () => {
  it("成功后 Check，1.5 秒后 Copy；卸载时清掉定时器", async () => {
    vi.useFakeTimers();
    const m = mount();
    m.load();
    expect((m.el.copyButton().props.children as El).type).toBe(Copy);
    m.click();
    await vi.advanceTimersByTimeAsync(0);
    m.rerender();
    expect((m.el.copyButton().props.children as El).type).toBe(Check);
    expect(m.el.copyButton().props.tooltip).toBe("已复制");
    await vi.advanceTimersByTimeAsync(1499);
    m.rerender();
    expect((m.el.copyButton().props.children as El).type).toBe(Check);
    await vi.advanceTimersByTimeAsync(1);
    m.rerender();
    expect((m.el.copyButton().props.children as El).type).toBe(Copy);

    // 卸载：挂着的回落定时器被清掉
    m.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    m.h.flushEffects();
    m.h.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("失败不切勾", async () => {
    vi.mocked(copyImageToClipboard).mockRejectedValueOnce(new Error("x"));
    const m = mount();
    m.load();
    m.click();
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    m.rerender();
    expect((m.el.copyButton().props.children as El).type).toBe(Copy);
  });
});

// ---------------------------------------------------------------------- 提示与快捷键文案

describe("hover 提示：写明复制的是原图；快捷键按平台", () => {
  it("可复制：提示「复制原图」+ 快捷键（平台未知 / 非 mac 写 Ctrl+C）", () => {
    const m = mount();
    m.load();
    expect(m.el.copyButton().props.tooltip).toBe("复制原图");
    expect(m.el.copyButton().props.shortcut).toBe("Ctrl+C");
  });

  it("mac（挂载后才读到平台，首帧与服务端一致）写 ⌘C", () => {
    vi.stubGlobal("window", { __shell: { platform: "darwin" } });
    const m = mount();
    expect(m.el.copyButton().props.shortcut).toBeUndefined(); // 首帧（还没 load）：不写快捷键
    m.load();
    expect(m.el.copyButton().props.shortcut).toBe("Ctrl+C"); // 首帧平台是 ""：与 SSR 一致
    m.h.flushEffects(); // effect 里读平台
    m.rerender();
    m.load();
    expect(m.el.copyButton().props.shortcut).toBe("⌘C");
  });

  it("还没加载 / 加载失败时的提示各自说明原因，且不写快捷键", () => {
    const loading = mount();
    expect(loading.el.copyButton().props.tooltip).toBe("图片加载完成后才能复制");
    expect(loading.el.copyButton().props.shortcut).toBeUndefined();
    const failed = mount();
    failed.loadFail();
    expect(failed.el.copyButton().props.tooltip).toBe("图片加载失败，无法复制");
    expect(failed.el.copyButton().props.shortcut).toBeUndefined();
  });

  it("aria-label 一直是「复制图片」，不随提示变（读屏名字稳定）", () => {
    vi.mocked(canCopyImage).mockReturnValue(false);
    const m = mount();
    expect(m.el.copyButton().props.label).toBe("复制图片");
    expect(buttonTag(ssr(), "复制图片")).toContain('aria-label="复制图片"');
  });
});

// ---------------------------------------------------------------------- 键盘：只吃 ⌘C，其它按键不动

describe("键盘：⌘C 分支只在命中时 preventDefault，现有快捷键不受影响", () => {
  it("原有的 + = - _ 0 1 r R 照常（preventDefault 且不触发复制）", () => {
    const m = mount();
    m.load();
    for (const key of ["+", "=", "-", "_", "0", "1", "r", "R"]) {
      const e = m.key({ key });
      expect(e.preventDefault, `按键 ${key}`).toHaveBeenCalledTimes(1);
    }
    expect(m.key({ key: "r", shiftKey: true }).preventDefault).toHaveBeenCalledTimes(1);
    expect(copyImageToClipboard).not.toHaveBeenCalled();
  });

  it("没命中的按键一律不 preventDefault、不复制：其它字母 / 方向键 / 回车 / 空格 / 单独的 c / ⌘V / ⌘A / ⌘+ / ⌘⇧C / ⌘⌥C / Ctrl+⌥C", () => {
    const m = mount();
    m.load();
    const cases: Array<Parameters<typeof m.key>[0]> = [
      { key: "a" },
      { key: "x" },
      { key: "ArrowLeft" },
      { key: "Enter" },
      { key: " " },
      { key: "Tab" },
      { key: "c" },
      { key: "C", shiftKey: true },
      { key: "v", metaKey: true },
      { key: "v", ctrlKey: true },
      { key: "a", metaKey: true },
      { key: "a", ctrlKey: true },
      { key: "x", metaKey: true },
      { key: "+", metaKey: true },
      { key: "0", ctrlKey: true },
      { key: "r", metaKey: true },
      { key: "c", metaKey: true, shiftKey: true },
      { key: "c", metaKey: true, altKey: true },
      { key: "c", ctrlKey: true, altKey: true },
      { key: "c", altKey: true },
    ];
    for (const init of cases) {
      const e = m.key(init);
      expect(e.preventDefault, JSON.stringify(init)).not.toHaveBeenCalled();
    }
    expect(copyImageToClipboard).not.toHaveBeenCalled();
  });

  it("⌘C 命中时即使当前不能复制（没加载 / 在途 / 不支持）也 preventDefault，但不调用", () => {
    const m = mount(); // 还没 load
    const e = m.key({ key: "c", metaKey: true });
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(copyImageToClipboard).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------- 拖拽：右键不开始拖拽

describe("图片区拖拽：只有左键开始拖拽（右键是开菜单，不是平移）", () => {
  const down = (m: ReturnType<typeof mount>, button: number) => {
    const target = { setPointerCapture: vi.fn() };
    (m.el.box().props.onPointerDown as (e: unknown) => void)({
      button,
      pointerId: 7,
      clientX: 10,
      clientY: 10,
      currentTarget: target,
    });
    return target;
  };

  it("右键（button 2）：不 setPointerCapture、不进入 dragging；中键（button 1）同理", () => {
    for (const button of [2, 1]) {
      const m = mount();
      m.load();
      const target = down(m, button);
      expect(target.setPointerCapture, `button ${button}`).not.toHaveBeenCalled();
      m.rerender();
      expect(String(m.el.box().props.className)).not.toContain("cursor-grabbing");
      // 之后的 move 也不会平移（没有拖拽会话）
      (m.el.box().props.onPointerMove as (e: unknown) => void)({ pointerId: 7, clientX: 80, clientY: 80 });
      m.rerender();
      expect(String(m.el.img().props.style ? JSON.stringify(m.el.img().props.style) : "")).not.toContain("translate(70px");
    }
  });

  it("对照：左键（button 0）正常开始拖拽", () => {
    const m = mount();
    m.load();
    const target = down(m, 0);
    expect(target.setPointerCapture).toHaveBeenCalledWith(7);
    m.rerender();
    expect(String(m.el.box().props.className)).toContain("cursor-grabbing");
  });
});

// ---------------------------------------------------------------------- SSR / 水合首帧

describe("SSR / 水合首帧：环境能力不在首次渲染里直接读 navigator", () => {
  // 注意：SSR 时图片一定还没加载（natural === null），按钮本来就置灰——所以光看 ImageViewer 的 SSR 输出区分不出
  // 「首帧读没读 navigator」。真正钉水合安全的是下面对 hook 本身的直测（getServerSnapshot 恒 false）。
  it("useCanCopyImage：服务端渲染（= 水合首帧）恒为 false，即使客户端环境支持——不在首帧直接读 navigator", () => {
    vi.mocked(canCopyImage).mockReturnValue(true);
    const Probe = () => createElement("i", null, String(useCanCopyImage()));
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<i>false</i>");
    // 对照：环境不支持时同样 false（不是写死 true）；客户端读 getSnapshot 的路径见下一条
    vi.mocked(canCopyImage).mockReturnValue(false);
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<i>false</i>");
  });

  it("useCanCopyImage：客户端（getSnapshot）如实反映环境能力", () => {
    const h = createHookHarness();
    vi.mocked(canCopyImage).mockReturnValue(true);
    expect(h.render(() => useCanCopyImage())).toBe(true);
    vi.mocked(canCopyImage).mockReturnValue(false);
    expect(h.render(() => useCanCopyImage())).toBe(false);
  });

  it("SSR 输出里复制按钮置灰（图片还没加载），与客户端 canCopy 是否为真无关；客户端加载后才可点", () => {
    vi.mocked(canCopyImage).mockReturnValue(true);
    expect(buttonTag(ssr(), "复制图片")).toContain("disabled");
    const m = mount();
    expect(m.el.copyButton().props.disabled).toBe(true); // 还没加载
    m.load();
    expect(m.el.copyButton().props.disabled).toBe(false);
  });

  it("置灰的按钮外面套一层 span 当 tooltip 的 trigger（disabled 按钮带 pointer-events-none，自己收不到 hover）", () => {
    const html = ssr();
    // span 上还会有 Tooltip trigger 加的 id 等属性，所以 class 之后允许别的属性
    expect(html).toMatch(/<span class="inline-flex"[^>]*><button[^>]*aria-label="复制图片"/);
    // 对照：没置灰的「缩小」按钮前面没有这层 span
    expect(html).not.toMatch(/<span class="inline-flex"[^>]*><button[^>]*aria-label="缩小"/);
  });

  it("SSR 不输出菜单弹层（关着时不挂 portal 内容），图片区仍是可聚焦的 div", () => {
    const html = ssr();
    expect(html).not.toContain('data-slot="context-menu-content"');
    expect(html).toMatch(/<div[^>]*tabindex="0"/);
    expect(html).toContain(`src="${SRC.replace(/&/g, "&amp;")}"`);
  });
});

// ---------------------------------------------------------------------- ToolButton 的两处增量

describe("ToolButton：tooltip 覆盖默认提示；传了 disabled 就一直套 span（trigger 元素不能随 disabled 真假来回换）", () => {
  const noop = () => {};
  const tipOf = (el: unknown) => (el as El).props.content;
  /** ToolButton 返回 <Tooltip>{trigger}</Tooltip>：trigger = Tooltip 唯一的子元素 */
  const triggerOf = (el: unknown) => (el as El).props.children as El;

  it("没有 tooltip：沿用 label（带 shortcut 时 label（shortcut））——既有用法不变", () => {
    expect(tipOf(ToolButton({ label: "放大", shortcut: "+", onClick: noop, children: null }))).toBe("放大（+）");
    expect(tipOf(ToolButton({ label: "缩小", onClick: noop, children: null }))).toBe("缩小");
  });

  it("有 tooltip：提示用它（shortcut 照样追加），aria-label 仍是 label", () => {
    const el = ToolButton({ label: "复制图片", tooltip: "复制原图", shortcut: "⌘C", onClick: noop, children: null }) as El;
    expect(el.props.content).toBe("复制原图（⌘C）");
    const btn = el.props.children as El;
    expect(btn.props["aria-label"]).toBe("复制图片");
  });

  it("没传 disabled：不套 span，按钮直接是 Tooltip 的子元素（与改动前一样——其它调用点的 DOM 不变）", () => {
    const el = ToolButton({ label: "放大", onClick: noop, children: null });
    expect(triggerOf(el).type).not.toBe("span");
    expect(triggerOf(el).props["aria-label"]).toBe("放大");
  });

  it("传了 disabled（不管真假）：都套 span，里面的按钮 disabled 如实反映", () => {
    for (const d of [true, false]) {
      const trig = triggerOf(ToolButton({ label: "放大", onClick: noop, disabled: d, children: null }));
      expect(trig.type).toBe("span");
      const btn = trig.props.children as El;
      expect(btn.props["aria-label"]).toBe("放大");
      expect(btn.props.disabled).toBe(d);
    }
  });

  it("★ trigger 元素类型不随 disabled 真假变化（真 Chromium 实测：span ↔ button 来回换，hover 提示永久失效）", () => {
    const t = triggerOf(ToolButton({ label: "x", onClick: noop, disabled: true, children: null }));
    const f = triggerOf(ToolButton({ label: "x", onClick: noop, disabled: false, children: null }));
    expect(f.type).toBe(t.type);
  });

  it("图片查看器的复制按钮：加载前（置灰）与加载后（可点）trigger 元素类型一致——正是上面那个坑的真实场景", () => {
    const m = mount();
    expect(m.el.copyButton().props.disabled).toBe(true);
    const before = triggerOf(ToolButton(m.el.copyButton().props as never)).type;
    m.load();
    expect(m.el.copyButton().props.disabled).toBe(false);
    const after = triggerOf(ToolButton(m.el.copyButton().props as never)).type;
    expect(after).toBe(before);
  });

  it("查找栏的「上一个 / 下一个」（disabled={!total}，随输入在真假间切换）同样保持 trigger 元素类型不变", () => {
    const bar = (total: number) =>
      walk(FindBar({ value: "x", onChange: noop, placeholder: "", total, onNext: noop, onPrev: noop, onClose: noop }));
    for (const label of ["上一个", "下一个"]) {
      const pick = (total: number) => {
        const tb = bar(total).find((e) => e.type === ToolButton && e.props.label === label);
        if (!tb) throw new Error(`没找到 ${label}`);
        return triggerOf(ToolButton(tb.props as never)).type;
      };
      expect(pick(3)).toBe(pick(0));
    }
  });
});

// ---------------------------------------------------------------------- 调用方契约

describe("调用方：只有 SvgViewer 声明 vector；位图入口不声明", () => {
  const read = (rel: string) => readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf8");

  it("svg-viewer.tsx 的 <ImageViewer …> 带 vector", () => {
    expect(read("src/components/preview/svg-viewer.tsx")).toMatch(/<ImageViewer\b[^>]*\bvector\b[^>]*\/>/);
  });

  it("local-file-preview-body.tsx（png / jpg / gif / webp …）的 <ImageViewer …> 不带 vector（位图放大只会糊）", () => {
    const body = read("src/components/ui/local-file-preview-body.tsx");
    const tags = body.match(/<ImageViewer\b[^>]*\/>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).not.toMatch(/\bvector\b/);
  });
});
