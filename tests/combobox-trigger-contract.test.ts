import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve(import.meta.dirname, "../src/components/ui/combobox.tsx"),
  "utf-8",
);

describe("Combobox Popover 触发器", () => {
  it("Base UI 的 render 直接接原生 button，不经过不透传事件的 Tooltip", () => {
    const triggerStart = source.indexOf("<PopoverTrigger");
    const triggerEnd = source.indexOf("/>", triggerStart);
    const trigger = source.slice(triggerStart, triggerEnd + 2);

    expect(triggerStart).toBeGreaterThan(-1);
    expect(trigger).toContain("<button");
    expect(trigger).not.toContain("<Tooltip");
    expect(source).not.toContain('from "@/components/ui/tooltip"');
  });
});
