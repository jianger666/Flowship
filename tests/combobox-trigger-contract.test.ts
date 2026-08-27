import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const pickerSource = readFileSync(
  path.resolve(import.meta.dirname, "../src/components/ui/picker.tsx"),
  "utf-8",
);
const comboboxSource = readFileSync(
  path.resolve(import.meta.dirname, "../src/components/ui/combobox.tsx"),
  "utf-8",
);

describe("Picker Popover 触发器", () => {
  it("Base UI 的 render 直接接原生 button，不经过不透传事件的 Tooltip", () => {
    const triggerStart = pickerSource.indexOf("<PopoverTrigger");
    const triggerEnd = pickerSource.indexOf("/>", triggerStart);
    const trigger = pickerSource.slice(triggerStart, triggerEnd + 2);

    expect(triggerStart).toBeGreaterThan(-1);
    expect(trigger).toContain("<button");
    expect(trigger).not.toContain("<Tooltip");
  });

  it("Combobox 只转调 Picker，自己不再声明 PopoverTrigger", () => {
    expect(comboboxSource).toContain("<Picker");
    expect(comboboxSource).not.toContain("PopoverTrigger");
    expect(comboboxSource).not.toContain('from "@/components/ui/popover"');
  });

  it("trigger 和弹层包在同一层 div 里，避免 FocusGuard 被 space-y 当成额外子元素", () => {
    const rootStart = pickerSource.search(/<Popover[\s\n]/);
    const rootEnd = pickerSource.indexOf("</Popover>", rootStart);
    const root = pickerSource.slice(rootStart, rootEnd);
    expect(root).toContain("relative w-full min-w-0");
    expect(root.indexOf("<div")).toBeLessThan(root.indexOf("<PopoverTrigger"));
    expect(root.indexOf("<PopoverContent")).toBeGreaterThan(root.indexOf("<PopoverTrigger"));
  });
});

describe("Popover 定位", () => {
  it("Positioner 默认 fixed，不被 Card overflow-hidden 裁切", () => {
    const popoverSource = readFileSync(
      path.resolve(import.meta.dirname, "../src/components/ui/popover.tsx"),
      "utf-8",
    );
    expect(popoverSource).toContain('positionMethod = "fixed"');
  });
});

describe("下拉滚动条槽", () => {
  it("globals.css 在 stable 之后给弹层退出预留槽（组件上写 auto 会被盖掉）", () => {
    const css = readFileSync(
      path.resolve(import.meta.dirname, "../src/app/globals.css"),
      "utf-8",
    );
    const stableAt = css.indexOf("scrollbar-gutter: stable");
    const popoverAt = css.indexOf('[data-slot="popover-content"] .overflow-y-auto');
    expect(stableAt).toBeGreaterThan(-1);
    expect(popoverAt).toBeGreaterThan(stableAt);
  });

  it("列表 p-1 + 选项 px-2，文字距边 12px 跟 trigger px-3 对齐", () => {
    expect(pickerSource).toContain("overflow-y-auto p-1");
    expect(pickerSource).toContain(
      'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5',
    );
  });
});
