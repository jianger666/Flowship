/**
 * 群问答 tab 的长内容不撑出横向滚动条（第二轮 review V17-03）。
 *
 * 飞书长链接（约 70 字符 ≈ 450px）超过 task 事件流栏宽（默认窗口下约 307px）时，
 * `whitespace-pre-wrap` 本身不会折断长串 → 整个 tab 出横向滚动条。
 * node 测试环境没有布局引擎，这里锁住关键的 CSS 折行链：每个 `whitespace-pre-wrap`
 * 文本容器必须同时带 `wrap-anywhere`，面板根不出横向滚动。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", relativePath), "utf-8");

/** 取出所有带 whitespace-pre-wrap 的 className 字符串 */
const preWrapClassNames = (src: string): string[] =>
  [...src.matchAll(/className="([^"]*whitespace-pre-wrap[^"]*)"/g)].map((m) => m[1]!);

describe("群问答展开块 / 面板：长内容必须能折行", () => {
  for (const file of [
    "src/components/tasks/group-qa-round-card.tsx",
    "src/components/tasks/group-qa-panel.tsx",
  ]) {
    it(`${path.basename(file)}：每个 whitespace-pre-wrap 都带 wrap-anywhere`, () => {
      const classNames = preWrapClassNames(source(file));
      expect(classNames.length).toBeGreaterThan(0);
      for (const cls of classNames) {
        expect(cls, cls).toContain("wrap-anywhere");
      }
    });
  }

  it("群问答面板根不出横向滚动条", () => {
    const panel = source("src/components/tasks/group-qa-panel.tsx");
    expect(panel).toContain("h-full overflow-x-hidden overflow-y-auto");
  });
});
