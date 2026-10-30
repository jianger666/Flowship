/**
 * 「有记录读不出来」灰条（Q9-08）的前端侧：文案、SSR 渲染、store 合并、接线、不落盘契约
 *
 * 服务端读 events.jsonl 遇到坏行时，`Task.eventsSkipped` 带上条数（见 events-bad-lines.test.ts / watch-task-events-skipped.test.ts）；
 * 界面在事件流顶部画一条灰色信息提示 `EventsSkippedNotice`，叠在存储降级红条之下。
 * 项目里没有 DOM 测试环境，所以走 renderToStaticMarkup 的 SSR 冒烟（手法同 storage-degraded-bar.test.ts），守的是：
 *   A. 文案口径：「至少 N 处」而不是「共 N 条」；不出现路径 / 偏移 / errno
 *   B. 渲染：role="note"（不是 alert，不打断读屏）；颜色走 muted 语义 token；字号 ≥ 11px、文字不叠 alpha；静止；className 透传
 *   C. task-store 合并：快照没带 eventsSkipped 时沿用本地的（提示不在两帧之间闪），带了就以快照为准；回退后的权威快照不沿用
 *   D. 接线（源码契约）：event-stream 在红条之后、列表之前渲染它；条件是 truthy 三元（0 不会渲染成文本「0」）
 *   E. 不落盘：`eventsSkipped` 只出现在约定的几个文件里（types / 文案 / hydrate / store / 事件流 / 组件）——
 *      没有进 meta schema、没有被任何 writeMeta 路径带上
 *
 * 样式只看「渲染出来的 class」、不读源码（cn() 合并后的结果才是用户拿到的）；源码文本层面的扫描由
 * ui-convention-scan.test.ts 的 FIXED_FILES 守（新组件已登记）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EventsSkippedNotice } from "@/components/tasks/events-skipped-notice";
import { describeEventsSkipped } from "@/lib/events-skipped";
import {
  mergeTaskEvents,
  replaceTaskEventsWithSnapshot,
} from "@/lib/task-store";
import type { Task, TaskEvent } from "@/lib/types";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const readSrc = (rel: string): string => readFileSync(path.join(srcDir, rel), "utf-8");

const render = (count: number, className?: string): string =>
  renderToStaticMarkup(createElement(EventsSkippedNotice, { count, className }));
const rootClass = (html: string): string =>
  /^<div\b[^>]*\bclass="([^"]*)"/.exec(html)?.[1] ?? "";
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "");

describe("A. 文案口径", () => {
  it("标题写「至少 N 处」，不写「共 N 条」（条数只覆盖已加载的范围）", () => {
    const { title, detail } = describeEventsSkipped(3);
    expect(title).toContain("至少有 3 处");
    expect(`${title}${detail}`).not.toMatch(/共\s*\d+\s*条/);
    // 补充说明交代统计口径：只数了已加载的部分
    expect(detail).toContain("已加载");
    expect(detail).toContain("更早的历史没有统计");
  });

  it("面向用户：不出现路径 / 字节偏移 / errno / 文件名", () => {
    const { title, detail } = describeEventsSkipped(1);
    expect(`${title}${detail}`).not.toMatch(/ENOSPC|EIO|EROFS|errno|偏移|jsonl|events\.|\/|\\/);
  });

  it("条数插值随入参变化", () => {
    expect(describeEventsSkipped(1).title).toContain("至少有 1 处");
    expect(describeEventsSkipped(27).title).toContain("至少有 27 处");
  });
});

describe("B. EventsSkippedNotice 渲染", () => {
  it('根节点是 role="note" 的信息条，不是 alert（不打断读屏）', () => {
    const html = render(3);
    expect(html).toMatch(/^<div\b[^>]*\brole="note"/);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('aria-live="assertive"');
  });

  it("标题在前、补充说明在后，文字来自 describeEventsSkipped；图标对读屏隐藏", () => {
    const { title, detail } = describeEventsSkipped(3);
    const html = render(3);
    const text = textOf(html);
    expect(text).toContain(title);
    expect(text).toContain(detail);
    expect(text.indexOf(title)).toBeLessThan(text.indexOf(detail));
    expect(html).toMatch(/<svg\b[^>]*aria-hidden="true"/);
  });

  it("颜色走中性 token（muted），不是红色告警；也没有裸色号 / 十六进制 / 内联 style", () => {
    const html = render(3);
    const cls = rootClass(html);
    expect(cls).toContain("bg-muted");
    expect(cls).toContain("text-muted-foreground");
    expect(cls).toContain("border-border");
    expect(html).not.toMatch(/destructive/);
    expect(html).not.toMatch(
      /\b(?:bg|text|border|ring|fill|stroke)-(?:red|orange|amber|yellow|green|emerald|blue|sky|slate|gray|zinc|neutral|stone|white|black)(?:-\d{2,3})?\b/,
    );
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\sstyle="/);
  });

  it("字号不小于 11px；文字不叠 alpha（ui-conventions：层级靠字号和 token，不靠透明度）", () => {
    const html = render(3);
    for (const m of html.matchAll(/text-\[(\d+)px\]/g)) {
      expect(Number(m[1]), m[0]).toBeGreaterThanOrEqual(11);
    }
    expect(html).toContain("text-[11px]"); // 补充说明那一档
    // 文字颜色类不带 /NN 的 alpha（border / bg 的 alpha 不在此限，本组件也没用）
    expect(html).not.toMatch(/\btext-[\w-]+\/\d+/);
    expect(html).not.toMatch(/(?<![\w/-])(?:[\w/-]+:)*opacity-(?:[2-9]\d)\b/);
  });

  it("静止：没有 animate-* / blur", () => {
    const html = render(3);
    expect(html).not.toMatch(/animate-/);
    expect(html).not.toMatch(/blur/);
  });

  it("根节点带 shrink-0：事件流是纵向 flex 容器（列表区 flex-1 min-h-0），灰条不能被列表挤扁", () => {
    expect(rootClass(render(3)).split(/\s+/)).toContain("shrink-0");
  });

  it("className 透传：追加在基类之后", () => {
    const cls = rootClass(render(3, "extra-class"));
    expect(cls.split(/\s+/)).toContain("extra-class");
    expect(cls.indexOf("extra-class")).toBeGreaterThan(cls.indexOf("bg-muted"));
  });
});

// ---------------------------------------------------------------------------
// C. task-store 合并
// ---------------------------------------------------------------------------

const T0 = 1_792_000_000_000;
const mkEv = (i: number): TaskEvent => ({
  id: `e_${T0 + i}_a${i}`,
  ts: T0 + i,
  kind: "assistant_message",
  text: `msg ${i}`,
});
const mkTask = (events: TaskEvent[], extra: Partial<Task> = {}): Task =>
  ({
    id: "t_probe",
    title: "probe",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    actions: [],
    mrs: [],
    repoPaths: [],
    events,
    createdAt: T0,
    updatedAt: T0 + 1000,
    ...extra,
  }) as unknown as Task;

describe("C. task-store 合并 eventsSkipped", () => {
  it("快照没带（SSE 中途帧不是每帧都读 events）：沿用本地的——提示不在两帧之间闪", () => {
    const prev = mkTask([mkEv(1), mkEv(2)], { eventsSkipped: 2, updatedAt: T0 + 100 });
    const next = mkTask([mkEv(1), mkEv(2), mkEv(3)], { updatedAt: T0 + 200 });
    expect(mergeTaskEvents(prev, next).eventsSkipped).toBe(2);
  });

  it("快照带了：以快照为准（条数变了就更新）", () => {
    const prev = mkTask([mkEv(1), mkEv(2)], { eventsSkipped: 2, updatedAt: T0 + 100 });
    const next = mkTask([mkEv(1), mkEv(2), mkEv(3)], { eventsSkipped: 5, updatedAt: T0 + 200 });
    expect(mergeTaskEvents(prev, next).eventsSkipped).toBe(5);
  });

  it("两边都没有：结果也没有（不凭空出现）", () => {
    const prev = mkTask([mkEv(1), mkEv(2)], { updatedAt: T0 + 100 });
    const next = mkTask([mkEv(1), mkEv(2), mkEv(3)], { updatedAt: T0 + 200 });
    expect(mergeTaskEvents(prev, next).eventsSkipped).toBeUndefined();
  });

  it("过期快照分支（next.updatedAt < prev.updatedAt，运行态以本地为准）：同样沿用 / 吸收 eventsSkipped", () => {
    const prev = mkTask([mkEv(1), mkEv(2)], { eventsSkipped: 2, updatedAt: T0 + 500 });
    const staleWithout = mkTask([mkEv(1), mkEv(2), mkEv(3)], { updatedAt: T0 + 100 });
    const staleWith = mkTask([mkEv(1), mkEv(2), mkEv(3)], { eventsSkipped: 4, updatedAt: T0 + 100 });
    expect(mergeTaskEvents(prev, staleWithout).eventsSkipped).toBe(2);
    expect(mergeTaskEvents(prev, staleWith).eventsSkipped).toBe(4);
    // 过期分支仍以本地为底（updatedAt 不被旧快照拉回去）
    expect(mergeTaskEvents(prev, staleWithout).updatedAt).toBe(T0 + 500);
  });

  it("本地没有 task（首次）/ 本地没有事件：直接取服务端快照（含它的 eventsSkipped）", () => {
    const next = mkTask([mkEv(1)], { eventsSkipped: 3 });
    expect(mergeTaskEvents(null, next).eventsSkipped).toBe(3);
    expect(mergeTaskEvents(mkTask([]), next).eventsSkipped).toBe(3);
  });

  it("replaceTaskEventsWithSnapshot（回退后以服务端快照为准）：快照没带就是没有，不沿用本地旧值", () => {
    const prev = mkTask([mkEv(1), mkEv(2)], { eventsSkipped: 2, updatedAt: T0 + 100 });
    const next = mkTask([mkEv(1)], { updatedAt: T0 + 200 });
    expect(replaceTaskEventsWithSnapshot(prev, next).eventsSkipped).toBeUndefined();
    const nextWith = mkTask([mkEv(1)], { eventsSkipped: 1, updatedAt: T0 + 200 });
    expect(replaceTaskEventsWithSnapshot(prev, nextWith).eventsSkipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D. 接线
// ---------------------------------------------------------------------------

describe("D. event-stream 接线（源码契约）", () => {
  const stream = readSrc("components/tasks/event-stream.tsx");

  it("在存储降级红条之后、虚拟列表容器之前渲染（红的更紧急，排在上面）", () => {
    const iBar = stream.indexOf("<StorageDegradedBar");
    const iNotice = stream.indexOf("<EventsSkippedNotice");
    const iList = stream.indexOf('<div className="relative min-h-0 flex-1">');
    expect(iBar).toBeGreaterThan(-1);
    expect(iNotice).toBeGreaterThan(iBar);
    expect(iList).toBeGreaterThan(iNotice);
  });

  it("条件是 truthy 三元（task.eventsSkipped 为 0 / 缺省不渲染，也不会渲染成文本「0」），count 取自 task.eventsSkipped", () => {
    expect(stream).toMatch(
      /\{task\.eventsSkipped \? \(\s*<EventsSkippedNotice count=\{task\.eventsSkipped\} \/>\s*\) : null\}/,
    );
    // 不能写成 `task.eventsSkipped && <…/>`：0 会被渲染成文字 0
    expect(stream).not.toMatch(/task\.eventsSkipped &&/);
  });

  it("组件从 ./events-skipped-notice 引入", () => {
    expect(stream).toContain('import { EventsSkippedNotice } from "./events-skipped-notice";');
  });

  it("新组件已登记进 ui-convention-scan 的 FIXED_FILES", () => {
    const scan = readFileSync(
      path.resolve(import.meta.dirname, "ui-convention-scan.test.ts"),
      "utf-8",
    );
    expect(scan).toContain('"components/tasks/events-skipped-notice.tsx"');
  });

  it("Task 类型里声明了 eventsSkipped?: number（运行时字段）", () => {
    expect(readSrc("lib/types.ts")).toMatch(/eventsSkipped\?: number;/);
  });
});

// ---------------------------------------------------------------------------
// E. 不落盘
// ---------------------------------------------------------------------------

describe("E. eventsSkipped 只是运行时派生字段（不落盘）", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };

  it("全仓只有这几个文件提到 eventsSkipped——没有进 meta schema，没有被任何 writeMeta 路径带上", () => {
    const hits = walk(srcDir)
      .filter((f) => /\beventsSkipped\b/.test(readFileSync(f, "utf-8")))
      .map((f) => path.relative(srcDir, f).split(path.sep).join("/"))
      .sort();
    expect(hits).toEqual(
      [
        "components/tasks/event-stream.tsx", // 渲染灰条
        "lib/events-skipped.ts", // 文案（注释里提到字段名）
        "lib/server/task-fs-core.ts", // hydrateTask / hydrateTaskWithTailEvents 派生
        "lib/task-store.ts", // mergeTaskEvents 沿用
        "lib/types.ts", // Task 类型声明
      ].sort(),
    );
  });

  it("task-fs-core 里只有 hydrate 两处会给 Task 设 eventsSkipped，assembleTask / meta 不碰它", () => {
    const core = readSrc("lib/server/task-fs-core.ts");
    const assigns = core.match(/\.eventsSkipped\s*=/g) ?? [];
    expect(assigns).toHaveLength(2);
    const assemble = core.slice(core.indexOf("export const assembleTask"), core.indexOf("export const hydrateTask "));
    expect(assemble).not.toContain("eventsSkipped");
  });
});
