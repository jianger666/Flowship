"use client";

/**
 * Mermaid 出图渲染页：只给桌面壳主进程的隐藏窗口用（electron-app/mermaid-render.mjs），不在任何导航里出现。
 * 飞书回复里的 ```mermaid 在这里渲染、被截成 PNG 后发飞书。逻辑与契约见 lib/mermaid-image-render.ts；
 * 本页是「裸路由」（lib/bare-routes）：不套侧栏 / 顶栏 / 全局监听，页面上只有一块白底舞台。
 */

import { useEffect, useRef } from "react";

import { installMermaidImageRenderer } from "@/lib/mermaid-image-render";

const MermaidRenderPage = () => {
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // 白底、浅色：截图要的是一张独立的图，不跟随系统深色（ThemeProvider 在裸路由里不挂载，这里再钉死一遍）
    const root = document.documentElement;
    const prev = { rootBg: root.style.background, bodyBg: document.body.style.background, scheme: root.style.colorScheme };
    root.style.background = "#fff";
    document.body.style.background = "#fff";
    root.style.colorScheme = "light";
    const uninstall = installMermaidImageRenderer(stage);
    return () => {
      uninstall();
      root.style.background = prev.rootBg;
      document.body.style.background = prev.bodyBg;
      root.style.colorScheme = prev.scheme;
    };
  }, []);

  return (
    <>
      {/* `next dev` 会在视口左下角挂一个「N」开发提示（<nextjs-portal>），截图的视口就是舞台大小，它会盖进图里；
          本页只给截图用、不给人看，隐藏掉（打包版是生产构建本来就没有） */}
      <style>{"nextjs-portal{display:none !important}"}</style>
      <div
        ref={stageRef}
        id="mermaid-stage"
        // 舞台贴左上角、宽度由内容决定；padding 即图片四周的留白
        style={{ position: "absolute", left: 0, top: 0, padding: 16, background: "#fff", width: "max-content" }}
      />
    </>
  );
};

export default MermaidRenderPage;
