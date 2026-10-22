/**
 * V18-03（第二轮 review）：选中态不会跟随「最新 action」。
 *
 * 旧 effect 只在「切 task / 没选 / 选的已不存在」时设选中。不经本页推进弹窗产生的新 action
 * （飞书需求群里推进 group-route、另一个窗口）出现时，旧选中仍存在 → 什么都不做：
 * 右栏事件流在输出 build，左栏产物区与时间线高亮还停在方案。
 *
 * 改法 S（wasLatest）：用户原本就选中「当时的最新一条」→ 新 action 出现时跟随；
 * 用户手动选了更早的 → 不动（不抢用户正在看的东西）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  latestActionId,
  resolveSelectedActionOnChange,
} from "@/lib/action-selection";

const acts = (...ids: string[]) => ids.map((id) => ({ id }));

describe("latestActionId", () => {
  it("数组最后一条；空 → null", () => {
    expect(latestActionId(acts("a1", "a2", "a3"))).toBe("a3");
    expect(latestActionId([])).toBeNull();
  });
});

describe("resolveSelectedActionOnChange", () => {
  it("选中的就是上一次的最新条，来了新 action → 跟随到新的最新条", () => {
    expect(
      resolveSelectedActionOnChange({
        selectedActionId: "a2",
        actions: acts("a1", "a2", "a3"),
        currentActionId: "a3",
        prevLatestId: "a2",
      }),
    ).toBe("a3");
  });

  it("用户手动选了更早的 → 不动（返回 undefined = 不改）", () => {
    expect(
      resolveSelectedActionOnChange({
        selectedActionId: "a1",
        actions: acts("a1", "a2", "a3"),
        currentActionId: "a3",
        prevLatestId: "a2",
      }),
    ).toBeUndefined();
  });

  it("最新条没变（currentActionId 变化 / 同一批 action 重排之类的重跑）→ 不动", () => {
    expect(
      resolveSelectedActionOnChange({
        selectedActionId: "a2",
        actions: acts("a1", "a2"),
        currentActionId: "a1",
        prevLatestId: "a2",
      }),
    ).toBeUndefined();
  });

  it("没选中 → 回到 currentActionId（旧行为保留）", () => {
    expect(
      resolveSelectedActionOnChange({
        selectedActionId: null,
        actions: acts("a1", "a2"),
        currentActionId: "a2",
        prevLatestId: "a1",
      }),
    ).toBe("a2");
    // currentActionId 也没有 → 置 null（与旧 `?? null` 一致）
    expect(
      resolveSelectedActionOnChange({
        selectedActionId: null,
        actions: [],
        currentActionId: undefined,
        prevLatestId: null,
      }),
    ).toBeNull();
  });

  it("选中的 action 已不存在（被 GC / 回退）→ 回到 currentActionId（旧行为保留）", () => {
    expect(
      resolveSelectedActionOnChange({
        selectedActionId: "gone",
        actions: acts("a1", "a2"),
        currentActionId: "a2",
        prevLatestId: "a2",
      }),
    ).toBe("a2");
  });

  it("首个 action 出现：之前没有最新条（prevLatestId=null）且没选中 → 走「没选中」分支", () => {
    expect(
      resolveSelectedActionOnChange({
        selectedActionId: null,
        actions: acts("a1"),
        currentActionId: "a1",
        prevLatestId: null,
      }),
    ).toBe("a1");
  });

  it("本页推进的路径：handleAdvance 已把选中直接设成新 action → 与跟随结果一致、不需要再改（undefined）", () => {
    // 选中的已经是新的最新条（a3），不是「上一次的最新条（a2）」→ 不满足 wasLatest，不重复 set
    expect(
      resolveSelectedActionOnChange({
        selectedActionId: "a3",
        actions: acts("a1", "a2", "a3"),
        currentActionId: "a3",
        prevLatestId: "a2",
      }),
    ).toBeUndefined();
  });
});

// ---- 接线契约 ----
const repoDir = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(repoDir, rel), "utf-8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("task 详情页接线：wasLatest", () => {
  const page = stripComments(read("src/app/tasks/[id]/page.tsx"));

  it("页面持有 prevLatestActionIdRef，并把它交给纯函数判定", () => {
    expect(page).toContain("prevLatestActionIdRef");
    expect(page).toContain("resolveSelectedActionOnChange({");
    expect(page).toMatch(/prevLatestId: prevLatestActionIdRef\.current/);
  });

  it("每次 effect 跑完都要把 ref 推进到当前最新条（否则下一次永远拿旧的比）", () => {
    const iDecide = page.indexOf("resolveSelectedActionOnChange({");
    const tail = page.slice(iDecide, iDecide + 700);
    expect(tail).toMatch(/prevLatestActionIdRef\.current = latestId/);
  });

  it("切到新 task 时也要初始化它（否则新 task 第一次来新 action 不会跟随）", () => {
    const iNew = page.indexOf("selectedActionTaskIdRef.current = task.id;");
    expect(iNew).toBeGreaterThan(-1);
    expect(page.slice(iNew, iNew + 400)).toContain("prevLatestActionIdRef.current = latestId");
  });
});
