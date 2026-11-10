/**
 * R7-12-B3：`LocalFileLink` 的「打开」行为：左键 / 右键菜单各项的去向、失败 toast、带行号的 HTML 走 IDE。
 *
 * 与 tests/markdown-link-menu.test.ts 同法：`LocalFileLink` 自己不用 React hook（用到的三个自定义 hook 在下面 mock），直接当函数调用得到元素树，
 * 再用假事件调用 `onClick`。菜单项在本文件里的内部组件 `LocalFileMenuItems` 中，展开它（它也不用 hook）再按文本找。
 * 对应 reviewer 的存活变异：reportOpenFailure 不 toast、右键内置 / 系统两条路径去掉 catch、带行号的 HTML 进了浏览器、
 * 「内置」「系统」两项的显隐条件（要 HTML；「内置」还要桥）。
 */
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  bridge: true,
  openLocalHtmlInBuiltin: vi.fn(),
  requestOpenLocalPath: vi.fn(),
  requestRevealLocalPath: vi.fn(),
  previewOpen: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/components/browser/open-in-builtin", () => ({
  openLocalHtmlInBuiltin: (...a: unknown[]) => h.openLocalHtmlInBuiltin(...a),
  readLinkOpenMode: () => "builtin",
}));
vi.mock("@/components/browser/use-browser-session", () => ({ useBrowserAvailable: () => h.bridge }));
vi.mock("@/components/media/media-group-state", () => ({ useMediaGroup: () => undefined }));
vi.mock("@/components/ui/local-file-preview-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/local-file-preview-context")>();
  return { ...actual, useLocalFilePreview: () => ({ open: h.previewOpen, ide: "cursor" }) };
});
vi.mock("@/lib/local-file-open", () => ({
  requestOpenLocalPath: (...a: unknown[]) => h.requestOpenLocalPath(...a),
  requestRevealLocalPath: (...a: unknown[]) => h.requestRevealLocalPath(...a),
}));
vi.mock("sonner", () => ({ toast: h.toast }));

import { ContextMenuItem } from "@/components/ui/context-menu";
import { LocalFileLink, type LocalFilePathLinker } from "@/components/ui/local-file-link";

type Props = { children?: ReactNode; [k: string]: unknown };
type AnyFn = ((props: unknown) => ReactNode) & { name: string };
/** 展开元素树；遇到文件内部的 `LocalFileMenuItems`（无 hook 的函数组件）就调用它继续往下走 */
const flat = (node: ReactNode, out: ReactElement<Props>[] = []): ReactElement<Props>[] => {
  Children.forEach(node, (c) => {
    if (!isValidElement(c)) return;
    const el = c as ReactElement<Props>;
    out.push(el);
    if (typeof el.type === "function" && (el.type as AnyFn).name === "LocalFileMenuItems") flat((el.type as AnyFn)(el.props), out);
    else flat(el.props.children, out);
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

const linker: LocalFilePathLinker = { resolveFor: (p, line) => ({ absolute: p, line }), baseDir: "/" };
const render = (path: string, line?: number) => LocalFileLink({ linker, path, line });
const primaryButton = (tree: ReactNode) => flat(tree).find((e) => e.type === "button");
const primaryAnchor = (tree: ReactNode) => flat(tree).find((e) => e.type === "a");
const menuTexts = (tree: ReactNode) => flat(tree).filter((e) => e.type === ContextMenuItem).map((e) => textOf(e.props.children).trim());
const menuItem = (tree: ReactNode, text: string) => flat(tree).find((e) => e.type === ContextMenuItem && textOf(e.props.children).trim() === text);
const fire = (el: ReactElement<Props> | undefined) => (el?.props.onClick as (e?: unknown) => void)({ stopPropagation: vi.fn(), preventDefault: vi.fn() });

const HTML = "/Users/me/site/index.html";

beforeEach(() => {
  h.bridge = true;
  h.openLocalHtmlInBuiltin.mockReset().mockResolvedValue("builtin");
  h.requestOpenLocalPath.mockReset().mockResolvedValue(undefined);
  h.requestRevealLocalPath.mockReset().mockResolvedValue(undefined);
  h.previewOpen.mockReset();
  for (const f of Object.values(h.toast)) f.mockReset();
});

describe("LocalFileLink 左键", () => {
  it("HTML（无行号）→ 是按钮；点击走 openLocalHtmlInBuiltin(绝对路径)（不带 forceBuiltin），并阻止冒泡 / 默认行为，不开预览", () => {
    const b = primaryButton(render(HTML));
    expect(b).toBeDefined();
    expect(primaryAnchor(render(HTML))).toBeUndefined();
    const ev = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
    (b!.props.onClick as (e: unknown) => void)(ev);
    expect(ev.stopPropagation).toHaveBeenCalled();
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(h.openLocalHtmlInBuiltin).toHaveBeenCalledTimes(1);
    expect(h.openLocalHtmlInBuiltin).toHaveBeenCalledWith(HTML);
    expect(h.previewOpen).not.toHaveBeenCalled();
  });

  it("HTML 带行号（x.html:12 = 源码定位）→ 是 IDE 链接（<a>），不进浏览器：点击不调 openLocalHtmlInBuiltin", () => {
    const tree = render(HTML, 12);
    expect(primaryAnchor(tree)).toBeDefined();
    expect(primaryButton(tree)).toBeUndefined();
    fire(primaryAnchor(tree));
    expect(h.openLocalHtmlInBuiltin).not.toHaveBeenCalled();
    expect(h.previewOpen).not.toHaveBeenCalled();
  });

  it("非 HTML（md）→ 开预览，不进浏览器", () => {
    fire(primaryButton(render("/Users/me/notes.md")));
    expect(h.previewOpen).toHaveBeenCalledTimes(1);
    expect(h.openLocalHtmlInBuiltin).not.toHaveBeenCalled();
  });

  it("打开失败 → toast.error：Error 带 message，非 Error 兜底文案（不能被吞）", async () => {
    h.openLocalHtmlInBuiltin.mockRejectedValueOnce(new Error("boom"));
    fire(primaryButton(render(HTML)));
    await vi.waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("浏览器打开失败：boom"));
    h.toast.error.mockClear();
    h.openLocalHtmlInBuiltin.mockRejectedValueOnce("just a string");
    fire(primaryButton(render(HTML)));
    await vi.waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("浏览器打开失败"));
  });
});

describe("LocalFileLink 右键菜单", () => {
  const BUILTIN = "在内置浏览器打开";
  const SYSTEM = "在系统浏览器打开";

  it("HTML + 有内置浏览器桥：「内置」「系统」两项都有", () => {
    const t = menuTexts(render(HTML));
    expect(t).toContain(BUILTIN);
    expect(t).toContain(SYSTEM);
  });

  it("HTML + 没有桥（网页版 / 非 Electron）：只有「系统」，没有「内置」", () => {
    h.bridge = false;
    const t = menuTexts(render(HTML));
    expect(t).not.toContain(BUILTIN);
    expect(t).toContain(SYSTEM);
  });

  it.each(["/Users/me/notes.md", "/Users/me/src/app.ts", "/Users/me/pic.png", "/Users/me/a.pdf"])("非 HTML（%s）：两项都不出（桥有没有都一样）", (p) => {
    for (const bridge of [true, false]) {
      h.bridge = bridge;
      const t = menuTexts(render(p));
      expect(t, `${p} bridge=${bridge}`).not.toContain(BUILTIN);
      expect(t, `${p} bridge=${bridge}`).not.toContain(SYSTEM);
    }
  });

  it("「在内置浏览器打开」→ openLocalHtmlInBuiltin(路径, { forceBuiltin: true })（无视「默认系统」设置）；失败 → toast.error", async () => {
    fire(menuItem(render(HTML), BUILTIN));
    expect(h.openLocalHtmlInBuiltin).toHaveBeenCalledTimes(1);
    expect(h.openLocalHtmlInBuiltin).toHaveBeenCalledWith(HTML, { forceBuiltin: true });
    expect(h.requestOpenLocalPath).not.toHaveBeenCalled();

    h.openLocalHtmlInBuiltin.mockRejectedValueOnce(new Error("builtin-failed"));
    fire(menuItem(render(HTML), BUILTIN));
    await vi.waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("浏览器打开失败：builtin-failed"));
  });

  it("「在系统浏览器打开」→ requestOpenLocalPath(路径)（系统默认应用，原行为），不经内置决策；失败 → toast.error", async () => {
    fire(menuItem(render(HTML), SYSTEM));
    expect(h.requestOpenLocalPath).toHaveBeenCalledTimes(1);
    expect(h.requestOpenLocalPath).toHaveBeenCalledWith(HTML);
    expect(h.openLocalHtmlInBuiltin).not.toHaveBeenCalled();

    h.requestOpenLocalPath.mockRejectedValueOnce(new Error("sys-failed"));
    fire(menuItem(render(HTML), SYSTEM));
    await vi.waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("浏览器打开失败：sys-failed"));
  });
});
