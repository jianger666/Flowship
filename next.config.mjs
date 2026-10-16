import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CSP 违规上报端点（app/api/csp-report/route.ts；全站 /api/** 的 middleware 守门同样适用于它）
 */
const CSP_REPORT_PATH = "/api/csp-report";

/**
 * 拼 Content-Security-Policy-Report-Only 策略串。
 *
 * ⚠️ 只做 Report-Only（观察期）：浏览器照常加载一切资源，只是把「若 enforce 会被拦」的
 * 违规 POST 到 /api/csp-report。我们没法在浏览器 / Electron 里验证 enforce 后的表现
 * （Next 内联脚本、HMR、mermaid / katex / streamdown 等），所以先收集、观察几个版本后
 * 再收紧并改成 enforce。**别把 header 名直接改成 Content-Security-Policy**——
 * tests/csp-headers.test.ts 会拦这个误改。
 *
 * 各指令的取值都来自读代码的结论（grep src/ + 读依赖 dist），不是凭空写的；
 * 偏宽松、以「不产生大量噪音」为准，每个宽松项都写了「为什么暂时需要」与「enforce 前怎么收」。
 * 策略串里不能有换行（header 值），所以用数组 join。
 *
 * @param {boolean} isProd 生产构建（`next build` 时 NODE_ENV=production）；dev 才需要的放行项按它切开，
 *   这样生产 Report-Only 能真实反映「生产代码有没有用到 eval / HMR 连接」。
 */
const buildCspReportOnlyPolicy = (isProd) =>
  [
    // 兜底：未单独列出的类型（manifest / media / prefetch 等）只允许同源。
    // 本项目没有 <video> / <audio> / <form>，没有 next/font，也没有任何 <link> 外链样式 / 字体。
    "default-src 'self'",

    // script-src —— 暂时最宽的一项：
    // - 'unsafe-inline'：Next App Router 往 HTML 里注入内联 <script>（self.__next_f.push 的 RSC
    //   flight 数据 + 启动脚本）；next-themes 注入首帧前定主题的内联脚本（见 app/layout.tsx 注释）；
    //   /api/mcp-oauth/callback 返回的 HTML 页自带内联 <script>（postMessage + window.close）。
    //   enforce 前收敛：改 nonce（middleware 逐请求生成 + 'strict-dynamic'）或 hash，
    //   mcp-oauth 回调页单独给 nonce；做完去掉 'unsafe-inline'。
    // - 'unsafe-eval'：**仅 dev**。React 19 开发态 / Turbopack、webpack 开发运行时用 eval 做 source map
    //   与调用栈还原，缺它 dev 会刷一屏违规。生产不加：生产客户端代码没有 eval ——
    //   mermaid（lodash 的 `Function("return this")()`）只是 `self` 不存在时才走的死兜底，浏览器里走不到；
    //   shiki 用 JS 正则引擎（@streamdown/code 用 createJavaScriptRegexEngine），没有 WASM 编译；
    //   katex 无 eval。所以生产 Report-Only 不带 unsafe-eval，若真有 eval 会被上报、一条去重日志即可暴露。
    `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,

    // style-src —— 'unsafe-inline' 暂时需要：app/layout.tsx 内联 <style>（搜索高亮 ::highlight）、
    // SSR 输出里大量 style="" 属性（tailwind / framer-motion / react-virtuoso / katex 输出）、
    // mermaid 往 SVG 里注入 <style>、/api/mcp-oauth/callback 页内联 <style>。
    // enforce 前收敛：style 属性是最难清的一块，先看上报量；<style> 标签可改 nonce / 把
    // 高亮 CSS 外移成静态文件。
    "style-src 'self' 'unsafe-inline'",

    // img-src：
    // - data:：粘贴图片预览的 dataUrl（use-image-attach / optimistic-submit）、docx 预览里 mammoth
    //   转出的 base64 内嵌图（preview-html-sanitize 只放行 data:image base64）、globals.css 里
    //   mask 用的 data:image/svg+xml
    // - blob:：src 里 <img> 暂无 blob 用法，作为保守放行（enforce 前若零上报可去掉）
    // - https:：Markdown 里 AI 输出 / 飞书内容的远程图（Streamdown 的 harden 默认不限图片 host）、
    //   docx 外链图。故意不放 http:：本地图一律走同源 /api/local-image，明文 http 图若出现会被上报，正好看看有没有
    // enforce 前收敛：https: 是内容驱动、很难列白名单——大概率保留，或改成「只允许 https + 同源」。
    "img-src 'self' data: blob: https:",

    // font-src：katex.min.css 的 @font-face 是相对路径（fonts/KaTeX_*.woff2），打包后落在
    // /_next/static/media（同源），小字体可能被内联成 data:。没有 next/font、没有 Google Fonts / CDN。
    // enforce 前收敛：若 data: 零上报可去掉。
    "font-src 'self' data:",

    // connect-src：客户端所有 fetch / SSE（/api/**、watch-task 流）都是同源 —— grep 不到写死外部
    // host 的 fetch，src/ 里也没有 new WebSocket / EventSource；GitLab / 飞书 / Meegle 请求全在 server 侧。
    // - https:：Streamdown 2.5 的图片「下载」按钮会 fetch(图片 src)（node_modules/streamdown dist），
    //   图片 src 可以是任意 https 远程地址
    // - dev 额外放行 ws://127.0.0.1:* / ws://localhost:*：Turbopack / webpack HMR 的 WebSocket
    //   （CSP3 的 'self' 在部分内核不覆盖 ws，显式列出最稳）；生产没有任何 WebSocket，不放行
    // enforce 前收敛：https: 能否收窄取决于「图片下载」的使用面——可考虑把下载改走同源代理后去掉。
    `connect-src 'self' https:${isProd ? "" : " ws://127.0.0.1:* ws://localhost:*"}`,

    // frame-src：唯一的 <iframe> 是本地文件预览的 PDF（components/ui/local-file-preview-body.tsx：
    // fetch → URL.createObjectURL → iframe src=blob:）。不放 data:——src 里没有 data: iframe / srcdoc，
    // 而 data: 子框架是常见的注入落点。
    "frame-src 'self' blob:",

    // worker-src：src 里没有 new Worker；blob: 作为保守放行（打包进来的库可能起 blob worker，
    // 无法在浏览器验证）。enforce 前若零上报收窄成 'self'。
    "worker-src 'self' blob:",

    // 无 <object> / <embed> / <applet> 用法，直接禁。
    // ⚠️ 待验证：Chromium 内置 PDF 查看器渲染 iframe 里的 PDF 时是否会触发 object-src 违规
    // （Report-Only 下只是多一条上报、不影响功能）；enforce 前要看上报里有没有 PDF 相关条目。
    "object-src 'none'",

    // 没有 <base> 用法。防「注入 <base href> 劫持相对路径脚本」。
    "base-uri 'self'",

    // 没有 <form> 提交；OAuth 授权是 window.open 外部链接，不是表单。
    "form-action 'self'",

    // Electron 主窗口顶层加载，不被任何页面嵌入；同源 iframe 也不存在。
    "frame-ancestors 'self'",

    // 旧式 report-uri（发 application/csp-report）。相对路径按文档 URL 解析 → 同源 127.0.0.1:<端口>。
    // 不用 report-to / Reporting-Endpoints：多一个 header 且只有 Chromium 系支持；收集端点两种报文都能解析，
    // 以后要迁移直接加 header 即可。
    `report-uri ${CSP_REPORT_PATH}`,
  ].join("; ");

/**
 * Next 配置（v1.0：从 next.config.ts 转 .mjs）
 *
 * 为什么用 .mjs 不用 .ts（踩坑记账）：Next 15.5.20 起（CR-06 依赖升级引入）、`.ts` 配置
 * 在 **standalone server 启动时**会走 next-config-ts 转译路径、require `next/dist/lib/typescript/*`；
 * 而本文件的 outputFileTracingExcludes 里 `node_modules/**​/typescript/**` 这条（本意排 typescript 包）
 * 把 Next 自己的 `dist/lib/typescript/` 也一并删了 → 打包态启动 `Cannot find module
 * required-packages` 崩溃（dev/build 不复现、只 standalone 挂）。改 .mjs 后 Next 原生加载、
 * 不再转译配置、彻底绕开该路径。
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  // 固定 file tracing root 为项目根——home 目录下有杂散 lockfile 时 Next 会把
  // workspace root 推断到 ~、导致 standalone 产物嵌套整段 Documents/my/... 路径
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  // 打包瘦身：把「运行时根本不会被 require、却被 file-tracing 保守拖进 standalone」
  // 的死重包显式排除（合计 ~26M）：
  // - sharp / @img(libvips)：next/image 的可选 native 依赖、本项目 UI 全自绘不用 next/image
  // - typescript：本是 devDep、server.js 启动用预序列化 config、不加载配置源
  //   ⚠️ 精确到 .pnpm/typescript@* + 顶层 typescript 包、**别用 `**​/typescript/**`**——
  //   那会连 Next 自己的 next/dist/lib/typescript 一起删、15.5.20+ standalone 启动崩
  // - caniuse-lite：browserslist 构建期专用、production server 不 require
  outputFileTracingExcludes: {
    "*": [
      "node_modules/**/sharp/**",
      "node_modules/**/@img/**",
      "node_modules/.pnpm/typescript@*/**",
      "node_modules/typescript/**",
      "node_modules/**/caniuse-lite/**",
    ],
  },
  // @cursor/sdk 是 server-only 的大依赖、让 Next 不打进 bundle、
  // 运行时直接 require；同时回避 webpack 解析 SDK 自带的 .d.ts.map
  // 时报 "Module parse failed: Unexpected token" 的问题。
  // @cursor/sdk / pi 都是 server-only 的大依赖、让 Next 不打进 bundle、
  // 运行时直接 require；同时回避 webpack 解析 SDK 自带的 .d.ts.map
  // 时报 "Module parse failed: Unexpected token" 的问题。
  // pi 系列还依赖 bundler-opaque 的动态 import（./api/* ./providers/*），
  // 必须外部化才能解析到其 dist 子路径。
  serverExternalPackages: [
    "@cursor/sdk",
    "ssh2",
    "zod",
    "zod-to-json-schema",
    // 仅 pi 系列需要 external：它们用 bundler-opaque 动态 import（./api/* ./providers/*）、
    // webpack 打包会 resolve 不到这些子路径；openai/anthropic/glob/typebox 都是普通 ESM、
    // webpack 能正常打包、external 反而当 CJS 处理会炸
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
  ],
  // 开发一律 Turbopack（`next dev --turbo`）。必须有非空 leaf（空 `{}` 会被 Next
  // flattenKeys 当成「没配 turbo」）——root 与 outputFileTracingRoot 同口径。
  turbopack: {
    root: path.dirname(fileURLToPath(import.meta.url)),
  },
  // 仅 `next build` 走 webpack（`next start` 只跑构建产物）。server 侧 `node:xxx`
  // 全走运行时 require（默认 externalsPresets 覆盖不到、会报 UnhandledSchemeError）。
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals ?? [];
      const list = Array.isArray(config.externals) ? config.externals : [config.externals];
      list.push(({ request }, callback) => {
        if (request && request.startsWith("node:")) {
          return callback(null, `commonjs ${request}`);
        }
        // ssh2 的可选原生依赖 cpu-features：本机没构建 .node 二进制、
        // webpack 硬打包会 Module not found；外部化后运行时 require 失败
        // 由 ssh2 自己的 try/catch 降级（纯 JS 实现照样可用）
        if (request === "cpu-features") {
          return callback(null, "commonjs cpu-features");
        }
        callback();
      });
      config.externals = list;
    }
    return config;
  },
  // 全站下发 CSP Report-Only（策略与各指令依据见 buildCspReportOnlyPolicy；**不下发 enforcing 版本**）。
  //
  // 为什么 standalone 产物里 headers() 照样生效（读 Next 15.5.20 源码得出，未靠运行验证）：
  // - build 时求值：`next build` → build/index.js 调 loadCustomRoutes(config) → config.headers()，
  //   结果写进 `.next/routes-manifest.json` 的 `headers` 字段（build/index.js 生成 routesManifest 处）
  // - 运行时只读 manifest：生产态（非 dev）server/lib/router-utils/filesystem.js 直接用
  //   `routesManifest.headers` 建路由表，**不会再调 config.headers()**；只有 dev 分支才
  //   `loadCustomRoutes(opts.config)` 现算
  // - standalone 的 server.js 把 nextConfig 用 JSON.stringify 内联（build/utils.js 写 server.js 处），
  //   函数字段（含 headers）因此被剥光——但上面两点说明运行时本来就不需要它。
  //   startServer 没传 minimalMode，resolve-routes.js 里 `opts.minimalMode ? [] : fsChecker.headers`
  //   走的是非 minimal 分支，manifest 里的 headers 会被应用
  // - routes-manifest.json 在 required-server-files 的 files 清单里、会进 standalone/.next；
  //   scripts/lib/assemble-server.mjs 整目录拷 standalone 且只裁 node_modules，不碰它
  // dev（`next dev --turbo`）：headers 由 Next 的 router-server 在 bundler 之外应用，Turbopack 不参与；
  // Report-Only 也不会拦任何资源，所以 dev 不会因此坏掉。
  // 在函数内读 NODE_ENV（而不是模块顶层）：build 时求值为 production、dev 为 development，
  // 也方便测试里 stub 环境后重复调用。
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        {
          key: "Content-Security-Policy-Report-Only",
          value: buildCspReportOnlyPolicy(process.env.NODE_ENV === "production"),
        },
      ],
    },
  ],
  // Electron 桌面端打包：CI 设 BUILD_STANDALONE=1 产出自包含 server.js + 最小 node_modules、
  // 由 assemble-electron-server.mjs 组进安装包 resources。日常 dev / `pnpm serve`（next start）
  // 不开——standalone 模式下 next start 不可用、两条路用 env 隔开互不影响。
  output: process.env.BUILD_STANDALONE ? "standalone" : undefined,
};

export default nextConfig;
