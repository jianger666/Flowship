/**
 * R7-12-B1：`MarkdownLink` 的点击 / 右键菜单行为。
 *
 * 仓库没有 jsdom：`MarkdownLink` 自己不用 React hook（只用两个自定义 hook，下面 mock 掉），所以直接当函数调用得到元素树，
 * 再按类型 / 文本找到 `<a>` 与 `ContextMenuItem`，用假事件调用它们的 `onClick`——比读源码正则更接近真实行为。
 * 这些用例对应 reviewer 的存活变异：右键「内置」不带 forceBuiltin（R7-09-2 的回归点）、环境不允许时吞掉点击、「复制链接」复制成 children 文本、
 * UNC 图片守卫、用户自己的 onClick 透传、defaultPrevented、CLICKABLE 的 `/i` 与放宽。
 */
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  bridge: true,
  openHttpInBuiltin: vi.fn(),
  openHttpInSystem: vi.fn(),
  previewOpen: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/components/browser/open-in-builtin", () => ({
  openHttpInBuiltin: (...a: unknown[]) => h.openHttpInBuiltin(...a),
  openHttpInSystem: (...a: unknown[]) => h.openHttpInSystem(...a),
}));
vi.mock("@/components/browser/use-browser-session", () => ({ useBrowserAvailable: () => h.bridge }));
vi.mock("@/components/ui/image-preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/image-preview")>();
  return {
    ...actual,
    useImagePreview: () => ({ open: h.previewOpen }),
    InsideInteractive: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("sonner", () => ({ toast: h.toast }));

import { MarkdownLink } from "@/components/markdown-link";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { toLoadableImageSrc } from "@/lib/local-image-src";

type Props = { children?: ReactNode; [k: string]: unknown };
const flat = (node: ReactNode, out: ReactElement<Props>[] = []): ReactElement<Props>[] => {
  Children.forEach(node, (c) => {
    if (isValidElement(c)) {
      out.push(c as ReactElement<Props>);
      flat((c.props as Props).children, out);
    }
  });
  return out;
};
const textOf = (node: ReactNode): string => {
  let s = "";
  Children.forEach(node, (c) => {
    if (typeof c === "string" || typeof c === "number") s += String(c);
    else if (isValidElement(c)) s += textOf((c.props as Props).children);
  });
  return s;
};

const render = (href: string | undefined, extra: Record<string, unknown> = {}, text = "显示文字") => MarkdownLink({ href, children: text, ...extra } as never);
const anchor = (tree: ReactNode) => flat(tree).find((e) => e.type === "a");
const menuItems = (tree: ReactNode) => flat(tree).filter((e) => e.type === ContextMenuItem);
const itemByText = (tree: ReactNode, text: string) => menuItems(tree).find((e) => textOf(e.props.children).trim() === text);
const click = (el: ReactElement<Props> | undefined, ev: Record<string, unknown> = {}) => {
  const e = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault: vi.fn(), ...ev };
  (el?.props.onClick as (e: unknown) => void)(e);
  return e;
};

const URL1 = "https://example.com/docs?a=1";

beforeEach(() => {
  h.bridge = true;
  h.openHttpInBuiltin.mockReset().mockReturnValue("builtin");
  h.openHttpInSystem.mockReset();
  h.previewOpen.mockReset();
  for (const f of Object.values(h.toast)) f.mockReset();
  vi.unstubAllGlobals();
});

describe("MarkdownLink 左键", () => {
  it("内置成功 → preventDefault（不再走 <a target=_blank>）；回退系统 → 不拦（走默认行为）", () => {
    const a = anchor(render(URL1));
    expect(a?.props.href).toBe(URL1);
    expect(a?.props.target).toBe("_blank");
    expect(a?.props.rel).toBe("noopener noreferrer");
    const e1 = click(a);
    expect(h.openHttpInBuiltin).toHaveBeenCalledWith(URL1); // 左键不带 forceBuiltin
    expect(e1.preventDefault).toHaveBeenCalledTimes(1);
    h.openHttpInBuiltin.mockReturnValue("system");
    const e2 = click(a);
    expect(e2.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    ["⌘", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["中键", { button: 1 }],
    ["右键", { button: 2 }],
  ])("%s 点击不拦（用户明确要系统浏览器 / 新窗口的惯例）：不问内置、不 preventDefault", (_n, ev) => {
    const e = click(anchor(render(URL1)), ev);
    expect(h.openHttpInBuiltin).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("用户传进来的 onClick 先被调用（透传）；它已经 preventDefault 了就不再处理（defaultPrevented）", () => {
    const user = vi.fn();
    const e1 = click(anchor(render(URL1, { onClick: user })));
    expect(user).toHaveBeenCalledTimes(1);
    expect(user.mock.calls[0]![0]).toBe(e1);
    expect(h.openHttpInBuiltin).toHaveBeenCalledTimes(1); // 对照：没拦的时候照常处理
    h.openHttpInBuiltin.mockClear();
    const prevent = vi.fn();
    click(anchor(render(URL1, { onClick: prevent })), { defaultPrevented: true });
    expect(prevent).toHaveBeenCalledTimes(1);
    expect(h.openHttpInBuiltin).not.toHaveBeenCalled();
  });
});

describe("MarkdownLink 右键菜单", () => {
  it("有内置浏览器桥：三项（内置 / 系统 / 复制链接）；没有桥：只有系统与复制，不出「内置」", () => {
    h.bridge = true;
    expect(menuItems(render(URL1)).map((e) => textOf(e.props.children).trim())).toEqual(["在内置浏览器打开", "在系统浏览器打开", "复制链接"]);
    h.bridge = false;
    expect(menuItems(render(URL1)).map((e) => textOf(e.props.children).trim())).toEqual(["在系统浏览器打开", "复制链接"]);
  });

  it("「在内置浏览器打开」→ openHttpInBuiltin(href, { forceBuiltin: true })（无视「默认系统」设置、不被授权链接启发式回退）；内置成功时不再打开系统", () => {
    const tree = render(URL1);
    (itemByText(tree, "在内置浏览器打开")!.props.onClick as () => void)();
    expect(h.openHttpInBuiltin).toHaveBeenCalledTimes(1);
    expect(h.openHttpInBuiltin).toHaveBeenCalledWith(URL1, { forceBuiltin: true });
    expect(h.openHttpInSystem).not.toHaveBeenCalled();
  });

  it("环境不允许（openHttpInBuiltin 返回 system：没有任务 / 站内地址…）→ 回退系统浏览器，不吞掉这次点击", () => {
    h.openHttpInBuiltin.mockReturnValue("system");
    (itemByText(render(URL1), "在内置浏览器打开")!.props.onClick as () => void)();
    expect(h.openHttpInSystem).toHaveBeenCalledTimes(1);
    expect(h.openHttpInSystem).toHaveBeenCalledWith(URL1);
  });

  it("「在系统浏览器打开」→ 直接 openHttpInSystem(href)，不经内置决策（不按设置）", () => {
    (itemByText(render(URL1), "在系统浏览器打开")!.props.onClick as () => void)();
    expect(h.openHttpInSystem).toHaveBeenCalledWith(URL1);
    expect(h.openHttpInBuiltin).not.toHaveBeenCalled();
  });

  it("「复制链接」复制的是 href（不是显示文字）；成功 / 失败各自 toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    (itemByText(render(URL1, {}, "点这里看文档"), "复制链接")!.props.onClick as () => void)();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(URL1);
    await vi.waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("已复制链接"));
    expect(h.toast.error).not.toHaveBeenCalled();

    const failing = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText: failing } });
    (itemByText(render(URL1, {}, "点这里看文档"), "复制链接")!.props.onClick as () => void)();
    await vi.waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("复制失败"));
  });
});

describe("MarkdownLink：什么样的 href 才是可点的链接", () => {
  it.each(["http://example.com", "https://example.com/x?y=1#z"])("%s → 带 href / target=_blank / rel 的 <a>", (href) => {
    const a = anchor(render(href));
    expect(a?.props.href).toBe(href);
    expect(a?.props.target).toBe("_blank");
  });

  it.each([
    "HTTP://example.com/", // 大小写敏感：只认小写协议（与既有渲染一致）
    "HTTPS://example.com/",
    "https:foo", // 少了 `//`
    "https:/example.com",
    "ftp://example.com/x",
    "mailto:a@b.c",
    "javascript:alert(1)",
    "./a.html",
    "docs/readme.md",
    "file:///tmp/a.html",
    "",
    undefined,
  ])("%j → 不可点的纯文本（没有 <a>，没有右键菜单）", (href) => {
    const tree = render(href as string | undefined);
    expect(anchor(tree)).toBeUndefined();
    expect(menuItems(tree)).toHaveLength(0);
    expect(textOf(tree as ReactNode)).toContain("显示文字");
  });
});

describe("MarkdownLink：本地图片路径（灯箱）与 UNC 守卫（R12-03）", () => {
  const button = (tree: ReactNode) => flat(tree).find((e) => e.type === "button");

  it.each(["/tmp/a.png", "/Users/me/pic.JPG", "C:\\Users\\me\\a.webp", "file:///tmp/a.gif"])("%s → 可点的预览按钮，点击以 toLoadableImageSrc 的结果打开灯箱", (href) => {
    const b = button(render(href));
    expect(b).toBeDefined();
    (b!.props.onClick as () => void)();
    expect(h.previewOpen).toHaveBeenCalledTimes(1);
    expect(h.previewOpen).toHaveBeenCalledWith([{ src: toLoadableImageSrc(href), alt: href }]);
  });

  it.each(["//server/share/a.png", "//host/dir/b.jpg", "file:////server/share/c.png"])("UNC 形态 %s → 不进灯箱（没有按钮），落到纯文本，路径仍可见", (href) => {
    const tree = render(href);
    expect(button(tree)).toBeUndefined();
    expect(anchor(tree)).toBeUndefined();
    expect(textOf(tree as ReactNode)).toContain("显示文字");
    expect(h.previewOpen).not.toHaveBeenCalled();
  });
});
