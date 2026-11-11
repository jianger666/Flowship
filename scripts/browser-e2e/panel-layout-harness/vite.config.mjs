// 面板排版 e2e harness 打包配置（由 r13-panel-layout.cjs 以 `vite build --config <本文件> --outDir <临时目录>` 调用）。
// 与 layout-harness/ 的区别：这里**不**把 BrowserPanel 换成桩，并且接真 Tailwind（@tailwindcss/postcss 吃仓库的 globals.css），
// 否则量不到真实排版。不进 next build、不产生仓库内产物；vite 来自 vitest 的依赖（见脚本里的定位逻辑）。
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const req = createRequire(path.join(repo, "package.json"));
const tailwind = req("@tailwindcss/postcss");

export default {
  root: here,
  logLevel: "error",
  define: { "process.env.NODE_ENV": '"development"' },
  oxc: { jsx: { runtime: "automatic" } },
  css: { postcss: { plugins: [tailwind({ base: repo })] } },
  resolve: {
    alias: [{ find: /^@\//, replacement: path.join(repo, "src") + "/" }],
    dedupe: ["react", "react-dom"],
  },
  build: {
    emptyOutDir: true,
    minify: false,
    cssCodeSplit: false,
    lib: { entry: path.join(here, "harness.tsx"), formats: ["iife"], name: "H", fileName: () => "harness.js", cssFileName: "harness" },
  },
};
