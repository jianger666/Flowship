/**
 * 真 Chromium 夹具的入口：把**真实的** `ImageViewer`（src/components/preview/image-viewer.tsx）放进**真实的** `Dialog` / `DialogContent`
 * （src/components/ui/dialog.tsx，与 local-file-preview.tsx 的弹窗外壳同一套），再配一个 sonner 的 `<Toaster />` 看提示。
 *
 * 由 `scripts/browser-e2e/lib/build-image-viewer-fixture.mjs` 打成 IIFE（`@/` 指向 src/）；样式用真实的 `src/app/globals.css`
 * 经 Tailwind 编译，所以 z-index / 布局 / `disabled:pointer-events-none` 都是线上同款，不是手写的近似。
 *
 * 页面参数：`?src=/img/photo.jpg`（图片地址）、`&vector=1`（按 SVG 的口径传 vector）。
 * 暴露给 e2e 脚本读取的状态：`window.__fx = { open }`（弹窗是否还开着）。
 */
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import { ImageViewer } from "@/components/preview/image-viewer";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

const q = new URLSearchParams(location.search);
const src = q.get("src") ?? "/img/photo.jpg";
const vector = q.get("vector") === "1";

const App = () => {
  const [open, setOpen] = useState(true);
  window.__fx = { open };
  return h(
    "div",
    null,
    h(
      Dialog,
      { open, onOpenChange: (next) => setOpen(next) },
      h(
        DialogContent,
        {
          // 与 local-file-preview.tsx 的 DialogContent 同一组尺寸 class（固定高度，图片查看器需要确定高度的容器）
          className:
            "flex h-[min(90vh,calc(100vh-48px))] max-h-[min(90vh,calc(100vh-48px))] w-full flex-col gap-0 overflow-hidden bg-background p-0 text-foreground sm:max-w-[min(960px,80vw,calc(100vw-48px))]",
        },
        // 顶栏：与 local-file-preview.tsx 的顶栏同一组 class（左身份 + 标题 + 路径；`pr-12` 给 DialogContent 内置的右上角关闭键让位）。
        // 没有它，图片查看器的工具栏会贴到弹窗最顶上、被关闭键盖住——那是夹具不忠实，不是线上的样子
        h(
          "div",
          { className: "flex shrink-0 items-center gap-2.5 border-b border-border/80 bg-muted/25 py-2.5 pr-12 pl-3" },
          h(
            "span",
            {
              className:
                "inline-flex h-6 shrink-0 items-center rounded-sm bg-info/10 px-1.5 font-mono text-[11px] font-medium uppercase tracking-wide text-info",
            },
            ".img",
          ),
          h(
            "div",
            { className: "min-w-0 flex-1" },
            h(DialogTitle, { className: "truncate text-sm font-medium tracking-tight" }, "fixture-image"),
            h(DialogDescription, { className: "sr-only" }, "图片查看器夹具"),
            h("div", { className: "mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground" }, "/tmp/fixture-image"),
          ),
        ),
        h("div", { className: "min-h-0 flex-1" }, h(ImageViewer, { src, alt: "fixture", size: 12345, vector })),
      ),
    ),
    h(Toaster, null),
  );
};

createRoot(document.getElementById("root")).render(h(App));
