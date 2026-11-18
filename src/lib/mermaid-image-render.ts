/**
 * Mermaid 出图渲染页的浏览器端逻辑（只在桌面壳主进程的隐藏窗口里跑，见 app/mermaid-render/page.tsx）。
 *
 * 给飞书回复出图：飞书卡片不渲染 Mermaid，主进程（electron-app/mermaid-render.mjs）加载本页、调
 * `window.__flowshipMermaidRender(source)` 拿到「已渲染好的舞台尺寸」，再用 CDP 把舞台截成 PNG。
 *
 * 与 app 内聊天**同一份** mermaid、同一套安全措施（lib/mermaid-source-gate）：
 *  - `MERMAID_SAFE_CONFIG`（securityLevel strict + secure 键 + 标签文本的 DOMPurify 禁用清单）；
 *  - `createGatedMermaidPlugin`：render 前预扫源码，含外部资源引用（`<img>` / `url()` / http(s)…）直接抛错、不调 mermaid。
 * server 侧在发过来之前已经预扫过一次（mermaid-blocks.ts），这里是不依赖它的第二道；主进程的渲染窗口还有网络白名单做第三道。
 *
 * 页面契约（主进程依赖，改动要同步 electron-app/mermaid-render.mjs 的头注释）：
 *   `__flowshipMermaidReady === true` → 可调用；
 *   `__flowshipMermaidRender(source)` → `{ ok:true, width, height }`（舞台在 (0,0)、白底、CSS 像素）| `{ ok:false, error }`；
 *   `__flowshipMermaidClear()` → 清空舞台。
 */

import { createMermaidPlugin } from "@streamdown/mermaid";

import { MERMAID_SAFE_CONFIG, createGatedMermaidPlugin } from "@/lib/mermaid-source-gate";

export type MermaidImageResult =
  | { ok: true; width: number; height: number }
  | { ok: false; error: string };

declare global {
  interface Window {
    __flowshipMermaidReady?: boolean;
    __flowshipMermaidRender?: (source: string) => Promise<MermaidImageResult>;
    __flowshipMermaidClear?: () => void;
  }
}

/** 中文优先的无衬线字体栈（app 内聊天的 monospace 在图片里太散；飞书里是图，字体按系统常见中文字体回退） */
export const MERMAID_IMAGE_FONT_FAMILY =
  '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Helvetica Neue",Arial,sans-serif';

/** 与聊天页同构：上游插件 + 安全配置 + render 前预扫（聊天页见 components/markdown-text.tsx 的 GATED_MERMAID） */
const GATED = createGatedMermaidPlugin(createMermaidPlugin({ config: MERMAID_SAFE_CONFIG }));

const IMAGE_CONFIG = {
  theme: "default" as const,
  fontFamily: MERMAID_IMAGE_FONT_FAMILY,
  themeVariables: { fontFamily: MERMAID_IMAGE_FONT_FAMILY },
};

const errorText = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").trim().slice(0, 300) || "Mermaid 渲染失败";
};

/** 在 `stage` 里渲染并回报尺寸；永不抛 */
export const renderMermaidToStage = async (
  stage: HTMLElement,
  source: string,
  seq: number,
): Promise<MermaidImageResult> => {
  const id = `fs-mermaid-${seq}`;
  try {
    stage.replaceChildren();
    const { svg } = await GATED.getMermaid(IMAGE_CONFIG).render(id, source);
    // svg 来自 mermaid（strict 模式 + DOMPurify），且本窗口网络只通 server 自己的 origin
    stage.innerHTML = svg;
    const el = stage.querySelector("svg");
    if (!el) return { ok: false, error: "没有生成图形" };
    // mermaid 默认给 svg 写 width=100% + max-width：舞台是 max-content、没有可参照的容器宽度，改成 viewBox 的实际尺寸
    const vb = el.viewBox?.baseVal;
    const box = el.getBoundingClientRect();
    const w = Math.ceil(vb && vb.width > 0 ? vb.width : box.width);
    const h = Math.ceil(vb && vb.height > 0 ? vb.height : box.height);
    if (!(w > 0) || !(h > 0)) return { ok: false, error: "图形尺寸为空" };
    el.setAttribute("width", String(w));
    el.setAttribute("height", String(h));
    el.style.maxWidth = "none";
    el.style.display = "block";
    // 字体加载完再量（CJK 字体回退可能改变文字宽度）；不用 requestAnimationFrame：窗口是隐藏的，rAF 不保证触发
    try {
      await document.fonts?.ready;
    } catch {
      /* 非关键 */
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const rect = stage.getBoundingClientRect();
    return { ok: true, width: rect.width, height: rect.height };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  } finally {
    // mermaid 渲染中临时挂在 body 上的容器（出错时可能残留）
    document.getElementById(`d${id}`)?.remove();
  }
};

/** 往 window 上挂页面契约；返回卸载函数 */
export const installMermaidImageRenderer = (stage: HTMLElement): (() => void) => {
  let seq = 0;
  window.__flowshipMermaidRender = (source) => renderMermaidToStage(stage, String(source ?? ""), ++seq);
  window.__flowshipMermaidClear = () => stage.replaceChildren();
  window.__flowshipMermaidReady = true;
  return () => {
    window.__flowshipMermaidReady = false;
    delete window.__flowshipMermaidRender;
    delete window.__flowshipMermaidClear;
  };
};
