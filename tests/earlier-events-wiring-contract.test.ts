/**
 * 上拉分页接线的源码契约闸（2026-10-13）
 *
 * 用户反馈「聊天太多的话，往回滚，滚着滚着就滚不动了」。根因与修法见
 * `src/lib/earlier-events.ts` 头注释，判定逻辑本身的行为测试在 `tests/earlier-events.test.ts`。
 * 这里只钉「组件确实走了那套逻辑」——React 在 node 环境跑不起来（见 vitest.config.ts），
 * 而「改回固定拉一页」只需要把一个调用换回去，无声无息、也不会让任何行为测试变红。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const eventStream = readFileSync(
  path.join(srcDir, "components", "tasks", "event-stream.tsx"),
  "utf-8",
);

/** 剥掉注释再查代码本身（注释里要解释「为什么不用 X」，不该因此误报） */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** 从 `marker` 起按花括号配对截出完整函数体 */
const sliceFunction = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  expect(start, `源码里找不到 \`${marker}\``).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", source.indexOf("=>", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`\`${marker}\` 的花括号没配平`);
};

const code = stripComments(eventStream);
const loadEarlier = sliceFunction(code, "const loadEarlier = async () =>");

describe("event-stream 上拉分页接线", () => {
  it("loadEarlier 走 fetchEarlierBatch（拉到有进展为止），不再固定拉一页", () => {
    expect(code).toContain(
      'import { fetchEarlierBatch } from "@/lib/earlier-events"',
    );
    expect(loadEarlier).toContain("fetchEarlierBatch(");
    // 旧实现：以本地第一条为锚点直接单页请求
    expect(loadEarlier).not.toContain("anchor.id");
    expect(code).not.toMatch(/const EARLIER_PAGE_SIZE\s*=/);
  });

  it("条目数用与渲染管线同一个 buildStreamItems 数（否则这里判有进展、Virtuoso 序号却没变）", () => {
    const countItems = loadEarlier.slice(loadEarlier.indexOf("countItems"));
    expect(countItems).toMatch(/countItems:[\s\S]{0,200}buildStreamItems\(/);
  });

  it("没进展且还有更早的就接着拉（提交一批后循环），有进展 / 读完才收工", () => {
    expect(loadEarlier).toMatch(/for\s*\(\s*;;\s*\)/);
    expect(loadEarlier).toMatch(
      /if\s*\(\s*batch\.progressed\s*\|\|\s*!batch\.hasMore\s*\)\s*break/,
    );
  });

  it("firstItemIndex 的递减量仍然是同一套 buildStreamItems 的前后条数差", () => {
    expect(loadEarlier).toMatch(/setFirstItemIndex\(\(fi\)\s*=>\s*fi\s*-\s*\(afterLen\s*-\s*beforeLen\)\)/);
    expect(loadEarlier).toContain("onPrependEvents(fresh)");
  });

  it("prepend 之后同步预置 latestEventsRef（多批循环的下一批不再读到旧的第一条、重复请求刚拉的页）", () => {
    // latestEventsRef 平时只在渲染时更新；循环里下一批在 onPrependEvents 之后立刻开始，
    // fetchEarlierBatch 开头同步读 getCurrent()[0] 当游标——不预置就会读到 prepend 之前的第一条
    expect(loadEarlier).toMatch(
      /onPrependEvents\(fresh\);[\s\S]{0,200}latestEventsRef\.current\s*=\s*\[\.\.\.fresh,\s*\.\.\.cur\]/,
    );
  });

  it("切走任务后丢弃迟到结果（取消钩子 + 提交前复查）", () => {
    expect(loadEarlier).toMatch(/isCancelled:\s*\(\)\s*=>\s*taskIdRef\.current\s*!==\s*requestedTaskId/);
    expect(loadEarlier).toMatch(/taskIdRef\.current\s*!==\s*requestedTaskId\)\s*return/);
  });

  it("失败后顶部给手动重试入口（Virtuoso 不会再自动触发 startReached）", () => {
    expect(loadEarlier).toContain("setEarlierFailed(true)");
    expect(loadEarlier).toContain("setEarlierFailed(false)");
    expect(code).toContain("加载更早失败，点击重试");
    expect(code).toMatch(/onRetryEarlier:\s*\(\)\s*=>\s*void loadEarlier\(\)/);
  });
});
