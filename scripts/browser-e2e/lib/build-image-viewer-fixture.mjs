#!/usr/bin/env node
/**
 * 把「真实的 ImageViewer + 真实的 Dialog + 真实的 Tailwind 样式」打成一个可以在真 Chromium 里打开的静态夹具。
 *
 *   node scripts/browser-e2e/lib/build-image-viewer-fixture.mjs <输出目录>
 *
 * 输出：`<输出目录>/app.js`（IIFE，入口见 fixtures/image-viewer-entry.mjs）、`app.css`（src/app/globals.css 经 Tailwind v4 编译）、`index.html`。
 *
 * 为什么要这样做：本仓 vitest 没有 DOM，ImageViewer 的「右键菜单盖不盖得住弹窗 / Esc 先关菜单还是先关弹窗 / 右键会不会开始拖拽 /
 * ⌘C 到不到得了处理器」只有在真 Chromium + 真 CSS 里才有答案。构建只用仓库里已有的依赖（vite 借 vitest 的、postcss 借 @tailwindcss/postcss 的），
 * 不新增依赖、不改 package.json。
 *
 * 由 e2e 脚本（r7-image-viewer-copy.cjs）经 `ELECTRON_RUN_AS_NODE=1` 起子进程调用；也可以直接用 node 跑（调试用）。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const require = createRequire(path.join(repoRoot, "package.json"));

/**
 * 从 `fromPkg` 这个包（顶层 node_modules 里的符号链接 → pnpm 仓库里的真实目录）出发解析 `name`。
 * pnpm 严格模式下只有直接依赖在顶层 node_modules；传递依赖（vite、postcss）要从依赖它的包的真实目录往上找。
 * 不用 `require.resolve("<pkg>/package.json")`：有的包的 exports 没放行 package.json。
 */
const resolveFrom = (fromPkg, name) => {
  const real = fs.realpathSync(path.join(repoRoot, "node_modules", ...fromPkg.split("/")));
  return createRequire(path.join(real, "noop.js")).resolve(name);
};

export const buildImageViewerFixture = async (outDir) => {
  fs.mkdirSync(outDir, { recursive: true });

  // 1) JS：vite（借 vitest 依赖的那份）lib 模式打 IIFE
  const vite = await import(pathToFileURL(resolveFrom("vitest", "vite")).href);
  await vite.build({
    configFile: false,
    root: repoRoot,
    logLevel: "warn",
    publicDir: false,
    resolve: { alias: { "@": path.join(repoRoot, "src") } },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // 仓库的 tsconfig 是 jsx: react-jsx（自动运行时）；configFile:false 时不会替我们推断，显式声明
    oxc: { jsx: { runtime: "automatic" } },
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      lib: {
        entry: path.join(repoRoot, "scripts/browser-e2e/fixtures/image-viewer-entry.mjs"),
        formats: ["iife"],
        name: "ImageViewerFixture",
        fileName: () => "app.js",
      },
    },
  });

  // 2) CSS：真实的 globals.css 经 Tailwind v4 编译（扫描整个仓库的 class，所以 ImageViewer / Dialog / ContextMenu 的类都在）
  const postcssPath = resolveFrom("@tailwindcss/postcss", "postcss");
  const postcss = require(postcssPath);
  const tailwind = require("@tailwindcss/postcss");
  const cssFile = path.join(repoRoot, "src/app/globals.css");
  const css = fs.readFileSync(cssFile, "utf8");
  const result = await postcss([tailwind({ base: repoRoot })]).process(css, { from: cssFile });
  fs.writeFileSync(path.join(outDir, "app.css"), result.css);

  // 3) 页面壳（html 上挂 light：与 next-themes 的 class 约定一致）。
  //    两个测试开关（必须在 app.js 之前执行）：`?nocb=1` 删掉 ClipboardItem（模拟「环境不支持复制图片」，如非安全上下文的 dev:web）；
  //    `?platform=darwin|win32|linux` 注入 window.__shell.platform（真壳里由 preload 提供，决定 ⌘C / Ctrl+C 的口径与提示文案）
  const bootstrap =
    `(function(){var q=new URLSearchParams(location.search);` +
    `if(q.get("nocb")==="1"){delete window.ClipboardItem;}` +
    `var p=q.get("platform");if(p){window.__shell={platform:p};}})();`;
  fs.writeFileSync(
    path.join(outDir, "index.html"),
    `<!doctype html><html lang="zh-CN" class="light"><head><meta charset="utf-8"><title>image-viewer fixture</title>` +
      `<link rel="stylesheet" href="/app.css"><script>${bootstrap}</script></head>` +
      `<body class="bg-background text-foreground"><div id="root"></div><script src="/app.js"></script></body></html>`,
  );
  return { js: path.join(outDir, "app.js"), css: path.join(outDir, "app.css"), html: path.join(outDir, "index.html") };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("用法：node scripts/browser-e2e/lib/build-image-viewer-fixture.mjs <输出目录>");
    process.exit(2);
  }
  buildImageViewerFixture(path.resolve(out)).then(
    (r) => console.log(JSON.stringify(r)),
    (e) => {
      console.error(e && e.stack ? e.stack : e);
      process.exit(1);
    },
  );
}
