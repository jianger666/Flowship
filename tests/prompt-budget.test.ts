/**
 * B2 applyPromptBudget 单测（验收线锁死）：
 * 预算内零裁剪 / 超预算先掉 L3 再 L2 / L1-L0 永不掉 /
 * dropped 可回放（段名+省字节）/ 压缩优先于删除 / fail-open。
 */
import { describe, expect, it } from "vitest";

import {
  applyPromptBudget,
  PROMPT_BUDGET_BYTES,
  type PromptSection,
} from "@/lib/server/prompt-budget";

const sec = (
  name: string,
  tier: 0 | 1 | 2 | 3,
  bytes: number,
  opts: Partial<PromptSection> = {},
): PromptSection => ({
  name,
  tier,
  content: `full:${name}`,
  bytes,
  ...opts,
});

describe("applyPromptBudget", () => {
  it("预算内零裁剪", () => {
    const sections = [
      sec("firstActionDirective", 0, 1000),
      sec("sharedRules", 1, 2000),
      sec("contextDocsSection", 3, 500, {
        compressedContent: "c",
        compressedBytes: 100,
      }),
    ];
    const r = applyPromptBudget(sections, 10 * 1024);
    expect(r.dropped).toEqual([]);
    expect(r.compressed).toEqual([]);
    expect(r.contents["sharedRules"]).toBe("full:sharedRules");
    expect(r.overBudget).toBe(false);
  });

  it("超预算先压缩、还超先掉 L3 再 L2", () => {
    const sections = [
      sec("firstActionDirective", 0, 500),
      sec("sharedRules", 1, 500),
      sec("skillsSection", 2, 800, {
        compressedContent: "c-skills",
        compressedBytes: 200,
        droppedPlaceholder: "(skills 掉)",
      }),
      sec("contextDocsSection", 3, 1000, {
        compressedContent: "c-docs",
        compressedBytes: 300,
        droppedPlaceholder: "(docs 掉)",
      }),
    ];
    // 全量 2600；只压缩 500+500+200+300=1500 仍超 1050 → 先掉 L3
    const r = applyPromptBudget(sections, 1050);
    const droppedNames = r.dropped.map((d) => d.name);
    expect(droppedNames).toContain("contextDocsSection");
    // L3 掉后仍超 → 再掉 L2，两段都掉后 1022 落进 1050
    expect(droppedNames).toContain("skillsSection");
    expect(r.totalBytes).toBeLessThanOrEqual(1050);
    // 回放：段名+省字节
    for (const d of r.dropped) {
      expect(d.name).toBeTruthy();
      expect(d.savedBytes).toBeGreaterThan(0);
    }
  });

  it("L1/L0 永不掉：L3+L2 全掉还超就 fail-open", () => {
    const sections = [
      sec("firstActionDirective", 0, 5000),
      sec("currentActionPlaybook", 0, 1000),
      sec("sharedRules", 1, 5000),
      sec("rulesSection", 1, 4000, {
        compressedContent: "c-rules",
        compressedBytes: 1000,
      }),
      sec("contextDocsSection", 3, 800, {
        compressedContent: "c",
        compressedBytes: 100,
        droppedPlaceholder: "(d)",
      }),
    ];
    const r = applyPromptBudget(sections, 1000);
    const droppedNames = r.dropped.map((d) => d.name);
    expect(droppedNames).not.toContain("firstActionDirective");
    expect(droppedNames).not.toContain("currentActionPlaybook");
    expect(droppedNames).not.toContain("sharedRules");
    expect(droppedNames).not.toContain("rulesSection");
    expect(r.overBudget).toBe(true);
    // fail-open：L0/L1 原样保留（rules 用压缩版、shared 全文）
    expect(r.contents["sharedRules"]).toBe("full:sharedRules");
    expect(r.contents["rulesSection"]).toBe("c-rules");
    expect(r.contents["firstActionDirective"]).toBe(
      "full:firstActionDirective",
    );
  });

  it("压缩能兜住就不删", () => {
    const sections = [
      sec("a", 0, 100),
      sec("contextDocsSection", 3, 1000, {
        compressedContent: "c",
        compressedBytes: 100,
        droppedPlaceholder: "(d)",
      }),
    ];
    const r = applyPromptBudget(sections, 500);
    expect(r.compressed).toContain("contextDocsSection");
    expect(r.dropped).toEqual([]);
    expect(r.contents["contextDocsSection"]).toBe("c");
  });

  it("L0 从不压缩", () => {
    const sections = [
      sec("firstActionDirective", 0, 2000, {
        compressedContent: "c0",
        compressedBytes: 10,
      }),
      sec("contextDocsSection", 3, 100, {
        droppedPlaceholder: "(d)",
        compressedContent: "c",
        compressedBytes: 50,
      }),
    ];
    const r = applyPromptBudget(sections, 10 * 1024);
    expect(r.contents["firstActionDirective"]).toBe(
      "full:firstActionDirective",
    );
    expect(r.compressed).not.toContain("firstActionDirective");
  });

  it("默认预算 100KB", () => {
    expect(PROMPT_BUDGET_BYTES).toBe(100 * 1024);
  });
});
