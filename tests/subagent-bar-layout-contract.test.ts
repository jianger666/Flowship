/**
 * V17-04：子代理任务条带「模型 + 推理强度」徽标时，标题被挤到几乎 0 宽。
 *
 * 根因：任务条是单行 flex。图标 / 「子代理」标签 / 模型徽标 / 强度徽标 / 状态图标 / 时间全是 `shrink-0`，
 * 只有标题 `shrink`——task 事件流栏只有 ≈307px，固定件加起来就超了，标题成了唯一让位的那个，被压到 0。
 *
 * ⚠️ 这是**类名 / 结构契约**，没有在浏览器里看过实际渲染（报告本身也标了「需肉眼」）。
 * 它只能防「改回去」：真实宽度下的观感要人眼过一遍。
 *
 * 与报告「标题 shrink-0 max-w-[55%]、徽标 min-w-0 truncate」的差异（有意的）：
 *  - `max-w` 会把标题钳死，多出来的溢出只能转嫁给别人（状态图标被裁），而且 55% 在窄栏里并不保证徽标有位置；
 *  - 改成「标题保底宽度 + 徽标整体先让位」：徽标放进一个 `min-w-0 shrink-[100] overflow-hidden` 的容器，
 *    窄了先从强度徽标、再从模型徽标右侧裁掉，最窄时整个容器收成 0 宽（不会剩一个只有边框的小方块）；
 *    标题 `min-w-12` 保底、徽标让完之后才轮到标题继续收。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { subagentBarMetaText } from "../src/lib/subagent-run-display";

const SRC = readFileSync(
  path.join(__dirname, "../src/components/tasks/event-stream/tool-block.tsx"),
  "utf8",
);

/** 取 TaskSubagentBlock 组件源码（到下一个顶层组件为止） */
const subagentBlockSrc = (): string => {
  const start = SRC.indexOf("const TaskSubagentBlock = (");
  const end = SRC.indexOf("const RegularToolBlockRow = (");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
};

/** 取某个 JSX 开标签（含 className）所在的那一小段：从标记起 360 字符内 */
const around = (src: string, marker: string, span = 360): string => {
  const i = src.indexOf(marker);
  expect(i, `找不到 ${marker}`).toBeGreaterThanOrEqual(0);
  return src.slice(i, i + span);
};

describe("subagentBarMetaText：任务条 Tooltip 的第二行", () => {
  it("模型 + 强度 → 带字段名；只有一个就只出一个；都没有 → null", () => {
    expect(subagentBarMetaText({ model: "gpt-5", effort: "high" })).toBe(
      "模型 gpt-5 · 推理强度 high",
    );
    expect(subagentBarMetaText({ model: "gpt-5" })).toBe("模型 gpt-5");
    expect(subagentBarMetaText({ effort: "low" })).toBe("推理强度 low");
    expect(subagentBarMetaText({ model: " ", effort: "" })).toBeNull();
    expect(subagentBarMetaText(null)).toBeNull();
    expect(subagentBarMetaText(undefined)).toBeNull();
  });

  it("两端空白被裁掉（args 里偶尔带换行 / 空格）", () => {
    expect(subagentBarMetaText({ model: "  m1 \n", effort: " e " })).toBe(
      "模型 m1 · 推理强度 e",
    );
  });
});

describe("TaskSubagentBlock 任务条布局（源码契约，未在浏览器验证）", () => {
  const SUB = subagentBlockSrc();

  it("标题：可收但有保底宽度（min-w-12 + shrink + truncate），不是 shrink-0 也不是裸 min-w-0", () => {
    const title = around(SUB, '<span className="min-w-12');
    expect(title).toMatch(/min-w-12[^"]*\bshrink\b[^"]*\btruncate\b/);
    expect(title).not.toMatch(/min-w-12[^"]*shrink-0/);
    // 旧写法 `min-w-0 shrink truncate` 的标题没有保底，不能回来
    expect(SUB).not.toMatch(/"min-w-0 shrink truncate text-\[11px\] font-medium/);
  });

  it("徽标整体放进一个容器：min-w-0 + 极大的 shrink 系数 + overflow-hidden，窄了先于标题让位、最窄收成 0", () => {
    const wrap = around(SUB, "data-subagent-badges");
    expect(wrap).toMatch(/min-w-0/);
    expect(wrap).toMatch(/shrink-\[100\]/);
    expect(wrap).toMatch(/overflow-hidden/);
  });

  it("模型徽标可截断（min-w-0 truncate）、强度徽标整块保持（shrink-0）；都不再是裸 shrink-0 一把梭", () => {
    // 模型徽标的 span：以 min-w-0 truncate 开头，且不含 shrink-0
    expect(SUB).toMatch(
      /<span className="min-w-0 truncate rounded-sm border[^"]*font-mono[^"]*text-subagent">\s*\{taskArgs\.model\}/,
    );
    // 强度徽标：整块保持（shrink-0）——先被容器的 overflow-hidden 裁掉，而不是被压成半截词
    expect(SUB).toMatch(
      /<span className="shrink-0 rounded-sm border[^"]*font-mono[^"]*text-muted-foreground">\s*\{taskArgs\.effort\}/,
    );
  });

  it("状态图标、时间、「子代理」标签仍是 shrink-0：让位的只有徽标和标题，状态不能被压没", () => {
    expect(SUB).toMatch(/const statusIcon = stillWorking \? \(\s*<Loader2 className="size-3\.5 shrink-0/);
    expect(SUB).toMatch(/<span className="ml-auto shrink-0 text-\[11px\] tabular-nums opacity-0/);
    expect(SUB).toMatch(/<span className="shrink-0 rounded-sm bg-subagent\/15[^"]*">\s*子代理/);
  });

  it("整条挂 Tooltip（不是原生 title）：隐藏掉的徽标 / 被截断的标题靠它看全；内容恒非空，Tooltip 不会在 children 与包装间切换", () => {
    expect(SUB).toMatch(/<Tooltip\s+content=\{barTooltip\}/);
    expect(SUB).toMatch(/subagentBarMetaText\(taskArgs\)/);
    expect(SUB).not.toMatch(/\btitle=\{/);
    // barTooltip 以标题打头（标题恒非空：缺省「子代理任务」）——所以内容恒非空
    expect(SUB).toMatch(/const barTooltip = \(\s*<>\s*<div>\{title\}<\/div>/);
  });
});
