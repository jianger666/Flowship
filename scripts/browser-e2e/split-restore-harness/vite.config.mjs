// 任务页分栏收起态恢复 e2e harness 的打包配置（由 r17-task-split-restore.cjs 以 `vite build --config <本文件> --outDir <临时目录>` 调用）。
// 不接 Tailwind（只量 Panel 的宽度，分隔条的宽度由脚本里的内联样式给）。不进 next build、不产生仓库内产物；
// vite 来自 vitest 的依赖（见脚本里的定位逻辑）。
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");

export default {
  root: here,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": '"development"' },
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: [{ find: /^@\//, replacement: path.join(repo, "src") + "/" }],
    dedupe: ["react", "react-dom"],
  },
  build: {
    emptyOutDir: true,
    minify: false,
    lib: { entry: path.join(here, "harness.tsx"), formats: ["iife"], name: "H", fileName: () => "harness.js" },
  },
};
