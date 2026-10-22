/**
 * 划除 action 的 UI 口径（第二轮 review V18-02 / V18-05 / V18-10）。
 *
 * - V18-05：进行中的 action 服务端会 409「先停止再划除」，前端按钮要先置灰并说明原因；
 * - V18-02：划除「交卷等你确认」的 action 实际会停会话、作废待确认提问，确认框不能只写「随时可恢复」；
 * - V18-10：批次表「已实现」行不再整行 opacity（压透明度把绿字压到 2.83:1，违反 ui-conventions）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  actionDisplayLabel,
  getActionExcludeBlockReason,
  getActionExcludeConfirmCopy,
} from "@/lib/task-display";

const source = (rel: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

describe("getActionExcludeBlockReason（V18-05）", () => {
  it("进行中的 action 不能划除，并给出可操作的原因", () => {
    const reason = getActionExcludeBlockReason({ status: "running" });
    expect(reason).toMatch(/停止/);
  });

  it("其余状态都可以划除（含交卷等确认、已完成、出错、已取消）", () => {
    for (const status of ["awaiting_ack", "completed", "error", "cancelled"]) {
      expect(getActionExcludeBlockReason({ status }), status).toBeNull();
    }
  });

  it("已划除的 action 恢复永远可以（即使状态还是 running 的历史脏数据）", () => {
    expect(getActionExcludeBlockReason({ status: "running", excluded: true })).toBeNull();
  });

  it("时间线按钮接了原因：aria-disabled + 不触发划除", () => {
    const src = source("src/components/tasks/action-timeline.tsx");
    expect(src).toContain("getActionExcludeBlockReason(action)");
    expect(src).toMatch(/aria-disabled=\{excludeBlockReason \? true : undefined\}/);
    expect(src).toMatch(/if \(excludeBlockReason\) return;/);
  });
});

describe("getActionExcludeConfirmCopy（V18-02）", () => {
  it("交卷等确认的那一步：说清会关会话、作废提问、恢复不会让它继续，按钮改「停止并划除」", () => {
    const copy = getActionExcludeConfirmCopy({ status: "awaiting_ack" });
    expect(copy.description).toMatch(/会话关闭/);
    expect(copy.description).toMatch(/作废/);
    expect(copy.description).toMatch(/不会让它继续/);
    expect(copy.confirmLabel).toBe("停止并划除");
  });

  it("普通状态保持原文案：不删数据、随时可恢复", () => {
    for (const status of ["completed", "error", "cancelled"]) {
      const copy = getActionExcludeConfirmCopy({ status });
      expect(copy.description, status).toContain("随时可恢复");
      expect(copy.confirmLabel, status).toBe("划除");
    }
  });

  it("task 页确认框用这份文案，不再写死", () => {
    const page = source("src/app/tasks/[id]/page.tsx");
    expect(page).toContain("getActionExcludeConfirmCopy(action)");
  });
});

describe("批次表「已实现」行（V18-10）", () => {
  it("不再整行 opacity，改为标题弱化", () => {
    const src = source("src/components/tasks/batch-plan-table.tsx");
    expect(src).not.toMatch(/opacity-70/);
    expect(src).toMatch(/built && "font-normal text-muted-foreground"/);
  });
});

describe("事件流 action 归属标带序号（V18-01）", () => {
  it("actionTagLabel：与时间线 chip 同形 `#n 短标签`，自定义 action 用自己的名字", async () => {
    const { actionTagLabel } = await import("@/lib/task-display");
    expect(actionTagLabel({ n: 2, type: "build" })).toBe(
      `#2 ${actionDisplayLabel({ type: "build" }, "short")}`,
    );
    expect(actionTagLabel({ n: 1, type: "build" })).not.toBe(
      actionTagLabel({ n: 3, type: "build" }),
    );
    expect(
      actionTagLabel({ n: 4, type: "custom", customLabel: "写周报" }),
    ).toBe("#4 写周报");
  });

  it("rows.tsx 不再裸查 ACTION_LABEL_SHORT，全部走 actionTagLabel", () => {
    const rows = source("src/components/tasks/event-stream/rows.tsx");
    expect(rows).not.toContain("ACTION_LABEL_SHORT");
    expect(rows).toContain("actionTagLabel(action)");
  });
});
