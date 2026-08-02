/**
 * UI 组件在 node 环境不挂 DOM，按项目约定用源码契约锁住 CheckboxRow 的
 * 两条点击路径；纯 TS/React 类型正确性另由 typecheck 覆盖。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve(
    import.meta.dirname,
    "..",
    "src",
    "components",
    "ui",
    "checkbox-row.tsx",
  ),
  "utf-8",
);

describe("CheckboxRow", () => {
  it("小方块不接收指针事件，点击直接落到整行的 toggle", () => {
    expect(source).toContain('className={cn("pointer-events-none", checkboxClassName)}');
    expect(source).toContain("onCheckedChange={() => {}}");
    expect(source).not.toContain("e.stopPropagation()");
  });

  it("点击整行仍走同一个 toggle", () => {
    expect(source).toContain("onClick={toggle}");
  });
});
