/**
 * 事件流「运行态」契约（P0 回归闸）
 *
 * 背景：task 详情页曾漏传 `isRunning` → EventStream 内 runActive 恒 false →
 * 每次渲染都跑 coerceStaleRunningTools，跑 action 时的长 shell / subagent 全被
 * 渲染成灰色「已中断」（chat 侧一直传、所以只坏了 task 侧）。
 *
 * UI 组件在 node 环境跑不起来（见 vitest.config.ts），所以这条闸靠**源码契约**守：
 * 1. 每个 `<EventStream>` 调用点都必须显式传 `isRunning`
 * 2. `isRunning` 是必填 prop（可选 = 下一个调用方还能漏）
 * 3. `buildStreamItems` 的 runActive 参数无默认值（默认成 true/false 都会在某条
 *    路径上悄悄判错）
 *
 * 工具块「非 running 就改判已中断」的行为本身由 tests/tool-display.test.ts 覆盖。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");

const listTsxFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listTsxFiles(full));
      continue;
    }
    if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
};

/** `<EventStream` 开标签起点；排除 `<EventStreamSearchBar` 等同名前缀组件 */
const eventStreamTagStart = (source: string, from: number): number => {
  let idx = from;
  for (;;) {
    const start = source.indexOf("<EventStream", idx);
    if (start < 0) return -1;
    const after = source[start + "<EventStream".length];
    if (!after || !/[A-Za-z0-9_]/.test(after)) return start;
    idx = start + "<EventStream".length;
  }
};

/** 抠出每个 `<EventStream ...>` 开标签的完整属性串（到第一个 `>` 为止，跳过字符串里的 `>`） */
const eventStreamOpenTags = (source: string): string[] => {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = eventStreamTagStart(source, from);
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) break;
    tags.push(source.slice(start, end + 1));
    from = end + 1;
  }
  return tags;
};

describe("EventStream 的 isRunning 契约", () => {
  const files = listTsxFiles(srcDir);

  it("每个调用点都显式传 isRunning（漏传 = 运行中的工具全渲染成「已中断」）", () => {
    let callSites = 0;
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      if (eventStreamTagStart(source, 0) < 0) continue;
      for (const tag of eventStreamOpenTags(source)) {
        callSites += 1;
        expect(tag, `${path.relative(srcDir, file)} 的 <EventStream> 漏传 isRunning`).toContain(
          "isRunning",
        );
      }
    }
    // 防「调用点被删光 / 组件改名」时本测试静默空跑
    expect(callSites).toBeGreaterThanOrEqual(2);
  });

  it("isRunning 是必填 prop、runActive 参数无默认值", () => {
    const source = readFileSync(
      path.join(srcDir, "components", "tasks", "event-stream.tsx"),
      "utf-8",
    );
    expect(source).toContain("isRunning: boolean;");
    expect(source).not.toContain("isRunning?: boolean");
    expect(source).toContain("runActive: boolean,");
    expect(source).not.toContain("runActive = true");
  });
});
