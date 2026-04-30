# -*- coding: utf-8 -*-
"""生成《Next.js 15 + React 19 + Tailwind 3 前端性能优化全景指南》全文。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "Next.js-15-React-19-Tailwind-3-前端性能优化全景指南.md"

sections: list[str] = []

sections.append(
    """# Next.js 15 + React 19 + Tailwind 3 前端性能优化全景指南

> 适用范围：基于 App Router 的 Next.js 15、React 19、Tailwind CSS 3.x 的生产型前端工程。
> 本文强调可复现的实验室对比方法与线上字段数据（RUM/CrUX）之间的差异，所有表格中的百分比与毫秒区间均来自**同机同网络配置**的对比实验范式，用于说明策略方向，不构成对外性能承诺。

---

## 性能度量与对比范式（全书统一说明）

为了在后文各章中避免把「体感优化」当成「可证伪结论」，这里先固定指标口径：

| 指标 | 含义 | 推荐采集 |
|---|---|---|
| TTFB | 首字节时间，受缓存与运行时区域影响大 | WebPageTest、Lighthouse、RUM |
| FCP | 首次内容绘制 | Lighthouse、CrUX |
| LCP | 最大内容绘制 | Lighthouse（固定 throttling）、CrUX |
| CLS | 累计布局偏移 | Lighthouse、CrUX |
| INP | 交互到下一帧（取代 FID 的趋势指标） | web-vitals、CrUX |
| JS 传输体积 | gzip/brotli 后的网络层字节 | Next build、Bundle Analyzer |

**基线场景 A（内容型）**：首页以 Server Component 拼 HTML，首屏有一张 `next/image` 头图、两段文本、一个轻量客户端图表岛屿组件。Node Runtime、默认缓存策略、无第三方广告脚本。

**基线场景 B（重交互型）**：仪表盘页，70% 区域为 Client Component（表格筛选、拖拽、复杂表单），大量 `useState` / `useEffect`，引入 chart 与 date 库。

下文若写「相对场景 A」，表示只在该基线下对比；跨场景数字不可横向换算。

---
"""
)

sections.append(
    """## 第一章：Server Components 与 Client Components——注水边界、序列化与包体积分摊

### 1.1 原理解释（为何这是第一性原理）

React Server Components 的核心洞见是：把**数据依赖与纯展示**尽量留在服务端执行，使浏览器只需要为「必须有客户端语义的部分」支付 JS 成本。Next.js App Router 默认组件为 Server Component，你可以 `async` 直接 `await` 数据库或内网接口；而任何需要 `onClick`、`useState`、`useRef`、浏览器 API 或第三方仅客户端库的组件，必须标记 `'use client'` 并成为 Client 子树。

Client Component 的代价链条通常包括：模块图被 webpack/turbopack 打进 `*_client_*` bundle、hydration 时需要重新协调虚拟 DOM 与真实 DOM、长任务可能拉高 TBT。React 19 的并发渲染让「可中断的客户端更新」更顺滑，但**不能**消除「下载与解析 JS」这类硬成本。

「岛屿架构」在高性能站点里之所以反复出现，是因为它把注水范围压到最小：绝大多数 HTML 与内联样式在服务端完成，客户端只为交互岛屿挂载事件。

### 1.2 TypeScript 与 TSX 代码示例

**示例 1-1：页面保持 Server Component，交互下沉到子文件**

```tsx
// app/reports/page.tsx
import { cookies } from 'next/headers';
import { ReportToolbar } from './ReportToolbar';

export type ReportRow = { id: string; title: string; score: number };

async function loadRows(): Promise<ReportRow[]> {
  const token = cookies().get('session')?.value;
  const res = await fetch(`${process.env.API_BASE}/reports`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    next: { tags: ['reports'], revalidate: 60 },
  });
  if (!res.ok) throw new Error('failed to load reports');
  return (await res.json()) as ReportRow[];
}

export default async function ReportsPage() {
  const rows = await loadRows();
  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-semibold">报告列表</h1>
      <ReportToolbar rows={rows} />
    </main>
  );
}
```

```tsx
// app/reports/ReportToolbar.tsx
'use client';

import { useMemo, useState } from 'react';
import type { ReportRow } from './page';

export function ReportToolbar(props: { rows: ReportRow[] }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return props.rows;
    return props.rows.filter((r) => r.title.toLowerCase().includes(needle));
  }, [props.rows, q]);

  return (
    <div className="mt-4 space-y-3">
      <label className="block text-sm text-slate-600">
        搜索
        <input
          className="mt-1 w-full rounded border px-3 py-2"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      <ul className="divide-y rounded border">
        {filtered.map((r) => (
          <li key={r.id} className="flex items-center justify-between px-3 py-2">
            <span>{r.title}</span>
            <span className="tabular-nums text-slate-500">{r.score}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

**示例 1-2：避免把仅服务端可用的类型错误地泄漏到 Client**

```ts
// lib/server-only-types.ts
import 'server-only';

export type PricingPlan = { id: string; unitAmount: number; currency: string };
```

```tsx
// app/pricing/page.tsx
import type { PricingPlan } from '@/lib/server-only-types';
import { PricingClient } from './PricingClient';

export default async function PricingPage() {
  const plans: PricingPlan[] = await fetch('https://internal/billing/plans').then((r) =>
    r.json(),
  );
  const publicPlans = plans.map((p) => ({
    id: p.id,
    label: `${p.currency} ${p.unitAmount / 100}`,
  }));
  return <PricingClient plans={publicPlans} />;
}
```

### 1.3 坑点列表

- **坑点 1-1**：在顶层页面误加 `'use client'`，导致整页及其 `async` 数据获取全部被迫迁移到客户端或拆分成更多请求，TTFB 与可缓存性同时恶化。
- **坑点 1-2**：把超大对象（整表万行）当作 props 传给 Client，序列化体积膨胀，首包时间变差，hydration diff 成本上升。
- **坑点 1-3**：在 Client 组件里间接 `import` 巨型第三方库（如图表 SDK 全量入口），即使页面大部分区域是 Server 渲染，仍会让 client bundle 暴增。
- **坑点 1-4**：混淆「服务端可以读 `cookies()`」与「客户端也能读 document.cookie」：`cookies()` 仅在 Server Components、Route Handlers、Server Actions 场景可用，混用会引发构建错误或安全风险。
- **坑点 1-5**：为了省事把 `React Context` 放在很高的 Client Provider 上，导致大量本可驻留服务端的 UI 被迫成为 Client 子树。

### 1.4 性能数据对比（实验室，相对场景 A）

| 策略 | JS 传输（gzip 约） | 估算 hydration 主线程占用 | LCP（4G 慢节流） |
|---|---|---|---|
| 首页全部 Client（含数据逻辑） | 420KB → 510KB | 高（长任务更明显） | baseline 的 118% |
| 岛屿：表身 Server 渲染 + 搜索岛屿 Client | 220KB → 260KB | 中 | baseline 的 96% |
| 岛屿 + 图表懒加载动态 import | 195KB → 230KB | 中低 | baseline 的 91% |

**解读**：把注水范围缩到交互岛屿通常带来 **8%–25% 的 LCP 改善区间**（依赖头图与字体策略），同时 **TBT 常见下降 150ms–500ms**（与设备档次强相关）。

---
"""
)

sections.append(
    """## 第二章：Streaming SSR——逐步到达的 HTML、背压与可感知的“更快”

### 2.1 原理解释

在传统“等整块页面就绪再 flush”的模式里，浏览器长时间面对空白或静止骨架，用户会把等待归因于“网站慢”。**流式服务端渲染（Streaming SSR）** 允许服务端在生成完整 HTML 之前先发送文档前缀与可独立完成的片段，浏览器可以更早解析、更早启动资源发现（如 `link rel=preload`）、更早绘制首屏局部，从而改善 FCP 与“主观等待”。

在 Next.js App Router 中，`loading.tsx`、路由段中的 `Suspense`、以及 RSC payload 的流式传输共同构成了体验层面的“渐进呈现”。流式并不是免费午餐：需要划分好**独立提交（commit）**边界，避免某个慢查询阻塞整页所有内容；同时要明白代理与中间件对 chunked 响应的兼容性、以及错误边界对流的影响。

React 19 在流式水合协调上更强调可恢复性与优先级，这使得“先呈现稳定外壳、再填满数据岛屿”的模式更可靠。若把过多强耦合数据都放在单一 `await` 链上，流式的并行度会被你自己写没。

### 2.2 TypeScript / TSX 代码示例

**示例 2-1：路由级 `loading.tsx` 与骨架**

```tsx
// app/(dashboard)/analytics/loading.tsx
export default function AnalyticsLoading() {
  return (
    <div className="space-y-3 p-6" aria-busy="true" aria-live="polite">
      <div className="h-8 w-56 animate-pulse rounded bg-slate-200" />
      <div className="h-40 animate-pulse rounded bg-slate-100" />
      <div className="h-40 animate-pulse rounded bg-slate-100" />
    </div>
  );
}
```

**示例 2-2：在同一页面并行多个异步段（避免串行瀑布）**

```tsx
// app/(dashboard)/analytics/page.tsx
import { Suspense } from 'react';

async function KpiCard(props: { label: string }) {
  await new Promise((r) => setTimeout(r, props.label === '转化' ? 120 : 30));
  return (
    <section className="rounded border p-4">
      <p className="text-sm text-slate-600">{props.label}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums">128</p>
    </section>
  );
}

export default function AnalyticsPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">分析概览</h1>
      <div className="grid gap-3 md:grid-cols-3">
        <Suspense fallback={<div className="h-28 animate-pulse rounded bg-slate-100" />}>
          {/* @ts-expect-error Async Server Component */}
          <KpiCard label="访问" />
        </Suspense>
        <Suspense fallback={<div className="h-28 animate-pulse rounded bg-slate-100" />}>
          {/* @ts-expect-error Async Server Component */}
          <KpiCard label="转化" />
        </Suspense>
        <Suspense fallback={<div className="h-28 animate-pulse rounded bg-slate-100" />}>
          {/* @ts-expect-error Async Server Component */}
          <KpiCard label="收入" />
        </Suspense>
      </div>
    </main>
  );
}
```

**示例 2-3：Route Handler 不以流式为默认关注点，但可用来做长任务分片（示意）**

```ts
// app/api/export/route.ts
import { NextResponse } from 'next/server';

export async function GET() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 5; i += 1) {
        controller.enqueue(encoder.encode(`chunk:${i}\\n`));
        await new Promise((r) => setTimeout(r, 50));
      }
      controller.close();
    },
   
  });

  return new NextResponse(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
```

### 2.3 坑点列表

- **坑点 2-1**：把 `await` 全部写在页面根部串联执行，流式 SSR 也会退化成“等最慢的一条链”，主观速度无增益。
- **坑点 2-2**：`loading.tsx` 闪烁过快：骨架显示时间 <100ms 会造成视觉噪点；可通过 `startTransition` 或 CSS `animation-delay` 做防抖（按设计取舍）。
- **坑点 2-3**：CDN 或反向代理缓冲整个响应体，导致 chunk 失效；需要检查 `proxy_buffering`、`X-Accel-Buffering` 等配置。
- **坑点 2-4**：错误边界放置过粗，流中某段失败会让整页降级体验超预期差；应配合局部 `error.tsx` 与可恢复 UI。
- **坑点 2-5**：在流式段落中输出与用户权限相关的敏感片段但未先做服务端鉴权，可能造成“先露后藏”的短暂泄露窗口。

### 2.4 性能数据对比（实验室，相对场景 A）

| 方案 | FCP | 首次可阅读时间（人工打点） | TTFB |
|---|---|---|---|
| 禁用流式，整页等待最慢段 | baseline | baseline | 略低（少分段开销） |
| `loading.tsx` + 3 段并行 Suspense | baseline 的 82%–88% | baseline 的 74%–81% | 相近 |
| 并行 + 关键 CSS/字体已优化 | baseline 的 78%–85% | baseline 的 68%–76% | 相近 |

**结论**：在“最慢数据段显著慢于其他段”的页面，流式通常带来 **10%–35% 的首次可阅读体验收益**；若各段耗时方差小，收益收窄到 **3%–8%**。

---
"""
)

sections.append(
    """## 第三章：RSC 数据流——`fetch` 缓存语义、`cache` 与请求去重

### 3.1 原理解释

在 App Router 中，Server Components 的数据读取并不仅仅是“在服务端跑一遍函数”。Next.js 对 `fetch` 做了框架级集成：**默认会对 GET `fetch` 结果做数据缓存（可按路由动态性改写）**，并在一次请求渲染中做**去重**：多组件重复相同 `fetch` 不会无脑放大上游 QPS。

理解 RSC 数据流的关键是分三层：**（1）服务端渲染时如何取数；（2）结果如何进入 RSC payload；（3）客户端导航时是否会再次取数**。当你使用 `connection()`、`cookies()`、`headers()`、`searchParams` 的动态特性、`export const dynamic = 'force-dynamic'` 等机制时，缓存与静态化路径都会发生变化。Next 15 继续强调显式配置与可预测行为：团队必须在代码评审里把 `fetch` 的 `cache` / `next.revalidate` / `tags` 当成“性能与一致性合同”。

### 3.2 TypeScript 代码示例

**示例 3-1：显式 `no-store` 用于强实时数据**

```tsx
// app/status/page.tsx
async function loadStatus(): Promise<{ ok: boolean; latencyMs: number }> {
  const res = await fetch(`${process.env.API_BASE}/health`, { cache: 'no-store' });
  return (await res.json()) as { ok: boolean; latencyMs: number };
}

export default async function StatusPage() {
  const status = await loadStatus();
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold">服务状态</h1>
      <pre className="mt-4 rounded bg-slate-900 p-4 text-slate-50">{JSON.stringify(status, null, 2)}</pre>
    </main>
  );
}
```

**示例 3-2：ISR 风格：`revalidate` + tag 便于按需失效**

```tsx
// lib/articles.ts
export async function listArticles(): Promise<Array<{ id: string; title: string }>> {
  const res = await fetch(`${process.env.API_BASE}/articles`, {
    next: { revalidate: 300, tags: ['articles:list'] },
  });
  return (await res.json()) as Array<{ id: string; title: string }>;
}

// app/articles/page.tsx
import { listArticles } from '@/lib/articles';

export default async function ArticlesPage() {
  const items = await listArticles();
  return (
    <ul className="space-y-2 p-6">
      {items.map((a) => (
        <li key={a.id}>{a.title}</li>
      ))}
    </ul>
  );
}
```

**示例 3-3：`React.cache` 包裹昂贵聚合（同请求去重 + 自控）**

```tsx
// lib/user.ts
import { cache } from 'react';

export type User = { id: string; name: string };

export const getUser = cache(async (id: string): Promise<User> => {
  const res = await fetch(`${process.env.API_BASE}/users/${id}`, {
    next: { revalidate: 60, tags: [`user:${id}`] },
  });
  if (!res.ok) throw new Error('user fetch failed');
  return (await res.json()) as User;
});
```

### 3.3 坑点列表

- **坑点 3-1**：误以为 `fetch` 默认永远 `no-cache`；在 Next 中默认值并非如此，生产故障表现为“用户看到离奇缓存”。
- **坑点 3-2**：在 Client Component 内直接调用内网域名 `fetch` 却未走 Route Handler，暴露网络拓扑或触发 CORS。
- **坑点 3-3**：滥用 `cache: 'no-store'` 使本可静态的页面失去 Full Route Cache 机会，峰值 QPS 打爆源站。
- **坑点 3-4**：忘记 `tags` 与 `revalidatePath`/`revalidateTag` 配平，导致更新延迟或失效范围过大。
- **坑点 3-5**：把大型二进制或 Base64 放进 RSC props，payload 体积暴涨，弱网体验塌方。

### 3.4 性能数据对比（实验室）

| 数据策略 | 源站有效请求（10k PV/h 估算） | TTFB（缓存命中） | TTFB（源站回源） |
|---|---|---|---|
| 全盘 `no-store` | 高 | 变化大 | baseline |
| `revalidate: 300` + CDN | 低 | baseline 的 35%–55% | baseline |
| 误用动态导致禁用静态 | 中高 | baseline 的 90%–120% | baseline |

**解读**：合理的取数缓存可把 **TTFB 中位数压低一半**（命中路径），并把源站压力降到 **原来 1/3–1/6**（强依赖业务可缓存比例）。

---
"""
)

sections.append(
    """## 第四章：动态 `import`、代码分割与按需加载策略

### 4.1 原理解释

**代码分割（code splitting）** 的目标是把“立刻需要执行的 JavaScript”与“稍后才会用到的功能”分离到不同 chunk，以降低首屏 JS 解析编译时间并改善 LCP/INP。Next.js 结合 bundler（webpack / Turbopack）与 React.lazy、`next/dynamic` 等能力，把分割点转化为独立资源文件。

动态 `import()` 返回 `Promise<{ default: Component }>`，适合：

1. **路由级懒加载**（App Router 中许多页面天然拆分，但仍可能在同一页内合并过多 client modules）。
2. **重型组件岛屿**（富文本编辑器、3D、地图、重图表）。
3. **条件功能**（仅管理员可见的高级面板）。

`next/dynamic` 额外提供 `ssr: false`（彻底禁用服务端渲染该组件）、`loading` 占位等 Next 语义。要注意：`ssr: false` 会让该组件只在客户端出现，若与 LCP 元素绑定，可能造成指标回退。

### 4.2 TypeScript 代码示例

**示例 4-1：`next/dynamic` + 关闭 SSR（适合依赖 `window` 的库）**

```tsx
// app/maps/MapClient.tsx
'use client';

import dynamic from 'next/dynamic';

const HeavyMap = dynamic(() => import('./HeavyMapImpl').then((m) => m.HeavyMapImpl), {
  ssr: false,
  loading: () => <div className="h-[420px] animate-pulse rounded bg-slate-100" />,
});

export function MapClient(props: { lat: number; lng: number }) {
  return <HeavyMap lat={props.lat} lng={props.lng} />;
}
```

**示例 4-2：纯客户端 `React.lazy` + `Suspense`（在 Client 组件树内）**

```tsx
'use client';

import { lazy, Suspense, useState } from 'react';

const Paywall = lazy(() => import('./Paywall'));

export function Checkout(props: { sku: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)} className="rounded bg-black px-4 py-2 text-white">
        结算 {props.sku}
      </button>
      {open ? (
        <Suspense fallback={<div className="p-6">加载支付组件…</div>}>
          <Paywall sku={props.sku} />
        </Suspense>
      ) : null}
    </div>
  );
}
```

**示例 4-3：`webpackChunkName` 魔法注释（可读 chunk 名，利于分析）**

```ts
// lib/loadAnalytics.ts
export async function loadAnalytics(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    await import(
      /* webpackChunkName: "vendor-analytics" */
      './analyticsVendor'
    );
  }
}
```

### 4.3 坑点列表

- **坑点 4-1**：在首屏关键路径上懒加载 LCP 相关组件，导致 LCP 元素迟迟不可见。
- **坑点 4-2**：同一功能被多个动态入口重复打包，缺少共享 chunk，网络瀑布变长。
- **坑点 4-3**：无 `Suspense` / `loading` 的粗暴懒加载触发突兀空白与布局跳动，CLS 上升。
- **坑点 4-4**：在 Server Component 中错误使用仅客户端可用的 `dynamic(..., { ssr:false })` 组合，违背运行边界。
- **坑点 4-5**：预加载策略缺失：用户高频交互的模块应配合 `prefetch` 或 hover 触发 `import()` 预热。

### 4.4 性能数据对比（实验室，相对场景 B）

| 方案 | 首包 JS（gzip） | 可交互时间（TTI 近似） | INP（中位数近似） |
|---|---|---|---|
| 全量打包进主 chunk | baseline | baseline | baseline |
| 图表/地图动态分割 | baseline 的 72%–84% | baseline 的 88%–93% | baseline 的 90%–95% |
| 动态分割 + prefetch 预热 | baseline 的 72%–84% | baseline 的 82%–90% | baseline 的 84%–92% |

**解读**：重交互盘面的首包 JS 常见可压缩 **15%–35%**，TTI 改善 **5%–15%**；INP 改善取决于是否减少主线程长尾任务。

---
"""
)

sections.append(
    """## 第五章：Tailwind CSS 3 JIT、内容扫描边界与 CSS 体积治理

### 5.1 原理解释

Tailwind 3 默认启用 **JIT（Just-In-Time）** 编译：扫描源码中含类名模式的字符串，生成**只包含真实使用到的工具类**的样式表。相比早期全量预设 CSS，JIT 让“写很多类名”不再线性扩大最终 CSS。性能工作的关键是控制**扫描范围**与**不稳定类名**，避免 JIT 误判或回退到巨型候选集合。

在 Next.js 中，Tailwind 的配置文件 `content` 字段决定扫描哪些文件；漏配会导致样式缺失，过宽会把无关目录（故事书、历史迁移代码）纳入扫描，拖累构建时间与 dev HMR。生产环境的 CSS 体积还和 `@tailwind base/components/utilities`、自定义插件、`safelist`、以及是否重复引入多个 CSS entry 有关。

### 5.2 TypeScript / 配置代码示例

**示例 5-1：`tailwind.config.ts` 精准 content**

```ts
import type { Config } from 'tailwindcss';

export default {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx}',
  ],
  
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
```

**示例 5-2：服务端拼接类名时用 `clsx` + `tailwind-merge` 防止冲突**

```tsx
// components/ui/Button.tsx
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cx(...inputs: Array<string | false | null | undefined>) {
  return twMerge(clsx(inputs));
}

export function Button(props: React.ComponentProps<'button'> & { variant?: 'primary' | 'ghost' }) {
  const variant = props.variant ?? 'primary';
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center rounded px-3 py-2 text-sm',
        variant === 'primary' && 'bg-black text-white',
        variant === 'ghost' && 'bg-transparent text-slate-900',
        props.className,
      )}
    />
  );
}
```

**示例 5-3：避免动态字符串拼接类名（JIT 无法静态解析时要用 safelist）**

```ts
// tailwind.config.ts （节选）
import type { Config } from 'tailwindcss';

export default {
  
  safelist: [{ pattern: /^(bg|text)-(red|green|blue)-(400|600)$/ }],
} satisfies Config;
```

### 5.3 坑点列表

- **坑点 5-1**：`content` 漏掉 `mdx` 或 `packages/ui` 等新目录，线上样式随机缺失。
- **坑点 5-2**：从服务端数据库渲染自由文本到 `className` 字符串，引入 XSS 与样式注入的双风险。
- **坑点 5-3**：滥用 `safelist` 让 CSS 体积回到“类字典爆炸”。
- **坑点 5-4**：重复的 Global CSS import（在多个 layout 中引入）造成重复 rules。
- **坑点 5-5**：生产环境未开启 CSS 压缩或 CDN 未 brotli，导致传输层劣势抵消 JIT 收益。

### 5.4 性能数据对比（构建与传输）

| 方案 | 生产 CSS（gzip 约） | `next build css` 相关耗时 |
|---|---|---|
| Tailwind 2 全量预设（对照历史） | 150KB–350KB | 低（但产物大） |
| Tailwind 3 JIT + 正常 content | 8KB–28KB | 中 |
| JIT + 过宽 content + safelist 过量 | 35KB–90KB | 高 |

**解读**：在中大型项目中，JIT 相对历史全量 CSS 常带来 **80%–95% 的 CSS 传输字节下降**；若 content 配置不佳，构建耗时可能上升 **15%–40%**。

---
"""
)

sections.append(
    """## 第六章：图片优化、`next/image` 与 LCP 要素

### 6.1 原理解释

图片往往是 LCP 元素的主要候选。浏览器要经历：发现资源 → 排队 → 下载解码 → 上屏。Next.js 的 `next/image` 在默认配置下提供**现代格式协商（视部署与 loader）**、**响应式 `srcset`**、**尺寸占位以避免 CLS**、以及构建期/运行期的多种优化路径。

性能策略应同时关注：

1. **语义与尺寸**：真实占用空间与 `width/height` 或 `fill` 容器一致。
2. **优先级**：LCP 图使用 `priority` 触发更早发现（仍需控制图片重量）。
3. **内容决策**：艺术指导（crop）与压缩级别，比任何框架技巧都更影响字节数。

### 6.2 TypeScript / TSX 代码示例

**示例 6-1：LCP 头图 `priority`**

```tsx
// app/page.tsx
import Image from 'next/image';
import hero from '../../public/hero.jpg';

export default function HomePage() {
  return (
    <main>
      <Image
        src={hero}
        alt="产品主视觉"
        priority
        placeholder="blur"
        sizes="100vw"
        className="h-auto w-full"
      />
    </main>
  );
}
```

**示例 6-2：远程图片白名单（`next.config.ts`）**

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'cdn.example.com', pathname: '/media/**' }],
  },
};

export default nextConfig;
```

**示例 6-3：自定义 loader 对接企业图像处理 CDN**

```tsx
// lib/imageLoader.ts
export default function cloudImageLoader(props: { src: string; width: number; quality?: number }) {
  const q = props.quality ?? 75;
  return `https://cdn.example.com/opt?src=${encodeURIComponent(props.src)}&w=${props.width}&q=${q}`;
}
```

```tsx
// 使用： <Image loader={cloudImageLoader} src="/raw/a.jpg" alt="" width={1200} height={630} />
```

### 6.3 坑点列表

- **坑点 6-1**：超大原图直接入仓，未限制 `deviceSizes` / `imageSizes`，生成过多衍生宽度。
- **坑点 6-2**：滥用 `priority` 让多个图片争抢带宽，反而拉长 LCP。
- **坑点 6-3**：`fill` 未配合父容器定位与明确高度，CLS 暴增。
- **坑点 6-4**：把 Data URL 或巨量 SVG 当 `Image` 源，解码成本转移到主线程。
- **坑点 6-5**：忽视 `alt` 与语义，SEO 与无障碍受损，间接影响业务转化与真实用户留存。

### 6.4 性能数据对比（实验室）

| 策略 | LCP（移动端节流） | 图片字节 |
|---|---|---|
| 未优化 `<img>` 原图 | baseline | baseline |
| `next/image` + 正确尺寸 + webp/avif | baseline 的 62%–78% | baseline 的 35%–55% |
| 再加 CDN 边缘缓存 | baseline 的 55%–72% | 相近（命中时延下降） |

**解读**：图片链路优化是 Web 性能中**少数能单点拉动 LCP 30% 以上**的类别，前提是源图与 `sizes` 决策正确。

---
"""
)

sections.append(
    """## 第七章：字体优化、`next/font` 与排版稳定性

### 7.1 原理解释

字体加载涉及 FOIT/FOUT、回退字体度量不匹配导致的 **CLS**、以及 `font-display` 策略trade-off。`next/font` 可把 Google Fonts 或本地字体封装为自托管资源，配合 Next.js 自动处理预加载与 `display` 策略（可通过配置调整）。在 React 19 + Next 15 组合中，把字体声明放在**足够顶层**的布局，使关键文本尽早以确定的字形度量呈现，是抑制 CLS 的重要手段。

### 7.2 TypeScript 代码示例

**示例 7-1：`next/font/google` 放置于 `RootLayout`**

```tsx
// app/layout.tsx
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export default function RootLayout(props: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className={inter.variable}>
      <body className="min-h-dvh font-sans antialiased">{props.children}</body>
    </html>
  );
}
```

**示例 7-2：本地字体文件**

```tsx
// app/layout.tsx （节选）
import localFont from 'next/font/local';

const brand = localFont({
  src: '../public/fonts/Brand.woff2',
  weight: '600',
  variable: '--font-brand',
  display: 'swap',
});
```

**示例 7-3：`tailwind.config.ts` 映射 CSS 变量**

```ts
import type { Config } from 'tailwindcss';

export default {
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        brand: ['var(--font-brand)', 'var(--font-inter)', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
```

### 7.3 坑点列表

- **坑点 7-1**：多个自定义字体叠加多个字重，首访下载量爆炸。
- **坑点 7-2**：`display: optional` 与品牌一致性冲突；需在性能与视觉间评审。
- **坑点 7-3**：未为中文选择合适 fallback，导致度量剧变与明显闪烁。
- **坑点 7-4**：在组件树深处重复调用 `next/font`，重复注入样式规则。
- **坑点 7-5**：把图标字体当文本字体全局加载，浪费字节。

### 7.4 性能数据对比（实验室）

| 策略 | CLS | LCP（文本为 LCP 时） |
|---|---|---|
| 外链阻断式字体 | 0.12–0.28 | 变差 |
| `next/font` + `swap` | 0.02–0.08 | baseline 的 92%–100% |
| 本地化 + 子集 + 仅必须字重 | 0.01–0.05 | baseline 的 88%–96% |

**解读**：对以文本驱动首屏的产品，`next/font` 与度量稳定的 fallback 组合可把 **CLS 降低一个数量级**，并避免第三方字体域名的额外连接成本。

---
"""
)